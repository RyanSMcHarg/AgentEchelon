/**
 * AN ACCOUNT TEAM IS ADDED TO THE MEETING ALONE, MUTED, AND BRIEFED PRIVATELY (SPEC-ASSISTANT-MEETINGS FR42, FR51, FR52).
 *
 * What it proves: a turn proposes people for the running meeting as data (each by the person id the record gives, with
 * the accounts they are for), as an `add_to_meeting` proposal addressed to the person who asked and offered to them
 * alone; only the meeting's host or a moderator may confirm it, at the offer and again at apply (the deny tests); a
 * confirmed proposal asks the creator to add the people to the meeting's own conversation, which never writes the room's
 * membership; a person outside the room's speaking roles joins muted and the on-call does not; and the arrival brief is
 * said once, as a targeted notice to the person who joined alone, naming their accounts.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { joinsMuted, meetingInvitesFromInput, mutingReadsRoomMembership } from '../../lambda/src/lib/meeting-invites';
import { meetingRunsFor, offerMeetingInvites, type MeetingInviteOfferDeps } from '../../lambda/src/lib/meeting-invite-offer';
import { addPeopleToMeeting, briefOnArrival, type MeetingAdditionDeps } from '../../lambda/src/lib/meeting-additions';
import { MEETING_ADDER, proposalRecordOf, type ProposalRecord } from '../../lambda/src/lib/proposals';
import { applyProposal } from '../../lambda/src/proposals-api';
import { tokenKey } from '../../lambda/src/lib/tokens';
import { DEFAULT_NOTICE_COPY, NOTICE_AUDIENCE } from '../../lambda/src/lib/notice-copy';
import { CONVERSATION_TYPES } from '../../lib/config/conversation-types';
import { participantRoleDeclarationErrors } from '../../lib/config/participant-roles';
import type { ChannelContext, MeetingInviteRecord } from '../../lambda/src/lib/channel-context-client';
import { edgeContext } from '../helpers/edge-context';
import { ACCOUNT_TEAM, ACCOUNT_TEAM_GROUP, withAccountTeamPeople } from '../../../demo/stratum-company/account-teams';
import { STRATUM_INLINE_INTENTS } from '../../../demo/stratum-company/intent-packs';
import * as fs from 'fs';
import * as path from 'path';

// The deciders are cleared for premium here; an uncleared caller's refusal is the shared conversation check's.
jest.mock('../../lambda/src/lib/auth', () => ({
  ...jest.requireActual('../../lambda/src/lib/auth'),
  callerHolderToken: () => 'premium',
}));

const APP = process.env.APP_INSTANCE_ARN || 'arn:aws:chime:us-east-1:111122223333:app-instance/test';
const ROOM = `${APP}/channel/ops-room`;
const MEETING = `${APP}/channel/meeting-1`;
const BOT = `${APP}/bot/advisor`;
const ONCALL = 'oncall';
const ENGINEER = 'engineer';
const STRANGER = 'stranger';
const MARIA = `${APP}/user/maria`;
const CHRIS = `${APP}/user/chris`;
const NOW = 1_800_000_000;

const invite = (person: string, name: string, accounts: string[]) => ({
  person, name, accounts, brief: `The US East API is degraded and the team is on it. ${accounts.join(', ')} are affected. Please start drafting customer messaging.`,
});
const INVITES = { invites: [invite(MARIA, 'Maria Santos', ['Meridian Corp', 'Coastal Health Systems']), invite(CHRIS, 'Chris Thompson', ['Urban Retail Group'])] };

/** The ops room and its running meeting, as the context rows hold them: the on-call leads and hosts. */
const rows = (): Record<string, ChannelContext> => ({
  [ROOM]: {
    channelArn: ROOM, conversationType: 'ops',
    participantRoles: { 'on-call:ops': { [ONCALL]: { origin: 'group' } } } as never,
    meetingConversation: { channelArn: MEETING, at: '2026-11-12T00:00:00Z' },
  } as ChannelContext,
  [MEETING]: {
    channelArn: MEETING, conversationType: 'meeting', meetingOf: ROOM,
    activeMeeting: { meetingId: 'm-1', meeting: {}, classification: 'premium', createdAt: '2026-11-12T00:00:00Z', createdBy: ONCALL, startedVia: 'person', hosts: [{ personId: ONCALL, role: 'on-call:ops' }] },
  } as ChannelContext,
});

describe('the types declare who joins muted and that a meeting takes people from outside its room', () => {
  it('an ops room speaks by its roles, and a meeting conversation takes added people', () => {
    expect(CONVERSATION_TYPES.ops.participants?.meetingSpeakers).toEqual(['lead', 'on-call:ops', 'secondary:ops', 'responder']);
    expect(CONVERSATION_TYPES.meeting.meeting).toEqual({ parentMembersJoin: true, addedPeople: true });
    expect(participantRoleDeclarationErrors(CONVERSATION_TYPES as never, { membershipGroups: { ops: 'premium', 'ops-on-call': 'premium', 'ops-secondary': 'premium', 'account-management': 'premium', 'account-team-lead': 'premium' } })).toEqual([]);
  });

  it('refuses a speaking role the type does not declare', () => {
    const types = { x: { driftEnabled: false, participants: { participantRoles: { lead: { from: [{ event: 'forPerson' }] } }, meetingSpeakers: ['nope'] } } };
    expect(participantRoleDeclarationErrors(types as never).join()).toMatch(/meetingSpeakers 'nope' is not one of its participant roles/);
  });
});

describe('who joins muted (FR51)', () => {
  const room = rows()[ROOM];
  it('the on-call and a member of the room speak; a person added to the meeting alone joins muted', () => {
    expect(joinsMuted(room, ONCALL, false)).toBe(false);
    expect(joinsMuted(room, ENGINEER, true)).toBe(false);
    expect(joinsMuted(room, 'maria', false)).toBe(true);
    // The membership is read only where the default role would let them speak.
    expect(mutingReadsRoomMembership(room, ONCALL)).toBe(false);
    expect(mutingReadsRoomMembership(room, 'maria')).toBe(true);
  });

  it('a room whose type names no speakers mutes nobody', () => {
    expect(joinsMuted({ ...room, conversationType: 'general' } as ChannelContext, 'maria', false)).toBe(false);
  });
});

describe('the invites are data, held to what reaches a person not reading the room', () => {
  it('reads each person by their id, merges a person named twice, and refuses a name in place of an id', () => {
    const read = meetingInvitesFromInput({ invites: [...INVITES.invites, invite(MARIA, 'Maria Santos', ['NovaTech Solutions'])] }, APP);
    expect('invites' in read && read.invites.map((i) => [i.person, i.accounts])).toEqual([
      [MARIA, ['Meridian Corp', 'Coastal Health Systems', 'NovaTech Solutions']], [CHRIS, ['Urban Retail Group']],
    ]);
    expect(meetingInvitesFromInput({ invites: [{ ...invite(MARIA, 'Maria', ['A']), person: 'Maria Santos' }] }, APP)).toEqual({ refused: expect.stringMatching(/person's id/) });
    expect(meetingInvitesFromInput({ invites: [{ ...invite(MARIA, 'Maria', ['A']), person: 'arn:aws:chime:us-east-1:123456789012:app-instance/other/user/maria' }] }, APP)).toEqual({ refused: expect.any(String) });
    expect(meetingInvitesFromInput({ invites: [{ ...invite(MARIA, 'Maria', ['A']), brief: 'Join at https://evil.example.com' }] }, APP)).toEqual({ refused: expect.stringMatching(/no link/) });
  });

  it('refuses a proposal whose list the card cannot show whole, so nobody is added whom the card did not name', () => {
    const accounts = Array.from({ length: 10 }, (_, n) => `Northwind Regional Health and Wellness Partners Group ${n}`);
    const brief = 'The US East API is degraded and the team is on it. Please start drafting customer messaging.';
    const people = Array.from({ length: 4 }, (_, n) => ({ ...invite(`${APP}/user/p${n}`, `Person ${n}`, accounts), brief }));
    expect(meetingInvitesFromInput({ invites: people }, APP)).toEqual({ refused: expect.stringMatching(/longer than the card holds \(2000 characters\)/) });
    expect('invites' in meetingInvitesFromInput({ invites: people.slice(0, 1) }, APP)).toBe(true);
  });
});

/** The offer's deps in memory: rows, the written proposal and the posted card. */
function offerWorld(over: Partial<Record<string, ChannelContext>> = {}) {
  const r = { ...rows(), ...over };
  const written: ProposalRecord[] = [];
  const posted: Array<{ content: string; to: string; card: unknown }> = [];
  const cardValues: Array<Parameters<MeetingInviteOfferDeps['cardText']>[0]> = [];
  const deps: MeetingInviteOfferDeps = {
    // The place its router reads (`handleMeetingPlaceRead`), from the rows held here.
    placeOf: (arn) => meetingRunsFor(arn, async (a) => r[a] ?? null),
    writeProposal: async (rec) => { written.push(rec); },
    cardText: async (values) => { cardValues.push(values); return `Add the account teams for these ${values.count} accounts to the call?\n\n${values.teams}`; },
    conversationNameOf: async (arn) => (arn === MEETING ? 'Meeting in Report Latency' : undefined),
    postCard: async (p) => { posted.push(p); },
    // Each person's own account, by ARN: the name the card and the welcome carry.
    nameOf: async (arn) => ({ [MARIA]: 'Maria Santos', [CHRIS]: 'Chris Thompson' } as Record<string, string>)[arn],
    now: () => NOW * 1000,
  };
  return { deps, written, posted, cardValues };
}
const turn = (personId: string, channelArn = ROOM) => ({
  channelArn, requesterArn: `${APP}/user/${personId}`, botArn: BOT, classification: 'premium', appInstanceArn: APP, correlationId: 'msg-1',
});

describe('the offer (the turn proposes, and executes nothing)', () => {
  it('the host is offered an add_to_meeting proposal carrying the accounts as data, privately', async () => {
    const w = offerWorld();
    const out = await offerMeetingInvites(INVITES, turn(ONCALL), w.deps);
    expect(out).toMatchObject({ offered: true, people: 2, accounts: 3 });
    expect(w.written).toHaveLength(1);
    expect(w.written[0]).toMatchObject({
      op: 'add_to_meeting', addressedAs: MEETING_ADDER, channelArn: ROOM, personArn: `${APP}/user/${ONCALL}`,
      meetingChannelArn: MEETING, briefBy: BOT, classification: 'premium',
    });
    expect(w.written[0].invites!.map((i) => [i.person, i.accounts])).toEqual([[MARIA, ['Meridian Corp', 'Coastal Health Systems']], [CHRIS, ['Urban Retail Group']]]);
    // The card goes to the person who asked alone, carrying the proposal's handle and nothing else of its record.
    expect(w.posted).toHaveLength(1);
    expect(w.posted[0].to).toBe(`${APP}/user/${ONCALL}`);
    expect(w.posted[0].card).toMatchObject({ op: 'add_to_meeting' });
    expect(w.posted[0].content).toMatch(/these 3 accounts/);
  });

  it('names each person by their own account, never by the name the model paired with their id', async () => {
    const w = offerWorld();
    const swapped = { invites: [invite(MARIA, 'Chris Thompson', ['Meridian Corp'])] };
    const out = await offerMeetingInvites(swapped, turn(ONCALL), w.deps);
    expect(out).toMatchObject({ offered: true, names: ['Maria Santos'] });
    expect(w.written[0].invites).toEqual([expect.objectContaining({ person: MARIA, name: 'Maria Santos' })]);
    expect(w.posted[0].content).toMatch(/Maria Santos: Meridian Corp/);
    expect(w.posted[0].content).not.toMatch(/Chris Thompson/);
  });

  it('DENY: a person whose account cannot be read refuses the proposal, and nothing is recorded or posted', async () => {
    const w = offerWorld();
    const out = await offerMeetingInvites({ invites: [invite(`${APP}/user/nobody`, 'Maria Santos', ['Meridian Corp'])] }, turn(ONCALL), w.deps);
    expect(out.error).toMatch(/^invites.0..person names no person/);
    expect(w.written).toEqual([]);
    expect(w.posted).toEqual([]);
  });

  it('DENY: a member who neither hosts nor moderates is refused, and nothing is recorded or posted', async () => {
    const w = offerWorld();
    const out = await offerMeetingInvites(INVITES, turn(ENGINEER), w.deps);
    expect(out.error).toMatch(/host or a moderator/);
    expect(w.written).toEqual([]);
    expect(w.posted).toEqual([]);
  });

  it('a card asked from the room names the call it is for, by its conversation\'s name and its meeting\'s id', async () => {
    const w = offerWorld({ [MEETING]: { ...rows()[MEETING], activeMeeting: { ...rows()[MEETING].activeMeeting!, meetingId: '5ca1ab1e-0000-4000-8000-000000000001' } } as ChannelContext });
    await offerMeetingInvites(INVITES, turn(ONCALL), w.deps);
    expect(w.cardValues[0]).toMatchObject({ meetingName: 'Meeting in Report Latency', meetingId: '5ca1ab1e' });
  });

  it("a card asked in the meeting's own chat names no call, because it is the one they are in", async () => {
    const w = offerWorld();
    expect(await offerMeetingInvites(INVITES, turn(ONCALL, MEETING), w.deps)).toMatchObject({ offered: true });
    expect(w.cardValues[0].meetingName).toBeUndefined();
    expect(w.cardValues[0].meetingId).toBeUndefined();
  });

  it("a card whose call's name cannot be read still names it by its meeting's id", async () => {
    const w = offerWorld();
    w.deps.conversationNameOf = async () => { throw Object.assign(new Error('x'), { name: 'ThrottledClientException' }); };
    await offerMeetingInvites(INVITES, turn(ONCALL), w.deps);
    expect(w.cardValues[0]).toMatchObject({ meetingId: 'm-1' });
    expect(w.cardValues[0].meetingName).toBeUndefined();
  });

  it('the holder of a room role that confers moderation may ask, and no meeting running offers nothing', async () => {
    const lead = offerWorld({ [ROOM]: { ...rows()[ROOM], participantRoles: { lead: { [ENGINEER]: { origin: 'event' } } } } as never });
    expect(await offerMeetingInvites(INVITES, turn(ENGINEER), lead.deps)).toMatchObject({ offered: true });
    const ended = offerWorld({ [MEETING]: { ...rows()[MEETING], activeMeeting: undefined } as ChannelContext });
    expect((await offerMeetingInvites(INVITES, turn(ONCALL), ended.deps)).error).toMatch(/no meeting/);
    expect(ended.written).toEqual([]);
  });
});

/** The apply endpoint's world: the proposal, the two rows, live moderators and the creator it asks. */
function applyWorld(record: ProposalRecord, opts: { moderators?: string[]; members?: string[]; meetingRow?: Partial<ChannelContext> } = {}) {
  const items = new Map<string, Record<string, any>>([[String(record.pk), { ...record }]]);
  const r = rows();
  if (opts.meetingRow) r[MEETING] = { ...r[MEETING], ...opts.meetingRow } as ChannelContext;
  const invoked: any[] = [];
  const doc = {
    send: async (cmd: any) => {
      const name = cmd.constructor.name;
      if (name === 'GetCommand' && cmd.input.TableName === 'Context') return { Item: r[cmd.input.Key.channelArn] };
      if (name === 'GetCommand') return { Item: items.get(cmd.input.Key.pk) };
      const item = items.get(cmd.input.Key.pk)!;
      const v = cmd.input.ExpressionAttributeValues;
      if (String(cmd.input.ConditionExpression).includes(':applying')) { item.decision = v[':d'] ?? undefined; return {}; }
      if (item.consumedAt !== undefined) throw Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
      item.consumedAt = v[':now'];
      for (const [k, field] of Object.entries(cmd.input.ExpressionAttributeNames ?? {})) if (k.startsWith('#x')) item[field as string] = v[`:x${k.slice(2)}`];
      return { Attributes: item };
    },
  };
  const messaging = {
    send: async (cmd: any) => {
      const name = cmd.constructor.name;
      if (name === 'DescribeChannelMembershipCommand') {
        if (!(opts.members ?? [`${APP}/user/${ONCALL}`, `${APP}/user/${ENGINEER}`]).includes(cmd.input.MemberArn)) throw Object.assign(new Error('no'), { name: 'NotFoundException' });
        return { ChannelMembership: {} };
      }
      if (name === 'DescribeChannelModeratorCommand') {
        if (cmd.input.ChimeBearer !== cmd.input.ChannelModeratorArn || !(opts.moderators ?? []).includes(cmd.input.ChannelModeratorArn)) throw Object.assign(new Error('no'), { name: 'NotFoundException' });
        return { ChannelModerator: {} };
      }
      return { Tags: [{ Key: 'classification', Value: 'premium' }] };
    },
  };
  const lambda = { send: async (cmd: any) => { invoked.push({ fn: cmd.input.FunctionName, payload: JSON.parse(Buffer.from(cmd.input.Payload).toString()) }); return { Payload: Buffer.from(JSON.stringify({ ok: true, channelArn: MEETING, added: 2 })) }; } };
  const deps = { doc, messaging, lambda, tokensTable: 'Tokens', contextTable: 'Context', appInstanceArn: APP, creatorOf: (c: string) => `Prefix-${c}-TypedCreator`, now: () => NOW * 1000 };
  return { deps, items, invoked };
}
const event = (personId: string, body: unknown): APIGatewayProxyEvent => ({
  httpMethod: 'POST', path: '/proposals/apply', headers: {}, body: JSON.stringify(body),
  requestContext: { authorizer: edgeContext({ claims: { sub: `subject-of-${personId}`, token_use: 'id' }, personId }) },
}) as unknown as APIGatewayProxyEvent;
const proposalFor = (personId: string) => proposalRecordOf({
  channelArn: ROOM, addresseeArn: `${APP}/user/${personId}`, now: NOW, token: 'handle-m',
  fields: {
    op: 'add_to_meeting', classification: 'premium', addressedAs: MEETING_ADDER, workflow: 'request', step: 'propose_meeting_invites', runKey: 'msg-1',
    draft: '- Maria Santos: Meridian Corp', meetingChannelArn: MEETING, invites: (meetingInvitesFromInput(INVITES, APP) as { invites: never[] }).invites, briefBy: BOT,
  },
}).record;

describe('the apply endpoint performs it for the host or a moderator alone', () => {
  it('the host confirms: the creator is asked to add the people to the meeting\'s conversation, never the room', async () => {
    const w = applyWorld(proposalFor(ONCALL));
    const out = await applyProposal(event(ONCALL, { proposal: 'handle-m', decision: 'apply' }), w.deps);
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body)).toMatchObject({ applied: true, op: 'add_to_meeting', channelArn: MEETING, added: 2 });
    expect(w.invoked).toHaveLength(1);
    expect(w.invoked[0]).toMatchObject({ fn: 'Prefix-premium-TypedCreator', payload: { aeMeeting: 'add', meetingChannelArn: MEETING, parentChannelArn: ROOM, invitedBy: `${APP}/user/${ONCALL}`, briefBy: BOT } });
    expect(w.invoked[0].payload.invites.map((i: { person: string }) => i.person)).toEqual([MARIA, CHRIS]);
    expect(w.items.get(tokenKey('proposal', 'handle-m'))).toMatchObject({ decision: 'applied' });
  });

  it('DENY: an addressee who no longer hosts or moderates is refused, the creator is not asked and the proposal stays undecided', async () => {
    const w = applyWorld(proposalFor(ENGINEER));
    const out = await applyProposal(event(ENGINEER, { proposal: 'handle-m', decision: 'apply' }), w.deps);
    expect(out.statusCode).toBe(403);
    expect(JSON.parse(out.body).code).toBe('NOT_HOST_OR_MODERATOR');
    expect(w.invoked).toEqual([]);
    expect(w.items.get(tokenKey('proposal', 'handle-m'))!.consumedAt).toBeUndefined();
  });

  it('a live moderator of the room may confirm, and a meeting that ended adds nobody', async () => {
    const mod = applyWorld(proposalFor(ENGINEER), { moderators: [`${APP}/user/${ENGINEER}`] });
    expect((await applyProposal(event(ENGINEER, { proposal: 'handle-m', decision: 'apply' }), mod.deps)).statusCode).toBe(200);
    const ended = applyWorld(proposalFor(ONCALL), { meetingRow: { activeMeeting: undefined } });
    expect(JSON.parse((await applyProposal(event(ONCALL, { proposal: 'handle-m', decision: 'apply' }), ended.deps)).body).code).toBe('NO_ACTIVE_MEETING');
    expect(ended.invoked).toEqual([]);
  });

  it('DENY: another member cannot confirm a proposal addressed to the host', async () => {
    const w = applyWorld(proposalFor(ONCALL), { moderators: [`${APP}/user/${ENGINEER}`] });
    const out = await applyProposal(event(ENGINEER, { proposal: 'handle-m', decision: 'apply' }), w.deps);
    expect(JSON.parse(out.body).code).toBe('NOT_ADDRESSEE');
    expect(w.invoked).toEqual([]);
  });
});

/** The creator's deps in memory: who was added where, what was recorded, and what was said to whom. */
function creatorWorld(opts: { cleared?: string[]; assistants?: string[]; meetingRow?: Partial<ChannelContext> } = {}) {
  const r = rows();
  if (opts.meetingRow) r[MEETING] = { ...r[MEETING], ...opts.meetingRow } as ChannelContext;
  const added: Array<{ channelArn: string; inviteeArn: string }> = [];
  const said: any[] = [];
  const invites: Record<string, MeetingInviteRecord> = {};
  const deps: MeetingAdditionDeps = {
    appInstanceArn: APP, classification: 'premium',
    closedCode: async () => undefined,
    readRow: async (arn) => r[arn] ?? null,
    serviceAdmin: async () => `${APP}/user/service-admin`,
    addMember: async ({ channelArn, inviteeArn }) => { added.push({ channelArn, inviteeArn }); },
    admits: async (arn) => (opts.cleared ?? [MARIA, CHRIS]).includes(arn),
    isAssistantHere: async (arn) => (opts.assistants ?? [BOT]).includes(arn),
    recordInvites: async (_m, rec) => { Object.assign(invites, rec); return true; },
    claimBrief: async (_m, id) => { const i = invites[id]; if (!i || i.briefedAt) return null; i.briefedAt = 'now'; return i; },
    say: async (_c, notice) => { said.push(notice); return { posted: true }; },
    meetingNameOf: async () => 'API latency in US East: meeting',
    now: () => new Date(NOW * 1000),
  };
  return { deps, added, said, invites };
}
const addRequest = () => ({
  aeMeeting: 'add' as const, meetingChannelArn: MEETING, parentChannelArn: ROOM,
  invites: (meetingInvitesFromInput(INVITES, APP) as { invites: never[] }).invites, invitedBy: `${APP}/user/${ONCALL}`, briefBy: BOT,
});

describe('the creator adds them to the meeting alone, and briefs each privately when they join', () => {
  it('adds each cleared person and the briefing assistant to the meeting\'s conversation, and never the room', async () => {
    const w = creatorWorld();
    const out = await addPeopleToMeeting(addRequest(), w.deps);
    expect(out).toEqual({ ok: true, channelArn: MEETING, added: 2, notAdmitted: 0 });
    expect(w.added.every((a) => a.channelArn === MEETING)).toBe(true);
    expect(w.added.map((a) => a.inviteeArn)).toEqual([BOT, MARIA, CHRIS]);
    expect(w.added.some((a) => a.channelArn === ROOM)).toBe(false);
    expect(w.invites.maria).toMatchObject({ accounts: ['Meridian Corp', 'Coastal Health Systems'], briefBy: BOT, invitedBy: `${APP}/user/${ONCALL}` });
    // Each is told privately that they were added, by the assistant that proposed it.
    expect(w.said.map((n) => [n.kind, n.to, n.botArn, n.channelArn])).toEqual([
      ['memberWelcome', [MARIA], BOT, MEETING], ['memberWelcome', [CHRIS], BOT, MEETING],
    ]);
  });

  it('DENY: a person whose clearance does not reach the meeting is left out, and none cleared adds nobody', async () => {
    const some = creatorWorld({ cleared: [MARIA] });
    expect(await addPeopleToMeeting(addRequest(), some.deps)).toMatchObject({ ok: true, added: 1, notAdmitted: 1 });
    expect(some.added.map((a) => a.inviteeArn)).not.toContain(CHRIS);
    const none = creatorWorld({ cleared: [] });
    expect(await addPeopleToMeeting(addRequest(), none.deps)).toEqual({ ok: false, code: 'NOT_CLEARED' });
    expect(none.added).toEqual([]);
  });

  it('DENY: adds nobody when the person who confirmed neither hosts the meeting nor holds a moderating role, whatever the apply endpoint decided', async () => {
    const w = creatorWorld();
    expect(await addPeopleToMeeting({ ...addRequest(), invitedBy: `${APP}/user/${ENGINEER}` }, w.deps)).toEqual({ ok: false, code: 'NOT_HOST_OR_MODERATOR' });
    expect(w.added).toEqual([]);
  });

  it('DENY: adds nobody when the briefing assistant is not one of this classification\'s', async () => {
    const w = creatorWorld({ assistants: [] });
    expect(await addPeopleToMeeting(addRequest(), w.deps)).toEqual({ ok: false, code: 'NOT_THIS_CLASSIFICATION' });
    expect(w.added).toEqual([]);
  });

  it('adds nobody to a meeting that is not its room\'s, or that ended', async () => {
    expect(await addPeopleToMeeting(addRequest(), creatorWorld({ meetingRow: { meetingOf: `${APP}/channel/elsewhere` } }).deps)).toEqual({ ok: false, code: 'NOT_THE_ROOMS_MEETING' });
    expect(await addPeopleToMeeting(addRequest(), creatorWorld({ meetingRow: { activeMeeting: undefined } }).deps)).toEqual({ ok: false, code: 'NO_ACTIVE_MEETING' });
  });

  it('the arrival brief is said once, to the person who joined alone, naming their accounts', async () => {
    const w = creatorWorld();
    await addPeopleToMeeting(addRequest(), w.deps);
    w.said.length = 0;
    expect(await briefOnArrival({ aeMeeting: 'arrived', meetingChannelArn: MEETING, personArn: MARIA }, w.deps)).toEqual({ ok: true, said: true });
    expect(w.said).toEqual([{
      kind: 'meetingArrivalBrief', channelArn: MEETING, botArn: BOT, to: [MARIA],
      vars: { brief: expect.stringMatching(/drafting customer messaging/), accounts: 'Meridian Corp, Coastal Health Systems' },
    }]);
    // Once: a second join says nothing, and a person nobody invited is told nothing.
    expect(await briefOnArrival({ aeMeeting: 'arrived', meetingChannelArn: MEETING, personArn: MARIA }, w.deps)).toEqual({ ok: true, said: false });
    expect(await briefOnArrival({ aeMeeting: 'arrived', meetingChannelArn: MEETING, personArn: `${APP}/user/${ONCALL}` }, w.deps)).toEqual({ ok: true, said: false });
    expect(w.said).toHaveLength(1);
  });

  it('the arrival brief is a notice addressed to one person, which the router sends targeted to them alone', () => {
    expect(NOTICE_AUDIENCE.meetingArrivalBrief).toBe('addressed');
    expect(DEFAULT_NOTICE_COPY.meetingArrivalBrief).toContain('{accounts}');
  });
});

describe('the demo record names each account\'s team by person', () => {
  it('each CSM in the record is an account team person, and the upload writes their person id beside the key', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'demo', 'stratum-company', 'context', 'premium', 'customer-accounts.json'), 'utf8');
    const accounts = (JSON.parse(raw) as { topAccountsByARR: Array<{ csm: string; csmKey: string; region: string }> }).topAccountsByARR;
    const team = new Map(ACCOUNT_TEAM.map((p) => [p.key, p.name]));
    for (const a of accounts) expect(team.get(a.csmKey)).toBe(a.csm);
    const uploaded = JSON.parse(withAccountTeamPeople(raw, { 'maria-santos': MARIA })) as { topAccountsByARR: Array<{ csmKey: string; csmPerson?: string }> };
    for (const a of uploaded.topAccountsByARR) expect(a.csmPerson).toBe(a.csmKey === 'maria-santos' ? MARIA : undefined);
    expect(ACCOUNT_TEAM_GROUP).toBe('account-management');
    expect(accounts.filter((a) => a.region === 'US East').map((a) => a.csmKey).sort()).toEqual(['chris-thompson', 'maria-santos', 'maria-santos', 'maria-santos']);
  });

  it('premium declares the region intent with the record and the proposal tool', () => {
    const intent = STRATUM_INLINE_INTENTS.premium.find((i) => i.key === 'impacted_accounts');
    expect(intent?.tools).toEqual(['load_company_context', 'propose_meeting_invites']);
    expect(intent?.delivery).toBe('PLACEHOLDER_UPDATE');
  });
});
