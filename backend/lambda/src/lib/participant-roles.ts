/**
 * WHO HOLDS WHICH PARTICIPANT ROLE IN ONE CONVERSATION (DESIGN-CONVERSATION-TYPES section 6.1).
 *
 * The holdings live on the conversation's server-only channel-context row, as `participantRoles`: each role name maps
 * the AppInstanceUser ids that hold it (tenet D14) to the holding's origin, the kind of source that named them, and,
 * where the holding made the person a moderator, the moderation's origin `participantRole:<name>`. The row is the one
 * source a reader asks (tenet D7). Channel Metadata is never read for a holding: any moderating member can write it, and
 * a holding decides which message a person receives and whether they moderate.
 *
 * Readers take the holdings through `holdersByRole`, which keeps only the roles the conversation's type declares and
 * only people who are members now, so a former holder who left is addressed by nothing. A member no source names holds
 * the type's `defaultRole`, which is applied here, over the live roster, and never stored.
 */
import {
  defaultRoleOf,
  hostSourcedRoles,
  participantRoleOf,
  participantRolesOf,
  type ParticipantRoleSourceKind,
} from '../../../lib/config/participant-roles.js';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { personIdFromArn } from './person-arn.js';

/** One person's holding of one role. */
export interface ParticipantRoleHolding {
  /** The kind of source that named them. */
  origin: ParticipantRoleSourceKind;
  /** Present when the holding made them a moderator: `participantRole:<name>`. Only a moderation of this origin is removed with the holding. */
  moderation?: string;
}

/** The `participantRoles` field of the channel-context row: role name to person id to holding. */
export type ParticipantRoleHoldings = Record<string, Record<string, ParticipantRoleHolding>>;

/** The moderation origin a role's conferral records. */
export const moderationOrigin = (role: string): string => `participantRole:${role}`;

const ORIGINS: readonly ParticipantRoleSourceKind[] = ['event', 'group', 'resolveVia', 'invitation', 'creator', 'host'];
const PERSON_ID = /^[A-Za-z0-9._-]{1,128}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The holdings as stored, kept to what the conversation's type declares: a role the type does not declare, a person id
 * that is not one, and a holding with no known origin are dropped. A `host` holding is never read here: a host's
 * assertion is member trust and decides nothing.
 */
export function parseHoldings(raw: unknown, typeKey: string | null | undefined): ParticipantRoleHoldings {
  const out: ParticipantRoleHoldings = {};
  if (!isObj(raw)) return out;
  for (const [role, people] of Object.entries(raw)) {
    if (!participantRoleOf(typeKey, role) || !isObj(people)) continue;
    for (const [personId, h] of Object.entries(people)) {
      if (!PERSON_ID.test(personId) || !isObj(h)) continue;
      const origin = h.origin as ParticipantRoleSourceKind;
      if (!ORIGINS.includes(origin) || origin === 'host') continue;
      (out[role] ??= {})[personId] = { origin, ...(typeof h.moderation === 'string' ? { moderation: h.moderation } : {}) };
    }
  }
  return out;
}

/**
 * THE HOLDINGS A CREATION RECORDS, from the sources resolved at creation: the opening event's person
 * (`{ event: 'forPerson' }`) and a declared group's admitted people (`{ group }`), of whom only those the room admits
 * hold the role unless it `adds` them. Each role tries its own sources in order, and the first that names anyone decides.
 */
export function holdingsAtCreation(
  typeKey: string,
  named: {
    forPerson?: string; groups?: Readonly<Record<string, readonly string[]>>; members?: readonly string[];
    /** The person whose confirmation of an `open_conversation` proposal opened it, who holds each `{ creator: true }` role. */
    creator?: string;
  },
): ParticipantRoleHoldings {
  const out: ParticipantRoleHoldings = {};
  const members = new Set(named.members ?? []);
  for (const [role, decl] of Object.entries(participantRolesOf(typeKey))) {
    for (const source of decl.from) {
      if ('event' in source && source.event === 'forPerson') {
        const id = personIdFromArn(named.forPerson);
        if (!id) continue;
        out[role] = { [id]: { origin: 'event' } };
        break;
      }
      if ('creator' in source && source.creator === true) {
        const id = personIdFromArn(named.creator);
        if (!id) continue;
        out[role] = { [id]: { origin: 'creator' } };
        break;
      }
      if ('group' in source) {
        const people = (named.groups?.[source.group] ?? []).filter((arn) => decl.adds || members.has(arn));
        const ids = people.map((arn) => personIdFromArn(arn)).filter((id): id is string => !!id);
        if (!ids.length) continue;
        out[role] = Object.fromEntries(ids.map((id) => [id, { origin: 'group' as const }]));
        break;
      }
    }
  }
  return out;
}

/**
 * The people a creation adds because a role that `adds` names them (FR31): each group-sourced role's admitted people
 * who are not members yet, through the same admission the group resolution applied.
 */
export function holdersToAdd(typeKey: string, groups: Readonly<Record<string, readonly string[]>>, members: readonly string[]): string[] {
  const have = new Set(members);
  const out = new Set<string>();
  for (const decl of Object.values(participantRolesOf(typeKey))) {
    if (!decl.adds) continue;
    for (const source of decl.from) if ('group' in source) for (const arn of groups[source.group] ?? []) if (!have.has(arn)) out.add(arn);
  }
  return [...out];
}

/**
 * ONE GROUP-SOURCED ROLE'S HOLDINGS, KEPT EQUAL TO ITS GROUP (DESIGN-CONVERSATION-TYPES section 6.1): every admitted person
 * who is a member holds it, a person who left the group does not, and a person whose groups could not be read keeps
 * whatever they held, as the membership reconcile leaves them where they are. A holding of another origin is kept, and a
 * kept group holding keeps its moderation's origin.
 */
export function groupRoleHoldings(
  current: Readonly<Record<string, ParticipantRoleHolding>> | undefined,
  args: { admitted: ReadonlySet<string>; undetermined: ReadonlySet<string>; members: readonly string[] },
): Record<string, ParticipantRoleHolding> {
  const out: Record<string, ParticipantRoleHolding> = {};
  const undeterminedIds = new Set([...args.undetermined].map((a) => personIdFromArn(a)).filter(Boolean) as string[]);
  for (const [id, h] of Object.entries(current ?? {})) {
    if (h.origin !== 'group' || undeterminedIds.has(id)) out[id] = h;
  }
  for (const arn of args.members) {
    if (!args.admitted.has(arn)) continue;
    const id = personIdFromArn(arn);
    if (id) out[id] = current?.[id]?.origin === 'group' ? current[id] : (out[id] ?? { origin: 'group' });
  }
  return out;
}

/**
 * THE HOLDERS OF EACH ROLE WHO ARE MEMBERS NOW, as AppInstanceUser ARNs, from the row's holdings and the live roster.
 * A `holders: 'one'` role takes its first holder. Every member no source names holds the type's `defaultRole`.
 * `members` are the conversation's people (assistants excluded), as the caller read them.
 */
export function holdersByRole(
  rawHoldings: unknown,
  typeKey: string | null | undefined,
  members: readonly string[],
): Record<string, string[]> {
  const holdings = parseHoldings(rawHoldings, typeKey);
  const byId = new Map<string, string>();
  for (const arn of members) {
    const id = personIdFromArn(arn);
    if (id) byId.set(id, arn);
  }
  const out: Record<string, string[]> = {};
  const named = new Set<string>();
  for (const [role, people] of Object.entries(holdings)) {
    const arns = Object.keys(people).map((id) => byId.get(id)).filter((a): a is string => !!a);
    for (const id of Object.keys(people)) named.add(id);
    const one = participantRoleOf(typeKey, role)?.holders === 'one';
    out[role] = one ? arns.slice(0, 1) : arns;
  }
  const fallback = defaultRoleOf(typeKey);
  if (fallback) {
    const unnamed = [...byId.entries()].filter(([id]) => !named.has(id)).map(([, arn]) => arn);
    out[fallback] = [...(out[fallback] ?? []), ...unnamed];
  }
  return out;
}

/**
 * THE ROLES A CREATING APPLICATION ASSERTED (the `host` source, DESIGN-CONVERSATION-TYPES section 6.1): each role the type
 * fills from `{ host: true }`, held by the members whose `memberIdentities[].role` on the channel-context row names it,
 * read here and never stored. An entry names a person by the issuer's subject, which becomes a person only through
 * Identities (`resolve`, as at sign-in), or by the person id itself where it names no issuer. Only a member counts, so a
 * tampered entry adds nobody. A role whose stored holdings already name someone keeps them: a role's sources are tried
 * in order and the first that names anyone decides.
 *
 * MEMBER TRUST: a host's assertion addresses and is mentioned, and never decides. The caller keeps these holdings out
 * of what a condition reads (`decidingRoles`).
 */
export async function hostRoleHoldings(
  memberIdentities: unknown,
  typeKey: string | null | undefined,
  members: readonly string[],
  resolve: (iss: string, sub: string) => Promise<string | null | undefined>,
): Promise<Record<string, string[]>> {
  const roles = new Set(hostSourcedRoles(typeKey));
  if (!roles.size || !Array.isArray(memberIdentities)) return {};
  const byId = new Map<string, string>();
  for (const arn of members) { const id = personIdFromArn(arn); if (id) byId.set(id, arn); }
  const out: Record<string, string[]> = {};
  for (const entry of memberIdentities.slice(0, 200)) {
    if (!isObj(entry) || typeof entry.sub !== 'string' || !entry.sub || typeof entry.role !== 'string' || !roles.has(entry.role)) continue;
    const id = typeof entry.iss === 'string' && entry.iss
      ? personIdFromArn(await resolve(entry.iss, entry.sub).catch(() => null) ?? undefined)
      : entry.sub;
    const arn = id ? byId.get(id) : undefined;
    if (arn && !(out[entry.role] ?? []).includes(arn)) (out[entry.role] ??= []).push(arn);
  }
  for (const [role, arns] of Object.entries(out)) if (participantRoleOf(typeKey, role)?.holders === 'one') out[role] = arns.slice(0, 1);
  return out;
}

/**
 * The holdings with a host's assertions added (`hostRoleHoldings`): a host-sourced role the stored holdings fill nobody
 * for takes its asserted holders, who then no longer hold the type's `defaultRole`.
 */
export function withHostHoldings(
  byRole: Readonly<Record<string, readonly string[]>>,
  host: Readonly<Record<string, readonly string[]>>,
  typeKey: string | null | undefined,
): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(Object.entries(byRole).map(([r, a]) => [r, [...a]]));
  const added = new Set<string>();
  for (const [role, arns] of Object.entries(host)) {
    if ((out[role] ?? []).length && role !== defaultRoleOf(typeKey)) continue;
    out[role] = [...arns];
    for (const a of arns) added.add(a);
  }
  const fallback = defaultRoleOf(typeKey);
  if (fallback && !(fallback in host)) out[fallback] = (out[fallback] ?? []).filter((a) => !added.has(a));
  return out;
}

/** The roles one person holds, from `holdersByRole`. */
export function rolesOfPerson(byRole: Readonly<Record<string, readonly string[]>>, personArn: string | undefined): string[] {
  if (!personArn) return [];
  return Object.entries(byRole).filter(([, arns]) => arns.includes(personArn)).map(([role]) => role).sort();
}

type Sender = { send(command: unknown): Promise<unknown> };

/**
 * RECORD ONE HOLDING on the row, without disturbing the others: three updates, the first two creating only what is
 * missing, so concurrent recordings for two people or two roles never overwrite each other. Throws on a store
 * failure, so the caller decides what an unrecorded holding means.
 *
 * `onlyHolder` (a `holders: 'one'` role): the holding is written only where the role holds nobody else, in the same
 * conditional write, so two people given the role at once cannot both hold it. The loser's write throws
 * `ConditionalCheckFailedException` (`isRoleHeldElsewhere`). Re-writing this person's own holding is allowed.
 */
export async function recordHolding(
  doc: Sender,
  table: string,
  channelArn: string,
  role: string,
  personId: string,
  holding: ParticipantRoleHolding,
  opts: { onlyHolder?: boolean } = {},
): Promise<void> {
  const Key = { channelArn };
  const names = { '#pr': 'participantRoles', '#r': role, '#p': personId };
  await doc.send(new UpdateCommand({
    TableName: table, Key, UpdateExpression: 'SET #pr = if_not_exists(#pr, :empty)',
    ExpressionAttributeNames: { '#pr': 'participantRoles' }, ExpressionAttributeValues: { ':empty': {} },
  }));
  await doc.send(new UpdateCommand({
    TableName: table, Key, UpdateExpression: 'SET #pr.#r = if_not_exists(#pr.#r, :empty)',
    ExpressionAttributeNames: { '#pr': 'participantRoles', '#r': role }, ExpressionAttributeValues: { ':empty': {} },
  }));
  await doc.send(new UpdateCommand({
    TableName: table, Key, UpdateExpression: 'SET #pr.#r.#p = :h',
    ExpressionAttributeNames: names,
    ...(opts.onlyHolder
      ? { ConditionExpression: 'size(#pr.#r) = :none OR attribute_exists(#pr.#r.#p)', ExpressionAttributeValues: { ':h': holding, ':none': 0 } }
      : { ExpressionAttributeValues: { ':h': holding } }),
  }));
}

/** Whether a holding's write was refused because a one-holder role is held by somebody else. */
export function isRoleHeldElsewhere(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ConditionalCheckFailedException';
}

/** Replace one role's holdings on the row, leaving every other role's alone. Throws on a store failure. */
export async function setRoleHoldings(
  doc: Sender, table: string, channelArn: string, role: string, holdings: Readonly<Record<string, ParticipantRoleHolding>>,
): Promise<void> {
  await doc.send(new UpdateCommand({
    TableName: table, Key: { channelArn }, UpdateExpression: 'SET #pr = if_not_exists(#pr, :empty)',
    ExpressionAttributeNames: { '#pr': 'participantRoles' }, ExpressionAttributeValues: { ':empty': {} },
  }));
  await doc.send(new UpdateCommand({
    TableName: table, Key: { channelArn }, UpdateExpression: 'SET #pr.#r = :h',
    ExpressionAttributeNames: { '#pr': 'participantRoles', '#r': role }, ExpressionAttributeValues: { ':h': holdings },
  }));
}

/** Remove one holding from the row. A holding that is not there is nothing to remove. */
export async function removeHolding(
  doc: Sender,
  table: string,
  channelArn: string,
  role: string,
  personId: string,
): Promise<void> {
  try {
    await doc.send(new UpdateCommand({
      TableName: table, Key: { channelArn }, UpdateExpression: 'REMOVE #pr.#r.#p',
      ConditionExpression: 'attribute_exists(#pr.#r.#p)',
      ExpressionAttributeNames: { '#pr': 'participantRoles', '#r': role, '#p': personId },
    }));
  } catch (err) {
    if ((err as { name?: string })?.name !== 'ConditionalCheckFailedException') throw err;
  }
}
