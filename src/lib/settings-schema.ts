import { z } from 'zod';

// Owner/admin-editable settings. ai_enabled / sending_enabled are changed only
// through the global controls endpoint; messaging_window_hours mirrors
// WhatsApp policy and is read-only.
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const modelId = z.string().regex(/^[a-z0-9][\w.-]*\/[\w.:-]+$/i).max(120);
export const NOTIFICATION_CATEGORIES = ['new_conversation', 'customer_message', 'ai_reply', 'staff_reply', 'delivery_failure', 'handoff', 'unresolved',
  'orders', 'stock', 'knowledge', 'notice_expiring', 'api_failure', 'connection', 'spending', 'deployment', 'backup', 'admin_reply_status'] as const;
const text3 = z.object({ en: z.string().max(500), bn: z.string().max(500).optional(), banglish: z.string().max(500).optional() });

export const SETTINGS_SCHEMAS: Record<string, z.ZodTypeAny> = {
  shop_name: z.string().min(1).max(100),
  shop_base_url: z.string().url().regex(/^https:\/\//),
  dashboard_url: z.string().url(),
  default_mode: z.enum(['AUTO', 'COPILOT', 'HUMAN']),
  agents_can_resume_ai: z.boolean(),
  agents_see_assigned_only: z.boolean(),
  per_conversation_sends_per_minute: z.number().int().min(1).max(20),
  marketing_max_per_week: z.number().int().min(0).max(7),
  burst_debounce_seconds: z.number().int().min(0).max(30),
  ai_daily_budget_usd: z.number().min(0).max(1000),
  models: z.object({
    chat_model: modelId,
    chat_reasoning_effort: z.enum(['low', 'medium', 'high']),
    chat_max_tokens: z.number().int().min(200).max(8000),
    vision_model: modelId,
    vision_max_tokens: z.number().int().min(200).max(4000),
    vision_response_format: z.enum(['json_object', 'json_schema']),
    summary_model: modelId,
    embedding_model: modelId.nullable(),
  }),
  vision: z.object({
    enabled: z.boolean(),
    max_images_per_turn: z.number().int().min(1).max(5),
    max_image_bytes: z.number().int().min(100_000).max(10 * 1024 * 1024),
    allowed_mime_types: z.array(z.enum(['image/jpeg', 'image/png', 'image/webp'])).min(1),
    prompt_version: z.string().regex(/^[\w.-]{1,40}$/),
  }),
  attachments: z.object({
    max_bytes: z.number().int().min(100_000).max(64 * 1024 * 1024),
    allowed_mime_types: z.array(z.string().regex(/^[a-z]+\/[\w.+-]+$/)).min(1),
  }),
  handoff_ack: z.object({ enabled: z.boolean(), text: text3 }),
  escalation_rules: z.object({
    customer_requests_human: z.object({ enabled: z.boolean() }),
    unresolved_complaint: z.object({ enabled: z.boolean(), complaint_turns: z.number().int().min(1).max(10) }),
    repeated_failed_answers: z.object({ enabled: z.boolean(), unresolved_turns: z.number().int().min(1).max(10) }),
    refund_request: z.object({ enabled: z.boolean() }),
    unavailable_information: z.object({ enabled: z.boolean() }),
    purchase_intent: z.object({ enabled: z.boolean() }),
  }),
  business_hours: z.object({
    timezone: z.string().max(60),
    days: z.record(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']), z.tuple([hhmm, hhmm])),
    after_hours_note: text3,
  }),
  response_time_targets: z.object({ first_response_minutes: z.number().int().min(1).max(1440), reminder_after_minutes: z.number().int().min(1).max(1440) }),
  // Telegram admin notifications (bot credential lives only in n8n). Each
  // category is sent at once, collected into the daily summary, or not at all.
  telegram_notifications: z.object({
    enabled: z.boolean(),
    max_per_minute: z.number().int().min(1).max(60),
    categories: z.record(z.enum(NOTIFICATION_CATEGORIES), z.enum(['immediate', 'summary', 'disabled'])),
  }),
  order_ops: z.object({ create_requires_staff_approval: z.boolean(), prefer_hosted_checkout: z.boolean(), unpaid_order_creation_enabled: z.boolean() }),
  retention: z.object({
    message_content_days: z.number().int().min(30).max(3650),
    attachment_days: z.number().int().min(7).max(3650),
    webhook_payload_days: z.number().int().min(1).max(365),
    ai_usage_days: z.number().int().min(30).max(3650),
    n8n_execution_note: z.string().max(300).optional(),
  }),
  followups: z.object({ enabled: z.boolean(), renewal_reminders_enabled: z.boolean(), order_update_notifications_enabled: z.boolean() }),
};

// Only the owner may change these (admins can change the rest).
export const REQUIRES_OWNER = new Set(['models', 'escalation_rules', 'order_ops', 'retention', 'ai_daily_budget_usd', 'agents_can_resume_ai']);
