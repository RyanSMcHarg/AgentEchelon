/**
 * A `prompt` WELCOME (SPEC-WELCOME-AND-CONTEXT FR22 and FR24, ADR-061 decision 9): since W1, the prompt step that
 * follows the opening in the assistant's welcome workflow.
 *
 * One welcome applies per conversation, selected by its type; the structured opening is returned first and
 * stands alone whatever the model turn does; the turn is dispatched once, as the joining assistant, with what the
 * conversation knows passed as data; and a turn that does not deliver posts nothing and records why.
 */
import * as fs from 'fs';
import * as path from 'path';
import { selectOpening } from '../../lambda/src/lib/welcome-orientation';
import { eventWorkflowErrors, welcomePlan, welcomeWorkflowOf, type EventWorkflow } from '../../lambda/src/lib/event-workflow';
import { eventWorkflowTemplateErrors, classificationServedBy } from '../../lambda/src/lib/profile-lifecycle';
import {
  dispatchWelcomePromptTurn,
  runWelcomePromptTurn,
  welcomePromptCorrelationId,
  type WelcomePromptRequest,
} from '../../lambda/src/lib/welcome-prompt-turn';
import { shippedMessageTemplates } from '../../lambda/src/lib/shipped-message-templates';
import { parseTemplate } from '../../lambda/src/lib/document-template';
import { putTemplate, activateTemplate } from '../../lambda/src/lib/template-store';
import { loadNamedPromptTemplate } from '../../lambda/src/lib/message-template-selection';
import { ANSWERS_NO_MESSAGE_KINDS, INTERACTION_KINDS } from '../../lambda/src/lib/interaction-kinds';

const greeting = () => shippedMessageTemplates().get('welcome-greeting')!.template;
const request = (over: Partial<WelcomePromptRequest> = {}): WelcomePromptRequest => ({
  template: 'welcome-greeting', tools: [], values: { topic: 'Q3 launch' }, ...over,
});

/** A welcome whose opening is followed by one prompt step, as a version declares it (W1). */
const promptWelcome = (template: string, tools?: string[], types?: string[]): EventWorkflow => ({
  on: 'assistant-joined', ...(types ? { types } : {}), initial: 'opening',
  states: {
    opening: { opening: {}, onSuccess: 'prompt', onFailure: 'prompt' },
    prompt: { prompt: { template, ...(tools ? { tools } : {}) }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
});

describe('which welcome applies (FR22)', () => {
  it('is the platform\'s opening when the version declares none', () => {
    expect(welcomePlan(welcomeWorkflowOf(undefined, undefined).workflow)).toEqual({ opening: {}, runs: false });
    expect(welcomePlan(welcomeWorkflowOf({}, 'ops').workflow).prompt).toBeUndefined();
  });

  it('a prompt welcome is its opening and its prompt step, said by the intent\'s reply', () => {
    const own = { welcome: promptWelcome('welcome-greeting', ['load_company_context']) };
    for (const type of [undefined, 'general']) {
      expect(welcomePlan(welcomeWorkflowOf(own, type).workflow)).toEqual({ opening: {}, prompt: { template: 'welcome-greeting', tools: ['load_company_context'] }, runs: false });
    }
  });

  it('a welcome for a type answers for that type only, and the one naming no type for every other room', () => {
    const own = {
      welcome: promptWelcome('welcome-greeting', ['load_company_context']),
      'welcome-ops': { ...promptWelcome('ops-hello', undefined, ['ops']) },
      'welcome-ops-team': { on: 'assistant-joined' as const, types: ['ops-team'], initial: 'o', states: { o: { opening: {}, onSuccess: 'd' }, d: { disposition: 'success' as const } } },
    };
    expect(welcomePlan(welcomeWorkflowOf(own, 'ops').workflow).prompt).toEqual({ template: 'ops-hello' });
    expect(welcomePlan(welcomeWorkflowOf(own, 'ops-team').workflow).prompt).toBeUndefined();
    expect(welcomePlan(welcomeWorkflowOf(own, 'general').workflow).prompt).toEqual({ template: 'welcome-greeting', tools: ['load_company_context'] });
  });

  it('the prompt and its tools are not orientation fields of the opening', () => {
    const plan = welcomePlan(promptWelcome('welcome-greeting', ['load_company_context']));
    expect(JSON.stringify(selectOpening(plan.opening))).not.toMatch(/welcome-greeting|load_company_context/);
  });
});

describe('what a version may name (FR22, FR24)', () => {
  it('accepts a prompt step with read tools after the opening', () => {
    expect(eventWorkflowErrors('welcome', promptWelcome('welcome-greeting', ['load_company_context']))).toEqual([]);
  });

  it('refuses a state-changing tool and an unknown one', () => {
    expect(eventWorkflowErrors('welcome', promptWelcome('welcome-greeting', ['advance_task_state'])))
      .toEqual([expect.stringMatching(/"advance_task_state", which changes state/)]);
    expect(eventWorkflowErrors('welcome', promptWelcome('welcome-greeting', ['no_such_tool'])))
      .toEqual([expect.stringMatching(/"no_such_tool", which is not a registered tool/)]);
  });

  it('refuses a prompt step that names no template, opens the room, is followed by a step, or runs on another event', () => {
    expect(eventWorkflowErrors('welcome', promptWelcome('Not A Name!'))[0]).toMatch(/names a prompt template/);
    const first = promptWelcome('welcome-greeting');
    first.initial = 'prompt';
    delete (first.states as Record<string, unknown>).opening;
    expect(eventWorkflowErrors('welcome', first).join()).toMatch(/initial must be a send or an opening/);
    const followed = promptWelcome('welcome-greeting');
    followed.states.prompt.onSuccess = 'opening';
    expect(eventWorkflowErrors('welcome', followed).join()).toMatch(/a prompt step's turn posts after the run has moved on/);
    const elsewhere = { ...promptWelcome('welcome-greeting'), on: 'person-joined' as const };
    expect(eventWorkflowErrors('welcome', elsewhere).join()).toMatch(/which only the welcome takes \(on assistant-joined\)/);
  });

  describe('the template it names exists', () => {
    const objects = new Map<string, string>();
    const params = new Map<string, string>();
    const deps = {
      bucket: 'b', ssmRoot: '/ae', now: () => 1,
      s3: { send: jest.fn(async (cmd: any) => {
        const i = cmd.input;
        if (cmd.constructor.name === 'PutObjectCommand') { objects.set(i.Key, i.Body); return {}; }
        if (cmd.constructor.name === 'ListObjectsV2Command') return { Contents: [...objects.keys()].filter((k) => k.startsWith(i.Prefix)).map((Key) => ({ Key })) };
        if (!objects.has(i.Key)) throw Object.assign(new Error('nk'), { name: 'NoSuchKey' });
        return { Body: { transformToString: async () => objects.get(i.Key) } };
      }) } as any,
      ssm: { send: jest.fn(async (cmd: any) => {
        const i = cmd.input;
        if (cmd.constructor.name === 'PutParameterCommand') { params.set(i.Name, i.Value); return {}; }
        if (!params.has(i.Name)) throw Object.assign(new Error('nf'), { name: 'ParameterNotFound' });
        return { Parameter: { Value: params.get(i.Name) } };
      }) } as any,
    };
    const assistant = 'ops-premium';
    const classification = classificationServedBy(assistant);

    it('a shipped prompt passes without a store read', async () => {
      expect(await eventWorkflowTemplateErrors({ eventWorkflows: { welcome: promptWelcome('welcome-greeting') } } as any, assistant, deps)).toEqual([]);
    });

    it('an unknown template is refused at the step that names it', async () => {
      const errors = await eventWorkflowTemplateErrors({ eventWorkflows: { 'welcome-ops': promptWelcome('nobody-wrote-this', undefined, ['ops']) } } as any, assistant, deps);
      expect(errors).toEqual([expect.stringMatching(/^eventWorkflows\.welcome-ops\.states\.prompt\.prompt\.template names "nobody-wrote-this", which is not a prompt template/)]);
    });

    it('a prompt saved to the assistant\'s own family passes, and the turn reads that one', async () => {
      const source = shippedMessageTemplates().get('welcome-greeting')!.source.replace('"name":"welcome-greeting"', '"name":"ops-hello"');
      expect(parseTemplate(source).name).toBe('ops-hello');
      const owner = { family: 'assistant' as const, assistant };
      const put = await putTemplate(classification, source, deps, { owner });
      await activateTemplate(classification, put.name, put.contentHash, deps, { owner });
      expect(await eventWorkflowTemplateErrors({ eventWorkflows: { welcome: promptWelcome('ops-hello') } } as any, assistant, deps)).toEqual([]);
      expect((await loadNamedPromptTemplate({ classification, assistant, name: 'ops-hello' }, deps))?.name).toBe('ops-hello');
      // Another assistant of the classification does not hold it.
      expect(await loadNamedPromptTemplate({ classification, assistant: 'someone-else', name: 'ops-hello' }, deps)).toBeUndefined();
    });
  });
});

describe('the turn (FR24)', () => {
  const run = async (invoke: (p: string) => Promise<any>, over: Partial<WelcomePromptRequest> = {}, template = greeting()) => {
    const posted: string[] = [];
    const recorded: string[] = [];
    const outcome = await runWelcomePromptTurn(request(over), template, {
      invoke, post: async (c) => { posted.push(c); }, record: (o) => { recorded.push(o); },
      emptyReplies: ['Done - nothing needed changing.'],
    });
    return { outcome, posted, recorded };
  };

  it('asks the template\'s instructions with the conversation\'s fields as delimited data, and posts the reply once', async () => {
    const prompts: string[] = [];
    const r = await run(async (p) => { prompts.push(p); return { response: 'Hi Dana, I can pull the launch numbers.' }; },
      { values: { topic: 'Q3 launch', people: 'Dana, Lee' } });
    expect(r).toEqual({ outcome: 'posted', posted: ['Hi Dana, I can pull the launch numbers.'], recorded: ['posted'] });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/^You have just joined this conversation/);
    expect(prompts[0]).toMatch(/<template-data>\ntopic: Q3 launch\npeople: Dana, Lee\n<\/template-data>$/);
  });

  it('past its deadline, posts nothing and records the deadline', async () => {
    const r = await run(() => new Promise((res) => setTimeout(() => res({ response: 'late' }), 200)), { deadlineMs: 10 });
    expect(r).toEqual({ outcome: 'fallback:deadline', posted: [], recorded: ['fallback:deadline'] });
  });

  it('on a model error, posts nothing and records it', async () => {
    const r = await run(async () => { throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' }); });
    expect(r).toEqual({ outcome: 'fallback:model-error', posted: [], recorded: ['fallback:model-error'] });
  });

  it('on a guardrail intervention on either side, posts nothing and records it', async () => {
    expect(await run(async () => ({ response: 'x', inputGuardBlocked: true }))).toEqual({ outcome: 'fallback:guardrail', posted: [], recorded: ['fallback:guardrail'] });
    expect(await run(async () => ({ response: 'masked', guardrailFindings: ['guardrail.output.pii'] }))).toEqual({ outcome: 'fallback:guardrail', posted: [], recorded: ['fallback:guardrail'] });
  });

  it('an empty reply, or the loop\'s line for one, is not a greeting', async () => {
    expect((await run(async () => ({ response: '   ' }))).outcome).toBe('fallback:empty');
    expect(await run(async () => ({ response: 'Done - nothing needed changing.' }))).toEqual({ outcome: 'fallback:empty', posted: [], recorded: ['fallback:empty'] });
  });

  it('a missing or non-prompt template posts nothing and asks no model', async () => {
    const invoke = jest.fn();
    expect((await run(invoke, {}, null as any)).outcome).toBe('fallback:template');
    expect((await run(invoke, {}, shippedMessageTemplates().get('stop-left-cancelled')!.template)).outcome).toBe('fallback:template');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('a failed post is recorded, and the turn never throws', async () => {
    const recorded: string[] = [];
    const outcome = await runWelcomePromptTurn(request(), greeting(), {
      invoke: async () => ({ response: 'Hello.' }),
      post: async () => { throw new Error('chime'); },
      record: (o) => { recorded.push(o); throw new Error('recording broke'); },
    });
    expect(outcome).toBe('fallback:post-failed');
    expect(recorded).toEqual(['fallback:post-failed']);
  });
});

describe('the dispatch (FR24)', () => {
  const channelArn = 'arn:aws:chime:us-east-1:1:app-instance/ai/channel/ch-1';
  const botArn = 'arn:aws:chime:us-east-1:1:app-instance/ai/bot/bot-9';

  it('dispatches once, as the joining assistant, with the conversation\'s fields and nothing read beside them', async () => {
    const invoke = jest.fn(async () => true);
    const out = await dispatchWelcomePromptTurn({ channelArn, botArn, classification: 'premium', request: request({ tools: ['load_company_context'] }) }, {
      processorArn: async () => 'arn:fn', invoke, now: () => 42,
    });
    expect(out).toBe('dispatched');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('arn:fn', {
      channelArn, botArn, classification: 'premium', correlationId: 'welcome-ch-1-bot-9',
      userMessage: '', userContent: '', trigger: 'welcome', triggerAtMs: 42,
      welcomePrompt: { template: 'welcome-greeting', tools: ['load_company_context'], values: { topic: 'Q3 launch' } },
    });
  });

  it('a redelivered join derives the same correlation, so the room is greeted once by each assistant', () => {
    expect(welcomePromptCorrelationId(channelArn, botArn)).toBe(welcomePromptCorrelationId(channelArn, botArn));
    expect(welcomePromptCorrelationId(channelArn, botArn.replace('bot-9', 'bot-2'))).not.toBe(welcomePromptCorrelationId(channelArn, botArn));
  });
});

describe('the turn meters and reads who is here itself, after the opening (FR2)', () => {
  it('a refused meter posts nothing, asks no model and records the fallback', async () => {
    const invoke = jest.fn();
    const post = jest.fn();
    const recorded: string[] = [];
    const out = await runWelcomePromptTurn(request(), greeting(), {
      meter: async () => false, invoke, post, record: (o) => { recorded.push(o); },
    });
    expect(out).toBe('fallback:meter');
    expect(recorded).toEqual(['fallback:meter']);
    expect(invoke).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('a meter that cannot be read refuses rather than spends', async () => {
    const out = await runWelcomePromptTurn(request(), greeting(), {
      meter: async () => { throw new Error('ddb'); }, invoke: jest.fn(), post: jest.fn(), record: jest.fn(),
    });
    expect(out).toBe('fallback:meter');
  });

  it('who is here is passed as data, and a roster that cannot be read leaves the people out rather than the turn', async () => {
    const prompts: string[] = [];
    const invoke = async (p: string) => { prompts.push(p); return { response: 'Hello.' }; };
    await runWelcomePromptTurn(request(), greeting(), { meter: async () => true, people: async () => ['Dana', '', 'Lee'], invoke, post: jest.fn(), record: jest.fn() });
    await runWelcomePromptTurn(request(), greeting(), { meter: async () => true, people: async () => { throw new Error('chime'); }, invoke, post: jest.fn(), record: jest.fn() });
    expect(prompts[0]).toMatch(/topic: Q3 launch\npeople: Dana, Lee\n/);
    expect(prompts[1]).not.toMatch(/people:/);
  });
});

describe('where the router and processor run it', () => {
  const src = (f: string) => fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', f), 'utf8');
  const router = src('router-agent-handler.ts');
  const processor = src('assistant-async-processor.ts');

  /** The source between two markers, so an await added anywhere on the welcome's path is seen. */
  const between = (text: string, from: string, to: string) => {
    const i = text.indexOf(from);
    const j = text.indexOf(to, i);
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    return text.slice(i, j);
  };
  const OPENING = "return formatLexResponse(event, [{ contentType: 'PlainText', content: withTurnDeclaration(welcome.content, { kind: 'welcome' }) }]);";

  it('a welcome said by the reply waits on nothing new: its workflow comes from the profile read that composed the opening', () => {
    const load = between(router, 'async function loadWelcomeFor(', 'async function loadWelcomeOrientation(');
    // One profile read, the one the opening always made, and the welcome selected from it without another.
    expect(load.match(/await /g)).toHaveLength(2);
    // The served version: the active one, with the experiment arm read beside it rather than after it.
    expect(load).toMatch(/served = await servedWelcomeVersion\(profileName, channelArn\);/);
    expect(router).toMatch(/await Promise\.all\(\[resolveActiveProfile\(profileName, \{ ssm: ssmClient, ssmRoot: SSM_ROOT \}\), armRead\]\)/);
    expect(load).toMatch(/\n\s+welcome = welcomeWorkflowOf\(active\.eventWorkflows, conversationType\);/);
    expect(load).toMatch(/return \{ \.\.\.\(await loadWelcomeOrientation\(\)\), welcome, plan, served \};/);
    // Between the composed opening and its return, every await sits inside the block of a welcome that runs or
    // dispatches a prompt turn, so an opening said by the reply reaches its return without one.
    const site = between(router, 'const promptValues: Record<string, string> = {', OPENING);
    const planBlocks = /\n {6}if \(channelArn && loaded\.plan\.(runs|prompt)\) \{[\s\S]*?\n {6}\}(?=\n)/g;
    expect(site.match(planBlocks)).toHaveLength(2);
    expect(site.replace(planBlocks, '').match(/await /g)).toBeNull();
    expect(site).toMatch(/if \(channelArn && loaded\.plan\.prompt\) \{\n\s+await dispatchWelcomePrompt\(/);
    // The reply's prompt turn, and a run's prompt step: one dispatch each.
    expect(router.match(/await dispatchWelcomePrompt\(/g)).toHaveLength(2);
  });

  it('a prompt welcome\'s one added wait is the dispatch: the processor ARN and the asynchronous invoke', () => {
    const dispatch = between(router, 'async function dispatchWelcomePrompt(', ' * RUN AN EVENT WORKFLOW AS ONE ASSISTANT');
    expect(dispatch.match(/await /g)).toHaveLength(1);
    expect(dispatch).not.toMatch(/evaluateAbuseGate|resolveChannelSize|resolveActiveProfile/);
    const lib = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'lib', 'welcome-prompt-turn.ts'), 'utf8');
    const turn = between(lib, 'export async function dispatchWelcomePromptTurn(', '\n}\n');
    expect(turn.match(/await [\w.]+/g)).toEqual(['await deps.processorArn', 'await deps.invoke']);
    // The meter moved to the processor, after the opening.
    const branch = processor.slice(processor.indexOf('if (event.welcomePrompt) {'));
    expect(branch.slice(0, 2500)).toMatch(/meter: async \(\) => \(await evaluateAbuseGate\(\{ personId: '', rateLimit: 0, isAdmin: false, machineWritten: true \}\)\)\.allowed/);
  });

  it('the processor runs the turn alone: no placeholder, one post, then it returns', () => {
    const at = processor.indexOf('if (event.welcomePrompt) {');
    expect(at).toBeGreaterThan(-1);
    const branch = processor.slice(at, processor.indexOf('\n    }\n', at));
    expect(branch).toMatch(/runWelcomePromptTurn\(/);
    expect(branch).toMatch(/tools: request\.tools/);
    expect(branch).toMatch(/turnKind: 'welcome'/);
    expect(branch).toMatch(/return;$/);
    // One post: one response, in as many parts as it needs (`sendInParts`).
    expect(branch.match(/sendInParts\(|sendChannelMessage\(/g)).toEqual(['sendInParts(']);
  });

  it('the turn is declared a welcome, which answers no person\'s message', () => {
    expect(INTERACTION_KINDS).toContain('welcome');
    expect(ANSWERS_NO_MESSAGE_KINDS).toContain('welcome');
  });
});

describe('a welcome reads the enrollment only when an experiment can serve it (FR2)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const manager = require('../../lambda/src/lib/experiment-manager');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { enrollmentMayApply } = require('../../lambda/src/lib/experiment-enrollment');
  const live = { experimentId: 'e1', experimentType: 'profile', tiers: ['premium'], status: 'active', variants: [{ variantId: 'a' }], createdAt: '2026-01-01T00:00:00Z' };
  afterEach(() => manager.__setEnrollableExperimentsForTests(null));

  it('decides from the list the container already holds, with no read', () => {
    manager.__setEnrollableExperimentsForTests(null);
    expect(enrollmentMayApply('premium')).toBeUndefined();
    manager.__setEnrollableExperimentsForTests([]);
    expect(enrollmentMayApply('premium')).toBe(false);
    manager.__setEnrollableExperimentsForTests([{ ...live, status: 'paused' }]);
    expect(enrollmentMayApply('premium')).toBe(false);
    manager.__setEnrollableExperimentsForTests([{ ...live, tiers: ['basic'] }]);
    expect(enrollmentMayApply('premium')).toBe(false);
    manager.__setEnrollableExperimentsForTests([live]);
    expect(enrollmentMayApply('premium')).toBe(true);
  });

  it('with no live experiment the welcome reads only the active version; with one, the enrollment beside it', () => {
    const router = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'router-agent-handler.ts'), 'utf8');
    const fn = router.slice(router.indexOf('async function servedWelcomeVersion('), router.indexOf('/**\n * THE ASSISTANT\'S OWN WELCOME FIRST'));
    expect(fn).toMatch(/&& enrollmentMayApply\(classification\) !== false;\n\s+if \(!mayEnroll\) return \{ version: await resolveActiveProfile\(profileName, \{ ssm: ssmClient, ssmRoot: SSM_ROOT \}\) \};/);
    // The enrollment read starts only after that return, and is awaited together with the profile read.
    const skip = fn.indexOf('if (!mayEnroll) return');
    expect(fn.indexOf('enrollmentOf(')).toBeGreaterThan(skip);
    expect(fn).toMatch(/await Promise\.all\(\[resolveActiveProfile\(profileName, \{ ssm: ssmClient, ssmRoot: SSM_ROOT \}\), armRead\]\)/);
    expect(fn.match(/enrollmentOf\(/g)).toHaveLength(1);
  });
});
