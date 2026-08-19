/**
 * Retrieval + drift DATA-PLANE Lambda (ADR-013).
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

import { ensureSchema } from './db-client.js';
import { retrieveContext } from './document-retrieval.js';
import {
  detectDrift,
  recordDriftFire,
  recordDriftOutcome,
  getLatestSummary,
} from './drift-detection.js';
// The first-turn summary seed. Runs HERE because the write, the Bedrock summarisation, and the
// embedding are all Aurora-side work; the non-VPC caller only supplies the exchange text.
import { seedSummaryFromExchange } from './summary-updater.js';
// The pending-drift-suggestion task lifecycle (open/read/close) is Aurora work
// too, so it runs HERE — not in the non-VPC handler, where a direct query() has
// no DB access (`DB_SECRET_ARN not configured`). ADR-013 consistency.
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
// Turn-event ledger: the backfill that proves the event shape against real history, and the
// derivation comparison the rollout's go/no-go depends on. Aurora work, so it belongs on this seam.
import {
  backfillTurnEvents,
  compareLatencyDerivations,
  type TurnEventsBackfillOptions,
} from './turn-events-backfill.js';
// Admin Conversations read path (Aurora): the Athena archive query is too slow
// (15-27s > API Gateway's 29s cap), so in Aurora mode the admin handler reads
// these via this Lambda instead. Aurora work → runs here (ADR-013). See BUG #21.
import {
  adminListConversations,
  adminListMessages,
  adminMembershipHistory,
} from './admin-conversations-aurora.js';
// Client-events ingest (Aurora mode has no Firehose pipeline; /events writes here
// via the data-plane so the Overview session/user/WebSocket rollups populate). #A.
import { ingestClientEvents, type ClientEventRecord } from './client-events-ingest.js';
// The classification shadow gate (DESIGN §5). Aurora AND Bedrock, in the VPC — the combination this
// Lambda exists for. It is deliberately OFF the request path: a classifier comparison must never
// spend a user's latency, so the admin console starts a run here and reads the result later.
import {
  openClassifierReplay,
  executeClassifierReplay,
  listReplayLabels,
  adjudicateReplayLabel,
  getReplayRun,
  listReplayRuns,
  type StartReplayInput,
  type AdjudicateInput,
} from './classifier-replay.js';
// ADR-028. The classification a channel carries is an Amazon Chime SDK tag, and this VPC has no route
// to Chime (natGateways: 0, and no Chime endpoint) - so the read happens outside and lands here.
// `verifyClassificationBoundary` is the ADR's owed proof, run against the real database because that
// is the only place FORCE ROW LEVEL SECURITY and `current_user` actually mean anything.
import { recordChannelClassifications, type ChannelClassificationRecord } from './channel-classification.js';
import { verifyClassificationBoundary } from './classification-boundary-verify.js';

/** The request envelope the client sends. `input` is the op's own input type. */
export interface DataPlaneRequest {
  op:
    | 'retrieve'
    | 'detectDrift'
    | 'recordDriftFire'
    | 'recordDriftOutcome'
    | 'getSummary'
    | 'seedSummary'
    | 'savePendingSuggestion'
    | 'readPendingSuggestion'
    | 'resolvePendingSuggestion'
    | 'backfillPlaceholders'
    | 'backfillProfileAttribution'
    | 'backfillTurnEvents'
    | 'compareLatencyDerivations'
    | 'adminListConversations'
    | 'adminListMessages'
    | 'adminMembershipHistory'
    | 'ingestClientEvents'
    | 'openClassifierReplay'
    | 'executeClassifierReplay'
    | 'listClassifierReplays'
    | 'getClassifierReplay'
    | 'setChannelClassifications'
    | 'verifyClassificationBoundary'
    | 'listClassifierReplayLabels'
    | 'adjudicateClassifierLabel';
  input: unknown;
}

/**
 * Dispatch. Returns the underlying function's result as-is (serialized by the
 * Lambda runtime). A thrown error surfaces to the caller as a Lambda
 * FunctionError, which the client treats as an infra failure and degrades from
 * (honest-empty retrieval, no-fire drift). Keep this thin: no business logic.
 */
export async function handler(req: DataPlaneRequest): Promise<unknown> {
  // Apply any pending migration before dispatching, exactly as the other two DB Lambdas do
  // (`analytics-query.ts`, `kinesis-archival.ts`). Memoized per instance, so this is one no-op check
  // per cold start on the hot path.
  //
  // WITHOUT THIS, A MIGRATION NEVER REACHES THIS PATH. `schema-init` bootstraps on Create only and can
  // never reconnect afterwards, so runtime application is the ONLY way a new `schema/NNN-*.sql` lands
  // on an existing cluster - and it happens where `ensureSchema` is called, not where the file is
  // bundled. This Lambda bundles the schema and had no call, so a data-plane op that needed a new
  // table failed with `relation "..." does not exist` on a deploy that reported complete success.
  // Observed exactly that way with `turn_events` (migration 019).
  await ensureSchema();
  switch (req?.op) {
    case 'retrieve':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return retrieveContext(req.input as any);
    case 'detectDrift': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const input = req.input as any;
      // ADR-028: keep the classification projection fresh from the one caller that knows the answer
      // authoritatively. The router resolved this channel's classification from its immutable Chime
      // tag on the way in; nothing inside this VPC can, so without a live turn writing it down the
      // projection would only ever be as current as the last bulk backfill.
      //
      // HERE AND NOT INSIDE `detectDrift`, because a detector that writes to a table as a side effect
      // is a detector nobody expects to have written anything. Recorded before the detection runs so
      // a drift failure does not also cost the classification. Best-effort: this is a cache refresh,
      // and failing it must not fail the turn.
      if (input?.channelArn && input?.classification) {
        try {
          await recordChannelClassifications([
            { channelArn: input.channelArn, classification: input.classification, source: 'router' },
          ]);
        } catch (err) {
          console.warn('[data-plane] channel classification refresh failed (non-fatal):', err);
        }
      }
      return detectDrift(input);
    }
    case 'recordDriftFire':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return recordDriftFire(req.input as any);
    case 'recordDriftOutcome':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await recordDriftOutcome(req.input as any);
      return { ok: true };
    case 'getSummary':
      return getLatestSummary((req.input as { channelArn: string }).channelArn);
    case 'seedSummary':
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return seedSummaryFromExchange(req.input as any);
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
    case 'backfillTurnEvents':
      return backfillTurnEvents((req.input as TurnEventsBackfillOptions) || {});
    case 'compareLatencyDerivations':
      return compareLatencyDerivations((req.input as { days?: number })?.days ?? 7);
    case 'backfillProfileAttribution':
      return backfillProfileAttribution((req.input as ProfileBackfillInput) || { attribution: {} });
    case 'adminListConversations': {
      const i = (req.input as { limit?: number; offset?: number; allowedClassifications?: string[] | null }) || {};
      return adminListConversations(i.limit, i.offset, i.allowedClassifications ?? null);
    }
    case 'adminListMessages':
      return adminListMessages((req.input as { channelArn: string }).channelArn);
    case 'adminMembershipHistory':
      return adminMembershipHistory((req.input as { channelArn: string }).channelArn);
    case 'ingestClientEvents':
      return ingestClientEvents((req.input as { records: ClientEventRecord[] }).records);
    // Two ops, not one, because the work outlives an API request (see openClassifierReplay). The
    // console opens a run synchronously and gets an id back; the execute is invoked as an Event and
    // may take minutes.
    case 'openClassifierReplay':
      return openClassifierReplay(req.input as StartReplayInput);
    case 'executeClassifierReplay': {
      const i = req.input as { runId: string; limit?: number };
      return executeClassifierReplay(i.runId, i.limit);
    }
    case 'listClassifierReplays':
      return listReplayRuns((req.input as { experimentId?: string })?.experimentId);
    case 'getClassifierReplay':
      return getReplayRun((req.input as { runId: string }).runId);
    case 'listClassifierReplayLabels': {
      const i = req.input as { runId: string; pendingOnly?: boolean; limit?: number; offset?: number };
      return listReplayLabels(i.runId, { pendingOnly: i.pendingOnly, limit: i.limit, offset: i.offset });
    }
    case 'setChannelClassifications': {
      const i = req.input as { records: ChannelClassificationRecord[] };
      return recordChannelClassifications(i?.records ?? []);
    }
    case 'verifyClassificationBoundary':
      return verifyClassificationBoundary();
    case 'adjudicateClassifierLabel':
      return adjudicateReplayLabel(req.input as AdjudicateInput);
    default:
      throw new Error(`[data-plane] unknown op: ${String(req?.op)}`);
  }
}
