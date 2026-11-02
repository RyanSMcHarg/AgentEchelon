/**
 * THE CATALOG SAYS WHAT EACH INTENT AND EACH TASK STEP DOES (SPEC-ADMIN-CONSOLE "Assistants": Scope and models,
 * Task workflows).
 *
 * The assistant page shows each intent's purpose, its answering instructions and the machine a multi-step intent runs,
 * and each machine's steps: who a step waits on, what it needs, what it delivers and where it goes next. All of it is
 * read from the pack the router reads and the machines the runtime authorizes transitions against, on the classification
 * catalog the profile listing already serves, so the page cannot describe a step the runtime does not run.
 */
import { PutParameterCommand } from '@aws-sdk/client-ssm';
import { classificationCatalog, machineSteps } from '../../lambda/src/lib/classification-catalog';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import { getModelCatalog } from '../../lib/config/model-strategy';
import { fakeSsmStore } from '../helpers/fake-ssm-store';

const ROOT = '/agent-echelon';
const keys = Object.keys(getModelCatalog('us-east-1', '123456789012'));
const lambda = { send: async () => ({}) } as never;

const PACK = {
  intents: [
    {
      key: 'report_generation', description: 'User wants a written report.', summary: 'A report, delivered as a document',
      keywords: ['report'], delivery: 'TASK_MULTI_STEP', instructions: 'Confirm the subject first.',
    },
    { key: 'financial_metric', description: 'One number.', keywords: ['arr'], delivery: 'PLACEHOLDER_UPDATE' },
    // Multi-step, with no machine of its own name: the page says multi-step and names no machine.
    { key: 'orphan_task', description: 'No machine.', keywords: ['orphan'], delivery: 'TASK_MULTI_STEP' },
  ],
};

async function catalogWithPack() {
  const store = fakeSsmStore();
  await store.client.send(new PutParameterCommand({ Name: `${ROOT}/assistant/standard/assistant-intent-pack`, Value: JSON.stringify(PACK), Type: 'String' }));
  return classificationCatalog(store.client, lambda, ROOT, 'standard', keys);
}

describe('each intent of the pack, with what it is for', () => {
  it('carries the description, summary, instructions, what it hands over and the machine a multi-step intent opens', async () => {
    const c = await catalogWithPack();
    expect(c.intents).toEqual([
      {
        key: 'report_generation', description: 'User wants a written report.', summary: 'A report, delivered as a document',
        instructions: 'Confirm the subject first.', multiStep: true, machine: 'report_generation', needs: 'document',
      },
      { key: 'financial_metric', description: 'One number.', multiStep: false },
      { key: 'orphan_task', description: 'No machine.', multiStep: true },
    ]);
    // The keys alone stay where a reader of them already looks.
    expect(c.packIntents).toEqual(['report_generation', 'financial_metric', 'orphan_task']);
  });

  it('serves no intents for a classification with no pack of its own, as it serves no pack keys', async () => {
    const c = await classificationCatalog(fakeSsmStore().client, lambda, ROOT, 'standard', keys);
    expect(c.intents).toBeUndefined();
    expect(c.packIntents).toBeUndefined();
  });
});

describe('each step of a machine', () => {
  it('reads who the step waits on, what it needs, what it delivers and where it goes', () => {
    const steps = machineSteps(DEFAULT_TASK_STATE_MACHINES.report_generation);
    expect(steps.map((s) => s.key)).toEqual(Object.keys(DEFAULT_TASK_STATE_MACHINES.report_generation.states));
    const first = steps.find((s) => s.key === 'collecting_requirements')!;
    expect(first.awaits).toBe('requester');
    expect(first.requires).toEqual(['the subject', 'the audience', 'the length or format']);
    expect(first.prompt).toBe(DEFAULT_TASK_STATE_MACHINES.report_generation.states.collecting_requirements.prompt);
    const delivering = steps.filter((s) => s.produces === 'document');
    expect(delivering.length).toBeGreaterThan(0);
    for (const s of delivering) expect(s.templates?.length ?? 0).toBeGreaterThan(0);
    const done = steps.find((s) => s.terminal === 'success')!;
    expect(done.reopens).toEqual(DEFAULT_TASK_STATE_MACHINES.report_generation.states[done.key].reopens);
  });

  it('serves every machine with its steps on the catalog', async () => {
    const c = await catalogWithPack();
    const report = c.workflows!.find((w) => w.key === 'report_generation')!;
    expect(report.steps.map((s) => s.key)).toEqual(report.states);
    expect(report.source).toBe('platform');
  });
});
