/**
 * ARCHIVAL HEALTH (G8, docs/guides/developer/LATENCY-TARGETS.md).
 *
 * Every latency number on the admin console is computed over rows that REACHED the analytics tables,
 * so a dropped archival record does not make a metric wrong - it makes it silently NARROWER. That is
 * the worse failure: an average over 90% of the traffic renders exactly like an average over all of
 * it, nothing on the dashboard moves, and the loss is discoverable only by someone who already
 * suspects it. The error count has been in an archival log line all along and could only be read by
 * grepping CloudWatch after the fact.
 *
 * Published as a metric because an alarm is the only monitoring that works for a failure nobody goes
 * looking for.
 *
 * ITS OWN MODULE, not an inline call in the archival path, for two reasons. The EMF schema guard
 * (`emf-schema.test.ts`) discovers every emitter in the tree and requires a caller that DRIVES it, so
 * an inline emitter inside a long transaction function is one no test can exercise without standing
 * up the whole batch. And CloudWatch rejects a malformed EMF document SILENTLY - the log line is
 * still written, everything looks healthy, and no metric is ever created - which has already cost
 * this repo months of a metric that never materialised. A named function is a thing a test can call.
 */

import { emitEmfMetric } from '../lib/emf-metrics.js';

/**
 * Archival health. Its own namespace rather than a dimension on an existing one: this measures
 * whether the ANALYTICS PIPELINE is intact, which is a different question from anything a product
 * metric answers, and an operator alarming on data loss should not have to know which feature's
 * namespace it was filed under.
 */
export const ARCHIVAL_METRIC_NAMESPACE = 'AgentEchelon/Archival';

/**
 * Publish one batch's archival outcome.
 *
 * BOTH SERIES, deliberately. `RecordErrors` alone is unreadable - twelve errors is a catastrophe on a
 * batch of twenty and noise on a batch of ten thousand - so the denominator is published beside it
 * and the alarm can be written on the ratio.
 *
 * DIMENSIONLESS, like the task-answer-repair series and for the same reason: EMF dimension sets are
 * distinct metrics, so an alarm over a dimensionless series that nothing publishes without dimensions
 * could structurally never fire.
 *
 * NEVER THROWS. Measurement must not cost the archive - the same contract the ledger write already
 * holds - so a failure here is swallowed rather than failing the batch carrying the messages.
 */
export function emitArchivalHealth(args: { archived: number; errors: number }): void {
  try {
    emitEmfMetric({
      namespace: ARCHIVAL_METRIC_NAMESPACE,
      metrics: [
        { name: 'RecordsArchived', unit: 'Count' },
        { name: 'RecordErrors', unit: 'Count' },
      ],
      dimensionSets: [[]],
      properties: { RecordsArchived: args.archived, RecordErrors: args.errors },
    });
  } catch {
    // Measurement must never cost the archive.
  }
}
