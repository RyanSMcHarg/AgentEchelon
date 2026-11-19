/**
 * AN INTENT WORKFLOW'S STEPS KEEP THEIR PLACE (ADR-067 stage 1, WT7).
 *
 * What it proves: where an intent workflow's steps sit is saved in the version's layout under `intent:<intent>`, kept
 * only for steps the version's intent workflow declares, dropped with the workflow or the step, passed through untouched by
 * a caller that does not hold the intent workflows (the event workflows' builder), counted apart from the event workflows'
 * points, and every server path that writes a version judges them.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { intentLayoutKey, layoutFor, workflowLayoutErrors } from '../../lambda/src/lib/workflow-layout';

const INTENTS = { report_generation: { states: { tell: {}, work: {}, done: {} } } };
const LAYOUT: NonNullable<Parameters<typeof layoutFor>[0]> = {
  [intentLayoutKey('report_generation')]: { tell: { x: 10, y: 20 }, work: { x: 210.4, y: 20 }, gone: { x: 0, y: 0 } },
  [intentLayoutKey('retired_intent')]: { a: { x: 1, y: 1 } },
};

describe('an intent workflow\'s points', () => {
  it('are kept for the steps its workflow declares, rounded, and dropped with a step or a workflow', () => {
    expect(layoutFor(LAYOUT, {}, null, INTENTS)).toEqual({ 'intent:report_generation': { tell: { x: 10, y: 20 }, work: { x: 210, y: 20 } } });
    expect(layoutFor(LAYOUT, {}, null, null)).toBeUndefined();
  });

  it('pass through untouched where the caller does not hold the intent workflows', () => {
    expect(layoutFor(LAYOUT, {}, undefined)).toEqual({
      'intent:report_generation': { tell: { x: 10, y: 20 }, work: { x: 210, y: 20 }, gone: { x: 0, y: 0 } },
      'intent:retired_intent': { a: { x: 1, y: 1 } },
    });
  });

  it('are counted apart from the event workflows\' points', () => {
    const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`wf-${i}`, { a: { x: 0, y: 0 } }]));
    expect(workflowLayoutErrors({ ...many, [intentLayoutKey('report_generation')]: { a: { x: 0, y: 0 } } })).toEqual([]);
  });

  it('every server path that writes a version judges them against its intent workflows', () => {
    for (const f of ['profile-lifecycle.ts', 'profile-manifest.ts']) {
      const src = readFileSync(resolve(__dirname, `../../lambda/src/lib/${f}`), 'utf8');
      const calls = src.match(/layoutFor\([^;]*\)/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) expect(c).toMatch(/intentWorkflows \?\? null\)$/);
    }
  });
});
