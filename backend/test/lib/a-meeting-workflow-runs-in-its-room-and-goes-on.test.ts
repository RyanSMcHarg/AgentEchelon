/**
 * A MEETING'S WORKFLOW RUNS IN ITS ROOM AND GOES ON (`meeting-started`, `meeting-ended`, the meetings capability).
 *
 *  - A version's workflow on a meeting event is selected, one per event, and runs only in the room types it names.
 *  - Its run values are named as the shipped meeting templates read them, and read through their event fields.
 *  - Its meeting rides every hand-back, so the run's natural key is computed again and its later steps run.
 *  - A meeting step is refused where a meeting's end raises the event, and is a room step for every condition on it.
 *  - A meeting offer goes on to a meeting step when the person asked starts it.
 *  - The notice a meeting step names must exist, as every template a workflow names must.
 *  - The handoff decides nothing: an end is confirmed by the service, a failed read is retried, and the started card's
 *    email leaves out the person who started it. Every meeting card is said one way, in the room's language.
 *  - A meeting's own conversation welcomes nobody; a workflow's start is the meeting's started card.
 *  - One meeting-id pattern and one room-eligibility rule.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  EVENTS_SELECTING_THEIR_WORKFLOW, MEETING_DURATION_VALUE, MEETING_EVENT_VALUES, MEETING_LINK_VALUE,
  declaredWorkflowOn, edgeAudience, eventWorkflowErrors, templatesNamedBy, versionEventWorkflowsErrors, type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import { eventNaturalKey } from '../../lambda/src/lib/event-natural-key';
import { MEETING_ID, endedAt, isMeetingId } from '../../lambda/src/lib/meeting-lifecycle';
import { __setMeetingsClient, meetingRunsNow } from '../../lambda/src/lib/meeting-run';
import { withinMetadataCap, notifyDirective } from '../../lambda/src/lib/notify-directive';
import { conversationClosedTo } from '../../lambda/src/lib/channel-classification';
import { shippedMessageTemplate } from '../../lambda/src/lib/shipped-message-templates';
import { EVENT_FIELDS } from '../../lambda/src/lib/variables';
import { DEFAULT_TASK_STATE_MACHINES } from '../../lambda/src/lib/task-state-machines';

const SRC = path.join(__dirname, '..', '..');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
const router = read('lambda/src/router-agent-handler.ts');
/** One function of the router's source, from its declaration to the next top-level function. */
const fnOf = (name: string): string => {
  const start = router.search(new RegExp(`\\n(export )?(async )?function ${name}[(<]`));
  expect(start).toBeGreaterThan(-1);
  const next = router.slice(start + 10).search(/\n(export )?(async )?function /);
  return router.slice(start, next < 0 ? undefined : start + 10 + next);
};
const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai/channel/ch-1';
const M = 'a1b2c3d4-0000-1111-2222-333344445555';

const recap = (on: string, extra: Record<string, unknown> = {}): EventWorkflow => ({
  on, ...extra, initial: 'say', states: { say: { send: { to: 'room', template: 'meeting-recap' }, onSuccess: 'done' }, done: { disposition: 'success' } },
} as unknown as EventWorkflow);

describe('a version\'s meeting workflow is selected', () => {
  it('is the one the version declares on the event, and a version declares at most one per meeting event', () => {
    expect(EVENTS_SELECTING_THEIR_WORKFLOW).toEqual(expect.arrayContaining(['meeting-started', 'meeting-ended']));
    expect(declaredWorkflowOn({ recap: recap('meeting-ended') }, 'meeting-ended')?.name).toBe('recap');
    expect(declaredWorkflowOn({ recap: recap('meeting-ended') }, 'meeting-started')).toBeUndefined();
    const two = versionEventWorkflowsErrors({ a: recap('meeting-ended', { types: ['general'] }), b: recap('meeting-ended', { types: ['ops'] }) });
    expect(two.join(' ')).toMatch(/2 workflows on meeting-ended/);
  });

  it('runs only in the room types it names, as every event\'s workflow does', () => {
    const fn = fnOf('handleMeetingLifecycle');
    expect(fn).toContain("if (declared.workflow.types?.length && !(roomType && declared.workflow.types.includes(roomType))) return { ran: false, carded, reason: 'no workflow for this type' };");
    expect(fn.indexOf('no workflow for this type')).toBeLessThan(fn.indexOf('runWorkflowFor('));
  });
});

describe('its run values are the ones the shipped templates read', () => {
  it('names the link and the length as the shipped meeting templates name their fields', () => {
    expect(MEETING_EVENT_VALUES['meeting-started'].value).toBe(MEETING_LINK_VALUE);
    expect(MEETING_EVENT_VALUES['meeting-ended'].value).toBe(MEETING_DURATION_VALUE);
    expect(Object.keys(shippedMessageTemplate('meeting-started').fields ?? {})).toContain(MEETING_LINK_VALUE);
    expect(Object.keys(shippedMessageTemplate('meeting-ended').fields ?? {})).toContain(MEETING_DURATION_VALUE);
    // Each is read through the event field the platform declares for it.
    for (const [event, { field }] of Object.entries(MEETING_EVENT_VALUES)) {
      expect(EVENT_FIELDS.some((f) => f.event === event && `event:${f.field}` === field)).toBe(true);
    }
  });

  it('hands the run the card\'s own values, and maps them to their event fields', () => {
    expect(fnOf('handleMeetingLifecycle')).toContain('event: h.event, channelArn: room, meeting: { meetingId: h.meetingId }, values,');
    expect(fnOf('eventSourceValues')).toContain('MEETING_EVENT_VALUES[ctx.event]');
  });
});

describe('its meeting rides every hand-back', () => {
  it('keys the run by the meeting, and refuses a key with no meeting', () => {
    expect(eventNaturalKey('meeting-ended', CHANNEL, undefined, undefined, undefined, undefined, undefined, undefined, M)).toBe(`meeting-${M}`);
    expect(eventNaturalKey('meeting-ended', CHANNEL)).toBeUndefined();
  });

  it('carries the meeting on the agent step, the wait, the task, the open step and the continuation', () => {
    expect(fnOf('runIdentity')).toContain('...(ctx.meeting ? { meeting: ctx.meeting } : {})');
    const deps = fnOf('eventRunDeps');
    expect(deps.match(/\.\.\.runIdentity\(ctx\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(fnOf('askingRunOf')).toContain('...runIdentity(ctx)');
    expect(fnOf('openChildConversation')).toContain('...runIdentity(ctx)');
    expect(fnOf('openWorkflowTaskStep')).toContain('...runIdentity(ctx)');
    expect(fnOf('continueRunOn')).toContain('...(run.meeting ? { meeting: run.meeting } : {})');
    expect(fnOf('dispatchEventAgentStep')).toContain('meetingId: args.meeting?.meetingId');
    const cont = fnOf('handleEventContinuation');
    expect(cont).toContain('isMeetingEvent(wf.on) && isMeetingId(req.meeting?.meetingId)');
    expect(cont).toContain('subjectMessageId: str(req.values?.message), meetingId: meeting?.meetingId');
    expect(cont).toContain('...(meeting ? { meeting } : {})');
    // The processor hands it back with the step's outcome, from its one copy of the run's identity.
    const processor = read('lambda/src/assistant-async-processor.ts');
    expect(processor.match(/\.\.\.\(req\.meeting \? \{ meeting: req\.meeting \} : \{\}\)/g)).toHaveLength(1);
    // Both hand-backs carry it; the step's own adds the file it delivered, which a later approval reads as its first version.
    expect(processor.match(/values: (req\.values \?\? \{\}|\{ \.\.\.\(req\.values \?\? \{\}\), \.\.\.delivered \}), \.\.\.identity,/g)).toHaveLength(2);
  });
});

describe('a meeting step', () => {
  const wf = (on: string, states: Record<string, unknown>): EventWorkflow => ({ on, initial: Object.keys(states)[0], states } as unknown as EventWorkflow);
  const meet = { action: { tool: 'start_meeting', email: true }, onSuccess: 'done', onFailure: 'done' };
  const done = { disposition: 'success' };

  it('is refused where a meeting\'s end raises the event, so no end starts the next meeting', () => {
    expect(eventWorkflowErrors('m', wf('meeting-ended', { meet, done })).join(' ')).toMatch(/a meeting is not started at meeting-ended/);
    expect(eventWorkflowErrors('m', wf('meeting-started', { meet, done }))).toEqual([]);
  });

  it('is a room step, so a fact about the person who joined never selects it or the edge into it (ADR-060)', () => {
    const gated = { ...meet, when: { 'person:clearance': { op: 'has', value: 'premium' } } };
    expect(eventWorkflowErrors('m', wf('person-joined', { gated, done })).join(' ')).toMatch(/person/);
    const choose = {
      send: { to: 'joined', template: 'hello' },
      onSuccess: [{ to: 'meet', when: { 'person:clearance': { op: 'has', value: 'premium' } } }, { to: 'done' }],
    };
    expect(eventWorkflowErrors('m', wf('person-joined', { choose, meet, done })).join(' ')).toMatch(/person/);
    expect(edgeAudience([{ to: 'meet', when: { 'room:x': 1 } }, { to: 'done' }], { meet, done })).toBe('room');
  });

  it('names a notice that must exist, as every template a workflow names must', () => {
    const named = templatesNamedBy(wf('meeting-started', { meet: { ...meet, action: { tool: 'start_meeting', notice: 'incident-call-notice' } }, done }));
    expect(named).toContainEqual({ name: 'incident-call-notice', kind: 'message', at: 'meet.action.notice' });
  });
});

describe('a meeting offer goes on to the meeting it offers', () => {
  const opts = { machines: DEFAULT_TASK_STATE_MACHINES };
  const offer = (onSuccess: unknown) => ({
    on: 'alarm-state-changed', initial: 'offer',
    states: {
      offer: { task: { machine: 'meeting_offer', for: { participantRole: 'on-call:ops' }, by: { participantRole: 'on-call:ops' }, visibility: 'private' }, onSuccess, onFailure: 'done' },
      meet: { action: { tool: 'start_meeting' }, onSuccess: 'done', onFailure: 'done' },
      say: { send: { to: 'room', template: 'hello' }, onSuccess: 'done' },
      done: { disposition: 'success' },
    },
  });
  it('accepts an offer whose start goes on to a meeting step', () => {
    const errs = eventWorkflowErrors('m', offer([{ to: 'meet', when: { 'task:state': 'start' } }, { to: 'done' }]), opts);
    expect(errs.join(' ')).not.toMatch(/offers a meeting/);
  });
  it('refuses one whose start goes anywhere else, or that has no start edge', () => {
    for (const edge of [[{ to: 'say', when: { 'task:state': 'start' } }, { to: 'done' }], 'done', [{ to: 'meet', when: { 'task:state': 'declined' } }, { to: 'done' }]]) {
      expect(eventWorkflowErrors('m', offer(edge), opts).join(' ')).toMatch(/offers a meeting, so its onSuccess goes to a start_meeting step/);
    }
  });
});

describe('the handoff decides nothing', () => {
  afterEach(() => __setMeetingsClient(undefined));

  it('believes an end only once the service no longer holds the meeting, and a service that cannot answer is retried', async () => {
    __setMeetingsClient({ send: async () => ({ Meeting: { MeetingId: M } }) } as never);
    expect(await meetingRunsNow(M)).toBe(true);
    __setMeetingsClient({ send: async () => { throw Object.assign(new Error('gone'), { name: 'NotFoundException' }); } } as never);
    expect(await meetingRunsNow(M)).toBe(false);
    __setMeetingsClient({ send: async () => { throw Object.assign(new Error('slow'), { name: 'ThrottlingException' }); } } as never);
    await expect(meetingRunsNow(M)).rejects.toThrow('slow');
    const fn = fnOf('handleMeetingLifecycle');
    expect(fn).toContain("if (await meetingRunsNow(h.meetingId)) return refuse('the meeting is still running');");
    // Once the service confirms the end, the conversation's record of that meeting, and no newer one, is released.
    expect(fn.indexOf('meetingRunsNow(h.meetingId)')).toBeLessThan(fn.indexOf('await releaseActiveMeeting(h.channelArn, h.meetingId, serviceEnd) === '));
    expect(fn.indexOf('await releaseActiveMeeting(h.channelArn, h.meetingId, serviceEnd) === ')).toBeGreaterThan(-1);
    // WHEN IT ENDED is the service's own time, written by the release itself, and put over a reader's earlier stamp.
    expect(fn).toContain('const serviceEnd = endedAt(h.at, last.createdAt);');
    expect(fn).toContain('await recordMeetingFact(h.channelArn, h.meetingId, { endedAt: serviceEnd });');
  });

  it('holds the reported end between the meeting\'s recorded start and now', () => {
    const now = Date.parse('2026-11-12T10:00:00Z');
    expect(endedAt('2026-11-12T09:30:00Z', '2026-11-12T09:00:00Z', now)).toBe('2026-11-12T09:30:00.000Z');
    expect(endedAt('2027-01-01T00:00:00Z', '2026-11-12T09:00:00Z', now)).toBe('2026-11-12T10:00:00.000Z');
    expect(endedAt('2020-01-01T00:00:00Z', '2026-11-12T09:00:00Z', now)).toBe('2026-11-12T09:00:00.000Z');
    expect(fnOf('handleMeetingLifecycle')).toContain('durationMinutes(last.createdAt, endedAt(h.at, last.createdAt))');
  });

  it('retries a read that fails rather than refusing or carding the wrong conversation', () => {
    for (const fn of [fnOf('handleMeetingLifecycle'), fnOf('meetingRoomOf')]) {
      expect(fn).not.toMatch(/\.catch\(\(\) => (null|undefined)\)/);
      expect(fn).not.toContain('getChannelContext(');
    }
    expect(fnOf('handleMeetingLifecycle')).toContain('await readChannelContext(h.channelArn, { consistent: true })');
  });

  it('emails a person\'s start to the room\'s other members, never to the person who started it', () => {
    const fn = fnOf('handleMeetingLifecycle');
    expect(fn).toContain("const starter = started && last.startedVia !== 'workflow' && last.createdBy ? [last.createdBy] : [];");
    expect(fn).toContain("link: 'meeting', exclude: starter,");
  });
});

describe('every meeting card is said one way', () => {
  it('in the room\'s language, through one helper that both the lifecycle and the summary use', () => {
    expect(fnOf('meetingCardTemplate')).toContain("chooseLanguage(chosen, { audience: 'room', ...(await sendLanguages(room, [])) }).written");
    expect(fnOf('postMeetingCard')).toContain('sayMeetingCard(');
    for (const fn of ['handleMeetingLifecycle', 'rewriteEndedCard']) {
      expect(fnOf(fn)).toMatch(/(say|post)MeetingCard\(/);
      expect(fnOf(fn)).not.toContain('renderMessageTemplate(');
      expect(fnOf(fn)).not.toContain('speakAsRoutedAssistant(');
    }
  });

  it('keeps its Metadata within the service\'s cap, giving up the email\'s own words first', () => {
    const long = 'x'.repeat(900);
    const meta = { meetingCard: { event: 'meeting-started', meetingId: M }, ...notifyDirective({ subject: 'Call about a long alarm', body: long, conversationId: 'c', link: 'meeting' }) };
    const fit = withinMetadataCap(meta, 1024);
    expect(encodeURIComponent(JSON.stringify(fit)).length).toBeLessThanOrEqual(1024);
    expect(fit).toMatchObject({ meetingCard: meta.meetingCard, notify: { email: true }, notifySubject: 'Call about a long alarm' });
    expect(fit).not.toHaveProperty('notifyBody');
    expect(withinMetadataCap({ a: 1 }, 1024)).toEqual({ a: 1 });
    expect(fnOf('sayWorkflowSendOutcome')).toContain('Metadata: JSON.stringify(withinMetadataCap(metadata, CHIME_METADATA_MAX))');
  });

  it('an ended card naming many hosts still fits, giving up its last hosts, and every post and rewrite is held to the cap', () => {
    const hosts = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(4, '0')}aaaa-bbbb-cccc-dddd-eeeeeeeeeeee`);
    const meta = {
      meetingCard: { event: 'meeting-ended', meetingId: M, conversationId: 'meet-room-1', durationMinutes: 42, summarized: true, transcriptKey: `transcripts/premium/c/${M}/t.md`, hosts },
      turnKind: 'meeting_summary', trigger: 'meeting_summary',
    };
    expect(encodeURIComponent(JSON.stringify(meta)).length).toBeGreaterThan(1024);
    const fit = withinMetadataCap(meta, 1024) as typeof meta;
    expect(encodeURIComponent(JSON.stringify(fit)).length).toBeLessThanOrEqual(1024);
    expect(fit.meetingCard.hosts.length).toBeGreaterThan(0);
    expect(fit.meetingCard.hosts).toEqual(hosts.slice(0, fit.meetingCard.hosts.length));
    expect({ ...fit.meetingCard, hosts: [] }).toEqual({ ...meta.meetingCard, hosts: [] });
    expect(fnOf('postMeetingCard')).toContain('Metadata: JSON.stringify(withinMetadataCap(args.metadata(said), CHIME_METADATA_MAX))');
    expect(fnOf('rewriteEndedCard')).toContain('Metadata: JSON.stringify(withinMetadataCap({');
  });
});

describe('a meeting started by a workflow', () => {
  it('rings as the assistant the router records first, and its notice is the meeting\'s started card', () => {
    const step = fnOf('startMeetingStep');
    const speak = step.indexOf('speakingAs({ botArn: args.botArn');
    expect(speak).toBeGreaterThan(-1);
    expect(speak).toBeLessThan(step.indexOf('Type: ChannelMessageType.CONTROL'));
    expect(step).toContain("cardMetadata: meetingCardMetadata('meeting-started', meetingId, meetingArn, ringUntil ? { ringUntil } : {})");
    // The step's ring length is recorded on the meeting, so a person who arrives while it rings hears the rest.
    expect(step).toContain('startConversationMeeting(fn, args.channelArn, botIdFromArn(args.botArn), args.def.ringSeconds)');
  });

  it('is never welcomed into its own conversation', () => {
    expect(router).toContain('if (channelArn && meetingSettingsOf(welcomeTypeKey)) return formatLexNothingToPost(event);');
  });
});

describe('one meeting id, one room rule', () => {
  it('reads every meeting id by one pattern, the chat app\'s included', () => {
    expect(isMeetingId(M)).toBe(true);
    expect(isMeetingId("m'1")).toBe(false);
    expect(isMeetingId('a'.repeat(65))).toBe(false);
    const chat = fs.readFileSync(path.join(SRC, '..', 'frontend', 'packages', 'chat', 'src', 'services', 'meetingService.ts'), 'utf8');
    expect(chat).toContain(`export const MEETING_ID = ${MEETING_ID.toString()};`);
    for (const f of ['lambda/src/meeting-summary.ts', 'lambda/src/admin-meetings.ts', 'lambda/src/lib/event-deadlines.ts', 'lambda/src/lib/meeting-event-reader.ts', 'lambda/src/lib/event-natural-key.ts']) {
      expect(read(f)).toContain('isMeetingId(');
      expect(read(f)).not.toMatch(/const (MEETING_ID|SAFE_ID) = /);
    }
  });

  it('decides where code may act from one rule: this classification\'s, readable, and not archived', () => {
    expect(conversationClosedTo(null, 'premium')).toBe('unreadable');
    expect(conversationClosedTo({ classification: 'basic' }, 'premium')).toBe('classification');
    expect(conversationClosedTo({ classification: 'premium', archived: 'true' }, 'premium')).toBe('archived');
    expect(conversationClosedTo({ classification: 'premium' }, 'premium')).toBeUndefined();
    expect(router).not.toContain("tags.archived === 'true'");
    expect(read('lambda/src/typed-conversation-from-event.ts')).not.toContain("tags.archived === 'true'");
  });
});

describe("the creator admits a person to a meeting's conversation only as a member of its room", () => {
  it("reads the room's membership itself before it adds anyone (tenet D3)", () => {
    const creator = read('lambda/src/typed-conversation-from-event.ts');
    const admit = creator.slice(creator.indexOf("if (request.aeMeeting === 'admit')"), creator.indexOf('await addInvitedMember({ channelArn: meetingArn'));
    expect(admit).toContain("if (!(await isMemberOf(parentArn, personArn, admin))) return { ok: false, code: 'NOT_A_MEMBER' };");
    expect(creator).toContain('new DescribeChannelMembershipCommand({ ChannelArn: channelArn, MemberArn: personArn, ChimeBearer: bearerArn })');
  });
});

describe('a long run\'s card still fits the service\'s Metadata cap', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { withinMetadataCap: cap } = require('../../lambda/src/lib/notify-directive');
  const size = (m: Record<string, unknown>) => encodeURIComponent(JSON.stringify(m)).length;
  const card = (moves: number) => ({
    botResponse: true, targetedSender: 'arn:aws:chime:us-east-1:111122223333:app-instance/inst/user/person',
    task: { id: 'evt-0123456789abcdef01234567', machine: 'approval', state: 'pending', choices: ['approved', 'declined'] },
    eventStep: { workflow: 'ops-room', step: 'runbook-decide', event: 'conversation-opened', outcome: 'posted' },
    eventRun: { runKey: 'conversation-opened#conv-ops-1794633726098-f7e408140793#ops-premium', transitions: Array.from({ length: moves }, (_, i) => ({ step: `step-number-${i}`, outcome: 'success' })) },
    notify: { email: true }, notifySubject: 'Runbook decision', notifyTargets: ['person'], notifyKind: 'task',
  });

  it('sheds the email\'s words first, then the run\'s oldest moves, and keeps the task card and the newest move', () => {
    const long = card(14);
    expect(size(long)).toBeGreaterThan(1024);
    const out = cap(long, 1024) as ReturnType<typeof card>;
    expect(size(out)).toBeLessThanOrEqual(1024);
    expect(out.task).toEqual(long.task);
    expect(out.notify).toEqual({ email: true });
    expect(out.eventRun.runKey).toBe(long.eventRun.runKey);
    expect(out.eventRun.transitions.at(-1)).toEqual({ step: 'step-number-13', outcome: 'success' });
    expect(out.eventRun.transitions.length).toBeLessThan(14);
  });

  it('leaves a card that fits as it is', () => {
    const short = card(2);
    expect(cap(short, 1024)).toBe(short);
  });
});
