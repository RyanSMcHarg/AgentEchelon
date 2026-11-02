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
 * TWO KEY FAMILIES, ONE STORE. Profile-version bodies live under `profiles/{profileName}/{configId}/`.
 * A CLASSIFICATION's own intent pack (`${SSM_ROOT}/assistant/{classification}/assistant-intent-pack`)
 * lives under `classification-packs/{classification}/{contentId}/intentPack`, and its parameter holds a
 * pointer. The two families are separate because their owners are (tenet D15): a version body is
 * written by manage-profiles and read by any assistant handed that version, while a classification's
 * pack is written by that classification's deploy and read only by that classification's functions, so
 * its prefix names the classification and IAM scopes both verbs to it (D13). The per-deployment
 * persona parameter (`...-system-prompt`) is not on this store.
 *
 * BOUNDARY. Writing a version body is exclusive to the manage-profiles role, the same rule the SSM
 * namespace already follows (SPEC-PORTABLE 7): a definition and its body are one artifact, so a second
 * writer to either is a second source of truth. Readers (the handler and async processor) get GetObject
 * on the prefix only. Writing a classification pack is exclusive to that classification stack's
 * deploy-time writer, on its own prefix only.
 */
import { createHash } from 'crypto';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { ProfileDefinition } from './active-profile.js';
import type { StoredIntentPack } from './intent-pack.js';
import type { WorkflowLayout } from './workflow-layout.js';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { sessionClient } from './assistant-session.js';

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
 * quietly kept the body inline would reintroduce the 4096 limit the pointer exists to remove, and the
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
  return putBodyAt(key, configId, value, field === 'intentPack' ? 'application/json' : 'text/plain; charset=utf-8', { ...deps, bucket });
}

/** The one S3 write both key families go through. The caller has already resolved the bucket. */
async function putBodyAt(
  key: string,
  configId: string,
  value: string,
  contentType: string,
  deps: { s3?: S3Client; bucket: string },
): Promise<ProfileBodyRef> {
  const s3 = deps.s3 ?? sessionClient(S3Client, { region: process.env.AWS_REGION || 'us-east-1', requestHandler: BOUNDED_REQUEST_HANDLER });
  await s3.send(new PutObjectCommand({ Bucket: deps.bucket, Key: key, Body: value, ContentType: contentType }));
  return { key, configId };
}

/** The key family a classification's own intent pack lives in. Distinct from `profiles/` (see header). */
export const CLASSIFICATION_PACK_PREFIX = 'classification-packs';

/** A classification value as a key segment: no separator, no traversal, nothing IAM would match oddly. */
const CLASSIFICATION_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** The content id of a body: the SHA-256 of its UTF-8 bytes, hex. What a classification pack is keyed by. */
export function contentIdOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * The key for one classification's pack body: `classification-packs/{classification}/{contentId}/intentPack`.
 *
 * The classification is the second segment so an IAM resource can name one classification's prefix and
 * nothing else. The content id makes the key immutable, so a redeploy with a changed pack writes a new
 * object beside the old one rather than over it, and pointing the parameter back at an earlier id is a
 * rollback that still finds its bytes.
 */
export function classificationPackKey(classification: string, contentId: string): string {
  return `${classificationPackPrefix(classification)}${contentId}/intentPack`;
}

/** The prefix one classification's pack bodies sit under, for an IAM resource (`<bucketArn>/<prefix>*`). */
export function classificationPackPrefix(classification: string): string {
  if (!CLASSIFICATION_SEGMENT.test(classification)) {
    throw new Error(`[ProfileBodies] '${classification}' is not a classification value a pack key can carry.`);
  }
  return `${CLASSIFICATION_PACK_PREFIX}/${classification}/`;
}

/**
 * Write a classification's pack body and return the pointer its parameter stores. The caller writes the
 * pointer AFTER this resolves, so a parameter never points at a body that was not written.
 *
 * Throws with no bucket, for the reason `putBody` does: a pack too large for the parameter has nowhere
 * else to go.
 */
export async function putClassificationPack(
  classification: string,
  packJson: string,
  deps?: { s3?: S3Client; bucket?: string },
): Promise<ProfileBodyRef> {
  const bucket = deps?.bucket ?? bodyBucket();
  if (!bucket) {
    throw new Error(
      `[ProfileBodies] no body bucket configured (PROFILE_BODY_BUCKET/CONTEXT_BUCKET); cannot store the `
      + `intent pack of classification '${classification}'.`,
    );
  }
  const contentId = contentIdOf(packJson);
  return putBodyAt(classificationPackKey(classification, contentId), contentId, packJson, 'application/json', { ...deps, bucket });
}

/**
 * Read a classification's pack body through its pointer, and refuse anything that is not exactly the
 * body the pointer names.
 *
 * THREE REFUSALS, each a throw rather than a fallback to some other pack:
 *   - a pointer whose key is not this classification's key for that content id. IAM refuses a read of
 *     another classification's prefix as well; this is the layer that does not depend on a grant being
 *     scoped correctly (P4), and it names the problem instead of surfacing an AccessDenied.
 *   - a body that cannot be read (absent object, or no bucket on this deployment).
 *   - a body whose SHA-256 is not the pointer's content id. The key is content-addressed and never
 *     overwritten, so a mismatch is a store written by something other than the writer.
 */
export async function getClassificationPack(
  ref: ProfileBodyRef,
  classification: string,
  deps?: { s3?: S3Client; bucket?: string },
): Promise<string> {
  const expectedKey = classificationPackKey(classification, ref.configId);
  if (ref.key !== expectedKey) {
    throw new Error(
      `[ProfileBodies] the intent-pack pointer of classification '${classification}' names ${ref.key}, `
      + `not its own key ${expectedKey}. Refusing to read another classification's pack.`,
    );
  }
  const body = await getBody(ref, ref.configId, deps);
  if (body === undefined) {
    throw new Error(
      `[ProfileBodies] the intent pack of classification '${classification}' points at ${ref.key}, which could `
      + 'not be read (absent object, or no body bucket configured on this deployment).',
    );
  }
  const actual = contentIdOf(body);
  if (actual !== ref.configId) {
    throw new Error(
      `[ProfileBodies] the intent pack at ${ref.key} hashes to ${actual}, not the ${ref.configId} its key names. `
      + 'Refusing a body that is not the one the pointer was written for.',
    );
  }
  return body;
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
  const s3 = deps?.s3 ?? sessionClient(S3Client, { region: process.env.AWS_REGION || 'us-east-1', requestHandler: BOUNDED_REQUEST_HANDLER });
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: ref.key }));
    const body = await resp.Body?.transformToString();
    return body ?? undefined;
  } catch (err: any) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return undefined;
    throw err;
  }
}

/**
 * THE CANVAS LAYOUT'S KEY: `profiles/{profileName}/{configId}/layout/{contentId}` (ADR-061 decision 7).
 *
 * Under the version's configId like the persona, and under its own content id too, because the layout is not hashed
 * into `configId`: two layouts of one body are two objects, so a key is still written once and never overwritten, and
 * an older version's pointer still finds the positions it was saved with. The `profiles/` family is the one
 * manage-profiles already writes and reads, so the layout takes no grant of its own.
 */
export function layoutKey(profileName: string, configId: string, contentId: string): string {
  return `${PREFIX}/${profileName}/${configId}/layout/${contentId}`;
}

/** A layout as stored: workflow and step names in order, so one layout always serializes to one content id. */
export function canonicalLayout(layout: WorkflowLayout): string {
  const sorted = Object.fromEntries(Object.keys(layout).sort().map((wf) => [
    wf, Object.fromEntries(Object.keys(layout[wf]).sort().map((step) => [step, { x: layout[wf][step].x, y: layout[wf][step].y }])),
  ]));
  return JSON.stringify(sorted);
}

/**
 * READ A VERSION'S LAYOUT, for the console only: the runtime never calls this. Undefined when the version has none, or
 * when its pointer does not name this version's own layout key, or its body is absent, unreadable or not the bytes the
 * key's content id names. An unreadable layout is no layout, never an error: the canvas then places each step
 * automatically, and nothing a version does depends on where its steps are drawn.
 */
export async function readLayout(def: Pick<ProfileDefinition, 'profileName' | 'configId' | 'layoutRef'>, deps?: BodyStoreDeps): Promise<WorkflowLayout | undefined> {
  const ref = def.layoutRef;
  if (!ref) return undefined;
  const contentId = ref.key.split('/').pop() ?? '';
  if (ref.configId !== def.configId || ref.key !== layoutKey(def.profileName, def.configId, contentId)) {
    console.warn('[ProfileBodies] a layout pointer that is not this version\'s own is read as no layout', { profileName: def.profileName, configId: def.configId });
    return undefined;
  }
  try {
    const raw = await getBody(ref, def.configId, deps);
    if (raw === undefined || contentIdOf(raw) !== contentId) return undefined;
    return JSON.parse(raw) as WorkflowLayout;
  } catch (err) {
    console.warn('[ProfileBodies] a layout that could not be read is read as no layout', { profileName: def.profileName, err: (err as Error)?.name });
    return undefined;
  }
}

/** A definition with its layout read back inline (the console's draft and export reads), its pointer kept. */
export async function withLayout(def: ProfileDefinition, deps?: BodyStoreDeps): Promise<ProfileDefinition> {
  if (def.layout || !def.layoutRef) return def;
  const layout = await readLayout(def, deps);
  return layout ? { ...def, layout } : def;
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
  if (!bucket) {
    // WITH NO BODY STORE A LAYOUT IS NOT KEPT: it never goes inline, and the canvas places each step automatically.
    if (!def.layout) return def;
    const { layout: _dropped, ...rest } = def;
    return rest as ProfileDefinition;
  }
  let out = def;
  if (def.persona) {
    const personaRef = await putBody(def.profileName, def.configId, 'persona', def.persona, { ...deps, bucket });
    const { persona: _moved, ...rest } = out;
    out = { ...rest, personaRef };
  }
  // THE INTENT PACK IS A BODY TOO, for the same reason the persona is: it is content an operator writes
  // and it grows with what they have to say. Keeping it inline made the 4096-character parameter the
  // binding constraint on the taxonomy - which is how the platform intents ended up inherited-but-not-
  // editable, since restating one of them cost most of the remaining budget.
  //
  // The STRUCTURE still validates before it is offloaded: `validateDefinitionBody` reconciles
  // `models.byIntent` against the pack's keys on the inline value, and only then does this run. So the
  // transaction that needs both halves in hand still has them.
  if (def.intentPack) {
    const intentPackRef = await putBody(
      def.profileName, def.configId, 'intentPack', JSON.stringify(def.intentPack), { ...deps, bucket },
    );
    const { intentPack: _movedPack, ...rest } = out;
    out = { ...rest, intentPackRef };
  }
  // THE CANVAS LAYOUT IS A BODY TOO (ADR-061 decision 7), and never stays inline: written under this version's key with its
  // own content id, and the definition keeps the pointer. A definition handed in with a pointer and no layout keeps
  // the pointer it has.
  if (def.layout) {
    const { layout: _movedLayout, layoutRef: _previous, ...rest } = out;
    const body = canonicalLayout(def.layout);
    const layoutRef = await putBodyAt(layoutKey(def.profileName, def.configId, contentIdOf(body)), def.configId, body, 'application/json', { ...deps, bucket });
    out = { ...rest, layoutRef };
  }
  return out;
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
  const needsPersona = !!def.personaRef && def.persona === undefined;
  const needsPack = !!def.intentPackRef && def.intentPack === undefined;
  if (!needsPersona && !needsPack) return def;

  // FETCHED TOGETHER, not one after the other. This sits on the per-turn cold path (the profile cache
  // misses every 30 seconds, and on a cold container), so two serial S3 round trips would be two
  // round trips of added first-turn latency where one will do.
  const [persona, packRaw] = await Promise.all([
    needsPersona ? getBody(def.personaRef!, def.configId, deps) : Promise.resolve(undefined),
    needsPack ? getBody(def.intentPackRef!, def.configId, deps) : Promise.resolve(undefined),
  ]);

  let out = def;
  if (needsPersona) {
    if (persona === undefined) {
      throw new Error(
        `[ProfileBodies] '${def.profileName}' version ${def.configId} points at ${def.personaRef!.key}, which `
        + `could not be read (absent object, or no body bucket configured on this deployment). Refusing to `
        + `resolve the version without the persona it declares.`,
      );
    }
    const { personaRef: _followed, ...rest } = out;
    out = { ...rest, persona };
  }
  if (needsPack) {
    // Same fail-closed rule as the persona, and for a sharper reason: a version whose taxonomy could not
    // be read would classify every turn against the DEPLOYMENT pack while reporting this version's
    // configId. That is not a degraded answer, it is a turn attributed to a taxonomy that had no part in
    // it - the exact failure the pack was brought onto the version to end.
    if (packRaw === undefined) {
      throw new Error(
        `[ProfileBodies] '${def.profileName}' version ${def.configId} points at ${def.intentPackRef!.key}, `
        + `which could not be read (absent object, or no body bucket configured on this deployment). `
        + `Refusing to resolve the version without the intent pack it declares.`,
      );
    }
    let parsed: StoredIntentPack;
    try {
      parsed = JSON.parse(packRaw) as StoredIntentPack;
    } catch (err) {
      // A body that is not JSON is a corrupt store, not an operator typo: the write path serialized it.
      throw new Error(
        `[ProfileBodies] '${def.profileName}' version ${def.configId} has an intent-pack body at `
        + `${def.intentPackRef!.key} that is not valid JSON (${(err as Error).message}).`,
      );
    }
    const { intentPackRef: _followedPack, ...rest } = out;
    out = { ...rest, intentPack: parsed };
  }
  return out;
}
