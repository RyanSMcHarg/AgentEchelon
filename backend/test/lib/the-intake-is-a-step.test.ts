/**
 * THE INTAKE IS A STEP (ADR-061 decision 2, `start_intake`).
 *
 * What it proves:
 *  - an `action` step offers the onboarding intake to the one person its event names: the subject at `assistant-joined`,
 *    the person who joined at `person-joined`, the person the opening named at `conversation-opened`, and nobody at an
 *    event whose person is not reading the room;
 *  - it is claimed before it is asked, so a redelivered event asks nobody twice, and a person with nothing to be asked
 *    takes the success edge;
 *  - the platform's `opening-and-subject` welcome offers it after the greeting, and a workflow welcome owns the intake,
 *    so the join starts none of its own and an intake room runs its workflow welcome (a drift-spawned room keeps its
 *    structured opening, which answers the question it was spawned for);
 *  - the router records the intake as the person's before it asks, only where no other person's is in progress, and
 *    targets the question at them alone.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  PLATFORM_EVENT_WORKFLOWS,
  eventWorkflowErrors,
  runEventWorkflow,
  type EventRunContext,
  type EventRunDeps,
  type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai';
const CHANNEL = `${APP}/channel/ch-1`;
const JOINER = `${APP}/user/jordan`;

const withIntake = (on: EventWorkflow['on'], to: unknown, first: 'send' | 'intake' = 'send'): EventWorkflow => ({
  on,
  ...(on === 'conversation-opened' ? { types: ['ops'] } : {}),
  initial: first === 'send' ? 'hello' : 'intake',
  states: {
    hello: { send: { to: 'room', template: 'workflow-opening' }, onSuccess: 'intake', onFailure: 'intake' },
    intake: { action: { tool: 'start_intake', to } as never, onSuccess: 'done', onFailure: 'failed' },
    done: { disposition: 'success' },
    failed: { disposition: 'failure' },
  },
});

describe('where an intake may be offered', () => {
  it('to the one person each arrival names', () => {
    expect(eventWorkflowErrors('a', withIntake('assistant-joined', 'subject'))).toEqual([]);
    expect(eventWorkflowErrors('p', withIntake('person-joined', 'joined'))).toEqual([]);
    expect(eventWorkflowErrors('p', withIntake('person-joined', { people: 'event:person' }))).toEqual([]);
    expect(eventWorkflowErrors('o', withIntake('conversation-opened', { people: 'event:person' }))).toEqual([]);
  });

  it('to nobody else: never the room, never a role, and never at an event whose person is not reading the room', () => {
    expect(eventWorkflowErrors('a', withIntake('assistant-joined', 'room')).join()).toMatch(/action\.to names the one person assistant-joined names: subject/);
    expect(eventWorkflowErrors('p', withIntake('person-joined', { participantRole: 'lead' })).join()).toMatch(/action\.to names the one person person-joined names/);
    expect(eventWorkflowErrors('o', withIntake('conversation-opened', 'subject')).join()).toMatch(/action\.to names the one person conversation-opened names/);
    const atInvite = withIntake('invitation-sent', { people: 'event:person' });
    expect(eventWorkflowErrors('i', atInvite).join()).toMatch(/an intake is offered at assistant-joined, conversation-opened, person-joined/);
    expect(eventWorkflowErrors('x', { ...withIntake('person-joined', 'joined'), states: { ...withIntake('person-joined', 'joined').states, intake: { action: { tool: 'send_email', to: 'joined' } as never, onSuccess: 'done' } } }).join())
      .toMatch(/is \{ tool: start_intake, to \}/);
  });

  it('is a step of its own kind, and never the opening of an arrival', () => {
    const both = withIntake('person-joined', 'joined');
    (both.states.intake as Record<string, unknown>).send = { to: 'room', template: 'x' };
    expect(eventWorkflowErrors('b', both).join()).toMatch(/exactly one of a send, an agent step, an action, an opening, a prompt, a task, or a terminal disposition/);
    expect(eventWorkflowErrors('f', withIntake('person-joined', 'joined', 'intake')).join()).toMatch(/initial must be a send/);
  });
});

describe('running the step', () => {
  const ctx: EventRunContext = { event: 'person-joined', channelArn: CHANNEL, eventPerson: JOINER, values: {} };
  function deps(answer: 'started' | 'skipped' | 'failed', asked: string[]): EventRunDeps {
    const claimed = new Set<string>();
    return {
      claimRun: async () => true,
      claimStep: async (step) => { if (claimed.has(step)) return false; claimed.add(step); return true; },
      mentionName: async () => '',
      send: async () => true,
      dispatchAgent: async () => true,
      startIntake: async (person, step) => { asked.push(`${step}:${person}`); return answer; },
    };
  }

  it('asks the person the event names, once, and goes on', async () => {
    const asked: string[] = [];
    const d = deps('started', asked);
    const out = await runEventWorkflow('p', withIntake('person-joined', 'joined'), ctx, d);
    expect(asked).toEqual([`intake:${JOINER}`]);
    expect(out.steps).toEqual([{ step: 'hello', outcome: 'posted' }, { step: 'intake', outcome: 'posted' }]);
    expect(out.ended).toBe('success');
    // A redelivered run that reaches the step again finds it claimed and asks nothing.
    const again = await runEventWorkflow('p', withIntake('person-joined', 'joined'), ctx, d);
    expect(asked).toHaveLength(1);
    expect(again.steps.find((s) => s.step === 'intake')?.outcome).toBe('already-claimed');
  });

  it('a person with nothing to ask goes on as a success, and an intake that could not be offered takes the failure edge', async () => {
    expect((await runEventWorkflow('p', withIntake('person-joined', 'joined'), ctx, deps('skipped', []))).ended).toBe('success');
    expect((await runEventWorkflow('p', withIntake('person-joined', 'joined'), ctx, deps('failed', []))).ended).toBe('failure');
  });

  it('a step whose person is not there asks nobody', async () => {
    const asked: string[] = [];
    const out = await runEventWorkflow('a', withIntake('assistant-joined', 'subject'), { event: 'assistant-joined', channelArn: CHANNEL, values: {} }, deps('started', asked));
    expect(asked).toEqual([]);
    expect(out.steps.find((s) => s.step === 'intake')?.outcome).toBe('skipped');
  });
});

describe('the welcome and the router', () => {
  it('the platform welcome offers the intake to the subject after greeting them', () => {
    const wf = PLATFORM_EVENT_WORKFLOWS['opening-and-subject'];
    expect(wf.states['greet-subject'].onSuccess).toBe('intake');
    expect(wf.states.intake).toEqual({ action: { tool: 'start_intake', to: 'subject' }, onSuccess: 'done', onFailure: 'done' });
    expect(eventWorkflowErrors('opening-and-subject', wf)).toEqual([]);
  });

  it('a welcome that runs owns the intake, so the join starts none of its own, except in a drift-spawned room', () => {
    const router = read('router-agent-handler.ts');
    expect(router).toMatch(/const workflowOwnsIntake = !driftCtx\?\.priorMessage && loaded\.plan\.runs;/);
    expect(router).toMatch(/\} else if \(isOnboardingEnabled\(intakeConfig\) && workflowOwnsIntake\) \{/);
  });

  it('records the intake as the person\'s before asking, only where no other person\'s is in progress, and asks them privately', () => {
    const router = read('router-agent-handler.ts');
    const fn = router.slice(router.indexOf('async function offerIntakeStep('), router.indexOf('export async function handleEventContinuation('));
    const order = ['intakeForAssistant(args.assistant', 'onboardingStatus(personId)', 'startIntake(', 'startOnboardingIntake(args.channelArn', 'sendChannelMessage('].map((t) => fn.indexOf(t));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(fn).toMatch(/Target: \[\{ MemberArn: args\.personArn \}\]/);
    expect(fn).toMatch(/if \(recorded === 'busy'\) \{/);
    const store = read('lib/channel-context-client.ts');
    expect(store).toMatch(/ConditionExpression: 'attribute_not_exists\(#intake\) OR #intake\.#phase = :done OR #intake\.#subject = :subject'/);
  });
});
