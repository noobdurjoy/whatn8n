-- 0008_workflow_functions.sql
-- Functions used by the n8n workflows for order verification, system
-- notifications, memory, retention, reminders and daily learning.

BEGIN;
SET search_path = app, public;
SET LOCAL check_function_bodies = off;

-- Normalises Bangladeshi and international numbers to digits with country code.
CREATE FUNCTION app.normalize_phone(p text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN d IS NULL OR d = '' THEN NULL
    WHEN d ~ '^01[3-9][0-9]{8}$' THEN '88' || d
    WHEN d ~ '^8801[3-9][0-9]{8}$' THEN d
    WHEN d ~ '^00' THEN substring(d from 3)
    ELSE d END
  FROM (SELECT regexp_replace(translate(coalesce(p, ''), '০১২৩৪৫৬৭৮৯', '0123456789'), '[^0-9]', '', 'g') AS d) x
$$;

-- Order verification: WhatsApp proves the customer controls their number.
-- If the order's billing phone is that same number, the order is linked to
-- this customer. Otherwise nothing is linked and staff must verify.
-- An order number alone never grants access.
ALTER TABLE app.order_links DROP CONSTRAINT order_links_verified_method_check;
ALTER TABLE app.order_links ADD CONSTRAINT order_links_verified_method_check
  CHECK (verified_method IN ('account_link', 'otp_to_order_contact', 'staff_verified', 'created_in_chat', 'whatsapp_number_matches_billing_phone'));
CREATE FUNCTION app.link_order_if_phone_matches(p_job uuid, p_woo_order_id bigint, p_billing_phone text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_customer uuid; v_phone text;
BEGIN
  SELECT c.customer_id, cu.phone_e164 INTO v_customer, v_phone
    FROM app.ai_jobs j JOIN app.conversations c ON c.id = j.conversation_id JOIN app.customers cu ON cu.id = c.customer_id
   WHERE j.id = p_job;
  IF v_customer IS NULL THEN RAISE EXCEPTION 'job not found' USING ERRCODE = 'P0002'; END IF;
  IF v_phone IS NULL OR p_billing_phone IS NULL OR app.normalize_phone(v_phone) IS NULL
     OR app.normalize_phone(v_phone) <> app.normalize_phone(p_billing_phone) THEN
    RETURN jsonb_build_object('linked', false, 'reason', 'contact_does_not_match');
  END IF;
  INSERT INTO app.order_links (customer_id, woo_order_id, verified_method)
  VALUES (v_customer, p_woo_order_id, 'whatsapp_number_matches_billing_phone')
  ON CONFLICT (customer_id, woo_order_id) DO UPDATE SET revoked_at = NULL;
  PERFORM app.audit('workflow', NULL, 'order.linked_by_whatsapp_number', 'order', p_woo_order_id::text, jsonb_build_object('customer_id', v_customer));
  RETURN jsonb_build_object('linked', true);
END $$;

-- System-originated messages (order updates, reminders, follow-ups). They go
-- through the same outbox and the same claim_outbound checks as every other
-- sender (window, consent, human-active, emergency stop).
CREATE FUNCTION app.enqueue_system_message(p_conversation uuid, p_kind text, p_category text, p_body text,
                                           p_payload jsonb, p_dedupe text, p_send_at timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE c app.conversations; v_id uuid;
BEGIN
  IF p_kind NOT IN ('notification', 'followup', 'scheduled', 'template') THEN
    RAISE EXCEPTION 'invalid kind' USING ERRCODE = '22023';
  END IF;
  IF p_category NOT IN ('service', 'utility', 'marketing') THEN RAISE EXCEPTION 'invalid category' USING ERRCODE = '22023'; END IF;
  c := app.lock_conversation(p_conversation);
  IF c.is_sandbox THEN RETURN jsonb_build_object('queued', false, 'reason', 'sandbox'); END IF;
  INSERT INTO app.outbound_messages (conversation_id, kind, category, actor_type, body, payload, dedupe_key, scheduled_for, next_attempt_at)
  VALUES (p_conversation, p_kind, p_category, 'system', p_body, coalesce(p_payload, '{}'), 'system:' || p_dedupe, p_send_at, p_send_at)
  ON CONFLICT (dedupe_key) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN jsonb_build_object('queued', false, 'reason', 'duplicate'); END IF;
  PERFORM app.notify('outbound', p_conversation, jsonb_build_object('outbound_id', v_id));
  RETURN jsonb_build_object('queued', true, 'outbound_id', v_id);
END $$;

-- Conversations whose summary is out of date and which have been quiet for a
-- few minutes (so we summarise finished exchanges, not mid-conversation).
CREATE FUNCTION app.conversations_needing_summary(p_limit integer DEFAULT 20) RETURNS TABLE (conversation_id uuid, since timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT c.id, coalesce(s.covers_until, '-infinity')
  FROM app.conversations c LEFT JOIN app.conversation_summaries s ON s.conversation_id = c.id
  WHERE NOT c.is_sandbox AND c.last_message_at < now() - interval '5 minutes'
    AND c.last_message_at > coalesce(s.covers_until, '-infinity')
    AND (SELECT count(*) FROM app.messages m WHERE m.conversation_id = c.id AND m.sent_at > coalesce(s.covers_until, '-infinity')) >= 2
  ORDER BY c.last_message_at DESC LIMIT least(p_limit, 50)
$$;

CREATE FUNCTION app.summary_input(p_conversation uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'conversation_id', c.id,
    'previous', (SELECT jsonb_build_object('summary', summary, 'actions_taken', actions_taken, 'open_issues', open_issues)
                 FROM app.conversation_summaries WHERE conversation_id = c.id),
    'messages', coalesce((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'role',
                   CASE WHEN m.direction = 'inbound' THEN 'customer' WHEN m.author_type = 'ai' THEN 'assistant' ELSE 'staff' END,
                   'text', m.body, 'at', m.sent_at) ORDER BY m.sent_at)
                 FROM (SELECT * FROM app.messages WHERE conversation_id = c.id AND redacted_at IS NULL
                         AND sent_at > coalesce((SELECT covers_until FROM app.conversation_summaries WHERE conversation_id = c.id), '-infinity')
                       ORDER BY sent_at DESC LIMIT 40) m), '[]'),
    'latest_at', c.last_message_at)
  FROM app.conversations c WHERE c.id = p_conversation
$$;

-- Preferences stated by the customer, scoped to that conversation's customer.
CREATE FUNCTION app.upsert_customer_memory_for_conversation(p_conversation uuid, p_key text, p_value text, p_source_message uuid)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_customer uuid;
BEGIN
  SELECT customer_id INTO v_customer FROM app.conversations WHERE id = p_conversation;
  IF NOT EXISTS (SELECT 1 FROM app.messages WHERE id = p_source_message AND conversation_id = p_conversation AND direction = 'inbound') THEN
    RETURN jsonb_build_object('stored', false, 'reason', 'source_must_be_customer_message_in_conversation');
  END IF;
  IF p_key !~ '^[a-z][a-z0-9_]{1,40}$' OR length(p_value) > 300 THEN
    RETURN jsonb_build_object('stored', false, 'reason', 'invalid_key_or_value');
  END IF;
  INSERT INTO app.customer_memories (customer_id, key, value, source_message_id, confirmed_by)
  VALUES (v_customer, p_key, p_value, p_source_message, 'customer')
  ON CONFLICT (customer_id, key) WHERE deleted_at IS NULL
  DO UPDATE SET value = excluded.value, source_message_id = excluded.source_message_id, updated_at = now();
  RETURN jsonb_build_object('stored', true);
END $$;

-- Daily learning candidates: resolved/closed conversations updated in the
-- window that involved the AI, with the evidence reviewers need (ids only
-- beyond the redacted text the workflow builds).
CREATE FUNCTION app.learning_candidates(p_since timestamptz, p_limit integer DEFAULT 30) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(x), '[]') FROM (
    SELECT jsonb_build_object(
      'conversation_id', c.id,
      'messages', (SELECT jsonb_agg(jsonb_build_object('role',
                     CASE WHEN m.direction = 'inbound' THEN 'customer' WHEN m.author_type = 'ai' THEN 'assistant' ELSE 'staff' END,
                     'text', left(m.body, 600)) ORDER BY m.sent_at)
                   FROM (SELECT * FROM app.messages WHERE conversation_id = c.id AND body IS NOT NULL AND redacted_at IS NULL
                           AND NOT is_historical ORDER BY sent_at DESC LIMIT 30) m),
      'drafts_edited', (SELECT jsonb_agg(jsonb_build_object('ai', left(d.body, 600), 'staff_final', left(d.final_body, 600)))
                        FROM app.ai_drafts d WHERE d.conversation_id = c.id AND d.status = 'approved' AND d.final_body <> d.body),
      'negative_feedback', (SELECT count(*) FROM app.feedback f WHERE f.conversation_id = c.id AND (f.rating <= 2 OR f.label IN ('ai_wrong', 'draft_rejected'))),
      'handoff_reasons', (SELECT jsonb_agg(DISTINCT reason) FROM app.mode_changes mc WHERE mc.conversation_id = c.id AND mc.to_mode = 'HUMAN')
    ) AS x
    FROM app.conversations c
    WHERE NOT c.is_sandbox AND c.updated_at >= p_since
      AND (c.status IN ('resolved', 'closed') OR c.mode = 'HUMAN')
      AND EXISTS (SELECT 1 FROM app.ai_jobs j WHERE j.conversation_id = c.id)
    ORDER BY c.updated_at DESC LIMIT least(p_limit, 100)
  ) q
$$;

CREATE FUNCTION app.published_knowledge_index() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('slug', d.slug, 'id', d.id, 'category', d.category, 'title', v.title, 'body', left(v.body, 800))), '[]')
  FROM app.knowledge_documents d JOIN app.knowledge_versions v ON v.id = d.published_version_id WHERE d.status = 'active'
$$;

CREATE FUNCTION app.document_id_for_slug(p_slug text) RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT id FROM app.knowledge_documents WHERE slug = p_slug $$;

-- Response-time reminders: conversations waiting past their target.
CREATE FUNCTION app.overdue_conversations() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('conversation_id', c.id, 'customer', cu.display_name, 'mode', c.mode,
                                               'due_at', c.first_response_due_at, 'assigned_to', su.display_name)), '[]')
  FROM app.conversations c JOIN app.customers cu ON cu.id = c.customer_id LEFT JOIN app.staff_users su ON su.id = c.assigned_to
  WHERE NOT c.is_sandbox AND c.status IN ('open', 'pending') AND c.first_response_due_at < now()
    AND c.first_response_due_at > now() - interval '24 hours'
$$;

-- Retention: removes content older than the configured periods. Message rows
-- stay (so metrics and audit remain consistent) but their text is removed.
CREATE FUNCTION app.apply_retention() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE r jsonb := app.setting('retention'); v_msgs integer; v_blobs integer; v_events integer; v_usage integer; v_sessions integer;
BEGIN
  UPDATE app.messages SET body = NULL, metadata = '{}', redacted_at = now()
   WHERE redacted_at IS NULL AND sent_at < now() - make_interval(days => coalesce((r ->> 'message_content_days')::int, 730));
  GET DIAGNOSTICS v_msgs = ROW_COUNT;
  DELETE FROM app.attachment_blobs b USING app.attachments a, app.messages m
   WHERE a.id = b.attachment_id AND m.id = a.message_id AND m.sent_at < now() - make_interval(days => coalesce((r ->> 'attachment_days')::int, 180));
  GET DIAGNOSTICS v_blobs = ROW_COUNT;
  DELETE FROM app.staff_uploads WHERE created_at < now() - make_interval(days => coalesce((r ->> 'attachment_days')::int, 180));
  DELETE FROM app.webhook_events WHERE received_at < now() - make_interval(days => coalesce((r ->> 'webhook_payload_days')::int, 30))
    AND processing_status IN ('processed', 'ignored');
  GET DIAGNOSTICS v_events = ROW_COUNT;
  DELETE FROM app.ai_usage WHERE created_at < now() - make_interval(days => coalesce((r ->> 'ai_usage_days')::int, 400));
  GET DIAGNOSTICS v_usage = ROW_COUNT;
  DELETE FROM app.staff_sessions WHERE expires_at < now() - interval '30 days';
  GET DIAGNOSTICS v_sessions = ROW_COUNT;
  DELETE FROM app.login_attempts WHERE at < now() - interval '90 days';
  RETURN jsonb_build_object('messages_redacted', v_msgs, 'attachment_blobs_deleted', v_blobs, 'webhook_events_deleted', v_events,
                            'ai_usage_deleted', v_usage, 'sessions_deleted', v_sessions);
END $$;

-- Health rows written by workflows and the backup job.
CREATE FUNCTION app.record_health(p_component text, p_status text, p_detail jsonb) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO app.health_checks (component, status, detail, checked_at) VALUES (p_component, p_status, coalesce(p_detail, '{}'), now())
  ON CONFLICT (component) DO UPDATE SET status = excluded.status, detail = excluded.detail, checked_at = now()
$$;

-- Unknown sends older than 2 minutes, with what the reconciliation step needs.
CREATE FUNCTION app.unknown_sends_for_reconcile() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('outbound_id', o.id, 'body', o.body, 'created_at', o.created_at,
         'provider_conversation_id', c.provider_conversation_id, 'provider_account_id', a.provider_account_id)), '[]')
  FROM app.outbound_messages o JOIN app.conversations c ON c.id = o.conversation_id JOIN app.channel_accounts a ON a.id = c.channel_account_id
  WHERE o.status = 'unknown' AND o.updated_at < now() - interval '2 minutes' AND o.updated_at > now() - interval '24 hours'
$$;

-- Candidates are attached to the alert for staff; the send is NOT resolved
-- automatically on text similarity.
CREATE FUNCTION app.attach_reconcile_evidence(p_outbound uuid, p_evidence jsonb) RETURNS void
LANGUAGE sql AS $$
  UPDATE app.alerts SET details = details || jsonb_build_object('reconcile_candidates', p_evidence, 'checked_at', now())
   WHERE dedupe_key = 'send_unknown:' || p_outbound AND resolved_at IS NULL
$$;

-- Attachments waiting for download (with the fields the media workflow needs).
CREATE FUNCTION app.pending_attachments(p_ids uuid[] DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('attachment_id', a.id, 'media_ref', a.provider_media_ref, 'media_type', a.media_type,
                                               'mime_type', a.mime_type, 'provider_account_id', ca.provider_account_id)), '[]')
  FROM app.attachments a JOIN app.messages m ON m.id = a.message_id JOIN app.conversations c ON c.id = m.conversation_id
  JOIN app.channel_accounts ca ON ca.id = c.channel_account_id
  WHERE a.fetch_status = 'pending' AND a.provider_media_ref IS NOT NULL
    AND (p_ids IS NULL OR a.id = ANY (p_ids))
    AND a.created_at > now() - interval '7 days'
  LIMIT 25
$$;

-- Conversation facts for staff notifications (no message content).
CREATE FUNCTION app.notification_facts(p_conversation uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('conversation_id', c.id, 'customer', coalesce(cu.display_name, 'Customer'), 'mode', c.mode,
                            'reason', c.mode_reason, 'assigned_to', su.display_name, 'hold', c.automation_hold_reason,
                            'notify', app.setting('notifications'))
  FROM app.conversations c JOIN app.customers cu ON cu.id = c.customer_id LEFT JOIN app.staff_users su ON su.id = c.assigned_to
  WHERE c.id = p_conversation
$$;

-- WooCommerce sync writers (explicit functions instead of table grants).
CREATE FUNCTION app.upsert_woo_order_ref(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_prev text; v_links jsonb;
BEGIN
  SELECT status INTO v_prev FROM app.woo_order_refs WHERE woo_order_id = (p ->> 'id')::bigint;
  INSERT INTO app.woo_order_refs (woo_order_id, status, currency, total_minor, billing_phone_hash, billing_email_hash, woo_customer_id,
                                  payment_method, date_paid, source_modified_at, synced_at)
  VALUES ((p ->> 'id')::bigint, p ->> 'status', p ->> 'currency', round(((p ->> 'total')::numeric) * 100)::bigint,
          CASE WHEN app.normalize_phone(p #>> '{billing,phone}') IS NOT NULL THEN sha256(convert_to(app.normalize_phone(p #>> '{billing,phone}'), 'UTF8')) END,
          CASE WHEN p #>> '{billing,email}' IS NOT NULL THEN sha256(convert_to(lower(p #>> '{billing,email}'), 'UTF8')) END,
          nullif((p ->> 'customer_id')::bigint, 0), p ->> 'payment_method',
          (p ->> 'date_paid_gmt')::timestamp AT TIME ZONE 'UTC', (p ->> 'date_modified_gmt')::timestamp AT TIME ZONE 'UTC', now())
  ON CONFLICT (woo_order_id) DO UPDATE SET status = excluded.status, currency = excluded.currency, total_minor = excluded.total_minor,
    billing_phone_hash = excluded.billing_phone_hash, billing_email_hash = excluded.billing_email_hash, woo_customer_id = excluded.woo_customer_id,
    payment_method = excluded.payment_method, date_paid = excluded.date_paid, source_modified_at = excluded.source_modified_at, synced_at = now()
  WHERE app.woo_order_refs.source_modified_at IS NULL OR excluded.source_modified_at >= app.woo_order_refs.source_modified_at;
  SELECT coalesce(jsonb_agg(jsonb_build_object('conversation_id', c.id, 'customer_id', l.customer_id)), '[]') INTO v_links
    FROM app.order_links l JOIN LATERAL (SELECT id FROM app.conversations WHERE customer_id = l.customer_id AND NOT is_sandbox
                                         ORDER BY last_message_at DESC NULLS LAST LIMIT 1) c ON true
   WHERE l.woo_order_id = (p ->> 'id')::bigint AND l.revoked_at IS NULL;
  RETURN jsonb_build_object('previous_status', v_prev, 'status', p ->> 'status', 'linked', v_links);
END $$;

CREATE FUNCTION app.upsert_woo_products(p_items jsonb) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE i jsonb; n integer := 0;
BEGIN
  FOR i IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO app.woo_products (product_id, variation_id, name, sku, type, attributes, price_minor, currency, stock_status,
                                  stock_quantity, permalink, status, source_modified_at, synced_at)
    VALUES ((i ->> 'product_id')::bigint, coalesce((i ->> 'variation_id')::bigint, 0), i ->> 'name', i ->> 'sku', i ->> 'type',
            coalesce(i -> 'attributes', '{}'), (i ->> 'price_minor')::bigint, i ->> 'currency', i ->> 'stock_status',
            (i ->> 'stock_quantity')::integer, i ->> 'permalink', i ->> 'status', (i ->> 'modified_at')::timestamptz, now())
    ON CONFLICT (product_id, variation_id) DO UPDATE SET name = excluded.name, sku = excluded.sku, type = excluded.type,
      attributes = excluded.attributes, price_minor = excluded.price_minor, currency = excluded.currency,
      stock_status = excluded.stock_status, stock_quantity = excluded.stock_quantity, permalink = excluded.permalink,
      status = excluded.status, source_modified_at = excluded.source_modified_at, synced_at = now();
    n := n + 1;
  END LOOP;
  PERFORM app.record_health('woocommerce_sync', 'ok', jsonb_build_object('upserted', n));
  RETURN n;
END $$;

CREATE FUNCTION app.get_webhook_event(p_event uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id', id, 'source', source, 'event_type', event_type, 'payload', payload)
  FROM app.webhook_events WHERE id = p_event AND signature_valid
$$;

-- Outbound rows due for dispatch (the dispatcher's sweep).
CREATE FUNCTION app.due_outbound(p_limit integer DEFAULT 20) RETURNS TABLE (outbound_id uuid)
LANGUAGE sql STABLE AS $$
  SELECT id FROM app.outbound_messages WHERE status = 'queued' AND next_attempt_at <= now() AND scheduled_for <= now()
  ORDER BY next_attempt_at LIMIT least(p_limit, 50)
$$;

INSERT INTO app.schema_migrations (version) VALUES ('0008_workflow_functions');
COMMIT;
