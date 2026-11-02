/**
 * THE CONSOLE'S ACCESS LOG: who was given access to which conversation, when, and why (ADR-052, FR30).
 *
 *   GET /admin/access-log?days=30&channelId=<id>&actor=<personId>&limit=200
 *
 * An AWS_IAM catalog route (`view-access-log`, admins only), so the gateway refuses a role that does
 * not hold it before this runs. The handler refuses on its own as well (tenet D3): only an ADMIN console
 * session is admitted, because a read of this log must name the person reading it. A team session, an
 * Identity-Pool principal and a service proxy that names no person get 403 even if a grant admits them.
 *
 * READING THE LOG IS AN ACCESS, AND IS RECORDED LIKE ONE, before the records are returned. A read that
 * cannot be recorded returns 503 and nothing, which is the same rule the exchange applies to a vend.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { callerIsAdmin, callerPersonId, isAdminConsoleSession } from './lib/auth.js';
import { readAccessLog, recordAccess, ACCESS_LOG_RETENTION_DAYS, type AccessRecord } from './lib/access-log.js';
import { responder, originsFrom, requestOrigin } from './lib/http-response.js';
import { loadProfileRegistry } from '../../lib/profile-registry';

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN || '';
// A SigV4-signed route: the console sends the signing headers, so they are allowed here.
const http = responder({
  origin: { allow: originsFrom(process.env.ALLOWED_ORIGIN, '', { trim: true, dropEmpty: true }), fallback: '' },
  allowHeaders: 'Authorization,Content-Type,X-Amz-Date,X-Amz-Security-Token,X-Amz-Content-Sha256',
  methods: 'GET,OPTIONS',
});

const respond = (event: APIGatewayProxyEvent, statusCode: number, body: unknown): APIGatewayProxyResult =>
  http.respond(statusCode, body, requestOrigin(event));

/** A whole number in [min, max], the default when absent, or null when present and invalid. */
function wholeIn(raw: string | undefined, min: number, max: number, dflt: number): number | null {
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** What the console renders: the record, with the audit line parsed back out. */
function view(r: AccessRecord) {
  let detail: unknown = null;
  try { detail = JSON.parse(r.detail); } catch { /* left null: the stored line was not JSON */ }
  return {
    id: r.id, event: r.event, at: r.at, actor: r.actorPersonId,
    conversation: r.conversation ?? null, capabilities: r.capabilities, reason: r.reason ?? null, detail,
  };
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  if (event.httpMethod === 'OPTIONS') return respond(event, 200, {});
  if (event.httpMethod !== 'GET') return respond(event, 405, { error: 'Method not allowed' });

  const reader = isAdminConsoleSession(event) ? await callerPersonId(event) : null;
  if (!callerIsAdmin(event) || !reader) return respond(event, 403, { error: 'Admin access required' });

  const q = event.queryStringParameters || {};
  const days = wholeIn(q.days, 1, ACCESS_LOG_RETENTION_DAYS, 30);
  if (days === null) return respond(event, 400, { error: `days must be a whole number from 1 to ${ACCESS_LOG_RETENTION_DAYS}` });
  const limit = wholeIn(q.limit, 1, 500, 200);
  if (limit === null) return respond(event, 400, { error: 'limit must be a whole number from 1 to 500' });
  const channelId = (q.channelId || '').trim();
  if (channelId && !/^[A-Za-z0-9-]{1,64}$/.test(channelId)) return respond(event, 400, { error: 'channelId is not a conversation id' });
  const actor = (q.actor || '').trim();
  if (actor && !/^[A-Za-z0-9-]{1,64}$/.test(actor)) return respond(event, 400, { error: 'actor is not a person id' });
  const conversation = channelId && APP_INSTANCE_ARN ? `${APP_INSTANCE_ARN}/channel/${channelId}` : undefined;
  if (channelId && !conversation) return respond(event, 500, { error: 'Access log misconfigured' });

  try {
    await recordAccess({
      _auditEvent: 'access_log_read',
      timestamp: new Date().toISOString(),
      adminPersonId: reader,
      channelArn: conversation ?? null,
      capabilities: ['view-access-log'],
      filter: { days, ...(actor ? { actor } : {}), limit },
    });
  } catch (err) {
    console.error('[AccessLog][SecurityEvent] the read could not be recorded; nothing is returned', { err: (err as Error)?.message });
    return respond(event, 503, { error: 'This read cannot be recorded right now, so it is not served', code: 'ACCESS_LOG_UNAVAILABLE' });
  }

  try {
    const records = await readAccessLog({ days, limit, ...(conversation ? { conversation } : {}), ...(actor ? { actor } : {}) });
    return respond(event, 200, { records: records.map(view), days, limit });
  } catch (err) {
    console.error('[AccessLog] the log could not be read', { err: (err as Error)?.message });
    return respond(event, 500, { error: 'The access log could not be read' });
  }
};
