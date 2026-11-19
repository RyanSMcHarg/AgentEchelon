/**
 * THE TURN'S HALF OF ADDING PEOPLE TO A MEETING (SPEC-ASSISTANT-MEETINGS FR42, ADR-061 decision 8): the
 * `propose_meeting_invites` tool. The model names the people a record gives for the work at hand (an account's team),
 * each by the person id the record carries, with the accounts they are for and the brief they are told when they join.
 * The tool EXECUTES NOTHING: it records an `add_to_meeting` proposal addressed to the person who asked and posts them
 * its confirmation card, privately (a targeted message, ADR-036). The apply endpoint performs it once they confirm.
 *
 * It is offered only on a turn in a conversation whose meeting is running (`meetingRunsFor`), and it refuses, by reason,
 * a person who is neither the meeting's host nor the holder of a room role that confers moderation (read from the room's
 * server-side row), so the model can say so. The rows are read by the turn's own router, which answers only for a
 * conversation of its own classification (`handleMeetingPlaceRead`); the assistant's session reads no conversation's row. The apply endpoint decides again, live, by the host and Amazon Chime SDK's
 * own moderators, before anything is added. Every read and write is passed in, so the rules are tested without a service.
 */
import type { ChannelContext } from './channel-context-client.js';
import { MEETING_ADDER, proposalDraft, proposalDraftRefusal, proposalRecordOf, type ProposalCard, type ProposalRecord } from './proposals.js';
import { wellFormedPrefix } from './meeting-event-shape.js';
import { MAX_INVITE_LABEL, holdsModeratingRole, inviteLines, mayAddPeople, meetingAdmitsAddedPeople, meetingInvitesFromInput, meetingPlaceOf, type MeetingInvite } from './meeting-invites.js';
import { appInstanceArnOf, personIdFromArn } from './person-arn.js';
import { DescribeAppInstanceUserCommand } from '@aws-sdk/client-chime-sdk-identity';
import { chimeIdentityClient } from './chime/clients.js';

/** The tool's name, as the loop offers it and a pack's intent names it. */
export const MEETING_INVITES_TOOL = 'propose_meeting_invites';

export interface MeetingInviteTurn {
  channelArn: string;
  /** The person whose message the turn answers: the proposal's addressee. */
  requesterArn: string;
  /** The answering assistant's bot, which posts the card and later says each brief. */
  botArn: string;
  classification: string;
  appInstanceArn: string;
  /** The request's message id, which keys the proposal's run. */
  correlationId: string;
}

/** The meeting a conversation's turn may propose people for, and the rows that say so. */
export interface MeetingPlace { meetingArn: string; roomArn: string; meetingRow: ChannelContext; roomRow: ChannelContext | null }

/** The attributes of a conversation's context row a meeting place carries: which room or meeting it is, its meeting, and its role holdings. */
export const MEETING_PLACE_ATTRIBUTES = ['channelArn', 'conversationType', 'participantRoles', 'meetingOf', 'meetingConversation', 'activeMeeting'] as const;

/** A row with the meeting place's attributes alone. */
export function meetingPlaceFields(row: ChannelContext | null): ChannelContext | null {
  if (!row) return null;
  const out: Partial<ChannelContext> = {};
  for (const k of MEETING_PLACE_ATTRIBUTES) if (row[k] !== undefined) (out as Record<string, unknown>)[k] = row[k];
  return out as ChannelContext;
}

export interface MeetingInviteOfferDeps {
  /** The conversation's meeting place, as its classification's router read it; undefined where none runs. */
  placeOf: (channelArn: string) => Promise<MeetingPlace | undefined>;
  writeProposal: (record: ProposalRecord) => Promise<void>;
  /** The card's words, from the assistant's `add-to-meeting-proposal` template. */
  cardText: (values: { count: number; teams: string; meetingName?: string; meetingId?: string }) => Promise<string>;
  /** A meeting conversation's name as people read it; undefined where it cannot be read. */
  conversationNameOf?: (channelArn: string) => Promise<string | undefined>;
  postCard: (args: { content: string; to: string; card: ProposalCard }) => Promise<void>;
  /** The name a person's AppInstanceUser carries, by their ARN; undefined where there is no such person. */
  nameOf?: (personArn: string) => Promise<string | undefined>;
  now?: () => number;
}

let identity: Pick<ReturnType<typeof chimeIdentityClient>, 'send'> | undefined;
/** The name Amazon Chime SDK holds for a person, read by their AppInstanceUser ARN. */
async function appInstanceUserName(personArn: string): Promise<string | undefined> {
  identity ??= chimeIdentityClient({});
  const out = await identity.send(new DescribeAppInstanceUserCommand({ AppInstanceUserArn: personArn }));
  return out.AppInstanceUser?.Name?.trim() || undefined;
}

/**
 * EACH PERSON IS NAMED BY THEIR OWN ACCOUNT, never by the name the model paired with their id: the card the confirmer
 * reads, and the welcome the person is sent, carry the name the person's AppInstanceUser holds, so what is confirmed is
 * who is added. A person whose account cannot be read refuses the proposal, by position, so the model can correct it.
 */
async function namedByAccount(
  invites: MeetingInvite[], nameOf: (personArn: string) => Promise<string | undefined>,
): Promise<{ invites: MeetingInvite[] } | { refused: string }> {
  const names = await Promise.all(invites.map((i) => nameOf(i.person).catch(() => undefined)));
  const missing = names.findIndex((n) => !n);
  if (missing >= 0) return { refused: `invites[${missing}].person names no person of this deployment that could be read; use the person id the record gives` };
  const named = invites.map((i, n) => ({ ...i, name: cardNameOf(names[n] as string, i.name) }));
  // The proposal as it will be applied, read by the rule its apply reads it by, so the card shows only what is applied.
  const applied = meetingInvitesFromInput({ invites: named }, appInstanceArnOf(named[0]?.person ?? '') ?? '');
  return 'invites' in applied ? { invites: named } : applied;
}

/**
 * THE NAME A CARD SHOWS FOR A PERSON, from their account's name, held to the rule every proposal's names are applied under
 * (`proposalDraftRefusal`): an account named by an address shows its local part, and a name the rule still refuses (a
 * link, a handle) shows the name the proposal was validated with. So what the confirmer reads is what the confirmed
 * proposal applies, and a confirmation never fails on a name. At most {@link MAX_INVITE_LABEL} characters.
 */
export function cardNameOf(accountName: string, validatedName: string): string {
  const one = accountName.replace(/\s+/g, ' ').trim();
  const local = one.replace(/([^\s@]+)@[^\s@]+\.[^\s@]+/g, '$1').trim();
  const name = [one, local].find((n) => n && !proposalDraftRefusal(n)) ?? validatedName;
  return wellFormedPrefix(name, MAX_INVITE_LABEL);
}

/** The meeting a conversation's turn may propose people for: its room's running meeting that takes people from outside. */
export async function meetingRunsFor(
  channelArn: string, readRow: (channelArn: string) => Promise<ChannelContext | null>,
): Promise<MeetingPlace | undefined> {
  const here = await readRow(channelArn);
  const place = meetingPlaceOf(channelArn, here);
  if (!place) return undefined;
  const meetingRow = place.meetingArn === channelArn ? here : await readRow(place.meetingArn);
  if (!meetingRow?.activeMeeting?.meetingId || meetingRow.meetingOf !== place.roomArn || !meetingAdmitsAddedPeople(meetingRow)) return undefined;
  const roomRow = place.roomArn === channelArn ? here : await readRow(place.roomArn);
  if (roomRow?.meetingConversation?.channelArn !== place.meetingArn) return undefined;
  return { ...place, meetingRow, roomRow };
}

/** The leading characters of a meeting id the card shows, enough to tell one call from another by eye. */
const SHORT_MEETING_ID = 8;

/**
 * WHICH CALL A CARD ASKED FROM THE ROOM IS FOR: the meeting conversation's name and the meeting's id, as the template's
 * values, so the person confirms the call they mean. A card asked in the meeting's own chat names none, because the call is
 * the one they are in. The id is the running meeting's, read from the meeting conversation's server-side record; a name
 * that cannot be read is left out, and the id still says which call.
 */
export async function meetingNamingOf(
  meetingArn: string, meetingRow: ChannelContext, deps: Pick<MeetingInviteOfferDeps, 'conversationNameOf'>,
): Promise<{ meetingName?: string; meetingId?: string }> {
  const meetingId = meetingRow.activeMeeting?.meetingId?.slice(0, SHORT_MEETING_ID);
  const meetingName = await deps.conversationNameOf?.(meetingArn).catch(() => undefined);
  return { ...(meetingName ? { meetingName } : {}), ...(meetingId ? { meetingId } : {}) };
}

/** Record the proposal and post its card, or say why not. What is returned is the tool's result, which the model reads. */
export async function offerMeetingInvites(input: Record<string, unknown>, turn: MeetingInviteTurn, deps: MeetingInviteOfferDeps): Promise<Record<string, unknown>> {
  const asked = meetingInvitesFromInput(input, turn.appInstanceArn);
  if ('refused' in asked) return { error: asked.refused };
  const meeting = await deps.placeOf(turn.channelArn);
  if (!meeting) return { error: 'no meeting that takes people from outside this conversation is running here, so nobody can be added' };
  const personId = personIdFromArn(turn.requesterArn) ?? '';
  const may = await mayAddPeople(meeting.meetingRow.activeMeeting, personId, async () => holdsModeratingRole(meeting.roomRow, personId));
  if (!may) return { error: 'only the meeting\'s host or a moderator can add people to it; say so, and offer nothing to confirm' };
  const read = await namedByAccount(asked.invites, deps.nameOf ?? appInstanceUserName);
  if ('refused' in read) return { error: read.refused };
  const now = Math.floor((deps.now ?? Date.now)() / 1000);
  const { record, card } = proposalRecordOf({
    channelArn: turn.channelArn, addresseeArn: turn.requesterArn, now,
    fields: {
      op: 'add_to_meeting', classification: turn.classification, addressedAs: MEETING_ADDER,
      workflow: 'request', step: MEETING_INVITES_TOOL, runKey: turn.correlationId,
      draft: proposalDraft(inviteLines(read.invites), 'add_to_meeting'),
      meetingChannelArn: meeting.meetingArn, invites: read.invites, briefBy: turn.botArn,
    },
  });
  await deps.writeProposal(record);
  const accounts = new Set(read.invites.flatMap((i) => i.accounts));
  const naming = turn.channelArn === meeting.meetingArn ? {} : await meetingNamingOf(meeting.meetingArn, meeting.meetingRow, deps);
  const content = await deps.cardText({ count: accounts.size, teams: inviteLines(read.invites), ...naming });
  await deps.postCard({ content, to: turn.requesterArn, card });
  return {
    offered: true, people: read.invites.length, names: read.invites.map((i) => i.name), accounts: accounts.size,
    next: 'The confirmation card is posted privately to the person who asked. Nothing is added until they confirm it. '
      + 'Do not call this again for the same people. End your reply by asking whether to add them.',
  };
}
