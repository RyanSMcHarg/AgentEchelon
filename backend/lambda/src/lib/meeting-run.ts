/**
 * STARTS A CONVERSATION'S MEETING THROUGH THE MEETINGS STACK'S RUN ENTRY (`MEETING_RUN_FUNCTION`), and reads a meeting's
 * summary through its summary entry (`MEETING_SUMMARY_FUNCTION`).
 *
 * The call waits for the answer, because the step that rings the room needs to know the meeting runs. Each entry's own
 * timeout is set here and read by the Meetings stack, and each call is bounded just past it, so a cold start, the
 * meeting's own conversation and `CreateMeeting` complete, a call that never answers still ends, and the router, whose
 * own timeout is 30 seconds, is left time to say what happened. The router's own Lambda client fires asynchronous
 * invokes only and keeps its short bound (`bounded-request-handler.ts`).
 *
 * The answers are the entries' own types (`meeting-api.ts`, `meeting-summary.ts`), so a field renamed there fails to
 * compile here. An entry that failed outright (a timeout, an unhandled error) answers `ok: false` with its own code.
 */
import { LambdaClient, InvokeCommand, InvocationType, type InvokeCommandOutput } from '@aws-sdk/client-lambda';
import { ChimeSDKMeetingsClient, GetMeetingCommand } from '@aws-sdk/client-chime-sdk-meetings';
import type { RunEndResult, RunStartResult, RunTranscriptResult } from '../meeting-api.js';
import type { MeetingEndReason } from './channel-context-client.js';
import type { MeetingSummaryAnswer as SummaryResult } from '../meeting-summary.js';

/** The run entry's timeout, in seconds: the creator's open and `CreateMeeting` fit inside it. */
export const MEETING_RUN_TIMEOUT_SECONDS = 18;
/** The summary entry's timeout, in seconds: an Athena read completes well inside it. */
export const MEETING_SUMMARY_TIMEOUT_SECONDS = 20;

const clients = new Map<number, LambdaClient>();
function boundedClient(timeoutSeconds: number): LambdaClient {
  let c = clients.get(timeoutSeconds);
  if (!c) {
    c = new LambdaClient({
      region: process.env.AWS_REGION,
      requestHandler: { connectionTimeout: 2_000, requestTimeout: timeoutSeconds * 1000 + 1_000, throwOnRequestTimeout: true },
      // ONE ATTEMPT: an entry that ran past its bound may have acted (a start is not idempotent), and a second attempt would
      // outlast the caller's own time. The caller decides from the record what the attempt did.
      maxAttempts: 1,
    });
    clients.set(timeoutSeconds, c);
  }
  return c;
}

type Ok<T> = Extract<T, { ok: true }>;
type No<T> = Extract<T, { ok: false }>;
/** An entry's answer, read field by field: its success fields, its refusal code, or `ENTRY_FAILED` for an entry that failed outright. */
type Answer<T> = Partial<Omit<Ok<T>, 'ok'>> & { ok?: boolean; code?: No<T> extends { code: infer C } ? C | 'ENTRY_FAILED' : 'ENTRY_FAILED' };

/** What the run entry answers: `ok` once the meeting runs, `created` when this call started it, the meeting's own conversation, else a `code`. */
export type MeetingRunAnswer = Answer<RunStartResult>;
/** What the run entry answers an end: `ended` once the service no longer runs the meeting, else a `code`. */
export type MeetingEndAnswer = Answer<RunEndResult>;
/** What the run entry answers for an ended meeting's transcript: its key where one was written, else a `code`. */
export type MeetingTranscriptAnswer = Answer<RunTranscriptResult>;
/** What the summary entry answers: counts and minutes once the events were read whole, else a `code`. */
export type MeetingSummaryAnswer = Answer<SummaryResult>;

/** An entry's payload, or its failure: a function error is an answer of its own, never parsed as the entry's. */
function answerOf<T>(res: InvokeCommandOutput, entry: string): Answer<T> {
  if (res.FunctionError) {
    console.error('[meeting-run] the entry failed', { entry, functionError: res.FunctionError });
    return { ok: false, code: 'ENTRY_FAILED' } as Answer<T>;
  }
  return res.Payload ? JSON.parse(Buffer.from(res.Payload).toString('utf8')) as Answer<T> : {};
}

/**
 * Starts the conversation's meeting, or finds the running one. `ringSeconds` is the step's, recorded on the meeting so a
 * person who arrives while it rings hears the rest. Throws when the run entry cannot be reached.
 */
export async function startConversationMeeting(functionName: string, channelArn: string, startedBy: string | null, ringSeconds?: number): Promise<MeetingRunAnswer> {
  const res = await boundedClient(MEETING_RUN_TIMEOUT_SECONDS).send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: InvocationType.RequestResponse,
    Payload: Buffer.from(JSON.stringify({ channelArn, startedBy, ...(ringSeconds !== undefined ? { ringSeconds } : {}) })),
  }));
  return answerOf<RunStartResult>(res, 'run');
}

/**
 * ENDS A CONVERSATION'S MEETING FOR EVERYONE THROUGH THE RUN ENTRY, the meetings function's own end (`meeting-api.ts`), so
 * the console ends a meeting the way the meeting's host does: the service deletes it, the conversation's record is
 * released, and the room is told by the service's own end event. Only the meeting the conversation holds now is ended.
 * Throws when the run entry cannot be reached.
 */
export async function endConversationMeeting(functionName: string, channelArn: string, meetingId: string, reason?: MeetingEndReason): Promise<MeetingEndAnswer> {
  const res = await boundedClient(MEETING_RUN_TIMEOUT_SECONDS).send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: InvocationType.RequestResponse,
    Payload: Buffer.from(JSON.stringify({ op: 'end', channelArn, meetingId, ...(reason ? { reason } : {}) })),
  }));
  return answerOf<RunEndResult>(res, 'end');
}

/**
 * WRITES AN ENDED MEETING'S TRANSCRIPT THROUGH THE RUN ENTRY (`meeting-api.ts` `transcriptFromRun`), where it was
 * transcribed. Throws when the run entry cannot be reached.
 */
export async function transcribeEndedMeeting(functionName: string, channelArn: string, meetingId: string): Promise<MeetingTranscriptAnswer> {
  const res = await boundedClient(MEETING_RUN_TIMEOUT_SECONDS).send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: InvocationType.RequestResponse,
    Payload: Buffer.from(JSON.stringify({ op: 'transcript', channelArn, meetingId })),
  }));
  return answerOf<RunTranscriptResult>(res, 'transcript');
}

/** READS A MEETING'S SUMMARY THROUGH THE MEETINGS STACK'S SUMMARY ENTRY. Throws when the entry cannot be reached. */
export async function summarizeConversationMeeting(functionName: string, channelArn: string, meetingId: string): Promise<MeetingSummaryAnswer> {
  const res = await boundedClient(MEETING_SUMMARY_TIMEOUT_SECONDS).send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: InvocationType.RequestResponse,
    Payload: Buffer.from(JSON.stringify({ channelArn, meetingId })),
  }));
  return answerOf<SummaryResult>(res, 'summary');
}

let meetingsClient: Pick<ChimeSDKMeetingsClient, 'send'> | undefined;
/** Test seam: the Amazon Chime SDK meetings client the router asks whether a meeting runs. */
export function __setMeetingsClient(c: Pick<ChimeSDKMeetingsClient, 'send'> | undefined): void { meetingsClient = c; }

/**
 * WHETHER AMAZON CHIME SDK STILL RUNS A MEETING, asked of the service itself (`GetMeeting`), so an end is believed only once
 * the service no longer holds the meeting. True while it runs, false once the service answers it is gone; a service that
 * cannot answer throws, so the caller is retried rather than deciding from no answer.
 */
export async function meetingRunsNow(meetingId: string): Promise<boolean> {
  meetingsClient ??= new ChimeSDKMeetingsClient({});
  try {
    const res = await meetingsClient.send(new GetMeetingCommand({ MeetingId: meetingId }));
    return Boolean(res.Meeting?.MeetingId);
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'NotFoundException' || name === 'ResourceNotFoundException') return false;
    throw err;
  }
}
