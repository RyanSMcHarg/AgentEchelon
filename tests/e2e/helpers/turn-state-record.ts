/**
 * THE TURN-STATE RECORD, READ AS THE RUNTIME WRITES IT.
 *
 * Every component of the queue coordinates through one DynamoDB row - the lock, the queue, the
 * notice, the drain's stage, and the split offer. Assertions go against that row rather than against
 * the assistant's wording, and that is not a convenience: the offer is spoken in the assistant's own
 * voice, in this deployment's persona and this conversation's language (tenet D11), so there is no
 * English to match on that would still be true for a deployment configured with a different voice.
 * What must be true everywhere is that the subjects were written down, against the people they were
 * put to.
 *
 * Lifted out of `turn-queue.spec.ts` when a second spec needed the same reads. A copy would have
 * been free to drift from the record's real shape, and the failure mode is the expensive direction:
 * a reader that returns null for a row the deployment wrote reports a working system as broken, and
 * a wait for that row to CLEAR passes instantly against a deployment that never handled the answer.
 */
import { aws, jsonArg } from './task-backend';

export interface PendingSplitTopic {
  label: string;
  messageIds: string[];
  /** The subject exists because somebody sent a TARGETED message, so it is not the room's to read. */
  private?: boolean;
  /** Whose request it is, as a principal id. Only a private topic has one. */
  requestorId?: string;
}

export interface PendingSplitRecord {
  topics: PendingSplitTopic[];
  /** Everyone the offer was put to. See `PendingSplitOffer.offeredTo`. */
  offeredTo: string[];
}

/**
 * The turn-state table, from the env or the shared SSM contract.
 *
 * Null when it cannot be resolved, which callers must treat as a PRECONDITION rather than as an
 * empty result - see `requireTurnStateTable`.
 */
export function resolveTurnStateTable(): string | null {
  if (process.env.TURN_STATE_TABLE) return process.env.TURN_STATE_TABLE;
  const instance = process.env.E2E_INSTANCE_NAME || process.env.INSTANCE_NAME;
  if (!instance) return null;
  try {
    return aws(`ssm get-parameter --name "/${instance}/shared/tables/turn-state-name"`)
      ?.Parameter?.Value ?? null;
  } catch {
    return null;
  }
}

/** The whole record for one (conversation, assistant), or null. */
function turnStateItem(channelArn: string, responderId: string): any | null {
  const table = resolveTurnStateTable();
  if (!table) return null;
  try {
    const key = jsonArg({ pk: { S: `turn#${channelArn}#${responderId}` } });
    return aws(`dynamodb get-item --table-name ${table} --key ${key} --consistent-read`)?.Item ?? null;
  } catch {
    return null;
  }
}

/**
 * The correlation id currently holding this conversation, or '' when nothing does.
 *
 * THE ONLY HONEST "IT IS BUSY NOW". A queue forms only while a turn is running, so a test that sends
 * follow-ups after a fixed sleep is asserting on a race: too early and the lock is not taken, too
 * late and the turn is finished, and BOTH produce "no queue" - which reads as the queue being broken
 * rather than as the setup never establishing its precondition. Measured: three sends four seconds
 * apart were answered as three separate turns, with "nothing queued behind this turn" in the log.
 */
export function holderOf(channelArn: string, responderId: string): string {
  // `.holder.S`, not `.holder`. The item arrives in DynamoDB WIRE format - every attribute is a
  // `{S: ...}` wrapper, which is why `pendingSplitRow` below reaches through `.M` and `.L`. Reading
  // the attribute directly and stringifying it yields "[object Object]", which is truthy: a lock
  // that was never taken would have read as held, and the wait for it would pass instantly.
  return turnStateItem(channelArn, responderId)?.holder?.S ?? '';
}

/**
 * The offer as recorded, which is what a person's later answer is checked against.
 *
 * `offeredTo` is a MAP keyed by principal id inside the offer - who was asked travels WITH the
 * question rather than beside it, so the two cannot disagree. A record written before that was true
 * carries a single string, and both are read here: during the window where both shapes exist, a
 * reader that knew only one would report a working deployment as a broken one.
 */
export function pendingSplitRow(channelArn: string, responderId: string): PendingSplitRecord | null {
  const raw = turnStateItem(channelArn, responderId)?.pendingSplit?.M;
  if (!raw) return null;
  return {
    offeredTo: raw.offeredTo?.M
      ? Object.keys(raw.offeredTo.M)
      : (raw.offeredTo?.S ? [raw.offeredTo.S] : []),
    topics: (raw.topics?.L ?? []).map((t: any) => ({
      label: t?.M?.label?.S ?? '',
      messageIds: (t?.M?.messageIds?.L ?? []).map((m: any) => m?.S ?? ''),
      ...(t?.M?.private?.BOOL ? { private: true as const } : {}),
      ...(t?.M?.requestorId?.S ? { requestorId: t.M.requestorId.S } : {}),
    })),
  };
}

/**
 * The amendments this conversation has recorded and not yet folded in.
 *
 * Read directly, because the fold's whole signature is a TRANSITION: the reading writes the ids, and
 * only the running turn folding them in takes them off again. Recorded-then-cleared is the fold
 * happening; recorded-and-stuck is a reading that classified an amendment which reached nothing.
 */
export function amendmentsRow(channelArn: string, responderId: string): string[] | null {
  const item = turnStateItem(channelArn, responderId);
  if (!item) return null;
  return (item.amendments?.L ?? []).map((m: any) => m?.S ?? '').filter(Boolean);
}

/**
 * The intent each queued message was classified as when it queued, by message id (ADR-064 decision B), as the router
 * recorded it beside the queue (`queuedIntents`). Null when the record cannot be read.
 */
export function queuedIntentsRow(channelArn: string, responderId: string): Record<string, string> | null {
  const item = turnStateItem(channelArn, responderId);
  if (!item) return null;
  const byId: Record<string, string> = {};
  for (const e of item.queuedIntents?.L ?? []) {
    const id = e?.M?.messageId?.S;
    const intent = e?.M?.intent?.S;
    if (id && intent) byId[id] = intent;
  }
  return byId;
}

/** The ids waiting in the queue right now, oldest first. Null when the record cannot be read. */
export function queuedRow(channelArn: string, responderId: string): string[] | null {
  const item = turnStateItem(channelArn, responderId);
  if (!item) return null;
  return (item.queued?.L ?? []).map((m: any) => m?.S ?? '').filter(Boolean);
}

/**
 * Send a message AS a given member, addressed privately to one other.
 *
 * Amazon Chime SDK returns a targeted message only to its sender and its target, so this is how a
 * request that the room cannot read is produced - and the only way to make a topic PRIVATE, since
 * `topicsForOffer` marks a subject private exactly when its messages were targeted.
 *
 * Returns the sent message's id, which is what an answer to it declares as its `answersMessageId`.
 */
export function sendTargetedAs(
  channelArn: string,
  senderUserArn: string,
  targetArn: string,
  content: string,
): string {
  const res = aws([
    'chime-sdk-messaging', 'send-channel-message',
    `--channel-arn "${channelArn}"`,
    `--content "${content.replace(/"/g, '\\"')}"`,
    '--type STANDARD',
    '--persistence PERSISTENT',
    `--chime-bearer "${senderUserArn}"`,
    `--target MemberArn=${targetArn}`,
  ].join(' '));
  return String(res?.MessageId || '');
}
