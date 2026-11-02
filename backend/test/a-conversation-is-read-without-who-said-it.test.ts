/**
 * A CONVERSATION IS READ WITHOUT WHO SAID IT (SPEC-ADMIN-CONSOLE FR54, DESIGN-ADMIN-CONSOLE 5.3).
 *
 * The rules of the de-identified copy, on the pure transform: every person a pseudonym stable within the
 * conversation, a participant's own name in what was said replaced by theirs, personal data described
 * rather than shown, a removed message kept in place with no text and never sent to the detector, an
 * edited message keeping both versions, and membership changes in the same timeline.
 */
import { deIdentify, inGroups, SEGMENT, type SourceRow } from '../lambda/src/lib/de-identify';
import { describePlaceholders, DEIDENTIFY_PII_TYPES, PLACEHOLDER_DESCRIPTION } from '../lib/config/deidentify-guardrail';

const APP = 'arn:aws:chime:us-east-1:1:app-instance/app';
const ALICE = `${APP}/user/alice-sub`;
const BOB = `${APP}/user/bob-sub`;
const BOT = `${APP}/bot/hr-standard`;
const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 10, m)).toISOString();

const msg = (over: Partial<SourceRow>): SourceRow => ({
  kind: 'message', messageId: `m${Math.random()}`, at: at(0), actorArn: ALICE, actorName: null, agentType: null,
  content: null, updatedContent: null, removed: null, action: null, subjectArn: null, subjectName: null, ...over,
});
const member = (over: Partial<SourceRow>): SourceRow => ({ ...msg({}), kind: 'membership', messageId: null, ...over });

/** A stand-in detector: masks an email the way the guardrail does, and records what it was shown. */
function detector() {
  const seen: string[] = [];
  const anonymize = async (texts: string[]) => {
    seen.push(...texts);
    return texts.map((t) => describePlaceholders(t.replace(/[\w.]+@[\w.]+/g, '{EMAIL}')));
  };
  return { seen, anonymize };
}

describe('the de-identified copy of a conversation', () => {
  it('names people by pseudonym in order of first appearance, and assistants by name', async () => {
    const d = detector();
    const rows = await deIdentify([
      msg({ at: at(1), actorArn: ALICE, actorName: 'Alice Smith', content: 'hello' }),
      msg({ at: at(2), actorArn: BOT, actorName: 'HR Assistant', agentType: 'hr', content: 'hi' }),
      msg({ at: at(3), actorArn: BOB, actorName: 'bob@example.com', content: 'me too' }),
      msg({ at: at(4), actorArn: ALICE, content: 'again' }),
    ], d.anonymize);
    expect(rows.map((r) => [r.actor, r.actorKind])).toEqual([
      ['Person 1', 'person'], ['hr', 'assistant'], ['Person 2', 'person'], ['Person 1', 'person'],
    ]);
  });

  it('replaces a participant\'s own name in what was said with their bracketed pseudonym, before the detector sees it', async () => {
    const d = detector();
    const rows = await deIdentify([
      msg({ at: at(1), actorArn: ALICE, actorName: 'Alice Smith', content: 'hi' }),
      msg({ at: at(2), actorArn: BOB, content: 'thanks alice smith, mail me at bob@corp.com' }),
    ], d.anonymize);
    expect(rows[1].text).toBe('thanks [Person 1], mail me at [an email address removed]');
    expect(d.seen.join(' ')).not.toMatch(/alice smith/i);
  });

  it('keeps a removed message in place with no text, and never shows its text to the detector', async () => {
    const d = detector();
    const rows = await deIdentify([
      msg({ at: at(1), content: 'my card is 4111 1111 1111 1111', removed: 'redacted' }),
      msg({ at: at(2), actorArn: BOT, agentType: 'hr', content: 'I cannot take card numbers' }),
    ], d.anonymize);
    expect(rows[0]).toMatchObject({ state: 'redacted', text: null, actor: 'Person 1' });
    // The answer still has the question it answered.
    expect(rows[1]).toMatchObject({ state: 'present', text: 'I cannot take card numbers' });
    expect(d.seen.join(' ')).not.toContain('4111');
  });

  it('keeps both versions of a person\'s edited message, and not an assistant\'s finalized reply', async () => {
    const d = detector();
    const rows = await deIdentify([
      msg({ at: at(1), content: 'when is payday', updatedContent: 'when is the next payday' }),
      msg({ at: at(2), actorArn: BOT, agentType: 'hr', content: 'Thinking...', updatedContent: 'The 28th.' }),
    ], d.anonymize);
    expect(rows[0]).toMatchObject({ text: 'when is the next payday', originalText: 'when is payday' });
    expect(rows[1]).toMatchObject({ text: 'The 28th.', originalText: null });
  });

  it('puts membership changes in the same timeline, with pseudonyms for who acted and who changed', async () => {
    const d = detector();
    const rows = await deIdentify([
      member({ at: at(0), actorArn: ALICE, action: 'joined', subjectArn: BOT, subjectName: 'HR Assistant' }),
      msg({ at: at(1), content: 'question' }),
      member({ at: at(2), actorArn: ALICE, action: 'joined', subjectArn: BOB, subjectName: 'Bob Jones' }),
    ], d.anonymize);
    expect(rows.map((r) => [r.kind, r.actor, r.action, r.subject])).toEqual([
      ['membership', 'Person 1', 'joined', 'HR Assistant'],
      ['message', 'Person 1', null, null],
      ['membership', 'Person 1', 'joined', 'Person 2'],
    ]);
  });

  it('refuses a detector that loses a text, rather than shifting one message onto another', async () => {
    await expect(deIdentify([msg({ content: 'a' }), msg({ content: 'b', at: at(1) })], async (t) => t.slice(1))).rejects.toThrow(/returned 1 texts for 2/);
  });
});

describe('placeholders say what was removed', () => {
  it('describes every entity type the guardrail produces', () => {
    for (const type of DEIDENTIFY_PII_TYPES) expect(PLACEHOLDER_DESCRIPTION[type]).toMatch(/^an? /);
    expect(describePlaceholders('call {PHONE} or write {EMAIL}')).toBe('call [a phone number removed] or write [an email address removed]');
  });

  it('leaves braces somebody actually wrote', () => {
    expect(describePlaceholders('use {placeholder} and {NOT_A_TYPE}')).toBe('use {placeholder} and {NOT_A_TYPE}');
  });
});

describe('grouping texts into detector calls', () => {
  it('sends several texts in one call and splits the answer back in order', async () => {
    const calls: string[] = [];
    const out = await inGroups(['a', 'b', 'c'], 1000, async (t) => { calls.push(t); return t.toUpperCase(); });
    expect(out).toEqual(['A', 'B', 'C']);
    expect(calls).toHaveLength(1);
  });

  it('starts a new call when the budget would be exceeded', async () => {
    const calls: string[] = [];
    await inGroups(['x'.repeat(40), 'y'.repeat(40)], 60, async (t) => { calls.push(t); return t; });
    expect(calls).toHaveLength(2);
  });

  it('falls back to one text per call when the detector alters a separator', async () => {
    const out = await inGroups(['a', 'b'], 1000, async (t) => (t.includes(SEGMENT) ? t.replace(SEGMENT, ' ') : t.toUpperCase()));
    expect(out).toEqual(['A', 'B']);
  });
});

describe('identifiers in what was said', () => {
  it('replaces a user ARN by rule: a participant\'s with their pseudonym, anyone else\'s described', async () => {
    const d = detector();
    const STRANGER = `${APP}/user/0a1b2c3d-0000-4000-8000-00000000abcd`;
    const rows = await deIdentify([
      msg({ at: at(1), actorArn: ALICE, content: 'hi' }),
      msg({ at: at(2), actorArn: BOT, agentType: 'admin', content: `Member: ${ALICE} and ${STRANGER}-admin, channel ${APP}/channel/c1` }),
    ], d.anonymize);
    expect(rows[1].text).toBe(`Member: [Person 1] and [a user id removed], channel ${APP}/channel/c1`);
    // The detector never sees the id, so it cannot half-mask it.
    expect(d.seen.join(' ')).not.toContain('0a1b2c3d');
  });
});

describe('naming an assistant', () => {
  it('names one assistant the same in every row, though only some rows record which assistant it is', async () => {
    const d = detector();
    const rows = await deIdentify([
      member({ at: at(0), actorArn: ALICE, action: 'joined', subjectArn: BOT, subjectName: 'HR Assistant' }),
      msg({ at: at(1), actorArn: BOT, actorName: 'HR Assistant', agentType: null, content: 'Welcome!' }),
      msg({ at: at(2), actorArn: BOT, actorName: 'HR Assistant', agentType: 'hr', content: 'The 28th.' }),
    ], d.anonymize);
    expect(rows.map((r) => r.subject ?? r.actor)).toEqual(['hr', 'hr', 'hr']);
  });
});
