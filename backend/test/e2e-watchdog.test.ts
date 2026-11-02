/**
 * THE E2E WATCHDOG: its decisions, and the suite rules that keep every spec under it.
 *
 * The watchdog (`tests/e2e/helpers/watchdog/`) fails a test the moment an operator alert arrives, a backend
 * error line arrives, or the test goes silent past its stall window. Its decisions are pure functions, proven
 * here with no account. The suite rules are source-text checks, the same kind as `e2e-suite-guards.test.ts`:
 *
 *  - every spec runs under the watchdog, by importing `test` from `helpers/fixtures`;
 *  - a spec that raises its timeout above the ceiling declares the timer it waits on (`declareWait`);
 *  - a wait on a room's messages wakes on the room's events (`roomMessagesUntil`), not on a timer.
 */
import * as fs from 'fs';
import * as path from 'path';
import { listE2eSpecs } from '../lib/docs/spec-coverage';
import {
  DECLARED_WAIT_MARGIN_MS, StallClock, alertReason, chunk, classifyAlert, correlates, isBackendFailureLine,
  parseLambdaLine, toPattern,
} from '../../tests/e2e/helpers/watchdog/logic';
import { EventStreamDecoder, encodeEventStreamMessage } from '../../tests/e2e/helpers/watchdog/eventstream';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const specs = listE2eSpecs(REPO_ROOT);
const read = (spec: string): string => fs.readFileSync(path.join(REPO_ROOT, 'tests', spec), 'utf8');

/** The longest a spec may raise its timeout to without naming the timer it waits on. */
const TIMEOUT_CEILING_MS = 10 * 60_000;
/** A poll or wait longer than this must run where the stall detector can end it. */
const LONG_WAIT_MS = 60_000;

/**
 * Specs whose tests run past the ceiling on live multi-turn model work rather than on a timer (and `welcome`,
 * whose timeout scales with `WELCOME_REPEAT`). Each is under the stall detector, so a long one that stops making
 * progress still fails at its window. The list only shrinks: an entry that no longer exceeds the ceiling fails
 * the ratchet below until it is removed.
 */
const LONG_RUNNING_RATCHET = new Set<string>([
  'e2e/a-console-edits-an-intents-image-and-step-models.spec.ts',
  'e2e/a-step-picks-the-model-where-it-overrides-or-delivers.spec.ts',
  'e2e/a-tested-treatment-is-promoted-into-the-live-assistant.spec.ts',
  'e2e/an-idle-assistant-takes-up-its-own-work.spec.ts',
  'e2e/an-image-duel-runs-both-chains-to-an-image.battle.spec.ts',
  'e2e/an-image-experiment-attributes-every-step-to-its-arm.spec.ts',
  'e2e/an-image-is-asked-for-confirmed-drawn-and-revised.spec.ts',
  'e2e/battle.spec.ts',
  'e2e/cost-sleep-failure-alert.spec.ts',
  'e2e/evaluation-verdicts.spec.ts',
  'e2e/experiment-results-trust.spec.ts',
  'e2e/experiments.spec.ts',
  'e2e/funnel.spec.ts',
  'e2e/no-platform-role-speaks-as-an-assistant.spec.ts',
  'e2e/place-item-flow.spec.ts',
  'e2e/report-flow-branches.spec.ts',
  'e2e/turn-queue.spec.ts',
  'e2e/welcome.spec.ts',
]);

/**
 * Waits on a room as a member the messaging session cannot follow: an app-instance admin that is not a member
 * of the room receives no events for it, so its read stays on an interval.
 */
const ROOM_POLL_RATCHET = new Set<string>(['e2e/an-operator-notice-is-worded-by-the-admin-agent.spec.ts']);

/** Evaluate a timeout expression: numeric literals, `+ - * /`, parentheses and the file's own numeric constants. */
export function evaluateTimeout(expr: string, src: string): number | null {
  const consts = new Map<string, string>();
  for (const m of src.matchAll(/\bconst ([A-Z][A-Z0-9_]*)\s*=\s*([0-9_.\s*+()/-]+);/g)) consts.set(m[1], m[2]);
  let e = expr;
  for (let i = 0; i < 3; i += 1) e = e.replace(/\b[A-Z][A-Z0-9_]*\b/g, (id) => (consts.has(id) ? `(${consts.get(id)})` : id));
  e = e.replace(/(\d)_(?=\d)/g, '$1');
  if (!/^[0-9.\s*+()/-]+$/.test(e)) return null;
  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict"; return (${e});`)();
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** The largest timeout a spec sets; Infinity when one cannot be evaluated (so it must be declared). */
function largestTimeout(src: string): number {
  let max = 0;
  for (const m of src.matchAll(/\btest\.setTimeout\(([^;]+?)\);/g)) {
    const v = evaluateTimeout(m[1], src);
    max = Math.max(max, v ?? Number.POSITIVE_INFINITY);
  }
  return max;
}

/** The longest poll or wait a spec writes inline (`timeoutMs`, `timeout`, or a `waitFor` deadline argument). */
function longestWait(src: string): number {
  let max = 0;
  const call = /\b(pollFor|roomMessagesUntil|waitFor|turnRowsOf|expect\.poll)\(/g;
  for (const m of src.matchAll(call)) {
    const tail = src.slice(m.index!, m.index! + 600);
    for (const t of tail.matchAll(/\btimeout(?:Ms)?:\s*([^,}\n]+)/g)) max = Math.max(max, evaluateTimeout(t[1], src) ?? Number.POSITIVE_INFINITY);
  }
  return max;
}

const importsWatchedTest = (src: string) => /import \{[^}]*\btest\b[^}]*\} from '\.\/helpers\/fixtures';/.test(src);

describe('e2e watchdog: stall detection', () => {
  it('is silent within the window and stalls after it, naming each side', () => {
    const c = new StallClock(120_000, 0);
    expect(c.verdict(119_999)).toBeNull();
    const v = c.verdict(120_000);
    expect(v?.message).toMatch(/^stalled: no progress for 120s/);
    expect(v?.message).toContain('last frontend signal never');
    expect(v?.message).toContain('last backend signal never');
  });

  it('pushes the deadline forward on every signal, from any side', () => {
    const c = new StallClock(120_000, 0);
    c.signal('frontend', 'websocket frame', 100_000);
    expect(c.verdict(200_000)).toBeNull();
    c.signal('backend', 'AsyncProcessor: turn started', 210_000);
    expect(c.verdict(329_999)).toBeNull();
    const v = c.verdict(330_000);
    expect(v?.message).toContain('last frontend signal 3m50s ago (websocket frame)');
    expect(v?.message).toContain('last backend signal 120s ago (AsyncProcessor: turn started)');
  });

  it('expects silence until a declared timer is due plus the margin, then stalls as before', () => {
    const c = new StallClock(120_000, 0);
    c.declareWait('the invitation deadline', 300_000);
    expect(c.verdict(300_000 + DECLARED_WAIT_MARGIN_MS - 1)).toBeNull();
    const v = c.verdict(300_000 + DECLARED_WAIT_MARGIN_MS);
    expect(v?.message).toContain('declared wait(s) already due: "the invitation deadline"');
    expect(c.activeWait(10_000)?.reason).toBe('the invitation deadline');
  });

  it('a signal after a declared wait restarts the ordinary window', () => {
    const c = new StallClock(120_000, 0);
    c.declareWait('a timer', 60_000);
    c.signal('harness', 'pollFor read changed', 400_000);
    expect(c.deadline()).toBe(520_000);
  });
});

describe('e2e watchdog: operator alerts', () => {
  const phaseStartMs = Date.parse('2026-10-30T16:00:00Z');
  const alarm = (state: 'ALARM' | 'OK', at: string, name = 'AgentEchelonAssistants-premium-context-source-failure-rate') => ({
    messageId: `m-${state}-${at}`,
    createdAtMs: Date.parse(at),
    content: `**Alarm:** ${name}\n**What:** More than 10% of context source reads failed over 5 minutes (premium).\n`
      + '**CloudWatch:** Threshold Crossed: 1 datapoint [14.2] was greater than the threshold (10.0).\n**When:** 2026-10-30T16:52:42Z',
    metadata: { messageType: 'cloudwatch_alarm', alarmName: name, alarmState: state },
  });

  it('an alarm going into ALARM during the phase fails, with its name, reason and time', () => {
    const v = classifyAlert(alarm('ALARM', '2026-10-30T16:52:43Z'), { phaseStartMs, expected: [] });
    expect(v).toMatchObject({ kind: 'alarm', name: 'AgentEchelonAssistants-premium-context-source-failure-rate', fails: true, preexisting: false, atIso: '2026-10-30T16:52:43.000Z' });
    expect(v.reason).toContain('Threshold Crossed');
  });

  it('a recovery is reported and fails nothing', () => {
    expect(classifyAlert(alarm('OK', '2026-10-30T16:57:43Z'), { phaseStartMs, expected: [] })).toMatchObject({ kind: 'recovery', fails: false });
  });

  it('an alert posted before the phase began is standing, not this run\'s', () => {
    expect(classifyAlert(alarm('ALARM', '2026-10-30T15:59:00Z'), { phaseStartMs, expected: [] })).toMatchObject({ preexisting: true, fails: false });
  });

  it('an alarm a spec declared, by name or by the words it carries, does not fail', () => {
    const named = classifyAlert(alarm('ALARM', '2026-10-30T16:10:00Z', 'AgentEchelon-e2e-admin-notice-abc'), { phaseStartMs, expected: [toPattern('AgentEchelon-e2e-admin-notice-abc')] });
    expect(named).toMatchObject({ expected: true, fails: false });
    const worded = classifyAlert(
      { ...alarm('ALARM', '2026-10-30T16:10:00Z'), content: '**What:** E2E synthetic alarm. Context source failure detail.' },
      { phaseStartMs, expected: [toPattern('E2E synthetic alarm.')] },
    );
    expect(worded.fails).toBe(false);
    // The same alarm without the synthetic words is still a failure: the declaration is that narrow.
    expect(classifyAlert(alarm('ALARM', '2026-10-30T16:20:00Z'), { phaseStartMs, expected: [toPattern('E2E synthetic alarm.')] }).fails).toBe(true);
  });

  it('every other operator notice fails; a completed clean-copy run is a routine report', () => {
    const notice = { messageId: 'n1', createdAtMs: phaseStartMs + 1, content: '**Error:** ThrottlingException', metadata: { messageType: 'assistant_error' } };
    expect(classifyAlert(notice, { phaseStartMs, expected: [] })).toMatchObject({ kind: 'notice', name: 'assistant_error', fails: true });
    const report = { ...notice, metadata: { messageType: 'clean_copy_run', outcome: 'complete' } };
    expect(classifyAlert(report, { phaseStartMs, expected: [] })).toMatchObject({ kind: 'report', fails: false });
    expect(classifyAlert({ ...notice, metadata: { messageType: 'clean_copy_run', outcome: 'failed' } }, { phaseStartMs, expected: [] }).fails).toBe(true);
  });

  it('reads the reason from the rendered alert', () => {
    expect(alertReason('**Alarm:** X\n**What:** watches Y\n**CloudWatch:** Threshold Crossed')).toBe('CloudWatch: Threshold Crossed | What: watches Y');
    expect(alertReason('just words')).toBe('just words');
  });
});

describe('e2e watchdog: backend log lines', () => {
  const textLine = '2026-10-30T17:31:06.610Z\t6bf85aa8-5b1c-4717-a1f1-c624b229e5a6\tERROR\t[AsyncProcessor] turn failed AccessDeniedException';

  it('an ERROR line, an exception, a denial and a runtime timeout are failures', () => {
    expect(isBackendFailureLine(textLine)).toBe(true);
    expect(isBackendFailureLine('2026-10-30T17:31:06Z\tid\tWARN\tcall was Denied by policy')).toBe(true);
    expect(isBackendFailureLine('2026-10-30T17:31:06Z 6bf85aa8-5b1c-4717-a1f1-c624b229e5a6 Task timed out after 30.03 seconds')).toBe(true);
  });

  it('matches whole terms the way the sweep\'s filter pattern does, and keeps its exclusions', () => {
    expect(isBackendFailureLine('2026-10-30T17:31:06Z\tid\tINFO\tERRORS_SEEN=0')).toBe(false);
    expect(isBackendFailureLine('2026-10-30T17:31:06Z\tid\tINFO\tturn complete')).toBe(false);
    expect(isBackendFailureLine('2026-10-30T17:31:06Z\tid\tERROR\tNodeVersionSupportWarning: upgrade')).toBe(false);
  });

  it('a line a test declared is not a failure', () => {
    expect(isBackendFailureLine(textLine, [toPattern(/turn failed/)])).toBe(false);
    expect(isBackendFailureLine(textLine, [toPattern('something else')])).toBe(true);
  });

  it('parses the request id and level from each shape the runtime writes', () => {
    expect(parseLambdaLine(textLine)).toMatchObject({ requestId: '6bf85aa8-5b1c-4717-a1f1-c624b229e5a6', level: 'ERROR' });
    expect(parseLambdaLine('START RequestId: 6bf85aa8-5b1c-4717-a1f1-c624b229e5a6 Version: $LATEST').requestId).toBe('6bf85aa8-5b1c-4717-a1f1-c624b229e5a6');
    expect(parseLambdaLine('{"level":"ERROR","requestId":"r-1","message":"boom"}')).toMatchObject({ requestId: 'r-1', level: 'ERROR', text: 'boom' });
  });

  it('follows a request that named the test\'s conversation for the rest of its invocation', () => {
    const keys = new Set(['c0ffee00-1111-2222-3333-444455556666']);
    const requests = new Set<string>();
    const first = correlates('2026-10-30T17:31:06Z\taaaaaaaa-1111-2222-3333-444444444444\tINFO\tturn for channel/c0ffee00-1111-2222-3333-444455556666', keys, requests);
    expect(first).toEqual({ hit: true, requestId: 'aaaaaaaa-1111-2222-3333-444444444444' });
    requests.add(first.requestId!);
    expect(correlates('END RequestId: aaaaaaaa-1111-2222-3333-444444444444', keys, requests).hit).toBe(true);
    expect(correlates('END RequestId: bbbbbbbb-1111-2222-3333-444444444444', keys, requests).hit).toBe(false);
  });

  it('splits log groups into Live Tail sessions of at most ten', () => {
    expect(chunk(Array.from({ length: 23 }, (_, i) => i), 10).map((c) => c.length)).toEqual([10, 10, 3]);
  });

  it('decodes the Live Tail event stream across arbitrary chunk boundaries', () => {
    const update = JSON.stringify({ sessionResults: [{ logGroupIdentifier: 'g', logStreamName: 's', message: textLine, timestamp: 1 }] });
    const bytes = Buffer.concat([
      encodeEventStreamMessage({ ':message-type': 'event', ':event-type': 'sessionStart' }, '{"sessionId":"x"}'),
      encodeEventStreamMessage({ ':message-type': 'event', ':event-type': 'sessionUpdate' }, update),
    ]);
    const d = new EventStreamDecoder();
    const out = [];
    for (let i = 0; i < bytes.length; i += 7) out.push(...d.push(bytes.subarray(i, i + 7)));
    expect(out.map((m) => m.headers[':event-type'])).toEqual(['sessionStart', 'sessionUpdate']);
    expect(JSON.parse(out[1].payload.toString('utf8')).sessionResults[0].message).toBe(textLine);
  });
});

describe('e2e watchdog: every spec runs under it', () => {
  it('finds the e2e suite', () => {
    expect(specs.length).toBeGreaterThan(10);
  });

  it('every spec imports test from helpers/fixtures, so the listeners are on by default', () => {
    const outside = specs.filter((f) => !importsWatchedTest(read(f)));
    expect(outside).toEqual([]);
  });

  it(`every spec that polls or waits longer than ${LONG_WAIT_MS / 1000}s runs under the stall detector`, () => {
    const unwatched = specs.filter((f) => {
      const src = read(f);
      return longestWait(src) > LONG_WAIT_MS && !importsWatchedTest(src);
    });
    expect(unwatched).toEqual([]);
  });

  it('no spec turns the watchdog off for itself, nor its stall window (only the manual demo, a person drives, has none)', () => {
    // `listE2eSpecs` leaves out `queue-demo.spec.ts`, the one spec a person drives from a paused browser.
    expect(specs.filter((f) => /E2E_WATCHDOG|setCurrentWatch|stallWindowMs:\s*0\b/.test(read(f)))).toEqual([]);
    expect(read('e2e/queue-demo.spec.ts')).toMatch(/stallWindowMs:\s*0\b/);
  });

  it(`a spec raising its timeout above ${TIMEOUT_CEILING_MS / 60_000} minutes declares the timer it waits on`, () => {
    const over = specs.filter((f) => {
      const src = read(f);
      return largestTimeout(src) > TIMEOUT_CEILING_MS && !/\bdeclareWait\(/.test(src) && !LONG_RUNNING_RATCHET.has(f);
    });
    expect(over).toEqual([]);
  });

  it('the long-running ratchet only shrinks: every entry still exists and still exceeds the ceiling', () => {
    const stale = [...LONG_RUNNING_RATCHET].filter((f) => !specs.includes(f) || largestTimeout(read(f)) <= TIMEOUT_CEILING_MS);
    expect(stale).toEqual([]);
  });

  it('a wait on a room\'s messages wakes on its events, not on a timer', () => {
    const polling = specs.filter((f) => /pollFor\(\s*\(\)\s*=>\s*roomMessagesSeenBy\(/.test(read(f)) && !ROOM_POLL_RATCHET.has(f));
    expect(polling).toEqual([]);
    const stale = [...ROOM_POLL_RATCHET].filter((f) => !/pollFor\(\s*\(\)\s*=>\s*roomMessagesSeenBy\(/.test(read(f)));
    expect(stale).toEqual([]);
  });

  describe('the detectors discriminate', () => {
    it('evaluates the timeout expressions the suite writes', () => {
      const src = 'const DEADLINE_MINUTES = 5;\nconst N = 3;';
      expect(evaluateTimeout('15 * 60_000', src)).toBe(900_000);
      expect(evaluateTimeout('DEADLINE_MINUTES * 60_000 + 600_000', src)).toBe(900_000);
      expect(evaluateTimeout('60_000 + N * 45_000', src)).toBe(195_000);
      expect(evaluateTimeout('SOMETHING_IMPORTED + 1', src)).toBeNull();
      expect(largestTimeout('test.setTimeout(LATER);')).toBe(Number.POSITIVE_INFINITY);
    });

    it('recognises a watched import and an unwatched one', () => {
      expect(importsWatchedTest("import { test, expect } from './helpers/fixtures';")).toBe(true);
      expect(importsWatchedTest("import { test, expect } from '@playwright/test';")).toBe(false);
    });

    it('measures an inline wait', () => {
      expect(longestWait('await pollFor(() => x(), ok, { timeoutMs: 180_000, intervalMs: 5_000 });')).toBe(180_000);
      expect(longestWait("await expect.poll(() => f(), { timeout: 30_000 }).toBe(1);")).toBe(30_000);
    });
  });
});
