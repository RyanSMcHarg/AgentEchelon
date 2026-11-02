/**
 * A CLASSIFICATION'S TURN DATA PLANE SERVES ONLY A TURN ROUTED TO THAT CLASSIFICATION.
 *
 * The data plane runs retrieval, drift and summaries inside the VPC, on its own role, for whoever
 * invokes it. A Lambda invoke carries no caller identity, so the data plane cannot tell which
 * assistant asked, and it used to believe the `classification` (and `channelArn`) the payload named:
 * a session of one classification could ask for another classification's retrieval scope, or for a
 * conversation's summary in a classification it never served.
 *
 * So each classification gets its own turn data plane, and IAM lets that classification's roles invoke
 * only theirs. This module is the code half:
 *
 * - the function is pinned to its classification by environment (`DATA_PLANE_CLASSIFICATION`), and a
 *   turn operation runs at that classification whatever the payload says, with the retrieval scope the
 *   registry grants it;
 * - every call names the routing record of the turn it serves (`routeId`), and the record must exist in
 *   this classification's routing table, which only the platform's routing services write;
 * - a channel-keyed operation is served only for the conversation that record names.
 *
 * Anything that is not a turn operation (backfills, admin reads, client events) is refused here; it runs
 * on the shared data plane, which no assistant session can invoke.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { readTurnRouting } from '../lib/turn-routing.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';

/** The operations a turn runs on its assistant's behalf. */
export const TURN_OPS: ReadonlySet<string> = new Set([
  'retrieve',
  'detectDrift',
  'resolveDriftRival',
  'recordDriftFire',
  'recordDriftOutcome',
  'adoptOfferedTopic',
  'getSummary',
  'seedSummary',
  'seedDriftTopic',
  'savePendingSuggestion',
  'readPendingSuggestion',
  'resolvePendingSuggestion',
]);

export class TurnBindingRefused extends Error {
  constructor(public readonly reason: string) {
    super(`the turn data plane refused the call: ${reason}`);
    this.name = 'TurnBindingRefused';
  }
}

let ddb: DynamoDBClient | null = null;

/**
 * The request as this classification's turn data plane will run it, or a refusal. Returns the request
 * unchanged when this function is the shared data plane (no `DATA_PLANE_CLASSIFICATION`).
 */
export async function bindTurnRequest<R extends { op?: string; input?: unknown; routeId?: string }>(
  req: R,
  deps: { ddb?: Pick<DynamoDBClient, 'send'>; env?: NodeJS.ProcessEnv } = {},
): Promise<R> {
  const env = deps.env ?? process.env;
  const classification = (env.DATA_PLANE_CLASSIFICATION || '').trim();
  if (!classification) return req;

  const op = req?.op || '';
  if (!TURN_OPS.has(op)) throw new TurnBindingRefused(`'${op}' is not a turn operation`);
  const routeId = typeof req.routeId === 'string' ? req.routeId : '';
  if (!routeId) throw new TurnBindingRefused('no routing record named');
  const table = env.TURN_ROUTING_TABLE || '';
  if (!table) throw new TurnBindingRefused('no routing table configured');

  const record = await readTurnRouting(deps.ddb ?? (ddb ??= new DynamoDBClient({})), table, routeId);
  if (!record) throw new TurnBindingRefused('the turn was not routed');
  if (record.classification !== classification) throw new TurnBindingRefused('the turn was routed to another classification');

  const input = { ...((req.input as Record<string, unknown>) || {}) };
  const channelArn = typeof input.channelArn === 'string' ? input.channelArn : '';
  if (channelArn && record.channelArn !== channelArn) {
    throw new TurnBindingRefused('the conversation is not the one the turn was routed in');
  }
  // THE CLASSIFICATION IS THIS FUNCTION'S, never the payload's. Retrieval's scope follows from it.
  input.classification = classification;
  if (op === 'retrieve') input.classificationScope = profiles.grantsFor(classification as never);
  return { ...req, input };
}
