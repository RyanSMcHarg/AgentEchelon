/**
 * Provider-pluggable image-gen registry (ROADMAP P1.4).
 *
 * Covers the additions on top of the original Titan/Nova-only registry:
 *
 *   - lifecycle / hosting / authEnvVar fields on every registry entry
 *   - listImageGenModels() filtering
 *   - shapeImageGenRequest cases for `openai` and `fal` providers
 *   - parseImageGenResponse for OpenAI (data.b64_json) + FAL (images[].url)
 *   - invokeImageGenModel routing to the external-HTTP path with
 *     mocked global.fetch
 *   - "model requires $ENV_VAR" structured error when an external-HTTP
 *     model is invoked without its env var
 *   - Legacy-lockout error wrapping when a legacy Bedrock model returns
 *     NotFound/AccessDenied
 *
 * The original Titan/Nova back-compat is covered by image-gen-models.test.ts;
 * we don't re-test it here.
 */

import {
  IMAGE_GEN_MODELS,
  IMAGE_GEN_RATE_USD_PER_IMAGE,
  imageGenModelIdToKey,
  listImageGenModels,
  shapeImageGenRequest,
  parseImageGenResponse,
  invokeImageGenModel,
  type ImageGenSendClient,
} from '../../lambda/src/lib/image-gen-models';
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const TITAN = 'amazon.titan-image-generator-v2:0';
const NOVA = 'amazon.nova-canvas-v1:0';
const STABILITY_CORE = 'stability.stable-image-core-v1:1';
const OPENAI_GPT_IMAGE = 'gpt-image-1';
const FAL_FLUX = 'fal-ai/flux-pro/v1.1';

function enc(o: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(o));
}

describe('registry: lifecycle + hosting fields', () => {
  it('Titan + Nova are tagged legacy / aws-bedrock', () => {
    expect(IMAGE_GEN_MODELS.titan_image.lifecycle).toBe('legacy');
    expect(IMAGE_GEN_MODELS.titan_image.hosting).toBe('aws-bedrock');
    expect(IMAGE_GEN_MODELS.nova_canvas.lifecycle).toBe('legacy');
    expect(IMAGE_GEN_MODELS.nova_canvas.hosting).toBe('aws-bedrock');
  });

  it('Stability Bedrock entries are active / aws-bedrock', () => {
    expect(IMAGE_GEN_MODELS.stability_image_core.lifecycle).toBe('active');
    expect(IMAGE_GEN_MODELS.stability_image_core.hosting).toBe('aws-bedrock');
    expect(IMAGE_GEN_MODELS.stability_image_ultra.lifecycle).toBe('active');
  });

  it('OpenAI + FAL entries are active / external-http with their authEnvVar', () => {
    expect(IMAGE_GEN_MODELS.openai_gpt_image_1.lifecycle).toBe('active');
    expect(IMAGE_GEN_MODELS.openai_gpt_image_1.hosting).toBe('external-http');
    expect(IMAGE_GEN_MODELS.openai_gpt_image_1.authEnvVar).toBe('OPENAI_API_KEY');
    expect(IMAGE_GEN_MODELS.fal_flux_pro_1_1.lifecycle).toBe('active');
    expect(IMAGE_GEN_MODELS.fal_flux_pro_1_1.hosting).toBe('external-http');
    expect(IMAGE_GEN_MODELS.fal_flux_pro_1_1.authEnvVar).toBe('FAL_KEY');
  });

  it('every model has a per-image rate (parity with prior contract)', () => {
    for (const key of Object.keys(IMAGE_GEN_MODELS)) {
      expect(typeof IMAGE_GEN_RATE_USD_PER_IMAGE[key as keyof typeof IMAGE_GEN_RATE_USD_PER_IMAGE]).toBe('number');
    }
  });
});

describe('listImageGenModels', () => {
  it('returns active-only by default — legacy entries hidden', () => {
    const active = listImageGenModels();
    const keys = active.map((m) => m.key).sort();
    expect(keys).toEqual([
      'fal_flux_pro_1_1',
      'openai_gpt_image_1',
      'stability_image_core',
      'stability_image_ultra',
    ]);
    expect(keys).not.toContain('titan_image');
    expect(keys).not.toContain('nova_canvas');
  });

  it('returns every entry when includeLegacy:true', () => {
    const all = listImageGenModels({ includeLegacy: true });
    expect(all.length).toBe(Object.keys(IMAGE_GEN_MODELS).length);
    expect(all.map((m) => m.key)).toContain('titan_image');
    expect(all.map((m) => m.key)).toContain('nova_canvas');
  });
});

describe('shapeImageGenRequest: per-provider body shapes', () => {
  it('stability provider produces the unified text-to-image body', () => {
    const b = shapeImageGenRequest(STABILITY_CORE, 'a red bicycle') as Record<string, unknown>;
    expect(b.prompt).toBe('a red bicycle');
    expect(b.mode).toBe('text-to-image');
    expect(b.aspect_ratio).toBe('1:1');
    expect(b.output_format).toBe('png');
    // No taskType / textToImageParams / imageGenerationConfig — those
    // are Titan-family fields and must not leak into Stability bodies.
    expect(b.taskType).toBeUndefined();
    expect(b.textToImageParams).toBeUndefined();
    expect(b.imageGenerationConfig).toBeUndefined();
  });

  it('stability provider carries seed when supplied', () => {
    const b = shapeImageGenRequest(STABILITY_CORE, 'x', { seed: 42 }) as Record<string, unknown>;
    expect(b.seed).toBe(42);
  });

  it('openai provider produces the OpenAI Images API body shape', () => {
    const b = shapeImageGenRequest(OPENAI_GPT_IMAGE, 'a cat in a hat', {
      count: 1,
      size: 1024,
    }) as Record<string, unknown>;
    expect(b.model).toBe(OPENAI_GPT_IMAGE);
    expect(b.prompt).toBe('a cat in a hat');
    expect(b.n).toBe(1);
    expect(b.size).toBe('1024x1024');
    // gpt-image-1 returns base64 by default and REJECTS response_format
    // (a DALL-E-3 param) with HTTP 400, so we must NOT send it.
    expect(b.response_format).toBeUndefined();
  });

  it('fal provider maps to the discrete image_size enum (no pixel dims) + sync_mode', () => {
    const b = shapeImageGenRequest(FAL_FLUX, 'foo') as Record<string, unknown>;
    expect(b.prompt).toBe('foo');
    expect(b.image_size).toBe('square_hd');
    expect(b.num_images).toBe(1);
    // sync_mode:true forces an inline base64 data: URI (not a CDN URL) so
    // the base64-decoding persistence path receives real bytes; output_format
    // png matches the persistence path's .png key + image/png ContentType.
    expect(b.sync_mode).toBe(true);
    expect(b.output_format).toBe('png');
    // No `size: "1024x1024"` (that's OpenAI) and no `aspect_ratio` (that's Stability)
    expect(b.size).toBeUndefined();
    expect(b.aspect_ratio).toBeUndefined();
  });

  it('legacy Titan still produces the original TEXT_IMAGE body (back-compat)', () => {
    const b = shapeImageGenRequest(TITAN, 'still working') as Record<string, unknown>;
    expect(b.taskType).toBe('TEXT_IMAGE');
  });
});

describe('parseImageGenResponse: per-provider response shapes', () => {
  it('OpenAI: extracts b64_json from data[]', () => {
    const body = { data: [{ b64_json: 'aaaa' }, { b64_json: 'bbbb' }] };
    expect(parseImageGenResponse(body, 'openai')).toEqual(['aaaa', 'bbbb']);
  });

  it('OpenAI: drops entries with empty/missing b64_json', () => {
    const body = { data: [{ b64_json: 'aaaa' }, {}, { b64_json: '' }, { b64_json: null }] };
    expect(parseImageGenResponse(body, 'openai')).toEqual(['aaaa']);
  });

  it('FAL: strips data: prefix from url, returns raw base64', () => {
    const body = {
      images: [
        { url: 'data:image/png;base64,iVBORw0KGgo=' },
        { url: 'https://fal.run/cached/abc.png' },
      ],
    };
    // data: prefix → stripped to bare base64. https: URL passes through.
    expect(parseImageGenResponse(body, 'fal')).toEqual(['iVBORw0KGgo=', 'https://fal.run/cached/abc.png']);
  });

  it('FAL: drops entries with no url field', () => {
    const body = { images: [{ url: 'data:image/png;base64,xx' }, {}, { width: 1024 }] };
    expect(parseImageGenResponse(body, 'fal')).toEqual(['xx']);
  });

  it('Stability: drops images with non-SUCCESS finish_reason', () => {
    const body = {
      images: ['ok-img', 'filtered-img'],
      finish_reasons: ['SUCCESS', 'CONTENT_FILTERED'],
    };
    expect(parseImageGenResponse(body, 'stability')).toEqual(['ok-img']);
  });

  it('auto-detects shape when providerHint is absent', () => {
    // OpenAI shape detected by data[]
    expect(parseImageGenResponse({ data: [{ b64_json: 'oo' }] })).toEqual(['oo']);
    // FAL shape detected by images[] being objects
    expect(parseImageGenResponse({ images: [{ url: 'data:image/png;base64,fa' }] })).toEqual(['fa']);
    // Titan shape detected by images[] being strings
    expect(parseImageGenResponse({ images: ['tt'] })).toEqual(['tt']);
  });
});

describe('invokeImageGenModel: external-HTTP routing', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    delete process.env.OPENAI_API_KEY;
    delete process.env.FAL_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('OpenAI: refuses to invoke without OPENAI_API_KEY env var (actionable error)', async () => {
    await expect(
      invokeImageGenModel(OPENAI_GPT_IMAGE, 'x'),
    ).rejects.toThrow(/OPENAI_API_KEY env var/);
  });

  it('FAL: refuses to invoke without FAL_KEY env var (actionable error)', async () => {
    await expect(
      invokeImageGenModel(FAL_FLUX, 'x'),
    ).rejects.toThrow(/FAL_KEY env var/);
  });

  it('OpenAI: happy path — POSTs to api.openai.com with Bearer auth and returns base64', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-123';
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ b64_json: 'openai-base64' }] }),
      text: async () => '',
    } as unknown as Response));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await invokeImageGenModel(OPENAI_GPT_IMAGE, 'a cat');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchMock.mock.calls[0] as unknown as [string, unknown]);
    expect(url).toBe('https://api.openai.com/v1/images/generations');
    const initObj = init as unknown as { headers: Record<string, string>; body: string };
    expect(initObj.headers.Authorization).toBe('Bearer sk-test-123');
    expect(initObj.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(initObj.body);
    expect(body.model).toBe(OPENAI_GPT_IMAGE);
    expect(body.prompt).toBe('a cat');
    // gpt-image-1 rejects response_format (DALL-E-3 param); must not send it.
    expect(body.response_format).toBeUndefined();
    expect(result.images).toEqual(['openai-base64']);
    expect(result.modelId).toBe(OPENAI_GPT_IMAGE);
  });

  it('FAL: happy path — POSTs to fal.run/<model> with Key auth, parses images[].url', async () => {
    process.env.FAL_KEY = 'fal-test-key';
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        images: [{ url: 'data:image/png;base64,fal-base64' }],
      }),
      text: async () => '',
    } as unknown as Response));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await invokeImageGenModel(FAL_FLUX, 'a dog');

    const [url, init] = (fetchMock.mock.calls[0] as unknown as [string, unknown]);
    expect(url).toBe(`https://fal.run/${FAL_FLUX}`);
    const initObj = init as unknown as { headers: Record<string, string> };
    expect(initObj.headers.Authorization).toBe('Key fal-test-key');
    expect(result.images).toEqual(['fal-base64']);
  });

  it('OpenAI: 429 retries once then succeeds', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    let calls = 0;
    const fetchMock = jest.fn(async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          json: async () => ({}),
          text: async () => 'rate limited',
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ b64_json: 'ok' }] }),
        text: async () => '',
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await invokeImageGenModel(OPENAI_GPT_IMAGE, 'x', { baseDelayMs: 0 });
    expect(result.images).toEqual(['ok']);
    expect(result.retryCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('OpenAI: 4xx (non-429) fails fast — no retry', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const fetchMock = jest.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'bad prompt' } }),
      text: async () => '{"error":{"message":"bad prompt"}}',
    } as unknown as Response));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(invokeImageGenModel(OPENAI_GPT_IMAGE, 'x', { baseDelayMs: 0 })).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('invokeImageGenModel: legacy-lockout error wrapping', () => {
  function recordingClient(impl: () => Promise<{ body?: Uint8Array }>): {
    client: ImageGenSendClient;
    commands: InvokeModelCommand[];
  } {
    const commands: InvokeModelCommand[] = [];
    return {
      commands,
      client: {
        send: async (cmd) => {
          commands.push(cmd);
          return impl();
        },
      },
    };
  }

  it('legacy Titan + ResourceNotFoundException → wrapped error naming active alternatives', async () => {
    const err = Object.assign(new Error('Model not found'), { name: 'ResourceNotFoundException' });
    const { client } = recordingClient(async () => {
      throw err;
    });

    await expect(
      invokeImageGenModel(TITAN, 'x', { client, baseDelayMs: 0 }),
    ).rejects.toThrow(/LEGACY-locked/);
    await expect(
      invokeImageGenModel(TITAN, 'x', { client, baseDelayMs: 0 }),
    ).rejects.toThrow(/Switch to an active model/);
  });

  it('legacy Nova + AccessDeniedException → same wrapping', async () => {
    const err = Object.assign(new Error('No permission'), { name: 'AccessDeniedException' });
    const { client } = recordingClient(async () => {
      throw err;
    });

    await expect(
      invokeImageGenModel(NOVA, 'x', { client, baseDelayMs: 0 }),
    ).rejects.toThrow(/LEGACY-locked/);
  });

  it('active Stability + ResourceNotFoundException is NOT wrapped (it would mislead)', async () => {
    const err = Object.assign(new Error('Model not found in this region'), {
      name: 'ResourceNotFoundException',
    });
    const { client } = recordingClient(async () => {
      throw err;
    });

    // Should throw the raw error, NOT wrap as LEGACY-locked.
    await expect(
      invokeImageGenModel(STABILITY_CORE, 'x', { client, baseDelayMs: 0 }),
    ).rejects.toThrow(/Model not found in this region/);
    await expect(
      invokeImageGenModel(STABILITY_CORE, 'x', { client, baseDelayMs: 0 }),
    ).rejects.not.toThrow(/LEGACY-locked/);
  });

  it('active Stability + happy path still works (no regression)', async () => {
    const { client } = recordingClient(async () => ({
      body: enc({ images: ['ok-base64'], finish_reasons: ['SUCCESS'] }),
    }));

    const result = await invokeImageGenModel(STABILITY_CORE, 'x', { client });
    expect(result.images).toEqual(['ok-base64']);
  });
});
