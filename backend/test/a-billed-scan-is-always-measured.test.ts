/**
 * A BILLED SCAN IS ALWAYS MEASURED.
 *
 * `poll_ms` means one thing: the placeholder handoff did not supply a target, so a billed
 * `ListChannelMessages` ran. `poll_fallback_count` is the rate over it, and its value comes from
 * sitting on a hard floor of zero - a regression is a step off the floor rather than a drift inside
 * noise, which is what lets an alert on it mean one thing.
 *
 * ── HOW IT WENT BLIND, WHICH IS WHY THIS TEST EXISTS ─────────────────────────
 *
 * The pre-inference placeholder wait was removed on 2026-09-22, and correctly: it waited on an id
 * that was not needed yet, in front of the work everyone is waiting for. It was also the only thing
 * that ever assigned `pollMs`. The DELIVERY-side scan survived and kept running, recording nothing.
 *
 * The console went on showing a scan rate, because rows written before the change were still inside
 * the window. It read 45% of turns three days later, traceable to no code at all, and it would have
 * decayed toward zero as the 90-day window rolled - presenting a measurement going blind as an
 * optimisation landing. A metric that looks live and measures nothing is worse than an absent one.
 *
 * SOURCE ASSERTIONS. The failure was structural - a whole producer missing - and that is visible in
 * the source and invisible to a test that mocks the thing it is checking for. What must never happen
 * again is the scan running with nothing timing it.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', 'lambda', 'src');
const processor = fs.readFileSync(path.join(SRC, 'assistant-async-processor.ts'), 'utf8');
const core = fs.readFileSync(path.join(SRC, 'lib', 'async-processor-core.ts'), 'utf8');

/** The delivery-side block: from the scan call to the end of its log line. */
function deliveryScanBlock(): string {
  const at = processor.indexOf('scanForPlaceholderMessage(');
  expect(at).toBeGreaterThan(-1);
  return processor.slice(Math.max(0, at - 1200), at + 900);
}

describe('the delivery-side scan is timed', () => {
  it('takes a clock reading immediately before the scan', () => {
    const block = deliveryScanBlock();
    expect(block).toMatch(/const scanStart = Date\.now\(\);\s*\n\s*deliverMessageId = await scanForPlaceholderMessage\(/);
  });

  it('records the elapsed time immediately after it', () => {
    expect(deliveryScanBlock()).toContain('deliveryScanMs = Date.now() - scanStart;');
  });

  it('measures the scan whether or not it found anything', () => {
    // A scan that comes back empty was still bought and still cost the person the wait. Timing only
    // the successful ones would report the cheap half of the population as the whole of it.
    const block = deliveryScanBlock();
    const assignAt = block.indexOf('deliveryScanMs = Date.now() - scanStart;');
    const guardAt = block.indexOf('if (deliverMessageId)');
    // The assignment is not nested under a "did it resolve" check.
    expect(assignAt).toBeGreaterThan(-1);
    if (guardAt > -1) expect(assignAt).toBeLessThan(guardAt);
  });
});

describe('the measurement reaches the analytics record', () => {
  it('sends the scan time as pollMs', () => {
    expect(processor).toContain('pollMs: deliveryScanMs ?? pollMs,');
  });

  it('adds the scan to the locating total, so the superset stays a superset', () => {
    // `placeholder_resolve_ms` is documented as a SUPERSET of poll_ms by exactly the mapping read.
    // Leaving the scan out of it would make the superset exclude its most expensive member.
    expect(processor).toMatch(/placeholderResolveMs: deliveryScanMs !== undefined/);
    expect(processor).toContain('(placeholderResolveMs ?? 0) + deliveryScanMs');
  });

  it('keeps pollMs UNDEFINED on a turn that did not scan', () => {
    // Not zero. A column of zeroes puts the mean between two populations and describes no turn:
    // COUNT(poll_ms) is how often a scan was paid and AVG(poll_ms) is what one costs.
    expect(processor).toMatch(/let deliveryScanMs: number \| undefined;/);
    expect(processor).not.toMatch(/let deliveryScanMs: number = 0/);
  });
});

describe('the producer the core points at actually exists', () => {
  it('the core still declines to write pollMs before inference', () => {
    // The pre-inference wait must not come back: it timed an id nothing needed yet.
    expect(core).toContain('const pollMs: number | undefined = undefined;');
  });

  it('the core says the delivery path owns the column, and the delivery path does', () => {
    // This pairing is the whole guard. The comment asserted an end state that nothing implemented,
    // and a comment describing a producer that does not exist reads exactly like one that does.
    // Line-break tolerant: the sentence wraps in the source, so a literal match would be asserting
    // the comment's line width rather than its claim.
    expect(core.replace(/\s*\n\s*\/\/\s*/g, ' ')).toMatch(/only ever written by the delivery-side path/);
    expect(processor).toContain('deliveryScanMs = Date.now() - scanStart;');
  });
});
