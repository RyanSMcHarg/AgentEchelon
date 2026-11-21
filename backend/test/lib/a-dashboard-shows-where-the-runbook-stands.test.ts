/**
 * AN INCIDENT'S DASHBOARD SHOWS WHERE ITS RUNBOOK STANDS (DESIGN-CONVERSATION-DASHBOARDS section 8).
 *
 * The run's own record is the one source: its step claims and the tasks its steps opened. These pin:
 *   - every labelled step is listed in the order the workflow declares, and nothing else;
 *   - each status is read from the record: a person's open card is waiting with their name, a settled one done with its
 *     times, a deadline timed out, a step the run never reached before its end skipped;
 *   - the section is escaped, tells each status in a word, and links a card only where there is an app to open it;
 *   - the publisher keeps the newest runbook, draws it on every publish, and a refresh draws nothing that was never published.
 */
import { labeledSteps, runbookOf, runbookClaimNames, type RunbookProgress } from '../../lambda/src/lib/runbook-progress';
import { renderRunbook, type DashboardLabels } from '../../lambda/src/lib/dashboard-render';
import { publishDashboard, refreshDashboardRunbook, dashboardLabels } from '../../lambda/src/lib/dashboard-tool';
import { SHIPPED_EVENT_WORKFLOWS, continuationClaim, RUN_END_CLAIM, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import type { Task } from '../../lambda/src/lib/task-tracking';
import type { TaskStateMachine } from '../../lambda/src/lib/task-state-machines';

const MACHINES: Record<string, TaskStateMachine> = {
  approval: {
    initial: 'pending',
    states: {
      pending: { transitions: ['approved', 'declined'] },
      approved: { transitions: [], terminal: 'success' },
      declined: { transitions: [], terminal: 'failure' },
    },
  },
};

const WF = {
  on: 'conversation-opened',
  initial: 'owner',
  states: {
    owner: { label: 'Incident owner', description: 'The on-call owns it.', task: { machine: 'approval', by: { participantRole: 'lead' } }, onSuccess: 'tell', onFailure: 'tell' },
    tell: { send: { to: 'room', template: 'x' }, onSuccess: 'wait', onFailure: 'wait' },
    wait: { label: 'Investigation complete', wait: { alongside: 'settled' }, onSuccess: 'decide', onFailure: 'done' },
    decide: { label: 'Mitigation decision', task: { machine: 'approval', by: { participantRole: 'lead' } }, onSuccess: 'confirm', onFailure: 'confirm' },
    confirm: { label: 'Customers impacted?', task: { machine: 'approval', by: { participantRole: 'lead' } }, onSuccess: 'review', onFailure: 'review' },
    review: { label: 'Post-incident review', task: { machine: 'approval', by: { participantRole: 'lead' } }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
} as unknown as EventWorkflow;

const task = (over: Partial<Task>): Task => ({
  taskId: 't', channelArn: 'c', userArn: 'u', status: 'in_progress', deliveryOption: 'channel', taskType: 'approval', taskState: 'pending',
  createdAt: '2026-11-19T10:00:00.000Z', updatedAt: '2026-11-19T10:05:00.000Z', ttl: 0, ...over,
} as Task);

describe('the runbook is read from the run\'s own record', () => {
  it('lists the labelled steps of a workflow in the order it declares them', () => {
    expect(labeledSteps(WF)).toEqual(['owner', 'wait', 'decide', 'confirm', 'review']);
    // The incident's own runbook starts with its owner and ends with its review.
    const ops = labeledSteps(SHIPPED_EVENT_WORKFLOWS['ops-room']);
    expect(ops[0]).toBe('lead-task');
    expect(ops).toContain('customer-impact');
    expect(ops.at(-1)).toBe('review');
    expect(runbookClaimNames(['a'])).toEqual(['a', continuationClaim('a'), RUN_END_CLAIM]);
  });

  it('reads each status from the claims and the tasks, with the holder of a waiting card', () => {
    const rb = runbookOf({
      workflow: 'ops-room', wf: WF, machinesOf: () => MACHINES, now: Date.parse('2026-11-19T10:30:00Z'),
      claims: { owner: 'opened', wait: 'waiting', decide: 'opened', confirm: 'opened' },
      tasks: {
        owner: task({ taskId: 'evt-owner', taskState: 'approved' }),
        decide: task({ taskId: 'evt-decide', assigneeType: 'user', assigneeId: 'p1' }),
        confirm: task({ taskId: 'evt-confirm', status: 'cancelled', error: 'deadline' } as Partial<Task>),
      },
      holders: { decide: 'Dana Ortiz' },
    });
    expect(rb.asOf).toBe('2026-11-19T10:30:00.000Z');
    expect(rb.steps.map((s) => [s.step, s.status])).toEqual([
      ['owner', 'done'], ['wait', 'in-progress'], ['decide', 'waiting'], ['confirm', 'timed-out'], ['review', 'not-started'],
    ]);
    expect(rb.steps[0]).toMatchObject({ label: 'Incident owner', description: 'The on-call owns it.', taskId: 'evt-owner', startedAt: '2026-11-19T10:00:00.000Z', settledAt: '2026-11-19T10:05:00.000Z' });
    expect(rb.steps[2]).toMatchObject({ holder: 'Dana Ortiz', taskId: 'evt-decide' });
    expect(rb.steps[2].settledAt).toBeUndefined();
  });

  it('marks a step the run ended without reaching as skipped, and one it left open and cancelled as skipped too', () => {
    const rb = runbookOf({
      workflow: 'ops-room', wf: WF, machinesOf: () => MACHINES, now: 0,
      claims: { owner: 'opened', wait: 'waiting', [continuationClaim('wait')]: 'came', [RUN_END_CLAIM]: 'success' },
      tasks: { owner: task({ taskId: 'evt-owner', status: 'cancelled', taskState: 'pending' }) },
    });
    expect(rb.steps.map((s) => s.status)).toEqual(['skipped', 'done', 'skipped', 'skipped', 'skipped']);
  });
});

const LABELS = { ...dashboardLabels(undefined, '10:30', 'Incident'), runbook: 'Runbook' } as DashboardLabels;
const RB: RunbookProgress = {
  asOf: '2026-11-19T10:30:00.000Z', workflow: 'ops-room',
  steps: [
    { step: 'owner', label: 'Incident <owner>', status: 'done', taskId: 'evt-owner', startedAt: '2026-11-19T10:00:00.000Z', settledAt: '2026-11-19T10:05:00.000Z' },
    { step: 'decide', label: 'Mitigation decision', status: 'waiting', holder: 'Dana "D" Ortiz', taskId: 'evt-decide' },
    { step: 'review', label: 'Post-incident review', status: 'not-started' },
  ],
};

describe('the runbook section', () => {
  it('escapes every word, tells each status in a word, and links each card in the app', () => {
    const html = renderRunbook(RB, LABELS, 'esc-1');
    expect(html).toContain('Incident &lt;owner&gt;');
    expect(html).not.toContain('<owner>');
    expect(html).toContain('Dana &quot;D&quot; Ortiz');
    for (const word of ['Done', 'Waiting', 'Not started']) expect(html).toContain(word);
    expect(html).toContain('href="?conversation=esc-1#task=evt-owner"');
    expect(html).toContain('href="?conversation=esc-1#task=evt-decide"');
    expect(html).toContain('10:00 to 10:05 UTC');
    expect(html.match(/<li /g)).toHaveLength(3);
  });

  it('links nothing where there is no app to open (the hosted page), and draws nothing without a runbook', () => {
    expect(renderRunbook(RB, LABELS)).not.toContain('<a ');
    expect(renderRunbook(undefined, LABELS)).toBe('');
    expect(renderRunbook({ ...RB, steps: [] }, LABELS)).toBe('');
  });
});

describe('the publisher keeps the newest runbook', () => {
  const ROOM = 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1/channel/esc-1';
  const data = () => ({ readAt: '2026-11-19T10:30:00.000Z', windowMinutes: 180, series: [] });
  function s3With(stored: RunbookProgress | undefined, published: boolean) {
    const puts: Array<{ Key: string; Body?: string }> = [];
    let reads = 0;
    const s3 = { send: jest.fn(async (cmd: { constructor: { name: string }; input: { Key: string; Body?: string } }) => {
      const name = cmd.constructor.name;
      if (name === 'GetObjectCommand') {
        if (!stored) throw Object.assign(new Error('nk'), { name: 'NoSuchKey' });
        return { Body: { transformToString: async () => JSON.stringify(stored) } };
      }
      if (name === 'HeadObjectCommand') { if (!published) throw Object.assign(new Error('nf'), { name: 'NotFound' }); return { Metadata: { 'message-id': 'm-1' } }; }
      puts.push(cmd.input);
      return {};
    }) };
    const read = jest.fn(async () => { reads += 1; return data(); });
    const messaging = { send: jest.fn(async () => ({ MessageId: 'm-1', Channel: { Name: 'Incident' } })) };
    return { s3, puts, read, messaging, reads: () => reads };
  }
  const base = { credentials: { accessKeyId: 'a', secretAccessKey: 'b' }, bucket: 'b', channelArn: ROOM, classification: 'premium', botArn: 'arn:x/bot/ops', assistant: 'ops-premium' };

  it('stores a newer runbook beside the dashboard and draws it', async () => {
    const older = { ...RB, asOf: '2026-11-19T10:00:00.000Z', steps: [RB.steps[2]] };
    const m = s3With(older, true);
    await publishDashboard({ ...base, mode: 'snapshot', runbook: RB }, { s3: m.s3 as never, messaging: m.messaging as never, read: m.read });
    const runbookPut = m.puts.find((p) => p.Key === 'dashboards/premium/esc-1/runbook.json');
    expect(JSON.parse(runbookPut!.Body!)).toEqual(RB);
    const snap = JSON.parse(m.puts.find((p) => p.Key === 'dashboards/premium/esc-1/snapshot.json')!.Body!);
    expect(snap.html).toContain('Mitigation decision');
  });

  it('never replaces a newer stored runbook with an older read, and draws the stored one on an ordinary publish', async () => {
    const m = s3With(RB, true);
    await publishDashboard({ ...base, mode: 'snapshot', runbook: { ...RB, asOf: '2026-11-19T09:00:00.000Z', steps: [] } }, { s3: m.s3 as never, messaging: m.messaging as never, read: m.read });
    expect(m.puts.some((p) => p.Key.endsWith('runbook.json'))).toBe(false);
    await publishDashboard({ ...base, mode: 'snapshot' }, { s3: m.s3 as never, messaging: m.messaging as never, read: m.read });
    const snaps = m.puts.filter((p) => p.Key.endsWith('snapshot.json'));
    expect(JSON.parse(snaps.at(-1)!.Body!).html).toContain('Post-incident review');
  });

  it('a refresh of a dashboard never published stores the runbook and draws, reads and posts nothing', async () => {
    const m = s3With(undefined, false);
    const out = await refreshDashboardRunbook({ ...base, runbook: RB, modes: ['snapshot'] }, { s3: m.s3 as never, messaging: m.messaging as never, read: m.read });
    expect(out).toEqual([{ published: false, reason: 'not-published' }]);
    expect(m.puts.map((p) => p.Key)).toEqual(['dashboards/premium/esc-1/runbook.json']);
    expect(m.reads()).toBe(0);
    expect(m.messaging.send).not.toHaveBeenCalled();
  });

  it('DENY: a refresh carrying an older read than the stored runbook draws, stores and posts nothing', async () => {
    const m = s3With(RB, true);
    const out = await refreshDashboardRunbook({ ...base, runbook: { ...RB, asOf: '2026-11-19T09:00:00.000Z', steps: [RB.steps[0]] }, modes: ['snapshot'] }, { s3: m.s3 as never, messaging: m.messaging as never, read: m.read });
    expect(out).toEqual([{ published: false, reason: 'not-newer' }]);
    expect(m.puts).toEqual([]);
    expect(m.reads()).toBe(0);
    expect(m.messaging.send).not.toHaveBeenCalled();
  });
});

describe('a refresh that changes nothing the section shows draws nothing', () => {
  it('leaves the dashboard and its message as they are when the steps match the stored runbook', async () => {
    const ROOM = 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1/channel/esc-1';
    const sends: string[] = [];
    const s3 = { send: jest.fn(async (cmd: { constructor: { name: string } }) => {
      sends.push(cmd.constructor.name);
      if (cmd.constructor.name === 'GetObjectCommand') return { Body: { transformToString: async () => JSON.stringify({ ...RB, asOf: '2026-11-19T10:00:00.000Z' }) } };
      return { Metadata: { 'message-id': 'm-1' } };
    }) };
    const messaging = { send: jest.fn() };
    const read = jest.fn();
    const out = await refreshDashboardRunbook({
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' }, bucket: 'b', channelArn: ROOM, classification: 'premium', botArn: 'arn:x/bot/ops', assistant: 'ops-premium',
      runbook: { ...RB, asOf: '2026-11-19T10:31:00.000Z' }, modes: ['snapshot'],
    }, { s3: s3 as never, messaging: messaging as never, read });
    expect(out).toEqual([{ published: false, reason: 'unchanged' }]);
    expect(sends).toEqual(['GetObjectCommand']);
    expect(read).not.toHaveBeenCalled();
    expect(messaging.send).not.toHaveBeenCalled();
  });
});

describe('what the conversation pins at its top', () => {
  it('is the step the run is on and who holds its roles, on the dashboard message', async () => {
    const ROOM = 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1/channel/esc-1';
    const sent: Array<{ name: string; metadata?: string }> = [];
    const s3 = { send: jest.fn(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetObjectCommand') throw Object.assign(new Error('nk'), { name: 'NoSuchKey' });
      if (cmd.constructor.name === 'HeadObjectCommand') return { Metadata: { 'message-id': 'm-1' } };
      return {};
    }) };
    const messaging = { send: jest.fn(async (cmd: { constructor: { name: string }; input: { Metadata?: string } }) => {
      sent.push({ name: cmd.constructor.name, metadata: cmd.input?.Metadata });
      return { Channel: { Name: 'Customer API Availability' } };
    }) };
    const runbook: RunbookProgress = { ...RB, people: [{ role: 'on-call:ops', name: 'Jordan Reyes' }, { role: 'secondary:ops', name: 'Priya Raman' }] };
    await refreshDashboardRunbook({
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' }, bucket: 'b', channelArn: ROOM, classification: 'premium', botArn: 'arn:x/bot/ops', assistant: 'ops-premium',
      runbook, modes: ['snapshot'],
    }, { s3: s3 as never, messaging: messaging as never, read: async () => ({ readAt: '2026-11-19T10:30:00.000Z', windowMinutes: 180, series: [] }) });
    const update = sent.find((s) => s.name === 'UpdateChannelMessageCommand');
    const dashboard = JSON.parse(update!.metadata!).dashboard;
    expect(dashboard.now).toEqual({ label: 'Mitigation decision', status: 'waiting', holder: 'Dana "D" Ortiz' });
    expect(dashboard.people).toEqual([{ role: 'on-call:ops', name: 'Jordan Reyes' }, { role: 'secondary:ops', name: 'Priya Raman' }]);
    expect(update!.metadata!.length).toBeLessThan(1024);
  });
});

describe('a pinned step: where the conversation stands, decided from the top', () => {
  it('reads the pinned step as open, resolved or ended, and nothing where none is pinned', () => {
    const { runbookStanding } = jest.requireActual('../../lambda/src/lib/runbook-progress') as typeof import('../../lambda/src/lib/runbook-progress');
    const at = (status: string, pinned = true) => ({ ...RB, steps: [{ step: 'owner', label: 'Incident owner', status, ...(pinned ? { pinned: true } : {}) }] }) as RunbookProgress;
    expect(runbookStanding(at('waiting'))).toBe('open');
    expect(runbookStanding(at('done'))).toBe('resolved');
    expect(runbookStanding(at('skipped'))).toBe('ended');
    expect(runbookStanding(at('done', false))).toBeUndefined();
  });

  it('the incident owner card is pinned, its card says so, and a pinned step is true or left out', () => {
    const { taskCardOf } = jest.requireActual('../../lambda/src/lib/workflow-task') as typeof import('../../lambda/src/lib/workflow-task');
    expect(SHIPPED_EVENT_WORKFLOWS['ops-room'].states['lead-task'].task?.pinned).toBe(true);
    const machines = { m: { initial: 'open', states: { open: { transitions: ['resolved'], choices: ['resolved'] }, resolved: { transitions: [], terminal: 'success' } } } };
    expect(taskCardOf({ taskId: 't', taskType: 'm', taskState: 'open', workflowRun: { pinned: true } } as never, machines as never)?.pinned).toBe(true);
    const { eventWorkflowErrors } = jest.requireActual('../../lambda/src/lib/event-workflow') as typeof import('../../lambda/src/lib/event-workflow');
    const wf = JSON.parse(JSON.stringify(SHIPPED_EVENT_WORKFLOWS['ops-room']));
    wf.states['lead-task'].task.pinned = 'yes';
    expect(eventWorkflowErrors('ops-room', wf).join('\n')).toMatch(/pinned is true, or left out/);
  });
});

describe('every way a labeled step moves redraws the runbook', () => {
  it('a claim is read as its step: a continuation, a move, an alongside release and a join\'s part alike', async () => {
    const { runbookStepOfClaim } = await import('../../lambda/src/router-agent-handler');
    expect(runbookStepOfClaim('lead-task')).toBe('lead-task');
    expect(runbookStepOfClaim('after#lead-task')).toBe('lead-task');
    expect(runbookStepOfClaim('moved#lead-task')).toBe('lead-task');
    expect(runbookStepOfClaim('after#investigation-complete#task:success:done')).toBe('investigation-complete');
    expect(runbookStepOfClaim('after#gather#alpha')).toBe('gather');
  });
});

describe('a resolve that moves its run on reads only workflow tasks', () => {
  it('never reads a runbook refresh or a meeting\'s action item, which no run waits on', () => {
    const router = require('fs').readFileSync(require('path').join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8') as string;
    const fn = router.slice(router.indexOf('async function moveRunOn('), router.indexOf('async function moveRunOn(') + 900);
    expect(fn).toContain('await workflowTasksOf(channelArn, { skipMachines: PLATFORM_RUN_MACHINES })');
    expect(router).toContain('const PLATFORM_RUN_MACHINES: readonly string[] = Object.freeze([DASHBOARD_RUNBOOK_MACHINE, MEETING_ACTION_ITEM_MACHINE]);');
  });

  it('the listing leaves out the tasks of the machines it is told to skip', async () => {
    const client = await import('../../lambda/src/lib/task-service-client');
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../lambda/src/lib/task-service-client.ts'), 'utf8') as string;
    expect(typeof client.workflowTaskIds).toBe('function');
    expect(src).toContain(".filter((r) => !input.skipMachines?.length || !input.skipMachines.includes(r.taskType ?? ''))");
  });
});
