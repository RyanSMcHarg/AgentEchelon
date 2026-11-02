/**
 * OPEN A TYPED CONVERSATION BECAUSE SOMETHING HAPPENED, AND WRITE NOTHING INTO THE ROOM IT CONCERNED.
 *
 * The first creation path in this system with no person in the loop at the moment of creation: an event
 * arrives, and a conversation of a declared TYPE is opened with the assistants and the people that type
 * names. ADR-053 Phase 1.
 *
 * ── WHAT IT IS FOR, AND WHAT IT IS NOT ───────────────────────────────────────────────────────────
 *
 * It is the mechanism behind "an alert opened a room with the right people in it". It is NOT a general
 * conversation-creation API: it takes no classification from its caller, it honors exactly the types the
 * registry declares, and it is reachable only by invoking this function.
 *
 * ── THE CLASSIFICATION IS PINNED AT DEPLOY, NOT TAKEN FROM THE EVENT ─────────────────────────────
 *
 * This is the one property that makes a manually invokable creator safe to have. Every other creating
 * path in this system is bounded by a deploy-time classification plus IAM conditioning
 * `chime:TagResource` on `aws:RequestTag/classification`; a Lambda that read the classification out of
 * its payload would be a create-at-any-classification primitive, which is precisely what must not exist
 * while the tag is the only axis IAM evaluates (tenet P4). So the classification is `CLASSIFICATION` from
 * the environment, the role may stamp no other value, and TWO further checks have to agree with it:
 * the conversation type must permit it, and the conversation the event concerned must already carry it.
 *
 * That last check is why this reads the concerned conversation's tag rather than trusting the payload.
 * The new conversation records the concerned one as its parent, and an event naming a conversation at
 * another classification is refused rather than linked.
 *
 * ── NOTHING IS WRITTEN INTO THE CONCERNED CONVERSATION ───────────────────────────────────────────
 *
 * The concerned room has its own audience, and what an incident room holds is not that audience's to
 * read (DESIGN-CONVERSATION-TYPES §11). So the event path posts nothing there, says nothing there, and
 * reads none of its members: a person posts there when anything should be said. The role holds no send
 * and no membership read on it.
 *
 * ── THE PEOPLE ARE THE TYPE'S; THE PERSON IT IS FOR IS NAMED, NOT GUESSED ──────────────────────
 *
 * A type with a membership source adds the people that source admits at this classification; a manual
 * type adds only the person the event named. Never the concerned conversation's roster: who is in an
 * incident room is the type's decision, not an accident of which room the event touched.
 *
 * The person (`forUserArn` or `forPerson`) is REQUIRED rather than defaulted. The new conversation's moderator is a durable property
 * of it, and picking one by list order would make it depend on a directory's pagination.
 *
 * ── WHAT REACHES IT: A DECLARED EVENT, OR AN INVOKE ──────────────────────────────────────────────
 *
 * A conversation type declares the events that open it (`openedBy`, `lib/config/event-openers.ts`), and the
 * classification's stack builds one EventBridge rule per declaration with this function as its target
 * (`lib/constructs/event-opened-conversations.ts`). The rule hands over `{ aeOpener, event }`: the id of the
 * declaration it was built from and the whole event. The TYPE is the declaration's, looked up here by that
 * id, and the fields are read from the event at the paths the declaration names; the event chooses neither
 * the type nor, as everywhere here, the classification. A direct invoke with a bare `detail` (or the same
 * fields unwrapped) still works, for the platform's own `ops-team` room and for an operator.
 *
 * The person may be named by AppInstanceUser ARN (`forUserArn`), or as `forPerson`: an ARN, an email
 * address the deployment's own pool holds (`<issuer id>|<address>` for another issuer's), or a subject. An
 * address is resolved within one issuer's directory and never across issuers (`Directory.findByAddress`).
 *
 * ── THE PEOPLE IT WAS OPENED FOR ARE EMAILED, BY THE ROOM'S ASSISTANT ────────────────────────────
 *
 * Once the room exists, the person the event named and the people the type admitted are each welcomed into
 * it privately by its primary, and the welcome carries their email (`lib/typed-conversation-notice.ts`):
 * the `memberWelcome` notice a share names, said by the router, emailed by the notification bridge with a
 * deep link into the new room. Nothing is said in the concerned room.
 *
 * ── IT NEVER THROWS ──────────────────────────────────────────────────────────────────────────────
 *
 * It returns `{ ok: false, error }`, the same shape and for the same reason as `proactive-briefing.ts`:
 * an EventBridge target that throws is retried, and retrying a creation produces a second conversation
 * rather than a repaired one. The function's own asynchronous retries are off for the same reason, and an
 * invocation that fails outright (a timeout) is kept in the rule's dead-letter queue.
 */
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { createConversationFromEvent } from './lib/channel-creation.js';
import { nameEventThroughRouter, personJoinedThroughRouter } from './lib/say-through-router.js';
import { primaryAssignmentOf } from './lib/conversation-primary.js';
import { conversationNameFor, conversationSubjectFor, nameDate } from './lib/conversation-name.js';
import { loadMessageTemplateSet } from './lib/message-template-selection.js';
import { resolveServiceAdminBearer } from './lib/service-admin-bearer.js';
import { resolveDefaultAgents } from './lib/default-agents.js';
import {
  CONVERSATION_TYPES,
  admittedIssuersOf,
  getConversationTypeConfig,
  membershipSourceFor,
  typeAdmitsIssuers,
} from '../../lib/config/conversation-types.js';
import { defaultDirectory, resolveAllowedSet } from './lib/membership-source.js';
import type { Classification } from '../../lib/config/model-strategy.js';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { readChannelTags } from './lib/channel-classification.js';
import { loadProfileRegistry } from '../../lib/profile-registry';
import { openerById, openerInput } from '../../lib/config/event-openers.js';
import { DEPLOYMENT_ISSUER_ID } from '../../lib/config/issuers.js';
import { peopleJoiningAfterOpening, welcomeIntoOpenedConversation } from './lib/typed-conversation-notice.js';
import { holdersToAdd, holdingsAtCreation, moderationOrigin } from './lib/participant-roles.js';
import { groupSourcedRoles, participantRolesOf } from '../../lib/config/participant-roles.js';
import { personIdFromArn, userArnFor } from './lib/person-arn.js';
import { claimOpening, recordAlarmWatch, settleOpening } from './lib/channel-context-client.js';
import { ALARM_NAME, alarmWatchKey } from './lib/event-workflow.js';

const messagingClient = chimeMessagingClient({});
const ssmClient = new SSMClient({});

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
/** The classification this deployment of the function may create at. Never read from the event. */
const DEPLOYED_CLASSIFICATION = (process.env.CLASSIFICATION || '') as Classification;
/** SSM parameter NAME (not the value) holding the channel-flow ARN, resolved at runtime and cached. */
const CHANNEL_FLOW_ARN_PARAM = process.env.CHANNEL_FLOW_ARN_PARAM || '';
/** SSM parameter NAME holding this classification's primary assistant bot ARN - the create bearer. */

/**
 * The creator's input, from a direct invoke or read off a declared rule's event.
 *
 * A direct invoke passes it under `detail`, the EventBridge envelope's field, or as a bare object, so
 * `aws lambda invoke` needs no wrapper. A declared rule passes `{ aeOpener, event }` instead, and this
 * shape is built from the declaration (`detailFromOpener`). Nothing here is read for a security decision:
 * the classification is the environment's, and the type is looked up in the registry.
 */
export interface TypedConversationEventDetail {
  /** Registry key of the conversation type to create. Must exist and must permit this classification. */
  conversationType: string;
  /**
   * The conversation the event concerned: the new conversation's parent, never written to. Its
   * classification tag must match this function's. Optional only for a type whose initiation is `system` - a standing
   * conversation the platform opens for a group, which concerns no other conversation.
   */
  concernedChannelArn?: string;
  /** The person the new conversation is for: its member and moderator. This or `forPerson` is required, never guessed. */
  forUserArn?: string;
  /**
   * The same person named as the directory resolves an entry: an AppInstanceUser ARN, an email address
   * (`<issuer id>|<address>` for an issuer other than the deployment's own pool), or a subject.
   */
  forPerson?: string;
  /**
   * What the new conversation is about, in a few words: its subject, and its name unless the type declares one of its
   * own (`name`, `conversation-name.ts`). Absent: the room is named from the alarm it watches, then from its summary.
   */
  topicLabel?: string;
  /** The system the event is about (an alarm's metric namespace, a vendor's product), read for the room's name alone. */
  service?: string;
  /** One line describing what happened, carried into the new conversation as its issue. */
  summary?: string;
  /**
   * THE PERSON WHOSE CONFIRMATION OPENED IT (ADR-061 decision 8, `open_conversation`): set by the apply endpoint
   * (`proposals-api.ts`) once that person applied the proposal, and only equal to the person the conversation is for,
   * who then holds each participant role the type sources from `{ creator: true }` (DESIGN-CONVERSATION-TYPES 6.1).
   */
  confirmedBy?: string;
  /**
   * THE CLOUDWATCH ALARM THE EVENT IS ABOUT (ADR-061, the incident watch): the new conversation watches it, so each state
   * change the alarm makes runs its primary's `alarm-state-changed` workflow there. Recorded on the room's context row
   * and in the alarm's watch record, which the newest room for an alarm holds.
   */
  watchesAlarm?: string;
  /** Display-only model labels for the new channel's Metadata. Nothing decides anything from them. */
  modelId?: string;
  modelName?: string;
}

export interface TypedConversationEvent {
  source?: string;
  'detail-type'?: string;
  detail?: TypedConversationEventDetail;
}

/**
 * What a declared rule hands over (`lib/constructs/event-opened-conversations.ts`): the declaration it was
 * built from, by id, and the event as it arrived. The declaration names the type and where each field is.
 */
export interface OpenerInvocation {
  aeOpener: string;
  event: unknown;
}

/** The creator's input from a declared rule's invocation, or a refusal. The type is the declaration's alone. */
function detailFromOpener(invocation: OpenerInvocation): TypedConversationEventDetail {
  const resolved = openerById(CONVERSATION_TYPES, String(invocation.aeOpener || ''));
  if (!resolved) throw new Error(`no conversation type declares the opener "${invocation.aeOpener}"`);
  // A RULE IS BUILT ON ONE CLASSIFICATION'S STACK. One that reached another classification's creator is a
  // wiring fault, refused rather than created at this one.
  if (resolved.classification !== DEPLOYED_CLASSIFICATION) {
    throw new Error(`the opener "${resolved.id}" opens at "${resolved.classification}" and this function creates at "${DEPLOYED_CLASSIFICATION}"`);
  }
  const input = openerInput(resolved.opener, invocation.event);
  return {
    conversationType: resolved.typeKey,
    forPerson: input.forPerson,
    ...(input.topicLabel ? { topicLabel: input.topicLabel } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.service ? { service: input.service } : {}),
    ...(input.concernedChannelArn ? { concernedChannelArn: input.concernedChannelArn } : {}),
    ...(input.watchesAlarm ? { watchesAlarm: input.watchesAlarm } : {}),
  } as TypedConversationEventDetail;
}

/**
 * THE OPENING EVENT'S CLAIM KEY (ADR-061 decision 1): the declaration that delivered it and the event's own id, which
 * EventBridge keeps across a redelivery. Undefined for a direct invoke, which no rule redelivers.
 */
export function openingKey(invocation: unknown): string | undefined {
  if (!invocation || typeof invocation !== 'object' || !('aeOpener' in invocation)) return undefined;
  const { aeOpener, event } = invocation as OpenerInvocation;
  const id = event && typeof event === 'object' ? (event as { id?: unknown }).id : undefined;
  return typeof aeOpener === 'string' && aeOpener && typeof id === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(id) ? `opened#${aeOpener}#${id}` : undefined;
}

/**
 * THE PERSON AN ENTRY NAMES, through the directory, or '' when it names nobody. An address is looked up in
 * one issuer's directory (the deployment's own pool unless the entry names another), and two people holding
 * it resolve to nobody, so an address never picks between people.
 */
async function personNamed(entry: string | undefined): Promise<string> {
  const value = (entry || '').trim();
  if (!value) return '';
  if (/^arn:aws:chime:[^ ]+\/user\/[^/ ]+$/.test(value)) return value;
  const directory = defaultDirectory();
  const bar = value.indexOf('|');
  const issuer = bar > 0 ? value.slice(0, bar) : DEPLOYMENT_ISSUER_ID;
  const rest = bar > 0 ? value.slice(bar + 1) : value;
  if (rest.includes('@')) return (await directory.findByAddress(issuer, rest)) || '';
  return (await directory.personOf(value)) || '';
}

export interface TypedConversationResult {
  ok: boolean;
  /** True when the event had already opened this room, and nothing new was created. */
  reused?: boolean;
  channelArn?: string;
  channelId?: string;
  conversationType?: string;
  agents?: string[];
  error?: string;
}

let channelFlowArnCache: string | null = null;
async function resolveChannelFlowArn(): Promise<string> {
  if (channelFlowArnCache !== null) return channelFlowArnCache;
  if (!CHANNEL_FLOW_ARN_PARAM) {
    channelFlowArnCache = '';
    return '';
  }
  const res = await ssmClient.send(new GetParameterCommand({ Name: CHANNEL_FLOW_ARN_PARAM }));
  channelFlowArnCache = res.Parameter?.Value || '';
  return channelFlowArnCache;
}

let primaryCache: { assistant: string; botArn: string } | null = null;
/** The new room's primary: this classification's primary assistant, from the assignment records (§3.8). */
async function resolvePrimary(): Promise<{ assistant: string; botArn: string }> {
  if (primaryCache !== null) return primaryCache;
  primaryCache = await primaryAssignmentOf(DEPLOYED_CLASSIFICATION).catch(() => ({ assistant: '', botArn: '' }));
  return primaryCache;
}

/**
 * THE NAME THE ROOM IS CREATED WITH, AND WHAT IT IS ABOUT, from what opened it (`conversation-name.ts`).
 *
 * The name: the type's own `name`, the event's label, the alarm it watches with its service, its summary, then the
 * room's type (`label.opened`). The subject, a noun phrase the welcome and the notice say: the label, the alarm form,
 * then the room's type, and never the summary sentence. Both are worded by the room's assistant's `conversation-name`
 * template, else the classification's, else the shipped one; a store that cannot be read leaves the shipped wording,
 * never the creation. A room an event opens always has a purpose, so neither is ever the placeholder.
 */
async function openedRoomNaming(typeKey: string, detail: TypedConversationEventDetail, alarm: string | undefined, assistant: string): Promise<{ name: string; subject: string }> {
  const templates = await loadMessageTemplateSet({ classification: DEPLOYED_CLASSIFICATION, ...(assistant ? { assistant } : {}) })
    .catch((err) => {
      console.warn('[typed-conversation] the name templates of the room could not be read; the shipped wording names it', { err: (err as Error)?.name });
      return undefined;
    });
  const values = { label: detail.topicLabel, summary: detail.summary, alarm, service: detail.service, date: nameDate() };
  const words = templates ? { words: { templates } } : {};
  return {
    name: conversationNameFor({ kind: 'opened', typeKey, values, ...words }),
    subject: conversationSubjectFor({ typeKey, values, ...words }),
  };
}

/**
 * The classification tag on the conversation the event named.
 *
 * READ LIVE AND NEVER FROM THE PAYLOAD. The tag is the axis IAM evaluates, and the new conversation names
 * this one as its parent only when both are at the same classification.
 * An unreadable tag is a refusal: a channel whose classification cannot be established is one this
 * function must not act on, and the per-classification roles are fail-closed for the same reason.
 */
async function classificationOf(channelArn: string): Promise<string> {
  return (await readChannelTags(messagingClient, channelArn)).classification || '';
}

export const handler = async (
  event?: TypedConversationEvent | TypedConversationEventDetail | OpenerInvocation,
): Promise<TypedConversationResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  try {
    if (!APP_INSTANCE_ARN) throw new Error('APP_INSTANCE_ARN is required');
    if (!DEPLOYED_CLASSIFICATION) throw new Error('CLASSIFICATION is required');
    // A declared rule's invocation, an EventBridge envelope and a bare object all work: the declaration's
    // fields for a rule, `detail` when present, the object otherwise.
    const detail = (event && 'aeOpener' in event
      ? detailFromOpener(event as OpenerInvocation)
      : event && 'detail' in event && event.detail
        ? event.detail
        : event) as TypedConversationEventDetail | undefined;

    if (!detail?.conversationType) throw new Error('detail.conversationType is required');
    const typeForCheck = detail.conversationType ? getConversationTypeConfig(detail.conversationType) : undefined;
    if (!detail.concernedChannelArn && typeForCheck?.initiation !== 'system') {
      throw new Error('detail.concernedChannelArn is required for a type the platform does not open on its own');
    }
    if (!detail.forUserArn && !detail.forPerson) throw new Error('detail.forUserArn or detail.forPerson is required');
    const forUserArn = detail.forUserArn || await personNamed(detail.forPerson);
    if (!forUserArn) throw new Error('the person this event names resolves to nobody in the directory');
    // A CONFIRMATION NAMES THE PERSON THE ROOM IS FOR, and nobody else: a creator holding is never handed to a third person.
    if (detail.confirmedBy !== undefined && detail.confirmedBy !== forUserArn) {
      throw new Error('the person who confirmed the proposal is not the person the conversation is for; refusing');
    }

    const typeKey = detail.conversationType;
    if (!CONVERSATION_TYPES[typeKey]) {
      throw new Error(`unknown conversation type "${typeKey}"`);
    }
    // AN ALARM IS NAMED AS CLOUDWATCH NAMES ONE, or the event is refused rather than opening a room that watches nothing.
    const watchedAlarm = detail.watchesAlarm?.trim() || undefined;
    if (watchedAlarm && !ALARM_NAME.test(watchedAlarm)) throw new Error('detail.watchesAlarm is not an alarm name');

    const primary = await resolvePrimary();
    const bearerArn = primary.botArn;
    if (!bearerArn) throw new Error('could not resolve this classification\'s assistant bot ARN');

    // CHECK ONE OF TWO: the conversation the event concerned is at the classification this function may
    // create at. The second is in `createConversationFromEvent`, where the TYPE has to permit it as
    // well, and the third is the IAM condition on `chime:TagResource` which allows no other value.
    const concernedClassification = detail.concernedChannelArn
      ? await classificationOf(detail.concernedChannelArn)
      : DEPLOYED_CLASSIFICATION;
    if (concernedClassification !== DEPLOYED_CLASSIFICATION) {
      throw new Error(
        `the conversation this event concerns is classified "${concernedClassification || '(untagged)'}" `
        + `and this function creates at "${DEPLOYED_CLASSIFICATION}"; refusing rather than linking `
        + 'across a classification boundary',
      );
    }

    // THE ASSISTANTS THE TYPE NAMES, resolved BEFORE anything is created. An unresolvable handle is a
    // refusal here rather than a conversation delivered without the assistant it was opened for.
    const typeConfig = getConversationTypeConfig(typeKey);
    const agents = await resolveDefaultAgents(
      DEPLOYED_CLASSIFICATION,
      typeConfig.defaultAgents ?? [],
    );

    // THE PEOPLE, AS THE TYPE'S MEMBERSHIP SOURCE DECLARES (DESIGN-CONVERSATION-TYPES §6). A type with a
    // source adds the people it ADMITS - its group's members, each checked against this classification
    // - and the membership reconcile keeps the room equal to that set afterwards. A manual type adds
    // only the person the event named. Never the concerned conversation's roster: who is in an incident
    // room is the type's decision, not an accident of which room the event touched.
    //
    // THE LEAD MUST BE IN THE ALLOWED SET of a sourced type. Otherwise the first reconcile would remove
    // the person the room was opened for, so the creation is refused here with a reason instead.
    const source = membershipSourceFor(typeKey);
    let humans: string[] = [];
    if (source) {
      const allowed = await resolveAllowedSet(source, DEPLOYED_CLASSIFICATION, APP_INSTANCE_ARN, defaultDirectory(), typeKey);
      if (allowed.refused.length) {
        console.warn('[typed-conversation] named by the membership source but not admitted at this classification; not added', {
          refused: allowed.refused.length, classification: DEPLOYED_CLASSIFICATION,
        });
      }
      if (!allowed.admitted.has(forUserArn)) {
        throw new Error(
          `the person this event names is not in the "${typeKey}" type's membership source, or is not admitted at `
          + `"${DEPLOYED_CLASSIFICATION}"; refusing rather than opening a room the next reconcile would remove them from`,
        );
      }
      humans = [...allowed.admitted];
    } else if (admittedIssuersOf(typeKey) !== null) {
      // A MANUAL TYPE THAT NARROWS BY ISSUER (T1, FR23) still refuses a lead of an issuer it does not list.
      const lead = await defaultDirectory().clearanceOf(forUserArn);
      const issuers = lead.state === 'held' ? lead.issuers ?? [] : [];
      if (!typeAdmitsIssuers(typeKey, issuers)) {
        throw new Error(`the "${typeKey}" type does not admit the issuer the person this event names signs in through`);
      }
    }
    // THE ROOM'S PARTICIPANT ROLES (DESIGN-CONVERSATION-TYPES section 6.1): each group a role is sourced from, admitted
    // against this classification as a membership source is. A group that cannot be listed names nobody for its role,
    // and a role that `adds` its holders (FR31) puts the admitted ones in the room, whose arrival is `person-joined`.
    const roleGroups: Record<string, string[]> = {};
    for (const group of new Set(groupSourcedRoles((k) => k === typeKey).map((r) => r.group))) {
      const set = await resolveAllowedSet({ group }, DEPLOYED_CLASSIFICATION, APP_INSTANCE_ARN, defaultDirectory(), typeKey).catch((err) => {
        console.warn('[typed-conversation] a participant role\'s group could not be resolved; it names nobody', { message: (err as Error)?.message });
        return null;
      });
      if (set) roleGroups[group] = [...set.admitted];
    }
    const roleAdds = holdersToAdd(typeKey, roleGroups, [forUserArn, ...humans]);
    if (roleAdds.length) humans = [...new Set([...humans, ...roleAdds])];
    const participantRoles = holdingsAtCreation(typeKey, {
      forPerson: forUserArn, groups: roleGroups, members: [forUserArn, ...humans],
      ...(detail.confirmedBy ? { creator: detail.confirmedBy } : {}),
    });
    // A ROLE THAT CONFERS `moderator` makes its holders moderators while the service admin creates the room; the opener
    // already is one by creation, so their holding names no moderation of its own.
    const roleModerators: string[] = [];
    for (const [role, people] of Object.entries(participantRoles)) {
      if (!participantRolesOf(typeKey)[role]?.confers?.moderator) continue;
      for (const id of Object.keys(people)) {
        if (id === personIdFromArn(forUserArn)) continue;
        people[id] = { ...people[id], moderation: moderationOrigin(role) };
        roleModerators.push(userArnFor(APP_INSTANCE_ARN, id));
      }
    }
    const channelFlowArn = await resolveChannelFlowArn();

    // ONE ROOM PER OPENING EVENT (ADR-061 decision 1): a redelivered event finds its claim and opens nothing, and the
    // room it opened is the answer. Claimed after every refusal above, so a refused event claims nothing.
    const opening = openingKey(event);
    if (opening) {
      const claim = await claimOpening(opening);
      if ('existing' in claim) {
        console.log('[typed-conversation] the event already opened its room; nothing is created', { conversationType: typeKey });
        return { ok: true, reused: true, channelArn: claim.existing, channelId: claim.existing.split('/channel/')[1], conversationType: typeKey };
      }
      if ('busy' in claim) throw new Error('another delivery of this event is opening its room');
      if ('failed' in claim) throw new Error('the event could not be claimed, so no room is opened rather than risk a second');
    }

    // THE ROOM IS NAMED AT CREATION, from what opened it, so it never shows the placeholder while it has a purpose, and its
    // subject is kept apart from its name: a name may be the summary sentence, a subject is always a noun phrase.
    const { name, subject } = await openedRoomNaming(typeKey, detail, watchedAlarm, primary.assistant);

    const created = await createConversationFromEvent({
      appInstanceArn: APP_INSTANCE_ARN,
      botArn: bearerArn,
      userArn: forUserArn,
      typeKey,
      classification: DEPLOYED_CLASSIFICATION,
      // The channel's member-readable model LABELS, carried from the event when it has them and empty
      // otherwise - the same shape `conversation-split.ts` passes, and for the same reason: these are
      // display fields on Metadata, and nothing decides anything from them. What model actually answers
      // is the assistant's own profile, resolved per turn.
      modelId: detail.modelId || '',
      modelName: detail.modelName || '',
      topicLabel: subject,
      name,
      // WHAT THE ISSUE IS, carried into the conversation so its assistants open on it rather than
      // asking.
      issue: detail.summary,
      // WHO CREATES IT. The service admin, so the flow is attached before any assistant is a member and
      // every welcome goes through it. Empty refuses the creation (`NoServiceAdminError`).
      creatorBearerArn: await resolveServiceAdminBearer(),
      channelFlowArn,
      ...(detail.concernedChannelArn ? { parentChannelArn: detail.concernedChannelArn } : {}),
      additionalMemberArns: humans,
      agents,
      // THE ROOM'S PARTICIPANT ROLES, resolved from the sources the type declares (DESIGN-CONVERSATION-TYPES section
      // 6.1): the person the event names holds each role sourced from it. Recorded on the context row before the
      // channel exists, so the opening's workflow addresses and mentions the holders.
      participantRoles,
      ...(roleModerators.length ? { roleModerators } : {}),
      ...(watchedAlarm ? { watchedAlarm } : {}),
    });
    if (opening) await settleOpening(opening, created.channelArn);

    // THE ROOM WATCHES THE ALARM (ADR-061, the incident watch): the alarm's watch record names this room, the newest one
    // opened for it, and the router runs `alarm-state-changed` here while this record and the row both name it. A record
    // that could not be written leaves the room standing and watching nothing.
    if (watchedAlarm) {
      const watching = await recordAlarmWatch(alarmWatchKey(watchedAlarm), { room: created.channelArn, classification: DEPLOYED_CLASSIFICATION });
      console.log('[typed-conversation] watches an alarm', { recorded: watching });
    }

    console.log('[typed-conversation] created', {
      channelArn: created.channelArn,
      conversationType: typeKey,
      classification: DEPLOYED_CLASSIFICATION,
      agents: agents.map((a) => `${a.handle}(${a.role})`),
      humansAdded: humans.length,
    });

    // `conversation-opened` IS NAMED TO THE ROUTER once the people the type admits are in the room (ADR-061
    // decision 1). Where the room's assistant declares a workflow for it, that run greets the room and its lead,
    // and the separate welcome below is not sent, so a person receives one welcome, not two.
    // Never fails the creation: a run that cannot be asked for leaves the separate welcome to greet the room.
    const opened = await Promise.resolve()
      .then(() => nameEventThroughRouter(DEPLOYED_CLASSIFICATION, {
        event: 'conversation-opened', channelArn: created.channelArn, personArn: forUserArn, label: subject,
      }))
      .catch((): { ran: boolean; people?: string[] } => ({ ran: false }));
    console.log('[typed-conversation] conversation-opened', { ran: opened.ran });

    // `person-joined` IS NAMED FOR EACH PERSON THE ROOM ADMITTED (ADR-061 decision 1), the lead first, in one naming,
    // except a person the `conversation-opened` run owns: the lead arrives with the opening, and that run is their
    // welcome, so they are welcomed once (`peopleJoiningAfterOpening`). Where the room's assistant declares a workflow on
    // `person-joined`, that run welcomes each of the others, by email too, and the separate welcome below is not sent to
    // them. A naming that fails owns nobody, and the welcome below is sent.
    const ownedByOpening = new Set(opened.people ?? []);
    const joinedRun = await Promise.resolve()
      .then(() => personJoinedThroughRouter(DEPLOYED_CLASSIFICATION, created.channelArn, peopleJoiningAfterOpening(forUserArn, humans, ownedByOpening)))
      .catch(() => new Set<string>());

    // THE PEOPLE IT WAS OPENED FOR ARE TOLD, privately and by email, as the room's primary
    // (`lib/typed-conversation-notice.ts`). In the NEW room only; a welcome that is not said leaves the room
    // standing.
    const directory = defaultDirectory();
    const welcomed = opened.ran ? { said: 0, notSaid: 0 } : await welcomeIntoOpenedConversation({
      classification: DEPLOYED_CLASSIFICATION,
      channelArn: created.channelArn,
      botArn: bearerArn,
      leadArn: forUserArn,
      people: humans,
      topicLabel: subject,
      welcomedByRun: joinedRun,
    }, {
      nameOf: typeof directory.displayNameFor === 'function' ? (arn) => directory.displayNameFor(arn) : undefined,
    }).catch(() => ({ said: 0, notSaid: 0 }));
    console.log('[typed-conversation] welcomed', { said: welcomed.said, notSaid: welcomed.notSaid });

    return {
      ok: true,
      channelArn: created.channelArn,
      channelId: created.channelId,
      conversationType: typeKey,
      agents: agents.map((a) => a.handle),
    };
  } catch (err) {
    // NEVER THROWN. An EventBridge target that throws is retried, and a retried creation is a second
    // conversation rather than a repaired one.
    const error = err instanceof Error ? err.message : String(err);
    console.error('[typed-conversation] refused or failed; no conversation was created', { error });
    return { ok: false, error };
  }
};
