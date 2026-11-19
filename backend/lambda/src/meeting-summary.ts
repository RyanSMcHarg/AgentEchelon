/**
 * A MEETING'S SUMMARY, FROM ITS EVENTS (the `meetings` capability). Invoked by the conversation's own router once the
 * meeting's summary schedule fires, so the router can rewrite the ended card in place (`handleMeetingSummaryFired`).
 *
 *  - Each classification has its own summary entry, which only that classification's router may invoke, and an entry
 *    answers only for a conversation whose immutable classification tag is its own (`MEETING_SUMMARY_CLASSIFICATION`).
 *  - The meeting is the conversation's last one by the conversation's own record, read here again, so a call naming any
 *    other meeting reads nothing.
 *  - The events are read from the deployment's store (`meetingEventsIn`: the Aurora projection where one runs, else the
 *    archive through Athena), from the meeting's creation to now, and only that meeting's rows of that conversation count.
 *  - The figures are the ones `summarizeMeeting` derives for the console, so the room and the console agree. A read that
 *    was cut short or left a classification unread answers `INCOMPLETE` rather than a figure over part of the meeting.
 *
 * It answers counts and minutes only: never a person, an attendee or a device. The router reads it for the ended card's
 * figures and for a running meeting's watch (how many people are in it now).
 */
import { readChannelContext } from './lib/channel-context-client.js';
import { meetingEventsIn } from './lib/meeting-event-reader.js';
import { summarizeMeeting } from './lib/meeting-figures.js';
import { isMeetingId } from './lib/meeting-lifecycle.js';
import { readChannelClassificationTag } from './lib/channel-classification.js';
import { chimeMessagingClient } from './lib/chime/clients.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const LOG = '[meeting-summary]';

/** Events filed a little before the meeting's own record (the service's start) still belong to it. */
const LEAD_MS = 5 * 60_000;

export interface MeetingSummaryRequest {
  channelArn: string;
  meetingId: string;
}

export type MeetingSummaryAnswer =
  | { ok: true; ended: boolean; durationMinutes: number | null; people: number; present: number; connectedMinutes: number; drops: number }
  | { ok: false; code: 'INVALID' | 'OTHER_CLASSIFICATION' | 'CLASSIFICATION_UNREADABLE' | 'NOT_THIS_MEETING' | 'INCOMPLETE' | 'UNAVAILABLE' | 'INTERNAL' };

let messaging: Parameters<typeof readChannelClassificationTag>[0] | undefined;
/** Test seam: the client the conversation's classification tag is read with. */
export function __setMessagingClient(c: Parameters<typeof readChannelClassificationTag>[0] | undefined): void { messaging = c; }


/** What the read leaves of the function's own time, for the answer to travel back. */
const ANSWER_MARGIN_MS = 3000;

export async function handler(
  event: MeetingSummaryRequest, context?: { getRemainingTimeInMillis?: () => number },
): Promise<MeetingSummaryAnswer> {
  // The read is answered inside this invocation's own time: a slow archive query is stopped and refused as INCOMPLETE.
  const remaining = context?.getRemainingTimeInMillis?.();
  const deadlineAt = remaining === undefined ? undefined : Date.now() + remaining - ANSWER_MARGIN_MS;
  const app = process.env.APP_INSTANCE_ARN || '';
  const channelArn = typeof event?.channelArn === 'string' ? event.channelArn : '';
  const meetingId = typeof event?.meetingId === 'string' ? event.meetingId : '';
  // THE CLASSIFICATION THIS ENTRY SERVES, set by its stack; an entry deployed without one answers nothing.
  const own = (process.env.MEETING_SUMMARY_CLASSIFICATION || '').trim();
  if (!own || !app || !channelArn.startsWith(`${app}/channel/`) || !isMeetingId(meetingId)) return { ok: false, code: 'INVALID' };
  try {
    // The conversation's immutable classification tag must be this entry's own. One that cannot be read refuses as a
    // failed read (`CLASSIFICATION_UNREADABLE`), which the router asks again, never as another classification's.
    await loadProfileRegistry();
    const classification = await readChannelClassificationTag(messaging ??= chimeMessagingClient({}), channelArn, LOG);
    if (!classification) return { ok: false, code: 'CLASSIFICATION_UNREADABLE' };
    if (classification !== own) {
      console.warn(`${LOG}[SecurityEvent] a summary entry was asked for another classification's conversation; refusing`, { channelArn, own, classification });
      return { ok: false, code: 'OTHER_CLASSIFICATION' };
    }
    // A RECORD THAT COULD NOT BE READ IS A FAILED READ (`UNAVAILABLE`), never "not this meeting": the router asks again.
    const record = await readChannelContext(channelArn, { consistent: true });
    const last = record?.lastMeeting;
    if (!last || last.meetingId !== meetingId) return { ok: false, code: 'NOT_THIS_MEETING' };
    const from = new Date(Date.parse(last.createdAt) - LEAD_MS).toISOString();
    // THE FIGURES ARE READ WITHOUT THE CONNECTIVITY SAMPLES, which they do not use and which would fill the read's cap.
    const read = await meetingEventsIn(from, new Date().toISOString(), meetingId, { deadlineAt, samples: false });
    if (read.truncated || read.unread.length) {
      console.warn(`${LOG} the meeting's events were not read whole; no figures`, { truncated: read.truncated, unread: read.unread.length });
      return { ok: false, code: 'INCOMPLETE' };
    }
    const rows = read.rows.filter((r) => r.meeting_id === meetingId && r.channel_arn === channelArn);
    const s = summarizeMeeting(rows, Date.now());
    const connectedSeconds = s.roster.reduce((sum, r) => sum + r.connectedSeconds, 0);
    return {
      ok: true,
      ended: s.status === 'ended',
      durationMinutes: s.durationSeconds === null ? null : Math.max(1, Math.round(s.durationSeconds / 60)),
      people: s.people,
      // People connected now, while it runs: what a meeting's watch reads (`meeting-watch.ts`).
      present: s.present,
      connectedMinutes: Math.round(connectedSeconds / 60),
      drops: s.dropEvents,
    };
  } catch (err) {
    const name = (err as Error).name;
    console.error(`${LOG} the summary could not be read`, { err: name });
    return { ok: false, code: name === 'ChannelContextUnreadable' ? 'UNAVAILABLE' : 'INTERNAL' };
  }
}
