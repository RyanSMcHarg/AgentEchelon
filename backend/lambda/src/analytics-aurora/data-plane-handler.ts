/**
 * Retrieval + drift DATA-PLANE Lambda (project decision 018).
 *
 * The Aurora-and-Bedrock work for the live request path lives here, in one
 * VPC-attached Lambda, so the Lex-facing agent handler can stay OUT of the VPC
 * (it would otherwise hang on SSM / Cognito / Lambda-invoke calls that have no
 * endpoint in the isolated subnets). The non-VPC handler invokes this Lambda
 * synchronously via `lib/data-plane-client.ts`.
 *
 * This module adds only a dispatch entry point; the underlying functions
 * (`retrieveContext`, `detectDrift`, `recordDriftFire`, `recordDriftOutcome`)
 * are the existing, unchanged implementations that talk to Aurora through
 * `db-client.ts` (RDS Proxy, IAM auth). Because THIS Lambda is VPC-attached with
 * DB env + Titan-embed IAM, `pg` and the DB client are bundled here (and only
 * here) — the caller bundle stays free of them via `import type`.
 */

import { retrieveContext } from './document-retrieval.js';
import {
  detectDrift,
  recordDriftFire,
  recordDriftOutcome,
  getLatestSummary,
} from './drift-detection.js';
// The pending-drift-suggestion task lifecycle (open/read/close) is Aurora work
// too, so it runs HERE — not in the non-VPC handler, where a direct query() has
// no DB access (`DB_SECRET_ARN not configured`). ADR-018 consistency.
import {
  savePendingSuggestion,
  readPendingSuggestion,
  resolvePendingSuggestion,
} from '../lib/routing-state.js';
// One-time analytics maintenance (placeholder->final historical reconciliation)
// also runs here — it is Aurora work, and this is the only VPC-attached seam.
import {
  backfillPlaceholders,
  type BackfillOptions,
} from './placeholder-backfill.js';
import { backfillProfileAttribution, type ProfileBackfillInput } from './profile-backfill.js';
// Admin Conversations read path (Aurora): the Athena archive query is too slow
// (15-27s > API Gateway's 29s cap), so in Aurora mode the admin handler reads
// these via this Lambda instead. Aurora work → runs here (ADR-018). See BUG #21.
import {
  adminListConversations,
  adminListMessages,
  adminMembershipHistory,
} from './admin-conversations-aurora.js';
// Client-events ingest (Aurora mode has no Firehose pipeline; /events writes here
// via the data-plane so the Overview session/user/WebSocket rollups populate). #A.
import { ingestClientEvents, type ClientEventRecord } from './client-events-ingest.js';

/** The request envelope the client sends. `input` is the op's own input type. */
export interface DataPlaneRequest {
  op:
    | 'retrieve'
    | 'detectDrift'
    | 'recordDriftFire'
    | 'recordDriftOutcome'
    | 'getSummary'
    | 'savePendingSuggestion'
    | 'readPendingSuggestion'
    | 'resolvePendingSuggestion'
    | 'backfillPlaceholders'
    | 'backfillProfileAttribution'
    | 'adminListConversations'
    | 'adminListMessages'
    | 'adminMembershipHistory'
    | 'ingestClientEvents';
  input: unknown;
}

/**
 * Dispatch. Returns the underlying function's result as-is (serialized by the
 * Lambda runtime). A thrown error surfaces to the caller as a Lambda
 * FunctionError, which the client treats as an infra failure and degrades from
 * (honest-empty retrieval, no-fire drift). Keep this thin: no business logic.
 */
export async function handler(req: DataPlaneRequest): Promise<unknown> {
  switch (req?.op) {
    case 'retrieve':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return retrieveContext(req.input as any);
    case 'detectDrift':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return detectDrift(req.input as any);
    case 'recordDriftFire':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return recordDriftFire(req.input as any);
    case 'recordDriftOutcome':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await recordDriftOutcome(req.input as any);
      return { ok: true };
    case 'getSummary':
      return getLatestSummary((req.input as { channelArn: string }).channelArn);
    case 'savePendingSuggestion':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return savePendingSuggestion(req.input as any);
    case 'readPendingSuggestion':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return readPendingSuggestion(req.input as any);
    case 'resolvePendingSuggestion':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await resolvePendingSuggestion(req.input as any);
      return { ok: true };
    case 'backfillPlaceholders':
      return backfillPlaceholders((req.input as BackfillOptions) || {});
    case 'backfillProfileAttribution':
      return backfillProfileAttribution((req.input as ProfileBackfillInput) || { attribution: {} });
    case 'adminListConversations':
      return adminListConversations((req.input as { limit?: number })?.limit);
    case 'adminListMessages':
      return adminListMessages((req.input as { channelArn: string }).channelArn);
    case 'adminMembershipHistory':
      return adminMembershipHistory((req.input as { channelArn: string }).channelArn);
    case 'ingestClientEvents':
      return ingestClientEvents((req.input as { records: ClientEventRecord[] }).records);
    default:
      throw new Error(`[data-plane] unknown op: ${String(req?.op)}`);
  }
}
