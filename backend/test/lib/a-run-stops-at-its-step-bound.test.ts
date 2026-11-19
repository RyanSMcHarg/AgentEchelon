/**
 * A RUN STOPS AT ITS STEP BOUND (ADR-067 decision 9, WT16).
 *
 * What it proves: whatever graph a run is handed, it takes at most `MAX_EVENT_RUN_STEPS` steps, and one more for the join
 * recap a `person-joined` workflow is given, and then stops without ending, so a chain longer than a version may declare
 * never runs past the bound; and a version may not declare more steps than that.
 */
import { MAX_EVENT_RUN_STEPS, runEventWorkflow, versionEventWorkflowsErrors, type EventRunDeps, type EventWorkflow } from '../../lambda/src/lib/event-workflow';

const LONG = 40;
const chain: EventWorkflow = {
  on: 'person-joined',
  initial: 's0',
  states: Object.fromEntries([
    ...Array.from({ length: LONG }, (_, i) => [`s${i}`, { send: { to: 'joined', template: 'workflow-step-withheld' }, onSuccess: `s${i + 1}`, onFailure: `s${i + 1}` }]),
    [`s${LONG}`, { disposition: 'success' }],
  ]),
} as unknown as EventWorkflow;

describe('a run\'s step bound', () => {
  it('stops a run at the bound, one step past it for a join recap, without ending it', async () => {
    const sent: string[] = [];
    const d: EventRunDeps = {
      claimRun: async () => true, claimStep: async () => true, mentionName: async () => '', dispatchAgent: async () => true,
      send: async ({ step }) => { sent.push(step); return true; },
    };
    const out = await runEventWorkflow('long', chain, { event: 'person-joined', channelArn: 'arn:c', eventPerson: 'arn:x/user/p', values: {} }, d);
    expect(out.steps).toHaveLength(MAX_EVENT_RUN_STEPS + 1);
    expect(sent).toHaveLength(MAX_EVENT_RUN_STEPS + 1);
    expect(out.ended).toBeUndefined();
  });

  it('a version may not declare a run longer than the bound', () => {
    expect(versionEventWorkflowsErrors({ long: chain }).join('\n')).toMatch(/has at most \d+ steps/);
  });
});
