/**
 * A SEND REACHES THE CONVERSATION THAT OPENED ITS RUN (DESIGN-PROCESSES O24; SPEC-WORKFLOWS-AND-TASKS WT129).
 *
 * What it proves: a `send` step of a `conversation-opened` workflow may post in the conversation that opened its own
 * (`in: 'opener'`), to that room only; the router finds that conversation by the parent link the opened conversation's row
 * records, holds it to this classification and an open conversation, and posts as the assistant itself, so Amazon Chime SDK
 * membership decides: an assistant that is not a member there is refused, and the step records `refused` and goes on by its
 * failure edge. The ops team conversation hears "resolved" once, at the resolve, from the incident conversation's run, and
 * not again when the runs end; a redelivered resolve posts nothing more. No store and no grant is added: the send reuses the
 * stored parent link and the assistant's own speaking session.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  SHIPPED_EVENT_WORKFLOWS, WAIT_CAME, continueAfter, eventWorkflowErrors, runEventWorkflow,
  type EventRunContext, type EventRunDeps, type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import { openedConversation, openerConversation } from '../../lambda/src/lib/held-run';

const ROOM = 'arn:aws:chime:us-east-1:111122223333:app-instance/inst/channel/conv-ops-1';
const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');
const opened = (states: EventWorkflow['states']): EventWorkflow => ({ on: 'conversation-opened', types: ['ops'], initial: 'tell', states } as EventWorkflow);
const TELL = opened({
  tell: { send: { to: 'room', in: 'opener', template: 'incident-resolved-team' }, onSuccess: 'ok', onFailure: 'not-told' },
  ok: { disposition: 'success' },
  'not-told': { disposition: 'failure' },
});
const ctx: EventRunContext = { event: 'conversation-opened', channelArn: ROOM, values: { openedBy: 'workflow', label: 'api-latency' } };

function deps(answer: boolean | 'refused') {
  const claimed = new Set<string>();
  const sends: Array<{ template: string; in?: string; to: string[] }> = [];
  const d: EventRunDeps = {
    claimRun: async () => true,
    claimStep: async (step) => { if (claimed.has(step)) return false; claimed.add(step); return true; },
    mentionName: async () => '',
    dispatchAgent: async () => true,
    openTask: async () => 'opened',
    send: async (args) => { sends.push({ template: args.template, ...(args.in ? { in: args.in } : {}), to: args.to }); return args.in ? answer : true; },
  };
  return { d, sends };
}

describe('a send in the conversation that opened this one (O24)', () => {
  it('posts there, once, as the step says', async () => {
    const run = deps(true);
    const out = await runEventWorkflow('tell', TELL, ctx, run.d);
    expect(out.steps[0]).toEqual({ step: 'tell', outcome: 'posted' });
    expect(out.ended).toBe('success');
    expect(run.sends).toEqual([{ template: 'incident-resolved-team', in: 'opener', to: [] }]);
  });

  it('DENY: refused where the assistant is not a member there, recorded as the step\'s outcome, and the run goes on by its failure edge', async () => {
    const run = deps('refused');
    const out = await runEventWorkflow('tell', TELL, ctx, run.d);
    expect(out.steps[0]).toEqual({ step: 'tell', outcome: 'refused' });
    expect(out.ended).toBe('failure');
  });

  it('a send that could not be posted for another reason is a failure, not a refusal', async () => {
    const out = await runEventWorkflow('tell', TELL, ctx, deps(false).d);
    expect(out.steps[0]).toEqual({ step: 'tell', outcome: 'failed' });
  });

  it('is a send step\'s own, to the room, on a conversation-opened workflow', () => {
    expect(eventWorkflowErrors('tell', TELL)).toEqual([]);
    const at = (send: object, on = 'conversation-opened') => eventWorkflowErrors('x', { ...TELL, on, states: { ...TELL.states, tell: { ...TELL.states.tell, send } } } as EventWorkflow).join('\n');
    expect(at({ to: 'room', in: 'parent', template: 'incident-resolved-team' })).toMatch(/\.in is opener/);
    expect(at({ to: 'room', in: 'opener', template: 'incident-resolved-team' }, 'assistant-joined')).toMatch(/\.in is opener on a conversation-opened workflow/);
    expect(at({ to: { participantRole: 'lead' }, in: 'opener', template: 'incident-resolved-team' })).toMatch(/\.in says it to the room/);
    expect(at({ to: 'room', in: 'opener', template: 'incident-resolved-team', mention: { lead: 'participantRole:lead' } })).toMatch(/\.in says it to the room/);
  });
});

describe('a link that could not be read is a failure, never a refusal and never a SecurityEvent', () => {
  const CHILD = 'arn:aws:chime:us-east-1:111122223333:app-instance/inst/channel/conv-child-1';
  const throttled = async () => { throw Object.assign(new Error('slow'), { name: 'ProvisionedThroughputExceededException' }); };

  it('a row read that fails is `unreadable`, with the failure\'s name, for the opener and for the opened conversation alike', async () => {
    expect(await openerConversation(CHILD, throttled)).toEqual({ unreadable: 'ProvisionedThroughputExceededException' });
    expect(await openedConversation(ROOM, '?conversation=conv-child-1', throttled)).toEqual({ unreadable: 'ProvisionedThroughputExceededException' });
  });

  it('only what the rows say refuses: no parent recorded, nothing opened, or a child that records another parent', async () => {
    expect(await openerConversation(CHILD, async () => ({}))).toEqual({ refused: 'none-recorded' });
    expect(await openerConversation(CHILD, async () => ({ parentRef: '?conversation=conv-ops-1' }))).toEqual({ arn: ROOM });
    expect(await openedConversation(ROOM, undefined, async () => ({}))).toEqual({ refused: 'opened-none' });
    expect(await openedConversation(ROOM, '?conversation=conv-child-1', async () => ({ parentRef: '?conversation=conv-other' }))).toEqual({ refused: 'not-opened-from-here' });
    expect(await openedConversation(ROOM, '?conversation=conv-child-1', async () => ({ parentRef: '?conversation=conv-ops-1' }))).toEqual({ arn: CHILD });
  });

  it('the router reads each link up to three times, and one still unreadable is logged as an error and answered as a failed send', () => {
    const fn = router.slice(router.indexOf('function linkUnreadable('), router.indexOf('async function sayWorkflowSend('));
    expect(fn).toMatch(/console\.error\('\[Router\]\[event-workflow\] a send beyond this conversation could not read its link/);
    expect(fn).toMatch(/return \{ tags: await tryThrice\(\(\) => readChannelTags\(chimeClient, channelArn\)\) \};/);
    // Every unreadable answer takes the failure before any refusal, or SecurityEvent, is decided.
    for (const say of ['sayInOpener', 'sayInOpened']) {
      const from = router.indexOf(`async function ${say}(`);
      const body = router.slice(from, router.indexOf('\nasync function ', from + 10));
      expect(body).toMatch(/if \('unreadable' in found\) return linkUnreadable\(/);
      expect(body).toMatch(/if \('unreadable' in read\) return linkUnreadable\(/);
      expect(body.indexOf("'unreadable' in found")).toBeLessThan(body.indexOf("'refused' in found"));
      expect(body).not.toMatch(/\.catch\(\(\) => null\)/);
    }
  });

  it('the step it failed is `failed`, and the run goes on by the step\'s failure edge, so the claimed send is not lost silently', async () => {
    const out = await runEventWorkflow('tell', TELL, ctx, deps(false).d);
    expect(out.steps[0]).toEqual({ step: 'tell', outcome: 'failed' });
    expect(out.ended).toBe('failure');
  });
});

describe('the router finds the opener by its stored link, and membership decides (no new store or grant)', () => {
  const fn = router.slice(router.indexOf('async function sayInOpener('), router.indexOf('async function sayWorkflowSend('));

  it('reads the parent the opened conversation\'s row records, never a value from the run', () => {
    expect(fn).toMatch(/const found = await openerConversation\(args\.channelArn, readLinkRow\);/);
    expect(router).toMatch(/const readLinkRow = \(channelArn: string\)[^=]*=>\s*tryThrice\(\(\) => readChannelContext\(channelArn, \{ consistent: true \}\)\);/);
  });

  it('DENY: a parent of another classification, archived or unreadable, is refused before anything is said', () => {
    expect(fn).toMatch(/const read = await readTagsForSend\(parent\);[\s\S]*?const closed = roomRefusal\(read\.tags\);\n\s+if \(closed\) \{[\s\S]*?return 'refused';/);
    expect(fn.indexOf('roomRefusal(')).toBeLessThan(fn.indexOf('sayWorkflowSendOutcome('));
  });

  it('posts there as the assistant itself, to the room, written, and a refusal by the service is the step\'s `refused`', () => {
    expect(fn).toMatch(/sayWorkflowSendOutcome\(\{\n\s+\.\.\.args, channelArn: parent, to: \[\], mentions: \[\], fallback: true,/);
    const say = router.slice(router.indexOf('async function sayWorkflowSendOutcome('), router.indexOf('async function sendLanguages('));
    expect(say).toMatch(/speakingAs\(\{ botArn: args\.botArn, channelArn: args\.channelArn, purpose: 'event' \}/);
    expect(say).toMatch(/return \(err as Error\)\?\.name === 'ForbiddenException' \? 'refused' : 'failed';/);
  });

  it('the run\'s send names where it is said, and only an opener or an opened send leaves the run\'s own conversation', () => {
    const d = router.slice(router.indexOf('function eventRunDeps('), router.indexOf('async function offerIntakeStep('));
    expect(d).toMatch(/if \(where !== 'opened'\) return where === 'opener' \? sayInOpener\(said\) : sayWorkflowSend\(said\);[\s\S]*?return sayInOpened\(\{ \.\.\.said, openTypes:/);
  });
});

describe('the team hears "resolved" once, at the resolve (WT129, O24)', () => {
  const room = SHIPPED_EVENT_WORKFLOWS['ops-room'];
  const team = SHIPPED_EVENT_WORKFLOWS['incident-triage'];
  const gated: EventRunContext = {
    ...ctx, gate: { lookup: () => undefined, values: {}, callSite: { identitySettled: true, conversationSettled: true, subjectSettled: true } as never },
  };

  it('the incident run tells the team conversation as it moves on from the resolve, and a redelivered resolve posts nothing more', async () => {
    const run = deps(true);
    run.d.holdEnd = async () => 'held';
    const resolved = { from: 'resolved', transitions: [{ step: 'lead-task', outcome: 'task:success:resolved' }] };
    await runEventWorkflow('ops-room', room, gated, run.d, resolved);
    await runEventWorkflow('ops-room', room, gated, run.d, resolved);
    expect(run.sends.filter((s) => s.in === 'opener')).toEqual([{ template: 'incident-resolved-team', in: 'opener', to: [] }]);
  });

  it('refused there, the incident run still goes on to the investigation and the review', async () => {
    const run = deps('refused');
    run.d.holdEnd = async () => 'held';
    const out = await runEventWorkflow('ops-room', room, gated, run.d, { from: 'resolved', transitions: [] });
    expect(out.steps).toEqual([{ step: 'resolved', outcome: 'posted' }, { step: 'tell-team', outcome: 'refused' }, { step: 'tell-messaging-resolved', outcome: 'refused' }, { step: 'investigation-complete', outcome: 'waiting' }]);
  });

  it('the team\'s run, told the incident ended, says nothing more', async () => {
    const run = deps(true);
    const out = await continueAfter('incident-triage', team, { event: 'event-received', channelArn: ROOM, values: { label: 'api-latency' } }, { step: 'hold', outcome: WAIT_CAME }, run.d);
    expect(out.ended).toBe('success');
    expect(run.sends).toEqual([]);
  });
});
