/**
 * A DEADLINE IS A ONE-SHOT SCHEDULE THE ROUTER CREATES, AND IS CHECKED WHEN IT FIRES (ADR-061 decision 1, tenet D6).
 *
 * What it proves, as ADR-061 "What proves it" lists for a deadline: `invitation-unredeemed` is a workflow event whose
 * workflow declares its deadline; the schedule is created once, by the router, only when the version declares a
 * workflow on it, at the declared deadline brought forward to before the invitation expires; it carries ids alone and
 * deletes itself once fired; on fire the router refuses a conversation at another classification, an archived one, an
 * invitation that is redeemed, revoked or expired, and a named person who is no longer a member, before any model call;
 * revoking and archiving ask the router to delete the schedule, through grants those callers already held, while a
 * redemption and an offboarding leave it to fire, find nothing pending, and delete itself; and a create that fails is
 * retried with backoff in the same call and then raised to the classification's alarm.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  DEADLINE_EVENTS,
  EVENTS_SELECTING_THEIR_WORKFLOW,
  EVENT_WORKFLOW_EVENTS,
  MAX_DEADLINE_MINUTES,
  PLATFORM_EVENT_WORKFLOWS,
  declaredWorkflowOn,
  eventNaturalKey,
  eventRunKey,
  eventWorkflowErrors,
  versionEventWorkflowsErrors,
  workflowSendEmailKind,
  type EventWorkflow,
} from '../../lambda/src/lib/event-workflow';
import {
  atExpression, createDeadlineSchedule, deadlineAt, deadlineCancelOf, deadlineFiringOf, deadlineScheduleName, deleteDeadlineSchedule,
  DEADLINE_EXPIRY_MARGIN_SECONDS,
} from '../../lambda/src/lib/event-deadlines';
import { EVENT_FIELDS, FIXED_SOURCES } from '../../lambda/src/lib/variables';
import { DEADLINE_CREATE_ATTEMPTS, DEADLINE_CREATE_BACKOFF_MS, handleDeadlineCancel, handleDeadlineFired, scheduleInvitationDeadline } from '../../lambda/src/router-agent-handler';
import { DEADLINE_METRIC_NAMESPACE, DEADLINE_SCHEDULE_FAILED_METRIC } from '../../lambda/src/lib/event-workflow';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/ai';
const CHANNEL = `${APP}/channel/ch-1`;
const INVITEE = `${APP}/user/jordan`;
const INVITER = `${APP}/user/riley`;
const ID = '0b7f2a52-0000-4000-8000-000000000001';
const NOW_MS = 1_800_000_000_000;
const WIRING = { group: 'ae-standard-event-deadlines', roleArn: 'arn:aws:iam::111122223333:role/standard-deadlines', routerArn: 'arn:aws:lambda:us-east-1:111122223333:function:standard-router' };

const CHASE = PLATFORM_EVENT_WORKFLOWS['chase-unredeemed'];

describe('the deadline event (ADR-061 decision 1)', () => {
  it('invitation-unredeemed is a built event that names the invitee, selects its own workflow, and is marked by a deadline', () => {
    expect(EVENT_WORKFLOW_EVENTS).toContain('invitation-unredeemed');
    expect(DEADLINE_EVENTS).toEqual(['invitation-unredeemed']);
    expect(EVENTS_SELECTING_THEIR_WORKFLOW).toContain('invitation-unredeemed');
    expect(EVENT_FIELDS.find((f) => f.event === 'invitation-unredeemed')).toMatchObject({ field: 'person', computedByPlatform: true });
    for (const k of ['invitation:inviter', 'invitation:invitee', 'invitation:reason']) expect(FIXED_SOURCES[k].events).toContain('invitation-unredeemed');
  });

  it('the platform\'s chase drafts a reminder for the inviter to confirm, three days after the invitation was sent', () => {
    expect(CHASE).toMatchObject({ on: 'invitation-unredeemed', deadline: { afterMinutes: 4320 } });
    expect(CHASE.states['draft-nudge'].agent).toMatchObject({ propose: ['send_nudge'], to: { people: 'invitation:inviter' } });
    expect(eventWorkflowErrors('chase-unredeemed', CHASE)).toEqual([]);
  });

  it('a deadline workflow declares its deadline, within bounds, and no other workflow declares one', () => {
    const none = clone(CHASE) as any;
    delete none.deadline;
    expect(eventWorkflowErrors('x', none).join()).toMatch(/deadline\.afterMinutes is a whole number of minutes from 5 to 43200/);
    expect(eventWorkflowErrors('x', { ...clone(CHASE), deadline: { afterMinutes: MAX_DEADLINE_MINUTES + 1 } }).join()).toMatch(/deadline\.afterMinutes/);
    expect(eventWorkflowErrors('x', { ...clone(PLATFORM_EVENT_WORKFLOWS['opening-and-subject']), deadline: { afterMinutes: 60 } }).join())
      .toMatch(/deadline is declared only on a deadline event \(invitation-unredeemed\)/);
  });

  it('a version declares at most one, which no welcome names, and its event selects it', () => {
    expect(versionEventWorkflowsErrors({ a: CHASE, b: CHASE }).join()).toMatch(/declares 2 workflows on invitation-unredeemed/);
    expect(declaredWorkflowOn({ chase: CHASE }, 'invitation-unredeemed')).toEqual({ name: 'chase', workflow: CHASE });
  });

  it('a run is keyed by the invitation and the event, so a schedule that fires twice starts one run, apart from invitation-sent\'s', () => {
    expect(eventNaturalKey('invitation-unredeemed', CHANNEL, INVITEE, ID)).toBe(`invitation-${ID}`);
    expect(eventRunKey('invitation-unredeemed', `invitation-${ID}`, 'advisor')).not.toBe(eventRunKey('invitation-sent', `invitation-${ID}`, 'advisor'));
  });

  it('its sends email nobody: the invitee has no address the platform holds, and the reminder is a proposal the inviter confirms', () => {
    expect(workflowSendEmailKind('invitation-unredeemed', [INVITER])).toBeUndefined();
  });

  it('an agent step addressed to the invitee is refused, at this event as at invitation-sent', () => {
    const wf = clone(CHASE) as any;
    wf.states['draft-nudge'].agent.to = { people: 'event:person' };
    expect(eventWorkflowErrors('x', wf).join()).toMatch(/names the invitee, who reads nothing in the conversation/);
  });
});

describe('the schedule (ADR-061 decision 1, "a deadline is a one-shot schedule, never a poll")', () => {
  it('is named from the ids it times, deterministically, within the scheduler\'s grammar', () => {
    const name = deadlineScheduleName('invitation-unredeemed', CHANNEL, ID);
    expect(name).toBe(deadlineScheduleName('invitation-unredeemed', CHANNEL, ID));
    expect(name).not.toBe(deadlineScheduleName('invitation-unredeemed', CHANNEL, 'another-id'));
    expect(name).toMatch(/^[0-9a-zA-Z_.-]{1,64}$/);
    // The name carries no id in the clear: a hash of each.
    expect(name).not.toContain('ch-1');
    expect(name).not.toContain(ID);
  });

  it('fires at the declared deadline, brought forward to before the invitation expires, and not at all for one about to lapse', () => {
    expect(deadlineAt(NOW_MS, 60)?.getTime()).toBe(NOW_MS + 3_600_000);
    const expiresAt = NOW_MS / 1000 + 1800;
    expect(deadlineAt(NOW_MS, 60, expiresAt)?.getTime()).toBe((expiresAt - DEADLINE_EXPIRY_MARGIN_SECONDS) * 1000);
    expect(deadlineAt(NOW_MS, 60, NOW_MS / 1000 + DEADLINE_EXPIRY_MARGIN_SECONDS + 30)).toBeUndefined();
    expect(atExpression(new Date(Date.UTC(2027, 0, 15, 9, 5, 7)))).toBe('at(2027-01-15T09:05:07)');
  });

  it('carries ids alone, targets this classification\'s router with its own role, and deletes itself once fired', async () => {
    const send = jest.fn().mockResolvedValue({});
    const at = new Date(NOW_MS + 3_600_000);
    expect(await createDeadlineSchedule(WIRING, { event: 'invitation-unredeemed', channelArn: CHANNEL, invitationId: ID }, at, { send })).toBe('created');
    const input = send.mock.calls[0][0].input;
    expect(input).toMatchObject({
      Name: deadlineScheduleName('invitation-unredeemed', CHANNEL, ID),
      GroupName: WIRING.group,
      ScheduleExpression: atExpression(at),
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      ActionAfterCompletion: 'DELETE',
      Target: { Arn: WIRING.routerArn, RoleArn: WIRING.roleArn },
    });
    expect(JSON.parse(input.Target.Input)).toEqual({ aeDeadline: { event: 'invitation-unredeemed', channelArn: CHANNEL, invitationId: ID } });
  });

  it('a second create of the same deadline (a redelivered invitation-sent) is the same schedule, and a delete of one already gone is not an error', async () => {
    const conflict = Object.assign(new Error('exists'), { name: 'ConflictException' });
    expect(await createDeadlineSchedule(WIRING, { event: 'invitation-unredeemed', channelArn: CHANNEL, invitationId: ID }, new Date(NOW_MS + 60_000_000), { send: jest.fn().mockRejectedValue(conflict) })).toBe('exists');
    const gone = Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' });
    expect(await deleteDeadlineSchedule(WIRING, 'invitation-unredeemed', CHANNEL, ID, { send: jest.fn().mockRejectedValue(gone) })).toBe('absent');
    const send = jest.fn().mockResolvedValue({});
    expect(await deleteDeadlineSchedule(WIRING, 'invitation-unredeemed', CHANNEL, ID, { send })).toBe('deleted');
    expect(send.mock.calls[0][0].input).toEqual({ Name: deadlineScheduleName('invitation-unredeemed', CHANNEL, ID), GroupName: WIRING.group });
  });

  it('a firing and a cancel are read as ids alone, and anything else is refused', () => {
    expect(deadlineFiringOf({ event: 'invitation-unredeemed', channelArn: CHANNEL, invitationId: ID, personArn: INVITEE })).toEqual({ event: 'invitation-unredeemed', channelArn: CHANNEL, invitationId: ID });
    expect(deadlineFiringOf({ event: 'invitation-sent', channelArn: CHANNEL, invitationId: ID })).toBeNull();
    expect(deadlineFiringOf({ event: 'invitation-unredeemed', channelArn: CHANNEL, invitationId: 'not/an#id' })).toBeNull();
    expect(deadlineCancelOf({ channelArn: CHANNEL })).toEqual({ channelArn: CHANNEL });
    expect(deadlineCancelOf({ channelArn: CHANNEL, invitationId: ID })).toEqual({ channelArn: CHANNEL, invitationId: ID });
    expect(deadlineCancelOf({ channelArn: 'nope' })).toBeNull();
  });
});

describe('the router schedules it once, only where a workflow declares the deadline', () => {
  const record = {
    pk: 'invitation#abc', kind: 'invitation', channelArn: CHANNEL, personArn: INVITEE, invitationId: ID, inviterArn: INVITER,
    inviterName: 'Riley', inviteeName: 'Jordan', mode: 'sign-in', classification: 'standard', conversationType: 'general',
    conversationName: 'Plan', expiresAt: NOW_MS / 1000 + 7 * 86_400, issuer: 'deployment', redemption: 'single-use', reclaimAt: 0, createdAt: '',
  } as never;

  it('schedules at the workflow\'s deadline, in this classification\'s group', async () => {
    const create = jest.fn().mockResolvedValue('created');
    expect(await scheduleInvitationDeadline(record, { chase: CHASE }, { wiring: WIRING, create, now: () => NOW_MS })).toBe('scheduled');
    expect(create).toHaveBeenCalledWith(WIRING, { event: 'invitation-unredeemed', channelArn: CHANNEL, invitationId: ID }, new Date(NOW_MS + 4320 * 60_000));
  });

  it('a version that declares no workflow on the deadline gets no schedule, nor does one for another type', async () => {
    const create = jest.fn();
    expect(await scheduleInvitationDeadline(record, {}, { wiring: WIRING, create, now: () => NOW_MS })).toBe('no workflow');
    expect(await scheduleInvitationDeadline(record, { chase: { ...CHASE, types: ['ops'] } as EventWorkflow }, { wiring: WIRING, create, now: () => NOW_MS })).toBe('no workflow');
    expect(create).not.toHaveBeenCalled();
  });

  it('a classification with no schedule group schedules nothing', async () => {
    expect(await scheduleInvitationDeadline(record, { chase: CHASE }, { wiring: null, create: jest.fn(), now: () => NOW_MS })).toBe('not wired');
  });

  it('a create that fails is retried with backoff in the same call, and one that recovers is scheduled with no alarm', async () => {
    const throttled = Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
    const create = jest.fn().mockRejectedValueOnce(throttled).mockRejectedValueOnce(throttled).mockResolvedValueOnce('created');
    const waits: number[] = [];
    const metric = jest.fn();
    expect(await scheduleInvitationDeadline(record, { chase: CHASE }, { wiring: WIRING, create, now: () => NOW_MS, sleep: async (ms) => { waits.push(ms); }, metric })).toBe('scheduled');
    expect(create).toHaveBeenCalledTimes(DEADLINE_CREATE_ATTEMPTS);
    expect(waits).toEqual([DEADLINE_CREATE_BACKOFF_MS, DEADLINE_CREATE_BACKOFF_MS * 4]);
    expect(metric).not.toHaveBeenCalled();
  });

  it('a create that fails every attempt is raised: one metric, for the classification\'s alarm, and never a throw', async () => {
    const create = jest.fn().mockRejectedValue(Object.assign(new Error('no'), { name: 'AccessDeniedException' }));
    const metric = jest.fn();
    expect(await scheduleInvitationDeadline(record, { chase: CHASE }, { wiring: WIRING, create, now: () => NOW_MS, sleep: async () => undefined, metric })).toBe('failed');
    expect(create).toHaveBeenCalledTimes(DEADLINE_CREATE_ATTEMPTS);
    expect(metric).toHaveBeenCalledTimes(1);
  });

  it('the raised failure is an EMF line on the metric the alarm watches, by classification', () => {
    const router = read('router-agent-handler.ts');
    const fn = router.slice(router.indexOf('function deadlineScheduleFailed('), router.indexOf('export async function scheduleInvitationDeadline('));
    expect(fn).toMatch(/namespace: DEADLINE_METRIC_NAMESPACE/);
    expect(fn).toMatch(/dimensionSets: \[\['Classification'\]\]/);
    expect(DEADLINE_METRIC_NAMESPACE).toBe('AgentEchelon/EventDeadlines');
    expect(DEADLINE_SCHEDULE_FAILED_METRIC).toBe('DeadlineScheduleFailed');
  });

  it('handling invitation-sent schedules the deadline after the invitation is verified, whether or not an invitation-sent workflow runs', () => {
    const router = read('router-agent-handler.ts');
    const fn = router.slice(router.indexOf('export async function handleInvitationSent('), router.indexOf('export async function handleDeadlineFired('));
    const order = ['verifyInvitationEvent(channelArn, invitationId, invitationKey)', 'primaryAssistantOf(', 'servedWelcomeVersion(', 'scheduleInvitationDeadline(record', "declaredWorkflowOn(served?.version.eventWorkflows, 'invitation-sent')"].map((t) => fn.indexOf(t));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('on fire, the record decides, before any model call', () => {
  it('a malformed firing runs nothing', async () => {
    expect(await handleDeadlineFired({ event: 'invitation-unredeemed', channelArn: CHANNEL })).toEqual({ ran: false, reason: 'malformed' });
    expect(await handleDeadlineFired({ event: 'person-joined', channelArn: CHANNEL, invitationId: ID })).toEqual({ ran: false, reason: 'malformed' });
  });

  it('checks the classification, the archive, the invitation, the primary, the workflow and the members, in that order, before the run', () => {
    const router = read('router-agent-handler.ts');
    const fn = router.slice(router.indexOf('export async function handleDeadlineFired('), router.indexOf('export async function handleDeadlineCancel('));
    const order = [
      'deadlineFiringOf(raw)', 'readChannelTags(chimeClient, channelArn)', "tags[CLASSIFICATION_TAG] !== STATIC_CLASSIFICATION", "tags.archived === 'true'",
      'verifyInvitationEvent(channelArn, invitationId)', 'primaryAssistantOf(', 'declaredWorkflowOn(served?.version.eventWorkflows, firing.event)',
      'resolveChannelSize(', 'verifiedJoiners([record.inviterArn, record.personArn], roster)', 'runWorkflowFor(',
    ].map((t) => fn.indexOf(t));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Its people are the record's; the firing carries ids alone.
    expect(fn).toMatch(/eventPerson: record\.personArn, invitationId: record\.invitationId, inviter: record\.inviterArn/);
    expect(fn).not.toMatch(/firing\.(personArn|inviter)/);
  });

  it('pendingInvitation is the check: a redeemed, revoked or expired invitation is refused (shared with invitation-sent)', () => {
    expect(read('lib/invitations.ts')).toMatch(/return status === 'pending' \? \{ record \} : \{ refused: status \};/);
  });
});

describe('resolving the thing it times deletes the schedule (ADR-061 decision 1, tenet D15)', () => {
  it('one invitation\'s schedule is deleted by name, in this classification\'s group', async () => {
    const del = jest.fn().mockResolvedValue('deleted');
    expect(await handleDeadlineCancel({ channelArn: CHANNEL, invitationId: ID }, { wiring: WIRING, del })).toEqual({ deleted: 1 });
    expect(del).toHaveBeenCalledWith(WIRING, 'invitation-unredeemed', CHANNEL, ID);
  });

  it('an archived conversation\'s are each of its invitations at this classification, read from the sparse index', async () => {
    const del = jest.fn().mockResolvedValue('deleted');
    const list = jest.fn().mockResolvedValue([
      { invitationId: 'a', classification: 'standard' },
      { invitationId: 'b', classification: 'premium' },
      { invitationId: 'c', classification: 'standard' },
    ]);
    // The router of `standard`, as its stack deploys it: its classification is read once, from its environment.
    const prev = process.env.CLASSIFICATION;
    process.env.CLASSIFICATION = 'standard';
    let cancel!: typeof handleDeadlineCancel;
    jest.isolateModules(() => { cancel = require('../../lambda/src/router-agent-handler').handleDeadlineCancel; });
    try {
      const out = await cancel({ channelArn: CHANNEL }, { wiring: WIRING, del, list });
      expect(list).toHaveBeenCalledWith(CHANNEL);
      // Only this router's classification's invitations: another classification's schedules are another group's.
      expect(del.mock.calls.map((c) => c[3])).toEqual(['a', 'c']);
      expect(out).toEqual({ deleted: 2 });
    } finally {
      if (prev === undefined) delete process.env.CLASSIFICATION; else process.env.CLASSIFICATION = prev;
    }
  });

  it('a malformed cancel or an unwired classification deletes nothing, and a failed delete never throws', async () => {
    expect(await handleDeadlineCancel({ channelArn: 'nope' }, { wiring: WIRING })).toEqual({ deleted: 0, reason: 'malformed' });
    expect(await handleDeadlineCancel({ channelArn: CHANNEL, invitationId: ID }, { wiring: null })).toEqual({ deleted: 0, reason: 'not wired' });
    expect(await handleDeadlineCancel({ channelArn: CHANNEL, invitationId: ID }, { wiring: WIRING, del: jest.fn().mockRejectedValue(new Error('x')) })).toEqual({ deleted: 0 });
  });

  it('revoking and archiving ask the router of the invitation\'s classification, through the invoke those callers already held', () => {
    const invitations = read('invitations.ts');
    const revoke = invitations.slice(invitations.indexOf('export async function revokeRecord('), invitations.indexOf('async function memberScope('));
    expect(revoke).toMatch(/cancelDeadlinesThroughRouter\)\(record\.classification, \{ channelArn: record\.channelArn, invitationId: record\.invitationId \}\)/);
    const management = read('conversation-management.ts');
    expect(management).toMatch(/cancelDeadlinesThroughRouter\(classification, \{ channelArn \}\)/);
  });

  it('a redemption and an offboarding name nothing to a router: the schedule fires, finds no pending invitation, and deletes itself', () => {
    // The credential exchange and offboarding are sensitive principals and hold no router invoke for this.
    expect(read('lib/invitation-redemption.ts')).not.toMatch(/cancelDeadlinesThroughRouter|say-through-router/);
    expect(read('lib/offboarding.ts')).not.toMatch(/cancelDeadlinesThroughRouter|cancelDeadline/);
    // What makes that safe: the check on fire refuses a redeemed or deleted invitation before anything runs.
    expect(read('lib/invitations.ts')).toMatch(/return status === 'pending' \? \{ record \} : \{ refused: status \};/);
  });

  it('that refusal is the expected end of a schedule, logged at info; an unreadable invitation is still a warning', () => {
    const router = read('router-agent-handler.ts');
    const fn = router.slice(router.indexOf('export async function handleDeadlineFired('), router.indexOf('export async function handleDeadlineCancel('));
    expect(fn).toMatch(/\(expected \? console\.info : console\.warn\)\('\[Router\]\[deadline\] the deadline names nothing that still matters; nothing runs'/);
    expect(fn).toMatch(/return refuse\(`the invitation is \$\{invitation\.refused\}`, !invitation\.refused\.startsWith\('unreadable'\)\);/);
    // No comment says a redemption or an offboarding deletes the schedule.
    const cancelDoc = router.slice(router.indexOf('DELETE THE DEADLINE SCHEDULES A RESOLVED THING'), router.indexOf('export async function handleDeadlineCancel('));
    expect(cancelDoc).toMatch(/Redeeming an invitation and offboarding a\s+\* person name nothing here, by decision/);
    const say = read('lib/say-through-router.ts');
    expect(say).not.toMatch(/when it is redeemed, revoked or its people are offboarded/);
    expect(router).not.toMatch(/when it is redeemed, revoked or its people offboarded/);
  });

  it('the cancel is named to the router asynchronously, by ids alone', async () => {
    const say = read('lib/say-through-router.ts');
    const fn = say.slice(say.indexOf('export async function cancelDeadlinesThroughRouter('), say.indexOf('export interface EventContinuation'));
    expect(fn).toMatch(/InvocationType: InvocationType\.Event/);
    expect(fn).toMatch(/aeDeadlineCancel: \{ channelArn: cancel\.channelArn, \.\.\.\(cancel\.invitationId \? \{ invitationId: cancel\.invitationId \} : \{\}\) \}/);
  });

  it('the router routes a firing and a cancel to their handlers, and nothing else reaches them', () => {
    const router = read('router-agent-handler.ts');
    expect(router).toMatch(/aeDeadline\?: unknown \}\)\.aeDeadline\) \{\n\s*try \{\n\s*return \(await handleDeadlineFired\(/);
    expect(router).toMatch(/aeDeadlineCancel\?: unknown \}\)\.aeDeadlineCancel\) \{\n\s*return \(await handleDeadlineCancel\(/);
  });
});
