-- 0005_event_routing.sql
-- Tracks whether n8n accepted the routing notification for a processed
-- event, so the maintenance sweep can re-deliver notifications that were lost
-- (n8n down, network error). Re-delivery is harmless: start_ai_job refuses
-- duplicate or superseded work.

BEGIN;
SET search_path = app, public;

ALTER TABLE app.webhook_events ADD COLUMN routed_at timestamptz;
ALTER TABLE app.webhook_events ADD COLUMN route_attempts integer NOT NULL DEFAULT 0;
CREATE INDEX webhook_events_unrouted_idx ON app.webhook_events (processed_at)
  WHERE routed_at IS NULL AND processing_status = 'processed';

-- Reactions stored against the reacted-to message.
ALTER TABLE app.messages ADD COLUMN reactions jsonb NOT NULL DEFAULT '[]';

INSERT INTO app.schema_migrations (version) VALUES ('0005_event_routing');
COMMIT;
