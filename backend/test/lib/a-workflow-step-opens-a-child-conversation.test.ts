/**
 * A WORKFLOW STEP OPENS A CHILD CONVERSATION (SPEC-WORKFLOWS-AND-TASKS WT120).
 *
 * What it proves: the step names a declared type and one person; it opens once however often its event is delivered, and the
 * run waits; a child that stands takes the success edge with its link in the run's values, so the room can be told where it
 * is, and one that could not be opened takes the failure edge; a room just opened and a room that is itself a child open
 * nothing further, so no chain of rooms can grow; and only this classification's creator is reachable from the router.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  CHILD_LINK_VALUE, OPEN_STEP_OPENED, continueAfter, eventRunKey, eventWorkflowErrors, runEventWorkflow,
  type EventRunContext, type EventRunDeps, type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import { shippedMessageTemplates } from '../../lambda/src/lib/shipped-message-templates';

const channelArn = 'arn:aws:chime:us-east-1:1:app-instance/ai/channel/main-1';
const oncall = 'arn:aws:chime:us-east-1:1:app-instance/ai/user/oncall-1';

const OPEN_INCIDENT = {
  on: 'alarm-state-changed',
  types: ['general'],
  initial: 'open',
  states: {
    open: { open: { type: 'ops', for: { typeRole: 'on-call:ops' } }, onSuccess: 'tell', onFailure: 'done' },
    tell: { send: { template: 'child-conversation-opened', to: 'room' }, onSuccess: 'done', onFailure: 'done' },
    done: { disposition: 'success' },
  },
} as unknown as EventWorkflow;

const ctx: EventRunContext = {
  event: 'alarm-state-changed', channelArn, eventPerson: oncall, values: {},
  alarm: { name: 'api-latency', state: 'ALARM', changedAt: 1 },
};

function harness(over: Partial<EventRunDeps> = {}) {
  const taken = new Map<string, string>();
  const key = eventRunKey('alarm-state-changed', 'main-1', 'advisor');
  const asked: Array<{ step: string; type: string }> = [];
  const sent: Array<{ template: string; values: Record<string, string> }> = [];
  const d: EventRunDeps = {
    claimRun: async () => { if (taken.has(key)) return false; taken.set(key, 'run'); return true; },
    claimStep: async (step: string, outcome: string) => { if (taken.has(step)) return false; taken.set(step, outcome); return true; },
    mentionName: async () => '@Dana',
    send: async (a) => { sent.push({ template: a.template, values: a.values }); return true; },
    dispatchAgent: async () => true,
    openChild: async (step, def) => { asked.push({ step, type: def.type }); return 'requested'; },
    ...over,
  };
  return { d, asked, sent };
}

describe('the step is declared', () => {
  const errorsFor = (open: unknown, on = 'alarm-state-changed'): string =>
    eventWorkflowErrors('x', { ...OPEN_INCIDENT, on, states: { ...OPEN_INCIDENT.states, open: { open, onSuccess: 'tell', onFailure: 'done' } } }).join('\n');

  it('with a declared type and one person', () => {
    expect(eventWorkflowErrors('x', OPEN_INCIDENT)).toEqual([]);
  });

  it.each([
    ['an undeclared type', { type: 'nope', for: { typeRole: 'on-call:ops' } }, /declared conversation type/],
    ['a role the type does not declare', { type: 'ops', for: { typeRole: 'nope' } }, /sourced from a group, with one holder/],
    ['a role no group fills', { type: 'ops', for: { typeRole: 'lead' } }, /sourced from a group, with one holder/],
    ['a person the event does not name', { type: 'ops', for: { people: 'event:person' } }, /only .* carry/],
    ['the room as its lead', { type: 'ops', for: 'room' }, /one person/],
    ['no lead', { type: 'ops' }, /one person/],
    ['a field it does not read', { type: 'ops', for: { typeRole: 'on-call:ops' }, members: ['someone'] }, /does not declare members/],
  ])('and refuses %s', (_name, open, pattern) => {
    expect(errorsFor(open)).toMatch(pattern);
  });

  it.each(['conversation-opened', 'assistant-joined'])('and refuses to open a room at %s, which runs in a room just opened', (on) => {
    expect(errorsFor({ type: 'ops', for: { typeRole: 'on-call:ops' } }, on)).toMatch(/opens no conversation of its own/);
  });

  it('and the room is told through a template the assistant can replace, naming the link', () => {
    expect(shippedMessageTemplates().get('child-conversation-opened')?.source).toContain(`{${CHILD_LINK_VALUE}}`);
  });
});

describe('a run opens one child and waits for it', () => {
  it('asks once however often the event is delivered, and says nothing yet', async () => {
    const { d, asked, sent } = harness();
    await runEventWorkflow('open-incident', OPEN_INCIDENT, ctx, d);
    await runEventWorkflow('open-incident', OPEN_INCIDENT, ctx, d);
    expect(asked).toEqual([{ step: 'open', type: 'ops' }]);
    expect(sent).toEqual([]);
  });

  it('a redelivery that starts its own run finds the step claimed, and opens nothing', async () => {
    const first = harness();
    await runEventWorkflow('open-incident', OPEN_INCIDENT, ctx, first.d);
    const asked: string[] = [];
    await runEventWorkflow('open-incident', OPEN_INCIDENT, ctx, { ...first.d, claimRun: async () => true, openChild: async (step) => { asked.push(step); return 'requested'; } });
    expect(asked).toEqual([]);
  });

  it('a child that stands tells the room where it is, once', async () => {
    const { d, sent } = harness();
    await runEventWorkflow('open-incident', OPEN_INCIDENT, ctx, d);
    const link = '?conversation=child-1';
    const after = { step: 'open', outcome: OPEN_STEP_OPENED };
    await continueAfter('open-incident', OPEN_INCIDENT, { ...ctx, values: { [CHILD_LINK_VALUE]: link } }, after, d);
    await continueAfter('open-incident', OPEN_INCIDENT, { ...ctx, values: { [CHILD_LINK_VALUE]: link } }, after, d);
    expect(sent).toHaveLength(1);
    expect(sent[0].template).toBe('child-conversation-opened');
  });

  it('a child that could not be opened takes the failure edge and tells the room nothing', async () => {
    const { d, sent } = harness();
    await runEventWorkflow('open-incident', OPEN_INCIDENT, ctx, d);
    await continueAfter('open-incident', OPEN_INCIDENT, ctx, { step: 'open', outcome: 'failed' }, d);
    expect(sent).toEqual([]);
  });

  it.each(['nested', 'no-person', 'failed'] as const)('nothing asked for (%s) goes on at once on the failure edge', async (out) => {
    const { d, sent } = harness({ openChild: async () => out });
    const ran = await runEventWorkflow('open-incident', OPEN_INCIDENT, ctx, d);
    expect(sent).toEqual([]);
    expect(ran.ended).toBe('success');
  });
});

describe('the router', () => {
  const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
  const stack = readFileSync(resolve(__dirname, '../../lib/stacks/assistant-profile-stack.ts'), 'utf8');

  it('leaves the on-call holder to the creator, which refuses anything but exactly one', () => {
    const creator = readFileSync(resolve(__dirname, '../../lambda/src/typed-conversation-from-event.ts'), 'utf8');
    expect(router).toMatch(/forRole: typeRole/);
    expect(creator).toMatch(/admitted\.length !== 1\) throw/);
  });

  it('opens nothing from a room that is itself a child, but one of a leaf type (DESIGN-PROCESSES O32)', () => {
    expect(router).toMatch(/if \(await openIsNested\(ctx\.channelArn, def\.type\)\) return 'nested';/);
  });

  it('never names a classification to the creator, which pins its own', () => {
    const opener = router.slice(router.indexOf('async function openChildConversation'), router.indexOf('async function openWorkflowTaskStep'));
    expect(opener).not.toMatch(/classification/i);
  });

  it('may invoke its own classification\'s creator by name, and no other', () => {
    expect(stack).toMatch(/agentHandler\.addEnvironment\('TYPED_CREATOR_NAME', typedCreatorName\(classification\)\)/);
    expect(stack).toMatch(/resourceName: typedCreatorName\(classification\)/);
  });
});

/**
 * A MOVE (SPEC-WORKFLOWS-AND-TASKS WT90): on `subject-changed`, the open step in move mode opens the conversation a person's
 * message moves to, inside the router, so it stands at once and the run goes on in the same invocation with its link.
 */
describe('an open step in move mode', () => {
  const MOVE = {
    on: 'subject-changed',
    initial: 'move',
    states: {
      move: { open: { type: 'general', for: { people: 'event:person' }, mode: 'move' }, onSuccess: 'tell', onFailure: 'done' },
      tell: { send: { template: 'child-conversation-opened', to: 'room' }, onSuccess: 'done', onFailure: 'done' },
      done: { disposition: 'success' },
    },
  } as unknown as EventWorkflow;
  const moveCtx: EventRunContext = { event: 'subject-changed', channelArn, eventPerson: oncall, values: {} };

  it('is declared on subject-changed, and refused anywhere else or in any other mode', () => {
    expect(eventWorkflowErrors('drift', MOVE)).toEqual([]);
    const elsewhere = { ...MOVE, on: 'alarm-state-changed', types: ['general'] } as unknown as EventWorkflow;
    expect(eventWorkflowErrors('x', elsewhere).join('\n')).toMatch(/mode is move only on subject-changed/);
    const other = { ...MOVE, states: { ...MOVE.states, move: { ...MOVE.states.move, open: { type: 'general', for: { people: 'event:person' }, mode: 'split' } } } } as unknown as EventWorkflow;
    expect(eventWorkflowErrors('x', other).join('\n')).toMatch(/\.mode is move/);
  });

  it('stands at once, and the run goes on in the same invocation carrying the child\'s link', async () => {
    const { d, sent } = harness({ openChild: async () => ({ opened: '?conversation=moved-1' }) });
    const out = await runEventWorkflow('drift', MOVE, moveCtx, d);
    expect(out.steps.map((s) => `${s.step}:${s.outcome}`)).toEqual([`move:${OPEN_STEP_OPENED}`, 'tell:posted']);
    expect(sent[0].values[CHILD_LINK_VALUE]).toBe('?conversation=moved-1');
    expect(out.ended).toBe('success');
  });

  it('takes the failure edge when the move could not open, and posts nothing', async () => {
    const { d, sent } = harness({ openChild: async () => 'failed' });
    const out = await runEventWorkflow('drift', MOVE, moveCtx, d);
    expect(out.steps.map((s) => `${s.step}:${s.outcome}`)).toEqual(['move:failed']);
    expect(sent).toEqual([]);
  });
});

describe('a task step\'s own notice', () => {
  const withNotice = (template: string, on = 'subject-changed', by: unknown = { people: 'event:person' }) => ({
    on, initial: 'ask',
    states: {
      ask: { task: { machine: 'drift_offer', by, deadline: { afterMinutes: 60 }, notice: { template } }, onSuccess: 'done', onFailure: 'done' },
      done: { disposition: 'success' },
    },
  } as unknown as EventWorkflow);

  it('names a message template this assistant has, and nothing else', () => {
    expect(eventWorkflowErrors('x', withNotice('drift-offer')).filter((e) => /notice/.test(e))).toEqual([]);
    expect(eventWorkflowErrors('x', withNotice('no-such-template')).join('\n')).toMatch(/notice\.template names no-such-template/);
  });

  it('DENY: it is an offer\'s alone, replacing no holder\'s private notice: on a subject change, held by its person', () => {
    expect(eventWorkflowErrors('x', withNotice('drift-offer', 'person-joined')).join('\n')).toMatch(/notice is an offer's, said on subject-changed/);
    expect(eventWorkflowErrors('x', withNotice('drift-offer', 'subject-changed', { participantRole: 'lead' })).join('\n')).toMatch(/said to the person who holds the offer/);
  });
});
