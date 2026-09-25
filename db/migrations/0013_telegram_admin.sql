-- 0013_telegram_admin.sql
-- Private Telegram admin bot (inside the single n8n workflow):
--  * pairing: a short-lived, single-use code created by the dashboard owner,
--    or an explicit numeric Telegram user id set by the owner;
--  * every Telegram update is recorded once (update_id), authorized by numeric
--    user id + private chat id, and unauthorized content is never stored;
--  * admin commands with idempotency, stock changes with previous/requested/
--    result and an overlap guard, temporary notices with versions and expiry,
--    private staff notes;
--  * an outbox of admin notifications with per-category mode (immediate,
--    summary, disabled), dedupe, rate limit and a daily summary.
-- The model only proposes a structured action; these functions check the
-- sender's authority, the action and the current state before anything runs.

BEGIN;
SET search_path = app, public;

-- The workflow role still may not act as staff, with one narrow exception:
-- inside an admin_* function below, for the staff member linked to the
-- verified Telegram admin of that command (never a staff id chosen by the
-- caller). The marker is transaction-local.
CREATE OR REPLACE FUNCTION app.require_cap(p_staff uuid, p_capability text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_cmd text := nullif(current_setting('app.admin_command', true), '');
BEGIN
  IF session_user = 'wa_n8n' THEN
    IF v_cmd IS NULL OR NOT EXISTS (
         SELECT 1 FROM app.admin_commands c JOIN app.telegram_admins a ON a.id = c.admin_id AND a.revoked_at IS NULL
          WHERE c.id = v_cmd::uuid AND c.staff_id = p_staff AND c.status IN ('received', 'awaiting_choice', 'executing')) THEN
      RAISE EXCEPTION 'staff actions are not allowed for the workflow role' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF p_staff IS NULL OR NOT app.staff_can(p_staff, p_capability) THEN
    RAISE EXCEPTION 'permission denied: %', p_capability USING ERRCODE = '42501';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Pairing and authorization
-- ---------------------------------------------------------------------------
CREATE TABLE app.telegram_pairing_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid NOT NULL REFERENCES app.staff_users(id) ON DELETE CASCADE,
  code_hash   bytea NOT NULL UNIQUE,            -- sha256 of the code; the code itself is never stored
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  used_by_telegram_user_id bigint,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.telegram_admins (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id         uuid NOT NULL REFERENCES app.staff_users(id) ON DELETE CASCADE,
  telegram_user_id bigint NOT NULL,
  chat_id          bigint NOT NULL,
  paired_via       text NOT NULL CHECK (paired_via IN ('pairing_code', 'owner_setting')),
  paired_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  revoked_by       uuid REFERENCES app.staff_users(id)
);
CREATE UNIQUE INDEX telegram_admins_active_user ON app.telegram_admins (telegram_user_id) WHERE revoked_at IS NULL;

-- Every update id is recorded exactly once. Content is stored only for
-- authorized admins (and redacted); unauthorized updates keep ids only.
CREATE TABLE app.telegram_updates (
  update_id        bigint PRIMARY KEY,
  received_at      timestamptz NOT NULL DEFAULT now(),
  telegram_user_id bigint,
  chat_id          bigint,
  chat_type        text,
  kind             text NOT NULL,
  authorized       boolean NOT NULL DEFAULT false,
  admin_id         uuid REFERENCES app.telegram_admins(id),
  text             text,
  outcome          text,             -- what was decided (unauthorized, pair_*, command, …); set once
  reply_status     text              -- whether the bot's answer went out (replied | reply_failed)
);
CREATE INDEX telegram_updates_user_idx ON app.telegram_updates (telegram_user_id, received_at DESC);

CREATE TABLE app.admin_commands (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  update_id       bigint NOT NULL UNIQUE REFERENCES app.telegram_updates(update_id),
  admin_id        uuid NOT NULL REFERENCES app.telegram_admins(id),
  staff_id        uuid NOT NULL REFERENCES app.staff_users(id),
  text            text NOT NULL,
  action          jsonb NOT NULL,
  parsed_by       text NOT NULL CHECK (parsed_by IN ('rules', 'model', 'choice', 'followup')),
  parent_id       uuid REFERENCES app.admin_commands(id),
  status          text NOT NULL DEFAULT 'received' CHECK (status IN
                    ('received', 'awaiting_choice', 'awaiting_expiry', 'executing', 'succeeded', 'failed', 'unknown',
                     'rejected', 'clarify', 'canceled', 'expired')),
  choices         jsonb,
  result          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_commands_admin_idx ON app.admin_commands (admin_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Stock changes (authoritative inventory lives in WooCommerce)
-- ---------------------------------------------------------------------------
CREATE TABLE app.stock_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id      uuid NOT NULL UNIQUE REFERENCES app.admin_commands(id),
  staff_id        uuid NOT NULL REFERENCES app.staff_users(id),
  product_id      bigint NOT NULL,
  variation_id    bigint NOT NULL DEFAULT 0,
  sku             text,
  product_name    text,
  op              text NOT NULL CHECK (op IN ('set', 'adjust', 'status')),
  requested       jsonb NOT NULL,       -- { quantity } | { delta } | { stock_status }
  previous        jsonb NOT NULL,       -- { manage_stock, stock_quantity, stock_status } read before writing
  target          jsonb,                -- exact fields written
  result          jsonb,                -- read back after writing
  status          text NOT NULL DEFAULT 'executing' CHECK (status IN ('executing', 'succeeded', 'failed', 'unknown')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
-- One change per product/variation at a time.
CREATE UNIQUE INDEX stock_changes_one_running ON app.stock_changes (product_id, variation_id) WHERE status = 'executing';

-- ---------------------------------------------------------------------------
-- Temporary customer-facing notices and private staff notes
-- ---------------------------------------------------------------------------
CREATE TABLE app.temporary_notices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_key   uuid NOT NULL,              -- same key across versions of one notice
  version      integer NOT NULL,
  title        text NOT NULL CHECK (length(title) <= 200),
  body         text NOT NULL CHECK (length(body) <= 2000),
  scope        jsonb NOT NULL DEFAULT '{"type": "all"}',   -- { type: all | keywords, keywords: [...] }
  starts_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'canceled')),
  created_by   uuid NOT NULL REFERENCES app.staff_users(id),
  created_via  text NOT NULL CHECK (created_via IN ('telegram', 'dashboard')),
  command_id   uuid REFERENCES app.admin_commands(id),
  canceled_at  timestamptz,
  canceled_by  uuid REFERENCES app.staff_users(id),
  expiry_notified_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notice_key, version),
  CHECK (expires_at > starts_at)
);
CREATE INDEX temporary_notices_active ON app.temporary_notices (expires_at) WHERE status = 'active';

CREATE TABLE app.staff_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body        text NOT NULL CHECK (length(body) <= 4000),
  created_by  uuid NOT NULL REFERENCES app.staff_users(id),
  created_via text NOT NULL CHECK (created_via IN ('telegram', 'dashboard')),
  command_id  uuid REFERENCES app.admin_commands(id),
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Admin notifications
-- ---------------------------------------------------------------------------
CREATE TABLE app.admin_notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category      text NOT NULL,
  dedupe_key    text NOT NULL UNIQUE,
  title         text NOT NULL,
  detail        text,
  link          text,
  mode          text NOT NULL CHECK (mode IN ('immediate', 'summary')),
  target_admin  uuid REFERENCES app.telegram_admins(id),   -- NULL = every active admin
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'summarized')),
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);
CREATE INDEX admin_notifications_pending ON app.admin_notifications (created_at) WHERE status IN ('pending', 'sending');

INSERT INTO app.settings (key, value) VALUES ('telegram_notifications', jsonb_build_object(
  'enabled', true,
  'max_per_minute', 20,
  'categories', jsonb_build_object(
    'new_conversation', 'immediate', 'customer_message', 'summary', 'ai_reply', 'summary', 'staff_reply', 'summary',
    'delivery_failure', 'immediate', 'handoff', 'immediate', 'unresolved', 'immediate', 'orders', 'immediate',
    'stock', 'immediate', 'knowledge', 'summary', 'notice_expiring', 'immediate', 'api_failure', 'immediate',
    'connection', 'immediate', 'spending', 'immediate', 'deployment', 'immediate', 'backup', 'immediate',
    'admin_reply_status', 'immediate')))
ON CONFLICT (key) DO NOTHING;
-- The old notification setting pointed at another project's Telegram bot.
DELETE FROM app.settings WHERE key = 'notifications';

-- SQL counterpart of shared/redact.js (redactSecrets) for text stored from
-- Telegram and copied into notifications: login/token links, API keys and
-- bearer tokens, passwords, OTPs near a keyword, card-length digit runs, CVV.
CREATE FUNCTION app.redact_text(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(p, ''),
    'https?://[^\s<>"'']*[?&#](token|access_token|auth|key|api_key|apikey|sig|signature|code|otp|password|pass|session|magic|login|reset)=[^\s<>"'']*', '[login link removed]', 'gi'),
    '\m(sk|pk|rk|zrk|sk-or-v1|ghp|gho|xox[abpr]|ck|cs)[-_][A-Za-z0-9_-]{16,}', '[secret removed]', 'gi'),
    '(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}', '\1 [secret removed]', 'gi'),
    '((password|passwd|pass|pwd|pin|পাসওয়ার্ড|পিন)\s*(is|hocche|holo)?\s*[:=-]?\s*)\S{3,}', '\1[hidden]', 'gi'),
    '((otp|verification code|security code|login code|code|কোড|ওটিপি)\s*(is|holo|hocche)?\s*[:=-]?\s*)[0-9০-৯]{4,8}', '\1[hidden]', 'gi'),
    '\m[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{3,7}\M', '[card number hidden]', 'g')
$$;

CREATE FUNCTION app.html_escape(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT replace(replace(replace(coalesce(p, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
$$;

-- Queue one admin notification. The mode comes from the settings; disabled
-- categories are dropped. dedupe_key makes repeats harmless.
CREATE FUNCTION app.notify_admin(p_category text, p_dedupe text, p_title text, p_detail text DEFAULT NULL,
                                 p_link text DEFAULT NULL, p_target uuid DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE s jsonb := app.setting('telegram_notifications'); v_mode text;
BEGIN
  IF s IS NULL OR NOT coalesce((s ->> 'enabled')::boolean, true) THEN RETURN false; END IF;
  -- Nobody paired yet: nothing to deliver, so nothing piles up for later.
  IF NOT EXISTS (SELECT 1 FROM app.telegram_admins WHERE revoked_at IS NULL) THEN RETURN false; END IF;
  v_mode := coalesce(s -> 'categories' ->> p_category, 'summary');
  IF v_mode NOT IN ('immediate', 'summary') THEN RETURN false; END IF;
  INSERT INTO app.admin_notifications (category, dedupe_key, title, detail, link, mode, target_admin)
  VALUES (p_category, left(p_dedupe, 300), left(p_title, 300), left(p_detail, 1500), left(p_link, 500), v_mode, p_target)
  ON CONFLICT (dedupe_key) DO NOTHING;
  RETURN FOUND;
END $$;

CREATE FUNCTION app.dashboard_link(p_conversation uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_conversation IS NULL THEN NULL
              ELSE rtrim(coalesce(app.setting('dashboard_url') #>> '{}', ''), '/') || '/?c=' || p_conversation END
$$;

-- Due immediate notifications for active admins, within the per-minute limit.
-- Rows are claimed ('sending') so parallel runs never send one twice.
CREATE FUNCTION app.claim_admin_notifications(p_limit integer DEFAULT 20) RETURNS jsonb
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
                   || coalesce(E'\n' || app.html_escape(u.link), '')) ORDER BY u.created_at), '[]')
    INTO v_out
    FROM upd u JOIN app.telegram_admins a ON a.revoked_at IS NULL AND (u.target_admin IS NULL OR a.id = u.target_admin);
  RETURN v_out;
END $$;

CREATE FUNCTION app.finish_admin_notification(p_id uuid, p_ok boolean, p_error text DEFAULT NULL) RETURNS void
LANGUAGE sql AS $$
  UPDATE app.admin_notifications
     SET status = CASE WHEN p_ok THEN 'sent' WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
         sent_at = CASE WHEN p_ok THEN now() ELSE sent_at END, last_error = left(p_error, 300)
   WHERE id = p_id
$$;

-- Daily summary: business counts for the last 24 hours plus the queued
-- summary-mode notifications (marked summarized). One message per admin.
CREATE FUNCTION app.admin_daily_summary() RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE m jsonb := app.metrics(now() - interval '24 hours', now()); v_items text; v_text text; v_out jsonb;
BEGIN
  WITH s AS (
    UPDATE app.admin_notifications SET status = 'summarized', sent_at = now()
     WHERE status = 'pending' AND mode = 'summary' AND created_at > now() - interval '48 hours' RETURNING category, title)
  SELECT string_agg('• ' || category || ': ' || n || CASE WHEN n > 0 THEN ' (latest: ' || app.html_escape(left(last_title, 80)) || ')' ELSE '' END, E'\n' ORDER BY category)
    INTO v_items
    FROM (SELECT category, count(*) AS n, (array_agg(title ORDER BY title DESC))[1] AS last_title FROM s GROUP BY category) g;
  v_text := '<b>Daily summary</b>' || E'\n'
    || 'Unanswered customer questions: ' || coalesce(m ->> 'unanswered_customer_bursts', '0') || E'\n'
    || 'Waiting for staff: ' || coalesce(m ->> 'waiting_for_staff', '0') || E'\n'
    || 'Open conversations: ' || coalesce(m ->> 'unresolved_conversations', '0') || E'\n'
    || 'Median first response: ' || coalesce(round((m ->> 'first_response_seconds_median')::numeric) || ' s', 'n/a') || E'\n'
    || 'AI cost (reported): ' || coalesce(round((m ->> 'ai_cost_usd')::numeric, 3)::text || ' USD', '0 USD')
    || CASE WHEN coalesce((m ->> 'ai_calls_usage_unavailable')::int, 0) > 0 THEN ' (+' || (m ->> 'ai_calls_usage_unavailable') || ' calls without usage data)' ELSE '' END || E'\n'
    || 'Active temporary notices: ' || (SELECT count(*) FROM app.temporary_notices WHERE status = 'active' AND now() >= starts_at AND now() < expires_at) || E'\n'
    || 'Last backup: ' || coalesce((SELECT status || ', ' || to_char(checked_at AT TIME ZONE 'Asia/Dhaka', 'DD Mon HH24:MI') FROM app.health_checks WHERE component = 'backup'), 'none recorded')
    || coalesce(E'\n\n' || v_items, '');
  SELECT coalesce(jsonb_agg(jsonb_build_object('chat_id', chat_id, 'text', v_text)), '[]') INTO v_out FROM app.telegram_admins WHERE revoked_at IS NULL;
  RETURN v_out;
END $$;

-- ---------------------------------------------------------------------------
-- Pairing (dashboard side creates codes; the workflow redeems them)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.create_telegram_pairing_code(p_staff uuid, p_code text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_exp timestamptz := now() + interval '10 minutes';
BEGIN
  PERFORM app.require_cap(p_staff, 'manage_staff');   -- owners only
  IF p_code !~ '^[A-Z2-9]{8}$' THEN RAISE EXCEPTION 'invalid code format' USING ERRCODE = '22023'; END IF;
  UPDATE app.telegram_pairing_codes SET expires_at = least(expires_at, now()) WHERE staff_id = p_staff AND used_at IS NULL;
  INSERT INTO app.telegram_pairing_codes (staff_id, code_hash, expires_at) VALUES (p_staff, sha256(convert_to(p_code, 'UTF8')), v_exp);
  PERFORM app.audit('staff', p_staff, 'telegram.pairing_code_created', 'staff', p_staff::text, jsonb_build_object('expires_at', v_exp));
  RETURN jsonb_build_object('expires_at', v_exp);
END $$;

CREATE FUNCTION app.set_telegram_admin(p_owner uuid, p_staff uuid, p_telegram_user_id bigint, p_chat_id bigint) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v uuid; v_role text;
BEGIN
  PERFORM app.require_cap(p_owner, 'manage_staff');
  SELECT role INTO v_role FROM app.staff_users WHERE id = p_staff AND active;
  IF v_role NOT IN ('owner', 'admin') THEN RETURN jsonb_build_object('ok', false, 'reason', 'staff_must_be_owner_or_admin'); END IF;
  IF p_telegram_user_id IS NULL OR p_telegram_user_id <= 0 OR p_chat_id IS NULL OR p_chat_id <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'private_chat_ids_are_positive'); END IF;
  UPDATE app.telegram_admins SET revoked_at = now(), revoked_by = p_owner WHERE telegram_user_id = p_telegram_user_id AND revoked_at IS NULL;
  INSERT INTO app.telegram_admins (staff_id, telegram_user_id, chat_id, paired_via) VALUES (p_staff, p_telegram_user_id, p_chat_id, 'owner_setting') RETURNING id INTO v;
  PERFORM app.audit('staff', p_owner, 'telegram.admin_set', 'telegram_admin', v::text, jsonb_build_object('staff_id', p_staff));
  RETURN jsonb_build_object('ok', true, 'admin_id', v);
END $$;

CREATE FUNCTION app.revoke_telegram_admin(p_owner uuid, p_admin uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.require_cap(p_owner, 'manage_staff');
  UPDATE app.telegram_admins SET revoked_at = now(), revoked_by = p_owner WHERE id = p_admin AND revoked_at IS NULL;
  PERFORM app.audit('staff', p_owner, 'telegram.admin_revoked', 'telegram_admin', p_admin::text, '{}');
END $$;

-- ---------------------------------------------------------------------------
-- Workflow side: accept an update (dedupe + authorization), pairing
-- ---------------------------------------------------------------------------
-- p: { update_id, user_id, chat_id, chat_type, text, forwarded, has_media, kind }
CREATE FUNCTION app.telegram_accept_update(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_update bigint := (p ->> 'update_id')::bigint;
  v_user bigint := nullif(p ->> 'user_id', '')::bigint;
  v_chat bigint := nullif(p ->> 'chat_id', '')::bigint;
  v_type text := p ->> 'chat_type';
  v_text text := left(coalesce(p ->> 'text', ''), 4000);
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

CREATE FUNCTION app.telegram_pair(p_update bigint, p_user bigint, p_chat bigint, p_code text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE c app.telegram_pairing_codes; v_attempts integer; v_admin uuid; v_role text;
BEGIN
  SELECT count(*) INTO v_attempts FROM app.telegram_updates
   WHERE telegram_user_id = p_user AND outcome LIKE 'pair_%' AND received_at > now() - interval '1 hour';
  IF v_attempts >= 5 THEN
    UPDATE app.telegram_updates SET outcome = 'pair_rate_limited' WHERE update_id = p_update;
    RETURN jsonb_build_object('ok', false, 'reason', 'too_many_attempts');
  END IF;
  SELECT * INTO c FROM app.telegram_pairing_codes WHERE code_hash = sha256(convert_to(upper(p_code), 'UTF8')) FOR UPDATE;
  IF c.id IS NULL OR c.used_at IS NOT NULL OR c.expires_at <= now() THEN
    UPDATE app.telegram_updates SET outcome = 'pair_' || CASE WHEN c.id IS NULL THEN 'invalid' WHEN c.used_at IS NOT NULL THEN 'used' ELSE 'expired' END
     WHERE update_id = p_update;
    RETURN jsonb_build_object('ok', false, 'reason', CASE WHEN c.id IS NULL THEN 'invalid_code' WHEN c.used_at IS NOT NULL THEN 'code_already_used' ELSE 'code_expired' END);
  END IF;
  SELECT role INTO v_role FROM app.staff_users WHERE id = c.staff_id AND active;
  IF v_role IS DISTINCT FROM 'owner' THEN
    UPDATE app.telegram_updates SET outcome = 'pair_not_owner' WHERE update_id = p_update;
    RETURN jsonb_build_object('ok', false, 'reason', 'owner_account_required');
  END IF;
  UPDATE app.telegram_pairing_codes SET used_at = now(), used_by_telegram_user_id = p_user WHERE id = c.id;
  UPDATE app.telegram_admins SET revoked_at = now() WHERE (telegram_user_id = p_user OR staff_id = c.staff_id) AND revoked_at IS NULL;
  INSERT INTO app.telegram_admins (staff_id, telegram_user_id, chat_id, paired_via) VALUES (c.staff_id, p_user, p_chat, 'pairing_code') RETURNING id INTO v_admin;
  UPDATE app.telegram_updates SET outcome = 'pair_ok', authorized = true, admin_id = v_admin WHERE update_id = p_update;
  PERFORM app.audit('staff', c.staff_id, 'telegram.paired', 'telegram_admin', v_admin::text, jsonb_build_object('telegram_user_id', p_user));
  RETURN jsonb_build_object('ok', true, 'admin_id', v_admin);
END $$;

-- Records whether the bot's answer was sent. It never overwrites the
-- decision (the once-a-day stranger answer and the pairing rate limit read it).
CREATE FUNCTION app.telegram_update_outcome(p_update bigint, p_outcome text) RETURNS void
LANGUAGE sql AS $$ UPDATE app.telegram_updates SET reply_status = left(p_outcome, 40) WHERE update_id = p_update $$;

-- ---------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.admin_cap_for(p_action text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_action
    WHEN 'stock_set' THEN 'settings' WHEN 'stock_adjust' THEN 'settings' WHEN 'stock_status' THEN 'settings'
    WHEN 'knowledge_permanent' THEN 'knowledge_review' WHEN 'notice_temporary' THEN 'knowledge_review'
    WHEN 'notice_cancel' THEN 'knowledge_review' WHEN 'notice_list' THEN 'view'
    WHEN 'staff_note' THEN 'note' WHEN 'reply_whatsapp' THEN 'reply'
    WHEN 'help' THEN 'view' WHEN 'status' THEN 'view' WHEN 'cancel' THEN 'view'
    ELSE NULL END
$$;

-- Records the command once per update and checks the admin's authority for
-- this action type. Returns the command id, or the earlier result on replay.
CREATE FUNCTION app.admin_command_start(p_update bigint, p_admin uuid, p_text text, p_action jsonb, p_parsed_by text, p_parent uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE a app.telegram_admins; v_cap text := app.admin_cap_for(p_action ->> 'type'); v_id uuid; v_existing app.admin_commands;
BEGIN
  SELECT * INTO v_existing FROM app.admin_commands WHERE update_id = p_update;
  IF v_existing.id IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'duplicate', 'command_id', v_existing.id, 'status', v_existing.status); END IF;
  SELECT * INTO a FROM app.telegram_admins WHERE id = p_admin AND revoked_at IS NULL;
  IF a.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_an_active_admin'); END IF;
  IF v_cap IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'unknown_action'); END IF;
  IF NOT app.staff_can(a.staff_id, v_cap) THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_allowed_for_role'); END IF;
  IF p_parent IS NOT NULL THEN
    UPDATE app.admin_commands SET status = 'canceled', updated_at = now() WHERE id = p_parent AND admin_id = p_admin AND status IN ('awaiting_choice', 'awaiting_expiry');
  END IF;
  INSERT INTO app.admin_commands (update_id, admin_id, staff_id, text, action, parsed_by, parent_id)
  VALUES (p_update, p_admin, a.staff_id, app.redact_text(left(p_text, 4000)), p_action, p_parsed_by, p_parent) RETURNING id INTO v_id;
  UPDATE app.telegram_updates SET outcome = 'command' WHERE update_id = p_update;
  -- Read-only commands are complete once accepted.
  IF p_action ->> 'type' IN ('help', 'status', 'notice_list') THEN
    UPDATE app.admin_commands SET status = 'succeeded', updated_at = now() WHERE id = v_id;
  END IF;
  PERFORM app.audit('staff', a.staff_id, 'telegram.command', 'admin_command', v_id::text,
                    jsonb_build_object('type', p_action ->> 'type', 'update_id', p_update, 'parsed_by', p_parsed_by));
  RETURN jsonb_build_object('ok', true, 'command_id', v_id, 'staff_id', a.staff_id);
END $$;

CREATE FUNCTION app.admin_command_finish(p_command uuid, p_status text, p_result jsonb, p_choices jsonb DEFAULT NULL) RETURNS void
LANGUAGE sql AS $$
  UPDATE app.admin_commands SET status = p_status, result = coalesce(result, '{}') || coalesce(p_result, '{}'),
         choices = coalesce(p_choices, choices), updated_at = now()
   WHERE id = p_command
$$;

-- ---------------------------------------------------------------------------
-- Stock
-- ---------------------------------------------------------------------------
-- p: { command_id, product_id, variation_id, sku, name, op, requested, previous }
CREATE FUNCTION app.stock_change_begin(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE c app.admin_commands; v_id uuid;
BEGIN
  SELECT * INTO c FROM app.admin_commands WHERE id = (p ->> 'command_id')::uuid FOR UPDATE;
  IF c.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'command_not_found'); END IF;
  IF EXISTS (SELECT 1 FROM app.stock_changes WHERE command_id = c.id) THEN RETURN jsonb_build_object('ok', false, 'reason', 'already_executed'); END IF;
  IF NOT app.staff_can(c.staff_id, 'settings') THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_allowed_for_role'); END IF;
  BEGIN
    INSERT INTO app.stock_changes (command_id, staff_id, product_id, variation_id, sku, product_name, op, requested, previous)
    VALUES (c.id, c.staff_id, (p ->> 'product_id')::bigint, coalesce((p ->> 'variation_id')::bigint, 0), p ->> 'sku', left(p ->> 'name', 200),
            p ->> 'op', p -> 'requested', p -> 'previous') RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'another_change_in_progress');
  END;
  UPDATE app.admin_commands SET status = 'executing', updated_at = now() WHERE id = c.id;
  RETURN jsonb_build_object('ok', true, 'stock_change_id', v_id);
END $$;

CREATE FUNCTION app.stock_change_finish(p_id uuid, p_status text, p_target jsonb, p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE s app.stock_changes;
BEGIN
  IF p_status NOT IN ('succeeded', 'failed', 'unknown') THEN RAISE EXCEPTION 'invalid status' USING ERRCODE = '22023'; END IF;
  UPDATE app.stock_changes SET status = p_status, target = p_target, result = p_result, finished_at = now()
   WHERE id = p_id AND status = 'executing' RETURNING * INTO s;
  IF s.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_executing'); END IF;
  UPDATE app.admin_commands SET status = p_status, result = coalesce(result, '{}') || jsonb_build_object('stock_change_id', s.id), updated_at = now()
   WHERE id = s.command_id;
  -- Keep the local product reference in step with what WooCommerce reported back.
  IF p_status = 'succeeded' THEN
    UPDATE app.woo_products SET stock_quantity = nullif(p_result ->> 'stock_quantity', '')::int, stock_status = p_result ->> 'stock_status', synced_at = now()
     WHERE product_id = s.product_id AND variation_id = s.variation_id;
  END IF;
  PERFORM app.audit('staff', s.staff_id, 'stock.' || p_status, 'stock_change', s.id::text,
                    jsonb_build_object('product_id', s.product_id, 'variation_id', s.variation_id, 'previous', s.previous, 'requested', s.requested, 'result', p_result));
  PERFORM app.notify_admin('stock', 'stock:' || s.id, 'Stock ' || CASE p_status WHEN 'succeeded' THEN 'updated' WHEN 'failed' THEN 'update failed' ELSE 'update outcome unknown' END
                           || ': ' || coalesce(s.product_name, '#' || s.product_id),
                           'Before: ' || coalesce(s.previous ->> 'stock_quantity', '-') || ' / ' || coalesce(s.previous ->> 'stock_status', '-')
                           || '; now: ' || coalesce(p_result ->> 'stock_quantity', '-') || ' / ' || coalesce(p_result ->> 'stock_status', '-'), NULL);
  RETURN jsonb_build_object('ok', true, 'status', p_status);
END $$;

-- ---------------------------------------------------------------------------
-- Knowledge, notices, notes (an owner command is the approval)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.admin_save_knowledge(p_command uuid, p_title text, p_body text, p_category text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE c app.admin_commands; v_doc uuid; v_ver uuid; v_shop uuid; v_slug text; v_no integer;
BEGIN
  SELECT * INTO c FROM app.admin_commands WHERE id = p_command FOR UPDATE;
  IF c.id IS NULL OR c.status NOT IN ('received') THEN RETURN jsonb_build_object('ok', false, 'reason', 'command_not_open'); END IF;
  IF NOT app.staff_can(c.staff_id, 'knowledge_review') THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_allowed_for_role'); END IF;
  IF p_category NOT IN ('faq', 'product', 'procedure', 'policy') THEN p_category := 'faq'; END IF;
  SELECT id INTO v_shop FROM app.shops ORDER BY created_at LIMIT 1;
  v_slug := left(regexp_replace(lower(coalesce(p_title, 'note')), '[^a-z0-9]+', '-', 'g'), 60) || '-' || left(replace(gen_random_uuid()::text, '-', ''), 6);
  INSERT INTO app.knowledge_documents (shop_id, slug, category) VALUES (v_shop, v_slug, p_category) RETURNING id INTO v_doc;
  INSERT INTO app.knowledge_versions (document_id, version_no, title, body, status, source, created_by)
  VALUES (v_doc, 1, left(p_title, 200), left(p_body, 8000), 'draft', 'owner', c.staff_id) RETURNING id INTO v_ver;
  PERFORM set_config('app.admin_command', c.id::text, true);
  PERFORM app.publish_knowledge_version(v_ver, c.staff_id);
  PERFORM set_config('app.admin_command', '', true);
  UPDATE app.admin_commands SET status = 'succeeded', result = jsonb_build_object('document_id', v_doc, 'version_id', v_ver), updated_at = now() WHERE id = c.id;
  PERFORM app.notify_admin('knowledge', 'knowledge:' || v_ver, 'New shop knowledge: ' || left(p_title, 120), left(p_body, 300), NULL);
  RETURN jsonb_build_object('ok', true, 'document_id', v_doc, 'version_id', v_ver, 'slug', v_slug);
END $$;

-- p: { command_id, title, body, starts_at, expires_at, keywords[], replaces_key }
CREATE FUNCTION app.admin_save_notice(p jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE c app.admin_commands; v_key uuid; v_ver integer := 1; v_id uuid; v_exp timestamptz; v_start timestamptz; v_scope jsonb;
BEGIN
  SELECT * INTO c FROM app.admin_commands WHERE id = (p ->> 'command_id')::uuid FOR UPDATE;
  IF c.id IS NULL OR c.status NOT IN ('received') THEN RETURN jsonb_build_object('ok', false, 'reason', 'command_not_open'); END IF;
  IF NOT app.staff_can(c.staff_id, 'knowledge_review') THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_allowed_for_role'); END IF;
  v_start := coalesce(nullif(p ->> 'starts_at', '')::timestamptz, now());
  v_exp := nullif(p ->> 'expires_at', '')::timestamptz;
  IF v_exp IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'expiry_required'); END IF;
  IF v_exp <= now() OR v_exp <= v_start THEN RETURN jsonb_build_object('ok', false, 'reason', 'expiry_in_past'); END IF;
  IF v_exp > now() + interval '180 days' THEN RETURN jsonb_build_object('ok', false, 'reason', 'expiry_too_far'); END IF;
  v_scope := CASE WHEN jsonb_array_length(coalesce(p -> 'keywords', '[]')) > 0 THEN jsonb_build_object('type', 'keywords', 'keywords', p -> 'keywords')
                  ELSE '{"type": "all"}' END;
  v_key := nullif(p ->> 'replaces_key', '')::uuid;
  IF v_key IS NOT NULL THEN
    SELECT coalesce(max(version), 0) + 1 INTO v_ver FROM app.temporary_notices WHERE notice_key = v_key;
    UPDATE app.temporary_notices SET status = 'superseded' WHERE notice_key = v_key AND status = 'active';
  ELSE
    v_key := gen_random_uuid();
  END IF;
  INSERT INTO app.temporary_notices (notice_key, version, title, body, scope, starts_at, expires_at, created_by, created_via, command_id)
  VALUES (v_key, v_ver, left(coalesce(p ->> 'title', left(p ->> 'body', 80)), 200), left(p ->> 'body', 2000), v_scope, v_start, v_exp, c.staff_id, 'telegram', c.id)
  RETURNING id INTO v_id;
  UPDATE app.admin_commands SET status = 'succeeded', result = jsonb_build_object('notice_id', v_id, 'notice_key', v_key, 'version', v_ver), updated_at = now() WHERE id = c.id;
  PERFORM app.audit('staff', c.staff_id, 'notice.saved', 'temporary_notice', v_id::text, jsonb_build_object('expires_at', v_exp, 'version', v_ver));
  PERFORM app.notify_admin('knowledge', 'notice:' || v_id, 'Temporary notice until ' || to_char(v_exp AT TIME ZONE 'Asia/Dhaka', 'DD Mon YYYY HH24:MI') || ' (Dhaka)', left(p ->> 'body', 300), NULL);
  RETURN jsonb_build_object('ok', true, 'notice_id', v_id, 'notice_key', v_key, 'version', v_ver,
    'starts_at', v_start, 'expires_at', v_exp, 'expires_local', to_char(v_exp AT TIME ZONE 'Asia/Dhaka', 'Dy DD Mon YYYY, HH24:MI') || ' Asia/Dhaka');
END $$;

-- Active notices matching a text (for cancel/edit). Returns a list; the
-- workflow asks the admin to choose when there is more than one.
CREATE FUNCTION app.find_active_notices(p_match text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('notice_key', notice_key, 'notice_id', id, 'version', version, 'title', title, 'body', left(body, 200),
                  'expires_local', to_char(expires_at AT TIME ZONE 'Asia/Dhaka', 'DD Mon HH24:MI')) ORDER BY created_at DESC), '[]')
  FROM app.temporary_notices
  WHERE status = 'active' AND expires_at > now()
    AND (coalesce(p_match, '') = '' OR body ILIKE '%' || p_match || '%' OR title ILIKE '%' || p_match || '%')
$$;

CREATE FUNCTION app.admin_cancel_notice(p_command uuid, p_notice_key uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE c app.admin_commands; n integer;
BEGIN
  SELECT * INTO c FROM app.admin_commands WHERE id = p_command FOR UPDATE;
  IF c.id IS NULL OR c.status NOT IN ('received', 'awaiting_choice') THEN RETURN jsonb_build_object('ok', false, 'reason', 'command_not_open'); END IF;
  IF NOT app.staff_can(c.staff_id, 'knowledge_review') THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_allowed_for_role'); END IF;
  UPDATE app.temporary_notices SET status = 'canceled', canceled_at = now(), canceled_by = c.staff_id WHERE notice_key = p_notice_key AND status = 'active';
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE app.admin_commands SET status = CASE WHEN n > 0 THEN 'succeeded' ELSE 'failed' END, result = jsonb_build_object('notice_key', p_notice_key, 'canceled', n), updated_at = now() WHERE id = c.id;
  PERFORM app.audit('staff', c.staff_id, 'notice.canceled', 'temporary_notice', p_notice_key::text, '{}');
  RETURN jsonb_build_object('ok', n > 0, 'canceled', n);
END $$;

-- Rollback: re-activate an earlier version as a new version (history kept).
CREATE FUNCTION app.restore_notice_version(p_staff uuid, p_notice uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE n app.temporary_notices; v_id uuid; v_ver integer;
BEGIN
  PERFORM app.require_cap(p_staff, 'knowledge_review');
  SELECT * INTO n FROM app.temporary_notices WHERE id = p_notice;
  IF n.id IS NULL THEN RAISE EXCEPTION 'notice not found' USING ERRCODE = 'P0002'; END IF;
  IF n.expires_at <= now() THEN RETURN jsonb_build_object('ok', false, 'reason', 'version_already_expired'); END IF;
  SELECT max(version) + 1 INTO v_ver FROM app.temporary_notices WHERE notice_key = n.notice_key;
  UPDATE app.temporary_notices SET status = 'superseded' WHERE notice_key = n.notice_key AND status = 'active';
  INSERT INTO app.temporary_notices (notice_key, version, title, body, scope, starts_at, expires_at, created_by, created_via)
  VALUES (n.notice_key, v_ver, n.title, n.body, n.scope, greatest(n.starts_at, now()), n.expires_at, p_staff, 'dashboard') RETURNING id INTO v_id;
  PERFORM app.audit('staff', p_staff, 'notice.restored', 'temporary_notice', v_id::text, jsonb_build_object('from_version', n.version));
  RETURN jsonb_build_object('ok', true, 'notice_id', v_id, 'version', v_ver);
END $$;

-- Dashboard: end a notice now (all of its active versions).
CREATE FUNCTION app.staff_cancel_notice(p_staff uuid, p_notice_key uuid) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_n integer;
BEGIN
  PERFORM app.require_cap(p_staff, 'knowledge_review');
  UPDATE app.temporary_notices SET status = 'canceled', canceled_at = now(), canceled_by = p_staff
   WHERE notice_key = p_notice_key AND status = 'active';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN PERFORM app.audit('staff', p_staff, 'notice.canceled', 'temporary_notice', p_notice_key::text, '{}'); END IF;
  RETURN jsonb_build_object('ok', v_n > 0, 'canceled', v_n);
END $$;

CREATE FUNCTION app.admin_save_staff_note(p_command uuid, p_body text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE c app.admin_commands; v_id uuid;
BEGIN
  SELECT * INTO c FROM app.admin_commands WHERE id = p_command FOR UPDATE;
  IF c.id IS NULL OR c.status NOT IN ('received') THEN RETURN jsonb_build_object('ok', false, 'reason', 'command_not_open'); END IF;
  INSERT INTO app.staff_notes (body, created_by, created_via, command_id) VALUES (app.redact_text(left(p_body, 4000)), c.staff_id, 'telegram', c.id) RETURNING id INTO v_id;
  UPDATE app.admin_commands SET status = 'succeeded', result = jsonb_build_object('staff_note_id', v_id), updated_at = now() WHERE id = c.id;
  RETURN jsonb_build_object('ok', true, 'staff_note_id', v_id);
END $$;

-- Active notices are part of what the AI may tell customers, filtered at
-- retrieval time (expired or not-yet-started notices never appear, whatever
-- the cleanup schedule did). Staff notes are never included.
CREATE FUNCTION app.active_notices_for(p_text text) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', 'notice:' || id, 'title', title, 'text', body,
                  'valid_until', to_char(expires_at AT TIME ZONE 'Asia/Dhaka', 'DD Mon YYYY HH24:MI') || ' (Dhaka time)') ORDER BY created_at DESC), '[]')
  FROM app.temporary_notices
  WHERE status = 'active' AND now() >= starts_at AND now() < expires_at
    AND (scope ->> 'type' = 'all'
         OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(scope -> 'keywords', '[]')) k
                     WHERE coalesce(p_text, '') ILIKE '%' || k || '%'))
$$;

-- ---------------------------------------------------------------------------
-- WhatsApp reply from Telegram
-- ---------------------------------------------------------------------------
-- Resolves the customer by normalized phone and the WhatsApp account, then
-- queues the exact text as a staff reply (existing takeover rules apply; the
-- dispatcher still enforces the window, templates and the emergency stop).
CREATE FUNCTION app.admin_reply_whatsapp(p_command uuid, p_phone text, p_text text, p_conversation uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE c app.admin_commands; v_norm text := app.normalize_phone(p_phone); v_matches jsonb; v_conv uuid; v_n integer; r jsonb;
BEGIN
  SELECT * INTO c FROM app.admin_commands WHERE id = p_command FOR UPDATE;
  IF c.id IS NULL OR c.status NOT IN ('received', 'awaiting_choice') THEN RETURN jsonb_build_object('ok', false, 'reason', 'command_not_open'); END IF;
  IF NOT app.staff_can(c.staff_id, 'reply') THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_allowed_for_role'); END IF;
  IF p_text IS NULL OR length(btrim(p_text)) = 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'empty_text'); END IF;
  IF v_norm IS NULL OR v_norm !~ '^[1-9][0-9]{7,14}$' THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_phone'); END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('conversation_id', cv.id, 'account', coalesce(ca.display_name, ca.username, ca.provider_account_id),
           'customer', coalesce(cu.display_name, ''), 'last_inbound_at', cv.last_inbound_at, 'mode', cv.mode) ORDER BY cv.last_inbound_at DESC NULLS LAST), '[]'),
         count(*)
    INTO v_matches, v_n
    FROM app.customers cu
    JOIN app.conversations cv ON cv.customer_id = cu.id AND NOT cv.is_sandbox
    JOIN app.channel_accounts ca ON ca.id = cv.channel_account_id AND ca.enabled AND ca.platform = 'whatsapp'
   WHERE cu.deleted_at IS NULL AND app.normalize_phone(cu.phone_e164) = v_norm
     AND (p_conversation IS NULL OR cv.id = p_conversation);
  IF v_n = 0 THEN
    UPDATE app.admin_commands SET status = 'failed', result = jsonb_build_object('reason', 'no_whatsapp_conversation', 'phone', '+' || v_norm), updated_at = now() WHERE id = c.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'no_whatsapp_conversation', 'phone', '+' || v_norm);
  END IF;
  IF v_n > 1 THEN
    UPDATE app.admin_commands SET status = 'awaiting_choice', choices = v_matches, updated_at = now() WHERE id = c.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'ambiguous', 'choices', v_matches, 'phone', '+' || v_norm);
  END IF;
  v_conv := (v_matches -> 0 ->> 'conversation_id')::uuid;
  PERFORM set_config('app.admin_command', c.id::text, true);
  -- A person is now answering this customer: HUMAN mode, AI sends and drafts
  -- canceled, before the reply is queued.
  IF (SELECT mode FROM app.conversations WHERE id = v_conv) <> 'HUMAN' THEN
    PERFORM app.take_over(v_conv, 'staff', c.staff_id, 'telegram_admin_reply', jsonb_build_object('admin_command_id', c.id), false);
  END IF;
  r := app.enqueue_staff_reply(v_conv, c.staff_id, p_text,
                               jsonb_build_object('origin', 'telegram_admin', 'admin_command_id', c.id), 'telegram:' || c.id);
  PERFORM set_config('app.admin_command', '', true);
  UPDATE app.admin_commands SET status = 'succeeded', result = jsonb_build_object('outbound_id', r ->> 'outbound_id', 'conversation_id', v_conv, 'phone', '+' || v_norm),
         updated_at = now() WHERE id = c.id;
  RETURN jsonb_build_object('ok', true, 'outbound_id', r ->> 'outbound_id', 'conversation_id', v_conv, 'phone', '+' || v_norm,
                            'link', app.dashboard_link(v_conv), 'duplicate', coalesce((r ->> 'duplicate')::boolean, false));
END $$;

-- ---------------------------------------------------------------------------
-- Event hooks → admin notifications (business facts and links only)
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.trg_notify_message() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_new boolean;
BEGIN
  IF NEW.direction <> 'inbound' OR NEW.is_historical THEN RETURN NEW; END IF;
  SELECT count(*) = 1 INTO v_new FROM app.messages WHERE conversation_id = NEW.conversation_id AND direction = 'inbound' AND NOT is_historical;
  IF v_new THEN
    PERFORM app.notify_admin('new_conversation', 'newconv:' || NEW.conversation_id, 'New WhatsApp conversation', left(app.redact_text(NEW.body), 200), app.dashboard_link(NEW.conversation_id));
  ELSE
    PERFORM app.notify_admin('customer_message', 'msg:' || NEW.id, 'Customer message', left(app.redact_text(NEW.body), 200), app.dashboard_link(NEW.conversation_id));
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.trg_notify_outbound() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_admin uuid;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NEW.payload ->> 'origin' = 'telegram_admin' THEN
    SELECT admin_id INTO v_admin FROM app.admin_commands WHERE id = (NEW.payload ->> 'admin_command_id')::uuid;
    IF NEW.status IN ('sent', 'failed', 'unknown', 'blocked', 'canceled') THEN
      PERFORM app.notify_admin('admin_reply_status', 'tgreply:' || NEW.id || ':' || NEW.status,
        CASE NEW.status WHEN 'sent' THEN 'WhatsApp accepted your reply (not yet delivered)'
                        WHEN 'failed' THEN 'Your WhatsApp reply was NOT sent'
                        WHEN 'unknown' THEN 'Your WhatsApp reply has an UNKNOWN outcome (checking before any retry)'
                        WHEN 'blocked' THEN 'Your WhatsApp reply cannot be sent'
                        ELSE 'Your WhatsApp reply was canceled' END,
        coalesce(NEW.status_reason, ''), app.dashboard_link(NEW.conversation_id), v_admin);
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'sent' AND NEW.actor_type = 'ai' THEN
    PERFORM app.notify_admin('ai_reply', 'aisent:' || NEW.id, 'AI replied to a customer', left(NEW.body, 200), app.dashboard_link(NEW.conversation_id));
  ELSIF NEW.status = 'sent' AND NEW.actor_type = 'staff' THEN
    PERFORM app.notify_admin('staff_reply', 'staffsent:' || NEW.id, 'Staff reply sent', left(NEW.body, 200), app.dashboard_link(NEW.conversation_id));
  ELSIF NEW.status IN ('failed', 'unknown') THEN
    PERFORM app.notify_admin('delivery_failure', 'sendfail:' || NEW.id || ':' || NEW.status,
      CASE NEW.status WHEN 'failed' THEN 'A WhatsApp message could not be sent' ELSE 'A WhatsApp send outcome is unknown' END,
      coalesce(NEW.status_reason, ''), app.dashboard_link(NEW.conversation_id));
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.trg_notify_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o app.outbound_messages; v_admin uuid;
BEGIN
  IF NEW.delivery_status IS NOT DISTINCT FROM OLD.delivery_status OR NEW.outbound_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO o FROM app.outbound_messages WHERE id = NEW.outbound_id;
  IF o.payload ->> 'origin' = 'telegram_admin' AND NEW.delivery_status IN ('delivered', 'read', 'failed') THEN
    SELECT admin_id INTO v_admin FROM app.admin_commands WHERE id = (o.payload ->> 'admin_command_id')::uuid;
    PERFORM app.notify_admin('admin_reply_status', 'tgdeliv:' || o.id || ':' || NEW.delivery_status,
      CASE NEW.delivery_status WHEN 'failed' THEN 'Your WhatsApp reply FAILED to deliver' WHEN 'read' THEN 'Your WhatsApp reply was read'
           ELSE 'Your WhatsApp reply was delivered' END, NULL, app.dashboard_link(o.conversation_id), v_admin);
  ELSIF NEW.delivery_status = 'failed' THEN
    PERFORM app.notify_admin('delivery_failure', 'delivfail:' || NEW.id, 'A WhatsApp message failed to deliver', NULL, app.dashboard_link(NEW.conversation_id));
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.trg_notify_mode_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.to_mode = 'HUMAN' AND NEW.actor_type IN ('customer', 'system', 'provider') THEN
    PERFORM app.notify_admin('handoff', 'handoff:' || NEW.id, 'Conversation needs a person (' || replace(split_part(NEW.reason, ':', 1), '_', ' ') || ')',
                             NULLIF(split_part(NEW.reason, ':', 2), ''), app.dashboard_link(NEW.conversation_id));
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.trg_notify_alert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_cat text;
BEGIN
  v_cat := CASE
    WHEN NEW.kind IN ('send_failed', 'send_unknown') THEN 'delivery_failure'
    WHEN NEW.kind = 'response_overdue' THEN 'unresolved'
    WHEN NEW.kind IN ('ai_budget_reached') THEN 'spending'
    WHEN NEW.kind IN ('account_disconnected', 'connection_down') THEN 'connection'
    WHEN NEW.kind IN ('backup_failed') THEN 'backup'
    WHEN NEW.kind IN ('deployment') THEN 'deployment'
    WHEN NEW.kind IN ('order_op_unknown') THEN 'orders'
    WHEN NEW.kind IN ('emergency_stop') THEN 'connection'
    ELSE 'api_failure' END;
  -- Technical details stay in the dashboard; Telegram gets the message and a link.
  PERFORM app.notify_admin(v_cat, 'alert:' || coalesce(NEW.dedupe_key, NEW.id::text), NEW.message, NULL,
                           coalesce(app.dashboard_link(nullif(NEW.details ->> 'conversation_id', '')::uuid),
                                    rtrim(coalesce(app.setting('dashboard_url') #>> '{}', ''), '/') || '/operations'));
  RETURN NEW;
END $$;

CREATE FUNCTION app.trg_notify_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_shop text := rtrim(coalesce(app.setting('shop_base_url') #>> '{}', ''), '/');
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app.notify_admin('orders', 'order:' || NEW.woo_order_id || ':new', 'New order #' || NEW.woo_order_id || ' (' || NEW.status || ')',
      CASE WHEN NEW.total_minor IS NOT NULL THEN (NEW.total_minor / 100.0)::text || ' ' || coalesce(NEW.currency, '') END,
      v_shop || '/wp-admin/post.php?post=' || NEW.woo_order_id || '&action=edit');
  ELSIF NEW.status IS DISTINCT FROM OLD.status OR (NEW.date_paid IS NOT NULL AND OLD.date_paid IS NULL) THEN
    PERFORM app.notify_admin('orders', 'order:' || NEW.woo_order_id || ':' || NEW.status || ':' || (NEW.date_paid IS NOT NULL),
      'Order #' || NEW.woo_order_id || ': ' || coalesce(OLD.status, '?') || ' → ' || NEW.status
      || CASE WHEN NEW.date_paid IS NOT NULL AND OLD.date_paid IS NULL THEN ' (payment recorded by WooCommerce)' ELSE '' END,
      NULL, v_shop || '/wp-admin/post.php?post=' || NEW.woo_order_id || '&action=edit');
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION app.trg_notify_product() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.stock_status IS DISTINCT FROM OLD.stock_status AND NEW.stock_status = 'outofstock' THEN
    PERFORM app.notify_admin('stock', 'oos:' || NEW.product_id || ':' || NEW.variation_id || ':' || to_char(now(), 'YYYYMMDDHH24'),
      'Now unavailable: ' || NEW.name, NULL, NEW.permalink);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER notify_message AFTER INSERT ON app.messages FOR EACH ROW EXECUTE FUNCTION app.trg_notify_message();
CREATE TRIGGER notify_outbound AFTER UPDATE OF status ON app.outbound_messages FOR EACH ROW EXECUTE FUNCTION app.trg_notify_outbound();
CREATE TRIGGER notify_delivery AFTER UPDATE OF delivery_status ON app.messages FOR EACH ROW EXECUTE FUNCTION app.trg_notify_delivery();
CREATE TRIGGER notify_mode_change AFTER INSERT ON app.mode_changes FOR EACH ROW EXECUTE FUNCTION app.trg_notify_mode_change();
CREATE TRIGGER notify_alert AFTER INSERT ON app.alerts FOR EACH ROW EXECUTE FUNCTION app.trg_notify_alert();
CREATE TRIGGER notify_order AFTER INSERT OR UPDATE ON app.woo_order_refs FOR EACH ROW EXECUTE FUNCTION app.trg_notify_order();
CREATE TRIGGER notify_product AFTER UPDATE ON app.woo_products FOR EACH ROW EXECUTE FUNCTION app.trg_notify_product();

-- Notices expiring within the next hour (once per notice).
CREATE FUNCTION app.notices_expiring_soon() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE n app.temporary_notices; v integer := 0;
BEGIN
  FOR n IN SELECT * FROM app.temporary_notices WHERE status = 'active' AND expiry_notified_at IS NULL
             AND expires_at > now() AND expires_at <= now() + interval '1 hour' FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE app.temporary_notices SET expiry_notified_at = now() WHERE id = n.id;
    PERFORM app.notify_admin('notice_expiring', 'noticeexp:' || n.id, 'Temporary notice expires at ' || to_char(n.expires_at AT TIME ZONE 'Asia/Dhaka', 'HH24:MI') || ' (Dhaka)',
                             left(n.body, 200), NULL);
    v := v + 1;
  END LOOP;
  RETURN v;
END $$;

-- Stock changes left 'executing' by a crash become 'unknown' (WooCommerce is
-- checked before anything is retried; nothing is retried automatically).
CREATE FUNCTION app.expire_stuck_stock_changes() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v integer;
BEGIN
  WITH s AS (UPDATE app.stock_changes SET status = 'unknown', finished_at = now()
              WHERE status = 'executing' AND created_at < now() - interval '5 minutes' RETURNING id, command_id, product_name)
  SELECT count(*) INTO v FROM s;
  UPDATE app.admin_commands SET status = 'unknown', updated_at = now()
   WHERE id IN (SELECT command_id FROM app.stock_changes WHERE status = 'unknown') AND status = 'executing';
  IF v > 0 THEN
    PERFORM app.raise_alert('stock_change_unknown', 'warning', 'A stock change was interrupted; check the product in WooCommerce.', '{}', 'stock_unknown:' || to_char(now(), 'YYYYMMDDHH24'));
  END IF;
  RETURN v;
END $$;

INSERT INTO app.schema_migrations (version) VALUES ('0013_telegram_admin');
COMMIT;
