/**
 * THE ACCESS LOG: WHO WAS GIVEN ACCESS TO WHAT, AND WHY, RECORDED BEFORE THEY HOLD IT (ADR-052, FR30),
 * AND EVERY ACCESS THE EXCHANGES REFUSED.
 *
 * Every credential the exchange vends to an operator - the console session, a per-conversation read,
 * an attachment read, a moderation action - is written here, with the stated reason, BEFORE the
 * credential is returned. A record that cannot be written withholds the credential: a reason with
 * nowhere durable to land is theater, and an access nobody can account for later is the failure this
 * exists to prevent. Reads of the log are recorded here too.
 *
 * EVERY REFUSAL IS RECORDED BESIDE THE GRANTS (`recordRefusal`), with `outcome: 'refused'`: who asked,
 * what they asked for, the refusal's code and status, and when. A refusal whose record cannot be written
 * is still a refusal: the write is bounded in time, never throws, and a failure is logged as a security
 * event, so recording can neither turn a refusal into a grant nor hold its answer up.
 *
 * The CloudWatch audit line stays beside it. That line is the operator's tail; this table is what the
 * console's Access Log reads, by conversation or by operator, for 400 days.
 *
 * ── SHAPE ───────────────────────────────────────────────────────────────────────────────────────
 *
 * `pk = day#YYYY-MM-DD`, `sk = <iso>#<id>`: the day's records, newest last. Two sparse indexes answer
 * the two questions a reader asks: `byConversation` (who reached this conversation) and `byActor`
 * (what did this person reach, keyed by `actorPersonId`). A console session names no conversation, so it is in `byActor` only.
 * `expiresAt` (epoch seconds) is the DynamoDB TTL, 400 days after the access. Every record carries its
 * `outcome`; a record written before refusals were recorded has none and is a grant.
 *
 * A refusal has the same shape and the same key design: its `sk` carries its own random id, so it lands
 * beside the grants of its day and can never replace one, and it expires on the same 400 days. A refusal
 * that names no person (a sign-in the exchange never resolved to one) carries no `actorPersonId`, so it is
 * in the day partition and the conversation index only.
 *
 * A READER THAT IS NOT A PERSON IS NAMED BY THE IAM PRINCIPAL THAT SIGNED ITS REQUEST (owner decision, 2026-11-12): an
 * access granted to a signed principal no person id resolves from (an operator's own role, a service mode caller) is
 * recorded with `actorKind: 'iam'`, its `actorPrincipalArn`, and `iam#<arn>` as its `byActor` key. The ARN is the one
 * API Gateway sets on the request context from the signature (`signingPrincipalArn`), never one a header or body
 * names. A grant that names neither a person nor a principal is refused (`AccessReaderUnidentified`, answered 403
 * `READER_UNIDENTIFIED`): an access nobody can be found for is not given.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

export const ACCESS_LOG_RETENTION_DAYS = 400;
export const ACCESS_LOG_BY_CONVERSATION = 'byConversation';
export const ACCESS_LOG_BY_ACTOR = 'byActor';
/** How long a refusal's record may take before the refusal is answered without it. */
export const REFUSAL_RECORD_TIMEOUT_MS = 2000;

/** Whether the access was given or refused. */
export type AccessOutcome = 'granted' | 'refused';

/** The audit line the exchange already writes, which is also what the record carries. */
export interface AccessAuditLine {
  _auditEvent: string;
  timestamp?: string;
  /** The person's AppInstanceUser id, on a console-session vend and a team vend. */
  personId?: string;
  /** The person's AppInstanceUser id, on an admin-plane vend. */
  adminPersonId?: string;
  /** The signing IAM principal's ARN, for a reader no person id resolves from (`signingPrincipalArn`). */
  actorPrincipalArn?: string;
  channelArn?: string | null;
  capabilities?: string[];
  reason?: string | null;
  /** `refused` on a refusal's line; a grant's line leaves it out. */
  outcome?: AccessOutcome;
  /** On a refusal: the refusal's code, when the exchange gave one. */
  code?: string | null;
  /** On a refusal: the HTTP status the exchange answered with. */
  status?: number;
  [key: string]: unknown;
}

export interface AccessRecord {
  pk: string;
  sk: string;
  id: string;
  event: string;
  at: string;
  /**
   * The person given (or refused) the access, as their AppInstanceUser id. The `byActor` index key. Absent
   * only on a refusal of a sign-in the exchange never resolved to a person.
   */
  actorPersonId?: string;
  /** `iam` when the reader is a signed IAM principal rather than a person; absent for a person. */
  actorKind?: 'iam';
  /** The signing principal's ARN, on an `iam` reader's record. */
  actorPrincipalArn?: string;
  /** Given or refused. Absent on a record written before refusals were recorded, which is a grant. */
  outcome?: AccessOutcome;
  conversation?: string;
  capabilities: string[];
  reason?: string;
  /** A refusal's code, when the exchange gave one. */
  code?: string;
  /** A refusal's HTTP status. */
  status?: number;
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

/**
 * The access names neither a person nor a signing principal, so nobody could be found for it later. Not transient: a
 * handler answers it 403 `READER_UNIDENTIFIED`. An `AccessLogUnavailable` too, so a caller that only knows that one
 * still withholds the access.
 */
export class AccessReaderUnidentified extends AccessLogUnavailable {
  constructor() {
    super('the access names no person and no signing principal');
    this.name = 'AccessReaderUnidentified';
  }
}

/** The prefix an IAM reader's `byActor` key carries before its principal ARN. */
export const IAM_ACTOR_PREFIX = 'iam#';
const PRINCIPAL_ARN = /^arn:aws[a-z-]*:(iam|sts)::\d{12}:[A-Za-z0-9+=,.@_/-]+$/;

/**
 * THE IAM PRINCIPAL THAT SIGNED THE REQUEST, as API Gateway sets it on the request context of an `AWS_IAM`-authorized
 * call (`requestContext.identity.userArn`), or null. Read from there alone: a header, the body and the query are the
 * caller's own words and are never consulted.
 */
export function signingPrincipalArn(event: { requestContext?: unknown } | null | undefined): string | null {
  const identity = (event?.requestContext as { identity?: { userArn?: unknown } } | undefined)?.identity;
  const arn = identity?.userArn;
  return typeof arn === 'string' && PRINCIPAL_ARN.test(arn) ? arn : null;
}

let defaultDoc: Pick<DynamoDBDocumentClient, 'send'> | null = null;
function doc(): Pick<DynamoDBDocumentClient, 'send'> {
  if (!defaultDoc) defaultDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return defaultDoc;
}

/** The record an audit line becomes. Pure, so the shape is testable without a table. */
export function accessRecordOf(line: AccessAuditLine, now: Date = new Date(), id: string = randomUUID()): AccessRecord {
  const at = line.timestamp && !Number.isNaN(Date.parse(line.timestamp)) ? new Date(line.timestamp).toISOString() : now.toISOString();
  const person = String(line.adminPersonId || line.personId || '');
  const principal = !person && typeof line.actorPrincipalArn === 'string' && PRINCIPAL_ARN.test(line.actorPrincipalArn) ? line.actorPrincipalArn : '';
  const actorPersonId = person || (principal ? `${IAM_ACTOR_PREFIX}${principal}` : '');
  const conversation = typeof line.channelArn === 'string' && line.channelArn ? line.channelArn : undefined;
  const reason = typeof line.reason === 'string' && line.reason.trim() ? line.reason.trim() : undefined;
  const outcome: AccessOutcome = line.outcome === 'refused' ? 'refused' : 'granted';
  const code = outcome === 'refused' && typeof line.code === 'string' && line.code ? line.code : undefined;
  const status = outcome === 'refused' && Number.isInteger(line.status) ? line.status : undefined;
  return {
    pk: `day#${at.slice(0, 10)}`,
    sk: `${at}#${id}`,
    id,
    event: line._auditEvent,
    at,
    // An index key is never written empty: a record that names no person stays out of `byActor`.
    ...(actorPersonId ? { actorPersonId } : {}),
    ...(principal ? { actorKind: 'iam' as const, actorPrincipalArn: principal } : {}),
    outcome,
    ...(conversation ? { conversation } : {}),
    capabilities: Array.isArray(line.capabilities) ? line.capabilities.map(String) : [],
    ...(reason ? { reason } : {}),
    ...(code ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
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
  if (!line.adminPersonId && !line.personId && !(typeof line.actorPrincipalArn === 'string' && PRINCIPAL_ARN.test(line.actorPrincipalArn))) {
    throw new AccessReaderUnidentified();
  }
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

/**
 * Write one REFUSAL record. NEVER THROWS and never waits longer than `REFUSAL_RECORD_TIMEOUT_MS`: the
 * caller answers its refusal whatever this returns, so a log that cannot be written can neither turn the
 * refusal into a grant nor hold it up. Resolves whether the record landed; a failure is logged as a
 * security event, because a refusal nobody can find later is what this record exists to prevent.
 */
export async function recordRefusal(
  line: AccessAuditLine,
  deps: { doc?: Pick<DynamoDBDocumentClient, 'send'>; table?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  const refusal: AccessAuditLine = { ...line, outcome: 'refused' };
  console.warn('[AccessLog][SecurityEvent] refused', JSON.stringify(refusal));
  const table = deps.table ?? process.env.ACCESS_LOG_TABLE ?? '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!table) throw new AccessLogUnavailable('ACCESS_LOG_TABLE is not set');
    const write = (deps.doc ?? doc()).send(new PutCommand({
      TableName: table,
      Item: accessRecordOf(refusal),
      // A record is written once and never replaced.
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AccessLogUnavailable('the refusal record timed out')), deps.timeoutMs ?? REFUSAL_RECORD_TIMEOUT_MS);
    });
    await Promise.race([write, timeout]);
    return true;
  } catch (err) {
    console.error('[AccessLog][SecurityEvent] a refusal could not be recorded; it is refused all the same', {
      event: line._auditEvent, code: line.code ?? null, status: line.status ?? null, err: (err as Error)?.name || 'error',
    });
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface AccessLogQuery {
  /** How many days back to read, 1 to 400. */
  days: number;
  /** Only accesses to this conversation (channel ARN). */
  conversation?: string;
  /** Only accesses by this person (their AppInstanceUser id). */
  actor?: string;
  /** At most this many records of each outcome, newest first. */
  limit: number;
  /** Only records of this outcome. Absent reads each outcome on its own budget. */
  outcome?: AccessOutcome;
}

/**
 * Records newest first, from the index the filter names, or day by day when there is none.
 *
 * GRANTS AND REFUSALS ARE COUNTED ON SEPARATE BUDGETS, in one walk. A refusal is written for whoever is refused, at
 * the rate they send requests, so on one shared limit a caller could fill a day or a conversation with refusals and
 * push its grants out of the view. Each outcome keeps up to `limit` records; the walk goes on until the grants are
 * full or the window ends, so a flood of refusals never stops it short of the grants, and the refusals shown are
 * the newest in the span read.
 */
export async function readAccessLog(
  q: AccessLogQuery,
  deps: { doc?: Pick<DynamoDBDocumentClient, 'send'>; table?: string; now?: Date } = {},
): Promise<AccessRecord[]> {
  const table = deps.table ?? process.env.ACCESS_LOG_TABLE ?? '';
  if (!table) throw new AccessLogUnavailable('ACCESS_LOG_TABLE is not set');
  const client = deps.doc ?? doc();
  const now = deps.now ?? new Date();
  const since = new Date(now.getTime() - q.days * 86_400_000).toISOString();
  const kept: Record<AccessOutcome, AccessRecord[]> = { granted: [], refused: [] };
  // Done when the outcome the view is bounded by is full: the one asked for, else the grants.
  const bound: AccessOutcome = q.outcome ?? 'granted';
  const full = (): boolean => kept[bound].length >= q.limit;

  const drain = async (input: Record<string, unknown>): Promise<void> => {
    let start: Record<string, unknown> | undefined;
    do {
      const page = await client.send(new QueryCommand({
        TableName: table, ScanIndexForward: false, ExclusiveStartKey: start, ...input,
      } as never)) as { Items?: AccessRecord[]; LastEvaluatedKey?: Record<string, unknown> };
      for (const item of page.Items ?? []) {
        if (q.actor && item.actorPersonId !== q.actor) continue;
        if (q.conversation && item.conversation !== q.conversation) continue;
        // A record with no outcome was written as a grant.
        const outcome: AccessOutcome = item.outcome === 'refused' ? 'refused' : 'granted';
        if (q.outcome && outcome !== q.outcome) continue;
        if (kept[outcome].length < q.limit) kept[outcome].push(item);
        if (full()) return;
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
    for (let d = 0; !full(); d++) {
      const day = new Date(now.getTime() - d * 86_400_000).toISOString().slice(0, 10);
      if (day < firstDay) break;
      await drain({
        KeyConditionExpression: 'pk = :p AND sk >= :since',
        ExpressionAttributeValues: { ':p': `day#${day}`, ':since': since },
      });
    }
  }
  return [...kept.granted, ...kept.refused].sort((a, b) => (a.sk < b.sk ? 1 : a.sk > b.sk ? -1 : 0));
}
