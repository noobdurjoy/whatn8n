import { z } from 'zod';
import { withTx } from '@/lib/db';
import { HttpError, json, staffRoute, uuid } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Customer deletion (owner only). Removes conversations with their messages,
// attachments, drafts, AI jobs, summaries, notes and outbound records;
// customer memories, identities, account and order links; stored webhook
// payloads for those conversations; cached image analyses. The customer row
// is kept only as an anonymous tombstone so audit entries stay consistent.
// (No embeddings exist yet; when pgvector is added, delete them here too.)
export const DELETE = staffRoute<{ id: string }, any>({ cap: 'delete_customer', body: z.object({ confirm: z.literal('DELETE') }) },
  async ({ staff, params }) => {
    if (!uuid.safeParse(params.id).success) throw new HttpError(404, 'Not found');
    const summary = await withTx(async (c) => {
      const cu = (await c.query(`SELECT id FROM app.customers WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [params.id])).rows[0];
      if (!cu) throw new HttpError(404, 'Not found');
      const convs = (await c.query(`SELECT id, provider_conversation_id FROM app.conversations WHERE customer_id = $1`, [params.id])).rows;
      const providerIds = convs.map((x) => x.provider_conversation_id);
      const shas = (await c.query(
        `SELECT DISTINCT a.sha256 FROM app.attachments a JOIN app.messages m ON m.id = a.message_id
          JOIN app.conversations cv ON cv.id = m.conversation_id WHERE cv.customer_id = $1 AND a.sha256 IS NOT NULL`, [params.id])).rows.map((r) => r.sha256);
      const events = await c.query(
        `DELETE FROM app.webhook_events WHERE source = 'zernio' AND (payload -> 'message' ->> 'conversationId' = ANY ($1::text[])
            OR payload -> 'conversation' ->> 'id' = ANY ($1::text[]))`, [providerIds]);
      await c.query(`DELETE FROM app.image_analyses WHERE sha256 = ANY ($1::bytea[])`, [shas]);
      await c.query(`DELETE FROM app.conversations WHERE customer_id = $1`, [params.id]);
      await c.query(`DELETE FROM app.customer_memories WHERE customer_id = $1`, [params.id]);
      await c.query(`DELETE FROM app.customer_identities WHERE customer_id = $1`, [params.id]);
      await c.query(`DELETE FROM app.customer_account_links WHERE customer_id = $1`, [params.id]);
      await c.query(`DELETE FROM app.order_links WHERE customer_id = $1`, [params.id]);
      await c.query(`UPDATE app.customers SET display_name = NULL, phone_e164 = NULL, preferred_language = NULL,
                            marketing_consent = 'unknown', deleted_at = now() WHERE id = $1`, [params.id]);
      const s = { conversations: convs.length, webhook_events: events.rowCount, image_analyses: shas.length };
      await c.query(`INSERT INTO app.data_requests (customer_id, kind, requested_by, summary) VALUES ($1, 'delete', $2, $3)`, [params.id, staff.id, s]);
      await c.query(`SELECT app.audit('staff', $1, 'customer.delete', 'customer', $2, $3)`, [staff.id, params.id, s]);
      return s;
    });
    return json({ ok: true, deleted: summary, note: 'Backups keep older copies until they expire (see retention settings).' });
  });
