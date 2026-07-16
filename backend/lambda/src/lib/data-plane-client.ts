/**
 * Client seam for the retrieval + drift DATA-PLANE Lambda (project decision 018).
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
} from '../analytics-aurora/drift-detection.js';
import type { PendingSuggestion, SuggestionKind } from './routing-state.js';
import type {
  AdminConvSummary,
  AdminConvMessage,
  AdminMembershipEvent,
} from '../analytics-aurora/admin-conversations-aurora.js';

export type {
  RetrieveContextInput,
  RetrieveContextResult,
  DetectDriftInput,
  DriftResult,
  RecordDriftInput,
  PendingSuggestion,
  SuggestionKind,
};

/** Input for opening a pending-drift-suggestion task (mirrors routing-state). */
export interface SavePendingInput {
  channelArn: string;
  userSub: string;
  kind: SuggestionKind;
  rivalConversationArn?: string;
  originatingMessageId: string;
  cosineDistance?: number;
  correlationId: string;
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

const lambda = new LambdaClient({ region: AWS_REGION });

type Op = DataPlaneOp;
type DataPlaneOp =
  | 'retrieve'
  | 'detectDrift'
  | 'recordDriftFire'
  | 'recordDriftOutcome'
  | 'getSummary'
  | 'savePendingSuggestion'
  | 'readPendingSuggestion'
  | 'resolvePendingSuggestion'
  | 'adminListConversations'
  | 'adminListMessages'
  | 'adminMembershipHistory'
  | 'ingestClientEvents';

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
      Payload: Buffer.from(JSON.stringify({ op, input })),
    }),
  );
  const raw = resp.Payload ? Buffer.from(resp.Payload).toString() : '';
  if (resp.FunctionError) {
    throw new Error(`data-plane '${op}' FunctionError=${resp.FunctionError}: ${raw.slice(0, 300)}`);
  }
  return (raw ? JSON.parse(raw) : null) as T;
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

// ---------------------------------------------------------------------------
// Pending-drift-suggestion task lifecycle (conversation_creation_tasks).
// Open on detect, read to RESUME on a later turn, close on confirm/decline.
// Runs via the data plane so the non-VPC handler can persist durable drift
// state (ADR-018) — a direct query() here fails with DB_SECRET_ARN.
// ---------------------------------------------------------------------------

/** Open a pending suggestion. Degrades to a stub (taskId='') on failure — the
 *  session-attribute fast-path still carries the turn; only durable resume is
 *  lost. */
export async function savePendingSuggestion(input: SavePendingInput): Promise<PendingSuggestion> {
  try {
    return await invoke<PendingSuggestion>('savePendingSuggestion', input);
  } catch (err) {
    console.warn('[data-plane-client] savePendingSuggestion failed (non-fatal):', err);
    return { taskId: '', createdAt: '', ...input };
  }
}

/** Read the durable pending suggestion for (user, channel). Returns null on
 *  failure or when there is none — the resume path then simply doesn't fire. */
export async function readPendingSuggestion(input: {
  userSub: string;
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
export async function adminListConversations(limit?: number): Promise<AdminConvSummary[]> {
  return invoke<AdminConvSummary[]>('adminListConversations', { limit });
}
export async function adminListMessages(channelArn: string): Promise<AdminConvMessage[]> {
  return invoke<AdminConvMessage[]>('adminListMessages', { channelArn });
}
export async function adminMembershipHistory(channelArn: string): Promise<AdminMembershipEvent[]> {
  return invoke<AdminMembershipEvent[]>('adminMembershipHistory', { channelArn });
}

/** Aurora-mode client-events ingest (#A). Propagates errors so the /events handler
 *  can report a delivery failure. */
export async function ingestClientEvents(records: unknown[]): Promise<{ inserted: number }> {
  return invoke<{ inserted: number }>('ingestClientEvents', { records });
}
