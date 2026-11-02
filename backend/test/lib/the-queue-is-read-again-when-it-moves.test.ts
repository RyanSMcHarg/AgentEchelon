/**
 * A QUEUE THAT MOVED UNDER THE READING IS READ AGAIN (ADR-033, DESIGN 2.3 step 1 and section 7).
 *
 * The requirement is two halves and only one was built. "Review the full queue. Every message
 * waiting, together, not one at a time" - and then, bounded by three passes, check whether it moved
 * while the model was answering.
 *
 * The first half was fine: the reading is handed the whole queue as it stands. The second did not
 * exist. Arrival triage dispatches ~200 to 500ms after the first message lands, so the second and
 * third of a burst arrive while the model is still reading about the first; their own arrival triage
 * correctly loses the claim to the reading in flight, and nothing ever came back for them. The drain
 * read one of three, posted a proposal for that one, and left the rest queued behind a notice it
 * could not honestly settle.
 *
 * Measured on the deployment: four readings in one e2e run logged `read: 1, stillWaiting: 2`, the
 * waiting styling never cleared, and a queue covering two plainly different subjects was never
 * offered as a split because the reading only ever held one of them.
 *
 * THE LOOP ITSELF WAS ALREADY BUILT. `TRIAGE_MAX_PASSES`, `mayTakeAnotherPass` and the `pass + 1`
 * threading have been there since the bound replaced the wall clock. It had exactly one trigger -
 * the model saying it cannot tell yet - and re-read the same ids, deliberately, to catch edits and
 * deletes. What was missing was the other reason a reading is not ready: the queue is no longer the
 * one it read.
 *
 * ── WHY THIS IS A SOURCE GUARD ──────────────────────────────────────────────────────────────────
 *
 * The check lives inside the processor's long-response path, which takes a live Bedrock result and
 * is not invocable from a unit test. Two neighbouring rules are pinned the same way and for the same
 * reason (`a-queue-with-nothing-readable-still-empties`, `a-question-outstanding-does-not-hold-the-
 * conversation`). What a source guard can still pin is the part that was wrong: WHERE the check
 * sits, and that it is bounded. Both are decisions, and both are silent when broken.
 */
import * as fs from 'fs';
import * as path from 'path';

const CORE = path.resolve(__dirname, '../..', 'lambda/src/lib/async-processor-core.ts');
const src: string = fs.readFileSync(CORE, 'utf8');

const recheck = src.indexOf('const arrivedSinceRead = queuedNow.filter(');
// WHERE A READING BECOMES A PROPOSAL, which is now TWO places: the deterministic tool channel and
// the prose fallback for a model that answered without calling it. This anchored on the single
// `const judged = parseTriageProposal(` that existed when the reading was prose-only; the tool
// channel made that line `recorded ?? parseTriageProposal(...)`, the anchor stopped matching, and
// every ordering assertion below started comparing against -1. Two of them passed that way.
//
// The rule is about the EARLIEST interpretation point - once any of it is parsed, a further pass
// would be adding to a reading rather than replacing it - so the guard takes the first of the two.
//
// AND ONE EXCEPTION, BY DECISION: before re-reading, a pass records what it found to
// be FOLLOW-UPS, so the running answer can fold them while the next pass reads. That peek adds nothing
// to the proposal - the next pass still replaces it - so the anchor is the PROPOSAL's interpretation
// point (`const judged =`), and the peek is pinned below to record amendments and nothing else.
const parse = src.indexOf('const judged = recorded ?? parseTriageProposal(');

describe('the reading checks whether the queue moved under it', () => {
  it('makes the check at all', () => {
    // Non-vacuity for every ordering assertion below: if this is gone they would all compare -1s.
    expect(recheck).toBeGreaterThan(-1);
    // The proposal's interpretation point, found rather than assumed: this file once asserted against
    // -1 without failing when its anchor stopped matching.
    expect(parse).toBeGreaterThan(recheck);
  });

  /**
   * BEFORE THE PARSE, which is the whole placement argument.
   *
   * A further pass REPLACES this reading rather than adding to it, so one drain still produces one
   * proposal. The obvious alternative - check at the settle, where `stillWaiting` is already
   * computed - is wrong: by then the tasks are created and the proposal is posted, so the drain
   * would emit a second proposal for the same queue. That is the duplicate the arrival claim was
   * given a depth to prevent, arriving by another door.
   */
  it('checks before the reading is parsed, so one drain still produces one proposal', () => {
    expect(recheck).toBeLessThan(parse);
  });

  /**
   * THE SAME BOUND AS THE OTHER TRIGGER, because it is the same loop. A second, separate limit
   * would be two numbers describing one thing, and the one nobody edits is the one that goes stale.
   */
  it('is bounded by the pass count rather than by a new limit of its own', () => {
    const guard = src.slice(recheck, parse);
    expect(guard).toContain('mayTakeAnotherPass(event.triage)');
    expect(guard).toContain('pass: event.triage.pass + 1');
  });

  /**
   * THE WHOLE QUEUE, never the difference. Reading only what arrived would classify the burst in
   * pieces, which is the defect being fixed rather than a cheaper version of the fix: "three
   * messages that are one request read as one request only when they are seen at once".
   */
  it('re-reads the whole queue rather than only what arrived', () => {
    const guard = src.slice(recheck, parse);
    expect(guard).toContain('queued: queuedNow');
    expect(guard).not.toContain('queued: arrivedSinceRead');
  });

  /**
   * NOT WHEN STOPPED. Re-reading a queue for a turn the person just ended is work they asked to
   * stop - the same rule the amendment fold follows a few hundred lines above.
   */
  it('the proposal anchor exists, so the slices above are not vacuous', () => {
    expect(recheck).toBeGreaterThan(-1);
    expect(parse).toBeGreaterThan(recheck);
  });

  it('keeps only this pass\'s follow-ups before re-reading, and creates or posts nothing', () => {
    const guard = src.slice(recheck, parse);
    const peekAt = guard.indexOf('const passReading =');
    expect(peekAt).toBeGreaterThan(-1);
    const peek = guard.slice(peekAt, guard.indexOf('const movedReread'));
    expect(peek).toContain('recordAmendments({');
    expect(peek).not.toContain('createTasksFromProposal');
    expect(peek).not.toContain('buildProposalMessage');
    expect(peek).not.toContain('clearQueue');
  });

  it('does not loop on a turn the person stopped', () => {
    const guard = src.slice(recheck, parse);
    expect(guard).toContain('!stopped');
  });
});
