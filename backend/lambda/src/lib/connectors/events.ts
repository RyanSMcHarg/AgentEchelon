/**
 * A RECEIVED VENDOR EVENT, AS A FACT ON THE DEFAULT BUS (`ae.connector`).
 *
 * The receiver publishes each accepted vendor event once, after its source matched the connector's declared
 * partner event source and its replay record was claimed, as an `ae.connector` event whose detail-type is `<vendor>.<event type>`. It names the connector,
 * the external record by reference (`ExternalRef`), the classification the connector declares, and the
 * people the event named who were resolved through `Identities` AND admitted at that classification (K2,
 * K4). People refused, undetermined or unresolved are counted, never named: nothing downstream may act for
 * someone admission did not admit.
 *
 * A different source from `ae.alert`, so the rule that posts alerts into the admin channel never matches
 * one. The rule that opens a room for an event (an incident opening an incident room) is **NOT BUILT**:
 * which conversation type an event opens is a product decision the type registry has not made.
 *
 * Throws when the bus refuses the entry, so the receiver releases its replay claim and throws in turn:
 * Lambda retries the invocation, and an event every retry fails lands in the receiver's dead-letter queue
 * instead of being lost.
 */
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import type { ExternalRef } from '../../../../lib/config/connectors.js';

type Sender = { send(command: unknown): Promise<any> };

export const CONNECTOR_SOURCE = 'ae.connector';

export interface ConnectorEventDetail {
  /** The instance that received it (`AE_INSTANCE_NAME`), so a rule matches its own instance only. */
  instance: string;
  connectorId: string;
  vendor: string;
  /** The vendor's event id, the replay key. */
  eventId: string;
  type: string;
  occurredAt: string;
  /** The classification the connector declares for the conversations its events concern. */
  classification: string;
  ref: ExternalRef;
  /** The people named, resolved and admitted, by AppInstanceUser ARN and role. */
  admitted: Array<{ role: string; personArn: string }>;
  /** How many were named and not admitted, by why. */
  notAdmitted: { refused: number; undetermined: number; unresolved: number; pending: number };
}

let defaultClient: Sender | null = null;

export async function publishConnectorEvent(detail: ConnectorEventDetail, client?: Sender): Promise<void> {
  const c = client ?? (defaultClient ??= new EventBridgeClient({ region: process.env.AWS_REGION || 'us-east-1' }));
  const out = await c.send(new PutEventsCommand({
    Entries: [{ Source: CONNECTOR_SOURCE, DetailType: `${detail.vendor}.${detail.type}`, Detail: JSON.stringify(detail) }],
  }));
  if (out?.FailedEntryCount) throw new Error(`the bus refused the connector event (${out.Entries?.[0]?.ErrorCode || 'unknown'})`);
}
