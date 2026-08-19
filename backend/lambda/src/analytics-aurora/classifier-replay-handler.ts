/**
 * The classification shadow gate's BATCH Lambda (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §5.2).
 *
 * Its own function, for one reason: this work does not fit anywhere else. A replay is hundreds of
 * paired model calls and runs for minutes, while `DataPlaneLambda` is capped at 15 seconds because it
 * serves the per-turn request path, and the analytics API has an API Gateway request behind it. Both
 * of those timeouts are guards worth keeping, so the batch job gets a function whose timeout can be
 * measured in minutes without weakening either.
 *
 * Invoked as an `Event` by the non-VPC starter (`classifier-replay-start.ts`), which has already
 * minted the run id and returned it, so the console has something to poll from the moment an operator
 * clicks. Nothing here is on a user's path: a classifier comparison must never spend somebody's
 * latency.
 *
 * **This function opens the run as well as executing it**, because the starter cannot: the database
 * lives in the VPC and the starter is deliberately outside it (an in-VPC function cannot invoke this
 * one at all — the Lambda control plane is unreachable from the isolated subnets, with no NAT and no
 * interface endpoint). So the two halves split along the network boundary rather than along the work:
 * outside answers the click, inside touches the database.
 */

import { ensureSchema } from './db-client.js';
import { executeClassifierReplay, openClassifierReplay, type StartReplayInput } from './classifier-replay.js';

export interface ClassifierReplayEvent {
  /** The run to execute. With `open`, the id to open it UNDER; without, a run that already exists. */
  runId: string;
  /** Message cap for this execution. The run's window is read from the run itself. */
  limit?: number;
  /**
   * Open the run here before executing it. Present when the starter minted the id but had no way to
   * write the row. Absent for an already-open run (a re-execute, or an in-VPC caller).
   */
  open?: Omit<StartReplayInput, 'runId'>;
}

export async function handler(event: ClassifierReplayEvent) {
  const runId = (event?.runId || '').trim();
  if (!runId) throw new Error('[classifier-replay] runId is required');

  // Apply any pending migration first - see `summary-updater.ts` for why bundling the schema is not
  // enough. Memoized per instance; pinned by `db-lambdas-apply-migrations.test.ts`.
  await ensureSchema();

  if (event.open) {
    // A failure HERE cannot be recorded on the run — there is no run yet — so it is logged loudly and
    // rethrown. The console polling this id sees a row that never appears, which is the honest signal:
    // nothing was replayed. Recording a phantom `failed` row would be worse, since the gate reads a
    // failed run as "this window produced no evidence" rather than "this request was never valid".
    try {
      await openClassifierReplay({ ...event.open, runId });
    } catch (e) {
      console.error('[classifier-replay] could not open run', runId, e);
      throw e;
    }
  }

  console.log('[classifier-replay] executing run', runId, 'limit', event.limit ?? 'default');
  // Errors are recorded ON THE RUN by executeClassifierReplay, which is what the console reads. A
  // throw here would only reach the Lambda's async retry, which would re-run the whole window; the
  // recorded failure is the honest signal, so the run's own status is the report.
  const result = await executeClassifierReplay(runId, event.limit);
  console.log('[classifier-replay] run', runId, 'finished:', {
    status: result.status,
    considered: result.messagesConsidered,
    replayed: result.messagesReplayed,
    retracted: result.messagesRetracted,
    fastPath: result.messagesFastPath,
  });
  return result;
}
