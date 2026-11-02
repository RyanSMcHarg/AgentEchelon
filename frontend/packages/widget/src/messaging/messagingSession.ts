/**
 * ONE SHARED AMAZON CHIME SDK MESSAGING SESSION PER APPINSTANCEUSER, for the widget's frame.
 *
 * One `DefaultMessagingSession` (amazon-chime-sdk-js) per person, reused across subscribers and kept on
 * `window` so a remount converges on one socket. One observer parses every frame, reads the channel ARN
 * from the message payload, and fans CREATE, UPDATE, DELETE and REDACT events out to that channel's
 * subscribers. UPDATE is how the async processor replaces a placeholder in place, so a subscriber upserts
 * by message id.
 *
 * A backgrounded tab's socket can be severed silently: when the tab returns and no frame has arrived for
 * five minutes, the session is restarted and its subscribers refetch history to close the gap.
 *
 * The credentials are a provider (`WidgetSession.credentials`), so the SDK asks again near expiry and a
 * restart always connects with a fresh session credential.
 */
import { ChimeSDKMessagingClient, GetMessagingSessionEndpointCommand } from '@aws-sdk/client-chime-sdk-messaging';
import {
  ConsoleLogger,
  DefaultMessagingSession,
  LogLevel,
  MessagingSessionConfiguration,
  type MessagingSession,
} from 'amazon-chime-sdk-js';
import type { CredentialProvider } from '../session/widgetSession';

/** A channel-message event, normalized from the raw WebSocket payload. */
export interface IncomingChannelMessage {
  messageId: string;
  /** Raw Content, still URI-encoded where the sender encoded it. */
  content: string;
  metadata?: string;
  senderArn?: string;
  senderName?: string;
  createdTimestamp?: string;
}

export interface ChannelSubscriber {
  onMessage?: (m: IncomingChannelMessage) => void;
  onDelete?: (messageId: string) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

const STALE_MS = 5 * 60 * 1000;

class SharedMessagingSession {
  readonly userArn: string;
  refCount = 0;
  private session: MessagingSession | null = null;
  private starting: Promise<void> | null = null;
  private connected = false;
  private lastFrameAt = 0;
  private readonly subs = new Map<string, Set<ChannelSubscriber>>();
  private readonly client: ChimeSDKMessagingClient;
  private visibilityHandler: (() => void) | null = null;

  constructor(userArn: string, region: string, credentials: CredentialProvider) {
    this.userArn = userArn;
    this.client = new ChimeSDKMessagingClient({ region, credentials });
  }

  async ensureStarted(): Promise<void> {
    if (this.connected) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    const ep = await this.client.send(new GetMessagingSessionEndpointCommand({}));
    const configuration = new MessagingSessionConfiguration(this.userArn, null, ep.Endpoint?.Url, this.client);
    const session = new DefaultMessagingSession(configuration, new ConsoleLogger('AEWidgetMessaging', LogLevel.WARN));
    session.addObserver({
      messagingSessionDidStart: () => {
        this.connected = true;
        this.lastFrameAt = Date.now();
        this.subs.forEach((set) => set.forEach((s) => s.onConnected?.()));
      },
      messagingSessionDidStop: () => {
        this.connected = false;
        this.subs.forEach((set) => set.forEach((s) => s.onDisconnected?.()));
      },
      messagingSessionDidReceiveMessage: (message) => {
        this.lastFrameAt = Date.now();
        this.dispatch(message as unknown as RawFrame);
      },
    });
    await session.start();
    this.session = session;
    this.installVisibilityReconnect();
  }

  private dispatch(frame: RawFrame): void {
    const type = frame?.type;
    if (!type || !frame.payload) return;
    const isDelete = type === 'DELETE_CHANNEL_MESSAGE' || type === 'REDACT_CHANNEL_MESSAGE';
    if (type !== 'CREATE_CHANNEL_MESSAGE' && type !== 'UPDATE_CHANNEL_MESSAGE' && !isDelete) return;
    let payload: RawPayload;
    try {
      payload = JSON.parse(frame.payload) as RawPayload;
    } catch {
      return;
    }
    const set = payload.ChannelArn ? this.subs.get(payload.ChannelArn) : undefined;
    if (!set?.size || !payload.MessageId) return;
    const id = payload.MessageId;
    if (isDelete) {
      set.forEach((s) => s.onDelete?.(id));
      return;
    }
    const m: IncomingChannelMessage = {
      messageId: id,
      content: payload.Content ?? '',
      metadata: payload.Metadata,
      senderArn: payload.Sender?.Arn,
      senderName: payload.Sender?.Name,
      createdTimestamp: payload.CreatedTimestamp,
    };
    set.forEach((s) => s.onMessage?.(m));
  }

  subscribe(channelArn: string, sub: ChannelSubscriber): () => void {
    let set = this.subs.get(channelArn);
    if (!set) {
      set = new Set();
      this.subs.set(channelArn, set);
    }
    set.add(sub);
    return () => {
      const cur = this.subs.get(channelArn);
      if (!cur) return;
      cur.delete(sub);
      if (cur.size === 0) this.subs.delete(channelArn);
    };
  }

  isConnected(): boolean {
    return this.connected;
  }

  private installVisibilityReconnect(): void {
    if (this.visibilityHandler || typeof document === 'undefined') return;
    this.visibilityHandler = () => {
      if (document.visibilityState !== 'visible') return;
      if (!this.connected || Date.now() - this.lastFrameAt > STALE_MS) void this.restart();
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  async restart(): Promise<void> {
    try {
      this.session?.stop();
    } catch {
      /* already stopped */
    }
    this.session = null;
    this.connected = false;
    await this.ensureStarted();
  }

  stop(): void {
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    try {
      this.session?.stop();
    } catch {
      /* already stopped */
    }
    this.session = null;
    this.connected = false;
    this.subs.clear();
  }
}

interface RawFrame {
  type?: string;
  payload?: string;
}
interface RawPayload {
  ChannelArn?: string;
  MessageId?: string;
  Content?: string;
  Metadata?: string;
  CreatedTimestamp?: string;
  Sender?: { Arn?: string; Name?: string };
}

interface SessionWindow {
  __aeWidgetMessagingSession?: SharedMessagingSession;
}

/**
 * Subscribe to one channel on the person's shared session, starting it on first use. Throws when the
 * socket cannot start; the caller retries. `release()` unsubscribes and stops the socket with its last
 * subscriber.
 */
export async function acquireChannelSubscription(args: {
  userArn: string;
  region: string;
  credentials: CredentialProvider;
  channelArn: string;
  subscriber: ChannelSubscriber;
}): Promise<{ release: () => void; isConnected: () => boolean }> {
  const w = window as unknown as SessionWindow;
  let shared = w.__aeWidgetMessagingSession;
  if (shared && shared.userArn !== args.userArn) {
    shared.stop();
    shared = undefined;
  }
  if (!shared) {
    shared = new SharedMessagingSession(args.userArn, args.region, args.credentials);
    w.__aeWidgetMessagingSession = shared;
  }
  const session = shared;
  session.refCount += 1;
  const unsubscribe = session.subscribe(args.channelArn, args.subscriber);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    unsubscribe();
    session.refCount -= 1;
    if (session.refCount <= 0) {
      session.stop();
      if (w.__aeWidgetMessagingSession === session) w.__aeWidgetMessagingSession = undefined;
    }
  };
  try {
    await session.ensureStarted();
  } catch (err) {
    release();
    throw err;
  }
  return { release, isConnected: () => session.isConnected() };
}
