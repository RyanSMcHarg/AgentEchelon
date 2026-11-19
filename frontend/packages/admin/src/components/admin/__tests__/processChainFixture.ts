import { SHIPPED_EVENT_WORKFLOWS } from '../../../../../../../backend/lambda/src/lib/event-workflow.ts';
/**
 * A PROCESS WITH PARALLEL WORK, for the console's tests (not shipped): `kickoff` opens two conversations at once (a fork) and
 * goes on alongside a notes task, then joins all three; `alpha-room` opens `gamma-room` and does not wait for it (alongside).
 */
export const PARALLEL_WORKFLOWS: Record<string, unknown> = {
  kickoff: {
    on: 'event-received', types: ['team'], initial: 'notes',
    states: {
      notes: { label: 'Notes', task: { machine: 'acknowledgement', by: { participantRole: 'lead:team' }, continue: 'alongside', deadline: { afterMinutes: 60 } }, onSuccess: 'open-alpha', onFailure: 'open-alpha' },
      'open-alpha': { open: { type: 'alpha', for: { typeRole: 'lead:alpha' } }, onSuccess: 'open-beta', onFailure: 'open-beta' },
      'open-beta': { open: { type: 'beta', for: { typeRole: 'lead:beta' } }, onSuccess: 'both', onFailure: 'both' },
      both: { label: 'Everything is in', wait: { join: { of: ['open-alpha', 'open-beta', 'notes'], when: 'all' } }, onSuccess: 'done', onFailure: 'done' },
      done: { disposition: 'success' },
    },
  },
  'alpha-room': {
    on: 'conversation-opened', types: ['alpha'], initial: 'work',
    states: {
      work: { label: 'Alpha work', task: { machine: 'acknowledgement', by: { participantRole: 'lead:alpha' }, deadline: { afterMinutes: 30 } }, onSuccess: 'open-gamma', onFailure: 'done' },
      'open-gamma': { open: { type: 'gamma', for: { typeRole: 'lead:gamma' } }, onSuccess: 'done', onFailure: 'done' },
      done: { disposition: 'success' },
    },
  },
  'beta-room': {
    on: 'conversation-opened', types: ['beta'], initial: 'work',
    states: { work: { label: 'Beta work', task: { machine: 'acknowledgement', by: { participantRole: 'lead:beta' }, deadline: { afterMinutes: 30 } }, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' } },
  },
  'gamma-room': {
    on: 'conversation-opened', types: ['gamma'], initial: 'work',
    states: { work: { label: 'Gamma work', task: { machine: 'acknowledgement', by: { participantRole: 'lead:gamma' }, deadline: { afterMinutes: 30 } }, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' } },
  },
};
export const PARALLEL_ORDER = ['kickoff', 'alpha-room', 'beta-room', 'gamma-room'];

/**
 * AN INCIDENT THAT TRIAGES IN THE TEAM CONVERSATION FIRST, for the console's stage tests (not shipped): the shipped
 * `incident-triage` with a labeled triage card in front of its open step, the shape a team may still declare. The shipped
 * incident opens its conversation at once and holds no stage of its own, so the stage reads that need a
 * labeled step in the team's run read this one.
 */
const SHIPPED_TRIAGE = SHIPPED_EVENT_WORKFLOWS['incident-triage'];
export const TRIAGE_FIRST_WORKFLOWS: typeof SHIPPED_EVENT_WORKFLOWS = {
  ...SHIPPED_EVENT_WORKFLOWS,
  'incident-triage': {
    ...SHIPPED_TRIAGE,
    initial: 'triage',
    states: {
      triage: {
        label: 'Triage', description: 'The on-call confirms the scope and whether customers are impacted.',
        task: { machine: 'customer_impact', by: { participantRole: 'on-call:ops' }, assigned: { template: 'incident-triage' }, deadline: { afterMinutes: 30 } },
        onSuccess: 'open', onFailure: 'done',
      },
      ...SHIPPED_TRIAGE.states,
    },
  } as (typeof SHIPPED_EVENT_WORKFLOWS)['incident-triage'],
};
