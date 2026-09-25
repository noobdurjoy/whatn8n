import { getPool } from '@/lib/db';
import { json, staffRoute } from '@/lib/http';

export const runtime = 'nodejs';

// Staff correction/deletion of a stored customer preference.
export const DELETE = staffRoute<{ id: string; memoryId: string }>({ cap: 'reply' }, async ({ staff, params }) => {
  await getPool().query(`UPDATE app.customer_memories SET deleted_at = now(), deleted_by = $3 WHERE id = $1 AND customer_id = $2`,
    [params.memoryId, params.id, staff.id]);
  await getPool().query(`SELECT app.audit('staff', $1, 'customer.memory_deleted', 'customer_memory', $2, '{}')`, [staff.id, params.memoryId]);
  return json({ ok: true });
});
