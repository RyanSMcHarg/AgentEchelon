/**
 * GET /classifications: THE DEPLOYMENT'S CLASSIFICATIONS AS ITS CLIENTS RENDER THEM.
 *
 * Each classification's value, display name, audience, badge token, grants, whether a conversation is held at
 * it, and the model-selection key its assistant answers on (`clientClassifications`, `lib/config/profiles.ts`),
 * read from the runtime registry (`loadProfileRegistry`), so a classification added or removed reaches the
 * chat app and the admin console when they next load, with no frontend build. Authorized at the edge like every
 * other person route; the answer holds no secret and is the same for every caller.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { responder, originsFrom, DEV_ORIGIN, type HttpResult } from './lib/http-response.js';
import { defaultProfileRegistry, loadProfileRegistry } from '../../lib/profile-registry';

const http = responder({ origin: { allow: originsFrom(process.env.ALLOWED_ORIGIN, DEV_ORIGIN) }, methods: 'GET,OPTIONS' });

export const handler = async (event: APIGatewayProxyEvent): Promise<HttpResult> => {
  // The deployment's set, read at runtime from the rows its stacks publish (lib/profile-registry.ts).
  await loadProfileRegistry();
  const origin = event.headers?.origin ?? event.headers?.Origin;
  return http.respond(200, { classifications: defaultProfileRegistry.forClients() }, origin);
};
