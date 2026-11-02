/**
 * AN EVENT STARTS A WORKFLOW (ADR-061 slice 1, SPEC-WELCOME-AND-CONTEXT FR25, SPEC-TASK-STATE-TRANSITIONS FR30).
 *
 * What it proves, as ADR-061 "What proves it" lists for slice 1: validation refuses what slice 1 does not run; a run
 * and each step are claimed exactly once, so a redelivered event greets nobody twice; the opening is a platform send
 * posted before any model call; an agent step ends in one message, its output or its fallback, and a reply that
 * arrives after the fallback is suppressed; a deadline, a model error, a guardrail and a refused meter each post the
 * fallback and record the outcome; where a `conversation-opened` workflow opens the room, the join posts nothing.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import {
  PLATFORM_EVENT_WORKFLOWS,
  eventWorkflowErrors,
  eventRunKey,
  inertMention,
  runEventWorkflow,
  continueAfter,
  openedWorkflowOf,
  welcomePlan,
  welcomeWorkflowOf,
  type EventRunContext,
  type EventRunDeps,
  type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import { runAgentStep } from '../../lambda/src/lib/event-agent-step';
import { claimEventRun, claimEventStep, EVENT_RUN_STATUS } from '../../lambda/src/lib/event-run-store';
import { shippedMessageTemplates } from '../../lambda/src/lib/shipped-message-templates';
import { welcomeWorkflowErrors } from '../../lambda/src/lib/profile-lifecycle';
import { TURN_KINDS } from '../../lambda/src/lib/turn-declaration';
import { ANSWERS_NO_MESSAGE_KINDS } from '../../lambda/src/lib/interaction-kinds';
import { classificationChannelScopedAllow, routerByNameStatements } from '../../lib/stacks/agent-classification-common';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const OPS = PLATFORM_EVENT_WORKFLOWS['ops-room'];

describe('validation (ADR-061 decision 8, slice 1)', () => {
  it('every platform workflow validates, and every template it names is shipped with the kind its step needs', () => {
    const shipped = shippedMessageTemplates();
    for (const [name, wf] of Object.entries(PLATFORM_EVENT_WORKFLOWS)) {
      expect(eventWorkflowErrors(name, wf)).toEqual([]);
      for (const def of Object.values(wf.states)) {
        if (def.send) expect(shipped.get(def.send.template)?.template.kind ?? 'message').toBe('message');
        if (def.send) expect(shipped.has(def.send.template)).toBe(true);
        if (def.agent) {
          expect(shipped.get(def.agent.prompt)?.template.kind).toBe('prompt');
          expect(shipped.has(def.agent.fallback.send.template)).toBe(true);
        }
      }
    }
  });

  const refused = (mutate: (wf: any) => void, pattern: RegExp, base: EventWorkflow = OPS) => {
    const wf = clone(base);
    mutate(wf);
    expect(eventWorkflowErrors('x', wf).join('\n')).toMatch(pattern);
  };

  it('refuses an agent step before the first send and a cycle', () => {
    refused((wf) => { wf.initial = 'first-look'; }, /initial must be a send/);
    refused((wf) => { wf.states['greet-lead'].onSuccess = 'opening'; }, /cycle/);
    refused((wf) => { wf.states['first-look'].onSuccess = 'opening'; }, /cycle/);
  });

  it('refuses an agent step with no deadline, no fallback, or a deadline past the platform maximum', () => {
    refused((wf) => { delete wf.states['first-look'].agent.deadlineMs; }, /deadlineMs/);
    refused((wf) => { wf.states['first-look'].agent.deadlineMs = 600_000; }, /deadlineMs.*at most 60000/);
    refused((wf) => { delete wf.states['first-look'].agent.fallback; }, /fallback must be a send/);
  });

  it('refuses a state-changing tool, an unknown tool, a proposal and a task the step would open', () => {
    refused((wf) => { wf.states['first-look'].agent.tools = ['advance_task_state']; }, /"advance_task_state", which changes state/);
    refused((wf) => { wf.states['first-look'].agent.tools = ['no_such_tool']; }, /not a registered tool/);
    // A proposal is built (slice 3d), held to the events its op is proposed at and to its one addressee.
    refused((wf) => { wf.states['first-look'].agent.propose = ['send_nudge']; }, /propose names send_nudge, which is proposed only at invitation-unredeemed/);
    refused((wf) => { wf.states['first-look'].agent.workflow = 'guided_troubleshooting'; }, /workflow names a task machine an event may open: incident_first_look/);
  });

  it('holds a participant role to the types the workflow declares, on a send and on an agent step alike (ADR-061 slice 3)', () => {
    refused((wf) => { wf.states['greet-lead'].send.to = { participantRole: 'organizer' }; }, /participant role organizer, which type ops does not declare/);
    refused((wf) => { wf.states.opening.send.mention = { lead: 'participantRole:organizer' }; }, /participant role organizer, which type ops does not declare/);
    refused((wf) => { wf.states['first-look'].agent.to = { participantRole: 'organizer' }; }, /participant role organizer, which type ops does not declare/);
    const agentToLead = clone(OPS) as any;
    agentToLead.states['first-look'].agent.to = { participantRole: 'lead' };
    // A step that opens a task the room works on posts to the room, so a step addressed to the lead opens none.
    delete agentToLead.states['first-look'].agent.workflow;
    agentToLead.states['first-look'].agent.fallback.send = { to: { participantRole: 'lead' }, template: 'ops-first-look-unavailable', mention: { lead: 'participantRole:lead' } };
    expect(eventWorkflowErrors('x', agentToLead)).toEqual([]);
  });

  it('holds a conditioned edge to its shape: its last alternative alone is unconditioned (ADR-060 slice 1d)', () => {
    refused((wf) => { wf.states.opening.onSuccess = [{ to: 'greet-lead', when: { 'conversation:type': 'ops' } }]; }, /last alternative, which carries no when/);
    refused((wf) => { wf.states.opening.onSuccess = [{ to: 'greet-lead' }, { to: 'first-look' }]; }, /carries no when, so the alternatives after it/);
    expect(eventWorkflowErrors('x', ((): EventWorkflow => { const wf = clone(OPS); (wf.states.opening as any).onSuccess = [{ to: 'greet-lead' }]; return wf; })())).toEqual([]);
  });

  it('holds each event to what it carries and where it runs', () => {
    refused((wf) => { wf.on = 'assistant-joined'; delete wf.types; wf.states['greet-lead'].send.to = { people: 'event:person' }; }, /event:person, which only conversation-opened, person-joined, invitation-sent, invitation-unredeemed carry/);
    refused((wf) => { delete wf.types; }, /declares the types an event opens/);
    refused((wf) => { wf.types = ['general']; }, /names general, which no event opens/);
    // Meeting-sourced events are NOT BUILT: their sources wait on the meetings code.
    refused((wf) => { (wf as { on: string }).on = 'meeting-joined'; }, /\.on is one of assistant-joined, conversation-opened, person-joined/);
  });
});

describe('a welcome that runs a workflow (ADR-061 decision 9, FR22, FR25, W1)', () => {
  const opened = { 'ops-room': PLATFORM_EVENT_WORKFLOWS['ops-room'] };
  it('the version\'s own assistant-joined workflow is the welcome, and the room\'s type selects a conversation-opened one', () => {
    const own = { 'opening-and-subject': PLATFORM_EVENT_WORKFLOWS['opening-and-subject'], ...opened };
    expect(welcomeWorkflowOf(own, undefined).name).toBe('opening-and-subject');
    expect(welcomeWorkflowOf(own, 'ops').name).toBe('opening-and-subject');
    expect(welcomePlan(welcomeWorkflowOf(own, undefined).workflow).runs).toBe(true);
    expect(openedWorkflowOf(own, 'ops')?.name).toBe('ops-room');
    expect(openedWorkflowOf(own, 'general')).toBeUndefined();
  });

  it('a conversation-opened workflow declares types an event opens, and one workflow answers for a type', () => {
    expect(welcomeWorkflowErrors({ modelKey: 'x', eventWorkflows: opened } as any)).toEqual([]);
    expect(welcomeWorkflowErrors({ modelKey: 'x', eventWorkflows: { mine: { ...PLATFORM_EVENT_WORKFLOWS['ops-room'], types: ['general'] } } } as any))
      .toEqual(expect.arrayContaining([expect.stringMatching(/types names general, which no event opens/)]));
    expect(welcomeWorkflowErrors({ modelKey: 'x', eventWorkflows: { ...opened, mine: PLATFORM_EVENT_WORKFLOWS['ops-room'] } } as any).join())
      .toMatch(/both run on conversation-opened in ops conversations/);
  });

  it('an agent step\'s tools are the own tools of the assistant that takes it', () => {
    // The ops room's first look is taken by the room's ops assistant (`as: { role: ops }`) with its own tools, so a primary
    // holding no health read is not refused for it (`a-step-that-reads-health-is-taken-by-the-ops-assistant.test.ts`).
    expect(welcomeWorkflowErrors({ modelKey: 'x', tools: ['load_company_context'], eventWorkflows: opened } as any)).toEqual([]);
  });
});

/** A claim store with DynamoDB's put-if-absent semantics. */
function claims() {
  const taken = new Map<string, string>();
  return {
    taken,
    claimRun: (key: string) => async () => { if (taken.has(key)) return false; taken.set(key, 'run'); return true; },
    claimStep: (key: string) => async (step: string, outcome: string) => {
      const k = `${key}#${step}`;
      if (taken.has(k)) return false;
      taken.set(k, outcome);
      return true;
    },
  };
}

describe('a run (ADR-061 decisions 2 and 5)', () => {
  const channelArn = 'arn:aws:chime:us-east-1:1:app-instance/ai/channel/ch-1';
  const lead = 'arn:aws:chime:us-east-1:1:app-instance/ai/user/lead-1';
  // The lead holds the ops room's `lead` role, read from the context row by the router (`holdersByRole`).
  const ctx: EventRunContext = { event: 'conversation-opened', channelArn, eventPerson: lead, roles: { lead: [lead] }, values: { label: 'API latency' } };

  function deps(store = claims(), over: Partial<EventRunDeps> = {}) {
    const key = eventRunKey('conversation-opened', 'ch-1', 'ops-premium');
    const sent: Array<{ template: string; values: Record<string, string>; to: string[] }> = [];
    const dispatched: string[] = [];
    const d: EventRunDeps = {
      claimRun: store.claimRun(key),
      claimStep: store.claimStep(key),
      mentionName: async () => '@Dana <ops>',
      send: async (a) => { sent.push({ template: a.template, values: a.values, to: a.to }); return true; },
      dispatchAgent: async (step) => { dispatched.push(step); return true; },
      ...over,
    };
    return { d, sent, dispatched, store };
  }

  it('posts its platform sends in order, mentioning the lead inertly, then hands the agent step over once', async () => {
    const { d, sent, dispatched } = deps();
    const out = await runEventWorkflow('ops-room', OPS, ctx, d);
    expect(out.ran).toBe(true);
    expect(sent.map((s) => [s.template, s.to])).toEqual([['ops-room-opening', []], ['ops-lead-welcome', [lead]]]);
    expect(sent[0].values).toEqual({ label: 'API latency', lead: 'Dana ops' });
    expect(dispatched).toEqual(['first-look']);
    expect(out.steps.map((s) => s.outcome)).toEqual(['posted', 'posted', 'dispatched']);
  });

  it('a redelivered event starts no second run and posts nothing', async () => {
    const store = claims();
    await runEventWorkflow('ops-room', OPS, ctx, deps(store).d);
    const again = deps(store);
    const out = await runEventWorkflow('ops-room', OPS, ctx, again.d);
    expect(out.ran).toBe(false);
    expect(again.sent).toEqual([]);
    expect(again.dispatched).toEqual([]);
  });

  it('a mention of someone who is not a member renders empty, and the line naming them drops', async () => {
    const { d, sent } = deps(claims(), { mentionName: async () => '' });
    await runEventWorkflow('ops-room', OPS, ctx, d);
    expect(sent[0].values).toEqual({ label: 'API latency' });
  });

  it('a subject send in a group conversation posts nothing and takes onSuccess', async () => {
    const wf = PLATFORM_EVENT_WORKFLOWS['opening-and-subject'];
    const { d, sent } = deps();
    const out = await runEventWorkflow('opening-and-subject', wf, { event: 'assistant-joined', channelArn, values: {} }, d);
    expect(sent.map((s) => s.template)).toEqual(['workflow-opening']);
    // The intake that follows the greeting is offered to the subject, and a group has none.
    expect(out.steps).toEqual([{ step: 'opening', outcome: 'posted' }, { step: 'greet-subject', outcome: 'skipped' }, { step: 'intake', outcome: 'skipped' }]);
  });

  it('an agent step that cannot be handed over posts its fallback, claimed once', async () => {
    const { d, sent, store } = deps(claims(), { dispatchAgent: async () => false });
    await runEventWorkflow('ops-room', OPS, ctx, d);
    expect(sent.map((s) => s.template)).toEqual(['ops-room-opening', 'ops-lead-welcome', 'ops-first-look-unavailable']);
    expect([...store.taken.values()]).toContain('fallback:not-dispatched');
  });

  it('a display name carrying a handle, a marker or a link is inert', () => {
    expect(inertMention('@ops-assistant')).toBe('ops-assistant');
    expect(inertMention('Dana https://evil.example/x [[ae:task-ref:1]]')).not.toMatch(/https?:|\[|@/);
    expect(inertMention('x'.repeat(200))).toHaveLength(64);
  });
});

describe('an agent step (ADR-061 decision 8)', () => {
  const template = shippedMessageTemplates().get('ops-first-look')!.template;
  function step(over: Partial<Parameters<typeof runAgentStep>[1]> = {}, store = new Map<string, string>()) {
    const posts: Array<[string, string]> = [];
    const d = {
      meter: async () => true,
      invoke: async () => ({ response: 'Two alarms are firing on the API.' }),
      claim: async (outcome: string) => { if (store.has('step')) return false; store.set('step', outcome); return true; },
      postOutput: async (content: string) => { posts.push(['output', content]); },
      postFallback: async (outcome: string) => { posts.push(['fallback', outcome]); },
      ...over,
    };
    return { d, posts, store };
  }

  it('asks its prompt with the event\'s fields as data, and posts its output once', async () => {
    const prompts: string[] = [];
    const { d, posts, store } = step({ invoke: async (p: string) => { prompts.push(p); return { response: 'Two alarms are firing on the API.' }; } });
    const out = await runAgentStep({ template, values: { label: 'API latency' }, deadlineMs: 1000 }, d);
    expect(out).toMatchObject({ outcome: 'posted', posted: true });
    expect(posts).toEqual([['output', 'Two alarms are firing on the API.']]);
    expect(store.get('step')).toBe('posted');
    expect(prompts[0]).toMatch(/<template-data>\nlabel: API latency\n<\/template-data>$/);
  });

  it('past its deadline posts the fallback, and the late reply is suppressed: the room holds one message', async () => {
    let resolveLate: (v: { response: string }) => void = () => undefined;
    const { d, posts, store } = step({ invoke: () => new Promise((r) => { resolveLate = r; }) });
    const out = await runAgentStep({ template, values: {}, deadlineMs: 5 }, d);
    expect(out).toMatchObject({ outcome: 'fallback:deadline', posted: true });
    resolveLate({ response: 'A late first look.' });
    await out.settled;
    expect(posts).toEqual([['fallback', 'fallback:deadline']]);
    expect(store.get('step')).toBe('fallback:deadline');
  });

  it('a model error, a guardrail on either side, an empty reply and a refused meter each post the fallback with their outcome', async () => {
    const cases: Array<[Partial<Parameters<typeof runAgentStep>[1]>, string]> = [
      [{ invoke: async () => { throw new Error('throttled'); } }, 'fallback:model_error'],
      [{ invoke: async () => ({ response: 'x', inputGuardBlocked: true }) }, 'fallback:guardrail'],
      [{ invoke: async () => ({ response: 'masked', guardrailFindings: ['guardrail.output.pii'] }) }, 'fallback:guardrail'],
      [{ invoke: async () => ({ response: '  ' }) }, 'fallback:empty'],
      [{ meter: async () => false }, 'fallback:meter'],
    ];
    for (const [over, outcome] of cases) {
      const invoke = jest.fn(over.invoke ?? (async () => ({ response: 'unused' })));
      const { d, posts } = step({ ...over, invoke });
      const out = await runAgentStep({ template, values: {}, deadlineMs: 1000 }, d);
      expect(out.outcome).toBe(outcome);
      expect(posts).toEqual([['fallback', outcome]]);
      if (outcome === 'fallback:meter') expect(invoke).not.toHaveBeenCalled();
    }
  });

  it('one responder: output that loses the claim is discarded rather than posted', async () => {
    const store = new Map([['step', 'fallback:deadline']]);
    const { d, posts } = step({}, store);
    const out = await runAgentStep({ template, values: {}, deadlineMs: 1000 }, d);
    expect(out).toMatchObject({ outcome: 'posted', posted: false });
    expect(posts).toEqual([]);
  });

  it('output the Amazon Chime SDK refuses is recorded post_failed at warning level, never posted', async () => {
    const refused = Object.assign(new Error('Channel Messages size limit exceeded'), { name: 'BadRequestException' });
    const logged: Array<Record<string, unknown>> = [];
    const warned: Array<Record<string, unknown>> = [];
    const { d, store } = step({
      postOutput: async () => { throw refused; },
      log: (e: Record<string, unknown>) => { logged.push(e); },
      warn: (e: Record<string, unknown>) => { warned.push(e); },
    });
    const out = await runAgentStep({ template, values: {}, deadlineMs: 1000 }, d);
    // The run is handed back as not delivered, so the router says the fallback and takes onFailure.
    expect(out).toMatchObject({ outcome: 'post_failed', posted: false, won: true });
    expect(store.get('step')).toBe('posted');
    expect(warned).toEqual([{ outcome: 'post_failed', posted: false, postFailed: 'BadRequestException', error: 'Channel Messages size limit exceeded' }]);
    expect([...logged, ...warned].filter((e) => e.outcome === 'posted' && e.postFailed)).toEqual([]);
  });

  it('a fallback the Amazon Chime SDK refuses is said at warning level and claims no delivery', async () => {
    const warned: Array<Record<string, unknown>> = [];
    const { d } = step({
      meter: async () => false,
      postFallback: async () => { throw Object.assign(new Error('bad'), { name: 'BadRequestException' }); },
      warn: (e: Record<string, unknown>) => { warned.push(e); },
    });
    const out = await runAgentStep({ template, values: {}, deadlineMs: 1000 }, d);
    expect(out).toMatchObject({ outcome: 'fallback:meter', posted: false, won: true });
    expect(warned).toEqual([expect.objectContaining({ outcome: 'fallback:meter', posted: false, postFailed: 'BadRequestException' })]);
  });

  it('the processor says a refused post through console.warn', () => {
    const processor = read('assistant-async-processor.ts');
    const branch = processor.slice(processor.indexOf('if (event.eventStep) {'), processor.indexOf('if (event.welcomePrompt) {'));
    expect(branch).toMatch(/warn: \(entry\) => console\.warn\('\[event-step\]'/);
  });

  it('a template that is not a prompt posts the fallback and asks no model', async () => {
    const invoke = jest.fn();
    const { d } = step({ invoke });
    const out = await runAgentStep({ template: shippedMessageTemplates().get('ops-room-opening')!.template, values: {}, deadlineMs: 1000 }, d);
    expect(out.outcome).toBe('fallback:template');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('the run record (ADR-061 decision 5)', () => {
  function table() {
    const items = new Map<string, Record<string, unknown>>();
    return {
      items,
      deps: {
        table: 'tasks', now: () => 1_700_000_000_000,
        send: async (cmd: any) => {
          const item = cmd.input.Item;
          expect(cmd.input.ConditionExpression).toBe('attribute_not_exists(taskId)');
          const k = `${item.taskId}|${item.channelArn}`;
          if (items.has(k)) throw Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' });
          items.set(k, item);
          return {};
        },
      },
    };
  }

  it('claims a run once per key, and marks it an event run that expires, never open work', async () => {
    const t = table();
    const runKey = eventRunKey('assistant-joined', 'ch-1', 'advisor');
    expect(runKey).toBe('assistant-joined#ch-1#advisor');
    expect(await claimEventRun({ runKey, channelArn: 'c', workflow: 'w' }, t.deps)).toEqual({ claimed: true });
    expect(await claimEventRun({ runKey, channelArn: 'c', workflow: 'w' }, t.deps)).toEqual({ claimed: false, reason: 'already_claimed' });
    // Two assistants opening one conversation each run their own.
    expect(await claimEventRun({ runKey: eventRunKey('assistant-joined', 'ch-1', 'ops'), channelArn: 'c', workflow: 'w' }, t.deps)).toEqual({ claimed: true });
    const item = [...t.items.values()][0];
    expect(item).toMatchObject({ taskId: 'event-run#assistant-joined#ch-1#advisor', eventRun: true, status: EVENT_RUN_STATUS, ttl: 1_700_000_000 + 7 * 24 * 3600 });
  });

  it('a step is claimed once whatever its outcome: one conditional write decides output or fallback', async () => {
    const t = table();
    const runKey = 'conversation-opened#ch-1#ops';
    expect((await claimEventStep({ runKey, channelArn: 'c', step: 'first-look', outcome: 'fallback:deadline' }, t.deps)).claimed).toBe(true);
    expect((await claimEventStep({ runKey, channelArn: 'c', step: 'first-look', outcome: 'posted' }, t.deps)).claimed).toBe(false);
    expect((await claimEventStep({ runKey, channelArn: 'c', step: 'opening', outcome: 'posted' }, t.deps)).claimed).toBe(true);
  });

  it('the task service claims only in a conversation its classification serves', () => {
    const svc = read('task-service.ts');
    expect(svc).toMatch(/async function claimEventRunOp[\s\S]{0,300}await refusesChannel\(input\.channelArn\)/);
    expect(svc).toMatch(/async function claimEventStepOp[\s\S]{0,300}await refusesChannel\(input\.channelArn\)/);
  });
});

describe('where it runs', () => {
  const router = read('router-agent-handler.ts');

  it('a room a conversation-opened workflow opens posts nothing at the join, and a welcome that runs posts its own opening', () => {
    const intent = router.slice(router.indexOf("if (lexIntentName === 'WelcomeIntent'"));
    expect(intent).toMatch(/const arrivals = arrivalWelcomeOwner\(\{ conversationType: welcomeTypeKey, own: loaded\.served\?\.version\.eventWorkflows \}\);\n\s+if \(channelArn && arrivals === 'conversation-opened'\) return formatLexNothingToPost\(event\);/);
    const site = intent.slice(intent.indexOf('const promptValues: Record<string, string> = {'));
    expect(site).toMatch(/if \(channelArn && loaded\.plan\.runs\) \{[\s\S]*?await runWorkflowFor\(loaded\.welcome\.name, loaded\.welcome\.workflow, \{\n\s+event: 'assistant-joined'[\s\S]*?return formatLexNothingToPost\(event\);/);
  });

  it('conversation-opened is verified before any workflow is read: the classification, then a type an event opens', () => {
    const fn = router.slice(router.indexOf('export async function handleConversationOpened('), router.indexOf('async function noticeSelection('));
    const order = ['resolveChannelClassificationTag(channelArn)', 'openedBy', 'primaryAssistantOf(', 'servedWelcomeVersion(', 'runWorkflowFor('].map((t) => fn.indexOf(t));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('the creator names the event and sends no separate welcome where a run greeted the room', () => {
    const creator = read('typed-conversation-from-event.ts');
    expect(creator).toMatch(/nameEventThroughRouter\(DEPLOYED_CLASSIFICATION, \{\n\s+event: 'conversation-opened'[\s\S]{0,200}\.catch\(\(\): \{ ran: boolean; people\?: string\[\] \} => \(\{ ran: false \}\)\)/);
    expect(creator).toMatch(/const welcomed = opened\.ran \? \{ said: 0, notSaid: 0 \} : await welcomeIntoOpenedConversation/);
  });

  it('the processor reads the agent step from the platform\'s workflow by name, metered machine-written', () => {
    const processor = read('assistant-async-processor.ts');
    const branch = processor.slice(processor.indexOf('if (event.eventStep) {'), processor.indexOf('if (event.welcomePrompt) {'));
    expect(branch).toMatch(/const wf = workflowFor\(stepWorkflows, req\.workflow\);/);
    expect(branch).toMatch(/machineWritten: true/);
    expect(branch).toMatch(/turnKind: 'event_step'/);
    expect(branch).toMatch(/tools: def\.tools \?\? \[\]/);
  });

  it('the agent step is a declared turn kind that answers no message', () => {
    expect(TURN_KINDS).toContain('event_step');
    expect(ANSWERS_NO_MESSAGE_KINDS).toContain('event_step');
  });
});

describe('IAM (ADR-061 "IAM this adds", the slice-1 rows)', () => {
  it('a source names an event only to its own classification\'s router', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S', { env: { account: '111111111111', region: 'us-east-1' } });
    const [invoke, readName] = routerByNameStatements(stack, ['premium']).map((s) => stack.resolve(s.toStatementJson()));
    expect(JSON.stringify(invoke.Condition)).toMatch(/premium/);
    expect(JSON.stringify(invoke.Condition)).not.toMatch(/basic|standard/);
    expect(JSON.stringify(readName.Resource)).toMatch(/assistant\/premium\/router-arn/);
    expect(JSON.stringify(readName.Resource)).not.toMatch(/assistant\/(basic|standard)\//);
  });
});

describe('steps after an agent step (ADR-061 decision 5)', () => {
  const channelArn = 'arn:aws:chime:us-east-1:1:app-instance/ai/channel/ch-2';
  const lead = 'arn:aws:chime:us-east-1:1:app-instance/ai/user/lead-2';
  const ctx: EventRunContext = { event: 'conversation-opened', channelArn, eventPerson: lead, values: { label: 'Disk full' } };
  const WF: EventWorkflow = {
    on: 'conversation-opened',
    types: ['ops'],
    initial: 'opening',
    states: {
      opening: { send: { to: 'room', template: 'ops-room-opening', mention: { lead: 'event:person' } }, onSuccess: 'look', onFailure: 'look' },
      look: {
        agent: { prompt: 'ops-first-look', tools: ['read_deployment_health'], to: 'room', deadlineMs: 5000, fallback: { send: { to: 'room', template: 'ops-first-look-unavailable' } } },
        onSuccess: 'tell-lead',
        onFailure: 'sorry',
      },
      'tell-lead': { send: { to: { people: 'event:person' }, template: 'ops-lead-welcome' }, onSuccess: 'done' },
      sorry: { send: { to: { people: 'event:person' }, template: 'ops-first-look-unavailable' }, onSuccess: 'done' },
      done: { disposition: 'success' },
    },
  };
  const key = eventRunKey('conversation-opened', 'ch-2', 'ops-premium');

  function deps(store = claims()) {
    const sent: Array<{ template: string; to: string[]; transitions: Array<{ step: string; outcome: string }> }> = [];
    const d: EventRunDeps = {
      claimRun: store.claimRun(key),
      claimStep: store.claimStep(key),
      mentionName: async () => '',
      send: async (a) => { sent.push({ template: a.template, to: a.to, transitions: a.transitions }); return true; },
      dispatchAgent: async () => true,
    };
    return { d, sent, store };
  }

  it('a workflow may continue past an agent step', () => {
    expect(eventWorkflowErrors('x', WF)).toEqual([]);
  });

  it('after the output posts, the next send posts once; a redelivered hand-back posts nothing', async () => {
    const { d, sent, store } = deps();
    await runEventWorkflow('x', WF, ctx, d);
    expect(sent.map((s) => s.template)).toEqual(['ops-room-opening']);
    const first = await continueAfter('x', WF, ctx, { step: 'look', outcome: 'posted' }, d);
    expect(first).toMatchObject({ ran: true, ended: 'success' });
    expect(sent.map((s) => [s.template, s.to])).toEqual([['ops-room-opening', []], ['ops-lead-welcome', [lead]]]);
    const again = await continueAfter('x', WF, ctx, { step: 'look', outcome: 'posted' }, deps(store).d);
    expect(again.ran).toBe(false);
    expect(sent).toHaveLength(2);
    expect(store.taken.get(`${key}#end`)).toBe('success');
  });

  it('after the fallback, the run takes the failure edge', async () => {
    const { d, sent } = deps();
    await runEventWorkflow('x', WF, ctx, d);
    await continueAfter('x', WF, ctx, { step: 'look', outcome: 'fallback:deadline' }, d);
    expect(sent.map((s) => s.template)).toEqual(['ops-room-opening', 'ops-first-look-unavailable']);
  });

  it('after a refused post, the router says the fallback once and the run takes the failure edge', async () => {
    const { d, sent } = deps();
    await runEventWorkflow('x', WF, ctx, d);
    const out = await continueAfter('x', WF, ctx, { step: 'look', outcome: 'post_failed' }, d);
    expect(out.ran).toBe(true);
    expect(sent.map((s) => s.template)).toEqual(['ops-room-opening', 'ops-first-look-unavailable', 'ops-first-look-unavailable']);
    expect(sent[2].transitions).toEqual(expect.arrayContaining([{ step: 'look', outcome: 'post_failed' }]));
  });

  it('a hand-back for a run that already went on posts nothing', async () => {
    const store = claims();
    const { d } = deps(store);
    await runEventWorkflow('x', WF, ctx, { ...d, dispatchAgent: async () => false });
    const late = deps(store);
    expect((await continueAfter('x', WF, ctx, { step: 'look', outcome: 'posted' }, late.d)).ran).toBe(false);
    expect(late.sent).toEqual([]);
  });

  it('an agent step that cannot be handed over posts its fallback, then continues on its failure edge here', async () => {
    const { d, sent } = deps();
    const out = await runEventWorkflow('x', WF, ctx, { ...d, dispatchAgent: async () => false });
    expect(sent.map((s) => s.template)).toEqual(['ops-room-opening', 'ops-first-look-unavailable', 'ops-first-look-unavailable']);
    expect(out.ended).toBe('success');
  });

  it('each send carries the run\'s moves so far, which is how they reach the archive (rule 11)', async () => {
    const { d, sent } = deps();
    await runEventWorkflow('x', WF, ctx, d);
    await continueAfter('x', WF, ctx, { step: 'look', outcome: 'posted', transitions: [{ step: 'opening', outcome: 'posted' }] }, d);
    expect(sent[0].transitions).toEqual([{ step: 'opening', outcome: 'posted' }]);
    expect(sent[1].transitions).toEqual([{ step: 'opening', outcome: 'posted' }, { step: 'look', outcome: 'posted' }, { step: 'tell-lead', outcome: 'posted' }]);
  });

  it('only the invocation that won the step hands the run back, and the router recomputes the run key', () => {
    const processor = read('assistant-async-processor.ts');
    const branch = processor.slice(processor.indexOf('if (event.eventStep) {'), processor.indexOf('if (event.welcomePrompt) {'));
    expect(branch).toMatch(/await run\.settled;[\s\S]{0,1200}if \(run\.won\) await handBack\(run\.outcome\);/);
    expect(branch).toMatch(/const handBack = async \(outcome: string\) => continueEventRunThroughRouter\(/);
    expect(branch).toMatch(/eventRun: \{ runKey: req\.runKey, transitions:/);
    const router = read('router-agent-handler.ts');
    const fn = router.slice(router.indexOf('export async function handleEventContinuation('));
    // The natural key is recomputed from the conversation and, at person-joined, the person (`eventNaturalKey`).
    expect(fn).toMatch(/const naturalKey = eventNaturalKey\(wf\.on, channelArn, person\(req\.eventPerson\), str\(req\.invitationId\), alarm\);/);
    expect(fn).toMatch(/const runKey = eventRunKey\(wf\.on, naturalKey, assistant\.profile\.name\);\n\s+if \(str\(req\.runKey\) !== runKey\) return refuse/);
    expect(fn.indexOf('resolveChannelClassificationTag(channelArn)')).toBeLessThan(fn.indexOf('continueAfter('));
  });
});

describe('the event_step kind is named and measured (G3)', () => {
  it('every declared turn kind has a description in the console', () => {
    const locale = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'frontend', 'packages', 'shared', 'src', 'locales', 'en.json'), 'utf8'));
    for (const kind of TURN_KINDS) expect(typeof locale.admin.turnKinds.help[kind]).toBe('string');
  });

  it('an agent step\'s message carries its trigger and when the event happened, so it is timed from the event', () => {
    const processor = read('assistant-async-processor.ts');
    const branch = processor.slice(processor.indexOf('if (event.eventStep) {'), processor.indexOf('if (event.welcomePrompt) {'));
    expect(branch).toMatch(/trigger: 'event_step',\n\s+\.\.\.\(typeof event\.triggerAtMs === 'number' \? \{ triggerAtMs: event\.triggerAtMs \} : \{\}\)/);
    // The grid labels a declared kind by its own name, so event_step is never an unknown bucket.
    expect(read('analytics-aurora/analytics-query.ts')).toMatch(/WHEN \$\{declaredKind\} IS NOT NULL THEN \$\{declaredKind\}/);
  });
});

describe('no greeting twice (G4)', () => {
  it('a send that mentions a person by name records that the run greeted them; an empty mention does not', async () => {
    const greeted: string[] = [];
    const store = claims();
    const ctx: EventRunContext = { event: 'conversation-opened', channelArn: 'arn:x/channel/ch-3', eventPerson: 'arn:x/user/p1', roles: { lead: ['arn:x/user/p1'] }, values: { label: 'L' } };
    const base = { claimRun: store.claimRun('k'), claimStep: store.claimStep('k'), send: async () => true, dispatchAgent: async () => true, greeted: async (a: string) => { greeted.push(a); } };
    await runEventWorkflow('ops-room', OPS, ctx, { ...base, mentionName: async () => 'Dana' });
    expect(greeted).toEqual(['arn:x/user/p1']);
    const s2 = claims();
    await runEventWorkflow('ops-room', OPS, ctx, { ...base, claimRun: s2.claimRun('k'), claimStep: s2.claimStep('k'), mentionName: async () => '' });
    expect(greeted).toEqual(['arn:x/user/p1']);
  });

  it('the first turn greets by name only when the run record says no run greeted them', async () => {
    const { recordEventGreeting, wasGreetedByEventRun } = await import('../../lambda/src/lib/task-store');
    expect(await wasGreetedByEventRun({ channelArn: 'c9', personArn: 'arn:x/user/p9' })).toBe(false);
    await recordEventGreeting({ channelArn: 'c9', personArn: 'arn:x/user/p9' });
    expect(await wasGreetedByEventRun({ channelArn: 'c9', personArn: 'arn:x/user/p9' })).toBe(true);
    expect(await wasGreetedByEventRun({ channelArn: 'c8', personArn: 'arn:x/user/p9' })).toBe(false);
    expect(read('assistant-async-processor.ts')).toMatch(/const greet = isFirstUserTurn && !\(await wasGreetedByEventRun\(\{ channelArn: event\.channelArn, personArn: event\.senderArn \?\? '' \}\)/);
  });
});

describe('IAM deny tests the slice-1 rows call for', () => {
  it('only Amazon Lex is admitted by the router\'s resource policy; every other caller needs an identity grant naming it', () => {
    const stack = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'stacks', 'assistant-profile-stack.ts'), 'utf8');
    expect(stack).not.toMatch(/agentHandler\.addPermission\(|agentHandler\.grantInvoke\(new iam\.(ServicePrincipal|AnyPrincipal|AccountPrincipal)/);
    const permissions = stack.match(/new lambda\.CfnPermission\(this, '[^']+', \{\n\s+action: 'lambda:InvokeFunction',\n\s+functionName: agentHandler\.functionName,\n\s+principal: '[^']+'/g) ?? [];
    expect(permissions).toHaveLength(1);
    expect(permissions[0]).toMatch(/principal: 'lexv2\.amazonaws\.com'/);
  });

  it('the router\'s membership read, which mentions rely on, is refused on a channel at another classification', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S2', { env: { account: '111111111111', region: 'us-east-1' } });
    const statements = classificationChannelScopedAllow('premium', 'arn:aws:chime:us-east-1:111111111111:app-instance/ai', ['chime:ListChannelMemberships'], {
      actor: 'assistant', bearerResources: ['arn:aws:chime:us-east-1:111111111111:app-instance/ai/bot/*'],
    }).map((st) => stack.resolve(st.toStatementJson()));
    const channel = statements.find((st) => JSON.stringify(st.Resource).includes('/channel/'));
    expect(JSON.stringify(channel.Condition)).toMatch(/"premium"/);
    expect(JSON.stringify(channel.Condition)).not.toMatch(/"basic"|"standard"/);
  });
});
