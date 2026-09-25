-- 0011_budget_handoff.sql
-- When the daily AI budget is used up, a customer reply job must not end
-- silently: the conversation goes to staff (with the fixed acknowledgment in
-- AUTO mode) and one alert per day tells the team.

BEGIN;
SET search_path = app, public;

CREATE OR REPLACE FUNCTION app.fail_ai_job(p_job uuid, p_reason text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE j app.ai_jobs; v_mode text;
BEGIN
  UPDATE app.ai_jobs SET status = 'failed', discard_reason = left(p_reason, 500), finished_at = now()
   WHERE id = p_job AND status = 'running' RETURNING * INTO j;
  IF j.id IS NULL OR p_reason <> 'ai_budget_reached' OR j.kind <> 'reply' THEN RETURN; END IF;
  SELECT mode INTO v_mode FROM app.conversations WHERE id = j.conversation_id;
  IF v_mode IN ('AUTO', 'COPILOT') THEN
    PERFORM app.take_over(j.conversation_id, 'system', NULL, 'ai_budget_reached', jsonb_build_object('job_id', p_job), v_mode = 'AUTO');
  END IF;
  PERFORM app.raise_alert('ai_budget_reached', 'warning', 'The daily AI budget is used up; new conversations go to staff.',
                          jsonb_build_object('budget', app.ai_budget_status()), 'ai_budget_reached:' || current_date);
END $$;

INSERT INTO app.schema_migrations (version) VALUES ('0011_budget_handoff');
COMMIT;
