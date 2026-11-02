/**
 * ONE HUMAN THROUGH TWO ISSUERS (B7, PLAN §16.5 P-13): a second issuer's subject is linked to a person
 * only by a session already pinned to that person plus the second token, in one call.
 *
 * The pinned session is the person's own sign-in on `Authorization`: the edge verified it and resolved it
 * to their AppInstanceUser through an active `Identities` row. The second token is in the body
 * (`{ linkIssuer: { token } }`), and the exchange verifies it here against the same registry and the same
 * checks the edge applies (`verifyToken`, `LINK_ISSUERS`). Nothing is ever matched by email: the second
 * subject is linked because the person holding the first session presented a token for it.
 *
 * ── REFUSED, AND NOTHING WRITTEN ─────────────────────────────────────────────────────────────────
 *
 *  - The second token fails any check (`LINK_TOKEN_REFUSED`).
 *  - Either side is a guest, a host assertion, a one-conversation issuer or a provisioned-only issuer
 *    (`LINK_NOT_SUPPORTED`): a visitor becomes a person by path A or B, and a provisioned subject is
 *    pre-assigned by `provisionSubject`. Linking a provisioned-only subject is **NOT BUILT**.
 *  - The second issuer is the first one (`LINK_SAME_ISSUER`): one person holds one subject per issuer.
 *  - The person already holds a subject of that issuer (`LINK_ISSUER_ALREADY_LINKED`).
 *  - The second subject already has a row, or was offboarded (`SUBJECT_ALREADY_BOUND`): it is somebody,
 *    and a link never moves a subject from one person to another. A row naming this same person answers
 *    200, already linked.
 *
 * ── WRITTEN ──────────────────────────────────────────────────────────────────────────────────────
 *
 * One conditional put of the second subject's row naming the person, and an `identity_linked` record in
 * the access log (ADR-052): actor, issuer id, AppInstanceUser ARN, time, and the issuer of the pinned
 * session. The access log is the record every `Identities` write already goes to, so no new store.
 */
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { isGuestIssuer, isProvisionedOnly, oneChannelOf, subjectOf, type TrustedIssuer } from '../../../lib/config/issuers.js';
import type { EdgeIssuer } from '../../../lib/config/edge-verification.js';
import { IDENTITIES_BY_PERSON, issuerSubjectKey, parseIssuerSubjectKey, revokedMarkerKey, type IdentityRow } from './person-identity.js';
import { TokenRefused, verifyToken, type VerifiedToken } from './token-verification.js';
import { recordAccess, type AccessAuditLine } from './access-log.js';
import { personIdFromArn } from './person-arn.js';

type Sender = { send(command: unknown): Promise<any> };

export const LINK_REFUSALS = {
  LINK_TOKEN_REFUSED: 401,
  LINK_NOT_SUPPORTED: 403,
  LINK_SAME_ISSUER: 409,
  LINK_ISSUER_ALREADY_LINKED: 409,
  SUBJECT_ALREADY_BOUND: 409,
  LINK_UNAVAILABLE: 503,
} as const;
export type LinkRefusalCode = keyof typeof LINK_REFUSALS;

export class LinkRefused extends Error {
  readonly status: number;
  constructor(readonly code: LinkRefusalCode, detail: string) {
    super(detail);
    this.name = 'LinkRefused';
    this.status = LINK_REFUSALS[code];
  }
}

/** The second token a request body names (`{ linkIssuer: { token } }`), null for none, `malformed` for a bad one. */
export function linkRequestOf(body: unknown): { token: string } | null | 'malformed' {
  const l = (body && typeof body === 'object' ? (body as Record<string, unknown>).linkIssuer : undefined) as Record<string, unknown> | undefined;
  if (l === undefined) return null;
  if (!l || typeof l !== 'object' || typeof l.token !== 'string' || !l.token || l.token.length > 8192) return 'malformed';
  return { token: l.token };
}

/** The registry, with what the edge verifies each issuer by, as this function was deployed with it. */
export function linkIssuersFromEnv(raw: string | undefined = process.env.LINK_ISSUERS): EdgeIssuer[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as EdgeIssuer[] : [];
  } catch {
    console.error('[IssuerLink][SecurityEvent] LINK_ISSUERS is not readable; no second issuer can be linked');
    return [];
  }
}

/** Whether an issuer's people may hold a linked subject at all. */
export function linkable(issuer: Pick<TrustedIssuer, 'kind' | 'clearance'> & { provisioning?: string } | null | undefined): boolean {
  if (!issuer || isGuestIssuer(issuer) || issuer.kind === 'host-assertion' || isProvisionedOnly(issuer as TrustedIssuer)) return false;
  return !oneChannelOf(issuer as TrustedIssuer);
}

export interface LinkDeps {
  doc: Sender;
  identitiesTable?: string;
  verify?: (token: string) => Promise<VerifiedToken>;
  audit?: (line: AccessAuditLine) => Promise<unknown>;
  now?: () => Date;
}

export interface Linked {
  issuerId: string;
  personArn: string;
  /** False when the subject was already this person's. */
  created: boolean;
}

/**
 * Link the subject of `secondToken` to `pinned.personArn`. `pinned` is what the edge resolved the
 * caller's own session to; it is never read from the body.
 */
export async function linkSecondIssuer(
  pinned: { personArn: string; issuer: TrustedIssuer },
  secondToken: string,
  deps: LinkDeps,
): Promise<Linked> {
  const table = deps.identitiesTable ?? process.env.IDENTITIES_TABLE ?? '';
  if (!table) throw new LinkRefused('LINK_UNAVAILABLE', 'IDENTITIES_TABLE is not set');
  if (!personIdFromArn(pinned.personArn)) throw new LinkRefused('LINK_NOT_SUPPORTED', 'the session names no person');
  if (!linkable(pinned.issuer)) throw new LinkRefused('LINK_NOT_SUPPORTED', 'this session cannot link another issuer');

  let verified: VerifiedToken;
  try {
    verified = await (deps.verify ?? ((t: string) => verifyToken(t, linkIssuersFromEnv())))(secondToken);
  } catch (err) {
    if (err instanceof TokenRefused) throw new LinkRefused('LINK_TOKEN_REFUSED', `the second token is refused: ${err.code}`);
    throw new LinkRefused('LINK_UNAVAILABLE', `the second token could not be checked: ${(err as Error)?.name || 'error'}`);
  }
  const second = verified.issuer as unknown as TrustedIssuer;
  if (!linkable(second)) throw new LinkRefused('LINK_NOT_SUPPORTED', `issuer "${second.id}" cannot be linked`);
  if (second.id === pinned.issuer.id) throw new LinkRefused('LINK_SAME_ISSUER', 'a person holds one subject per issuer');
  const subject = subjectOf(second, verified.claims);
  if (!subject) throw new LinkRefused('LINK_TOKEN_REFUSED', 'the second token names no subject');

  const key = issuerSubjectKey(second.id, subject);
  const get = async (k: string) => (await deps.doc.send(new GetCommand({ TableName: table, Key: { issuerSubject: k }, ConsistentRead: true })))?.Item as IdentityRow | undefined;
  const existing = await get(key);
  if (existing) {
    if (existing.personArn === pinned.personArn && existing.status === 'active') return { issuerId: second.id, personArn: pinned.personArn, created: false };
    throw new LinkRefused('SUBJECT_ALREADY_BOUND', 'that sign-in is already a person');
  }
  if (await get(revokedMarkerKey(second.id, subject))) throw new LinkRefused('SUBJECT_ALREADY_BOUND', 'that sign-in was offboarded');

  const held = await deps.doc.send(new QueryCommand({
    TableName: table,
    IndexName: IDENTITIES_BY_PERSON,
    KeyConditionExpression: 'personArn = :p',
    ExpressionAttributeValues: { ':p': pinned.personArn },
  }));
  for (const item of (held?.Items ?? []) as IdentityRow[]) {
    if (parseIssuerSubjectKey(item.issuerSubject)?.issuer === second.id) {
      throw new LinkRefused('LINK_ISSUER_ALREADY_LINKED', `this person already signs in through "${second.id}"`);
    }
  }

  const at = (deps.now?.() ?? new Date()).toISOString();
  const row: IdentityRow & { linkedBy: string } = {
    issuerSubject: key, personArn: pinned.personArn, issuer: second.id, status: 'active', createdAt: at, linkedBy: pinned.issuer.id,
  };
  try {
    await deps.doc.send(new PutCommand({ TableName: table, Item: row, ConditionExpression: 'attribute_not_exists(issuerSubject)' }));
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') throw new LinkRefused('SUBJECT_ALREADY_BOUND', 'that sign-in became a person meanwhile');
    throw new LinkRefused('LINK_UNAVAILABLE', `the link could not be written: ${(err as Error)?.name || 'error'}`);
  }

  const line: AccessAuditLine = {
    _auditEvent: 'identity_linked',
    timestamp: at,
    // The actor is the person whose pinned session asked for the link.
    personId: personIdFromArn(pinned.personArn)!,
    actorArn: pinned.personArn,
    issuer: second.id,
    personArn: pinned.personArn,
    linkedBy: pinned.issuer.id,
  };
  console.log(JSON.stringify(line));
  try {
    await (deps.audit ?? ((l: AccessAuditLine) => recordAccess(l)))(line);
  } catch (err) {
    console.error('[IssuerLink][SecurityEvent] a link could not be written to the access log', { personArn: pinned.personArn, err: (err as Error)?.name });
  }
  return { issuerId: second.id, personArn: pinned.personArn, created: true };
}
