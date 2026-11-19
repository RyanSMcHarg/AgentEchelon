/**
 * THE CONSOLE'S MEETINGS (SPEC-ASSISTANT-MEETINGS FR22 to FR26), on the admin API when `meetings` and `admin` are both
 * declared:
 *   GET /admin/meetings?days=7               every figure across the window's meetings, and each meeting's summary.
 *   GET /admin/meetings/{meetingId}?days=7   one meeting: its summary, its roster, each attendee record's connectivity
 *                                            (`connectivity`), each person's poor stretches and moments against the
 *                                            deployment's thresholds (`experience`) and its events in time order.
 *   POST /admin/meetings/{meetingId}/end     ends a running meeting for everyone, with a stated reason (`end-meetings`).
 *   GET /admin/meetings/{meetingId}/transcript?accessReason=...
 *                                            the meeting's transcript and its summary: conversation content, read under
 *                                            `view-events` with a stated reason that the access log records before the read.
 *
 * ONE MEETING NAMES ITS CONVERSATION'S TYPE AND THE ROOM IT WAS STARTED FROM (`conversation`), read from the meeting
 * conversation's record, so the console can open both. It never carries what was said: the transcript is its own route.
 *
 * WHETHER A MEETING RUNS NOW is current state, read from its conversation's record and confirmed with Amazon Chime SDK
 * (`meeting-liveness.ts`), never from the events: each meeting in an answer carries `live` (true, false, or null when it
 * could not be read).
 *
 * Admins only: an admin spans every classification, and the gateway refuses any other principal on these routes
 * (`view-meeting-analytics`, `lib/config/admin-capabilities.ts`). Ending a meeting is its own capability on its own
 * resource (`end-meetings`), and a caller whose role is scoped ends only meetings of a classification their scope reaches. The figures are folded from the recorded events
 * (`meeting-figures.ts`) read from whichever store the deployment keeps (`meeting-event-reader.ts`), and the answer
 * says what it is missing: rows past the cap, and a classification whose rows could not be read.
 *
 * NAMES ARE NOT ADDED HERE. A person on the roster is their AppInstanceUser id, as the record keeps them, and the console
 * shows that id.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { requireAdmin, isAdminIamEnforcedCall } from './lib/auth.js';
import { responder, originsFrom, DEV_ORIGIN } from './lib/http-response.js';
import { loadProfileRegistry } from '../../lib/profile-registry';
import { meetingFigures, meetingDetail, distinctEvents, startsInEvents, type MeetingStatus } from './lib/meeting-figures.js';
import { experienceIssues, experienceThresholds } from './lib/meeting-experience.js';
import { MAX_WINDOW_DAYS, meetingEventsIn } from './lib/meeting-event-reader.js';
import { CONNECTIVITY_SAMPLE_EVENT } from './lib/meeting-event-shape.js';
import { isMeetingId } from './lib/meeting-lifecycle.js';
import { livenessOf, meetingIsLive, __setLivenessDeps } from './lib/meeting-liveness.js';
import { readChannelContext } from './lib/channel-context-client.js';
import { endConversationMeeting, type MeetingEndAnswer } from './lib/meeting-run.js';
import { AccessReaderUnidentified, recordAccess, signingPrincipalArn, type AccessAuditLine } from './lib/access-log.js';
import { classificationAllowed, scopeForRequest, type ClassificationScope } from './lib/caller-scope.js';
import { conversationChannelArn } from './lib/conversation-access.js';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { transcriptKey } from './lib/meeting-transcript.js';
import { conversationIdOf } from './lib/dashboard-keys.js';
import type { ChannelContext } from './lib/channel-context-client.js';

const http = responder({ origin: { allow: originsFrom(process.env.ALLOWED_ORIGIN, DEV_ORIGIN) }, methods: 'GET,POST,OPTIONS' });
const DEFAULT_DAYS = 7;
/**
 * How long the read may take, from the request's arrival: inside the HTTP API's 30 s integration limit with room for the
 * fold and the reply, so a window too large to read in time is answered as incomplete rather than cut off by the gateway.
 */
export const READ_BUDGET_MS = 24_000;

let readEvents = meetingEventsIn;
let clock = (): number => Date.now();
type MeetingRecord = { meetingId?: string; classification?: string } | null | undefined;
let readRecord = async (channelArn: string): Promise<MeetingRecord> => (await readChannelContext(channelArn, { consistent: true }))?.activeMeeting;
/**
 * THE RUN ENTRY OF THE MEETING'S CLASSIFICATION ends it: each classification has its own, which refuses a conversation of
 * any other, so the classification is the one the meeting's record kept and never one the request names.
 */
export function runEntryFor(classification: string): string {
  const pattern = process.env.MEETING_RUN_FUNCTION_PATTERN || '';
  return pattern.includes('{classification}') && /^[a-z0-9-]+$/i.test(classification) ? pattern.replace('{classification}', classification) : '';
}
let endMeeting = async (channelArn: string, meetingId: string, classification: string): Promise<MeetingEndAnswer> => {
  const entry = runEntryFor(classification);
  return entry ? endConversationMeeting(entry, channelArn, meetingId) : { ok: false, code: 'NOT_CONFIGURED' };
};
let recordEnd: (line: AccessAuditLine) => Promise<unknown> = (line) => recordAccess(line);
/**
 * Record an access in the access log, with its CloudWatch audit line beside it (the operator's tail). The line is written
 * first, so an access whose record then fails still leaves a trace of the attempt.
 */
async function recordWithAuditLine(line: AccessAuditLine): Promise<void> {
  // An access that names neither a person nor a signing principal is refused before anything is written.
  if (!line.personId && !line.actorPrincipalArn) throw new AccessReaderUnidentified();
  console.log(JSON.stringify(line));
  await recordEnd(line);
}
/** Who the access log names: the person, else the IAM principal that signed the request, as API Gateway set it. */
function readerOf(event: APIGatewayProxyEvent, actor: string | null): Pick<AccessAuditLine, 'personId' | 'actorPrincipalArn'> {
  if (actor) return { personId: actor };
  const principal = signingPrincipalArn(event);
  return principal ? { actorPrincipalArn: principal } : {};
}
type ConversationRow = (Pick<ChannelContext, 'conversationType' | 'meetingOf'> & { lastMeeting?: unknown }) | null | undefined;

/**
 * Whether this meeting's transcript was kept: its conversation's record says the meeting was in recording mode at some
 * point (`lastMeeting.transcription.everRecorded`), the same fact the end reads before it writes a transcript. Null when
 * the record holds a different meeting or none, so whether one was kept is not known from it.
 */
export function transcriptKeptOf(row: ConversationRow, meetingId: string): boolean | null {
  const last = (row?.lastMeeting ?? null) as { meetingId?: unknown; transcription?: { everRecorded?: unknown } } | null;
  if (!last || last.meetingId !== meetingId) return null;
  return last.transcription?.everRecorded === true;
}

/**
 * A MEETING'S SUMMARY, as the router keeps it on the meeting conversation's record (`lastMeeting.summary`): what was said,
 * its key points, next steps and topics, and each action item, which is a task on the room where a host holds it. Read
 * strictly, so only these fields leave the record; null where this meeting has none.
 */
export interface MeetingSummaryContent {
  summary: string;
  keyPoints: string[];
  nextSteps: string[];
  topics: string[];
  actionItems: Array<{ text: string; due?: string; taskId?: string; assignee?: string; heldBy?: string }>;
  writtenAt?: string;
}
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
export function summaryOf(row: ConversationRow, meetingId: string): MeetingSummaryContent | null {
  const last = (row?.lastMeeting ?? null) as { meetingId?: unknown; summary?: unknown } | null;
  if (!last || last.meetingId !== meetingId || !last.summary || typeof last.summary !== 'object') return null;
  const s = last.summary as Record<string, unknown>;
  if (typeof s.summary !== 'string') return null;
  const items = Array.isArray(s.actionItems) ? s.actionItems : [];
  return {
    summary: s.summary,
    keyPoints: strings(s.keyPoints),
    nextSteps: strings(s.nextSteps),
    topics: strings(s.topics),
    actionItems: items.filter((i): i is Record<string, unknown> => Boolean(i) && typeof (i as Record<string, unknown>).text === 'string').map((i) => ({
      text: i.text as string,
      ...(str(i.due) ? { due: str(i.due) } : {}),
      ...(str(i.taskId) ? { taskId: str(i.taskId) } : {}),
      ...(str(i.assignee) ? { assignee: str(i.assignee) } : {}),
      ...(str(i.heldBy) ? { heldBy: str(i.heldBy) } : {}),
    })),
    ...(str(s.writtenAt) ? { writtenAt: str(s.writtenAt) } : {}),
  };
}
let readConversation = async (channelArn: string): Promise<ConversationRow> => readChannelContext(channelArn);
let s3: Pick<S3Client, 'send'> | null = null;
/**
 * THE TRANSCRIPT'S TEXT, or null where none was written. A read of a missing key is answered as missing (`NoSuchKey`) only
 * to a role whose bucket listing reaches it; one denied instead lists the key's own prefix, which the role may list, so a
 * key that is not there is answered as none and any other denial stands.
 */
export async function readTranscriptFromStore(key: string, client: Pick<S3Client, 'send'>, bucket: string): Promise<string | null> {
  try {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return (await out.Body?.transformToString()) ?? null;
  } catch (err) {
    if ((err as Error).name === 'NoSuchKey') return null;
    if ((err as Error).name !== 'AccessDenied') throw err;
    const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 1 }));
    if (!listed.Contents?.some((o) => o.Key === key)) return null;
    throw err;
  }
}
let readTranscriptText = async (key: string): Promise<string | null> => {
  s3 ??= new S3Client({});
  return readTranscriptFromStore(key, s3, process.env.TRANSCRIPT_BUCKET || '');
};
/**
 * Test seam: the read, the clock, the meeting's record, the service's answer, the end, the access log, a conversation's
 * record and the transcript.
 */
export function __setForTests(d: {
  read?: typeof meetingEventsIn; now?: () => number;
  record?: (channelArn: string) => Promise<MeetingRecord>; runs?: (meetingId: string) => Promise<boolean>;
  end?: typeof endMeeting; log?: (line: AccessAuditLine) => Promise<unknown>;
  conversation?: (channelArn: string) => Promise<ConversationRow>; transcript?: (key: string) => Promise<string | null>;
}): void {
  if (d.conversation) readConversation = d.conversation;
  if (d.transcript) readTranscriptText = d.transcript;
  if (d.read) readEvents = d.read;
  if (d.now) clock = d.now;
  if (d.record) readRecord = d.record;
  if (d.end) endMeeting = d.end;
  if (d.log) recordEnd = d.log;
  if (d.record || d.runs) __setLivenessDeps({ ...(d.record ? { readRecord: d.record } : {}), ...(d.runs ? { runs: d.runs } : {}) });
}

/** The window a request asks for: whole days back from now, 1 to {@link MAX_WINDOW_DAYS}. */
export function windowOf(daysParam: string | undefined, now: number): { fromIso: string; toIso: string; days: number } | null {
  const days = daysParam === undefined ? DEFAULT_DAYS : Number(daysParam);
  if (!Number.isInteger(days) || days < 1 || days > MAX_WINDOW_DAYS) return null;
  return { fromIso: new Date(now - days * 86_400_000).toISOString(), toIso: new Date(now).toISOString(), days };
}

/** The classifications the caller reaches: every one for an admin signed in as one, else what their signed role's scope reaches. */
function callerScopeOf(event: APIGatewayProxyEvent): ClassificationScope {
  return isAdminIamEnforcedCall(event) ? scopeForRequest(event) : null;
}

const END_PATH = /\/admin\/meetings\/[^/]+\/end\/?$/;
const TRANSCRIPT_PATH = /\/admin\/meetings\/[^/]+\/transcript\/?$/;

/** What the console shows about the conversation a meeting was held in. */
export interface MeetingConversation {
  /** The meeting conversation's type. */
  type: string | null;
  /** The room it was started from, with that room's type; null for a meeting held in its room. */
  room: { channelArn: string; type: string | null } | null;
  /** Whether its summary was written. What it says is read with the transcript, under `view-events`. */
  summarized: boolean;
  /**
   * Whether its transcript was kept: true where the meeting was in recording mode at some point, false where it was
   * captions only or never transcribed, null where the record does not hold this meeting.
   */
  transcriptKept: boolean | null;
}

/**
 * THE CONVERSATION A MEETING WAS HELD IN, as its record names it: that conversation's type, and the room the meeting was
 * started from with the room's type. Null where the record cannot be read; the rest of the answer stands without it.
 */
async function conversationOf(channelArn: string, meetingId: string): Promise<MeetingConversation | null> {
  try {
    const row = await readConversation(channelArn);
    if (!row) return null;
    const instance = channelArn.slice(0, channelArn.lastIndexOf('/channel/'));
    const roomArn = row.meetingOf ? (row.meetingOf.includes('/channel/') ? row.meetingOf : `${instance}/channel/${row.meetingOf}`) : null;
    const roomRow = roomArn ? await readConversation(roomArn).catch(() => null) : null;
    return {
      type: row.conversationType ?? null,
      room: roomArn ? { channelArn: roomArn, type: roomRow?.conversationType ?? null } : null,
      summarized: summaryOf(row, meetingId) !== null,
      transcriptKept: transcriptKeptOf(row, meetingId),
    };
  } catch {
    return null;
  }
}

/**
 * A MEETING'S TRANSCRIPT IS CONVERSATION CONTENT (`view-events`). The gateway admits only a role holding the capability on
 * this resource; here the meeting must be in the window, of a classification the caller reaches, and the read must state
 * why. The access log records who read which meeting's transcript and why BEFORE it is read, and a read that cannot be
 * recorded is refused. The transcript is read from its own key in the conversation store (`meeting-transcript.ts`).
 */
async function transcriptFor(event: APIGatewayProxyEvent, meetingId: string, actor: string | null, origin: string | undefined, startedAt: number): Promise<APIGatewayProxyResult> {
  const reason = (event.queryStringParameters?.accessReason ?? '').trim().slice(0, 500);
  if (!reason) return http.respond(400, { error: 'Say why the transcript is being read', code: 'REASON_REQUIRED' }, origin);
  const window = windowOf(event.queryStringParameters?.days, clock());
  if (!window) return http.respond(400, { error: `Ask for 1 to ${MAX_WINDOW_DAYS} days`, code: 'INVALID_WINDOW' }, origin);
  let read: Awaited<ReturnType<typeof meetingEventsIn>>;
  try {
    read = await readEvents(window.fromIso, window.toIso, meetingId, { deadlineAt: startedAt + READ_BUDGET_MS });
  } catch (err) {
    console.error('[admin-meetings] the meeting events could not be read', { err: (err as Error).name });
    return http.respond(503, { error: 'Meetings could not be read just now', code: 'UNAVAILABLE' }, origin);
  }
  const rows = read.rows;
  const held = rows.find((r) => r.meeting_id === meetingId && r.classification && r.channel_arn);
  if (!startsInEvents(rows) || !held) return noSuchMeeting(read, origin);
  const scope = callerScopeOf(event);
  if (!classificationAllowed(held.classification, scope)) {
    return http.respond(403, { error: 'That meeting is outside the classifications you reach', code: 'OUTSIDE_SCOPE' }, origin);
  }
  // A meeting its record says kept no transcript and no summary has nothing to read, so no read is recorded.
  const row = await readConversation(held.channel_arn).catch(() => null);
  const summary = summaryOf(row, meetingId);
  if (!summary && transcriptKeptOf(row, meetingId) === false) {
    return http.respond(404, { error: 'No transcript was kept for this meeting', code: 'NO_TRANSCRIPT' }, origin);
  }
  try {
    await recordWithAuditLine({
      _auditEvent: 'meeting_transcript_read',
      timestamp: new Date().toISOString(),
      ...readerOf(event, actor),
      channelArn: held.channel_arn,
      capabilities: ['view-events'],
      meetingId,
      classification: held.classification,
      scope: scope === null ? 'full' : scope || 'none',
      reason,
    });
  } catch (err) {
    if (err instanceof AccessReaderUnidentified) return http.respond(403, { error: 'This read names no person and no signing principal', code: 'READER_UNIDENTIFIED' }, origin);
    console.error('[admin-meetings][SecurityEvent] a transcript read could not be recorded; refusing it', { err: (err as Error).name });
    return http.respond(503, { error: 'This read cannot be recorded right now, so the transcript is not read', code: 'ACCESS_LOG_UNAVAILABLE' }, origin);
  }
  const conversationId = conversationIdOf(held.channel_arn);
  let text: string | null;
  try {
    text = conversationId ? await readTranscriptText(transcriptKey(held.classification, conversationId, meetingId)) : null;
  } catch (err) {
    console.error('[admin-meetings] the transcript could not be read', { err: (err as Error).name });
    return http.respond(503, { error: 'The transcript could not be read just now', code: 'UNAVAILABLE' }, origin);
  }
  // The summary is on the meeting conversation's record; one that cannot be read leaves the transcript standing.
  if (text === null && !summary) return http.respond(404, { error: 'No transcript was written for this meeting', code: 'NO_TRANSCRIPT' }, origin);
  return http.respond(200, { meetingId, transcript: text, summary }, origin);
}

/**
 * END A RUNNING MEETING FOR EVERYONE (`end-meetings`). The gateway admits only a role that holds the capability on this
 * resource; here the meeting must be the one its conversation holds now and the service still runs, of a classification
 * the caller reaches, with a stated reason. The access log records who ended which meeting in which conversation and why
 * BEFORE the meeting is ended, and an end that cannot be recorded is refused. The end itself is the meetings function's
 * own (`endConversationMeeting`): the service deletes the meeting, the record is released, and the room hears the end
 * from the service's own event.
 */
async function endForEveryone(event: APIGatewayProxyEvent, meetingId: string, actor: string | null, origin: string | undefined): Promise<APIGatewayProxyResult> {
  let body: { channelArn?: unknown; conversationId?: unknown; reason?: unknown } = {};
  try {
    body = event.body ? JSON.parse(event.body) as typeof body : {};
  } catch {
    return http.respond(400, { error: 'The body is not JSON', code: 'INVALID_BODY' }, origin);
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
  if (!reason) return http.respond(400, { error: 'Say why the meeting is being ended', code: 'REASON_REQUIRED' }, origin);
  const channelArn = conversationChannelArn(body.channelArn ?? body.conversationId, process.env.APP_INSTANCE_ARN || '');
  if (!channelArn) return http.respond(400, { error: "Name the meeting's conversation", code: 'INVALID_CONVERSATION' }, origin);

  let recorded: MeetingRecord;
  try {
    recorded = await readRecord(channelArn);
  } catch (err) {
    console.error("[admin-meetings] the meeting's record could not be read", { err: (err as Error).name });
    return http.respond(503, { error: 'The meeting could not be read just now', code: 'UNAVAILABLE' }, origin);
  }
  // The meeting's classification is the one its record kept when it was created, never one the request names.
  if (recorded?.meetingId !== meetingId || !recorded.classification) {
    return http.respond(409, { error: 'That meeting is not running in that conversation', code: 'NOT_RUNNING' }, origin);
  }
  const scope = callerScopeOf(event);
  if (!classificationAllowed(recorded.classification, scope)) {
    return http.respond(403, { error: 'That meeting is outside the classifications you reach', code: 'OUTSIDE_SCOPE' }, origin);
  }
  const live = await meetingIsLive({ meetingId, channelArn, endedAt: null });
  if (live === null) return http.respond(503, { error: 'Whether the meeting runs could not be read just now', code: 'UNAVAILABLE' }, origin);
  if (!live) return http.respond(409, { error: 'That meeting has already ended', code: 'NOT_RUNNING' }, origin);

  try {
    await recordWithAuditLine({
      _auditEvent: 'meeting_ended_for_all',
      timestamp: new Date().toISOString(),
      ...readerOf(event, actor),
      channelArn,
      capabilities: ['end-meetings'],
      meetingId,
      classification: recorded.classification,
      scope: scope === null ? 'full' : scope || 'none',
      reason,
    });
  } catch (err) {
    if (err instanceof AccessReaderUnidentified) return http.respond(403, { error: 'This end names no person and no signing principal', code: 'READER_UNIDENTIFIED' }, origin);
    console.error('[admin-meetings][SecurityEvent] an end could not be recorded; refusing it', { err: (err as Error).name });
    return http.respond(503, { error: 'This end cannot be recorded right now, so the meeting is not ended', code: 'ACCESS_LOG_UNAVAILABLE' }, origin);
  }

  let ended: MeetingEndAnswer;
  try {
    ended = await endMeeting(channelArn, meetingId, recorded.classification);
  } catch (err) {
    console.error('[admin-meetings] the meetings function could not be reached', { err: (err as Error).name });
    return http.respond(503, { error: 'The meeting could not be ended just now', code: 'UNAVAILABLE' }, origin);
  }
  if (ended.ok) return http.respond(200, { ended: true }, origin);
  // The service ended it and only the conversation's record was left: the meeting is over, and the next read releases it.
  if (ended.code === 'RELEASE_FAILED') return http.respond(200, { ended: true, released: false }, origin);
  const status = ended.code === 'NOT_RUNNING' ? 409 : 502;
  return http.respond(status, { error: 'The meeting could not be ended', code: ended.code ?? 'END_FAILED' }, origin);
}

/**
 * A MEETING NOT FOUND IN A READ THAT WAS NOT WHOLE IS NOT KNOWN TO BE ABSENT: a read cut short (`truncated`) or missing a
 * classification (`unread`) answers 503 `INCOMPLETE`, which the console words as "could not be read whole; try a
 * shorter window", and only a whole read answers 404.
 */
function noSuchMeeting(read: { truncated: boolean; unread: string[] }, origin: string | undefined): APIGatewayProxyResult {
  if (read.truncated || read.unread.length) {
    return http.respond(503, { error: 'The meetings could not be read whole; try a shorter window', code: 'INCOMPLETE', truncated: read.truncated, unreadClassifications: read.unread }, origin);
  }
  return http.respond(404, { error: 'No such meeting in this window', code: 'NO_MEETING' }, origin);
}

/**
 * THE WINDOW'S MEETINGS BY STATUS, by the same fact each meeting's row is shown by: running is what the meeting's record
 * and Amazon Chime SDK say runs now, a meeting that no longer runs without a recorded end has no end recorded, and a
 * meeting whose liveness could not be read keeps the status its events give it.
 */
export function statusByLiveness(meetings: Array<{ meetingId: string; status: MeetingStatus }>, live: ReadonlyMap<string, boolean | null>): Record<MeetingStatus, number> {
  const out: Record<MeetingStatus, number> = { active: 0, ended: 0, abandoned: 0 };
  for (const m of meetings) {
    const now = live.get(m.meetingId) ?? null;
    const status: MeetingStatus = now === true ? 'active' : now === false ? (m.status === 'ended' ? 'ended' : 'abandoned') : m.status;
    out[status] += 1;
  }
  return out;
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const startedAt = Date.now();
  const origin = (event.headers?.origin || event.headers?.Origin) ?? undefined;
  if (event.httpMethod === 'OPTIONS') return http.empty(204, origin);
  await loadProfileRegistry();
  const admin = await requireAdmin(event);
  if (!('claims' in admin)) return admin;

  if (event.httpMethod === 'POST') {
    const id = event.pathParameters?.meetingId ?? '';
    if (!END_PATH.test(event.resource || event.path || '') || !isMeetingId(id)) return http.respond(404, { error: 'No such route', code: 'NOT_FOUND' }, origin);
    return endForEveryone(event, id, admin.claims.personId, origin);
  }

  if (TRANSCRIPT_PATH.test(event.resource || event.path || '')) {
    const id = event.pathParameters?.meetingId ?? '';
    if (!isMeetingId(id)) return http.respond(400, { error: 'Name one meeting', code: 'INVALID_MEETING' }, origin);
    return transcriptFor(event, id, admin.claims.personId, origin, startedAt);
  }

  const now = clock();
  const window = windowOf(event.queryStringParameters?.days, now);
  if (!window) return http.respond(400, { error: `Ask for 1 to ${MAX_WINDOW_DAYS} days`, code: 'INVALID_WINDOW' }, origin);
  const meetingId = event.pathParameters?.meetingId ?? null;
  if (meetingId !== null && !isMeetingId(meetingId)) return http.respond(400, { error: 'Name one meeting', code: 'INVALID_MEETING' }, origin);

  let read: Awaited<ReturnType<typeof meetingEventsIn>>;
  try {
    read = await readEvents(window.fromIso, window.toIso, meetingId, { deadlineAt: startedAt + READ_BUDGET_MS });
  } catch (err) {
    console.error('[admin-meetings] the meeting events could not be read', { err: (err as Error).name });
    return http.respond(503, { error: 'Meetings could not be read just now', code: 'UNAVAILABLE' }, origin);
  }
  const missing = { truncated: read.truncated, unreadClassifications: read.unread };
  const scope = { days: window.days, from: window.fromIso, to: window.toIso, store: read.store };
  // THE CALLER'S CLASSIFICATIONS, AS EVERY ADMIN READ APPLIES THEM: the list holds only meetings of a classification the
  // caller's scope reaches, and one meeting outside it is refused, as its transcript and its end are.
  const callerScope = callerScopeOf(event);
  const everyRow = read.rows;
  if (callerScope !== null) read = { ...read, rows: read.rows.filter((r) => classificationAllowed(r.classification ?? undefined, callerScope)) };

  if (meetingId) {
    // A meeting is in the window when it started in it, the same rule the list counts by.
    if (!startsInEvents(read.rows)) {
      if (startsInEvents(everyRow)) return http.respond(403, { error: 'That meeting is outside the classifications you reach', code: 'OUTSIDE_SCOPE' }, origin);
      return noSuchMeeting(read, origin);
    }
    // Its connection per attendee record beside the summary: the series, its health changes and its poor seconds.
    const { meeting, connectivity } = meetingDetail(read.rows, now);
    const [live, conversation] = await Promise.all([meetingIsLive(meeting), conversationOf(meeting.channelArn, meeting.meetingId)]);
    // The readings travel once, folded into `connectivity`: the events carry everything else, so the answer stays inside
    // the read's byte cap plus the folded readings, well under the 6 MB a Lambda answer may be.
    const distinct = distinctEvents(read.rows);
    const events = distinct.filter((r) => r.event_type !== CONNECTIVITY_SAMPLE_EVENT);
    // WHO HAD A POOR EXPERIENCE, AND WHEN (FR74): judged against the deployment's thresholds, answered with them so the
    // console draws the lines it was judged against.
    const thresholds = experienceThresholds();
    const closeAt = meeting.endedAt ? Date.parse(meeting.endedAt) : now;
    const experience = { thresholds, issues: experienceIssues(distinct, connectivity, closeAt, thresholds) };
    return http.respond(200, { ...scope, ...missing, meeting: { ...meeting, live }, conversation, connectivity, experience, events }, origin);
  }
  const { figures, meetings } = meetingFigures(read.rows, now);
  const live = await livenessOf(meetings);
  figures.byStatus = statusByLiveness(meetings, live);
  // The list carries each meeting's summary without its roster or its incidents: the detail route has both, and the
  // window's incidents are in `figures.incidents`.
  return http.respond(200, {
    ...scope, ...missing, figures,
    meetings: meetings.map(({ roster: _roster, incidents: _incidents, ...m }) => ({ ...m, live: live.get(m.meetingId) ?? null })),
  }, origin);
}
