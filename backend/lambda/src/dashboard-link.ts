/**
 * A MEMBER'S LINK TO THEIR CONVERSATION'S DASHBOARD PAGE (DESIGN-CONVERSATION-DASHBOARDS section 4, `publish_dashboard_page`).
 *
 * `POST /dashboard-link { conversationId }`. The caller's membership and clearance are checked as the presigner checks them,
 * then one CloudFront URL is signed for that conversation's `page.html`, valid for five minutes. Nothing is signed for a
 * caller who is not in the conversation, and the URL names the one object, so it opens nothing else.
 *
 * A SIGNED URL CANNOT BE REVOKED: a person removed from the conversation keeps a link already signed for them until it
 * expires, and no longer. That is the trade this delivery makes and the in-app view does not.
 */
import { createSign } from 'crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { readCachedSecret } from './lib/secret-cache.js';
import { loadProfileRegistry } from '../../lib/profile-registry';
import { callerReachesConversation } from './lib/conversation-access.js';
import { CONVERSATION_ID, dashboardPageUrl } from './lib/dashboard-keys.js';
import { originsFrom, requestOrigin, responder } from './lib/http-response.js';

const LINK_SECONDS = Number(process.env.DASHBOARD_LINK_SECONDS || '300');
const DOMAIN = process.env.DASHBOARD_DOMAIN || '';
const KEY_PAIR_ID = process.env.DASHBOARD_KEY_PAIR_ID || '';
const SECRET_ARN = process.env.DASHBOARD_SIGNING_SECRET_ARN || '';
const http = responder({ origin: { allow: originsFrom(process.env.ALLOWED_ORIGIN, 'http://localhost:5173') }, methods: 'POST,OPTIONS' });


/** The base64 CloudFront expects in a URL: `+` `=` `/` replaced by `-` `_` `~`. */
const urlSafe = (b64: string): string => b64.replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');

/** A canned-policy signed URL for one resource, expiring at `expires` (epoch seconds). */
export function signCannedUrl(url: string, expires: number, keyPairId: string, pem: string): string {
  const policy = JSON.stringify({ Statement: [{ Resource: url, Condition: { DateLessThan: { 'AWS:EpochTime': expires } } }] });
  const signature = createSign('RSA-SHA1').update(policy).sign(pem, 'base64');
  return `${url}?Expires=${expires}&Signature=${urlSafe(signature)}&Key-Pair-Id=${encodeURIComponent(keyPairId)}`;
}

export async function handler(event: APIGatewayProxyEvent) {
  const origin = requestOrigin(event);
  const reply = (statusCode: number, body: Record<string, unknown>) => http.respond(statusCode, body, origin);
  let conversationId = '';
  try {
    const body = event?.body ? JSON.parse(event.body) : {};
    if (typeof body?.conversationId === 'string') conversationId = body.conversationId;
  } catch { /* a malformed body names no conversation */ }
  if (!CONVERSATION_ID.test(conversationId)) return reply(400, { error: 'conversationId names one conversation' });
  if (!DOMAIN || !KEY_PAIR_ID || !SECRET_ARN) return reply(503, { error: 'dashboard pages are not available on this deployment' });

  // THE SAME CHECK THE PRESIGNER MAKES: a member now, cleared for the conversation's classification now. It reads the
  // classification it reaches from the registry, so the registry loads first; a fault in either is pages unavailable.
  let access: Awaited<ReturnType<typeof callerReachesConversation>>;
  try {
    await loadProfileRegistry();
    access = await callerReachesConversation(event, conversationId);
  } catch (err) {
    console.error('[dashboard-link] the conversation check could not run:', (err as Error).name);
    return reply(503, { error: 'dashboard pages are not available on this deployment' });
  }
  if (!access.ok) return reply(access.status, { error: 'this conversation\'s dashboard is not yours to open', code: access.code });

  const url = dashboardPageUrl(DOMAIN, access.classification, conversationId);
  if (!url) return reply(400, { error: 'this conversation has no dashboard page' });
  // THE SIGNING KEY THROUGH THE ONE SECRET CACHE: a key that cannot be read is pages unavailable, never an unhandled fault.
  const privateKey = await readCachedSecret({ secretId: SECRET_ARN }).catch((err: unknown) => {
    console.error('[dashboard-link] the signing key could not be read', { name: (err as Error)?.name, message: (err as Error)?.message });
    return '';
  });
  if (!privateKey) return reply(503, { error: 'dashboard pages are not available on this deployment' });
  const expires = Math.floor(Date.now() / 1000) + LINK_SECONDS;
  return reply(200, { url: signCannedUrl(url, expires, KEY_PAIR_ID, privateKey), expiresAt: new Date(expires * 1000).toISOString() });
}
