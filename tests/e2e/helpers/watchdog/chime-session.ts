/**
 * AN AMAZON CHIME SDK MESSAGING SESSION HELD BY THE TEST RUNNER, AS ONE MEMBER.
 *
 * The browser's own messaging socket is what `channel-wire.ts` records, but a spec that drives the platform
 * through its API has no browser, and the run-level alert listener has no page at all. This is the same
 * session the chat app opens (a presigned `wss://.../connect` as one AppInstanceUser), opened from Node, so a
 * runner-side wait wakes on the message event instead of re-listing the channel on a timer.
 *
 * WHAT A RECONNECT DOES. A dropped socket is reopened, and every subscriber is told (`onConnected`) so it can
 * read what it missed with one `ListChannelMessages`. That read is the reconnect's catch-up step, never a
 * timer: a session that stays up reads nothing.
 */
import { randomUUID } from 'crypto';
import { type AwsCredentials, type CredentialSource, REGION, presignWebSocket, signedJson } from './aws-signing';

const MESSAGING_HOST = `messaging-chime.${REGION}.amazonaws.com`;

/** One channel message event, decoded the way the app and the archive decode it. */
export interface WireEvent {
  /** `CREATE_CHANNEL_MESSAGE`, `UPDATE_CHANNEL_MESSAGE`, `DELETE_CHANNEL_MESSAGE`, `REDACT_CHANNEL_MESSAGE`, ... */
  eventType: string;
  channelArn: string;
  messageId: string;
  senderArn: string;
  /** URI-decoded; a Lex envelope unwrapped. */
  content: string;
  metadata: Record<string, any>;
  target: string[];
  createdAtMs: number;
}

/** A message as `ListChannelMessages` returns it, in the same decoded shape. */
export type ListedMessage = Omit<WireEvent, 'eventType'>;

export function decodeContent(raw: string): string {
  let content = raw || '';
  try {
    if (content.startsWith('{') && content.includes('"Messages"')) {
      const lex = JSON.parse(content);
      if (lex.Messages?.[0]?.Content) content = lex.Messages[0].Content;
    }
  } catch { /* not Lex-wrapped */ }
  try {
    if (content.includes('%')) content = decodeURIComponent(content);
  } catch { /* not URI-encoded */ }
  return content;
}

function parseMeta(raw: unknown): Record<string, any> {
  if (raw && typeof raw === 'object') return raw as Record<string, any>;
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Decode one message record, whether it came off the socket or out of a listing. */
export function decodeMessage(m: any, channelArn?: string): ListedMessage {
  return {
    channelArn: String(m?.ChannelArn || channelArn || ''),
    messageId: String(m?.MessageId || ''),
    senderArn: String(m?.Sender?.Arn || ''),
    content: decodeContent(String(m?.Content || '')),
    metadata: parseMeta(m?.Metadata),
    target: ((m?.Target ?? []) as any[]).map((t) => String(t?.MemberArn || '')).filter(Boolean),
    createdAtMs: Date.parse(String(m?.CreatedTimestamp || '')) || Date.now(),
  };
}

/**
 * One page-walk of `ListChannelMessages` as `bearerArn`, oldest first: that member's view of the room, since
 * a targeted message is returned only to its sender and its targets.
 */
export async function listChannelMessages(
  creds: AwsCredentials, channelArn: string, bearerArn: string, opts: { notBeforeMs?: number; maxPages?: number } = {},
): Promise<ListedMessage[]> {
  const out: ListedMessage[] = [];
  let next = '';
  for (let page = 0; page < (opts.maxPages ?? 10); page += 1) {
    const query: Record<string, string> = { 'max-results': '50', 'sort-order': 'DESCENDING' };
    if (next) query['next-token'] = next;
    if (opts.notBeforeMs) query['not-before'] = new Date(opts.notBeforeMs).toISOString();
    const j = await signedJson(creds, 'chime', {
      method: 'GET', hostname: MESSAGING_HOST, path: `/channels/${encodeURIComponent(channelArn)}/messages`, query,
      headers: { 'x-amz-chime-bearer': bearerArn },
    });
    for (const m of (j?.ChannelMessages ?? []) as any[]) out.push(decodeMessage(m, channelArn));
    next = String(j?.NextToken || '');
    if (!next) break;
  }
  return out.sort((a, b) => a.createdAtMs - b.createdAtMs);
}

export interface SessionOptions {
  userArn: string;
  credentials: CredentialSource;
  /** Named in the status lines, so a run log says whose session dropped. */
  label: string;
  onStatus?: (status: string) => void;
}

/** One member's messaging session, reopened whenever it drops. */
export class ChimeMessagingSession {
  private ws: WebSocket | null = null;
  private stopped = false;
  private retryMs = 1_000;
  private readonly listeners = new Set<(e: WireEvent) => void>();
  private readonly connectedListeners = new Set<() => void>();
  private firstEstablished: Promise<void> | null = null;
  private resolveFirst: (() => void) | null = null;
  private rejectFirst: ((err: Error) => void) | null = null;
  private established = false;

  constructor(private readonly opts: SessionOptions) {}

  get userArn(): string {
    return this.opts.userArn;
  }

  get isEstablished(): boolean {
    return this.established;
  }

  credentials(): Promise<AwsCredentials> {
    return this.opts.credentials();
  }

  /** Every message event this member's session receives. Returns the unsubscribe. */
  onEvent(listener: (e: WireEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Told on every (re)connect, after the service says the session is established. */
  onConnected(listener: () => void): () => void {
    this.connectedListeners.add(listener);
    return () => this.connectedListeners.delete(listener);
  }

  /** Open the session; resolves once it is established, rejects when the first attempt cannot be made. */
  start(timeoutMs = 30_000): Promise<void> {
    if (this.firstEstablished) return this.firstEstablished;
    this.firstEstablished = new Promise<void>((resolve, reject) => {
      this.resolveFirst = resolve;
      this.rejectFirst = reject;
      const t = setTimeout(() => reject(new Error(`${this.opts.label}: the messaging session was not established in ${timeoutMs / 1000}s`)), timeoutMs);
      t.unref?.();
    });
    void this.open();
    return this.firstEstablished;
  }

  stop(): void {
    this.stopped = true;
    try { this.ws?.close(); } catch { /* already closed */ }
  }

  private reopenLater(why: string): void {
    this.established = false;
    if (this.stopped) return;
    this.opts.onStatus?.(`${this.opts.label}: messaging session closed (${why}); reopening`);
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
    const t = setTimeout(() => void this.open(), wait);
    t.unref?.();
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    let url: string;
    try {
      const creds = await this.opts.credentials();
      const endpoint = await signedJson(creds, 'chime', { method: 'GET', hostname: MESSAGING_HOST, path: '/endpoints/messaging-session' });
      const host = String(endpoint?.Endpoint?.Url || '').replace(/^wss?:\/\//, '').replace(/\/.*$/, '');
      if (!host) throw new Error('no messaging session endpoint');
      url = await presignWebSocket(creds, 'chime', host, '/connect', { userArn: this.opts.userArn, sessionId: randomUUID() });
    } catch (err) {
      if (this.rejectFirst && !this.established) {
        // The first attempt is the caller's to report; later ones keep retrying.
        this.rejectFirst(new Error(`${this.opts.label}: ${err}`));
        this.rejectFirst = null;
      }
      this.reopenLater(String(err));
      return;
    }
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.addEventListener('message', (ev: MessageEvent) => this.handle(typeof ev.data === 'string' ? ev.data : String(ev.data)));
    ws.addEventListener('close', (ev: CloseEvent) => {
      if (this.ws === ws) this.reopenLater(`code ${ev.code}${ev.reason ? ` ${ev.reason}` : ''}`);
    });
    ws.addEventListener('error', () => { /* the close that follows reopens it */ });
  }

  private handle(data: string): void {
    let json: any;
    try { json = JSON.parse(data); } catch { return; }
    const eventType: string = json?.Headers?.['x-amz-chime-event-type'] || '';
    if (eventType === 'SESSION_ESTABLISHED') {
      this.established = true;
      this.retryMs = 1_000;
      this.resolveFirst?.();
      this.resolveFirst = null;
      this.rejectFirst = null;
      for (const l of this.connectedListeners) {
        try { l(); } catch { /* one subscriber must not stop the others */ }
      }
      return;
    }
    if (!eventType.includes('CHANNEL_MESSAGE')) return;
    let payload: any;
    try { payload = typeof json.Payload === 'string' ? JSON.parse(json.Payload) : json.Payload; } catch { return; }
    if (!payload) return;
    const event: WireEvent = { eventType, ...decodeMessage(payload) };
    for (const l of this.listeners) {
      try { l(event); } catch { /* one subscriber must not stop the others */ }
    }
  }
}

const pool = new Map<string, ChimeMessagingSession>();

/**
 * The runner's session as `userArn`, opened once per worker and shared by every wait that reads as that
 * member. Operator credentials, bearing the member: the same authority `roomMessagesSeenBy` lists with.
 */
export async function sessionAs(userArn: string, credentials: CredentialSource, onStatus?: (s: string) => void): Promise<ChimeMessagingSession> {
  let s = pool.get(userArn);
  if (!s) {
    s = new ChimeMessagingSession({ userArn, credentials, label: `session as ${userArn.split('/').pop()}`, onStatus });
    pool.set(userArn, s);
  }
  try {
    await s.start();
  } catch (err) {
    pool.delete(userArn);
    s.stop();
    throw err;
  }
  return s;
}

/** Close every pooled session; the worker calls this as it ends. */
export function closeAllSessions(): void {
  for (const s of pool.values()) s.stop();
  pool.clear();
}
