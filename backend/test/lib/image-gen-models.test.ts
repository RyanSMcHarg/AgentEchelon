/**
 * image-gen-models unit tests (SPEC-BATTLE.md Generation-Out, Phase 4B).
 * Pure shaping — the load-bearing bits are the per-model caps clamp
 * (cost guard) and the honest empty-on-unrecognised parse.
 */
import {
  IMAGE_GEN_MODELS,
  IMAGE_GEN_RATE_USD_PER_IMAGE,
  imageGenModelIdToKey,
  shapeImageGenRequest,
  parseImageGenResponse,
  invokeImageGenModel,
  type ImageGenSendClient,
} from '../../lambda/src/lib/image-gen-models';
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const TITAN = 'amazon.titan-image-generator-v2:0';
const NOVA = 'amazon.nova-canvas-v1:0';

describe('imageGenModelIdToKey', () => {
  it('maps registered ids, null otherwise', () => {
    expect(imageGenModelIdToKey(TITAN)).toBe('titan_image');
    expect(imageGenModelIdToKey(NOVA)).toBe('nova_canvas');
    expect(imageGenModelIdToKey('anthropic.claude-opus-4-6-v1')).toBeNull();
    expect(imageGenModelIdToKey(undefined)).toBeNull();
  });

  it('every model has a per-image rate (parity)', () => {
    for (const key of Object.keys(IMAGE_GEN_MODELS)) {
      expect(typeof IMAGE_GEN_RATE_USD_PER_IMAGE[key as keyof typeof IMAGE_GEN_RATE_USD_PER_IMAGE]).toBe('number');
    }
  });
});

describe('shapeImageGenRequest', () => {
  it('produces the Titan/Nova TEXT_IMAGE body', () => {
    const b = shapeImageGenRequest(NOVA, '  a red bicycle  ') as Record<string, unknown>;
    expect(b.taskType).toBe('TEXT_IMAGE');
    expect((b.textToImageParams as { text: string }).text).toBe('a red bicycle'); // trimmed
    const cfg = b.imageGenerationConfig as Record<string, number>;
    expect(cfg.numberOfImages).toBe(1);
    expect(cfg.width).toBe(1024);
    expect(cfg.height).toBe(1024);
  });

  it('clamps count + dimension to the model caps and rounds dim to /64', () => {
    const b = shapeImageGenRequest(TITAN, 'x', { count: 9, size: 5000 }) as Record<string, unknown>;
    const cfg = b.imageGenerationConfig as Record<string, number>;
    expect(cfg.numberOfImages).toBe(1); // maxImages = 1
    expect(cfg.width).toBe(1024); // clamped to maxDimension
    const b2 = shapeImageGenRequest(TITAN, 'x', { size: 700 }) as Record<string, unknown>;
    expect((b2.imageGenerationConfig as Record<string, number>).width % 64).toBe(0); // /64
  });

  it('Phase-4D cap only LOWERS the registry ceiling, never raises it', () => {
    // maxDimension registry cap = 1024. A deployer cap of 512 lowers it.
    const lowered = shapeImageGenRequest(TITAN, 'x', { maxDimensionCap: 512 }) as Record<
      string,
      unknown
    >;
    expect((lowered.imageGenerationConfig as Record<string, number>).width).toBe(512);

    // A cap ABOVE the registry hard cap is ignored (cost can't rise).
    const ignored = shapeImageGenRequest(TITAN, 'x', {
      size: 4000,
      maxDimensionCap: 4096,
    }) as Record<string, unknown>;
    expect((ignored.imageGenerationConfig as Record<string, number>).width).toBe(1024);

    // A capped dimension still rounds to a /64 multiple.
    const rounded = shapeImageGenRequest(TITAN, 'x', { maxDimensionCap: 700 }) as Record<
      string,
      unknown
    >;
    expect((rounded.imageGenerationConfig as Record<string, number>).width % 64).toBe(0);

    // A below-floor / zero cap is pinned to the safe floor, not 0.
    const floored = shapeImageGenRequest(TITAN, 'x', {
      maxImagesCap: 0,
      maxDimensionCap: 0,
    }) as Record<string, unknown>;
    const fcfg = floored.imageGenerationConfig as Record<string, number>;
    expect(fcfg.numberOfImages).toBe(1); // floor 1
    expect(fcfg.width).toBe(256); // floor 256

    // Absent cap ⇒ registry behavior unchanged.
    const def = shapeImageGenRequest(NOVA, 'x') as Record<string, unknown>;
    expect((def.imageGenerationConfig as Record<string, number>).width).toBe(1024);
  });

  it('passes a seed through only when given', () => {
    const withSeed = shapeImageGenRequest(NOVA, 'x', { seed: 42 }) as Record<string, unknown>;
    expect((withSeed.imageGenerationConfig as Record<string, number>).seed).toBe(42);
    const noSeed = shapeImageGenRequest(NOVA, 'x') as Record<string, unknown>;
    expect('seed' in (noSeed.imageGenerationConfig as object)).toBe(false);
  });

  it('throws on an unknown model or empty prompt (fail fast/local)', () => {
    expect(() => shapeImageGenRequest('mystery.image', 'x')).toThrow(/unknown image model/);
    expect(() => shapeImageGenRequest(NOVA, '   ')).toThrow(/empty prompt/);
  });
});

describe('invokeImageGenModel', () => {
  const enc = (obj: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(obj));
  const namedError = (name: string): Error => {
    const e = new Error(name);
    e.name = name;
    return e;
  };

  // Records every command + drives the response so command.input is assertable.
  function recordingClient(
    impl: (call: number, opts?: { abortSignal?: AbortSignal }) => Promise<{ body?: Uint8Array }>,
  ): { client: ImageGenSendClient; commands: InvokeModelCommand[] } {
    const commands: InvokeModelCommand[] = [];
    const client: ImageGenSendClient = {
      send: (command: InvokeModelCommand, options?: { abortSignal?: AbortSignal }) => {
        commands.push(command);
        return impl(commands.length - 1, options);
      },
    };
    return { client, commands };
  }

  it('happy path: returns base64 images and sends the shaped body + guardrail params', async () => {
    const { client, commands } = recordingClient(async () => ({
      body: enc({ images: ['AAAA', 'BBBB'] }),
    }));

    const res = await invokeImageGenModel(NOVA, '  a red bicycle  ', {
      client,
      guardrailIdentifier: 'gr-1',
      guardrailVersion: '2',
    });

    expect(res).toEqual({
      images: ['AAAA', 'BBBB'],
      guardrailIntervened: false,
      retryCount: 0,
      modelId: NOVA,
    });
    expect(commands).toHaveLength(1);
    const input = commands[0].input;
    expect(input.modelId).toBe(NOVA);
    expect(input.guardrailIdentifier).toBe('gr-1');
    expect(input.guardrailVersion).toBe('2');
    expect(input.trace).toBe('ENABLED');
    const sentBody = JSON.parse(new TextDecoder().decode(input.body as Uint8Array));
    expect(sentBody.taskType).toBe('TEXT_IMAGE');
    expect(sentBody.textToImageParams.text).toBe('a red bicycle'); // shaper trimmed
  });

  it('guardrail intervened → images:[], guardrailIntervened:true', async () => {
    const { client } = recordingClient(async () => ({
      body: enc({ 'amazon-bedrock-guardrailAction': 'INTERVENED' }),
    }));
    const res = await invokeImageGenModel(TITAN, 'x', { client });
    expect(res.images).toEqual([]);
    expect(res.guardrailIntervened).toBe(true);
  });

  it('retries throttle once then succeeds → retryCount:1', async () => {
    const { client, commands } = recordingClient(async (call) => {
      if (call === 0) throw namedError('ThrottlingException');
      return { body: enc({ images: ['OK'] }) };
    });
    const res = await invokeImageGenModel(TITAN, 'x', { client, baseDelayMs: 0 });
    expect(res.images).toEqual(['OK']);
    expect(res.retryCount).toBe(1);
    expect(commands).toHaveLength(2);
  });

  it('AccessDeniedException fails fast — no retry, send called once', async () => {
    const { client, commands } = recordingClient(async () => {
      throw namedError('AccessDeniedException');
    });
    await expect(invokeImageGenModel(TITAN, 'x', { client, baseDelayMs: 0 })).rejects.toThrow(
      /AccessDeniedException/,
    );
    expect(commands).toHaveLength(1);
  });

  it('aborts a slow call at requestTimeoutMs and fails fast (no retry)', async () => {
    // Fake send hangs until the invoker's abort signal fires — the
    // long-running cost vector. It must be capped and NOT retried.
    const { client, commands } = recordingClient(
      (_call, opts) =>
        new Promise<{ body?: Uint8Array }>((_resolve, reject) => {
          opts?.abortSignal?.addEventListener('abort', () =>
            reject(new Error('aborted-by-signal')),
          );
        }),
    );
    await expect(
      invokeImageGenModel(TITAN, 'x', { client, requestTimeoutMs: 5, baseDelayMs: 0 }),
    ).rejects.toThrow(/timed out after 5ms/);
    expect(commands).toHaveLength(1); // long-running vector is never retried
  });

  it('unknown model throws before any send (fail fast/local)', async () => {
    const { client, commands } = recordingClient(async () => ({ body: enc({ images: [] }) }));
    await expect(invokeImageGenModel('mystery.image', 'x', { client })).rejects.toThrow(
      /unknown image model/,
    );
    expect(commands).toHaveLength(0);
  });
});

describe('parseImageGenResponse', () => {
  it('extracts non-empty base64 strings', () => {
    expect(parseImageGenResponse({ images: ['aaaa', 'bbbb'] })).toEqual(['aaaa', 'bbbb']);
  });

  it('returns [] for any unrecognised / empty shape (honest, never fabricated)', () => {
    expect(parseImageGenResponse(null)).toEqual([]);
    expect(parseImageGenResponse({})).toEqual([]);
    expect(parseImageGenResponse({ images: 'nope' })).toEqual([]);
    expect(parseImageGenResponse({ images: ['', 123, null, 'ok'] })).toEqual(['ok']);
  });
});
