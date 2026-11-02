/**
 * THE ACCESS LOG: WHO WAS GIVEN ACCESS TO WHAT, AND WHY, RECORDED BEFORE THEY HOLD IT (ADR-052, FR30).
 *
 * Every credential the exchange vends to an operator - the console session, a per-conversation read,
 * an attachment read, a moderation action - is written here, with the stated reason, BEFORE the
 * credential is returned. A record that cannot be written withholds the credential: a reason with
 * nowhere durable to land is theater, and an access nobody can account for later is the failure this
 * exists to prevent. Reads of the log are recorded here too.
 *
 * The CloudWatch audit line stays beside it. That line is the operator's tail; this table is what the
 * console's Access Log reads, by conversation or by operator, for 400 days.
 *
 * ── SHAPE ───────────────────────────────────────────────────────────────────────────────────────
 *
 * `pk = day#YYYY-MM-DD`, `sk = <iso>#<id>`: the day's records, newest last. Two sparse indexes answer
 * the two questions a reader asks: `byConversation` (who reached this conversation) and `byActor`
 * (what did this person reach, keyed by `actorPersonId`). A console session names no conversation, so it is in `byActor` only.
 * `expiresAt` (epoch seconds) is the DynamoDB TTL, 400 days after the access.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

export const ACCESS_LOG_RETENTION_DAYS = 400;
export const ACCESS_LOG_BY_CONVERSATION = 'byConversation';
export const ACCESS_LOG_BY_ACTOR = 'byActor';

/** The audit line the exchange already writes, which is also what the record carries. */
export interface AccessAuditLine {
  _auditEvent: string;
  timestamp?: string;
  /** The person's AppInstanceUser id, on a console-session vend and a team vend. */
  personId?: string;
  /** The person's AppInstanceUser id, on an admin-plane vend. */
  adminPersonId?: string;
  channelArn?: string | null;
  capabilities?: string[];
  reason?: string | null;
  [key: string]: unknown;
}

export interface AccessRecord {
  pk: string;
  sk: string;
  id: string;
  event: string;
  at: string;
  /** The person given the access, as their AppInstanceUser id. The `byActor` index key. */
  actorPersonId: string;
  conversation?: string;
  capabilities: string[];
  reason?: string;
  /** The whole audit line, so nothing the exchange recorded is dropped. */
  detail: string;
  expiresAt: number;
}

export class AccessLogUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessLogUnavailable';
  }
}

let defaultDoc: Pick<DynamoDBDocumentClient, 'send'> | null = null;
function doc(): Pick<DynamoDBDocumentClient, 'send'> {
  if (!defaultDoc) defaultDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return defaultDoc;
}

/** The record an audit line becomes. Pure, so the shape is testable without a table. */
export function accessRecordOf(line: AccessAuditLine, now: Date = new Date(), id: string = randomUUID()): AccessRecord {
  const at = line.timestamp && !Number.isNaN(Date.parse(line.timestamp)) ? new Date(line.timestamp).toISOString() : now.toISOString();
  const actorPersonId = String(line.adminPersonId || line.personId || '');
  const conversation = typeof line.channelArn === 'string' && line.channelArn ? line.channelArn : undefined;
  const reason = typeof line.reason === 'string' && line.reason.trim() ? line.reason.trim() : undefined;
  return {
    pk: `day#${at.slice(0, 10)}`,
    sk: `${at}#${id}`,
    id,
    event: line._auditEvent,
    at,
    actorPersonId,
    ...(conversation ? { conversation } : {}),
    capabilities: Array.isArray(line.capabilities) ? line.capabilities.map(String) : [],
    ...(reason ? { reason } : {}),
    detail: JSON.stringify(line),
    expiresAt: Math.floor(Date.parse(at) / 1000) + ACCESS_LOG_RETENTION_DAYS * 86_400,
  };
}

/**
 * Write one access record. THROWS `AccessLogUnavailable` when it cannot, and the caller withholds what
 * it was about to hand over. An unset table is a failure, not a skip: a deployment that has no access
 * log vends nothing, rather than vending silently.
 */
export async function recordAccess(
  line: AccessAuditLine,
  deps: { doc?: Pick<DynamoDBDocumentClient, 'send'>; table?: string } = {},
): Promise<AccessRecord> {
  const table = deps.table ?? process.env.ACCESS_LOG_TABLE ?? '';
  if (!table) throw new AccessLogUnavailable('ACCESS_LOG_TABLE is not set');
  if (!line.adminPersonId && !line.personId) throw new AccessLogUnavailable('the access names no person');
  const record = accessRecordOf(line);
  try {
    await (deps.doc ?? doc()).send(new PutCommand({
      TableName: table,
      Item: record,
      // A record is written once and never replaced.
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  } catch (err) {
    throw new AccessLogUnavailable(`the access record could not be written: ${(err as Error)?.name || 'error'}`);
  }
  return record;
}

export interface AccessLogQuery {
  /** How many days back to read, 1 to 400. */
  days: number;
  /** Only accesses to this conversation (channel ARN). */
  conversation?: string;
  /** Only accesses by this person (their AppInstanceUser id). */
  actor?: string;
  /** At most this many records, newest first. */
  limit: number;
}

/** Records newest first, from the index the filter names, or day by day when there is none. */
export async function readAccessLog(
  q: AccessLogQuery,
  deps: { doc?: Pick<DynamoDBDocumentClient, 'send'>; table?: string; now?: Date } = {},
): Promise<AccessRecord[]> {
  const table = deps.table ?? process.env.ACCESS_LOG_TABLE ?? '';
  if (!table) throw new AccessLogUnavailable('ACCESS_LOG_TABLE is not set');
  const client = deps.doc ?? doc();
  const now = deps.now ?? new Date();
  const since = new Date(now.getTime() - q.days * 86_400_000).toISOString();
  const out: AccessRecord[] = [];

  const drain = async (input: Record<string, unknown>): Promise<void> => {
    let start: Record<string, unknown> | undefined;
    do {
      const page = await client.send(new QueryCommand({
        TableName: table, ScanIndexForward: false, ExclusiveStartKey: start, ...input,
      } as never)) as { Items?: AccessRecord[]; LastEvaluatedKey?: Record<string, unknown> };
      for (const item of page.Items ?? []) {
        if (q.actor && item.actorPersonId !== q.actor) continue;
        if (q.conversation && item.conversation !== q.conversation) continue;
        out.push(item);
        if (out.length >= q.limit) return;
      }
      start = page.LastEvaluatedKey;
    } while (start);
  };

  if (q.conversation) {
    await drain({
      IndexName: ACCESS_LOG_BY_CONVERSATION,
      KeyConditionExpression: 'conversation = :c AND #at >= :since',
      ExpressionAttributeNames: { '#at': 'at' },
      ExpressionAttributeValues: { ':c': q.conversation, ':since': since },
    });
  } else if (q.actor) {
    await drain({
      IndexName: ACCESS_LOG_BY_ACTOR,
      KeyConditionExpression: 'actorPersonId = :a AND #at >= :since',
      ExpressionAttributeNames: { '#at': 'at' },
      ExpressionAttributeValues: { ':a': q.actor, ':since': since },
    });
  } else {
    // The SAME rolling window as the indexed reads: every day partition from today back to the day
    // `since` falls in, and within them only `sk >= since` (the sort key leads with the ISO instant).
    // Counting calendar days instead would drop most of yesterday for days=1 and keep records older
    // than the window from the oldest day.
    const firstDay = since.slice(0, 10);
    for (let d = 0; out.length < q.limit; d++) {
      const day = new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10);
      if (day < firstDay) break;
      await drain({
        KeyConditionExpression: 'pk = :p AND sk >= :since',
        ExpressionAttributeValues: { ':p': `day#${day}`, ':since': since },
      });
    }
  }
  return out.slice(0, q.limit);
}
