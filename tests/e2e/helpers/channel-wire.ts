/**
 * Records every channel message the Chime SDK websocket delivers, for the WHOLE page session.
 *
 * WHY THIS EXISTS SEPARATELY FROM `WebSocketMonitor`. That monitor is a request/response stopwatch:
 * `handleFrame` returns immediately unless `startMonitoring()` has armed it for one exchange, so it
 * is blind to anything that arrives outside a turn - including the assistant's on-add WELCOME, which
 * is exactly the message with a history of going missing.
 *
 * WHAT IT BUYS. A DOM-only assertion cannot tell these two failures apart, and they have completely
 * different causes:
 *
 *   - the message never reached the browser  -> the assistant never posted it, or Chime never
 *     delivered it (a BACKEND fault)
 *   - the message reached the browser and never rendered -> the CLIENT dropped it
 *
 * The second is a real, shipped defect: roughly a third of new conversations rendered empty while the
 * welcome sat unread in the sidebar, because the client registered its rendering consumer per-channel
 * AFTER creation while the bookkeeping consumer was app-level (fixed in `d92a86b` by registering one
 * app-level channel handler). Recording the wire independently of the DOM is what makes that
 * distinction assertable instead of guessable.
 *
 * Attach BEFORE navigation - a listener added after `goto` misses the socket entirely.
 */
import { Page, WebSocket as PwWebSocket } from '@playwright/test';

export interface WireMessage {
  /** The channel the message belongs to - the frame carries it, so a recorder can serve many channels. */
  channelArn: string;
  messageId: string;
  /** Content as the sender composed it: Lex envelope unwrapped, then URI-decoded. */
  content: string;
  /** Content exactly as it arrived, before unwrapping. Kept so a failure can show the real bytes. */
  raw: string;
  senderArn: string;
  isBot: boolean;
  eventType: string;
  /**
   * The message's parsed Chime Metadata, when it carried any. This is the backend's own account of the
   * turn - model attribution, intent, experiment/variant - so a test can assert how a reply was
   * produced instead of inferring it from the text. Undefined when the frame carried none (a user
   * message, or a placeholder before the processor's UPDATE).
   */
  metadata?: Record<string, unknown>;
  /** Wall-clock arrival, for measuring how long after creation the welcome actually landed. */
  atMs: number;
}

/**
 * Unwrap a Chime message's Content the same way the app and the archive do: the Lex fulfillment
 * arrives as a `{"Messages":[{"Content":...}]}` envelope, and Content may be URI-encoded.
 * Order matters - unwrap first, decode second (`admin-conversations.listMessages` does the same).
 */
function unwrapContent(rawContent: string): string {
  let content = rawContent || '';
  try {
    if (content.startsWith('{') && content.includes('"Messages"')) {
      const lex = JSON.parse(content);
      if (lex.Messages?.[0]?.Content) content = lex.Messages[0].Content;
    }
  } catch { /* not Lex-wrapped - keep as-is */ }
  try {
    if (content.includes('%')) content = decodeURIComponent(content);
  } catch { /* not URI-encoded - keep as-is */ }
  return content;
}

export class ChannelWireRecorder {
  private readonly messages: WireMessage[] = [];
  private socketSeen = false;

  attach(page: Page): void {
    page.on('websocket', (ws: PwWebSocket) => {
      // The Chime SDK messaging socket; the same discriminator WebSocketMonitor uses.
      if (!ws.url().includes('/connect')) return;
      this.socketSeen = true;
      ws.on('framereceived', (event: { payload: string | Buffer }) => this.record(event.payload.toString()));
    });
  }

  /** False when no Chime socket ever opened - the recorder proves nothing, and a caller must say so
   *  rather than read "no messages" as "the backend posted nothing". */
  get connected(): boolean {
    return this.socketSeen;
  }

  private record(data: string): void {
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const eventType: string = json.Headers?.['x-amz-chime-event-type'] || '';
    if (!eventType.includes('CHANNEL_MESSAGE')) return;

    let payload: any;
    try {
      payload = typeof json.Payload === 'string' ? JSON.parse(json.Payload) : json.Payload;
    } catch {
      return;
    }
    if (!payload) return;

    const senderArn: string = payload.Sender?.Arn || '';
    const raw: string = payload.Content || '';
    // Chime carries Metadata as a JSON STRING alongside Content. It is where the processor stamps how
    // a turn was produced - model, intent, experiment/variant attribution - so a test can assert the
    // BACKEND's account of a turn rather than the text it happened to render. Unparseable metadata is
    // recorded as undefined rather than throwing: a malformed value must not lose the whole frame.
    let metadata: Record<string, unknown> | undefined;
    if (payload.Metadata) {
      try {
        metadata = typeof payload.Metadata === 'string' ? JSON.parse(payload.Metadata) : payload.Metadata;
      } catch { /* leave undefined */ }
    }
    this.messages.push({
      channelArn: payload.ChannelArn || '',
      messageId: payload.MessageId || '',
      content: unwrapContent(raw),
      raw,
      senderArn,
      isBot: senderArn.includes('/bot/'),
      eventType,
      metadata,
      atMs: Date.now(),
    });
  }

  /** Every bot message seen for a channel, in arrival order. */
  botMessagesFor(channelArn: string): WireMessage[] {
    return this.messages.filter((m) => m.isBot && m.channelArn === channelArn);
  }

  /** All frames seen, for a failure diagnostic that shows what DID arrive. */
  get all(): WireMessage[] {
    return [...this.messages];
  }

  /**
   * Wait for the first bot message on a channel. Resolves `null` on timeout rather than throwing:
   * "nothing arrived" is a result the caller has to distinguish from "arrived but did not render",
   * and an exception here would collapse the two.
   */
  async waitForBotMessage(channelArn: string, timeoutMs = 20_000): Promise<WireMessage | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.botMessagesFor(channelArn)[0];
      if (found) return found;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
