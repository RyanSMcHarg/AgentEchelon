/**
 * IS THIS DOCUMENT THE ONE THAT WAS AGREED? Checked in the loop, before it is delivered.
 *
 * WHY THIS EXISTS AS CODE AND NOT AS A PROMPT LINE. The delivering prompt has said "do not say you
 * have saved, attached, created, uploaded or exported a file" since the first deploy of this work, and
 * the report that arrived opened: "Here's your report, Test - delivered as a downloadable markdown
 * document." An instruction the model can ignore is not a control. The e2e caught it; the runtime did
 * not, because nothing checked. So the loop writes, CHECKS, and corrects (maintainer, 2026-08-20).
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
 * WHAT DECIDES IS STRUCTURAL (tenet D11). The document arrives declared, separate from the reply
 * (`advance_task_state`'s `document`), which is what keeps the conversation out of it. The one purity
 * check that acts is whether the document opens as a document, read from its markup
 * (`opensAsADocument`). The English phrase patterns that once decided are measured only
 * (`phraseShadowKinds`): they read words a model wrote, and a deployment in another language passed
 * them in both directions.
 *
 * PURE, and deliberately: no AWS clients and no model calls, so every rule here is unit-testable
 * against real documents. The one model call this feature makes belongs to the caller.
 */
// Pure too, and load-bearing: anything from this module that reaches a POSTED message is stripped of
// control markers first. See `recordedLengthTarget` and `correctionProgressLine`.
import { stripMessageMarkers } from './message-markers.js';
import { checkAgainstTemplate, describeMissingStructure, type ParsedTemplate } from './document-template.js';

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
  // SANITIZED ON THE WAY OUT, not only on the way in. `source` is model-authored text that this
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

export type DeliverableIssueKind = 'too_short' | 'too_long' | 'chat_wrapper' | 'reader_ask' | 'claims_a_file' | 'template_structure';

/**
 * The kinds that are about the document being a DOCUMENT rather than a conversation, as opposed to its
 * agreed size. A correction for these alone is judged by whether the document's structure survived
 * (`acceptCorrection`), and a document still carrying one after the bounded correction posts inline.
 */
const PURITY_KINDS: ReadonlySet<DeliverableIssueKind> = new Set(['chat_wrapper', 'reader_ask', 'claims_a_file']);

/** Whether this issue is about the document's purity rather than its agreed size. */
export function isPurityIssue(issue: DeliverableIssue): boolean {
  return PURITY_KINDS.has(issue.kind);
}

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
 * THE ENGLISH PHRASE CHECKS, AS A MEASUREMENT ONLY (tenet D11).
 *
 * These three patterns decided whether a document was rewritten and what shipped, and they read
 * English a model wrote: a deployment in another language passed them in both directions. They are
 * kept because the rate at which a declared document still opens with a greeting, asks its reader
 * something or claims a file is worth knowing, and they are logged for that (`[shadow]` in the delivery
 * gate). Nothing is decided from them.
 */
export function phraseShadowKinds(doc: string): DeliverableIssueKind[] {
  const firstBlock = (doc.split(/\n\s*\n/)[0] || '').trim();
  const kinds: DeliverableIssueKind[] = [];
  if (CHAT_WRAPPER.test(firstBlock)) kinds.push('chat_wrapper');
  if (READER_ASK.test(doc)) kinds.push('reader_ask');
  if (CLAIMS_A_FILE.test(doc)) kinds.push('claims_a_file');
  return kinds;
}

/**
 * DOES THE DOCUMENT OPEN AS A DOCUMENT? Read from markup, never from words, so it says the same thing
 * in every language.
 *
 * A document opens with a title or with its content: a heading, a table row, a fenced block, a bold
 * title line, a setext heading, a CSV header row (a delimited line followed by a row with the same
 * number of delimiters), or structured data (`{`, `[`, `<`, front matter). A conversation opens with
 * a sentence to somebody. The opening line of the incident this guards ("Hi <name>, I have everything
 * I need...") is none of the above.
 */
export function opensAsADocument(doc: string): boolean {
  const lines = doc.split('\n').map((l) => l.trim());
  const at = lines.findIndex((l) => l.length > 0);
  if (at < 0) return false;
  const first = lines[at];
  if (/^#{1,6}\s+\S/.test(first)) return true;
  if (first.startsWith('|')) return true;
  if (/^(```|~~~)/.test(first)) return true;
  if (/^(\*\*|__)[^*_].*(\*\*|__)\s*:?$/.test(first)) return true;
  if (/^(=+|-+)$/.test(lines[at + 1] ?? '')) return true;
  if (/^[[{<]/.test(first) || first === '---') return true;
  // A CSV-SHAPED EXTRACTION. Counted by delimiter, so it is the shape of the data that answers and
  // not what the cells say: a header and the rows directly under it (no blank line between, which is
  // what separates prose paragraphs) carry the same number of separators. One separator per line is
  // also what a sentence with a comma looks like, so a single-separator shape needs two rows.
  const row1 = lines[at + 1] ?? '';
  const row2 = lines[at + 2] ?? '';
  for (const sep of [',', '\t', ';']) {
    const count = (s: string) => s.split(sep).length - 1;
    const n = count(first);
    if (n >= 1 && count(row1) === n && (n >= 2 || count(row2) === n)) return true;
  }
  return false;
}

/**
 * The structure a correction must not lose, counted from markup: table rows, headings and fenced
 * blocks. Language-neutral by construction, and what a person actually downloads the document for.
 */
export function documentStructure(doc: string): { tableRows: number; headings: number; fences: number } {
  const lines = doc.split('\n').map((l) => l.trim());
  return {
    tableRows: lines.filter((l) => l.startsWith('|') && !/^\|?[\s:|-]+\|?$/.test(l)).length,
    headings: lines.filter((l) => /^#{1,6}\s+\S/.test(l)).length,
    fences: lines.filter((l) => /^(```|~~~)/.test(l)).length,
  };
}

/**
 * Everything wrong with this document that the delivery acts on, in the order a reader would notice it.
 *
 * `target` is null when no size was recorded, which suppresses the length pair only. The opening check
 * is structural (`opensAsADocument`) and is skipped for a code deliverable (`opts.code`), which is code
 * wherever it starts. The English phrase checks are not here: they are `phraseShadowKinds`, measured
 * and never acted on.
 */
export function deliverableIssues(
  doc: string,
  target: LengthTarget | null,
  opts: { code?: boolean; template?: ParsedTemplate } = {},
): DeliverableIssue[] {
  const issues: DeliverableIssue[] = [];

  // THE TEMPLATE'S STRUCTURE, when the delivering step declares one (SPEC-DOCUMENT-TEMPLATES FR6): its
  // required sections in order by position and heading level, and its tables by column count. Never
  // the heading text, so a document in the conversation's language passes.
  if (opts.template && doc.trim()) {
    const check = checkAgainstTemplate(doc, opts.template);
    if (!check.passed) {
      issues.push({ kind: 'template_structure', fix: describeMissingStructure(check.missing, opts.template.name) });
    }
  }

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

  if (!opts.code && doc.trim() && !opensAsADocument(doc)) {
    issues.push({
      kind: 'chat_wrapper',
      fix: 'It opens with a sentence to the reader instead of the document. Start with the document: a '
        + 'title heading, then the content. Remove any greeting, any offer or question to the reader, '
        + 'and anything about files or downloads. Nobody reading the file later is in the conversation '
        + 'it came from.',
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
  if (kinds.has('template_structure')) return 'Fitting the document to its template...';
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
 * So acceptance needs a floor on CONTENT as well as a limit on faults. The floor is relative to what
 * was written, not absolute: the model wrote the document, and a correction is meant to adjust it, not
 * to replace it with something a fraction of the size.
 *
 * The exception is a document that was too long, where shrinking IS the correction - there the floor
 * is the agreed minimum instead, because that is the length the person asked for.
 *
 * AND A CORRECTION THAT ONLY REMOVES CONVERSATION IS JUDGED BY STRUCTURE, NOT BY WORDS. When every
 * issue is a purity issue (`isPurityIssue`), the fix is to take out a greeting, a narration and an
 * apology, and in a short document those can be most of the words. Measured live: a 162-word
 * extraction whose table was wrapped in a greeting and a closing offer was correctly rewritten to 82
 * words, the table intact, and the 60% floor rejected it, so the wrapped original shipped. For those
 * faults the rewrite is accepted when the document's countable structure survived (`documentStructure`:
 * table rows, headings, fenced blocks, none fewer than before). A document with no countable structure
 * keeps the word floor, because then there is nothing else to say what was lost.
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

  const was = documentStructure(original);
  const hasStructure = was.tableRows + was.headings + was.fences > 0;
  if (issuesBefore.length > 0 && issuesBefore.every(isPurityIssue) && hasStructure) {
    const now = documentStructure(rewritten);
    const lost = (['tableRows', 'headings', 'fences'] as const).filter((k) => now[k] < was[k]);
    if (lost.length) {
      return {
        accept: false,
        reason: `the rewrite lost the document's structure: ${lost.map((k) => `${k} ${was[k]} -> ${now[k]}`).join(', ')}`,
      };
    }
    return {
      accept: true,
      reason: `structure kept (${was.tableRows} table rows, ${was.headings} headings, ${was.fences} fences), `
        + `${before} -> ${after} words, ${issuesBefore.length} -> ${issuesAfter.length} issues`,
    };
  }

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

/**
 * WHAT A DECLARED DOCUMENT THAT STILL FAILS AFTER THE BOUNDED CORRECTION COMES TO (SPEC-TASK-STATE-
 * TRANSITIONS §4; SPEC-DOCUMENT-TEMPLATES FR6). One decision, read by the delivery gate, so the rule is
 * testable on its own:
 *  - `template_structure`: it still does not follow its template, so it is NOT attached. A file of this
 *    kind is one readers scan for its sections; posted inline, it is read in the conversation, and the
 *    next turn can produce the file in the declared shape.
 *  - `purity`: it still reads as conversation, so it is NOT attached either.
 *  - `mismatch`: only its agreed length is off, so the best version is attached and the shortfall logged.
 *  - null: nothing is left to fix.
 * Only a DECLARED document (`replyBesideFile`) is withheld: where the reply itself is the file there is no
 * separate reply to post it beside.
 */
export function stillFailingPackaging(
  issues: DeliverableIssue[],
  replyBesideFile: boolean,
): 'template_structure' | 'purity' | 'mismatch' | null {
  if (replyBesideFile && issues.some((i) => i.kind === 'template_structure')) return 'template_structure';
  if (replyBesideFile && issues.some(isPurityIssue)) return 'purity';
  return issues.length > 0 ? 'mismatch' : null;
}

/** The template check's recorded outcome (SPEC-DOCUMENT-TEMPLATES FR8), decided once the packaging is. */
export function templateCheckOutcome(args: {
  filled: boolean;
  attached: boolean;
  corrected: boolean;
}): 'filled_by_platform' | 'posted_inline' | 'passed_after_correction' | 'passed' {
  if (args.filled) return 'filled_by_platform';
  if (!args.attached) return 'posted_inline';
  return args.corrected ? 'passed_after_correction' : 'passed';
}

/** A declared document that is not packaged posts inline AFTER the reply, so neither text is lost. */
export function postInline(reply: string, documentText: string): string {
  return reply.trim() ? `${reply.trim()}\n\n${documentText}` : documentText;
}
