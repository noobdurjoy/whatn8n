-- 0009_history_targets.sql
-- Known WhatsApp conversations for the history import workflow (J), with
-- the participant identity the backend import endpoint needs.

BEGIN;
SET search_path = app, public;

CREATE FUNCTION app.history_import_targets(p_limit integer DEFAULT 200) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'conversation_id', c.id,
    'provider_conversation_id', c.provider_conversation_id,
    'provider_account_id', a.provider_account_id,
    'participant', jsonb_build_object(
      'bsuid', (SELECT identity_value FROM app.customer_identities i WHERE i.customer_id = c.customer_id AND i.channel_account_id = a.id AND identity_kind = 'bsuid' LIMIT 1),
      'phone_e164', cu.phone_e164,
      'participant_id', (SELECT identity_value FROM app.customer_identities i WHERE i.customer_id = c.customer_id AND i.channel_account_id = a.id AND identity_kind = 'participant_id' LIMIT 1),
      'display_name', cu.display_name,
      'provider_contact_id', (SELECT provider_contact_id FROM app.customer_identities i WHERE i.customer_id = c.customer_id AND i.channel_account_id = a.id AND provider_contact_id IS NOT NULL LIMIT 1))
  ) ORDER BY c.last_message_at DESC NULLS LAST), '[]')
  FROM (SELECT * FROM app.conversations WHERE NOT is_sandbox AND provider_conversation_id IS NOT NULL
        ORDER BY last_message_at DESC NULLS LAST LIMIT least(p_limit, 1000)) c
  JOIN app.channel_accounts a ON a.id = c.channel_account_id
  JOIN app.customers cu ON cu.id = c.customer_id
$$;

INSERT INTO app.schema_migrations (version) VALUES ('0009_history_targets');
COMMIT;
