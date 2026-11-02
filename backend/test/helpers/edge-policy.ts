/**
 * THE EDGE AUTHORIZER'S ANSWER, EVALUATED THE WAY THE GATEWAY EVALUATES IT, against a synthesized API.
 *
 * A suite that synthesizes the app reads the route keys each HTTP API serves and the route lists its edge
 * function is handed (`EDGE_ROUTES`). This decides a token for an issuer with the real decision code
 * (`decide` and `policyOf`, `lambda/src/edge-authorizer.ts`) and the token check stubbed, and evaluates the
 * policy against every route of the API: an explicit Deny wins, then an Allow. So a suite asserts which of
 * the routes the deployment actually serves a token reaches, not only what the authorizer was asked about.
 */
import { decide, policyOf, routeResource, type EdgePolicy, type EdgeRoutes } from '../../lambda/src/edge-authorizer';
import type { IdentityState } from '../../lambda/src/lib/person-identity';
import { issuerRegistry, runtimeIssuers, type TrustedIssuer } from '../../lib/config/issuers';
import { defaultProfileRegistry as profiles } from '../../lib/profile-registry';
import type { EdgeIssuer } from '../../lib/config/edge-verification';

export const API_STAGE = 'arn:aws:execute-api:us-east-1:111122223333:abc123/$default';

type Resource = { Type: string; Properties?: Record<string, any> };

/** Every route key an HTTP API in a template serves, with its authorization type. */
export function routesOf(template: { Resources?: Record<string, Resource> }): Array<{ key: string; auth: string; authorizerTtl: number | null }> {
  const resources = template.Resources ?? {};
  return Object.values(resources)
    .filter((r) => r.Type === 'AWS::ApiGatewayV2::Route')
    .map((r) => ({
      key: r.Properties!.RouteKey as string,
      auth: (r.Properties!.AuthorizationType as string) ?? 'NONE',
      authorizerTtl: r.Properties!.AuthorizerId?.Ref
        ? (resources[r.Properties!.AuthorizerId.Ref]?.Properties?.AuthorizerResultTtlInSeconds ?? 0)
        : null,
    }));
}

/** The route lists the template's edge function is handed. */
export function edgeRoutesOf(template: { Resources?: Record<string, Resource> }): EdgeRoutes {
  const fn = Object.values(template.Resources ?? {})
    .find((r) => r.Type === 'AWS::Lambda::Function' && r.Properties?.Environment?.Variables?.EDGE_ROUTES);
  if (!fn) throw new Error('the template has no edge authorizer function');
  return JSON.parse(fn.Properties!.Environment.Variables.EDGE_ROUTES) as EdgeRoutes;
}

/** The registry's runtime entries, for a stubbed token check to name. */
export function runtimeEntries(issuers: unknown[]): TrustedIssuer[] {
  return runtimeIssuers(issuerRegistry(issuers, profiles), 'us-east-1_Self', 'us-east-1');
}

/** The concrete ARN a request to a route key arrives on: each path parameter is one segment. */
export const arnOfRoute = (key: string): string => routeResource(API_STAGE, key.replace(/\{[^}]+\}/g, 'x'));

/** The gateway's evaluation of a policy against one request's route ARN. */
export function admits(policy: EdgePolicy, routeArn: string): boolean {
  const matches = (resource: string) => new RegExp(`^${resource.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(routeArn);
  const st = policy.policyDocument.Statement;
  if (st.some((s) => s.Effect === 'Deny' && s.Resource.some(matches))) return false;
  return st.some((s) => s.Effect === 'Allow' && s.Resource.some(matches));
}

/**
 * The route keys of `keys` a verified token from `issuer` reaches, when its subject resolves to `state`,
 * asked first on `askedOn` (the route the gateway decided it for before caching the answer).
 */
export async function reachableRoutes(
  issuer: TrustedIssuer,
  state: IdentityState,
  routes: EdgeRoutes,
  keys: string[],
  askedOn: string = keys[0],
): Promise<string[]> {
  const decision = await decide('token', {
    verify: async () => ({ issuer: issuer as EdgeIssuer, claims: { sub: 'the-subject' } }),
    lookup: async () => state,
    routes,
  });
  if (decision.effect === 'unauthorized') return [];
  const policy = policyOf(decision, arnOfRoute(askedOn));
  return keys.filter((k) => admits(policy, arnOfRoute(k)));
}
