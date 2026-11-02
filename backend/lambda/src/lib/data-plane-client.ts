/**
 * Client seam for the retrieval + drift DATA-PLANE Lambda (ADR-013).
 *
 * Runs in the NON-VPC agent handler. Exposes the SAME function signatures as the
 * underlying `document-retrieval` / `drift-detection` modules, but implemented as
 * a synchronous (RequestResponse) invoke of the VPC-attached data-plane Lambda.
 * Callers (`router-agent-handler.ts`, `lib/live-drift-flow.ts`) change only their
 * import source, not their bodies.
 *
 * All I/O types are pulled in with `import type`, so `pg` / `db-client` are erased
 * from this bundle and the caller's bundle stays VPC-free.
 *
 * Degradation contract: retrieval and drift are best-effort on the hot path. An
 * infra failure (ARN unset, invoke error, Lambda FunctionError) logs a warning
 * and returns a safe default rather than throwing, so a data-plane hiccup never
 * fails the user's turn — matching the honest-empty / no-fire contracts of the
 * underlying functions.
 */

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type {
  RetrieveContextInput,
  RetrieveContextResult,
} from '../analytics-aurora/document-retrieval.js';
import type {
  DetectDriftInput,
  DriftResult,
  RecordDriftInput,
  ResolveDriftRivalInput,
} from '../analytics-aurora/drift-detection.js';
import type { PendingSuggestion, SuggestionKind } from './routing-state.js';
import type {
  AdminConvSummary,
  AdminConvMessage,
  AdminMembershipEvent,
} from '../analytics-aurora/admin-conversations-aurora.js';
import { sessionClient, currentAssistantSession } from './assistant-session.js';
import type { SourceRow, CleanRow } from './de-identify.js';
import type { PendingConversation, CleanConversation } from '../analytics-aurora/clean-copy.js';

export type {
  RetrieveContextInput,
  RetrieveContextResult,
  DetectDriftInput,
  DriftResult,
  RecordDriftInput,
  ResolveDriftRivalInput,
  PendingSuggestion,
  SuggestionKind,
};

/** Input for opening a pending-drift-suggestion task (mirrors routing-state). */
export interface SavePendingInput {
  channelArn: string;
  personId: string;
  kind: SuggestionKind;
  rivalConversationArn?: string;
  originatingMessageId: string;
  cosineDistance?: number;
  correlationId: string;
  driftEventId?: string;
}

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
/**
 * The data-plane Lambda ARN, read at CALL time from the env. Set by
 * auroraDriftWiring for the agent handler (Aurora mode); the admin-conversations
 * handler resolves it from SSM at cold start and writes it into the env before
 * its first call (the two stacks can't pass it directly — that would be a
 * circular dependency). Absent => data plane not wired.
 */
function dataPlaneArn(): string {
  return process.env.AURORA_DATA_PLANE_ARN || '';
}

/** True when the data plane is wired; callers gate retrieval/drift on this. */
export function hasDataPlane(): boolean {
  return !!dataPlaneArn();
}

const lambda = sessionClient(LambdaClient, { region: AWS_REGION });

/**
 * The envelope a call carries. `routeId` is the routing record of the turn this invocation is serving,
 * read from the assistant session it holds: a classification's turn data plane serves a turn operation
 * only for a turn routed to that classification, in the conversation the record names. A caller with
 * no session (the admin plane, client events) sends none and uses the shared data plane.
 */
function envelope(op: Op, input: unknown): string {
  const routeId = currentAssistantSession()?.routeId;
  return JSON.stringify({ op, input, ...(routeId ? { routeId } : {}) });
}

type Op = DataPlaneOp;
type DataPlaneOp =
  | 'retrieve'
  | 'detectDrift'
  | 'resolveDriftRival'
  | 'recordDriftFire'
  | 'recordDriftOutcome'
  | 'adoptOfferedTopic'
  | 'getSummary'
  | 'seedSummary'
  | 'seedDriftTopic'
  | 'savePendingSuggestion'
  | 'readPendingSuggestion'
  | 'resolvePendingSuggestion'
  | 'adminListConversations'
  | 'adminListMessages'
  | 'adminMembershipHistory'
  | 'ingestClientEvents'
  | 'cleanCopyPending'
  | 'cleanCopySource'
  | 'cleanCopyWrite'
  | 'cleanCopyRecordRun'
  | 'adminCleanConversation'
  | 'erasePerson';

/**
 * Invoke the data-plane Lambda and parse its JSON result. Throws on any infra
 * failure; each public wrapper below catches and degrades.
 */
async function invoke<T>(op: Op, input: unknown): Promise<T> {
  const arn = dataPlaneArn();
  if (!arn) {
    throw new Error(`AURORA_DATA_PLANE_ARN unset; cannot run '${op}'`);
  }
  const resp = await lambda.send(
    new InvokeCommand({
      FunctionName: arn,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(envelope(op, input)),
    }),
  );
  const raw = resp.Payload ? Buffer.from(resp.Payload).toString() : '';
  if (resp.FunctionError) {
    throw new Error(`data-plane '${op}' FunctionError=${resp.FunctionError}: ${raw.slice(0, 300)}`);
  }
  return (raw ? JSON.parse(raw) : null) as T;
}

/**
 * Fire-and-forget variant: `Event` invocation, so it returns as soon as Lambda ACCEPTS the payload
 * rather than waiting for the work. Used by side-effect ops on the reply path, where the caller
 * must not pay the data plane's latency (a Bedrock summarization is seconds) and must not fail the
 * user's turn if the data plane is unavailable. No result is available by construction.
 */
async function invokeAsync(op: Op, input: unknown): Promise<void> {
  const arn = dataPlaneArn();
  if (!arn) {
    throw new Error(`AURORA_DATA_PLANE_ARN unset; cannot run '${op}'`);
  }
  await lambda.send(
    new InvokeCommand({
      FunctionName: arn,
      InvocationType: 'Event',
      Payload: Buffer.from(envelope(op, input)),
    }),
  );
}

/** Retrieval — degrades to honest-empty on failure. */
export async function retrieveContext(
  input: RetrieveContextInput,
): Promise<RetrieveContextResult> {
  try {
    return await invoke<RetrieveContextResult>('retrieve', input);
  } catch (err) {
    console.warn('[data-plane-client] retrieve failed (non-fatal):', err);
    return { chunks: [], citations: [], signalAvailable: false };
  }
}

/** Drift detection — degrades to a no-fire result on failure. */
export async function detectDrift(input: DetectDriftInput): Promise<DriftResult> {
  try {
    return await invoke<DriftResult>('detectDrift', input);
  } catch (err) {
    console.warn('[data-plane-client] detectDrift failed (non-fatal):', err);
    return {
      isDrift: false,
      driftScore: 0,
      suggestedAction: 'continue',
      confidence: 'low',
      signalAvailable: false,
      correlationId: input.correlationId ?? '',
    };
  }
}

/**
 * Question 3 of a deferred `detectDrift`. Degrades to the offer as it stood, without the pending
 * embedding: a failed lookup costs the redirect, never the offer.
 */
export async function resolveDriftRival(input: ResolveDriftRivalInput): Promise<DriftResult> {
  try {
    return await invoke<DriftResult>('resolveDriftRival', input);
  } catch (err) {
    console.warn('[data-plane-client] resolveDriftRival failed (non-fatal):', err);
    const { relatedLookupPending: _pending, ...offer } = input.result;
    return offer;
  }
}

/** Best-effort drift-fire record — returns '' (no event id) on failure. */
export async function recordDriftFire(input: RecordDriftInput): Promise<string> {
  try {
    return await invoke<string>('recordDriftFire', input);
  } catch (err) {
    console.warn('[data-plane-client] recordDriftFire failed (non-fatal):', err);
    return '';
  }
}

/** Best-effort drift-outcome record — swallows failure. */
export async function recordDriftOutcome(input: {
  eventId: string;
  outcome: 'declined' | 'rejected_in_new_channel' | 'accepted';
  newChannelArn?: string;
}): Promise<void> {
  try {
    await invoke<unknown>('recordDriftOutcome', input);
  } catch (err) {
    console.warn('[data-plane-client] recordDriftOutcome failed (non-fatal):', err);
  }
}

/**
 * A declined drift offer's subject becomes a topic of the conversation (migration 044). Degrades to
 * `adopted: false` on failure: the decline itself still stands, and the cost is that this one subject
 * may be offered again later.
 */
export async function adoptOfferedTopic(input: {
  channelArn: string;
  correlationId: string;
}): Promise<{ adopted: boolean }> {
  try {
    return (await invoke<{ adopted: boolean } | null>('adoptOfferedTopic', input)) ?? { adopted: false };
  } catch (err) {
    console.warn('[data-plane-client] adoptOfferedTopic failed (non-fatal):', err);
    return { adopted: false };
  }
}

/** Latest running summary for a channel (ADR-017: summary as consumable context).
 *  Returns null on failure or when the conversation has no summary yet. */
export async function getLatestSummary(channelArn: string): Promise<string | null> {
  try {
    return await invoke<string | null>('getSummary', { channelArn });
  } catch (err) {
    console.warn('[data-plane-client] getSummary failed (non-fatal):', err);
    return null;
  }
}

/**
 * Seed a conversation's first summary from its opening exchange, giving drift an anchor from turn
 * one instead of leaving it unable to fire until the scheduled summariser runs.
 *
 * The summarization itself is asynchronous (`Event` invoke), so the caller does NOT wait for
 * Bedrock - but the returned promise MUST still be awaited. An async Lambda freezes the instant its
 * handler resolves, so an un-awaited SDK call is frequently suspended before the request is even
 * sent (the same trap documented on the first-turn title rename). Awaiting costs only the
 * milliseconds Lambda takes to ACCEPT the payload, and guarantees the seed is actually dispatched.
 *
 * Never throws: a failed seed leaves the scheduled scan to write the summary later, which is exactly
 * the behavior that existed before this - so the worst case is the old behavior, never a lost reply.
 *
 * Safe to call on ANY turn: the data-plane side no-ops when a summary already exists, so the caller
 * does not have to know whether this turn was genuinely the conversation's first.
 */
export async function seedConversationSummary(input: {
  channelArn: string;
  userMessage: string;
  assistantReply: string;
}): Promise<void> {
  if (!hasDataPlane()) return;
  try {
    await invokeAsync('seedSummary', input);
  } catch (err) {
    console.warn('[data-plane-client] seedSummary failed (non-fatal):', err);
  }
}

/**
 * Record a SPLIT-OUT conversation's topic as its first summary, at creation.
 *
 * The one conversation whose subject is known before it has any messages: the person was offered a
 * separate conversation for a topic and accepted. Writing it now means drift in the new conversation
 * compares against the topic it was created for, rather than against a seed built from its own first
 * message - which drift treats as no topic at all.
 *
 * Async and non-fatal, like the turn-one seed. The conversation exists either way; losing this costs
 * the new conversation its drift anchor until the scheduled summariser catches up.
 */
export async function seedDriftTopicSummary(input: {
  channelArn: string;
  topicLabel: string;
  originatingMessageText?: string;
}): Promise<void> {
  if (!hasDataPlane()) return;
  try {
    await invokeAsync('seedDriftTopic', input);
  } catch (err) {
    console.warn('[data-plane-client] seedDriftTopic failed (non-fatal):', err);
  }
}

// ---------------------------------------------------------------------------
// Pending-drift-suggestion task lifecycle (conversation_creation_tasks).
// Open on detect, read to RESUME on a later turn, close on confirm/decline.
// Runs via the data plane so the non-VPC handler can persist durable drift
// state (ADR-013) — a direct query() here fails with DB_SECRET_ARN.
// ---------------------------------------------------------------------------

/** Open a pending suggestion. Degrades to a stub (taskId='') on failure: the offer is still shown,
 *  but nothing records it, so its answer is read as an ordinary message. */
export async function savePendingSuggestion(input: SavePendingInput): Promise<PendingSuggestion> {
  try {
    return await invoke<PendingSuggestion>('savePendingSuggestion', input);
  } catch (err) {
    console.warn('[data-plane-client] savePendingSuggestion failed (non-fatal):', err);
    return { taskId: '', createdAt: '', ...input };
  }
}

/** The open drift offer for (user, channel), read at the start of every drift turn. Returns null on
 *  failure or when there is none, and the turn then proceeds as one with no offer open. */
export async function readPendingSuggestion(input: {
  personId: string;
  channelArn: string;
}): Promise<PendingSuggestion | null> {
  try {
    return await invoke<PendingSuggestion | null>('readPendingSuggestion', input);
  } catch (err) {
    console.warn('[data-plane-client] readPendingSuggestion failed (non-fatal):', err);
    return null;
  }
}

/** Close a pending suggestion. Best-effort — swallows failure (the outcome
 *  telemetry is non-critical to the user's turn). */
export async function resolvePendingSuggestion(input: {
  taskId: string;
  outcome: 'confirmed' | 'declined' | 'expired';
}): Promise<void> {
  try {
    await invoke<unknown>('resolvePendingSuggestion', input);
  } catch (err) {
    console.warn('[data-plane-client] resolvePendingSuggestion failed (non-fatal):', err);
  }
}

// Admin Conversations reads (Aurora mode). Unlike the drift/retrieval wrappers
// these PROPAGATE errors so the admin handler can surface an archiveError to the
// console rather than silently returning empty (a read failure is user-visible).
export interface AdminConvPage {
  conversations: AdminConvSummary[];
  total: number;
}
export async function adminListConversations(
  limit?: number,
  offset?: number,
  allowedClassifications?: string[] | null,
  channelArn?: string | null,
  memberArns?: string[] | null,
): Promise<AdminConvPage> {
  return invoke<AdminConvPage>('adminListConversations', { limit, offset, allowedClassifications, channelArn, memberArns });
}
export async function adminListMessages(channelArn: string): Promise<AdminConvMessage[]> {
  return invoke<AdminConvMessage[]>('adminListMessages', { channelArn });
}
export async function adminMembershipHistory(channelArn: string): Promise<AdminMembershipEvent[]> {
  return invoke<AdminMembershipEvent[]>('adminMembershipHistory', { channelArn });
}

// THE DE-IDENTIFIED COPY (DESIGN-ADMIN-CONSOLE 5.3). Each propagates its error: the batch reports a
// failed run, and the console read reports an unreadable copy, rather than either passing for empty.
export async function cleanCopyPending(limit: number, derivation?: string): Promise<{ pending: PendingConversation[]; total: number }> {
  return invoke('cleanCopyPending', { limit, derivation });
}
export async function cleanCopySource(channelArn: string): Promise<{ rows: SourceRow[]; classification: string | null }> {
  return invoke('cleanCopySource', { channelArn });
}
export async function cleanCopyWrite(input: {
  channelArn: string; rows: CleanRow[]; sourceRows: number; sourceLatest: string | null; classification: string | null; detector: string;
}): Promise<{ written: number }> {
  return invoke('cleanCopyWrite', input);
}
export async function cleanCopyRecordRun(input: {
  startedAt: string; outcome: 'complete' | 'incomplete' | 'failed'; conversations: number; remaining: number | null; failure: string | null;
}): Promise<{ recorded: boolean }> {
  return invoke('cleanCopyRecordRun', input);
}
export async function adminCleanConversation(channelArn: string): Promise<CleanConversation> {
  return invoke('adminCleanConversation', { channelArn });
}

/** Aurora-mode client-events ingest (#A). Propagates errors so the /events handler
 *  can report a delivery failure. */
export async function ingestClientEvents(records: unknown[]): Promise<{ inserted: number }> {
  return invoke<{ inserted: number }>('ingestClientEvents', { records });
}

/**
 * Offboarding's erasure of a person's own rows in the Aurora projection (`analytics-aurora/person-erasure.ts`).
 * Propagates errors, so a failed erasure stops the offboarding before the identity is touched.
 */
export async function erasePersonProjection(personId: string): Promise<{ removed: number; byTable: Record<string, number> }> {
  return invoke<{ removed: number; byTable: Record<string, number> }>('erasePerson', { personId });
}
