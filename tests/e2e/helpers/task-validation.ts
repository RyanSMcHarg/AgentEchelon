/**
 * Shared task/attachment hardening assertions (live-e2e).
 *
 * Two invariants every task-producing / file-delivering e2e must enforce, factored here so a
 * single ask can never silently regress into (a) duplicate work or (b) a bogus deliverable:
 *
 *  1. NO DUPLICATE TASKS — a single user ask must open exactly ONE task in its conversation.
 *     The live bug was getActiveTask reading an eventually-consistent GSI, so a second turn
 *     raced ahead of the first task's write and opened a duplicate (2x the model cost). See
 *     assertNoDuplicateTasks (analytics-side) and the source-of-truth variant in
 *     task-state-machine.spec.ts (agent-tasks/user-tasks rows).
 *
 *  2. VALID ATTACHMENT — when the assistant delivers a file, it must be a real, substantial,
 *     on-topic document, NOT a conversational/clarifying turn wrongly serialized to a file (a
 *     bug that once shipped a chat response as an attachment and passed review). openAnd
 *     ValidateAttachment downloads the presigned bytes and asserts the CONTENT, not just that a
 *     file row exists.
 */
import { expect, request as pwRequest, type Page, type Locator } from '@playwright/test';

/** A task row as surfaced by the analytics `task_details` query (loosely typed across tiers). */
type TaskRow = Record<string, unknown>;

/**
 * Assert that, among `tasks`, no conversation opened more than one task of `type` during this
 * test window (started_at >= `since`). Scoped by conversation `channel_arn` because the chat SPA
 * does not expose the conversation's channel_arn to the test — the analytics row does.
 *
 * @returns the count of THIS-test tasks it checked (>=1 asserted by the caller when a task is expected).
 */
export function assertNoDuplicateTasks(
  tasks: TaskRow[],
  opts: { type: string; since: number; label?: string },
): number {
  const { type, since, label = '' } = opts;
  const mine = tasks.filter(
    (t) => t.type === type && t.started_at && new Date(String(t.started_at)).getTime() >= since,
  );
  const perChannel = new Map<string, number>();
  for (const t of mine) {
    const ch = String(t.channel_arn);
    perChannel.set(ch, (perChannel.get(ch) || 0) + 1);
  }
  for (const [ch, n] of perChannel) {
    expect(
      n,
      `${label} conversation ${ch} must have exactly ONE ${type} task (no duplicate tasks per ask), found ${n}`,
    ).toBe(1);
  }
  return mine.length;
}

export interface AttachmentValidation {
  /** Allowed file extensions for the delivered document, e.g. /\.(md|markdown|txt|pdf)$/i */
  namePattern: RegExp;
  /** Minimum content length — guards empty/near-empty deliverables. */
  minLength: number;
  /** Patterns the content MUST match (structure + on-topic), each with a human message. */
  mustMatch: Array<{ re: RegExp; because: string; lower?: boolean }>;
  /**
   * Extra "this is NOT a chat turn" phrases to reject beyond the shared clarifying-question set,
   * e.g. task-type-specific conversational tells.
   */
  mustNotMatch?: Array<{ re: RegExp; because: string; lower?: boolean }>;
  label?: string;
}

// Conversational tells that mean a clarifying/chat turn got saved as a file instead of a real
// document (the reported bug). Shared across every attachment-producing test.
//
// THE ORIGINAL SET WAS TOO LITERAL AND A REAL DEFECT WALKED THROUGH IT. It listed the phrasings from
// one incident, so a document that ASKED THE READER FOR APPROVAL in any other words - an outline with
// a table, ending "does this structure work?" - satisfied every check: markdown structure, on-topic
// words, substantial length, no listed phrase. The file was a proposal about the report, delivered as
// the report, and the suite called it a valid document.
//
// So the rule is now about the ACT, not the wording: a finished deliverable does not ask its reader to
// decide anything, and does not describe what it is going to contain. Both patterns below are matched
// against the lowercased content.
const CLARIFYING_TELLS =
  /a few quick questions|what should the report focus on|let me know your preferences|before i (start|begin|proceed)|could you clarify|to make sure i|happy to help/;

/**
 * A question, or an offer, aimed at the READER. A report states; it does not negotiate.
 *
 * Deliberately narrow so ordinary report prose survives: a rhetorical question inside a sentence
 * ("which repository model scales?") has no second person in it, and section prose that mentions "you"
 * without a question mark is untouched.
 */
const READER_DIRECTED_ASK =
  /\b(would|do|does|should|shall|can|could|are)\s+you\b[^.?!]{0,160}\?|\blet me know\b|\bif you'?d like\b|\bshall i\b|\bwant me to\b|\bwould you like\b|\bsound good\b|\bhow does (this|that) (look|sound)\b/;

/**
 * The document is describing itself instead of being itself: an OUTLINE or a plan-to-write, saved as
 * the deliverable. This is the exact shape of the incident that demoted the output-shape heuristic.
 */
const OUTLINE_TELLS =
  /\bproposed outline\b|\bhere'?s? (a|the) (proposed )?outline\b|\boutline for (the|your) report\b|\bi'?ll (then )?(write|generate|draft|produce)\b|\bthe report will (cover|include|contain)\b|\bonce you (approve|confirm)\b/;

/**
 * Download the delivered attachment via its presigned URL and validate the CONTENT is a real
 * document. Opens the download popup (handleDownload → window.open the presigned S3 URL), fetches
 * the bytes, and asserts: presigned URL + fetch OK, allowed file type, substantial length, all
 * `mustMatch` patterns, none of the shared clarifying tells (nor caller `mustNotMatch`), and valid
 * UTF-8 (no replacement char). Returns the fetched content for any caller-specific extra checks.
 */
export async function openAndValidateAttachment(
  page: Page,
  attachment: Locator,
  v: AttachmentValidation,
): Promise<string> {
  const label = v.label ? `${v.label} ` : '';

  const name = ((await attachment.locator('.attachment-name').textContent()) || '').trim();
  expect(name, `${label}attachment name: "${name}"`).toMatch(v.namePattern);

  const [popup] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 30_000 }),
    attachment.locator('.attachment-file, .attachment-download-btn').first().click(),
  ]);
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  const fileUrl = popup.url();
  await popup.close();
  expect(fileUrl, `${label}the download must open the presigned file URL`).toMatch(/^https?:\/\//);

  const fileApi = await pwRequest.newContext();
  try {
    const fileResp = await fileApi.get(fileUrl);
    expect(fileResp.ok(), `${label}presigned download must succeed (got ${fileResp.status()})`).toBeTruthy();
    const content = await fileResp.text();

    expect(content.length, `${label}the document must be substantial (not empty/near-empty)`).toBeGreaterThan(
      v.minLength,
    );
    for (const m of v.mustMatch) {
      expect(m.lower ? content.toLowerCase() : content, `${label}${m.because}`).toMatch(m.re);
    }
    expect(
      content.toLowerCase(),
      `${label}the document must not be a clarifying/chat turn saved as a file`,
    ).not.toMatch(CLARIFYING_TELLS);
    expect(
      content.toLowerCase(),
      `${label}a finished deliverable does not ask its reader to decide anything. This document puts a `
        + 'question or an offer to the reader, which is what a clarifying turn saved as a file looks '
        + 'like - and a table plus on-topic words is not enough to tell the two apart',
    ).not.toMatch(READER_DIRECTED_ASK);
    expect(
      content.toLowerCase(),
      `${label}the document describes what it WILL contain instead of containing it - an outline or a `
        + 'plan-to-write delivered as the deliverable',
    ).not.toMatch(OUTLINE_TELLS);
    for (const m of v.mustNotMatch || []) {
      expect(m.lower ? content.toLowerCase() : content, `${label}${m.because}`).not.toMatch(m.re);
    }
    expect(content, `${label}the document text must be valid UTF-8 (no replacement/garbage chars)`).not.toContain(
      '�',
    );
    return content;
  } finally {
    await fileApi.dispose();
  }
}
