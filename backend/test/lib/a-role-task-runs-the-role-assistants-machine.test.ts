/**
 * A TASK GIVEN TO AN ASSISTANT ROLE RUNS THAT ASSISTANT'S OWN MACHINE (ADR-067 WT78, G11).
 *
 * What it proves: an assistant's advertisement marks each intent it advertises that opens a task (`multiStep`); a
 * workflow step that asks a role for work starts the role assistant's own run on its served version, whose task runs that
 * version's machine, for an intent that assistant advertises as multi-step, and fails its step otherwise; and the asking
 * run reads the role assistant's advertisement, never its definition, to decide (WT118).
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { projectAdvertisement } from '../../lambda/src/lib/assistant-advertisement';

describe('the advertisement says which intents open a task', () => {
  it('marks a multi-step intent, and leaves a single-turn one unmarked', () => {
    const ad = projectAdvertisement({
      assistant: 'ops-premium', displayName: 'Ops',
      pack: { intents: [
        { key: 'incident_review', description: 'd', keywords: [], delivery: 'TASK_MULTI_STEP', summary: 'Review an incident' },
        { key: 'health_check', description: 'd', keywords: [], delivery: 'DIRECT', summary: 'Check health now' },
      ] } as never,
    });
    expect(ad.intents).toEqual([
      { key: 'incident_review', summary: 'Review an incident', multiStep: true },
      { key: 'health_check', summary: 'Check health now' },
    ]);
  });
});

describe('the step opens the task on the role assistant\'s version', () => {
  const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
  const fn = router.slice(router.indexOf('async function openWorkflowTaskStep('), router.indexOf('async function openWorkflowTaskStep(') + 6000);
  const ask = router.slice(router.indexOf('async function askAnother('), router.indexOf('async function openWorkflowTaskStep('));

  it('reads the role assistant\'s advertisement and fails the step where the intent is not one it advertises', () => {
    // The holder's own assistant, or the run's own where the run's assistant holds the role.
    expect(fn).toMatch(/const ad = await readAdvertisement\(takerAssistant\)/);
    expect(fn).toMatch(/const advertised = ad\?\.intents\.find\(\(i\) => i\.key === def\.machine\);\s*if \(!advertised\) \{[\s\S]{0,300}return 'failed';/);
  });

  it('the owner\'s own run takes the machine and the origin from that assistant\'s served version', () => {
    expect(fn).not.toMatch(/resolveActiveProfile\(taker\.assistant/);
    expect(ask).toMatch(/const served = await servedWelcomeVersion\(taker\.assistant, ctx\.channelArn\)/);
    expect(ask).toMatch(/const machineDef = versionDeclaredMachines\(served\.version\.intentPack\)\?\.\[def\.machine\];/);
    expect(ask).toMatch(/const originConfigId = originConfigIdOf\(served\.version\);/);
  });
});
