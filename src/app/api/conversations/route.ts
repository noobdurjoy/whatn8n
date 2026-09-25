import { staffRoute, json } from '@/lib/http';
import { listConversations } from '@/lib/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = staffRoute({ cap: 'view' }, async ({ req, staff }) => {
  const u = req.nextUrl.searchParams;
  const mode = u.get('mode');
  const status = u.get('status');
  const queue = u.get('queue');
  const rows = await listConversations(staff, {
    q: u.get('q') ?? undefined,
    mode: mode && ['AUTO', 'COPILOT', 'HUMAN'].includes(mode) ? mode : undefined,
    status: status && ['open', 'pending', 'resolved', 'closed'].includes(status) ? status : undefined,
    queue: queue && ['waiting', 'mine', 'unassigned', 'attention'].includes(queue) ? (queue as any) : undefined,
    tag: u.get('tag')?.slice(0, 40) ?? undefined,
    before: u.get('before') ?? undefined,
    limit: Number(u.get('limit') ?? 40),
  });
  return json({ conversations: rows });
});
