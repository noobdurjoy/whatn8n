-- 0014: Telegram notification for AI drafts (observation mode).
-- In COPILOT mode the AI writes drafts that are never sent to the customer.
-- The owner can watch them on Telegram: category "ai_draft" sends the
-- customer's latest message and the AI's draft, with a dashboard link.
-- Only customer reply jobs count (not staff-assist or sandbox drafts).
-- A reply draft carries Approve / Decline buttons; Approve sends exactly that
-- draft through the normal dispatcher (all send checks still apply).

BEGIN;
SET search_path = app, public;

-- Idempotent: an earlier run without a transaction created some of these objects.
ALTER TABLE app.admin_notifications ADD COLUMN IF NOT EXISTS buttons jsonb;

CREATE OR REPLACE FUNCTION app.trg_notify_draft() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF NEW.decision = 'reply' THEN
    UPDATE app.admin_notifications
       SET buttons = jsonb_build_array(jsonb_build_array(
             jsonb_build_object('text', '✅ Approve & send', 'data', 'd:a:' || NEW.id),
             jsonb_build_object('text', '❌ Decline', 'data', 'd:r:' || NEW.id)))
     WHERE dedupe_key = 'draft:' || NEW.id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS notify_draft ON app.ai_drafts;
CREATE TRIGGER notify_draft AFTER INSERT ON app.ai_drafts FOR EACH ROW EXECUTE FUNCTION app.trg_notify_draft();

UPDATE app.settings SET value = jsonb_set(value, '{categories,ai_draft}', '"immediate"')
 WHERE key = 'telegram_notifications' AND NOT (value -> 'categories' ? 'ai_draft');

CREATE OR REPLACE FUNCTION app.claim_admin_notifications(p_limit integer DEFAULT 20) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE s jsonb := app.setting('telegram_notifications'); v_room integer; v_out jsonb;
BEGIN
  -- Rows stuck in 'sending' (workflow stopped mid-send) go back to pending once.
  UPDATE app.admin_notifications SET status = 'pending' WHERE status = 'sending' AND sent_at IS NULL AND created_at < now() - interval '10 minutes' AND attempts < 3;
  v_room := greatest(0, coalesce((s ->> 'max_per_minute')::int, 20)
                         - (SELECT count(*) FROM app.admin_notifications WHERE sent_at > now() - interval '1 minute')::int);
  WITH due AS (
    SELECT id FROM app.admin_notifications
     WHERE status = 'pending' AND mode = 'immediate' AND attempts < 3
     ORDER BY created_at LIMIT least(p_limit, v_room) FOR UPDATE SKIP LOCKED),
  upd AS (UPDATE app.admin_notifications n SET status = 'sending', attempts = attempts + 1 FROM due WHERE n.id = due.id RETURNING n.*)
  SELECT coalesce(jsonb_agg(jsonb_build_object('notification_id', u.id, 'chat_id', a.chat_id, 'category', u.category,
           'text', '<b>' || app.html_escape(u.title) || '</b>' || coalesce(E'\n' || app.html_escape(u.detail), '')
                   || coalesce(E'\n' || app.html_escape(u.link), ''), 'buttons', u.buttons) ORDER BY u.created_at), '[]')
    INTO v_out
    FROM upd u JOIN app.telegram_admins a ON a.revoked_at IS NULL AND (u.target_admin IS NULL OR a.id = u.target_admin);
  RETURN v_out;
END $$;

CREATE OR REPLACE FUNCTION app.telegram_accept_update(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_update bigint := (p ->> 'update_id')::bigint;
  v_user bigint := nullif(p ->> 'user_id', '')::bigint;
  v_chat bigint := nullif(p ->> 'chat_id', '')::bigint;
  v_type text := p ->> 'chat_type';
  v_text text := left(coalesce(nullif(p ->> 'text', ''), p ->> 'callback_data', ''), 4000);
  a app.telegram_admins; st app.staff_users; v_pending app.admin_commands; v_recent integer;
BEGIN
  IF v_update IS NULL THEN RETURN jsonb_build_object('route', 'ignore', 'reason', 'no_update_id'); END IF;
  SELECT * INTO a FROM app.telegram_admins WHERE telegram_user_id = v_user AND revoked_at IS NULL;
  IF a.id IS NOT NULL THEN SELECT * INTO st FROM app.staff_users WHERE id = a.staff_id AND active AND role IN ('owner', 'admin'); END IF;

  INSERT INTO app.telegram_updates (update_id, telegram_user_id, chat_id, chat_type, kind, authorized, admin_id, text)
  VALUES (v_update, v_user, v_chat, v_type, coalesce(p ->> 'kind', 'message'),
          a.id IS NOT NULL AND st.id IS NOT NULL AND v_type = 'private' AND v_chat = a.chat_id, a.id,
          CASE WHEN a.id IS NOT NULL AND st.id IS NOT NULL AND v_type = 'private' AND v_chat = a.chat_id THEN app.redact_text(v_text) END)
  ON CONFLICT (update_id) DO NOTHING;
  IF NOT FOUND THEN RETURN jsonb_build_object('route', 'duplicate', 'update_id', v_update); END IF;

  -- Pairing is the only thing an unpaired private chat may do.
  IF v_text ~* '^/(pair|start)\s+[A-Za-z0-9]{8}\s*$' AND v_type = 'private' THEN
    RETURN jsonb_build_object('route', 'pair', 'update_id', v_update, 'chat_id', v_chat, 'user_id', v_user,
                              'code', upper(substring(v_text from '([A-Za-z0-9]{8})\s*$')));
  END IF;
  IF a.id IS NULL OR st.id IS NULL OR v_type IS DISTINCT FROM 'private' OR v_chat IS DISTINCT FROM a.chat_id THEN
    UPDATE app.telegram_updates SET outcome = 'rejected_unauthorized' WHERE update_id = v_update;
    -- Answer an unknown private chat at most once a day; never echo content.
    SELECT count(*) INTO v_recent FROM app.telegram_updates
     WHERE telegram_user_id = v_user AND outcome IN ('rejected_unauthorized_answered') AND received_at > now() - interval '1 day';
    IF v_recent = 0 AND v_type = 'private' THEN
      UPDATE app.telegram_updates SET outcome = 'rejected_unauthorized_answered' WHERE update_id = v_update;
      RETURN jsonb_build_object('route', 'unauthorized', 'update_id', v_update, 'chat_id', v_chat, 'answer', true);
    END IF;
    RETURN jsonb_build_object('route', 'unauthorized', 'update_id', v_update, 'chat_id', v_chat, 'answer', false);
  END IF;
  IF coalesce((p ->> 'forwarded')::boolean, false) THEN
    UPDATE app.telegram_updates SET outcome = 'rejected_forwarded' WHERE update_id = v_update;
    RETURN jsonb_build_object('route', 'reply_only', 'update_id', v_update, 'chat_id', v_chat,
      'text', 'Forwarded messages are never treated as commands. Type the instruction yourself.');
  END IF;
  -- A button press under a notification (e.g. Approve/Decline on an AI
  -- draft). Only the recorded, authorized admin of this update may act.
  IF p ->> 'kind' = 'callback_query' THEN
    RETURN jsonb_build_object('route', 'callback', 'update_id', v_update, 'chat_id', v_chat, 'admin_id', a.id,
      'data', left(coalesce(p ->> 'callback_data', ''), 64), 'callback_id', p ->> 'callback_id', 'message_id', p ->> 'message_id');
  END IF;
  IF length(btrim(v_text)) = 0 THEN
    UPDATE app.telegram_updates SET outcome = 'ignored_no_text' WHERE update_id = v_update;
    RETURN jsonb_build_object('route', 'reply_only', 'update_id', v_update, 'chat_id', v_chat, 'text', 'Only text commands are supported. Send /help for examples.');
  END IF;
  SELECT * INTO v_pending FROM app.admin_commands
   WHERE admin_id = a.id AND status IN ('awaiting_choice', 'awaiting_expiry') AND created_at > now() - interval '15 minutes'
   ORDER BY created_at DESC LIMIT 1;
  RETURN jsonb_build_object('route', 'command', 'update_id', v_update, 'chat_id', v_chat, 'admin_id', a.id, 'staff_id', st.id,
    'staff_role', st.role, 'text', v_text,
    'pending', CASE WHEN v_pending.id IS NULL THEN NULL ELSE jsonb_build_object('command_id', v_pending.id, 'status', v_pending.status,
               'action', v_pending.action, 'choices', v_pending.choices) END);
END $$;

-- Approve or decline an AI draft from its Telegram buttons. The update must
-- be the recorded, authorized button press of this admin; the draft action
-- runs as the staff member linked to that admin (never one chosen by the
-- caller), through approve_draft / reject_draft with their usual checks.
CREATE OR REPLACE FUNCTION app.telegram_draft_decision(p_update bigint, p_admin uuid, p_data text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE u app.telegram_updates; a app.telegram_admins; v_m text[]; v_draft uuid; v_cmd uuid; r jsonb; d app.ai_drafts;
BEGIN
  SELECT * INTO u FROM app.telegram_updates WHERE update_id = p_update;
  IF u.update_id IS NULL OR NOT u.authorized OR u.admin_id IS DISTINCT FROM p_admin OR u.kind <> 'callback_query' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;
  SELECT * INTO a FROM app.telegram_admins WHERE id = p_admin AND revoked_at IS NULL;
  IF a.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized'); END IF;
  v_m := regexp_match(coalesce(p_data, ''), '^d:([ar]):([0-9a-f-]{36})$');
  IF v_m IS NULL THEN
    UPDATE app.telegram_updates SET outcome = 'ignored_unknown_button' WHERE update_id = p_update;
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_button');
  END IF;
  v_draft := v_m[2]::uuid;
  SELECT * INTO d FROM app.ai_drafts WHERE id = v_draft;
  IF d.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'draft_not_found'); END IF;
  INSERT INTO app.admin_commands (update_id, admin_id, staff_id, text, action, parsed_by, status)
  VALUES (p_update, a.id, a.staff_id, p_data,
          jsonb_build_object('type', 'draft_decision', 'decision', CASE v_m[1] WHEN 'a' THEN 'approve' ELSE 'decline' END, 'draft_id', v_draft),
          'rules', 'executing')
  RETURNING id INTO v_cmd;
  PERFORM set_config('app.admin_command', v_cmd::text, true);
  BEGIN
    IF v_m[1] = 'a' THEN
      r := app.approve_draft(v_draft, a.staff_id, NULL, false);
    ELSE
      r := app.reject_draft(v_draft, a.staff_id, 'declined in Telegram');
      IF NOT coalesce((r ->> 'ok')::boolean, false) THEN
        SELECT * INTO d FROM app.ai_drafts WHERE id = v_draft;
        r := jsonb_build_object('ok', false, 'reason', 'draft_' || d.status);
      END IF;
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    r := jsonb_build_object('ok', false, 'reason', 'not_allowed_for_role');
  END;
  PERFORM set_config('app.admin_command', '', true);
  UPDATE app.admin_commands SET status = CASE WHEN (r ->> 'ok')::boolean THEN 'succeeded' ELSE 'failed' END, result = r, updated_at = now()
   WHERE id = v_cmd;
  UPDATE app.telegram_updates SET outcome = 'draft_' || CASE v_m[1] WHEN 'a' THEN 'approve' ELSE 'decline' END
   WHERE update_id = p_update;
  RETURN r || jsonb_build_object('decision', CASE v_m[1] WHEN 'a' THEN 'approve' ELSE 'decline' END, 'draft_id', v_draft,
                                 'link', app.dashboard_link(d.conversation_id));
END $$;

INSERT INTO app.schema_migrations (version) VALUES ('0014_draft_notifications');
COMMIT;
