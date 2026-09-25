// Mirror of app.role_capabilities() in db/migrations/0002_control_functions.sql.
// The backend checks here first (fast UI answers, route guards); the database
// functions check again, so skipping this layer never grants anything.
// tests/integration/permissions.test.ts asserts both matrices are identical.

export type Role = 'owner' | 'admin' | 'agent';

const AGENT = ['view', 'reply', 'note', 'takeover', 'set_copilot', 'approve_draft', 'assign_self', 'tag', 'tickets',
  'request_ai_assist', 'view_orders'] as const;
const ADMIN_EXTRA = ['resume_ai', 'assign_any', 'global_ai', 'emergency_stop', 'knowledge_review', 'settings', 'prompts',
  'canned_manage', 'export_customer', 'reconcile_send', 'order_approve', 'clear_hold', 'view_audit', 'view_metrics',
  'history_import'] as const;
const OWNER_EXTRA = ['delete_customer', 'manage_staff'] as const;

export type Capability = (typeof AGENT)[number] | (typeof ADMIN_EXTRA)[number] | (typeof OWNER_EXTRA)[number];

export function capabilitiesFor(role: Role, opts: { agentsCanResumeAi?: boolean } = {}): Capability[] {
  switch (role) {
    case 'agent': return [...AGENT, ...(opts.agentsCanResumeAi ? (['resume_ai'] as const) : [])];
    case 'admin': return [...AGENT, ...ADMIN_EXTRA];
    case 'owner': return [...AGENT, ...ADMIN_EXTRA, ...OWNER_EXTRA];
    default: return [];
  }
}

export function can(role: Role, cap: Capability, opts: { agentsCanResumeAi?: boolean } = {}) {
  return capabilitiesFor(role, opts).includes(cap);
}
