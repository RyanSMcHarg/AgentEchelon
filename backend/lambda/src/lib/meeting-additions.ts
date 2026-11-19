/**
 * THE CREATOR'S HALF OF ADDING PEOPLE TO A MEETING (SPEC-ASSISTANT-MEETINGS FR42, FR52): what the typed-conversation
 * creator of a classification does when the apply endpoint performs a confirmed `add_to_meeting` proposal
 * (`aeMeeting: 'add'`), and when a person it added first joins (`aeMeeting: 'arrived'`). The creator holds the membership
 * grant; the rules are here, with every read and write it makes passed in, so they are tested without a service.
 *
 * ADD. Only into a meeting's own conversation that still names the room it was started from, while that room still names
 * it as its meeting's, while its meeting runs, where the meeting's settings take people from outside its room
 * (`addedPeople`), and neither conversation archived or at another classification. Each person is admitted against the
 * meeting's classification as any membership is (their clearance must reach it); a person it does not reach is left out
 * and counted. The person who confirmed must host the meeting or hold a room role that confers moderation, and the
 * assistant that proposed it must be one of this classification's, checked here as well as by the apply endpoint. The
 * assistant that proposed it joins the meeting's conversation too, so it can say each brief there. The
 * ROOM'S MEMBERSHIP IS NEVER WRITTEN. Each person added is recorded on the meeting's row (`meetingInvites`) and told
 * privately, and by email, that they were added (the `memberWelcome` notice), by the assistant that proposed it.
 *
 * ARRIVED. The person's arrival brief (`meetingArrivalBrief`): said once, privately in the meeting's chat, to that person
 * alone (a targeted message, ADR-036), by the assistant the invitation names, in its own words from its own templates.
 * The claim on the row makes it once, however often they join.
 */
import { meetingSettingsOf } from '../../../lib/config/conversation-types';
import type { ChannelContext, MeetingInviteRecord } from './channel-context-client.js';
import type { NoticeOutcome, NoticeRequest } from './assistant-notice.js';
import { conversationChannelArn } from './conversation-access.js';
import { botArnFor, botIdFromArn, isPersonOf, personIdFromArn } from './person-arn.js';
import { holdsModeratingRole, mayAddPeople, storedInvites, type MeetingInvite } from './meeting-invites.js';

export interface MeetingAddRequest {
  aeMeeting: 'add';
  meetingChannelArn: string;
  parentChannelArn: string;
  invites: MeetingInvite[];
  /** Who confirmed the proposal, as their AppInstanceUser ARN. */
  invitedBy: string;
  /** The assistant that proposed it and says each brief, as its AppInstanceBot ARN. */
  briefBy: string;
}
export interface MeetingArrivalRequest { aeMeeting: 'arrived'; meetingChannelArn: string; personArn: string }

export type MeetingAddAnswer = { ok: true; channelArn: string; added: number; notAdmitted: number } | { ok: false; code: string };
export type MeetingArrivalAnswer = { ok: true; said: boolean } | { ok: false; code: string };

export interface MeetingAdditionDeps {
  appInstanceArn: string;
  classification: string;
  /** Why the creator does not act in a conversation (archived, another classification), or undefined. */
  closedCode: (channelArn: string) => Promise<string | undefined>;
  readRow: (channelArn: string) => Promise<ChannelContext | null>;
  /** The service admin's bearer, which holds the membership grant. */
  serviceAdmin: () => Promise<string>;
  addMember: (input: { channelArn: string; inviteeArn: string; bearerArn: string }) => Promise<void>;
  /** Whether a person's clearance reaches the classification. */
  admits: (personArn: string) => Promise<boolean>;
  /** Whether a bot is a live assistant of this classification; a read that fails throws. */
  isAssistantHere: (botArn: string) => Promise<boolean>;
  recordInvites: (meetingArn: string, invites: Record<string, MeetingInviteRecord>) => Promise<boolean>;
  claimBrief: (meetingArn: string, personId: string) => Promise<MeetingInviteRecord | null>;
  say: (classification: string, notice: NoticeRequest) => Promise<NoticeOutcome>;
  /** The meeting conversation's name, which the welcome names; undefined where it cannot be read. */
  meetingNameOf?: (channelArn: string) => Promise<string | undefined>;
  now?: () => Date;
}

const isBotOf = (arn: unknown, appInstanceArn: string): arn is string => {
  if (typeof arn !== 'string' || arn.length > 1600) return false;
  const botId = botIdFromArn(arn);
  return !!botId && /^[A-Za-z0-9-]+$/.test(botId) && arn === botArnFor(appInstanceArn, botId);
};

/** Add the people a confirmed proposal names to the meeting's own conversation, and nowhere else. */
export async function addPeopleToMeeting(req: MeetingAddRequest, deps: MeetingAdditionDeps): Promise<MeetingAddAnswer> {
  const meetingArn = conversationChannelArn(req.meetingChannelArn, deps.appInstanceArn) ?? '';
  const roomArn = conversationChannelArn(req.parentChannelArn, deps.appInstanceArn) ?? '';
  const invites = storedInvites(req.invites, deps.appInstanceArn);
  if (!meetingArn || !roomArn || meetingArn === roomArn || !invites.length || !isPersonOf(req.invitedBy, deps.appInstanceArn) || !isBotOf(req.briefBy, deps.appInstanceArn)) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  for (const arn of [meetingArn, roomArn]) {
    const closed = await deps.closedCode(arn);
    if (closed) return { ok: false, code: closed };
  }
  const meetingRow = await deps.readRow(meetingArn);
  if (!meetingSettingsOf(meetingRow?.conversationType)) return { ok: false, code: 'NOT_A_MEETING' };
  if (meetingRow?.meetingOf !== roomArn) return { ok: false, code: 'NOT_THE_ROOMS_MEETING' };
  if (meetingSettingsOf(meetingRow?.conversationType)?.addedPeople !== true) return { ok: false, code: 'NOT_PERMITTED' };
  if (!meetingRow?.activeMeeting?.meetingId) return { ok: false, code: 'NO_ACTIVE_MEETING' };
  const roomRow = await deps.readRow(roomArn);
  if (roomRow?.meetingConversation?.channelArn !== meetingArn) return { ok: false, code: 'NOT_THE_ROOMS_MEETING' };
  // THE SECOND LAYER BEHIND THE APPLY ENDPOINT (tenet D3): the person who confirmed hosts the meeting or holds a room role
  // that confers moderation, by the rule the offer applies, read here from the server-side rows.
  const confirmer = personIdFromArn(req.invitedBy) ?? '';
  if (!(await mayAddPeople(meetingRow.activeMeeting, confirmer, async () => holdsModeratingRole(roomRow, confirmer)))) {
    return { ok: false, code: 'NOT_HOST_OR_MODERATOR' };
  }
  // THE ASSISTANT THAT SAYS EACH BRIEF IS ONE OF THIS CLASSIFICATION'S, so no other classification's assistant is added here.
  if (!(await deps.isAssistantHere(req.briefBy))) return { ok: false, code: 'NOT_THIS_CLASSIFICATION' };

  const admitted: MeetingInvite[] = [];
  for (const invite of invites) if (await deps.admits(invite.person).catch(() => false)) admitted.push(invite);
  const notAdmitted = invites.length - admitted.length;
  if (!admitted.length) return { ok: false, code: 'NOT_CLEARED' };

  const bearerArn = await deps.serviceAdmin();
  // THE ASSISTANT THAT SAYS EACH BRIEF is in the meeting's conversation, so it can say it there.
  await deps.addMember({ channelArn: meetingArn, inviteeArn: req.briefBy, bearerArn });
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const records: Record<string, MeetingInviteRecord> = {};
  for (const invite of admitted) {
    await deps.addMember({ channelArn: meetingArn, inviteeArn: invite.person, bearerArn });
    records[personIdFromArn(invite.person) as string] = { accounts: invite.accounts, brief: invite.brief, briefBy: req.briefBy, invitedBy: req.invitedBy, at };
  }
  if (!(await deps.recordInvites(meetingArn, records))) {
    console.warn('[meeting-additions] the people were added and their invitations could not be recorded; no brief is said to them');
  }
  // EACH PERSON IS TOLD THEY WERE ADDED, privately and by email, as the assistant that proposed it.
  const name = (await deps.meetingNameOf?.(meetingArn).catch(() => undefined)) || '';
  for (const invite of admitted) {
    await deps.say(deps.classification, {
      kind: 'memberWelcome', channelArn: meetingArn, botArn: req.briefBy, to: [invite.person],
      vars: { name: invite.name, ...(name ? { recap: name, notifySubject: name } : {}), notifyPerson: invite.person },
    }).catch(() => ({ posted: false }));
  }
  console.log('[meeting-additions] people added to a meeting\'s conversation alone', { added: admitted.length, notAdmitted });
  return { ok: true, channelArn: meetingArn, added: admitted.length, notAdmitted };
}

/** Say a person's arrival brief, once, privately in the meeting's chat, as the assistant their invitation names. */
export async function briefOnArrival(req: MeetingArrivalRequest, deps: MeetingAdditionDeps): Promise<MeetingArrivalAnswer> {
  const meetingArn = conversationChannelArn(req.meetingChannelArn, deps.appInstanceArn) ?? '';
  if (!meetingArn || !isPersonOf(req.personArn, deps.appInstanceArn)) return { ok: false, code: 'INVALID_REQUEST' };
  const closed = await deps.closedCode(meetingArn);
  if (closed) return { ok: false, code: closed };
  const invite = await deps.claimBrief(meetingArn, personIdFromArn(req.personArn) as string);
  if (!invite || !isBotOf(invite.briefBy, deps.appInstanceArn)) return { ok: true, said: false };
  const said = await deps.say(deps.classification, {
    kind: 'meetingArrivalBrief', channelArn: meetingArn, botArn: invite.briefBy, to: [req.personArn],
    vars: { brief: invite.brief, accounts: invite.accounts.join(', ') },
  }).catch((): NoticeOutcome => ({ posted: false, reason: 'invoke-failed' }));
  return { ok: true, said: said.posted };
}
