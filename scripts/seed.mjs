// Seeds the shop row, safe default settings, prompt versions and the sandbox
// test conversation. Idempotent: existing settings and prompts are not
// overwritten, so it is safe to run after every deploy.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

// Safe defaults: AI answering is OFF and new conversations start in COPILOT.
// Automatic replies are enabled deliberately, after the control tests pass.
const DEFAULT_SETTINGS = {
  shop_name: process.env.SHOP_NAME || 'Infinity Digital Shop',
  shop_base_url: process.env.WOO_BASE_URL || 'https://infinitydigitalshop.com',
  dashboard_url: process.env.APP_ORIGIN || 'https://support.example.com',
  ai_enabled: false,
  sending_enabled: true,
  default_mode: 'COPILOT',
  agents_can_resume_ai: false,
  messaging_window_hours: 24,
  per_conversation_sends_per_minute: 8,
  marketing_max_per_week: 2,
  burst_debounce_seconds: 6,
  ai_daily_budget_usd: 5,
  models: {
    chat_model: 'deepseek/deepseek-v4.1-flash',
    chat_reasoning_effort: 'low',
    chat_max_tokens: 1500,
    vision_model: 'qwen/qwen3.7-flash',
    vision_max_tokens: 1200,
    vision_response_format: 'json_object',
    summary_model: 'deepseek/deepseek-v4.1-flash',
    embedding_model: null,
  },
  vision: {
    enabled: true,
    max_images_per_turn: 3,
    max_image_bytes: 5 * 1024 * 1024,
    allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'],
    prompt_version: 'vision-v1',
  },
  attachments: {
    max_bytes: 16 * 1024 * 1024,
    allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'video/mp4'],
  },
  handoff_ack: {
    enabled: true,
    text: {
      en: 'Thanks — a member of our team will reply to you here shortly.',
      bn: 'ধন্যবাদ! আমাদের টিমের একজন সদস্য শিগগিরই এখানে আপনাকে উত্তর দেবেন।',
      banglish: 'Thanks! Amader team er ekjon member shigroi ekhane apnake reply dibe.',
    },
  },
  escalation_rules: {
    customer_requests_human: { enabled: true },
    unresolved_complaint: { enabled: true, complaint_turns: 2 },
    repeated_failed_answers: { enabled: true, unresolved_turns: 2 },
    refund_request: { enabled: true },
    unavailable_information: { enabled: true },
    purchase_intent: { enabled: false },
  },
  business_hours: {
    timezone: 'Asia/Dhaka',
    days: { mon: ['10:00', '22:00'], tue: ['10:00', '22:00'], wed: ['10:00', '22:00'], thu: ['10:00', '22:00'],
            fri: ['15:00', '22:00'], sat: ['10:00', '22:00'], sun: ['10:00', '22:00'] },
    after_hours_note: {
      en: 'Our team is offline right now; a person will follow up during business hours.',
      bn: 'আমাদের টিম এখন অফলাইনে আছে; অফিস সময়ে একজন সদস্য আপনার সাথে যোগাযোগ করবেন।',
    },
  },
  response_time_targets: { first_response_minutes: 10, reminder_after_minutes: 15 },
  notifications: { telegram_enabled: false, telegram_chat_id: '', notify_on: ['handoff', 'send_failed', 'send_unknown', 'emergency_stop', 'connection_down'] },
  order_ops: { create_requires_staff_approval: true, prefer_hosted_checkout: true, unpaid_order_creation_enabled: false },
  retention: {
    message_content_days: 730,
    attachment_days: 180,
    webhook_payload_days: 30,
    ai_usage_days: 400,
    n8n_execution_note: 'Configure EXECUTIONS_DATA_MAX_AGE in n8n; chats are archived here, not in n8n.',
  },
  followups: { enabled: false, renewal_reminders_enabled: false, order_update_notifications_enabled: false },
};

const PROMPTS = [
  { name: 'customer_system', file: 'customer_system.md', model_config: { model_setting: 'models.chat_model' } },
  { name: 'vision_system', file: 'vision_system.md', model_config: { model_setting: 'models.vision_model' } },
  { name: 'summary_system', file: 'summary_system.md', model_config: { model_setting: 'models.summary_model' } },
  { name: 'learning_system', file: 'learning_system.md', model_config: { model_setting: 'models.chat_model' } },
];

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  let shop = (await client.query('SELECT id FROM app.shops LIMIT 1')).rows[0];
  if (!shop) {
    shop = (await client.query(
      'INSERT INTO app.shops (name, timezone, currency, woo_base_url) VALUES ($1, $2, $3, $4) RETURNING id',
      [DEFAULT_SETTINGS.shop_name, 'Asia/Dhaka', 'BDT', process.env.WOO_BASE_URL || null],
    )).rows[0];
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await client.query(
      `INSERT INTO app.settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)],
    );
  }
  for (const p of PROMPTS) {
    const body = await readFile(path.join(root, 'prompts', p.file), 'utf8');
    await client.query(
      `INSERT INTO app.prompt_versions (name, version_no, body, model_config, status, note, published_at)
       SELECT $1, 1, $2, $3::jsonb, 'published', 'initial version from prompts/', now()
       WHERE NOT EXISTS (SELECT 1 FROM app.prompt_versions WHERE name = $1)`,
      [p.name, body, JSON.stringify(p.model_config)],
    );
  }
  // Sandbox: a conversation that can never send (claim_outbound refuses it),
  // used by the dashboard's test area.
  const acct = (await client.query(
    `INSERT INTO app.channel_accounts (shop_id, provider, platform, provider_account_id, display_name, status, enabled)
     VALUES ($1, 'zernio', 'whatsapp', 'sandbox', 'Sandbox (never sends)', 'disabled', false)
     ON CONFLICT (provider, provider_account_id) DO UPDATE SET display_name = excluded.display_name RETURNING id`,
    [shop.id],
  )).rows[0];
  const hasSandbox = (await client.query('SELECT 1 FROM app.conversations WHERE is_sandbox LIMIT 1')).rowCount;
  if (!hasSandbox) {
    const cust = (await client.query(
      `INSERT INTO app.customers (shop_id, display_name) VALUES ($1, 'Sandbox customer') RETURNING id`, [shop.id],
    )).rows[0];
    await client.query(
      `INSERT INTO app.conversations (shop_id, channel_account_id, customer_id, provider_conversation_id, mode, is_sandbox, status)
       VALUES ($1, $2, $3, 'sandbox', 'COPILOT', true, 'open')`,
      [shop.id, acct.id, cust.id],
    );
  }
  await client.query('COMMIT');
  console.log('seed complete');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
