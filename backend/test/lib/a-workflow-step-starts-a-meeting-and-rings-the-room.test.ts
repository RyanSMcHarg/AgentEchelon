/**
 * A WORKFLOW STEP STARTS A MEETING AND RINGS THE ROOM (`start_meeting`, the `meetings` capability).
 *
 *  - The step is declared as an action: its ring within bounds, a template by name, and nothing else.
 *  - It runs once: a redelivered event starts and rings nothing twice.
 *  - Its link is the run's, so a following send names it.
 *  - Without the capability, or when the meeting cannot be started, it takes the failure edge.
 *  - A private run starts none, because a meeting rings and tells the whole room.
 *  - The ring is one shape (`ae:ring:<seconds>`) within the service's 30 bytes, read the same by the chat app, and its
 *    length is the step's, else the deployment's, else ten seconds.
 *  - The email leads into the meeting window, built from this deployment's origin and an id, never a URL a message carries.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  continueAfter, eventWorkflowErrors, reachesBeyondRequester, runEventWorkflow, MEETING_LINK_VALUE,
  type EventRunContext, type EventRunDeps, type EventWorkflow, type MeetingAction,
} from '../../lambda/src/lib/event-workflow';
import {
  CONTROL_CONTENT_MAX_BYTES, DEFAULT_RING_SECONDS, MAX_RING_SECONDS, MIN_RING_SECONDS, RING_OFF, parseRing, ringContent, ringOnStart, ringSecondsFor, ringSecondsLeft, ringSecondsOf,
} from '../../lambda/src/lib/meeting-ring';
import { meetingDeepLink, notifyDirective } from '../../lambda/src/lib/notify-directive';
import { parseNotifyDirective } from '../../lambda/src/lib/channel-notify';
import { shippedMessageTemplate } from '../../lambda/src/lib/shipped-message-templates';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';

const CHANNEL = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';

const WF: EventWorkflow = {
  initial: 'meet',
  states: {
    meet: { action: { tool: 'start_meeting', ringSeconds: 15, email: true }, onSuccess: 'say', onFailure: 'sorry' },
    say: { send: { to: 'room', template: 'agenda' }, onSuccess: 'done' },
    sorry: { send: { to: 'room', template: 'no-meeting' }, onSuccess: 'done' },
    done: { disposition: 'success' },
  },
} as unknown as EventWorkflow;

function world(startMeeting?: EventRunDeps['startMeeting']) {
  const taken = new Set<string>();
  const said: Array<{ template: string; values: Record<string, string> }> = [];
  const deps: EventRunDeps = {
    claimRun: async () => true,
    claimStep: async (step, outcome) => (taken.has(`${step}#${outcome}`) ? false : (taken.add(`${step}#${outcome}`), true)),
    mentionName: async () => '',
    send: async (a) => { said.push({ template: a.template, values: a.values }); return true; },
    dispatchAgent: async () => true,
    ...(startMeeting ? { startMeeting } : {}),
  };
  return { deps, said };
}
const ctx: EventRunContext = { event: 'conversation-opened', channelArn: CHANNEL, values: {} } as EventRunContext;

describe('the step as a workflow declares it', () => {
  const at = (action: unknown) => eventWorkflowErrors('m', { on: 'alarm-state-changed', initial: 'a', states: { a: { action, onSuccess: 'z' }, z: { disposition: 'success' } } }, {});
  it('accepts the step with its fields, and with none', () => {
    expect(at({ tool: 'start_meeting' })).toEqual([]);
    expect(at({ tool: 'start_meeting', ringSeconds: 10, notice: 'meeting-started', email: true })).toEqual([]);
  });
  it('refuses a ring outside 5 to 60 seconds, a notice that is not a template name, and a field it does not declare', () => {
    expect(at({ tool: 'start_meeting', ringSeconds: 2 }).join(' ')).toMatch(/ringSeconds/);
    expect(at({ tool: 'start_meeting', ringSeconds: 90 }).join(' ')).toMatch(/ringSeconds/);
    expect(at({ tool: 'start_meeting', notice: 'Not A Name' }).join(' ')).toMatch(/notice/);
    expect(at({ tool: 'start_meeting', to: 'room' }).join(' ')).toMatch(/not a field of a meeting step/);
  });
});

describe('the step runs', () => {
  it('starts the meeting once, and a following send names its link', async () => {
    const calls: MeetingAction[] = [];
    const w = world(async (_step, def) => { calls.push(def); return { link: '?meeting=c1' }; });
    const out = await runEventWorkflow('meet', WF, ctx, w.deps);
    expect(out.ended).toBe('success');
    expect(calls).toEqual([{ tool: 'start_meeting', ringSeconds: 15, email: true }]);
    expect(w.said).toEqual([{ template: 'agenda', values: expect.objectContaining({ [MEETING_LINK_VALUE]: '?meeting=c1' }) }]);
    // Redelivered: the step is claimed, so nothing starts or rings again, and nothing is said without the link.
    const again = await runEventWorkflow('meet', WF, ctx, w.deps);
    expect(calls).toHaveLength(1);
    expect(again.steps).toEqual([{ step: 'meet', outcome: 'already-claimed' }]);
    expect(w.said).toHaveLength(1);
  });

  it('says no link it does not hold: a step whose claim cannot be written starts nothing and the run stops there', async () => {
    const calls: MeetingAction[] = [];
    const w = world(async (_step, def) => { calls.push(def); return { link: '?meeting=c1' }; });
    const out = await runEventWorkflow('meet', WF, ctx, { ...w.deps, claimStep: async () => false });
    expect(calls).toEqual([]);
    expect(out.ended).toBeUndefined();
    expect(w.said).toEqual([]);
  });

  it('takes the failure edge when the meeting cannot be started', async () => {
    const w = world(async () => 'failed');
    await runEventWorkflow('meet', WF, ctx, w.deps);
    expect(w.said.map((s) => s.template)).toEqual(['no-meeting']);
  });

  it('takes the failure edge where the deployment does not declare meetings', async () => {
    const w = world();
    await runEventWorkflow('meet', WF, ctx, w.deps);
    expect(w.said.map((s) => s.template)).toEqual(['no-meeting']);
  });

  it('is withheld from a private run, because a meeting reaches the whole room', () => {
    expect(reachesBeyondRequester({ action: { tool: 'start_meeting' } }, { ...ctx, requester: 'p' } as EventRunContext)).toBe(true);
  });
});

describe('the ring', () => {
  it('is one shape within the service\'s control-message limit, and reads back', () => {
    for (const s of [5, 10, 60]) {
      expect(Buffer.byteLength(ringContent(s))).toBeLessThanOrEqual(CONTROL_CONTENT_MAX_BYTES);
      expect(parseRing(ringContent(s))).toBe(s);
    }
    expect(parseRing('hello')).toBeNull();
    expect(parseRing('ae:ring:abc')).toBeNull();
    expect(Buffer.byteLength(RING_OFF)).toBeLessThanOrEqual(CONTROL_CONTENT_MAX_BYTES);
  });

  it('is read as no ring at all outside 5 to 60 seconds, whoever sent it', () => {
    for (const s of [0, 4, 61, 600]) expect(parseRing(`ae:ring:${s}`)).toBeNull();
    expect(parseRing(RING_OFF)).toBeNull();
  });

  it('rings only from the start that created the meeting, for the length the meetings function recorded and answered', () => {
    expect(ringOnStart(true, 15)).toBe('ae:ring:15');
    expect(ringOnStart(false, 15)).toBeNull();
    expect(ringOnStart(undefined, 15)).toBeNull();
    // No recorded length answered, or one outside the bounds: no ring, and the router computes none of its own.
    expect(ringOnStart(true, undefined)).toBeNull();
    expect(ringOnStart(true, 600)).toBeNull();
  });

  it('is recorded once at the start, by one rule, and every later reading counts down from the recorded length', () => {
    expect(ringSecondsOf(20, '30')).toBe(20);
    expect(ringSecondsOf(600, '30')).toBe(30);
    expect(ringSecondsOf('20', undefined)).toBe(DEFAULT_RING_SECONDS);
    const at = Date.parse('2026-11-12T10:00:00Z');
    expect(ringSecondsLeft({ createdAt: '2026-11-12T10:00:00Z', ringSeconds: 30 }, at + 4_000)).toBe(26);
    expect(ringSecondsLeft({ createdAt: '2026-11-12T10:00:00Z', ringSeconds: 30 }, at + 40_000)).toBe(0);
    expect(ringSecondsLeft({ createdAt: 'not a time', ringSeconds: 30 }, at)).toBe(0);
  });

  it("the router takes the length from the run entry's answer and keeps no ring rule of its own", () => {
    const router = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'lambda', 'src', 'router-agent-handler.ts'), 'utf8') as string;
    expect(router).not.toContain('function ringLeftFor(');
    expect(router).not.toContain('ringSecondsFor(');
    expect(router).toContain('ringOnStart(started.created, started.ringSeconds)');
  });

  it('lasts the step\'s seconds, else the deployment\'s, else ten', () => {
    const bounds = { min: 5, max: 60 };
    expect(ringSecondsFor(20, bounds, '30')).toBe(20);
    expect(ringSecondsFor(undefined, bounds, '30')).toBe(30);
    expect(ringSecondsFor(undefined, bounds, '600')).toBe(DEFAULT_RING_SECONDS);
    expect(ringSecondsFor(undefined, bounds, undefined)).toBe(DEFAULT_RING_SECONDS);
  });

  it('is read by the chat app in the same shape', () => {
    const client = fs.readFileSync(path.join(__dirname, '../../../frontend/packages/chat/src/services/meetingRing.ts'), 'utf8');
    expect(client).toContain("RING_PREFIX = 'ae:ring:'");
    expect(client).toContain(`RING_OFF = '${RING_OFF}'`);
    expect(client).toContain(`MIN_RING_SECONDS = ${MIN_RING_SECONDS}`);
    expect(client).toContain(`MAX_RING_SECONDS = ${MAX_RING_SECONDS}`);
  });
});

describe('the email leads into the meeting window', () => {
  it('builds the link from the deployment\'s origin and an id, and from nothing else', () => {
    expect(meetingDeepLink('https://app.example', 'c1')).toBe('https://app.example?meeting=c1');
    expect(meetingDeepLink('https://app.example', 'https://evil.example')).toBeUndefined();
    expect(meetingDeepLink('', 'c1')).toBeUndefined();
  });

  it('carries the meeting link on the directive, and reads only that one value back', () => {
    const d = parseNotifyDirective(JSON.stringify(notifyDirective({ conversationId: 'c1', link: 'meeting' })));
    expect(d?.link).toBe('meeting');
    expect(parseNotifyDirective(JSON.stringify({ notify: { email: true }, notifyConversationId: 'c1', notifyLink: 'https://evil.example' }))?.link).toBeUndefined();
  });

  it('ships the notice the step says, with email words of its own and no app-relative link in them', () => {
    const t = shippedMessageTemplate('meeting-started');
    expect(t.messageSections?.chat).toContain('{meeting_link}');
    expect(t.messageSections?.['email.body']).toBeTruthy();
    expect(t.messageSections?.['email.body']).not.toContain('meeting_link');
  });
});

/**
 * ASK FIRST (SPEC-ASSISTANT-MEETINGS FR40): an offer step in front of the meeting, a `meeting_offer` card for the on-call,
 * starts the meeting on `start` alone. Declined or unanswered, the run goes where the meeting step's failure goes.
 */
describe('a meeting the on-call is asked to start', () => {
  const OFFERED = {
    on: 'event-received',
    types: ['ops-team'],
    initial: 'meet-offer',
    states: {
      'meet-offer': {
        task: { machine: 'meeting_offer', for: { participantRole: 'on-call:ops' }, by: { participantRole: 'on-call:ops' }, visibility: 'private', deadline: { afterMinutes: 15 } },
        onSuccess: [{ to: 'meet', when: { 'task:state': 'start' } }, { to: 'sorry' }],
        onFailure: 'sorry',
      },
      meet: { action: { tool: 'start_meeting', email: true }, onSuccess: 'say', onFailure: 'sorry' },
      say: { send: { to: 'room', template: 'agenda' }, onSuccess: 'done' },
      sorry: { send: { to: 'room', template: 'no-meeting' }, onSuccess: 'done' },
      done: { disposition: 'success' },
    },
  } as unknown as EventWorkflow;
  const opsCtx = {
    event: 'event-received', channelArn: CHANNEL, values: {},
    gate: { lookup: () => undefined, values: {}, callSite: { identitySettled: true, conversationSettled: true, subjectSettled: true } },
  } as unknown as EventRunContext;
  const machines = DEFAULT_TASK_STATE_MACHINES;

  it('is a platform machine whose card offers start and decline, each an ending the run reads', () => {
    const offered = machines.meeting_offer.states.offered;
    expect(offered.choices).toEqual(['start', 'declined']);
    expect(offered.awaits).toEqual({ party: 'worker' });
    expect(machines.meeting_offer.states.start.terminal).toBe('success');
    expect(machines.meeting_offer.states.declined.terminal).toBe('success');
  });

  it('validates as an ops workflow asking the on-call', () => {
    expect(eventWorkflowErrors('ops-meeting', OFFERED, {})).toEqual([]);
  });

  it('starts the meeting when the on-call presses start', async () => {
    const calls: MeetingAction[] = [];
    const w = world(async (_step, def) => { calls.push(def); return { link: '?meeting=c1' }; });
    await continueAfter('ops-meeting', OFFERED, opsCtx, { step: 'meet-offer', outcome: 'task:success:start' }, w.deps, machines);
    expect(calls).toHaveLength(1);
    expect(w.said.map((s) => s.template)).toEqual(['agenda']);
  });

  it('starts nothing when the on-call declines, or the offer goes unanswered', async () => {
    for (const outcome of ['task:success:declined', 'task:deadline']) {
      const calls: MeetingAction[] = [];
      const w = world(async (_step, def) => { calls.push(def); return { link: '?meeting=c1' }; });
      await continueAfter('ops-meeting', OFFERED, opsCtx, { step: 'meet-offer', outcome }, w.deps, machines);
      expect(calls).toEqual([]);
      expect(w.said.map((s) => s.template)).toEqual(['no-meeting']);
    }
  });
});
