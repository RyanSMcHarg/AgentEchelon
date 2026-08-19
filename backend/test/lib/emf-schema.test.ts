/**
 * EMF documents must match the schema AWS parses, not the one we happen to emit.
 *
 * THE BUG THIS EXISTS FOR. `emitEmfMetric` wrote `Metrics: [{ name, unit }]` in lowercase. The EMF
 * schema requires `Name` and `Unit`. CloudWatch rejects a malformed document SILENTLY - the log line
 * is still written, so every log looks healthy - and creates no metric at all.
 *
 * The consequence was total and invisible: `aws cloudwatch list-metrics --namespace AgentEchelon/Drift`
 * returned ZERO after months of drift detection running and emitting on every turn. Any alarm over any
 * of these metrics would have sat in INSUFFICIENT_DATA forever instead of firing.
 *
 * Every unit test around this passed throughout, because they asserted the shape the function
 * produces. That is the trap: a serializer test can only ever confirm the code does what the code
 * does. The schema is an EXTERNAL contract, so it is pinned here explicitly, against the field names
 * AWS documents rather than against ourselves.
 *
 * TWO LAYERS, and the second is the one that was missing. The envelope is validated below, and then
 * EVERY caller is driven through the same validator - because the envelope being right does not make a
 * caller right. A caller declares its own `dimensionSets`, and a dimension named in a set but absent
 * from the root properties drops that metric just as silently as the lowercase key did. The set of
 * callers is discovered by SCANNING THE SOURCE rather than listed by hand, so a new emitter added
 * tomorrow fails this file until it is exercised here.
 *
 * Reference: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html
 */
import * as fs from 'fs';
import * as path from 'path';
import { emitEmfMetric, emitDriftCounter, emitDriftTiming } from '../../lambda/src/lib/emf-metrics';
import {
  emitContextSourceOutcome,
  emitContextSourceFieldFailure,
} from '../../lambda/src/lib/context-source-outcomes';
import { recordNoTransitionTurn, TASK_STALL_TURNS, type Task } from '../../lambda/src/lib/task-tracking';
import { recordWelcomeConfigDefect } from '../../lambda/src/lib/welcome-metrics';
import { repairTaskAnswer } from '../../lambda/src/lib/task-answer-repair';
import { DeliveryOption } from '../../lambda/src/lib/delivery-options';

interface EmfDoc {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: Array<{
      Namespace: string;
      Dimensions: string[][];
      Metrics: Array<Record<string, unknown>>;
    }>;
  };
  [k: string]: unknown;
}

function capture(fn: () => void): EmfDoc[] {
  const docs: EmfDoc[] = [];
  const spy = jest.spyOn(console, 'log').mockImplementation((line: string) => {
    try { docs.push(JSON.parse(line) as EmfDoc); } catch { /* not EMF */ }
  });
  try { fn(); } finally { spy.mockRestore(); }
  return docs;
}

async function captureAsync(fn: () => Promise<unknown>): Promise<EmfDoc[]> {
  const docs: EmfDoc[] = [];
  const spy = jest.spyOn(console, 'log').mockImplementation((line: string) => {
    try { docs.push(JSON.parse(line) as EmfDoc); } catch { /* not EMF */ }
  });
  try { await fn(); } finally { spy.mockRestore(); }
  return docs;
}

/**
 * The whole external contract, in one place, applied to any document.
 *
 * Shared between the envelope tests and the per-caller sweep deliberately: a caller checked against a
 * weaker copy of these rules would pass while emitting something CloudWatch discards.
 */
function assertValidEmfDocument(d: EmfDoc, label: string): void {
  expect(`${label}: ${typeof d?._aws}`).toBe(`${label}: object`);
  const blocks = d._aws.CloudWatchMetrics;
  expect(`${label}: blocks=${blocks?.length ?? 0}`).not.toBe(`${label}: blocks=0`);

  expect(`${label}: ts=${typeof d._aws.Timestamp}`).toBe(`${label}: ts=number`);
  expect(d._aws.Timestamp).toBeGreaterThan(1_600_000_000_000); // ms, not seconds

  for (const block of blocks) {
    expect(`${label}: namespace=${block.Namespace}`).toMatch(/: namespace=\S+/);

    for (const m of block.Metrics) {
      // The original bug: lowercase keys. Asserted as the EXACT key set so emitting both spellings
      // cannot satisfy it.
      expect(`${label}: metric keys=${Object.keys(m).sort().join(',')}`)
        .toBe(`${label}: metric keys=Name,Unit`);
      // A metric named in the envelope but absent from the root is extracted as nothing.
      expect(`${label}: value of ${String(m.Name)}=${typeof d[m.Name as string]}`)
        .toBe(`${label}: value of ${String(m.Name)}=number`);
    }

    for (const set of block.Dimensions) {
      for (const key of set) {
        // A dimension named in a set but missing from the root drops that whole metric, silently.
        expect(`${label}: dimension ${key}=${d[key] === undefined ? 'MISSING' : 'present'}`)
          .toBe(`${label}: dimension ${key}=present`);
      }
    }
  }
}

describe('the EMF envelope matches the schema CloudWatch parses', () => {
  const doc = () => capture(() => emitEmfMetric({
    namespace: 'AgentEchelon/Test',
    metrics: [{ name: 'ThingHappened', unit: 'Count' }],
    dimensionSets: [['Classification'], ['Classification', 'Outcome']],
    properties: { Classification: 'standard', Outcome: 'resolved', ThingHappened: 1 },
  }))[0];

  it('names each metric with CAPITALISED Name and Unit', () => {
    // The whole bug, in one assertion. Lowercase keys make CloudWatch discard the document without
    // an error anywhere.
    const [metric] = doc()._aws.CloudWatchMetrics[0].Metrics;
    expect(metric).toEqual({ Name: 'ThingHappened', Unit: 'Count' });
  });

  it('does NOT emit the lowercase keys at all', () => {
    // Falsification: emitting both spellings would satisfy the assertion above while leaving the
    // document ambiguous. It must be the documented shape only.
    const [metric] = doc()._aws.CloudWatchMetrics[0].Metrics;
    expect(Object.keys(metric).sort()).toEqual(['Name', 'Unit']);
  });

  it('carries a numeric value for every declared metric name at the ROOT', () => {
    // A metric named in the envelope but absent from the root properties is extracted as nothing.
    const d = doc();
    for (const m of d._aws.CloudWatchMetrics[0].Metrics) {
      expect(typeof d[m.Name as string]).toBe('number');
    }
  });

  it('carries a value for every dimension KEY it declares', () => {
    // A dimension named in a set but missing from the root drops that whole metric silently.
    const d = doc();
    for (const set of d._aws.CloudWatchMetrics[0].Dimensions) {
      for (const key of set) expect(d[key]).toBeDefined();
    }
  });

  it('stamps a millisecond Timestamp', () => {
    const ts = doc()._aws.Timestamp;
    expect(typeof ts).toBe('number');
    expect(ts).toBeGreaterThan(1_600_000_000_000); // ms, not seconds
  });

  it('the shared validator accepts a valid document and REJECTS each way of breaking one', () => {
    // Falsification for the sweep below: a validator that cannot fail would bless every caller.
    const good = doc();
    expect(() => assertValidEmfDocument(good, 'good')).not.toThrow();

    const lowercased = JSON.parse(JSON.stringify(good)) as EmfDoc;
    lowercased._aws.CloudWatchMetrics[0].Metrics = [{ name: 'ThingHappened', unit: 'Count' }];
    expect(() => assertValidEmfDocument(lowercased, 'lowercase')).toThrow();

    const noRootValue = JSON.parse(JSON.stringify(good)) as EmfDoc;
    delete noRootValue.ThingHappened;
    expect(() => assertValidEmfDocument(noRootValue, 'no-root-value')).toThrow();

    const undeclaredDimension = JSON.parse(JSON.stringify(good)) as EmfDoc;
    undeclaredDimension._aws.CloudWatchMetrics[0].Dimensions = [['Classification', 'NotThere']];
    expect(() => assertValidEmfDocument(undeclaredDimension, 'missing-dimension')).toThrow();

    const secondsTimestamp = JSON.parse(JSON.stringify(good)) as EmfDoc;
    secondsTimestamp._aws.Timestamp = Math.floor(Date.now() / 1000);
    expect(() => assertValidEmfDocument(secondsTimestamp, 'seconds-ts')).toThrow();
  });
});

/**
 * Every emitter in the codebase, driven for real.
 *
 * Each entry produces one or more documents through the caller's own `dimensionSets` and properties -
 * the part `emitEmfMetric` cannot get right on the caller's behalf. Optional dimensions are exercised
 * too (drift's `UserClearance` / `Intent` are added to the sets only when the option is passed, which
 * is precisely where a set and its properties can drift apart).
 */
const CALLERS: Array<{ module: string; label: string; emit: () => Promise<EmfDoc[]> }> = [
  {
    module: 'lambda/src/lib/emf-metrics.ts',
    label: 'emitDriftCounter (no options)',
    emit: async () => capture(() => emitDriftCounter('drift_fired', 'corr-1')),
  },
  {
    module: 'lambda/src/lib/emf-metrics.ts',
    label: 'emitDriftCounter (clearance + intent)',
    emit: async () => capture(() => emitDriftCounter('drift_skipped_intent', 'corr-1', {
      userClearance: 'premium', intent: 'report_generation',
    })),
  },
  {
    module: 'lambda/src/lib/emf-metrics.ts',
    label: 'emitDriftTiming (no options)',
    emit: async () => capture(() => emitDriftTiming('total', 42, 'corr-1')),
  },
  {
    module: 'lambda/src/lib/emf-metrics.ts',
    label: 'emitDriftTiming (clearance + intent)',
    emit: async () => capture(() => emitDriftTiming('comparison', 7, 'corr-1', {
      userClearance: 'basic', intent: 'general',
    })),
  },
  {
    module: 'lambda/src/lib/context-source-outcomes.ts',
    label: 'emitContextSourceOutcome (resolved)',
    emit: async () => capture(() => emitContextSourceOutcome({
      classification: 'standard', sourceKey: 'company-docs', outcome: 'resolved',
    })),
  },
  {
    module: 'lambda/src/lib/context-source-outcomes.ts',
    label: 'emitContextSourceOutcome (denied)',
    emit: async () => capture(() => emitContextSourceOutcome({
      classification: 'premium', sourceKey: 'user-profile', outcome: 'denied',
    })),
  },
  {
    module: 'lambda/src/lib/context-source-outcomes.ts',
    label: 'emitContextSourceOutcome (not-in-catalog)',
    emit: async () => capture(() => emitContextSourceOutcome({
      classification: 'basic', sourceKey: 'ghost-key', outcome: 'not-in-catalog',
    })),
  },
  {
    module: 'lambda/src/lib/context-source-outcomes.ts',
    label: 'emitContextSourceFieldFailure',
    emit: async () => capture(() => emitContextSourceFieldFailure({
      classification: 'standard', sourceKey: 'company-docs', field: 'pricing', reason: 'timeout',
    })),
  },
  {
    module: 'lambda/src/lib/welcome-metrics.ts',
    label: 'recordWelcomeConfigDefect (incomplete)',
    emit: async () => capture(() => recordWelcomeConfigDefect({
      classification: 'standard', reason: 'incomplete', detail: ['companyName missing'],
    })),
  },
  {
    module: 'lambda/src/lib/welcome-metrics.ts',
    label: 'recordWelcomeConfigDefect (unusable)',
    emit: async () => capture(() => recordWelcomeConfigDefect({
      classification: 'premium', reason: 'unusable', detail: ['AccessDeniedException'],
    })),
  },
  {
    // An unset classification still has to produce a Classification dimension VALUE: the set names it,
    // and a named dimension with no property drops the metric silently.
    module: 'lambda/src/lib/welcome-metrics.ts',
    label: 'recordWelcomeConfigDefect (no classification)',
    emit: async () => capture(() => recordWelcomeConfigDefect({
      classification: '', reason: 'unusable', detail: [],
    })),
  },
  {
    module: 'lambda/src/lib/task-tracking.ts',
    label: 'recordNoTransitionTurn (task_state_stalled)',
    // The stall counter fires only at the threshold, so the task is seeded one turn short of it.
    // TASKS_TABLE is unset in tests, so the increment stays in memory and no DynamoDB call is made.
    emit: async () => captureAsync(() => recordNoTransitionTurn({
      taskId: 't1',
      channelArn: 'arn:chan',
      userArn: 'arn:user',
      userMessage: 'help',
      status: 'in_progress',
      deliveryOption: DeliveryOption.TASK_MULTI_STEP,
      taskType: 'report_generation',
      taskState: 'generating',
      turnsInState: TASK_STALL_TURNS - 1,
      details: {},
      createdAt: 'x',
      updatedAt: 'x',
      ttl: 0,
    } as Task)),
  },
  {
    // Delegated from a hand-rolled envelope 2026-08-18 (the dead-alarm fix): the repair metrics now
    // publish BOTH the [Classification]/[Reason] set and the DIMENSIONLESS rollup the
    // post-processing stack's alarm watches - dimension sets are distinct metrics, and an alarm over
    // a set nothing publishes can never fire. Driven through the module's real entry: with no
    // TASKS_TABLE the hint resolves to no task, which is the cheapest emitting path.
    module: 'lambda/src/lib/task-answer-repair.ts',
    label: 'repairTaskAnswer (Unresolved no-task, dimensionless rollup present)',
    emit: async () => captureAsync(() => repairTaskAnswer({
      EventType: 'CREATE_CHANNEL_MESSAGE',
      Payload: {
        MessageId: 'm-emf-1',
        ChannelArn: 'arn:aws:chime:us-east-1:1:app-instance/a/channel/c-emf',
        Content: encodeURIComponent('the audience is engineering leadership'),
        Metadata: JSON.stringify({ task: { id: 't-emf' } }),
        Sender: { Arn: 'arn:aws:chime:us-east-1:1:app-instance/a/user/u-emf', Name: 'A' },
      },
    } as never)),
  },
];

describe('every emitEmfMetric caller emits a document CloudWatch will parse', () => {
  it.each(CALLERS.map((c) => [c.label, c] as const))('%s', async (_label, caller) => {
    const docs = await caller.emit();
    // A caller that emitted NOTHING would pass a for-loop over an empty array - the vacuous-guard
    // shape this repo keeps getting bitten by.
    expect(`${caller.label}: ${docs.length} document(s)`).not.toBe(`${caller.label}: 0 document(s)`);
    for (const d of docs) assertValidEmfDocument(d, caller.label);
  });
});

describe('the caller list is discovered from the source, not maintained by hand', () => {
  const LAMBDA_SRC = path.join(__dirname, '..', '..', 'lambda', 'src');

  /** Files containing a real `emitEmfMetric({ ... })` CALL (the declaration takes `args:`, so it is excluded). */
  function callSiteModules(): string[] {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
        if (/emitEmfMetric\(\s*\{/.test(fs.readFileSync(full, 'utf8'))) {
          hits.push(path.relative(path.join(__dirname, '..', '..'), full).split(path.sep).join('/'));
        }
      }
    };
    walk(LAMBDA_SRC);
    return Array.from(new Set(hits)).sort();
  }

  it('finds call sites at all', () => {
    // A regex that matched nothing would make the assertion below compare two empty lists and pass.
    expect(callSiteModules().length).toBeGreaterThan(1);
  });

  it('every module that emits is exercised above', () => {
    const covered = new Set(CALLERS.map((c) => c.module));
    const uncovered = callSiteModules().filter((m) => !covered.has(m));
    if (uncovered.length) {
      throw new Error(
        `These modules call emitEmfMetric but are not exercised in this file:\n\n`
        + uncovered.map((m) => `    ${m}`).join('\n')
        + '\n\nAdd an entry to CALLERS driving each new emitter. A caller declares its own dimensionSets,\n'
        + 'and a dimension named in a set but absent from the properties drops that metric silently -\n'
        + 'the same failure mode as the lowercase Name/Unit bug, one layer up.',
      );
    }
    expect(uncovered).toEqual([]);
  });

  it('names no module that has stopped emitting', () => {
    // The reverse drift: a CALLERS entry for a module whose emit call was removed would keep passing
    // while covering nothing.
    const found = new Set(callSiteModules());
    const stale = Array.from(new Set(CALLERS.map((c) => c.module))).filter((m) => !found.has(m));
    expect(stale).toEqual([]);
  });
});
