// Setup check: confirms the configured OpenRouter models exist and support
// what the workflows need, using the official @openrouter/sdk.
//   OPENROUTER_API_KEY (optional for listings) CHAT_MODEL / VISION_MODEL env
//   or DATABASE_URL to read the configured models from app.settings.
// With --live and OPENROUTER_API_KEY it also sends one tiny text request and
// one tiny image request (a few hundredths of a cent) to prove it end to end.
import { OpenRouter } from '@openrouter/sdk';
import pg from 'pg';

let chat = process.env.CHAT_MODEL;
let vision = process.env.VISION_MODEL;
if ((!chat || !vision) && process.env.DATABASE_URL) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const m = (await c.query(`SELECT value FROM app.settings WHERE key = 'models'`)).rows[0]?.value ?? {};
  await c.end();
  chat ??= m.chat_model; vision ??= m.vision_model;
}
chat ??= 'deepseek/deepseek-v4.1-flash';
vision ??= 'stealth/space-bunny-alpha';

const sdk = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY || undefined });
let failed = false;
for (const [model, need] of [[chat, ['tools', 'response_format']], [vision, ['image', 'response_format']]]) {
  const [author, slug] = model.split('/');
  try {
    const r = await sdk.endpoints.list({ author, slug });
    const eps = r.data.endpoints ?? [];
    const inputs = r.data.architecture?.inputModalities ?? [];
    const params = new Set(eps.flatMap((e) => e.supportedParameters ?? []));
    const checks = need.map((n) => [n, n === 'image' ? inputs.includes('image') : params.has(n)]);
    const ok = eps.length > 0 && checks.every(([, v]) => v);
    failed ||= !ok;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${model}: ${eps.length} provider(s); input=${inputs.join(',')}; ` +
      checks.map(([n, v]) => `${n}=${v ? 'yes' : 'NO'}`).join(' ') +
      `; strict json_schema=${params.has('structured_outputs') ? 'yes' : 'no (use json_object + server validation)'}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${model}: ${e.statusCode === 404 ? 'not found' : e.message}`);
  }
}

if (process.argv.includes('--live')) {
  if (!process.env.OPENROUTER_API_KEY) { console.log('SKIP live test: OPENROUTER_API_KEY not set'); }
  else {
    // 1x1 PNG. The TypeScript SDK uses camelCase `imageUrl`; raw HTTP uses `image_url`.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const t0 = Date.now();
    const r = await sdk.chat.send({
      model: vision,
      maxTokens: 300,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Describe this image in one short sentence.' },
        { type: 'image_url', imageUrl: { url: png } },
      ] }],
    });
    console.log(`live vision (${vision}): ${Date.now() - t0} ms, id=${r.id}, usage=${JSON.stringify(r.usage ?? 'unavailable')}`);
  }
}
process.exit(failed ? 1 : 0);
