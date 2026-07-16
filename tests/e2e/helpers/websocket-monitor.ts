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

    return { eventType, senderArn, content, messageId: payload.MessageId || '' };
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
  private placeholderMessageId: string | null = null;

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
    this.placeholderMessageId = null;
    this.startTime = Date.now();

    if (!this.ws) {
      console.warn('[WsMonitor] No WebSocket captured -- returning empty timings');
      return Promise.resolve({
        userEchoMs: null, ttffMs: null, ttfrMs: null,
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

    if (parsed.eventType === 'CREATE_CHANNEL_MESSAGE') {
      if (!isBot && this.userEchoMs === null) {
        // User's own message echoed back
        this.userEchoMs = elapsed;
        console.log(`[WsMonitor] User echo: ${elapsed}ms`);
      } else if (isBot && this.ttffMs === null) {
        // First bot message -- either placeholder or DIRECT response
        this.ttffMs = elapsed;
        this.placeholderMessageId = parsed.messageId;
        if (isPlaceholder(parsed.content)) {
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
      // Bot updated the placeholder with the real response. Accept any
      // non-placeholder, non-empty content -- a correct terse answer (e.g. "4"
      // to "2 + 2") is legitimately short, so a length floor here would drop
      // the real UPDATE frame and force a 60s timeout + empty content.
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
      });
    }
  }
}
