/**
 * Persist generation-out images to S3 and hand back the object key +
 * byte size the caller delivers as a message ATTACHMENT (rendered by the
 * frontend AttachmentDisplay as an `<img>` that fetches a fresh presigned
 * URL on demand, exactly like a generated document). A presigned GET is
 * also returned for callers that still want a direct URL. Used by both a
 * `/battle` generation-out turn and a normal `image_generation` turn
 * (SPEC-BATTLE.md §"Image Battles — Generation-Out", Phase 4C-ii).
 *
 * Honest contract (mirrors `parseImageGenResponse` / the no-fabrication
 * rule): `invokeImageGenModel` returning `images: []` — a generation
 * failure OR a guardrail block — persists NOTHING and returns an empty
 * list. We never write or serve a placeholder image; the caller renders
 * an honest "generation failed / withheld", not a broken `<img>`.
 *
 * Testability posture mirrors `attachment-bytes.ts` /
 * `image-gen-models.ts`: the PutObject client is a structural inject
 * (`S3PutClient`) and the presigner is an injectable function
 * (`PresignGet`) so unit tests need neither aws-sdk-client-mock nor
 * real SigV4 signing. The default presigner lazily builds one real
 * S3Client, reused across warm Lambdas.
 */
import { PutObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Minimal structural surface of `S3Client.send` the uploader needs. */
export interface S3PutClient {
  send(command: PutObjectCommand): Promise<unknown>;
}

/** Presign a GET for an already-uploaded object. Injectable so tests
 *  assert the (bucket,key,ttl) without standing up SigV4. */
export type PresignGet = (bucket: string, key: string, expiresIn: number) => Promise<string>;

export interface PersistImageGenOutputArgs {
  /** base64 PNGs from `invokeImageGenModel`. Empty ⇒ nothing persisted. */
  images: string[];
  bucket: string;
  /** Channel ARN or id; the last `/` segment namespaces the key prefix. */
  channelArn: string;
  /** Bedrock image model id — provenance, into the key and object metadata. */
  modelId: string;
  /** Presigned-GET TTL in seconds (default 3600). */
  urlTtlSeconds?: number;
  s3: S3PutClient;
  /** Override the presigner (tests). Default: real `getSignedUrl`. */
  presign?: PresignGet;
  /** Override the clock (tests) for deterministic keys. */
  now?: () => Date;
}

export interface PersistedImage {
  key: string;
  url: string;
  /** Decoded PNG byte length — feeds the delivered attachment's `size`. */
  size: number;
}

export interface PersistImageGenOutputResult {
  /** One entry per uploaded image; [] when there was nothing to persist. */
  persisted: PersistedImage[];
}

/**
 * Pure. Build the message CONTENT line for a generation-out turn. This is
 * a short human-readable lede only — the image itself is delivered as a
 * message ATTACHMENT (see buildImageGenAttachment), rendered by the
 * frontend AttachmentDisplay as an `<img>` that fetches a fresh presigned
 * URL on demand. No presigned URL is embedded in content (no giant URL,
 * no STS-token expiry). With images: a short "Generated ... with <model>."
 * line. With none: an honest failure/withheld line — the scorecard still
 * records responseMs/cost (imageCount 0), the user never sees a broken
 * `<img>` or a fabricated image.
 */
export function buildBattleImageContent(input: {
  persisted: PersistedImage[];
  modelId: string;
  displayName?: string;
  /** From invokeImageGenModel — distinguishes a content block from a plain failure. */
  guardrailIntervened: boolean;
}): string {
  const { persisted, modelId, displayName, guardrailIntervened } = input;
  if (persisted.length === 0) {
    return guardrailIntervened
      ? 'The generated image was withheld by the content filter.'
      : 'Image generation failed for this prompt; no image was produced.';
  }
  const label = displayName || modelId;
  return `Generated ${
    persisted.length === 1 ? 'an image' : `${persisted.length} images`
  } with ${label}.`;
}

/**
 * Pure. Build the message ATTACHMENT for a successful generation-out turn.
 * Shape mirrors a generated document (`{ fileKey, name, size, type }`) so
 * the same finalize/metadata path and the frontend AttachmentDisplay carry
 * the image: an `image/*` attachment renders as an `<img>` via
 * getDownloadUrl(fileKey, conversationId). Attaches the FIRST persisted
 * image (the required minimum). Returns `undefined` for the honest
 * no-image path (nothing persisted), so the caller attaches nothing.
 */
export function buildImageGenAttachment(input: {
  persisted: PersistedImage[];
  name?: string;
}): { fileKey: string; name: string; size: number; type: string } | undefined {
  const first = input.persisted[0];
  if (!first) return undefined;
  return {
    fileKey: first.key,
    name: input.name || 'generated-image.png',
    size: first.size,
    type: 'image/png',
  };
}

// Lazy real S3Client for the default presigner — constructed once,
// reused across warm Lambda invocations (mirrors image-gen-models).
let _s3: S3Client | undefined;
function defaultPresign(bucket: string, key: string, expiresIn: number): Promise<string> {
  if (!_s3) {
    _s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
  }
  return getSignedUrl(_s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
}

/**
 * Upload each generated PNG under
 * `battle-images/<channelId>/<iso-ts>-<idx>.png` (SSE-AES256, provenance
 * metadata) and presign a GET for it. Returns `{ persisted: [] }`
 * without any S3 call when `images` is empty (the honest no-image
 * path). `bucket` and `channelArn` are required.
 */
export async function persistImageGenOutput(
  args: PersistImageGenOutputArgs,
): Promise<PersistImageGenOutputResult> {
  const { images, bucket, channelArn, modelId, s3 } = args;
  if (!bucket || !channelArn) {
    throw new Error('persistImageGenOutput: bucket and channelArn are required');
  }

  // Honest no-image path: a generation failure or guardrail block
  // produced no bytes — persist nothing, never a placeholder.
  const pngs = (images ?? []).filter((b64) => typeof b64 === 'string' && b64.length > 0);
  if (pngs.length === 0) return { persisted: [] };

  const presign = args.presign ?? defaultPresign;
  const ttl = args.urlTtlSeconds ?? 3600;
  const channelId = channelArn.split('/').pop() || 'unknown';
  const ts = (args.now ? args.now() : new Date()).toISOString().replace(/[:.]/g, '-');

  const persisted: PersistedImage[] = [];
  for (let i = 0; i < pngs.length; i++) {
    const key = `battle-images/${channelId}/${ts}-${i}.png`;
    // Decode once: the same buffer is the PutObject body AND the byte size
    // the delivered attachment reports.
    const body = Buffer.from(pngs[i], 'base64');
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'image/png',
        ServerSideEncryption: 'AES256',
        Metadata: {
          channelArn,
          modelId,
          generatedAt: new Date().toISOString(),
        },
      }),
    );
    persisted.push({ key, url: await presign(bucket, key, ttl), size: body.length });
  }
  return { persisted };
}
