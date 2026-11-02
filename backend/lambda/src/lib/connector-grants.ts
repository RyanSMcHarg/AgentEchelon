/**
 * PER-PERSON CONNECTOR GRANTS (K3): a vendor OAuth grant a person gave this deployment, so a connector can
 * read the vendor's records AS that person and the vendor's own sharing rules apply.
 *
 * ── THE STORE ───────────────────────────────────────────────────────────────────────────────────
 *
 * One item per person and connector in the grants table (`Connectors`), keyed `personId` (the
 * AppInstanceUser id, tenet D14) and `connectorId`. The tokens are a KMS ciphertext under the grants key,
 * with the person and connector as its encryption context, so a ciphertext moved to another person's item
 * does not decrypt; the table itself is encrypted under the same customer managed key. Nothing else about
 * the vendor account is kept. `status` is `active`, or `revoke-failed` for a grant whose revocation at the
 * vendor has not succeeded yet.
 *
 * ── WHO REVOKES ─────────────────────────────────────────────────────────────────────────────────
 *
 *  - The person, from their own session (`DELETE /connectors/{connectorId}/grant`).
 *  - Offboarding, for every grant the person holds (`offboarding.ts`, the `connectorGrants` store), through
 *    the revoker function.
 *
 * Revocation calls the vendor's revocation endpoint FIRST and deletes the item only once the vendor has
 * revoked the token, or says the token is no longer valid. A call that fails is retried
 * `REVOKE_ATTEMPTS` times with backoff; one that still fails leaves the item `revoke-failed`, counted in
 * the offboarding event, and the revoker's daily sweep tries it again (tenet D6: the offboarding call is
 * primary, the sweep the backstop). After `MAX_SWEEP_ATTEMPTS` sweeps the item is deleted and an
 * `ae.alert` asks an operator to revoke it at the vendor by hand, naming the connector and the person id.
 */
import { DecryptCommand, EncryptCommand } from '@aws-sdk/client-kms';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { RuntimeConnector } from '../../../lib/config/connectors.js';

type Sender = { send(command: unknown): Promise<any> };
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: URLSearchParams; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const REVOKE_ATTEMPTS = 3;
export const MAX_SWEEP_ATTEMPTS = 14;
export const VENDOR_TIMEOUT_MS = 5_000;

export type GrantStatus = 'active' | 'revoke-failed';

export interface GrantItem {
  personId: string;
  connectorId: string;
  ciphertext: string;
  status: GrantStatus;
  createdAt: string;
  revokeAttempts?: number;
}

export interface GrantTokens {
  accessToken: string;
  refreshToken?: string;
}

export interface GrantDeps {
  doc: Sender;
  kms: Sender;
  table: string;
  keyArn: string;
  connectors: readonly RuntimeConnector[];
  oauthClient(connectorId: string): Promise<{ clientId: string; clientSecret: string }>;
  fetch?: FetchLike;
  /** Waits between retries. Default a real delay; a test passes one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const context = (personId: string, connectorId: string) => ({ personId, connectorId, purpose: 'connector-grant' });
const fetchOf = (d: GrantDeps): FetchLike => d.fetch ?? (globalThis.fetch as unknown as FetchLike);
const sleepOf = (d: GrantDeps) => d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

/** The connector, when it is declared AND takes per-person grants. */
export function grantConnector(connectors: readonly RuntimeConnector[], connectorId: string): RuntimeConnector | undefined {
  return connectors.find((c) => c.id === connectorId && c.grants);
}

async function seal(personId: string, connectorId: string, tokens: GrantTokens, deps: GrantDeps): Promise<string> {
  const r = await deps.kms.send(new EncryptCommand({
    KeyId: deps.keyArn,
    Plaintext: Buffer.from(JSON.stringify(tokens), 'utf8'),
    EncryptionContext: context(personId, connectorId),
  }));
  return Buffer.from(r.CiphertextBlob as Uint8Array).toString('base64');
}

async function open(item: GrantItem, deps: GrantDeps): Promise<GrantTokens> {
  const r = await deps.kms.send(new DecryptCommand({
    KeyId: deps.keyArn,
    CiphertextBlob: Buffer.from(item.ciphertext, 'base64'),
    EncryptionContext: context(item.personId, item.connectorId),
  }));
  return JSON.parse(Buffer.from(r.Plaintext as Uint8Array).toString('utf8')) as GrantTokens;
}

// ── LINKING ────────────────────────────────────────────────────────────────────────────────────

/** A grant the vendor would not issue, or a request this deployment refuses before asking it. */
export class GrantRefused extends Error {
  constructor(readonly code: 'unknown-connector' | 'redirect-not-declared' | 'vendor-refused' | 'vendor-unavailable', detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'GrantRefused';
  }
}

/**
 * Exchange an authorization code (with its PKCE verifier) for the person's tokens, and store them sealed.
 * The redirect URI must be one the connector declares. Replaces the person's earlier grant for it.
 */
export async function linkGrant(
  personId: string,
  connectorId: string,
  input: { code: string; redirectUri: string; codeVerifier: string },
  deps: GrantDeps,
): Promise<void> {
  const connector = grantConnector(deps.connectors, connectorId);
  if (!connector?.grants) throw new GrantRefused('unknown-connector', 'no declared connector takes a grant by that id');
  if (!connector.grants.redirectUris.includes(input.redirectUri)) throw new GrantRefused('redirect-not-declared', 'the redirect URI is not one the connector declares');
  const client = await deps.oauthClient(connector.id);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
  let answer: { access_token?: unknown; refresh_token?: unknown };
  try {
    const r = await fetchOf(deps)(connector.grants.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS),
    });
    if (!r.ok) throw new GrantRefused('vendor-refused', `the vendor answered ${r.status}`);
    answer = (await r.json()) as typeof answer;
  } catch (err) {
    if (err instanceof GrantRefused) throw err;
    throw new GrantRefused('vendor-unavailable', `the vendor could not be reached: ${(err as Error)?.name || 'error'}`);
  }
  if (typeof answer?.access_token !== 'string' || !answer.access_token) throw new GrantRefused('vendor-refused', 'the vendor issued no access token');
  const tokens: GrantTokens = {
    accessToken: answer.access_token,
    ...(typeof answer.refresh_token === 'string' && answer.refresh_token ? { refreshToken: answer.refresh_token } : {}),
  };
  // A grant this replaces is revoked at the vendor first, so a person never holds two live grants for one connector.
  const earlier = await readGrant(personId, connector.id, deps);
  if (earlier) await revokeGrant(earlier, deps);
  const item: GrantItem = {
    personId,
    connectorId: connector.id,
    ciphertext: await seal(personId, connector.id, tokens, deps),
    status: 'active',
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  await deps.doc.send(new PutCommand({ TableName: deps.table, Item: item }));
}

export async function readGrant(personId: string, connectorId: string, deps: Pick<GrantDeps, 'doc' | 'table'>): Promise<GrantItem | null> {
  const r = await deps.doc.send(new GetCommand({ TableName: deps.table, Key: { personId, connectorId }, ConsistentRead: true }));
  return (r?.Item as GrantItem | undefined) ?? null;
}

// ── REVOKING ───────────────────────────────────────────────────────────────────────────────────

/**
 * One revocation call at the vendor. True when the vendor revoked the token or says it is no longer valid
 * (`invalid_token`, `invalid_grant`, `unsupported_token_type`: nothing is left to revoke); false otherwise.
 */
async function revokeAtVendor(connector: RuntimeConnector, tokens: GrantTokens, deps: GrantDeps): Promise<boolean> {
  const g = connector.grants!;
  // The refresh token where there is one: revoking it ends the access token too at both vendors.
  const body = new URLSearchParams({ token: tokens.refreshToken || tokens.accessToken });
  if (g.revokeAuth === 'client-credentials') {
    const client = await deps.oauthClient(connector.id);
    body.set('client_id', client.clientId);
    body.set('client_secret', client.clientSecret);
  }
  try {
    const r = await fetchOf(deps)(g.revokeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(VENDOR_TIMEOUT_MS),
    });
    if (r.ok) return true;
    if (r.status === 400) {
      const e = (await r.json().catch(() => ({}))) as { error?: unknown };
      return ['invalid_token', 'invalid_grant', 'unsupported_token_type'].includes(String(e?.error ?? ''));
    }
    return false;
  } catch {
    return false;
  }
}

export type RevocationOutcome = 'revoked' | 'failed';

/**
 * Revoke one grant at the vendor, retried with backoff, then delete it. A grant that still fails is left
 * `revoke-failed` with its attempt count for the sweep. A connector no longer declared cannot be revoked
 * through: that also counts as failed and is left for an operator, never deleted silently.
 */
export async function revokeGrant(item: GrantItem, deps: GrantDeps): Promise<RevocationOutcome> {
  const connector = grantConnector(deps.connectors, item.connectorId);
  let ok = false;
  if (connector) {
    let tokens: GrantTokens | null = null;
    try {
      tokens = await open(item, deps);
    } catch (err) {
      console.error('[connector-grants] a grant could not be decrypted', { connectorId: item.connectorId, err: (err as Error)?.name });
    }
    for (let attempt = 0; tokens && attempt < REVOKE_ATTEMPTS && !ok; attempt++) {
      if (attempt > 0) await sleepOf(deps)(200 * 4 ** (attempt - 1));
      ok = await revokeAtVendor(connector, tokens, deps);
    }
  }
  if (ok) {
    await deps.doc.send(new DeleteCommand({ TableName: deps.table, Key: { personId: item.personId, connectorId: item.connectorId } }));
    return 'revoked';
  }
  await deps.doc.send(new UpdateCommand({
    TableName: deps.table,
    Key: { personId: item.personId, connectorId: item.connectorId },
    UpdateExpression: 'SET #s = :failed ADD revokeAttempts :one',
    ConditionExpression: 'attribute_exists(personId)',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':failed': 'revoke-failed', ':one': 1 },
  })).catch((err: unknown) => {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
  });
  console.error('[connector-grants][SecurityEvent] a grant could not be revoked at the vendor; it is kept for the retry', { connectorId: item.connectorId });
  return 'failed';
}

/** Every grant a person holds. */
export async function grantsOf(personId: string, deps: Pick<GrantDeps, 'doc' | 'table'>): Promise<GrantItem[]> {
  const out: GrantItem[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await deps.doc.send(new QueryCommand({
      TableName: deps.table,
      KeyConditionExpression: 'personId = :p',
      ExpressionAttributeValues: { ':p': personId },
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
    }));
    out.push(...((r?.Items || []) as GrantItem[]));
    ExclusiveStartKey = r?.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

/** What offboarding records: how many grants were revoked and deleted, and how many are left for the retry. */
export interface PersonRevocation {
  revoked: number;
  failed: number;
}

/** Revoke every grant a person holds (offboarding). Throws only when the grants cannot be listed. */
export async function revokePersonGrants(personId: string, deps: GrantDeps): Promise<PersonRevocation> {
  const result: PersonRevocation = { revoked: 0, failed: 0 };
  for (const item of await grantsOf(personId, deps)) {
    const outcome = await revokeGrant(item, deps).catch(() => 'failed' as const);
    result[outcome]++;
  }
  return result;
}

/** What one sweep did. `abandoned` were deleted after `MAX_SWEEP_ATTEMPTS` and raised as alerts. */
export interface SweepResult {
  revoked: number;
  failed: number;
  abandoned: Array<{ personId: string; connectorId: string }>;
}

/** THE BACKSTOP: try every `revoke-failed` grant again. */
export async function retryFailedRevocations(deps: GrantDeps): Promise<SweepResult> {
  const result: SweepResult = { revoked: 0, failed: 0, abandoned: [] };
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await deps.doc.send(new ScanCommand({
      TableName: deps.table,
      FilterExpression: '#s = :failed',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':failed': 'revoke-failed' },
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
    }));
    for (const item of (r?.Items || []) as GrantItem[]) {
      if ((item.revokeAttempts ?? 0) >= MAX_SWEEP_ATTEMPTS) {
        await deps.doc.send(new DeleteCommand({ TableName: deps.table, Key: { personId: item.personId, connectorId: item.connectorId } }));
        result.abandoned.push({ personId: item.personId, connectorId: item.connectorId });
        continue;
      }
      result[await revokeGrant(item, deps)]++;
    }
    ExclusiveStartKey = r?.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return result;
}
