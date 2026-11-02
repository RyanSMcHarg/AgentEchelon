/**
 * THE ONE PLACE AN APP-INSTANCE PRINCIPAL ARN IS READ OR WRITTEN.
 *
 * Every principal in a conversation is an Amazon Chime SDK app-instance member, and its ARN is
 * `<appInstanceArn>/user/<id>` for a person or `<appInstanceArn>/bot/<id>` for an assistant. The id
 * inside it is the AppInstanceUser (or AppInstanceBot) id, and that id is the person key: every table
 * that records who did something stores it.
 *
 * Parsing and building that shape inline (`arn.split('/user/').pop()`, `${appInstanceArn}/user/${x}`)
 * scattered the rule across dozens of handlers, each with its own answer for a bot ARN or a malformed
 * one. They live here so the rule has one answer, and so a change to what the id IS changes one input
 * rather than every call site. `backend/test/an-arn-is-parsed-in-one-place.test.ts` refuses a new
 * inline copy; `backend/scripts/lib/person-arn.cjs` is the operator-script twin and the unit test holds
 * both to the same table.
 *
 * WHAT COUNTS AS AN ID. Everything after the `/user/` or `/bot/` segment, when it is non-empty and has
 * no further `/`. The id's own characters are not validated: an id may carry dashes, colons,
 * underscores, `@` and dots, and the `<id>-admin` twin is a person ARN like any other. Nothing here
 * branches on the id's shape.
 */

export type PrincipalKind = 'person' | 'assistant';

export interface Principal {
  kind: PrincipalKind;
  id: string;
}

const PERSON_SEGMENT = '/user/';
const ASSISTANT_SEGMENT = '/bot/';
const CHANNEL_SEGMENT = '/channel/';

/** The id after `segment`, or null when the ARN has no such segment or names nothing after it. */
function idAfter(arn: string | null | undefined, segment: string): string | null {
  if (typeof arn !== 'string' || !arn) return null;
  const at = arn.indexOf(segment);
  if (at <= 0) return null;
  const id = arn.slice(at + segment.length);
  return id && !id.includes('/') ? id : null;
}

/** The AppInstanceUser id a person ARN names. Null for an assistant ARN, a non-ARN, or a malformed one. */
export function personIdFromArn(arn: string | null | undefined): string | null {
  return idAfter(arn, PERSON_SEGMENT);
}

/** The AppInstanceBot id an assistant ARN names. Null for a person ARN, a non-ARN, or a malformed one. */
export function botIdFromArn(arn: string | null | undefined): string | null {
  return idAfter(arn, ASSISTANT_SEGMENT);
}

/**
 * The same two parses as SQL, for a query that reads ARNs PostgreSQL holds. Fragments rather than
 * a second copy of the segment strings, so the database and the runtime split an ARN one way.
 */
export const personIdSql = (expr: string): string => `split_part(${expr}, '${PERSON_SEGMENT}', 2)`;
export const botIdSql = (expr: string): string => `split_part(${expr}, '${ASSISTANT_SEGMENT}', 2)`;

/** Which kind of principal an ARN names, and its id. Null when it names neither. */
export function principalFromArn(arn: string | null | undefined): Principal | null {
  const personId = personIdFromArn(arn);
  if (personId) return { kind: 'person', id: personId };
  const botId = botIdFromArn(arn);
  if (botId) return { kind: 'assistant', id: botId };
  return null;
}

/**
 * The unique id of an app-instance principal, from its ARN, or the input's last path segment when it
 * is not a principal ARN (a bare id passes through unchanged). '' for nothing.
 */
export function principalIdFromArn(arn: string | null | undefined): string {
  const principal = principalFromArn(arn);
  if (principal) return principal.id;
  return (typeof arn === 'string' && arn.split('/').pop()) || '';
}

/**
 * The app instance a principal (or channel) ARN lives in: everything before its `/user/`, `/bot/` or
 * `/channel/` segment. Null when the ARN carries none of them.
 */
export function appInstanceArnOf(arn: string | null | undefined): string | null {
  if (typeof arn !== 'string' || !arn) return null;
  for (const segment of [PERSON_SEGMENT, ASSISTANT_SEGMENT, CHANNEL_SEGMENT]) {
    const at = arn.indexOf(segment);
    if (at > 0) return arn.slice(0, at);
  }
  return null;
}

/** The ARN of the AppInstanceUser `personId` in `appInstanceArn`. */
export function userArnFor(appInstanceArn: string, personId: string): string {
  return `${appInstanceArn}${PERSON_SEGMENT}${personId}`;
}

/** The ARN of the AppInstanceBot `botId` in `appInstanceArn`. */
export function botArnFor(appInstanceArn: string, botId: string): string {
  return `${appInstanceArn}${ASSISTANT_SEGMENT}${botId}`;
}

/** Whether an ARN names a person (an AppInstanceUser) of the app instance `appInstanceArn`, and no other. */
export function isPersonOf(arn: string | null | undefined, appInstanceArn: string | null | undefined): boolean {
  return isPersonArn(arn) && !!appInstanceArn && appInstanceArnOf(arn) === appInstanceArn;
}

/** Whether an ARN names a person (an AppInstanceUser). */
export function isPersonArn(arn: string | null | undefined): boolean {
  return personIdFromArn(arn) !== null;
}

/** Whether an ARN names an assistant (an AppInstanceBot). */
export function isAssistantArn(arn: string | null | undefined): boolean {
  return botIdFromArn(arn) !== null;
}

// ── Rosters ─────────────────────────────────────────────────────────────────────────────────────

/** One member of a channel roster, as `ListChannelMemberships` reports it, read once. */
export interface RosterMember extends Principal {
  arn: string;
  name: string;
}

/** The shape of a `ListChannelMemberships` entry this reads: `Member.Arn` and `Member.Name`. */
export interface MembershipLike {
  Member?: { Arn?: string | null; Name?: string | null } | null;
}

/** One `ListChannelMemberships` entry as a roster member. Null when it names no person or assistant. */
export function rosterMember(membership: MembershipLike | null | undefined): RosterMember | null {
  const arn = membership?.Member?.Arn || '';
  const principal = principalFromArn(arn);
  if (!principal) return null;
  return { ...principal, arn, name: membership?.Member?.Name || '' };
}

/** A page of `ListChannelMemberships` entries as roster members, dropping any that name no principal. */
export function rosterOf(memberships: ReadonlyArray<MembershipLike> | null | undefined): RosterMember[] {
  const out: RosterMember[] = [];
  for (const m of memberships || []) {
    const member = rosterMember(m);
    if (member) out.push(member);
  }
  return out;
}

// ── The admin-plane twin ────────────────────────────────────────────────────────────────────────

/**
 * The resource tag an admin-plane twin carries, naming the AppInstanceUser ARN of the person it belongs
 * to. Written by the credential exchange, which is the only creator of a twin; offboarding finds a
 * person's twin by it, and so does any reader that can read tags.
 */
export const ADMIN_TWIN_OWNER_TAG = 'owner';

const ADMIN_TWIN_SUFFIX = '-admin';

/**
 * The AppInstanceUser id of `personId`'s admin-plane twin: a second principal the same human holds for
 * cross-conversation administration (SPEC-ADMIN-IDENTITY), created only by the credential exchange.
 */
export function adminTwinIdFor(personId: string): string {
  return `${personId}${ADMIN_TWIN_SUFFIX}`;
}

/**
 * The person id an admin-plane twin belongs to, for a reader that cannot read the twin's `owner` tag
 * (the archival path runs with no route to the Amazon Chime SDK). Null for an id that is not a twin.
 * `serviceAdminId` is the deployment's own service admin, which shares the suffix and has no owner.
 */
export function adminTwinOwnerId(id: string | null | undefined, serviceAdminId?: string): string | null {
  if (typeof id !== 'string' || id === serviceAdminId || !id.endsWith(ADMIN_TWIN_SUFFIX)) return null;
  const owner = id.slice(0, -ADMIN_TWIN_SUFFIX.length);
  return owner || null;
}
