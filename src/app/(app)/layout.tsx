import { redirect } from 'next/navigation';
import { currentStaff } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { capabilitiesFor } from '@/lib/permissions';
import { SessionProvider } from '@/components/session';
import { Shell } from '@/components/shell';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const staff = await currentStaff();
  if (!staff) redirect('/login');
  const agentsCanResumeAi = (await getPool().query(`SELECT app.setting_bool('agents_can_resume_ai', false) AS v`)).rows[0].v;
  const me = {
    id: staff.id, email: staff.email, display_name: staff.display_name, role: staff.role, csrf_token: staff.csrf_token,
    capabilities: capabilitiesFor(staff.role, { agentsCanResumeAi }) as string[],
  };
  return (
    <SessionProvider me={me}>
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}
