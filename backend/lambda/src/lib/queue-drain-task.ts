/**
 * THE DRAIN IS A TASK: opening it, and ending it (ADR-033, owner 2026-09-03).
 *
 * Working a queue is work - it has states, legal moves between them, a step that awaits a person, and
 * a point at which it is over - and it was declared in exactly that shape long before it took a task
 * row. Both ends live here rather than at the two call sites, because "one drain per queue" is a rule
 * about the PAIR: an open that is claimed once and an end that happens exactly when the queue is
 * empty. Split across two files, the second half is the one that gets forgotten, which is precisely
 * what happened - the record forgot the drain while the row lived on to its TTL.
 *
 * WHAT THIS DELIBERATELY DOES NOT STORE IS THE MESSAGE (maintainer, 2026-09-03). The task carries the
 * message ID and nothing of its content. Anything showing a person what a drain is about resolves
 * that id AS THE CALLER, so a targeted request stays invisible to somebody who may not read it - the
 * same rule the queue itself already follows, and the reason `queued` holds ids rather than text.
 *
 * Storing an excerpt instead would publish a private message's words into a conversation-visible row:
 * a drain covers a whole queue, from possibly several people, so there is no single message whose
 * text it could honestly carry even if privacy allowed it. The client already renders a work item
 * with no title of its own from its TYPE, so nothing is lost by carrying none.
 */

import { randomUUID } from 'crypto';
import { ChimeSDKMessagingClient, GetChannelMessageCommand } from '@aws-sdk/client-chime-sdk-messaging';
import { claimDrainTask } from './turn-lock.js';
import { createTask, getTask, advanceTaskStateTo, updateTaskStatus } from './task-store.js';
import { DeliveryOption } from './delivery-options.js';
import { QUEUED_REQUEST_TASK_TYPE } from './turn-triage-proposal.js';
import { shouldMarkTaskCompleted, principalIdFromArn, ACTIVE_TASK_STATUSES, type LexEventForTask, type Task } from './task-tracking.js';
import { taskStateMachines } from './intent-pack.js';
import { BOUNDED_REQUEST_HANDLER } from './bounded-request-handler.js';
import { sessionClient } from './assistant-session.js';

/** The declared type. One string, so the machine, the open and the end cannot drift apart. */
const messagingClient = sessionClient(ChimeSDKMessagingClient, { region: process.env.AWS_REGION || 'us-east-1', requestHandler: BOUNDED_REQUEST_HANDLER });

export const QUEUE_DRAIN_TASK_TYPE = 'queue_drain';

/**
 * Open the drain for this queue, or find the one already open.
 *
 * Called on the path that DEFERS a message, which runs for every message that queues - so a burst of
 * three must open one drain, not three. The claim on the shared turn record settles that: the winner
 * of a conditional write creates the row and every loser is told which row it is. The task is created
 * only by the winner, so a lost race leaves no orphan.
 *
 * OWNED BY THE ASSISTANT, because reading the queue is the assistant's work. That is also why it
 * lands in nobody else's list: the mirror is partitioned by owner. It reaches a person only if the
 * drain hands over at `clarifying`, which is the moment it is asking them something.
 *
 * BEST EFFORT THROUGHOUT. The queue is the work; the task is how the work is seen. A drain that
 * cannot record itself still drains.
 *
 * @returns the drain's task id, or an empty string when none is tracking it.
 */
export async function openDrainTask(args: {
  event: LexEventForTask;
  channelArn: string;
  responderId: string;
  correlationId?: string;
  /** The queued message's own id. Stored as a REFERENCE; its content is never copied here. */
  queuedMessageId?: string;
  /** The intent the message that opened the drain was classified as (ADR-064 decision B). */
  openingIntent?: string;
}): Promise<string> {
  const { event, channelArn, responderId, correlationId, queuedMessageId, openingIntent } = args;
  if (!channelArn || !responderId) return '';

  const claim = await claimDrainTask({ channelArn, responderId, taskId: randomUUID() });
  if (!claim.created) return claim.taskId;

  // ── THE TRANSCRIPT IS STRIPPED, AND THAT IS THE WHOLE PRIVACY RULE (live evidence, 2026-09-03) ──
  //
  // `createTask` falls back to `event.inputTranscript` when no excerpt is passed, which is right for
  // every ordinary caller on the Lex path and wrong for exactly this one. Passing no excerpt is
  // therefore NOT the same as storing none: the drain was handed the turn's real Lex event, so every
  // drain row carried the queued message's text after all - measured on the deployment, nine rows out
  // of nine, while the unit test asserting "no excerpt is passed" stayed green because it mocked
  // `createTask` and never reached the fallback.
  //
  // So the attributes are passed WITHOUT the transcript. `createTask` reads only the channel and
  // sender from them, which is all a drain has any business handing it.
  const attributesOnly: LexEventForTask = {
    ...(event.requestAttributes ? { requestAttributes: event.requestAttributes } : {}),
  };

  try {
    await createTask(attributesOnly, DeliveryOption.TASK_MULTI_STEP, QUEUE_DRAIN_TASK_TYPE, correlationId, {
      taskId: claim.taskId,
      owner: { id: responderId, type: 'assistant' },
      assistantId: responderId,
      // MULTI-STEP, and NOT the delivery the turn resolved. That one describes the message being
      // deferred; a drain is its own work and moves through its own stages. Borrowing the turn's
      // would make a drain DIRECT whenever the message it queued behind was a greeting.
      //
      // CONVERSATION-VISIBLE, and stated rather than left absent. Absence is reserved to mean
      // "written before visibility existed", so a new write that omits it turns a migration reading
      // into a default nobody chose. Visible is honest here BECAUSE no content is stored: the room
      // is already told that messages are waiting by the notice, and a row carrying only an id
      // discloses nothing the notice has not.
      visibility: 'conversation',
      ...(queuedMessageId ? { userMessageId: queuedMessageId } : {}),
      ...(openingIntent ? { openingIntent } : {}),
    });
    return claim.taskId;
  } catch (err) {
    console.warn('[queue-drain-task] could not open the drain task; the drain runs untracked', {
      correlationId, message: (err as Error)?.message,
    });
    return '';
  }
}

/**
 * END THE DRAIN, WHICH HAPPENS EXACTLY WHEN THE QUEUE IS EMPTY.
 *
 * The queue emptying and the notice settling and the drain ending are one fact said three ways - to
 * the record, to the person, and to the system - so they are done together. They disagreed once
 * already: `clearQueue` removed the drain's id from the record while the row stayed `pending` to its
 * 24-hour TTL, and an unsettled drain is not inert. It is the NEWEST live task the assistant owns in
 * that channel, and the router reads the newest, so it masked a real chain that was blocked on a
 * person - their reply stopped resuming their own work. It also held `liveTaskInChannel` true, which
 * suppresses drift, and it would eventually trip stall supervision on work nobody was doing.
 *
 * THE STATUS IS WHAT ACTUALLY ENDS IT. Reaching a terminal STATE does not close a row: the queries
 * that decide what is live filter on `status`, so a task in `settled` with `status: pending` is still
 * live work by every reader that matters. The state is recorded because it is the honest history and
 * what the resolution timing reads; the status is recorded because it is what makes the row stop
 * counting.
 *
 * BEST EFFORT, and it must stay that way: this runs after the person already has their answer.
 */
export async function settleDrainTask(args: {
  taskId: string;
  channelArn: string;
  /** For the log, so a drain that failed to close names the turn that should have closed it. */
  correlationId?: string;
}): Promise<void> {
  const { taskId, channelArn, correlationId } = args;
  if (!taskId || !channelArn) return;
  try {
    const task = await getTask(taskId, channelArn);
    if (!task) return;
    // ALREADY OVER. Two readings can both observe an empty queue - the clear and a handover that
    // finds nothing left - and closing a closed task would rewrite the ending's timestamp, which is
    // the number the resolution view reads.
    // THE PACK-MERGED MACHINES, for the reason the finalizer states: omitted, this resolves against
    // the platform defaults, and a deployment that overrides the drain machine gets a completion
    // check reading a graph the task is not running on. The drain is platform-declared, so this is
    // narrower than the sibling cases - but "nobody would override that one" is what makes a fixed
    // default look safe everywhere it is wrong.
    if (shouldMarkTaskCompleted(task.taskType, task.taskState, taskStateMachines())) {
      // A TERMINAL STATE IS NOT A CLOSED ROW (queue review, 2026-09-12). `advanceTaskStateTo` writes the
      // state and never the status, so a settle that advanced the machine and then threw before the
      // status write below left a row in `settled` with `status: pending` - and every later settle
      // returned here, so it stayed live work until its 24h TTL. The status is finished here, and ONLY
      // when it is still active: a drain a stop cancelled is not rewritten as completed, and a row
      // already closed keeps the ending it has.
      if (task.status && ACTIVE_TASK_STATUSES.includes(task.status)) {
        await updateTaskStatus(taskId, channelArn, 'completed');
      }
      return;
    }

    // THE MACHINE, AND THE WHOLE DECLARED PATH TO THE END - NOT A JUMP (live evidence, 2026-09-03).
    //
    // `settled` is reachable from `clearing` and from `waiting`, the latter being the stopped turn.
    // A drain that ASKED something sits in `clarifying`, and asking `clarifying -> settled` is an
    // illegal transition the machine rightly refuses - so the row closed on its status while its
    // state stopped at `clarifying`. Measured on the deployment: of 18 drains, 6 ended that way.
    //
    // A task closed in a non-terminal state is not a cosmetic problem. `v_task_resolution` reads the
    // TERMINAL entry, so a drain that never records one has no resolution at all - which is the
    // measurement the task row was adopted to provide.
    //
    // So it walks the declared edges rather than forcing past them. `clearing` is reachable from
    // every state a live drain can be in when the queue empties, and it is TRUE at that moment: the
    // queue is being cleared, which is what the step means. Nothing here invents an edge - a machine
    // that still refuses after this is genuinely somewhere unexpected, and says so.
    let advanced = await advanceTaskStateTo({
      task, toState: 'settled', by: 'system', reason: 'the queue is empty',
    });
    if (!advanced.ok) {
      const viaClearing = await advanceTaskStateTo({
        task, toState: 'clearing', by: 'system', reason: 'the queue is empty',
      });
      if (viaClearing.ok) {
        advanced = await advanceTaskStateTo({
          task: { ...task, taskState: 'clearing' },
          toState: 'settled', by: 'system', reason: 'the queue is empty',
        });
      }
    }
    if (!advanced.ok) {
      console.warn('[queue-drain-task] the drain could not be settled on its machine', {
        taskId, from: task.taskState, error: advanced.error, correlationId,
      });
    }
    await updateTaskStatus(taskId, channelArn, 'completed');
  } catch (err) {
    console.warn('[queue-drain-task] could not close the drain task', {
      taskId, correlationId, message: (err as Error)?.message,
    });
  }
}

/**
 * MOVE THE DRAIN'S OWN STATE ALONGSIDE THE STAGE A PERSON IS SHOWN.
 *
 * The stage and the task state were two records of one fact. A person read `queueStatus` off the
 * notice; the task carried a `taskState` that nothing moved, so it sat in `waiting` for its whole
 * life while the notice said `clearing`. Two vocabularies for one drain is what the task row was
 * adopted to stop, and leaving one of them frozen is worse than not having it: the operator view and
 * the resolution timing both read the state, and a state that never moves reports every drain as
 * having never started.
 *
 * THE RECORD DECIDES, AND THIS FOLLOWS. The conditional advance on the turn record is the authority
 * for ordering - it refuses a stage that cannot legally follow the stored one, which is what settles
 * the genuine race between the private half and the clear. This runs only when that write ACCEPTED
 * the move, so the two cannot disagree about whether a stage happened; asking the machine twice, in
 * two places, is how they would.
 *
 * ONE READ PER DRAIN, NOT PER STAGE. The task is fetched once and its state carried forward locally,
 * because the record has already established the order and a drain is on the path somebody is waiting
 * on (section 7.4). A write that fails leaves the local state moved on anyway: the task falls behind,
 * the drain still closes, and the alternative - refusing to advance because one write failed - would
 * strand the state at the exact stage that failed.
 *
 * @returns a function that records one stage. Safe to call with no drain: it does nothing.
 */
export function drainStageRecorder(args: { taskId: string; channelArn: string }) {
  const { taskId, channelArn } = args;
  // `undefined` is "not looked up yet"; `null` is "looked up, and there is none".
  let task: Task | null | undefined;

  return async (toState: string): Promise<void> => {
    if (!taskId || !channelArn) return;
    try {
      if (task === undefined) task = await getTask(taskId, channelArn);
      if (!task) return;
      const advanced = await advanceTaskStateTo({
        task, toState, by: 'system', reason: 'the drain moved on',
      });
      if (advanced.ok) {
        task = { ...task, taskState: toState };
        return;
      }
      // WORTH SEEING rather than swallowing. The record accepted this move, so a refusal here means
      // the two machines disagree - which is the one thing carrying the stage in two places was
      // supposed to stop.
      console.warn('[queue-drain-task] the record advanced the stage and the task would not', {
        taskId, from: task.taskState, to: toState, error: advanced.error,
      });
    } catch (err) {
      console.warn('[queue-drain-task] could not record the drain stage', {
        taskId, to: toState, message: (err as Error)?.message,
      });
    }
  };
}

/** The question a drain raises about work that was already running. */
export const WORK_STILL_WANTED_TASK_TYPE = 'work_still_wanted';

/**
 * RECORD THE QUESTION "IS THE WORK ALREADY RUNNING STILL WANTED".
 *
 * The reading says `IN_FLIGHT_UNCLEAR` when it cannot tell whether the turn it is queued behind is
 * still wanted. That produced a stage on the notice, one sentence in the proposal, and a log field -
 * and nothing else. Nothing owned it, nothing outlived the message, and no list showed it.
 *
 * It was survivable while the drain waited at `clarifying`, because the drain was the holder. Once a
 * drain stopped waiting, the question was left held by nothing: asked once, in a message, forgotten
 * by the system the moment the queue cleared. That is the failure this whole design exists to
 * prevent - a proposal describing something nothing holds.
 *
 * IT CANNOT ATTACH TO THE IN-FLIGHT WORK, which is why it is a row of its own. The running turn is
 * identified only by holding the lock; `inFlightLabel` is a literal phrase set from `state.busy`, and
 * the holder is a correlation id. There is frequently no task there to attach to - an ordinary answer
 * has none.
 *
 * WHO IT IS ASKED OF, stated because it is imperfect. The drain does not know who STARTED the running
 * turn - nothing records that - so it asks the person it is talking to, which is the same attribution
 * the proposal already uses and the same person the question is already put to in the room. In a
 * conversation where one person's work is running and another's message queued, this asks the second
 * about the first. That is the existing behavior of the proposal made durable, not a new defect, and
 * it is the honest limit of what the record knows.
 *
 * ONE PER DRAIN. The id is derived from the drain's own, so a chain of passes that keeps finding the
 * same ambiguity re-asks nobody: an existing row is left exactly as it is, including an answer that
 * has already moved it.
 */
export async function openInFlightQuestion(args: {
  event: LexEventForTask;
  channelArn: string;
  responderId: string;
  /** The drain this question came out of, which is what makes the id stable across its passes. */
  drainTaskId?: string;
  correlationId?: string;
  visibility?: 'conversation' | 'private';
}): Promise<string> {
  const { event, channelArn, responderId, drainTaskId, correlationId, visibility } = args;
  if (!channelArn || !responderId) return '';
  // A drain with no row of its own cannot key this to anything stable. A fresh id still records the
  // question, which is the point, and an untracked drain is already the case where the record is
  // incomplete.
  const taskId = drainTaskId ? `${drainTaskId}-still-wanted` : randomUUID();

  try {
    if (drainTaskId && await getTask(taskId, channelArn)) return taskId;
    await createTask(event, DeliveryOption.TASK_MULTI_STEP, WORK_STILL_WANTED_TASK_TYPE, correlationId, {
      taskId,
      // THE PERSON HOLDS IT FROM BIRTH, because the machine's first state awaits them. `createTask`
      // honors a caller's owner only when the first step is NOT the person's, so naming one here
      // would be ignored - correctly. This is the case ADR-024 D1 describes: born blocked on them.
      assistantId: responderId,
      // THE READING THAT ASKED is joined by `correlationId`, passed positionally above, and nothing
      // else. `userMessageId` is reserved for a resolvable Chime id of the person's message (ADR-024
      // D5, "never the correlation id as a fallback"), and this question was opened by no message of
      // theirs, so it is left absent rather than filled with a correlation id a reader would try to
      // resolve against the channel.
      ...(visibility ? { visibility } : { visibility: 'conversation' as const }),
    });
    return taskId;
  } catch (err) {
    console.warn('[queue-drain-task] could not record the in-flight question; it lives only in the proposal', {
      correlationId, message: (err as Error)?.message,
    });
    return '';
  }
}

/**
 * RECALL THE MESSAGE A CLARIFICATION IS ABOUT, AT THE MOMENT IT IS ANSWERED.
 *
 * This is the other half of storing the ID instead of the words, and without it the rule is only half
 * kept: the row is safe, and the assistant is helpless. A person answers "I meant the Q3 one" against
 * a task that deliberately carries nothing about what was asked, so there is nothing for the answer to
 * attach to and the reply is uninterpretable.
 *
 * RESOLVED AS THE CALLER, WHICH IS WHY THIS IS SAFE. The clarification is owned by the person the
 * assistant asked - `createTask` derives the requester from the sender of the message it could not
 * make out, and the state awaits them - so the only turn that reaches this is that person answering
 * their OWN message. Nothing here widens who may read what: it recovers, for one person, the text
 * they themselves wrote.
 *
 * BEST EFFORT. A message that has since been deleted or redacted returns nothing, and the turn
 * proceeds without it - the assistant then has the answer and not the question, which is worse than
 * having both and far better than failing the turn. A message can also be EDITED between the reading
 * and the answer, and what comes back is the current text rather than what was read; that is the
 * honest thing to show, and the wider question of an edit reaching work already proposed is tracked
 * separately.
 */
export async function recallClarifiedMessage(args: {
  channelArn: string;
  messageId: string;
  botArn: string;
}): Promise<string> {
  const { channelArn, messageId, botArn } = args;
  if (!channelArn || !messageId || !botArn) return '';
  try {
    const res = await messagingClient.send(new GetChannelMessageCommand({
      ChannelArn: channelArn,
      MessageId: messageId,
      ChimeBearer: botArn,
    }));
    const raw = res.ChannelMessage?.Content || '';
    if (!raw) return '';
    // Amazon Chime SDK delivers the content percent-encoded, and handing the model
    // `Produce%20a%20report` is the same defect as storing it that way.
    try { return decodeURIComponent(raw); } catch { return raw; }
  } catch (err) {
    console.warn('[queue-drain-task] could not recall the message a clarification is about', {
      messageId, message: (err as Error)?.message,
    });
    return '';
  }
}

/** The question a drain raises when one subject holds requests from more than one person. */
export const QUEUED_COMBINATION_TASK_TYPE = 'queued_combination';

/** A subject the reading named, with who sent each message in it. */
export interface CombinationCandidate {
  label: string;
  messageIds: string[];
  /** Distinct senders, as principal ids, in the order their messages arrived. */
  /** The people who asked, as principal ids. Used for comparison and for the task details. */
  requestors: string[];
  /**
   * The same people as ARNs, in the same order.
   *
   * Kept because `createTask` reads its sender as an ARN and splits on `/user/`: handing it a bare
   * principal id produced an empty requester, so the combination task awaited nobody and was never
   * handed back. Carried rather than rebuilt from the app-instance ARN, which this module would
   * otherwise have to know.
   */
  requestorArns: string[];
}

/**
 * WHICH SUBJECTS HOLD REQUESTS FROM MORE THAN ONE PERSON.
 *
 * A queue is not one person's, and the reading groups it by subject. A group whose messages came from
 * DIFFERENT people is the case where two requests might really be one - and merging them is not
 * triage's call to make. DESIGN 2.4.1 said exactly that and only half of it was built: the runtime
 * refused to combine, and nothing ever proposed it, so "separate" was the answer to a question nobody
 * asked.
 *
 * PURE, so the rule is testable without a queue, a model or a store. What counts as a candidate is a
 * judgement about people rather than about text: same subject, more than one sender.
 */
export function combinationCandidates(
  topics: Array<{ label: string; messageIds: string[] }> | undefined,
  sendersById: Record<string, string> | undefined,
): CombinationCandidate[] {
  if (!topics?.length || !sendersById) return [];
  const out: CombinationCandidate[] = [];
  for (const topic of topics) {
    const requestors: string[] = [];
    const requestorArns: string[] = [];
    for (const id of topic.messageIds) {
      const sender = principalIdFromArn(sendersById[id] || '');
      // ONE ENTRY PER PERSON, in arrival order. Three messages from the same person about one subject
      // is not a combination question - it is one person elaborating, which the reading already
      // handles by giving each its own item.
      if (sender && !requestors.includes(sender)) {
        requestors.push(sender);
        requestorArns.push(sendersById[id] || '');
      }
    }
    if (requestors.length > 1) {
      out.push({ label: topic.label, messageIds: topic.messageIds, requestors, requestorArns });
    }
  }
  return out;
}

/**
 * ASK WHETHER TWO PEOPLE'S REQUESTS ARE ONE, AND WHO WOULD OWN IT.
 *
 * ONE PERSON IS ASKED, NOT THE ROOM. The candidates are all possible owners of the merged item, so
 * the question goes to the sender of the EARLIEST message in the group - the one whose request the
 * others arrived alongside. Asking everybody would produce several answers to a question with one
 * outcome, and asking nobody is what happens today.
 *
 * IT NAMES NOTHING ANYBODY WROTE. The task carries the message ids and the subject label the reading
 * chose; the messages themselves are resolved as the caller when somebody reads them. A targeted
 * request inside the group therefore stays unreadable to the person being asked - which is why the
 * question is about whether to combine, and never about what the other message said.
 *
 * ONE PER SUBJECT PER DRAIN. The id is derived from the drain's and the subject's, so a handover
 * chain that keeps seeing the same grouping asks once.
 */
export async function openCombinationQuestion(args: {
  event: LexEventForTask;
  channelArn: string;
  responderId: string;
  candidate: CombinationCandidate;
  drainTaskId?: string;
  correlationId?: string;
  /** The intent the earliest message of the group was classified as when it queued (ADR-064 decision B). */
  openingIntent?: string;
}): Promise<string> {
  const { event, channelArn, responderId, candidate, drainTaskId, correlationId, openingIntent } = args;
  if (!channelArn || !responderId || candidate.requestors.length < 2) return '';

  // Stable across passes: the same drain seeing the same subject must not ask twice.
  const key = `${drainTaskId || 'untracked'}-combine-${candidate.messageIds[0]}`;
  try {
    if (drainTaskId && await getTask(key, channelArn)) return key;
    await createTask(
      // THE ASKED PERSON IS THE SENDER, which is what makes them the requester the machine awaits.
      // THE ARN, not the principal id. `createTask` requires the `/user/` split to match to derive a
      // requester, so a bare id left the task awaiting nobody and it was never handed back.
      {
        requestAttributes: {
          'CHIME.channel.arn': channelArn,
          'CHIME.sender.arn': candidate.requestorArns[0] || candidate.requestors[0]!,
        },
      },
      DeliveryOption.TASK_MULTI_STEP,
      QUEUED_COMBINATION_TASK_TYPE,
      correlationId,
      {
        taskId: key,
        assistantId: responderId,
        visibility: 'conversation',
        ...(openingIntent ? { openingIntent } : {}),
        details: {
          // WHAT THE ANSWER HAS TO ACT ON, recorded rather than re-derived: the merge happens on a
          // later turn, and the grouping that prompted it is gone from the record by then.
          subject: candidate.label,
          messageIds: candidate.messageIds,
          requestors: candidate.requestors,
          // AND THE ARNs, because the merge on a later turn opens a task of its own and `createTask`
          // derives its requester by splitting the sender on `/user/`. Only the bare ids were kept
          // here, so `mergeCombinedRequests` had nothing else to hand it: the merged `queued_request`
          // failed that split, awaited nobody, and could never be handed back - the identical defect
          // this question's own sender line was fixed for, surviving one step further along.
          requestorArns: candidate.requestorArns,
        },
      },
    );
    return key;
  } catch (err) {
    console.warn('[queue-drain-task] could not ask whether two requests are one', {
      correlationId, message: (err as Error)?.message,
    });
    return '';
  }
}

/**
 * DO WHAT THE ANSWER DECIDED: open ONE item covering the group, owned by the person named.
 *
 * This is why `merging` is a state rather than something done quietly inside a transition. A machine
 * whose terminal state is the ANSWER records that somebody replied; a machine with a step for the
 * WORK records that something happened because they did - and a merge that failed is then visible as
 * a task sitting in `merging` rather than as a success with nothing behind it.
 *
 * THE OWNER IS THE ANSWER'S, NOT THE ASKED PERSON'S. The question goes to the sender of the earliest
 * message, but they may name somebody else as the one whose request this really is - that is half of
 * what is being asked. `ownerId` on the merged item is what settles it, so the answer has to be able
 * to settle `ownerId`. A named owner outside the group is refused: the candidates are the people who
 * actually asked for something, and handing the work to a bystander is not a decision the answer is
 * entitled to make.
 *
 * THE MESSAGES THEMSELVES ARE NOT COPIED. The merged item carries the ids it covers; its content is
 * resolved as the caller, so a targeted request folded into a group stays unreadable to anyone who
 * could not already read it.
 *
 * @returns the merged task's id, or an empty string when nothing was opened.
 */
export async function mergeCombinedRequests(args: {
  task: Task;
  channelArn: string;
  responderId: string;
  /** Who the answer named as the owner. Defaults to the person who was asked. */
  ownerId?: string;
  correlationId?: string;
}): Promise<string> {
  const { task, channelArn, responderId, correlationId } = args;
  const details = (task.details ?? {}) as {
    subject?: string; messageIds?: unknown; requestors?: unknown; requestorArns?: unknown;
  };
  const messageIds = Array.isArray(details.messageIds)
    ? details.messageIds.filter((i): i is string => typeof i === 'string')
    : [];
  const requestors = Array.isArray(details.requestors)
    ? details.requestors.filter((i): i is string => typeof i === 'string')
    : [];
  // THE SAME PEOPLE AS ARNs, IN THE SAME ORDER, so a named owner can be turned back into the sender
  // `createTask` needs. A row written before these were recorded has none, and falls back to the
  // bare id below - which is what it did for every row, and is why this is a fallback rather than
  // the path.
  const requestorArns = Array.isArray(details.requestorArns)
    ? details.requestorArns.filter((i): i is string => typeof i === 'string')
    : [];
  if (!messageIds.length || !requestors.length) {
    console.warn('[queue-drain-task] a combination answered with nothing to merge', {
      taskId: task.taskId, correlationId,
    });
    return '';
  }

  // ONE OF THE PEOPLE WHO ASKED. A name outside that set is not a decision this question can carry,
  // so it falls back to the person who was asked rather than being honored.
  const named = args.ownerId && requestors.includes(args.ownerId) ? args.ownerId : requestors[0]!;
  // AND AS AN ARN, which is what the sender attribute has to carry. `requestorArns` is written in the
  // same order as `requestors`, so the named person's ARN is at the named person's index.
  const namedArn = requestorArns[requestors.indexOf(named)] || named;
  if (namedArn === named && !requestorArns.length) {
    // Said once, because the merged item will await nobody and the only visible symptom is work that
    // is never handed back. A row written before the ARNs were recorded is the only way to get here.
    console.warn('[queue-drain-task] the combination carries no requester ARNs; the merged item may await nobody', {
      taskId: task.taskId, correlationId,
    });
  }

  try {
    const merged = await createTask(
      { requestAttributes: { 'CHIME.channel.arn': channelArn, 'CHIME.sender.arn': namedArn } },
      DeliveryOption.TASK_MULTI_STEP,
      QUEUED_REQUEST_TASK_TYPE,
      correlationId,
      {
        assistantId: responderId,
        visibility: 'conversation',
        // The subject the reading named, which is what the people who asked agreed this is about.
        ...(details.subject ? { requestExcerpt: details.subject } : {}),
        // THE INTENT THE QUESTION WAS OPENED UNDER, which the merged request carries on (ADR-064 decision B).
        ...(task.openingIntent ? { openingIntent: task.openingIntent } : {}),
        details: {
          mergedFrom: messageIds,
          requestors,
          ...(requestorArns.length ? { requestorArns } : {}),
          combinedBy: task.taskId,
        },
      },
    );
    console.log('[queue-drain-task] two requests became one', {
      taskId: merged.taskId, from: messageIds.length, owner: named, correlationId,
    });
    return merged.taskId;
  } catch (err) {
    console.warn('[queue-drain-task] could not merge the combined requests', {
      taskId: task.taskId, correlationId, message: (err as Error)?.message,
    });
    return '';
  }
}
