/**
 * THE CONSOLE'S EVENTS, AS THE CONSOLE FOLLOWS THEM (ADR-065, `frontend/packages/admin/src/services/consoleEvents.ts`).
 *
 * Subscribes to one run's or batch's channel on the AppSync Event API with the operator's console credentials, and
 * resolves when the platform says it ended. A spec subscribes BEFORE it starts the work, so the event cannot be missed,
 * and the event itself is the proof that the push path works end to end: the async destination, the rule, the publisher,
 * IAM on both sides and the namespace's subscribe handler.
 *
 * Needs VITE_CONSOLE_EVENTS_HTTP and VITE_CONSOLE_EVENTS_REALTIME, which `validate.mjs` resolves from AdminServices.
 */
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { consoleCreds } from './signed-analytics';

const REGION = process.env.AWS_REGION || 'us-east-1';
export const CONSOLE_EVENTS_HTTP = process.env.VITE_CONSOLE_EVENTS_HTTP || '';
export const CONSOLE_EVENTS_REALTIME = process.env.VITE_CONSOLE_EVENTS_REALTIME || '';

export interface BatchEnded {
  id: string;
  kind: 'run' | 'upload' | 'generation';
  status: 'complete' | 'refused' | 'failed';
}

async function authorization(idToken: string, body: string): Promise<Record<string, string>> {
  const signer = new SignatureV4({ credentials: await consoleCreds(idToken), region: REGION, service: 'appsync', sha256: Sha256 });
  const signed = await signer.sign({
    method: 'POST', protocol: 'https:', hostname: CONSOLE_EVENTS_HTTP, path: '/event', query: {}, body,
    headers: {
      accept: 'application/json, text/javascript',
      'content-encoding': 'amz-1.0',
      'content-type': 'application/json; charset=UTF-8',
      host: CONSOLE_EVENTS_HTTP,
    },
  });
  return signed.headers as Record<string, string>;
}

/**
 * Follow `/console/batch/<id>`. `ready` resolves once the subscription stands (start the work after it), `ended` with the
 * event, and `refused` resolves with the API's refusal of a subscription (a wildcard, or a session without the grant).
 */
export function followConsoleBatch(idToken: string, channelId: string): {
  ready: Promise<void>;
  ended: Promise<BatchEnded>;
  refused: Promise<string>;
  close: () => void;
} {
  let resolveReady!: () => void;
  let resolveEnded!: (e: BatchEnded) => void;
  let resolveRefused!: (why: string) => void;
  const ready = new Promise<void>((r) => { resolveReady = r; });
  const ended = new Promise<BatchEnded>((r) => { resolveEnded = r; });
  const refused = new Promise<string>((r) => { resolveRefused = r; });
  let socket: WebSocket | null = null;
  const channel = `/console/batch/${channelId}`;
  void (async () => {
    const header = Buffer.from(JSON.stringify(await authorization(idToken, '{}'))).toString('base64url');
    socket = new WebSocket(`wss://${CONSOLE_EVENTS_REALTIME}/event/realtime`, ['aws-appsync-event-ws', `header-${header}`]);
    socket.onopen = () => socket?.send(JSON.stringify({ type: 'connection_init' }));
    socket.onmessage = async (message) => {
      const m = JSON.parse(String(message.data)) as { type?: string; event?: string; errors?: unknown };
      if (m.type === 'connection_ack') {
        socket?.send(JSON.stringify({ type: 'subscribe', id: crypto.randomUUID(), channel, authorization: await authorization(idToken, JSON.stringify({ channel })) }));
      } else if (m.type === 'subscribe_success') {
        resolveReady();
      } else if (m.type === 'data' && m.event) {
        resolveEnded(JSON.parse(m.event) as BatchEnded);
      } else if (m.type === 'subscribe_error' || m.type === 'connection_error' || m.type === 'error') {
        resolveRefused(JSON.stringify(m));
      }
    };
  })();
  return { ready, ended, refused, close: () => socket?.close() };
}
