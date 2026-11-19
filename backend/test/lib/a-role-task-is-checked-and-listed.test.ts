/**
 * A TASK GIVEN TO AN ASSISTANT ROLE IS CHECKED AT VALIDATE AND LISTED FOR THAT ROLE (ADR-067 G11, WT78).
 *
 * What it proves: Validate says, never refuses, a task step (in an event workflow or an intent's) that gives a role's
 * assistant a task on an intent that assistant does not advertise as multi-step, reading the advertisement once per
 * assistant and nothing else of its definition; a role with no assistant here is left to the step-role warning; and an
 * active version's listing names each such step by workflow, step, role and intent, so the role's assistant lists the
 * tasks it is given without reading another definition.
 */
import { eventWorkflowsListedOf, roleTaskWarnings } from '../../lambda/src/lib/profile-lifecycle';
import type { AssistantAdvertisement } from '../../lambda/src/lib/assistant-advertisement';

const opsTask = (machine: string) => ({
  on: 'conversation-opened', types: ['ops'], initial: 'look',
  states: {
    look: { task: { machine, by: { assistantRole: 'ops' }, continue: 'opened' }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
});
const body = (machine: string) => ({
  eventWorkflows: { 'ops-room': opsTask(machine) },
  intentWorkflows: {
    support_request: {
      on: { intent: 'support_request' }, initial: 'work',
      states: {
        work: { task: { machine: 'support_request', for: 'requester' }, onSuccess: 'escalate', onFailure: 'done' },
        escalate: { task: { machine, by: { assistantRole: 'ops' }, deadline: { afterMinutes: 60 } }, onSuccess: 'done', onFailure: 'done' },
        done: { disposition: 'success' },
      },
    },
  },
});
const ad = (intents: AssistantAdvertisement['intents']): AssistantAdvertisement => ({ assistant: 'ops-standard', intents } as AssistantAdvertisement);

describe('Validate checks a role task against the role assistant\'s advertisement', () => {
  it('says each step naming an intent the role\'s assistant does not advertise, reading its advertisement once', async () => {
    const read = jest.fn(async () => ad([{ key: 'deployment_health', summary: 'a health read' }]));
    const warnings = await roleTaskWarnings(body('incident_first_look') as never, (role) => (role === 'ops' ? 'ops-standard' : undefined), read);
    expect(warnings).toEqual([
      expect.stringMatching(/^eventWorkflows\.ops-room, whose step look asks the ops assistant for incident_first_look, which that assistant does not advertise/),
      expect.stringMatching(/^intentWorkflows\.support_request, whose step escalate asks the ops assistant for incident_first_look/),
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('ops-standard');
  });

  it('says nothing where the assistant advertises it, single-turn or multi-step, or where no assistant holds the role', async () => {
    const read = jest.fn(async () => ad([{ key: 'incident_first_look', summary: 'a first look', multiStep: true }]));
    expect(await roleTaskWarnings(body('incident_first_look') as never, () => 'ops-standard', read)).toEqual([]);
    const oneTurn = jest.fn(async () => ad([{ key: 'incident_first_look', summary: 'a first look' }]));
    expect(await roleTaskWarnings(body('incident_first_look') as never, () => 'ops-standard', oneTurn)).toEqual([]);
    const none = jest.fn();
    expect(await roleTaskWarnings(body('incident_first_look') as never, () => undefined, none)).toEqual([]);
    expect(none).not.toHaveBeenCalled();
  });

  it('an advertisement that cannot be read is said, not taken as an offer', async () => {
    const warnings = await roleTaskWarnings(body('incident_first_look') as never, () => 'ops-standard', async () => null);
    expect(warnings).toHaveLength(2);
  });
});

describe('the listing names the tasks a version gives to a role', () => {
  it('by workflow, step, role and intent, from event and intent workflows alike', () => {
    const listed = eventWorkflowsListedOf(JSON.stringify(body('incident_first_look')));
    expect(listed.activeRoleTasks).toEqual([
      { workflow: 'ops-room', step: 'look', role: 'ops', machine: 'incident_first_look' },
      { workflow: 'support_request', step: 'escalate', role: 'ops', machine: 'incident_first_look' },
    ]);
  });

  it('a version that gives no role a task lists none', () => {
    expect(eventWorkflowsListedOf(JSON.stringify({ eventWorkflows: {} })).activeRoleTasks).toBeUndefined();
  });
});
