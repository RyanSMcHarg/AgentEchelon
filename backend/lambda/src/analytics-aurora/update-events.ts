/**
 * EVERY UPDATE OF A MESSAGE IS ITS OWN ROW (migration 084).
 *
 * The archive is a stream of events, and an event is never updated (tenet D7). Amazon Chime SDK sends
 * one UPDATE_CHANNEL_MESSAGE per edit of a message, and a placeholder routinely receives several: it
 * becomes the queue notice, and later the receipt of an answer that moved to a message of its own, or
 * the answer itself. The projection keys each of those events as its own row:
 *
 *   `<MessageId>-UPD-<12 hex>`
 *
 * where the hex is an MD5 prefix of the event's own LastUpdatedTimestamp, Content and Metadata, exactly
 * as they arrived on the stream. Deterministic on the event, so a Kinesis redelivery lands on the row
 * it already wrote (`ON CONFLICT (message_id, channel_arn) DO NOTHING`), and distinct per event, so a
 * second update is a second row rather than a dropped one. Channel events are keyed the same way
 * (`transformToMessageRecord`).
 *
 * REDACT AND DELETE KEEP THEIR FIXED SUFFIXES (`-RED`, `-DEL`). Each is a terminal fact about the
 * message, and every reader asks only whether it happened: a second redaction of an already redacted
 * message carries nothing the first did not, and keeping the first keeps the instant the content was
 * first removed.
 *
 * `messages.base_message_id` holds the MessageId the event is about (the CREATE row's own
 * `message_id`), and `messages.last_updated_at` the event's own LastUpdatedTimestamp, so a reader finds
 * a message's updates by an indexed equality and orders them by when each happened. A row archived
 * before 084 has the single fixed `<MessageId>-UPD` id, a backfilled `base_message_id`, and a NULL
 * `last_updated_at`; both readers below order it correctly against per-event rows (see `updateJoinSql`).
 */
import { createHash } from 'crypto';

/** The suffix every UPDATE event's id starts with after the MessageId. */
export const UPDATE_EVENT_SUFFIX = '-UPD';

/**
 * The archival suffixes, as one pattern for TypeScript and one for SQL. Strips a per-event update id
 * (`-UPD-<12 hex>`), a row archived before 084 (`-UPD`), and the moderation rows (`-RED`, `-DEL`).
 */
export const ARCHIVAL_SUFFIX_RE = /-(UPD(-[0-9a-f]{12})?|RED|DEL)$/;
export const ARCHIVAL_SUFFIX_SQL = `'-(UPD(-[0-9a-f]{12})?|RED|DEL)$'`;

/** The archived id of one UPDATE event (see the module comment for why each part is there). */
export function updateEventMessageId(
  messageId: string,
  event: { LastUpdatedTimestamp?: string | null; Content?: string | null; Metadata?: string | null },
): string {
  const discriminator = createHash('md5')
    .update(`${event.LastUpdatedTimestamp ?? ''}|${event.Content ?? ''}|${event.Metadata ?? ''}`)
    .digest('hex')
    .substring(0, 12);
  return `${messageId}${UPDATE_EVENT_SUFFIX}-${discriminator}`;
}

/** The MessageId an archived message event is about: its id with any archival suffix removed. */
export function baseMessageIdOf(archivedId: string): string {
  return archivedId.replace(ARCHIVAL_SUFFIX_RE, '');
}

/** Whether an archived id is an UPDATE event's, in either the per-event or the pre-084 shape. */
export function isUpdateEventId(archivedId: string): boolean {
  return /-UPD(-[0-9a-f]{12})?$/.test(archivedId);
}

/**
 * The SQL ordering that puts a message's update rows in the order they happened, LATEST first.
 *
 * By the event's own timestamp; a pre-084 row (NULL) sorts after every per-event row, because any
 * per-event row of the same message was necessarily archived after it. Ties (two events stamped the same
 * instant) fall to arrival order and then to the id, so the choice is the same on every read.
 */
export function latestUpdateOrderSql(u: string): string {
  return `${u}.last_updated_at DESC NULLS LAST, ${u}.archived_at DESC, ${u}.message_id DESC`;
}

/** The same ordering, EARLIEST first: a pre-084 row is the first update its message received. */
export function firstUpdateOrderSql(u: string): string {
  return `${u}.last_updated_at ASC NULLS FIRST, ${u}.archived_at ASC, ${u}.message_id ASC`;
}

/**
 * ONE UPDATE ROW OF A MESSAGE, as a LEFT JOIN LATERAL that yields one row or none under `alias`, with
 * every column of `messages`. `create` is the alias of the CREATE row whose updates are read.
 *
 * `latest` is the message's current state: what it says now and what it last declared (a placeholder
 * that became the notice and then a receipt is a receipt). `first` is the first update it received,
 * for a reader whose metric is defined by the first answer. Each caller states which it takes and why.
 *
 * No backticks in what this returns: it is interpolated into template-literal SQL.
 */
export function updateJoinSql(a: {
  alias: string;
  create: string;
  pick: 'latest' | 'first';
  /** An extra condition on one column of the update row, as `<column> <predicate>`; it is prefixed
   *  with the row's alias. */
  and?: string;
}): string {
  const u = `${a.alias}_ev`;
  const order = a.pick === 'latest' ? latestUpdateOrderSql(u) : firstUpdateOrderSql(u);
  return `LEFT JOIN LATERAL (
         SELECT ${u}.* FROM messages ${u}
          WHERE ${u}.channel_arn = ${a.create}.channel_arn
            AND ${u}.event_type = 'UPDATE_CHANNEL_MESSAGE'
            AND ${u}.base_message_id = ${a.create}.message_id${a.and ? `
            AND ${u}.${a.and}` : ''}
          ORDER BY ${order}
          LIMIT 1
       ) ${a.alias} ON TRUE`;
}

/**
 * Whether an UPDATE row `u` has been superseded by a later update of the same message: the predicate a
 * reader of every row uses to keep only the message's current text. The same order as
 * `latestUpdateOrderSql`, with a pre-084 row's NULL instant read as the earliest.
 */
export function supersededUpdateSql(u: string): string {
  return `EXISTS (
           SELECT 1 FROM messages later
            WHERE later.channel_arn = ${u}.channel_arn
              AND later.event_type = 'UPDATE_CHANNEL_MESSAGE'
              AND later.base_message_id = ${u}.base_message_id
              AND later.id <> ${u}.id
              AND (COALESCE(later.last_updated_at, '-infinity'::timestamptz), later.archived_at, later.message_id)
                  > (COALESCE(${u}.last_updated_at, '-infinity'::timestamptz), ${u}.archived_at, ${u}.message_id))`;
}
