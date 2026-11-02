/**
 * THE CONSOLE'S INVITATIONS (M-10, E6): a conversation's invitations with their status, and revoke.
 *
 * Two `AdminApi` routes behind IAM, each its own capability in the catalog (`view-invitations`,
 * `revoke-invitations`, `lib/config/admin-capabilities.ts`), so the gateway's `execute-api:Invoke` on the
 * one resource is the first layer and this handler's admin gate the second (tenet D3):
 *
 *   GET  /admin/conversations/{channelId}/invitations
 *   POST /admin/conversations/{channelId}/invitations/{invitationId}/revoke
 *
 * WHAT IS BEING ASKED ABOUT TRAVELS IN THE PATH, so the resource the console role is granted names it. The
 * work is the invitations function's (`invitations.ts`, in `Conversations`), invoked directly: one list and
 * one revocation for the inviter, a moderator and the console alike. This function holds no grant on
 * `Tokens` and no Amazon Chime SDK grant of its own; its one grant is the invoke.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { requireAdmin } from './lib/auth.js';
import { responder, originsFrom, requestOrigin, DEV_ORIGIN } from './lib/http-response.js';
// The deployment's set, read at runtime from the rows its stacks publish, before the handler runs.
import { withProfileRegistry } from '../../lib/profile-registry';

type Sender = { send(command: unknown): Promise<any> };

const http = responder({ origin: { allow: originsFrom(process.env.ALLOWED_ORIGINS, DEV_ORIGIN) }, methods: 'GET,POST,OPTIONS' });

export interface AdminInvitationsDeps {
  lambda?: Sender;
  invitationsFunction?: string;
  appInstanceArn?: string;
}

let defaultLambda: Sender | null = null;

export async function handleAdminInvitations(event: APIGatewayProxyEvent, d: AdminInvitationsDeps = {}): Promise<APIGatewayProxyResult> {
  const origin = requestOrigin(event);
  if (event.httpMethod === 'OPTIONS') return http.empty(200, origin);
  const gate = await requireAdmin(event);
  if ('statusCode' in gate) return gate;
  const fn = d.invitationsFunction ?? process.env.INVITATIONS_FUNCTION ?? '';
  const appInstanceArn = d.appInstanceArn ?? process.env.APP_INSTANCE_ARN ?? '';
  if (!fn || !appInstanceArn) return http.respond(503, { error: 'invitations are not configured on this deployment', code: 'INVITATIONS_UNAVAILABLE' }, origin);
  const channelId = event.pathParameters?.channelId || '';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(channelId)) return http.respond(400, { error: 'channelId names one conversation', code: 'INVITATION_INVALID' }, origin);
  const channelArn = `${appInstanceArn}/channel/${channelId}`;
  const invitationId = event.pathParameters?.invitationId || '';
  const revoking = event.httpMethod === 'POST' && /\/revoke$/.test(event.resource || event.path || '');
  if (revoking && !gate.claims.personId) {
    return http.respond(403, { error: 'a revocation is made by a person, from a console session', code: 'NOT_A_PERSON' }, origin);
  }
  const payload = revoking
    ? { op: 'admin-revoke', channelArn, invitationId, actor: gate.claims.personId }
    : { op: 'admin-list', channelArn };
  try {
    const invoked = await (d.lambda ?? (defaultLambda ??= new LambdaClient({}))).send(new InvokeCommand({
      FunctionName: fn,
      InvocationType: 'RequestResponse',
      Payload: new TextEncoder().encode(JSON.stringify(payload)),
    }));
    if (invoked?.FunctionError) throw new Error(String(invoked.FunctionError));
    const answer = JSON.parse(new TextDecoder().decode(invoked?.Payload)) as { status?: number; body?: unknown };
    if (revoking) {
      console.log(JSON.stringify({ _auditEvent: 'admin_invitation_revoke', actor: gate.claims.actor, channelArn, invitationId, status: answer.status }));
    }
    return http.respond(typeof answer.status === 'number' ? answer.status : 502, answer.body ?? {}, origin);
  } catch (err) {
    console.error('[admin-invitations] the invitations function could not answer', { err: (err as Error)?.name || (err as Error)?.message });
    return http.respond(503, { error: 'the invitations could not be read or changed', code: 'INVITATIONS_UNAVAILABLE' }, origin);
  }
}

export const handler = withProfileRegistry((event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => handleAdminInvitations(event));
