/**
 * A TASK STATE'S NOTICE IS SAID UNDER THE TASK'S OWN RUN (ADR-067 WT23; SPEC-PROCESSES P8, P9).
 *
 * What it proves:
 *  - the incident's `confirming_resolve` notice is said under the incident run: its workflow (`ops-room`), its run key, the
 *    step that opened the task and the run's edition and process, so its analytics record names a run that ends;
 *  - the notice's once-per-entry claim keeps a key of its own (`notice#<taskId>`), and that key never carries a process;
 *  - a task with no run is told under its own type and claim key, with no process;
 *  - in a full incident, every run key a process record names is one of the incident's two runs, each of which has an end:
 *    every notice every task step of `incident-triage` and `ops-room` can say lands on its own run's key;
 *  - the router claims on the claim key and says the notice under the run, and no send in the router or the processor names
 *    a claim key as its run.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { SHIPPED_EVENT_WORKFLOWS, continueAfter, type EventRunContext, type EventRunDeps } from '../../lambda/src/lib/event-workflow';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import { stateNoticeRun } from '../../lambda/src/lib/workflow-task';

const PROCESS = { id: 'a1b2c3d4e5f6', name: 'incident-response', edition: 'abcdefabcdef', ownerTeam: 'ops' };
const TEAM_RUN = 'event-received#conv-team#rule-1';
const ROOM_RUN = 'conversation-opened#conv-incident#ops';
const RUN_OF: Record<string, string> = { 'incident-triage': TEAM_RUN, 'ops-room': ROOM_RUN };

const incident = {
  taskId: 'evt-lead', taskType: 'incident_ownership',
  workflowRun: {
    runKey: ROOM_RUN, workflow: 'ops-room', step: 'lead-task', event: 'conversation-opened', botArn: 'arn:bot',
    origin: { configId: 'cfg-1' }, workflowHash: 'hash-1', trigger: 'event' as const, process: PROCESS,
  },
};

describe('the confirming-resolve notice (the incident task)', () => {
  it('is said under the incident run, never under a notice key with a process', () => {
    const at = stateNoticeRun(incident, 'confirming_resolve');
    expect(at).toEqual({
      claimKey: 'notice#evt-lead', workflow: 'ops-room', runKey: ROOM_RUN, step: 'lead-task', process: PROCESS,
      edition: { originConfigId: 'cfg-1', workflowHash: 'hash-1', trigger: 'event' },
    });
    expect(at.runKey.startsWith('notice#')).toBe(false);
    expect(at.workflow).not.toBe('incident_ownership');
  });

  it('a task with no run is told under its own type and claim key, and carries no process', () => {
    const at = stateNoticeRun({ taskId: 't-1', taskType: 'approval' }, 'asked');
    expect(at).toEqual({ claimKey: 'notice#t-1', workflow: 'approval', runKey: 'notice#t-1', step: 'notice:asked' });
    expect(at.process).toBeUndefined();
  });
});

describe('a full incident: every run key a process record names has an end', () => {
  it('each notice of each task step of both workflows is said under that workflow\'s own run', () => {
    const keysWithProcess = new Set<string>();
    for (const [workflow, wf] of Object.entries({ 'incident-triage': SHIPPED_EVENT_WORKFLOWS['incident-triage'], 'ops-room': SHIPPED_EVENT_WORKFLOWS['ops-room'] })) {
      for (const [step, def] of Object.entries(wf.states)) {
        const machine = (def as { task?: { machine?: string } }).task?.machine;
        if (!machine) continue;
        const states = DEFAULT_TASK_STATE_MACHINES[machine]?.states ?? {};
        for (const [state, sd] of Object.entries(states)) {
          if (!(sd as { notice?: unknown }).notice) continue;
          const at = stateNoticeRun({ taskId: `t-${step}`, taskType: machine, workflowRun: { ...incident.workflowRun, runKey: RUN_OF[workflow], workflow, step } }, state);
          expect(at.runKey).toBe(RUN_OF[workflow]);
          if (at.process) keysWithProcess.add(at.runKey);
        }
      }
    }
    // The incident's notices are among them, so the check is not vacuous.
    expect(keysWithProcess.has(ROOM_RUN)).toBe(true);
    for (const key of keysWithProcess) expect(Object.values(RUN_OF)).toContain(key);
  });

  it('the incident run those notices name ends: from the resolve, it reaches its end once the review is done', async () => {
    const ended: string[] = [];
    const ctx: EventRunContext = {
      event: 'conversation-opened', channelArn: 'arn:aws:chime:us-east-1:1:app-instance/i/channel/conv-incident', values: { openedBy: 'workflow', label: 'X' },
      gate: { lookup: () => undefined, values: {}, callSite: { identitySettled: true, conversationSettled: true, subjectSettled: true } as never },
    };
    const deps: EventRunDeps = {
      claimRun: async () => true, claimStep: async () => true, mentionName: async () => '',
      dispatchAgent: async () => true, send: async () => true, openTask: async () => 'opened',
      ended: async (disposition) => { ended.push(disposition); },
    };
    // The review's task settled: the run goes on from the review to its end.
    const out = await continueAfter('ops-room', SHIPPED_EVENT_WORKFLOWS['ops-room'], ctx, { step: 'review', outcome: 'task:success:acknowledged' }, deps);
    expect(out.ended).toBe('success');
    expect(ended).toEqual(['success']);
  });
});

describe('the router and the processor say no message under a claim key', () => {
  const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
  const processor = readFileSync(resolve(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');

  it('the router claims a notice on its claim key and says it under the task\'s run', () => {
    const fn = router.slice(router.indexOf('async function handleStateNotice('), router.indexOf('async function handleTaskReopened('));
    expect(fn).toContain('const at = stateNoticeRun(task, state);');
    expect(fn).toContain("claimEventStep({ runKey: at.claimKey, channelArn: task.channelArn, step: entry, outcome: 'posted' })");
    expect(fn).toContain('runKey: at.runKey,');
    expect(fn).toContain('...(at.process ? { process: at.process } : {})');
    expect(fn).not.toContain('process: run?.process');
  });

  it('no send names a key built for a claim (`notice#`, `remind#`) as its run: such a key is only ever claimed', () => {
    for (const src of [router, processor]) {
      expect(src).not.toMatch(/const runKey = `(notice|remind)#/);
      for (const m of src.matchAll(/runKey: `(notice|remind)#/g)) expect(src.slice(Math.max(0, (m.index ?? 0) - 20), m.index)).toContain('claimEventStep({');
    }
  });
});
