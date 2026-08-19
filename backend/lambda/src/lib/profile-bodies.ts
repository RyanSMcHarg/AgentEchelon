/**
 * Profile BODIES in S3, keyed by `configId` (SPEC-PORTABLE-PROFILES, "Where it lives").
 *
 * WHY THIS EXISTS. A profile version's definition is one SSM parameter, and SSM's Standard tier caps a
 * value at 4096 characters for the WHOLE serialized definition. The persona rides inside that definition
 * (`active-profile.ts` `ProfileDefinitionBody.persona`) while `MAX_PERSONA_LENGTH` allows 20000, so the
 * schema permits a persona that cannot be stored: it passes validation and then fails at `PutParameter`
 * with an opaque AWS `ValidationException`. `profile-lifecycle.ts` carries a storage-boundary check whose
 * only job is to turn that into a readable message - a workaround for the missing indirection, not a fix.
 *
 * The spec's answer, and the one implemented here: the large bodies live in S3 and the definition stores
 * a POINTER. That restores the documented persona limit and takes body size off the definition's budget.
 *
 * CONTENT-ADDRESSED, THEREFORE IMMUTABLE. The key carries the `configId`, which is the hash of the
 * version's body. A given configId always names the same bytes, so:
 *   - re-writing a version is idempotent (same key, same content),
 *   - activating or rolling back never rewrites a body - it re-points at one that already exists,
 *   - two versions that differ only outside the body share nothing and collide never.
 * Nothing here ever deletes: an older version's body must survive for rollback to mean anything.
 *
 * WHAT THIS IS NOT. This is the PROFILE path. The per-deployment parameters
 * (`${SSM_ROOT}/assistant/{classification}/assistant-intent-pack` and `...-system-prompt`) are a separate,
 * older mechanism read by `intent-pack.ts`, and they are NOT moved here. Conflating the two is what makes
 * the size problem look already-solved when only one path solves it.
 *
 * BOUNDARY. Writing is exclusive to the manage-profiles role, the same rule the SSM namespace already
 * follows (SPEC-PORTABLE 7): a definition and its body are one artifact, so a second writer to either is
 * a second source of truth. Readers (the handler and async processor) get GetObject on the prefix only.
 */
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { ProfileDefinition } from './active-profile.js';

/** The body fields large enough to warrant indirection. Both are prose/JSON authored per version. */
export type ProfileBodyField = 'persona' | 'intentPack';

/** Where a body lives. Stored in the definition in place of the body itself. */
export interface ProfileBodyRef {
  /** S3 key. The bucket is the deployment's own attachments bucket, resolved at read time from the
   *  environment rather than stored - a stored bucket name would travel with an export and point a
   *  target instance at the SOURCE account's bucket, which the security model forbids. */
  key: string;
  /** The configId this body belongs to. Redundant with the key by construction, and kept so a reader can
   *  detect a definition whose pointer and configId disagree instead of silently serving the wrong body. */
  configId: string;
}

const PREFIX = 'profiles';

/**
 * The key for one body. `profiles/{profileName}/{configId}/{field}`.
 *
 * `profileName` is in the path so a bucket listing is readable by a human and so a per-profile prefix
 * grant is expressible; `configId` makes it immutable. Neither is trusted input: both are validated by
 * the caller's write path before they reach here.
 */
export function bodyKey(profileName: string, configId: string, field: ProfileBodyField): string {
  return `${PREFIX}/${profileName}/${configId}/${field}`;
}

/** The bucket bodies live in, from the environment. Absent ⇒ this deployment has no body store wired. */
export function bodyBucket(): string | undefined {
  return process.env.PROFILE_BODY_BUCKET || process.env.CONTEXT_BUCKET || undefined;
}

/**
 * Write a body. Idempotent by construction: the key contains the content hash, so re-writing a version
 * writes identical bytes to the same key.
 *
 * Throws when no bucket is configured. That is deliberate rather than a silent skip: a write path that
 * quietly kept the body inline would reintroduce the 4096 ceiling the pointer exists to remove, and the
 * failure would surface much later as an unstorable definition.
 */
export async function putBody(
  profileName: string,
  configId: string,
  field: ProfileBodyField,
  value: string,
  deps?: { s3?: S3Client; bucket?: string },
): Promise<ProfileBodyRef> {
  const bucket = deps?.bucket ?? bodyBucket();
  if (!bucket) {
    throw new Error(
      `[ProfileBodies] no body bucket configured (PROFILE_BODY_BUCKET/CONTEXT_BUCKET); cannot store the `
      + `${field} for ${profileName}. Storing it inline would re-impose the 4096-character definition cap.`,
    );
  }
  const key = bodyKey(profileName, configId, field);
  const s3 = deps?.s3 ?? new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: value,
    ContentType: field === 'intentPack' ? 'application/json' : 'text/plain; charset=utf-8',
  }));
  return { key, configId };
}

/**
 * Read a body. Returns `undefined` when the object is absent, so a caller can fall back to an inline
 * body on a definition written before this indirection existed.
 *
 * A MISMATCHED POINTER IS AN ERROR, NOT A FALLBACK. If the ref's `configId` does not match the version
 * being resolved, the definition and its body disagree and serving either one is wrong - the assistant
 * would answer with a persona from a different version while reporting this version's id.
 */
export async function getBody(
  ref: ProfileBodyRef,
  expectedConfigId: string,
  deps?: { s3?: S3Client; bucket?: string },
): Promise<string | undefined> {
  if (ref.configId !== expectedConfigId) {
    throw new Error(
      `[ProfileBodies] pointer/configId mismatch: body ref is for ${ref.configId}, resolving ${expectedConfigId}. `
      + `Refusing to serve a body from a different version.`,
    );
  }
  const bucket = deps?.bucket ?? bodyBucket();
  if (!bucket) return undefined;
  const s3 = deps?.s3 ?? new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: ref.key }));
    const body = await resp.Body?.transformToString();
    return body ?? undefined;
  } catch (err: any) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return undefined;
    throw err;
  }
}

export interface BodyStoreDeps {
  s3?: S3Client;
  bucket?: string;
}

/**
 * The STORED form of a definition: bodies moved out to S3, replaced by pointers.
 *
 * WHERE IT SITS IN THE SEQUENCE. `configId` is the hash of the behavioral body INCLUDING the persona,
 * and the S3 key contains the configId - so the order is hash -> configId -> put -> store the ref, and
 * `buildDefinition` must already have run. That ordering is also what makes the id stable: a persona
 * has the SAME configId whether it is stored inline or in S3, so this is purely a storage decision and
 * never a behavioral or attribution one. Per-turn config attribution cannot tell the two apart, which
 * is the property that lets an existing deployment migrate without splitting its analytics.
 *
 * NO BUCKET ⇒ INLINE, deliberately. A deployment with no body store is exactly the pre-indirection
 * deployment, and its persona keeps the definition's 4096-character budget with the storage-boundary
 * check still naming the profile and the field. That is a legible degradation, not the silent one
 * `putBody` refuses: this function DECIDES that offload applies, and once it does, a missing bucket is
 * fatal there rather than quietly re-imposing the cap.
 */
export async function offloadBodies(def: ProfileDefinition, deps?: BodyStoreDeps): Promise<ProfileDefinition> {
  const bucket = deps?.bucket ?? bodyBucket();
  if (!bucket || !def.persona) return def;
  const personaRef = await putBody(def.profileName, def.configId, 'persona', def.persona, { ...deps, bucket });
  const { persona: _moved, ...rest } = def;
  return { ...rest, personaRef };
}

/**
 * The RESOLVED form: pointers followed, bodies inline again. The inverse of {@link offloadBodies}, and
 * the first thing any reader of a stored definition must do.
 *
 * A DEFINITION WITH NO POINTER IS RETURNED UNTOUCHED, which is the whole back-compat story: every
 * definition written before this indirection existed carries an inline persona, including the ones live
 * in a running deployment, and they keep resolving with no migration and no S3 call.
 *
 * A POINTER THAT DOES NOT RESOLVE IS AN ERROR, never an empty persona. The definition asserts the body
 * is in S3; if it is not, the assistant would answer as the generic default while reporting this
 * version's configId - a silently de-personalised profile that reads as healthy. Callers fail closed on
 * the throw (the runtime resolver to the compiled seed, the variant lookup to no variant).
 */
export async function hydrateBodies(def: ProfileDefinition, deps?: BodyStoreDeps): Promise<ProfileDefinition> {
  if (!def.personaRef || def.persona !== undefined) return def;
  const persona = await getBody(def.personaRef, def.configId, deps);
  if (persona === undefined) {
    throw new Error(
      `[ProfileBodies] '${def.profileName}' version ${def.configId} points at ${def.personaRef.key}, which `
      + `could not be read (absent object, or no body bucket configured on this deployment). Refusing to `
      + `resolve the version without the persona it declares.`,
    );
  }
  const { personaRef: _followed, ...rest } = def;
  return { ...rest, persona };
}
