-- 0001_core_schema.sql
-- Application records for the WhatsApp support & sales system.
-- Lives in its own schema ("app"), separate from n8n's internal tables.
-- n8n execution history is NOT the chat archive: everything durable is here.

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS app;
SET search_path = app, public;

CREATE TABLE app.schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Staff, roles and sessions
-- ---------------------------------------------------------------------------
CREATE TABLE app.staff_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE,
  display_name   text NOT NULL,
  role           text NOT NULL CHECK (role IN ('owner', 'admin', 'agent')),
  password_hash  text NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

CREATE TABLE app.staff_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   bytea NOT NULL UNIQUE,          -- sha256 of the opaque cookie token
  staff_id     uuid NOT NULL REFERENCES app.staff_users(id) ON DELETE CASCADE,
  csrf_token   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  ip           inet,
  user_agent   text
);
CREATE INDEX staff_sessions_staff_idx ON app.staff_sessions (staff_id);

CREATE TABLE app.login_attempts (
  id          bigserial PRIMARY KEY,
  email       citext NOT NULL,
  ip          inet,
  succeeded   boolean NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_at_idx ON app.login_attempts (email, at DESC);

-- ---------------------------------------------------------------------------
-- Shop and connected channel accounts
-- ---------------------------------------------------------------------------
CREATE TABLE app.shops (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  timezone      text NOT NULL DEFAULT 'Asia/Dhaka',
  currency      text NOT NULL DEFAULT 'BDT',
  woo_base_url  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.channel_accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id              uuid NOT NULL REFERENCES app.shops(id),
  provider             text NOT NULL DEFAULT 'zernio' CHECK (provider IN ('zernio')),
  platform             text NOT NULL DEFAULT 'whatsapp',
  provider_account_id  text NOT NULL,        -- Zernio account id (account.id / accountId)
  display_name         text,
  username             text,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disconnected', 'suspended', 'disabled')),
  enabled              boolean NOT NULL DEFAULT false,  -- only enabled accounts are processed
  last_event_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_account_id)
);

-- ---------------------------------------------------------------------------
-- Customers and identities
-- ---------------------------------------------------------------------------
CREATE TABLE app.customers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id              uuid NOT NULL REFERENCES app.shops(id),
  display_name         text,
  phone_e164           text,
  preferred_language   text CHECK (preferred_language IN ('bn', 'en', 'banglish')),
  marketing_consent    text NOT NULL DEFAULT 'unknown' CHECK (marketing_consent IN ('unknown', 'opted_in', 'opted_out')),
  marketing_consent_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,            -- set by customer data deletion; row is scrubbed
  deletion_request_id  uuid
);
CREATE INDEX customers_phone_idx ON app.customers (shop_id, phone_e164);

-- One row per identity a channel gives us for a person. WhatsApp BSUIDs are
-- the recommended anchor (Zernio docs); phone number is the fallback.
CREATE TABLE app.customer_identities (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id          uuid NOT NULL REFERENCES app.customers(id) ON DELETE CASCADE,
  channel_account_id   uuid NOT NULL REFERENCES app.channel_accounts(id),
  identity_kind        text NOT NULL CHECK (identity_kind IN ('bsuid', 'phone', 'participant_id')),
  identity_value       text NOT NULL,
  provider_contact_id  text,                   -- Zernio CRM contact id when present
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_account_id, identity_kind, identity_value)
);
CREATE INDEX customer_identities_customer_idx ON app.customer_identities (customer_id);

-- Verified link between a WhatsApp customer and a WooCommerce customer/contact.
CREATE TABLE app.customer_account_links (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid NOT NULL REFERENCES app.customers(id) ON DELETE CASCADE,
  woo_customer_id    bigint,
  woo_email_hash     bytea,                    -- sha256(lower(email)); raw email not needed here
  verified_method    text NOT NULL CHECK (verified_method IN ('otp_to_order_contact', 'staff_verified', 'phone_match_verified')),
  verified_by        uuid REFERENCES app.staff_users(id),
  verified_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz
);
CREATE INDEX customer_account_links_customer_idx ON app.customer_account_links (customer_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Conversations: scoped by shop + connected account + provider conversation.
-- ---------------------------------------------------------------------------
CREATE TABLE app.conversations (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                     uuid NOT NULL REFERENCES app.shops(id),
  channel_account_id          uuid NOT NULL REFERENCES app.channel_accounts(id),
  customer_id                 uuid NOT NULL REFERENCES app.customers(id),
  provider_conversation_id    text NOT NULL,     -- Zernio internal conversation id
  platform_conversation_id    text,
  -- Mode control. mode_version increments on every mode change; AI jobs carry it.
  mode                        text NOT NULL DEFAULT 'COPILOT' CHECK (mode IN ('AUTO', 'COPILOT', 'HUMAN')),
  mode_version                integer NOT NULL DEFAULT 1,
  mode_reason                 text,
  mode_changed_at             timestamptz NOT NULL DEFAULT now(),
  mode_changed_by_type        text,
  mode_changed_by             uuid REFERENCES app.staff_users(id),
  -- revision increments on every new genuine customer message and every staff
  -- message; AI output computed against an older revision is stale.
  revision                    bigint NOT NULL DEFAULT 0,
  status                      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  priority                    text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  queue_state                 text NOT NULL DEFAULT 'none' CHECK (queue_state IN ('none', 'waiting_staff', 'assigned')),
  assigned_to                 uuid REFERENCES app.staff_users(id),
  tags                        text[] NOT NULL DEFAULT '{}',
  -- Automation hold: set when an outgoing message of unknown origin or another
  -- automation is seen; AI sends are suppressed until reconciled or cleared.
  automation_hold_reason      text,
  automation_hold_since       timestamptz,
  provider_control_owner      text,              -- e.g. 'ai_agent' when Meta Business Agent holds the thread
  handoff_ack_sent_version    integer,           -- mode_version for which the fixed ack was sent
  last_inbound_at             timestamptz,       -- last genuine customer message (24h window anchor)
  last_outbound_at            timestamptz,
  last_message_at             timestamptz,
  last_message_preview        text,
  unread_count                integer NOT NULL DEFAULT 0,
  first_response_due_at       timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_account_id, provider_conversation_id)
);
CREATE INDEX conversations_list_idx ON app.conversations (shop_id, last_message_at DESC);
CREATE INDEX conversations_queue_idx ON app.conversations (queue_state, assigned_to) WHERE status IN ('open', 'pending');
CREATE INDEX conversations_customer_idx ON app.conversations (customer_id);

CREATE TABLE app.mode_changes (
  id               bigserial PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES app.conversations(id) ON DELETE CASCADE,
  from_mode        text,
  to_mode          text NOT NULL,
  from_version     integer,
  to_version       integer NOT NULL,
  reason           text NOT NULL,
  detail           jsonb,
  actor_type       text NOT NULL CHECK (actor_type IN ('staff', 'system', 'customer', 'provider')),
  actor_staff_id   uuid REFERENCES app.staff_users(id),
  at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mode_changes_conv_idx ON app.mode_changes (conversation_id, at DESC);

-- ---------------------------------------------------------------------------
-- Webhook events: every provider delivery is persisted before we acknowledge.
-- ---------------------------------------------------------------------------
CREATE TABLE app.webhook_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source              text NOT NULL CHECK (source IN ('zernio', 'woocommerce')),
  provider_event_id   text NOT NULL,              -- X-Zernio-Event-Id / X-WC-Webhook-Delivery-ID
  event_type          text NOT NULL,
  signature_valid     boolean NOT NULL,
  headers             jsonb NOT NULL DEFAULT '{}',  -- sanitized (no auth/signature values)
  payload             jsonb NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  processing_status   text NOT NULL DEFAULT 'received'
                      CHECK (processing_status IN ('received', 'processing', 'processed', 'ignored', 'deferred', 'failed', 'dead')),
  attempts            integer NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz,
  last_error          text,
  processed_at        timestamptz,
  route               jsonb,                       -- normalized routing decision
  duplicate_count     integer NOT NULL DEFAULT 0,
  UNIQUE (source, provider_event_id)
);
CREATE INDEX webhook_events_status_idx ON app.webhook_events (processing_status, next_attempt_at);

-- ---------------------------------------------------------------------------
-- Messages: actual messages only (customer, sent AI/staff/system, external).
-- Drafts, notes and failed attempts live in their own tables.
-- ---------------------------------------------------------------------------
CREATE TABLE app.messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id       uuid NOT NULL REFERENCES app.conversations(id) ON DELETE CASCADE,
  direction             text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  author_type           text NOT NULL CHECK (author_type IN
                          ('customer', 'ai', 'staff', 'system', 'external_human', 'external_automation', 'unknown')),
  author_staff_id       uuid REFERENCES app.staff_users(id),
  kind                  text NOT NULL DEFAULT 'text' CHECK (kind IN
                          ('text', 'image', 'audio', 'video', 'file', 'sticker', 'location', 'contacts',
                           'interactive', 'template', 'order', 'unsupported')),
  body                  text,
  provider_message_id   text,                      -- WhatsApp wamid (platformMessageId)
  provider_internal_id  text,                      -- Zernio message id
  outbound_id           uuid,                      -- set when sent by our dispatcher
  sent_at               timestamptz NOT NULL,      -- provider timestamp (ordering key)
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  delivery_status       text CHECK (delivery_status IN ('sent', 'delivered', 'read', 'failed')),
  delivery_status_at    timestamptz,
  delivery_error        jsonb,
  sent_via              text,                      -- Zernio sentVia on message.sent
  send_source           text,                      -- Zernio source (whatsapp_business_app | cloud_api | meta_business_agent)
  is_historical         boolean NOT NULL DEFAULT false,  -- imported history never triggers replies
  quoted_provider_id    text,
  metadata              jsonb NOT NULL DEFAULT '{}',
  edited_at             timestamptz,
  deleted_by_sender_at  timestamptz,
  redacted_at           timestamptz,               -- content removed by retention/deletion
  search_tsv            tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED
);
CREATE UNIQUE INDEX messages_provider_id_uq ON app.messages (conversation_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX messages_conv_time_idx ON app.messages (conversation_id, sent_at, recorded_at);
CREATE INDEX messages_search_idx ON app.messages USING gin (search_tsv);
CREATE INDEX messages_outbound_idx ON app.messages (outbound_id) WHERE outbound_id IS NOT NULL;

CREATE TABLE app.attachments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id          uuid NOT NULL REFERENCES app.messages(id) ON DELETE CASCADE,
  position            integer NOT NULL,
  media_type          text NOT NULL,             -- image|video|audio|file|sticker|share|...
  mime_type           text,
  file_name           text,
  size_bytes          bigint,
  sha256              bytea,
  -- The Zernio media endpoint requires the API key; it is a reference only and
  -- is never put into prompts, logs or the dashboard.
  provider_media_ref  text,
  fetch_status        text NOT NULL DEFAULT 'pending'
                      CHECK (fetch_status IN ('pending', 'stored', 'expired', 'failed', 'too_large', 'rejected_type', 'not_applicable')),
  fetch_error         text,
  fetched_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, position)
);
CREATE INDEX attachments_sha_idx ON app.attachments (sha256);
CREATE INDEX attachments_pending_idx ON app.attachments (fetch_status) WHERE fetch_status = 'pending';

-- Bytes are kept separately so list queries never load them.
CREATE TABLE app.attachment_blobs (
  attachment_id  uuid PRIMARY KEY REFERENCES app.attachments(id) ON DELETE CASCADE,
  data           bytea NOT NULL
);

CREATE TABLE app.internal_notes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES app.conversations(id) ON DELETE CASCADE,
  staff_id         uuid NOT NULL REFERENCES app.staff_users(id),
  body             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX internal_notes_conv_idx ON app.internal_notes (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- AI jobs, drafts, usage and image analyses
-- ---------------------------------------------------------------------------
CREATE TABLE app.ai_jobs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id          uuid NOT NULL REFERENCES app.conversations(id) ON DELETE CASCADE,
  kind                     text NOT NULL CHECK (kind IN ('reply', 'staff_assist', 'vision', 'summary', 'sandbox')),
  trigger_message_id       uuid REFERENCES app.messages(id) ON DELETE SET NULL,
  requested_by             uuid REFERENCES app.staff_users(id),
  mode_at_start            text NOT NULL,
  mode_version_at_start    integer NOT NULL,
  revision_at_start        bigint NOT NULL,
  prompt_version_id        uuid,
  status                   text NOT NULL DEFAULT 'running'
                           CHECK (status IN ('running', 'queued_output', 'drafted', 'completed', 'stale', 'discarded', 'failed', 'canceled')),
  decision                 text,
  result                   jsonb,
  discard_reason           text,
  started_at               timestamptz NOT NULL DEFAULT now(),
  finished_at              timestamptz
);
CREATE INDEX ai_jobs_conv_idx ON app.ai_jobs (conversation_id, started_at DESC);
CREATE INDEX ai_jobs_running_idx ON app.ai_jobs (conversation_id) WHERE status = 'running';

CREATE TABLE app.ai_drafts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id    uuid NOT NULL REFERENCES app.conversations(id) ON DELETE CASCADE,
  ai_job_id          uuid REFERENCES app.ai_jobs(id) ON DELETE SET NULL,
  body               text NOT NULL,
  decision           text,
  references_used    jsonb NOT NULL DEFAULT '[]',
  mode_version       integer NOT NULL,
  revision           bigint NOT NULL,
  status             text NOT NULL DEFAULT 'pending_review'
                     CHECK (status IN ('pending_review', 'approved', 'rejected', 'invalidated')),
  invalidated_reason text,
  reviewed_by        uuid REFERENCES app.staff_users(id),
  reviewed_at        timestamptz,
  final_body         text,                    -- what staff actually approved (may be edited)
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_drafts_conv_idx ON app.ai_drafts (conversation_id, status);

CREATE TABLE app.ai_usage (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_job_id           uuid REFERENCES app.ai_jobs(id) ON DELETE SET NULL,
  conversation_id     uuid REFERENCES app.conversations(id) ON DELETE SET NULL,
  purpose             text NOT NULL,           -- reply | vision | classify | summary | learning | sandbox
  model               text NOT NULL,
  provider            text,
  request_id          text,
  latency_ms          integer,
  -- NULL means "not returned by the provider", never zero.
  prompt_tokens       integer,
  completion_tokens   integer,
  reasoning_tokens    integer,
  cost_usd            numeric(14, 8),
  usage_available     boolean NOT NULL,
  outcome             text NOT NULL CHECK (outcome IN ('ok', 'error', 'invalid_output', 'timeout', 'incomplete')),
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_created_idx ON app.ai_usage (created_at);

CREATE TABLE app.image_analyses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id     uuid NOT NULL REFERENCES app.attachments(id) ON DELETE CASCADE,
  sha256            bytea NOT NULL,
  model             text NOT NULL,
  prompt_version    text NOT NULL,
  question          text,
  status            text NOT NULL CHECK (status IN ('ok', 'invalid_output', 'failed', 'unreadable')),
  result            jsonb,                     -- validated observation object only
  error             text,
  ai_usage_id       uuid REFERENCES app.ai_usage(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- Re-use: one successful analysis per (image bytes, model, prompt version).
CREATE UNIQUE INDEX image_analyses_reuse_uq ON app.image_analyses (sha256, model, prompt_version) WHERE status = 'ok';
CREATE INDEX image_analyses_attachment_idx ON app.image_analyses (attachment_id);

-- ---------------------------------------------------------------------------
-- Outbound: the single durable outbox used by every sending path.
-- The id doubles as the Zernio Idempotency-Key.
-- ---------------------------------------------------------------------------
CREATE TABLE app.outbound_messages (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id         uuid NOT NULL REFERENCES app.conversations(id) ON DELETE CASCADE,
  kind                    text NOT NULL CHECK (kind IN
                            ('ai_reply', 'staff_reply', 'approved_draft', 'handoff_ack', 'scheduled', 'notification', 'template', 'followup')),
  category                text NOT NULL DEFAULT 'service' CHECK (category IN ('service', 'utility', 'marketing')),
  actor_type              text NOT NULL CHECK (actor_type IN ('ai', 'staff', 'system')),
  actor_staff_id          uuid REFERENCES app.staff_users(id),
  body                    text,
  payload                 jsonb NOT NULL DEFAULT '{}',   -- template / attachment / interactive (validated)
  ai_job_id               uuid REFERENCES app.ai_jobs(id) ON DELETE SET NULL,
  draft_id                uuid REFERENCES app.ai_drafts(id) ON DELETE SET NULL,
  expected_mode_version   integer,
  expected_revision       bigint,
  dedupe_key              text NOT NULL UNIQUE,
  status                  text NOT NULL DEFAULT 'queued' CHECK (status IN
                            ('queued', 'sending', 'sent', 'failed', 'unknown', 'canceled', 'blocked')),
  status_reason           text,
  attempts                integer NOT NULL DEFAULT 0,
  max_attempts            integer NOT NULL DEFAULT 4,
  scheduled_for           timestamptz NOT NULL DEFAULT now(),
  next_attempt_at         timestamptz NOT NULL DEFAULT now(),
  lease_until             timestamptz,
  in_flight_at_takeover   boolean NOT NULL DEFAULT false,
  provider_message_id     text,
  provider_response       jsonb,
  last_error              jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  sent_at                 timestamptz,
  resolved_by             uuid REFERENCES app.staff_users(id)
);
CREATE INDEX outbound_ready_idx ON app.outbound_messages (next_attempt_at) WHERE status = 'queued';
CREATE INDEX outbound_conv_idx ON app.outbound_messages (conversation_id, created_at DESC);
CREATE INDEX outbound_unknown_idx ON app.outbound_messages (status) WHERE status IN ('unknown', 'sending');

ALTER TABLE app.messages
  ADD CONSTRAINT messages_outbound_fk FOREIGN KEY (outbound_id) REFERENCES app.outbound_messages(id) ON DELETE SET NULL;

CREATE TABLE app.outbound_attempts (
  id               bigserial PRIMARY KEY,
  outbound_id      uuid NOT NULL REFERENCES app.outbound_messages(id) ON DELETE CASCADE,
  attempt_no       integer NOT NULL,
  worker           text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  http_status      integer,
  outcome          text CHECK (outcome IN ('accepted', 'rejected_retryable', 'rejected_permanent', 'ambiguous', 'lease_expired')),
  error            jsonb,
  UNIQUE (outbound_id, attempt_no)
);

-- ---------------------------------------------------------------------------
-- Memory
-- ---------------------------------------------------------------------------
CREATE TABLE app.conversation_summaries (
  conversation_id     uuid PRIMARY KEY REFERENCES app.conversations(id) ON DELETE CASCADE,
  summary             text NOT NULL,
  actions_taken       jsonb NOT NULL DEFAULT '[]',
  open_issues         jsonb NOT NULL DEFAULT '[]',
  covers_until        timestamptz NOT NULL,
  version             integer NOT NULL DEFAULT 1,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.customer_memories (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         uuid NOT NULL REFERENCES app.customers(id) ON DELETE CASCADE,
  key                 text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  value               text NOT NULL CHECK (length(value) <= 300),
  source_message_id   uuid REFERENCES app.messages(id) ON DELETE SET NULL,
  confirmed_by        text NOT NULL CHECK (confirmed_by IN ('customer', 'staff')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  deleted_by          uuid REFERENCES app.staff_users(id)
);
CREATE UNIQUE INDEX customer_memories_key_uq ON app.customer_memories (customer_id, key) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Shared knowledge (owner-approved only reaches the AI)
-- ---------------------------------------------------------------------------
CREATE TABLE app.knowledge_documents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id              uuid NOT NULL REFERENCES app.shops(id),
  slug                 text NOT NULL,
  category             text NOT NULL CHECK (category IN ('faq', 'product', 'procedure', 'policy')),
  language             text NOT NULL DEFAULT 'en',
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  published_version_id uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, slug)
);

CREATE TABLE app.knowledge_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      uuid NOT NULL REFERENCES app.knowledge_documents(id) ON DELETE CASCADE,
  version_no       integer NOT NULL,
  title            text NOT NULL,
  body             text NOT NULL CHECK (length(body) <= 8000),
  status           text NOT NULL CHECK (status IN ('draft', 'approved', 'superseded', 'rejected')),
  source           text NOT NULL CHECK (source IN ('owner', 'learning_proposal', 'import')),
  proposal_id      uuid,
  created_by       uuid REFERENCES app.staff_users(id),
  approved_by      uuid REFERENCES app.staff_users(id),
  approved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  search_tsv       tsvector GENERATED ALWAYS AS (
                     setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
                     setweight(to_tsvector('simple', coalesce(body, '')), 'B')) STORED,
  UNIQUE (document_id, version_no)
);
CREATE INDEX knowledge_versions_search_idx ON app.knowledge_versions USING gin (search_tsv);
ALTER TABLE app.knowledge_documents
  ADD CONSTRAINT knowledge_documents_published_fk FOREIGN KEY (published_version_id) REFERENCES app.knowledge_versions(id);

CREATE TABLE app.knowledge_proposals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind               text NOT NULL CHECK (kind IN ('new', 'revise')),
  document_id        uuid REFERENCES app.knowledge_documents(id) ON DELETE SET NULL,
  category           text NOT NULL CHECK (category IN ('faq', 'product', 'procedure', 'policy')),
  proposed_title     text NOT NULL,
  proposed_body      text NOT NULL CHECK (length(proposed_body) <= 8000),
  rationale          text,
  -- Conversation/message ids only; readable by owner/admin reviewers.
  evidence_refs      jsonb NOT NULL DEFAULT '[]',
  redaction_report   jsonb NOT NULL DEFAULT '{}',
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by        uuid REFERENCES app.staff_users(id),
  reviewed_at        timestamptz,
  review_note        text,
  resulting_version_id uuid REFERENCES app.knowledge_versions(id),
  created_by_run     text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
CREATE TABLE app.order_links (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL REFERENCES app.customers(id) ON DELETE CASCADE,
  woo_order_id      bigint NOT NULL,
  verified_method   text NOT NULL CHECK (verified_method IN ('account_link', 'otp_to_order_contact', 'staff_verified', 'created_in_chat')),
  verified_by       uuid REFERENCES app.staff_users(id),
  verified_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  UNIQUE (customer_id, woo_order_id)
);

CREATE TABLE app.order_verifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   uuid NOT NULL REFERENCES app.conversations(id) ON DELETE CASCADE,
  customer_id       uuid NOT NULL REFERENCES app.customers(id) ON DELETE CASCADE,
  woo_order_id      bigint NOT NULL,
  channel           text NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp_to_billing_phone')),
  code_hash         bytea NOT NULL,
  expires_at        timestamptz NOT NULL,
  attempts          integer NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'expired', 'locked')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.pending_order_operations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id            text NOT NULL UNIQUE,     -- client-supplied idempotency key
  conversation_id         uuid NOT NULL REFERENCES app.conversations(id) ON DELETE CASCADE,
  customer_id             uuid NOT NULL REFERENCES app.customers(id) ON DELETE CASCADE,
  op_type                 text NOT NULL CHECK (op_type IN
                            ('create_order', 'cancel_order', 'refund', 'address_change', 'discount', 'payment_state_change', 'renewal', 'access_issue')),
  woo_order_id            bigint,
  payload                 jsonb NOT NULL,           -- validated line items / details
  quote                   jsonb,                    -- authoritative totals returned by WooCommerce
  status                  text NOT NULL DEFAULT 'awaiting_customer_confirmation' CHECK (status IN
                            ('awaiting_customer_confirmation', 'awaiting_staff_approval', 'approved', 'executing',
                             'succeeded', 'failed', 'unknown', 'rejected', 'expired', 'canceled')),
  requires_staff_approval boolean NOT NULL DEFAULT true,
  customer_confirmed_at   timestamptz,
  customer_confirm_message_id uuid REFERENCES app.messages(id) ON DELETE SET NULL,
  staff_decision_by       uuid REFERENCES app.staff_users(id),
  staff_decision_at       timestamptz,
  result                  jsonb,
  expires_at              timestamptz NOT NULL DEFAULT now() + interval '2 hours',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pending_order_ops_conv_idx ON app.pending_order_operations (conversation_id, status);

-- Local references synced from WooCommerce; WooCommerce stays the source of truth.
CREATE TABLE app.woo_products (
  product_id       bigint NOT NULL,
  variation_id     bigint NOT NULL DEFAULT 0,
  name             text NOT NULL,
  sku              text,
  type             text,
  attributes       jsonb NOT NULL DEFAULT '{}',
  price_minor      bigint,
  currency         text,
  stock_status     text,
  stock_quantity   integer,
  permalink        text,
  status           text,
  source_modified_at timestamptz,
  synced_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, variation_id)
);

CREATE TABLE app.woo_order_refs (
  woo_order_id        bigint PRIMARY KEY,
  status              text NOT NULL,
  currency            text,
  total_minor         bigint,
  billing_phone_hash  bytea,
  billing_email_hash  bytea,
  woo_customer_id     bigint,
  payment_method      text,
  date_paid           timestamptz,
  source_modified_at  timestamptz,
  synced_at           timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Tickets, feedback, canned replies
-- ---------------------------------------------------------------------------
CREATE TABLE app.tickets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES app.conversations(id) ON DELETE CASCADE,
  subject          text NOT NULL,
  category         text,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_customer', 'resolved', 'closed')),
  priority         text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assigned_to      uuid REFERENCES app.staff_users(id),
  due_at           timestamptz,
  created_by       uuid REFERENCES app.staff_users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz
);

CREATE TABLE app.feedback (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES app.conversations(id) ON DELETE CASCADE,
  message_id       uuid REFERENCES app.messages(id) ON DELETE SET NULL,
  source           text NOT NULL CHECK (source IN ('customer', 'staff')),
  rating           integer CHECK (rating BETWEEN 1 AND 5),
  label            text,                        -- e.g. 'ai_wrong', 'ai_good', 'corrected'
  comment          text,
  staff_id         uuid REFERENCES app.staff_users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.canned_replies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  body        text NOT NULL,
  language    text NOT NULL DEFAULT 'en',
  created_by  uuid REFERENCES app.staff_users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Settings, prompts, escalation rules (versioned)
-- ---------------------------------------------------------------------------
CREATE TABLE app.settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  updated_by  uuid REFERENCES app.staff_users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.settings_history (
  id          bigserial PRIMARY KEY,
  key         text NOT NULL,
  value       jsonb NOT NULL,
  version     integer NOT NULL,
  changed_by  uuid REFERENCES app.staff_users(id),
  changed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.prompt_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (name IN ('customer_system', 'vision_system', 'summary_system', 'learning_system')),
  version_no    integer NOT NULL,
  body          text NOT NULL,
  model_config  jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  note          text,
  created_by    uuid REFERENCES app.staff_users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_by  uuid REFERENCES app.staff_users(id),
  published_at  timestamptz,
  tested_at     timestamptz,                   -- last successful test-area run
  UNIQUE (name, version_no)
);
CREATE UNIQUE INDEX prompt_versions_one_published ON app.prompt_versions (name) WHERE status = 'published';

-- ---------------------------------------------------------------------------
-- Operations: audit, alerts, health, data requests
-- ---------------------------------------------------------------------------
CREATE TABLE app.audit_log (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_type   text NOT NULL CHECK (actor_type IN ('staff', 'system', 'customer', 'provider', 'workflow')),
  actor_id     uuid,
  action       text NOT NULL,
  entity_type  text,
  entity_id    text,
  details      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_entity_idx ON app.audit_log (entity_type, entity_id, at DESC);
CREATE INDEX audit_log_at_idx ON app.audit_log (at DESC);

CREATE TABLE app.alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL,
  severity      text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  message       text NOT NULL,
  details       jsonb NOT NULL DEFAULT '{}',
  dedupe_key    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  notified_at   timestamptz,
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES app.staff_users(id)
);
CREATE UNIQUE INDEX alerts_open_dedupe_uq ON app.alerts (dedupe_key) WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL;

CREATE TABLE app.health_checks (
  component    text PRIMARY KEY,
  status       text NOT NULL CHECK (status IN ('ok', 'degraded', 'down', 'unknown')),
  detail       jsonb NOT NULL DEFAULT '{}',
  checked_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.data_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('export', 'delete')),
  status        text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed')),
  requested_by  uuid NOT NULL REFERENCES app.staff_users(id),
  summary       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.history_imports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_account_id uuid NOT NULL REFERENCES app.channel_accounts(id),
  conversation_ref   text,
  cursor             text,
  status             text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  imported_count     integer NOT NULL DEFAULT 0,
  started_by         uuid REFERENCES app.staff_users(id),
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  last_error         text
);

INSERT INTO app.schema_migrations (version) VALUES ('0001_core_schema');

COMMIT;
