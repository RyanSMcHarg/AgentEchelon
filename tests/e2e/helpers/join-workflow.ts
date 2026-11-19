/**
 * THE WORKFLOW THE JOIN E2E RUNS (SPEC-PROCESSES P14), declared here and not shipped: an alarm in the ops team's conversation
 * opens two checks for the on-call beside each other (`continue: 'alongside'`), and the run goes on only once both are in
 * (`wait: { join: { when: 'all' } }`). Its process links it, so the Processes view reads the join's outcome from the run's end.
 *
 * Plain data, so the unit suite validates the very workflow the deployed spec installs.
 */
import type { EventWorkflow, VersionProcess } from '../../../backend/lambda/src/lib/event-workflow';

export const JOIN_E2E_WORKFLOW = 'e2e-two-checks';
export const JOIN_E2E_PROCESS = 'e2e-two-checks';
export const JOIN_E2E_PARTS = ['first-check', 'second-check'] as const;
export const JOIN_E2E_STEP = 'both-in';

const check = (label: string, next: string) => ({
  label,
  task: { machine: 'acknowledgement', by: { participantRole: 'on-call:ops' }, continue: 'alongside', assigned: { template: 'incident-investigation' }, deadline: { afterMinutes: 60 } },
  onSuccess: next, onFailure: next,
});

export function joinE2eWorkflow(): EventWorkflow {
  return {
    on: 'event-received',
    types: ['ops-team'],
    initial: JOIN_E2E_PARTS[0],
    states: {
      [JOIN_E2E_PARTS[0]]: check('First check', JOIN_E2E_PARTS[1]),
      [JOIN_E2E_PARTS[1]]: check('Second check', JOIN_E2E_STEP),
      [JOIN_E2E_STEP]: {
        label: 'Both checks in', wait: { join: { of: [...JOIN_E2E_PARTS], when: 'all', minutes: 60 } },
        onSuccess: 'done', onFailure: 'done', onDeadline: 'done',
      },
      done: { disposition: 'success' },
    },
  } as unknown as EventWorkflow;
}

export function joinE2eProcess(): Record<string, VersionProcess> {
  return { [JOIN_E2E_PROCESS]: { label: 'Two checks', description: 'An alarm asks the on-call for two checks at once; the run goes on once both are in.', workflows: [JOIN_E2E_WORKFLOW] } };
}
