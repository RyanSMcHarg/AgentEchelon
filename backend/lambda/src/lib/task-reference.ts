import { shippedLineText, templateLine } from './message-lines.js';
/**
 * A REPLY THAT NAMES THE WORK IT ANSWERS (ADR-035).
 *
 * Every open item in a conversation carries a short reference, `#<n>`, that a person can type on any
 * channel. A message that starts with one says which item it answers, so the router fixes that item
 * instead of ranking candidates and asking the model to pick.
 *
 * TEXT, NOT METADATA, and that is the decision. SMS and email carry nothing but text, so the same
 * words have to reach the same decision on every channel; a client may insert the reference for the
 * person, and it never carries anything the typed form lacks.
 *
 * Pure: parsing and formatting only. Who may answer an item is settled by which reads a candidate came
 * from (the sender's own assignee partition and the items they own), never by this file.
 */

/**
 * How the item a reply answers was decided, recorded on the turn's analytics row.
 *
 * `reference` the person typed `#<n>`; `id` a client named the item out of band, in the message
 * metadata; `ranked` nobody said, so the turn ranked what was open and the model chose. The three are
 * kept apart because they carry different confidence, and because only `ranked` is a guess.
 */
export type TaskResolution = 'reference' | 'id' | 'ranked';

/** A reference found at the start of a message. */
export interface ParsedTaskReference {
  taskRef: number;
  /** The message with the reference (and any leading mentions) removed. */
  rest: string;
}

/**
 * THE LARGEST REFERENCE ACCEPTED. A conversation allocates references one at a time, so six digits is
 * far past anything real, and a longer number reads as a figure rather than an item ("#20260915").
 */
const MAX_REF_DIGITS = 6;

/**
 * `#2 EMEA only`, `re #2: EMEA only`, `@Atlas #2 EMEA only`. Anchored at the start, after leading
 * `@` mentions, and the number must end at a word boundary so `#2nd` is not a reference.
 */
const REFERENCE_AT_START = new RegExp(
  String.raw`^\s*(?:@\S+\s+)*(?:re:?\s+)?#(\d{1,${MAX_REF_DIGITS}})(?![\w#])[\s:,.\-]*`,
  'i',
);

/**
 * Read a reference from the start of a message. Null when the message does not start with one.
 *
 * ONLY AT THE START. "we ranked it #1 last quarter" names no item, and reading references out of the
 * middle of a sentence would turn ordinary numbering into routing.
 */
export function parseTaskReference(text: string | undefined): ParsedTaskReference | null {
  if (!text) return null;
  const match = REFERENCE_AT_START.exec(text);
  if (!match) return null;
  const taskRef = Number(match[1]);
  if (!Number.isInteger(taskRef) || taskRef < 1) return null;
  return { taskRef, rest: text.slice(match[0].length).trim() };
}

/** The fields of a task row this module reads. */
export interface ReferenceableTask {
  taskId: string;
  taskRef?: number;
  taskType?: string;
  requestExcerpt?: string;
}

/**
 * The item a reference names, from rows the sender may answer. Null when none of them carries it.
 *
 * The rows ARE the permission. The router passes only what this sender holds or owns here, so a
 * reference to someone else's item, a closed item or another conversation's item finds nothing, and
 * the reference narrows what was already allowed rather than widening it.
 */
export function findReferencedTask<T extends ReferenceableTask>(rows: T[], taskRef: number): T | null {
  return rows.find((row) => row.taskRef === taskRef) ?? null;
}

/** The longest request excerpt shown beside a reference, in characters. */
const LABEL_MAX = 60;

/**
 * The words shown beside a reference in a reply only its sender reads.
 *
 * The request excerpt when there is one, which is the sender's own words; otherwise the task type in
 * plain words. Never used in a message the room reads: a private item's excerpt is its content.
 */
export function referenceLabel(row: ReferenceableTask): string {
  const excerpt = (row.requestExcerpt ?? '').replace(/\s+/g, ' ').trim();
  if (excerpt) return excerpt.length > LABEL_MAX ? `${excerpt.slice(0, LABEL_MAX - 3).trimEnd()}...` : excerpt;
  return (row.taskType ?? 'item').replace(/_/g, ' ');
}

/** The default reply when a reference names nothing the sender may answer. */
export const DEFAULT_TASK_REF_NOT_FOUND = shippedLineText('task-ref-not-found');

/** The default reply when the sender has no open items at all to offer instead. */
export const DEFAULT_TASK_REF_NOTHING_OPEN = shippedLineText('task-ref-nothing-open');

/**
 * Fill a not-found template. `{ref}` is the reference as typed; `{items}` is one line per open item
 * the sender may answer. A row without a reference is left out: it cannot be named, so listing it
 * would offer something the person has no way to type.
 */
export function formatReferenceNotFound(
  /** The turn's words object, carrying its stored templates (`withMessageTemplates`). */
  words: { copy?: object | null },
  taskRef: number,
  answerable: ReferenceableTask[],
): string {
  const lines = answerable
    .filter((row) => row.taskRef)
    .sort((a, b) => (a.taskRef ?? 0) - (b.taskRef ?? 0))
    .map((row) => `#${row.taskRef} ${referenceLabel(row)}`);
  const copy = words.copy;
  return lines.length
    ? templateLine('task-ref-not-found', { copy }, { values: { ref: taskRef, items: lines.join('\n') } })
    : templateLine('task-ref-nothing-open', { copy }, { values: { ref: taskRef } });
}

/** The default line when a turn advanced an item without finishing it. */
export const DEFAULT_TASK_STILL_OPEN = shippedLineText('task-still-open');

/**
 * THE LINE THAT SAYS THE WORK IS NOT FINISHED, WHEN A TURN ADVANCED IT AND DID NOT FINISH IT.
 *
 * ── WHY THE PLATFORM WRITES THIS AND NOT THE MODEL ──────────────────────────────────────────────
 *
 * Measured live: a `data_extraction` task was reported to the person as closed twice while the row
 * sat one step short of terminal. The tool had answered truthfully each time; the turn that believed
 * it had finished the work is precisely the turn that will not say otherwise, so asking the model
 * more clearly is a mitigation rather than a guarantee.
 *
 * This is the guarantee. It is decided from the TRANSITION THAT WAS WRITTEN and the machine's own
 * shape - never from the words of the reply - so it cannot be talked out of firing, and it carries no
 * opinion about what the reply said. The same rule the reference hint follows: a fact a person acts on
 * is stated by the platform, because it must be exact.
 *
 * NOT A CONTENT SCAN. Reading the reply for "closed" or "done" would be the output-shape heuristic
 * this codebase has retired twice, and it would miss every phrasing nobody thought of while firing on
 * quotes and questions. The fact is on the row.
 *
 * SILENT WHEN THE TURN DID NOT ADVANCE ANYTHING, and silent when it reached a terminal state, so an
 * ordinary conversational turn and a genuinely finished one are both untouched.
 */
export function taskStillOpenLine(args: {
  /** True when this turn wrote a transition. No advance, no line. */
  advanced: boolean;
  /** Where the item stands after the turn, in the person's words rather than the schema's. */
  state?: string;
  /** What the machine says comes next. Absent or empty leaves the line unsaid. */
  nextStates?: readonly string[];
  /** Set when the state the turn reached is terminal: the work IS finished and nothing is added. */
  terminal?: string;
  /** The turn's words object, carrying its stored templates (`withMessageTemplates`). */
  copy?: object | null;
}): string {
  if (!args.advanced || args.terminal || !args.state) return '';
  const next = (args.nextStates ?? []).filter(Boolean);
  if (next.length === 0) return '';
  const readable = (v: string) => v.replace(/_/g, ' ');
  const words = { copy: args.copy };
  const or = templateLine('task-still-open', words, { section: 'label.or' });
  return templateLine('task-still-open', words, { values: { state: readable(args.state), next: next.map(readable).join(` ${or} `) } });
}

/** The default line under a question about one of several open items. */
export const DEFAULT_TASK_REF_HINT = shippedLineText('task-ref-hint');

/**
 * THE LINE THAT TELLS A PERSON WHICH REFERENCE TO TYPE (ADR-035), or '' when none is needed.
 *
 * Added by the platform under the turn's reply, never written by the model, because a reference must
 * be exact. Only when all of these hold: the turn left its item waiting on the person (it asked them
 * something), the item has a reference, and they have more than one open item here, so a bare reply
 * could be read as answering another. With one item there is nothing to tell apart, and a line that
 * appears on every question teaches people to skim past it.
 *
 * Left out when the reply already names the reference, so it is never said twice.
 *
 * ── AND LEFT OUT ENTIRELY WHEN THE CLIENT NAMES THE ITEM ITSELF ──────────────────────────────────
 *
 * `namedByClient` is the turn arriving with the item declared in the message metadata. That client
 * has an Answer action and shows which item is being answered, so this line teaches a syntax the
 * person never has to type - and it was read, correctly, as the assistant being unable to work out
 * what its own reply was about.
 *
 * THE LINE IS NOT DELETED, because it is the only mechanism that exists on a channel carrying nothing
 * but text. It is addressed to the person who has no client to speak for them.
 */
export function taskRefHintLine(args: {
  taskRef?: number;
  awaitsPerson: boolean;
  openItemCount?: number;
  response: string;
  /** The turn's words object, carrying its stored templates (`withMessageTemplates`). */
  copy?: object | null;
  /** The turn arrived with its item already named out of band, so there is nothing to teach. */
  namedByClient?: boolean;
}): string {
  if (args.namedByClient) return '';
  if (!args.taskRef || !args.awaitsPerson || (args.openItemCount ?? 0) < 2) return '';
  if (new RegExp(`#${args.taskRef}(?!\\d)`).test(args.response ?? '')) return '';
  return templateLine('task-ref-hint', { copy: args.copy }, { values: { ref: args.taskRef } });
}
