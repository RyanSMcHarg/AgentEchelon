/**
 * HOW AN INTENT'S ANSWER IS PRODUCED AND DELIVERED, FROM THE INTENT PACK
 * (SPEC-CONFIGURABLE-INTENT-PACK FR17-FR22, Appendix A "Answer guidance").
 *
 * The pack decides what an assistant answers: the router refuses an intent it does not declare. This
 * module makes the same pack decide HOW: each intent carries instructions, and where a result must not
 * vary, prescriptive guidance that code enforces - the answering temperature, whether the answer is
 * posted in the message or attached as a file, the sections it must carry and the shape checks it must
 * pass. Scope and delivery therefore come from the pack, not from persona prose.
 *
 * OUT OF SCOPE: queue and task workflows. The queue loop and the task state machines are already
 * deterministic platform code; on a task, the machine's `delivers` state still decides delivery.
 *
 * Optional throughout: an intent without `answer` behaves exactly as before (tenet P3, additive schema).
 */
import type { IntentDef, IntentPack } from './intent-pack.js';

export const ANSWER_FORMS = ['message', 'file', 'auto'] as const;
export type AnswerForm = (typeof ANSWER_FORMS)[number];
export const ANSWER_FILE_TYPES = ['markdown', 'code'] as const;
export type AnswerFileType = (typeof ANSWER_FILE_TYPES)[number];
export const ANSWER_CHECKS = ['code-block', 'sections', 'no-file-claim'] as const;
export type AnswerCheck = (typeof ANSWER_CHECKS)[number];

/** Bounds, so guidance stays prompt weight a turn can afford. */
export const MAX_ANSWER_SECTIONS = 12;
export const MAX_ANSWER_SECTION_LENGTH = 80;

export interface AnswerGuidance {
  /** The answering temperature for this intent, 0 to 1. Absent keeps the deployment default. */
  temperature?: number;
  /** Posted in the message, attached as a file, or chosen by `fileAbove` on the generated answer. */
  form?: AnswerForm;
  /** For `auto`: a file when the answer passes either bound, or carries more than one code block. */
  fileAbove?: { lines?: number; chars?: number };
  /** What a file is: Markdown, or code named by its fenced block's language. */
  fileType?: AnswerFileType;
  /** Headings the answer must carry, in order. */
  sections?: string[];
  /** Named checks the answer must pass before it is delivered. */
  require?: AnswerCheck[];
}

const isPositive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Read path: keep what is well formed, drop the rest (a bad field never breaks a turn). */
export function coerceAnswerGuidance(raw: unknown): AnswerGuidance | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: AnswerGuidance = {};
  if (typeof r.temperature === 'number' && r.temperature >= 0 && r.temperature <= 1) out.temperature = r.temperature;
  if ((ANSWER_FORMS as readonly unknown[]).includes(r.form)) out.form = r.form as AnswerForm;
  if (r.fileAbove && typeof r.fileAbove === 'object') {
    const f = r.fileAbove as Record<string, unknown>;
    const fileAbove = {
      ...(isPositive(f.lines) ? { lines: Math.floor(f.lines) } : {}),
      ...(isPositive(f.chars) ? { chars: Math.floor(f.chars) } : {}),
    };
    if (Object.keys(fileAbove).length) out.fileAbove = fileAbove;
  }
  if ((ANSWER_FILE_TYPES as readonly unknown[]).includes(r.fileType)) out.fileType = r.fileType as AnswerFileType;
  if (Array.isArray(r.sections)) {
    const sections = r.sections.filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim());
    if (sections.length) out.sections = sections.slice(0, MAX_ANSWER_SECTIONS);
  }
  if (Array.isArray(r.require)) {
    const require = r.require.filter((c): c is AnswerCheck => (ANSWER_CHECKS as readonly unknown[]).includes(c));
    if (require.length) out.require = [...new Set(require)];
  }
  return Object.keys(out).length ? out : undefined;
}

/** Write path: every field is checked against what the operator wrote, and a refusal names the fix. */
export function answerGuidanceErrors(raw: unknown, where: string): string[] {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [`${where}.answer must be an object`];
  const r = raw as Record<string, unknown>;
  const errs: string[] = [];
  const known = ['temperature', 'form', 'fileAbove', 'fileType', 'sections', 'require'];
  for (const k of Object.keys(r)) if (!known.includes(k)) errs.push(`${where}.answer.${k} is not a known field (${known.join(', ')})`);
  if (r.temperature !== undefined && !(typeof r.temperature === 'number' && r.temperature >= 0 && r.temperature <= 1)) {
    errs.push(`${where}.answer.temperature must be a number from 0 to 1`);
  }
  if (r.form !== undefined && !(ANSWER_FORMS as readonly unknown[]).includes(r.form)) {
    errs.push(`${where}.answer.form must be one of ${ANSWER_FORMS.join(', ')}`);
  }
  if (r.fileAbove !== undefined) {
    const f = r.fileAbove as Record<string, unknown>;
    if (!f || typeof f !== 'object' || Array.isArray(f)) errs.push(`${where}.answer.fileAbove must be an object of { lines?, chars? }`);
    else {
      for (const k of ['lines', 'chars']) if (f[k] !== undefined && !isPositive(f[k])) errs.push(`${where}.answer.fileAbove.${k} must be a positive number`);
      if (f.lines === undefined && f.chars === undefined) errs.push(`${where}.answer.fileAbove must set lines or chars`);
    }
    if (r.form !== 'auto') errs.push(`${where}.answer.fileAbove applies only to form 'auto'`);
  }
  if (r.form === 'auto' && r.fileAbove === undefined) errs.push(`${where}.answer.form 'auto' needs fileAbove to decide by`);
  if (r.fileType !== undefined && !(ANSWER_FILE_TYPES as readonly unknown[]).includes(r.fileType)) {
    errs.push(`${where}.answer.fileType must be one of ${ANSWER_FILE_TYPES.join(', ')}`);
  }
  if (r.sections !== undefined) {
    if (!Array.isArray(r.sections) || r.sections.some((s) => typeof s !== 'string' || !s.trim())) {
      errs.push(`${where}.answer.sections must be a list of non-empty headings`);
    } else {
      if (r.sections.length > MAX_ANSWER_SECTIONS) errs.push(`${where}.answer.sections has ${r.sections.length} headings, over the ${MAX_ANSWER_SECTIONS} limit`);
      if (r.sections.some((s) => (s as string).length > MAX_ANSWER_SECTION_LENGTH)) errs.push(`${where}.answer.sections has a heading over ${MAX_ANSWER_SECTION_LENGTH} characters`);
    }
  }
  if (r.require !== undefined) {
    if (!Array.isArray(r.require) || r.require.some((c) => !(ANSWER_CHECKS as readonly unknown[]).includes(c))) {
      errs.push(`${where}.answer.require must list only ${ANSWER_CHECKS.join(', ')}`);
    } else if (r.require.includes('sections') && !(Array.isArray(r.sections) && r.sections.length)) {
      errs.push(`${where}.answer.require names 'sections' but the intent declares no answer.sections`);
    }
  }
  return errs;
}

/** The intent definition a turn was classified as, in the serving pack. */
export function intentDefFor(intent: string, pack: IntentPack): IntentDef | undefined {
  return pack.intents.find((d) => d.key === intent);
}

const VERBOSITY_LINE: Record<string, string> = {
  tight: 'Keep the answer short: the fewest words that fully answer.',
  normal: '',
  long: 'Give a full, developed answer.',
};

/**
 * The per-turn prompt blocks, all from the pack: how to answer this intent (its instructions and
 * verbosity), the answer's required shape, and what this assistant offers. A turn of an intent the pack
 * declares is told it is in scope; a `general` turn is judged against the list of what is offered.
 */
export function intentAnswerPrompt(intent: string, pack: IntentPack): string {
  const def = intentDefFor(intent, pack);
  const blocks: string[] = [];
  if (def) {
    const label = def.summary?.trim() || def.description?.trim() || def.key.replace(/_/g, ' ');
    const how = [
      `This request is: ${label}. You offer this, so answer it; do not decline it as off topic.`,
      def.instructions?.trim() || '',
      def.verbosity ? VERBOSITY_LINE[def.verbosity] || '' : '',
    ].filter(Boolean);
    blocks.push(`## HOW TO ANSWER THIS REQUEST\n${how.join('\n')}`);
    const shape = answerShapeLines(def.answer);
    if (shape.length) blocks.push(`## ANSWER SHAPE\n${shape.join('\n')}`);
  }
  // OFF TOPIC, AS CLASSIFIED. The offer list below lets the model judge a `general` turn; a turn the
  // classifier already named off topic is not left to that judgment.
  if (intent === 'off_topic') {
    blocks.push('## THIS REQUEST IS OFF TOPIC\nIt is outside what you offer. Do not answer it, even in part. Say in one sentence that it is not something you help with, then name what you can help with.');
  }
  if (pack.intents.length) {
    const offered = pack.intents.map((d) => d.summary?.trim() || d.key.replace(/_/g, ' ')).join('; ');
    blocks.push(`## WHAT YOU OFFER\n${offered}.\nA request outside these and outside ordinary conversation is not what you are here for, and it is not an access problem: say so briefly and name what you can help with. Do not answer it first and then say so.`);
  }
  // THE REPLY IS THE ANSWER, NOT AN ACCOUNT OF GETTING IT. A final message once opened "Now let me combine
  // this with the retrieved context...", the model narrating its tool use into the reply a person reads.
  blocks.push(ANSWER_NOT_NARRATION);
  return `\n\n${blocks.join('\n\n')}`;
}

function answerShapeLines(g: AnswerGuidance | undefined): string[] {
  if (!g) return [];
  const lines: string[] = [];
  if (g.sections?.length) lines.push(`Use these headings, in this order: ${g.sections.join(' / ')}.`);
  if (g.require?.includes('code-block')) lines.push('Put code in fenced code blocks with the language named.');
  if (g.form === 'file') lines.push('The whole answer is delivered as an attached file.');
  if (g.form === 'message') lines.push('The answer is posted in the message; do not say a file is attached.');
  if (g.form === 'auto' && g.fileAbove) {
    const bound = [g.fileAbove.lines ? `${g.fileAbove.lines} lines` : '', g.fileAbove.chars ? `${g.fileAbove.chars} characters` : '']
      .filter(Boolean).join(' or ');
    lines.push(`An answer longer than ${bound}${g.fileType === 'code' ? ', or with more than one code file,' : ''} is attached as a file; a shorter one is posted in the message. Write it so it reads either way, and do not claim a file yourself.`);
  }
  if (g.require?.includes('no-file-claim')) lines.push('Never say you saved, attached or exported a file.');
  return lines;
}

/** Fenced code blocks in an answer, with their language tag. */
export function codeBlocksOf(text: string): Array<{ lang: string; code: string }> {
  const out: Array<{ lang: string; code: string }> = [];
  const re = /```([\w+#.-]*)[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ lang: (m[1] || '').toLowerCase(), code: m[2] });
  return out;
}

/**
 * MESSAGE OR FILE, decided by code from what was produced - so the same answer is always delivered the
 * same way. Undefined when the intent declares no form, which leaves the caller's previous rule in place.
 */
export function deliverAsFile(g: AnswerGuidance | undefined, answer: string): boolean | undefined {
  if (!g?.form) return undefined;
  if (g.form === 'message') return false;
  if (g.form === 'file') return true;
  const text = answer.trim();
  const blocks = codeBlocksOf(text);
  if (g.fileType === 'code' && blocks.length > 1) return true;
  const measured = g.fileType === 'code' && blocks.length === 1 ? blocks[0].code : text;
  const lines = measured.split('\n').length;
  if (g.fileAbove?.lines && lines > g.fileAbove.lines) return true;
  if (g.fileAbove?.chars && measured.length > g.fileAbove.chars) return true;
  return false;
}

const LANG_EXTENSION: Record<string, string> = {
  typescript: 'ts', ts: 'ts', javascript: 'js', js: 'js', python: 'py', py: 'py', java: 'java', go: 'go',
  rust: 'rs', rs: 'rs', ruby: 'rb', rb: 'rb', csharp: 'cs', cs: 'cs', 'c#': 'cs', cpp: 'cpp', 'c++': 'cpp', c: 'c',
  kotlin: 'kt', swift: 'swift', php: 'php', sql: 'sql', bash: 'sh', sh: 'sh', shell: 'sh', powershell: 'ps1',
  yaml: 'yaml', yml: 'yaml', json: 'json', html: 'html', css: 'css', scala: 'scala', r: 'r',
};

/**
 * What the attached file contains and is called. A code answer with one fenced block becomes that code,
 * named by its language (`.ts`, `.py`); anything else is the Markdown answer.
 */
export function fileForAnswer(g: AnswerGuidance | undefined, answer: string): { content: string; extension: string; contentType: string } {
  if (g?.fileType === 'code') {
    const blocks = codeBlocksOf(answer);
    if (blocks.length === 1) {
      const ext = LANG_EXTENSION[blocks[0].lang] || 'txt';
      return { content: blocks[0].code, extension: ext, contentType: 'text/plain; charset=utf-8' };
    }
  }
  return { content: answer, extension: 'md', contentType: 'text/markdown; charset=utf-8' };
}

/** A shape check that failed, in the shape the correction rounds consume. */
export interface AnswerShapeIssue { kind: string; fix: string }

/** Pattern of an answer claiming a file. Mirrors the deliverable check's `claims_a_file`. */
const FILE_CLAIM = /\b(attached|saved|exported|download(?:able)?)\b[^.\n]{0,40}\b(file|document|report|copy)\b/i;

/** The checks an intent requires, run on the generated answer before it is delivered. */
export function answerShapeIssues(g: AnswerGuidance | undefined, answer: string): AnswerShapeIssue[] {
  if (!g?.require?.length) return [];
  const issues: AnswerShapeIssue[] = [];
  if (g.require.includes('code-block') && codeBlocksOf(answer).length === 0) {
    issues.push({ kind: 'code_block', fix: 'Put the code in a fenced code block, with the language named after the opening fence.' });
  }
  if (g.require.includes('sections') && g.sections?.length) {
    const lower = answer.toLowerCase();
    let at = -1;
    const missing: string[] = [];
    for (const s of g.sections) {
      const idx = lower.indexOf(s.toLowerCase(), at + 1);
      if (idx < 0) missing.push(s); else at = idx;
    }
    if (missing.length) {
      issues.push({ kind: 'sections', fix: `Use these headings, in this order: ${g.sections.join(' / ')}. Missing or out of order: ${missing.join(', ')}.` });
    }
  }
  if (g.require.includes('no-file-claim') && FILE_CLAIM.test(answer)) {
    issues.push({ kind: 'file_claim', fix: 'Remove every sentence saying a file was saved, attached or exported; the platform handles delivery.' });
  }
  return issues;
}

/** Every turn's reply is the answer itself, never narration of the work that produced it. */
export const ANSWER_NOT_NARRATION = '## YOUR REPLY\nYour reply is the answer itself. Do not describe what you looked up, are about to do, or are combining (no "Let me check" or "Now let me combine"); begin with the answer.';
