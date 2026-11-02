/**
 * THE VENDOR ADAPTERS: what one vendor event, as EventBridge delivered it, says in the platform's terms.
 *
 * An adapter moves bytes and nothing else (§19.2, "adapters move bytes; core resolves people"). It reads a
 * vendor's event from its EventBridge envelope into a `VendorEvent`: the vendor's own event id (the replay
 * key), its type, when it happened, the record it concerns, and the people it names BY THE VENDOR'S
 * IMMUTABLE USER ID. It never reads an email address, a name or a phone number to identify anyone: who a
 * vendor user is gets decided once, in core, through `Identities` (`lib/connector-participants.ts`, K2).
 *
 * One adapter per built vendor (`VENDORS` in `lib/config/connectors.ts`), chosen by the connector's
 * declared vendor through this table. Nothing else in the runtime names a vendor. The receiver has already
 * matched the envelope's `source` to the connector's declared partner event source before an adapter runs.
 *
 * THE VENDOR EVENT ID is the vendor's own id for the event, never the envelope's `id` when the vendor
 * gives one: EventBridge keeps its `id` across its own retries, but a vendor that resends an event (the
 * Salesforce relay resuming after an outage) puts it on the bus again under a new envelope id. Only when
 * the vendor's detail carries no id does the envelope's stand in.
 */
import type { ExternalRef } from '../../../../lib/config/connectors.js';

/** The EventBridge envelope the receiver is invoked with, as far as an adapter reads it. */
export interface PartnerEvent {
  id?: string;
  source?: string;
  'detail-type'?: string;
  time?: string;
  detail?: unknown;
}

/** A person the vendor names, by its own immutable id, in the role the event gives them. */
export interface VendorPerson {
  role: string;
  /** The subject under the connector's `Identities` namespace. Never an address. */
  subject: string;
}

export interface VendorEvent {
  /** The vendor's id for this event: the replay key. */
  eventId: string;
  type: string;
  /** ISO 8601. */
  occurredAt: string;
  ref: Omit<ExternalRef, 'connectorId' | 'system'>;
  people: VendorPerson[];
}

/** An event the adapter cannot read: the receiver records nothing and drops it (a retry reads it no better). */
export class UnreadableEvent extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'UnreadableEvent';
  }
}

export interface VendorAdapter {
  read(event: PartnerEvent): VendorEvent;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const PAGERDUTY_ID = /^P[A-Z0-9]{5,13}$/;
const SALESFORCE_ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

/** A time as ISO 8601: an ISO string, or epoch milliseconds (a Salesforce commit timestamp). */
function isoOf(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  const s = str(v);
  return s && Number.isFinite(Date.parse(s)) ? s : null;
}

/**
 * PagerDuty, through its Amazon EventBridge integration: `detail-type` is `PagerDuty Webhook` and the
 * detail is one webhook message, `{ id, event, created_on, incident: { id, html_url, assignments: [{
 * assignee: { id } }] } }`. An assignee is named by their PagerDuty user id; `summary` (a display name)
 * and any address are never read.
 */
const pagerduty: VendorAdapter = {
  read(event) {
    const detail = obj(event.detail);
    const type = str(detail.event);
    const incident = obj(detail.incident);
    const recordId = str(incident.id);
    const eventId = str(detail.id) ?? str(event.id);
    const occurredAt = isoOf(detail.created_on) ?? isoOf(event.time);
    if (!eventId || !type || !occurredAt || !recordId) throw new UnreadableEvent('the event names no id, type, time or incident');
    const people: VendorPerson[] = [];
    for (const a of Array.isArray(incident.assignments) ? incident.assignments : []) {
      const id = str(obj(obj(a).assignee).id);
      if (id && PAGERDUTY_ID.test(id)) people.push({ role: 'assignee', subject: id });
    }
    const url = str(incident.html_url);
    return { eventId, type, occurredAt, ref: { recordId, ...(url ? { url } : {}) }, people };
  },
};

/**
 * Salesforce, through Event Relay: the source is `aws.partner/salesforce.com/<organization id>/<relay id>`,
 * the `detail-type` is the relayed event's API name, and the detail is `{ id, payload, schemaId }`, where
 * `id` is the event's UUID.
 *
 *  - A Change Data Capture event (`<Object>ChangeEvent`): the record is
 *    `payload.ChangeEventHeader.recordIds[0]`, the time its `commitTimestamp`, and the owner `payload.OwnerId`,
 *    which a create carries and an update carries only when the owner changed.
 *  - A Platform Event (`<Name>__e`): the fields are the org's own, so the connector reads the two it
 *    defines for them, `RecordId__c` and `OwnerId__c`, and the time from `CreatedDate`.
 *
 * The owner is named by org and user id together (`<organizationId>:<userId>`), the subject a
 * Salesforce-signed sign-in carries (V8); the org is the one the partner event source names, never a field
 * of the payload. A `commitUser` (who made the change) names nobody.
 */
const salesforce: VendorAdapter = {
  read(event) {
    const type = str(event['detail-type']);
    const detail = obj(event.detail);
    const payload = obj(detail.payload);
    const header = obj(payload.ChangeEventHeader);
    const isChange = !!type && /ChangeEvent$/.test(type);
    const recordIds = Array.isArray(header.recordIds) ? header.recordIds : [];
    const recordId = isChange ? str(recordIds[0]) : str(payload.RecordId__c);
    const ownerId = isChange ? str(payload.OwnerId) : str(payload.OwnerId__c);
    const eventId = str(detail.id) ?? str(payload.EventUuid) ?? str(event.id);
    const occurredAt = (isChange ? isoOf(header.commitTimestamp) : isoOf(payload.CreatedDate)) ?? isoOf(event.time);
    if (!eventId || !type || !occurredAt || !recordId) throw new UnreadableEvent('the event names no id, type, time or record');
    const org = String(event.source ?? '').split('/')[2] ?? '';
    const people: VendorPerson[] = [];
    if (SALESFORCE_ID.test(org) && ownerId && SALESFORCE_ID.test(ownerId)) people.push({ role: 'owner', subject: `${org}:${ownerId}` });
    return { eventId, type, occurredAt, ref: { recordId }, people };
  },
};

export const ADAPTERS: Readonly<Record<'pagerduty' | 'salesforce', VendorAdapter>> = { pagerduty, salesforce };
