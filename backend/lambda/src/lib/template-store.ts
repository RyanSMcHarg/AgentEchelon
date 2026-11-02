/**
 * WHERE DOCUMENT TEMPLATES LIVE, and how a version becomes the one in use (SPEC-DOCUMENT-TEMPLATES FR2, FR7).
 *
 * A template's body is stored at `templates/<classification>/<name>/<sha256>.md` in the deployment's
 * attachments bucket, the same store the classification's intent pack uses (`profile-bodies.ts`). The key
 * is content-addressed and written with `If-None-Match: *`, so a body is never overwritten: a changed
 * template is a new object beside the old one.
 *
 * WHICH VERSION IS IN USE is a pointer per name, an SSM parameter beside the classification's other
 * assistant parameters: `<ssmRoot>/assistant/<classification>/templates/<name>`, holding
 * `{ "active": "<sha256>", "history": ["<sha256>", ...] }`. Activation and rollback rewrite that pointer
 * and nothing else, so the next delivery follows it with no deploy and no write to a body.
 *
 * THE KEY NAMES ITS OWNER (tenets D13, D15). The classification is the second segment, so IAM scopes a
 * read to one classification's prefix: a turn role reads `templates/<own classification>/*` and its
 * pointers, and holds no write on either. Inside a classification each owner has its own family
 * (`TemplateOwner`, ADR-062 decision 2): the classification's templates directly under its prefix, an
 * assistant's own under `_assistants/<assistant>/`, the platform's shipped ones under `_shipped/`. The writers
 * are the operator's own credentials through `scripts/template.mjs`, the same operator-side path that seeds a
 * classification's pack; the deploy's writer of the platform's shipped document templates
 * (`lib/constructs/default-template-writer.ts`), scoped to the names it writes and create-only; and the
 * console's writer of an assistant's own family (`manage-message-templates.ts`). No turn role writes a
 * template. The reader's own key and hash checks are the second layer (tenet P4): a body is read only from
 * its own family's key and only when its bytes hash to the id the key names.
 */
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { sessionClient } from './assistant-session.js';
import { bodyBucket, contentIdOf } from './profile-bodies.js';
import {
  parseTemplate,
  TEMPLATE_NAME,
  type LoadedTemplate,
  type TemplateLoadFailure,
  type TurnTemplates,
} from './document-template.js';
import { templateRefsOfMachine, templateRefKey, type TaskStateMachine, type TemplateRef } from './task-state-machines.js';

/** The key family templates live in. */
export const TEMPLATES_PREFIX = 'templates';

/** How many earlier versions a pointer remembers for rollback. */
const MAX_HISTORY = 20;

/** How long a pointer read is reused within one container. A body is immutable and cached for good. */
export const TEMPLATE_POINTER_TTL_MS = 30_000;

const CLASSIFICATION_SEGMENT = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export class TemplateReferenceError extends Error {
  constructor(public readonly templateName: string, message: string) {
    super(`[TemplateStore] ${message}`);
    this.name = 'TemplateReferenceError';
  }
}

/** No version of the template is active in the family it was read from, so the next family in an order answers. */
export class TemplateNotActiveError extends TemplateReferenceError {
  constructor(templateName: string, message: string) {
    super(templateName, message);
    this.name = 'TemplateNotActiveError';
  }
}

export interface TemplateStoreDeps {
  s3?: Pick<S3Client, 'send'>;
  ssm?: Pick<SSMClient, 'send'>;
  bucket?: string;
  ssmRoot?: string;
  now?: () => number;
}

/** The prefix one classification's templates sit under, for an IAM resource (`<bucketArn>/<prefix>*`). */
export function templatePrefix(classification: string): string {
  if (!CLASSIFICATION_SEGMENT.test(classification)) {
    throw new TemplateReferenceError('', `'${classification}' is not a classification value a template key can carry.`);
  }
  return `${TEMPLATES_PREFIX}/${classification}/`;
}

/**
 * WHO A TEMPLATE BELONGS TO, and so the key family it is stored in (ADR-062 decision 2, tenet D15). The
 * classification's own templates sit directly under its prefix, as document templates always have; an
 * assistant's own under `_assistants/<assistant>/`; the platform's shipped ones under `_shipped/`. An
 * underscore cannot begin a template name (`TEMPLATE_NAME`), so no family's key collides with another's, and
 * each writer's grant is narrowed to its own family's prefix.
 */
export type TemplateOwner =
  | { family: 'classification' }
  | { family: 'shipped' }
  | { family: 'assistant'; assistant: string };

export const CLASSIFICATION_OWNER: TemplateOwner = { family: 'classification' };

/** An assistant name as the profile registry spells one, the segment its family is keyed by. */
export const ASSISTANT_SEGMENT = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The segment after the classification an owner's family adds: empty for the classification's own. */
export function ownerSegment(owner: TemplateOwner = CLASSIFICATION_OWNER): string {
  if (owner.family === 'classification') return '';
  if (owner.family === 'shipped') return '_shipped/';
  if (!ASSISTANT_SEGMENT.test(owner.assistant)) {
    throw new TemplateReferenceError('', `'${owner.assistant}' is not an assistant name a template key can carry.`);
  }
  return `_assistants/${owner.assistant}/`;
}

/** The prefix one owner's templates sit under, inside its classification's prefix. */
export function templateFamilyPrefix(classification: string, owner: TemplateOwner = CLASSIFICATION_OWNER): string {
  return `${templatePrefix(classification)}${ownerSegment(owner)}`;
}

/** `templates/<classification>/[<owner family>/]<name>/<sha256>.md`. */
export function templateKey(classification: string, name: string, contentHash: string, owner: TemplateOwner = CLASSIFICATION_OWNER): string {
  if (!TEMPLATE_NAME.test(name)) throw new TemplateReferenceError(name, `"${name}" is not a template name.`);
  if (!SHA256_HEX.test(contentHash)) throw new TemplateReferenceError(name, `"${contentHash}" is not a content hash.`);
  return `${templateFamilyPrefix(classification, owner)}${name}/${contentHash}.md`;
}

/** The SSM path a classification's template pointers sit under. */
export function templatePointerPath(ssmRoot: string, classification: string): string {
  templatePrefix(classification);
  return `${ssmRoot}/assistant/${classification}/templates`;
}

/** The pointer parameter for one template, in its owner's family. */
export function templatePointerName(ssmRoot: string, classification: string, name: string, owner: TemplateOwner = CLASSIFICATION_OWNER): string {
  if (!TEMPLATE_NAME.test(name)) throw new TemplateReferenceError(name, `"${name}" is not a template name.`);
  return `${templatePointerPath(ssmRoot, classification)}/${ownerSegment(owner)}${name}`;
}

export interface TemplatePointer {
  active: string;
  /** Earlier active versions, oldest first. Rollback returns to the last one. */
  history: string[];
}

export function parseTemplatePointer(value: string | undefined): TemplatePointer | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  const p = parsed as { active?: unknown; history?: unknown };
  if (!p || typeof p.active !== 'string' || !SHA256_HEX.test(p.active)) return undefined;
  const history = Array.isArray(p.history) ? p.history.filter((h): h is string => typeof h === 'string' && SHA256_HEX.test(h)) : [];
  return { active: p.active, history };
}

export function templatePointerValue(pointer: TemplatePointer): string {
  return JSON.stringify({ active: pointer.active, history: pointer.history.slice(-MAX_HISTORY) });
}

function resolved(deps: TemplateStoreDeps | undefined) {
  const region = process.env.AWS_REGION || 'us-east-1';
  return {
    s3: deps?.s3 ?? sessionClient(S3Client, { region, requestHandler: BOUNDED_REQUEST_HANDLER }),
    ssm: deps?.ssm ?? sessionClient(SSMClient, { region, requestHandler: BOUNDED_REQUEST_HANDLER }),
    bucket: deps?.bucket ?? (process.env.TEMPLATE_BUCKET || bodyBucket() || process.env.ATTACHMENTS_BUCKET),
    ssmRoot: deps?.ssmRoot ?? (process.env.SSM_ROOT || '/agent-echelon'),
    now: deps?.now ?? Date.now,
  };
}

// ── Writing: the operator's path ───────────────────────────────────────────────────────────────

/**
 * Store a template body under its content hash. Parsed first, so a template that cannot be checked
 * against is refused before anything is written. `If-None-Match: *` makes the write a create only: the
 * same bytes again find the object already there, which is success, and nothing overwrites a body.
 */
export async function putTemplate(
  classification: string,
  source: string,
  deps?: TemplateStoreDeps,
  opts: { dryRun?: boolean; owner?: TemplateOwner } = {},
): Promise<{ name: string; contentHash: string; key: string; written: boolean }> {
  const template = parseTemplate(source);
  const contentHash = contentIdOf(source);
  const key = templateKey(classification, template.name, contentHash, opts.owner);
  const d = resolved(deps);
  if (opts.dryRun) return { name: template.name, contentHash, key, written: false };
  if (!d.bucket) throw new TemplateReferenceError(template.name, 'no template bucket configured (TEMPLATE_BUCKET, PROFILE_BODY_BUCKET or ATTACHMENTS_BUCKET).');
  try {
    await d.s3.send(new PutObjectCommand({
      Bucket: d.bucket, Key: key, Body: source, ContentType: 'text/markdown; charset=utf-8', IfNoneMatch: '*',
    }));
    return { name: template.name, contentHash, key, written: true };
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === 'PreconditionFailed' || e?.$metadata?.httpStatusCode === 412) {
      return { name: template.name, contentHash, key, written: false };
    }
    throw err;
  }
}

/** The pointer for one template, or undefined when none was ever activated. */
export async function readTemplatePointer(
  classification: string,
  name: string,
  deps?: TemplateStoreDeps,
  owner?: TemplateOwner,
): Promise<TemplatePointer | undefined> {
  const d = resolved(deps);
  try {
    const resp = await d.ssm.send(new GetParameterCommand({ Name: templatePointerName(d.ssmRoot, classification, name, owner) }));
    return parseTemplatePointer(resp.Parameter?.Value);
  } catch (err) {
    if ((err as { name?: string })?.name === 'ParameterNotFound') return undefined;
    throw err;
  }
}

async function writePointer(classification: string, name: string, pointer: TemplatePointer, deps?: TemplateStoreDeps, owner?: TemplateOwner): Promise<void> {
  const d = resolved(deps);
  await d.ssm.send(new PutParameterCommand({
    Name: templatePointerName(d.ssmRoot, classification, name, owner),
    Value: templatePointerValue(pointer),
    Type: 'String',
    Overwrite: true,
  }));
  // A pointer this process just wrote is not served from its own stale cache.
  pointerCache.delete(templatePointerName(d.ssmRoot, classification, name, owner));
}

/**
 * Make a stored version the one the next delivery uses (FR7). The body is read and its hash verified
 * first, so a pointer never names a body that is not there. Only the pointer is written.
 */
export async function activateTemplate(
  classification: string,
  name: string,
  contentHash: string,
  deps?: TemplateStoreDeps,
  opts: { dryRun?: boolean; owner?: TemplateOwner } = {},
): Promise<{ previous?: string; active: string; changed: boolean }> {
  await getTemplateBody(classification, name, contentHash, deps, opts.owner);
  const current = await readTemplatePointer(classification, name, deps, opts.owner);
  if (current?.active === contentHash) return { previous: current.active, active: contentHash, changed: false };
  const next: TemplatePointer = {
    active: contentHash,
    history: current ? [...current.history, current.active] : [],
  };
  if (!opts.dryRun) await writePointer(classification, name, next, deps, opts.owner);
  return { ...(current ? { previous: current.active } : {}), active: contentHash, changed: true };
}

/** Return a template to the version active before the current one (FR7). Only the pointer is written. */
export async function rollbackTemplate(
  classification: string,
  name: string,
  deps?: TemplateStoreDeps,
  opts: { dryRun?: boolean; owner?: TemplateOwner } = {},
): Promise<{ from: string; to: string }> {
  const current = await readTemplatePointer(classification, name, deps, opts.owner);
  if (!current) throw new TemplateReferenceError(name, `template "${name}" has no active version for ${classification}.`);
  const to = current.history[current.history.length - 1];
  if (!to) throw new TemplateReferenceError(name, `template "${name}" has no earlier version to roll back to.`);
  await getTemplateBody(classification, name, to, deps, opts.owner);
  if (!opts.dryRun) await writePointer(classification, name, { active: to, history: current.history.slice(0, -1) }, deps, opts.owner);
  return { from: current.active, to };
}

/** Every template stored for a classification, with its stored versions and its pointer. */
export async function listTemplates(
  classification: string,
  deps?: TemplateStoreDeps,
  owner?: TemplateOwner,
): Promise<Array<{ name: string; versions: string[]; active?: string; history: string[] }>> {
  const d = resolved(deps);
  if (!d.bucket) throw new TemplateReferenceError('', 'no template bucket configured.');
  const prefix = templateFamilyPrefix(classification, owner);
  const versions = new Map<string, string[]>();
  let token: string | undefined;
  do {
    const page = await d.s3.send(new ListObjectsV2Command({ Bucket: d.bucket, Prefix: prefix, ContinuationToken: token }));
    for (const obj of page.Contents ?? []) {
      // Only this family's own keys: a key with more segments after the prefix is another family's.
      const k = obj.Key ?? '';
      const m = k.startsWith(prefix) ? /^([^/]+)\/([0-9a-f]{64})\.md$/.exec(k.slice(prefix.length)) : null;
      if (m) versions.set(m[1], [...(versions.get(m[1]) ?? []), m[2]]);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  const out = [];
  for (const [name, hashes] of [...versions.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const pointer = await readTemplatePointer(classification, name, deps, owner);
    out.push({ name, versions: hashes, ...(pointer ? { active: pointer.active } : {}), history: pointer?.history ?? [] });
  }
  return out;
}

// ── Reading: the turn's path ───────────────────────────────────────────────────────────────────

/**
 * A template body, read from its own classification's key and refused unless its bytes hash to the id
 * the key names. A throw, never a fallback to some other body.
 */
export async function getTemplateBody(
  classification: string,
  name: string,
  contentHash: string,
  deps?: TemplateStoreDeps,
  owner?: TemplateOwner,
): Promise<string> {
  const d = resolved(deps);
  const key = templateKey(classification, name, contentHash, owner);
  if (!d.bucket) throw new TemplateReferenceError(name, `no template bucket configured; cannot read ${key}.`);
  let body: string | undefined;
  try {
    const resp = await d.s3.send(new GetObjectCommand({ Bucket: d.bucket, Key: key }));
    body = await resp.Body?.transformToString();
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) {
      throw new TemplateReferenceError(name, `template "${name}" version ${contentHash} does not exist for ${classification} (${key}).`);
    }
    throw err;
  }
  if (body === undefined) throw new TemplateReferenceError(name, `template "${name}" at ${key} has no body.`);
  const actual = contentIdOf(body);
  if (actual !== contentHash) {
    throw new TemplateReferenceError(name, `the template at ${key} hashes to ${actual}, not the ${contentHash} its key names. Refusing it.`);
  }
  return body;
}

const pointerCache = new Map<string, { pointer: TemplatePointer | undefined; at: number }>();
const bodyCache = new Map<string, LoadedTemplate>();

/** Forget cached pointers and bodies. For tests. */
export function _resetTemplateCache(): void {
  pointerCache.clear();
  bodyCache.clear();
}

/**
 * Load one declared reference: a pinned version as named, else the version the pointer makes active.
 *
 * CACHED PER CONTAINER, with the version id. A body is immutable, so it is kept for the container's life
 * under its key; a pointer is reused for `TEMPLATE_POINTER_TTL_MS`, which is how an activation reaches
 * the next delivery without a deploy and without a pointer read on every turn.
 */
export async function loadTemplate(
  classification: string,
  ref: TemplateRef,
  deps?: TemplateStoreDeps,
  opts: { owner?: TemplateOwner; kind?: 'document' | 'message' | 'prompt' } = {},
): Promise<LoadedTemplate> {
  const d = resolved(deps);
  const { owner } = opts;
  let hash = ref.version;
  if (!hash) {
    const pname = templatePointerName(d.ssmRoot, classification, ref.name, owner);
    const cached = pointerCache.get(pname);
    let pointer: TemplatePointer | undefined;
    if (cached && d.now() - cached.at < TEMPLATE_POINTER_TTL_MS) {
      pointer = cached.pointer;
    } else {
      pointer = await readTemplatePointer(classification, ref.name, deps, owner);
      pointerCache.set(pname, { pointer, at: d.now() });
    }
    if (!pointer) {
      throw new TemplateNotActiveError(ref.name, `template "${ref.name}" does not exist for ${classification}: no version is active.`);
    }
    hash = pointer.active;
  }
  const key = templateKey(classification, ref.name, hash, owner);
  const hit = bodyCache.get(key);
  if (hit) return kindChecked(hit, key, opts.kind);
  const body = await getTemplateBody(classification, ref.name, hash, deps, owner);
  const template = parseTemplate(body);
  if (template.name !== ref.name) {
    throw new TemplateReferenceError(ref.name, `the body at ${key} names itself "${template.name}", not "${ref.name}".`);
  }
  const loaded: LoadedTemplate = { name: ref.name, contentHash: hash, template };
  bodyCache.set(key, loaded);
  return kindChecked(loaded, key, opts.kind);
}

/** A loaded template of the kind its reader asked for. A workflow's reference asks for a document. */
function kindChecked(loaded: LoadedTemplate, key: string, kind: 'document' | 'message' | 'prompt' = 'document'): LoadedTemplate {
  const actual = loaded.template.kind ?? 'document';
  if (actual !== kind) throw new TemplateReferenceError(loaded.name, `the template at ${key} is a ${actual}, not a ${kind}.`);
  return loaded;
}

/**
 * The templates a turn's machine declares, loaded once before the turn runs. A reference that cannot be
 * loaded is kept as a named failure, so the step that needs it refuses with the reason rather than
 * delivering an unshaped document. Nothing is read for a machine that declares no template.
 */
export async function loadTurnTemplates(
  refs: TemplateRef[],
  classification: string,
  deps?: TemplateStoreDeps,
): Promise<TurnTemplates> {
  const out: TurnTemplates = {};
  await Promise.all(refs.map(async (ref) => {
    try {
      out[templateRefKey(ref)] = await loadTemplate(classification, ref, deps);
    } catch (err) {
      const failure: TemplateLoadFailure = { name: ref.name, error: (err as Error)?.message ?? String(err) };
      console.error('[TemplateStore] a declared template could not be loaded', { classification, ref: templateRefKey(ref), error: failure.error });
      out[templateRefKey(ref)] = failure;
    }
  }));
  return out;
}

/**
 * Every declared template reference in a set of machines that does not resolve for the classification,
 * as named errors (FR4). Where the pack and the store can both be read: the template script's `check`,
 * and the processor when it hydrates a pack.
 */
export async function templateReferenceErrors(
  machines: Record<string, TaskStateMachine>,
  classification: string,
  deps?: TemplateStoreDeps,
): Promise<string[]> {
  const errors: string[] = [];
  for (const [taskType, machine] of Object.entries(machines)) {
    for (const ref of templateRefsOfMachine(machine)) {
      try {
        await loadTemplate(classification, ref, deps);
      } catch (err) {
        errors.push(`${taskType}: ${(err as Error)?.message ?? String(err)}`);
      }
    }
  }
  return errors;
}
