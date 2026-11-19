/**
 * A RUN HELD ON SOMETHING ELSE'S END: a team conversation's run waiting for the conversation it opened to end its own run
 * (`wait: { child: 'ended' }`), a run's end waiting on a task it opened alongside its steps (`continue: 'alongside'`), and a
 * join waiting on several of those parts at once (`wait: { join }`), each part on its own record.
 *
 * Both meet on one record of the run's wait (`holdRunWait`, written once, through the task service): whichever side comes
 * first writes it, and the side that comes second reads it and goes on. The run's side writes its continuation; the ending
 * side writes how it ended. So neither order loses the meeting, and the run goes on once, under its step's continuation
 * claim, whichever side carries it on.
 *
 * What it guarantees:
 *  - THE RECORD IS NAMED BY WHAT ENDS, never by the run: the opened conversation's ARN, or the task's id. An ending can only
 *    reach a run that waits on that very thing, in the conversation that waits.
 *  - THE PARENT IS THE ONE THE CHILD'S OWN ROW RECORDS (`parentRef`, server-only, written by its creator), and the opened
 *    conversation is the one the creator handed the run back (`conversation_link`), each a conversation of the same app
 *    instance. A link naming anything else names nothing.
 *  - A FAILED READ OR WRITE IS NEVER A MEETING: it answers `failed`, and the caller decides.
 *
 * Pure apart from the two record operations it is handed.
 */
import { contentHash12 } from './canonical-json.js';
import { parentArnOf } from './related-conversations.js';

/** The two operations on a run's wait record, as the task service answers them. */
export interface HeldRunRecords {
  hold: (input: { waitId: string; channelArn: string; continuation: Record<string, unknown> }) => Promise<{ claimed: boolean; reason?: string }>;
  read: (input: { waitId: string; channelArn: string }) => Promise<Record<string, unknown> | null>;
}

/**
 * The prefix of the record a run waiting on the conversation it opened is held under: a wait's record (`wait-`), so its
 * one-shot backstop fires through the run-wait schedule every timed wait uses.
 */
export const CHILD_WAIT_PREFIX = 'wait-child-';
/** The record a run waiting on the conversation it opened is held under, in the conversation that waits. */
export const childEndWaitId = (childArn: string): string => `${CHILD_WAIT_PREFIX}${contentHash12({ child: childArn })}`;
/** The record a run's end waiting on a task it opened alongside is held under, in the task's conversation. */
export const alongsideEndWaitId = (taskId: string): string => `end-${contentHash12({ task: taskId })}`;

/**
 * The record a join waiting on a task its run went on alongside is held under, in the task's conversation (`wait: { join }`):
 * its own, beside the one the run's end holds on, so a join that went on at its first part (`any`) never stands in for the end.
 */
export const joinPartWaitId = (taskId: string): string => `join-${contentHash12({ task: taskId })}`;
/** The record a join's deadline is held under: a wait's record, so it fires through the run-wait schedule every timed wait uses. */
export const joinDeadlineWaitId = (runKey: string, step: string): string => `wait-join-${contentHash12({ runKey, step })}`;
/**
 * The prefix of the record an `open` step's backstop is held under (DESIGN-PROCESSES section 10): a wait's record, so it fires through the
 * run-wait schedule, and goes on as `timed-out` where the creator never handed the run back.
 */
export const OPEN_WAIT_PREFIX = 'wait-open-';
/** The record an `open` step's backstop is held under, in the conversation whose run asked for the child. */
export const openBackstopWaitId = (runKey: string, step: string): string => `${OPEN_WAIT_PREFIX}${contentHash12({ runKey, step })}`;
/** How long an `open` step waits for the creator to hand the run back before its backstop takes the failure edge, in minutes. */
export const OPEN_HAND_BACK_MINUTES = 10;

/**
 * The record that names the process of a conversation a process's `open` step opened (SPEC-PROCESSES P15): written once, by
 * the router, as the opening run starts, from the process the canonical creator named; read when a person's request there
 * starts a workflow its version links into a process, so that run joins this one. Held in the opened conversation itself.
 */
export const CONVERSATION_PROCESS_WAIT_ID = 'process-of-conversation';

/** How the ending side's record says it ended. */
const ENDED = 'ended';

/** The conversation the run's open step opened, read from the link the creator handed back, or undefined. */
export function openedConversationOf(link: string | undefined, runChannelArn: string): string | undefined {
  const child = parentArnOf(runChannelArn, link);
  return child && child !== runChannelArn ? child : undefined;
}

/** The conversation that opened this one, read from the parent link its own row records, or undefined. */
export function parentConversationOf(parentRef: string | undefined, childArn: string): string | undefined {
  const parent = parentArnOf(childArn, parentRef);
  return parent && parent !== childArn ? parent : undefined;
}

/** Reads a conversation's server-side row for the parent it records; throws where the row could not be read. */
export type LinkRowReader = (channelArn: string) => Promise<{ parentRef?: string } | null | undefined>;

/**
 * THE CONVERSATION A RUN'S SEND IS SAID IN beyond its own: `arn` where the link holds; `refused` where the records say there
 * is none (`none-recorded`: this conversation records no opener; `opened-none`: the run opened nothing; `not-opened-from-here`:
 * the conversation named records another parent); `unreadable` where a row could not be read, which says nothing about the
 * link and is never a refusal.
 */
export type LinkedConversation =
  | { arn: string }
  | { refused: 'none-recorded' | 'opened-none' | 'not-opened-from-here' }
  | { unreadable: string };

const readFailure = (err: unknown): string => (err as Error)?.name || 'read failed';

/** The conversation that opened this one, by the parent its own row records (DESIGN-PROCESSES O24). */
export async function openerConversation(channelArn: string, readRow: LinkRowReader): Promise<LinkedConversation> {
  let row: Awaited<ReturnType<LinkRowReader>>;
  try { row = await readRow(channelArn); } catch (err) { return { unreadable: readFailure(err) }; }
  const parent = parentConversationOf(row?.parentRef, channelArn);
  return parent ? { arn: parent } : { refused: 'none-recorded' };
}

/**
 * The conversation this run's open step opened (DESIGN-PROCESSES O33), by the link it handed back, held only where that
 * conversation's own row names this one as its parent.
 */
export async function openedConversation(channelArn: string, link: string | undefined, readRow: LinkRowReader): Promise<LinkedConversation> {
  const child = openedConversationOf(link, channelArn);
  if (!child) return { refused: 'opened-none' };
  let row: Awaited<ReturnType<LinkRowReader>>;
  try { row = await readRow(child); } catch (err) { return { unreadable: readFailure(err) }; }
  return parentConversationOf(row?.parentRef, child) === channelArn ? { arn: child } : { refused: 'not-opened-from-here' };
}

/**
 * THE RUN'S SIDE: hold the run's continuation under the record. `held` when the run now waits; `came` with how the other
 * side ended where its record was there first, so the run goes on now; `failed` when neither could be established.
 */
export async function holdUntilEnded(
  records: HeldRunRecords, waitId: string, channelArn: string, continuation: Record<string, unknown>,
): Promise<{ held: true } | { came: string } | { failed: true }> {
  const out = await records.hold({ waitId, channelArn, continuation }).catch(() => ({ claimed: false, reason: 'failed' }));
  if (out.claimed) return { held: true };
  if (out.reason !== 'already_claimed') return { failed: true };
  const there = await records.read({ waitId, channelArn }).catch(() => null);
  if (!there) return { failed: true };
  // THE OTHER SIDE CAME FIRST: its ending is the record. Otherwise the record is this run's own, held by a redelivery.
  return typeof there[ENDED] === 'string' ? { came: there[ENDED] as string } : { held: true };
}

/**
 * THE ENDING SIDE: record how it ended under the record. `recorded` when no run waits yet (the run finds it when it comes);
 * `run` with the waiting run's continuation where the run was there first, which the caller continues once; `failed`
 * when neither could be established.
 */
export async function meetHeldRun(
  records: HeldRunRecords, waitId: string, channelArn: string, ending: string,
): Promise<{ recorded: true } | { run: Record<string, unknown> } | { failed: true }> {
  const out = await records.hold({ waitId, channelArn, continuation: { [ENDED]: ending } }).catch(() => ({ claimed: false, reason: 'failed' }));
  if (out.claimed) return { recorded: true };
  if (out.reason !== 'already_claimed') return { failed: true };
  const there = await records.read({ waitId, channelArn }).catch(() => null);
  if (!there) return { failed: true };
  // A REDELIVERED ENDING FINDS ITS OWN RECORD: nothing waits on it yet.
  return typeof there.runKey === 'string' && typeof there.step === 'string' ? { run: there } : { recorded: true };
}
