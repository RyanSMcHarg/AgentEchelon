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
 * reads none of its members: a person posts there when anything should be said. The role holds no send on
 * it. Where the deployment declares `meetings`, the role reads one membership at a time
 * (`DescribeChannelMembership`, this classification's conversations, bearing the service admin): a meeting's
 * own conversation is opened for, and admits, only a member of the room it was started from, and takes that
 * room's assistants.
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
import { addInvitedMember, channelStands, completeTeamRoom, createConversationFromEvent, requireServiceAdmin } from './lib/channel-creation.js';
import { continueEventRunThroughRouter, nameEventThroughRouter, personJoinedThroughRouter, type EventContinuation } from './lib/say-through-router.js';
import { resolveRouterArn } from './lib/router-arn.js';
import { teamRoomChannelId } from './lib/event-triggers.js';
import { conversationRef } from './lib/notify-directive.js';
import { CHILD_LINK_VALUE, OPEN_STEP_OPENED, isCustomerImpact, incidentFactsOf } from './lib/event-workflow.js';
import { PRIMARY_ROLE, primaryAssignmentOf, primaryAssistantOf } from './lib/conversation-primary.js';
import { PLACEHOLDER_TITLE, conversationNameFor, conversationSubjectFor, nameDate } from './lib/conversation-name.js';
import { loadMessageTemplateSet } from './lib/message-template-selection.js';
import { resolveServiceAdminBearer } from './lib/service-admin-bearer.js';
import { resolveDefaultAgents, liveAssistantsByHandleOrThrow, type ResolvedAgent } from './lib/default-agents.js';
import {
  CONVERSATION_TYPES,
  MEETING_CONVERSATION_TYPE,
  meetingSettingsOf,
  admittedIssuersOf,
  getConversationTypeConfig,
  membershipSourceFor,
  typeAdmitsIssuers,
} from '../../lib/config/conversation-types.js';
import { defaultDirectory, resolveAllowedSet } from './lib/membership-source.js';
import type { Classification } from '../../lib/config/model-strategy.js';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { conversationClosedTo, readChannelTags } from './lib/channel-classification.js';
import { openIsNestedBy } from './lib/conversation-nesting.js';
import { loadProfileRegistry } from '../../lib/profile-registry';
import { REF_KIND, openerById, openerInput, openerWatchKey, refId, refKey } from '../../lib/config/event-openers.js';
import { DEPLOYMENT_ISSUER_ID } from '../../lib/config/issuers.js';
import { peopleJoiningAfterOpening, welcomeIntoOpenedConversation } from './lib/typed-conversation-notice.js';
import { holdersToAdd, holdingsAtCreation, moderationOrigin } from './lib/participant-roles.js';
import { groupSourcedRoles, participantRolesOf } from '../../lib/config/participant-roles.js';
import { isPersonOf, personIdFromArn, rosterOf, userArnFor } from './lib/person-arn.js';
import { claimOpening, claimRefWatch, putChannelContext, readChannelContext, recordAlarmWatch, recordMeetingOf, refWatchOf, settleOpening } from './lib/channel-context-client.js';
import { conversationChannelArn, isNotAMemberError } from './lib/conversation-access.js';
import { DescribeChannelCommand, DescribeChannelMembershipCommand, ListChannelMembershipsCommand, ListChannelModeratorsCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { carryRoomPeople, isArchived, roomMemberMayEnter } from './lib/meeting-admission.js';
import { ALARM_NAME, alarmWatchKey, refWatchKey } from './lib/event-workflow.js';
import { addPeopleToMeeting, briefOnArrival, type MeetingAddAnswer, type MeetingAddRequest, type MeetingAdditionDeps, type MeetingArrivalAnswer, type MeetingArrivalRequest } from './lib/meeting-additions.js';
import { claimArrivalBrief, recordMeetingInvites } from './lib/channel-context-client.js';
import { sayThroughRouter } from './lib/say-through-router.js';
import { defaultProfileRegistry } from '../../lib/profile-registry';

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
  /**
   * THE PERSON IS THE ONE HOLDER OF THIS ROLE OF THE TYPE (WT120): a group-sourced role such as `on-call:ops`, read now, so an
   * event that names nobody still has a lead. No holder, or several, opens nothing: a lead is never guessed.
   */
  forRole?: string;
  /** This is the type's one team room: its id and tag follow the convention, and an existing room is the answer (WT121). */
  teamRoom?: boolean;
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
  /**
   * THE KEY THE NEW CONVERSATION WATCHES (DESIGN-EVENT-TARGETS section 3), from a declared opener's `watches` alone: the kind
   * is the declaration's and the id the event's. A live conversation that already watches it is returned instead.
   */
  watchesRef?: { kind: string; id: string };
  /**
   * THE RUN WHOSE STEP ASKED FOR THIS CONVERSATION (WT120), handed back to the router once the conversation stands, with its
   * link, or could not be opened. Its own router verifies it again before the run goes on.
   */
  continueRun?: Omit<EventContinuation, 'outcome'>;
  /** Display-only model labels for the new channel's Metadata. Nothing decides anything from them. */
  modelId?: string;
  modelName?: string;
}

export interface TypedConversationEvent {
  source?: string;
  'detail-type'?: string;
  detail?: TypedConversationEventDetail;
}

/** The one person a type's group-sourced role names now. Anything but exactly one refuses: a lead is never guessed. */
async function soleHolderOf(typeKey: string, role: string): Promise<string> {
  const group = groupSourcedRoles((k) => k === typeKey).find((r) => r.role === role && r.decl.holders === 'one')?.group;
  if (!group) throw new Error(`the "${typeKey}" type declares no group-sourced role "${role}" with one holder`);
  const admitted = [...(await resolveAllowedSet({ group }, DEPLOYED_CLASSIFICATION, APP_INSTANCE_ARN, defaultDirectory(), typeKey)).admitted];
  if (admitted.length !== 1) throw new Error(`the "${role}" role has ${admitted.length} holders where this room's lead must be one`);
  return admitted[0];
}

/**
 * THE ASSISTANTS A ROOM OF THE TYPE IS CREATED WITH: every `defaultAgents` assistant, each required, and every
 * `optionalAgents` assistant the classification has live, each passed over where the deployment declares none. A read of
 * the assignments that fails throws, so an optional assistant is never left out because it could not be read.
 */
export async function typeAgents(typeKey: string): Promise<ResolvedAgent[]> {
  const type = getConversationTypeConfig(typeKey);
  const required = await resolveDefaultAgents(DEPLOYED_CLASSIFICATION, type.defaultAgents ?? []);
  if (!type.optionalAgents?.length) return required;
  const live = await liveAssistantsByHandleOrThrow(DEPLOYED_CLASSIFICATION);
  const optional = type.optionalAgents.map((h) => live.get(h)).filter((a): a is ResolvedAgent => !!a && !required.some((r) => r.botArn === a.botArn));
  return [...required, ...optional];
}

/**
 * COMPLETE A STANDING TEAM ROOM WITH NO LEAD: its primary, the assistants and people its type names, added as a creation adds
 * them. A room that does not stand is not created here, and the lead's refusal (`leadErr`) is the answer.
 */
async function completeTeamRoomWithoutLead(typeKey: string, leadErr: unknown): Promise<void> {
  const channelArn = `${APP_INSTANCE_ARN}/channel/${teamRoomChannelId(typeKey, DEPLOYED_CLASSIFICATION)}`;
  const bearerArn = requireServiceAdmin(await resolveServiceAdminBearer());
  if (!(await channelStands(channelArn, bearerArn))) throw leadErr;
  const primary = await resolvePrimary();
  if (!primary.botArn) throw new Error('could not resolve this classification\'s assistant bot ARN');
  const agents = await typeAgents(typeKey);
  const source = membershipSourceFor(typeKey);
  const people = source ? [...(await resolveAllowedSet(source, DEPLOYED_CLASSIFICATION, APP_INSTANCE_ARN, defaultDirectory(), typeKey)).admitted] : [];
  const channelFlowArn = await resolveChannelFlowArn();
  await completeTeamRoom({
    channelArn, primaryBotArn: primary.botArn, leadArn: '', memberArns: people,
    agentBotArns: agents.map((a) => a.botArn).filter((a): a is string => !!a), roleModerators: [],
    bearerArn, ...(channelFlowArn ? { channelFlowArn } : {}),
  });
  console.log('[typed-conversation] the team room stands; completed without a lead, whose role has no single holder', { conversationType: typeKey });
}

/** Hand the run that asked for this conversation back to its router. A hand-back that fails leaves the room standing. */
async function handBackRun(run: Omit<EventContinuation, 'outcome'>, outcome: string, values: Record<string, string>): Promise<void> {
  const routerArn = await resolveRouterArn(DEPLOYED_CLASSIFICATION).catch(() => undefined);
  const handed = routerArn ? await continueEventRunThroughRouter(routerArn, { ...run, outcome, values: { ...run.values, ...values } }) : false;
  if (!handed) console.warn('[typed-conversation] the run that asked for this conversation could not be handed back', { step: run.step, outcome });
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
  const watchesRef = openerWatchKey(resolved.opener, invocation.event);
  if (watchesRef === null) throw new Error(`the event names no key the opener "${resolved.id}" can watch at ${resolved.opener.watches?.path}`);
  return {
    conversationType: resolved.typeKey,
    forPerson: input.forPerson,
    ...(input.topicLabel ? { topicLabel: input.topicLabel } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    ...(input.service ? { service: input.service } : {}),
    ...(input.concernedChannelArn ? { concernedChannelArn: input.concernedChannelArn } : {}),
    ...(input.watchesAlarm ? { watchesAlarm: input.watchesAlarm } : {}),
    ...(watchesRef ? { watchesRef } : {}),
  } as TypedConversationEventDetail;
}

/**
 * WHETHER A CONVERSATION STILL WATCHES A KEY: `live` when it stands, is not archived, is at this classification, and its row
 * lists the key; `released` when the service or its row says it no longer does (gone, archived, another classification, the
 * key not listed); `unknown` when either could not be read. Only `released` lets a key move, and only `live` stops a new
 * room opening, so a read that fails neither hands a key away nor opens a second room for it.
 */
export async function watchesRefLive(room: string, key: string): Promise<'live' | 'released' | 'unknown'> {
  let tags: Record<string, string | undefined>;
  try {
    tags = await readChannelTags(messagingClient as never, room);
  } catch (err) {
    const name = (err as Error)?.name;
    return name === 'NotFoundException' || name === 'ResourceNotFoundException' ? 'released' : 'unknown';
  }
  if (conversationClosedTo(tags, DEPLOYED_CLASSIFICATION)) return 'released';
  const row = await readChannelContext(room, { consistent: true }).catch(() => undefined);
  if (row === undefined) return 'unknown';
  return row?.watchedRefs?.includes(key) ? 'live' : 'released';
}

/**
 * A ROOM HOLDS ITS KEY'S WATCH: the claim (`claimRefWatch`) is tried again while the store cannot be written, so a write
 * that fails once does not leave the room watching nothing. Answers the conversation that holds the key, or null when every
 * attempt failed.
 */
/** A room opened for an event stands, and its key's watch could not be written: the one failure the opener throws. */
export class KeyWatchUnwritten extends Error {
  constructor(message: string) { super(message); this.name = 'KeyWatchUnwritten'; }
}

export async function holdRefWatch(claim: () => Promise<string | null>, attempts = 3, pauseMs = 200): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    const holder = await claim().catch(() => null);
    if (holder) return holder;
    if (i + 1 < attempts) await new Promise((r) => setTimeout(r, pauseMs * (i + 1)));
  }
  return null;
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
/**
 * The new room's primary, from the assignment records (§3.8): this classification's primary assistant, the same for
 * every room this function creates. Exactly one, recorded on the room's `primaryAssistant` tag in the create call.
 * Remembered for the container's life once found; a lookup that fails is not remembered, so the next creation asks again.
 */
export async function resolvePrimary(): Promise<{ assistant: string; botArn: string }> {
  if (primaryCache) return primaryCache;
  const found = await primaryAssignmentOf(DEPLOYED_CLASSIFICATION, PRIMARY_ROLE).catch((err) => {
    console.warn('[typed-conversation] this classification\'s primary assistant could not be read', { err: (err as Error)?.name });
    return null;
  });
  if (!found?.botArn) return { assistant: '', botArn: '' };
  primaryCache = found;
  return found;
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
async function openedRoomNaming(
  typeKey: string, detail: TypedConversationEventDetail, alarm: string | undefined, assistant: string, meetingOfRoom?: string,
): Promise<{ name: string; subject: string }> {
  const templates = await loadMessageTemplateSet({ classification: DEPLOYED_CLASSIFICATION, ...(assistant ? { assistant } : {}) })
    .catch((err) => {
      console.warn('[typed-conversation] the name templates of the room could not be read; the shipped wording names it', { err: (err as Error)?.name });
      return undefined;
    });
  const values = { label: detail.topicLabel, summary: detail.summary, alarm, service: detail.service, date: nameDate() };
  const words = templates ? { words: { templates } } : {};
  // A MEETING'S OWN CONVERSATION is named for its room (`label.meeting`), where the room's name could be read.
  const forMeeting = meetingOfRoom ? conversationNameFor({ kind: 'meeting', typeKey, values: { label: meetingOfRoom }, ...words }) : '';
  return {
    name: forMeeting && forMeeting !== PLACEHOLDER_TITLE ? forMeeting : conversationNameFor({ kind: 'opened', typeKey, values, ...words }),
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

/**
 * A MEETING'S OWN CONVERSATION (SPEC-ASSISTANT-MEETINGS FR27, FR42), asked for by the Meetings stack's meeting function,
 * which has already checked the person against the conversation the meeting is started from, as that person:
 *  - `open`: the meeting's conversation, a `meeting` conversation at this classification, for the person who started
 *    the meeting (its member and moderator) or for nobody when a workflow started it, owned by the primary of the
 *    conversation it was started from, with that conversation's other assistants as members (`roomAssistantsOf`). Its
 *    row names that conversation (`meetingOf`), and it is answered only once the
 *    row does. Every person that conversation holds, cleared for this classification now, is then its member
 *    (`carryRoomPeople`). A meeting's conversation opens no meeting conversation of its own.
 *  - `admit`: one person added to a meeting's conversation, and to nothing else, by the rule the meeting function applied
 *    (`meeting-admission.ts`), for the conversation whose membership that function proved (`parentChannelArn`).
 *  - `carry`: the rest of the room carried after an `open` answered with some left (`carryLeft`), asked without waiting:
 *    every person of the room its row names (`meetingOf`) who is not yet a member, cleared for this classification now.
 * Both act only on conversations this function may create at: the classification is the deployment's, read from each
 * conversation's tag, and neither acts in an archived conversation.
 */
export type MeetingConversationRequest =
  | { aeMeeting: 'open'; parentChannelArn: string; forUserArn?: string }
  | { aeMeeting: 'admit'; meetingChannelArn: string; personArn: string; parentChannelArn: string }
  | { aeMeeting: 'carry'; meetingChannelArn: string; parentChannelArn: string };

/**
 * `roomModeratorIds`: on an `open` for nobody (a workflow's start), the person ids of the parent conversation's moderators, read as the
 * service admin, who host a meeting no host role holder hosts (`meeting-host.ts`). Absent where none could be read.
 * `carryLeft`: on an `open`, people of the room were not carried by the time it answered, so the meeting function asks for
 * the rest (`carry`) without waiting.
 */
export type MeetingConversationAnswer = { ok: true; channelArn: string; roomModeratorIds?: string[]; carryLeft?: true } | { ok: false; code: string };

const isMeetingRequest = (event: unknown): event is MeetingConversationRequest =>
  !!event && typeof event === 'object' && ['open', 'admit', 'carry'].includes((event as { aeMeeting?: unknown }).aeMeeting as string);

/**
 * PEOPLE A CONFIRMED PROPOSAL ADDS TO A MEETING (`add`), and the brief each is told when they first join (`arrived`)
 * (`lib/meeting-additions.ts`): the meeting's own conversation alone, at this classification, as the service admin.
 */
const isMeetingAddition = (event: unknown): event is MeetingAddRequest | MeetingArrivalRequest =>
  !!event && typeof event === 'object' && ((event as { aeMeeting?: unknown }).aeMeeting === 'add' || (event as { aeMeeting?: unknown }).aeMeeting === 'arrived');

/** What adding people to a meeting reads and writes, as this creator holds it. */
function meetingAdditionDeps(): MeetingAdditionDeps {
  return {
    appInstanceArn: APP_INSTANCE_ARN,
    classification: DEPLOYED_CLASSIFICATION,
    closedCode,
    readRow: (channelArn) => readChannelContext(channelArn, { consistent: true }),
    serviceAdmin: async () => requireServiceAdmin(await resolveServiceAdminBearer()),
    addMember: addInvitedMember,
    admits: clearedHere,
    isAssistantHere: async (botArn) => [...(await liveAssistantsByHandleOrThrow(DEPLOYED_CLASSIFICATION)).values()].some((a) => a.botArn === botArn),
    recordInvites: recordMeetingInvites,
    claimBrief: claimArrivalBrief,
    say: sayThroughRouter,
    meetingNameOf: roomNameOf,
  };
}

async function meetingAddition(request: MeetingAddRequest | MeetingArrivalRequest): Promise<MeetingAddAnswer | MeetingArrivalAnswer> {
  if (!APP_INSTANCE_ARN || !DEPLOYED_CLASSIFICATION) return { ok: false, code: 'NOT_CONFIGURED' };
  try {
    return request.aeMeeting === 'add' ? await addPeopleToMeeting(request, meetingAdditionDeps()) : await briefOnArrival(request, meetingAdditionDeps());
  } catch (err) {
    console.error('[typed-conversation] the meeting addition failed', { op: request.aeMeeting, err: (err as Error)?.name });
    return { ok: false, code: 'FAILED' };
  }
}

/** A channel of this app instance, by its full ARN, or ''. The one conversation-id rule (`conversationChannelArn`). */
const ownChannel = (arn: unknown): string =>
  typeof arn === 'string' && arn.startsWith('arn:') ? conversationChannelArn(arn, APP_INSTANCE_ARN) ?? '' : '';
/** An AppInstanceUser of this app instance, by its ARN, or ''. */
const ownPerson = (arn: unknown): string =>
  typeof arn === 'string' && arn.length <= 1600 && isPersonOf(arn, APP_INSTANCE_ARN) ? arn : '';

/** ADMITTED AS ANY MEMBERSHIP IS: whether a person's clearance reaches this classification now. */
async function clearedHere(personArn: string): Promise<boolean> {
  const clearance = await defaultDirectory().clearanceOf(personArn);
  return clearance.state === 'held' && defaultProfileRegistry.holderReaches({ token: clearance.token, adminPlane: clearance.adminPlane === true }, DEPLOYED_CLASSIFICATION);
}

/** Whether a person is a member of a conversation, read as the service admin. A read that fails throws. */
async function isMemberOf(channelArn: string, personArn: string, bearerArn: string): Promise<boolean> {
  try {
    await messagingClient.send(new DescribeChannelMembershipCommand({ ChannelArn: channelArn, MemberArn: personArn, ChimeBearer: bearerArn }));
    return true;
  } catch (err) {
    if (isNotAMemberError(err)) return false;
    throw err;
  }
}

/**
 * THE ROOM'S OTHER ASSISTANTS, each live assistant of this classification that is a member of the room now, read as the
 * service admin, besides `primaryBotArn`. A meeting's conversation carries on part of its room's subject, so the assistants
 * working that subject are in it: an incident's call has its ops assistant to ask. One membership read per live
 * assistant, which this function's role already holds. A read that fails throws, so a meeting's conversation never opens
 * without an assistant its room has.
 */
async function roomAssistantsOf(roomArn: string, primaryBotArn: string): Promise<ResolvedAgent[]> {
  const admin = requireServiceAdmin(await resolveServiceAdminBearer());
  const candidates = new Map<string, ResolvedAgent>();
  for (const a of (await liveAssistantsByHandleOrThrow(DEPLOYED_CLASSIFICATION)).values()) {
    if (a.botArn && a.botArn !== primaryBotArn && !candidates.has(a.botArn)) candidates.set(a.botArn, a);
  }
  const inRoom = await Promise.all([...candidates.values()].map(async (a) => ((await isMemberOf(roomArn, a.botArn, admin)) ? a : null)));
  return inRoom.filter((a): a is ResolvedAgent => !!a);
}

/** The most pages of a parent conversation's members or moderators read, fifty a page. */
const ROOM_PAGES = 20;

/** Every person (AppInstanceUser ARN) a parent conversation holds now, read as the service admin. A read that fails throws. */
async function roomPeopleOf(roomArn: string, bearerArn: string): Promise<string[]> {
  const people: string[] = [];
  let NextToken: string | undefined;
  let pages = 0;
  do {
    pages += 1;
    const res = await messagingClient.send(new ListChannelMembershipsCommand({ ChannelArn: roomArn, ChimeBearer: bearerArn, MaxResults: 50, NextToken }));
    for (const m of rosterOf(res.ChannelMemberships)) if (m.kind === 'person') people.push(m.arn);
    NextToken = res.NextToken;
  } while (NextToken && pages < ROOM_PAGES);
  return people;
}

/** The person ids of a parent conversation's moderators, read as the service admin; none where they cannot be read. */
async function roomModeratorIdsOf(roomArn: string, bearerArn: string): Promise<string[]> {
  try {
    const ids: string[] = [];
    let NextToken: string | undefined;
    let pages = 0;
    do {
      pages += 1;
      const res = await messagingClient.send(new ListChannelModeratorsCommand({ ChannelArn: roomArn, ChimeBearer: bearerArn, MaxResults: 50, NextToken }));
      for (const m of res.ChannelModerators ?? []) {
        const arn = m.Moderator?.Arn;
        if (arn && isPersonOf(arn, APP_INSTANCE_ARN)) { const id = personIdFromArn(arn); if (id) ids.push(id); }
      }
      NextToken = res.NextToken;
    } while (NextToken && pages < ROOM_PAGES);
    return [...new Set(ids)];
  } catch (err) {
    console.warn("[typed-conversation] the parent conversation's moderators could not be read; the meeting records no host", { err: (err as Error)?.name });
    return [];
  }
}

/** Why this function does not act in a conversation, as the answer's code, or undefined when it may. */
async function closedCode(channelArn: string): Promise<string | undefined> {
  const closed = conversationClosedTo(await readChannelTags(messagingClient, channelArn), DEPLOYED_CLASSIFICATION);
  if (closed === 'archived') return 'CONVERSATION_ARCHIVED';
  return closed ? 'NOT_THIS_CLASSIFICATION' : undefined;
}

/** A room's name as people read it, read as the service admin, or undefined where it cannot be read. */
async function roomNameOf(channelArn: string): Promise<string | undefined> {
  try {
    const res = await messagingClient.send(new DescribeChannelCommand({ ChannelArn: channelArn, ChimeBearer: requireServiceAdmin(await resolveServiceAdminBearer()) }));
    return res.Channel?.Name || undefined;
  } catch (err) {
    console.warn("[typed-conversation] the room's name could not be read; the meeting is named by its type", { err: (err as Error)?.name });
    return undefined;
  }
}

/**
 * HOW LONG A MEETING'S CONVERSATION TAKES TO ANSWER ITS OPEN, from the request: inside the meetings function's one wait for it
 * (`meeting-api.ts`, ten seconds), so a large room's start answers rather than times out and leaves an orphan behind it.
 * Room members not carried by then enter by joining, through the admission rule (`aeMeeting: 'admit'`).
 */
export const MEETING_OPEN_ANSWER_MS = 7_000;

/** A carry's step that is not begun once its deadline has passed: the person enters by joining instead. */
export function beforeDeadline<A extends unknown[], T>(deadline: number, step: (...args: A) => Promise<T>, now: () => number = Date.now): (...args: A) => Promise<T> {
  return async (...args: A) => {
    if (now() >= deadline) throw Object.assign(new Error('the meeting conversation answers now; this person enters by joining'), { name: 'CarryDeadline' });
    return step(...args);
  };
}

export async function meetingConversation(request: MeetingConversationRequest): Promise<MeetingConversationAnswer> {
  const answerBy = Date.now() + MEETING_OPEN_ANSWER_MS;
  if (!APP_INSTANCE_ARN || !DEPLOYED_CLASSIFICATION) return { ok: false, code: 'NOT_CONFIGURED' };
  try {
    if (request.aeMeeting === 'admit') {
      const meetingArn = ownChannel(request.meetingChannelArn);
      const personArn = ownPerson(request.personArn);
      const parentArn = ownChannel(request.parentChannelArn);
      if (!meetingArn || !personArn || !parentArn) return { ok: false, code: 'INVALID_REQUEST' };
      const meetingClosed = await closedCode(meetingArn);
      if (meetingClosed) return { ok: false, code: meetingClosed };
      const meetingRow = await readChannelContext(meetingArn, { consistent: true });
      if (!meetingSettingsOf(meetingRow?.conversationType)) return { ok: false, code: 'NOT_A_MEETING' };
      // The membership the meeting function proved is of the conversation this meeting was started from, and no other.
      if (meetingRow?.meetingOf !== parentArn) return { ok: false, code: 'NOT_THE_ROOMS_MEETING' };
      const parentClosed = await closedCode(parentArn);
      if (parentClosed) return { ok: false, code: parentClosed };
      const rule = roomMemberMayEnter({
        meetingArn, meetingRow, meetingArchived: false, parentRow: await readChannelContext(parentArn, { consistent: true }), parentArchived: false,
      });
      if (!rule.ok) return { ok: false, code: rule.code };
      // THE PERSON IS A MEMBER OF THE ROOM AND CLEARED FOR IT, read here as well as by the meeting function that asked (tenet D3).
      const admin = requireServiceAdmin(await resolveServiceAdminBearer());
      if (!(await isMemberOf(parentArn, personArn, admin))) return { ok: false, code: 'NOT_A_MEMBER' };
      if (!(await clearedHere(personArn))) return { ok: false, code: 'NOT_CLEARED' };
      await addInvitedMember({ channelArn: meetingArn, inviteeArn: personArn, bearerArn: admin });
      return { ok: true, channelArn: meetingArn };
    }
    if (request.aeMeeting === 'carry') return await carryTheRest(request);

    const parentArn = ownChannel(request.parentChannelArn);
    const forUserArn = request.forUserArn === undefined ? '' : ownPerson(request.forUserArn);
    if (!parentArn || (request.forUserArn !== undefined && !forUserArn)) return { ok: false, code: 'INVALID_REQUEST' };
    const parentClosed = await closedCode(parentArn);
    if (parentClosed) return { ok: false, code: parentClosed };
    // A MEETING'S CONVERSATION OPENS NO MEETING CONVERSATION: a meeting started in one is held there.
    if (meetingSettingsOf((await readChannelContext(parentArn, { consistent: true }))?.conversationType)) return { ok: false, code: 'NESTED' };
    // THE PERSON IT IS OPENED FOR, who moderates it, is a member of the room and cleared for it, read here as well as by the
    // meeting function that asked (tenet D3).
    if (forUserArn) {
      const admin = requireServiceAdmin(await resolveServiceAdminBearer());
      if (!(await isMemberOf(parentArn, forUserArn, admin))) return { ok: false, code: 'NOT_A_MEMBER' };
      if (!(await clearedHere(forUserArn))) return { ok: false, code: 'NOT_CLEARED' };
    }

    // THE PRIMARY OF THE CONVERSATION IT WAS STARTED FROM owns the meeting's conversation, moderates it and answers in it,
    // as it posts the meeting's cards and runs its workflows in that conversation.
    const primary = await primaryAssistantOf(parentArn, messagingClient as never, '[typed-conversation]').catch((err) => {
      console.warn('[typed-conversation] the primary of the conversation a meeting was started from could not be read', { err: (err as Error)?.name });
      return null;
    });
    if (!primary?.botArn) return { ok: false, code: 'NO_PRIMARY' };
    if (primary.classification !== DEPLOYED_CLASSIFICATION) return { ok: false, code: 'NOT_THIS_CLASSIFICATION' };
    // THE ROOM'S OTHER ASSISTANTS JOIN IT TOO, resolved before anything is created. None of them is welcomed there: a
    // meeting's conversation is the meeting's chat (`router-agent-handler.ts`, the welcome's meeting check).
    const agents = await roomAssistantsOf(parentArn, primary.botArn);
    const detail: TypedConversationEventDetail = { conversationType: MEETING_CONVERSATION_TYPE };
    const { name, subject } = await openedRoomNaming(MEETING_CONVERSATION_TYPE, detail, undefined, primary.assistant, await roomNameOf(parentArn));
    const created = await createConversationFromEvent({
      appInstanceArn: APP_INSTANCE_ARN,
      botArn: primary.botArn,
      userArn: forUserArn,
      typeKey: MEETING_CONVERSATION_TYPE,
      classification: DEPLOYED_CLASSIFICATION,
      modelId: '',
      modelName: '',
      topicLabel: subject,
      name,
      creatorBearerArn: await resolveServiceAdminBearer(),
      channelFlowArn: await resolveChannelFlowArn(),
      parentChannelArn: parentArn,
      additionalMemberArns: [],
      agents,
    });
    // THE ROW NAMES THE CONVERSATION IT WAS STARTED FROM before the meeting is held in it: its room's members join through
    // that link, and its cards are posted there. A conversation whose row does not name it holds no meeting.
    if (!(await recordMeetingOf(created.channelArn, parentArn))) {
      console.error('[typed-conversation] the meeting conversation does not name the conversation it was started from; no meeting is held in it', { channelArn: created.channelArn });
      return { ok: false, code: 'NOT_LINKED' };
    }
    // EVERYONE IN THE ROOM IS A MEMBER FROM THE MOMENT IT OPENS (FR27), each checked for clearance as a join is, through the
    // canonical membership write; the person it was opened for is already its member and moderator. Carried until the open
    // must answer (`MEETING_OPEN_ANSWER_MS`): in a room too large for that, the rest enter by joining.
    const admin = requireServiceAdmin(await resolveServiceAdminBearer());
    const carried = await carryRoomPeople(parentArn, created.channelArn, {
      peopleOf: (room) => roomPeopleOf(room, admin),
      cleared: beforeDeadline(answerBy, clearedHere),
      add: beforeDeadline(answerBy, (meetingArn: string, personArn: string) => addInvitedMember({ channelArn: meetingArn, inviteeArn: personArn, bearerArn: admin })),
    }, forUserArn ? [forUserArn] : []);
    // A MEETING A WORKFLOW STARTS has no starter: the parent conversation's moderators host it where no host role is held (FR50).
    const roomModeratorIds = forUserArn ? [] : await roomModeratorIdsOf(parentArn, admin);
    // PEOPLE NOT CARRIED BY THE ANSWER (the deadline, or a write that failed) are carried after it (`carry`).
    const carryLeft = carried.failed.length > 0 || !!carried.unread;
    console.log('[typed-conversation] a meeting conversation opened', {
      channelArn: created.channelArn, classification: DEPLOYED_CLASSIFICATION, forPerson: Boolean(forUserArn), agents: agents.map((a) => `${a.handle}(${a.role})`),
      carried: carried.added.length, notCleared: carried.notCleared.length, failed: carried.failed.length, ...(carried.unread ? { unread: true } : {}),
    });
    return { ok: true, channelArn: created.channelArn, ...(roomModeratorIds.length ? { roomModeratorIds } : {}), ...(carryLeft ? { carryLeft: true as const } : {}) };
  } catch (err) {
    console.error('[typed-conversation] the meeting conversation request failed', { op: request.aeMeeting, err: (err as Error)?.name, message: (err as Error)?.message });
    return { ok: false, code: 'FAILED' };
  }
}

/**
 * THE REST OF THE ROOM, CARRIED AFTER THE OPEN ANSWERED (`carry`): the meeting conversation is a meeting's, both it and the
 * room it names (`meetingOf`, server-written) are open and this classification's, and every person of that room who is not
 * yet a member is added, each cleared for this classification now, as the open carries them. Anyone this leaves out still
 * enters by joining (`admit`). Each one added hears what is left of the ring from the started card (`ringUntil`, `useOngoingMeetings`).
 */
async function carryTheRest(request: { meetingChannelArn: string; parentChannelArn: string }): Promise<MeetingConversationAnswer> {
  const meetingArn = ownChannel(request.meetingChannelArn);
  const parentArn = ownChannel(request.parentChannelArn);
  if (!meetingArn || !parentArn) return { ok: false, code: 'INVALID_REQUEST' };
  const meetingClosed = await closedCode(meetingArn);
  if (meetingClosed) return { ok: false, code: meetingClosed };
  const meetingRow = await readChannelContext(meetingArn, { consistent: true });
  if (!meetingSettingsOf(meetingRow?.conversationType)) return { ok: false, code: 'NOT_A_MEETING' };
  if (meetingRow?.meetingOf !== parentArn) return { ok: false, code: 'NOT_THE_ROOMS_MEETING' };
  const parentClosed = await closedCode(parentArn);
  if (parentClosed) return { ok: false, code: parentClosed };
  const admin = requireServiceAdmin(await resolveServiceAdminBearer());
  const members = await roomPeopleOf(meetingArn, admin);
  const carried = await carryRoomPeople(parentArn, meetingArn, {
    peopleOf: (room) => roomPeopleOf(room, admin),
    cleared: clearedHere,
    add: (arn: string, personArn: string) => addInvitedMember({ channelArn: arn, inviteeArn: personArn, bearerArn: admin }),
  }, members);
  console.log('[typed-conversation] the rest of the room was carried into the meeting conversation', {
    channelArn: meetingArn, carried: carried.added.length, notCleared: carried.notCleared.length, failed: carried.failed.length, ...(carried.unread ? { unread: true } : {}),
  });
  return { ok: true, channelArn: meetingArn };
}

export const handler = async (
  event?: TypedConversationEvent | TypedConversationEventDetail | OpenerInvocation | MeetingConversationRequest | MeetingAddRequest | MeetingArrivalRequest,
): Promise<TypedConversationResult | MeetingConversationAnswer | MeetingAddAnswer | MeetingArrivalAnswer> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  if (isMeetingRequest(event)) return meetingConversation(event);
  if (isMeetingAddition(event)) return meetingAddition(event);
  // Whether the run that asked for this room has been told it opened, so a later failure never hands it back a second time.
  let handedBack = false;
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
    if (!detail.forUserArn && !detail.forPerson && !detail.forRole) throw new Error('detail.forUserArn, detail.forPerson or detail.forRole is required');
    // A TEAM ROOM THAT STANDS IS COMPLETED EVEN WHILE ITS LEAD ROLE HAS NO SINGLE HOLDER (a handover): opening needs its lead,
    // completing does not, so an attach is never refused because the on-call is changing hands.
    const forUserArn = detail.forUserArn || (detail.forRole
      ? await soleHolderOf(detail.conversationType, detail.forRole).catch(async (err) => {
        if (!detail.teamRoom) throw err;
        await completeTeamRoomWithoutLead(detail.conversationType, err);
        return null;
      })
      : await personNamed(detail.forPerson));
    if (forUserArn === null) {
      const channelId = teamRoomChannelId(detail.conversationType, DEPLOYED_CLASSIFICATION);
      return { ok: true, reused: true, channelArn: `${APP_INSTANCE_ARN}/channel/${channelId}`, channelId, conversationType: detail.conversationType };
    }
    if (!forUserArn) throw new Error('the person this event names resolves to nobody in the directory');
    // A CONFIRMATION NAMES THE PERSON THE ROOM IS FOR, and nobody else: a creator holding is never handed to a third person.
    if (detail.confirmedBy !== undefined && detail.confirmedBy !== forUserArn) {
      throw new Error('the person who confirmed the proposal is not the person the conversation is for; refusing');
    }

    const typeKey = detail.conversationType;
    if (!CONVERSATION_TYPES[typeKey]) {
      throw new Error(`unknown conversation type "${typeKey}"`);
    }
    // A MEETING'S CONVERSATION IS OPENED BY ITS MEETING (`aeMeeting: 'open'`), which records the room it was started from;
    // an event or a step that names the type opens none.
    if (meetingSettingsOf(typeKey)) throw new Error(`a "${typeKey}" conversation is opened only by the meeting it holds`);
    // AN ALARM IS NAMED AS CLOUDWATCH NAMES ONE, or the event is refused rather than opening a room that watches nothing.
    const watchedAlarm = detail.watchesAlarm?.trim() || undefined;
    if (watchedAlarm && !ALARM_NAME.test(watchedAlarm)) throw new Error('detail.watchesAlarm is not an alarm name');

    // THE ROOM'S ONE PRIMARY, the classification's primary assistant (§3.8).
    const primary = await resolvePrimary();
    const bearerArn = primary.botArn;
    if (!bearerArn) throw new Error('could not resolve this classification\'s primary assistant bot ARN');

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
    // NESTING STOPS ONE LEAF BELOW A CHILD (DESIGN-PROCESSES O32), whichever way the open was asked: a workflow's open step
    // (which the router asked too), an `open_conversation` proposal, or an event an opener declared. A leaf opens nothing,
    // a child opens only a leaf, a grandchild opens nothing; a row that cannot be read throws, and nothing is created.
    if (detail.concernedChannelArn && await openIsNestedBy(detail.concernedChannelArn, typeKey, (arn) => readChannelContext(arn, { consistent: true }))) {
      throw new Error(`a "${typeKey}" conversation would nest past one leaf below a child; refusing`);
    }

    // THE ASSISTANTS THE TYPE NAMES, resolved BEFORE anything is created. An unresolvable handle is a
    // refusal here rather than a conversation delivered without the assistant it was opened for.
    const agents = await typeAgents(typeKey);

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

    // ONE LIVE CONVERSATION PER WATCHED KEY (DESIGN-EVENT-TARGETS section 3): an event for a key a live conversation at this
    // classification already watches opens no second one, so a later event cannot move the key away from it.
    const ref = detail.watchesRef && REF_KIND.test(detail.watchesRef.kind) && refId(detail.watchesRef.id)
      ? { kind: detail.watchesRef.kind, id: refId(detail.watchesRef.id) as string } : undefined;
    if (detail.watchesRef && !ref) throw new Error('detail.watchesRef is not a kind and an id');
    const refWatch = ref ? refWatchKey(DEPLOYED_CLASSIFICATION, ref.kind, ref.id) : undefined;
    if (ref && refWatch) {
      const held = await refWatchOf(refWatch, { strict: true }).catch(() => {
        throw new Error('the key\'s watch could not be read, so no room is opened rather than risk a second');
      });
      const live = held && held.classification === DEPLOYED_CLASSIFICATION ? await watchesRefLive(held.room, refKey(ref.kind, ref.id)) : 'released';
      if (live === 'unknown') throw new Error('the conversation that watches the key could not be read, so no room is opened rather than risk a second');
      if (held && live === 'live') {
        console.log('[typed-conversation] a live conversation already watches the key; nothing is created', { conversationType: typeKey, kind: ref.kind });
        return { ok: true, reused: true, channelArn: held.room, channelId: held.room.split('/channel/')[1], conversationType: typeKey };
      }
    }

    // ONE ROOM PER OPENING EVENT (ADR-061 decision 1): a redelivered event finds its claim and opens nothing, and the
    // room it opened is the answer. Claimed after every refusal above, so a refused event claims nothing.
    const opening = openingKey(event);
    if (opening) {
      const claim = await claimOpening(opening);
      if ('existing' in claim) {
        console.log('[typed-conversation] the event already opened its room; nothing is created', { conversationType: typeKey });
        // THE ROOM IT OPENED HOLDS ITS KEY: a second delivery of the event claims the watch for it again, so a claim the first
        // could not write is made now. No live conversation holds the key (checked above), so the claim moves it from no other.
        if (ref && refWatch) {
          const holder = await holdRefWatch(() => claimRefWatch(refWatch, { room: claim.existing, classification: DEPLOYED_CLASSIFICATION },
            async (room) => (await watchesRefLive(room, refKey(ref.kind, ref.id))) === 'released'));
          console.log('[typed-conversation] the opened room watches its key', { kind: ref.kind, held: holder === claim.existing });
        }
        return { ok: true, reused: true, channelArn: claim.existing, channelId: claim.existing.split('/channel/')[1], conversationType: typeKey };
      }
      if ('busy' in claim) throw new Error('another delivery of this event is opening its room');
      if ('failed' in claim) throw new Error('the event could not be claimed, so no room is opened rather than risk a second');
    }

    // THE ROOM IS NAMED AT CREATION, from what opened it, so it never shows the placeholder while it has a purpose, and its
    // subject is kept apart from its name: a name may be the summary sentence, a subject is always a noun phrase.
    const { name, subject } = await openedRoomNaming(typeKey, detail, watchedAlarm, primary.assistant);
    const creatorBearerArn = await resolveServiceAdminBearer();

    const created = await createConversationFromEvent({
      ...(detail.teamRoom ? { teamRoom: true } : {}),
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
      creatorBearerArn,
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
      ...(ref ? { watchedRefs: [refKey(ref.kind, ref.id)] } : {}),
    }).catch(async (err) => {
      // THE TEAM ROOM ALREADY STANDS: its id is fixed, so it is the answer, completed with the members a creation adds, so
      // a creation that stopped part way never leaves an empty room behind. A completion that fails reaches the catch below.
      if (!detail.teamRoom || (err as { name?: string })?.name !== 'ConflictException') throw err;
      const channelId = teamRoomChannelId(typeKey, DEPLOYED_CLASSIFICATION);
      const channelArn = `${APP_INSTANCE_ARN}/channel/${channelId}`;
      await completeTeamRoom({
        channelArn, primaryBotArn: bearerArn, leadArn: forUserArn, memberArns: humans,
        agentBotArns: agents.map((a) => a.botArn).filter((a): a is string => !!a), roleModerators,
        bearerArn: requireServiceAdmin(creatorBearerArn), ...(channelFlowArn ? { channelFlowArn } : {}),
      });
      return { reused: true as const, channelArn, channelId };
    });
    if ('reused' in created) {
      console.log('[typed-conversation] the team room stands; completed and reused', { conversationType: typeKey });
      return { ok: true, reused: true, channelArn: created.channelArn, channelId: created.channelId, conversationType: typeKey };
    }
    if (opening) await settleOpening(opening, created.channelArn);

    // THE ROOM WATCHES THE ALARM (ADR-061, the incident watch): the alarm's watch record names this room, the newest one
    // opened for it, and the router runs `alarm-state-changed` here while this record and the row both name it. A record
    // that could not be written leaves the room standing and watching nothing.
    if (watchedAlarm) {
      const watching = await recordAlarmWatch(alarmWatchKey(watchedAlarm), { room: created.channelArn, classification: DEPLOYED_CLASSIFICATION });
      console.log('[typed-conversation] watches an alarm', { recorded: watching });
    }
    // THE ROOM WATCHES ITS KEY once its row lists it: the item is claimed only where no live conversation holds it.
    if (ref && refWatch) {
      const holder = await holdRefWatch(() => claimRefWatch(refWatch, { room: created.channelArn, classification: DEPLOYED_CLASSIFICATION },
        async (room) => (await watchesRefLive(room, refKey(ref.kind, ref.id))) === 'released'));
      if (holder) console.log('[typed-conversation] watches a key', { kind: ref.kind, held: holder === created.channelArn });
      else if (opening) {
        // A ROOM THAT WATCHES NOTHING IS NOT A SUCCESS: the invocation fails, so the event goes to its dead-letter queue, and a
        // redelivery of it is this event again, which finds the room it opened by its claim and claims the key for it then.
        throw new KeyWatchUnwritten('the key\'s watch could not be written; the event is delivered again to write it');
      } else console.error('[typed-conversation] the key\'s watch could not be written after retries; the room stands and watches nothing', { kind: ref.kind });
      // ANOTHER CONVERSATION OPENED FOR THE SAME KEY AT THE SAME MOMENT HOLDS IT: this one's row stops naming it, so no row says
      // it watches a key it does not hold. The conversation itself stands; it was opened for a real event.
      if (holder && holder !== created.channelArn) {
        await putChannelContext(created.channelArn, { watchedRefs: null }).catch(() => false);
        console.warn('[typed-conversation] another conversation holds the key; this one watches nothing', { kind: ref.kind });
      }
    }

    console.log('[typed-conversation] created', {
      channelArn: created.channelArn,
      conversationType: typeKey,
      classification: DEPLOYED_CLASSIFICATION,
      agents: agents.map((a) => `${a.handle}(${a.role})`),
      humansAdded: humans.length,
    });

    // THE RUN THAT ASKED FOR THE ROOM GOES ON AS SOON AS THE ROOM STANDS, so the room it was asked from is told where it is
    // as the room appears in its members' lists, rather than after the room's own opening and welcomes. The hand-back is
    // an asynchronous invocation, and the room's opening below is its own run, which the parent's never waits on.
    if (detail.continueRun) {
      handedBack = true;
      await handBackRun(detail.continueRun, OPEN_STEP_OPENED, {
        [CHILD_LINK_VALUE]: `?${conversationRef(created.channelId)}`,
      });
    }

    // `conversation-opened` IS NAMED TO THE ROUTER once the people the type admits are in the room (ADR-061
    // decision 1). Where the room's assistant declares a workflow for it, that run greets the room and its lead,
    // and the separate welcome below is not sent, so a person receives one welcome, not two.
    // Never fails the creation: a run that cannot be asked for leaves the separate welcome to greet the room.
    const opened = await Promise.resolve()
      .then(() => nameEventThroughRouter(DEPLOYED_CLASSIFICATION, {
        event: 'conversation-opened', channelArn: created.channelArn, personArn: forUserArn, label: subject,
        openedBy: detail.continueRun ? 'workflow' : 'event',
        resource: detail.continueRun?.values?.resource,
        ...(detail.continueRun?.process ? { process: detail.continueRun.process } : {}),
        ...(isCustomerImpact(detail.continueRun?.values?.customerImpact) ? { customerImpact: detail.continueRun.values.customerImpact } : {}),
        ...(detail.continueRun ? { facts: incidentFactsOf(detail.continueRun.values) } : {}),
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
    // NEVER THROWN, but for a room that stands without its key's watch: a retried creation would be a second conversation,
    // while that event's redelivery finds its room by the event's claim and only writes the watch.
    if (err instanceof KeyWatchUnwritten) throw err;
    const error = err instanceof Error ? err.message : String(err);
    console.error('[typed-conversation] refused or failed; no conversation was created', { error });
    const asked = (event as { detail?: TypedConversationEventDetail } | undefined)?.detail?.continueRun;
    if (asked && !handedBack) await handBackRun(asked, 'failed', {});
    return { ok: false, error };
  }
};
