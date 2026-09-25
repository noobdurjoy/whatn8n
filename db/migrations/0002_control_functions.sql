-- 0002_control_functions.sql
-- The enforcement point. Every mode change, AI result and outgoing message goes
-- through these functions, whether it comes from the dashboard backend or from
-- n8n. They serialize on the conversation row (SELECT ... FOR UPDATE), so a
-- takeover and a send authorization for the same conversation can never
-- interleave. Lock order is always: conversation first, then its rows.

BEGIN;
SET search_path = app, public;

ALTER TABLE app.conversations ADD COLUMN is_sandbox boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.setting(p_key text) RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT value FROM app.settings WHERE key = p_key $$;

CREATE FUNCTION app.setting_bool(p_key text, p_default boolean) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT (value #>> '{}')::boolean FROM app.settings WHERE key = p_key), p_default)
$$;

CREATE FUNCTION app.setting_int(p_key text, p_default integer) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT (value #>> '{}')::integer FROM app.settings WHERE key = p_key), p_default)
$$;

-- IDs only: listeners re-read everything through permission-checked queries.
CREATE FUNCTION app.notify(p_type text, p_conversation uuid, p_extra jsonb DEFAULT '{}') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('app_events',
    (jsonb_build_object('type', p_type, 'conversation_id', p_conversation) || coalesce(p_extra, '{}'))::text);
END $$;

CREATE FUNCTION app.audit(p_actor_type text, p_actor uuid, p_action text, p_entity_type text, p_entity_id text, p_details jsonb DEFAULT '{}')
RETURNS void LANGUAGE sql AS $$
  INSERT INTO app.audit_log (actor_type, actor_id, action, entity_type, entity_id, details)
  VALUES (p_actor_type, p_actor, p_action, p_entity_type, p_entity_id, coalesce(p_details, '{}'))
$$;

CREATE FUNCTION app.raise_alert(p_kind text, p_severity text, p_message text, p_details jsonb, p_dedupe text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO app.alerts (kind, severity, message, details, dedupe_key)
  VALUES (p_kind, p_severity, p_message, coalesce(p_details, '{}'), p_dedupe)
  ON CONFLICT (dedupe_key) WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL DO NOTHING;
  PERFORM pg_notify('app_events', jsonb_build_object('type', 'alert', 'kind', p_kind)::text);
END $$;

-- Role → capability matrix. Mirrored in the backend (src/lib/permissions.ts);
-- a test asserts both agree. The backend checks first for a fast UI answer,
-- these functions check again so no caller can skip it.
CREATE FUNCTION app.role_capabilities(p_role text) RETURNS text[]
LANGUAGE sql STABLE AS $$
  SELECT CASE p_role
    WHEN 'agent' THEN ARRAY['view', 'reply', 'note', 'takeover', 'set_copilot', 'approve_draft', 'assign_self',
                            'tag', 'tickets', 'request_ai_assist', 'view_orders']
                      || CASE WHEN app.setting_bool('agents_can_resume_ai', false) THEN ARRAY['resume_ai'] ELSE ARRAY[]::text[] END
    WHEN 'admin' THEN ARRAY['view', 'reply', 'note', 'takeover', 'set_copilot', 'approve_draft', 'assign_self',
                            'tag', 'tickets', 'request_ai_assist', 'view_orders',
                            'resume_ai', 'assign_any', 'global_ai', 'emergency_stop', 'knowledge_review',
                            'settings', 'prompts', 'canned_manage', 'export_customer', 'reconcile_send',
                            'order_approve', 'clear_hold', 'view_audit', 'view_metrics', 'history_import']
    WHEN 'owner' THEN ARRAY['view', 'reply', 'note', 'takeover', 'set_copilot', 'approve_draft', 'assign_self',
                            'tag', 'tickets', 'request_ai_assist', 'view_orders',
                            'resume_ai', 'assign_any', 'global_ai', 'emergency_stop', 'knowledge_review',
                            'settings', 'prompts', 'canned_manage', 'export_customer', 'reconcile_send',
                            'order_approve', 'clear_hold', 'view_audit', 'view_metrics', 'history_import',
                            'delete_customer', 'manage_staff']
    ELSE ARRAY[]::text[]
  END
$$;

CREATE FUNCTION app.staff_can(p_staff uuid, p_capability text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    SELECT p_capability = ANY (app.role_capabilities(role))
    FROM app.staff_users WHERE id = p_staff AND active
  ), false)
$$;

CREATE FUNCTION app.require_cap(p_staff uuid, p_capability text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- Staff actions come only from the authenticated backend. The workflow
  -- engine's database role can never act as a staff member.
  IF session_user = 'wa_n8n' THEN
    RAISE EXCEPTION 'staff actions are not allowed for the workflow role' USING ERRCODE = '42501';
  END IF;
  IF p_staff IS NULL OR NOT app.staff_can(p_staff, p_capability) THEN
    RAISE EXCEPTION 'permission denied: %', p_capability USING ERRCODE = '42501';
  END IF;
END $$;

CREATE FUNCTION app.lock_conversation(p_conversation uuid) RETURNS app.conversations
LANGUAGE plpgsql AS $$
DECLARE c app.conversations;
BEGIN
  SELECT * INTO c FROM app.conversations WHERE id = p_conversation FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation % not found', p_conversation USING ERRCODE = 'P0002';
  END IF;
  RETURN c;
END $$;

-- ---------------------------------------------------------------------------
-- Takeover (handoff to HUMAN). Atomic:
--   save HUMAN + reason, increment mode_version, cancel pending AI sends,
--   flag in-flight AI sends, invalidate drafts, cancel running AI jobs,
--   assign/queue, optionally enqueue ONE fixed acknowledgment, notify.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.take_over(
  p_conversation uuid,
  p_actor_type   text,          -- staff | system | customer | provider
  p_staff        uuid,
  p_reason       text,
  p_detail       jsonb DEFAULT '{}',
  p_send_ack     boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  c            app.conversations;
  v_new        integer;
  v_canceled   integer := 0;
  v_inflight   integer := 0;
  v_drafts     integer := 0;
  v_jobs       integer := 0;
  v_ack_id     uuid;
  v_ack        jsonb;
  v_lang       text;
  v_ack_text   text;
BEGIN
  IF p_actor_type = 'staff' THEN
    PERFORM app.require_cap(p_staff, 'takeover');
  END IF;

  c := app.lock_conversation(p_conversation);
  v_new := c.mode_version + 1;

  UPDATE app.conversations SET
    mode = 'HUMAN',
    mode_version = v_new,
    mode_reason = p_reason,
    mode_changed_at = now(),
    mode_changed_by_type = p_actor_type,
    mode_changed_by = CASE WHEN p_actor_type = 'staff' THEN p_staff END,
    assigned_to = CASE WHEN c.assigned_to IS NULL AND p_actor_type = 'staff' THEN p_staff ELSE c.assigned_to END,
    queue_state = CASE WHEN coalesce(c.assigned_to, CASE WHEN p_actor_type = 'staff' THEN p_staff END) IS NULL
                       THEN 'waiting_staff' ELSE 'assigned' END,
    updated_at = now()
  WHERE id = p_conversation;

  UPDATE app.outbound_messages
     SET status = 'canceled', status_reason = 'takeover', updated_at = now()
   WHERE conversation_id = p_conversation AND actor_type = 'ai' AND status IN ('queued', 'blocked');
  GET DIAGNOSTICS v_canceled = ROW_COUNT;

  -- Already handed to the provider: cannot be recalled; the dashboard shows it.
  UPDATE app.outbound_messages
     SET in_flight_at_takeover = true, updated_at = now()
   WHERE conversation_id = p_conversation AND actor_type = 'ai' AND status IN ('sending', 'unknown');
  GET DIAGNOSTICS v_inflight = ROW_COUNT;

  UPDATE app.ai_drafts SET status = 'invalidated', invalidated_reason = 'takeover'
   WHERE conversation_id = p_conversation AND status = 'pending_review';
  GET DIAGNOSTICS v_drafts = ROW_COUNT;

  UPDATE app.ai_jobs SET status = 'canceled', discard_reason = 'takeover', finished_at = now()
   WHERE conversation_id = p_conversation AND status = 'running' AND kind IN ('reply', 'vision');
  GET DIAGNOSTICS v_jobs = ROW_COUNT;

  INSERT INTO app.mode_changes (conversation_id, from_mode, to_mode, from_version, to_version, reason, detail, actor_type, actor_staff_id)
  VALUES (p_conversation, c.mode, 'HUMAN', c.mode_version, v_new, p_reason, coalesce(p_detail, '{}'), p_actor_type,
          CASE WHEN p_actor_type = 'staff' THEN p_staff END);

  -- One fixed acknowledgment per handoff, never generated text.
  v_ack := app.setting('handoff_ack');
  IF p_send_ack AND coalesce((v_ack ->> 'enabled')::boolean, false) AND NOT c.is_sandbox THEN
    SELECT preferred_language INTO v_lang FROM app.customers WHERE id = c.customer_id;
    v_ack_text := coalesce(v_ack -> 'text' ->> coalesce(v_lang, 'en'), v_ack -> 'text' ->> 'en');
    IF v_ack_text IS NOT NULL AND length(v_ack_text) > 0 THEN
      INSERT INTO app.outbound_messages (conversation_id, kind, category, actor_type, body, expected_mode_version, dedupe_key)
      VALUES (p_conversation, 'handoff_ack', 'service', 'system', v_ack_text, v_new,
              'handoff_ack:' || p_conversation || ':' || v_new)
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id INTO v_ack_id;
      UPDATE app.conversations SET handoff_ack_sent_version = v_new WHERE id = p_conversation;
    END IF;
  END IF;

  PERFORM app.audit(p_actor_type, p_staff, 'conversation.take_over', 'conversation', p_conversation::text,
    jsonb_build_object('reason', p_reason, 'from_mode', c.mode, 'mode_version', v_new,
                       'canceled_ai_sends', v_canceled, 'in_flight_ai_sends', v_inflight,
                       'invalidated_drafts', v_drafts, 'canceled_jobs', v_jobs, 'detail', p_detail));
  PERFORM app.notify('mode_changed', p_conversation, jsonb_build_object('mode', 'HUMAN', 'mode_version', v_new));

  RETURN jsonb_build_object('mode', 'HUMAN', 'mode_version', v_new, 'canceled_ai_sends', v_canceled,
                            'in_flight_ai_sends', v_inflight, 'invalidated_drafts', v_drafts,
                            'canceled_jobs', v_jobs, 'ack_outbound_id', v_ack_id);
END $$;

-- ---------------------------------------------------------------------------
-- Explicit mode change by staff. Returning to AUTO needs 'resume_ai'.
-- Canceled sends stay canceled: nothing is re-released.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.set_mode(p_conversation uuid, p_mode text, p_staff uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  c        app.conversations;
  v_new    integer;
  v_canc   integer := 0;
  v_drafts integer := 0;
BEGIN
  IF p_mode NOT IN ('AUTO', 'COPILOT', 'HUMAN') THEN
    RAISE EXCEPTION 'invalid mode %', p_mode USING ERRCODE = '22023';
  END IF;
  IF p_mode = 'HUMAN' THEN
    RETURN app.take_over(p_conversation, 'staff', p_staff, coalesce(p_reason, 'staff_take_over'), '{}', false);
  END IF;
  PERFORM app.require_cap(p_staff, CASE p_mode WHEN 'AUTO' THEN 'resume_ai' ELSE 'set_copilot' END);

  c := app.lock_conversation(p_conversation);
  IF c.mode = p_mode THEN
    RETURN jsonb_build_object('mode', c.mode, 'mode_version', c.mode_version, 'changed', false);
  END IF;
  v_new := c.mode_version + 1;

  UPDATE app.conversations SET
    mode = p_mode, mode_version = v_new, mode_reason = coalesce(p_reason, 'staff_set_' || lower(p_mode)),
    mode_changed_at = now(), mode_changed_by_type = 'staff', mode_changed_by = p_staff,
    queue_state = CASE WHEN p_mode = 'AUTO' THEN 'none' ELSE queue_state END,
    updated_at = now()
  WHERE id = p_conversation;

  -- Pending AI work was computed under the old mode.
  UPDATE app.outbound_messages SET status = 'canceled', status_reason = 'mode_changed', updated_at = now()
   WHERE conversation_id = p_conversation AND actor_type = 'ai' AND status IN ('queued', 'blocked');
  GET DIAGNOSTICS v_canc = ROW_COUNT;
  UPDATE app.ai_drafts SET status = 'invalidated', invalidated_reason = 'mode_changed'
   WHERE conversation_id = p_conversation AND status = 'pending_review';
  GET DIAGNOSTICS v_drafts = ROW_COUNT;
  UPDATE app.ai_jobs SET status = 'canceled', discard_reason = 'mode_changed', finished_at = now()
   WHERE conversation_id = p_conversation AND status = 'running' AND kind IN ('reply', 'vision');

  INSERT INTO app.mode_changes (conversation_id, from_mode, to_mode, from_version, to_version, reason, actor_type, actor_staff_id)
  VALUES (p_conversation, c.mode, p_mode, c.mode_version, v_new, coalesce(p_reason, 'staff_set_' || lower(p_mode)), 'staff', p_staff);
  PERFORM app.audit('staff', p_staff, 'conversation.set_mode', 'conversation', p_conversation::text,
    jsonb_build_object('from', c.mode, 'to', p_mode, 'mode_version', v_new, 'canceled_ai_sends', v_canc, 'invalidated_drafts', v_drafts));
  PERFORM app.notify('mode_changed', p_conversation, jsonb_build_object('mode', p_mode, 'mode_version', v_new));
  RETURN jsonb_build_object('mode', p_mode, 'mode_version', v_new, 'changed', true,
                            'canceled_ai_sends', v_canc, 'invalidated_drafts', v_drafts);
END $$;

-- Place / clear an automation hold (unknown-origin echo, other automation).
CREATE FUNCTION app.set_automation_hold(p_conversation uuid, p_reason text, p_detail jsonb DEFAULT '{}')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE c app.conversations; v_n integer;
BEGIN
  c := app.lock_conversation(p_conversation);
  UPDATE app.conversations SET automation_hold_reason = p_reason, automation_hold_since = coalesce(c.automation_hold_since, now()),
         updated_at = now() WHERE id = p_conversation;
  UPDATE app.outbound_messages SET status = 'canceled', status_reason = 'automation_hold:' || p_reason, updated_at = now()
   WHERE conversation_id = p_conversation AND actor_type = 'ai' AND status IN ('queued', 'blocked');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM app.audit('system', NULL, 'conversation.automation_hold', 'conversation', p_conversation::text,
                    jsonb_build_object('reason', p_reason, 'canceled_ai_sends', v_n) || coalesce(p_detail, '{}'));
  PERFORM app.notify('automation_hold', p_conversation, jsonb_build_object('reason', p_reason));
END $$;

CREATE FUNCTION app.clear_automation_hold(p_conversation uuid, p_staff uuid, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE c app.conversations;
BEGIN
  IF p_staff IS NOT NULL THEN PERFORM app.require_cap(p_staff, 'clear_hold'); END IF;
  c := app.lock_conversation(p_conversation);
  UPDATE app.conversations SET automation_hold_reason = NULL, automation_hold_since = NULL, updated_at = now()
   WHERE id = p_conversation;
  PERFORM app.audit(CASE WHEN p_staff IS NULL THEN 'system' ELSE 'staff' END, p_staff, 'conversation.clear_hold',
                    'conversation', p_conversation::text, jsonb_build_object('previous', c.automation_hold_reason, 'note', p_note));
  PERFORM app.notify('automation_hold', p_conversation, jsonb_build_object('reason', NULL));
END $$;

-- ---------------------------------------------------------------------------
-- AI jobs
-- ---------------------------------------------------------------------------
-- Starts a job only if the conversation currently allows it, and captures the
-- mode_version + revision the job is computed against.
-- p_expected_revision implements burst combining: a job triggered by an older
-- message is skipped because the newer message's run will cover both.
CREATE FUNCTION app.start_ai_job(
  p_conversation       uuid,
  p_kind               text,
  p_trigger_message    uuid DEFAULT NULL,
  p_expected_revision  bigint DEFAULT NULL,
  p_staff              uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  c     app.conversations;
  v_id  uuid;
  v_prompt uuid;
BEGIN
  IF p_kind NOT IN ('reply', 'staff_assist', 'vision', 'sandbox') THEN
    RAISE EXCEPTION 'invalid job kind %', p_kind USING ERRCODE = '22023';
  END IF;
  IF p_kind = 'staff_assist' THEN
    PERFORM app.require_cap(p_staff, 'request_ai_assist');
  END IF;

  c := app.lock_conversation(p_conversation);

  IF p_kind = 'sandbox' AND NOT c.is_sandbox THEN
    RETURN jsonb_build_object('started', false, 'reason', 'not_a_sandbox_conversation');
  END IF;
  IF p_kind IN ('reply', 'vision') THEN
    IF c.is_sandbox THEN RETURN jsonb_build_object('started', false, 'reason', 'sandbox_conversation'); END IF;
    IF NOT app.setting_bool('ai_enabled', false) THEN
      RETURN jsonb_build_object('started', false, 'reason', 'ai_disabled');
    END IF;
    IF c.mode = 'HUMAN' THEN
      RETURN jsonb_build_object('started', false, 'reason', 'human_mode');
    END IF;
    IF c.automation_hold_reason IS NOT NULL THEN
      RETURN jsonb_build_object('started', false, 'reason', 'automation_hold');
    END IF;
    IF c.provider_control_owner = 'ai_agent' THEN
      RETURN jsonb_build_object('started', false, 'reason', 'provider_agent_in_control');
    END IF;
    IF p_expected_revision IS NOT NULL AND c.revision <> p_expected_revision THEN
      RETURN jsonb_build_object('started', false, 'reason', 'superseded_by_newer_message', 'revision', c.revision);
    END IF;
    IF EXISTS (SELECT 1 FROM app.ai_jobs WHERE conversation_id = p_conversation AND status = 'running'
                 AND kind = 'reply' AND revision_at_start = c.revision AND started_at > now() - interval '5 minutes') THEN
      RETURN jsonb_build_object('started', false, 'reason', 'already_running');
    END IF;
  END IF;

  SELECT id INTO v_prompt FROM app.prompt_versions WHERE name = 'customer_system' AND status = 'published';

  INSERT INTO app.ai_jobs (conversation_id, kind, trigger_message_id, requested_by, mode_at_start,
                           mode_version_at_start, revision_at_start, prompt_version_id)
  VALUES (p_conversation, p_kind, p_trigger_message, p_staff, c.mode, c.mode_version, c.revision, v_prompt)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('started', true, 'job_id', v_id, 'mode', c.mode, 'mode_version', c.mode_version,
                            'revision', c.revision, 'customer_id', c.customer_id, 'prompt_version_id', v_prompt);
END $$;

-- Is a running job still current? Cheap check workflows call between steps
-- (e.g. before starting an expensive vision call).
CREATE FUNCTION app.ai_job_is_current(p_job uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'current', j.status = 'running' AND c.mode_version = j.mode_version_at_start AND c.revision = j.revision_at_start
               AND (j.kind NOT IN ('reply', 'vision') OR (app.setting_bool('ai_enabled', false) AND c.automation_hold_reason IS NULL)),
    'status', j.status, 'mode', c.mode, 'mode_version', c.mode_version, 'revision', c.revision)
  FROM app.ai_jobs j JOIN app.conversations c ON c.id = j.conversation_id
  WHERE j.id = p_job
$$;

-- Submit a validated AI result. Stale output is discarded here, atomically
-- with respect to takeover and new messages.
-- p_decision: reply | handoff | no_reply
CREATE FUNCTION app.submit_ai_result(
  p_job            uuid,
  p_decision       text,
  p_reply_text     text,
  p_handoff_reason text DEFAULT NULL,
  p_references     jsonb DEFAULT '[]',
  p_result         jsonb DEFAULT '{}'
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  j         app.ai_jobs;
  c         app.conversations;
  v_conv    uuid;
  v_out     uuid;
  v_draft   uuid;
  v_reason  text;
  v_take    jsonb;
BEGIN
  SELECT conversation_id INTO v_conv FROM app.ai_jobs WHERE id = p_job;
  IF v_conv IS NULL THEN RAISE EXCEPTION 'job % not found', p_job USING ERRCODE = 'P0002'; END IF;
  c := app.lock_conversation(v_conv);
  SELECT * INTO j FROM app.ai_jobs WHERE id = p_job FOR UPDATE;

  IF p_decision NOT IN ('reply', 'handoff', 'no_reply') THEN
    UPDATE app.ai_jobs SET status = 'failed', discard_reason = 'invalid_decision', finished_at = now() WHERE id = p_job;
    RETURN jsonb_build_object('result', 'failed', 'reason', 'invalid_decision');
  END IF;

  IF j.status <> 'running' THEN
    RETURN jsonb_build_object('result', 'discarded', 'reason', 'job_' || j.status);
  END IF;

  v_reason := CASE
    WHEN c.mode_version <> j.mode_version_at_start THEN 'mode_changed'
    WHEN c.revision <> j.revision_at_start THEN 'conversation_changed'
    WHEN j.kind IN ('reply', 'vision') AND NOT app.setting_bool('ai_enabled', false) THEN 'ai_disabled'
    WHEN j.kind IN ('reply', 'vision') AND c.automation_hold_reason IS NOT NULL THEN 'automation_hold'
    WHEN j.kind IN ('reply', 'vision') AND c.mode = 'HUMAN' THEN 'human_mode'
  END;
  IF v_reason IS NOT NULL THEN
    UPDATE app.ai_jobs SET status = 'stale', discard_reason = v_reason, decision = p_decision,
           result = p_result, finished_at = now() WHERE id = p_job;
    PERFORM app.notify('ai_job', v_conv, jsonb_build_object('job_id', p_job, 'status', 'stale'));
    RETURN jsonb_build_object('result', 'stale', 'reason', v_reason);
  END IF;

  IF p_decision = 'reply' AND (p_reply_text IS NULL OR length(btrim(p_reply_text)) = 0 OR length(p_reply_text) > 4096) THEN
    UPDATE app.ai_jobs SET status = 'failed', discard_reason = 'invalid_reply_text', finished_at = now() WHERE id = p_job;
    RETURN jsonb_build_object('result', 'failed', 'reason', 'invalid_reply_text');
  END IF;

  -- Staff-assist, sandbox and COPILOT jobs never send: they become drafts.
  IF j.kind IN ('staff_assist', 'sandbox') OR (c.mode = 'COPILOT') THEN
    IF p_decision = 'no_reply' THEN
      UPDATE app.ai_jobs SET status = 'completed', decision = p_decision, result = p_result, finished_at = now() WHERE id = p_job;
      RETURN jsonb_build_object('result', 'completed');
    END IF;
    INSERT INTO app.ai_drafts (conversation_id, ai_job_id, body, decision, references_used, mode_version, revision)
    VALUES (v_conv, p_job,
            CASE WHEN p_decision = 'handoff' THEN coalesce(nullif(p_reply_text, ''), '[AI suggests human handoff: ' || coalesce(p_handoff_reason, 'unspecified') || ']')
                 ELSE p_reply_text END,
            p_decision, coalesce(p_references, '[]'), c.mode_version, c.revision)
    RETURNING id INTO v_draft;
    UPDATE app.ai_jobs SET status = 'drafted', decision = p_decision, result = p_result, finished_at = now() WHERE id = p_job;
    PERFORM app.notify('draft_created', v_conv, jsonb_build_object('draft_id', v_draft));
    RETURN jsonb_build_object('result', 'drafted', 'draft_id', v_draft);
  END IF;

  -- AUTO mode.
  IF p_decision = 'handoff' THEN
    UPDATE app.ai_jobs SET status = 'completed', decision = p_decision, result = p_result, finished_at = now() WHERE id = p_job;
    v_take := app.take_over(v_conv, 'system', NULL, 'ai_handoff:' || coalesce(p_handoff_reason, 'unspecified'),
                            jsonb_build_object('job_id', p_job), true);
    RETURN jsonb_build_object('result', 'handoff', 'takeover', v_take);
  ELSIF p_decision = 'no_reply' THEN
    UPDATE app.ai_jobs SET status = 'completed', decision = p_decision, result = p_result, finished_at = now() WHERE id = p_job;
    RETURN jsonb_build_object('result', 'completed');
  END IF;

  INSERT INTO app.outbound_messages (conversation_id, kind, category, actor_type, body, ai_job_id,
                                     expected_mode_version, expected_revision, dedupe_key)
  VALUES (v_conv, 'ai_reply', 'service', 'ai', p_reply_text, p_job, j.mode_version_at_start, j.revision_at_start,
          'ai_job:' || p_job)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_out;
  UPDATE app.ai_jobs SET status = 'queued_output', decision = p_decision, result = p_result, finished_at = now() WHERE id = p_job;
  PERFORM app.notify('outbound', v_conv, jsonb_build_object('outbound_id', v_out));
  RETURN jsonb_build_object('result', 'queued', 'outbound_id', v_out);
END $$;

CREATE FUNCTION app.fail_ai_job(p_job uuid, p_reason text) RETURNS void
LANGUAGE sql AS $$
  UPDATE app.ai_jobs SET status = 'failed', discard_reason = left(p_reason, 500), finished_at = now()
   WHERE id = p_job AND status = 'running'
$$;

-- ---------------------------------------------------------------------------
-- Staff sends
-- ---------------------------------------------------------------------------
-- A manual staff reply in AUTO mode takes the conversation over FIRST, in the
-- same transaction, so no AI send can be authorized after the staff reply.
CREATE FUNCTION app.enqueue_staff_reply(
  p_conversation      uuid,
  p_staff             uuid,
  p_body              text,
  p_payload           jsonb DEFAULT '{}',
  p_client_request_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  c       app.conversations;
  v_out   uuid;
  v_take  jsonb;
  v_key   text;
BEGIN
  PERFORM app.require_cap(p_staff, 'reply');
  IF (p_body IS NULL OR length(btrim(p_body)) = 0) AND NOT (coalesce(p_payload, '{}') ? 'attachment' OR coalesce(p_payload, '{}') ? 'template') THEN
    RAISE EXCEPTION 'empty message' USING ERRCODE = '22023';
  END IF;
  IF length(coalesce(p_body, '')) > 4096 THEN
    RAISE EXCEPTION 'message too long' USING ERRCODE = '22001';
  END IF;

  c := app.lock_conversation(p_conversation);
  IF c.is_sandbox THEN RAISE EXCEPTION 'sandbox conversation' USING ERRCODE = '22023'; END IF;

  v_key := 'staff:' || coalesce(p_client_request_id, gen_random_uuid()::text);
  SELECT id INTO v_out FROM app.outbound_messages WHERE dedupe_key = v_key;
  IF v_out IS NOT NULL THEN
    RETURN jsonb_build_object('outbound_id', v_out, 'duplicate', true);
  END IF;

  IF c.mode = 'AUTO' THEN
    v_take := app.take_over(p_conversation, 'staff', p_staff, 'staff_reply', '{}', false);
  ELSE
    UPDATE app.ai_drafts SET status = 'invalidated', invalidated_reason = 'staff_replied'
     WHERE conversation_id = p_conversation AND status = 'pending_review';
    UPDATE app.ai_jobs SET status = 'canceled', discard_reason = 'staff_replied', finished_at = now()
     WHERE conversation_id = p_conversation AND status = 'running' AND kind = 'reply';
  END IF;

  -- A staff message changes the conversation: AI work computed before it is stale.
  UPDATE app.conversations SET revision = revision + 1,
         assigned_to = coalesce(assigned_to, p_staff),
         queue_state = 'assigned', updated_at = now()
   WHERE id = p_conversation;

  INSERT INTO app.outbound_messages (conversation_id, kind, category, actor_type, actor_staff_id, body, payload, dedupe_key)
  VALUES (p_conversation, 'staff_reply', coalesce(p_payload ->> 'category', 'service'), 'staff', p_staff,
          p_body, coalesce(p_payload, '{}') - 'category', v_key)
  RETURNING id INTO v_out;

  PERFORM app.audit('staff', p_staff, 'message.staff_reply_enqueued', 'outbound', v_out::text,
                    jsonb_build_object('conversation_id', p_conversation));
  PERFORM app.notify('outbound', p_conversation, jsonb_build_object('outbound_id', v_out));
  RETURN jsonb_build_object('outbound_id', v_out, 'duplicate', false, 'takeover', v_take);
END $$;

CREATE FUNCTION app.approve_draft(p_draft uuid, p_staff uuid, p_final_body text DEFAULT NULL, p_force_stale boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  d      app.ai_drafts;
  c      app.conversations;
  v_conv uuid;
  v_out  uuid;
  v_body text;
BEGIN
  PERFORM app.require_cap(p_staff, 'approve_draft');
  SELECT conversation_id INTO v_conv FROM app.ai_drafts WHERE id = p_draft;
  IF v_conv IS NULL THEN RAISE EXCEPTION 'draft not found' USING ERRCODE = 'P0002'; END IF;
  c := app.lock_conversation(v_conv);
  SELECT * INTO d FROM app.ai_drafts WHERE id = p_draft FOR UPDATE;

  IF d.status <> 'pending_review' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'draft_' || d.status);
  END IF;
  IF c.revision <> d.revision AND NOT p_force_stale THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'stale_draft',
                              'detail', 'The conversation changed after this draft was written.');
  END IF;
  v_body := coalesce(nullif(btrim(p_final_body), ''), d.body);
  IF length(v_body) > 4096 THEN RAISE EXCEPTION 'message too long' USING ERRCODE = '22001'; END IF;

  UPDATE app.ai_drafts SET status = 'approved', reviewed_by = p_staff, reviewed_at = now(), final_body = v_body
   WHERE id = p_draft;
  UPDATE app.conversations SET revision = revision + 1, updated_at = now() WHERE id = v_conv;

  INSERT INTO app.outbound_messages (conversation_id, kind, category, actor_type, actor_staff_id, body, draft_id, dedupe_key)
  VALUES (v_conv, 'approved_draft', 'service', 'staff', p_staff, v_body, p_draft, 'draft:' || p_draft)
  RETURNING id INTO v_out;

  IF v_body <> d.body THEN
    INSERT INTO app.feedback (conversation_id, source, label, comment, staff_id)
    VALUES (v_conv, 'staff', 'draft_edited', NULL, p_staff);
  END IF;
  PERFORM app.audit('staff', p_staff, 'draft.approved', 'draft', p_draft::text,
                    jsonb_build_object('edited', v_body <> d.body, 'forced_stale', c.revision <> d.revision, 'outbound_id', v_out));
  PERFORM app.notify('outbound', v_conv, jsonb_build_object('outbound_id', v_out, 'draft_id', p_draft));
  RETURN jsonb_build_object('ok', true, 'outbound_id', v_out);
END $$;

CREATE FUNCTION app.reject_draft(p_draft uuid, p_staff uuid, p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_conv uuid; v_n integer;
BEGIN
  PERFORM app.require_cap(p_staff, 'approve_draft');
  SELECT conversation_id INTO v_conv FROM app.ai_drafts WHERE id = p_draft;
  IF v_conv IS NULL THEN RAISE EXCEPTION 'draft not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.lock_conversation(v_conv);
  UPDATE app.ai_drafts SET status = 'rejected', reviewed_by = p_staff, reviewed_at = now()
   WHERE id = p_draft AND status = 'pending_review';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO app.feedback (conversation_id, source, label, comment, staff_id) VALUES (v_conv, 'staff', 'draft_rejected', p_note, p_staff);
    PERFORM app.audit('staff', p_staff, 'draft.rejected', 'draft', p_draft::text, jsonb_build_object('note', p_note));
    PERFORM app.notify('draft_updated', v_conv, jsonb_build_object('draft_id', p_draft));
  END IF;
  RETURN jsonb_build_object('ok', v_n > 0);
END $$;

-- ---------------------------------------------------------------------------
-- Dispatch authorization: the single gate every send passes through,
-- immediately before the provider call.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.claim_outbound(p_outbound uuid, p_worker text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  o          app.outbound_messages;
  c          app.conversations;
  a          app.channel_accounts;
  v_conv     uuid;
  v_block    text;
  v_cancel   text;
  v_window   integer;
  v_recent   integer;
  v_limit    integer;
  v_consent  text;
  v_attempt  integer;
  v_has_tpl  boolean;
BEGIN
  SELECT conversation_id INTO v_conv FROM app.outbound_messages WHERE id = p_outbound;
  IF v_conv IS NULL THEN RETURN jsonb_build_object('claimed', false, 'reason', 'not_found'); END IF;

  -- Conversation lock first (same order as take_over), then the outbox row.
  c := app.lock_conversation(v_conv);
  SELECT * INTO o FROM app.outbound_messages WHERE id = p_outbound FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('claimed', false, 'reason', 'locked'); END IF;

  IF o.status <> 'queued' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'status_' || o.status);
  END IF;
  IF o.scheduled_for > now() OR o.next_attempt_at > now() THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_due');
  END IF;

  -- Global emergency stop: nothing leaves, whoever the sender is.
  IF NOT app.setting_bool('sending_enabled', true) THEN
    v_cancel := 'emergency_stop';
  ELSIF c.is_sandbox THEN
    v_cancel := 'sandbox_conversation';
  ELSIF o.actor_type = 'ai' THEN
    v_cancel := CASE
      WHEN NOT app.setting_bool('ai_enabled', false) THEN 'ai_disabled'
      WHEN c.mode <> 'AUTO' THEN 'mode_' || lower(c.mode)
      WHEN c.mode_version <> o.expected_mode_version THEN 'mode_version_changed'
      WHEN c.revision <> o.expected_revision THEN 'conversation_changed'
      WHEN c.automation_hold_reason IS NOT NULL THEN 'automation_hold'
      WHEN c.provider_control_owner = 'ai_agent' THEN 'provider_agent_in_control'
    END;
  ELSIF o.kind = 'handoff_ack' THEN
    v_cancel := CASE
      WHEN c.mode <> 'HUMAN' OR c.mode_version <> o.expected_mode_version THEN 'handoff_superseded'
    END;
  ELSIF o.actor_type = 'staff' THEN
    v_cancel := CASE
      WHEN NOT app.staff_can(o.actor_staff_id, 'reply') THEN 'staff_not_authorized'
      WHEN o.kind = 'approved_draft' AND NOT EXISTS (SELECT 1 FROM app.ai_drafts WHERE id = o.draft_id AND status = 'approved')
        THEN 'draft_not_approved'
    END;
  ELSIF o.actor_type = 'system' AND o.kind IN ('followup', 'scheduled', 'notification') THEN
    v_cancel := CASE
      WHEN c.mode = 'HUMAN' AND NOT coalesce((o.payload ->> 'allow_during_human')::boolean, false) THEN 'human_handling_conversation'
    END;
  END IF;

  IF v_cancel IS NULL AND o.category = 'marketing' THEN
    SELECT marketing_consent INTO v_consent FROM app.customers WHERE id = c.customer_id;
    IF v_consent IS DISTINCT FROM 'opted_in' THEN
      v_cancel := 'no_marketing_consent';
    ELSIF (SELECT count(*) FROM app.outbound_messages
            WHERE conversation_id = c.id AND category = 'marketing' AND status = 'sent'
              AND sent_at > now() - interval '7 days') >= app.setting_int('marketing_max_per_week', 2) THEN
      v_cancel := 'marketing_frequency_cap';
    END IF;
  END IF;

  IF v_cancel IS NOT NULL THEN
    UPDATE app.outbound_messages SET status = 'canceled', status_reason = v_cancel, updated_at = now() WHERE id = o.id;
    PERFORM app.notify('outbound', c.id, jsonb_build_object('outbound_id', o.id, 'status', 'canceled'));
    RETURN jsonb_build_object('claimed', false, 'reason', v_cancel, 'final', true);
  END IF;

  -- Channel availability: keep queued, retry later, do not consume an attempt.
  SELECT * INTO a FROM app.channel_accounts WHERE id = c.channel_account_id;
  IF NOT a.enabled OR a.status <> 'active' THEN
    UPDATE app.outbound_messages SET next_attempt_at = now() + interval '5 minutes', status_reason = 'channel_unavailable',
           updated_at = now() WHERE id = o.id;
    RETURN jsonb_build_object('claimed', false, 'reason', 'channel_unavailable');
  END IF;

  -- WhatsApp customer-service window, for every sender. Outside it only an
  -- approved template may be sent.
  v_window := app.setting_int('messaging_window_hours', 24);
  v_has_tpl := o.payload ? 'template';
  IF NOT v_has_tpl AND (c.last_inbound_at IS NULL OR c.last_inbound_at < now() - make_interval(hours => v_window)) THEN
    UPDATE app.outbound_messages SET status = 'blocked', status_reason = 'outside_customer_service_window', updated_at = now()
     WHERE id = o.id;
    PERFORM app.notify('outbound', c.id, jsonb_build_object('outbound_id', o.id, 'status', 'blocked'));
    RETURN jsonb_build_object('claimed', false, 'reason', 'outside_customer_service_window', 'final', true);
  END IF;

  -- Per-recipient pacing (WhatsApp rejects bursts to one recipient with 131056).
  v_limit := app.setting_int('per_conversation_sends_per_minute', 8);
  SELECT count(*) INTO v_recent FROM app.outbound_attempts t JOIN app.outbound_messages m ON m.id = t.outbound_id
   WHERE m.conversation_id = c.id AND t.started_at > now() - interval '60 seconds';
  IF v_recent >= v_limit THEN
    UPDATE app.outbound_messages SET next_attempt_at = now() + interval '15 seconds', updated_at = now() WHERE id = o.id;
    RETURN jsonb_build_object('claimed', false, 'reason', 'rate_limited');
  END IF;

  v_attempt := o.attempts + 1;
  UPDATE app.outbound_messages SET status = 'sending', attempts = v_attempt,
         lease_until = now() + interval '120 seconds', status_reason = NULL, updated_at = now()
   WHERE id = o.id;
  INSERT INTO app.outbound_attempts (outbound_id, attempt_no, worker) VALUES (o.id, v_attempt, p_worker);
  PERFORM app.notify('outbound', c.id, jsonb_build_object('outbound_id', o.id, 'status', 'sending'));

  RETURN jsonb_build_object(
    'claimed', true,
    'outbound_id', o.id,
    'attempt_no', v_attempt,
    'idempotency_key', o.id::text,          -- stable across retries of this logical message
    'provider_conversation_id', c.provider_conversation_id,
    'provider_account_id', a.provider_account_id,
    'body', o.body,
    'payload', o.payload,
    'kind', o.kind);
END $$;

-- Record the provider's answer for a claimed send.
-- p_outcome: accepted | rejected_retryable | rejected_permanent | ambiguous
CREATE FUNCTION app.record_send_result(
  p_outbound            uuid,
  p_attempt_no          integer,
  p_outcome             text,
  p_http_status         integer DEFAULT NULL,
  p_provider_message_id text DEFAULT NULL,
  p_response            jsonb DEFAULT NULL,
  p_error               jsonb DEFAULT NULL,
  p_retry_after_seconds integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  o        app.outbound_messages;
  c        app.conversations;
  v_conv   uuid;
  v_msg    uuid;
  v_author text;
  v_status text;
  v_delay  integer;
BEGIN
  IF p_outcome NOT IN ('accepted', 'rejected_retryable', 'rejected_permanent', 'ambiguous') THEN
    RAISE EXCEPTION 'invalid outcome %', p_outcome USING ERRCODE = '22023';
  END IF;
  SELECT conversation_id INTO v_conv FROM app.outbound_messages WHERE id = p_outbound;
  IF v_conv IS NULL THEN RAISE EXCEPTION 'outbound not found' USING ERRCODE = 'P0002'; END IF;
  c := app.lock_conversation(v_conv);
  SELECT * INTO o FROM app.outbound_messages WHERE id = p_outbound FOR UPDATE;

  UPDATE app.outbound_attempts SET finished_at = now(), http_status = p_http_status, outcome = p_outcome, error = p_error
   WHERE outbound_id = p_outbound AND attempt_no = p_attempt_no;

  IF p_outcome = 'accepted' THEN
    -- Truth wins even if a lease already expired and the row was marked unknown.
    v_author := CASE o.actor_type WHEN 'ai' THEN 'ai' WHEN 'staff' THEN 'staff' ELSE 'system' END;
    UPDATE app.outbound_messages SET status = 'sent', sent_at = now(), provider_message_id = p_provider_message_id,
           provider_response = p_response, lease_until = NULL, status_reason = NULL, updated_at = now()
     WHERE id = p_outbound;

    -- If our own echo (message.sent) arrived first it was stored without an
    -- owner; attach it now instead of creating a duplicate row.
    IF p_provider_message_id IS NOT NULL THEN
      UPDATE app.messages SET author_type = v_author, author_staff_id = o.actor_staff_id, outbound_id = p_outbound,
             body = coalesce(body, o.body)
       WHERE conversation_id = v_conv AND provider_message_id = p_provider_message_id
      RETURNING id INTO v_msg;
    END IF;
    IF v_msg IS NULL THEN
      INSERT INTO app.messages (conversation_id, direction, author_type, author_staff_id, kind, body,
                                provider_message_id, outbound_id, sent_at, delivery_status, delivery_status_at)
      VALUES (v_conv, 'outbound', v_author, o.actor_staff_id,
              CASE WHEN o.payload ? 'template' THEN 'template' WHEN o.payload ? 'attachment' THEN coalesce(o.payload -> 'attachment' ->> 'type', 'file') ELSE 'text' END,
              o.body, p_provider_message_id, p_outbound, now(), 'sent', now())
      RETURNING id INTO v_msg;
    END IF;

    UPDATE app.conversations SET last_outbound_at = now(), last_message_at = now(),
           last_message_preview = left(coalesce(o.body, '[attachment]'), 140),
           first_response_due_at = CASE WHEN o.actor_type IN ('ai', 'staff') THEN NULL ELSE first_response_due_at END,
           unread_count = CASE WHEN o.actor_type = 'staff' THEN 0 ELSE unread_count END,
           updated_at = now()
     WHERE id = v_conv;

    -- An unknown-origin hold caused only by our own late-matched echo can lift.
    IF c.automation_hold_reason = 'unknown_outgoing_origin' AND NOT EXISTS (
         SELECT 1 FROM app.messages WHERE conversation_id = v_conv AND direction = 'outbound'
           AND author_type = 'unknown' AND outbound_id IS NULL) THEN
      UPDATE app.conversations SET automation_hold_reason = NULL, automation_hold_since = NULL WHERE id = v_conv;
      PERFORM app.audit('system', NULL, 'conversation.hold_auto_cleared', 'conversation', v_conv::text,
                        jsonb_build_object('matched_outbound', p_outbound));
    END IF;
    v_status := 'sent';

  ELSIF p_outcome = 'rejected_retryable' THEN
    IF o.attempts >= o.max_attempts THEN
      v_status := 'failed';
      UPDATE app.outbound_messages SET status = 'failed', status_reason = 'max_attempts', last_error = p_error,
             lease_until = NULL, updated_at = now() WHERE id = p_outbound;
      PERFORM app.raise_alert('send_failed', 'warning', 'A message could not be sent after retries.',
                              jsonb_build_object('outbound_id', p_outbound, 'conversation_id', v_conv), 'send_failed:' || p_outbound);
    ELSE
      v_delay := coalesce(p_retry_after_seconds, least(900, (15 * power(2, o.attempts - 1))::integer));
      v_status := 'queued';
      UPDATE app.outbound_messages SET status = 'queued', next_attempt_at = now() + make_interval(secs => v_delay),
             last_error = p_error, lease_until = NULL, status_reason = 'retry_scheduled', updated_at = now()
       WHERE id = p_outbound;
    END IF;

  ELSIF p_outcome = 'rejected_permanent' THEN
    v_status := 'failed';
    UPDATE app.outbound_messages SET status = 'failed', status_reason = coalesce(p_error ->> 'code', 'rejected'),
           last_error = p_error, provider_response = p_response, lease_until = NULL, updated_at = now()
     WHERE id = p_outbound;
    PERFORM app.raise_alert('send_failed', 'warning', 'The provider rejected a message.',
                            jsonb_build_object('outbound_id', p_outbound, 'conversation_id', v_conv, 'error', p_error),
                            'send_failed:' || p_outbound);

  ELSE -- ambiguous: the provider may or may not have accepted it. Never blind-retry.
    v_status := 'unknown';
    UPDATE app.outbound_messages SET status = 'unknown', status_reason = 'ambiguous_provider_result',
           last_error = p_error, lease_until = NULL, updated_at = now() WHERE id = p_outbound;
    PERFORM app.raise_alert('send_unknown', 'warning', 'A send outcome is unknown and needs reconciliation.',
                            jsonb_build_object('outbound_id', p_outbound, 'conversation_id', v_conv), 'send_unknown:' || p_outbound);
  END IF;

  PERFORM app.notify('outbound', v_conv, jsonb_build_object('outbound_id', p_outbound, 'status', v_status));
  RETURN jsonb_build_object('status', v_status, 'message_id', v_msg);
END $$;

-- Sends whose worker died mid-call: we do not know whether the provider got
-- them, so they become 'unknown' (reconcile, never auto-retry).
CREATE FUNCTION app.expire_send_leases() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE r record; v_n integer := 0;
BEGIN
  FOR r IN SELECT id, conversation_id, attempts FROM app.outbound_messages
            WHERE status = 'sending' AND lease_until < now() ORDER BY lease_until LIMIT 200
  LOOP
    PERFORM app.lock_conversation(r.conversation_id);
    UPDATE app.outbound_messages SET status = 'unknown', status_reason = 'lease_expired', lease_until = NULL, updated_at = now()
     WHERE id = r.id AND status = 'sending';
    IF FOUND THEN
      UPDATE app.outbound_attempts SET outcome = 'lease_expired', finished_at = now()
       WHERE outbound_id = r.id AND attempt_no = r.attempts AND outcome IS NULL;
      PERFORM app.raise_alert('send_unknown', 'warning', 'A send outcome is unknown and needs reconciliation.',
                              jsonb_build_object('outbound_id', r.id, 'conversation_id', r.conversation_id), 'send_unknown:' || r.id);
      PERFORM app.notify('outbound', r.conversation_id, jsonb_build_object('outbound_id', r.id, 'status', 'unknown'));
      v_n := v_n + 1;
    END IF;
  END LOOP;
  RETURN v_n;
END $$;

-- Human (or evidence-based automatic) resolution of an unknown send.
-- p_resolution: mark_sent | retry_same_key | discard
CREATE FUNCTION app.resolve_unknown_send(p_outbound uuid, p_resolution text, p_staff uuid,
                                         p_provider_message_id text DEFAULT NULL, p_evidence jsonb DEFAULT '{}')
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE o app.outbound_messages; v_conv uuid; v_r jsonb;
BEGIN
  IF p_staff IS NOT NULL THEN
    PERFORM app.require_cap(p_staff, 'reconcile_send');
  ELSIF p_resolution <> 'mark_sent' OR p_provider_message_id IS NULL THEN
    -- Automation may only confirm a send it has provider evidence for.
    RAISE EXCEPTION 'automatic reconciliation requires provider evidence' USING ERRCODE = '42501';
  END IF;
  SELECT conversation_id INTO v_conv FROM app.outbound_messages WHERE id = p_outbound;
  IF v_conv IS NULL THEN RAISE EXCEPTION 'outbound not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM app.lock_conversation(v_conv);
  SELECT * INTO o FROM app.outbound_messages WHERE id = p_outbound FOR UPDATE;
  IF o.status NOT IN ('unknown', 'failed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'status_' || o.status);
  END IF;

  IF p_resolution = 'mark_sent' THEN
    UPDATE app.outbound_messages SET status = 'sending' WHERE id = p_outbound;  -- transient, for record_send_result
    INSERT INTO app.outbound_attempts (outbound_id, attempt_no, worker) VALUES (p_outbound, o.attempts + 1, 'reconcile')
      ON CONFLICT DO NOTHING;
    UPDATE app.outbound_messages SET attempts = o.attempts + 1 WHERE id = p_outbound;
    v_r := app.record_send_result(p_outbound, o.attempts + 1, 'accepted', NULL, p_provider_message_id,
                                  jsonb_build_object('reconciled', true, 'evidence', p_evidence), NULL);
  ELSIF p_resolution = 'retry_same_key' THEN
    -- Same outbox id = same Idempotency-Key. It still passes every claim check.
    UPDATE app.outbound_messages SET status = 'queued', next_attempt_at = now(), status_reason = 'manual_retry',
           max_attempts = greatest(max_attempts, o.attempts + 1), resolved_by = p_staff, updated_at = now()
     WHERE id = p_outbound;
    v_r := jsonb_build_object('status', 'queued');
  ELSIF p_resolution = 'discard' THEN
    UPDATE app.outbound_messages SET status = 'canceled', status_reason = 'discarded_after_review', resolved_by = p_staff,
           updated_at = now() WHERE id = p_outbound;
    v_r := jsonb_build_object('status', 'canceled');
  ELSE
    RAISE EXCEPTION 'invalid resolution %', p_resolution USING ERRCODE = '22023';
  END IF;
  UPDATE app.alerts SET resolved_at = now(), resolved_by = p_staff
   WHERE dedupe_key IN ('send_unknown:' || p_outbound, 'send_failed:' || p_outbound) AND resolved_at IS NULL;
  PERFORM app.audit(CASE WHEN p_staff IS NULL THEN 'system' ELSE 'staff' END, p_staff, 'outbound.resolve_unknown',
                    'outbound', p_outbound::text, jsonb_build_object('resolution', p_resolution, 'evidence', p_evidence));
  PERFORM app.notify('outbound', v_conv, jsonb_build_object('outbound_id', p_outbound));
  RETURN jsonb_build_object('ok', true) || v_r;
END $$;

-- ---------------------------------------------------------------------------
-- Global controls
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.put_setting(p_key text, p_value jsonb, p_staff uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v_version integer;
BEGIN
  INSERT INTO app.settings (key, value, version, updated_by, updated_at) VALUES (p_key, p_value, 1, p_staff, now())
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, version = app.settings.version + 1,
                                  updated_by = excluded.updated_by, updated_at = now()
  RETURNING version INTO v_version;
  INSERT INTO app.settings_history (key, value, version, changed_by) VALUES (p_key, p_value, v_version, p_staff);
  RETURN v_version;
END $$;

CREATE FUNCTION app.set_global_controls(p_staff uuid, p_ai_enabled boolean DEFAULT NULL, p_sending_enabled boolean DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_canc integer := 0; v_inflight integer := 0; v_ai_canc integer := 0;
BEGIN
  IF p_ai_enabled IS NOT NULL THEN
    PERFORM app.require_cap(p_staff, 'global_ai');
    PERFORM app.put_setting('ai_enabled', to_jsonb(p_ai_enabled), p_staff);
    IF NOT p_ai_enabled THEN
      UPDATE app.outbound_messages SET status = 'canceled', status_reason = 'ai_disabled', updated_at = now()
       WHERE actor_type = 'ai' AND status IN ('queued', 'blocked');
      GET DIAGNOSTICS v_ai_canc = ROW_COUNT;
    END IF;
    PERFORM app.audit('staff', p_staff, CASE WHEN p_ai_enabled THEN 'global.ai_enabled' ELSE 'global.ai_disabled' END,
                      'settings', 'ai_enabled', jsonb_build_object('canceled_ai_sends', v_ai_canc));
  END IF;
  IF p_sending_enabled IS NOT NULL THEN
    PERFORM app.require_cap(p_staff, 'emergency_stop');
    PERFORM app.put_setting('sending_enabled', to_jsonb(p_sending_enabled), p_staff);
    IF NOT p_sending_enabled THEN
      -- Everything queued is canceled, not paused: resuming never releases it.
      UPDATE app.outbound_messages SET status = 'canceled', status_reason = 'emergency_stop', updated_at = now()
       WHERE status IN ('queued', 'blocked');
      GET DIAGNOSTICS v_canc = ROW_COUNT;
      SELECT count(*) INTO v_inflight FROM app.outbound_messages WHERE status = 'sending';
      PERFORM app.raise_alert('emergency_stop', 'critical', 'All outgoing messages are stopped.',
                              jsonb_build_object('by', p_staff, 'canceled', v_canc, 'in_flight', v_inflight), 'emergency_stop');
    ELSE
      UPDATE app.alerts SET resolved_at = now(), resolved_by = p_staff WHERE dedupe_key = 'emergency_stop' AND resolved_at IS NULL;
    END IF;
    PERFORM app.audit('staff', p_staff, CASE WHEN p_sending_enabled THEN 'global.sending_resumed' ELSE 'global.emergency_stop' END,
                      'settings', 'sending_enabled', jsonb_build_object('canceled', v_canc, 'in_flight', v_inflight));
  END IF;
  PERFORM pg_notify('app_events', jsonb_build_object('type', 'global_controls')::text);
  RETURN jsonb_build_object('ai_enabled', app.setting_bool('ai_enabled', false),
                            'sending_enabled', app.setting_bool('sending_enabled', true),
                            'canceled', v_canc + v_ai_canc, 'in_flight', v_inflight);
END $$;

INSERT INTO app.schema_migrations (version) VALUES ('0002_control_functions');
COMMIT;
