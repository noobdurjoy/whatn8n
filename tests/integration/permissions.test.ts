import { afterAll, describe, expect, it } from 'vitest';
import { closePool, one, setSetting } from './helpers';
import { capabilitiesFor } from '../../src/lib/permissions';

afterAll(async () => { await closePool(); });

describe('role capability matrix', () => {
  it('backend and database agree for every role', async () => {
    for (const resume of [false, true]) {
      await setSetting('agents_can_resume_ai', resume);
      for (const role of ['owner', 'admin', 'agent'] as const) {
        const db = (await one(`SELECT app.role_capabilities($1) AS c`, [role])).c as string[];
        expect([...db].sort(), `${role} resume=${resume}`).toEqual([...capabilitiesFor(role, { agentsCanResumeAi: resume })].sort());
      }
    }
    await setSetting('agents_can_resume_ai', false);
  });
});
