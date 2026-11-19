/**
 * AN INTENT STARTS A WORKFLOW (ADR-067 decision 1, stage 3; WT3, WT7, WT19, WT71, WT72, WT110, WT113).
 *
 * What it proves: a version's intent workflow is held to the event workflow rules on the intent trigger and to an
 * intent's own (a declared multi-step intent; one step opening its machine, reached through sends only; no deadline
 * needed there; no step continuing before its task settles; \`requester\` named only here); the canonical workflow is
 * today's rule; a private request's step that would reach anyone else is withheld and its requester told once; and the
 * router starts the run only where the version declares one, opening the request's task through its own door, and
 * continues it from the run's own task row.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  asRun, canonicalIntentWorkflow, intentRunKey, intentTaskStep, intentWorkflowErrors, intentWorkflowFor, versionIntentWorkflowsErrors,
  type IntentWorkflow,
} from '../../lambda/src/lib/intent-workflow';
import { continueAfter, runEventWorkflow, reachesBeyondRequester, INTENT_TRIGGER, type EventRunContext, type EventRunDeps } from '../../lambda/src/lib/event-workflow';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';

const MULTI = ['report_generation', 'image_generation'];
const opts = { multiStepIntents: MULTI, machines: DEFAULT_TASK_STATE_MACHINES };

/** A report, then the requester is told, then the lead approves on the card. */
const APPROVED_REPORT: IntentWorkflow = {
  on: { intent: 'report_generation' },
  initial: 'work',
  states: {
    work: { task: { machine: 'report_generation', for: 'requester' }, onSuccess: 'tell', onFailure: 'done' },
    tell: { send: { to: 'requester', template: 'workflow-task-assigned' }, onSuccess: 'share', onFailure: 'share' },
    share: { send: { to: 'room', template: 'workflow-step-withheld' }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
} as IntentWorkflow;

describe('an intent workflow is validated', () => {
  it('accepts the canonical workflow and a workflow with steps after the task', () => {
    expect(intentWorkflowErrors('report_generation', canonicalIntentWorkflow('report_generation'), opts)).toEqual([]);
    expect(intentWorkflowErrors('report_generation', APPROVED_REPORT, opts)).toEqual([]);
  });

  it('refuses an intent the pack does not declare, a single-turn intent\'s own task, an on that names another, and an event workflow\'s deadline', () => {
    expect(intentWorkflowErrors('greeting', { ...canonicalIntentWorkflow('greeting') }, opts).join()).toMatch(/not an intent this version's pack declares/);
    // A single-turn intent may have a workflow, which opens no task of the request's own.
    expect(intentWorkflowErrors('image_generation', { ...canonicalIntentWorkflow('image_generation') }, { ...opts, multiStepIntents: [], intents: ['image_generation'] }).join())
      .toMatch(/which a single-turn intent does not: make image_generation multi-step/);
    expect(intentWorkflowErrors('report_generation', { ...APPROVED_REPORT, on: { intent: 'image_generation' } }, opts).join()).toMatch(/on is \{ intent: 'report_generation' \}/);
    expect(intentWorkflowErrors('report_generation', { ...APPROVED_REPORT, deadline: { afterMinutes: 60 } }, opts).join()).toMatch(/declares none/);
  });

  it('opens its own machine once, reached through sends only, and continues no task before it settles', () => {
    const noOwn = { ...APPROVED_REPORT, states: { ...APPROVED_REPORT.states, work: { task: { machine: 'image_generation', for: 'requester', deadline: { afterMinutes: 60 } }, onSuccess: 'tell', onFailure: 'done' } } };
    expect(intentWorkflowErrors('report_generation', noOwn, opts).join()).toMatch(/exactly one task step/);
    const continues = { ...APPROVED_REPORT, states: { ...APPROVED_REPORT.states, work: { task: { machine: 'report_generation', for: 'requester', continue: 'opened' }, onSuccess: 'tell', onFailure: 'done' } } };
    expect(intentWorkflowErrors('report_generation', continues, opts).join()).toMatch(/waits on its task's ending/);
    // A send first is fine; a branch before the task is not, since the request's turn opens its task with nothing waited on.
    const sendFirst = { ...APPROVED_REPORT, initial: 'hello', states: { ...APPROVED_REPORT.states, hello: { send: { to: 'requester', template: 'workflow-task-assigned' }, onSuccess: 'work', onFailure: 'work' } } };
    expect(intentWorkflowErrors('report_generation', sendFirst, opts)).toEqual([]);
    expect(intentTaskStep(sendFirst as IntentWorkflow, 'report_generation')).toBe('work');
    const branch = { ...sendFirst, states: { ...sendFirst.states, hello: { send: { to: 'requester', template: 'workflow-task-assigned' }, onSuccess: 'work', onFailure: 'done' } } };
    expect(intentWorkflowErrors('report_generation', branch, opts).join()).toMatch(/through sends only/);
  });

  it('names the requester only on an intent trigger, and never an event\'s subject', () => {
    const subject = { ...APPROVED_REPORT, states: { ...APPROVED_REPORT.states, tell: { send: { to: 'subject', template: 'workflow-task-assigned' }, onSuccess: 'share', onFailure: 'share' } } };
    expect(intentWorkflowErrors('report_generation', subject, opts).join()).toMatch(/names as requester/);
    expect(versionIntentWorkflowsErrors('not a map', opts)).toEqual(['intentWorkflows maps an intent to its workflow']);
  });

  it('a version that declares none for an intent runs the canonical workflow, keyed by the turn', () => {
    expect(intentWorkflowFor(undefined, 'report_generation')).toEqual({ workflow: canonicalIntentWorkflow('report_generation'), declared: false });
    expect(intentWorkflowFor({ report_generation: APPROVED_REPORT }, 'report_generation').declared).toBe(true);
    expect(intentRunKey('corr-1', 'advisor')).toBe('intent#corr-1#advisor');
    expect(asRun(APPROVED_REPORT).on).toBe(INTENT_TRIGGER);
  });
});

describe('a private request reaches no one but its requester (decision 8)', () => {
  const REQ = 'arn:aws:chime:us-east-1:1:app-instance/i/user/asker';
  const OTHER = 'arn:aws:chime:us-east-1:1:app-instance/i/user/lead';
  const ctx = (privateRun: boolean): EventRunContext => ({ event: INTENT_TRIGGER, channelArn: 'arn:ch', requester: REQ, values: {}, privateRun, roles: { lead: [OTHER] } });

  it('a step to the room or another person reaches beyond them; one to the requester, or a task the assistant works for them, does not', () => {
    expect(reachesBeyondRequester({ send: { to: 'room', template: 'x' } } as never, ctx(true))).toBe(true);
    expect(reachesBeyondRequester({ send: { to: { participantRole: 'lead' }, template: 'x' } } as never, ctx(true))).toBe(true);
    expect(reachesBeyondRequester({ send: { to: 'requester', template: 'x' } } as never, ctx(true))).toBe(false);
    expect(reachesBeyondRequester({ task: { machine: 'approval', for: 'requester', by: { assistantRole: 'ops' } } } as never, ctx(true))).toBe(false);
    expect(reachesBeyondRequester({ task: { machine: 'approval', for: 'requester', by: { participantRole: 'lead' } } } as never, ctx(true))).toBe(true);
  });

  it('a child conversation reaches beyond them, and a move, which takes its message\'s audience, does not', () => {
    expect(reachesBeyondRequester({ open: { type: 'ops', for: 'requester' } } as never, ctx(true))).toBe(true);
    expect(reachesBeyondRequester({ open: { mode: 'move', type: 'general' } } as never, ctx(true))).toBe(false);
  });

  it('the run takes each such step as withheld, tells the requester once, and goes on; a shared request posts it', async () => {
    const run = async (privateRun: boolean) => {
      const sent: string[] = [];
      const told: string[] = [];
      const claims = new Set<string>();
      const deps: EventRunDeps = {
        claimRun: async () => true,
        claimStep: async (step, outcome) => { const k = `${step}:${outcome}`; if (claims.has(k)) return false; claims.add(k); return true; },
        mentionName: async () => 'Sam', dispatchAgent: async () => true,
        send: async ({ step }) => { sent.push(step); return true; },
        withheld: async (step) => { told.push(step); },
      };
      const out = await continueAfter('report_generation', asRun(APPROVED_REPORT), ctx(privateRun), { step: 'work', outcome: 'task:success:completed' }, deps, DEFAULT_TASK_STATE_MACHINES);
      return { sent, told, out };
    };
    const priv = await run(true);
    expect(priv.sent).toEqual(['tell']);
    expect(priv.told).toEqual(['share']);
    expect(priv.out.steps.map((s) => `${s.step}:${s.outcome}`)).toEqual(['tell:posted', 'share:withheld']);
    const shared = await run(false);
    expect(shared.sent).toEqual(['tell', 'share']);
    expect(shared.told).toEqual([]);
  });

  it('the steps after a task run once, at its first settlement, whatever reopens it later', async () => {
    const claims = new Set<string>();
    const sent: string[] = [];
    const deps: EventRunDeps = {
      claimRun: async () => true,
      claimStep: async (step, outcome) => { const k = step.startsWith('continue') ? step : `${step}:${outcome}`; if (claims.has(k)) return false; claims.add(k); return true; },
      mentionName: async () => '', dispatchAgent: async () => true, send: async ({ step }) => { sent.push(step); return true; },
    };
    await continueAfter('report_generation', asRun(APPROVED_REPORT), ctx(false), { step: 'work', outcome: 'task:success:completed' }, deps, DEFAULT_TASK_STATE_MACHINES);
    const again = await continueAfter('report_generation', asRun(APPROVED_REPORT), ctx(false), { step: 'work', outcome: 'task:success:completed' }, deps, DEFAULT_TASK_STATE_MACHINES);
    expect(again.ran).toBe(false);
    expect(sent).toEqual(['tell', 'share']);
  });

  it('a run with no task opened yet starts at its own step and waits there', async () => {
    let openedAt = '';
    const out = await runEventWorkflow('report_generation', asRun(APPROVED_REPORT), ctx(true), {
      claimRun: async () => true, claimStep: async () => true, mentionName: async () => '', dispatchAgent: async () => true, send: async () => true,
      openTask: async (step) => { openedAt = step; return 'opened'; },
    });
    expect(openedAt).toBe('work');
    expect(out.steps.map((s) => s.outcome)).toEqual(['opened']);
    expect(out.ended).toBeUndefined();
  });
});

describe('the router starts and continues the run', () => {
  const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');

  it('starts it on the classifying turn only where the version declares one, through the router\'s own door, and opens the task as today otherwise', () => {
    expect(router).toMatch(/const declared = args\.version\?\.intentWorkflows\?\.\[args\.intent\] \?\? \(args\.askedBy \? canonicalIntentWorkflow\(args\.intent\) : undefined\);\s*if \(!declared \|\| !args\.correlationId/);
    expect(router).toMatch(/\? await startIntentRun\(\{[\s\S]{0,400}open: openRequestTask,[\s\S]{0,140}\}\)\s*: undefined\)[\s\S]{0,400}\?\? await openRequestTask\(\);/);
    expect(router).toMatch(/\.\.\.\(run \? \{ workflowRun: run \} : \{\}\),/);
  });

  it('continues it from the run\'s own task row, never the hand-back\'s word', () => {
    const fn = router.slice(router.indexOf('export async function handleIntentContinuation('), router.indexOf('async function startIntentRun('));
    expect(fn).toMatch(/const own = await getTask\(str\(req\.runTaskId\), channelArn\);/);
    expect(fn).toMatch(/!keyedBy \|\| own\.workflowRun\?\.runKey !== runKey/);
    expect(fn).toMatch(/requester: own\.userArn/);
    expect(fn).toMatch(/privateRun: isPrivateVisibility\(own\.visibility\)/);
    expect(router).toMatch(/if \(req\?\.event === INTENT_TRIGGER\) return handleIntentContinuation\(req, opts\);/);
  });
});
