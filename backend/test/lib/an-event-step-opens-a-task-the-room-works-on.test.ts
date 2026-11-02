/**
 * AN EVENT STEP OPENS A TASK THE ROOM WORKS ON (ADR-061 decision 8, the agent step's `workflow:`; example (a)).
 *
 * What it proves:
 *  - `incident_first_look` is a platform machine whose first step awaits nobody, because a task an event opens has no
 *    requester, and every machine an event may open is declared and valid;
 *  - an agent step may name one of those machines only, only where its reader is the room, and never in a step narrowed
 *    to declared values; the ops room's first look names it;
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
import { EVENT_TASK_MACHINES, PLATFORM_EVENT_WORKFLOWS, eventWorkflowErrors, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import { DEFAULT_TASK_STATE_MACHINES, validateTaskStateMachine } from '../../lambda/src/lib/task-state-machines';
import { eventTaskId, openEventTask } from '../../lambda/src/lib/event-task';
import { welcomeWorkflowErrors } from '../../lambda/src/lib/profile-lifecycle';
import { validateIntentPackBody } from '../../lambda/src/lib/intent-pack';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai';
const CHANNEL = `${APP}/channel/ch-1`;
const BOT = `${APP}/bot/ops-bot`;
const OPS = PLATFORM_EVENT_WORKFLOWS['ops-room'];

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
    expect(m.states.reading_health).toMatchObject({ transitions: ['findings_shared'], tools: ['read_deployment_health'] });
    expect(m.states.findings_shared.transitions.sort()).toEqual(['reading_health', 'resolved']);
    expect(m.states.resolved.terminal).toBe('success');
  });
});

describe('an agent step names the task it opens', () => {
  it('the ops room\'s first look opens incident_first_look, and validates', () => {
    expect(OPS.states['first-look'].agent!.workflow).toBe('incident_first_look');
    expect(eventWorkflowErrors('ops-room', OPS)).toEqual([]);
  });

  it('only a machine an event may open, only for the room, and never in a narrowed step', () => {
    const other: EventWorkflow = clone(OPS);
    other.states['first-look'].agent!.workflow = 'guided_troubleshooting';
    expect(eventWorkflowErrors('o', other).join()).toMatch(/workflow names a task machine an event may open: incident_first_look/);
    const private_: EventWorkflow = clone(OPS);
    private_.states['first-look'].agent!.to = { participantRole: 'lead' };
    private_.states['first-look'].agent!.fallback.send.to = { participantRole: 'lead' };
    expect(eventWorkflowErrors('p', private_).join()).toMatch(/opens a task the room works on, so the step posts to the room/);
    const chase = clone(PLATFORM_EVENT_WORKFLOWS['chase-unredeemed']);
    chase.states['draft-nudge'].agent!.workflow = 'incident_first_look';
    expect(eventWorkflowErrors('c', chase).join()).toMatch(/workflow opens a task in the room, and a step whose draft reaches a person outside it/);
  });

  it('a version that selects its task workflows offers the one its event step opens', () => {
    const body = { modelKey: 'x', eventWorkflows: { mine: clone(OPS) } };
    expect(welcomeWorkflowErrors({ ...body, workflows: ['guided_troubleshooting'] } as never).join()).toMatch(/opens a incident_first_look task, which this version's workflows do not include/);
    expect(welcomeWorkflowErrors({ ...body, workflows: ['incident_first_look'] } as never).join()).not.toMatch(/incident_first_look task/);
    expect(welcomeWorkflowErrors(body as never).join()).not.toMatch(/incident_first_look task/);
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
