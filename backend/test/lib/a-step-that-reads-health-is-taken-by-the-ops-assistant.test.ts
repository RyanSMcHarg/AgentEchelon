/**
 * A STEP THAT READS THE DEPLOYMENT'S HEALTH IS TAKEN BY THE ROOM'S OPS ASSISTANT (ADR-061 decision 1, "Whose workflow
 * runs"; tenet D1).
 *
 * The ops room's first look and the incident watch's re-read name `read_deployment_health`, and the boundary refuses
 * CloudWatch to every primary's session. So each of those steps names `as: { role: 'ops' }`: the router hands that one
 * turn to the classification's ops assistant in the room, which takes it as itself on its own session, and the run
 * stays the primary's. What it proves:
 *  - the step is dispatched to the ops assistant in the room, never to the primary, and the turn hands the run back to
 *    the primary that owns it;
 *  - with no ops assistant in the room the step is never dispatched, so no turn runs and no tool is called: the room is
 *    told plainly that no ops assistant is there, and the run takes the step's failure edge;
 *  - the processor takes a step naming a role only as an assistant holding it;
 *  - the re-read runs in a room no person has spoken in yet: only a join recap has nothing to recount (`skipped`);
 *  - a step no turn completed (refused by the processor, or skipped and not a join recap) says its fallback and takes
 *    its failure edge, as a step with no ops assistant in the room does;
 *  - validation does not refuse a version that runs these steps on a deployment with no ops role; it warns.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  PLATFORM_EVENT_WORKFLOWS,
  agentStepDelivered,
  assistantForStep,
  continueAfter,
  eventRunKey,
  nothingToRecap,
  eventWorkflowErrors,
  runEventWorkflow,
  stepTakenBy,
  type AgentStep,
  type EventRunContext,
  type EventRunDeps,
  type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import { shippedMessageTemplates } from '../../lambda/src/lib/shipped-message-templates';
import { stepRoleWarnings, welcomeWorkflowErrors } from '../../lambda/src/lib/profile-lifecycle';
import type { ProfileDefinitionBody } from '../../lambda/src/lib/active-profile';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

const APP = 'arn:aws:chime:us-east-1:1:app-instance/ai';
const channelArn = `${APP}/channel/ch-1`;
const ADVISOR = `${APP}/bot/advisor`;
const OPS_BOT = `${APP}/bot/ops`;
const lead = `${APP}/user/dana`;
const LIVE = [
  { botArn: ADVISOR, role: 'primary', handle: 'advisor' },
  { botArn: OPS_BOT, role: 'ops', handle: 'ops-premium' },
];

const OPS_ROOM = PLATFORM_EVENT_WORKFLOWS['ops-room'];
const WATCH = PLATFORM_EVENT_WORKFLOWS['incident-watch'];
const firstLook = OPS_ROOM.states['first-look'].agent as AgentStep;
const recheck = WATCH.states.recheck.agent as AgentStep;

describe('the platform\'s health-reading steps name the ops role', () => {
  it('the first look and the re-read are taken by the ops assistant, and each says a plain message when none is in the room', () => {
    for (const step of [firstLook, recheck]) {
      expect(step.tools).toContain('read_deployment_health');
      expect(step.as).toEqual({ role: 'ops' });
      expect(step.fallback.absent).toEqual({ to: 'room', template: 'ops-assistant-absent' });
    }
    const absent = shippedMessageTemplates().get('ops-assistant-absent');
    expect(absent?.template.kind).toBe('message');
    expect(absent?.source).toMatch(/No ops assistant is in this room/);
    expect(eventWorkflowErrors('ops-room', OPS_ROOM)).toEqual([]);
    expect(eventWorkflowErrors('incident-watch', WATCH)).toEqual([]);
  });

  it('validation refuses a malformed role and an absent message on a step that names none', () => {
    const wf = JSON.parse(JSON.stringify(OPS_ROOM)) as EventWorkflow;
    (wf.states['first-look'].agent as any).as = { role: 'Ops Team' };
    expect(eventWorkflowErrors('w', wf).join(' ')).toMatch(/first-look\.agent\.as is \{ role \}/);
    delete (wf.states['first-look'].agent as any).as;
    expect(eventWorkflowErrors('w', wf).join(' ')).toMatch(/fallback\.absent is said when the step's role has no assistant in the room/);
  });
});

describe('the step is dispatched to the ops assistant in the room (assistantForStep)', () => {
  it('a step naming ops goes to the ops assistant that is a member, as itself, never to the primary', () => {
    expect(assistantForStep(firstLook, { self: { botArn: ADVISOR, role: 'primary' }, live: LIVE, botsInRoom: [ADVISOR, OPS_BOT] }))
      .toEqual({ botArn: OPS_BOT, assistant: 'ops-premium' });
  });

  it('a step naming no role stays the run\'s own, and a run whose assistant holds the role takes it itself', () => {
    const own: Pick<AgentStep, 'as'> = {};
    expect(assistantForStep(own, { self: { botArn: ADVISOR, role: 'primary' }, live: LIVE, botsInRoom: [ADVISOR, OPS_BOT] })).toEqual({ botArn: ADVISOR });
    expect(assistantForStep(firstLook, { self: { botArn: OPS_BOT, role: 'ops' }, live: LIVE, botsInRoom: [OPS_BOT] })).toEqual({ botArn: OPS_BOT });
  });

  it('an ops assistant that is not a member of the room, or a deployment with none, takes nothing', () => {
    expect(assistantForStep(firstLook, { self: { botArn: ADVISOR, role: 'primary' }, live: LIVE, botsInRoom: [ADVISOR] })).toBeUndefined();
    expect(assistantForStep(firstLook, { self: { botArn: ADVISOR, role: 'primary' }, live: [LIVE[0]], botsInRoom: [ADVISOR, OPS_BOT] })).toBeUndefined();
  });

  it('the router dispatches the turn as the assistant that takes it, naming the run\'s owner and handing back to it', () => {
    const router = read('router-agent-handler.ts');
    const deps = router.slice(router.indexOf('function eventRunDeps('), router.indexOf('async function offerIntakeStep('));
    expect(deps).toMatch(/const taker = _def\.as \? await stepTaker\(_def, ctx\.channelArn, who\.botArn\) : \{ botArn: who\.botArn \};/);
    expect(deps).toMatch(/if \(!taker\) \{[\s\S]{0,300}return 'absent' as const;/);
    expect(deps).toMatch(/botArn: taker\.botArn,/);
    expect(deps).toMatch(/\.\.\.\(taker\.assistant \? \{ workflowOwner: who\.assistant, ownerBotArn: who\.botArn \} : \{\}\)/);
    // The primary's experiment arm is never the ops assistant's version.
    expect(deps).toMatch(/who\.variantProfile && !taker\.assistant \? \{ variantProfile: who\.variantProfile \}/);
    // NO OPS ASSISTANT AT ALL: nothing is read of the room, and nothing is dispatched.
    const taker = router.slice(router.indexOf('async function stepTaker('), router.indexOf('async function dispatchEventAgentStep('));
    expect(taker.indexOf("if (!live.some((a) => a.role === def.as?.role)) return undefined;")).toBeGreaterThan(-1);
    expect(taker.indexOf('if (!live.some(')).toBeLessThan(taker.indexOf('resolveChannelSize('));
  });

  it('the processor reads the step from the owner\'s version and hands the run back to the owner\'s bot', () => {
    const processor = read('assistant-async-processor.ts');
    expect(processor).toMatch(/const stepWorkflows = stepOwner\s+\? await ownerEventWorkflows\(stepOwner,/);
    expect(processor).toMatch(/if \(!stepTakenBy\(def, \{ owner: stepOwner, role: turnAssistantRole \}\)\)/);
    expect(processor).toMatch(/botArn: \(stepOwner && req\.ownerBotArn\) \|\| event\.botArn/);
  });
});

describe('each assistant takes only its own steps (stepTakenBy, tenet D1)', () => {
  it('a step naming ops is taken only by an assistant holding ops', () => {
    expect(stepTakenBy(firstLook, { owner: 'advisor', role: 'ops' })).toBe(true);
    expect(stepTakenBy(firstLook, { role: 'primary' })).toBe(false);
    expect(stepTakenBy(firstLook, { owner: 'advisor', role: '' })).toBe(false);
  });

  it('a step another version declares and names no role is never taken by a second assistant', () => {
    expect(stepTakenBy({}, { owner: 'advisor', role: 'ops' })).toBe(false);
    expect(stepTakenBy({}, { role: 'primary' })).toBe(true);
  });
});

describe('with no ops assistant in the room, the step is not dispatched and reads nothing', () => {
  const ctx: EventRunContext = { event: 'conversation-opened', channelArn, eventPerson: lead, roles: { lead: [lead] }, values: { label: 'API latency' } };

  function run(botsInRoom: string[], live = LIVE) {
    const taken = new Map<string, string>();
    const key = eventRunKey('conversation-opened', 'ch-1', 'advisor');
    const sent: Array<{ template: string; to: string[] }> = [];
    // The turn the processor would run, the only path to `read_deployment_health`, as the ops assistant's own.
    const turns: Array<{ step: string; botArn: string }> = [];
    const d: EventRunDeps = {
      claimRun: async () => { if (taken.has(key)) return false; taken.set(key, 'run'); return true; },
      claimStep: async (step, outcome) => { const k = `${key}#${step}`; if (taken.has(k)) return false; taken.set(k, outcome); return true; },
      mentionName: async () => 'Dana',
      send: async (a) => { sent.push({ template: a.template, to: a.to }); return true; },
      // As the router decides it: the step's assistant, or `absent` with nothing handed to anyone.
      dispatchAgent: async (step, def) => {
        const taker = assistantForStep(def, { self: { botArn: ADVISOR, role: 'primary' }, live, botsInRoom });
        if (!taker) return 'absent';
        turns.push({ step, botArn: taker.botArn });
        return true;
      },
    };
    return { d, sent, turns, taken };
  }

  it('with an ops assistant in the room, the first look is handed to it', async () => {
    const { d, turns } = run([ADVISOR, OPS_BOT]);
    await runEventWorkflow('ops-room', OPS_ROOM, ctx, d);
    expect(turns).toEqual([{ step: 'first-look', botArn: OPS_BOT }]);
  });

  it('with none, no turn runs, the room is told no ops assistant is here, and the run takes the failure edge', async () => {
    const { d, sent, turns, taken } = run([ADVISOR], [LIVE[0]]);
    const out = await runEventWorkflow('ops-room', OPS_ROOM, ctx, d);
    expect(turns).toEqual([]);
    expect(sent.map((s) => s.template)).toEqual(['ops-room-opening', 'ops-lead-welcome', 'ops-assistant-absent']);
    expect(sent[2].to).toEqual([]);
    expect(out.steps.find((s) => s.step === 'first-look')?.outcome).toBe('no-role-assistant');
    expect([...taken.values()]).toContain('fallback:no-role-assistant');
  });

  it('the incident watch\'s re-read says the same when no ops assistant is in the room', async () => {
    const { d, sent, turns } = run([ADVISOR], [LIVE[0]]);
    await runEventWorkflow('incident-watch', WATCH, { event: 'alarm-state-changed', channelArn, alarm: { name: 'ae-x', state: 'ALARM', changedAt: 1 }, values: { alarm: 'ae-x', alarmState: 'ALARM' } }, d);
    expect(turns).toEqual([]);
    expect(sent.map((s) => s.template)).toEqual(['incident-alarm-changed', 'ops-assistant-absent']);
  });
});

describe('the re-read runs in a room no person has spoken in yet', () => {
  it('an event-opened ops room holds only assistants\' messages, and the re-read still runs: only a join recap has nothing to recount', () => {
    expect(nothingToRecap(WATCH.states.recheck, false)).toBe(false);
    expect(nothingToRecap(OPS_ROOM.states['first-look'], false)).toBe(false);
    expect(nothingToRecap(PLATFORM_EVENT_WORKFLOWS['join-recap'].states.recap, false)).toBe(true);
    expect(nothingToRecap(PLATFORM_EVENT_WORKFLOWS['join-recap'].states.recap, true)).toBe(false);
  });

  it('the processor skips a step for an empty room only through nothingToRecap', () => {
    const processor = read('assistant-async-processor.ts');
    expect(processor).toMatch(/readsRoom && nothingToRecap\(wf\.states\[req\.step\], pipeline\.personSpoke\) \? \{ nothingToRead: true \}/);
    expect(processor).not.toMatch(/readsRoom && !pipeline\.personSpoke/);
  });
});

describe('a step no turn completed says its fallback and takes its failure edge', () => {
  const ctx: EventRunContext = { event: 'alarm-state-changed', channelArn, alarm: { name: 'ae-x', state: 'ALARM', changedAt: 1 }, values: { alarm: 'ae-x', alarmState: 'ALARM' } };
  // The incident watch with its re-read's two edges told apart.
  const wf = (): EventWorkflow => {
    const w = JSON.parse(JSON.stringify(WATCH)) as EventWorkflow;
    w.states.recheck = { ...w.states.recheck, onSuccess: 'ok', onFailure: 'failed' };
    w.states.ok = { disposition: 'success' };
    w.states.failed = { disposition: 'failure' };
    return w;
  };
  function deps() {
    const taken = new Set<string>();
    const sent: Array<{ template: string; to: string[]; fallback?: boolean }> = [];
    const d: EventRunDeps = {
      claimRun: async () => true,
      claimStep: async (step) => { if (taken.has(step)) return false; taken.add(step); return true; },
      mentionName: async () => '',
      send: async (a) => { sent.push({ template: a.template, to: a.to, fallback: a.fallback }); return true; },
      dispatchAgent: async () => true,
    };
    return { d, sent };
  }

  it('a turn the processor refused: the room is told the re-read could not be done, and the run ends on its failure edge', async () => {
    const { d, sent } = deps();
    const out = await continueAfter('e2e-incident-watch', wf(), ctx, { step: 'recheck', outcome: 'refused' }, d);
    expect(sent).toEqual([{ template: 'ops-first-look-unavailable', to: [], fallback: true }]);
    expect(out.ended).toBe('failure');
  });

  it('a skipped step that is not a join recap does the same, never ending the run as a success with nothing said', async () => {
    const { d, sent } = deps();
    const out = await continueAfter('e2e-incident-watch', wf(), ctx, { step: 'recheck', outcome: 'skipped' }, d);
    expect(sent.map((s) => s.template)).toEqual(['ops-first-look-unavailable']);
    expect(out.ended).toBe('failure');
  });

  it('a fallback the processor already said is not said twice, and posted output takes the success edge', async () => {
    const said = deps();
    expect((await continueAfter('e2e-incident-watch', wf(), ctx, { step: 'recheck', outcome: 'fallback:deadline' }, said.d)).ended).toBe('failure');
    expect(said.sent).toEqual([]);
    const posted = deps();
    expect((await continueAfter('e2e-incident-watch', wf(), ctx, { step: 'recheck', outcome: 'posted' }, posted.d)).ended).toBe('success');
    expect(posted.sent).toEqual([]);
  });

  it('a redelivered refusal says nothing a second time: the continuation is claimed once', async () => {
    const { d, sent } = deps();
    await continueAfter('e2e-incident-watch', wf(), ctx, { step: 'recheck', outcome: 'refused' }, d);
    expect((await continueAfter('e2e-incident-watch', wf(), ctx, { step: 'recheck', outcome: 'refused' }, d)).ran).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('only posted output, or a join recap with nothing to recount, is delivered', () => {
    expect(agentStepDelivered(WATCH.states.recheck, 'posted')).toBe(true);
    expect(agentStepDelivered(WATCH.states.recheck, 'skipped')).toBe(false);
    expect(agentStepDelivered(WATCH.states.recheck, 'refused')).toBe(false);
    expect(agentStepDelivered(PLATFORM_EVENT_WORKFLOWS['join-recap'].states.recap, 'skipped')).toBe(true);
  });

  it('the processor claims a refused step and hands it back to the owner\'s router, so the run never waits on it', () => {
    const processor = read('assistant-async-processor.ts');
    const refusal = processor.slice(processor.indexOf('if (!stepTakenBy(def, { owner: stepOwner, role: turnAssistantRole }))'));
    expect(refusal.slice(0, 600)).toMatch(/claimEventStep\(\{ runKey: req\.runKey, channelArn: event\.channelArn, step: req\.step, outcome: 'refused' \}\)[\s\S]{0,40}await handBack\('refused'\);\s*return;/);
  });
});

describe('validation warns rather than refuses on a deployment with no ops role', () => {
  const body = (): ProfileDefinitionBody => ({
    tools: ['search_company_docs'],
    eventWorkflows: { 'ops-room': JSON.parse(JSON.stringify(PLATFORM_EVENT_WORKFLOWS['ops-room'])), 'e2e-incident-watch': JSON.parse(JSON.stringify(WATCH)) },
    workflows: ['incident_first_look'],
  } as unknown as ProfileDefinitionBody);

  it('a primary whose tools do not include the health read is not refused for a step the ops assistant takes', () => {
    expect(welcomeWorkflowErrors(body()).filter((e) => /read_deployment_health/.test(e))).toEqual([]);
  });

  it('a step the primary itself would take with a tool it lacks is still refused', () => {
    const b = body();
    delete (b.eventWorkflows!['e2e-incident-watch'].states.recheck.agent as any).as;
    delete (b.eventWorkflows!['e2e-incident-watch'].states.recheck.agent as any).fallback.absent;
    expect(welcomeWorkflowErrors(b).join(' ')).toMatch(/uses read_deployment_health, which this assistant's tools do not include/);
  });

  it('each step taken by a role the classification does not declare is a warning, and none where it does', () => {
    const warnings = stepRoleWarnings(body(), ['primary']);
    expect(warnings).toHaveLength(2);
    expect(warnings.join(' ')).toMatch(/ops-room, whose step first-look is taken by the ops assistant, which this deployment does not declare/);
    expect(warnings.join(' ')).toMatch(/e2e-incident-watch, whose step recheck is taken by the ops assistant/);
    expect(stepRoleWarnings(body(), ['primary', 'ops'])).toEqual([]);
  });

  it('validateDraft returns them as warnings beside its errors', () => {
    const lifecycle = read('lib/profile-lifecycle.ts');
    const fn = lifecycle.slice(lifecycle.indexOf('export async function validateDraft('));
    expect(fn).toMatch(/stepRoleWarnings\(body, defaultProfileRegistry\.rolesFor\(classification\)\)/);
  });
});
