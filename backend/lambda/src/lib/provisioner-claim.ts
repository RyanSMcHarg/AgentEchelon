/**
 * WHO ASKED THE PROVISIONER, PROVEN BY A WRITE ONLY THAT CALLER CAN MAKE (ADR-048, amended 2026-10-24).
 *
 * A Lambda function cannot see who invoked it, and the provisioner (`assistant-provisioner-function.ts`) is invoked
 * by several principals: each stack's seed, for its own classification, and `manage-assistants`, for the console. So
 * a request does not say who it is from; it PROVES it. Before invoking, the caller writes a claim, an SSM parameter
 * whose value is the digest of the exact request, under a path that names the caller:
 *
 *   - `{root}/provisioner-claims/seed/{classification}/{claimId}`, writable by that classification's seed role alone
 *     (`DeclaredAssistantsSeed` grants it in the classification's own stack);
 *   - `{root}/provisioner-claims/console/{claimId}`, writable by `manage-assistants`' role alone.
 *
 * The provisioner derives the path from the request (a `seed-declared` request's `callerClassification`, or the
 * console for `build` and `remove`), reads the claim, and refuses the request unless the claim is there, is fresh,
 * and carries the digest of the request it received. It then deletes the claim, so a claim answers one request. A
 * principal that may invoke the provisioner but cannot write another caller's path cannot ask in its name: IAM
 * refuses the write, which is the boundary, and the provisioner's read is the second layer.
 *
 * Adding a classification adds its seed's grant in its own stack and changes nothing in the core.
 */
import { createHash, randomUUID } from 'crypto';
import { GetParameterCommand, PutParameterCommand, DeleteParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';

/** The path every claim is written under, below the deployment's SSM root. */
export const PROVISIONER_CLAIMS = 'provisioner-claims';

/** How long a claim answers a request after it is written. A caller invokes as soon as it writes. */
export const CLAIM_MAX_AGE_MS = 15 * 60_000;

/** A classification, as it may appear in a claim path: one path segment, never a nested one. */
const CLASSIFICATION_SEGMENT = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A claim id, as `randomUUID` writes it. */
const CLAIM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Who a claim is from: the console, or one classification's seed. */
export type ClaimPrincipal = { kind: 'console' } | { kind: 'seed'; classification: string };

/** The path, below `{root}/provisioner-claims`, that only `principal` can write. Refuses a classification that is not one segment. */
export function claimPrefixOf(ssmRoot: string, principal: ClaimPrincipal): string {
  if (principal.kind === 'console') return `${ssmRoot}/${PROVISIONER_CLAIMS}/console`;
  if (!CLASSIFICATION_SEGMENT.test(principal.classification)) throw new Error(`provisioner: '${principal.classification}' is not a classification`);
  return `${ssmRoot}/${PROVISIONER_CLAIMS}/seed/${principal.classification}`;
}

/** The principal a request must prove it is from: a seed's request names its classification, every other is the console's. */
export function principalOf(request: { op: string; callerClassification?: unknown }): ClaimPrincipal {
  return request.op === 'seed-declared'
    ? { kind: 'seed', classification: String(request.callerClassification ?? '') }
    : { kind: 'console' };
}

/** JSON with every object's keys in order, so the digest of a request does not depend on how it was serialized. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The digest a claim carries: of the request, without its `claim`. */
export function claimDigest(request: Record<string, unknown>): string {
  const { claim: _claim, ...rest } = request;
  void _claim;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

/**
 * WRITE THE CLAIM for `request` and return the request carrying it. `release` deletes the claim, for the caller to
 * run once the provisioner has answered (the provisioner deletes it first when it reads it; a release of a claim
 * already gone does nothing).
 */
export async function writeClaim<T extends Record<string, unknown>>(
  ssm: Pick<SSMClient, 'send'>, ssmRoot: string, request: T,
): Promise<{ request: T & { claim: string }; release: () => Promise<void> }> {
  const claim = randomUUID();
  const name = `${claimPrefixOf(ssmRoot, principalOf(request as unknown as { op: string; callerClassification?: unknown }))}/${claim}`;
  await ssm.send(new PutParameterCommand({ Name: name, Value: claimDigest(request), Type: 'String', Overwrite: false }));
  return {
    request: { ...request, claim },
    release: async () => { await ssm.send(new DeleteParameterCommand({ Name: name })).catch(() => undefined); },
  };
}

/**
 * WHY A REQUEST'S CLAIM DOES NOT PROVE ITS CALLER, or null when it does. Reads the claim at the path the request's
 * own caller would have written, and deletes it once read, so it answers this request and no other.
 */
export async function claimRefusal(
  ssm: Pick<SSMClient, 'send'>, ssmRoot: string, request: Record<string, unknown> & { op: string }, now = Date.now(),
): Promise<string | null> {
  const claim = request.claim;
  if (typeof claim !== 'string' || !CLAIM_ID.test(claim)) return 'the request carries no claim';
  let prefix: string;
  try {
    prefix = claimPrefixOf(ssmRoot, principalOf(request));
  } catch (err) {
    return (err as Error).message.replace(/^provisioner: /, '');
  }
  const name = `${prefix}/${claim}`;
  let stored: { Value?: string; LastModifiedDate?: Date } | undefined;
  try {
    stored = (await ssm.send(new GetParameterCommand({ Name: name })))?.Parameter;
  } catch (err) {
    if ((err as { name?: string })?.name === 'ParameterNotFound') return `no claim was written where its caller writes (${prefix})`;
    throw err;
  }
  // Single use, whatever the verdict: a claim read once is never read again.
  await ssm.send(new DeleteParameterCommand({ Name: name })).catch((err) => {
    if ((err as { name?: string })?.name !== 'ParameterNotFound') throw err;
  });
  if (!stored?.Value || stored.Value !== claimDigest(request)) return 'the claim was written for another request';
  const writtenAt = stored.LastModifiedDate ? new Date(stored.LastModifiedDate).getTime() : NaN;
  if (!Number.isFinite(writtenAt) || now - writtenAt > CLAIM_MAX_AGE_MS) return 'the claim is stale';
  return null;
}
