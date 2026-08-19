/**
 * A channel message as the Kinesis mirror of the Amazon Chime SDK message stream delivers it.
 *
 * WHY THIS SHAPE IS ITS OWN MODULE. The stream and the channel flow see DIFFERENT messages, and the
 * difference decides where a rule can live (ADR-032, MESSAGE-FLOW Appendix A). The flow's callback
 * carries no `Target` and cannot set one, so it cannot tell an addressed message from an unaddressed
 * one; the stream carries `Target` and `Metadata` intact. Any rule that reasons about how a message
 * was ADDRESSED can therefore only run here, after the fact.
 *
 * Kept deliberately minimal: the fields post-processing decides on, and nothing else. The archival
 * consumer on the same stream reads a much wider shape for its own purposes, and the two must not
 * become one type that grows to fit both.
 */

export interface StreamChannelMessage {
  MessageId?: string;
  ChannelArn?: string;
  Content?: string;
  Metadata?: string;
  Sender?: { Arn?: string; Name?: string };
  /**
   * WHO THE MESSAGE WAS ADDRESSED TO, and the field this whole component turns on.
   *
   * Both spellings are read because being wrong in this direction is the expensive one: treating an
   * addressed message as unaddressed dispatches a turn for a message that already reached an
   * assistant, and the person gets two answers with nothing anywhere reporting an error.
   */
  Target?: Array<{ MemberArn?: string }> | null;
  /** Defensive: an alternate spelling seen in some SDK shapes. Treated identically. */
  Targets?: Array<{ MemberArn?: string }> | null;
  /**
   * THE SECOND WAY A MESSAGE IS ADDRESSED, and it carries no `Target` at all.
   *
   * `CHIME.mentions` holds the member ARNs a message names, and Amazon Chime SDK routes a message
   * mentioning a bot to that bot's Lex. So a mention-addressed message reaches an assistant while
   * looking, on the `Target` field alone, exactly like one that reached nobody.
   *
   * Measured on the live stream 2026-08-14: the record carries `MessageAttributes` with the full
   * mention ARNs, alongside `Target` when set and omitting it when not.
   */
  MessageAttributes?: Record<string, { StringValues?: string[] }> | null;
  Type?: string;
  Persistence?: string;
}

export interface MessageStreamEvent {
  EventType?: string;
  Payload?: StreamChannelMessage;
}

/**
 * One Kinesis record, decoded, or undefined when it cannot be read.
 *
 * Undefined rather than a throw: a record this component cannot parse is not a decision it can make,
 * and a handler that throws on the stream stalls its shard for every message behind it.
 */
export function parseStreamRecord(base64Data: string): MessageStreamEvent | undefined {
  try {
    return JSON.parse(Buffer.from(base64Data, 'base64').toString('utf8')) as MessageStreamEvent;
  } catch {
    return undefined;
  }
}
