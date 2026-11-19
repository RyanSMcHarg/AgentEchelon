/**
 * AN EVENT STEP OPENS A TASK THE ROOM WORKS ON (ADR-061 decision 8, the agent step's `workflow:`; example (a)).
 *
 * What it proves:
 *  - `incident_first_look` is a platform machine whose first step awaits nobody, because a task an event opens has no
 *    requester, and every machine an event may open is declared and valid;
 *  - the shipped first look opens that machine as a task step the ops assistant holds; a stored agent-step first look
 *    names it (`AGENT_STEP_OPS_ROOM`), which the runtime runs, while `agent.workflow` is retired and refused on a draft,
 *    and its current form is the task step that validates;
 *  - the runtime opens the task before the turn, once per step of a run, owned by the assistant and visible to the room,
 *    and hands the turn the first step's instructions and its one transition; a task that cannot be opened leaves the
 *    turn to run as a plain agent step;
 *  - opening it is the runtime's act: the processor opens it before the model call and advances it once the turn
 *    posted, never on a fallback;
 *  - a version that selects its task workflows offers the machine its event step opens;
 *  - an intent pack declares no event workflow (decision 1 puts them on the version).
 */
import * as fs from 'fs';
import * as path from 'path';
import { EVENT_TASK_MACHINES, SHIPPED_EVENT_WORKFLOWS, eventWorkflowErrors, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import { DEFAULT_TASK_STATE_MACHINES, validateTaskStateMachine } from '../../lambda/src/lib/task-state-machines';
import { eventTaskId, openEventTask } from '../../lambda/src/lib/event-task';
import { welcomeWorkflowErrors } from '../../lambda/src/lib/profile-lifecycle';
import { validateIntentPackBody } from '../../lambda/src/lib/intent-pack';
import { workflowInCurrentForm } from '../../lambda/src/lib/retired-fields';
import { AGENT_STEP_OPS_ROOM } from '../helpers/agent-step-ops-room';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai';
const CHANNEL = `${APP}/channel/ch-1`;
const BOT = `${APP}/bot/ops-bot`;
const OPS = SHIPPED_EVENT_WORKFLOWS['ops-room'];
/** The stored shape whose agent step opens the task (`workflow:`), which the runtime runs and a draft may not declare. */
const AGENT_OPS = AGENT_STEP_OPS_ROOM;
const retired = (name: string, step: string) =>
  `eventWorkflows.${name}.states.${step}.agent.workflow is retired: open the task with a task step (task: { machine, by, continue: opened })`;

describe('the machines an event may open', () => {
  it('each is a declared, valid platform machine whose first step awaits nobody', () => {
    expect(EVENT_TASK_MACHINES).toEqual(['incident_first_look']);
    for (const key of EVENT_TASK_MACHINES) {
      const m = DEFAULT_TASK_STATE_MACHINES[key];
      expect(m).toBeDefined();
      expect(() => validateTaskStateMachine(key, m)).not.toThrow();
      expect(m.states[m.initial].awaits).toBeUndefined();
      expect(m.states[m.initial].awaitsUser).toBeUndefined();
    }
  });

  it('the first look reads the deployment\'s health, then rests on its findings as the room\'s work', () => {
    const m = DEFAULT_TASK_STATE_MACHINES.incident_first_look;
    expect(m.initial).toBe('reading_health');
    expect(m.states.reading_health).toMatchObject({ transitions: ['findings_shared'], tools: ['read_deployment_health', 'publish_dashboard'], auto: 'findings_shared' });
    expect(m.states.findings_shared.transitions.sort()).toEqual(['reading_health', 'resolved']);
    expect(m.states.resolved.terminal).toBe('success');
  });
});

describe('the shipped first look is a task step that opens it', () => {
  it('the ops room\'s first look asks the ops assistant for incident_first_look, and validates', () => {
    expect(OPS.states['first-look'].agent).toBeUndefined();
    expect(OPS.states['first-look'].task).toEqual({ machine: 'incident_first_look', by: { assistantRole: 'ops' }, continue: 'opened' });
    expect(eventWorkflowErrors('ops-room', OPS)).toEqual([]);
  });
});

describe('an agent step that names the task it opens is retired on a draft', () => {
  it('a stored agent-step first look names incident_first_look, a draft is refused it, and its current form is the task step that validates', () => {
    expect(AGENT_OPS.states['first-look'].agent!.workflow).toBe('incident_first_look');
    expect(eventWorkflowErrors('ops-room', AGENT_OPS)).toEqual(expect.arrayContaining([retired('ops-room', 'first-look')]));
    const current = workflowInCurrentForm(AGENT_OPS).workflow;
    expect(current.states['first-look'].agent).toBeUndefined();
    // A REQUEST TO THE OPS ASSISTANT: who sees the work is the owner's to declare (WT118).
    expect(current.states['first-look'].task).toEqual({ machine: 'incident_first_look', by: { assistantRole: 'ops' }, continue: 'opened' });
    expect(eventWorkflowErrors('ops-room', current)).toEqual([]);
  });

  it('refuses agent.workflow on a draft whatever machine it names and wherever the step posts', () => {
    const other: EventWorkflow = clone(AGENT_OPS);
    other.states['first-look'].agent!.workflow = 'guided_troubleshooting';
    expect(eventWorkflowErrors('o', other)).toContain(retired('o', 'first-look'));
    const private_: EventWorkflow = clone(AGENT_OPS);
    private_.states['first-look'].agent!.to = { participantRole: 'lead' };
    private_.states['first-look'].agent!.fallback.send.to = { participantRole: 'lead' };
    expect(eventWorkflowErrors('p', private_)).toContain(retired('p', 'first-look'));
    const chase = clone(SHIPPED_EVENT_WORKFLOWS['chase-unredeemed']);
    chase.states['draft-nudge'].agent!.workflow = 'incident_first_look';
    expect(eventWorkflowErrors('c', chase)).toContain(retired('c', 'draft-nudge'));
  });

  it('a version that selects its task workflows offers the one its event step opens', () => {
    const body = { modelKey: 'x', eventWorkflows: { mine: clone(OPS) } };
    expect(welcomeWorkflowErrors({ ...body, workflows: ['guided_troubleshooting'] } as never).join()).toMatch(/opens a incident_first_look task, which this version's workflows do not include/);
    expect(welcomeWorkflowErrors({ ...body, workflows: ['incident_first_look'] } as never).join()).not.toMatch(/incident_first_look task/);
    expect(welcomeWorkflowErrors(body as never).join()).not.toMatch(/incident_first_look task/);
    // The stored agent step that opens it is held to the same selection.
    const stored = { modelKey: 'x', eventWorkflows: { mine: clone(AGENT_OPS) } };
    expect(welcomeWorkflowErrors({ ...stored, workflows: ['guided_troubleshooting'] } as never).join()).toMatch(/opens a incident_first_look task, which this version's workflows do not include/);
    expect(welcomeWorkflowErrors({ ...stored, workflows: ['incident_first_look'] } as never).join()).not.toMatch(/incident_first_look task/);
  });
});

describe('the runtime opens it', () => {
  it('once per step of a run, owned by the assistant, visible to the room, with its first step\'s instructions and one transition', async () => {
    const calls: unknown[][] = [];
    const create = (async (...args: unknown[]) => { calls.push(args); return { taskId: (args[4] as { taskId: string }).taskId, channelArn: CHANNEL } as never; }) as never;
    const opened = await openEventTask({ machine: 'incident_first_look', channelArn: CHANNEL, runKey: 'conversation-opened#ch-1#ops', step: 'first-look', botArn: BOT, excerpt: 'Report latency' }, { create });
    expect(opened?.next).toBe('findings_shared');
    expect(opened?.stepPrompt).toMatch(/read_deployment_health/);
    const [event, , taskType, , opts] = calls[0] as [Record<string, unknown>, string, string, unknown, Record<string, unknown>];
    expect(taskType).toBe('incident_first_look');
    expect(event).toEqual({ requestAttributes: { 'CHIME.channel.arn': CHANNEL } });
    expect(opts).toMatchObject({ taskId: eventTaskId('conversation-opened#ch-1#ops', 'first-look'), owner: { id: 'ops-bot', type: 'assistant' }, assistantId: 'ops-bot', visibility: 'conversation', requestExcerpt: 'Report latency' });
    expect(eventTaskId('k', 'first-look')).toBe(eventTaskId('k', 'first-look'));
    expect(eventTaskId('k', 'first-look')).not.toBe(eventTaskId('k2', 'first-look'));
  });

  it('opens nothing for a machine no event may open, and leaves the turn to run when the task cannot be opened', async () => {
    const create = (async () => { throw new Error('refused'); }) as never;
    expect(await openEventTask({ machine: 'guided_troubleshooting', channelArn: CHANNEL, runKey: 'k', step: 's', botArn: BOT }, { create })).toBeUndefined();
    expect(await openEventTask({ machine: 'incident_first_look', channelArn: CHANNEL, runKey: 'k', step: 's', botArn: BOT }, { create })).toBeUndefined();
  });

  it('the processor opens it before the model call, and advances it only once the turn posted', () => {
    const proc = read('assistant-async-processor.ts');
    const at = (t: string) => proc.indexOf(t);
    expect(at('const opened = def.workflow && !narrowed ? await openEventTask({')).toBeGreaterThan(-1);
    expect(at('const opened = def.workflow')).toBeLessThan(at('const run = await runAgentStep({'));
    expect(proc).toMatch(/if \(opened && run\.won && run\.outcome === 'posted' && opened\.next\) \{/);
    expect(proc).toMatch(/by: 'system', reason: 'the event step that opened the task ran its first step'/);
  });
});

describe('an intent pack declares no event workflow', () => {
  it('is refused with where event workflows live', () => {
    const pack = { extends: 'default', intents: [{ key: 'thing', description: 'A thing', keywords: ['thing'], delivery: 'DIRECT' }], eventWorkflows: { x: {} } };
    expect(validateIntentPackBody(pack).join()).toMatch(/an intent pack declares no event workflows; they live on an assistant's version/);
    const { eventWorkflows: _e, ...plain } = pack;
    expect(validateIntentPackBody(plain).join()).not.toMatch(/eventWorkflows/);
  });
});
