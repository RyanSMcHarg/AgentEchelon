/**
 * A PERSON'S OWN CONNECTOR GRANTS (K3), on `PersonApi` behind the edge authorizer:
 *
 *   POST   /connectors/{connectorId}/grant   { code, redirectUri, codeVerifier }   link: 204
 *   DELETE /connectors/{connectorId}/grant                                         revoke: 204
 *
 * The person is the caller the edge resolved (`callerPersonId`), never anything in the body, so a person
 * links and revokes only their own grant. Linking completes the vendor's authorization-code flow with PKCE:
 * the client sends the person to the vendor, the vendor returns a code to one of the connector's declared
 * redirect URIs, and this route exchanges it with the connector's OAuth client and stores the tokens
 * sealed (`lib/connector-grants.ts`). Revoking calls the vendor's revocation endpoint and then deletes the
 * grant; a revocation the vendor does not confirm is kept as `revoke-failed` for the sweep, and the answer
 * says so (202).
 *
 * A one-conversation person is refused, as on every route that does not admit them. No first-party client
 * calls these routes yet: the linking screen is **NOT BUILT**.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { KMSClient } from '@aws-sdk/client-kms';
import { runtimeConnectors } from '../../lib/config/connectors.js';
import { callerPersonId } from './lib/auth.js';
import { originsFrom, requestOrigin, responder } from './lib/http-response.js';
import { GrantRefused, grantConnector, linkGrant, readGrant, revokeGrant, type GrantDeps } from './lib/connector-grants.js';
import { ConnectorSecretUnavailable, oauthClient } from './lib/connectors/secrets.js';
// The deployment's set, read at runtime from the rows its stacks publish, before the handler runs.
import { withProfileRegistry } from '../../lib/profile-registry';

const http = responder({
  origin: { allow: originsFrom(process.env.ALLOWED_ORIGIN, '', { trim: true, dropEmpty: true }), fallback: '' },
  methods: 'POST,DELETE,OPTIONS',
});

const MAX_FIELD = 4096;
const field = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= MAX_FIELD ? v : null);

export async function handleGrantRoute(event: APIGatewayProxyEvent, deps: GrantDeps): Promise<APIGatewayProxyResult> {
  const origin = requestOrigin(event);
  const personId = await callerPersonId(event);
  if (!personId) return http.error(401, 'not signed in', origin);
  const connectorId = String(event.pathParameters?.connectorId || '');
  const connector = grantConnector(deps.connectors, connectorId);
  if (!connector) return http.error(404, 'no connector takes a grant by that id', origin, 'unknown_connector');

  if (event.httpMethod === 'DELETE') {
    const item = await readGrant(personId, connector.id, deps);
    if (!item) return http.empty(204, origin);
    const outcome = await revokeGrant(item, deps);
    return outcome === 'revoked' ? http.empty(204, origin) : http.respond(202, { status: 'revoke_pending' }, origin);
  }
  if (event.httpMethod !== 'POST') return http.error(405, 'method not allowed', origin);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}') as Record<string, unknown>;
  } catch {
    return http.error(400, 'the body is not JSON', origin, 'bad_request');
  }
  const code = field(body.code);
  const redirectUri = field(body.redirectUri);
  const codeVerifier = field(body.codeVerifier);
  if (!code || !redirectUri || !codeVerifier) return http.error(400, 'code, redirectUri and codeVerifier are required', origin, 'bad_request');
  try {
    await linkGrant(personId, connector.id, { code, redirectUri, codeVerifier }, deps);
    return http.empty(204, origin);
  } catch (err) {
    if (err instanceof GrantRefused) {
      const status = err.code === 'vendor-unavailable' ? 503 : err.code === 'unknown-connector' ? 404 : 400;
      return http.error(status, err.message, origin, err.code.replace(/-/g, '_'));
    }
    if (err instanceof ConnectorSecretUnavailable) return http.error(503, 'the connector is not configured', origin, 'unavailable');
    throw err;
  }
}

let defaults: GrantDeps | null = null;
function defaultDeps(): GrantDeps {
  if (defaults) return defaults;
  const region = process.env.AWS_REGION || 'us-east-1';
  defaults = {
    doc: DynamoDBDocumentClient.from(new DynamoDBClient({ region })),
    kms: new KMSClient({ region }),
    table: process.env.GRANTS_TABLE || '',
    keyArn: process.env.GRANTS_KEY_ARN || '',
    connectors: runtimeConnectors(process.env.CONNECTORS),
    oauthClient: (id) => oauthClient(id),
  };
  return defaults;
}

export const handler = withProfileRegistry((event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => handleGrantRoute(event, defaultDeps()));
