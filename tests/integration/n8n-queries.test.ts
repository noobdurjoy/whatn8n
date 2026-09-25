// Every Postgres query used by the n8n workflows is planned (EXPLAIN) as the
// restricted wa_n8n role against the migrated schema. This catches syntax,
// type and permission errors (EXECUTE on functions, SELECT/UPDATE grants)
// before a workflow ever runs on the instance.
import { describe, expect, it } from 'vitest';
import { generate, ORDER } from '../../n8n/workflows.mjs';
import { asN8nRole } from './helpers';

describe('n8n workflow SQL', async () => {
  const g = await generate();
  const queries: { wf: string; node: string; sql: string; param: string | null }[] = [];
  for (const k of ORDER) {
    for (const n of g[k].def.nodes) {
      if (n.type !== 'n8n-nodes-base.postgres') continue;
      const hasParam = Boolean(n.parameters.options && n.parameters.options.queryReplacement);
      queries.push({ wf: g[k].def.name, node: n.name, sql: n.parameters.query, param: hasParam ? JSON.stringify(n.sample ?? {}) : null });
    }
  }

  it('found the workflow queries', () => {
    expect(queries.length).toBeGreaterThan(35);
  });

  for (const q of queries) {
    it(`${q.wf} / ${q.node}`, async () => {
      await asN8nRole(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query({ text: 'EXPLAIN ' + q.sql, values: q.param === null ? [] : [q.param] });
        } finally {
          await c.query('ROLLBACK');
        }
      });
    });
  }
});
