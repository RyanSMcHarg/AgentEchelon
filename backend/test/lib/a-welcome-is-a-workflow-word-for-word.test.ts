/**
 * THE WELCOME IS ONE SPECIAL WORKFLOW THAT `WelcomeIntent` STARTS (W1), AND IT SAYS WHAT THE RETIRED WELCOME SAID, WORD
 * FOR WORD.
 *
 * Before W1 a version carried a `welcome` object: orientation fields, an opening text, a mode, and per-conversation-type
 * variants. The welcome is now the version's `assistant-joined` workflow, selected by the room's type, whose opening is a
 * template step rendered by the same composition. `npm run migrate-legacy-welcome` carries each stored welcome into those
 * workflows (`legacyWelcomePlan`).
 *
 * THE REFERENCE IS TODAY'S STRUCTURED OUTPUT. `retired*` below are the selectors the router read a `welcome` through
 * before W1, kept here verbatim as the reference, never in the source: the room's variant merged over the version's own
 * fields, a variant with no mode inheriting the version's, and a welcome of variants only saying nothing of its own. Both
 * paths end in the one composer (`composeOpening`), so the test holds the migration, the selection and the plan to the
 * exact text a room read, across every kind of room, every room context (fresh, a topic, a drift-spawned room, an event
 * summary, a carried-over visit) and both sides of the deployment-orientation fallback.
 *
 * What else it proves: a prompt welcome becomes an opening and a prompt step said by the intent's reply; a workflow welcome
 * selects its workflow in exactly the rooms it ran in; a `conversation-opened` welcome becomes the workflow its room's type
 * selects; the demo seed is what the migration writes for the demo's retired welcomes; and the retired field is refused
 * at every gate, naming the script.
 */
import {
  composeOpening,
  parseWelcomeOrientationDetailed,
  selectOpening,
  type WelcomeOrientation,
} from '../../lambda/src/lib/welcome-orientation';
import {
  arrivalWelcomeOwner,
  eventWorkflowErrors,
  runEventWorkflow,
  openedWorkflowOf,
  PLATFORM_EVENT_WORKFLOWS,
  versionEventWorkflowsErrors,
  welcomePlan,
  welcomeWorkflowOf,
  workflowFor,
  type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import { legacyWelcomePlan, type LegacyWelcome } from '../../lambda/src/lib/legacy-welcome-migration';
import { MIGRATE_LEGACY_WELCOME, patchShapeErrors, retiredWelcomeErrors } from '../../lambda/src/lib/profile-copy-fields';
import { OPS_WELCOME, ADVISOR_WELCOME } from '../../demo/welcomes';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── THE REFERENCE: the selectors the router read a version's `welcome` through before W1, verbatim ──────────────────
const RETIRED_SHAPE_KEYS = ['template', 'byConversationType', 'mode', 'prompt', 'tools', 'workflow'];
function retiredResolve(welcome: LegacyWelcome | null | undefined, context: { conversationType?: string }): LegacyWelcome | null {
  if (!welcome) return null;
  const { byConversationType, ...own } = welcome;
  const variant = context.conversationType ? byConversationType?.[context.conversationType] : undefined;
  if (variant) {
    const { byConversationType: _nested, ...variantOwn } = variant;
    return { ...own, ...variantOwn };
  }
  return Object.keys(own).length > 0 ? own : null;
}
function retiredSelect(welcome: LegacyWelcome | null | undefined, context: { conversationType?: string }) {
  const forThisRoom = retiredResolve(welcome, context);
  if (!forThisRoom) return null;
  const template = forThisRoom.template?.trim() ? forThisRoom.template : undefined;
  const fields = Object.fromEntries(Object.entries(forThisRoom).filter(([key]) => !RETIRED_SHAPE_KEYS.includes(key)));
  const own = Object.keys(fields).length ? parseWelcomeOrientationDetailed(JSON.stringify(fields)) : null;
  if (!template && !own?.orientation) return null;
  return { ...(template ? { template } : {}), orientation: own?.orientation ?? null, issues: own?.issues ?? [] };
}
function retiredMode(welcome: LegacyWelcome | null | undefined, context: { conversationType?: string }) {
  const variant = context.conversationType ? welcome?.byConversationType?.[context.conversationType] : undefined;
  const mode = variant?.mode ?? welcome?.mode ?? 'structured';
  if (mode === 'workflow') {
    const workflow = variant?.workflow ?? welcome?.workflow;
    return workflow ? { mode, workflow } : { mode: 'structured' };
  }
  if (mode !== 'prompt') return { mode };
  const prompt = variant?.prompt ?? welcome?.prompt;
  const tools = variant?.tools ?? welcome?.tools ?? [];
  return prompt ? { mode, prompt, tools } : { mode: 'structured' };
}

/** The deployment's orientation, which a primary says when its welcome carries nothing of its own. */
const DEPLOYMENT: WelcomeOrientation = {
  companyName: 'Stratum Technologies', companyBlurb: 'an enterprise SaaS company', accessBlurb: 'You have premium access.',
  examples: ['How did Q3 close?'], platformNote: 'Ask how the platform works.',
};
/** What a room carries, from a fresh room to a drift-spawned one. */
const ROOMS: Array<[string, WelcomeOrientation]> = [
  ['fresh', {}],
  ['a topic', { topic: 'the Q4 board deck' }],
  ['drift-spawned', { priorSubject: 'revenue forecasting', priorMessage: 'Can you forecast Q1 revenue for the board?', parentRef: '?conversation=abc#message=m1' }],
  ['an event', { eventSummary: 'p95 latency crossed its SLA for 10 minutes.', topic: 'Latency SLA' }],
  ['a carried-over visit', { visitSummary: 'You asked about pricing tiers as a visitor.' }],
];
const TYPES = [undefined, 'general', 'ops', 'ops-team', 'guest-visitor'];

/** The opening a room read, by the retired path. */
function retiredOpening(welcome: LegacyWelcome | undefined, type: string | undefined, room: WelcomeOrientation, primary: boolean): string {
  const own = retiredSelect(welcome, { conversationType: type });
  const orientation = own ? own.orientation : (primary ? DEPLOYMENT : null);
  return composeOpening(own?.template, { ...(orientation ?? {}), ...room }, { role: 'ops' }).content;
}
/** The opening a room reads now, from the welcome workflow its type selects. */
function workflowOpening(own: Record<string, EventWorkflow> | undefined, type: string | undefined, room: WelcomeOrientation, primary: boolean): string {
  const plan = welcomePlan(welcomeWorkflowOf(own, type).workflow);
  const sel = selectOpening(plan.opening);
  const orientation = sel ? sel.orientation : (primary ? DEPLOYMENT : null);
  return composeOpening(sel?.template, { ...(orientation ?? {}), ...room }, { role: 'ops' }).content;
}

/** The retired demo welcomes, as they were seeded before W1. */
const LEGACY_OPS: LegacyWelcome = {
  companyName: 'Stratum Technologies',
  companyBlurb: 'an enterprise SaaS company (workflow automation, ~280 people, based in Austin)',
  accessBlurb: 'You have operations access in this conversation: I read this deployment\'s own telemetry - CloudWatch metrics and alarm state - which the Stratum business assistants cannot reach. I read it only; I change nothing.',
  examples: ['What is the error rate across the deployment right now?', 'Which functions are slowest, and since when?', 'Which alarms are in alarm, and what do they cover?'],
  platformNote: 'I also know the AgentEchelon platform that powers this demo - ask me "how does AgentEchelon work?" or "how do I customize it?"',
  byConversationType: {
    ops: { template: 'This conversation is open for an operations issue.\n{eventSummary}\nI can read this deployment\'s metrics and alarm state - ask me what is happening and I will start there.' },
  },
};
const LEGACY_ADVISOR: LegacyWelcome = {
  byConversationType: {
    ops: { template: 'I am here too, and I am checking in on this one.' },
    'ops-team': { template: 'This is the operations team\'s standing room.\nIt is for {topic}.\nEveryone in the ops group is here, and people join or leave as the group changes.\nAsk me anything here. When an alert opens an incident, a separate room opens for it with the Ops assistant, which reads this deployment\'s metrics and alarm state.' },
  },
};

/** Every shape a stored welcome took. */
const STRUCTURED: Array<[string, LegacyWelcome | undefined]> = [
  ['no welcome', undefined],
  ['an empty welcome', {}],
  ['orientation fields only', { companyName: 'Acme', accessBlurb: 'You can read the runbooks.', examples: ['What broke?', '  ', 'Who is on call?'] }],
  ['an opening text only', { template: 'Hello about {topic}.\nYou asked: {priorMessage}' }],
  ['text and fields', { template: 'I am the {role} assistant.\n{eventSummary}', companyName: 'Acme', platformNote: 'See the guide.' }],
  ['variants only', { byConversationType: { ops: { template: 'An alert opened this: {{eventSummary}}' }, 'ops-team': { accessBlurb: 'You can see alarms.' } } }],
  ['own fields with a variant that adds a field', { companyName: 'Acme', byConversationType: { 'ops-team': { accessBlurb: 'You can see alarms.' } } }],
  ['own text with a variant text', { template: 'Hello.', examples: ['Try this.'], byConversationType: { ops: { template: 'Ops: {eventSummary}' } } }],
  ['a field set blank', { companyName: '  ', companyBlurb: 'a blurb with no name' }],
  ['a per-conversation field a version may not set', { topic: 'set by a version', companyName: 'Acme' } as LegacyWelcome],
  ['the demo ops assistant', LEGACY_OPS],
  ['the demo advisor', LEGACY_ADVISOR],
];

describe('a structured welcome says, as a workflow, exactly what it said', () => {
  for (const [what, legacy] of STRUCTURED) {
    it(`${what}: word for word in every kind of room, every room context, primary or not`, () => {
      const plan = legacyWelcomePlan(legacy, undefined);
      expect(plan.refused).toEqual([]);
      expect(versionEventWorkflowsErrors(plan.eventWorkflows)).toEqual([]);
      for (const type of TYPES) for (const [, room] of ROOMS) for (const primary of [true, false]) {
        expect(workflowOpening(plan.eventWorkflows, type, room, primary)).toBe(retiredOpening(legacy, type, room, primary));
        // Said by the intent's reply, exactly as a structured welcome was.
        expect(welcomePlan(welcomeWorkflowOf(plan.eventWorkflows, type).workflow).runs).toBe(false);
      }
    });
  }

  it('the demo seed is what the migration writes for the demo\'s retired welcomes, word for word', () => {
    for (const [seeded, legacy] of [[OPS_WELCOME, LEGACY_OPS], [ADVISOR_WELCOME, LEGACY_ADVISOR]] as const) {
      expect(versionEventWorkflowsErrors(seeded)).toEqual([]);
      for (const type of TYPES) for (const [, room] of ROOMS) for (const primary of [true, false]) {
        expect(workflowOpening(seeded, type, room, primary)).toBe(retiredOpening(legacy, type, room, primary));
      }
    }
  });

  it('a welcome that says only what the platform\'s does writes no workflow, and the platform\'s welcome opens the room', () => {
    expect(legacyWelcomePlan({}, undefined).workflows).toEqual([]);
    expect(legacyWelcomePlan({ mode: 'structured' }, undefined).eventWorkflows).toEqual({});
    expect(welcomeWorkflowOf(undefined, 'ops')).toEqual({ name: 'welcome', workflow: PLATFORM_EVENT_WORKFLOWS.welcome, declared: false });
    expect(selectOpening(welcomePlan(PLATFORM_EVENT_WORKFLOWS.welcome).opening)).toBeNull();
  });

  it('carries the version\'s other workflows unchanged', () => {
    const own: Record<string, EventWorkflow> = { 'chase': JSON.parse(JSON.stringify(PLATFORM_EVENT_WORKFLOWS['chase-unredeemed'])) };
    const plan = legacyWelcomePlan({ companyName: 'Acme' }, own);
    expect(plan.eventWorkflows.chase).toEqual(own.chase);
    expect(Object.keys(plan.eventWorkflows).sort()).toEqual(['chase', 'welcome']);
  });
});

describe('a prompt welcome becomes its opening and a prompt step, said by the intent\'s reply', () => {
  const PROMPTS: Array<[string, LegacyWelcome]> = [
    ['the version\'s own', { mode: 'prompt', prompt: 'welcome-greeting', tools: ['load_company_context'], companyName: 'Acme' }],
    ['a variant\'s, inheriting the version\'s tools', { mode: 'prompt', prompt: 'welcome-greeting', tools: ['load_company_context'], byConversationType: { ops: { prompt: 'ops-hello', template: 'Ops room.' }, 'ops-team': { mode: 'structured' } } }],
    ['a variant only', { byConversationType: { ops: { mode: 'prompt', prompt: 'ops-hello' } } }],
    ['a prompt mode naming no template, which greeted as structured', { mode: 'prompt', template: 'Hi.' }],
  ];
  for (const [what, legacy] of PROMPTS) {
    it(`${what}: the same opening and the same prompt turn in every kind of room`, () => {
      const plan = legacyWelcomePlan(legacy, undefined);
      expect(plan.refused).toEqual([]);
      expect(versionEventWorkflowsErrors(plan.eventWorkflows)).toEqual([]);
      for (const type of TYPES) {
        const was = retiredMode(legacy, { conversationType: type });
        const now = welcomePlan(welcomeWorkflowOf(plan.eventWorkflows, type).workflow);
        expect(now.runs).toBe(false);
        expect(now.prompt).toEqual(was.mode === 'prompt' ? { template: was.prompt, ...((was.tools ?? []).length ? { tools: was.tools } : {}) } : undefined);
        for (const [, room] of ROOMS) for (const primary of [true, false]) {
          expect(workflowOpening(plan.eventWorkflows, type, room, primary)).toBe(retiredOpening(legacy, type, room, primary));
        }
      }
    });
  }
});

describe('a workflow welcome selects its workflow in exactly the rooms it ran in', () => {
  it('a platform workflow named by the version\'s own welcome is copied in and answers for every room', () => {
    const plan = legacyWelcomePlan({ mode: 'workflow', workflow: 'opening-and-subject' }, undefined);
    expect(plan.refused).toEqual([]);
    expect(plan.eventWorkflows['opening-and-subject']).toEqual(PLATFORM_EVENT_WORKFLOWS['opening-and-subject']);
    for (const type of TYPES) {
      const chosen = welcomeWorkflowOf(plan.eventWorkflows, type);
      expect(chosen.name).toBe('opening-and-subject');
      expect(welcomePlan(chosen.workflow).runs).toBe(true);
    }
  });

  it('a variant\'s workflow answers for its type alone, and the version\'s structured opening for every other room', () => {
    const own: Record<string, EventWorkflow> = { greet: { on: 'assistant-joined', initial: 'hi', states: { hi: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'done' }, done: { disposition: 'success' } } } };
    const legacy: LegacyWelcome = { companyName: 'Acme', byConversationType: { 'ops-team': { mode: 'workflow', workflow: 'greet' } } };
    const plan = legacyWelcomePlan(legacy, own);
    expect(versionEventWorkflowsErrors(plan.eventWorkflows)).toEqual([]);
    expect(plan.eventWorkflows.greet.types).toEqual(['ops-team']);
    expect(welcomeWorkflowOf(plan.eventWorkflows, 'ops-team').name).toBe('greet');
    for (const type of [undefined, 'general', 'ops']) {
      expect(welcomeWorkflowOf(plan.eventWorkflows, type).name).toBe('welcome');
      for (const [, room] of ROOMS) expect(workflowOpening(plan.eventWorkflows, type, room, true)).toBe(retiredOpening(legacy, type, room, true));
    }
  });

  it('a workflow that declared types it never ran in keeps only the rooms it ran in', () => {
    const own: Record<string, EventWorkflow> = { greet: { on: 'assistant-joined', types: ['ops-team', 'general'], initial: 'hi', states: { hi: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'done' }, done: { disposition: 'success' } } } };
    const plan = legacyWelcomePlan({ mode: 'workflow', workflow: 'greet', byConversationType: { general: { mode: 'structured', template: 'General.' } } }, own);
    expect(plan.eventWorkflows.greet.types).toEqual(['ops-team']);
    expect(welcomeWorkflowOf(plan.eventWorkflows, 'general').name).toBe('welcome-general');
    expect(versionEventWorkflowsErrors(plan.eventWorkflows)).toEqual([]);
  });

  it('a conversation-opened welcome becomes the workflow its room\'s type selects, and the join posts nothing there', () => {
    const plan = legacyWelcomePlan({ byConversationType: { ops: { mode: 'workflow', workflow: 'ops-room' } } }, undefined);
    expect(plan.refused).toEqual([]);
    expect(plan.eventWorkflows['ops-room']).toEqual(PLATFORM_EVENT_WORKFLOWS['ops-room']);
    expect(openedWorkflowOf(plan.eventWorkflows, 'ops')?.name).toBe('ops-room');
    expect(openedWorkflowOf(plan.eventWorkflows, 'general')).toBeUndefined();
    expect(arrivalWelcomeOwner({ conversationType: 'ops', own: plan.eventWorkflows })).toBe('conversation-opened');
    expect(arrivalWelcomeOwner({ conversationType: 'general', own: plan.eventWorkflows })).toBeUndefined();
  });

  it('says what it could not carry: fields beside a workflow, read only in a drift-spawned room, and a name nothing declares', () => {
    const beside = legacyWelcomePlan({ mode: 'workflow', workflow: 'opening-and-subject', companyName: 'Acme' }, undefined);
    expect(beside.refused.map((r) => r.reason).join(' ')).toMatch(/companyName beside workflow "opening-and-subject".*drift-spawned/);
    const missing = legacyWelcomePlan({ mode: 'workflow', workflow: 'nowhere', template: 'Hi.' }, undefined);
    expect(missing.refused[0].reason).toMatch(/"nowhere", which the version does not declare/);
    // It greeted with its opening instead, and still does.
    expect(workflowOpening(missing.eventWorkflows, 'general', {}, true)).toBe(retiredOpening({ template: 'Hi.' }, 'general', {}, true));
  });
});

describe('one welcome per kind of room', () => {
  const opening = (types?: string[]): EventWorkflow => ({ on: 'assistant-joined', ...(types ? { types } : {}), initial: 'o', states: { o: { opening: {}, onSuccess: 'd' }, d: { disposition: 'success' } } });
  it('refuses two welcomes that name no type, and two that answer for one type', () => {
    expect(versionEventWorkflowsErrors({ a: opening(), b: opening() }).join(' ')).toMatch(/2 workflows on assistant-joined that name no type/);
    expect(versionEventWorkflowsErrors({ a: opening(['ops']), b: opening(['ops', 'general']) }).join(' ')).toMatch(/both run on assistant-joined in ops conversations/);
    expect(versionEventWorkflowsErrors({ a: opening(), b: opening(['ops']) })).toEqual([]);
  });
  it('a room\'s type selects its own welcome first, then the one naming no type', () => {
    const own = { a: opening(), b: opening(['ops']) };
    expect(welcomeWorkflowOf(own, 'ops').name).toBe('b');
    expect(welcomeWorkflowOf(own, 'general').name).toBe('a');
    expect(welcomeWorkflowOf(own, undefined).name).toBe('a');
    expect(workflowFor(own, 'b')).toBe(own.b);
  });
});

describe('the retired welcome is refused, naming the script', () => {
  it('on a draft patch, and at every gate that reads a stored body', () => {
    expect(patchShapeErrors({ welcome: { companyName: 'Acme' } }).join(' ')).toContain(MIGRATE_LEGACY_WELCOME);
    expect(patchShapeErrors({ welcome: null })).toEqual([]);
    expect(retiredWelcomeErrors(undefined)).toEqual([]);
    expect(retiredWelcomeErrors({})[0]).toMatch(/welcome is retired: the welcome is this assistant's assistant-joined workflow/);
    const lifecycle = readFileSync(join(__dirname, '../../lambda/src/lib/profile-lifecycle.ts'), 'utf8');
    // validate, activate, an experiment's variant and a rollback.
    expect(lifecycle.match(/retiredWelcomeErrors\(/g)?.length).toBe(4);
    expect(readFileSync(join(__dirname, '../../lambda/src/lib/profile-manifest.ts'), 'utf8')).toMatch(/retiredWelcomeErrors\(\(body as \{ welcome\?: unknown \}\)\.welcome\)/);
    expect(readFileSync(join(__dirname, '../../package.json'), 'utf8')).toContain('"migrate-legacy-welcome": "tsc && node scripts/migrate-legacy-welcome.mjs"');
  });

  it('nothing on the runtime path reads a version\'s welcome (no dual read)', () => {
    for (const file of ['../../lambda/src/router-agent-handler.ts', '../../lambda/src/assistant-async-processor.ts', '../../lambda/src/lib/async-processor-core.ts']) {
      expect(readFileSync(join(__dirname, file), 'utf8')).not.toMatch(/version\.welcome|active\.welcome|\.welcome as /);
    }
  });
});

describe('a welcome that greets and then continues runs as a workflow, its opening a step', () => {
  const GREET_THEN_CONTINUE: EventWorkflow = {
    on: 'assistant-joined', initial: 'opening',
    states: {
      opening: { opening: { text: 'Hello.' }, onSuccess: 'greet-subject', onFailure: 'greet-subject' },
      'greet-subject': { send: { to: 'subject', template: 'workflow-subject-welcome', mention: { name: 'subject' } }, onSuccess: 'intake', onFailure: 'intake' },
      intake: { action: { tool: 'start_intake', to: 'subject' }, onSuccess: 'done', onFailure: 'done' },
      done: { disposition: 'success' },
    },
  };
  const deps = () => {
    const taken = new Set<string>();
    const said: string[] = [];
    return {
      said,
      deps: {
        claimRun: async () => (taken.has('run') ? false : (taken.add('run'), true)),
        claimStep: async (step: string) => (taken.has(step) ? false : (taken.add(step), true)),
        mentionName: async () => 'Lee',
        send: async (a: { template: string }) => { said.push(`send:${a.template}`); return true; },
        dispatchAgent: async () => false,
        startIntake: async () => { said.push('intake'); return 'started' as const; },
        opening: async (step: string) => { said.push(`opening:${step}`); return true; },
        prompt: async (step: string) => { said.push(`prompt:${step}`); return true; },
      },
    };
  };

  it('is valid, and it runs: the router posts each step', () => {
    expect(eventWorkflowErrors('greet', GREET_THEN_CONTINUE)).toEqual([]);
    expect(welcomePlan(GREET_THEN_CONTINUE)).toEqual({ opening: { text: 'Hello.' }, runs: true });
  });

  it('posts the opening first, then greets the subject and offers the intake, each once', async () => {
    const w = deps();
    const ctx = { event: 'assistant-joined' as const, channelArn: 'arn:ch', subject: 'arn:app/user/u1', values: {} };
    const out = await runEventWorkflow('greet', GREET_THEN_CONTINUE, ctx, w.deps);
    expect(out.steps.map((s) => `${s.step}:${s.outcome}`)).toEqual(['opening:posted', 'greet-subject:posted', 'intake:posted']);
    expect(w.said).toEqual(['opening:opening', 'send:workflow-subject-welcome', 'intake']);
    // A redelivered WelcomeIntent finds the run claimed and says nothing.
    expect((await runEventWorkflow('greet', GREET_THEN_CONTINUE, ctx, w.deps)).ran).toBe(false);
    expect(w.said).toHaveLength(3);
  });

  it('a run with no opening to say (no WelcomeIntent behind it) skips the step rather than posting nothing as something', async () => {
    const w = deps();
    const { opening: _o, ...without } = w.deps;
    const out = await runEventWorkflow('greet', GREET_THEN_CONTINUE, { event: 'assistant-joined', channelArn: 'arn:ch', values: {} }, without);
    expect(out.steps[0]).toEqual({ step: 'opening', outcome: 'skipped' });
  });

  it('a prompt step in a run dispatches the turn once and ends the run', async () => {
    const wf: EventWorkflow = {
      on: 'assistant-joined', initial: 'opening',
      states: {
        opening: { opening: {}, onSuccess: 'tell', onFailure: 'tell' },
        tell: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'p', onFailure: 'p' },
        p: { prompt: { template: 'welcome-greeting' }, onSuccess: 'done', onFailure: 'done' },
        done: { disposition: 'success' },
      },
    };
    expect(eventWorkflowErrors('w', wf)).toEqual([]);
    expect(welcomePlan(wf).runs).toBe(true);
    const w = deps();
    const out = await runEventWorkflow('w', wf, { event: 'assistant-joined', channelArn: 'arn:ch', values: {} }, w.deps);
    expect(out.steps.map((s) => s.outcome)).toEqual(['posted', 'posted', 'dispatched']);
    expect(w.said).toEqual(['opening:opening', 'send:workflow-opening', 'prompt:p']);
  });

  it('refuses two openings, and a welcome step on any other event', () => {
    const two = JSON.parse(JSON.stringify(GREET_THEN_CONTINUE)) as EventWorkflow;
    two.states['greet-subject'] = { opening: {}, onSuccess: 'intake' };
    expect(eventWorkflowErrors('two', two).join()).toMatch(/has 2 opening steps .* a welcome opens the room once/);
    expect(eventWorkflowErrors('x', { ...GREET_THEN_CONTINUE, on: 'person-joined' }).join()).toMatch(/is an opening, which only the welcome takes/);
    // The opening opens the room, so it comes first: never after a send, nor after an agent step a run continues past.
    const late = JSON.parse(JSON.stringify(GREET_THEN_CONTINUE)) as EventWorkflow;
    late.initial = 'greet-subject';
    late.states['greet-subject'].onSuccess = 'opening';
    late.states.opening.onSuccess = 'intake';
    expect(eventWorkflowErrors('late', late).join()).toMatch(/states\.opening is an opening, which opens the room, so it is the welcome's first step/);
  });

  it('the router gives a run the opening it composed and the prompt values, only where WelcomeIntent runs the welcome', () => {
    const router = readFileSync(join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
    const deps = router.slice(router.indexOf('function eventRunDeps('), router.indexOf('async function offerIntakeStep('));
    expect(deps).toMatch(/\.\.\.\(who\.welcome \? \{\n\s+opening: [\s\S]*?postWelcomeOpening\(\{[\s\S]*?content: who\.welcome!\.opening/);
    expect(deps).toMatch(/prompt: async [\s\S]*?await dispatchWelcomePrompt\(/);
    expect(router).toMatch(/welcome: \{ opening: welcome\.content, promptValues \},/);
    // Posted as the welcome it is, so the ledger does not count it as an answer.
    const post = router.slice(router.indexOf('async function postWelcomeOpening('), router.indexOf('export async function handleEventContinuation('));
    expect(post).toMatch(/turnKind: 'welcome'/);
  });
});
