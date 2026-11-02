/**
 * THE CONSOLE'S REGISTRATIONS (B6, P-12): the visitors' registrations waiting for an operator, and approving
 * one, on a deployment whose guest issuer declares `guest.registration.approval: 'admin'`.
 *
 * Two `AdminApi` routes behind IAM, under one capability in the catalog (`approve-registrations`,
 * `lib/config/admin-capabilities.ts`), so the gateway's `execute-api:Invoke` on the resource is the first
 * layer and this handler's admin gate the second (tenet D3):
 *
 *   GET  /users/guest/registrations
 *   POST /users/guest/registrations/{registrationId}/approve
 *
 * The listing shows what each visitor registered and the address their sign-in link will go to, which is
 * why it sits under the approval capability and not the Guest panel's read-only one. The work is path B's
 * function's (`guest-upgrade.ts`, in `Conversations`), the one writer of registrations and claims (A8),
 * invoked directly. This function holds no grant on `Tokens` and no email grant of its own; its one grant is
 * the invoke.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { requireAdmin } from './lib/auth.js';
import { responder, originsFrom, requestOrigin, DEV_ORIGIN } from './lib/http-response.js';
// The deployment's set, read at runtime from the rows its stacks publish, before the handler runs.
import { withProfileRegistry } from '../../lib/profile-registry';

type Sender = { send(command: unknown): Promise<any> };

const http = responder({ origin: { allow: originsFrom(process.env.ALLOWED_ORIGINS, DEV_ORIGIN) }, methods: 'GET,POST,OPTIONS' });

export interface AdminRegistrationsDeps {
  lambda?: Sender;
  upgradeFunction?: string;
}

let defaultLambda: Sender | null = null;

export async function handleAdminRegistrations(event: APIGatewayProxyEvent, d: AdminRegistrationsDeps = {}): Promise<APIGatewayProxyResult> {
  const origin = requestOrigin(event);
  if (event.httpMethod === 'OPTIONS') return http.empty(200, origin);
  const gate = await requireAdmin(event);
  if ('statusCode' in gate) return gate;
  const fn = d.upgradeFunction ?? process.env.UPGRADE_FUNCTION ?? '';
  if (!fn) return http.respond(503, { error: 'registrations are not configured on this deployment', code: 'REGISTRATIONS_UNAVAILABLE' }, origin);
  const approving = event.httpMethod === 'POST' && /\/approve$/.test(event.resource || event.path || '');
  const registrationId = event.pathParameters?.registrationId || '';
  if (approving && !/^[0-9a-f-]{36}$/i.test(registrationId)) {
    return http.respond(400, { error: 'registrationId names one registration', code: 'REGISTRATION_INVALID' }, origin);
  }
  // AN APPROVAL IS A PERSON'S DECISION, made from a console session and recorded under their id.
  if (approving && !gate.claims.personId) {
    return http.respond(403, { error: 'an approval is made by a person, from a console session', code: 'NOT_A_PERSON' }, origin);
  }
  const payload = approving
    ? { op: 'admin-approve-registration', registrationId, actor: gate.claims.personId }
    : { op: 'admin-list-registrations' };
  try {
    const invoked = await (d.lambda ?? (defaultLambda ??= new LambdaClient({}))).send(new InvokeCommand({
      FunctionName: fn,
      InvocationType: 'RequestResponse',
      Payload: new TextEncoder().encode(JSON.stringify(payload)),
    }));
    if (invoked?.FunctionError) throw new Error(String(invoked.FunctionError));
    const answer = JSON.parse(new TextDecoder().decode(invoked?.Payload)) as { status?: number; body?: unknown };
    if (approving) {
      console.log(JSON.stringify({ _auditEvent: 'admin_registration_approve', actor: gate.claims.actor, registrationId, status: answer.status }));
    }
    return http.respond(typeof answer.status === 'number' ? answer.status : 502, answer.body ?? {}, origin);
  } catch (err) {
    console.error('[admin-registrations] path B\'s function could not answer', { err: (err as Error)?.name || (err as Error)?.message });
    return http.respond(503, { error: 'the registrations could not be read or approved', code: 'REGISTRATIONS_UNAVAILABLE' }, origin);
  }
}

export const handler = withProfileRegistry((event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => handleAdminRegistrations(event));
