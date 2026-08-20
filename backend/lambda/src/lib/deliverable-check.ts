/**
 * IS THIS DOCUMENT THE ONE THAT WAS AGREED? Checked in the loop, before it is delivered.
 *
 * WHY THIS EXISTS AS CODE AND NOT AS A PROMPT LINE. The delivering prompt has said "do not say you
 * have saved, attached, created, uploaded or exported a file" since the first deploy of this work, and
 * the report that arrived opened: "Here's your report, Test - delivered as a downloadable markdown
 * document." An instruction the model can ignore is not a control. The e2e caught it; the runtime did
 * not, because nothing checked. So the loop writes, CHECKS, and corrects (owner, 2026-08-20).
 *
 * WHAT IT CHECKS AGAINST, and why the source matters. Length is a REQUIREMENT the step declares
 * (`report_generation.collecting_requirements` lists "the length or format") and the person answers.
 * The answer is recorded on the task when the step advances, so this compares the document against a
 * value that was agreed once - not against a number chosen by a developer, and not against prose
 * re-parsed out of the transcript on every read. If nothing was recorded, there is nothing to enforce
 * and the length check simply does not apply: an absent agreement is not a violation.
 *
 * THE PURITY CHECKS NEED NO AGREEMENT. A delivered document is read later, by someone who is not in
 * the conversation it came from. A greeting addressed to a name at a moment that has passed, an offer
 * they cannot answer from a file, and a claim about a download that the runtime - not the model -
 * decides, are all wrong regardless of what was asked for.
 *
 * PURE, and deliberately: no AWS clients and no model calls, so every rule here is unit-testable
 * against real documents. The one model call this feature makes belongs to the caller.
 */
// Pure too, and load-bearing: anything from this module that reaches a POSTED message is stripped of
// control markers first. See `recordedLengthTarget` and `correctionProgressLine`.
import { stripMessageMarkers } from './message-markers.js';

/**
 * The size the person agreed to, as the numbers it was recorded as.
 *
 * NOT PARSED HERE, AND THAT IS THE POINT. The first version regexed the recorded value - "1-2 pages",
 * "roughly 600-900 words" - into a range at read time, which put the runtime back to guessing at
 * English one layer below where the agreement had just been moved out of prose. A person says "a page
 * or two" or "keep it short"; turning that into a number is language work, and the model doing the
 * turn is the only component that saw the sentence in context. It resolves the range ONCE, when the
 * requirement is recorded (`collected[].minWords/maxWords`, task-tools), and every reader here gets
 * numbers.
 */
export interface LengthTarget {
  minWords: number;
  maxWords: number;
  /** What the person actually said, carried for the correction instruction and the logs. */
  source: string;
}

/**
 * The agreed size off the task's recorded details, or null when none was agreed.
 *
 * Validated rather than trusted: `details` is JSON that a model's tool call produced and DynamoDB
 * returned, so a bound that is missing, non-numeric, non-positive or reversed is treated as no
 * agreement at all. Half an agreement cannot say what satisfies the person, and a guessed one is
 * worse than none.
 */
export function recordedLengthTarget(details: unknown): LengthTarget | null {
  const t = (details as { lengthTarget?: unknown } | undefined)?.lengthTarget as
    { minWords?: unknown; maxWords?: unknown; source?: unknown } | undefined;
  if (!t || typeof t !== 'object') return null;
  const { minWords, maxWords, source } = t;
  if (typeof minWords !== 'number' || typeof maxWords !== 'number') return null;
  if (!Number.isFinite(minWords) || !Number.isFinite(maxWords)) return null;
  if (minWords <= 0 || maxWords < minWords) return null;
  const min = Math.round(minWords);
  const max = Math.round(maxWords);
  // SANITISED ON THE WAY OUT, not only on the way in. `source` is model-authored text that this
  // module hands to a string which is POSTED INTO THE CHANNEL, and the write-side bound cannot protect
  // this read: rows already exist that were written before that bound, by a hand edit, or by an
  // imported fixture. A control marker reaching a bot message is not cosmetic - the chat client parses
  // markers out of bot content, and a `NAVIGATE_CHANNEL:` marker on a message UPDATE makes every
  // watching client navigate with no user gesture (`ConversationProvider.chime.tsx`). Stripped AND
  // bounded here, so no writer can re-open the sink.
  const cleaned = typeof source === 'string' ? stripMessageMarkers(source).trim().slice(0, 60) : '';
  return {
    minWords: min,
    maxWords: max,
    // The ROUNDED values, because this string is shown to the person. A row written by anything other
    // than `collectedRequirements` - a hand edit, a future writer, an imported fixture - can carry
    // fractional bounds, and the raw ones surfaced as "Trimming the report to 299.6-900.4 words...".
    source: cleaned || `${min}-${max} words`,
  };
}

/** Words in the document, ignoring markdown table pipes and heading marks. */
export function documentWordCount(doc: string): number {
  return doc
    .replace(/\|/g, ' ')
    .replace(/^#{1,6}\s/gm, '')
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w)).length;
}

export type DeliverableIssueKind = 'too_short' | 'too_long' | 'chat_wrapper' | 'reader_ask' | 'claims_a_file';

export interface DeliverableIssue {
  kind: DeliverableIssueKind;
  /** What to tell the model, in the imperative. Read by `correctionInstruction`. */
  fix: string;
}

/** A greeting, or an announcement of the document, at the top of the document itself. */
const CHAT_WRAPPER =
  /^\s*(?:hi|hello|hey|thanks|thank you|got it|sure|certainly|absolutely|understood)\b|^\s*here(?:'s| is)\s+(?:your|the)\s+(?:report|table|summary|document|extraction|analysis)\b/i;

/** A question or offer put to the reader. Narrow: a rhetorical question with no second person survives. */
const READER_ASK =
  /\b(?:would|do|does|should|shall|can|could|are)\s+you\b[^.?!]{0,160}\?|\blet me know\b|\bif you'?d like\b|\bshall i\b|\bwant me to\b|\bwould you like\b|\bsound good\b/i;

/** The model claiming a packaging decision that is the runtime's to make. */
const CLAIMS_A_FILE =
  /\b(?:downloadable|attached (?:above|below|document|file|here)|i(?:'ve| have) (?:attached|uploaded|saved|exported)|download (?:it|the file|below))\b/i;

/**
 * Everything wrong with this document, in the order a reader would notice it.
 *
 * `target` is null when no size was recorded, which suppresses the length pair only - the purity
 * checks always apply.
 */
export function deliverableIssues(doc: string, target: LengthTarget | null): DeliverableIssue[] {
  const issues: DeliverableIssue[] = [];
  const firstBlock = (doc.split(/\n\s*\n/)[0] || '').trim();

  if (target) {
    const words = documentWordCount(doc);
    if (words < target.minWords) {
      issues.push({
        kind: 'too_short',
        fix: `It is ${words} words. The agreed length is "${target.source}" (about ${target.minWords}`
          + `-${target.maxWords} words). Expand it to that length by developing the analysis that is `
          + 'already there - more depth per section, not more sections, and no filler.',
      });
    } else if (words > target.maxWords) {
      issues.push({
        kind: 'too_long',
        fix: `It is ${words} words. The agreed length is "${target.source}" (about ${target.minWords}`
          + `-${target.maxWords} words). Tighten it to that length, keeping every section but cutting `
          + 'repetition and preamble.',
      });
    }
  }

  if (CHAT_WRAPPER.test(firstBlock)) {
    issues.push({
      kind: 'chat_wrapper',
      fix: 'It opens with a greeting or an announcement of itself. Start with the document: a title, '
        + 'then the content. Nobody reading the file later is in the conversation it came from.',
    });
  }
  if (READER_ASK.test(doc)) {
    issues.push({
      kind: 'reader_ask',
      fix: 'It puts a question or an offer to the reader. A finished document states; it does not ask '
        + 'the reader to decide. Remove the question - anything you want to offer belongs in the '
        + 'conversation, not in the file.',
    });
  }
  if (CLAIMS_A_FILE.test(doc)) {
    issues.push({
      kind: 'claims_a_file',
      fix: 'It refers to itself as attached or downloadable. Whether this arrives as a file or as text '
        + 'is decided after you answer, so the document cannot describe its own packaging.',
    });
  }
  return issues;
}

/**
 * The instruction for the corrective turn.
 *
 * Rewrite-in-place, deliberately: the model is given the document it just wrote and asked to return
 * the corrected document and nothing else. Asking it to "revise" invites a conversational reply about
 * the revision, which is the very thing half these issues are about.
 */
/**
 * WHAT THE PERSON SEES WHILE THE LOOP IS FIXING IT.
 *
 * A correction pass takes a model call, and a placeholder that sits unchanged through it looks like a
 * turn that stalled. Naming the work is also the honest thing: the assistant said it would produce a
 * report of an agreed length, and this says it is doing that, rather than going quiet and delivering
 * something different from what was agreed.
 *
 * Says WHAT is being fixed, never how many passes are left: the round count is an implementation
 * detail and a person reading "pass 2 of 3" learns nothing they can act on.
 */
export function correctionProgressLine(issues: DeliverableIssue[], target: LengthTarget | null): string {
  const kinds = new Set(issues.map((i) => i.kind));
  // STRIPPED AT THE POINT OF USE as well as at the read, because this string is posted into the
  // channel and a caller may hand us a target it built itself. Two cheap strips beat one that a later
  // call site forgets: the same belt-and-braces the prompt builder applies to model-supplied titles.
  const size = target ? (stripMessageMarkers(target.source).trim() || 'the agreed length') : '';
  if (kinds.has('too_long')) {
    return target ? `Trimming the report to ${size}...` : 'Trimming the report to the agreed length...';
  }
  if (kinds.has('too_short')) {
    return target ? `Expanding the report to ${size}...` : 'Expanding the report to the agreed length...';
  }
  return 'Tidying the document before delivering it...';
}

/**
 * IS THE REWRITE ACTUALLY BETTER, or merely emptier?
 *
 * "Fewer faults than before" was the first rule and it is not safe, which a live run proved within
 * minutes: the corrective call was itself refused by the guardrail, so the "rewrite" came back as the
 * 60-character refusal copy - a document with no greeting, no question and no file claim, and
 * therefore ZERO issues. It won on a count and the person received it as their report. Deleting the
 * document is not a way of fixing it.
 *
 * So acceptance needs a floor on CONTENT as well as a ceiling on faults. The floor is relative to what
 * was written, not absolute: the model wrote the document, and a correction is meant to adjust it, not
 * to replace it with something a fraction of the size.
 *
 * The exception is a document that was too long, where shrinking IS the correction - there the floor
 * is the agreed minimum instead, because that is the length the person asked for.
 */
export function acceptCorrection(args: {
  original: string;
  rewritten: string;
  issuesBefore: DeliverableIssue[];
  issuesAfter: DeliverableIssue[];
  target: LengthTarget | null;
  /** The corrective call was refused by the guardrail; its output is copy, not a document. */
  blocked?: boolean;
}): { accept: boolean; reason: string } {
  const { original, rewritten, issuesBefore, issuesAfter, target, blocked } = args;

  if (blocked) return { accept: false, reason: 'the corrective turn was guardrail-blocked' };
  if (!rewritten.trim()) return { accept: false, reason: 'the rewrite came back empty' };
  if (issuesAfter.length >= issuesBefore.length) {
    return { accept: false, reason: 'the rewrite fixed nothing' };
  }

  const before = documentWordCount(original);
  const after = documentWordCount(rewritten);
  const wasTooLong = issuesBefore.some((i) => i.kind === 'too_long');
  const floor = wasTooLong
    ? (target?.minWords ?? Math.round(before * 0.3))
    : Math.round(before * 0.6);

  if (after < floor) {
    return {
      accept: false,
      reason: `the rewrite lost the document: ${after} words against ${before} before `
        + `(floor ${floor}${wasTooLong ? ', the agreed minimum' : ', 60% of the original'})`,
    };
  }
  return { accept: true, reason: `${before} -> ${after} words, ${issuesBefore.length} -> ${issuesAfter.length} issues` };
}

export function correctionInstruction(issues: DeliverableIssue[], doc: string): string {
  const numbered = issues.map((i, n) => `${n + 1}. ${i.fix}`).join('\n');
  return `The document below is going to be delivered to the person who asked for it, and it does not `
    + `yet meet what was agreed.\n\n${numbered}\n\nRewrite it so that every point above is addressed. `
    + 'Return ONLY the corrected document - no preamble, no explanation of what you changed, no '
    + 'closing remark. Keep everything that is already right: the structure, the findings, the data '
    + 'and the wording that is not at fault.\n\n---\n\n' + doc;
}
