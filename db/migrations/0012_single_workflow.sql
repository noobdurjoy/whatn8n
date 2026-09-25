-- 0012_single_workflow.sql
-- Support for the single n8n workflow:
--  * claim_event_route: the workflow claims each routed event exactly once
--    (a re-delivered event stops at "Duplicate?") and routes on the stored
--    decision plus the conversation's CURRENT mode, never on the request body.
--  * Interrupted AI jobs (n8n restart or crash mid-reply) are recovered by the
--    scheduled branch: the customer is handed to staff instead of waiting.

BEGIN;
SET search_path = app, public;

ALTER TABLE app.webhook_events ADD COLUMN route_claimed_at timestamptz;

CREATE FUNCTION app.claim_event_route(p_event uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE e app.webhook_events; c app.conversations; v_conv uuid; v_msg app.messages;
BEGIN
  SELECT * INTO e FROM app.webhook_events WHERE id = p_event FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'event_not_found'); END IF;
  IF e.source <> 'zernio' OR e.processing_status <> 'processed' OR e.route IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'event_not_processed', 'status', e.processing_status);
  END IF;
  IF e.route_claimed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'duplicate', true, 'reason', 'already_routed', 'claimed_at', e.route_claimed_at);
  END IF;
  UPDATE app.webhook_events SET route_claimed_at = now() WHERE id = p_event;

  v_conv := nullif(e.route ->> 'conversation_id', '')::uuid;
  IF v_conv IS NOT NULL THEN SELECT * INTO c FROM app.conversations WHERE id = v_conv; END IF;
  IF e.route ->> 'message_id' IS NOT NULL THEN
    SELECT * INTO v_msg FROM app.messages WHERE id = (e.route ->> 'message_id')::uuid AND conversation_id = v_conv;
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'event_id', e.id,
    'route', e.route,
    'conversation', CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', c.id, 'mode', c.mode, 'mode_version', c.mode_version, 'revision', c.revision,
        'automation_hold', c.automation_hold_reason, 'is_sandbox', c.is_sandbox, 'customer_id', c.customer_id) END,
    -- Identity facts only (no phone numbers or names).
    'customer', CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
        'identities', (SELECT coalesce(jsonb_agg(DISTINCT i.identity_kind), '[]') FROM app.customer_identities i WHERE i.customer_id = c.customer_id),
        'is_new_conversation', coalesce((e.route ->> 'is_new_conversation')::boolean, false)) END,
    'message', CASE WHEN v_msg.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', v_msg.id, 'direction', v_msg.direction, 'is_historical', v_msg.is_historical, 'saved', true) END,
    'controls', jsonb_build_object('ai_enabled', app.setting_bool('ai_enabled', false), 'sending_enabled', app.setting_bool('sending_enabled', true)));
END $$;

-- Reply jobs still 'running' long after they started were interrupted. The
-- customer is handed to staff (fixed acknowledgment in AUTO, which still goes
-- through the dispatcher and the emergency stop), with one alert per job.
CREATE FUNCTION app.recover_stale_ai_jobs(p_older_than interval DEFAULT interval '10 minutes') RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE j app.ai_jobs; v_mode text; v_n integer := 0; v_ack jsonb; v_acks jsonb := '[]';
BEGIN
  FOR j IN SELECT * FROM app.ai_jobs WHERE status = 'running' AND started_at < now() - p_older_than ORDER BY started_at LIMIT 50 FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE app.ai_jobs SET status = 'failed', discard_reason = 'interrupted', finished_at = now() WHERE id = j.id;
    v_n := v_n + 1;
    CONTINUE WHEN j.kind <> 'reply';
    SELECT mode INTO v_mode FROM app.conversations WHERE id = j.conversation_id;
    -- Only when this job was the conversation's latest reply attempt.
    CONTINUE WHEN EXISTS (SELECT 1 FROM app.ai_jobs n WHERE n.conversation_id = j.conversation_id AND n.kind = 'reply' AND n.started_at > j.started_at);
    IF v_mode IN ('AUTO', 'COPILOT') THEN
      v_ack := app.take_over(j.conversation_id, 'system', NULL, 'ai_interrupted', jsonb_build_object('job_id', j.id), v_mode = 'AUTO');
      IF v_ack ->> 'ack_outbound_id' IS NOT NULL THEN v_acks := v_acks || to_jsonb(v_ack ->> 'ack_outbound_id'); END IF;
    END IF;
    PERFORM app.raise_alert('ai_job_interrupted', 'warning', 'An AI reply was interrupted; the conversation is waiting for staff.',
                            jsonb_build_object('conversation_id', j.conversation_id, 'job_id', j.id), 'ai_job_interrupted:' || j.id);
  END LOOP;
  RETURN jsonb_build_object('recovered', v_n, 'ack_outbound_ids', v_acks);
END $$;

INSERT INTO app.schema_migrations (version) VALUES ('0012_single_workflow');
COMMIT;
