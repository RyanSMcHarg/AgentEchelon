/**
 * THE CONNECTOR GRANT REVOKER (K3): offboarding's way to a person's vendor grants, and the daily backstop.
 *
 * Two callers, told apart by the event's shape:
 *  - OFFBOARDING (`lib/offboarding.ts`, the `connectorGrants` step) invokes it with `{ personId }`. Every
 *    grant the person holds is revoked at the vendor (retried with backoff), then deleted. The answer
 *    counts what was revoked and what is left `revoke-failed`; offboarding records both in its
 *    `offboarding` event. Only the offboarding role is granted the invoke.
 *  - THE SWEEP, an EventBridge schedule (`Scheduled Event`), retries every `revoke-failed` grant. One that
 *    has failed `MAX_SWEEP_ATTEMPTS` sweeps is deleted and raised as an `ae.alert`, so an operator
 *    revokes it at the vendor by hand.
 *
 * Never reached by a person: it has no route.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { KMSClient } from '@aws-sdk/client-kms';
import { runtimeConnectors } from '../../lib/config/connectors.js';
import { retryFailedRevocations, revokePersonGrants, type GrantDeps, type PersonRevocation, type SweepResult } from './lib/connector-grants.js';
import { oauthClient } from './lib/connectors/secrets.js';
import { adminNotice, postAdminNotice } from './lib/admin-notice.js';

const PERSON_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RevokerEvent = { personId: string } | { 'detail-type': 'Scheduled Event' };

export async function handleRevoker(
  event: RevokerEvent,
  deps: GrantDeps,
  alert: (personId: string, connectorId: string) => Promise<unknown> = raiseAbandoned,
): Promise<PersonRevocation | SweepResult> {
  if (event && 'personId' in event) {
    if (!PERSON_ID.test(String(event.personId))) throw new Error('connector-grant-revoker: personId is not a person id');
    const result = await revokePersonGrants(event.personId, deps);
    console.log(JSON.stringify({ _connectorGrants: 'offboarding', ...result }));
    return result;
  }
  if (event && (event as { 'detail-type'?: string })['detail-type'] === 'Scheduled Event') {
    const result = await retryFailedRevocations(deps);
    for (const a of result.abandoned) await alert(a.personId, a.connectorId);
    console.log(JSON.stringify({ _connectorGrants: 'sweep', revoked: result.revoked, failed: result.failed, abandoned: result.abandoned.length }));
    return result;
  }
  throw new Error('connector-grant-revoker: the event is neither an offboarding nor the schedule');
}

/** The operator's alert for a grant the vendor never revoked: the connector and the person id, nothing more. */
function raiseAbandoned(personId: string, connectorId: string): Promise<boolean> {
  return postAdminNotice(adminNotice({ name: 'connector-grant-unrevoked', values: { connector: connectorId, person: personId } },
    'connector_grant_unrevoked', { connectorId, personId }));
}

let defaults: GrantDeps | null = null;
function defaultDeps(): GrantDeps {
  if (defaults) return defaults;
  const region = process.env.AWS_REGION || 'us-east-1';
  defaults = {
    doc: DynamoDBDocumentClient.from(new DynamoDBClient({ region })),
    kms: new KMSClient({ region }),
    table: process.env.GRANTS_TABLE || '',
    keyArn: process.env.GRANTS_KEY_ARN || '',
    connectors: runtimeConnectors(process.env.CONNECTORS),
    oauthClient: (id) => oauthClient(id),
  };
  return defaults;
}

export const handler = (event: RevokerEvent): Promise<PersonRevocation | SweepResult> => handleRevoker(event, defaultDeps());
