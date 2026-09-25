import { getPool } from '@/lib/db';
import { json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = staffRoute({ cap: 'view_metrics' }, async ({ req }) => {
  const days = Math.min(Math.max(Number(req.nextUrl.searchParams.get('days') ?? 7), 1), 90);
  const r = await getPool().query(`SELECT app.metrics(now() - make_interval(days => $1), now()) AS m`, [days]);
  const daily = await getPool().query(
    `SELECT date_trunc('day', created_at) AS day, sum(cost_usd) AS cost_usd, count(*)::int AS calls
       FROM app.ai_usage WHERE created_at > now() - make_interval(days => $1) GROUP BY 1 ORDER BY 1`, [days]);
  return json({ metrics: r.rows[0].m, ai_daily: daily.rows });
});
