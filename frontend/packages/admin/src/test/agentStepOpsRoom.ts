/**
 * A TEST FIXTURE: the ops room an event opened, whose first look is an AGENT STEP, the room's own assistant's turn reading
 * the deployment's health, with a deadline and its fallback message. No step runs as another assistant (WT118). It is the
 * shipped `ops-room`'s opening and lead greeting, each going on by a plain edge, then the agent step and the end: the
 * shipped room opens its first look with a task step (ADR-067 stage 2) and gives a room a workflow opened its incident owner's
 * task, call offer and runbook, and a draft never carries an agent step that opens a task (`agent.workflow` is retired and
 * rewritten, ADR-067 stage 4), so the console's agent-step tests read an agent step of the current form from here. The
 * shipped workflows themselves are read in `the-shipped-workflows-edit-validly.test.ts`.
 */
import { SHIPPED_EVENT_WORKFLOWS, type EventWorkflow } from '../../../../../backend/lambda/src/lib/event-workflow.ts';

export function agentStepOpsRoom(): EventWorkflow {
  const shipped = JSON.parse(JSON.stringify(SHIPPED_EVENT_WORKFLOWS['ops-room'])) as EventWorkflow;
  const { opening, 'greet-lead': greetLead, done } = shipped.states;
  return {
    ...shipped,
    states: {
      opening: { ...opening, onSuccess: 'greet-lead', onFailure: 'greet-lead' },
      'greet-lead': greetLead,
      'first-look': {
        agent: {
          prompt: 'ops-first-look',
          tools: ['read_deployment_health'],
          to: 'room',
          deadlineMs: 20_000,
          fallback: { send: { to: 'room', template: 'ops-first-look-unavailable' } },
        },
        onSuccess: 'done',
        onFailure: 'done',
      },
      done,
    },
  } as EventWorkflow;
}
