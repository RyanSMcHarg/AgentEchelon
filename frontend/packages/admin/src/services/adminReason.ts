/**
 * WHY AN OPERATOR IS REACHING A CONVERSATION (SPEC-ADMIN-CONSOLE FR51).
 *
 * Every per-conversation admin credential - a message read, the live member list, an attachment, a
 * redaction, a deletion, a membership change - is issued only with a stated reason, which the credential
 * exchange records beside what the credential reaches. This module is where the console obtains that
 * reason: the dashboard registers a dialog that asks for it, and every vend asks here first.
 *
 * READS ARE ASKED ONCE PER CONVERSATION, CHANGES EVERY TIME. Opening a conversation reads its messages,
 * its live members and perhaps an attachment, all for the one reason the operator opened it; asking three
 * times for the same purpose would train them to type nonsense, which is the failure mode a reason exists
 * to avoid. A change is a separate act on someone's record, so each one is asked for on its own.
 */
import i18n from '@ae/shared/i18n';

export type ReasonKind = 'read' | 'change';

export interface ReasonRequest {
  /** The catalog capability the credential is for, e.g. `view-messages` or `redact`. */
  capability: string;
  channelArn?: string;
  kind: ReasonKind;
  /** What a read reaches when it is not one conversation: a team's list of its assistant's responses. */
  subject?: 'responses';
  /** The key a read's reason is remembered under for the session, when it is not a conversation. */
  readKey?: string;
}

/** Thrown when the operator declines to give a reason; the action is abandoned, not failed. */
export class ReasonDeclinedError extends Error {
  constructor() {
    super(i18n.t('admin.reason.declined'));
    this.name = 'ReasonDeclinedError';
  }
}

type ReasonProvider = (request: ReasonRequest) => Promise<string | null>;
let provider: ReasonProvider | null = null;
/** The reason a conversation was opened for, reused by the other reads of that conversation. */
const readReasons = new Map<string, string>();

/** Register the dialog that asks for a reason. Returns the function that unregisters it. */
export function setReasonProvider(next: ReasonProvider): () => void {
  provider = next;
  return () => {
    if (provider === next) provider = null;
  };
}

/** Forget the reasons given in this page session (sign-out, or a test). */
export function clearReasons(): void {
  readReasons.clear();
}

/** A read of a conversation already being asked about, so its other reads wait for the same answer. */
const pendingReads = new Map<string, Promise<string>>();
/** The tail of the prompt queue: one dialog at a time, so a second request never replaces the first. */
let queue: Promise<unknown> = Promise.resolve();

/** The operator's reason for this credential, asked for when one is not already on record. */
export async function reasonFor(request: ReasonRequest): Promise<string> {
  const readKey = request.kind === 'read' ? (request.readKey ?? request.channelArn) : undefined;
  if (readKey) {
    const remembered = readReasons.get(readKey);
    if (remembered) return remembered;
    // OPENING A CONVERSATION READS SEVERAL THINGS AT ONCE - its messages and its live members load in
    // parallel - and they are one act with one reason. The second waits for the first's answer.
    const pending = pendingReads.get(readKey);
    if (pending) return pending;
  }
  const asked = (async () => {
    if (!provider) throw new Error(i18n.t('admin.reason.noPrompt'));
    const ask = provider;
    const answer = (await (queue = queue.catch(() => undefined).then(() => ask(request))) as string | null)?.trim();
    if (!answer) throw new ReasonDeclinedError();
    if (readKey) readReasons.set(readKey, answer);
    return answer;
  })();
  if (readKey) {
    pendingReads.set(readKey, asked);
    asked.finally(() => pendingReads.delete(readKey)).catch(() => undefined);
  }
  return asked;
}
