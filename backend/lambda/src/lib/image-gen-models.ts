/**
 * Image-generation model registry + request/response shaping
 * (SPEC-BATTLE.md §"Image Battles — Generation-Out", Phase 4B).
 *
 * Generation-out is a **net-new modality with zero precedent** in the
 * codebase. It is deliberately kept OUT of the central text model
 * catalog (`lib/config/model-strategy.ts`): image models have no classification
 * gating, no intent routing, no token rates, and use Bedrock
 * `InvokeModel` (not Converse). Threading them through `BackendModelKey`
 * would ripple into the resolver, classification selection, intent routing and
 * the rate-parity test for no benefit. This self-contained registry is
 * the single source for the image-gen battle.
 *
 * Provider-pluggable shaper (ROADMAP P1.4). Originally the
 * registry hard-coded the Titan TEXT_IMAGE schema because both Titan
 * Image Gen v2 and Amazon Nova Canvas share it. Both have since been
 * LEGACY-locked on Bedrock (AWS blocks the modelId for accounts that
 * haven't used it in 30 days; no self-serve unblock). Their entries
 * stay in the registry but are now marked `lifecycle: 'legacy'` so
 * admin UI can warn, and so the runtime can surface a clear "model
 * deprecated by AWS" error instead of a bare `ResourceNotFoundException`.
 *
 * Stability AI's modern text-to-image models (`stable-image-core`,
 * `stable-image-ultra`, `sd3-5-large`) are added as the ACTIVE
 * alternative. They speak a different request/response shape (the
 * unified Stability API: `{ prompt, mode, aspect_ratio, output_format,
 * seed }` → `{ images, seeds, finish_reasons }`) so the shaper +
 * parser dispatch on `provider`. Adding a new provider = adding two
 * shaping functions + registry entries; nothing else changes.
 *
 * Pure shaping is unit-tested; `invokeImageGenModel` adds the Bedrock
 * `InvokeModel` call (retry on throttle/quota only — no cross-model
 * fallback by design: the two models are a head-to-head, not a
 * fallback pair). S3 persistence + IAM wiring are later bricks.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandInput,
} from '@aws-sdk/client-bedrock-runtime';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

export type ImageGenModelKey =
  | 'titan_image'
  | 'nova_canvas'
  | 'stability_image_core'
  | 'stability_image_ultra'
  | 'openai_gpt_image_1'
  | 'fal_flux_pro_1_1';

/**
 * Wire-format family the model expects. Adding a new family = adding
 * one shaper + one parser case + (if hosting='external-http') one
 * invocation case; existing entries are unaffected.
 *
 *   `titan`     — Amazon Titan TEXT_IMAGE body, used by Titan Image Gen
 *                 and Amazon Nova Canvas. Response is `{ images:[...] }`.
 *   `stability` — Stability AI unified text-to-image API (used by
 *                 stable-image-core, stable-image-ultra, sd3-5-large
 *                 on Bedrock). Body `{ prompt, mode, aspect_ratio,
 *                 output_format, seed }`; response `{ images:[...],
 *                 seeds:[...], finish_reasons:[...] }`.
 *   `openai`    — OpenAI Images API (gpt-image-1, formerly DALL-E 3).
 *                 Body `{ model, prompt, n, size, response_format:
 *                 'b64_json' }`; response `{ data: [{ b64_json:'...' }] }`.
 *   `fal`       — FAL.ai inference API (FLUX 1.1 Pro and similar
 *                 open-weights models). Body `{ prompt,
 *                 image_size:'square_hd', num_images, seed }`;
 *                 response `{ images: [{ url:'data:image/png;base64,...' }] }`.
 */
export type ImageGenProvider = 'titan' | 'stability' | 'openai' | 'fal';

/**
 * Where the model is invoked from. Drives the invocation path inside
 * `invokeImageGenModel` (Bedrock SDK vs HTTP fetch with provider auth).
 *
 *   `aws-bedrock`   — Bedrock `InvokeModel` via SDK. IAM via the
 *                     Lambda execution role; no env-var secrets.
 *   `external-http` — Provider's own HTTP API. Auth from a provider-
 *                     specific key (`OPENAI_API_KEY`, `FAL_KEY`, etc.)
 *                     sourced PREFERABLY from a Secrets Manager secret
 *                     (IMAGE_GEN_KEYS_SECRET_ARN, a JSON object keyed by
 *                     env-var name — hydrated into process.env at runtime),
 *                     or directly from a Lambda env var. Absent both ⇒ the
 *                     model is treated as not-configured and the runtime
 *                     fails with an actionable "set $ENV_VAR to enable"
 *                     message instead of a generic auth error.
 */
export type ImageGenHosting = 'aws-bedrock' | 'external-http';

/**
 * Bedrock model lifecycle from a deployer's perspective. The registry
 * is the source of truth; the runtime uses it to give better error
 * messages when AWS blocks a deprecated model.
 *
 *   `active` — currently invokable; admin UI should list it.
 *   `legacy` — AWS may block this model for accounts without recent
 *              usage (no self-serve unblock). Listed so existing
 *              configs keep working, but admin UI should warn and
 *              prefer active alternatives.
 */
export type ImageGenLifecycle = 'active' | 'legacy';

export interface ImageGenModelDef {
  key: ImageGenModelKey;
  displayName: string;
  /**
   * The id the provider's API expects. Named `bedrockModelId` for
   * back-compat with the original Bedrock-only registry; for
   * `hosting: 'external-http'` entries this is the model id sent in
   * the HTTP request body (e.g. `gpt-image-1` for OpenAI,
   * `fal-ai/flux-pro/v1.1` for FAL).
   */
  bedrockModelId: string;
  provider: ImageGenProvider;
  hosting: ImageGenHosting;
  lifecycle: ImageGenLifecycle;
  /**
   * Env var the deployer sets to enable an `external-http` provider.
   * `aws-bedrock` entries leave this undefined (auth via IAM role).
   * Listed in the registry so the "not configured" error names the
   * exact variable to set.
   */
  authEnvVar?: string;
  /** Hard caps the shaper clamps to (cost guard; tightened in 4D). */
  maxImages: number;
  maxDimension: number;
}

export const IMAGE_GEN_MODELS: Record<ImageGenModelKey, ImageGenModelDef> = {
  titan_image: {
    key: 'titan_image',
    displayName: 'Amazon Titan Image G1 v2 (legacy)',
    bedrockModelId: 'amazon.titan-image-generator-v2:0',
    provider: 'titan',
    hosting: 'aws-bedrock',
    lifecycle: 'legacy',
    maxImages: 1,
    maxDimension: 1024,
  },
  nova_canvas: {
    key: 'nova_canvas',
    displayName: 'Amazon Nova Canvas (legacy)',
    bedrockModelId: 'amazon.nova-canvas-v1:0',
    provider: 'titan',
    hosting: 'aws-bedrock',
    lifecycle: 'legacy',
    maxImages: 1,
    maxDimension: 1024,
  },
  // Stability Image Core — currently-ACTIVE Bedrock model. The AWS-
  // native option for deployers who want everything in one cloud
  // (IAM auth, no external API keys, no egress).
  stability_image_core: {
    key: 'stability_image_core',
    displayName: 'Stability Image Core (Bedrock)',
    bedrockModelId: 'stability.stable-image-core-v1:1',
    provider: 'stability',
    hosting: 'aws-bedrock',
    lifecycle: 'active',
    maxImages: 1,
    // Stability's API takes an aspect_ratio rather than explicit pixel
    // dimensions; the registry's maxDimension is informational (used
    // by the cost-cap guard, surfaced in admin UI for parity with
    // Titan-family entries).
    maxDimension: 1024,
  },
  stability_image_ultra: {
    key: 'stability_image_ultra',
    displayName: 'Stability Image Ultra (Bedrock)',
    bedrockModelId: 'stability.stable-image-ultra-v1:1',
    provider: 'stability',
    hosting: 'aws-bedrock',
    lifecycle: 'active',
    maxImages: 1,
    maxDimension: 1024,
  },
  // OpenAI gpt-image-1 (formerly DALL-E 3). Best-in-breed for prompt
  // adherence and typography. External-HTTP — deployer sets
  // OPENAI_API_KEY on the Lambda to enable. AWS hosting is optional
  // per the OSS posture; this is a deployer choice, not a default.
  openai_gpt_image_1: {
    key: 'openai_gpt_image_1',
    displayName: 'OpenAI gpt-image-1',
    bedrockModelId: 'gpt-image-1',
    provider: 'openai',
    hosting: 'external-http',
    lifecycle: 'active',
    authEnvVar: 'OPENAI_API_KEY',
    maxImages: 1,
    maxDimension: 1024,
  },
  // FAL.ai FLUX 1.1 Pro. Best-in-breed open-weights model; FAL
  // inference is fast (<10s) and cheap. External-HTTP — deployer sets
  // FAL_KEY on the Lambda to enable.
  fal_flux_pro_1_1: {
    key: 'fal_flux_pro_1_1',
    displayName: 'Black Forest Labs FLUX 1.1 Pro (via FAL)',
    bedrockModelId: 'fal-ai/flux-pro/v1.1',
    provider: 'fal',
    hosting: 'external-http',
    lifecycle: 'active',
    authEnvVar: 'FAL_KEY',
    maxImages: 1,
    maxDimension: 1024,
  },
};

/** APPROXIMATE USD per generated image, keyed by model. Reasonable
 *  defaults a deployer reviews against current Bedrock pricing (same
 *  honesty contract as MODEL_RATE_TABLE — edit in one place). */
export const IMAGE_GEN_RATE_USD_PER_IMAGE: Record<ImageGenModelKey, number> = {
  titan_image: 0.01,
  nova_canvas: 0.04,
  stability_image_core: 0.04,
  stability_image_ultra: 0.08,
  // OpenAI gpt-image-1: $0.040 per standard 1024×1024 image at writing.
  // Deployer reviews against current openai.com/pricing.
  openai_gpt_image_1: 0.04,
  // FAL FLUX 1.1 Pro: ~$0.04 per image at FAL's pay-as-you-go rate.
  // Subscription / commit plans are cheaper.
  fal_flux_pro_1_1: 0.04,
};

/**
 * List models filtered by lifecycle. Default: `active` only. Use this
 * for the admin UI's "pick an image model" dropdown so deployers can't
 * silently bind a legacy model that AWS will block on first use.
 */
export function listImageGenModels(
  opts: { includeLegacy?: boolean } = {},
): ImageGenModelDef[] {
  const includeLegacy = opts.includeLegacy === true;
  return Object.values(IMAGE_GEN_MODELS).filter(
    (m) => includeLegacy || m.lifecycle === 'active',
  );
}

/** Resolve a Bedrock image model id to its registry key (or null). */
export function imageGenModelIdToKey(modelId: string | undefined | null): ImageGenModelKey | null {
  if (!modelId) return null;
  for (const def of Object.values(IMAGE_GEN_MODELS)) {
    if (def.bedrockModelId === modelId) return def.key;
  }
  return null;
}

export interface ImageGenRequestOptions {
  /** Number of images to generate. Clamped to the model's maxImages. */
  count?: number;
  /** Square dimension in px. Clamped to the model's maxDimension; rounded to /64. */
  size?: number;
  /** Deterministic seed (optional). */
  seed?: number;
  /**
   * Phase-4D deployer cost cap (per-battle count guard). Only ever
   * *lowers* the effective ceiling — `min(registry, cap)`. A cap above
   * the per-model registry hard cap is ignored (a deployer fat-finger
   * can never raise cost past the model's safe ceiling). Absent ⇒
   * registry behavior unchanged. The processor sources these from
   * `BATTLE_IMAGE_MAX_IMAGES` / `BATTLE_IMAGE_MAX_DIMENSION`.
   */
  maxImagesCap?: number;
  maxDimensionCap?: number;
}

/**
 * Pure. Shape the Bedrock `InvokeModel` body for an image-gen model.
 * Dispatches on the registry's `provider` field so a new provider can
 * be added by extending this switch alone (and the matching
 * `parseImageGenResponse` case). Per-model caps clamp count and size
 * uniformly across providers; the body shape itself differs.
 *
 * Throws on an unknown model id (caller must pass a registered one) and
 * on an empty prompt (Bedrock rejects it anyway — fail fast/local).
 */
export function shapeImageGenRequest(
  modelId: string,
  prompt: string,
  opts: ImageGenRequestOptions = {},
): Record<string, unknown> {
  const key = imageGenModelIdToKey(modelId);
  if (!key) throw new Error(`shapeImageGenRequest: unknown image model "${modelId}"`);
  const text = (prompt ?? '').trim();
  if (!text) throw new Error('shapeImageGenRequest: empty prompt');
  const def = IMAGE_GEN_MODELS[key];

  // Deployer cap only ever lowers the registry hard cap (cost-safety:
  // an out-of-range / above-registry cap can never raise the ceiling).
  const effMaxImages = capCeiling(def.maxImages, opts.maxImagesCap, 1);
  const effMaxDim = capCeiling(def.maxDimension, opts.maxDimensionCap, 256);

  const count = clampInt(opts.count ?? 1, 1, effMaxImages);
  // Bedrock image dims must be multiples of 64.
  const raw = clampInt(opts.size ?? effMaxDim, 256, effMaxDim);
  const dim = Math.max(256, Math.floor(raw / 64) * 64);

  switch (def.provider) {
    case 'titan':
      return {
        taskType: 'TEXT_IMAGE',
        textToImageParams: { text },
        imageGenerationConfig: {
          numberOfImages: count,
          width: dim,
          height: dim,
          cfgScale: 8.0,
          ...(opts.seed != null && { seed: opts.seed }),
        },
      };
    case 'stability':
      // Stability's unified API takes aspect_ratio + output_format
      // rather than explicit pixel dimensions. v0 hardcodes 1:1.
      return {
        prompt: text,
        mode: 'text-to-image',
        aspect_ratio: '1:1',
        output_format: 'png',
        ...(opts.seed != null && { seed: opts.seed }),
      };
    case 'openai':
      // OpenAI Images API. gpt-image-1 ALWAYS returns inline base64
      // (`data[].b64_json`) and REJECTS the `response_format` param that
      // DALL-E 3 used ("Unknown parameter: 'response_format'"), so we must
      // NOT send it. The base64 result feeds the persistence path
      // identically to the Bedrock providers. (`seed` is likewise not a
      // gpt-image-1 param; omit it.)
      return {
        model: def.bedrockModelId,
        prompt: text,
        n: count,
        size: `${dim}x${dim}`,
      };
    case 'fal':
      // FAL.ai inference API. Uses a discrete image_size enum rather
      // than pixel dims; map our 1024 default to 'square_hd'.
      // sync_mode:true makes FAL return the image inline as a base64
      // `data:` URI instead of a CDN URL — required because the
      // persistence path base64-decodes the result (image-gen-output.ts);
      // a passed-through https URL would be decoded as garbage bytes. The
      // parser strips the `data:` prefix to raw base64 (parseImageGenResponse).
      return {
        prompt: text,
        image_size: 'square_hd',
        num_images: count,
        sync_mode: true,
        // FLUX defaults to JPEG; force PNG so the bytes match the
        // persistence path's .png key + image/png ContentType.
        output_format: 'png',
        ...(opts.seed != null && { seed: opts.seed }),
      };
    default: {
      // Exhaustiveness check — adding a new provider to the union
      // without handling it here fails the build.
      const _exhaustive: never = def.provider;
      throw new Error(`shapeImageGenRequest: unhandled provider "${_exhaustive}"`);
    }
  }
}

/**
 * Pure. Extract base64 PNG strings from an image-gen response.
 * Recognises the four current shapes:
 *
 *   - Titan family:    `{ images: ["base64", ...] }`
 *   - Stability family: `{ images: ["base64", ...], finish_reasons:
 *                          ["SUCCESS"|"CONTENT_FILTERED"|...] }` —
 *                       images with non-SUCCESS reasons dropped (honest
 *                       empty, not a censored image).
 *   - OpenAI:          `{ data: [{ b64_json: "..." }, ...] }`
 *   - FAL:             `{ images: [{ url: "data:image/png;base64,...",
 *                          ... }, ...] }` — the URL may be either an
 *                       inline data: URL or a hosted https: URL; we
 *                       strip the data: prefix and pass through.
 *
 * Returns [] on any unrecognised shape (caller treats empty as a
 * generation failure, never a fabricated image).
 *
 * For provider-specific behavior the caller can pass `providerHint`;
 * absent, the parser auto-detects from the response shape (sufficient
 * today because the four shapes are disjoint).
 */
export function parseImageGenResponse(
  body: unknown,
  providerHint?: ImageGenProvider,
): string[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as Record<string, unknown>;

  // OpenAI: { data: [{ b64_json }] }
  if (providerHint === 'openai' || Array.isArray(b.data)) {
    const data = b.data as Array<{ b64_json?: unknown }> | undefined;
    if (!Array.isArray(data)) return [];
    return data
      .map((d) => (typeof d?.b64_json === 'string' && d.b64_json.length > 0 ? d.b64_json : null))
      .filter((v): v is string => v !== null);
  }

  const images = b.images;
  if (!Array.isArray(images)) return [];

  // FAL: images is an array of { url, ... }
  if (providerHint === 'fal' || (images.length > 0 && typeof images[0] === 'object' && images[0] !== null)) {
    return images
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const url = (entry as { url?: unknown }).url;
        if (typeof url !== 'string' || url.length === 0) return null;
        // Strip a `data:image/png;base64,` prefix so the persistence
        // path receives the same raw base64 string regardless of
        // provider. Pass through unchanged if it's already a URL.
        const match = url.match(/^data:[^;]+;base64,(.+)$/);
        return match ? match[1] : url;
      })
      .filter((v): v is string => v !== null);
  }

  // Titan / Stability: images is an array of strings
  const validImages = images
    .map((i): string | null => (typeof i === 'string' && i.length > 0 ? i : null));

  const finishReasons = b.finish_reasons;
  if (Array.isArray(finishReasons)) {
    return validImages
      .map((img, idx) => {
        if (img === null) return null;
        const reason = finishReasons[idx];
        if (typeof reason === 'string' && reason !== 'SUCCESS') return null;
        return img;
      })
      .filter((img): img is string => img !== null);
  }

  return validImages.filter((img): img is string => img !== null);
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

/**
 * Phase-4D deployer cost cap. The effective ceiling is the registry
 * hard cap, optionally *lowered* by a deployer cap. A missing/invalid
 * cap, or one ≥ the registry cap, leaves the registry cap intact (a
 * fat-fingered or hostile value can never raise cost); a cap below the
 * safe `floor` is pinned to the floor.
 */
function capCeiling(registry: number, cap: number | undefined, floor: number): number {
  if (cap == null || !Number.isFinite(cap)) return registry;
  const c = Math.floor(cap);
  if (c < floor) return floor;
  return Math.min(registry, c);
}

// ============================================================
// Bedrock InvokeModel — image generation-out (Phase 4B-ii)
// ============================================================

/**
 * Minimal structural surface of `BedrockRuntimeClient.send` the invoker
 * needs. Injectable so tests pass a fake — the repo has no
 * aws-sdk-client-mock and we do not add one for this.
 * `InvokeModelCommandOutput` (whose `body` is a `Uint8Array`) is
 * assignable to this return shape.
 */
export interface ImageGenSendClient {
  send(
    command: InvokeModelCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<{ body?: Uint8Array }>;
}

export interface ImageGenInvokeOptions extends ImageGenRequestOptions {
  /**
   * Bedrock guardrail id. When set, `guardrailVersion` and
   * `trace: 'ENABLED'` are sent too (Bedrock requires the version
   * alongside the identifier; trace surfaces the guardrail action).
   */
  guardrailIdentifier?: string;
  guardrailVersion?: string;
  /** Throttle/quota retry budget (default 2). NO cross-model fallback. */
  maxRetries?: number;
  /** Backoff base in ms (default 200 → 200ms, 800ms). Pass 0 in tests. */
  baseDelayMs?: number;
  /**
   * Hard per-attempt wall-clock cap (default 60_000ms). Image models
   * are slow by design; a *hung* one is the long-running cost vector —
   * with no SDK timeout it would burn Lambda billed-seconds up to the
   * caller's Lambda timeout. At this bound the call is aborted and
   * FAILS FAST: never retried (retrying a timeout only spends more
   * Lambda + Bedrock) and never falls back. Keep it under the caller
   * Lambda's timeout so the failure can still be delivered. Distinct
   * from the per-image count/dimension caps (those cap spend per call;
   * this caps time).
   */
  requestTimeoutMs?: number;
  /** Injectable send() — defaults to a lazy module-level real client. */
  client?: ImageGenSendClient;
}

export interface ImageGenInvokeResult {
  /** base64 PNG strings. Honest [] on generation failure / guardrail block. */
  images: string[];
  /** True when a Bedrock guardrail INTERVENED on the prompt or image. */
  guardrailIntervened: boolean;
  /** Throttle/quota retries performed before the successful call. */
  retryCount: number;
  /** The Bedrock model id that produced this result. */
  modelId: string;
}

// Lazy module-level client — constructed once, reused across warm
// Lambda invocations (mirrors async-processor-core / intent-classifier).
let _client: BedrockRuntimeClient | undefined;
function defaultSendClient(): ImageGenSendClient {
  if (!_client) {
    // IMAGE_GEN_REGION lets a us-east-1 deployment reach the Stability base
    // generators that are only offered in us-west-2; falls back to the
    // Lambda's own region. (External-HTTP providers don't use this client.)
    _client = new BedrockRuntimeClient({
      region: process.env.IMAGE_GEN_REGION || process.env.AWS_REGION || 'us-east-1',
    });
  }
  const c = _client;
  return {
    send: (command: InvokeModelCommand, options?: { abortSignal?: AbortSignal }) =>
      c.send(command, options),
  };
}

/** Throttle/quota only — the sole retryable class (no fallback by design). */
function isThrottle(error: unknown): boolean {
  const name = (error as { name?: string })?.name || '';
  const code = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === 'ThrottlingException' || name === 'ServiceQuotaExceededException' || code === 429;
}

/**
 * AWS responses for legacy-locked image models. When a deployer's
 * account has been blocked on a deprecated model, Bedrock returns
 * either ResourceNotFoundException (model id unknown to the account)
 * or AccessDeniedException (no permission to invoke). Both translate
 * to the same deployer problem; both deserve a clearer error than the
 * raw SDK message.
 */
function isLegacyLockoutError(error: unknown): boolean {
  const name = (error as { name?: string })?.name || '';
  return name === 'ResourceNotFoundException' || name === 'AccessDeniedException';
}

/** Uint8Array JSON → object; {} on absent/undecodable body (never throws). */
function decodeImageGenBody(body: Uint8Array | undefined): Record<string, unknown> {
  if (!body) return {};
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Invoke a registered image-gen model via Bedrock `InvokeModel`.
 *
 * Fails fast/local on an unknown model or empty prompt (shaper throws
 * before any network call). Retries throttle/quota with exponential
 * backoff (200ms, 800ms; `maxRetries` default 2); access/validation/
 * model errors fail fast with no retry and — by locked design — no
 * cross-model fallback (the two image models are a head-to-head). A
 * slow/hung call is aborted at `requestTimeoutMs` (default 60s) and
 * also fails fast — the cost guard for the long-running vector. The
 * returned `images` is honest: [] on a generation failure or a
 * guardrail block, never a fabricated image.
 */
/**
 * Where each external-HTTP provider's request lands. Centralised so
 * the URL + auth-header shape can be unit-tested via mocked fetch
 * without spinning up network mocks.
 */
const EXTERNAL_HTTP_ENDPOINTS: Record<'openai' | 'fal', {
  url: (def: ImageGenModelDef) => string;
  authHeader: (apiKey: string) => Record<string, string>;
}> = {
  openai: {
    url: () => 'https://api.openai.com/v1/images/generations',
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  fal: {
    // FAL routes by model id in the path: e.g.
    // https://fal.run/fal-ai/flux-pro/v1.1
    url: (def) => `https://fal.run/${def.bedrockModelId}`,
    authHeader: (key) => ({ Authorization: `Key ${key}` }),
  },
};

/**
 * Invoke an external-HTTP image-gen model. Mirrors the Bedrock path's
 * retry-on-throttle behavior (one knob, default maxRetries=2) but uses
 * `fetch` directly with the provider's auth header.
 *
 * Auth is read from the registry's `authEnvVar` at call time. Absent
 * env var ⇒ structured error naming the variable the deployer needs
 * to set (so the operational fix is one line, not a docs hunt).
 */
/**
 * Hydrate external-provider API keys from Secrets Manager into
 * `process.env`, once per warm container. When `IMAGE_GEN_KEYS_SECRET_ARN`
 * is set, the secret is a JSON object keyed by env-var name (e.g.
 * `{ "FAL_KEY": "...", "OPENAI_API_KEY": "..." }`); each key is copied to
 * `process.env` ONLY if not already present, so a real env var still wins
 * and local/test overrides work. No-op (and never throws) when the secret
 * isn't configured — the caller then falls back to a plain env var and, if
 * that's also absent, surfaces the actionable "set $ENV_VAR" error.
 *
 * Keeping the keys in Secrets Manager (not a plaintext Lambda env var) is
 * the deployer-preferred posture: the value isn't visible in the Lambda
 * config and can be rotated without a redeploy.
 */
let _imageGenKeysHydrated: Promise<void> | undefined;
let _secretsClient: SecretsManagerClient | undefined;
async function hydrateImageGenKeysFromSecret(): Promise<void> {
  const secretId = process.env.IMAGE_GEN_KEYS_SECRET_ARN;
  if (!secretId) return;
  if (!_imageGenKeysHydrated) {
    _imageGenKeysHydrated = (async () => {
      try {
        if (!_secretsClient) {
          _secretsClient = new SecretsManagerClient({
            region: process.env.AWS_REGION || 'us-east-1',
          });
        }
        const out = await _secretsClient.send(
          new GetSecretValueCommand({ SecretId: secretId }),
        );
        const raw = out.SecretString;
        if (!raw) return;
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && v && process.env[k] == null) {
            process.env[k] = v;
          }
        }
      } catch (err) {
        // Best-effort: a fetch/parse failure must not mask the clear
        // "set $ENV_VAR to enable this provider" error the caller raises
        // when the key ends up absent. Reset so a later call can retry.
        _imageGenKeysHydrated = undefined;
        console.warn('[image-gen] failed to hydrate keys from Secrets Manager', {
          secretIdSuffix: secretId.slice(-12),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }
  return _imageGenKeysHydrated;
}

async function invokeExternalHttp(
  def: ImageGenModelDef,
  body: Record<string, unknown>,
  opts: ImageGenInvokeOptions,
): Promise<ImageGenInvokeResult> {
  if (def.provider !== 'openai' && def.provider !== 'fal') {
    throw new Error(
      `invokeImageGenModel: provider "${def.provider}" is registered as ` +
      `external-http but has no HTTP endpoint configured. This is a registry bug.`,
    );
  }

  // Pull keys from Secrets Manager (if configured) before reading env.
  await hydrateImageGenKeysFromSecret();
  const envVar = def.authEnvVar;
  const apiKey = envVar ? process.env[envVar] : undefined;
  if (!apiKey) {
    throw new Error(
      `invokeImageGenModel: model "${def.bedrockModelId}" requires the ` +
      `${envVar ?? '(unknown)'} env var on the Lambda. Set it to enable ` +
      `this provider, or pick a different active model from the registry.`,
    );
  }

  const endpoint = EXTERNAL_HTTP_ENDPOINTS[def.provider];
  const url = endpoint.url(def);

  const maxRetries = opts.maxRetries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;

  let retryCount = 0;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...endpoint.authHeader(apiKey),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        // 429 → throttle, retry. 5xx → retry. Everything else fails fast.
        if (res.status === 429 || res.status >= 500) {
          throw Object.assign(new Error(`HTTP ${res.status}`), {
            name: 'ThrottlingException',
            $metadata: { httpStatusCode: res.status },
          });
        }
        const text = await res.text().catch(() => '');
        throw new Error(
          `invokeImageGenModel: ${def.provider} returned HTTP ${res.status}: ${text.slice(0, 500)}`,
        );
      }

      const parsed = (await res.json()) as Record<string, unknown>;
      return {
        images: parseImageGenResponse(parsed, def.provider),
        // External providers don't carry the Bedrock guardrail marker;
        // a CONTENT_FILTERED-equivalent surfaces as an empty `images`
        // (honest empty, same contract as the Bedrock path).
        guardrailIntervened: false,
        retryCount,
        modelId: def.bedrockModelId,
      };
    } catch (error) {
      if (timedOut) {
        throw new Error(`invokeImageGenModel: timed out after ${requestTimeoutMs}ms`);
      }
      lastError = error;
      if (!isThrottle(error) || attempt >= maxRetries) {
        throw error;
      }
      retryCount = attempt + 1;
      const delay = baseDelayMs * Math.pow(4, attempt); // 200ms, 800ms
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export async function invokeImageGenModel(
  modelId: string,
  prompt: string,
  opts: ImageGenInvokeOptions = {},
): Promise<ImageGenInvokeResult> {
  // Throws on unknown model / empty prompt BEFORE the client is touched.
  const body = shapeImageGenRequest(modelId, prompt, opts);

  const key = imageGenModelIdToKey(modelId);
  const def = key ? IMAGE_GEN_MODELS[key] : undefined;
  if (!def) throw new Error(`invokeImageGenModel: unknown image model "${modelId}"`);

  // Route by hosting. External-HTTP providers use a different invoker
  // (fetch + provider-specific auth header) but return the same
  // ImageGenInvokeResult shape.
  if (def.hosting === 'external-http') {
    return invokeExternalHttp(def, body, opts);
  }

  const client = opts.client ?? defaultSendClient();
  const maxRetries = opts.maxRetries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;

  const commandInput: InvokeModelCommandInput = {
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
  if (opts.guardrailIdentifier) {
    commandInput.guardrailIdentifier = opts.guardrailIdentifier;
    commandInput.guardrailVersion = opts.guardrailVersion;
    commandInput.trace = 'ENABLED';
  }

  let retryCount = 0;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Fresh controller+timer per attempt. Because a timeout fails fast
    // (below), there is only ever ONE timed-out attempt, so total wall
    // clock stays ≈ requestTimeoutMs + throttle backoff — bounded under
    // the caller Lambda's timeout.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, requestTimeoutMs);
    try {
      const out = await client.send(new InvokeModelCommand(commandInput), {
        abortSignal: controller.signal,
      });
      const parsed = decodeImageGenBody(out.body);
      return {
        images: parseImageGenResponse(parsed, def.provider),
        guardrailIntervened: parsed['amazon-bedrock-guardrailAction'] === 'INTERVENED',
        retryCount,
        modelId,
      };
    } catch (error) {
      // The long-running cost vector: abort and FAIL FAST — no retry,
      // no fallback — so a hung call cannot spend more Lambda/Bedrock.
      if (timedOut) {
        throw new Error(`invokeImageGenModel: timed out after ${requestTimeoutMs}ms`);
      }
      lastError = error;
      // Only throttle/quota is retryable; everything else (access,
      // validation, model error) fails fast with no fallback.
      if (!isThrottle(error) || attempt >= maxRetries) {
        // ROADMAP P1.4: when a legacy model returns NotFound/AccessDenied,
        // wrap the SDK error with deployer-actionable context. AWS's
        // raw message just says "the specified model is not found" or
        // "you don't have permission" — neither hints that the cause
        // is a deprecation lockout, not a config typo.
        if (def?.lifecycle === 'legacy' && isLegacyLockoutError(error)) {
          const rawName = (error as { name?: string })?.name || 'UnknownError';
          const activeAlternatives = listImageGenModels()
            .map((m) => m.bedrockModelId)
            .join(', ');
          const wrapped = new Error(
            `invokeImageGenModel: Bedrock model "${modelId}" is LEGACY-locked for ` +
            `this AWS account (${rawName}). AWS blocks deprecated image models for ` +
            `accounts without recent usage, with no self-serve unblock. ` +
            `Switch to an active model: ${activeAlternatives || '(none configured)'}.`,
          );
          (wrapped as Error & { cause?: unknown }).cause = error;
          throw wrapped;
        }
        throw error;
      }
      retryCount = attempt + 1;
      const delay = baseDelayMs * Math.pow(4, attempt); // 200ms, 800ms
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}
