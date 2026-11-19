/**
 * A REQUEST TO ANOTHER ASSISTANT RUNS THAT ASSISTANT'S OWN WORKFLOW (WT118, DESIGN-WORKFLOWS-AND-TASKS section 1, tenet D1).
 *
 * Ownership is never broken: work that needs another assistant is a request naming an intent it advertises, which its own
 * version runs; no step of one assistant's workflow runs a turn as another. What it proves:
 *  - DENY: an agent step naming another assistant's role (`as`) and its absent message are refused on a draft; a stored
 *    one is never dispatched by the router, and the processor takes none (the second layer);
 *  - DENY: a request may not shape the owner's work (visibility, priority, form fields, deadline), and an `ask` belongs to
 *    a request only; a request says what it needs with one of the asking assistant's own templates;
 *  - a stored request that shaped the owner's work is written without those fields on a new draft;
 *  - the shipped ops room and incident watch ask the ops assistant, and validate; the watch says what it needs;
 *  - the router asks: it reads only the advertisement, starts the owning assistant's own run on its served version as a
 *    request another assistant's run started, and writes what was asked and the asking run on the task; the asking run is
 *    continued on how the task ended, handed only its own values; the processor reads only its own version;
 *  - every run records what started it, and the archive and Effectiveness read it as the breakdown of one population.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { RunAbandoned, SHIPPED_EVENT_WORKFLOWS, continueAfter, holderOfRole, eventWorkflowErrors, runEventWorkflow, stepTakenBy, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import { requestAwaitingRun } from '../../lambda/src/lib/workflow-task';
import { askedTurnClaimStep, askedTurnOutcome, askedTurnWorkflow } from '../../lambda/src/lib/asked-turn';
import { shippedMessageTemplates } from '../../lambda/src/lib/shipped-message-templates';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';
import { workflowInCurrentForm } from '../../lambda/src/lib/retired-fields';
import { runFieldsOf } from '../../lambda/src/analytics-aurora/kinesis-archival';
import { workflowEditionRows } from '../../lambda/src/analytics-aurora/analytics-query';

const read = (f: string) => readFileSync(resolve(__dirname, '../../lambda/src', f), 'utf8');
const opts = { machines: DEFAULT_TASK_STATE_MACHINES };

const opsRoom = (step: Record<string, unknown>): EventWorkflow => ({
  on: 'conversation-opened', types: ['ops'], initial: 'look',
  states: {
    look: { ...step, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
} as unknown as EventWorkflow);

describe('no step runs as another assistant', () => {
  it('DENY: an agent step naming another assistant\'s role, and its absent message, are refused on a draft', () => {
    const errs = eventWorkflowErrors('watch', opsRoom({
      agent: { prompt: 'ops-first-look', as: { role: 'ops' }, to: 'room', fallback: { send: { to: 'room', template: 'ops-first-look-unavailable' }, absent: { to: 'room', template: 'ops-assistant-absent' } } },
    }), opts).join('\n');
    expect(errs).toMatch(/\.as is retired: an agent step runs as the run's own assistant/);
    expect(errs).toMatch(/fallback\.absent is retired with as/);
  });

  it('DENY: a stored step naming a role is never dispatched, and no assistant takes it', () => {
    expect(stepTakenBy({ as: { role: 'ops' } })).toBe(false);
    expect(stepTakenBy({})).toBe(true);
    const router = read('router-agent-handler.ts');
    expect(router).toMatch(/if \(_def\.as\) \{\s*console\.warn\('\[Router\]\[event-workflow\]\[SecurityEvent\][^\n]*\n\s*return false;/);
    // No dispatch carries a second assistant to act for: a run's runner is the one assistant that owns its event (`eventWorkflowOwner`).
    expect(router).not.toMatch(/ownerBotArn|workflowOwner:/);
  });

  it('the processor reads a step only from its own version', () => {
    const proc = read('assistant-async-processor.ts');
    expect(proc).not.toMatch(/ownerEventWorkflows|ownerIntentWorkflows|stepOwner/);
    expect(proc).toMatch(/if \(!stepTakenBy\(def\)\) \{/);
    expect(read('lib/active-profile.ts')).not.toMatch(/export async function owner(Event|Intent)Workflows/);
  });
});

describe('a request says what it needs, and the owner decides the rest', () => {
  it.each([
    ['who sees the work', { visibility: 'conversation' }, 'visibility'],
    ['how urgent it is', { priority: 'high' }, 'priority'],
    ['how quickly it is done', { deadline: { afterMinutes: 60 } }, 'deadline'],
  ])('DENY: a request may not set %s', (_label, extra, field) => {
    const errs = eventWorkflowErrors('ops-room', opsRoom({ task: { machine: 'incident_first_look', by: { assistantRole: 'ops' }, continue: 'opened', ...extra } }), opts).join('\n');
    expect(errs).toMatch(new RegExp(`task\\.${field} is the owning assistant's to declare`));
  });

  it('DENY: an ask belongs to a request, and is { template }', () => {
    const own = eventWorkflowErrors('ops-room', opsRoom({ task: { machine: 'acknowledgement', by: { participantRole: 'lead' }, ask: { template: 'incident-recheck-ask' }, deadline: { afterMinutes: 60 } } }), opts).join('\n');
    expect(own).toMatch(/task\.ask belongs to a request to another assistant's role/);
    const bad = eventWorkflowErrors('ops-room', opsRoom({ task: { machine: 'incident_first_look', by: { assistantRole: 'ops' }, ask: 'read it', continue: 'opened' } }), opts).join('\n');
    expect(bad).toMatch(/task\.ask is \{ template \}/);
  });

  it('a stored request that shaped the owner\'s work is written without it on a new draft', () => {
    const stored = opsRoom({ task: { machine: 'incident_first_look', by: { assistantRole: 'ops' }, visibility: 'conversation', priority: 'high', continue: 'opened' } });
    const { workflow, rewritten } = workflowInCurrentForm(stored);
    expect(rewritten).toEqual(['look']);
    expect(workflow.states.look).toMatchObject({ task: { machine: 'incident_first_look', by: { assistantRole: 'ops' }, continue: 'opened' } });
    expect((workflow.states.look as unknown as { task: Record<string, unknown> }).task).not.toHaveProperty('visibility');
    expect(eventWorkflowErrors('ops-room', workflow, opts).filter((e) => /\.task\./.test(e))).toEqual([]);
  });

  it('the shipped ops room and incident watch ask the ops assistant, and validate; the watch says what it needs', () => {
    const room = SHIPPED_EVENT_WORKFLOWS['ops-room'];
    const watch = SHIPPED_EVENT_WORKFLOWS['incident-watch'];
    expect(room.states['first-look']).toMatchObject({ task: { machine: 'incident_first_look', by: { assistantRole: 'ops' }, continue: 'opened' } });
    expect(watch.states.recheck).toMatchObject({ task: { machine: 'deployment_health', by: { assistantRole: 'ops' }, ask: { template: 'incident-recheck-ask' } } });
    expect(JSON.stringify(SHIPPED_EVENT_WORKFLOWS)).not.toMatch(/"as":/);
    expect(eventWorkflowErrors('ops-room', room, opts)).toEqual([]);
    expect(eventWorkflowErrors('incident-watch', watch, opts)).toEqual([]);
    expect(shippedMessageTemplates().get('incident-recheck-ask')?.entry.kind).toBe('message');
    expect(shippedMessageTemplates().has('ops-incident-recheck')).toBe(false);
  });
});

describe('the router asks, and the owner runs it', () => {
  const router = read('router-agent-handler.ts');
  const ask = router.slice(router.indexOf('async function askAnother('), router.indexOf('async function openWorkflowTaskStep('));

  it('DENY: two assistants in the room holding the role leave the request naming nobody, and the step fails', () => {
    const live = [
      { botArn: 'arn:i/bot/ops-a', role: 'ops', handle: 'ops-a' },
      { botArn: 'arn:i/bot/ops-b', role: 'ops', handle: 'ops-b' },
    ];
    const self = { botArn: 'arn:i/bot/advisor', role: 'advisor' };
    expect(holderOfRole('ops', { self, live, botsInRoom: ['arn:i/bot/ops-a', 'arn:i/bot/ops-b'] })).toBe('ambiguous');
    expect(holderOfRole('ops', { self, live, botsInRoom: ['arn:i/bot/ops-b'] })).toEqual({ botArn: 'arn:i/bot/ops-b', assistant: 'ops-b' });
    expect(router).toMatch(/if \(taker === 'ambiguous'\) \{[\s\S]{0,240}return 'failed';/);
  });

  it('reads only the advertisement, and never resolves the other assistant\'s definition for the asking run', () => {
    const roleBranch = router.slice(router.indexOf('// ANOTHER ASSISTANT\'S WORK IS A REQUEST'), router.indexOf('} else {\n      workerArn = one(def.by);'));
    expect(roleBranch).toMatch(/readAdvertisement\(takerAssistant\)/);
    expect(roleBranch).toMatch(/return askAnother\(/);
    expect(roleBranch).not.toMatch(/resolveActiveProfile/);
  });

  it('starts the owning assistant\'s own run on its served version, as a request another assistant\'s run started', () => {
    expect(ask).toMatch(/servedWelcomeVersion\(taker\.assistant, ctx\.channelArn\)/);
    expect(ask).toMatch(/startIntentRun\(\{[\s\S]*askedBy, trigger: ASKED_BY_ASSISTANT,/);
    expect(ask).toMatch(/workflowRun: run, askedBy, \.\.\.\(asked \? \{ requestExcerpt: asked \} : \{\}\)/);
    expect(ask).toMatch(/visibility: ctx\.privateRun \? 'private' : 'conversation'/);
    // The owner's run uses its declared workflow for the intent, or the standard one.
    expect(router).toMatch(/args\.version\?\.intentWorkflows\?\.\[args\.intent\] \?\? \(args\.askedBy \? canonicalIntentWorkflow\(args\.intent\) : undefined\)/);
  });

  it('the asking run is continued on how the task ended, handed only its own values', () => {
    expect(router).toMatch(/asker && askerOutcome \? continueRunOn\(asker, askerOutcome, \{ \.\.\.\(asker\.values \?\? \{\}\) \}/);
    expect(router).toMatch(/own && ownOutcome && !own\.holdsEnd \? continueRunOn\(own, ownOutcome, withRecordedRunValues\(own\.values, task, settledMachine\)/);
  });

  it('the task service writes the asking run and what was asked, and names the asking run\'s moment', () => {
    const svc = read('task-service.ts');
    expect(svc).toMatch(/\.\.\.\(input\.askedBy\?\.runKey \? \{ askedBy: input\.askedBy \} : \{\}\),/);
    expect(svc).toMatch(/requestExcerpt: typeof input\.requestExcerpt === 'string' \? input\.requestExcerpt : '',/);
    expect(svc).toMatch(/task\.askedBy\?\.continueOn === 'entered'/);
  });
});

describe('each run records what started it', () => {
  it('the archive projects it from a run\'s message or a task turn, one of three or nothing', () => {
    expect(runFieldsOf(true, { eventStep: { workflow: 'w', step: 's' }, eventRun: { runKey: 'k', trigger: 'assistant' } }, {}).workflow_trigger).toBe('assistant');
    expect(runFieldsOf(true, null, { workflowRun: { workflow: 'w', step: 's', runKey: 'k', trigger: 'person' } }).workflow_trigger).toBe('person');
    expect(runFieldsOf(true, { eventRun: { runKey: 'k', trigger: 'somebody' } }, {}).workflow_trigger).toBeNull();
    expect(runFieldsOf(false, { eventRun: { runKey: 'k', trigger: 'event' } }, {}).workflow_trigger).toBeNull();
    const sql = readFileSync(resolve(__dirname, '../../lambda/src/analytics-aurora/schema/100-a-runs-turns-record-what-started-it.sql'), 'utf8');
    expect(sql).toMatch(/ALTER TABLE messages ADD COLUMN IF NOT EXISTS workflow_trigger VARCHAR\(16\);/);
  });

  it('a run\'s sends and its task\'s turns carry it', () => {
    const router = read('router-agent-handler.ts');
    expect(router).toMatch(/const trigger: RunTrigger = ctx\.event === INTENT_TRIGGER \? \(ctx\.trigger \?\? 'person'\) : 'event';/);
    expect(read('lib/async-processor-core.ts')).toMatch(/trigger: params\.taskContext\.task\.workflowRun\.trigger/);
  });

  it('Effectiveness reads each edition as one population, broken down by what started its runs, with the same measures', () => {
    const q = read('analytics-aurora/analytics-query.ts');
    expect(q).toMatch(/SELECT 'trigger'::text AS dimension/);
    const rows = workflowEditionRows([{ dimension: 'trigger', workflow_trigger: 'assistant', runs: '4', ended: '4', succeeded: '3' }]);
    expect(rows[0]).toMatchObject({ runs: 4, success_share: 0.75 });
  });
});

describe('the seventh review\'s findings hold fixed', () => {
  const router = read('router-agent-handler.ts');

  it('a request has one task: its id is the request\'s, a run waits only on a row that was written, and a row that may have landed is read back', () => {
    expect(router).toMatch(/const requestTaskId = correlationId && !taskOpts\?\.taskId \? `req-\$\{contentHash12\(\{ correlationId, intent: classification\.intent, assistant: principalIdFromArn\(botArn\) \}\)\}` : undefined;/);
    expect(router).toMatch(/\.\.\.\(run \? \{ throwOnTaskWriteFailure: true \} : \{\}\),/);
    // The open without a run writes the same id once, or reads back the row that exists (createOnly).
    expect(router).toMatch(/: undefined\)\s*\/\/ THE REQUEST'S TASK WITHOUT A RUN[^\n]*\n\s*\?\? await openRequestTask\(\);/);
  });

  it('recording a run on an existing request is tried again, a conditional write that never records a second run', () => {
    expect(router).toMatch(/async function retryOnFault<T>\(call: \(\) => Promise<T \| undefined>, attempts = 3\)/);
  });

  it('DENY: an intent run asks another assistant only once its own task holds the run', () => {
    expect(router).toMatch(/if \(ctx\.event === INTENT_TRIGGER && !ctx\.runTaskId\) \{[\s\S]{0,200}return 'failed';/);
  });

  it('a workflow task no timeout ends is kept for the run\'s lifetime, and rework reads a deadline\'s ending from the state it was in', () => {
    expect(read('task-service.ts')).toMatch(/const ttlSeconds = !input\.workflowRun\.deadlineAt\s*\? Math\.min\(Math\.max\(60, input\.keepForSeconds \?\? 45 \* 24 \* 3600\), 45 \* 24 \* 3600\)/);
    expect(read('analytics-aurora/analytics-query.ts')).toMatch(/COALESCE\(f\.metadata->>'toState', f\.metadata->>'fromState'\)/);
  });

  it('the run\'s edition is computed once and handed to each step', () => {
    expect(router).toContain('openWorkflowTaskStep({ name, step, def, ctx, who, runKey, transitions, eventValues, edition, ...(opts?.joined ? { joined: true } : {}) })');
    expect((router.match(/runEdition\(who, ctx/g) ?? []).length).toBe(1);
  });
});

describe('the sixth review\'s findings hold fixed', () => {
  const router = read('router-agent-handler.ts');

  it('a request\'s own task that cannot be written abandons its run, taking no edge', async () => {
    const taken: string[] = [];
    const wf = {
      on: { intent: 'report_generation' }, initial: 'work',
      states: { work: { task: { machine: 'report_generation', for: 'requester' }, onSuccess: 'done', onFailure: 'tell' }, tell: { send: { to: 'requester', template: 'workflow-step-withheld' }, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' } },
    } as unknown as EventWorkflow;
    const deps = {
      claimRun: async () => true, claimStep: async () => true, mentionName: async () => '', dispatchAgent: async () => true,
      send: async ({ step }: { step: string }) => { taken.push(step); return true; },
      openTask: async () => { throw new RunAbandoned('not written'); },
    };
    const ctx = { event: 'intent', channelArn: 'arn:c', requester: 'arn:i/user/p', values: {} };
    await expect(runEventWorkflow('report_generation', wf, ctx as never, deps as never)).rejects.toBeInstanceOf(RunAbandoned);
    expect(taken).toEqual([]);
    expect(router).toMatch(/\.catch\(\(err\) => \{ throw new RunAbandoned\(/);
  });

  it('a run another assistant asked for goes on under the asking run\'s key, on the standard workflow where none is declared', () => {
    expect(router).toMatch(/const asked = own\?\.askedBy\?\.runKey && own\.askedBy\.step \? askedRunCorrelation\(own\.askedBy\) : undefined;/);
    // The standard workflow stands in only where the owner's served version was read and declares none.
    expect(router).toMatch(/\?\? \(asked && served \? canonicalIntentWorkflow\(str\(req\.workflow\)\) : undefined\)/);
    expect(router).toMatch(/correlationId: askedRunCorrelation\(askedBy\)/);
  });

  it('DENY: a requester\'s turn never takes the holder\'s automatic move', () => {
    expect(read('assistant-async-processor.ts')).toMatch(/if \(t && autoTo && response\.trim\(\) && !event\.battleContext && !event\.requesterMoves\?\.length\) \{/);
  });

  it('DENY: only a queued request its sender accepted awaits its run', () => {
    const q = { taskType: 'queued_request', openingIntent: 'report_generation', userMessageId: 'm' };
    expect(requestAwaitingRun({ ...q, taskState: 'accepted' })).toBe(true);
    expect(requestAwaitingRun({ ...q, taskState: 'dropped' })).toBe(false);
    expect(requestAwaitingRun({ ...q, taskState: 'proposed' })).toBe(false);
  });

  it('the person\'s list keeps the attached run\'s due time and lifetime, and the owner\'s run serves its experiment arm', () => {
    // Set in place on the mirror row that exists, never a whole row read before a concurrent move.
    expect(read('lib/task-tracking.ts')).toMatch(/if \(USER_TASKS_TABLE && owner && \(extra\.dueBy \|\| ttlSeconds\)\) \{\s*await dynamoClient\.send\(new UpdateCommand\(\{\s*TableName: USER_TASKS_TABLE,[\s\S]{0,300}ConditionExpression: 'attribute_exists\(taskId\)'/);
    expect(router).toMatch(/askedBy, trigger: ASKED_BY_ASSISTANT, served,/);
    expect(router).toMatch(/runnerOf\(args\.botArn, args\.assistant, args\.served \?\? /);
  });
});

describe('the eighth review\'s findings hold fixed', () => {
  const router = read('router-agent-handler.ts');
  const tracking = read('lib/task-tracking.ts');

  it('a request\'s task is written once under its id, and a second open reads back the row that exists', () => {
    expect(tracking).toMatch(/\.\.\.\(opts\?\.createOnly \? \{ ConditionExpression: 'attribute_not_exists\(taskId\)' \} : \{\}\),/);
    expect(tracking).toMatch(/if \(opts\?\.createOnly && \(error as \{ name\?: string \}\)\?\.name === 'ConditionalCheckFailedException'\) \{[\s\S]{0,200}ConsistentRead: true/);
    expect(router).toMatch(/\.\.\.\(requestTaskId \? \{ taskId: requestTaskId, createOnly: true \} : \{\}\),/);
  });

  it('a run waits only on a row that names it, raised only where the task row itself did not land', () => {
    expect(router).toMatch(/\.\.\.\(run \? \{ throwOnTaskWriteFailure: true \} : \{\}\),/);
    expect(router).toMatch(/if \(opened\.workflowRun\?\.runKey !== ownRun\) throw new RunAbandoned\(/);
    expect(router).toMatch(/ttlSeconds: deadline\.ttlSeconds \?\? 45 \* 24 \* 3600/);
  });

  it('recording a run hands back the row it wrote; a refusal is an answer, and only a fault is tried again', () => {
    expect(tracking).toMatch(/ReturnValues: 'ALL_NEW',/);
    expect(tracking).toMatch(/if \(\(err as \{ name\?: string \}\)\?\.name === 'ConditionalCheckFailedException'\) return null;\s*console\.error\('\[task-tracking\] could not record a run on a request'[^\n]*\n\s*throw err;/);
    expect(router).toMatch(/const attached = await retryOnFault\(\(\) => attachRequestRun\(/);
  });

  it('a request opened mid-task is the assistant\'s to take up first, and opens only where its message is known', () => {
    const proc = read('assistant-async-processor.ts');
    expect(proc).toMatch(/if \(!event\.userMessageId\) return \{\};/);
    expect(proc).toMatch(/owner: \{ id: principalIdFromArn\(event\.botArn\), type: 'assistant' \},/);
  });

  it('a stored copy of the incident watch\'s re-read is written as the shipped request', () => {
    const stored = {
      on: 'alarm-state-changed', types: ['ops'], initial: 'announce',
      states: {
        announce: { send: { to: 'room', template: 'incident-alarm-changed' }, onSuccess: 'recheck', onFailure: 'recheck' },
        recheck: { agent: { prompt: 'ops-incident-recheck', as: { role: 'ops' }, tools: ['read_deployment_health'], reads: 'messages', to: 'room', deadlineMs: 20000, fallback: { send: { to: 'room', template: 'ops-first-look-unavailable' }, absent: { to: 'room', template: 'ops-assistant-absent' } } }, onSuccess: 'done', onFailure: 'done' },
        done: { disposition: 'success' },
      },
    } as unknown as EventWorkflow;
    const { workflow, rewritten } = workflowInCurrentForm(stored);
    expect(rewritten).toEqual(['recheck']);
    expect(workflow.states.recheck).toMatchObject({ task: { machine: 'deployment_health', by: { assistantRole: 'ops' }, ask: { template: 'incident-recheck-ask' } } });
    expect(eventWorkflowErrors('incident-watch', workflow, opts)).toEqual([]);
  });

  it('an intent workflow\'s trigger is refused as what it is', () => {
    expect(eventWorkflowErrors('report_generation', { on: 'person-joined', initial: 'x', states: {} }, { intent: 'report_generation' } as never))
      .toEqual(['intentWorkflows.report_generation.on is { intent: report_generation }']);
  });
});

describe('the ninth review\'s findings hold fixed', () => {
  const router = read('router-agent-handler.ts');

  it('a settlement continues a run that goes on once the work starts, where the task ended before it left its first step', () => {
    expect(router).toMatch(/return r\.kind === 'settled' \? settlementOutcome\(task, machines\) : undefined;/);
  });

  it('a lost answer to recording a run is tried again, and a refusal that is its own earlier write is taken', () => {
    expect(router).toMatch(/const attached = await retryOnFault\(\(\) => attachRequestRun\(/);
    expect(router).toMatch(/if \(row\?\.workflowRun\?\.runKey === run\.runKey\) return row;/);
  });

  it('every run message carries what started it: a send, an agent step, and a voiced send', () => {
    const proc = read('assistant-async-processor.ts');
    // An agent step's message reads it from the turn's stamp (an asked turn's is the owner's own run); a voiced send's from the send.
    expect(proc).toMatch(/\.\.\.\(stamp\.trigger \? \{ trigger: stamp\.trigger \} : \{\}\),/);
    expect(proc).toMatch(/\.\.\.\(req\.runTrigger \? \{ trigger: req\.runTrigger \} : \{\}\),/);
    expect(router).toMatch(/runTrigger: edition\.trigger,/);
    expect(router).toMatch(/\.\.\.\(args\.edition\?\.trigger \? \{ runTrigger: args\.edition\.trigger \} : \{\}\),/);
  });

  it('DENY: a request\'s continue is one the platform knows, and its ask a message template the assistant has', () => {
    const typo = eventWorkflowErrors('ops-room', opsRoom({ task: { machine: 'incident_first_look', by: { assistantRole: 'ops' }, continue: 'start' } }), opts).join('\n');
    expect(typo).toMatch(/task\.continue is opened/);
    const missing = eventWorkflowErrors('ops-room', opsRoom({ task: { machine: 'incident_first_look', by: { assistantRole: 'ops' }, ask: { template: 'incident-rechek-ask' } } }), opts).join('\n');
    expect(missing).toMatch(/task\.ask\.template names incident-rechek-ask, which is not a message template this assistant has/);
  });

  it('a create that finds its row reads it first and numbers nothing, and a lost row is never handed back', () => {
    const tracking = read('lib/task-tracking.ts');
    expect(tracking.indexOf("if (opts?.createOnly && TASKS_TABLE && opts.taskId) {")).toBeLessThan(tracking.indexOf('const taskRef = TASKS_TABLE'));
    expect(tracking).toMatch(/if \(existing\.Item\) return existing\.Item as Task;[\s\S]{0,160}throw error;/);
  });

  it('a stored re-read keeps its own messages, edges and gate, under names no other step holds', () => {
    const stored = {
      on: 'alarm-state-changed', types: ['ops'], initial: 'announce',
      states: {
        announce: { send: { to: 'room', template: 'incident-alarm-changed' }, onSuccess: 'recheck', onFailure: 'recheck' },
        recheck: { agent: { prompt: 'ops-incident-recheck', as: { role: 'ops' }, to: 'room', deadlineMs: 20000, fallback: { send: { to: 'room', template: 'workflow-opening' }, absent: { to: 'room', template: 'ops-assistant-absent' } } }, when: { 'event:alarmState': 'ALARM' }, onSuccess: 'done', onFailure: 'after' },
        'recheck-unavailable': { send: { to: 'room', template: 'ops-room-opening' }, onSuccess: 'done', onFailure: 'done' },
        after: { disposition: 'failure' },
        done: { disposition: 'success' },
      },
    } as unknown as EventWorkflow;
    const { workflow } = workflowInCurrentForm(stored);
    expect(workflow.states['recheck-unavailable']).toEqual(stored.states['recheck-unavailable']);
    expect(workflow.states['recheck-unavailable-2']).toEqual({ send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'after', onFailure: 'after' });
    expect(workflow.states.recheck).toMatchObject({
      when: { 'event:alarmState': 'ALARM' }, onSuccess: 'done',
      onFailure: [{ to: 'recheck-absent', when: { 'task:outcome': 'no-worker' } }, { to: 'recheck-unavailable-2' }],
    });
  });

  it('a request resolves its role by name, and no agent step names another assistant', () => {
    expect(router).toMatch(/const taker = await roleHolder\(role, ctx\.channelArn, who\.botArn\);/);
    expect(router).not.toMatch(/stepTaker|taker\.assistant \?/);
  });
});

describe('the tenth review\'s findings hold fixed', () => {
  const router = read('router-agent-handler.ts');
  const svc = read('task-service.ts');

  it('a request\'s task id names the assistant answering it, so two assistants never share one', () => {
    expect(router).toMatch(/contentHash12\(\{ correlationId, intent: classification\.intent, assistant: principalIdFromArn\(botArn\) \}\)/);
  });

  it('a deadline at a recorded time falls no later than the longest a step may set', async () => {
    const { taskStepDeadline } = await import('../../lambda/src/router-agent-handler');
    const now = 1_800_000_000;
    const far = new Date((now + 60 * 24 * 3600) * 1000).toISOString();
    const d = taskStepDeadline({ deadline: { at: 'task:value:t' } } as never, { 'task:value:t': far }, now);
    expect(d).toMatchObject({ deadlineAt: now + 30 * 24 * 3600 });
  });

  it('an operator\'s cancel releases the requests the run made, which stay their owners\' work', () => {
    expect(svc).toMatch(/if \(task\?\.askedBy\?\.runKey === runKey\) \{ await releaseAskedBy\(task\.taskId, channelArn, runKey\); continue; \}/);
    expect(read('lib/task-tracking.ts')).toMatch(/UpdateExpression: 'REMOVE askedBy SET updatedAt = :now',\s*ConditionExpression: 'askedBy\.runKey = :rk',/);
  });

  it('a reminder is spent only once its assistant may say it, and the chain goes on whatever one send did', () => {
    const fn = router.slice(router.indexOf('async function handleTaskReminderFired('), router.indexOf('async function handleTaskReminderFired(') + 3000);
    expect(fn.indexOf('const assistant = await assistantOfBot(')).toBeLessThan(fn.indexOf('claimEventStep('));
    expect(fn).toMatch(/if \(assistant\.decision === 'decline'\) \{ await scheduleNext\(\); return/);
  });

  it('an intent continuation keeps the machine its task ran, the requester\'s candidates are read together, and a requester\'s turn opens no request', () => {
    expect(router).toMatch(/if \(req\?\.event === INTENT_TRIGGER\) return handleIntentContinuation\(req, opts\);/);
    expect(svc).toMatch(/const read = await Promise\.all\(rows\.map\(\(row\) => getTask\(row\.taskId, channelArn\)/);
    const core = read('lib/async-processor-core.ts');
    expect(core).toMatch(/config\.newRequest\?\.intents\.length && !taskContext\.requesterMoves\?\.length \? \[openNewRequestToolSpec/);
    expect(core).toMatch(/toolUse\.name === OPEN_NEW_REQUEST_TOOL_NAME && config\.newRequest && !taskContext\.requesterMoves\?\.length\)/);
  });
});

describe('nothing loops: no request chain and no chain of automatic moves runs without end', () => {
  it('DENY: an assistant a chain already asked for the same intent is not asked again, and a chain stops at its bound', () => {
    const router = read('router-agent-handler.ts');
    expect(router).toMatch(/const chain = \[\.\.\.\(ctx\.askChain \?\? \[\]\), `\$\{who\.assistant\}:\$\{args\.name\}`\];/);
    expect(router).toMatch(/if \(chain\.includes\(target\) \|\| chain\.length >= MAX_ASK_CHAIN\) \{[\s\S]{0,300}return 'failed';/);
    // The chain rides the owner's run, its own task, and every continuation of it.
    expect(router).toMatch(/askedBy, trigger: ASKED_BY_ASSISTANT, served, askChain: chain,/);
    expect(router).toMatch(/\.\.\.\(own\.workflowRun\?\.askChain\?\.length \? \{ askChain: own\.workflowRun\.askChain \} : \{\}\),/);
  });

  it('DENY: a machine whose automatic moves loop is refused', async () => {
    const { validateTaskStateMachine } = await import('../../lambda/src/lib/task-state-machines');
    const looping = {
      initial: 'a',
      states: {
        a: { transitions: ['b', 'done'], auto: 'b', prompt: 'p' },
        b: { transitions: ['a', 'done'], auto: 'a', prompt: 'p' },
        done: { transitions: [], terminal: 'success' },
      },
    };
    expect(() => validateTaskStateMachine('loop', looping as never)).toThrow(/automatic moves loop back to "a"/);
    const ending = { ...looping, states: { ...looping.states, b: { transitions: ['a', 'done'], prompt: 'p' } } };
    expect(() => validateTaskStateMachine('ends', ending as never)).not.toThrow(/automatic moves loop/);
  });
});

describe('what the room reads', () => {
  it('a state with a declared automatic move does not offer the model the move, which would lose its answer', () => {
    expect(read('lib/async-processor-core.ts')).toMatch(/toolSpecName\(spec as never\) === ADVANCE_TASK_STATE_TOOL_NAME && taskContext\.machines\[[^\]]*\]\?\.states\?\.\[toolState \?\? ''\]\?\.auto/);
  });

  it('the re-read is told the alarm\'s confirmed state, which its own read may not list', () => {
    const text = JSON.stringify(shippedMessageTemplates().get('incident-recheck-ask'));
    expect(text).toMatch(/do not report it as clear/);
  });

  it('an asked turn is measured as its own run: its time on its message, and its end recorded', () => {
    const proc = read('assistant-async-processor.ts');
    expect(proc).toMatch(/\{ totalMs: Date\.now\(\) - event\.triggerAtMs \}/);
    expect(proc).toMatch(/if \(asked && run\.won\) \{\s*await recordRunEnded\(\{\s*channelArn: event\.channelArn, runKey: asked\.run\.runKey, workflow: asked\.intent,/);
  });
});

describe('a request may name any intent its owner advertises', () => {
  const router = read('router-agent-handler.ts');
  const req = (intent: string) => ({ workflow: 'incident-watch', step: 'recheck', event: 'alarm-state-changed' as never, asked: { intent, ask: 'what changed', askerBotArn: 'arn:b', to: [], run: { runKey: 'k', trigger: 'assistant' as const } } });
  const pack = { intents: [
    { key: 'deployment_health', delivery: 'PLACEHOLDER_UPDATE', tools: ['read_deployment_health'] },
    { key: 'incident_first_look', delivery: 'TASK_MULTI_STEP' },
  ] };

  it('names an intent its machines say nothing about, whose edges read how the work ended', () => {
    const step = { task: { machine: 'a_team_intent', by: { assistantRole: 'ops' } }, onSuccess: 'done', onFailure: [{ to: 'done', when: { 'task:outcome': 'no-worker' } }, { to: 'done' }] };
    const errs = eventWorkflowErrors('w', { on: 'conversation-opened', types: ['ops'], initial: 'hello', states: {
      hello: { send: { to: 'room', template: 'ops-first-look-unavailable' }, onSuccess: 'ask', onFailure: 'ask' }, ask: step, done: { disposition: 'success' },
    } } as never, opts);
    expect(errs).toEqual([]);
    // The owner's states are its own: a request's edges cannot name one.
    const byState = { ...step, onSuccess: [{ to: 'done', when: { 'task:state': 'approved' } }, { to: 'done' }] };
    expect(eventWorkflowErrors('w', { on: 'conversation-opened', types: ['ops'], initial: 'hello', states: {
      hello: { send: { to: 'room', template: 'ops-first-look-unavailable' }, onSuccess: 'ask', onFailure: 'ask' }, ask: byState, done: { disposition: 'success' },
    } } as never, opts).join('\n')).toMatch(/task:state/);
  });

  it('DENY: a task of the run\'s own still names a machine this version may open', () => {
    const errs = eventWorkflowErrors('w', opsRoom({ task: { machine: 'a_team_intent', by: { participantRole: 'lead' }, deadline: { afterMinutes: 60 } } }), opts).join('\n');
    expect(errs).toMatch(/machine names a_team_intent/);
  });

  it('a single-turn intent is one step on the owner\'s own pack, with its tools, and opens no task', () => {
    const wf = askedTurnWorkflow(pack, req('deployment_health'))!;
    expect(wf.states.recheck.agent).toMatchObject({ prompt: 'asked-intent-turn', tools: ['read_deployment_health'], reads: 'messages' });
    expect(wf.states.recheck.task).toBeUndefined();
    expect(shippedMessageTemplates().get('asked-intent-turn')?.entry.kind).toBe('prompt');
  });

  it('DENY: an intent the owner does not declare, or a multi-step one, runs no such turn', () => {
    expect(askedTurnWorkflow(pack, req('nope'))).toBeUndefined();
    expect(askedTurnWorkflow(pack, req('incident_first_look'))).toBeUndefined();
  });

  it('the turn hands the asking run its ending, on the step\'s own edges, under a claim of its own', async () => {
    expect(askedTurnOutcome('posted')).toBe('task:success:answered');
    expect(askedTurnOutcome('timed-out')).toBe('task:failure:unanswered');
    expect(askedTurnClaimStep('recheck')).toBe('recheck#asked');
    const taken: string[] = [];
    const wf = { on: 'alarm-state-changed', types: ['ops'], initial: 'recheck', states: {
      recheck: { task: { machine: 'deployment_health', by: { assistantRole: 'ops' } }, onSuccess: 'good', onFailure: 'bad' },
      good: { send: { to: 'room', template: 'x' }, onSuccess: 'done', onFailure: 'done' }, bad: { send: { to: 'room', template: 'x' }, onSuccess: 'done', onFailure: 'done' }, done: { disposition: 'success' },
    } } as unknown as EventWorkflow;
    const deps = { claimRun: async () => true, claimStep: async () => true, mentionName: async () => '', dispatchAgent: async () => true, send: async ({ step }: { step: string }) => { taken.push(step); return true; } };
    const ctx = { event: 'alarm-state-changed', channelArn: 'arn:c', values: {}, gate: { lookup: () => undefined, values: {}, callSite: { identitySettled: true, conversationSettled: true, subjectSettled: true } } };
    await continueAfter('w', wf, ctx as never, { step: 'recheck', outcome: askedTurnOutcome('posted') }, deps as never);
    expect(taken).toEqual(['good']);
    taken.length = 0;
    await continueAfter('w', wf, ctx as never, { step: 'recheck', outcome: askedTurnOutcome('timed-out') }, deps as never);
    expect(taken).toEqual(['bad']);
  });

  it('the router asks by what the owner advertises, and measures the turn as the owner\'s own run', () => {
    expect(router).toMatch(/const advertised = ad\?\.intents\.find\(\(i\) => i\.key === def\.machine\);/);
    expect(router).toMatch(/multiStep: advertised\.multiStep === true/);
    expect(router).toMatch(/run: \{ runKey: intentRunKey\(correlation, taker\.assistant\), \.\.\.\(origin \? \{ origin \} : \{\}\), trigger: ASKED_BY_ASSISTANT \}/);
    const proc = read('assistant-async-processor.ts');
    expect(proc).toMatch(/runKey: stamp\.runKey,/);
    expect(proc).toMatch(/botArn: asked \? asked\.askerBotArn : event\.botArn/);
    expect(proc).toMatch(/if \(asked\) return;/);
  });
});

describe('a role the run\'s own assistant holds is asked the same way', () => {
  const router = read('router-agent-handler.ts');

  it('the ops assistant\'s own room workflow asking the ops role runs its advertised intent, not a task nobody takes up', () => {
    expect(router).toMatch(/const takerAssistant = taker\.assistant \|\| \(taker\.botArn === who\.botArn \? who\.assistant : undefined\);/);
    expect(router).toMatch(/if \(takerAssistant\) \{\s*const ad = await readAdvertisement\(takerAssistant\)/);
    expect(router).toMatch(/taker: \{ botArn: taker\.botArn, assistant: takerAssistant \}/);
  });

  it('DENY: a message the flow is already answering is not queued again behind its own turn', () => {
    expect(router).toMatch(/if \(queuedMessageId && turnClaim\.heldBy === mentionCorrelationId\(queuedMessageId\)\) \{[\s\S]{0,300}?return formatLexSilentResponse\(event\);/);
    const gate = router.indexOf('turnClaim.heldBy === mentionCorrelationId(queuedMessageId)');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(router.indexOf('const queued = await enqueueMessage('));
  });

  it('a second entry for one message is logged at warn, so a duplicate entry is visible rather than absorbed', () => {
    expect(router).toMatch(/turnClaim\.heldBy === mentionCorrelationId\(queuedMessageId\)\) \{\s*console\.warn\('\[Router\] \[duplicate-entry\]/);
  });
});
