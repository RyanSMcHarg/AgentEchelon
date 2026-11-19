/**
 * AN INTENT OPENS A TASK ONLY WHERE ITS WORKFLOW DOES (ADR-067 stage 4).
 *
 * What it proves: every multi-step intent has a declared workflow, the standard one written out where a new version
 * declares none, and one missing is refused where a body store holds them; the author decides whether a request opens a
 * task, so a single-turn intent may have a workflow that opens no task of the request's own (DENY: one that opens it);
 * the retired selection is carried as single-turn intents, their workflows going with it; the intent workflows are a body
 * the store holds and the runtime reads back, refusing to serve a version whose pointer it did not follow; and the
 * router runs a single-turn intent's workflow beside its one-turn answer.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  canonicalIntentWorkflow, intentWorkflowErrors, versionIntentWorkflowsErrors, withIntentWorkflowsDeclared, type IntentWorkflow,
} from '../../lambda/src/lib/intent-workflow';
import { inCurrentForm } from '../../lambda/src/lib/retired-fields';
import { hydrateBodies, offloadBodies } from '../../lambda/src/lib/profile-bodies';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import type { ProfileDefinition } from '../../lambda/src/lib/active-profile';

const SEND_ONLY: IntentWorkflow = {
  on: { intent: 'greeting' },
  initial: 'thank',
  states: {
    thank: { send: { to: 'requester', template: 'workflow-step-withheld' }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
} as unknown as IntentWorkflow;

describe('every multi-step intent declares its workflow', () => {
  it('a new version writes out the standard workflow for each multi-step intent that declares none, and keeps its own', () => {
    const own = { report_generation: { ...canonicalIntentWorkflow('report_generation'), initial: 'work' } };
    const out = withIntentWorkflowsDeclared(own, ['report_generation', 'image_generation'])!;
    expect(out.report_generation).toBe(own.report_generation);
    expect(out.image_generation).toEqual(canonicalIntentWorkflow('image_generation'));
    expect(withIntentWorkflowsDeclared(undefined, [])).toBeUndefined();
  });

  it('DENY: a multi-step intent with no workflow is refused where a body store holds them, and asked for nowhere else', () => {
    const opts = { multiStepIntents: ['report_generation'], machines: DEFAULT_TASK_STATE_MACHINES };
    expect(versionIntentWorkflowsErrors(undefined, { ...opts, requireDeclared: true }))
      .toEqual(['intentWorkflows has no workflow for report_generation, a multi-step intent: declare one, or make report_generation single-turn']);
    expect(versionIntentWorkflowsErrors(undefined, opts)).toEqual([]);
  });
});

describe('the author decides whether a request opens a task', () => {
  const opts = { multiStepIntents: ['report_generation'], intents: ['report_generation', 'greeting', 'image_generation'], machines: DEFAULT_TASK_STATE_MACHINES };

  it('a single-turn intent may have a workflow that opens no task of the request\'s own', () => {
    expect(intentWorkflowErrors('greeting', SEND_ONLY, opts)).toEqual([]);
  });

  it('DENY: a single-turn intent\'s workflow does not open the request\'s own task', () => {
    expect(intentWorkflowErrors('image_generation', canonicalIntentWorkflow('image_generation'), opts).join())
      .toMatch(/which a single-turn intent does not: make image_generation multi-step to open it/);
  });

  it('DENY: a multi-step intent\'s workflow opens the request\'s own task', () => {
    expect(intentWorkflowErrors('report_generation', { ...SEND_ONLY, on: { intent: 'report_generation' } }, opts).join())
      .toMatch(/exactly one task step \(found 0\); make report_generation single-turn/);
  });
});

describe('the retired selection', () => {
  it('becomes single-turn intents in the version\'s own pack, their workflows going with it', () => {
    const body = {
      workflows: ['report_generation'],
      intentPack: { intents: [
        { key: 'report_generation', delivery: 'TASK_MULTI_STEP' },
        { key: 'image_generation', delivery: 'TASK_MULTI_STEP' },
        { key: 'greeting', delivery: 'DIRECT' },
      ] },
      intentWorkflows: { report_generation: canonicalIntentWorkflow('report_generation'), image_generation: canonicalIntentWorkflow('image_generation') },
    } as never;
    const out = inCurrentForm(body);
    expect(out.rewritten).toEqual(['workflows', 'intentPack.intents.image_generation.delivery']);
    expect((out.body as { workflows?: unknown }).workflows).toBeUndefined();
    expect((out.body.intentPack as { intents: Array<{ key: string; delivery: string }> }).intents.map((i) => `${i.key}:${i.delivery}`))
      .toEqual(['report_generation:TASK_MULTI_STEP', 'image_generation:PLACEHOLDER_UPDATE', 'greeting:DIRECT']);
    expect(Object.keys(out.body.intentWorkflows ?? {})).toEqual(['report_generation']);
  });

  it('a version whose pack is the classification\'s is handed it to carry the selection', () => {
    const out = inCurrentForm({ workflows: ['image_generation'] } as never, { pack: { intents: [{ key: 'report_generation', delivery: 'TASK_MULTI_STEP' }] } });
    expect((out.body.intentPack as { intents: Array<{ delivery: string }> }).intents[0].delivery).toBe('PLACEHOLDER_UPDATE');
  });

  it('an empty selection allowed every workflow, so it is dropped and no intent changes', () => {
    const out = inCurrentForm({ workflows: [] } as never, { pack: { intents: [{ key: 'report_generation', delivery: 'TASK_MULTI_STEP' }] } });
    expect((out.body as { workflows?: unknown }).workflows).toBeUndefined();
    expect(out.body.intentPack).toBeUndefined();
  });
});

describe('the intent workflows are a body the store holds', () => {
  it('are written to the store and read back whole, and the definition keeps only the pointer', async () => {
    const objects = new Map<string, string>();
    const s3 = { send: async (cmd: { input: { Key: string; Body?: string } }) => {
      if (cmd.input.Body !== undefined) { objects.set(cmd.input.Key, cmd.input.Body); return {}; }
      const body = objects.get(cmd.input.Key);
      return { Body: body === undefined ? undefined : { transformToString: async () => body } };
    } };
    const deps = { s3: s3 as never, bucket: 'bodies' };
    const def = { profileName: 'analyst', configId: 'cfg1', intentWorkflows: { greeting: SEND_ONLY } } as unknown as ProfileDefinition;
    const stored = await offloadBodies(def, deps);
    expect(stored.intentWorkflows).toBeUndefined();
    expect(stored.intentWorkflowsRef).toEqual({ key: 'profiles/analyst/cfg1/intentWorkflows', configId: 'cfg1' });
    expect((await hydrateBodies(stored, deps)).intentWorkflows).toEqual({ greeting: SEND_ONLY });
    await expect(hydrateBodies({ ...stored, intentWorkflowsRef: { key: 'profiles/analyst/cfg1/missing', configId: 'cfg1' } } as ProfileDefinition, deps))
      .rejects.toThrow(/Refusing to resolve the version without the intent workflows it declares/);
  });
});

describe('the router', () => {
  it('runs a single-turn intent\'s workflow beside its one-turn answer, opening no task of its own', () => {
    const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    expect(router).toMatch(/if \(deliveryOption !== DeliveryOption\.TASK_MULTI_STEP && !battleSide && !hasActiveTask && channelArn\s+&& turnVersionForTasks\?\.intentWorkflows\?\.\[classification\.intent\]\) \{\s+\/\/[^\n]*\n\s+const sideVersion = turnVersionForTasks;\s+sideRun = inboundTaskFields\(\)\.then\(\(fields\) => startIntentRun\(/);
    expect(router).toMatch(/open: async \(\) => \{ throw new Error\('a single-turn intent opens no task of its own'\); \}/);
  });
});
