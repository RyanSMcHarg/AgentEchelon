/**
 * A RUN GOES ON FROM EVERY STEP IT WAITS AT, ON THE TASK IT ACTUALLY RAN (ADR-067).
 *
 * What it proves: a wait's continuation is taken by both routers' doors; a request's run is matched by the key its own row
 * computes, the turn's correlation id or, where no turn opened its task, its own message; a request's run is private only
 * where its message was; a run whose own task ran another machine reads that machine on its edges; a wait's claim fails
 * closed; an agent step whose only fallback was its absent message is rewritten with an unconditioned last edge; a
 * single-turn intent's workflow takes sends and an end; a state's notice spends its claim only once its assistant may say
 * it; a single-turn intent's run is joined with the answer's dispatch; and a stored version's offloaded intent workflows
 * keep their role tasks on the definition for the listing.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { continueAfter, eventWorkflowErrors, type EventRunContext, type EventRunDeps, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import { inCurrentForm as inCurrentFormOf, workflowInCurrentForm } from '../../lambda/src/lib/retired-fields';
import { intentWorkflowErrors, roleTasksOf, type IntentWorkflow } from '../../lambda/src/lib/intent-workflow';
import { offloadBodies } from '../../lambda/src/lib/profile-bodies';
import { eventWorkflowsListedOf } from '../../lambda/src/lib/profile-lifecycle';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import type { ProfileDefinition } from '../../lambda/src/lib/active-profile';
import { AGENT_STEP_OPS_ROOM } from '../helpers/agent-step-ops-room';

const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');

describe('the router takes every continuation', () => {
  it('a wait that came due goes on, at an event\'s door and at an intent\'s', () => {
    expect(router.match(/!continuableStep\(wf, str\(req\.step\)\)\) return refuse\('no such agent, task, wait, open or held end step'\);/g)).toHaveLength(2);
  });

  it('a request\'s run is matched by its turn\'s correlation id, or by its own message where no turn opened its task', () => {
    expect(router).toMatch(/const ids = \[\.\.\.\(own\.correlationId \? \[own\.correlationId\] : \[\]\), \.\.\.\(own\.userMessageId \? \[own\.userMessageId\] : \[\]\), \.\.\.\(asked \? \[asked\] : \[\]\)\];/);
    expect(router).toMatch(/const keyedBy = ids\.find\(\(id\) => intentRunKey\(id, assistant\.profile\.name\) === runKey\);\s*if \(!keyedBy \|\| own\.workflowRun\?\.runKey !== runKey\)/);
  });

  it('a request\'s run is private only where its message was', () => {
    // A literal `true` appears only behind the message's own privacy: a private message's subject change, raised and gone on.
    expect(router.match(/privateRun: true/g)).toHaveLength(2);
    expect(router).toMatch(/\.\.\.\(args\.privateMessage \? \{ privateRun: true, requester: args\.senderArn \} : \{\}\)/);
    expect(router).toMatch(/\.\.\.\(wf\.on === 'subject-changed' && values\.private === '1' && person\(req\.eventPerson\) \? \{ privateRun: true, /);
    expect(router).toMatch(/privateRun: args\.privateRun/);
    expect(router).toMatch(/privateRun: isPrivateVisibility\(\(await inboundTaskFields\(\)\)\.visibility\)/);
    expect(router).toMatch(/privateRun: isPrivateVisibility\(fields\.visibility\)/);
    expect(router).toMatch(/correlationId: task\.userMessageId, privateRun: isPrivateVisibility\(task\.visibility\)/);
  });

  it('a run that goes on inside a turn reads the classification on the router\'s own role, which its speak session could not', () => {
    expect(router).toMatch(/const routerRoleChimeClient = chimeMessagingClient\(/);
    expect(router).toMatch(/return readChannelClassificationTag\(routerRoleChimeClient, channelArn, '\[Router\]'\);/);
  });

  it('a yes goes on in its own turn alone and says only a real failure; a kept subject is the service\'s to continue', () => {
    const at = router.indexOf('async function answerSubjectOffer(');
    const body = router.slice(at, router.indexOf('\n}\n', at));
    expect(body).toMatch(/\.\.\.\(answer === 'move' \? \{ continuedByCaller: true \} : \{\}\)/);
    expect(body).toMatch(/if \(answer === 'keep'\) return 'kept';\s*const went = await keepingTheTurnsSession\(/);
    expect(body).toMatch(/return went\.ran && !went\.moveFailed \? 'moved' : 'not-moved';/);
    expect(body).toMatch(/relayed\.error === 'REFUSED' && answer === 'move' \? 'not-moved' : 'gone'/);
  });

  it('an answered offer is not recently ended work, so detection goes on after it', () => {
    expect(router).toMatch(/RECENTLY_ENDED_WINDOW_MS && ended\?\.workflowRun\?\.event !== 'subject-changed'/);
  });

  it('every hand-back of a rule\'s run carries the rule, or the run is refused when it goes on', () => {
    // ONE COPY OF THE RUN'S IDENTITY, the rule among it, spread onto every record that continues the run.
    expect(router.match(/ctx\.ruleEvent \? \{ ruleEvent: ctx\.ruleEvent \} : \{\}/g)!.length).toBe(1);
    expect(router.match(/\.\.\.runIdentity\(ctx\)/g)!.length).toBeGreaterThanOrEqual(6);
  });

  it('a move step acts on a speak session of its own, taken before anything it reads, records or posts', () => {
    const at = router.indexOf('async function openMovedSubject(');
    const body = router.slice(at, router.indexOf('\n}\n', at));
    const speaks = body.indexOf('await speakingAs({ botArn: who.botArn, channelArn: ctx.channelArn');
    expect(speaks).toBeGreaterThan(-1);
    expect(body.slice(speaks)).toMatch(/purpose: 'event'/);
    for (const later of ['resolveChannelSize(', 'moveSubject(', 'sendInParts(']) expect(body.indexOf(later)).toBeGreaterThan(speaks);
  });

  it('a move refuses a person no longer in the room, whichever audience it carries', () => {
    const at = router.indexOf('async function openMovedSubject(');
    const body = router.slice(at, router.indexOf('\n}\n', at));
    expect(body).toMatch(/if \(!\(size\.members \?\? \[\]\)\.some\(\(m\) => m\.arn === sender\)\) return 'failed';/);
    expect(body.indexOf("m.arn === sender)) return 'failed'")).toBeLessThan(body.indexOf('if (!privately) memberArns'));
  });

  it('a notice\'s claim is spent only once its assistant may say it, in the run\'s own version', () => {
    const fn = router.slice(router.indexOf('async function handleStateNotice('), router.indexOf('async function handleTaskReopened('));
    expect(fn.indexOf("if (assistant.decision === 'decline')")).toBeLessThan(fn.indexOf('claimEventStep('));
    expect(fn).toMatch(/runOriginVersion\(assistant\.profile\.name, task\.channelArn, task\.workflowRun\?\.origin\)/);
  });

  it('a single-turn intent\'s run is joined with the answer\'s dispatch, not awaited in front of it', () => {
    expect(router).toMatch(/sideRun = inboundTaskFields\(\)\.then\(\(fields\) => startIntentRun\(\{/);
    expect(router).toMatch(/askRoomToBeNamed\(asyncProcessorArn\), sideRun\]\);/);
    expect(router).not.toMatch(/await startIntentRun\(\{\s+intent: classification\.intent/);
  });
});

describe('a run reads the task it actually ran', () => {
  it('reads the machine its own task ran on its edges', async () => {
    const wf = {
      on: 'person-joined', initial: 'work',
      states: {
        work: { task: { machine: 'report_generation', for: 'joined', deadline: { afterMinutes: 60 } }, onSuccess: [{ to: 'yes', when: { 'task:state': { op: 'eq', value: 'completed' } } }, { to: 'no' }], onFailure: 'no' },
        yes: { send: { to: 'joined', template: 'workflow-step-withheld' }, onSuccess: 'done', onFailure: 'done' },
        no: { send: { to: 'joined', template: 'workflow-step-withheld' }, onSuccess: 'done', onFailure: 'done' },
        done: { disposition: 'success' },
      },
    } as unknown as EventWorkflow;
    const sent: string[] = [];
    const d: EventRunDeps = {
      claimRun: async () => true, claimStep: async () => true, mentionName: async () => '', dispatchAgent: async () => true,
      send: async ({ step }) => { sent.push(step); return true; },
    };
    const ctx: EventRunContext = {
      event: 'person-joined', channelArn: 'arn:c', eventPerson: 'arn:x/user/p', values: {},
      gate: { lookup: () => undefined, values: {}, callSite: { identitySettled: true, conversationSettled: true, subjectSettled: true } as never },
    };
    await continueAfter('w', wf, ctx, { step: 'work', outcome: 'task:success:completed', machine: DEFAULT_TASK_STATE_MACHINES.queued_request }, d, DEFAULT_TASK_STATE_MACHINES);
    expect(sent).toEqual(['yes']);
  });

  it('a wait\'s claim fails closed, as every other claim does', () => {
    const src = readFileSync(resolve(__dirname, '../../lambda/src/lib/event-workflow.ts'), 'utf8');
    expect(src).toMatch(/deps\.claimStep\(at, 'waiting'\)\.catch\(\(\) => false\)/);
  });
});

describe('what a new version is written as', () => {
  it('an agent step whose only fallback was its absent message keeps an unconditioned last edge, and validates', () => {
    const first = AGENT_STEP_OPS_ROOM.states['first-look'] as unknown as { agent: Record<string, unknown> };
    const absentOnly = { ...AGENT_STEP_OPS_ROOM, states: { ...AGENT_STEP_OPS_ROOM.states, 'first-look': { ...first, agent: { ...first.agent, fallback: { absent: (first.agent.fallback as { absent: unknown }).absent } } } } } as unknown as EventWorkflow;
    const { workflow } = workflowInCurrentForm(absentOnly);
    expect(workflow.states['first-look'].onFailure).toEqual([{ to: 'first-look-absent', when: { 'task:outcome': 'no-worker' } }, { to: 'done' }]);
    expect(eventWorkflowErrors('ops-room', workflow)).toEqual([]);
  });

  it('DENY: a single-turn intent\'s workflow takes sends and an end, and no step that waits for a continuation', () => {
    const wf = {
      on: { intent: 'greeting' }, initial: 'pause',
      states: { pause: { wait: { minutes: 5 }, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' } },
    } as unknown as IntentWorkflow;
    expect(intentWorkflowErrors('greeting', wf, { multiStepIntents: [], intents: ['greeting'] }).join())
      .toMatch(/a single-turn intent's workflow runs in its request's turn, so it takes sends and an end/);
  });

  it('an offloaded intent workflow\'s role tasks stay on the definition, and the listing reads them', async () => {
    const workflows = {
      support_request: { on: { intent: 'support_request' }, initial: 'work', states: {
        work: { task: { machine: 'support_request', for: 'requester' }, onSuccess: 'escalate', onFailure: 'done' },
        escalate: { task: { machine: 'incident_first_look', by: { assistantRole: 'ops' }, deadline: { afterMinutes: 60 } }, onSuccess: 'done', onFailure: 'done' },
        done: { disposition: 'success' },
      } },
    };
    expect(roleTasksOf(workflows as never)).toEqual([{ workflow: 'support_request', step: 'escalate', role: 'ops', machine: 'incident_first_look' }]);
    const s3 = { send: async () => ({}) };
    const stored = await offloadBodies({ profileName: 'advisor', configId: 'c1', intentWorkflows: workflows } as unknown as ProfileDefinition, { s3: s3 as never, bucket: 'b' });
    expect(stored.intentWorkflows).toBeUndefined();
    expect(eventWorkflowsListedOf(JSON.stringify(stored)).activeRoleTasks).toEqual([{ workflow: 'support_request', step: 'escalate', role: 'ops', machine: 'incident_first_look' }]);
  });
});

describe('the second review\'s findings hold fixed', () => {
  it('a settled task is read on the machine it ran, whichever step opened it, and a run keeps the id it was keyed by', () => {
    expect(router).toMatch(/const settled = settledMachine \? \{ settledMachine \} : \{\};/);
    // Both continuations hand the settled machine on; the event's also names the step a resolve moves the run on to (O15).
    expect(router.match(/\}, (?:settled\)|\{ \.\.\.settled, )/g)).toHaveLength(2);
    expect(router).not.toMatch(/const ownMachine = /);
    expect(router).toMatch(/correlationId: keyedBy,/);
  });

  it('a single-turn intent\'s run reads the request\'s visibility inside itself, off the answer\'s path', () => {
    expect(router).toMatch(/sideRun = inboundTaskFields\(\)\.then\(\(fields\) => startIntentRun\(\{/);
  });

  it('a requester\'s turn on a task another person holds runs none of its step actions and hands over no document', () => {
    const core = readFileSync(resolve(__dirname, '../../lambda/src/lib/async-processor-core.ts'), 'utf8');
    expect(core).toMatch(/if \(taskContext && !taskContext\.requesterMoves\?\.length\) \{\s+const runs = await runStepActions/);
    expect(core).toMatch(/toolUse\.name === DELIVER_DOCUMENT_TOOL_NAME && taskContext\.requesterMoves\?\.length\) \{/);
    expect(core).toMatch(/!\(taskContext\.requesterMoves\?\.length && toolSpecName\(spec as never\) === DELIVER_DOCUMENT_TOOL_NAME\)/);
  });

  it('a version that no longer gives a role a task keeps no stale summary of one', async () => {
    const s3 = { send: async () => ({}) };
    const stored = await offloadBodies({
      profileName: 'advisor', configId: 'c2', intentWorkflows: { greeting: { on: { intent: 'greeting' }, initial: 'done', states: { done: { disposition: 'success' } } } },
      intentRoleTasks: [{ workflow: 'old', step: 's', role: 'ops', machine: 'm' }],
    } as unknown as ProfileDefinition, { s3: s3 as never, bucket: 'b' });
    expect(stored.intentRoleTasks).toBeUndefined();
  });

  it('a rewritten absent-only step whose failure ended the run still ends it on any other failure', () => {
    const first = AGENT_STEP_OPS_ROOM.states['first-look'] as unknown as { agent: Record<string, unknown> };
    const { onFailure: _f, ...noEdge } = AGENT_STEP_OPS_ROOM.states['first-look'] as Record<string, unknown>;
    const wf = { ...AGENT_STEP_OPS_ROOM, states: { ...AGENT_STEP_OPS_ROOM.states, 'first-look': { ...noEdge, agent: { ...first.agent, fallback: { absent: (first.agent.fallback as { absent: unknown }).absent } } } } } as unknown as EventWorkflow;
    const { workflow } = workflowInCurrentForm(wf);
    expect(workflow.states['first-look'].onFailure).toEqual([{ to: 'first-look-absent', when: { 'task:outcome': 'no-worker' } }, { to: 'first-look-ended' }]);
    expect(workflow.states['first-look-ended']).toEqual({ disposition: 'failure' });
  });

  it('a single-turn intent\'s workflow that opens its own task is refused once, for that', () => {
    const errs = intentWorkflowErrors('image_generation', {
      on: { intent: 'image_generation' }, initial: 'work',
      states: { work: { task: { machine: 'image_generation', for: 'requester' }, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' } },
    } as never, { multiStepIntents: [], intents: ['image_generation'], machines: DEFAULT_TASK_STATE_MACHINES });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/which a single-turn intent does not/);
  });

  it('every platform fact is put by one path', () => {
    const facts = readFileSync(resolve(__dirname, '../../lambda/src/lib/archive-facts.ts'), 'utf8');
    expect(facts.match(/new PutRecordCommand\(/g)).toHaveLength(1);
    expect(facts).toMatch(/return putRecord\('AE_TASK_SETTLED', fact, deps\);/);
  });
});

describe('the third review\'s findings hold fixed', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, '../../lambda/src/', p), 'utf8');

  it('an intent run\'s step is read from the assistant\'s own intent workflows, never another assistant\'s (WT118)', () => {
    expect(read('assistant-async-processor.ts')).toMatch(/\? intentRunWorkflows\(activeProfile\.intentWorkflows\)/);
  });

  it('a request opened mid-task is as private as its message (its stored Target; proven in a-requests-task-keeps-its-step-deadline)', () => {
    const proc = read('assistant-async-processor.ts');
    const block = proc.slice(proc.indexOf('// A NEW REQUEST MID-TASK (ADR-067 G15, WT106)'), proc.indexOf('model: cnBedrockModel ?? effectiveModel,'));
    expect(block).toMatch(/visibility: await requestVisibility\(/);
  });

  it('an empty selection allowed every workflow, so it carries nothing', () => {
    const body = { workflows: [], intentPack: { intents: [{ key: 'report_generation', delivery: 'TASK_MULTI_STEP' }] } } as never;
    const out = inCurrentFormOf(body);
    expect((out.body as { workflows?: unknown }).workflows).toBeUndefined();
    expect((out.body.intentPack as { intents: Array<{ delivery: string }> }).intents[0].delivery).toBe('TASK_MULTI_STEP');
  });

  it('a caller\'s origin machine is dropped under a platform key, or where it does not validate', () => {
    const svc = read('task-service.ts');
    expect(svc).toMatch(/const originOk = !!origin && !!taskType && !isPlatformMachineKey\(taskType\) && \(\(\) => \{\s+try \{ validateTaskStateMachine\(taskType, origin\); return true; \} catch \{ return false; \}/);
  });

  it('the request\'s own task step keeps its deadline and declares nothing else', () => {
    const r = read('router-agent-handler.ts');
    expect(r).toMatch(/\.\.\.\(deadline\.deadlineAt !== undefined \? \{ deadlineAt: deadline\.deadlineAt \} : \{\}\),/);
    expect(r).toMatch(/if \(deadline\.deadlineAt !== undefined\) await scheduleTaskDeadline\(args\.channelArn, opened\.taskId, deadline\.deadlineAt\);/);
    const errs = intentWorkflowErrors('report_generation', {
      on: { intent: 'report_generation' }, initial: 'work',
      states: { work: { task: { machine: 'report_generation', for: 'requester', by: 'requester', visibility: 'private' }, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' } },
    } as never, { multiStepIntents: ['report_generation'], machines: DEFAULT_TASK_STATE_MACHINES }).join('\n');
    expect(errs).toMatch(/task\.by: the request's own task is the requester's/);
    expect(errs).toMatch(/task\.visibility: the request's own task is the requester's/);
  });

  it('the requester\'s other questions are answered as ever, and a run\'s tasks are read together to cancel', () => {
    expect(read('lib/async-processor-core.ts')).toMatch(/Answer anything else they ask as you normally would\./);
    expect(read('task-service.ts')).toMatch(/for \(let i = 0; i < ids\.length; i \+= 25\) \{\s+const batch = await Promise\.all/);
  });
});
