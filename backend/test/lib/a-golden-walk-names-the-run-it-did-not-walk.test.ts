/**
 * A GOLDEN WALK NAMES THE RUN-LEVEL STEPS IT DID NOT WALK (ADR-067 decision 1, "The golden set").
 *
 * What it proves: a walk runs an intent's machine only, so every other step of the intent's workflow (a send before, an
 * approval or a second task after) is named as not exercised, its ends and its own task step excepted; the canonical
 * workflow names none; the gate's walk entries carry the names from the attempt's walk note; and the golden run records
 * them on each attempt from the side's own intent workflow.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { canonicalIntentWorkflow, runStepsNotWalked, type IntentWorkflow } from '../../lambda/src/lib/intent-workflow';
import { walksOf, type GateAttempt, type GateEntry } from '../../lambda/src/lib/promotion-gate';

const WITH_APPROVAL = {
  on: { intent: 'report_generation' },
  initial: 'tell',
  states: {
    tell: { send: { to: 'requester', template: 'workflow-step-withheld' }, onSuccess: 'work', onFailure: 'work' },
    work: { task: { machine: 'report_generation', for: 'requester' }, onSuccess: 'approve', onFailure: 'failed' },
    approve: { task: { machine: 'approval', by: { participantRole: 'lead' }, deadline: { afterMinutes: 60 } }, onSuccess: 'done', onFailure: 'failed' },
    done: { disposition: 'success' },
    failed: { disposition: 'failure' },
  },
} as unknown as IntentWorkflow;

describe('the steps a walk does not walk', () => {
  it('are every step but the intent\'s own task step and the ends, in declaration order', () => {
    expect(runStepsNotWalked(WITH_APPROVAL, 'report_generation')).toEqual(['tell', 'approve']);
    expect(runStepsNotWalked(canonicalIntentWorkflow('report_generation'), 'report_generation')).toEqual([]);
  });

  it('the gate carries them on each walked entry, whatever the walk\'s outcome', () => {
    const attempt = (walk: GateAttempt['walk']): GateAttempt => ({ ok: true, empty: false, blocked: false, breaches: [], score: 0.9, walk });
    const entry = (id: string, walk: GateAttempt['walk']): GateEntry => ({ entryId: id, purpose: 'regression', candidate: [attempt(walk)], baseline: [], walked: { intent: 'report_generation' } });
    const walks = walksOf([
      entry('e1', { outcome: 'passed', runSteps: ['tell', 'approve'] }),
      entry('e2', { outcome: 'passed' }),
    ])!;
    expect(walks.entries[0]).toMatchObject({ entryId: 'e1', outcome: 'passed', runSteps: ['tell', 'approve'] });
    expect(walks.entries[1]).not.toHaveProperty('runSteps');
    expect(walks.passed).toBe(2);
  });

  it('the golden run records them on each attempt from the side\'s own intent workflow', () => {
    const run = readFileSync(resolve(__dirname, '../../lambda/src/analytics-aurora/golden-run.ts'), 'utf8');
    expect(run).toMatch(/const declaredRun = side\.intentWorkflows\?\.\[intent\];\s*const runSteps = declaredRun \? runStepsNotWalked\(declaredRun, intent\) : \[\];/);
    expect(run).toMatch(/\.\.\.\(resolved\.intentWorkflows \? \{ intentWorkflows: resolved\.intentWorkflows as Record<string, IntentWorkflow> \} : \{\}\)/);
  });
});
