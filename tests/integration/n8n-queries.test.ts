// Every Postgres query used by the n8n workflow is planned (EXPLAIN) as the
// restricted wa_n8n role against the migrated schema. This catches syntax,
// type and permission errors (EXECUTE on functions, SELECT/UPDATE grants)
// before the workflow ever runs on the instance.
import { describe, expect, it } from 'vitest';
import { generate } from '../../n8n/workflow.mjs';
import { asN8nRole } from './helpers';

describe('n8n workflow SQL', async () => {
  const g: any = await generate();
  const queries: { section: string; node: string; sql: string; param: string | null }[] = [];
  for (const n of g.def.nodes) {
    if (n.type !== 'n8n-nodes-base.postgres') continue;
    const hasParam = Boolean(n.parameters.options && n.parameters.options.queryReplacement);
    queries.push({ section: n.section, node: n.name, sql: n.parameters.query, param: hasParam ? JSON.stringify(n.sample ?? {}) : null });
  }

  it('found the workflow queries', () => {
    expect(queries.length).toBeGreaterThan(45);
  });

  for (const q of queries) {
    it(`${q.section} / ${q.node}`, async () => {
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
