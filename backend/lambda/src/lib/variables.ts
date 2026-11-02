/**
 * A VARIABLE IS DECLARED ONCE, AND ITS TRUST DECIDES WHAT IT MAY DO (ADR-060).
 *
 * The one table of what a classification publishes as a named value (decision 1), the rule that a value's
 * trust decides whether it may be inserted, decide, or both (decision 2), the closed condition language
 * (decision 6), and both layers that hold those rules (decision 3): the validation a version or a template
 * passes when it is stored (`whenErrors`, `insertionErrors`) and the resolver's run-time layer
 * (`decidingValue`, `insertValue`, `conditionHolds`), which holds a declaration written around validation or
 * stored before a rule existed.
 *
 * PURE: no client and no store. Every value is handed in by the call site that read it, under that
 * classification's own grants (decision 4), so this module adds no principal and no grant (tenet D12).
 *
 * What it guarantees:
 *  - A SOURCE IS DECLARED BY THE PLATFORM. The fixed kinds are declared here; every `ctx:<source>.<field>` is
 *    built from the classification's published context-source catalog, so a new catalog entry is a new source
 *    with no code change. A version names sources and cannot declare one, change a trust or clear
 *    `describesPerson`.
 *  - MEMBER TEXT NEVER DECIDES (tenet D11). A member-trust value is inserted stripped, capped and unable to
 *    close a delimiter, and a condition on it is refused at validation and does not hold at run time.
 *  - AN UNRESOLVED VALUE MAKES EVERY OPERATOR FALSE, `ne` and `exists` included, so a failed read never
 *    selects a path written for a value. A value not settled at a call site is unresolved, never awaited.
 *  - A FACT ABOUT A PERSON REACHES ONLY THAT PERSON (decision 7). A room message carries a person's display
 *    name only as an inert mention of a member; every other person-describing value renders empty there and
 *    a condition on one does not hold there.
 *  - A REFUSAL IS LOGGED BY VARIABLE NAME, NEVER BY VALUE.
 */
import { REPLY_PREFERENCES, type ReplyPreference } from '../../../lib/config/reply-preferences.js';
import { CONVERSATION_TYPES } from '../../../lib/config/conversation-types.js';
import { declaredParticipantRoleNames, participantRolesOf } from '../../../lib/config/participant-roles.js';
import type { CallSiteCapabilities, PublishedContextSource } from './context-source-shapes.js';
import { cleanMessageValue, fieldsIn } from './message-template.js';
import type { MessageValueType } from './document-template.js';
import { inertMention } from './message-markers.js';
import { VARIABLE_BINDING_KINDS, VARIABLE_NAME } from './step-bindings.js';
import { fieldTrust } from '../../../lib/config/context-source-trust.js';
import { deploymentLanguages, resolveLanguageTag } from '../../../lib/config/languages.js';

// ── Decision 1: the source table ───────────────────────────────────────────────────────────────

/** The typed values the resolver returns (decision 4). A set and a person-list are lists of strings. */
export type VariableType = 'string' | 'number' | 'boolean' | 'enum' | 'set' | 'person-list';

/**
 * Who supplied a value, which decides what it may do (decision 2). `closed-enum` is a value a model or a person
 * chose among values the platform declared, at the point it was established.
 */
export type VariableTrust = 'platform' | 'operator' | 'closed-enum' | 'member';

/**
 * The earliest point a source is readable. `person-settled` is readable once the person it describes is
 * known: the sender on a turn (`identitySettled`), or the participant shape's one subject at `WelcomeIntent`
 * (`subjectSettled`), because the shape is written before the channel exists.
 */
export type SourceAvailability = 'always' | 'identity-settled' | 'conversation-settled' | 'person-settled';

export interface VariableSource {
  /** The source as a version names it: `<kind>:<key>`, the step-binding grammar. */
  source: string;
  type: VariableType;
  trust: VariableTrust;
  /** True when the value is a fact about one person, which reaches only that person (decision 7). */
  describesPerson: boolean;
  /** `person:displayName` only: a room message may carry it as an inert mention of a member. */
  mentionable?: boolean;
  availability: SourceAvailability;
  /** An enum's closed set of values, where the platform declares one. */
  values?: readonly string[];
  /** `event:` and `invitation:` fields only: the events at which the field exists. */
  events?: readonly string[];
  /** The type an inserted value is capped and checked as. */
  insertAs: MessageValueType;
  /** Its one source (tenet D7), for the console and for a reviewer. */
  origin: string;
}

/**
 * Every source kind the grammar names, which is the step-binding grammar's variable kinds (`step-bindings.ts`):
 * one grammar for a template field, a version's variable and a step's binding. The kinds with no built source
 * are listed in `NOT_BUILT_SOURCES`.
 */
export const SOURCE_KINDS = VARIABLE_BINDING_KINDS;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** The kind a source string names, or undefined when it names none of the grammar's kinds. */
export function sourceKindOf(source: string): SourceKind | undefined {
  const at = source.indexOf(':');
  if (at <= 0) return undefined;
  const kind = source.slice(0, at);
  return (SOURCE_KINDS as readonly string[]).includes(kind) ? (kind as SourceKind) : undefined;
}

/** The events an invitation names (ADR-061 decision 1): its sending, and the deadline it was still unredeemed at. */
const INVITATION_SOURCE_EVENTS: readonly string[] = Object.freeze(['invitation-sent', 'invitation-unredeemed']);

/** The fixed sources every classification publishes, each read where it lives (decision 1's table). */
export const FIXED_SOURCES: Readonly<Record<string, VariableSource>> = Object.freeze({
  'person:onboarded': {
    source: 'person:onboarded', type: 'boolean', trust: 'platform', describesPerson: true,
    availability: 'person-settled', insertAs: 'text', origin: 'the user-profile store (user-profile-client.ts)',
  },
  'person:displayName': {
    source: 'person:displayName', type: 'string', trust: 'member', describesPerson: true, mentionable: true,
    availability: 'person-settled', insertAs: 'text', origin: 'the directory (membership-source.ts)',
  },
  'person:clearance': {
    source: 'person:clearance', type: 'set', trust: 'platform', describesPerson: true,
    availability: 'person-settled', insertAs: 'text', origin: 'the clearance resolution (user-clearance.ts)',
  },
  'conversation:classification': {
    source: 'conversation:classification', type: 'enum', trust: 'platform', describesPerson: false,
    availability: 'always', insertAs: 'id', origin: "the conversation's immutable classification tag",
  },
  'conversation:type': {
    source: 'conversation:type', type: 'enum', trust: 'platform', describesPerson: false,
    values: Object.freeze(Object.keys(CONVERSATION_TYPES)),
    availability: 'always', insertAs: 'id', origin: 'the channel-context row (ADR-053)',
  },
  'conversation:participants': {
    source: 'conversation:participants', type: 'person-list', trust: 'platform', describesPerson: true,
    availability: 'always', insertAs: 'text', origin: 'the participant shape recorded at creation (participant-shape.ts)',
  },
  'conversation:title': {
    source: 'conversation:title', type: 'string', trust: 'member', describesPerson: false,
    availability: 'conversation-settled', insertAs: 'text', origin: "the channel's name, from the Amazon Chime SDK",
  },
  'conversation:topic': {
    source: 'conversation:topic', type: 'string', trust: 'member', describesPerson: false,
    availability: 'always', insertAs: 'text', origin: 'the channel-context row',
  },
  // WHY THIS CONVERSATION EXISTS (the welcome's fields, slice 1c): text the creating flow carried onto the
  // channel-context row, member trust, and the room's own story rather than a fact about one person.
  'conversation:priorSubject': {
    source: 'conversation:priorSubject', type: 'string', trust: 'member', describesPerson: false,
    availability: 'always', insertAs: 'longText', origin: "the channel-context row (a continued conversation's subject label)",
  },
  'conversation:priorMessage': {
    source: 'conversation:priorMessage', type: 'string', trust: 'member', describesPerson: false,
    availability: 'always', insertAs: 'longText', origin: 'the channel-context row (the message that opened this conversation)',
  },
  'conversation:parentRef': {
    source: 'conversation:parentRef', type: 'string', trust: 'member', describesPerson: false,
    availability: 'always', insertAs: 'longText', origin: 'the channel-context row (the link back to the conversation this continues)',
  },
  'conversation:eventSummary': {
    source: 'conversation:eventSummary', type: 'string', trust: 'member', describesPerson: false,
    availability: 'always', insertAs: 'longText', origin: 'the channel-context row (the line the opening event wrote)',
  },
  'conversation:visitSummary': {
    source: 'conversation:visitSummary', type: 'string', trust: 'member', describesPerson: false,
    availability: 'always', insertAs: 'longText', origin: 'the channel-context row (the line a carried-over visit wrote)',
  },
  'host:userName': {
    source: 'host:userName', type: 'string', trust: 'member', describesPerson: true,
    availability: 'always', insertAs: 'text', origin: 'the channel-context row written at creation',
  },
  'host:participantProfile': {
    source: 'host:participantProfile', type: 'string', trust: 'member', describesPerson: true,
    availability: 'always', insertAs: 'longText', origin: 'the channel-context row written at creation',
  },
  // THE ROLE A CREATING APPLICATION ASSERTED FOR A MEMBER (`memberIdentities[].role` on the channel-context row): member
  // trust, so it is inserted into a message addressed to that person and never decides (ADR-060 decision 2).
  'host:role': {
    source: 'host:role', type: 'string', trust: 'member', describesPerson: true,
    availability: 'person-settled', insertAs: 'text', origin: 'the channel-context row (memberIdentities[].role, written at creation)',
  },
  'signal:userLanguage': {
    source: 'signal:userLanguage', type: 'enum', trust: 'platform', describesPerson: false,
    availability: 'always', insertAs: 'id', origin: 'the routing context on the channel-context row',
  },
  // THE PERSON'S OWN LANGUAGE (ADR-062 decision 4): a choice among the languages the deployment declares, made by the
  // person in their language setting and stored as the declared tag in the user-profile store's preferences. A closed
  // enum, so it may decide; it describes the person, so it reaches only a message addressed to them (decision 7).
  'person:preferredLanguage': {
    source: 'person:preferredLanguage', type: 'enum', trust: 'closed-enum', describesPerson: true,
    availability: 'person-settled', insertAs: 'id', origin: "the user-profile store's preferences (preferredLanguage, user-profile-client.ts)",
  },
  // THE INVITATION `invitation-sent` AND `invitation-unredeemed` NAME (ADR-061 decision 1), read by the router from its
  // `Tokens` record when it verifies the event, so each exists at those events only. The inviter and the invitee are AppInstanceUsers the record
  // names, platform trust; the reason is the line the inviter typed, member text about why the invitee is asked in,
  // inserted only into a message addressed to a person and never deciding.
  'invitation:inviter': {
    source: 'invitation:inviter', type: 'person-list', trust: 'platform', describesPerson: true, events: INVITATION_SOURCE_EVENTS,
    availability: 'always', insertAs: 'text', origin: "the invitation's Tokens record (inviterArn, invitations.ts)",
  },
  'invitation:invitee': {
    source: 'invitation:invitee', type: 'person-list', trust: 'platform', describesPerson: true, events: INVITATION_SOURCE_EVENTS,
    availability: 'always', insertAs: 'text', origin: "the invitation's Tokens record (personArn, invitations.ts)",
  },
  'invitation:reason': {
    source: 'invitation:reason', type: 'string', trust: 'member', describesPerson: true, events: INVITATION_SOURCE_EVENTS,
    availability: 'always', insertAs: 'longText', origin: "the invitation's Tokens record (reason, the line the inviter gave)",
  },
} satisfies Record<string, VariableSource>);

/** `fact:<key>`: an onboarding answer, member free text about the person who gave it. */
const FACT_SOURCE: Omit<VariableSource, 'source'> = {
  type: 'string', trust: 'member', describesPerson: true, availability: 'person-settled', insertAs: 'text',
  origin: 'onboarding answers (the user-profile store)',
};
const FACT_KEY = /^fact:[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * A field an event's one source declares (ADR-061). Its trust follows who produced the value: a value the
 * platform computed or resolved is platform trust and may decide; free text carried from the event's payload
 * is member trust, inserted as data and never deciding.
 */
export interface EventFieldDeclaration {
  event: string;
  /** The field, named as `event:<field>`. */
  field: string;
  type: VariableType;
  computedByPlatform: boolean;
  describesPerson: boolean;
  /** An enum's closed set of values, which a condition may name. */
  values?: readonly string[];
  origin: string;
}

/**
 * The event fields built today: the person `conversation-opened` names, resolved to an AppInstanceUser, the person
 * `person-joined` names, verified a member of the conversation, and the invitee `invitation-sent` names, read from the
 * invitation's record.
 */
export const EVENT_FIELDS: readonly EventFieldDeclaration[] = Object.freeze([
  {
    event: 'conversation-opened', field: 'person', type: 'person-list', computedByPlatform: true, describesPerson: true,
    origin: "the verified opening request, resolved to an AppInstanceUser (the router's handleConversationOpened)",
  },
  {
    event: 'person-joined', field: 'person', type: 'person-list', computedByPlatform: true, describesPerson: true,
    origin: "the person the adding path names, verified a member by a live read (the router's handlePersonJoined)",
  },
  {
    event: 'invitation-sent', field: 'person', type: 'person-list', computedByPlatform: true, describesPerson: true,
    origin: "the invitee the invitation's Tokens record names, verified pending (the router's handleInvitationSent)",
  },
  {
    event: 'invitation-unredeemed', field: 'person', type: 'person-list', computedByPlatform: true, describesPerson: true,
    origin: "the invitee the invitation's Tokens record names, verified still pending when its deadline fired (the router's handleDeadlineFired)",
  },
  // THE INCIDENT WATCH (ADR-061 slice 5): the alarm the conversation watches and the state it entered, each read back from
  // CloudWatch by the router before anything runs, so each is platform trust and the state may decide.
  {
    event: 'alarm-state-changed', field: 'alarmName', type: 'string', computedByPlatform: true, describesPerson: false,
    origin: "the alarm the conversation's watch record names, read back from CloudWatch (the router's handleAlarmStateChanged)",
  },
  {
    event: 'alarm-state-changed', field: 'alarmState', type: 'enum', computedByPlatform: true, describesPerson: false,
    values: ['ALARM', 'OK', 'INSUFFICIENT_DATA'],
    origin: "the alarm's state as CloudWatch reports it when the router reads it (the router's handleAlarmStateChanged)",
  },
]);

/**
 * The key a person's language is stored under in the user-profile store's preferences (ADR-060 decision 1), beside the
 * reply preferences and never one of them: it is not a reply instruction, and the registry's readers drop it.
 */
export const PREFERRED_LANGUAGE_KEY = 'preferredLanguage';

/** Sources the grammar names that no record holds yet, each with what is missing. */
export const NOT_BUILT_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  'person:firstSeen': 'no stored field holds it; the archive is its source',
  meeting: 'deferred until the meetings code lands on main',
  task: 'task:state is read only on the edges of the task step that opened the task (ADR-063), and task:assignees has no person-list record',
});

/** The table a classification publishes: every source by its exact name. Built, never hand-listed. */
export interface SourceTable {
  readonly sources: Readonly<Record<string, VariableSource>>;
  /**
   * The `fact:` keys an intake declares, when the caller read them: a `fact:<key>` outside this set is not
   * published. Absent, any well-formed `fact:<key>` is read as member text about the person.
   */
  readonly facts?: ReadonlySet<string>;
}

const CATALOG_TYPES: Readonly<Record<string, VariableType>> = { string: 'string', number: 'number', boolean: 'boolean', 'string[]': 'set' };

/**
 * When a catalog entry is readable, as its variables and its prompt section both read it (decision 4). A source
 * that waits on identity and describes a person waits on THAT person, so the participant shape's one subject at
 * `WelcomeIntent` settles it as the sender settles it on a turn. Undefined for an availability the catalog does not
 * declare, which no call site settles.
 */
export function catalogAvailability(entry: { availability?: unknown; describesPerson?: unknown }): SourceAvailability | undefined {
  switch (entry.availability) {
    case 'always': return 'always';
    case 'conversation-settled': return 'conversation-settled';
    case 'identity-settled': return entry.describesPerson === false ? 'identity-settled' : 'person-settled';
    default: return undefined;
  }
}

/**
 * One `ctx:<source>.<field>` per field of every entry the classification's catalog publishes, with the field's
 * trust (its own where it declares a lower one than its entry, `fieldTrust`) and type. An entry that does not
 * declare `describesPerson` describes a person. An availability the catalog does not declare waits on identity.
 */
function catalogSources(catalog: readonly PublishedContextSource[]): Record<string, VariableSource> {
  const out: Record<string, VariableSource> = {};
  for (const entry of catalog) {
    const describesPerson = entry.describesPerson !== false;
    const availability: SourceAvailability = catalogAvailability(entry) ?? (describesPerson ? 'person-settled' : 'identity-settled');
    for (const [field, f] of Object.entries(entry.fields ?? {})) {
      const type = CATALOG_TYPES[f.type];
      if (!type) continue;
      const source = `ctx:${entry.key}.${field}`;
      out[source] = {
        source, type, trust: fieldTrust(entry, f), describesPerson, availability,
        insertAs: type === 'string' ? 'longText' : 'text',
        origin: `the ${entry.key} context source (${entry.title})`,
      };
    }
  }
  return out;
}

/** A catalog entry as a reader outside the turn holds it: the key, and whatever of the published entry it carries. */
export type VariableCatalogEntry = { key: string; fields?: Readonly<Record<string, { type: string; optional?: boolean; trust?: VariableTrust }>> }
  & Partial<Omit<PublishedContextSource, 'key' | 'fields'>>;

/**
 * A catalog entry the source table can be built from. What the entry does not say is read in the direction that
 * permits least: no trust is member trust (INV-CTX-CAT-2), no `describesPerson` describes a person, and no
 * availability waits on identity.
 */
export function catalogEntryForVariables(e: VariableCatalogEntry): PublishedContextSource {
  return {
    key: e.key,
    title: e.title ?? e.key,
    description: e.description ?? '',
    useWhen: e.useWhen ?? '',
    type: e.type ?? '',
    trust: e.trust === 'platform' || e.trust === 'operator' ? e.trust : 'member',
    availability: e.availability === 'always' || e.availability === 'conversation-settled' ? e.availability : 'identity-settled',
    maxBytes: e.maxBytes ?? 0,
    fields: (e.fields ?? {}) as PublishedContextSource['fields'],
    ...(e.describesPerson === false ? { describesPerson: false } : {}),
  };
}

/** One `pref:<key>` per reply preference, a closed enum of the values the registry declares. */
function preferenceSources(preferences: Readonly<Record<string, ReplyPreference>>): Record<string, VariableSource> {
  return Object.fromEntries(Object.values(preferences).map((p) => [`pref:${p.key}`, {
    source: `pref:${p.key}`, type: 'enum' as const, trust: 'closed-enum' as const, describesPerson: true,
    values: Object.freeze(Object.keys(p.values)), availability: 'person-settled' as const, insertAs: 'id' as const,
    origin: 'the reply-preferences registry (reply-preferences.ts)',
  }]));
}

/**
 * THE PARTICIPANT ROLES THE DECLARED TYPES NAME (DESIGN-CONVERSATION-TYPES section 6.1), as sources: `participant:role`, the
 * set of roles the person an event names holds, `participantRole:<name>` for each role a workflow may address, the
 * role's holders who are members, and `invitation:role`, the role an invitation records. All platform trust or a closed
 * enum, so each may decide, and none describes a person: who leads or responds is the room's own shape, as membership
 * is (ADR-060 decision 7). Each reads the `participantRoles` holdings on the channel-context row, never Metadata.
 */
function participantSources(names: readonly string[], audience: readonly string[], invitable: readonly string[]): Record<string, VariableSource> {
  const origin = 'the participantRoles holdings on the channel-context row (participant-roles.ts)';
  return {
    'participant:role': {
      source: 'participant:role', type: 'set', trust: 'platform', describesPerson: false, values: Object.freeze([...names]),
      availability: 'always', insertAs: 'id', origin: `${origin}, for the person the event names`,
    },
    'invitation:role': {
      source: 'invitation:role', type: 'enum', trust: 'closed-enum', describesPerson: false, values: Object.freeze([...invitable]),
      events: INVITATION_SOURCE_EVENTS, availability: 'always', insertAs: 'id',
      origin: "the invitation's Tokens record (participantRole, among the roles its type declares invitable)",
    },
    ...Object.fromEntries(audience.map((name) => [`participantRole:${name}`, {
      source: `participantRole:${name}`, type: 'person-list' as const, trust: 'platform' as const, describesPerson: false,
      availability: 'always' as const, insertAs: 'text' as const, origin: `${origin}, its holders who are members`,
    }])),
  };
}

/** Every role some type declares an invitation may record. */
function invitableRoleNames(): string[] {
  const out = new Set<string>();
  for (const key of Object.keys(CONVERSATION_TYPES)) {
    for (const [name, decl] of Object.entries(participantRolesOf(key))) if (decl.invitable) out.add(name);
  }
  return [...out].sort();
}

function eventSources(fields: readonly EventFieldDeclaration[]): Record<string, VariableSource> {
  const out: Record<string, VariableSource> = {};
  for (const f of fields) {
    const source = `event:${f.field}`;
    const prior = out[source];
    out[source] = {
      source, type: f.type, trust: f.computedByPlatform ? 'platform' : 'member', describesPerson: f.describesPerson,
      ...(f.values ? { values: Object.freeze([...f.values]) } : {}),
      availability: 'always', events: Object.freeze([...(prior?.events ?? []), f.event]),
      insertAs: f.type === 'string' ? 'longText' : 'text', origin: f.origin,
    };
  }
  return out;
}

/**
 * The classification's source table: the fixed kinds, its catalog's `ctx:` fields, the reply preferences and
 * the event fields. `catalog` is the classification's PUBLISHED catalog (`readPublishedCatalog`), so a
 * classification's table names only what that classification publishes.
 */
export function buildSourceTable(input: {
  catalog: readonly PublishedContextSource[];
  preferences?: Readonly<Record<string, ReplyPreference>>;
  eventFields?: readonly EventFieldDeclaration[];
  /**
   * The classifications the deployment declares (`classificationValues()`). Given, `person:clearance` is a set
   * of them and `conversation:classification` an enum of them (ADR-046: a set, never a ladder), so a condition
   * naming a classification the deployment does not declare is refused.
   */
  classifications?: readonly string[];
  /** The `fact:` keys the intakes the version reads declare (`intakeFactKeys`). */
  facts?: readonly string[];
  /**
   * The languages the deployment declares (`deploymentLanguages()`, the default): the closed value set of
   * `signal:userLanguage` and `person:preferredLanguage` (ADR-062 decision 4), so a condition naming a language the
   * deployment does not speak is refused.
   */
  languages?: readonly string[];
  /**
   * The conversation types whose participant roles the table names (a workflow's declared `types`, ADR-061 decision 1):
   * `participant:role` is a set of their role names and `participantRole:<name>` exists for each role they declare
   * addressable. Absent, every registered type's.
   */
  participantRoleTypes?: readonly string[];
}): SourceTable {
  const classifications = input.classifications?.length ? Object.freeze([...input.classifications]) : undefined;
  const languages = Object.freeze([...(input.languages?.length ? input.languages : deploymentLanguages())]);
  return {
    sources: Object.freeze({
      ...FIXED_SOURCES,
      'signal:userLanguage': { ...FIXED_SOURCES['signal:userLanguage'], values: languages },
      'person:preferredLanguage': { ...FIXED_SOURCES['person:preferredLanguage'], values: languages },
      ...(classifications ? {
        'person:clearance': { ...FIXED_SOURCES['person:clearance'], values: classifications },
        'conversation:classification': { ...FIXED_SOURCES['conversation:classification'], values: classifications },
      } : {}),
      ...preferenceSources(input.preferences ?? REPLY_PREFERENCES),
      ...eventSources(input.eventFields ?? EVENT_FIELDS),
      ...participantSources(
        declaredParticipantRoleNames(input.participantRoleTypes),
        declaredParticipantRoleNames(input.participantRoleTypes, { audienceOnly: true }),
        invitableRoleNames(),
      ),
      ...catalogSources(input.catalog),
    }),
    ...(input.facts ? { facts: new Set(input.facts) } : {}),
  };
}

/** A source's declaration in this table, or undefined when the classification does not publish it. */
export function lookupSource(table: SourceTable, source: string): VariableSource | undefined {
  const own = Object.prototype.hasOwnProperty.call(table.sources, source) ? table.sources[source] : undefined;
  if (own) return own;
  if (FACT_KEY.test(source) && (!table.facts || table.facts.has(source.slice('fact:'.length)))) return { source, ...FACT_SOURCE };
  return undefined;
}

/** One source as the console's variable picker lists it: its declaration, and whether its trust lets it decide (decision 2). */
export interface PickableSource extends VariableSource {
  mayDecide: boolean;
}

/** What a classification publishes, as the console's picker reads it: every source of its table, the `fact:` keys its intake declares. */
export interface PublishedVariables {
  sources: PickableSource[];
  facts?: string[];
}

/**
 * The table as the console receives it, so the picker lists exactly what validation reads (decision 1) and says of
 * each source whether it may decide. Ordered by source name, so the listing is stable.
 */
export function publishedVariables(table: SourceTable): PublishedVariables {
  const sources = Object.values(table.sources)
    .map((s) => ({ ...s, mayDecide: mayDecide(s) }))
    .sort((a, b) => a.source.localeCompare(b.source));
  return { sources, ...(table.facts ? { facts: [...table.facts].sort() } : {}) };
}

/** The table the console's picker and its inline validation read, rebuilt from what the listing served. */
export function tableFromPublished(published: PublishedVariables): SourceTable {
  return {
    sources: Object.freeze(Object.fromEntries(published.sources.map(({ mayDecide: _d, ...s }) => [s.source, s]))),
    ...(published.facts ? { facts: new Set(published.facts) } : {}),
  };
}

/** Why a source is not in the table: not built yet, or not published by this classification. */
export function unpublishedReason(source: string): string {
  const kind = sourceKindOf(source);
  const notBuilt = NOT_BUILT_SOURCES[source] ?? (kind ? NOT_BUILT_SOURCES[kind] : undefined);
  if (notBuilt) return `"${source}" is not built: ${notBuilt}`;
  if (!kind) return `"${source}" is not a source; a source is <kind>:<key> with a kind among ${SOURCE_KINDS.join(', ')}`;
  return `"${source}" is not a source this classification publishes`;
}

/** Reads a name a condition or a template uses: a version's variable by its name, else a source by its own. */
export type SourceLookup = (name: string) => VariableSource | undefined;

/**
 * The lookup a version's declarations read through. `variables` maps a version's variable name to the source
 * it names (ADR-060 decision 1, slice 1b); a name that is not a variable is read as a source string.
 */
export function sourceLookup(table: SourceTable, variables: Readonly<Record<string, string>> = {}): SourceLookup {
  return (name: string) => {
    const named = Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : name;
    return lookupSource(table, named);
  };
}

// ── Decision 1: a version names its variables ──────────────────────────────────────────────────

/**
 * One variable a version names: the source it reads and the fallback inserted when the value is unresolved or
 * held back. Absent fallback: a message leaves the line out (decision 5). A fallback applies to insertion only;
 * a condition never reads it.
 */
export interface VersionVariable {
  source: string;
  fallback?: string | number | boolean | readonly string[];
}

/** At most this many variables on one version. */
export const MAX_VERSION_VARIABLES = 32;
/** A variable's name: no colon, so it never reads as a source, and the `{{field}}` grammar accepts it. */
export { VARIABLE_NAME };

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Why a version's `variables` is refused as written, before any source is read: a map of names to
 * `{ source, fallback? }`, each name in the grammar, each source `<kind>:<key>` of a kind the grammar names, and
 * a fallback a scalar or a list of text.
 */
export function versionVariablesShapeErrors(raw: unknown): string[] {
  if (!isPlainObject(raw)) return ['variables maps a variable name to { source, fallback }'];
  const errors: string[] = [];
  const names = Object.keys(raw);
  if (names.length > MAX_VERSION_VARIABLES) errors.push(`variables holds at most ${MAX_VERSION_VARIABLES} variables`);
  for (const name of names) {
    const at = `variables.${name}`;
    if (!VARIABLE_NAME.test(name)) { errors.push(`${at} is not a variable name (a lowercase letter, then letters, digits or underscores)`); continue; }
    const v = raw[name];
    if (!isPlainObject(v)) { errors.push(`${at} is { source, fallback }`); continue; }
    for (const k of Object.keys(v)) if (k !== 'source' && k !== 'fallback') errors.push(`${at}.${k} is not a variable field; a variable is a source and a fallback`);
    if (typeof v.source !== 'string' || !sourceKindOf(v.source) || v.source.length > 128) {
      errors.push(`${at}.source names a source as <kind>:<key>, with a kind among ${SOURCE_KINDS.join(', ')}`);
    }
    const fb = v.fallback;
    if (fb !== undefined && !isScalar(fb) && !(Array.isArray(fb) && fb.every((x) => typeof x === 'string'))) {
      errors.push(`${at}.fallback is text, a number, true or false, or a list of text`);
    }
  }
  return errors;
}

/** Why a fallback does not fit its variable's type, or undefined when it does. */
function fallbackMisfit(src: VariableSource, fb: VersionVariable['fallback']): string | undefined {
  if (fb === undefined) return undefined;
  if (src.type === 'person-list') return 'is a person-list, which has no fallback: a person is never invented, so the line is left out';
  if (src.type === 'set') {
    if (!Array.isArray(fb)) return 'is a set, so its fallback is a list of text';
    const outside = src.values ? fb.filter((x) => !src.values!.includes(x)) : [];
    if (outside.length) return `is a set of ${src.values!.join(', ')}, and the fallback names ${outside.join(', ')}`;
  } else {
    const scalar = SCALAR_TYPES[src.type];
    if (typeof fb !== scalar) return `is a ${src.type}, so its fallback is a ${scalar}`;
    if (src.type === 'enum' && src.values && !src.values.includes(fb as string)) {
      return `is an enum of ${src.values.join(', ')}, and the fallback is not one of them`;
    }
  }
  // The fallback is inserted where the value would be, so it passes the value's own check unchanged.
  const text = Array.isArray(fb) ? fb.join(', ') : String(fb);
  const checked = cleanMessageValue(src.insertAs, text, 'the fallback');
  if ('refused' in checked) return `has a fallback that is refused: ${checked.refused}`;
  if (checked.value !== text.trim()) return 'has a fallback carrying a marker or more text than its type allows';
  return undefined;
}

/**
 * Why a version's variables are refused against what its classification publishes (decision 1, decision 3's
 * first layer), every reason at once: the shape, a source the table does not hold (a `fact:` key no intake the
 * version reads declares among them), and a fallback that does not fit the variable's type. Trust is the
 * source's own: a version cannot raise it, so a member-trust variable is refused where a condition names it
 * (`whenErrors` over `versionLookup`), not here.
 */
export function versionVariablesErrors(raw: unknown, table: SourceTable): string[] {
  if (raw === undefined || raw === null) return [];
  const shape = versionVariablesShapeErrors(raw);
  if (shape.length) return shape;
  const errors: string[] = [];
  for (const [name, v] of Object.entries(raw as Record<string, VersionVariable>)) {
    const at = `variables.${name}`;
    const src = lookupSource(table, v.source);
    if (!src) {
      errors.push(sourceKindOf(v.source) === 'fact' && table.facts && FACT_KEY.test(v.source)
        ? `${at}: "${v.source}" is not a field any intake this assistant reads declares (${[...table.facts].map((f) => `fact:${f}`).join(', ') || 'none declared'})`
        : `${at}: ${unpublishedReason(v.source)}`);
      continue;
    }
    const misfit = fallbackMisfit(src, v.fallback);
    if (misfit) errors.push(`${at}: "${v.source}" ${misfit}`);
  }
  return errors;
}

/** Each variable's name to the source it names, the map `sourceLookup` reads a version's names through. */
export function versionVariableSources(variables: Readonly<Record<string, VersionVariable>> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(variables ?? {}).map(([name, v]) => [name, v.source]));
}

/** The lookup a version's conditions and templates read through: a variable by its name, else a source. */
export function versionLookup(table: SourceTable, variables: Readonly<Record<string, VersionVariable>> | undefined): SourceLookup {
  return sourceLookup(table, versionVariableSources(variables));
}

/** An intake as far as its declared fields go (`IntakeConfig`, `onboarding-intake.ts`). */
export type IntakeFields = { fields?: ReadonlyArray<{ key?: unknown; preference?: unknown } | null | undefined> };

/**
 * The `fact:` keys the given intakes declare: every field that stores a fact, never one that sets a reply
 * preference (that answer is `pref:<key>`). The declared list `fact:<key>` is checked against.
 */
export function intakeFactKeys(intakes: ReadonlyArray<IntakeFields | null | undefined>): string[] {
  const keys = new Set<string>();
  for (const intake of intakes) {
    for (const f of intake?.fields ?? []) {
      if (f && typeof f.key === 'string' && f.key.trim() && !f.preference) keys.add(f.key.trim());
    }
  }
  return [...keys].sort();
}

// ── Decision 2: trust decides insert or decide ─────────────────────────────────────────────────

/** Every trust may be inserted; member text is inserted stripped, capped and unable to close a delimiter. */
export function mayInsert(_src: VariableSource): true {
  return true;
}

/** Platform, operator and closed-enum values may decide. Member free text never does (tenet D11). */
export function mayDecide(src: VariableSource): boolean {
  return src.trust !== 'member';
}

// ── Decision 6: conditions ─────────────────────────────────────────────────────────────────────

export const WHEN_OPERATORS = ['eq', 'ne', 'in', 'has', 'exists', 'gt', 'lt'] as const;
export type WhenOperator = (typeof WHEN_OPERATORS)[number];
export type Scalar = string | number | boolean;
export interface WhenTest {
  op: WhenOperator;
  value?: Scalar | readonly Scalar[];
}
/** Several keys are joined by AND. */
export type WhenClause = Readonly<Record<string, Scalar | WhenTest>>;
/** One clause, or an ordered list of alternatives joined by OR. There is no expression language. */
export type When = WhenClause | readonly WhenClause[];

/** A resolved value: a string, number or boolean, or a set or person-list as a list of strings. */
export type VariableValue = Scalar | readonly string[];

const isScalar = (v: unknown): v is Scalar =>
  typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

/** Unresolved: absent, empty text, or a number that is not finite. An empty set is a resolved set. */
export function isUnresolved(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v === 'number') return !Number.isFinite(v);
  if (Array.isArray(v)) return false;
  return typeof v !== 'boolean';
}

function asTest(raw: Scalar | WhenTest): WhenTest {
  return isScalar(raw) ? { op: 'eq', value: raw } : raw;
}

/** One operator over one value. An unresolved value, or a value of the wrong shape, makes it false. */
export function testHolds(test: WhenTest, actual: VariableValue | undefined): boolean {
  if (isUnresolved(actual)) return false;
  const { op, value } = test;
  switch (op) {
    case 'eq': return isScalar(actual) && isScalar(value) && actual === value;
    case 'ne': return isScalar(actual) && isScalar(value) && actual !== value;
    case 'in': return isScalar(actual) && Array.isArray(value) && value.includes(actual);
    case 'has': return Array.isArray(actual) && typeof value === 'string' && actual.includes(value);
    case 'exists': return true;
    case 'gt': return typeof actual === 'number' && typeof value === 'number' && Number.isFinite(value) && actual > value;
    case 'lt': return typeof actual === 'number' && typeof value === 'number' && Number.isFinite(value) && actual < value;
    default: return false;
  }
}

function isClause(c: unknown): c is WhenClause {
  return !!c && typeof c === 'object' && !Array.isArray(c);
}

/**
 * Whether a condition holds over resolved values, keyed as the condition names them. A clause holds when
 * every key holds; a list holds when any clause does. An empty or malformed condition does not hold.
 */
export function evaluateWhen(when: When | unknown, values: Readonly<Record<string, VariableValue | undefined>>): boolean {
  if (Array.isArray(when)) return when.some((c) => evaluateWhen(c, values));
  if (!isClause(when)) return false;
  const keys = Object.keys(when);
  if (!keys.length) return false;
  return keys.every((k) => {
    const raw = when[k];
    if (!isScalar(raw) && !isClause(raw)) return false;
    const actual = Object.prototype.hasOwnProperty.call(values, k) ? values[k] : undefined;
    return testHolds(asTest(raw as Scalar | WhenTest), actual);
  });
}

/** The keys a condition names, for the resolver to read and no more. */
export function whenKeys(when: When | unknown): string[] {
  if (Array.isArray(when)) return [...new Set(when.flatMap((c) => whenKeys(c)))];
  return isClause(when) ? Object.keys(when) : [];
}

// ── Decision 3, first layer: validation ────────────────────────────────────────────────────────

const SCALAR_TYPES: Readonly<Record<VariableType, 'string' | 'number' | 'boolean' | undefined>> = {
  string: 'string', enum: 'string', number: 'number', boolean: 'boolean', set: undefined, 'person-list': undefined,
};

/** Why one value does not fit a variable's type, or undefined when it does. */
function valueMisfit(src: VariableSource, value: unknown): string | undefined {
  const scalar = SCALAR_TYPES[src.type];
  if (typeof value !== scalar) return `is a ${src.type}, so its value is a ${scalar}`;
  if (src.type === 'enum' && src.values && !src.values.includes(value as string)) {
    return `is an enum of ${src.values.join(', ')}`;
  }
  return undefined;
}

export interface WhenValidationOptions {
  /** `room` when the condition selects a message the room reads (decision 7). */
  selects?: 'room' | 'addressed';
  /** The event the condition is evaluated at, which an `event:` field must exist at. */
  event?: string;
  /**
   * Which keys a check holds, by whether they read the classification's context-source catalog (`ctx:`, by name or
   * through a version's variable). `deferred`: a check made where the catalog is not read leaves those keys to the
   * check that reads it. `only`: the check that reads it holds those keys and no others, so no reason is said twice.
   * Absent: every key.
   */
  catalog?: 'deferred' | 'only';
}

/** Whether a condition's key reads the classification's context-source catalog: a `ctx:` source, by name or through a variable. */
export function keyReadsCatalog(key: string, lookup: SourceLookup): boolean {
  return (lookup(key)?.source ?? key).startsWith('ctx:');
}

/**
 * Whether any key of a condition reads the classification's catalog, so the check that holds it reads the catalog
 * first. A malformed condition reads nothing; the check that does not read the catalog refuses its shape.
 */
export function whenReadsCatalog(when: unknown, lookup: SourceLookup): boolean {
  return whenKeys(when).some((k) => keyReadsCatalog(k, lookup));
}

/**
 * Why a condition is refused, every reason at once. Refused: a key the classification does not publish, a
 * member-trust variable (a free-text `event:` field included), an operator outside the closed set or on a type
 * it does not apply to (`gt`/`lt` on anything but a number), a value that does not fit the variable, an
 * `event:` field at an event that does not carry it, and a person-describing variable selecting a room message.
 */
export function whenErrors(when: unknown, lookup: SourceLookup, opts: WhenValidationOptions = {}): string[] {
  const errors: string[] = [];
  const clauses: unknown[] = Array.isArray(when) ? when : [when];
  // A check holding only the catalog's keys says nothing of a condition's shape: the check without the catalog does.
  const only = opts.catalog === 'only';
  if (Array.isArray(when) && !when.length) return only ? [] : ['a `when` list names at least one alternative'];
  clauses.forEach((clause, i) => {
    const at = Array.isArray(when) ? `alternative ${i + 1}: ` : '';
    if (!isClause(clause)) {
      if (only) return;
      errors.push(`${at}a \`when\` is { <variable>: <value> } or { <variable>: { op, value } }`);
      return;
    }
    const keys = Object.keys(clause);
    if (!keys.length && !only) errors.push(`${at}a \`when\` names at least one variable`);
    for (const key of keys) {
      if (opts.catalog && keyReadsCatalog(key, lookup) === (opts.catalog === 'deferred')) continue;
      const src = lookup(key);
      if (!src) {
        errors.push(`${at}${unpublishedReason(key)}`);
        continue;
      }
      if (!mayDecide(src)) {
        errors.push(sourceKindOf(src.source) === 'event'
          ? `${at}"${key}" is a free-text event field, which is inserted as data and never decides`
          : `${at}"${key}" is member text, which may be inserted but never decides`);
        continue;
      }
      if (src.events && opts.event && !src.events.includes(opts.event)) {
        errors.push(`${at}"${key}" exists only at ${src.events.join(', ')}, not at ${opts.event}`);
      }
      if (src.describesPerson && opts.selects === 'room') {
        errors.push(`${at}"${key}" describes a person, so it selects only a message addressed to that person, never one the room reads`);
      }
      const raw = clause[key];
      if (isScalar(raw)) {
        if (!SCALAR_TYPES[src.type]) {
          errors.push(`${at}"${key}": a bare value means eq, which applies to a string, an enum, a boolean or a number, and this is a ${src.type}`);
          continue;
        }
        const misfit = valueMisfit(src, raw);
        if (misfit) errors.push(`${at}"${key}" ${misfit}`);
        continue;
      }
      if (!isClause(raw) || !(WHEN_OPERATORS as readonly string[]).includes((raw as { op?: unknown }).op as string)) {
        errors.push(`${at}"${key}" names an operator among ${WHEN_OPERATORS.join(', ')}`);
        continue;
      }
      const { op, value } = raw as WhenTest;
      if (op === 'exists') {
        if (value !== undefined) errors.push(`${at}"${key}": exists takes no value`);
      } else if (op === 'gt' || op === 'lt') {
        if (src.type !== 'number') errors.push(`${at}"${key}": ${op} applies to a number only, and this is a ${src.type}`);
        else if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${at}"${key}": ${op} compares with a number`);
      } else if (op === 'has') {
        if (src.type !== 'set' && src.type !== 'person-list') errors.push(`${at}"${key}": has applies to a set only, and this is a ${src.type}`);
        else if (typeof value !== 'string' || !value) errors.push(`${at}"${key}": has names one member`);
        else if (src.values && !src.values.includes(value)) errors.push(`${at}"${key}" is a set of ${src.values.join(', ')}`);
      } else if (!SCALAR_TYPES[src.type]) {
        errors.push(`${at}"${key}": ${op} applies to a string, an enum, a boolean or a number, and this is a ${src.type}`);
      } else if (op === 'in') {
        if (!Array.isArray(value) || !value.length) errors.push(`${at}"${key}": in names a list of values`);
        else for (const v of value) { const m = valueMisfit(src, v); if (m) { errors.push(`${at}"${key}" ${m}`); break; } }
      } else {
        const misfit = valueMisfit(src, value);
        if (misfit) errors.push(`${at}"${key}" ${misfit}`);
      }
    }
  });
  return errors;
}

/** What a message's insertion is checked against: its fields, its sections and who reads it. */
export interface InsertionUse {
  /** Template field to its binding. A binding outside the source grammar (`value:`, `assistant:`) is the call site's. */
  fields: Readonly<Record<string, string>>;
  /** Section name to text, as `ParsedTemplate.messageSections` holds them. */
  sections: Readonly<Record<string, string>>;
  /** `room` when every member reads the message, `addressed` when one person does (a targeted send). */
  audience: 'room' | 'addressed';
  /** The fields a `mention:` binding renders as an inert display name. */
  mentions?: readonly string[];
}

/**
 * Why a message's insertions are refused, every reason at once. Refused: a source the classification does not
 * publish, a variable the version does not name, a person-describing variable in a message the room reads (except
 * `person:displayName` through a `mention:` binding), a mention bound to anything but a mentionable name, and
 * `person:clearance` in an email.
 */
export function insertionErrors(use: InsertionUse, lookup: SourceLookup): string[] {
  const errors: string[] = [];
  const mentions = new Set(use.mentions ?? []);
  for (const [section, text] of Object.entries(use.sections)) {
    for (const field of [...new Set(fieldsIn(text))]) {
      const binding = use.fields[field];
      if (binding === undefined) continue;
      const variable = !sourceKindOf(binding) && VARIABLE_NAME.test(binding);
      if (!variable && !sourceKindOf(binding)) {
        // The call site's own value (`value:<type>`, `assistant:displayName`): a mention is still only ever a name.
        if (mentions.has(field)) errors.push(`{{${field}}} is a mention, which renders a person's display name only, and it binds "${binding}"`);
        continue;
      }
      const src = lookup(binding);
      if (!src) {
        errors.push(variable ? `{{${field}}} binds "${binding}", which is not a variable this version names` : `{{${field}}}: ${unpublishedReason(binding)}`);
        continue;
      }
      const mention = mentions.has(field);
      if (mention && !src.mentionable) {
        errors.push(`{{${field}}} is a mention, which renders a person's display name only, and it binds "${binding}"`);
      }
      if (src.describesPerson && use.audience === 'room' && !(mention && src.mentionable)) {
        errors.push(`{{${field}}} in "${section}" binds "${binding}", which describes a person and reaches only that person; `
          + 'a message the room reads may name a member only through a mention');
      }
      if (src.source === 'person:clearance' && section.startsWith('email.')) {
        errors.push(`{{${field}}}: a person's clearance never reaches an email, so it cannot be in "${section}"`);
      }
    }
  }
  return [...new Set(errors)];
}

/**
 * A lookup for a call site that does not read the classification's catalog (the router): a `ctx:` source it does
 * not hold is read as the catalog's least-permitting entry would be, member text about a person (INV-CTX-CAT-2), so
 * a template binding one is checked by the rules that bind it most tightly rather than refused as unpublished. Given
 * the version's variables, a variable naming a `ctx:` field reads the same way.
 */
export function withUnreadCatalog(lookup: SourceLookup, variables?: Readonly<Record<string, VersionVariable>>): SourceLookup {
  const named = versionVariableSources(variables);
  return (name: string) => {
    const found = lookup(name);
    const source = Object.prototype.hasOwnProperty.call(named, name) ? named[name] : name;
    if (found || !/^ctx:[^.\s]+\.[^.\s]+$/.test(source)) return found;
    return {
      source, type: 'string', trust: 'member', describesPerson: true, availability: 'person-settled',
      insertAs: 'longText', origin: "the classification's context-source catalog, not read at this call site",
    };
  };
}

// ── Decision 3, second layer: the resolver ─────────────────────────────────────────────────────

/** Where a value is resolved: what the call site has settled, who reads the message, and which part of it. */
export interface ResolveSite {
  callSite: CallSiteCapabilities;
  /** `room` when every member reads it; `addressed` when one person does. A step's `when` is `addressed`. */
  audience: 'room' | 'addressed';
  /** The section rendered, such as `chat` or `email.body`. */
  section?: string;
}

/** Whether a source is readable at this call site. Unmet: the value is unresolved, never awaited. */
export function sourceSettled(src: Pick<VariableSource, 'availability'>, callSite: CallSiteCapabilities): boolean {
  switch (src.availability) {
    case 'always': return true;
    case 'identity-settled': return callSite.identitySettled;
    case 'conversation-settled': return callSite.conversationSettled;
    case 'person-settled': return callSite.identitySettled || callSite.subjectSettled;
    default: return false;
  }
}

function held(variable: string, rule: string): undefined {
  // By name and rule, never by value.
  console.warn('[variables] the resolver held a value back', { variable, rule });
  return undefined;
}

/**
 * The value a condition reads, or undefined (unresolved) when the second layer holds it back: a source not
 * published, a member-trust value, a value not settled at the call site, or a person-describing value where
 * the message has no single addressee.
 */
export function decidingValue(
  name: string,
  src: VariableSource | undefined,
  raw: VariableValue | undefined,
  site: ResolveSite,
): VariableValue | undefined {
  if (!src) return held(name, 'not-published');
  if (!mayDecide(src)) return held(name, 'member-trust-never-decides');
  if (!sourceSettled(src, site.callSite)) return undefined;
  if (src.describesPerson && site.audience === 'room') return held(name, 'person-fact-in-room');
  return isUnresolved(raw) ? undefined : raw;
}

/**
 * Whether a condition holds at a site: each key it names is read through `decidingValue`, then `evaluateWhen`.
 * A condition stored around validation therefore does not hold on a value it was never allowed to read.
 */
export function conditionHolds(
  when: When | unknown,
  lookup: SourceLookup,
  values: Readonly<Record<string, VariableValue | undefined>>,
  site: ResolveSite,
): boolean {
  const masked: Record<string, VariableValue | undefined> = {};
  for (const key of whenKeys(when)) masked[key] = decidingValue(key, lookup(key), values[key], site);
  return evaluateWhen(when, masked);
}

/** What a condition reads at one call site: the lookup, the version's variables and the values held, by source. */
export type GateResolution = Omit<FieldResolution, 'mentions'>;

/** The value a condition's key reads: a version's variable through the source it names, else the source itself. */
function heldValueOf(key: string, r: GateResolution): VariableValue | undefined {
  const variable = r.variables && Object.prototype.hasOwnProperty.call(r.variables, key) ? r.variables[key] : undefined;
  const source = variable ? variable.source : key;
  return Object.prototype.hasOwnProperty.call(r.values, source) ? r.values[source] : undefined;
}

/**
 * THE DECIDING VALUES SEVERAL CONDITIONS READ AT ONE SITE (decision 6), keyed as the conditions name them, each
 * already held back by the second layer (`decidingValue`): member text, a value not settled here and a person fact in
 * a room message are absent. Plain data, so a call site that hands a move to another function (the task service)
 * carries the values it may decide on rather than a function, and that side evaluates them with `evaluateWhen`.
 */
export function decidingValues(whens: readonly unknown[], r: GateResolution): Record<string, VariableValue> {
  const out: Record<string, VariableValue> = {};
  for (const key of new Set(whens.flatMap((w) => whenKeys(w)))) {
    const v = decidingValue(key, r.lookup(key), heldValueOf(key, r), r.site);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * Whether a condition holds at a call site, reading each key through the version's variables and the values the call
 * site holds by source. The resolver's second layer applies (`conditionHolds`), and a fallback is never read.
 */
export function whenHolds(when: When | unknown, r: GateResolution): boolean {
  return evaluateWhen(when, decidingValues([when], r));
}

/**
 * A PERSON'S CLEARANCE AS THE SET IT IS (decision 7, ADR-046): the classifications the person's holder token grants,
 * read through the deployment's registry (`grantsFor`). Unresolved when there is no token: an absent clearance, a
 * failed resolution and sign-in evidence are never a clearance, so no condition on it holds.
 */
export function clearanceSet(
  token: string | undefined | null,
  grantsFor: (token: string) => readonly string[],
): readonly string[] | undefined {
  if (typeof token !== 'string' || !token.trim()) return undefined;
  try {
    return Object.freeze([...new Set(grantsFor(token))]);
  } catch {
    return undefined;
  }
}

/**
 * THE `ctx:` VALUES A CALL SITE HOLDS (decision 4): every field of every source it already resolved for its own use,
 * typed as the catalog declares the field, by `ctx:<source>.<field>`. Nothing is read here, so a source the call site
 * did not resolve is unresolved. A `string[]` field arrives as JSON or as a comma list and is read as a set.
 */
export function catalogValues(
  resolved: ReadonlyArray<{ entry: Pick<PublishedContextSource, 'key' | 'fields'>; values: Readonly<Record<string, string>> }>,
): Record<string, VariableValue> {
  const out: Record<string, VariableValue> = {};
  for (const { entry, values } of resolved) {
    for (const [field, raw] of Object.entries(values)) {
      const declared = entry.fields?.[field];
      if (!declared || typeof raw !== 'string' || !raw.trim()) continue;
      const key = `ctx:${entry.key}.${field}`;
      switch (declared.type) {
        case 'number': { const n = Number(raw); if (Number.isFinite(n)) out[key] = n; break; }
        case 'boolean': if (raw === 'true' || raw === 'false') out[key] = raw === 'true'; break;
        case 'string[]': {
          let list: unknown;
          try { list = JSON.parse(raw); } catch { list = raw.split(','); }
          if (Array.isArray(list)) out[key] = Object.freeze(list.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean));
          break;
        }
        default: out[key] = raw;
      }
    }
  }
  return out;
}

/**
 * THE VALUES A PROCESSOR TURN HOLDS, by source (decision 4): the conversation's classification and type, the language
 * signal, and, where the turn has a person, that person's clearance as a set (`clearanceSet`), reply preferences
 * and display name, then the `ctx:` values it resolved (`catalogValues`). Each is a value the turn already read for its
 * own use; none is read on demand.
 */
export function turnValues(input: {
  classification?: string;
  conversationType?: string;
  userLanguage?: string;
  clearance?: readonly string[];
  preferences?: Readonly<Record<string, string>>;
  displayName?: string;
  catalog?: Readonly<Record<string, VariableValue>>;
  /** The languages the deployment declares, which both language values are read against (default `deploymentLanguages()`). */
  languages?: readonly string[];
}): Record<string, VariableValue> {
  const out: Record<string, VariableValue> = {};
  const declared = input.languages ?? deploymentLanguages();
  if (input.classification) out['conversation:classification'] = input.classification;
  if (input.conversationType) out['conversation:type'] = input.conversationType;
  // A LANGUAGE IS A DECLARED TAG OR UNRESOLVED (ADR-062 decision 4): a tag the deployment does not speak decides nothing.
  const conversationLanguage = resolveLanguageTag(input.userLanguage, declared);
  if (conversationLanguage) out['signal:userLanguage'] = conversationLanguage;
  if (input.clearance) out['person:clearance'] = input.clearance;
  const preferredLanguage = resolveLanguageTag(input.preferences?.[PREFERRED_LANGUAGE_KEY], declared);
  if (preferredLanguage) out['person:preferredLanguage'] = preferredLanguage;
  for (const [k, v] of Object.entries(input.preferences ?? {})) {
    if (k === PREFERRED_LANGUAGE_KEY) continue;
    if (typeof v === 'string' && v) out[`pref:${k}`] = v;
  }
  if (input.displayName) out['person:displayName'] = input.displayName;
  return { ...out, ...(input.catalog ?? {}) };
}

/** What decides whether a mention renders: the person, the live membership and, at `assistant-joined`, the shape. */
export interface MentionContext {
  /** The person the mention names, as the membership and the shape hold them. */
  person: string;
  /** The conversation's live membership when the message is rendered. */
  members: ReadonlySet<string>;
  /** The event the message is rendered at. */
  event?: string;
  /** The participant shape's `humans`, written before the channel existed. */
  participantHumans?: readonly string[];
  /** True for an email sent to a person who is not a member, where every mention renders empty. */
  emailToNonMember?: boolean;
}

/**
 * A mention renders only for a member. At `assistant-joined` live membership has not converged, so a person in
 * the participant shape's `humans` counts as one. In an email to a non-member no mention renders.
 */
export function mentionRenders(m: MentionContext): boolean {
  if (m.emailToNonMember) return false;
  if (m.members.has(m.person)) return true;
  return m.event === 'assistant-joined' && (m.participantHumans ?? []).includes(m.person);
}

/** What a template's resolver-bound fields are read from at one call site. */
export interface FieldResolution {
  /** The classification's sources and the version's variables (`versionLookup`). */
  lookup: SourceLookup;
  /** The version's variables, for their sources and fallbacks. */
  variables?: Readonly<Record<string, VersionVariable>>;
  /**
   * The values this call site already holds, by SOURCE name. A source it does not hold is unresolved and inserts
   * its fallback: never awaited, never read on demand (decision 4).
   */
  values: Readonly<Record<string, VariableValue | undefined>>;
  site: ResolveSite;
  /** A mention field's context, by field, for a `person:displayName` the message names as a mention. */
  mentions?: Readonly<Record<string, MentionContext>>;
}

/**
 * THE TEXT EACH RESOLVER-BOUND FIELD INSERTS (decision 5), by field: a field bound to a source in the grammar or to
 * one of the version's variables is read through `insertValue` (the second layer: held back by trust, audience and
 * call site, stripped and capped by its type), else it inserts the variable's fallback, checked as the value would
 * be. A field with neither is absent, so its line is left out. A field bound to the call site's own value
 * (`value:<type>`, `assistant:displayName`) is the call site's and is not returned.
 */
export function resolveTemplateFields(fields: Readonly<Record<string, string>>, r: FieldResolution): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, binding] of Object.entries(fields)) {
    const named = !sourceKindOf(binding) && VARIABLE_NAME.test(binding);
    const variable = named && r.variables && Object.prototype.hasOwnProperty.call(r.variables, binding) ? r.variables[binding] : undefined;
    if (!variable && !sourceKindOf(binding)) continue;
    const source = variable ? variable.source : binding;
    const src = r.lookup(binding);
    const raw = Object.prototype.hasOwnProperty.call(r.values, source) ? r.values[source] : undefined;
    const text = isUnresolved(raw) ? undefined : insertValue(binding, src, raw, r.site, r.mentions?.[field]);
    if (text) { out[field] = text; continue; }
    const fb = variable?.fallback;
    if (fb === undefined) continue;
    const checked = cleanMessageValue(src?.insertAs ?? 'text', Array.isArray(fb) ? fb.join(', ') : String(fb), field);
    if (!('refused' in checked) && checked.value) out[field] = checked.value;
  }
  return out;
}

/** Text that closes a delimiter a value is placed inside: the prompt's data block and a context fence. */
const DELIMITER = /<\s*\/?\s*(template-data|context)\b[^>]*>?/gi;

/**
 * The text a value inserts, or undefined when it renders empty and the call site inserts its fallback (decision
 * 5). Held back: a source not published, a value not settled, `person:clearance` in an email, and a
 * person-describing value in a message the room reads, except a mention of a member, which renders inert. Every
 * value is stripped of every marker a reader acts on and capped by its type; a member-trust value also loses any
 * delimiter it carries, so wherever it is placed it stays data.
 */
export function insertValue(
  name: string,
  src: VariableSource | undefined,
  raw: VariableValue | undefined,
  site: ResolveSite,
  mention?: MentionContext,
): string | undefined {
  if (!src) return held(name, 'not-published');
  if (!sourceSettled(src, site.callSite) || isUnresolved(raw)) return undefined;
  if (src.source === 'person:clearance' && (site.section ?? '').startsWith('email.')) return held(name, 'clearance-in-email');
  if (mention) {
    if (!src.mentionable) return held(name, 'mention-of-non-name');
    if (!mentionRenders(mention)) return undefined;
    return inertMention(String(raw)) || undefined;
  }
  if (src.describesPerson && site.audience === 'room') return held(name, 'person-fact-in-room');
  const text = Array.isArray(raw) ? raw.join(', ') : String(raw);
  const checked = cleanMessageValue(src.insertAs, src.trust === 'member' ? text.replace(DELIMITER, '') : text, name);
  if ('refused' in checked) return held(name, 'refused-by-type');
  return checked.value || undefined;
}
