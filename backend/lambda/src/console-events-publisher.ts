/**
 * TELLS THE CONSOLE THAT A GOLDEN RUN OR A GOLDEN-SET BATCH ENDED (ADR-065, tenet D6).
 *
 * A classification's GoldenRun function is invoked as an Event and runs in the archive's VPC, which has no route to
 * EventBridge or AppSync. The Lambda service itself reports how each invocation ended to EventBridge (the function's async
 * destination); a rule sends those reports here, outside the VPC, and this publishes one event on the console's channel for
 * that run or batch, `/console/batch/<id>`. The console subscribed to that channel when it started the work, reads the
 * result once when told, and never polls.
 *
 * WHAT IS PUBLISHED IS AN ID, A KIND AND A STATUS. Never a count, a refusal or any text: the result is read through the
 * console's own authorized route, so the channel says only "this ended". The ids are random or content-derived UUIDs the
 * starter was given, and the channel namespace refuses a wildcard subscription, so a session follows only work it knows.
 */
import { SignatureV4 } from '@smithy/signature-v4';
import type { HttpRequest } from '@smithy/types';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

/** The fields of a Lambda async destination's record this reads. */
export interface InvocationRecord {
  'detail-type'?: string;
  detail?: {
    requestPayload?: { op?: string; runId?: string; uploadId?: string; generationId?: string };
    responsePayload?: { status?: string } | null;
  };
}

export interface ConsoleEvent {
  id: string;
  kind: 'run' | 'upload' | 'generation';
  status: 'complete' | 'refused' | 'failed';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The event for a record, or null when there is nothing to tell: a read (gate, batch), a batch that was already running
 * and did nothing, or a record with no usable id. A failed invocation is told as failed.
 */
export function consoleEventOf(record: InvocationRecord): ConsoleEvent | null {
  const req = record.detail?.requestPayload;
  const kind = req?.op === 'start' ? 'run' : req?.op === 'import' ? 'upload' : req?.op === 'generate' ? 'generation' : null;
  const id = req?.op === 'start' ? req.runId : req?.op === 'import' ? req.uploadId : req?.generationId;
  if (!kind || !id || !UUID.test(id)) return null;
  if (/Failure/.test(record['detail-type'] ?? '')) return { id, kind, status: 'failed' };
  const status = record.detail?.responsePayload?.status;
  if (status === 'complete' || status === 'refused' || status === 'failed') return { id, kind, status };
  return null;
}

/** The channel a run or batch is told on. */
export const consoleChannel = (id: string): string => `/console/batch/${id}`;

export async function handler(record: InvocationRecord): Promise<{ published: boolean }> {
  const event = consoleEventOf(record);
  if (!event) return { published: false };
  const host = process.env.CONSOLE_EVENTS_HTTP_DNS || '';
  if (!host) throw new Error('[console-events] CONSOLE_EVENTS_HTTP_DNS is not set');
  const body = JSON.stringify({ channel: consoleChannel(event.id), events: [JSON.stringify(event)] });
  const signer = new SignatureV4({
    credentials: defaultProvider(), region: process.env.AWS_REGION || 'us-east-1', service: 'appsync', sha256: Sha256,
  });
  const request: HttpRequest = {
    method: 'POST', protocol: 'https:', hostname: host, path: '/event', query: {},
    headers: { host, 'content-type': 'application/json' }, body,
  };
  const signed = await signer.sign(request);
  const res = await fetch(`https://${host}/event`, { method: 'POST', headers: signed.headers as Record<string, string>, body });
  if (!res.ok) throw new Error(`[console-events] publish refused: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return { published: true };
}
