-- 0014: Telegram notification for AI drafts (observation mode).
-- In COPILOT mode the AI writes drafts that are never sent to the customer.
-- The owner can watch them on Telegram: category "ai_draft" sends the
-- customer's latest message and the AI's draft, with a dashboard link.
-- Only customer reply jobs count (not staff-assist or sandbox drafts).

CREATE FUNCTION app.trg_notify_draft() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_kind text; v_sandbox boolean; v_customer text;
BEGIN
  SELECT kind INTO v_kind FROM app.ai_jobs WHERE id = NEW.ai_job_id;
  SELECT is_sandbox INTO v_sandbox FROM app.conversations WHERE id = NEW.conversation_id;
  IF v_kind IS DISTINCT FROM 'reply' OR coalesce(v_sandbox, false) THEN RETURN NEW; END IF;
  SELECT body INTO v_customer FROM app.messages
   WHERE conversation_id = NEW.conversation_id AND direction = 'inbound' AND NOT is_historical
   ORDER BY sent_at DESC LIMIT 1;
  PERFORM app.notify_admin('ai_draft', 'draft:' || NEW.id,
    CASE WHEN NEW.decision = 'handoff' THEN 'AI suggests a person answers (nothing was sent)'
         ELSE 'AI draft reply (NOT sent to the customer)' END,
    'Customer: ' || left(coalesce(app.redact_text(v_customer), '(no text)'), 400)
      || E'\n\nAI draft:\n' || left(NEW.body, 1000),
    app.dashboard_link(NEW.conversation_id));
  RETURN NEW;
END $$;

CREATE TRIGGER notify_draft AFTER INSERT ON app.ai_drafts FOR EACH ROW EXECUTE FUNCTION app.trg_notify_draft();

UPDATE app.settings SET value = jsonb_set(value, '{categories,ai_draft}', '"immediate"')
 WHERE key = 'telegram_notifications' AND NOT (value -> 'categories' ? 'ai_draft');
