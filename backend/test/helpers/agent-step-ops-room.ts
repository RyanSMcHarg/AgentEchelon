/**
 * AN OPS ROOM WHOSE FIRST LOOK IS AN AGENT STEP THAT OPENS AN EVENT TASK: a fixture of the stored shape that stays
 * supported. A version stored before the first look became a task step carries this workflow word for word: the agent
 * step names the machine it opens (`workflow: 'incident_first_look'`), the role that takes it (`as: { role: 'ops' }`),
 * its tool, its deadline, and the fallback and absent messages it posts.
 *
 * Tests that prove what an agent step does (role dispatch, fallback, deadline, the absent message, the task it opens)
 * read it here, so each keeps proving that path whatever shape the shipped `ops-room` takes.
 */
import { SHIPPED_EVENT_WORKFLOWS, type EventWorkflow } from '../../lambda/src/lib/event-workflow';

const shipped = SHIPPED_EVENT_WORKFLOWS['ops-room'];

export const AGENT_STEP_OPS_ROOM: Readonly<EventWorkflow> = Object.freeze({
  on: shipped.on,
  types: shipped.types,
  initial: 'opening',
  states: {
    // The opening as the stored shape had it: a conversation a workflow opened goes straight to its first look.
    opening: {
      send: shipped.states.opening.send,
      onSuccess: [{ to: 'first-look', when: { 'event:openedBy': 'workflow' } }, { to: 'greet-lead' }],
      onFailure: [{ to: 'first-look', when: { 'event:openedBy': 'workflow' } }, { to: 'greet-lead' }],
    },
    'greet-lead': shipped.states['greet-lead'],
    'first-look': {
      agent: {
        prompt: 'ops-first-look',
        workflow: 'incident_first_look',
        as: { role: 'ops' },
        tools: ['read_deployment_health'],
        to: 'room',
        deadlineMs: 20_000,
        fallback: { send: { to: 'room', template: 'ops-first-look-unavailable' }, absent: { to: 'room', template: 'ops-assistant-absent' } },
      },
      onSuccess: 'done',
      onFailure: 'done',
    },
    done: { disposition: 'success' },
  },
} as EventWorkflow);
