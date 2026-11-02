/**
 * ONE CONVERSATION, LIVE: history loaded once, then the shared WebSocket session's events.
 *
 * `ListChannelMessages` loads the history once and again on every (re)connect, to close a gap. After
 * that the transcript changes only on CREATE, UPDATE, DELETE and REDACT events (tenet D6), upserted by
 * message id, so a placeholder the async processor UPDATEs in place re-renders the same bubble.
 *
 * When the socket cannot start, the widget says so and tries again after a growing delay. The timer is
 * armed in that failure branch only: it is a recovery, never a poll.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChannelMessagePersistenceType,
  ChannelMessageType,
  ChimeSDKMessagingClient,
  ListChannelMessagesCommand,
  SendChannelMessageCommand,
} from '@aws-sdk/client-chime-sdk-messaging';
import { REGION } from '@ae/shared/platform/config.ts';
import type { WidgetSession } from '../session/widgetSession';
import { acquireChannelSubscription, type IncomingChannelMessage } from './messagingSession';
import { displayText } from './messageFormat';

export type ChannelStatus = 'connecting' | 'live' | 'reconnecting' | 'sendFailed';

export interface TranscriptMessage {
  id: string;
  /** Sent by the person in this frame. */
  mine: boolean;
  /** Sent by an assistant (an AppInstanceBot). */
  fromAssistant: boolean;
  senderName?: string;
  /** ISO 8601. */
  createdAt?: string;
  text: string;
}

export interface ChannelState {
  messages: TranscriptMessage[];
  status: ChannelStatus;
  send: (text: string) => Promise<void>;
}

/** The delays before each retry of a socket that would not start, in milliseconds; the last repeats. */
export const RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 30_000];

const isAssistantArn = (arn?: string) => !!arn && arn.includes('/bot/');

function toMessage(
  raw: { id: string; content?: string; senderArn?: string; senderName?: string; createdAt?: string },
  userArn: string,
): TranscriptMessage {
  return {
    id: raw.id,
    mine: raw.senderArn === userArn,
    fromAssistant: isAssistantArn(raw.senderArn),
    senderName: raw.senderName,
    createdAt: raw.createdAt,
    text: displayText(raw.content),
  };
}

function byCreatedAt(a: TranscriptMessage, b: TranscriptMessage): number {
  const ta = a.createdAt ? Date.parse(a.createdAt) : Number.MAX_SAFE_INTEGER;
  const tb = b.createdAt ? Date.parse(b.createdAt) : Number.MAX_SAFE_INTEGER;
  return ta - tb;
}

export function useChannel(session: WidgetSession): ChannelState {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [status, setStatus] = useState<ChannelStatus>('connecting');
  const client = useMemo(
    () => new ChimeSDKMessagingClient({ region: REGION, credentials: session.credentials }),
    [session],
  );
  const connectedRef = useRef(false);

  const upsert = useCallback(
    (raw: IncomingChannelMessage) => {
      const m = toMessage(
        { id: raw.messageId, content: raw.content, senderArn: raw.senderArn, senderName: raw.senderName, createdAt: raw.createdTimestamp },
        session.userArn,
      );
      setMessages((cur) => {
        const i = cur.findIndex((x) => x.id === m.id);
        if (i >= 0) {
          const next = cur.slice();
          next[i] = m;
          return next;
        }
        return [...cur, m].sort(byCreatedAt);
      });
    },
    [session.userArn],
  );

  const loadHistory = useCallback(async () => {
    const r = await client.send(new ListChannelMessagesCommand({
      ChannelArn: session.channelArn,
      ChimeBearer: session.userArn,
      SortOrder: 'ASCENDING',
      MaxResults: 50,
    }));
    const next = (r.ChannelMessages ?? []).filter((m) => m.MessageId).map((m) => toMessage({
      id: m.MessageId!,
      content: m.Content,
      senderArn: m.Sender?.Arn,
      senderName: m.Sender?.Name,
      createdAt: m.CreatedTimestamp instanceof Date ? m.CreatedTimestamp.toISOString() : undefined,
    }, session.userArn));
    // History is authoritative, and a live message it does not list yet (eventual consistency) stays.
    setMessages((cur) => {
      const ids = new Set(next.map((m) => m.id));
      return [...next, ...cur.filter((m) => !ids.has(m.id))].sort(byCreatedAt);
    });
  }, [client, session]);

  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = async () => {
      try {
        const handle = await acquireChannelSubscription({
          userArn: session.userArn,
          region: REGION,
          credentials: session.credentials,
          channelArn: session.channelArn,
          subscriber: {
            onMessage: upsert,
            onDelete: (id) => setMessages((cur) => cur.filter((m) => m.id !== id)),
            onConnected: () => {
              connectedRef.current = true;
              setStatus('live');
              void loadHistory().catch(() => undefined);
            },
            onDisconnected: () => {
              connectedRef.current = false;
              setStatus('reconnecting');
            },
          },
        });
        if (cancelled) {
          handle.release();
          return;
        }
        release = handle.release;
        attempt = 0;
        connectedRef.current = handle.isConnected();
        await loadHistory();
        if (!cancelled) setStatus(handle.isConnected() ? 'live' : 'reconnecting');
      } catch {
        if (cancelled) return;
        // THE ONE TIMER: armed only because the socket did not start.
        setStatus('reconnecting');
        const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
        attempt += 1;
        retry = setTimeout(() => void connect(), delay);
      }
    };
    void connect();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      release?.();
    };
  }, [session, upsert, loadHistory]);

  const send = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t) return;
    try {
      await client.send(new SendChannelMessageCommand({
        ChannelArn: session.channelArn,
        ChimeBearer: session.userArn,
        Content: encodeURIComponent(t),
        Type: ChannelMessageType.STANDARD,
        Persistence: ChannelMessagePersistenceType.PERSISTENT,
      }));
      // The socket echoes the message. Without a socket, history is read once so the message shows.
      if (!connectedRef.current) void loadHistory().catch(() => undefined);
      setStatus((s) => (s === 'sendFailed' ? (connectedRef.current ? 'live' : 'reconnecting') : s));
    } catch {
      setStatus('sendFailed');
    }
  }, [client, session, loadHistory]);

  return { messages, status, send };
}
