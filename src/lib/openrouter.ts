import { OpenRouter } from '@openrouter/sdk';

// Model verification through the official SDK (@openrouter/sdk). Used when
// the owner changes a model in the dashboard and by `npm run verify:models`.
// The API key is optional here: the model and endpoint listings are public.
// Chat/vision calls themselves are made by n8n (HTTP Request node).

export type ModelRequirements = { image?: boolean; tools?: boolean; structuredOutputs?: boolean; responseFormat?: boolean };

export type ModelCheck = {
  model: string;
  exists: boolean;
  input_modalities: string[];
  providers: Array<{ provider: string; params: string[] }>;
  meets: Record<string, boolean>;
  ok: boolean;
  error?: string;
};

let client: OpenRouter | null = null;
function sdk() {
  if (!client) {
    client = new OpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY || undefined,
      httpReferer: process.env.APP_ORIGIN,
      appTitle: 'WhatsApp Support Dashboard',
    } as any);
  }
  return client;
}

export async function checkModel(model: string, req: ModelRequirements): Promise<ModelCheck> {
  const m = model.match(/^([a-z0-9][\w.-]*)\/([\w.:-]+)$/i);
  if (!m) return { model, exists: false, input_modalities: [], providers: [], meets: {}, ok: false, error: 'invalid model id' };
  try {
    const res = await sdk().endpoints.list({ author: m[1], slug: m[2] });
    const data = res.data;
    const providers = (data.endpoints ?? []).map((e: any) => ({ provider: String(e.providerName), params: (e.supportedParameters ?? []).map(String) }));
    const any = (p: string) => providers.some((x) => x.params.includes(p));
    const inputs = (data.architecture?.inputModalities ?? []).map(String);
    const meets: Record<string, boolean> = {};
    if (req.image) meets.image_input = inputs.includes('image');
    if (req.tools) meets.tools = any('tools');
    if (req.structuredOutputs) meets.structured_outputs = any('structured_outputs');
    if (req.responseFormat) meets.response_format = any('response_format');
    return { model, exists: providers.length > 0, input_modalities: inputs, providers, meets,
             ok: providers.length > 0 && Object.values(meets).every(Boolean) };
  } catch (err) {
    const status = (err as any)?.statusCode;
    return { model, exists: false, input_modalities: [], providers: [], meets: {}, ok: false,
             error: status === 404 ? 'model not found' : `lookup failed: ${(err as Error).message?.slice(0, 200)}` };
  }
}
