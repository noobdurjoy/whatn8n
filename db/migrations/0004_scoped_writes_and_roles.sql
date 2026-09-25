-- 0004_scoped_writes_and_roles.sql
-- Scoped write functions for n8n, and a least-privilege database role for it.
--
-- Roles (created by db/roles.sql, run once by the DBA with real passwords):
--   wa_app  – owns the schema; used by migrations and the dashboard backend.
--   wa_n8n  – used by n8n's Postgres credential. It can only EXECUTE the
--             functions granted below and read/write a few sync tables.
--             It cannot UPDATE conversations/outbound directly, so every send
--             and mode change still goes through the control functions.

BEGIN;
SET search_path = app, public;
SET LOCAL check_function_bodies = off;

-- Memory writes are scoped to the job's own customer / conversation.
CREATE FUNCTION app.upsert_customer_memory(p_job uuid, p_key text, p_value text, p_source_message uuid, p_confirmed_by text)
RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_customer uuid; v_id uuid;
BEGIN
  SELECT c.customer_id INTO v_customer FROM app.ai_jobs j JOIN app.conversations c ON c.id = j.conversation_id WHERE j.id = p_job;
  IF v_customer IS NULL THEN RAISE EXCEPTION 'job not found' USING ERRCODE = 'P0002'; END IF;
  IF p_source_message IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM app.messages m JOIN app.conversations c ON c.id = m.conversation_id
        WHERE m.id = p_source_message AND c.customer_id = v_customer AND m.direction = 'inbound') THEN
    RAISE EXCEPTION 'source message is not from this customer' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.customer_memories (customer_id, key, value, source_message_id, confirmed_by)
  VALUES (v_customer, p_key, p_value, p_source_message, p_confirmed_by)
  ON CONFLICT (customer_id, key) WHERE deleted_at IS NULL
  DO UPDATE SET value = excluded.value, source_message_id = excluded.source_message_id, updated_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION app.upsert_conversation_summary(p_conversation uuid, p_summary text, p_actions jsonb, p_open jsonb, p_covers_until timestamptz)
RETURNS void
LANGUAGE sql AS $$
  INSERT INTO app.conversation_summaries (conversation_id, summary, actions_taken, open_issues, covers_until)
  VALUES (p_conversation, left(p_summary, 2000), coalesce(p_actions, '[]'), coalesce(p_open, '[]'), p_covers_until)
  ON CONFLICT (conversation_id) DO UPDATE SET summary = excluded.summary, actions_taken = excluded.actions_taken,
    open_issues = excluded.open_issues, covers_until = excluded.covers_until,
    version = app.conversation_summaries.version + 1, updated_at = now()
$$;

-- Order access: private order data only for orders linked to THIS customer
-- through a verified method. An order number alone never grants access.
CREATE FUNCTION app.order_access_for_job(p_job uuid, p_woo_order_id bigint) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'allowed', EXISTS (SELECT 1 FROM app.order_links l WHERE l.customer_id = c.customer_id AND l.woo_order_id = p_woo_order_id
                         AND l.revoked_at IS NULL),
    'customer_id', c.customer_id)
  FROM app.ai_jobs j JOIN app.conversations c ON c.id = j.conversation_id
  WHERE j.id = p_job
$$;

-- Proposed order operation; the model only proposes, never executes.
CREATE FUNCTION app.propose_order_operation(p_job uuid, p_operation_id text, p_type text, p_woo_order_id bigint,
                                            p_payload jsonb, p_quote jsonb)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE c app.conversations; v_id uuid; v_status text; v_staff boolean;
BEGIN
  SELECT cv.* INTO c FROM app.ai_jobs j JOIN app.conversations cv ON cv.id = j.conversation_id WHERE j.id = p_job;
  IF c.id IS NULL THEN RAISE EXCEPTION 'job not found' USING ERRCODE = 'P0002'; END IF;
  IF p_woo_order_id IS NOT NULL AND p_type <> 'create_order' AND NOT (app.order_access_for_job(p_job, p_woo_order_id) ->> 'allowed')::boolean THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'order_not_verified_for_customer');
  END IF;
  -- Refunds, cancellations, discounts, address and payment-state changes
  -- always need staff approval (initial policy; see settings.order_ops).
  v_staff := p_type <> 'create_order' OR coalesce((app.setting('order_ops') ->> 'create_requires_staff_approval')::boolean, true);
  INSERT INTO app.pending_order_operations (operation_id, conversation_id, customer_id, op_type, woo_order_id, payload, quote,
                                            requires_staff_approval, status)
  VALUES (p_operation_id, c.id, c.customer_id, p_type, p_woo_order_id, p_payload, p_quote, v_staff,
          CASE WHEN p_type IN ('refund', 'cancel_order', 'address_change', 'discount', 'payment_state_change', 'renewal', 'access_issue')
               THEN 'awaiting_staff_approval' ELSE 'awaiting_customer_confirmation' END)
  ON CONFLICT (operation_id) DO NOTHING
  RETURNING id, status INTO v_id, v_status;
  IF v_id IS NULL THEN
    SELECT id, status INTO v_id, v_status FROM app.pending_order_operations WHERE operation_id = p_operation_id AND conversation_id = c.id;
    IF v_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'operation_id_conflict'); END IF;
  END IF;
  PERFORM app.notify('order_operation', c.id, jsonb_build_object('operation_id', p_operation_id, 'status', v_status));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'status', v_status, 'requires_staff_approval', v_staff);
END $$;

-- Customer confirmation of a proposed operation, recorded only against a
-- genuine inbound customer message in the same conversation.
CREATE FUNCTION app.confirm_order_operation(p_job uuid, p_operation_id text, p_message uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE p app.pending_order_operations; v_conv uuid;
BEGIN
  SELECT conversation_id INTO v_conv FROM app.ai_jobs WHERE id = p_job;
  SELECT * INTO p FROM app.pending_order_operations WHERE operation_id = p_operation_id AND conversation_id = v_conv FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF p.status <> 'awaiting_customer_confirmation' THEN RETURN jsonb_build_object('ok', false, 'reason', 'status_' || p.status); END IF;
  IF p.expires_at < now() THEN
    UPDATE app.pending_order_operations SET status = 'expired', updated_at = now() WHERE id = p.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.messages WHERE id = p_message AND conversation_id = v_conv AND direction = 'inbound' AND NOT is_historical) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'confirmation_must_be_customer_message');
  END IF;
  UPDATE app.pending_order_operations SET customer_confirmed_at = now(), customer_confirm_message_id = p_message,
         status = CASE WHEN requires_staff_approval THEN 'awaiting_staff_approval' ELSE 'approved' END, updated_at = now()
   WHERE id = p.id RETURNING status INTO p.status;
  PERFORM app.notify('order_operation', v_conv, jsonb_build_object('operation_id', p_operation_id, 'status', p.status));
  RETURN jsonb_build_object('ok', true, 'status', p.status);
END $$;

-- Staff decision on an operation (backend only).
CREATE FUNCTION app.decide_order_operation(p_id uuid, p_staff uuid, p_approve boolean, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE p app.pending_order_operations;
BEGIN
  PERFORM app.require_cap(p_staff, 'order_approve');
  SELECT * INTO p FROM app.pending_order_operations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'operation not found' USING ERRCODE = 'P0002'; END IF;
  IF p.status <> 'awaiting_staff_approval' THEN RETURN jsonb_build_object('ok', false, 'reason', 'status_' || p.status); END IF;
  IF p.op_type = 'create_order' AND p.customer_confirmed_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'customer_has_not_confirmed');
  END IF;
  UPDATE app.pending_order_operations SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
         staff_decision_by = p_staff, staff_decision_at = now(), result = coalesce(result, '{}') || jsonb_build_object('note', p_note),
         updated_at = now()
   WHERE id = p_id;
  PERFORM app.audit('staff', p_staff, CASE WHEN p_approve THEN 'order_op.approved' ELSE 'order_op.rejected' END,
                    'order_operation', p_id::text, jsonb_build_object('type', p.op_type, 'woo_order_id', p.woo_order_id));
  PERFORM app.notify('order_operation', p.conversation_id, jsonb_build_object('operation_id', p.operation_id));
  RETURN jsonb_build_object('ok', true, 'status', CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END);
END $$;

-- The executor claims an approved operation exactly once; an ambiguous result
-- becomes 'unknown' and must be reconciled against WooCommerce before retry.
CREATE FUNCTION app.claim_order_operation(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE p app.pending_order_operations;
BEGIN
  SELECT * INTO p FROM app.pending_order_operations WHERE id = p_id FOR UPDATE SKIP LOCKED;
  IF NOT FOUND OR p.status <> 'approved' THEN RETURN jsonb_build_object('claimed', false); END IF;
  IF NOT app.setting_bool('sending_enabled', true) THEN RETURN jsonb_build_object('claimed', false, 'reason', 'emergency_stop'); END IF;
  UPDATE app.pending_order_operations SET status = 'executing', updated_at = now() WHERE id = p_id;
  RETURN jsonb_build_object('claimed', true, 'operation_id', p.operation_id, 'type', p.op_type, 'woo_order_id', p.woo_order_id,
                            'payload', p.payload, 'quote', p.quote);
END $$;

CREATE FUNCTION app.finish_order_operation(p_id uuid, p_outcome text, p_woo_order_id bigint, p_result jsonb) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE p app.pending_order_operations;
BEGIN
  IF p_outcome NOT IN ('succeeded', 'failed', 'unknown') THEN RAISE EXCEPTION 'invalid outcome' USING ERRCODE = '22023'; END IF;
  UPDATE app.pending_order_operations SET status = p_outcome, woo_order_id = coalesce(p_woo_order_id, woo_order_id),
         result = coalesce(result, '{}') || coalesce(p_result, '{}'), updated_at = now()
   WHERE id = p_id AND status = 'executing' RETURNING * INTO p;
  IF p.id IS NULL THEN RETURN; END IF;
  IF p_outcome = 'succeeded' AND p.op_type = 'create_order' AND p_woo_order_id IS NOT NULL THEN
    INSERT INTO app.order_links (customer_id, woo_order_id, verified_method) VALUES (p.customer_id, p_woo_order_id, 'created_in_chat')
    ON CONFLICT DO NOTHING;
  END IF;
  IF p_outcome = 'unknown' THEN
    PERFORM app.raise_alert('order_op_unknown', 'critical', 'An order operation outcome is unknown; reconcile in WooCommerce before retrying.',
                            jsonb_build_object('operation_id', p.operation_id), 'order_op_unknown:' || p.operation_id);
  END IF;
  PERFORM app.notify('order_operation', p.conversation_id, jsonb_build_object('operation_id', p.operation_id, 'status', p_outcome));
END $$;

-- Knowledge proposals come in only as 'pending'; approval is a staff action.
CREATE FUNCTION app.submit_knowledge_proposal(p_kind text, p_document uuid, p_category text, p_title text, p_body text,
                                              p_rationale text, p_evidence jsonb, p_redaction jsonb, p_run text)
RETURNS uuid
LANGUAGE sql AS $$
  INSERT INTO app.knowledge_proposals (kind, document_id, category, proposed_title, proposed_body, rationale, evidence_refs,
                                       redaction_report, created_by_run)
  VALUES (p_kind, p_document, p_category, left(p_title, 200), left(p_body, 8000), left(p_rationale, 2000),
          coalesce(p_evidence, '[]'), coalesce(p_redaction, '{}'), p_run)
  RETURNING id
$$;

CREATE FUNCTION app.review_knowledge_proposal(p_proposal uuid, p_staff uuid, p_action text, p_title text DEFAULT NULL,
                                              p_body text DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE pr app.knowledge_proposals; v_doc uuid; v_ver uuid; v_no integer; v_slug text;
BEGIN
  PERFORM app.require_cap(p_staff, 'knowledge_review');
  SELECT * INTO pr FROM app.knowledge_proposals WHERE id = p_proposal FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'proposal not found' USING ERRCODE = 'P0002'; END IF;
  IF pr.status <> 'pending' THEN RETURN jsonb_build_object('ok', false, 'reason', 'status_' || pr.status); END IF;
  IF p_action = 'reject' THEN
    UPDATE app.knowledge_proposals SET status = 'rejected', reviewed_by = p_staff, reviewed_at = now(), review_note = p_note WHERE id = p_proposal;
    PERFORM app.audit('staff', p_staff, 'knowledge.proposal_rejected', 'knowledge_proposal', p_proposal::text, '{}');
    RETURN jsonb_build_object('ok', true, 'status', 'rejected');
  ELSIF p_action NOT IN ('approve', 'edit_approve') THEN
    RAISE EXCEPTION 'invalid action' USING ERRCODE = '22023';
  END IF;
  v_doc := pr.document_id;
  IF v_doc IS NULL THEN
    v_slug := left(regexp_replace(lower(coalesce(p_title, pr.proposed_title)), '[^a-z0-9]+', '-', 'g'), 60) || '-' || left(p_proposal::text, 8);
    INSERT INTO app.knowledge_documents (shop_id, slug, category) SELECT id, v_slug, pr.category FROM app.shops LIMIT 1
    RETURNING id INTO v_doc;
  END IF;
  SELECT coalesce(max(version_no), 0) + 1 INTO v_no FROM app.knowledge_versions WHERE document_id = v_doc;
  INSERT INTO app.knowledge_versions (document_id, version_no, title, body, status, source, proposal_id, created_by, approved_by, approved_at)
  VALUES (v_doc, v_no, coalesce(nullif(p_title, ''), pr.proposed_title), coalesce(nullif(p_body, ''), pr.proposed_body),
          'approved', 'learning_proposal', p_proposal, p_staff, p_staff, now())
  RETURNING id INTO v_ver;
  PERFORM app.publish_knowledge_version(v_ver, p_staff);
  UPDATE app.knowledge_proposals SET status = 'approved', reviewed_by = p_staff, reviewed_at = now(), review_note = p_note,
         resulting_version_id = v_ver WHERE id = p_proposal;
  RETURN jsonb_build_object('ok', true, 'status', 'approved', 'version_id', v_ver);
END $$;

-- Publish (or roll back to) a specific version: the previous published one is
-- superseded but kept, so rollback is just publishing an older version.
CREATE FUNCTION app.publish_knowledge_version(p_version uuid, p_staff uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v app.knowledge_versions; v_prev uuid;
BEGIN
  PERFORM app.require_cap(p_staff, 'knowledge_review');
  SELECT * INTO v FROM app.knowledge_versions WHERE id = p_version FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'version not found' USING ERRCODE = 'P0002'; END IF;
  SELECT published_version_id INTO v_prev FROM app.knowledge_documents WHERE id = v.document_id FOR UPDATE;
  UPDATE app.knowledge_versions SET status = 'superseded' WHERE id = v_prev AND id <> p_version;
  UPDATE app.knowledge_versions SET status = 'approved', approved_by = coalesce(approved_by, p_staff),
         approved_at = coalesce(approved_at, now()) WHERE id = p_version;
  UPDATE app.knowledge_documents SET published_version_id = p_version, status = 'active' WHERE id = v.document_id;
  PERFORM app.audit('staff', p_staff, 'knowledge.published', 'knowledge_document', v.document_id::text,
                    jsonb_build_object('version_id', p_version, 'previous_version_id', v_prev, 'version_no', v.version_no));
END $$;

-- Every function runs with the owner's rights and a fixed search_path; by
-- default nobody may execute them until granted below.
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER SET search_path = app, pg_temp', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
  END LOOP;
END $$;

-- Grants for the workflow role live in db/grants.sql (re-run after every migration).

INSERT INTO app.schema_migrations (version) VALUES ('0004_scoped_writes_and_roles');
COMMIT;
