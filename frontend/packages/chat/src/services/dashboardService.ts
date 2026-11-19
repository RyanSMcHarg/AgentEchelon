/**
 * A CONVERSATION'S DASHBOARD, AS A MEMBER READS IT (DESIGN-CONVERSATION-DASHBOARDS section 4).
 *
 * The dashboard message carries references only: which kind, which conversation, when it was updated. The figures are
 * read here, with the member's own credentials:
 *
 *  - `snapshot`: the credential exchange checks the member is in the conversation, then vends a session that reads that
 *    one conversation's `snapshot.json`. The browser signs the read itself, so no server reads it on the member's behalf.
 *  - `page`: `POST /dashboard-link` checks the same, then returns a five-minute signed link to the page.
 */
import { ensureFreshIdToken, exchangeCredentials, isAssistantArn, onSessionEnd, personApiServes, personUrl, resolvePersonIdentity } from '@ae/shared';

/** What a dashboard message carries (`dashboard-tool.ts`), lifted from its Metadata. Anything malformed is no dashboard. */
export interface DashboardOnMessage {
  kind: 'snapshot' | 'page';
  conversationId: string;
  updatedAt: string;
  state?: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA';
}

/** A conversation id, by the backend's rule: `CONVERSATION_ID` in `backend/lambda/src/lib/dashboard-keys.ts`. */
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function dashboardFromMetadata(metadata: Record<string, unknown>, senderArn: string): DashboardOnMessage | undefined {
  const raw = metadata.dashboard as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  // AN ASSISTANT'S OWN MESSAGE, by its sender: a member can write any Metadata, and must not draw a dashboard by writing it.
  if (!isAssistantArn(senderArn)) return undefined;
  const kind = raw.kind === 'snapshot' || raw.kind === 'page' ? raw.kind : undefined;
  const conversationId = typeof raw.conversationId === 'string' && CONVERSATION_ID.test(raw.conversationId) ? raw.conversationId : '';
  const updatedAt = typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt)) ? raw.updatedAt : '';
  const state = raw.state === 'ALARM' || raw.state === 'OK' || raw.state === 'INSUFFICIENT_DATA' ? raw.state : undefined;
  return kind && conversationId && updatedAt ? { kind, conversationId, updatedAt, ...(state ? { state } : {}) } : undefined;
}

/** A refusal the server named, shown in the client's own words. */
export class DashboardError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const raw = key instanceof Uint8Array ? new Uint8Array(key).buffer as ArrayBuffer : key;
  const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}
/** RFC 3986 encoding, as Signature Version 4 requires. */
const uri = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * A SIGNATURE VERSION 4 QUERY-SIGNED GET for one S3 object, signed in the browser with the member's own session, so no
 * server reads it on their behalf. Tested against the SDK's own signer.
 */
export async function presignedGet(
  loc: { bucket: string; key: string; region: string },
  creds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
  now: Date = new Date(),
): Promise<string> {
  const host = `${loc.bucket}.s3.${loc.region}.amazonaws.com`;
  const path = `/${loc.key.split('/').map(uri).join('/')}`;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${loc.region}/s3/aws4_request`;
  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${creds.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    // FIVE MINUTES, so a client clock a few minutes off still reads; it is fetched at once.
    'X-Amz-Expires': '300',
    'X-Amz-SignedHeaders': 'host',
    ...(creds.sessionToken ? { 'X-Amz-Security-Token': creds.sessionToken } : {}),
  };
  const query = Object.keys(params).sort().map((k) => `${uri(k)}=${uri(params[k])}`).join('&');
  const canonical = ['GET', path, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(canonical)].join('\n');
  let key = await hmac(enc.encode(`AWS4${creds.secretAccessKey}`), day);
  for (const part of [loc.region, 's3', 'aws4_request']) key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));
  return `https://${host}${path}?${query}&X-Amz-Signature=${signature}`;
}

type DashboardRead = Awaited<ReturnType<typeof exchangeCredentials>>;
/**
 * ONE EXCHANGE'S ANSWER SERVES ONE PERSON IN ONE CONVERSATION FOR A MINUTE, so an open dashboard refreshes without a new
 * exchange, and a removal or a clearance downgrade reaches the read within that minute. A sign-out drops every entry.
 */
const READ_HELD_MS = 60_000;
const reads = new Map<string, { answer: DashboardRead; heldUntil: number }>();
const usable = (entry: { answer: DashboardRead; heldUntil: number }) => {
  const now = Date.now();
  const expiration = entry.answer.credentials.expiration;
  return now < entry.heldUntil && (!expiration || expiration.getTime() - now > 60_000);
};

let sessionsEnded = 0;
let watchingSessions = false;
function dropReadsAtSignOut(): void {
  if (watchingSessions) return;
  watchingSessions = true;
  onSessionEnd(() => { sessionsEnded += 1; reads.clear(); });
}

/** The in-app dashboard's markup, read with the member's own session for this one conversation. */
export async function readDashboardSnapshot(channelArn: string): Promise<string> {
  dropReadsAtSignOut();
  const session = sessionsEnded;
  const token = await ensureFreshIdToken();
  if (!token) throw new DashboardError('NOT_SIGNED_IN');
  const person = await resolvePersonIdentity(token).catch(() => null);
  if (!person) throw new DashboardError('UNAVAILABLE');
  const key = `${person.personId} ${channelArn}`;
  const held = reads.get(key);
  let answer = held && usable(held) ? held.answer : undefined;
  if (!answer) {
    reads.delete(key);
    try {
      answer = await exchangeCredentials({ channelArn, capabilities: ['dashboard'] }, token);
    } catch (err) {
      throw new DashboardError((err as { code?: string }).code || 'UNAVAILABLE');
    }
    if (session === sessionsEnded) reads.set(key, { answer, heldUntil: Date.now() + READ_HELD_MS });
  }
  if (!answer.dashboard) throw new DashboardError('UNAVAILABLE');
  const res = await fetch(await presignedGet(answer.dashboard, answer.credentials), { cache: 'no-store' });
  // NOT THERE YET: this session may read the object and may not list the bucket, so S3 answers a missing key with a 403 where
  // a caller that may list hears a 404. The credential was vended for this object, so neither names a refusal of the member.
  if (res.status === 403 || res.status === 404) throw new DashboardError('NOT_PUBLISHED');
  if (!res.ok) { reads.delete(key); throw new DashboardError('UNAVAILABLE'); }
  const body = await res.json() as { html?: unknown };
  if (typeof body.html !== 'string') throw new DashboardError('UNAVAILABLE');
  return body.html;
}

/** A five-minute signed link to the dashboard page, issued to a member only. */
export async function dashboardPageLink(conversationId: string): Promise<string> {
  // THE ROUTE IS THE `dashboard-pages` CAPABILITY'S, served only where the deployment declares it.
  if (!personApiServes('dashboard-pages')) throw new DashboardError('UNAVAILABLE');
  const token = await ensureFreshIdToken();
  if (!token) throw new DashboardError('NOT_SIGNED_IN');
  const res = await fetch(personUrl('/dashboard-link'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId }),
  });
  const body = await res.json().catch(() => ({})) as { url?: string; code?: string };
  if (!res.ok || typeof body.url !== 'string') throw new DashboardError(body.code || 'UNAVAILABLE');
  return body.url;
}

/** The sandboxed document the in-app view shows: the fragment, under a policy that loads and runs nothing. */
export function dashboardDocument(html: string, lang: string): string {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  return `<!doctype html><html lang="${lang.replace(/[^A-Za-z-]/g, '') || 'en'}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${csp}"><style>html,body{margin:0}</style></head><body>${html}</body></html>`;
}
