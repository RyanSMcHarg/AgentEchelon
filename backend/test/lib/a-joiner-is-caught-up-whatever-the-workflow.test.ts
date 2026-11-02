/**
 * A JOINER IS CAUGHT UP, WHATEVER THE WORKFLOW (ADR-061 decision 5, the join recap as `person-joined`'s default step).
 *
 * What it proves:
 *  - the recap is an `agent` step that reads the room's recent messages (`reads: messages`), addressed to the person who
 *    joined, and it is the step `person-joined` runs where a version declares no workflow (the platform's `join-recap`);
 *  - a version that declares a `person-joined` workflow keeps the recap: it runs after the version's own steps, so the
 *    room's message still waits on no model, unless the workflow writes a recap of its own (`withJoinRecap`);
 *  - the router and the processor read the same steps for a run, by name (`workflowFor`);
 *  - only the recap may come before the first send on an arrival event, and only a step whose reader reads the room
 *    reads its messages: never a step narrowed to declared values, and never at an invitation's events;
 *  - a recap with nothing a person wrote to read calls no model, posts nothing and goes on as a success;
 *  - the router reports who its run recapped, and the share asks for its own recap only where the naming failed.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  JOIN_RECAP_STEP_PREFIX,
  PLATFORM_EVENT_WORKFLOWS,
  continueAfter,
  eventWorkflowErrors,
  isJoinRecapStep,
  personJoinedWorkflowOf,
  runEventWorkflow,
  versionEventWorkflowsErrors,
  withJoinRecap,
  workflowFor,
  type EventRunContext,
  type EventRunDeps,
  type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import { runAgentStep } from '../../lambda/src/lib/event-agent-step';
import { shippedMessageTemplate } from '../../lambda/src/lib/shipped-message-templates';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai';
const CHANNEL = `${APP}/channel/ch-1`;
const JOINER = `${APP}/user/jordan`;
const RECAP = PLATFORM_EVENT_WORKFLOWS['join-recap'];

/** A version's own `person-joined` workflow: a room line, then a private welcome. */
const OWN: EventWorkflow = {
  on: 'person-joined',
  initial: 'announce',
  states: {
    announce: { send: { to: 'room', template: 'member-joined', mention: { name: 'event:person' } }, onSuccess: 'welcome', onFailure: 'done' },
    welcome: { send: { to: 'joined', template: 'member-welcome' }, onSuccess: 'done', onFailure: 'failed' },
    done: { disposition: 'success' },
    failed: { disposition: 'failure' },
  },
};

function deps(log: string[]): EventRunDeps {
  const claimed = new Set<string>();
  return {
    claimRun: async () => true,
    claimStep: async (step) => { if (claimed.has(step)) return false; claimed.add(step); return true; },
    mentionName: async () => 'Jordan',
    send: async ({ template, to }) => { log.push(`send:${template}:${to.length ? 'targeted' : 'room'}`); return true; },
    dispatchAgent: async (step, def) => { log.push(`agent:${step}:${def.reads ?? ''}`); return true; },
  };
}
const ctx: EventRunContext = { event: 'person-joined', channelArn: CHANNEL, eventPerson: JOINER, values: {} };

describe('the join recap is person-joined\'s default step', () => {
  it('reads the room\'s recent messages, for the person who joined alone, from the join-recap prompt', () => {
    expect(RECAP.on).toBe('person-joined');
    expect(RECAP.states[RECAP.initial].agent).toMatchObject({ prompt: 'join-recap', reads: 'messages', to: 'joined' });
    expect(isJoinRecapStep(RECAP.states[RECAP.initial])).toBe(true);
    expect(eventWorkflowErrors('join-recap', RECAP)).toEqual([]);
  });

  it('is what person-joined runs where a version declares no workflow, and owns nobody\'s welcome then', () => {
    expect(personJoinedWorkflowOf({})).toEqual({ name: 'join-recap', workflow: RECAP, declared: false });
    expect(personJoinedWorkflowOf(undefined)).toEqual({ name: 'join-recap', workflow: RECAP, declared: false });
  });

  it('a declared workflow keeps the recap, after its own steps, so the room\'s line still comes first', async () => {
    const chosen = personJoinedWorkflowOf({ mine: OWN });
    expect(chosen.declared).toBe(true);
    const wf = chosen.workflow;
    expect(wf.initial).toBe('announce');
    // Each edge into a terminal step goes through the recap first, and the recap ends the run as that step would.
    expect(wf.states.welcome.onSuccess).toBe(`${JOIN_RECAP_STEP_PREFIX}done`);
    expect(wf.states.welcome.onFailure).toBe(`${JOIN_RECAP_STEP_PREFIX}failed`);
    expect(wf.states[`${JOIN_RECAP_STEP_PREFIX}done`]).toMatchObject({ onSuccess: 'done', onFailure: 'done' });
    expect(isJoinRecapStep(wf.states[`${JOIN_RECAP_STEP_PREFIX}done`])).toBe(true);
    const log: string[] = [];
    const out = await runEventWorkflow(chosen.name, wf, ctx, deps(log));
    expect(log).toEqual(['send:member-joined:room', 'send:member-welcome:targeted', `agent:${JOIN_RECAP_STEP_PREFIX}done:messages`]);
    expect(out.ran).toBe(true);
  });

  it('the router and the processor read the same steps by name, so the recap a run hands over is found', () => {
    expect(workflowFor({ mine: OWN }, 'mine')).toEqual(withJoinRecap(OWN));
    expect(workflowFor({ mine: OWN }, 'mine')!.states[`${JOIN_RECAP_STEP_PREFIX}done`].agent).toBeDefined();
    expect(workflowFor({}, 'join-recap')).toBe(RECAP);
    // A workflow of another event is read as written.
    const welcome = clone(PLATFORM_EVENT_WORKFLOWS['opening-and-subject']);
    expect(workflowFor({ w: welcome }, 'w')).toBe(welcome);
  });

  it('a workflow that writes its own recap runs as written, and is not given a second', () => {
    const own: EventWorkflow = clone(OWN);
    own.states.welcome.onSuccess = 'catch-up';
    own.states['catch-up'] = { agent: { prompt: 'join-recap', reads: 'messages', to: 'joined', deadlineMs: 15_000, fallback: { send: { to: 'joined', template: 'join-recap-unavailable' } } }, onSuccess: 'done', onFailure: 'done' };
    expect(withJoinRecap(own)).toBe(own);
  });

  it('a recap after a step addressed to the person stays inside the run\'s bound', async () => {
    const wide: EventWorkflow = { on: 'person-joined', initial: 's0', states: { done: { disposition: 'success' } } };
    for (let i = 0; i < 15; i++) wide.states[`s${i}`] = { send: { to: 'joined', template: 'member-welcome' }, onSuccess: i < 14 ? `s${i + 1}` : 'done' };
    expect(versionEventWorkflowsErrors({ wide })).toEqual([]);
    const log: string[] = [];
    await runEventWorkflow('wide', withJoinRecap(wide), ctx, deps(log));
    expect(log.filter((l) => l.startsWith('send:'))).toHaveLength(15);
    expect(log[log.length - 1]).toBe(`agent:${JOIN_RECAP_STEP_PREFIX}done:messages`);
  });
});

describe('who may read the room, and what may come first', () => {
  it('on person-joined only the recap may come before the first send; any other agent step may not', () => {
    const recapFirst: EventWorkflow = { on: 'person-joined', initial: 'recap', states: { recap: clone(RECAP.states.recap), done: { disposition: 'success' } } };
    expect(eventWorkflowErrors('r', recapFirst)).toEqual([]);
    const briefFirst = clone(recapFirst);
    delete briefFirst.states.recap.agent!.reads;
    expect(eventWorkflowErrors('r', briefFirst).join()).toMatch(/initial must be a send/);
    const roomFirst = clone(recapFirst);
    roomFirst.states.recap.agent!.to = 'room';
    expect(eventWorkflowErrors('r', roomFirst).join()).toMatch(/initial must be a send/);
  });

  it('a step whose draft reaches someone outside the room reads none of it, and nothing reads it at an invitation\'s events', () => {
    const chase = clone(PLATFORM_EVENT_WORKFLOWS['chase-unredeemed']);
    chase.states['draft-nudge'].agent!.reads = 'messages';
    expect(eventWorkflowErrors('c', chase).join()).toMatch(/reads: a step whose draft reaches a person outside the room/);
    const sent: EventWorkflow = {
      on: 'invitation-sent', initial: 'note',
      states: {
        note: { agent: { prompt: 'join-recap', reads: 'messages', to: { people: 'invitation:inviter' }, deadlineMs: 10_000, fallback: { send: { to: { people: 'invitation:inviter' }, template: 'join-recap-unavailable' } } }, onSuccess: 'done', onFailure: 'done' },
        done: { disposition: 'success' },
      },
    };
    expect(eventWorkflowErrors('s', sent).join()).toMatch(/reads: at invitation-sent/);
  });

  it('the recap\'s names are the platform\'s', () => {
    expect(versionEventWorkflowsErrors({ 'join-recap': clone(PLATFORM_EVENT_WORKFLOWS['opening-and-subject']) }).join()).toMatch(/names the platform's person-joined default/);
    const taken = clone(OWN);
    taken.states[`${JOIN_RECAP_STEP_PREFIX}x`] = { disposition: 'success' };
    expect(versionEventWorkflowsErrors({ taken }).join()).toMatch(/is the join recap's/);
  });
});

describe('a recap with nothing to read', () => {
  const prompt = shippedMessageTemplate('join-recap');

  it('calls no model, posts nothing, and records skipped', async () => {
    const calls: string[] = [];
    const out = await runAgentStep({ template: prompt, values: {}, deadlineMs: 1000, nothingToRead: true }, {
      meter: async () => { calls.push('meter'); return true; },
      invoke: async () => { calls.push('invoke'); return { response: 'x' }; },
      claim: async (o) => { calls.push(`claim:${o}`); return true; },
      postOutput: async () => { calls.push('post'); },
      postFallback: async () => { calls.push('fallback'); },
    });
    expect(out).toMatchObject({ outcome: 'skipped', posted: false, won: true });
    expect(calls).toEqual(['claim:skipped']);
  });

  it('goes on as a success: the run takes the step\'s onSuccess', async () => {
    const wf = withJoinRecap(OWN);
    const log: string[] = [];
    const out = await continueAfter('mine', wf, ctx, { step: `${JOIN_RECAP_STEP_PREFIX}failed`, outcome: 'skipped' }, deps(log));
    expect(out.ended).toBe('failure');
    const ok = await continueAfter('mine', wf, ctx, { step: `${JOIN_RECAP_STEP_PREFIX}done`, outcome: 'skipped' }, deps([]));
    expect(ok.ended).toBe('success');
  });

  it('the processor reads the room for a step that reads it, as this turn\'s pipeline read it, and asks no model for a recap when no person spoke', () => {
    const proc = read('assistant-async-processor.ts');
    expect(proc).toMatch(/const readsRoom = def\.reads === 'messages' && !narrowed;/);
    expect(proc).toMatch(/const roomHistory = readsRoom \? consolidatedHistory : \[\];/);
    expect(proc).toMatch(/readsRoom && nothingToRecap\(wf\.states\[req\.step\], pipeline\.personSpoke\) \? \{ nothingToRead: true \}/);
    expect(proc).toMatch(/consolidateConsecutiveMessages\(\[\.\.\.roomHistory, \{ role: 'user', content: withStep\(prompt\) \}\]\)/);
    // A narrowed turn still reads its prompt alone.
    expect(proc).toMatch(/\[\{ role: 'user', content: prompt \}\],\n\s*\{ \.\.\.invokeConfig, tools: \[\], userTurnText: '' \}/);
    expect(read('lib/async-processor-core.ts')).toMatch(/const personSpoke = \(conversationHistory as ConversationMessage\[\]\)\.some\(\(m\) => m\.speaker\?\.kind === 'person'\)/);
  });
});

describe('the router recaps every verified joiner, and the share asks only where it could not', () => {
  const router = read('router-agent-handler.ts');
  const fn = router.slice(router.indexOf('export async function handlePersonJoined('), router.indexOf('export async function handleConversationOpened('));

  it('runs the version\'s workflow for a type it declares, else the platform\'s recap, and owns welcomes only when declared', () => {
    expect(fn).toMatch(/let chosen = personJoinedWorkflowOf\(served\?\.version\.eventWorkflows\);/);
    expect(fn).toMatch(/chosen = \{ name: 'join-recap', workflow: workflowFor\(undefined, 'join-recap'\)!, declared: false \};/);
    expect(fn).toMatch(/return \{ ran, people: declared \? members : \[\], recapped: members \};/);
    expect(fn).not.toMatch(/reason: 'no workflow'/);
  });

  it('the share asks for a recap of its own only for a person no run recapped', () => {
    const share = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'share-conversation', 'index.js'), 'utf8');
    expect(share).toMatch(/if \(!joinedRun\.recapped\?\.has\(recipientUserArn\)\) \{\n\s*await dispatchJoinRecapTurn/);
    expect(read('lib/say-through-router.ts')).toMatch(/export type JoinedRun = Set<string> & \{ recapped: ReadonlySet<string> \};/);
  });
});
