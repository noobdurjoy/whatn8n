import { z } from 'zod';
import { getPool } from '@/lib/db';
import { HttpError, json, staffRoute } from '@/lib/http';
import { checkModel } from '@/lib/openrouter';
import { REQUIRES_OWNER, SETTINGS_SCHEMAS } from '@/lib/settings-schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = staffRoute({ cap: 'settings' }, async () => {
  const pool = getPool();
  const settings = (await pool.query(`SELECT key, value, version, updated_at FROM app.settings ORDER BY key`)).rows;
  const history = (await pool.query(
    `SELECT h.key, h.version, h.value, h.changed_at, su.display_name AS changed_by
       FROM app.settings_history h LEFT JOIN app.staff_users su ON su.id = h.changed_by
      ORDER BY h.changed_at DESC LIMIT 100`)).rows;
  return json({ settings, history, editable: Object.keys(SETTINGS_SCHEMAS), owner_only: [...REQUIRES_OWNER] });
});

export const PUT = staffRoute({ cap: 'settings', body: z.object({ key: z.string().max(60), value: z.unknown(), expected_version: z.number().int().optional() }) },
  async ({ staff, body }) => {
    const schema = SETTINGS_SCHEMAS[body.key];
    if (!schema) throw new HttpError(400, 'This setting cannot be edited here');
    if (REQUIRES_OWNER.has(body.key) && staff.role !== 'owner') throw new HttpError(403, 'Only the owner can change this setting');
    const parsed = schema.safeParse(body.value);
    if (!parsed.success) return json({ error: 'Invalid value', issues: parsed.error.issues.slice(0, 5) }, 400);

    // Model changes are verified against OpenRouter before they are saved.
    if (body.key === 'models') {
      const v = parsed.data as any;
      const checks = await Promise.all([
        checkModel(v.chat_model, { tools: true, responseFormat: true }),
        checkModel(v.vision_model, { image: true, responseFormat: true }),
        checkModel(v.summary_model, { responseFormat: true }),
      ]);
      const failed = checks.filter((c) => !c.ok);
      if (failed.length) return json({ error: 'Model check failed', checks }, 422);
    }

    const pool = getPool();
    const cur = (await pool.query(`SELECT version FROM app.settings WHERE key = $1`, [body.key])).rows[0];
    if (body.expected_version !== undefined && cur && cur.version !== body.expected_version) {
      throw new HttpError(409, 'Someone else changed this setting. Reload and try again.');
    }
    const version = (await pool.query(`SELECT app.put_setting($1, $2, $3) AS v`, [body.key, JSON.stringify(parsed.data), staff.id])).rows[0].v;
    await pool.query(`SELECT app.audit('staff', $1, 'settings.update', 'settings', $2, $3)`, [staff.id, body.key, { version }]);
    return json({ ok: true, version });
  });
