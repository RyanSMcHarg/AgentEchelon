/**
 * THE OUTBOX IS SENT IN ORDER, AND EACH MESSAGE ONCE (`composerCache.ts` holds it).
 *
 * A message is written to the outbox before its send and removed on the service's confirmation. One whose send never got
 * an answer (offline, a dropped connection, a server error) stays, and is sent when a messaging session starts again or
 * the browser comes back online. Each carries its client id as the send's idempotency token and in its Metadata, so a
 * retry of a send whose outcome is unknown is first looked for among the conversation's recent messages and is not posted
 * a second time. A message the service refused stays in the outbox, marked, for the person to retry or discard.
 */
import { cacheSession, outboxEntries, putOutboxEntry, removeOutboxEntry, type OutboxEntry } from './composerCache';

/** Whether the browser says it is online. A browser that does not say is taken as online. */
export function isOnline(): boolean {
  try {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  } catch {
    return true;
  }
}

/**
 * Whether a failed send may have reached the service, or never reached it, rather than being refused by it: no HTTP
 * answer at all (offline, a dropped connection), a server error, or throttling. Only a refusal (any other 4xx) is final.
 */
export function isUnknownOutcome(error: unknown): boolean {
  const e = error as { $metadata?: { httpStatusCode?: number }; name?: string } | undefined;
  const status = e?.$metadata?.httpStatusCode;
  if (typeof status !== 'number') return true;
  return status >= 500 || status === 429 || e?.name === 'ThrottledClientException';
}

export interface DrainDeps {
  /** Send one entry, carrying its id as the client message id. Resolves on the service's confirmation. */
  send: (entry: OutboxEntry) => Promise<unknown>;
  /** Whether the service already holds the entry: a message of this person's carrying its client id. */
  sentAlready: (entry: OutboxEntry) => Promise<boolean>;
  /** An entry the service confirmed, with what the send resolved to (nothing when it was found already sent). */
  onSent?: (entry: OutboxEntry, sent?: unknown) => void;
  /** The outbox changed. */
  onChange?: () => void;
}

const draining = new Set<string>();
/** Entries whose send is running now, outside a drain: a drain leaves them to that send. */
const inFlight = new Set<string>();

/** Whether the entry `id` is being sent now. */
export function isSendingNow(id: string): boolean {
  return inFlight.has(id);
}

/** Run `send` as the one send of the entry `id` while it runs, so a drain starting meanwhile does not send it too. */
export async function sendingNow<T>(id: string, send: () => Promise<T>): Promise<T> {
  inFlight.add(id);
  try {
    return await send();
  } finally {
    inFlight.delete(id);
  }
}

/** The words a refusal carries, for the entry the person is shown. */
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Send the person's outbox in order, each entry once. A drain already running for this person is not doubled. ONE
 * CONVERSATION NEVER HOLDS BACK ANOTHER: an entry whose outcome stays unknown (its send, or the look for it among the
 * conversation's messages) keeps its place and holds back only the later entries of its own conversation, so their order
 * is kept; one the service refused (its send, or the look for it, as for a conversation the person can no longer read)
 * is marked failed, for the person to retry or discard, and holds back nothing.
 */
export async function drainOutbox(personId: string, deps: DrainDeps): Promise<void> {
  if (draining.has(personId)) return;
  draining.add(personId);
  const session = cacheSession();
  /** Conversations whose next entry waits: their later entries wait behind it. */
  const waiting = new Set<string>();
  try {
    for (const listed of outboxEntries(personId)) {
      if (!isOnline()) break;
      if (waiting.has(listed.channelArn)) continue;
      // Read again: the person may have discarded it, or another tab sent it, since the list was read.
      const entry = outboxEntries(personId).find((e) => e.id === listed.id);
      if (!entry || entry.failed || inFlight.has(entry.id)) continue;
      if (entry.attempted) {
        let held: boolean;
        try {
          held = await deps.sentAlready(entry);
        } catch (error) {
          if (isUnknownOutcome(error)) {
            waiting.add(entry.channelArn);
          } else {
            putOutboxEntry(personId, { ...entry, failed: reasonOf(error) }, session);
            deps.onChange?.();
          }
          continue;
        }
        if (held) {
          removeOutboxEntry(personId, entry.id);
          deps.onSent?.(entry);
          deps.onChange?.();
          continue;
        }
      }
      putOutboxEntry(personId, { ...entry, attempted: true }, session);
      try {
        const sent = await sendingNow(entry.id, () => deps.send(entry));
        removeOutboxEntry(personId, entry.id);
        deps.onSent?.(entry, sent);
        deps.onChange?.();
      } catch (error) {
        if (isUnknownOutcome(error)) {
          waiting.add(entry.channelArn);
          continue;
        }
        putOutboxEntry(personId, { ...entry, attempted: true, failed: reasonOf(error) }, session);
        deps.onChange?.();
      }
    }
  } finally {
    draining.delete(personId);
    deps.onChange?.();
  }
}
