-- 0003_context_and_search.sql
-- Read-side functions used by n8n and the backend: AI context, approved
-- knowledge search, escalation counters, image-analysis reuse, metrics.

BEGIN;
SET search_path = app, public;
SET LOCAL check_function_bodies = off;

-- Only APPROVED + PUBLISHED knowledge is searchable. Drafts, pending
-- proposals and rejected versions can never reach the model.
CREATE FUNCTION app.search_knowledge(p_query text, p_limit integer DEFAULT 5)
RETURNS TABLE (document_id uuid, version_id uuid, slug text, category text, title text, body text, rank real)
LANGUAGE sql STABLE AS $$
  WITH q AS (SELECT websearch_to_tsquery('simple', coalesce(p_query, '')) AS tsq)
  SELECT d.id, v.id, d.slug, d.category, v.title, v.body,
         (ts_rank(v.search_tsv, q.tsq) + 0.3 * similarity(v.title, coalesce(p_query, '')))::real AS rank
  FROM app.knowledge_documents d
  JOIN app.knowledge_versions v ON v.id = d.published_version_id AND v.status = 'approved'
  CROSS JOIN q
  WHERE d.status = 'active'
    AND (v.search_tsv @@ q.tsq OR similarity(v.title, coalesce(p_query, '')) > 0.2
         OR v.body ILIKE '%' || left(coalesce(p_query, ''), 60) || '%')
  ORDER BY rank DESC
  LIMIT least(greatest(p_limit, 1), 10)
$$;

-- Everything the reply workflow needs for one job, scoped to that job's
-- conversation and customer. Internal notes and drafts are excluded.
CREATE FUNCTION app.get_ai_context(p_job uuid, p_message_limit integer DEFAULT 20)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'job', jsonb_build_object('id', j.id, 'kind', j.kind, 'mode_at_start', j.mode_at_start,
                              'mode_version', j.mode_version_at_start, 'revision', j.revision_at_start,
                              'trigger_message_id', j.trigger_message_id),
    'conversation', jsonb_build_object('id', c.id, 'mode', c.mode, 'status', c.status, 'tags', c.tags,
                                       'last_inbound_at', c.last_inbound_at,
                                       'window_open', c.last_inbound_at > now() - make_interval(hours => app.setting_int('messaging_window_hours', 24))),
    'customer', jsonb_build_object('id', cu.id, 'display_name', cu.display_name, 'preferred_language', cu.preferred_language,
                                   'has_verified_account_link', EXISTS (SELECT 1 FROM app.customer_account_links l
                                                                        WHERE l.customer_id = cu.id AND l.revoked_at IS NULL)),
    'summary', (SELECT jsonb_build_object('summary', s.summary, 'actions_taken', s.actions_taken, 'open_issues', s.open_issues)
                FROM app.conversation_summaries s WHERE s.conversation_id = c.id),
    'customer_memory', coalesce((SELECT jsonb_agg(jsonb_build_object('key', m.key, 'value', m.value) ORDER BY m.key)
                                 FROM app.customer_memories m WHERE m.customer_id = cu.id AND m.deleted_at IS NULL), '[]'),
    'verified_order_ids', coalesce((SELECT jsonb_agg(o.woo_order_id) FROM app.order_links o
                                    WHERE o.customer_id = cu.id AND o.revoked_at IS NULL), '[]'),
    'pending_operations', coalesce((SELECT jsonb_agg(jsonb_build_object('operation_id', p.operation_id, 'type', p.op_type,
                                                                        'status', p.status, 'woo_order_id', p.woo_order_id))
                                    FROM app.pending_order_operations p
                                    WHERE p.conversation_id = c.id AND p.status IN ('awaiting_customer_confirmation', 'awaiting_staff_approval', 'approved', 'executing', 'unknown')), '[]'),
    'messages', coalesce((
      SELECT jsonb_agg(x.m ORDER BY x.sent_at, x.recorded_at)
      FROM (
        SELECT msg.sent_at, msg.recorded_at, jsonb_build_object(
                 'id', msg.id,
                 'role', CASE WHEN msg.direction = 'inbound' THEN 'customer'
                              WHEN msg.author_type = 'ai' THEN 'assistant'
                              WHEN msg.author_type IN ('staff', 'external_human') THEN 'staff'
                              ELSE 'business' END,
                 'kind', msg.kind,
                 'text', CASE WHEN msg.redacted_at IS NOT NULL THEN '[removed]' ELSE msg.body END,
                 'sent_at', msg.sent_at,
                 'historical', msg.is_historical,
                 'attachments', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                   'attachment_id', a.id, 'type', a.media_type, 'mime_type', a.mime_type,
                                   'size_bytes', a.size_bytes, 'fetch_status', a.fetch_status,
                                   'analysis', (SELECT jsonb_build_object('status', ia.status, 'result', ia.result, 'model', ia.model)
                                                FROM app.image_analyses ia WHERE ia.attachment_id = a.id
                                                ORDER BY ia.created_at DESC LIMIT 1)) ORDER BY a.position)
                                  FROM app.attachments a WHERE a.message_id = msg.id), '[]')) AS m
        FROM app.messages msg
        WHERE msg.conversation_id = c.id AND msg.deleted_by_sender_at IS NULL
        ORDER BY msg.sent_at DESC, msg.recorded_at DESC
        LIMIT least(greatest(p_message_limit, 1), 60)
      ) x), '[]'),
    'escalation_state', app.escalation_state(c.id)
  )
  FROM app.ai_jobs j
  JOIN app.conversations c ON c.id = j.conversation_id
  JOIN app.customers cu ON cu.id = c.customer_id
  WHERE j.id = p_job
$$;

-- Counters the escalation rules use. Computed from stored facts only.
CREATE FUNCTION app.escalation_state(p_conversation uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'ai_unresolved_turns_24h', (SELECT count(*) FROM app.ai_jobs
                                WHERE conversation_id = p_conversation AND started_at > now() - interval '24 hours'
                                  AND (result ->> 'resolved')::boolean IS FALSE),
    'complaint_turns_24h', (SELECT count(*) FROM app.ai_jobs
                            WHERE conversation_id = p_conversation AND started_at > now() - interval '24 hours'
                              AND result -> 'intents' ? 'complaint'),
    'negative_feedback_7d', (SELECT count(*) FROM app.feedback
                             WHERE conversation_id = p_conversation AND created_at > now() - interval '7 days'
                               AND (rating <= 2 OR label IN ('ai_wrong', 'draft_rejected'))),
    'handoffs_7d', (SELECT count(*) FROM app.mode_changes
                    WHERE conversation_id = p_conversation AND to_mode = 'HUMAN' AND at > now() - interval '7 days')
  )
$$;

-- Vision reuse: an unchanged image already analysed with the same model and
-- prompt version is not sent to the model again.
CREATE FUNCTION app.find_image_analysis(p_attachment uuid, p_model text, p_prompt_version text)
RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('analysis_id', ia.id, 'result', ia.result, 'status', ia.status)
  FROM app.attachments a
  JOIN app.image_analyses ia ON ia.sha256 = a.sha256 AND ia.model = p_model AND ia.prompt_version = p_prompt_version AND ia.status = 'ok'
  WHERE a.id = p_attachment
  ORDER BY ia.created_at DESC
  LIMIT 1
$$;

-- Media bytes for the vision step, only for an attachment that belongs to the
-- job's own conversation and passed validation on download.
CREATE FUNCTION app.get_attachment_for_job(p_job uuid, p_attachment uuid)
RETURNS TABLE (attachment_id uuid, mime_type text, size_bytes bigint, sha256_hex text, data_base64 text)
LANGUAGE sql STABLE AS $$
  SELECT a.id, a.mime_type, a.size_bytes, encode(a.sha256, 'hex'), encode(b.data, 'base64')
  FROM app.ai_jobs j
  JOIN app.messages m ON m.conversation_id = j.conversation_id
  JOIN app.attachments a ON a.message_id = m.id AND a.id = p_attachment AND a.fetch_status = 'stored'
  JOIN app.attachment_blobs b ON b.attachment_id = a.id
  WHERE j.id = p_job
$$;

CREATE FUNCTION app.record_ai_usage(p_job uuid, p_purpose text, p_usage jsonb) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_conv uuid;
BEGIN
  SELECT conversation_id INTO v_conv FROM app.ai_jobs WHERE id = p_job;
  INSERT INTO app.ai_usage (ai_job_id, conversation_id, purpose, model, provider, request_id, latency_ms,
                            prompt_tokens, completion_tokens, reasoning_tokens, cost_usd, usage_available, outcome, error)
  VALUES (p_job, v_conv, p_purpose, coalesce(p_usage ->> 'model', 'unknown'), p_usage ->> 'provider', p_usage ->> 'request_id',
          (p_usage ->> 'latency_ms')::integer,
          -- Missing usage stays NULL ("unavailable"), never 0.
          (p_usage ->> 'prompt_tokens')::integer, (p_usage ->> 'completion_tokens')::integer,
          (p_usage ->> 'reasoning_tokens')::integer, (p_usage ->> 'cost_usd')::numeric,
          (p_usage ? 'prompt_tokens') AND p_usage ->> 'prompt_tokens' IS NOT NULL,
          coalesce(p_usage ->> 'outcome', 'ok'), left(p_usage ->> 'error', 1000))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Spending guard: AI calls are refused once today's recorded cost reaches the
-- configured limit (checked by workflows before each model call).
CREATE FUNCTION app.ai_budget_status() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH spent AS (SELECT coalesce(sum(cost_usd), 0) AS usd FROM app.ai_usage WHERE created_at > now() - interval '24 hours'),
       lim AS (SELECT coalesce((app.setting('ai_daily_budget_usd') #>> '{}')::numeric, 5) AS usd)
  SELECT jsonb_build_object(
    'spent_24h_usd', spent.usd,
    'limit_24h_usd', lim.usd,
    'calls_without_usage_24h', (SELECT count(*) FROM app.ai_usage WHERE created_at > now() - interval '24 hours' AND NOT usage_available),
    'within_budget', spent.usd < lim.usd)
  FROM spent, lim
$$;

CREATE FUNCTION app.store_image_analysis(p_job uuid, p_attachment uuid, p_model text, p_prompt_version text,
                                         p_question text, p_status text, p_result jsonb, p_error text, p_usage uuid)
RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_sha bytea;
BEGIN
  -- Only attachments inside the job's conversation.
  SELECT a.sha256 INTO v_sha FROM app.ai_jobs j JOIN app.messages m ON m.conversation_id = j.conversation_id
    JOIN app.attachments a ON a.message_id = m.id WHERE j.id = p_job AND a.id = p_attachment;
  IF v_sha IS NULL THEN RAISE EXCEPTION 'attachment not in job conversation' USING ERRCODE = '42501'; END IF;
  INSERT INTO app.image_analyses (attachment_id, sha256, model, prompt_version, question, status, result, error, ai_usage_id)
  VALUES (p_attachment, v_sha, p_model, p_prompt_version, left(p_question, 1000), p_status,
          CASE WHEN p_status = 'ok' THEN p_result END, left(p_error, 1000), p_usage)
  ON CONFLICT (sha256, model, prompt_version) WHERE status = 'ok' DO UPDATE SET attachment_id = excluded.attachment_id
  RETURNING id INTO v_id;
  PERFORM app.notify('image_analysis', (SELECT conversation_id FROM app.ai_jobs WHERE id = p_job),
                     jsonb_build_object('attachment_id', p_attachment, 'status', p_status));
  RETURN v_id;
END $$;

-- Attachment download results written by the media workflow.
CREATE FUNCTION app.store_attachment_blob(p_attachment uuid, p_mime text, p_data_base64 text, p_max_bytes integer, p_allowed_mimes text[])
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_bytes bytea; v_mime text; v_conv uuid;
BEGIN
  v_bytes := decode(p_data_base64, 'base64');
  v_mime := lower(split_part(coalesce(p_mime, ''), ';', 1));
  SELECT m.conversation_id INTO v_conv FROM app.attachments a JOIN app.messages m ON m.id = a.message_id WHERE a.id = p_attachment;
  IF octet_length(v_bytes) > p_max_bytes THEN
    UPDATE app.attachments SET fetch_status = 'too_large', size_bytes = octet_length(v_bytes), mime_type = v_mime, fetched_at = now()
     WHERE id = p_attachment;
    RETURN jsonb_build_object('status', 'too_large');
  END IF;
  -- Magic-byte check: the declared type must match the actual bytes.
  IF NOT (v_mime = ANY (p_allowed_mimes)) OR NOT (
       (v_mime = 'image/jpeg' AND substring(v_bytes from 1 for 3) = '\xffd8ff'::bytea) OR
       (v_mime = 'image/png'  AND substring(v_bytes from 1 for 8) = '\x89504e470d0a1a0a'::bytea) OR
       (v_mime = 'image/webp' AND substring(v_bytes from 1 for 4) = '\x52494646'::bytea AND substring(v_bytes from 9 for 4) = '\x57454250'::bytea) OR
       (v_mime = 'application/pdf' AND substring(v_bytes from 1 for 4) = '\x25504446'::bytea) OR
       (v_mime IN ('audio/ogg', 'audio/ogg; codecs=opus') AND substring(v_bytes from 1 for 4) = '\x4f676753'::bytea) OR
       (v_mime IN ('audio/mpeg') AND (substring(v_bytes from 1 for 3) = '\x494433'::bytea OR get_byte(v_bytes, 0) = 255)) OR
       (v_mime IN ('audio/mp4', 'video/mp4') AND substring(v_bytes from 5 for 4) = '\x66747970'::bytea)) THEN
    UPDATE app.attachments SET fetch_status = 'rejected_type', size_bytes = octet_length(v_bytes), mime_type = v_mime, fetched_at = now()
     WHERE id = p_attachment;
    RETURN jsonb_build_object('status', 'rejected_type');
  END IF;
  INSERT INTO app.attachment_blobs (attachment_id, data) VALUES (p_attachment, v_bytes)
  ON CONFLICT (attachment_id) DO UPDATE SET data = excluded.data;
  UPDATE app.attachments SET fetch_status = 'stored', mime_type = v_mime, size_bytes = octet_length(v_bytes),
         sha256 = sha256(v_bytes), fetched_at = now(), fetch_error = NULL
   WHERE id = p_attachment;
  PERFORM app.notify('attachment', v_conv, jsonb_build_object('attachment_id', p_attachment, 'status', 'stored'));
  RETURN jsonb_build_object('status', 'stored', 'sha256', encode(sha256(v_bytes), 'hex'));
END $$;

CREATE FUNCTION app.mark_attachment_fetch_failed(p_attachment uuid, p_status text, p_error text) RETURNS void
LANGUAGE sql AS $$
  UPDATE app.attachments SET fetch_status = CASE WHEN p_status IN ('expired', 'failed') THEN p_status ELSE 'failed' END,
         fetch_error = left(p_error, 500), fetched_at = now()
   WHERE id = p_attachment
$$;

-- ---------------------------------------------------------------------------
-- Metrics (definitions documented in docs/METRICS.md)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.metrics(p_from timestamptz, p_to timestamptz) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH inbound AS (
    SELECT m.conversation_id, m.sent_at,
           (SELECT min(o.sent_at) FROM app.messages o
             WHERE o.conversation_id = m.conversation_id AND o.direction = 'outbound'
               AND o.author_type IN ('ai', 'staff', 'external_human') AND o.sent_at >= m.sent_at) AS answered_at
    FROM app.messages m
    WHERE m.direction = 'inbound' AND NOT m.is_historical AND m.sent_at BETWEEN p_from AND p_to
      AND NOT EXISTS (SELECT 1 FROM app.messages p WHERE p.conversation_id = m.conversation_id AND p.direction = 'inbound'
                        AND p.sent_at < m.sent_at AND p.sent_at > m.sent_at - interval '10 minutes')
  )
  SELECT jsonb_build_object(
    'window', jsonb_build_object('from', p_from, 'to', p_to),
    'first_response_seconds_median', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM answered_at - sent_at))
                                      FROM inbound WHERE answered_at IS NOT NULL),
    'first_response_seconds_p90', (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM answered_at - sent_at))
                                   FROM inbound WHERE answered_at IS NOT NULL),
    'unanswered_customer_bursts', (SELECT count(*) FROM inbound WHERE answered_at IS NULL),
    'unresolved_conversations', (SELECT count(*) FROM app.conversations WHERE status IN ('open', 'pending') AND NOT is_sandbox),
    'waiting_for_staff', (SELECT count(*) FROM app.conversations WHERE queue_state = 'waiting_staff' AND status IN ('open', 'pending')),
    'handoffs', (SELECT jsonb_object_agg(reason, n) FROM (
                   SELECT split_part(reason, ':', 1) AS reason, count(*) AS n FROM app.mode_changes
                   WHERE to_mode = 'HUMAN' AND at BETWEEN p_from AND p_to GROUP BY 1) h),
    'messages_sent', (SELECT jsonb_object_agg(author_type, n) FROM (
                        SELECT author_type, count(*) AS n FROM app.messages
                        WHERE direction = 'outbound' AND sent_at BETWEEN p_from AND p_to GROUP BY 1) s),
    'drafts', (SELECT jsonb_object_agg(status, n) FROM (
                 SELECT status, count(*) AS n FROM app.ai_drafts WHERE created_at BETWEEN p_from AND p_to GROUP BY 1) d),
    'customer_feedback_avg', (SELECT avg(rating) FROM app.feedback WHERE source = 'customer' AND rating IS NOT NULL
                                AND created_at BETWEEN p_from AND p_to),
    'ai_cost_usd', (SELECT sum(cost_usd) FROM app.ai_usage WHERE created_at BETWEEN p_from AND p_to),
    'ai_calls', (SELECT count(*) FROM app.ai_usage WHERE created_at BETWEEN p_from AND p_to),
    'ai_calls_usage_unavailable', (SELECT count(*) FROM app.ai_usage WHERE created_at BETWEEN p_from AND p_to AND NOT usage_available),
    -- Attribution: an order counts as chat-assisted when it was created in chat
    -- or linked to a conversation in which the customer wrote within the 72h
    -- before the order was paid. See docs/METRICS.md.
    'orders_created_in_chat', (SELECT count(*) FROM app.pending_order_operations
                               WHERE op_type = 'create_order' AND status = 'succeeded' AND updated_at BETWEEN p_from AND p_to),
    'orders_chat_assisted_paid', (SELECT count(DISTINCT r.woo_order_id) FROM app.woo_order_refs r
                                  JOIN app.order_links l ON l.woo_order_id = r.woo_order_id AND l.revoked_at IS NULL
                                  JOIN app.conversations c ON c.customer_id = l.customer_id
                                  WHERE r.date_paid BETWEEN p_from AND p_to
                                    AND EXISTS (SELECT 1 FROM app.messages m WHERE m.conversation_id = c.id AND m.direction = 'inbound'
                                                  AND m.sent_at BETWEEN r.date_paid - interval '72 hours' AND r.date_paid))
  )
$$;

INSERT INTO app.schema_migrations (version) VALUES ('0003_context_and_search');
COMMIT;
