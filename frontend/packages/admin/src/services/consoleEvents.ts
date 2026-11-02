/**
 * TOLD WHEN BACKGROUND WORK ENDS, NEVER POLLING FOR IT (ADR-065, tenet D6).
 *
 * A golden run, an upload or a generation runs in the background on a classification's GoldenRun function. When it ends,
 * the platform publishes `{ id, kind, status }` on the AppSync Event API channel `/console/batch/<id>`
 * (`console-events-publisher.ts`). The console subscribes to the one channel of the work it started, signed with its own
 * console credentials (IAM), and closes the connection when told. The event carries no result: the caller reads that
 * through its own authorized route.
 *
 * Unconfigured (`VITE_CONSOLE_EVENTS_REALTIME` absent, as in Athena mode), nothing subscribes, and the console reads only
 * when asked (Check again).
 */
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { REGION } from '@ae/shared';
import { consoleCredentials } from './sigv4Fetch';

/** What the channel says when the work ended. */
export interface BatchEnded {
  id: string;
  kind: 'run' | 'upload' | 'generation';
  status: 'complete' | 'refused' | 'failed';
}

const httpDns = (): string => String(import.meta.env.VITE_CONSOLE_EVENTS_HTTP || '');
const realtimeDns = (): string => String(import.meta.env.VITE_CONSOLE_EVENTS_REALTIME || '');

/** Whether this deployment tells the console when work ends. */
export function consoleEventsConfigured(): boolean {
  return !!httpDns() && !!realtimeDns();
}

/** The headers that authorize one message on the API: a SigV4 signature of `body` as a POST to `/event`. */
async function authorization(body: string): Promise<Record<string, string>> {
  const host = httpDns();
  const signer = new SignatureV4({ credentials: await consoleCredentials(), region: REGION, service: 'appsync', sha256: Sha256 });
  const signed = await signer.sign({
    method: 'POST', protocol: 'https:', hostname: host, path: '/event', query: {}, body,
    headers: {
      accept: 'application/json, text/javascript',
      'content-encoding': 'amz-1.0',
      'content-type': 'application/json; charset=UTF-8',
      host,
    },
  });
  return signed.headers as Record<string, string>;
}

/** Base64url without padding, as the connection's header subprotocol carries it. */
function base64Url(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Follow one run or batch until it ends. `onReady` is called once the subscription stands, so the caller reads the state
 * once then (the work may have ended before the subscription did); `onEnded` once, when the channel says it ended; `onLost`
 * once if the connection closes or is refused first, so the caller reads once and offers Check again rather than waiting on
 * a channel that will say nothing. Returns a function that stops following. Does nothing where the deployment has no
 * console events.
 */
export function followBatch(
  id: string,
  onEnded: (e: BatchEnded) => void,
  onReady?: () => void,
  onLost?: () => void,
): () => void {
  if (!consoleEventsConfigured()) return () => {};
  let socket: WebSocket | null = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    socket?.close();
  };
  const lost = () => {
    if (stopped) return;
    stop();
    onLost?.();
  };
  const channel = `/console/batch/${id}`;
  void (async () => {
    try {
      const header = base64Url(JSON.stringify(await authorization('{}')));
      if (stopped) return;
      socket = new WebSocket(`wss://${realtimeDns()}/event/realtime`, ['aws-appsync-event-ws', `header-${header}`]);
      socket.onopen = () => socket?.send(JSON.stringify({ type: 'connection_init' }));
      socket.onclose = lost;
      socket.onerror = lost;
      socket.onmessage = async (message) => {
        const m = JSON.parse(String(message.data)) as { type?: string; event?: string };
        if (m.type === 'connection_ack') {
          socket?.send(JSON.stringify({ type: 'subscribe', id: crypto.randomUUID(), channel, authorization: await authorization(JSON.stringify({ channel })) }));
        } else if (m.type === 'subscribe_success') {
          onReady?.();
        } else if (m.type === 'data' && m.event) {
          const ended = JSON.parse(m.event) as BatchEnded;
          if (ended.id === id) {
            stop();
            onEnded(ended);
          }
        } else if (m.type === 'subscribe_error' || m.type === 'connection_error' || m.type === 'error') {
          // A connection the API refused leaves the caller where it was: it reads when asked.
          console.warn('[console-events]', 'subscribe_refused', m.type);
          lost();
        }
      };
    } catch (err) {
      console.warn('[console-events]', 'follow_failed', err instanceof Error ? err.name : String(err));
      lost();
    }
  })();
  return stop;
}
