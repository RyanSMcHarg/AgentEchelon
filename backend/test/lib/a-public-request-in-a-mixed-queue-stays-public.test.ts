/**
 * A MIXED QUEUE DOES NOT MAKE AN OPEN REQUEST PRIVATE.
 *
 * When several messages are queued and read together, one visibility used to be computed for the
 * whole batch - `private` if ANY of them was targeted - and every task the reading produced took it.
 * So in a queue of {a targeted request, an openly-asked request}, BOTH tasks were written private, and
 * the open one was hidden from the room because somebody ELSE had asked privately.
 *
 * ── WHY THE FAIL-CLOSED ARGUMENT DOES NOT REACH IT ───────────────────────────────────────────────
 *
 * `turn-triage.ts` defends the collapse: "over-disclosing publishes a request its sender chose to keep
 * off the room", and under-disclosing only costs a notification, so the mix takes the quieter answer.
 * That is correct about the READING, which names every queued request in one message, and it is
 * correct about the TARGETED item, which is why that item is still forced private.
 *
 * It is not correct about an untargeted item. Its sender chose nothing of the kind, so the quieter
 * answer is not the safer one - it is a different wrong answer, reached on a choice nobody made.
 * The asymmetry that justifies failing closed is per message, so the answer is per message.
 *
 * ── WHY THIS IS A SOURCE TEST ────────────────────────────────────────────────────────────────────
 *
 * `createTasksFromProposal` writes through `createTask`, and the value under test is one expression
 * inside the options it passes. A behavior test would have to stand up the task store, the queue and
 * the proposal parser to observe a single field, and would then pass whether or not the else-branch
 * still deferred to the batch - which is exactly how this defect survived: `targetedIds` was plumbed,
 * used per message for two other decisions, and the visibility fallback quietly kept the collapse.
 * So the assertion is on the expression, and it is written to fail if the batch value comes back.
 */
import * as fs from 'fs';
import * as path from 'path';

const PROPOSAL = path.join(__dirname, '../../lambda/src/lib/turn-triage-proposal.ts');
const TRIAGE = path.join(__dirname, '../../lambda/src/lib/turn-triage.ts');

const proposalSrc = fs.readFileSync(PROPOSAL, 'utf8');
const triageSrc = fs.readFileSync(TRIAGE, 'utf8');

describe('a public request in a mixed queue stays public', () => {
  it('decides a task visibility from THIS message, with no fallback to the batch', () => {
    // Non-vacuous: the file really does create tasks with a visibility option.
    expect(proposalSrc).toContain('visibility: targeted.has(item.messageId)');
    // The two literals, and nothing else. `: visibility` here is the collapse coming back.
    // The else-branch must not be the bare batch value. It may be `conversation` OR the batch value
    // guarded by whether the dispatcher actually told us - see `perItemVisibilityKnown`, which is the
    // difference between "nobody was targeted" and "nothing looked".
    expect(proposalSrc).toContain("perItemVisibilityKnown ? 'conversation' : visibility");
    expect(proposalSrc).toContain("args.targetedIds !== undefined");
  });

  it('still forces a TARGETED request private, which is the half the asymmetry does justify', () => {
    // The guard this change must not weaken: a request its sender addressed privately stays private
    // whatever the rest of the batch looks like.
    //
    // Whitespace-tolerant, because the expression is formatted across lines: a substring assertion
    // would fail on a reformat and read as the rule being broken.
    expect(proposalSrc).toMatch(/targeted\.has\(item\.messageId\)\s*\n?\s*\?\s*'private'/);
  });

  it('keeps the batch value only when the dispatcher never said which were targeted', () => {
    // ABSENT IS NOT EMPTY, and here it is the difference between failing closed and failing open. A
    // PRESENT `targetedIds` means the dispatcher looked, so "not in the set" is information. ABSENT
    // means an older dispatcher whose payload predates the field - nothing looked, so reading it as
    // "not targeted" would publish a request its sender addressed privately.
    //
    // Caught by the shard gate: `turn-triage-tasks.test.ts` passes a batch `private` with no
    // `targetedIds` and expects a private task, and the first version of this change made it shared.
    expect(proposalSrc).toContain('args.targetedIds !== undefined');
    expect(proposalSrc).toContain("perItemVisibilityKnown ? 'conversation' : visibility");
  });

  it('keeps the batch floor for the READING, because one message names every request', () => {
    // The batch value is not deleted - it is scoped. The reading carries every queued subject at once,
    // so its floor has to be the most restrictive of them.
    expect(triageSrc).toMatch(/visibility:\s*messages\.some\(\(m\) => m\.targeted\) \? 'private' : 'conversation'/);
    // And the comment says which of the two it governs, so the next reader does not re-apply it to a
    // task. This is the sentence that used to say "the tasks this produces".
    expect(triageSrc).toContain('What the READING must be visible to');
  });

  it('carries the per-message targeting all the way to task creation', () => {
    // `targetedIds` is the only input that can answer per message, so the path has to keep it. It was
    // already plumbed and already used for the fold decision; this asserts it reaches the visibility.
    expect(proposalSrc).toContain('targetedIds');
    expect(proposalSrc).toContain('const targeted = new Set');
  });
});
