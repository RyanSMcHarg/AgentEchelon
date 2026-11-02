/**
 * TRIAGE: what the queue becomes when the turn it waited behind finishes (ADR-033).
 *
 * The queue is a holding pen, not a work list. What comes out of it is TASKS, and what happens after
 * that is a question to the person rather than an execution.
 *
 * ── WHY NOT JUST ANSWER THEM ─────────────────────────────────────────────────────────────────────
 *
 * An earlier version of this concatenated the queue into one prompt and dispatched a single turn,
 * defending it with "later messages change what the earlier ones meant" - draft the report, then make
 * it about Q3. That argument is sound and it covers exactly ONE of the two things a queue holds:
 *
 *   an AMENDMENT to work in progress     "make it one page, not three"
 *   a NEW REQUEST that arrived just now  "also, what was Q3 headcount?"
 *
 * Concatenated, the amendment is buried inside a compound request and the new question is answered
 * inside a report revision. They cannot all be addressed at once, and a design that tries is a faster
 * way to produce the confusion the queue exists to prevent.
 *
 * ── WHY TASKS ────────────────────────────────────────────────────────────────────────────────────
 *
 * Because this platform already has them. A task is durable, so the work survives a worker dying and
 * the queue record is no longer the thing that must not be lost. A task is already visible as an open
 * work item. A task already has an owner and a state machine, so "who acts next" is answered rather
 * than reinvented. Building a second work list beside the first would be inventing all of it again.
 *
 * ── WHY IT STOPS AND ASKS ────────────────────────────────────────────────────────────────────────
 *
 * Triage produces a READING of what arrived, and a reading is a proposal. Executing it silently means
 * the first time the person learns how their messages were interpreted is when the wrong work is
 * already done. So this creates the tasks, orders them, and hands back what it understood; the
 * proposal and the pause are the caller's to post.
 *
 * The ambiguity that must always be raised is whether the work already in flight is still wanted. A
 * person who says "actually, what was Q3 headcount?" mid-report may have amended nothing and may have
 * abandoned the report, and there is no way to tell from the message which they meant. Guessing wastes
 * their time in both directions: finish a report nobody wants, or discard one they were waiting for.
 */

import { ChimeSDKMessagingClient, GetChannelMessageCommand } from '@aws-sdk/client-chime-sdk-messaging';
// The queue stores only an id; the read that restores the message also restores its file.
import { extractAttachment } from './battle-attachment.js';
import type { MessageAttachment } from './battle-attachment.js';
import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { stripMessageMarkers } from './message-markers.js';
import { resolveRouterArn as resolveRouterArnByName } from './router-arn.js';
import {
  buildTriagePrompt,
  mayTakeAnotherPass,
} from './turn-triage-proposal.js';
import { recordQueueWait } from './turn-queue-metrics.js';
import type { TaskVisibility } from './task-tracking.js';
import type { TurnRequest } from '../router-agent-handler.js';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { sessionClient } from './assistant-session.js';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const messagingClient = sessionClient(ChimeSDKMessagingClient, { region: AWS_REGION, requestHandler: BOUNDED_REQUEST_HANDLER });
// The dispatch and the router lookup are the processor's own (step 18); only reading the message is the
// assistant's, so only the messaging client follows the turn's session.
const lambdaClient = new LambdaClient({ region: AWS_REGION });
const ssmClient = new SSMClient({ region: AWS_REGION, requestHandler: BOUNDED_REQUEST_HANDLER });

/** One queued message, read at triage rather than stored at enqueue. */
export interface TriagedMessage {
  messageId: string;
  content: string;
  senderArn?: string;
  /**
   * The message was addressed to specific members, so other members cannot read it. This is what the
   * task's visibility is derived from, and the reason a targeted request must not become a
   * conversation-visible task.
   */
  targeted: boolean;
  /**
   * The file this message carried, if any.
   *
   * THE QUEUE HELD ONLY AN ID, and the read that turns it back into a message already returns the
   * `Metadata` the attachment rides in - it was simply never looked at. So a message queued while the
   * assistant was busy became a task about its CAPTION, with the document dropped: the reading
   * answered fluently about a file it had never seen, which is the same silent failure an `@` mention
   * had. Nothing errored, because nothing was missing as far as any code could tell.
   */
  attachment?: MessageAttachment;
}

export interface TriageResult {
  /** What was read, in the order it was sent. Empty when nothing could be read. */
  messages: TriagedMessage[];
  /**
   * True when every queued id was accounted for. The caller clears the queue only on true: a message
   * triaged twice is a duplicate task somebody can close, and one cleared without a task is a request
   * that silently never happened.
   */
  allTriaged: boolean;
  /**
   * Queued ids that were read successfully and had nothing left in them - a redaction, or a
   * message that was only markers. They are ACCOUNTED FOR: no work to create and none lost.
   *
   * They travel separately because they must be CLEARED without being TRIAGED. Dropping them
   * silently, which is what this used to do, left an id in `queued` that no reading would ever
   * name: the notice never settled, the client kept showing the wait, and every later notice
   * re-entered triage and produced nothing. A moderator redacting a queued message was enough.
   */
  emptiedIds: string[];
  /**
   * What the READING must be visible to. `private` when ANY queued message was targeted.
   *
   * A MIXED QUEUE FAILS TOWARD SILENCE, AND THAT APPLIES TO THE READING. Under-disclosing costs
   * somebody a notification they might have liked; over-disclosing publishes a request its sender
   * chose to keep off the room. Those are not symmetric, so the mix takes the quieter answer - and the
   * reading is exactly where it must, because one message names every queued request at once.
   *
   * IT DOES NOT DECIDE A TASK'S VISIBILITY: a public request in a queue stays public. Applied to an individual task the same rule over-corrects: an untargeted request became
   * private because somebody ELSE in the burst asked privately, which hides work the room was meant to
   * see and does it on a choice its sender never made. The asymmetry that justifies failing closed is
   * per message, so a task takes its own message's answer - `targetedIds`, applied per item in
   * `createTasksFromProposal`.
   */
  visibility: TaskVisibility;
}

/**
 * Read the queued messages and decide what their tasks may be seen by.
 *
 * CONTENT IS READ HERE, NOT AT ENQUEUE. The queue holds ids, so a message edited while it waited is
 * triaged as edited and one deleted while it waited disappears from the batch. It also keeps the queue
 * out of the retention story: no copy of a person's words with a second lifetime and a second erasure
 * path, which is the rule `drift_events` already follows by referencing a message rather than storing
 * its body.
 *
 * A message that cannot be read is a message that is NOT triaged, and `allTriaged` says so. Dropping
 * it silently would clear it from the queue with no task behind it, which is the one outcome worse
 * than answering it twice.
 */
export async function triageQueuedMessages(args: {
  channelArn: string;
  botArn: string;
  classification: string;
  queued: string[];
}): Promise<TriageResult> {
  const { channelArn, botArn, queued } = args;

  // THE READS RUN TOGETHER, and the ORDER comes from the queue, not from the network. Each read is
  // independent - one message's content says nothing about another's - so running them sequentially
  // was N round trips on a path a person is waiting on (section 7.4 named this reduction the day the
  // path was designed). `Promise.all` keeps the RESULTS in the input's order whatever order the
  // responses arrive in, which is what preserves "in the order it was sent" without a sort.
  //
  // Bounded by construction: the queue never holds more than `TURN_QUEUE_MAX` ids, so this is at
  // most a handful of concurrent reads, not a fan-out that needs a limiter.
  const reads = await Promise.all(queued.map(async (messageId) => {
    try {
      const res = await messagingClient.send(new GetChannelMessageCommand({
        ChannelArn: channelArn,
        MessageId: messageId,
        ChimeBearer: botArn,
      }));
      return { messageId, res };
    } catch (err) {
      // NOT triaged. The queue stays open for it rather than the message being lost.
      console.warn('[turn-triage] a queued message could not be read; leaving it queued', {
        messageId, err: (err as Error)?.message,
      });
      return { messageId, res: null };
    }
  }));

  const messages: TriagedMessage[] = [];
  const emptiedIds: string[] = [];
  let allTriaged = true;
  for (const { messageId, res } of reads) {
    if (!res) { allTriaged = false; continue; }
    const raw = res.ChannelMessage?.Content || '';
    const decoded = (() => {
      try { return decodeURIComponent(raw); } catch { return raw; }
    })();
    const content = stripMessageMarkers(decoded).trim();
    // A redacted or emptied message has nothing to become a task about. It IS accounted for -
    // there is no work to create and none was lost - so it does not hold the queue open.
    if (!content) { emptiedIds.push(messageId); continue; }

    // WHAT THE WAIT COST THIS PERSON, measured here because this is the moment it ends: the message
    // stops waiting when something finally looks at it, not when an answer arrives. What happens
    // after belongs to the task surface, which measures it without mixing in human think time.
    //
    // From the message's OWN creation instant, which Amazon Chime SDK stamps, rather than from when
    // this deployment noticed it. A server-side instant would measure our own detection delay and
    // call it the person's wait.
    const createdAt = res.ChannelMessage?.CreatedTimestamp;
    if (createdAt) recordQueueWait(args.classification, Date.now() - new Date(createdAt).getTime());

    // Both spellings, for the same reason the post-processing repair reads both: being wrong in the
    // direction of "not targeted" is the expensive one, because it publishes a private request.
    // BOTH, which the comment above already promised and the code did not do. All three siblings
    // read both spellings (`message-stream-event`, `task-answer-repair`, `live-drift-flow`); reading
    // only one meant a `Targets`-shaped response scored "not targeted", collapsing visibility to
    // `conversation` and publishing a privately addressed request as a room-visible task.
    const msg = res.ChannelMessage as { Target?: unknown; Targets?: unknown } | undefined;
    const target = (msg?.Target ?? msg?.Targets) as Array<{ MemberArn?: string }> | undefined;
    messages.push({
      messageId,
      content,
      senderArn: res.ChannelMessage?.Sender?.Arn,
      targeted: Array.isArray(target) && target.length > 0,
      // Read from the SAME response that supplied the content. No extra call, and no reason this was
      // ever absent beyond nobody asking the message what else it carried.
      attachment: extractAttachment(res.ChannelMessage?.Metadata),
    });
  }

  return {
    messages,
    allTriaged,
    emptiedIds,
    visibility: messages.some((m) => m.targeted) ? 'private' : 'conversation',
  };
}

/**
 * The router's ARN, when nothing handed it over.
 *
 * WHY A LOOKUP AND NOT AN ENVIRONMENT VARIABLE. The processor and the router live in one stack, and
 * the router already carries the processor's ARN. Putting the router's ARN in the processor's
 * environment closes a CloudFormation dependency cycle through the roles' default policies, and the
 * template will not deploy at all. The PARAMETER NAME refers to nothing, so it can be handed over
 * freely; the value behind it is read here.
 *
 * ONCE PER CONTAINER. The result is cached, including the failure - a missing parameter is a wiring
 * fault, not a transient, and retrying it on every triage would add a round trip to a path a person
 * is waiting on to no purpose. A container that never triages never makes the call at all.
 *
 * THE PARAMETER NAMES THIS FUNCTION'S OWN CLASSIFICATION'S ROUTER, and nothing else (the stack sets
 * it to `routerArnKey(classification)` next to `CLASSIFICATION`). `resolveRouterArn` therefore reads
 * it only for a turn of that classification; a cross-stack dispatcher carries the per-classification
 * router variables instead and resolves through `routerArnForClassification`.
 */
let cachedRouterArn: string | undefined | null = null;
async function routerArnFromParameter(): Promise<string | undefined> {
  if (cachedRouterArn !== null) return cachedRouterArn;
  const name = process.env.ROUTER_ARN_PARAM;
  if (!name) {
    cachedRouterArn = undefined;
    return undefined;
  }
  try {
    const res = await ssmClient.send(new GetParameterCommand({ Name: name }));
    cachedRouterArn = res.Parameter?.Value || undefined;
  } catch (err) {
    console.error('[turn-triage] could not read the router parameter; the queue stays untriaged', {
      name, err: (err as Error)?.message,
    });
    cachedRouterArn = undefined;
  }
  return cachedRouterArn;
}

/**
 * Dispatch the turn that reads the queue and proposes what to do with it.
 *
 * IT GOES THROUGH THE ROUTER, the same entry every other re-dispatch uses. The alternative - the
 * processor invoking itself - would need a new self-invoke edge and would skip the placeholder, so the
 * person would see nothing at all between their messages and the proposal.
 *
 * ITS `userMessage` IS A PROMPT, not anything a person wrote. That is the one unusual thing about this
 * turn, and it is why the queued IDS travel separately: the reply is parsed against what was actually
 * queued rather than against what the prompt happens to mention.
 *
 * RETURNS FALSE RATHER THAN THROWING. The caller has already handed the lock over by this point, and
 * a false answer is its signal to hand it back - a lock naming a turn nobody is running is the
 * stranded conversation this design is judged on.
 */

/**
 * The router for a classification: that classification's own router, or `undefined`.
 *
 * TWO SOURCES, ONE CLASSIFICATION. A per-classification function (the processor, the router) holds
 * the parameter naming its OWN classification's router, so a turn of that classification reads it.
 * Every other caller, and every other classification, goes through `routerArnForClassification`,
 * which resolves only a declared classification's own router variable. A turn of classification X is
 * never dispatched to the router of classification Y (ADR-046): a processor asked for another
 * classification's router finds none and the caller declines.
 *
 * SHARED rather than copied, because the stop path dispatches through the same routers and a second
 * resolver would be a second place for the per-classification table to drift. The caching in
 * `routerArnFromParameter` is per container, so a caller that never triages still never pays it.
 */
export async function resolveRouterArn(classification: string): Promise<string | undefined> {
  const own = (process.env.CLASSIFICATION || '').trim();
  if (own && classification === own) {
    const fromParameter = await routerArnFromParameter();
    if (fromParameter) return fromParameter;
  }
  return resolveRouterArnByName(classification);
}

/**
 * RUN THE STEP AGAIN WITH WHAT THEY JUST SAID (ADR-033, "queue, as context for the running step").
 *
 * The amendment is not new work and gets no task of its own, so the only place it can land is the
 * work it amends. This re-invokes the SAME correlation with the amendment folded into the request,
 * which is what makes it a continuation of one turn rather than a second answer to the same person:
 * the placeholder is already theirs, the lock is already held, and the reply that eventually arrives
 * is the one that accounts for everything they asked.
 *
 * RE-READ FROM THE CHANNEL by the caller, never carried as remembered text - the same rule the
 * another-pass path follows, so a message edited before the fold is folded as edited and a deleted
 * one disappears.
 */
export async function dispatchAmendedTurn(args: {
  channelArn: string;
  botArn: string;
  classification: string;
  correlationId: string;
  senderArn: string;
  /** What the turn was asked in the first place. */
  userMessage: string;
  userMessageId?: string;
  /**
   * THE QUEUED MESSAGES THE FOLDED ANSWER ADDRESSES, accumulated across folds.
   *
   * Declared here because this is where the mapping becomes a fact: the reading said these amend the
   * work in flight, and this dispatch is what rolls them into it. See `TurnRequest.foldedMessageIds`.
   */
  foldedMessageIds?: string[];
  /** The intent each folded message was classified as when it queued, by id (ADR-064 decision B). */
  foldedIntents?: Record<string, string>;
  /** The amending messages, already re-read from the channel. */
  amendments: TriagedMessage[];
  /**
   * WHO WILL READ THE ANSWER THIS FOLD PRODUCES.
   *
   * The fold inlines each amendment's own words and answers onto the placeholder the running turn
   * already has, so the audience is that placeholder's, not the amendment's. A message addressed to
   * one assistant must not be inlined into an answer the whole room reads.
   *
   * REQUIRED RATHER THAN OPTIONAL, because a default would have to guess, and the cheap guess
   * (untargeted) is the one that publishes. The caller reads it off the placeholder and already
   * filters on it; this is the second layer, so a future caller that forgets is refused here rather
   * than trusted.
   */
  replyIsTargeted: boolean;
  /** Which fold this is, 1-based. */
  fold: number;
}): Promise<boolean> {
  const { channelArn, botArn, classification, correlationId, senderArn, amendments, fold } = args;
  if (!amendments.length) return false;

  // TWO LAYERS, BECAUSE ONE MISSED CHECK MUST NOT BE A DISCLOSURE (tenet D3). The caller filters
  // these already; this refuses the whole fold rather than quietly dropping the offending message,
  // because a caller that got here with one has a bug worth seeing and a silent drop would hide it.
  if (!args.replyIsTargeted && amendments.some((m) => m.targeted)) {
    console.error('[turn-triage] refusing to fold a privately addressed amendment into an answer the '
      + 'conversation can read; this is a caller fault', {
      channelArn, fold, targeted: amendments.filter((m) => m.targeted).length,
    });
    return false;
  }

  const routerArn = await resolveRouterArn(classification);
  if (!routerArn) {
    console.error('[turn-triage] no router for this classification; the amendment cannot be folded', {
      classification, count: amendments.length,
    });
    return false;
  }

  // MODEL-FACING, so it is fixed English like every other assembled contract in this file. Nothing
  // here is shown to a person: the reply the model writes is, and that is written in the
  // conversation's own language under the deployment's persona.
  const amended = [
    args.userMessage,
    '',
    'While you were working on that, the person added the following. It changes what they are asking',
    'for rather than starting something new, so answer the request AS AMENDED - do not answer the',
    'original and then correct it, and do not mention that a revision happened.',
    ...amendments.map((m) => '- ' + m.content),
  ].join('\n');

  const aeTurn: TurnRequest = {
    channelArn,
    senderArn,
    userMessage: amended,
    // AND THE HUMAN HALF, BESIDE IT. `amended` above is a contract: the original request wrapped in
    // instructions about how to treat what follows. Screened as a person's message it reads as a
    // prompt-injection attempt, and the input guardrail blocked the fold before the model ran - which
    // on 2026-09-09 replaced a finished report with a refusal. Everything a person wrote, and nothing
    // this file added.
    userContent: [args.userMessage, ...amendments.map((m) => m.content)].filter(Boolean).join('\n\n'),
    botArn,
    correlationId,
    amendedFold: fold,
    ...(args.userMessageId ? { userMessageId: args.userMessageId } : {}),
    // WHAT THIS ANSWER ADDRESSES BESIDES THE ORIGINAL MESSAGE. Falls back to the ids of this fold's
    // own amendments, so a caller that does not accumulate still declares the batch it is folding
    // rather than declaring nothing.
    foldedMessageIds: args.foldedMessageIds?.length
      ? args.foldedMessageIds
      : amendments.map((m) => m.messageId),
    ...(args.foldedIntents && Object.keys(args.foldedIntents).length ? { foldedIntents: args.foldedIntents } : {}),
    trigger: 'user' as const,
  };

  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: routerArn,
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify({ aeTurn })),
    }));
    console.log('[turn-triage] folded the amendment into the work in flight', {
      correlationId, count: amendments.length, fold,
    });
    return true;
  } catch (err) {
    console.error('[turn-triage] could not fold the amendment; the caller must deliver what it has', {
      correlationId, err: (err as Error)?.message,
    });
    return false;
  }
}

export async function dispatchTriageTurn(args: {
  channelArn: string;
  botArn: string;
  classification: string;
  correlationId: string;
  senderArn: string;
  messages: TriagedMessage[];
  inFlightLabel?: string;
  /** What the tasks this turn creates may be seen by. Decided here, applied there. */
  visibility: TaskVisibility;
  /** Which pass this is, 1-based. Omitted means the first, which is what a fresh queue starts at. */
  pass?: number;
  /** Queued ids with nothing readable left in them; cleared, never triaged. */
  accountedIds?: string[];
  /** What earlier passes of this reading cost, carried to the pass that posts. See `TriageTurnContext.priorPasses`. */
  priorPasses?: { inputTokens: number; outputTokens: number; bedrockMs: number };
  /**
   * WHEN THE QUEUE RELEASED THIS WORK, epoch ms, for a pass after the first.
   *
   * A reading is timed from the queue's release of its work to the message it delivers (the
   * `queue_release` source, LATENCY-TARGETS). The first pass is dispatched at that release, so its own
   * dispatch instant is the start. A later pass is the same reading continued, and without this each
   * redispatch declared its own instant, so a reading that posted on its second pass was timed from
   * that pass and the first pass's wait went unmeasured. Absent means this dispatch IS the release.
   */
  queueReleasedAtMs?: number;
}): Promise<boolean> {
  const {
    channelArn, botArn, classification, correlationId, senderArn, messages, inFlightLabel, visibility,
  } = args;
  if (!messages.length) return false;

  const pass = args.pass && args.pass >= 1 ? Math.floor(args.pass) : 1;

  const routerArn = await resolveRouterArn(classification);
  if (!routerArn) {
    // Loud, because the messages are still queued and nothing else will look at them until somebody
    // speaks again. An unroutable classification means a person waited and was not answered.
    console.error('[turn-triage] no router for this classification; the queue stays untriaged', {
      classification, count: messages.length,
    });
    return false;
  }

  // TYPED, because this is the one hop where a rename drifts SILENTLY: the payload is serialized to
  // JSON and read back through request attributes, so a field this side stops sending is not a type
  // error on the other side - it is a triage turn that arrives looking like an ordinary one and posts
  // its machine-readable reply into the channel. The annotation costs nothing (`import type` is
  // erased) and turns that into a compile failure.
  const withAttachments = messages.filter((m) => m.attachment);
  if (withAttachments.length > 1) {
    console.warn('[turn-triage] more than one queued message carried a file; the reading takes the '
      + 'most recent and the others are not read', {
      channelArn, attached: withAttachments.length,
      ids: withAttachments.map((m) => m.messageId),
    });
  }

  const aeTurn: TurnRequest = {
    channelArn,
    senderArn,
    userMessage: buildTriagePrompt({
      queued: messages.map((m) => ({ messageId: m.messageId, content: m.content })),
      inFlightLabel,
      // OFFERED ONLY WHILE IT IS AFFORDABLE. Describing an option the runtime would then refuse
      // teaches the model to ask for something that silently does not happen, and a reply that asks
      // is a reply that produced no reading.
      mayAskForAnotherPass: mayTakeAnotherPass({ pass }),
      // THE READING IS RECORDED THROUGH THE TOOL, which is offered on every triage turn. Said here so
      // this prompt does not restate a contract the system directive has already given differently.
      viaTool: true,
    }),
    botArn,
    correlationId,
    userMessageId: messages[messages.length - 1].messageId,
    // THE FILE SOMEBODY QUEUED, carried into the reading that answers for it.
    //
    // ONE, BECAUSE A TURN CARRIES ONE, and a reading answers a BURST that may hold several. The most
    // recent wins, matching `userMessageId` above - the reading is anchored on the last queued
    // message, so its file is the one the anchor refers to. When more than one was attached the loss
    // is LOGGED rather than silent: a person who attached two documents and got an answer about one
    // has no other way to find out, and a quiet drop here is what this whole fix is about.
    ...(withAttachments.length > 0 && { attachment: withAttachments[withAttachments.length - 1].attachment }),
    // WHEN THE DRAIN STARTED, so a reading is timed from its own start to its own final post. A reading
    // answers no single person's message, so without this its span began at processor entry and the
    // dispatch was unmeasured. Every turn is named and measured.
    // A LATER PASS CARRIES THE FIRST RELEASE, so the whole reading is timed from it (`queueReleasedAtMs`).
    triggerAtMs: typeof args.queueReleasedAtMs === 'number' && Number.isFinite(args.queueReleasedAtMs)
      ? args.queueReleasedAtMs
      : Date.now(),
    triage: {
      ids: messages.map((m) => m.messageId),
      // CLEARED BUT NOT TRIAGED. Nothing readable is left in these, so asking the model to
      // classify them would be asking about nothing - but they are still sitting in the queue,
      // and only the turn that drains it can take them out.
      ...(args.accountedIds?.length ? { accountedIds: args.accountedIds } : {}),
      // WHAT ACTUALLY CAME FROM A PERSON, carried apart from the prompt that wraps it.
      //
      // The input guardrail screens the turn's `userMessage`, and for a triage turn that value is
      // the whole assembled CONTRACT: instructions telling the model what to do, wrapped around
      // quoted user text. That is the shape of a prompt-injection attempt, so the guardrail's
      // prompt-attack filter fired on our own scaffolding and blocked every triage turn before the
      // model was ever called - which is why the judged reading never once succeeded and every
      // drain fell back to the derived floor.
      //
      // The answer is not to stop screening. It is to screen the part that is actually untrusted:
      // the queued messages themselves, which is what a guardrail is for. The contract is our own
      // text and screening it protects nobody.
      userContent: messages.map((m) => m.content).join('\n\n'),
      // WHICH of them were targeted, not merely whether any were. The batch visibility below
      // is the safe floor for the reading; this is what lets task creation keep a targeted
      // request separate from an untargeted one instead of merging them (DESIGN 2.4.1).
      targetedIds: messages.filter((m) => m.targeted).map((m) => m.messageId),
      // WHO SENT EACH. A queue is not one person's, and the single senderArn below is only the
      // turn's own attribution - taken from the last queued message, which is nobody in
      // particular once there is more than one sender.
      sendersById: Object.fromEntries(
        messages.filter((m) => m.senderArn).map((m) => [m.messageId, m.senderArn as string]),
      ),
      visibility,
      inFlight: Boolean(inFlightLabel),
      // AND THE DESCRIPTION ITSELF, so a re-read pass compares against the same work the first pass
      // did. Only the boolean traveled, so pass 2 fell back to the bare phrase and could classify an
      // amendment differently from pass 1 for no reason a person could see.
      ...(inFlightLabel ? { inFlightLabel } : {}),
      pass,
      ...(args.priorPasses ? { priorPasses: args.priorPasses } : {}),
    },
    // A person IS waiting on this - they sent the messages it is reading - so the perceived-latency
    // SLO covers it. What makes the wait legible is the queue metric, not a different interaction.
    trigger: 'user' as const,
  };

  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: routerArn,
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify({ aeTurn })),
    }));
    console.log('[turn-triage] dispatched the triage turn', { count: messages.length, correlationId });
    return true;
  } catch (err) {
    console.error('[turn-triage] dispatch failed; the caller must hand the lock back', {
      count: messages.length, err: (err as Error)?.message,
    });
    return false;
  }
}
