/**
 * A PERSON REACHES A CONVERSATION THROUGH A SERVICE ROLE ONLY WHILE THEY ARE A MEMBER OF IT AND CLEARED
 * FOR IT (tenets D3 and D15).
 *
 * A person route that acts on its own role (the presigner, the battle, task, turn-state, feedback and
 * proposal routes) carries none of the caller's IAM scope, so the caller's own boundary is put in front
 * of the action here. The same two checks run on every such route, in this order:
 *   1. Membership, proven with the caller's OWN AppInstanceUser as `ChimeBearer`: the Amazon Chime SDK
 *      answers a person's lookup of their own membership and refuses anybody else's, so a removed member
 *      and a non-member are both refused by the service that holds the membership. Nothing about the
 *      conversation is read for a caller this check refuses.
 *   2. Clearance against the conversation's immutable `classification` tag: the caller's token
 *      (`callerHolderToken`) must reach it (`profiles.reaches`). A member whose clearance no longer
 *      reaches the conversation is refused, the case membership alone would admit.
 *   3. On a function wired for it (`LIVE_CLEARANCE=directory`, `grantLiveClearance`), the clearance the person's
 *      directory holds NOW must reach it too (DESIGN-REVOCATION-WINDOWS R4): the token's claim is frozen at issue, so
 *      a downgrade reaches the route within `CLEARANCE_RECHECK_SECONDS` rather than at the token's renewal. The
 *      live answer only narrows the token's, and a directory that cannot be read refuses. A person who signs in
 *      through no issuer that clears them by its directory's own groups is held to the token, which is bounded by
 *      its lifetime.
 *
 * The caller is an ordinary person signed in through the edge. A guest resolves to nobody here (`callerPerson` admits a guest only on a route that asks,
 * and none of these does), and a console session is an operator's credential, not a person's, so each is refused.
 *
 * Nothing that cannot be answered admits. A refusal and an outage are different answers: the Amazon
 * Chime SDK refusing the lookup is `NOT_A_MEMBER`, while a throttle or a service failure on either read is
 * `UNAVAILABLE` (503), so a caller is told to retry rather than told they are not a member.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { DescribeChannelMembershipCommand, ListChannelMembershipsForAppInstanceUserCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { chimeMessagingClient } from './chime/clients.js';
import { callerHolderToken, callerPerson } from './auth.js';
import { userArnFor } from './person-arn.js';
import { CLASSIFICATION_TAG, readChannelTags } from './channel-classification.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
import { emitEmfMetric } from './emf-metrics.js';
import { memoizedTagReader, tagMemoHolds } from './conversation-primary.js';
import { defaultDirectory, type Directory } from './membership-source.js';
import { mapLimited } from './map-limited.js';

const LOG = '[conversation-access]';

export type ConversationRefusal =
  | 'NOT_A_MEMBER' | 'NOT_CLEARED' | 'CLASSIFICATION_UNREADABLE' | 'UNAVAILABLE' | 'NOT_A_PERSON_SESSION';

/**
 * The answer. `memberProven` says whether membership was established before the refusal, which is what a
 * route that answers a proven member differently (a read that degrades rather than fails) decides on.
 * `CLASSIFICATION_UNREADABLE` is given only to a proven member: the conversation carries no classification
 * this deployment recognizes, so clearance cannot be decided. A route whose action only takes access away
 * (archive, remove a member) may act on it; every other route refuses. `tags`, on an admitted answer, is
 * the conversation's tag map read in this request, present when the route asked for live tags.
 */
export type ConversationAccess =
  | { ok: true; channelArn: string; classification: string; tags?: Record<string, string | undefined> }
  | { ok: false; status: 403 | 503; code: ConversationRefusal; memberProven: boolean; channelArn?: string };

/** What a person is told for each refusal: one wording for every route, so it cannot drift. */
export const CONVERSATION_REFUSAL_MESSAGES: Readonly<Record<ConversationRefusal, string>> = {
  NOT_A_MEMBER: 'You are not a member of this conversation',
  NOT_CLEARED: 'Your clearance does not reach this conversation',
  CLASSIFICATION_UNREADABLE: 'This conversation has no classification this deployment recognizes',
  UNAVAILABLE: 'The conversation could not be checked just now; try again',
  NOT_A_PERSON_SESSION: 'This request must be made from a person\'s own sign-in',
};

/** The Amazon Chime SDK's answers that mean the caller is not a member, as opposed to an outage. */
const NOT_A_MEMBER_ERRORS = new Set(['ForbiddenException', 'NotFoundException', 'BadRequestException']);

/**
 * Whether an Amazon Chime SDK error, read bearing the caller, is the service saying the caller is not a member,
 * as opposed to an outage. One set, so a route reading a conversation as the caller decides the same way.
 */
export function isNotAMemberError(err: unknown): boolean {
  return NOT_A_MEMBER_ERRORS.has(String((err as { name?: string } | null)?.name ?? ''));
}

/** The answers to a tag read that mean the role was refused that conversation's tags. */
const TAG_READ_DENIED = new Set(['ForbiddenException', 'AccessDeniedException']);

type MessagingClient = Pick<ReturnType<typeof chimeMessagingClient>, 'send'>;

let client: MessagingClient | undefined;
const messaging = (): MessagingClient => (client ??= chimeMessagingClient());

type TagSource = 'remembered' | 'read' | 'none';

/**
 * WHAT THE CHECK COSTS, MEASURED: one EMF line per check, every outcome including an early refusal, the
 * time from the start of the check to the decision, by whether the tag was read or remembered, so the
 * latency the second layer adds to a route is a number in CloudWatch rather than an estimate.
 */
/**
 * What a check is for: `check` decides whether a route acts for the caller; `list` decides which rows of a
 * list across conversations the caller is shown, where a refusal drops a row rather than refusing access.
 */
export type CheckUse = 'check' | 'list';

/** One check's outcome and duration, by use and by where the tag came from (`AgentEchelon/ConversationAccess`). */
export function recordCheck(startedAt: number, outcome: 'ALLOWED' | ConversationRefusal, tagSource: TagSource, use: CheckUse): void {
  // A dimension with an empty value is dropped by CloudWatch without an error, so `Instance` is named
  // only where the function carries one.
  const instance = process.env.ALERT_INSTANCE;
  emitEmfMetric({
    namespace: 'AgentEchelon/ConversationAccess',
    metrics: [{ name: 'ConversationAccessCheckMs', unit: 'Milliseconds' }],
    dimensionSets: [[...(instance ? ['Instance'] : []), 'Use', 'Outcome', 'TagSource']],
    properties: {
      ...(instance ? { Instance: instance } : {}),
      Use: use,
      Outcome: outcome,
      TagSource: tagSource,
      ConversationAccessCheckMs: Date.now() - startedAt,
    },
  });
}

export interface ConversationAccessOptions {
  appInstanceArn?: string;
  client?: MessagingClient;
  /** What the check is for, recorded with its outcome (`CheckUse`). Default `check`. */
  use?: CheckUse;
  /**
   * Read the conversation's tags live in this request and return them, for a route that also decides on a
   * tag that changes (`archived`), so it reads the tags once rather than twice.
   */
  liveTags?: boolean;
  /**
   * For a role whose tag grant covers only conversations that carry a classification
   * (`anyClassificationTagged`): a denied tag read then means the conversation carries none, and is
   * answered as `CLASSIFICATION_UNREADABLE`. For every other role a denied read is a missing grant, an
   * outage the operator must see, and is answered as `UNAVAILABLE`.
   */
  tagGrantCoversClassifiedOnly?: boolean;
  /**
   * For a role whose membership read covers only conversations that carry a classification (`anyClassificationTagged`):
   * a denied read then means the conversation carries none or does not exist, and is answered as `NOT_A_MEMBER`.
   */
  membershipGrantCoversClassifiedOnly?: boolean;
  /** The directory the live clearance is read from. Default: the deployment's, on a function wired for it. */
  directory?: Pick<Directory, 'clearedByGroups'>;
}

/**
 * HOW LONG A LIVE CLEARANCE READ STANDS in one container (DESIGN-REVOCATION-WINDOWS R4): the downgrade window on a
 * route that rechecks, and the bound on the directory reads a busy person costs.
 */
export const CLEARANCE_RECHECK_SECONDS = 60;
const liveCleared = new Map<string, { until: number; cleared: string[] | null }>();

/** The classifications the person's directories clear them for now, or null when none keeps groups. Throws on a failed read. */
async function liveClearanceOf(personArn: string, directory: Pick<Directory, 'clearedByGroups'>, now = Date.now()): Promise<string[] | null> {
  const hit = liveCleared.get(personArn);
  if (hit && hit.until > now) return hit.cleared;
  const cleared = await directory.clearedByGroups(personArn);
  liveCleared.set(personArn, { until: now + CLEARANCE_RECHECK_SECONDS * 1000, cleared });
  return cleared;
}

/**
 * WHETHER THE CALLER'S DIRECTORY STILL CLEARS THEM FOR A CLASSIFICATION, for a route acting before any conversation exists to
 * check them against. `unavailable` is a directory that could not be read. A person whose directory keeps no groups is held
 * to their token, as `callerReachesConversation` holds them.
 */
export async function callerStillCleared(classification: string, personArn: string): Promise<'cleared' | 'not-cleared' | 'unavailable'> {
  const directory = process.env.LIVE_CLEARANCE === 'directory' ? defaultDirectory() : undefined;
  if (!directory) return 'cleared';
  try {
    const cleared = await liveClearanceOf(personArn, directory);
    if (!cleared) return 'cleared';
    const live = profiles.holderOf(cleared).token;
    if (live && profiles.reaches(live, classification)) return 'cleared';
    console.warn(`${LOG}[SecurityEvent] the caller's current clearance no longer reaches the classification`, { classification, live });
    return 'not-cleared';
  } catch (err) {
    console.error(`${LOG} the caller's current clearance could not be read; refusing`, { err: (err as Error).name });
    return 'unavailable';
  }
}

/** Test seam: forget every live clearance read. */
export function __clearLiveClearance(): void {
  liveCleared.clear();
}

type CheckState = { source: TagSource; memberProven: boolean; use: CheckUse; personArn?: string };
type Refuse = (code: ConversationRefusal, channelArn?: string) => ConversationAccess;

/** A refusal that records itself, with whether membership was proven by then. */
function refusalFor(startedAt: number, state: CheckState): Refuse {
  return (code, channelArn) => {
    recordCheck(startedAt, code, state.source, state.use);
    return {
      ok: false, status: code === 'UNAVAILABLE' ? 503 : 403, code, memberProven: state.memberProven, ...(channelArn ? { channelArn } : {}),
    };
  };
}

/** Who is asking, or why nobody can be: the same answer for every conversation a request names. */
async function callerOf(event: APIGatewayProxyEvent, appInstanceArn: string): Promise<{ personArn: string } | { refusal: ConversationRefusal }> {
  // THE DEPLOYMENT, NOT THE CALLER: a function without its app instance cannot ask anything, and saying
  // "not a member" would blame the person for a misconfiguration the operator must see.
  if (!appInstanceArn) {
    console.error(`${LOG} APP_INSTANCE_ARN is not configured for this function; no conversation can be checked`);
    return { refusal: 'UNAVAILABLE' };
  }
  const person = await callerPerson(event);
  if (person?.source === 'console-session') return { refusal: 'NOT_A_PERSON_SESSION' };
  if (!person) return { refusal: 'NOT_A_MEMBER' };
  return { personArn: person.personArn ?? userArnFor(appInstanceArn, person.personId) };
}

/** A conversation id as Amazon Chime SDK names a channel: what may follow `/channel/` in an ARN. */
const CHANNEL_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * THE CONVERSATION'S FULL CHANNEL ARN, from its id or its ARN, or null for anything that is not a channel of
 * this app instance. The one normalizer, so every route records and acts on the same name for a conversation.
 */
export function conversationChannelArn(conversation: unknown, appInstanceArn: string): string | null {
  if (typeof conversation !== 'string' || !conversation || !appInstanceArn) return null;
  const channelPrefix = `${appInstanceArn}/channel/`;
  const channelArn = conversation.startsWith('arn:') ? conversation : `${channelPrefix}${conversation}`;
  return channelArn.startsWith(channelPrefix) && CHANNEL_ID.test(channelArn.slice(channelPrefix.length)) ? channelArn : null;
}

/**
 * THE SECOND CHECK, FOR A PROVEN MEMBER: the conversation's classification, and whether the caller's
 * clearance reaches it. The tags come from the container's one memo (`memoizedTagReader`), unless the route
 * asked for them live, in which case this read is the only tag read the request makes.
 */
async function clearedFor(
  event: APIGatewayProxyEvent,
  send: MessagingClient,
  channelArn: string,
  opts: ConversationAccessOptions,
  startedAt: number,
  state: CheckState,
): Promise<ConversationAccess> {
  const refuse = refusalFor(startedAt, state);
  state.source = !opts.liveTags && tagMemoHolds(channelArn) ? 'remembered' : 'read';
  let tags: Record<string, string | undefined>;
  try {
    tags = await readChannelTags(opts.liveTags ? send : memoizedTagReader(send), channelArn);
  } catch (err) {
    const name = (err as Error).name;
    if (opts.tagGrantCoversClassifiedOnly && TAG_READ_DENIED.has(name)) {
      console.warn(`${LOG}[SecurityEvent] classification tag read denied; the conversation carries no classification`, { channelArn });
      return refuse('CLASSIFICATION_UNREADABLE', channelArn);
    }
    console.error(`${LOG} classification tag read failed`, { channelArn, err: name });
    return refuse('UNAVAILABLE');
  }
  const tag = tags[CLASSIFICATION_TAG];
  const classification = profiles.isKnownClassification(tag) ? profiles.resolveClassification(tag) : undefined;
  if (!classification) {
    console.warn(`${LOG}[SecurityEvent] channel missing/invalid classification tag; refusing`, { channelArn, tag });
    return refuse('CLASSIFICATION_UNREADABLE', channelArn);
  }
  const token = callerHolderToken(event);
  if (!token || !profiles.reaches(token, classification)) {
    console.warn(`${LOG} caller is not cleared for the conversation`, { channelArn, classification, token });
    return refuse('NOT_CLEARED');
  }
  const directory = opts.directory ?? (process.env.LIVE_CLEARANCE === 'directory' ? defaultDirectory() : undefined);
  if (directory && state.personArn) {
    let cleared: string[] | null;
    try {
      cleared = await liveClearanceOf(state.personArn, directory);
    } catch (err) {
      console.error(`${LOG} the caller's current clearance could not be read; refusing`, { channelArn, err: (err as Error).name });
      return refuse('UNAVAILABLE');
    }
    const live = cleared ? profiles.holderOf(cleared).token : undefined;
    if (cleared && (!live || !profiles.reaches(live, classification))) {
      console.warn(`${LOG}[SecurityEvent] the caller's current clearance no longer reaches the conversation`, { channelArn, classification, token, live });
      return refuse('NOT_CLEARED');
    }
  }
  recordCheck(startedAt, 'ALLOWED', state.source, state.use);
  return { ok: true, channelArn, classification, ...(opts.liveTags ? { tags } : {}) };
}

/**
 * Is the caller a current member of the conversation, and cleared for its classification? `conversation`
 * is a conversation id or its channel ARN; an ARN outside this deployment's app instance is refused. The
 * answer carries the normalized channel ARN, which is what a route records.
 */
export async function callerReachesConversation(
  event: APIGatewayProxyEvent,
  conversation: unknown,
  opts: ConversationAccessOptions = {},
): Promise<ConversationAccess> {
  const startedAt = Date.now();
  const state: CheckState = { source: 'none', memberProven: false, use: opts.use ?? 'check' };
  const refuse = refusalFor(startedAt, state);

  const appInstanceArn = opts.appInstanceArn ?? process.env.APP_INSTANCE_ARN ?? '';
  const caller = await callerOf(event, appInstanceArn);
  if ('refusal' in caller) return refuse(caller.refusal);
  const channelArn = conversationChannelArn(conversation, appInstanceArn);
  if (!channelArn) return refuse('NOT_A_MEMBER');
  const send = opts.client ?? messaging();

  // MEMBERSHIP FIRST, and never remembered: removal is what it exists to see, and a caller it refuses
  // costs no tag read, no log line and no cache entry.
  try {
    await send.send(new DescribeChannelMembershipCommand({
      ChannelArn: channelArn, MemberArn: caller.personArn, ChimeBearer: caller.personArn,
    }));
  } catch (err) {
    const name = (err as Error).name;
    if (isNotAMemberError(err) || (opts.membershipGrantCoversClassifiedOnly && name === 'AccessDeniedException')) {
      // AN ANSWER, NOT A FAULT: a caller who is not a member is refused, which callers rely on (a room member opening a
      // meeting's link is answered from the room). Logged as information, so a failure search finds only real faults.
      console.info(`${LOG} caller is not a member`, { channelArn, refusedAs: 'NOT_A_MEMBER' });
      return refuse('NOT_A_MEMBER');
    }
    console.error(`${LOG} membership lookup failed`, { channelArn, err: name });
    return refuse('UNAVAILABLE');
  }
  state.memberProven = true;
  state.personArn = caller.personArn;
  return clearedFor(event, send, channelArn, opts, startedAt, state);
}

/** How many pages of 50 a list's membership read takes before the rest is checked one conversation at a time. */
export const LIST_MEMBERSHIP_MAX_PAGES = 20;

/** How many conversations of a list have their clearance checked at once. */
const LIST_CHECK_CONCURRENCY = 4;

/**
 * A LIST ACROSS CONVERSATIONS, CHECKED WITH ONE MEMBERSHIP READ (`use: 'list'`). The conversations the caller is a
 * member of come from `ListChannelMembershipsForAppInstanceUser` bearing the caller, so a list of open work in N
 * conversations costs one paged read rather than N membership lookups. The caller is the bearer and the user asked
 * about, so the read can only ever return the caller's own memberships (tenet D1).
 *
 * THE MEMBERSHIP STORE, NOT THE SEARCH INDEX. `SearchChannels` (MEMBERS INCLUDES the caller) answers the same
 * question from an index that lags: measured on a deployed instance, 10 add-then-remove cycles each read
 * at once, a removed member was still found in 1 and an added one not yet found in 2. Removal is what this check
 * exists to see, so the search cannot be the authority. The same probe against this read, 15 cycles, was exact every
 * time in both directions.
 *
 * The same answers as `callerReachesConversation`, one per conversation asked:
 *   - listed: membership is proven, and the clearance check runs as it does for one conversation;
 *   - not listed once the read is exhausted: `NOT_A_MEMBER`;
 *   - not listed when the read stops at `LIST_MEMBERSHIP_MAX_PAGES`: asked one at a time, so a very large
 *     membership never drops a conversation the caller is in;
 *   - a read that fails: `UNAVAILABLE` for every conversation still unanswered, never a narrower list.
 *
 * Membership is never remembered past the request: the reader returned here holds what one request learned,
 * and the next request reads again, so a removal is seen on the next read.
 */
export function listReach(event: APIGatewayProxyEvent, opts: ConversationAccessOptions = {}): {
  reaches(conversations: string[]): Promise<Map<string, ConversationAccess>>;
} {
  const appInstanceArn = opts.appInstanceArn ?? process.env.APP_INSTANCE_ARN ?? '';
  const send = opts.client ?? messaging();
  let caller: Promise<{ personArn: string } | { refusal: ConversationRefusal }> | undefined;
  const members = new Set<string>();
  let nextToken: string | undefined;
  let pages = 0;
  let exhausted = false;
  let failed: string | undefined;

  const readUntilFound = async (personArn: string, wanted: string[]): Promise<void> => {
    while (!exhausted && !failed && pages < LIST_MEMBERSHIP_MAX_PAGES && wanted.some((arn) => !members.has(arn))) {
      pages += 1;
      try {
        const res = await send.send(new ListChannelMembershipsForAppInstanceUserCommand({
          AppInstanceUserArn: personArn,
          ChimeBearer: personArn,
          MaxResults: 50,
          NextToken: nextToken,
        }));
        for (const m of res.ChannelMemberships || []) if (m.ChannelSummary?.ChannelArn) members.add(m.ChannelSummary.ChannelArn);
        nextToken = res.NextToken;
        if (!nextToken) exhausted = true;
      } catch (err) {
        failed = (err as Error).name;
        console.error(`${LOG} membership read failed`, { err: failed, pages });
      }
    }
  };

  return {
    async reaches(conversations) {
      const out = new Map<string, ConversationAccess>();
      const startedAt = Date.now();
      caller ??= callerOf(event, appInstanceArn);
      const who = await caller;
      const asked = [...new Set(conversations)];
      if ('refusal' in who) {
        for (const c of asked) out.set(c, refusalFor(startedAt, { source: 'none', memberProven: false, use: 'list' })(who.refusal));
        return out;
      }
      const arnOf = new Map(asked.map((c) => [c, conversationChannelArn(c, appInstanceArn)]));
      const wanted = [...new Set([...arnOf.values()].filter((a): a is string => !!a))];
      await readUntilFound(who.personArn, wanted);
      // The clearance check reads each conversation's tags (memoized per container), so the conversations are
      // answered `LIST_CHECK_CONCURRENCY` at a time rather than all at once.
      await mapLimited(asked, LIST_CHECK_CONCURRENCY, async (c) => {
        const channelArn = arnOf.get(c);
        const state: CheckState = { source: 'none', memberProven: false, use: 'list' };
        const refuse = refusalFor(startedAt, state);
        if (!channelArn) { out.set(c, refuse('NOT_A_MEMBER')); return; }
        if (members.has(channelArn)) {
          state.memberProven = true;
          state.personArn = who.personArn;
          out.set(c, await clearedFor(event, send, channelArn, opts, startedAt, state));
          return;
        }
        if (failed) { out.set(c, refuse('UNAVAILABLE')); return; }
        if (exhausted) { out.set(c, refuse('NOT_A_MEMBER')); return; }
        // THE READ STOPPED SHORT of a very large membership: this one is asked directly, as a single check is.
        out.set(c, await callerReachesConversation(event, channelArn, { ...opts, use: 'list' }));
      });
      return out;
    },
  };
}

/**
 * A REFUSAL AS EVERY ROUTE ANSWERS IT: its status and an `{ error, code }` body in the one wording, for the
 * route to hand to its own responder. A 503 is retryable; every other refusal is final for this request.
 */
export function refusalAnswer(access: Extract<ConversationAccess, { ok: false }>): {
  statusCode: 403 | 503; body: { error: string; code: ConversationRefusal };
} {
  return { statusCode: access.status, body: { error: CONVERSATION_REFUSAL_MESSAGES[access.code], code: access.code } };
}
