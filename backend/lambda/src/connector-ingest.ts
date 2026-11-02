/**
 * THE VENDOR EVENT RECEIVER, BEHIND EACH CONNECTOR'S EVENTBRIDGE RULE (K5, PH-1).
 *
 * One function serves every subscribing connector. A vendor never calls it: the vendor's partner
 * integration (Salesforce Event Relay, PagerDuty's EventBridge integration) puts its events on the partner
 * event bus of the source the connector declares, and that bus's rule for the connector, pinned to the
 * declared source and the subscribed event types (`connectorEventPattern`), invokes this function
 * asynchronously. Its resource policy admits those rules and nothing else (`connectors-stack.ts`). In order:
 *
 *  1. THE SOURCE, a second layer behind the rule: the envelope's `source` must be the `eventSource` a
 *     subscribing connector declares, and that connector is the one the event is for. Any other source is
 *     refused and recorded as a security event; nothing is written.
 *  2. THE EVENT is read by the vendor's adapter (`lib/connectors/vendors.ts`). Unreadable: dropped. A type
 *     the connector does not subscribe to: ignored. An event older than the replay window, or dated in the
 *     future past the skew allowed: refused, since its replay record could have expired.
 *  3. THE REPLAY RECORD, one item per vendor event id (`<connector>#<event id>`), expiring after
 *     `REPLAY_WINDOW_SECONDS`. It is CLAIMED with a conditional write before any work and marked `published`
 *     once the fact is on the bus. Only a `published` record makes a delivery a replay, which is dropped.
 *     A claim another invocation holds, inside `CLAIM_LEASE_SECONDS`, is in flight: this invocation throws,
 *     so it is retried rather than dropped. A claim older than the lease (its holder died) is taken over.
 *  4. THE PEOPLE the event names, each resolved through `Identities` and admitted at the connector's
 *     classification, never by email (`lib/connector-participants.ts`, K2, K4). A person with no row under
 *     a `provisioned-only` issuer is pre-assigned through the connector subject provisioner
 *     (`PROVISION_FUNCTION_NAME`, P-13) and admitted nowhere until they sign in.
 *  5. THE FACT, an `ae.connector` event on the default bus (`lib/connectors/events.ts`), then the record is
 *     marked `published`.
 *
 * A FAILURE THAT A RETRY CAN CURE THROWS: the replay store unreadable, a claim in flight, or a resolution or
 * publish that fails. The claim is released first, so the retry is processed, not dropped as a replay.
 * Lambda retries the asynchronous invocation, and an event every retry fails is kept in the receiver's
 * dead-letter queue (`ConnectorEventsDlq`). A refusal a retry cannot cure (a foreign source, an unreadable
 * or out-of-window event) returns, so it is not retried.
 *
 * Nothing about an event is logged but the connector, the outcome and the vendor event id: never the detail.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { runtimeConnectors, type RuntimeConnector } from '../../lib/config/connectors.js';
import { ADAPTERS, UnreadableEvent, type PartnerEvent, type VendorEvent } from './lib/connectors/vendors.js';
import { publishConnectorEvent, type ConnectorEventDetail } from './lib/connectors/events.js';
import { resolveParticipants, type ParticipantDeps } from './lib/connector-participants.js';
import { defaultDirectory } from './lib/membership-source.js';
// The deployment's set, read at runtime from the rows its stacks publish, before the handler runs.
import { withProfileRegistry } from '../../lib/profile-registry';

type Sender = { send(command: unknown): Promise<any> };

/** How long a vendor event id is remembered, and so the oldest event accepted. */
export const REPLAY_WINDOW_SECONDS = 7 * 24 * 3600;
/** How far in the future an event may be dated: clock skew, not more. */
export const FUTURE_SKEW_SECONDS = 300;
/** How long a claim holds an event id before another invocation may take it over: four times the timeout. */
export const CLAIM_LEASE_SECONDS = 60;

export interface IngestDeps {
  connectors: readonly RuntimeConnector[];
  doc: Sender;
  replayTable: string;
  instance: string;
  publish(detail: ConnectorEventDetail): Promise<void>;
  participants: ParticipantDeps;
  now(): number;
}

export type IngestOutcome =
  | 'accepted'
  | 'duplicate'
  | 'ignored'
  | 'foreign-source'
  | 'unreadable'
  | 'out-of-window';

export interface IngestResult {
  outcome: IngestOutcome;
  connectorId?: string;
  eventId?: string;
}

/** A failure a retry can cure. Thrown, so Lambda retries the invocation and the dead-letter queue keeps what never succeeds. */
export class IngestRetry extends Error {
  constructor(readonly reason: string, cause?: unknown) {
    super(`the event is retried: ${reason}${cause ? ` (${(cause as Error)?.name || 'error'})` : ''}`);
    this.name = 'IngestRetry';
  }
}

function log(level: 'log' | 'warn' | 'error', connectorId: string, outcome: string, extra: Record<string, unknown> = {}): void {
  console[level](JSON.stringify({ _ingest: outcome, connectorId, ...extra }));
}

/** The subscribing connector that declares this partner event source, or none. */
function connectorOf(event: PartnerEvent, connectors: readonly RuntimeConnector[]): RuntimeConnector | undefined {
  const source = typeof event?.source === 'string' ? event.source : '';
  return source ? connectors.find((c) => c.subscribes.length > 0 && !!c.eventSource && c.eventSource === source) : undefined;
}

const replayKey = (connectorId: string, eventId: string): string => `${connectorId}#${eventId}`;

/**
 * Claim one vendor event id. `claimed`: this invocation holds it. `published`: a replay. A claim another
 * invocation still holds throws, so this delivery is retried after it settles rather than dropped.
 */
async function claim(deps: IngestDeps, connectorId: string, eventId: string): Promise<'claimed' | 'published'> {
  const nowSeconds = Math.floor(deps.now() / 1000);
  const pk = replayKey(connectorId, eventId);
  try {
    await deps.doc.send(new PutCommand({
      TableName: deps.replayTable,
      Item: { pk, state: 'claimed', claimedAt: nowSeconds, ttl: nowSeconds + REPLAY_WINDOW_SECONDS },
      // New, or a claim whose holder outlived the lease (it died without releasing it).
      ConditionExpression: 'attribute_not_exists(pk) OR (#s = :claimed AND claimedAt < :stale)',
      ExpressionAttributeNames: { '#s': 'state' },
      ExpressionAttributeValues: { ':claimed': 'claimed', ':stale': nowSeconds - CLAIM_LEASE_SECONDS },
    }));
    return 'claimed';
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw new IngestRetry('the replay store did not answer', err);
  }
  let state: unknown;
  try {
    state = (await deps.doc.send(new GetCommand({ TableName: deps.replayTable, Key: { pk }, ConsistentRead: true })))?.Item?.state;
  } catch (err) {
    throw new IngestRetry('the replay store did not answer', err);
  }
  if (state === 'published') return 'published';
  throw new IngestRetry('another invocation holds the claim');
}

/** Release this invocation's claim, so the retry is processed. Best effort: an unreleased claim lapses after the lease. */
async function release(deps: IngestDeps, connectorId: string, eventId: string, claimedAt: number): Promise<void> {
  try {
    await deps.doc.send(new DeleteCommand({
      TableName: deps.replayTable,
      Key: { pk: replayKey(connectorId, eventId) },
      ConditionExpression: '#s = :claimed AND claimedAt = :mine',
      ExpressionAttributeNames: { '#s': 'state' },
      ExpressionAttributeValues: { ':claimed': 'claimed', ':mine': claimedAt },
    }));
  } catch (err) {
    log('error', connectorId, 'release-failed', { eventId, err: (err as Error)?.name });
  }
}

export async function handleEvent(event: PartnerEvent, deps: IngestDeps): Promise<IngestResult> {
  // 1. THE SOURCE: the rule matched it, and the receiver checks it again.
  const connector = connectorOf(event, deps.connectors);
  if (!connector) {
    log('warn', '', 'foreign-source', { securityEvent: true });
    return { outcome: 'foreign-source' };
  }

  // 2. THE EVENT.
  let parsed: VendorEvent;
  try {
    parsed = ADAPTERS[connector.vendor].read(event);
  } catch (err) {
    log('warn', connector.id, 'unreadable', { reason: err instanceof UnreadableEvent ? err.message : (err as Error)?.name });
    return { outcome: 'unreadable', connectorId: connector.id };
  }
  const done = (outcome: IngestOutcome): IngestResult => ({ outcome, connectorId: connector.id, eventId: parsed.eventId });
  const occurred = Date.parse(parsed.occurredAt);
  const nowMs = deps.now();
  if (!Number.isFinite(occurred) || occurred < nowMs - REPLAY_WINDOW_SECONDS * 1000 || occurred > nowMs + FUTURE_SKEW_SECONDS * 1000) {
    log('warn', connector.id, 'out-of-window', { eventId: parsed.eventId, securityEvent: true });
    return done('out-of-window');
  }
  if (!connector.subscribes.includes(parsed.type)) {
    log('log', connector.id, 'ignored', { eventId: parsed.eventId, type: parsed.type });
    return done('ignored');
  }

  // 3. THE REPLAY RECORD.
  const claimedAt = Math.floor(nowMs / 1000);
  let state: 'claimed' | 'published';
  try {
    state = await claim(deps, connector.id, parsed.eventId);
  } catch (err) {
    log('error', connector.id, 'retry', { eventId: parsed.eventId, reason: (err as IngestRetry).reason ?? (err as Error)?.name });
    throw err;
  }
  if (state === 'published') {
    log('log', connector.id, 'duplicate', { eventId: parsed.eventId });
    return done('duplicate');
  }

  // 4 and 5. THE PEOPLE, AND THE FACT. A failure releases the claim and throws, so the retry is processed.
  let outcomes: Awaited<ReturnType<typeof resolveParticipants>>;
  const classification = connector.classification || '';
  try {
    outcomes = classification ? await resolveParticipants(connector, parsed.people, classification, deps.participants) : [];
    const count = (s: string) => outcomes.filter((o) => o.state === s).length;
    await deps.publish({
      instance: deps.instance,
      connectorId: connector.id,
      vendor: connector.vendor,
      eventId: parsed.eventId,
      type: parsed.type,
      occurredAt: parsed.occurredAt,
      classification,
      ref: { connectorId: connector.id, system: connector.vendor, ...parsed.ref },
      admitted: outcomes.flatMap((o) => (o.state === 'admitted' ? [{ role: o.role, personArn: o.personArn }] : [])),
      notAdmitted: { refused: count('refused'), undetermined: count('undetermined'), unresolved: count('unresolved'), pending: count('pending') },
    });
  } catch (err) {
    await release(deps, connector.id, parsed.eventId, claimedAt);
    log('error', connector.id, 'retry', { eventId: parsed.eventId, reason: 'publish', err: (err as Error)?.name });
    throw new IngestRetry('the event could not be published', err);
  }

  try {
    await deps.doc.send(new UpdateCommand({
      TableName: deps.replayTable,
      Key: { pk: replayKey(connector.id, parsed.eventId) },
      UpdateExpression: 'SET #s = :published, publishedAt = :at',
      ExpressionAttributeNames: { '#s': 'state' },
      ExpressionAttributeValues: { ':published': 'published', ':at': Math.floor(deps.now() / 1000) },
    }));
  } catch (err) {
    // The fact is on the bus, so the event is not retried. The claim lapses after the lease, and a vendor
    // resend after that would be published again: recorded, so a second fact for one event id is explained.
    log('error', connector.id, 'mark-failed', { eventId: parsed.eventId, err: (err as Error)?.name });
  }
  const count = (s: string) => outcomes.filter((o) => o.state === s).length;
  log('log', connector.id, 'accepted', {
    eventId: parsed.eventId, type: parsed.type, named: outcomes.length, admitted: count('admitted'), unresolved: count('unresolved'), pending: count('pending'),
  });
  return done('accepted');
}

/**
 * PRE-ASSIGN A NAMED PERSON (P-13), through the connector subject provisioner, the one function this role
 * may invoke for it. True when a `pending` row now exists for the subject.
 */
function provisionThrough(functionName: string, region: string): (namespace: string, subject: string, connectorId: string) => Promise<boolean> {
  const lambda = new LambdaClient({ region });
  return async (namespace, subject, connectorId) => {
    const out = await lambda.send(new InvokeCommand({
      FunctionName: functionName,
      Payload: new TextEncoder().encode(JSON.stringify({ op: 'provisionSubject', issuer: namespace, subject, actor: connectorId })),
    }));
    if (out.FunctionError) throw new Error(`the subject provisioner failed (${out.FunctionError})`);
    const answer = JSON.parse(out.Payload ? new TextDecoder().decode(out.Payload) : '{}') as { ok?: boolean; state?: string; status?: string };
    return answer.ok === true && (answer.state === 'provisioned' || (answer.state === 'exists' && answer.status === 'pending'));
  };
}

function provisionNamespaces(): string[] {
  try {
    const parsed = JSON.parse(process.env.PROVISION_NAMESPACES || '[]');
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

let defaults: IngestDeps | null = null;

function defaultDeps(): IngestDeps {
  if (defaults) return defaults;
  const region = process.env.AWS_REGION || 'us-east-1';
  defaults = {
    connectors: runtimeConnectors(process.env.CONNECTORS),
    doc: DynamoDBDocumentClient.from(new DynamoDBClient({ region })),
    replayTable: process.env.REPLAY_TABLE || '',
    instance: process.env.ALERT_INSTANCE || '',
    publish: (detail) => publishConnectorEvent(detail),
    participants: {
      directory: defaultDirectory(),
      ...(process.env.PROVISION_FUNCTION_NAME
        ? { provision: { namespaces: provisionNamespaces(), subject: provisionThrough(process.env.PROVISION_FUNCTION_NAME, region) } }
        : {}),
    },
    now: () => Date.now(),
  };
  return defaults;
}

export const handler = withProfileRegistry((event: PartnerEvent): Promise<IngestResult> => handleEvent(event, defaultDeps()));
