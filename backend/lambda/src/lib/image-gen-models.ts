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
 * `InvokeModel` call for ONE model (retry on throttle/quota only).
 * `invokeImageGenWithFallback` serves an image ROUTE: the primary, then
 * the route's fallback model once when the primary failed on the model
 * side (`isImageGenFallbackEligible`). A content refusal or an
 * input-validation error is final and is never routed to another model.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandInput,
} from '@aws-sdk/client-bedrock-runtime';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SecretUnavailable, readCachedSecret } from './secret-cache.js';
import { sessionClient } from './assistant-session.js';
import { imageModelsAllowedFor, type ImageGenModelKey } from '../../../lib/config/model-availability.js';

export type { ImageGenModelKey };

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
  /**
   * The ONLY region this Bedrock model is offered in, when it is not offered everywhere.
   *
   * Bedrock does not carry every model in every region, and an id invoked in the wrong one fails with
   * `ValidationException: The provided model identifier is invalid` — a message that reads exactly
   * like a typo and sent one investigation after another chasing the id instead of the region.
   * Declaring it here makes the registry self-describing: the invoker builds its client for the
   * model's region, so image generation works out of the box in ANY deploy region with no deployer
   * configuration. `IMAGE_GEN_REGION` remains an override for a deployer who has the model somewhere
   * else. Undefined ⇒ the model is available in the deploy region (the common case).
   *
   * Whatever is set here MUST also be reachable by the processor's IAM grant — the grants use an
   * `arn:aws:bedrock:*::foundation-model/...` region wildcard so a region-pinned model stays covered.
   * `image-gen-iam-parity.test.ts` holds the registry and that grant together.
   */
  region?: string;
  /** Hard caps the shaper clamps to (cost guard; tightened in 4D). */
  maxImages: number;
  maxDimension: number;
  /** What it is for: an image model serves only an intent that needs an image (`modelFits`). */
  output: 'image';
}

const IMAGE_GEN_MODEL_ENTRIES: Record<ImageGenModelKey, Omit<ImageGenModelDef, 'output'>> = {
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
  // us-west-2 ONLY: the Stability base generators are not offered in
  // us-east-1, where the only text-to-image model is Nova Canvas.
  stability_image_core: {
    key: 'stability_image_core',
    displayName: 'Stability Image Core (Bedrock)',
    bedrockModelId: 'stability.stable-image-core-v1:1',
    provider: 'stability',
    hosting: 'aws-bedrock',
    lifecycle: 'active',
    region: 'us-west-2',
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
    region: 'us-west-2',
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

/** The image registry, each entry carrying its purpose. Which classifications use one is their own selection. */
export const IMAGE_GEN_MODELS: Record<ImageGenModelKey, ImageGenModelDef> = Object.fromEntries(
  (Object.entries(IMAGE_GEN_MODEL_ENTRIES) as Array<[ImageGenModelKey, Omit<ImageGenModelDef, 'output'>]>)
    .map(([key, def]) => [key, { ...def, output: 'image' as const }]),
) as Record<ImageGenModelKey, ImageGenModelDef>;

/**
 * THE BEDROCK IMAGE MODELS A CLASSIFICATION IS GRANTED, as foundation-model ARNs, derived from the same
 * selection the write path and the resolver read (`models` on its registry entry). A classification allowed none gets no
 * image grant, no image guardrail and no image edge (`assistant-profile-stack.ts`).
 */
export function imageModelArnsForClassification(classification: string): Record<string, string> {
  return Object.fromEntries(Object.values(IMAGE_GEN_MODELS)
    .filter((m) => m.hosting === 'aws-bedrock' && imageModelsAllowedFor(classification).includes(m.key))
    .map((m) => [m.key, `arn:aws:bedrock:*::foundation-model/${m.bedrockModelId}`]));
}

/**
 * THE PROVIDER KEYS A CLASSIFICATION HOLDS: the `authEnvVar` of each image model hosted outside AWS that it
 * selects, and no other. The stack sets these as `IMAGE_GEN_KEY_FIELDS` on the processor, and the processor
 * reads only these fields of the shared key secret into its environment (`imageGenKeysFromSecret`).
 */
export function externalImageKeyFieldsFor(classification: string): string[] {
  return [...new Set(Object.values(IMAGE_GEN_MODELS)
    .filter((m) => m.hosting === 'external-http' && m.authEnvVar && imageModelsAllowedFor(classification).includes(m.key))
    .map((m) => m.authEnvVar as string))].sort();
}

/**
 * The fields of the parsed key secret this processor may read: those named in `fields` (the comma list the stack
 * sets as `IMAGE_GEN_KEY_FIELDS`), each a non-empty string. No list reads nothing, so a secret that holds every
 * provider's key puts only the selected providers' keys into a classification's environment.
 */
export function imageGenKeysFromSecret(parsed: Record<string, unknown>, fields: string | undefined): Record<string, string> {
  const allowed = new Set((fields ?? '').split(',').map((f) => f.trim()).filter(Boolean));
  return Object.fromEntries(Object.entries(parsed)
    .filter((e): e is [string, string] => allowed.has(e[0]) && typeof e[1] === 'string' && !!e[1]));
}

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
 * Every Bedrock image model's foundation-model ARN, for the processor role's `bedrock:InvokeModel`
 * grant. DERIVED from the registry rather than hand-listed in the stack, so adding a model cannot
 * leave it ungranted.
 *
 * That drift is not hypothetical: the grant used to name Titan Image and Nova Canvas only — both
 * LEGACY — while `DEFAULT_IMAGE_MODEL` had moved to Stability Image Core. The shipped default was
 * ungranted, so every image turn failed, and unit tests could not see it because the gap was between
 * the registry and a CDK policy that nothing compared it to.
 *
 * LEGACY entries are included deliberately: an existing profile may still be bound to one, and
 * revoking its permission would turn a working (if deprecated) configuration into an access error.
 *
 * The `:*:` region wildcard covers models Bedrock offers in only some regions — see `region` on the
 * definition. `external-http` providers are excluded: they authenticate with an API key over HTTPS
 * and are not IAM-reachable at all.
 */
export const BEDROCK_IMAGE_MODEL_ARNS: string[] = Object.values(IMAGE_GEN_MODELS)
  .filter((m) => m.hosting === 'aws-bedrock')
  .map((m) => `arn:aws:bedrock:*::foundation-model/${m.bedrockModelId}`);

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
   * *lowers* the effective maximum — `min(registry, cap)`. A cap above
   * the per-model registry hard cap is ignored (a deployer fat-finger
   * can never raise cost past the model's safe maximum). Absent ⇒
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
  // an out-of-range / above-registry cap can never raise the maximum).
  const effMaxImages = limitByCap(def.maxImages, opts.maxImagesCap, 1);
  const effMaxDim = limitByCap(def.maxDimension, opts.maxDimensionCap, 256);

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
 * Recognizes the four current shapes:
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
 * Returns [] on any unrecognized shape (caller treats empty as a
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
 * Phase-4D deployer cost cap. The effective maximum is the registry
 * hard cap, optionally *lowered* by a deployer cap. A missing/invalid
 * cap, or one ≥ the registry cap, leaves the registry cap intact (a
 * fat-fingered or hostile value can never raise cost); a cap below the
 * safe `floor` is pinned to the floor.
 */
function limitByCap(registry: number, cap: number | undefined, floor: number): number {
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
  /** Throttle/quota retry budget (default 2), for this one model. A route's fallback model is
   *  `invokeImageGenWithFallback`'s concern. */
  maxRetries?: number;
  /** Backoff base in ms (default 200 → 200ms, 800ms). Pass 0 in tests. */
  baseDelayMs?: number;
  /**
   * Hard per-attempt wall-clock cap (default 60_000ms). Image models
   * are slow by design; a *hung* one is the long-running cost vector —
   * with no SDK timeout it would burn Lambda billed-seconds up to the
   * caller's Lambda timeout. At this bound the call is aborted and
   * FAILS FAST: never retried on the same model (retrying a timeout only
   * spends more Lambda + Bedrock); a route with a fallback tries that
   * model once. Keep the route's total (primary plus fallback) under the
   * caller Lambda's timeout so the failure can still be delivered. Distinct
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

/**
 * The guardrail to apply for an image invocation IN A GIVEN REGION.
 *
 * **Guardrails are regional, and image models are not always local.** `stability_image_core` and
 * `stability_image_ultra` are offered only in `us-west-2`, so a `us-east-1` deployment invokes them
 * cross-region - while `BATTLE_IMAGE_GUARDRAIL_ID` names a guardrail in the DEPLOY region. Passing it
 * to a call made in another region fails with:
 *
 *   ValidationException: The guardrail identifier or version provided in the request does not exist.
 *
 * which reads exactly like a bad id and is why two investigations checked the id (it was fine, and so
 * was its version) before anyone checked the region. This is the same trap `region` on the model
 * definition already documents; the model pinning was fixed and the guardrail was left behind.
 *
 * `BATTLE_IMAGE_GUARDRAIL_BY_REGION` is a JSON map of region -> `{id, version}`, populated at deploy
 * for every region an active image model lives in. The legacy single-value env still applies, but only
 * for the DEPLOY region, which is the one it was always provisioned in.
 *
 * Returns undefined when no guardrail covers the region. The CALLER MUST NOT then invoke unguarded:
 * silently dropping content moderation is a safety regression that no test would notice.
 */
export function imageGuardrailFor(region: string): { id: string; version: string } | undefined {
  const raw = process.env.BATTLE_IMAGE_GUARDRAIL_BY_REGION;
  if (raw) {
    try {
      const map = JSON.parse(raw) as Record<string, { id?: string; version?: string }>;
      const hit = map[region];
      if (hit?.id && hit.version) return { id: hit.id, version: hit.version };
    } catch {
      // A malformed map must not read as "no guardrail configured anywhere" - fall through to the
      // single-value env, and let the caller's no-guardrail branch handle a genuine absence.
      console.warn('[image-gen] BATTLE_IMAGE_GUARDRAIL_BY_REGION is not valid JSON; ignoring it');
    }
  }
  const deployRegion = process.env.AWS_REGION || 'us-east-1';
  const id = process.env.BATTLE_IMAGE_GUARDRAIL_ID;
  const version = process.env.BATTLE_IMAGE_GUARDRAIL_VERSION;
  if (region === deployRegion && id && version) return { id, version };
  return undefined;
}

/**
 * The region to invoke a given image model in.
 *
 * Precedence, highest first:
 *   1. `IMAGE_GEN_REGION` — the deployer's explicit override, for an account that has the model
 *      somewhere other than where the registry says.
 *   2. `def.region` — the model's declared home, for a model Bedrock offers in ONE region only.
 *      This is what makes a us-west-2-only generator work from a us-east-1 deployment with no
 *      configuration at all.
 *   3. The Lambda's own region — the common case, where the model is offered locally.
 *
 * The override is checked FIRST on purpose: a deployer who sets it has information this registry does
 * not, and silently preferring a hardcoded region over their explicit setting would be unfixable
 * from the outside.
 */
export function imageGenRegionFor(def?: Pick<ImageGenModelDef, 'region'>): string {
  return process.env.IMAGE_GEN_REGION || def?.region || process.env.AWS_REGION || 'us-east-1';
}

// Lazy clients, keyed BY REGION and reused across warm Lambda invocations (mirrors
// async-processor-core / intent-classifier). Keyed rather than single because two profiles in one
// deployment can legitimately select models with different homes — a single cached client would
// serve whichever model ran first and send the other to the wrong endpoint.
const _clients = new Map<string, BedrockRuntimeClient>();
function defaultSendClient(def?: ImageGenModelDef): ImageGenSendClient {
  const region = imageGenRegionFor(def);
  let c = _clients.get(region);
  if (!c) {
    c = sessionClient(BedrockRuntimeClient, { region });
    _clients.set(region, c);
  }
  const client = c;
  return {
    send: (command: InvokeModelCommand, options?: { abortSignal?: AbortSignal }) =>
      client.send(command, options),
  };
}

/** Throttle/quota only — the sole class retried on the SAME model. */
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

/**
 * The failures that belong to the MODEL, not to the request: the model is unavailable or not
 * accessible to this account, the service failed, the model failed or did not answer in time, or
 * throttling outlasted the retry budget. An image route's fallback serves exactly these.
 *
 * Everything else is final, by name: a `ValidationException` (a malformed request, and also how
 * Bedrock reports a prompt its content filters blocked), a guardrail intervention (returned as a
 * result, not thrown), an external provider's 400/422 (its content-policy refusal), and the local
 * shaper's refusals (unknown model, empty prompt). Another model must never be asked to answer a
 * prompt the first one refused.
 */
const MODEL_SIDE_ERROR_NAMES: ReadonlySet<string> = new Set([
  'ResourceNotFoundException',
  'AccessDeniedException',
  'ModelNotReadyException',
  'ModelTimeoutException',
  'ModelErrorException',
  'ServiceUnavailableException',
  'InternalServerException',
  'ThrottlingException',
  'ServiceQuotaExceededException',
]);

/** Marks an error this module raises for a model-side failure (a timeout, a provider not configured). */
function modelSideError(message: string): Error {
  return Object.assign(new Error(message), { imageGenModelSide: true });
}

/** True when an image route may try its fallback model after this error (see {@link MODEL_SIDE_ERROR_NAMES}). */
export function isImageGenFallbackEligible(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { imageGenModelSide?: boolean }).imageGenModelSide) return true;
    const name = (e as { name?: string }).name || '';
    if (MODEL_SIDE_ERROR_NAMES.has(name)) return true;
    const code = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (code === 429 || (typeof code === 'number' && code >= 500)) return true;
  }
  return false;
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
 * model errors fail fast with no retry. This invokes ONE model; an
 * image route's fallback model is `invokeImageGenWithFallback`. A
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
 * `{ "FAL_KEY": "...", "OPENAI_API_KEY": "..." }`); each key named in
 * `IMAGE_GEN_KEY_FIELDS` (the selected providers') is copied to
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
          _secretsClient = sessionClient(SecretsManagerClient, {
            region: process.env.AWS_REGION || 'us-east-1',
          });
        }
        // Through the shared five-minute cache (`lib/secret-cache.ts`); an empty secret reads as nothing.
        const raw = await readCachedSecret({ secretId }, { secrets: _secretsClient }).catch((err) => {
          if (err instanceof SecretUnavailable && err.reason === 'empty') return '';
          throw err;
        });
        if (!raw) return;
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        // Only the selected providers' fields: the secret may hold every provider's key.
        for (const [k, v] of Object.entries(imageGenKeysFromSecret(parsed, process.env.IMAGE_GEN_KEY_FIELDS))) {
          if (process.env[k] == null) process.env[k] = v;
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
    throw modelSideError(
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
        const message = `invokeImageGenModel: ${def.provider} returned HTTP ${res.status}: ${text.slice(0, 500)}`;
        // 401/403/404 say the model is not accessible or not there; any other 4xx is about the request
        // itself (a 400/422 is how these providers refuse a prompt on content policy).
        throw [401, 403, 404].includes(res.status) ? modelSideError(message) : new Error(message);
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
        throw modelSideError(`invokeImageGenModel: timed out after ${requestTimeoutMs}ms`);
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

  const client = opts.client ?? defaultSendClient(def);
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
      // The long-running cost vector: abort and FAIL FAST with no retry
      // on this model, so a hung call cannot spend more Lambda/Bedrock.
      // A route with a fallback tries that model once.
      if (timedOut) {
        throw modelSideError(`invokeImageGenModel: timed out after ${requestTimeoutMs}ms`);
      }
      lastError = error;
      // Only throttle/quota is retried on this model; everything else
      // (access, validation, model error) fails fast. Which of those a
      // route's fallback serves is `isImageGenFallbackEligible`.
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

/** The result of an image ROUTE: the model that answered, and whether it was the route's fallback. */
export interface ImageGenRouteResult extends ImageGenInvokeResult {
  /** True when the primary failed on the model side and the fallback model produced this result. */
  wasFallback: boolean;
  /** The primary's failure, when the fallback answered in its place. */
  primaryError?: string;
}

/**
 * Serve an image ROUTE: the primary model, then the route's fallback model ONCE when the primary failed on
 * the model side ({@link isImageGenFallbackEligible}). The image counterpart of the text path's
 * `invokeBedrockWithFallback`.
 *
 * - A content refusal is final: a guardrail intervention or an empty result is returned as the answer,
 *   and a refusal thrown as a `ValidationException` or a provider's 400 is rethrown. Another model is
 *   never asked to answer a prompt the first one refused.
 * - `optionsFor` supplies each model's invoke options (its guardrail lives in that model's region), and is
 *   the one place a model's guardrail is resolved. It returns undefined when the model cannot be called
 *   safely (no guardrail in its region): for the primary the route is refused, naming that region, and
 *   nothing is generated; for the fallback the route ends on the primary's error rather than run unguarded.
 * - The fallback runs only in the time the caller has left: with `remainingMs` given, it is tried only when
 *   what remains covers its own timeout (`requestTimeoutMs`, default 60s) plus `replyMarginMs` to post the
 *   reply. Otherwise the route ends on the primary's error, and `onFallbackSkipped` names the reason.
 * - The result's `modelId` is the model that produced the image, so the turn records the right model.
 */
export async function invokeImageGenWithFallback(args: {
  primaryModelId: string;
  /** The route's fallback model id; absent or equal to the primary ⇒ the primary's outcome is final. */
  fallbackModelId?: string;
  prompt: string;
  optionsFor: (modelId: string) => ImageGenInvokeOptions | undefined;
  /** Called once when the fallback is about to run, for the turn's log. */
  onFallback?: (info: { primaryModelId: string; fallbackModelId: string; error: string }) => void;
  /** The caller's remaining time in ms (a Lambda's `getRemainingTimeInMillis`). Absent ⇒ no deadline is applied. */
  remainingMs?: () => number;
  /** Time kept back after the fallback for posting the reply (default 5000ms). */
  replyMarginMs?: number;
  /** Called when an eligible fallback is not tried, with the reason, for the turn's log. */
  onFallbackSkipped?: (info: { primaryModelId: string; fallbackModelId: string; error: string; reason: string }) => void;
  /** Injectable for tests; defaults to {@link invokeImageGenModel}. */
  invoke?: typeof invokeImageGenModel;
}): Promise<ImageGenRouteResult> {
  const invoke = args.invoke ?? invokeImageGenModel;
  const primaryOpts = args.optionsFor(args.primaryModelId);
  if (!primaryOpts) {
    const key = imageGenModelIdToKey(args.primaryModelId);
    throw new Error(`image generation blocked: no content guardrail available in ${imageGenRegionFor(key ? IMAGE_GEN_MODELS[key] : undefined)}`);
  }
  try {
    return { ...(await invoke(args.primaryModelId, args.prompt, primaryOpts)), wasFallback: false };
  } catch (error) {
    const fallback = args.fallbackModelId;
    if (!fallback || fallback === args.primaryModelId || !isImageGenFallbackEligible(error)) throw error;
    const fallbackOpts = args.optionsFor(fallback);
    if (!fallbackOpts) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (args.remainingMs) {
      const needed = (fallbackOpts.requestTimeoutMs ?? 60_000) + (args.replyMarginMs ?? 5_000);
      const left = args.remainingMs();
      if (left < needed) {
        args.onFallbackSkipped?.({
          primaryModelId: args.primaryModelId, fallbackModelId: fallback, error: message,
          reason: `${left}ms remain and the fallback needs ${needed}ms (its timeout plus the reply margin)`,
        });
        throw error;
      }
    }
    args.onFallback?.({ primaryModelId: args.primaryModelId, fallbackModelId: fallback, error: message });
    return { ...(await invoke(fallback, args.prompt, fallbackOpts)), wasFallback: true, primaryError: message };
  }
}
