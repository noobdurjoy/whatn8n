-- 0006_staff_uploads.sql
-- Files staff attach to a reply from the dashboard. Validated on upload
-- (type by magic bytes, size) and handed to the dispatcher, which uploads
-- them to Zernio's media endpoint right before sending.

BEGIN;
SET search_path = app, public;
SET LOCAL check_function_bodies = off;

CREATE TABLE app.staff_uploads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES app.conversations(id) ON DELETE CASCADE,
  staff_id         uuid NOT NULL REFERENCES app.staff_users(id),
  file_name        text NOT NULL,
  mime_type        text NOT NULL,
  size_bytes       integer NOT NULL,
  sha256           bytea NOT NULL,
  data             bytea NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Returns the upload attached to a claimed outbound message, only while that
-- message is being sent and only if it belongs to the same conversation.
CREATE FUNCTION app.get_outbound_upload(p_outbound uuid)
RETURNS TABLE (file_name text, mime_type text, size_bytes integer, data_base64 text)
LANGUAGE sql STABLE AS $$
  SELECT u.file_name, u.mime_type, u.size_bytes, encode(u.data, 'base64')
  FROM app.outbound_messages o
  JOIN app.staff_uploads u ON u.id = (o.payload -> 'attachment' ->> 'upload_id')::uuid AND u.conversation_id = o.conversation_id
  WHERE o.id = p_outbound AND o.status = 'sending'
$$;

-- Records the provider media URL used for the send (public Zernio storage URL).
CREATE FUNCTION app.set_outbound_media_url(p_outbound uuid, p_url text) RETURNS void
LANGUAGE sql AS $$
  UPDATE app.outbound_messages SET payload = jsonb_set(payload, '{attachment,url}', to_jsonb(p_url)), updated_at = now()
   WHERE id = p_outbound AND status = 'sending' AND payload ? 'attachment'
$$;

INSERT INTO app.schema_migrations (version) VALUES ('0006_staff_uploads');
COMMIT;
