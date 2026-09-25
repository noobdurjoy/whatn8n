import { currentStaff } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { json } from '@/lib/http';
import { capabilitiesFor } from '@/lib/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = await currentStaff();
  if (!s) return json({ error: 'Not signed in' }, 401);
  const agentsCanResumeAi = (await getPool().query(`SELECT app.setting_bool('agents_can_resume_ai', false) AS v`)).rows[0].v;
  return json({
    id: s.id, email: s.email, display_name: s.display_name, role: s.role, csrf_token: s.csrf_token,
    capabilities: capabilitiesFor(s.role, { agentsCanResumeAi }),
  });
}
