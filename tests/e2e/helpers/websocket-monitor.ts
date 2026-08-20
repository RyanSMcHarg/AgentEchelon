/**
 * WebSocket Monitor for Chime SDK Message Flow
 *
 * Captures accurate per-event timestamps (TTFF/TTFR) by intercepting
 * Chime SDK WebSocket frames directly, avoiding DOM polling overhead.
 *
 * Console/WebSocket monitoring helper for Playwright e2e.
 */
import { Page, WebSocket as PwWebSocket } from '@playwright/test';

// Placeholder patterns the bot sends before the real response
const PLACEHOLDER_STRINGS = [
  'one moment',
  'analyzing',
  'checking availability',
  'processing',
  'let me help',
  'looking into',
  'helping schedule',
  'submitting your',
  'gathering meeting',
  'gathering details',
  '<!--corr:',
];

const PLACEHOLDER_REGEXES = [
  /^(thinking|retrieving|searching|reviewing)\b/i,
  /^\.{2,}$/,
  /^\s*loading\b/i,
];

/**
 * Check if a message is a placeholder/intermediate message from the bot.
 */
export function isPlaceholder(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (PLACEHOLDER_STRINGS.some(p => lower.includes(p))) return true;
  if (PLACEHOLDER_REGEXES.some(r => r.test(text.trim()))) return true;
  return false;
}

/**
 * Timestamps for each event in the message flow, captured via WebSocket.
 *
 * Flow (PLACEHOLDER_UPDATE path):
 *   T=0    User presses Enter
 *   T+X    CREATE_CHANNEL_MESSAGE from user -> userEchoMs
 *   T+Y    CREATE_CHANNEL_MESSAGE from bot (placeholder) -> ttffMs
 *   T+Z    UPDATE_CHANNEL_MESSAGE from bot (final response) -> ttfrMs
 *
 * Flow (DIRECT path):
 *   T=0    User presses Enter
 *   T+X    CREATE_CHANNEL_MESSAGE from user -> userEchoMs
 *   T+Y    CREATE_CHANNEL_MESSAGE from bot (final response) -> ttffMs = ttfrMs
 */
export interface WebSocketTimings {
  /** When the user's own message echoed back via WebSocket */
  userEchoMs: number | null;
  /** When the bot's first message arrived (placeholder or DIRECT response) -- TTFF */
  ttffMs: number | null;
  /** When the bot's final response arrived (UPDATE or DIRECT CREATE) -- TTFR */
  ttfrMs: number | null;
  /** Whether the response was DIRECT (single CREATE, no placeholder/update cycle) */
  isDirect: boolean;
  /** Content of the final response from WebSocket */
  responseContent: string;
  /**
   * The `respPhase` the accepted frame DECLARED, when it declared one.
   *
   * Exposed so a caller can tell "this is the settled answer" from "this is as far as the frame path
   * got" without re-reading the text. `null` means the frame carried no phase and the content test
   * decided - which is the older, weaker path, kept for writers that do not stamp one.
   */
  responsePhase: string | null;
}

/**
 * Parse a raw Chime SDK WebSocket frame.
 * Frame format: JSON with Headers and Payload fields.
 * See: DefaultMessagingSession.receiveMessageHandler() in amazon-chime-sdk-js
 */
function parseChimeFrame(data: string): {
  eventType: string;
  senderArn: string;
  content: string;
  messageId: string;
  /**
   * The message's `Metadata`, parsed. This carries the turn's analytics — including which model
   * actually served it (`bedrockModel`) and the classified `intent`.
   *
   * Captured because a whole class of assertion is otherwise impossible from a browser: a test can
   * see the REPLY but not which model produced it, so "should access Opus model" could only ever
   * assert that the answer mentioned quantum physics — which a Haiku reply passes just as well.
   */
  metadata: Record<string, unknown> | null;
} | null {
  try {
    const json = JSON.parse(data);
    const eventType = json.Headers?.['x-amz-chime-event-type'] || '';
    if (!eventType.includes('CHANNEL_MESSAGE')) return null;

    const payload = typeof json.Payload === 'string' ? JSON.parse(json.Payload) : json.Payload;
    if (!payload) return null;

    const senderArn = payload.Sender?.Arn || '';

    // Extract content -- may be Lex JSON-wrapped or URL-encoded
    let content = payload.Content || '';
    try {
      if (content.startsWith('{') && content.includes('"Messages"')) {
        const lexResponse = JSON.parse(content);
        if (lexResponse.Messages?.[0]?.Content) {
          content = lexResponse.Messages[0].Content;
        }
      }
    } catch { /* not Lex-wrapped */ }
    try {
      if (content.includes('%')) {
        content = decodeURIComponent(content);
      }
    } catch { /* not URL-encoded */ }

    let metadata: Record<string, unknown> | null = null;
    try {
      if (typeof payload.Metadata === 'string' && payload.Metadata.trim()) {
        metadata = JSON.parse(payload.Metadata);
      } else if (payload.Metadata && typeof payload.Metadata === 'object') {
        metadata = payload.Metadata as Record<string, unknown>;
      }
    } catch { /* metadata is best-effort; a turn without it is not a failure */ }

    return { eventType, senderArn, content, messageId: payload.MessageId || '', metadata };
  } catch {
    return null;
  }
}

/**
 * Monitors the Chime SDK WebSocket for message flow events.
 * Captures per-event timestamps for accurate TTFF/TTFR measurement
 * without DOM polling overhead.
 *
 * Usage:
 *   const monitor = new WebSocketMonitor();
 *   monitor.attach(page);  // before navigation
 *   // ... navigate, open widget ...
 *   const wsPromise = monitor.startMonitoring();
 *   // ... send message ...
 *   const timings = await wsPromise;
 */
export class WebSocketMonitor {
  private ws: PwWebSocket | null = null;
  private monitorResolve: ((timings: WebSocketTimings) => void) | null = null;
  private monitorTimer: ReturnType<typeof setTimeout> | null = null;
  private startTime = 0;
  private userEchoMs: number | null = null;
  private ttffMs: number | null = null;
  private ttfrMs: number | null = null;
  private responseContent = '';
  /** The phase the accepted frame declared, or null when it carried none. */
  private responsePhase: string | null = null;
  private placeholderMessageId: string | null = null;

  /**
   * Metadata from the most recent BOT frame seen. Exposed because a browser test can read the reply
   * text but nothing about how it was produced — which model served it, which intent was classified.
   * Those are the claims several specs make and none could previously assert.
   */
  private lastBotMetadataValue: Record<string, unknown> | null = null;

  /** Metadata of the latest bot message (model attribution, intent, correlation id), or null. */
  get lastBotMetadata(): Record<string, unknown> | null {
    return this.lastBotMetadataValue;
  }

  /** MessageId of the most recent bot message — the handle a moderation action targets. */
  private lastBotMessageIdValue: string | null = null;

  get lastBotMessageId(): string | null {
    return this.lastBotMessageIdValue;
  }

  /**
   * Attach to the page to capture the Chime SDK WebSocket when it opens.
   * Must be called BEFORE the WebSocket is created (before widget opens or
   * conversation loads).
   */
  attach(page: Page): void {
    page.on('websocket', (ws: PwWebSocket) => {
      // Chime SDK messaging WebSocket URL contains '/connect'
      if (ws.url().includes('/connect')) {
        this.ws = ws;
        console.log(`[WsMonitor] Captured Chime WebSocket: ${ws.url().substring(0, 80)}...`);
        // Persistent frame listener -- only processes when monitoring is active
        ws.on('framereceived', (event: { payload: string | Buffer }) => {
          this.handleFrame(event);
        });
      }
    });
  }

  /** Whether a WebSocket has been captured */
  get connected(): boolean {
    return this.ws !== null;
  }

  /**
   * Start monitoring for a single message exchange.
   * Returns a Promise that resolves with timings when the full flow completes
   * (bot UPDATE received) or times out.
   * Call this BEFORE sending the user message.
   */
  startMonitoring(timeoutMs: number = 60000): Promise<WebSocketTimings> {
    // Reset state for this monitoring round
    this.userEchoMs = null;
    this.ttffMs = null;
    this.ttfrMs = null;
    this.responseContent = '';
    this.responsePhase = null;
    this.placeholderMessageId = null;
    this.startTime = Date.now();

    if (!this.ws) {
      console.warn('[WsMonitor] No WebSocket captured -- returning empty timings');
      return Promise.resolve({
        userEchoMs: null, ttffMs: null, ttfrMs: null, responsePhase: null,
        isDirect: false, responseContent: '',
      });
    }

    return new Promise<WebSocketTimings>((resolve) => {
      this.monitorResolve = resolve;

      // Timeout fallback -- return whatever we captured
      this.monitorTimer = setTimeout(() => {
        console.warn(`[WsMonitor] Timeout after ${timeoutMs}ms -- returning partial timings`);
        this.complete();
      }, timeoutMs);
    });
  }

  private handleFrame(event: { payload: string | Buffer }): void {
    if (!this.monitorResolve) return; // Not actively monitoring

    const data = event.payload.toString();
    const parsed = parseChimeFrame(data);
    if (!parsed) return;

    const elapsed = Date.now() - this.startTime;
    const isBot = parsed.senderArn.includes('/bot/');
    if (isBot && parsed.metadata) this.lastBotMetadataValue = parsed.metadata;
    if (isBot && parsed.messageId) this.lastBotMessageIdValue = parsed.messageId;

    if (parsed.eventType === 'CREATE_CHANNEL_MESSAGE') {
      if (!isBot && this.userEchoMs === null) {
        // User's own message echoed back
        this.userEchoMs = elapsed;
        console.log(`[WsMonitor] User echo: ${elapsed}ms`);
      } else if (isBot && this.ttffMs === null) {
        // First bot message -- either placeholder or DIRECT response
        this.ttffMs = elapsed;
        this.placeholderMessageId = parsed.messageId;
        // Same structural question as the UPDATE branch below: a frame that DECLARES a phase other
        // than `final` is not the answer, whatever its text looks like. A `placeholder` phase is the
        // ordinary case here; anything else that is not `final` is still work in progress.
        const createPhase = typeof parsed.metadata?.respPhase === 'string' ? parsed.metadata.respPhase : null;
        if (createPhase === 'placeholder' || createPhase === 'progress') {
          console.log(`[WsMonitor] Bot ${createPhase} (TTFF): ${elapsed}ms [msgId=${parsed.messageId.substring(0, 8)}]`);
        } else if (isPlaceholder(parsed.content)) {
          console.log(`[WsMonitor] Bot placeholder (TTFF): ${elapsed}ms [msgId=${parsed.messageId.substring(0, 8)}]`);
        } else {
          // DIRECT response -- no UPDATE will follow
          this.ttfrMs = elapsed;
          this.responseContent = parsed.content;
          console.log(`[WsMonitor] Bot direct (TTFF=TTFR): ${elapsed}ms -- "${parsed.content.substring(0, 60)}..."`);
          this.complete();
        }
      }
    } else if (parsed.eventType === 'UPDATE_CHANNEL_MESSAGE' && isBot) {
      // Only accept updates for the current turn's placeholder message
      if (!this.placeholderMessageId || parsed.messageId !== this.placeholderMessageId) {
        console.log(`[WsMonitor] Ignoring update for msgId=${parsed.messageId.substring(0, 8)} (expected ${this.placeholderMessageId?.substring(0, 8) ?? 'none'})`);
        return;
      }
      // WHICH STEP OF THE ANSWER THIS IS, ASKED STRUCTURALLY. Every update the platform writes stamps
      // `respPhase` into the message metadata (`updateMessage`), and only `final` closes the turn -
      // the runtime's own rule, which archival already gates `agent_final_at` on. An `interim` frame
      // is work in progress and must not be mistaken for the answer.
      //
      // THIS REPLACED A PHRASE LIST, and the list had just cost a test run. `isPlaceholder` matches
      // known placeholder COPY, so the moment the platform posted a progress line nobody had added to
      // it ("Tidying the document before delivering it..."), this frame was accepted as the settled
      // reply. `sendAndWaitForResponse` returned, the spec sent its next message into a turn that was
      // still generating, and the report was produced twice - three attachments where the test
      // expected two. A list of sentences cannot keep up with the copy the product writes.
      //
      // The text test remains as a FALLBACK for a frame with no phase: other writers post messages
      // (the channel flow's handed-back placeholder, a battle notice) and not all of them stamp one.
      const phase = typeof parsed.metadata?.respPhase === 'string' ? parsed.metadata.respPhase : null;
      if (phase === 'placeholder' || phase === 'progress') {
        console.log(`[WsMonitor] Ignoring ${phase} update for msgId=${parsed.messageId.substring(0, 8)}`);
        return;
      }
      // Every OTHER declared phase is a message the person can see and may have to act on - `final`
      // is the answer, `interim` is a duel's clarifying question, `error` is a failure that ended
      // their wait. All of them settle this monitor; only the two above are work in progress.
      if (phase && parsed.content.trim().length > 0) {
        this.ttfrMs = elapsed;
        this.responseContent = parsed.content;
        this.responsePhase = phase;
        console.log(`[WsMonitor] Bot update (TTFR, phase=${phase}): ${elapsed}ms -- "${parsed.content.substring(0, 60)}..."`);
        this.complete();
        return;
      }
      if (!isPlaceholder(parsed.content) && parsed.content.trim().length > 0) {
        this.ttfrMs = elapsed;
        this.responseContent = parsed.content;
        console.log(`[WsMonitor] Bot update (TTFR): ${elapsed}ms -- "${parsed.content.substring(0, 60)}..."`);
        this.complete();
      }
    }
  }

  private complete(): void {
    if (this.monitorTimer) {
      clearTimeout(this.monitorTimer);
      this.monitorTimer = null;
    }
    if (this.monitorResolve) {
      const resolve = this.monitorResolve;
      this.monitorResolve = null;
      resolve({
        userEchoMs: this.userEchoMs,
        ttffMs: this.ttffMs,
        ttfrMs: this.ttfrMs,
        isDirect: this.ttfrMs !== null && this.ttffMs === this.ttfrMs,
        responseContent: this.responseContent,
        responsePhase: this.responsePhase,
      });
    }
  }
}
