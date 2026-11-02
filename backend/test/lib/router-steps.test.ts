/**
 * THE ROUTER-STEP VOCABULARY, and the rules that keep it honest.
 *
 * RULE 1 - EVERY STEP HAS A PRODUCER, and every producer's step is declared. A name nothing marks is
 * a row that is always absent, and absence is how this design says "the branch did not run it" - so
 * an unmarked name is indistinguishable from a skipped step, and quietly makes the whole absence
 * convention unreadable. A mark the vocabulary does not know is worse: the ledger writer discards it,
 * so the step is measured, carried across a Lambda boundary, and then silently dropped.
 *
 * RULE 2 - THE INSTANTS RECONCILE WITH THE SPAN. The first and last marks of a dispatched turn are
 * `entry` and `dispatched`, taken from the same two readings of the clock as `routerMs`, so the log
 * divides that span exactly rather than approximately. That is the property that makes a residual
 * meaningful: if the steps do not sum to the leg, the instrumentation is wrong, and there is no
 * rounding to hide behind.
 *
 * RULE 3 - A PAYLOAD IS NOT TRUSTED. The log crosses a Lambda boundary as JSON before it reaches an
 * append-only ledger, so a malformed mark is discarded at the boundary rather than written. A row
 * nothing can interpret is worse in that table than no row.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ROUTER_STEPS,
  isRouterStep,
  startRouterSteps,
  parseRouterSteps,
} from '../../lambda/src/lib/router-steps';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');

/** Every step a producer marks, read from the source rather than remembered. */
function markedSteps(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
      const src = fs.readFileSync(p, 'utf8');
      // The router's own mark calls...
      for (const m of src.matchAll(/markRouterStep\(\s*'([a-z_]+)'/g)) found.add(m[1]);
      // ...and `entry`, which the log stamps for itself so the first step has a predecessor. A stamp is a
      // log mark, `{ step, at }`, so other vocabularies that name a `step` (a template's language step) are
      // not read as router steps.
      for (const m of src.matchAll(/\bstep:\s*'([a-z_]+)',\s*at:/g)) found.add(m[1]);
    }
  };
  walk(SRC);
  return found;
}

describe('every step is actually marked', () => {
  it('each marked step is one the vocabulary knows', () => {
    // The names go in the assertion VALUE, not a message: jest's expect takes none, and "expected
    // true, received false" would not say which producer drifted.
    const unknown = [...markedSteps()].filter((s) => !isRouterStep(s));
    expect({ producersMarkingUnknownSteps: unknown }).toEqual({ producersMarkingUnknownSteps: [] });
  });

  it('every step in the vocabulary has at least one producer', () => {
    const marked = markedSteps();
    const orphans = ROUTER_STEPS.filter((s) => !marked.has(s));
    expect({ stepsWithNoProducer: orphans }).toEqual({ stepsWithNoProducer: [] });
  });

  it('the path begins at entry and ends at dispatch', () => {
    // Order in the declaration is documentation, but these two are load-bearing: they are the pair
    // that `routerMs` is measured between.
    expect(ROUTER_STEPS[0]).toBe('entry');
    expect(ROUTER_STEPS[ROUTER_STEPS.length - 1]).toBe('dispatched');
  });
});

describe('the log divides the span it is stamped alongside', () => {
  it('entry carries the caller\'s own start instant, not a second reading', () => {
    const routerStart = 1_000_000;
    const { log } = startRouterSteps(routerStart);
    expect(log[0]).toEqual({ step: 'entry', at: routerStart });
  });

  it('first to last equals routerMs exactly, because both come from the same instants', () => {
    const routerStart = 1_000_000;
    const { log, mark } = startRouterSteps(routerStart);
    mark('channel_resolved', routerStart + 120);
    mark('classified', routerStart + 600);
    // The dispatch reads the clock ONCE and uses it for both, which is what this asserts.
    const at = routerStart + 900;
    mark('dispatched', at);
    const routerMs = at - routerStart;

    expect(log[log.length - 1].at - log[0].at).toBe(routerMs);
  });

  it('keeps a step reached twice, rather than collapsing it', () => {
    // A branching path can legitimately reach one boundary twice, and a map keyed on the step would
    // silently keep one of them. The ledger records what happened.
    const { log, mark } = startRouterSteps(0);
    mark('task_prepared', 10);
    mark('task_prepared', 40);
    expect(log.filter((m) => m.step === 'task_prepared')).toHaveLength(2);
  });

  it('marks nothing for a step that did not run', () => {
    // Absence IS the record: a fast-path turn buys no classification, and a zero would report the
    // step as free on exactly the turns that skipped it.
    const { log, mark } = startRouterSteps(0);
    mark('dispatched', 50);
    expect(log.map((m) => m.step)).toEqual(['entry', 'dispatched']);
  });
});

describe('what crosses the boundary is validated, not trusted', () => {
  it('drops a step name this build does not know', () => {
    const parsed = parseRouterSteps([
      { step: 'entry', at: 1 },
      { step: 'a_step_from_a_newer_router', at: 2 },
    ]);
    expect(parsed).toEqual([{ step: 'entry', at: 1 }]);
  });

  it('drops a mark whose instant is not a number', () => {
    const parsed = parseRouterSteps([
      { step: 'entry', at: 1 },
      { step: 'classified', at: 'soon' },
      { step: 'dispatched', at: Number.NaN },
    ]);
    expect(parsed).toEqual([{ step: 'entry', at: 1 }]);
  });

  it('reads absent, malformed and empty all as "this turn recorded none"', () => {
    expect(parseRouterSteps(undefined)).toBeNull();
    expect(parseRouterSteps(null)).toBeNull();
    expect(parseRouterSteps('entry')).toBeNull();
    expect(parseRouterSteps([])).toBeNull();
    expect(parseRouterSteps([{ step: 'nope', at: 1 }])).toBeNull();
  });
});
