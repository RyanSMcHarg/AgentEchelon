/**
 * THE HANDLER'S OWN CHECK ON A TEAM-SCOPED ROUTE (DESIGN-ADMIN-CONSOLE 5.2, SPEC-ADMIN-CONSOLE FR48).
 *
 * A team member reaches `.../assistants/{assistant}/...` only for an assistant their team owns: the
 * credential exchange names exactly those paths in their console session, and IAM refuses the rest.
 * This is the second check behind that one. It re-reads the caller's team groups and the assistant's
 * `owner-team` tag and refuses a mismatch, so a session issued before a reassignment, or a policy
 * built wrong, is caught here rather than trusted.
 *
 * Fails closed: a caller or an assistant it cannot resolve is refused, never let through.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ChimeSDKIdentityClient } from '@aws-sdk/client-chime-sdk-identity';
import { callerPersonArn, consoleSessionOf, respond } from './auth.js';
import { defaultDirectory } from './membership-source.js';
import { listAssistantIdentities, scopeFor, type AssistantIdentity } from './assistant-ownership.js';
import { defaultProfileRegistry as profiles } from '../../../lib/profile-registry';
import { chimeIdentityClient } from './chime/clients.js';

let chime: ChimeSDKIdentityClient | null = null;

/** The `{assistant}` a scoped route names, or null on an unscoped route. */
export function scopedAssistant(event: APIGatewayProxyEvent): string | null {
  const a = event.pathParameters?.assistant;
  return typeof a === 'string' && a ? decodeURIComponent(a) : null;
}

export interface OwnedScope {
  assistant: string;
  /** Every bot serving the assistant, with its classification: what the handler binds the request to. */
  bots: AssistantIdentity[];
}

/**
 * Null on an unscoped route. On a scoped one, the scope when the caller's team owns the assistant, or
 * the 403 the handler returns.
 */
export async function requireOwnedAssistant(event: APIGatewayProxyEvent, origin?: string): Promise<OwnedScope | APIGatewayProxyResult | null> {
  const assistant = scopedAssistant(event);
  if (!assistant) return null;
  const refuse = (why: string) => {
    console.warn('[assistant-scope] refused', { assistant, why });
    return respond(403, { error: 'This assistant is not owned by your team', code: 'ASSISTANT_NOT_OWNED' }, origin);
  };
  const appInstanceArn = process.env.APP_INSTANCE_ARN || '';
  if (!appInstanceArn) return refuse('scope check is not configured');
  const personArn = await callerPersonArn(event, appInstanceArn);
  if (!personArn) return refuse('no caller');
  try {
    chime = chime ?? chimeIdentityClient({ region: process.env.AWS_REGION || 'us-east-1' });
    // THE CALLER'S GROUPS BY PERSON, through the directory (C4): their subjects in every trusted issuer
    // whose directory keeps groups. A person in none holds no team.
    const directory = defaultDirectory();
    const [held, clearedBy, identities] = await Promise.all([
      directory.groupsFor(personArn), directory.clearedByGroups(personArn), listAssistantIdentities(chime, appInstanceArn),
    ]);
    const groups = held ?? [];
    // THEIR CLEARANCE FROM THOSE GROUPS, each issuer's classifications bounding its own part (`heldWithinIssuer`):
    // the rule the exchange applied when it named this path, never the groups' bare reading, which is looser.
    const cleared = clearedBy ?? [];
    // Owned by the caller's team AND within their clearance: the same rule the exchange used to name
    // this path in their session, read again now.
    const inScope = scopeFor(identities, groups, (h, t) => profiles.reaches(h, t), () => cleared);
    if (!inScope.includes(assistant)) return refuse('not owned or not cleared');
    return { assistant, bots: identities.filter((i) => i.assistant === assistant) };
  } catch (err) {
    console.error('[assistant-scope] could not resolve ownership', err);
    return refuse('ownership unresolvable');
  }
}

/**
 * A TEAM CONSOLE SESSION REACHES TEAM ROUTES ONLY: the 403 for one on a route that names no assistant, else
 * null. The second check behind the gateway, which grants the team console role its team routes alone: on an
 * administrator's route a body or a query names the assistant, and nothing binds it to the team's own.
 */
export function refuseTeamSessionOnAdminRoute(event: APIGatewayProxyEvent, origin?: string): APIGatewayProxyResult | null {
  const userArn = (event.requestContext?.identity as { userArn?: string | null } | undefined)?.userArn;
  if (consoleSessionOf(userArn)?.kind !== 'team' || scopedAssistant(event)) return null;
  console.warn("[assistant-scope] a team session on an administrator's route was refused", { path: event.resource || event.path });
  return respond(403, { error: "This route is an administrator's; a team member uses the route that names its assistant", code: 'ADMIN_ROUTE' }, origin);
}

/** Narrowing helper: true when `requireOwnedAssistant` returned a refusal. */
export function isRefusal(x: OwnedScope | APIGatewayProxyResult | null): x is APIGatewayProxyResult {
  return !!x && 'statusCode' in x;
}
