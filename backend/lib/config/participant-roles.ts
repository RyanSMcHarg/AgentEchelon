/**
 * PARTICIPANT ROLES, AS A CONVERSATION TYPE DECLARES THEM (DESIGN-CONVERSATION-TYPES section 6.1, SPEC-CONVERSATION-TYPES
 * FR30 and FR31, ADR-061 slice 3).
 *
 * A participant role is a function a person holds in one conversation: an incident room's lead, a meeting's organizer.
 * It is declared on the type (`participants.participantRoles`), resolved from a declared source, recorded on the
 * conversation's server-only channel-context row (`participantRoles`), and read by the variable resolver
 * (`participant:role`, `participantRole:<name>`), by an event workflow's audience and mentions, and by the invitations
 * path. It is not an assistant role (ADR-048) and not an IAM role, and it grants nothing: a type decides experience and
 * a classification decides reach (tenets P4 and D2).
 *
 * This module is pure: the declarations as read, and every rule synthesis applies to them. The holdings are
 * `lambda/src/lib/participant-roles.ts`.
 */
import {
  CONVERSATION_TYPES,
  classificationAllowedForType,
  invitationPolicyOf,
  type ConversationTypeConfig,
  type ParticipantRoleDeclaration,
  type ParticipantRoleSource,
} from './conversation-types';

/** A participant role's name: `lead`, `organizer`, `on-call:network`. Never a colon at the start, never spaces. */
export const PARTICIPANT_ROLE_NAME = /^[a-z][a-z0-9-]{0,31}(:[a-z0-9-]{1,32})?$/;
/** The most participant roles one type declares. */
export const MAX_PARTICIPANT_ROLES = 16;
/** The most holders a multi-person participant-role audience addresses before it sends nothing (ADR-061 decision 3). */
export const PARTICIPANT_ROLE_AUDIENCE_CAP = 10;

/** The kind of a source, as the holdings record it as each holding's origin. */
export type ParticipantRoleSourceKind = 'event' | 'group' | 'resolveVia' | 'invitation' | 'creator' | 'host';

export function sourceKindOf(source: ParticipantRoleSource): ParticipantRoleSourceKind | undefined {
  const keys = Object.keys(source ?? {});
  for (const k of ['event', 'group', 'resolveVia', 'invitation', 'creator', 'host'] as const) if (keys.includes(k)) return k;
  return undefined;
}

/**
 * THE SOURCES NO PATH RESOLVES YET, each with what is missing. Synthesis refuses a declaration naming one, so a type
 * never declares a role that nothing fills.
 */
export const NOT_BUILT_ROLE_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  resolveVia: 'no vendor adapter implements lookupRole, so no connector can answer who holds a role',
});

/** The roles of a type some `{ host: true }` source fills, read over `memberIdentities[].role` and never stored. */
export function hostSourcedRoles(typeKey: string | null | undefined): string[] {
  return Object.entries(participantRolesOf(typeKey)).filter(([, d]) => d.from.some((s) => 'host' in s && s.host === true)).map(([r]) => r);
}

/** Every group some participant role of a type permitting this classification is sourced from. */
export function roleGroups(classification: string): string[] {
  return [...new Set(groupSourcedRoles((k) => classificationAllowedForType(k, classification)).map((r) => r.group))].sort();
}

/** A template name a role confers: the message and prompt template grammar (ADR-062). */
const TEMPLATE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * EVERY GROUP-SOURCED ROLE OF THE TYPES THAT PERMIT A CLASSIFICATION: what the membership reconcile keeps equal to its
 * group, and the groups whose change it listens for beside the membership sources.
 */
export function groupSourcedRoles(permits: (typeKey: string) => boolean): Array<{ typeKey: string; role: string; group: string; decl: ParticipantRoleDeclaration }> {
  const out: Array<{ typeKey: string; role: string; group: string; decl: ParticipantRoleDeclaration }> = [];
  for (const typeKey of Object.keys(CONVERSATION_TYPES)) {
    if (!permits(typeKey)) continue;
    for (const [role, decl] of Object.entries(participantRolesOf(typeKey))) {
      const source = decl.from.find((f) => sourceKindOf(f) === 'group') as { group: string } | undefined;
      if (source && typeof source.group === 'string') out.push({ typeKey, role, group: source.group, decl });
    }
  }
  return out;
}

/** A type's participant roles, by name. An unknown type declares none. */
export function participantRolesOf(typeKey: string | undefined | null): Readonly<Record<string, ParticipantRoleDeclaration>> {
  return (typeKey && CONVERSATION_TYPES[typeKey]?.participants?.participantRoles) || {};
}

/** One declared participant role of a type, or undefined. */
export function participantRoleOf(typeKey: string | undefined | null, name: string): ParticipantRoleDeclaration | undefined {
  const roles = participantRolesOf(typeKey);
  return Object.prototype.hasOwnProperty.call(roles, name) ? roles[name] : undefined;
}

/** The role a member no source names holds, when the type declares one. */
export function defaultRoleOf(typeKey: string | undefined | null): string | undefined {
  const d = typeKey ? CONVERSATION_TYPES[typeKey]?.participants?.defaultRole : undefined;
  return d && participantRoleOf(typeKey, d) ? d : undefined;
}

/** Whether a role may be addressed and read as a person-list (`confers.audience`, default true). */
export const isAudienceRole = (decl: ParticipantRoleDeclaration | undefined): boolean => !!decl && decl.confers?.audience !== false;

/**
 * Every participant role name the given types declare, or every registered type's when none are given: the closed
 * value set of `participant:role`, and the names `participantRole:<name>` may take.
 */
export function declaredParticipantRoleNames(types?: readonly string[], opts: { audienceOnly?: boolean } = {}): string[] {
  const names = new Set<string>();
  for (const key of types ?? Object.keys(CONVERSATION_TYPES)) {
    for (const [name, decl] of Object.entries(participantRolesOf(key))) {
      if (!opts.audienceOnly || isAudienceRole(decl)) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * An invitation may record this role in a conversation of this type: the type declares it `invitable`, its sources
 * include `invitation`, and the type declares invitations.
 */
export function invitableRoleOf(typeKey: string | null | undefined, name: string): ParticipantRoleDeclaration | undefined {
  const decl = participantRoleOf(typeKey, name);
  if (!decl?.invitable || !typeKey || !invitationPolicyOf(typeKey)) return undefined;
  return decl.from.some((s) => sourceKindOf(s) === 'invitation') ? decl : undefined;
}

/** What decides whether a room a guest or a link session reads is mixed trust. */
export interface MixedTrustContext {
  /** The classifications whose audience is outside the deployment's own people (`outsideClassificationValues()`). */
  outside?: readonly string[];
  /** An issuer's kind by its registry id, where the caller has the registry. */
  issuerKind?: (id: string) => string | undefined;
}

/** The issuer kinds whose people are not the deployment's own signed-in people. */
const OUTSIDE_ISSUER_KINDS: readonly string[] = ['guest', 'invitation-link', 'host-assertion'];

/**
 * A ROOM A GUEST OR A LINK SESSION MAY READ (SPEC-CONVERSATION-SECURITY Layer 7, FR16): the type may carry an outside
 * classification, its invitations admit `link` redemption, or it names an issuer whose people are not the deployment's
 * own. A holding is said in such a room only when its role declares `visibleToGuests`.
 */
export function typeIsMixedTrust(typeKey: string | undefined | null, ctx: MixedTrustContext = {}): boolean {
  const config: ConversationTypeConfig | undefined = typeKey ? CONVERSATION_TYPES[typeKey] : undefined;
  if (!config) return false;
  if ((config.classifications ?? []).some((c) => (ctx.outside ?? ['guest', 'customer']).includes(c))) return true;
  if (invitationPolicyOf(typeKey!)?.modes.includes('link')) return true;
  return (config.admitsIssuers ?? []).some((id) => OUTSIDE_ISSUER_KINDS.includes(ctx.issuerKind?.(id) ?? ''));
}

/** Whether a holding of this role may be said in a room message of this type. */
export function roleSaidInRoom(typeKey: string | undefined | null, name: string, ctx: MixedTrustContext = {}): boolean {
  const decl = participantRoleOf(typeKey, name);
  if (!decl) return false;
  return !typeIsMixedTrust(typeKey, ctx) || decl.visibleToGuests === true;
}

/** What synthesis checks the declarations against. */
export interface ParticipantRoleContext extends MixedTrustContext {
  /** The membership groups the deployment declares (`membershipGroups()`). */
  membershipGroups?: Readonly<Record<string, string>>;
  /** The connectors the registry declares, with what each is used for. */
  connectors?: ReadonlyArray<{ id: string; capabilities: readonly string[] }>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * EVERY REASON A TYPE'S PARTICIPANT ROLES CANNOT BE SYNTHESIZED, as sentences. Empty when they can. The rules are
 * DESIGN-CONVERSATION-TYPES section 6.1's, and a source or a conferral no path reads yet is refused with what is missing.
 */
export function participantRoleDeclarationErrors(
  types: Readonly<Record<string, ConversationTypeConfig>> = CONVERSATION_TYPES,
  ctx: ParticipantRoleContext = {},
): string[] {
  const errs: string[] = [];
  for (const [typeKey, config] of Object.entries(types)) {
    const p = config.participants;
    const roles = p?.participantRoles;
    if (roles === undefined) {
      if (p?.defaultRole !== undefined) errs.push(`type '${typeKey}' names defaultRole '${p.defaultRole}' and declares no participant roles`);
      continue;
    }
    if (!isObj(roles)) { errs.push(`type '${typeKey}': participants.participantRoles maps a role name to its declaration`); continue; }
    const names = Object.keys(roles);
    if (names.length > MAX_PARTICIPANT_ROLES) errs.push(`type '${typeKey}' declares ${names.length} participant roles; at most ${MAX_PARTICIPANT_ROLES}`);
    if (p?.defaultRole !== undefined && !names.includes(p.defaultRole)) errs.push(`type '${typeKey}': defaultRole '${p.defaultRole}' is not one of its participant roles`);
    const openerFields = (config.openedBy ?? []).map((o) => ({ ...(o.fields ?? {}), ...(o.values ?? {}) }));
    const mixed = typeIsMixedTrust(typeKey, ctx);
    const invitations = invitationPolicyOf(typeKey);
    const typeConnectors = new Set((p?.resolveVia ?? []).map((r) => r.connectorId));
    for (const name of names) {
      const at = `type '${typeKey}' participant role '${name}'`;
      const decl = roles[name] as ParticipantRoleDeclaration;
      if (!PARTICIPANT_ROLE_NAME.test(name)) errs.push(`${at}: a name is lowercase letters, digits and hyphens, optionally <role>:<qualifier>`);
      if (!isObj(decl) || !Array.isArray(decl.from)) { errs.push(`${at}: declares from, its sources in order`); continue; }
      if (decl.holders !== undefined && decl.holders !== 'one' && decl.holders !== 'many') errs.push(`${at}: holders is one or many`);
      if (!decl.from.length && p?.defaultRole !== name) errs.push(`${at}: names no source, and only the type's defaultRole may`);
      const kinds = new Set<ParticipantRoleSourceKind>();
      for (const [i, source] of decl.from.entries()) {
        const sat = `${at} from[${i}]`;
        const kind = isObj(source) ? sourceKindOf(source as ParticipantRoleSource) : undefined;
        if (!kind) { errs.push(`${sat}: is one of event, group, resolveVia, invitation, creator or host`); continue; }
        kinds.add(kind);
        if (kind === 'event') {
          const field = (source as { event: unknown }).event;
          if (field !== 'forPerson') errs.push(`${sat}: event names forPerson, the one person field an opening event carries`);
          else if (!openerFields.length) errs.push(`${sat}: an event source needs a type an event opens (openedBy)`);
          else if (openerFields.some((f) => !f.forPerson)) errs.push(`${sat}: an opener of this type does not map forPerson`);
        } else if (kind === 'group') {
          const group = (source as { group: unknown }).group;
          if (typeof group !== 'string' || !(ctx.membershipGroups && group in ctx.membershipGroups)) errs.push(`${sat}: group '${String(group)}' is not a declared membership group`);
        } else if (kind === 'resolveVia') {
          const s = source as { resolveVia: unknown; op?: unknown };
          const id = typeof s.resolveVia === 'string' ? s.resolveVia : '';
          if (s.op !== 'lookupRole') errs.push(`${sat}: a resolveVia source names op lookupRole`);
          if (!typeConnectors.has(id)) errs.push(`${sat}: connector '${id}' is not in this type's participants.resolveVia`);
          const declared = ctx.connectors?.find((c) => c.id === id);
          if (!declared?.capabilities.includes('lookupRole')) errs.push(`${sat}: connector '${id}' is not declared in the registry with the lookupRole capability`);
        } else if (kind === 'invitation') {
          if (!invitations) errs.push(`${sat}: an invitation source needs a type that declares invitations`);
        } else if (kind === 'creator') {
          // THE PERSON WHOSE CONFIRMATION OPENED THE CONVERSATION (an `open_conversation` proposal's apply), which the
          // creator records; a type the platform opens on its own is opened on nobody's confirmation.
          if ((source as { creator: unknown }).creator !== true) errs.push(`${sat}: a creator source is { creator: true }`);
          if (config.initiation === 'system') errs.push(`${sat}: a creator source needs a type a person's confirmed proposal opens, and the platform opens this one on its own`);
        } else if (kind === 'host') {
          // THE ROLE A CREATING APPLICATION ASSERTED for each member it named (`memberIdentities[].role`), read when the
          // holdings are read and never stored.
          if ((source as { host: unknown }).host !== true) errs.push(`${sat}: a host source is { host: true }`);
        }
        if (NOT_BUILT_ROLE_SOURCES[kind]) errs.push(`${sat}: a ${kind} source is NOT BUILT: ${NOT_BUILT_ROLE_SOURCES[kind]}`);
      }
      if (decl.invitable === true && !kinds.has('invitation')) errs.push(`${at}: invitable needs an invitation source`);
      const confers = decl.confers;
      if (confers !== undefined && !isObj(confers)) errs.push(`${at}: confers is an object`);
      for (const key of ['template', 'brief'] as const) {
        const named = isObj(confers) ? (confers as Record<string, unknown>)[key] : undefined;
        if (named !== undefined && (typeof named !== 'string' || !TEMPLATE_NAME.test(named))) errs.push(`${at}: confers.${key} names a ${key === 'brief' ? 'prompt' : 'message'} template`);
      }
      // A ROLE AS A MEMBER (FR31) adds its holders, which a type that keeps its room equal to a membership source would
      // remove again on its next reconcile: the two cannot both hold, so the declaration is refused.
      if (decl.adds === true && config.membershipSource) {
        errs.push(`${at}: adds its holders, and the type's membership source keeps its room equal to that source, so the reconcile would remove them`);
      }
      if (decl.adds === true && !kinds.has('group')) errs.push(`${at}: adds needs a source that names people who are not members yet (group)`);
      // A HOST'S ASSERTION NEVER DECIDES: a role it fills confers nothing and is never said to the room.
      if (kinds.has('host') && (confers !== undefined || decl.visibleToGuests !== undefined)) {
        errs.push(`${at}: a role with a host source confers nothing and declares no visibleToGuests (it is member trust)`);
      }
      // MODERATION IS A POWER OVER THE ROOM, so a source a vendor or an outsider can fill never confers it.
      if (confers?.moderator === true) {
        if (kinds.has('resolveVia')) errs.push(`${at}: confers moderator, which a resolveVia source never fills`);
        if ((kinds.has('invitation') || kinds.has('event')) && mixed) {
          errs.push(`${at}: confers moderator, and an invitation or event source on a type a guest or a link session reads never fills it`);
        }
      }
    }
  }
  return errs;
}

/** Synthesis refuses any participant-role declaration that cannot be built. */
export function assertParticipantRolesAreDeclared(ctx: ParticipantRoleContext): void {
  const errs = participantRoleDeclarationErrors(CONVERSATION_TYPES, ctx);
  if (errs.length) throw new Error(`conversation types declare participant roles that cannot be built:\n  - ${errs.join('\n  - ')}`);
}
