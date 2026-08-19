/**
 * A blocked turn is not an answer, and that has to be assertable.
 *
 * Found live: one side of a duel was blocked by the INPUT guardrail before its model was called. It
 * still posted an ATTRIBUTED reply - the guardrail's block text - so the duel was shaped exactly like
 * a healthy one: two replies, both archived, a scorecard offered, a countable human pick. Every
 * assertion the battle e2e made was satisfied by a dead side, and the experiment recorded a loss
 * against a model that never ran.
 *
 * The cause is fixed (ADR-027 part 4). This pins the two things that keep a recurrence loud:
 * the predicate that recognises a block reply, and the fact that the e2e's copy of the pattern still
 * matches the message the backend actually posts.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  GUARDRAIL_BLOCK_FALLBACK,
  isGuardrailBlockReply,
} from '../../lambda/src/lib/async-processor-core';

const BATTLE_SPEC = path.resolve(__dirname, '..', '..', '..', 'tests', 'e2e', 'battle.spec.ts');

describe('isGuardrailBlockReply', () => {
  it('recognises the exact reply a blocked side posts', () => {
    expect(isGuardrailBlockReply(GUARDRAIL_BLOCK_FALLBACK)).toBe(true);
  });

  it('recognises it after the transport trims or truncates it', () => {
    // What was actually observed live was a truncated render: "I cannot process that request. Please re…"
    expect(isGuardrailBlockReply('  I cannot process that request. Please re')).toBe(true);
  });

  it('does NOT fire on an answer that happens to discuss processing', () => {
    // A keyword search would have failed here, which is why this is a prefix test.
    expect(isGuardrailBlockReply(
      'Spaces - and specifically 4 of them. Some build systems cannot process tabs consistently.',
    )).toBe(false);
  });

  it('does not fire on an empty reply (that is a different defect, and it has its own guard)', () => {
    expect(isGuardrailBlockReply('')).toBe(false);
    expect(isGuardrailBlockReply('   ')).toBe(false);
  });
});

describe('the e2e guard still matches what the backend posts', () => {
  it('battle.spec.ts holds a pattern, and the real block message matches it', () => {
    // The e2e runs against a deployment and cannot import Lambda source, so it carries its own copy.
    // Duplication is deliberate; this is what stops the copy drifting into a guard that never fires.
    const src = fs.readFileSync(BATTLE_SPEC, 'utf8');
    const m = src.match(/const GUARDRAIL_BLOCK_PATTERN = (\/.+\/[a-z]*);/);
    if (!m) throw new Error('GUARDRAIL_BLOCK_PATTERN not found in tests/e2e/battle.spec.ts');
    const body = m[1].slice(1, m[1].lastIndexOf('/'));
    const flags = m[1].slice(m[1].lastIndexOf('/') + 1);
    const pattern = new RegExp(body, flags);
    expect(pattern.test(GUARDRAIL_BLOCK_FALLBACK)).toBe(true);
  });
});

describe('the block is a STRUCTURAL fact, not a text shape', () => {
  // The prefix test above guards only the default deployment: `applyInputGuardrail` returns the
  // guardrail's own masked copy when one is configured (`masked || GUARDRAIL_BLOCK_FALLBACK`), and
  // custom blockedInputMessaging - the normal enterprise case - never matches the English prefix.
  // The structural fact therefore rides the invoke result and lands in the analytics metadata, so
  // no consumer has to recognise deployment-specific copy by shape.
  const read = (rel: string) =>
    fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', rel), 'utf8');

  it('the blocked early-return declares itself on the result', () => {
    expect(read('lib/async-processor-core.ts')).toMatch(/steps, inputGuardBlocked: true \};/);
  });

  it('the processor forwards the fact into finalize, never re-deriving it from text', () => {
    const processor = read('assistant-async-processor.ts');
    expect(processor).toMatch(/guardrailBlocked: bedrockResult\.inputGuardBlocked/);
    expect(processor).not.toMatch(/isGuardrailBlockReply/);
  });

  it('the metadata stamps it, so archival and the battle reads can see a dead side', () => {
    const metadata = read('lib/analytics-metadata.ts');
    expect(metadata).toMatch(/if \(context\.guardrailBlocked\) metadata\.guardrailBlocked = true;/);
  });
});
