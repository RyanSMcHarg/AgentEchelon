/**
 * Bot-to-bot coordination, and the loop guard that bounds it.
 *
 * WHY THIS EXISTS BEFORE THE FEATURE THAT NEEDS IT. Every targeted send in this backend today
 * addresses a HUMAN - the channel flow's rejection notices, the federated add-member welcome, the
 * battle clarification question, and the continuation chunks that mirror a placeholder. There is not
 * one message anywhere whose sender is a bot and whose `Target` names a bot, which is why no loop is
 * possible today. The ADR-023 round-2 nudge would be the FIRST, so the guard lands first.
 *
 * THE LOOP, CONCRETELY. `TargetedMessages: ALL` routes a targeted message to the target bot's Lex
 * (the continuation path denies a message for exactly that reason - see `channel-flow-processor.ts`
 * where the deny is justified). Chime then materialises a reply from the Lex return and targets it
 * back at the inbound's sender. So bot A nudging bot B produces a reply aimed at A, which routes to
 * A's Lex, which produces a reply aimed at B, and nothing in that cycle terminates it. Each hop is a
 * Lex invocation and potentially a model call, in a channel where no human can see any of it.
 *
 * THE TERMINATOR IS THE EMPTY ENVELOPE, AND IT CANNOT BE MARKED. A handler that wants to say nothing
 * returns `messages: []`, and Chime still materialises a message from it (verified live - see the
 * duplicate-placeholder guard's comment). That message has no content, so it can carry no marker, so
 * DEFAULT-DENY on an unmarked bot-to-bot message is what actually stops the exchange. That ordering
 * is the whole design: the guard does not depend on any handler behaving correctly.
 *
 * WHAT MAKES THIS SAFE FROM A BAD ACTOR. The marker lives in message content, which a user can type.
 * It is only ever consulted for a message whose SENDER is a bot, and the sender ARN is stamped by
 * Amazon Chime SDK rather than supplied by the client, so a user cannot forge their way onto this
 * path. A user's own message - even one addressed to a bot with a hand-typed marker - resolves to
 * `not-bot-sender` and is none of this module's business.
 *
 * Pure. No I/O, no clients, no environment. The flow calls it with data it already holds, so the
 * guard costs nothing on the hot path that every bot message crosses.
 */

/**
 * What a coordination message is for. Deliberately a closed set of two.
 *
 * `nudge` - one assistant telling a peer to run its next phase. `ack` - the peer confirming receipt.
 * An exchange is exactly these two messages and there is no third kind, because a third kind is how
 * a bounded handshake becomes a protocol and a protocol becomes a loop.
 */
export type CoordinationKind = 'nudge' | 'ack';

/**
 * The hop a coordination message occupies: a `nudge` is 1, its `ack` is 2. Anything beyond 2 is a
 * bug by definition, so the cap is the circuit breaker rather than a tuning knob.
 */
export const MAX_COORDINATION_HOP = 2;

/** The hop each kind is allowed to occupy. A `nudge` at hop 2 is a second nudge inside one exchange. */
const HOP_FOR_KIND: Record<CoordinationKind, number> = { nudge: 1, ack: 2 };

export interface CoordinationMarker {
  kind: CoordinationKind;
  hop: number;
  /**
   * What this exchange is about - the battle id, today. Generic on purpose: the loop guard is a
   * property of bot-to-bot messaging, not of battles, and naming the field `battleId` would invite
   * the next coordination feature to add a second marker rather than reuse this one.
   */
  ref: string;
}

/**
 * `<!--aecoord:kind=nudge,hop=1,ref=battle-abc-->`
 *
 * Bounded and character-classed exactly like `<!--corr:-->`, so a crafted marker cannot smuggle a
 * value. `hop` is a single digit by construction, so it can never parse to something the cap has to
 * catch numerically.
 */
const COORD_MARKER = /<!--aecoord:kind=(nudge|ack),hop=([0-9]),ref=([A-Za-z0-9._-]{1,64})-->/;

/** Render a coordination marker for the sender to append to its message content. */
export function formatCoordinationMarker(marker: CoordinationMarker): string {
  return `<!--aecoord:kind=${marker.kind},hop=${marker.hop},ref=${marker.ref}-->`;
}

/**
 * The coordination marker a message carries, or null.
 *
 * Raw form first, decoded second, mirroring `correlationMarkerOf`: Amazon Chime SDK delivers message
 * content percent-encoded to the channel flow, and a malformed escape anywhere in the message makes
 * `decodeURIComponent` throw. A throw is not an error here - it means "no marker", which for this
 * guard means DENY rather than allow, so the failure direction is already the safe one.
 */
export function parseCoordinationMarker(content: string | undefined | null): CoordinationMarker | null {
  if (!content) return null;
  const read = (s: string): CoordinationMarker | null => {
    const m = COORD_MARKER.exec(s);
    return m ? { kind: m[1] as CoordinationKind, hop: Number(m[2]), ref: m[3] } : null;
  };
  const direct = read(content);
  if (direct) return direct;
  try {
    return read(decodeURIComponent(content));
  } catch {
    return null;
  }
}

/** Why the guard reached its verdict. Logged, and asserted on in the tests. */
export type CoordinationReason =
  | 'not-bot-sender'
  | 'not-bot-targeted'
  | 'coordination'
  | 'unmarked'
  | 'self-targeted'
  | 'hop-exceeded'
  | 'wrong-hop-for-kind';

export interface CoordinationVerdict {
  action: 'allow' | 'deny';
  reason: CoordinationReason;
  /** Present only on an allowed coordination message. */
  marker?: CoordinationMarker;
  /**
   * True when this verdict indicates a defect rather than the designed terminator.
   *
   * `unmarked` is the EXPECTED end of a healthy exchange (the ack's empty envelope), so it must stay
   * quiet or every duel would fail the e2e backend-error guard. The other denials mean a coordination
   * bug got past the handler, and those should be loud enough to fail a run - the guard greps handler
   * logs for `ERROR`, so logging them at error level is the whole reporting mechanism.
   */
  anomalous: boolean;
}

/**
 * Should this message be delivered?
 *
 * DEFAULT-DENY, and only for the bot-to-bot case. Anything a human sent, and anything not addressed
 * to a bot, is waved through untouched - this guard exists to bound one message shape, not to become
 * a second opinion on ordinary delivery.
 *
 * The ordering matters. `self-targeted` is checked before the marker, because a bot addressing itself
 * is a guaranteed self-loop no matter how well-formed its marker is.
 */
export function evaluateBotToBot(args: {
  /** The message's sender ARN, as stamped by Amazon Chime SDK. */
  senderArn: string;
  /** Bot ARNs named in the message `Target` (see `extractTargetedBotArns`). */
  targetBotArns: string[];
  /** Raw message content; percent-encoded or not. */
  content: string | undefined | null;
}): CoordinationVerdict {
  const { senderArn, targetBotArns, content } = args;

  if (!senderArn.includes('/bot/')) {
    return { action: 'allow', reason: 'not-bot-sender', anomalous: false };
  }
  if (targetBotArns.length === 0) {
    return { action: 'allow', reason: 'not-bot-targeted', anomalous: false };
  }
  if (targetBotArns.includes(senderArn)) {
    return { action: 'deny', reason: 'self-targeted', anomalous: true };
  }

  const marker = parseCoordinationMarker(content);
  if (!marker) {
    // The designed terminator: an ack's empty envelope has no content to mark. Not a defect.
    return { action: 'deny', reason: 'unmarked', anomalous: false };
  }
  if (marker.hop > MAX_COORDINATION_HOP) {
    return { action: 'deny', reason: 'hop-exceeded', anomalous: true };
  }
  if (marker.hop !== HOP_FOR_KIND[marker.kind]) {
    return { action: 'deny', reason: 'wrong-hop-for-kind', anomalous: true };
  }
  return { action: 'allow', reason: 'coordination', marker, anomalous: false };
}
