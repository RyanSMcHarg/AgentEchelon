import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import {
  ADMIN_API_MOUNTS,
  ADMIN_ROLES,
  roleExecuteApiResources,
  routesReachedBeyondHeld,
  type AdminApiResource,
  type AdminRole,
} from '../config/admin-capabilities';
import { RES_PREFIX } from '../stacks/agent-classification-common';
import type { RouteAuth, RouteMethod, RouteSpec, RouteThrottle, RouteTableApi } from './http-api';

/**
 * THE CONSOLE ROLES' NAMES (SPEC-ADMIN-CONSOLE "Temporary, scoped credentials").
 *
 * The admin console holds no standing credential: it asks the admin credential exchange for a short-lived
 * session on one of these, and each holds exactly the capabilities the catalog gives its role. The
 * `AdminServices` stack creates them, and `AdminApi` grants each on its routes. Named so a deny-test and
 * an operator can find them by name.
 */
export const ADMIN_CONSOLE_ROLE_NAME: Record<AdminRole, string> = {
  admins: `${RES_PREFIX}-admin-console`,
  'team-members': `${RES_PREFIX}-team-console`,
};

/**
 * THE ADMIN PLANE'S ROLE NAME. The admin credential exchange assumes it for a channel-scoped, audited vend,
 * and every admin handler recognizes this instance's admin plane by it (`lambda/src/lib/auth.ts`), so a
 * session minted on another instance's admin plane is never taken for this one's.
 */
export const ADMIN_PLANE_ROLE_NAME = `${RES_PREFIX}-admin-plane`;

/**
 * THE ROLES THIS INSTANCE MINTS AN ADMIN SESSION ON, for a handler's environment. An admin handler admits an
 * IAM-signed console or admin-plane session only on these, by name (`trustedIamAdminPrincipal`,
 * `lambda/src/lib/auth.ts`), so a session another instance in the same account minted is refused there.
 */
export function adminSessionRoleEnv(): Record<string, string> {
  return {
    ADMIN_CONSOLE_ROLE_NAME: ADMIN_CONSOLE_ROLE_NAME.admins,
    TEAM_CONSOLE_ROLE_NAME: ADMIN_CONSOLE_ROLE_NAME['team-members'],
    ADMIN_PLANE_ROLE_NAME,
  };
}

/**
 * THE ROUTES THE ADMIN PLANE REACHES on `AdminApi`: the message read and the task routes, each completed
 * per vend with the one channel or owner id. Written once: the role's grant on this instance's API
 * (`grantAdminPlaneOnApi`), its permissions boundary and the exchange's session-policy templates are all
 * built from this list.
 */
export const ADMIN_PLANE_ROUTES: ReadonlyArray<{ method: RouteMethod; path: string }> = [
  { method: 'GET', path: '/admin/conversations/{channelId}/messages' },
  { method: 'GET', path: '/admin/tasks/channel/{channelId}' },
  { method: 'POST', path: '/admin/tasks/channel/{channelId}/cancel' },
  { method: 'POST', path: '/admin/tasks/channel/{channelId}/owner' },
  { method: 'GET', path: '/admin/tasks/assignee/{assigneeId}' },
  { method: 'GET', path: '/admin/tasks/owned-by/{ownerPersonId}' },
];

/**
 * Each catalog surface's throttle on `AdminApi`, the limit its own REST API carried as a whole: a surface
 * the console polls (the analytics panels) is allowed more than one an operator acts through.
 */
export const ADMIN_SURFACE_THROTTLE: Record<AdminApiResource['api'], RouteThrottle> = {
  'admin-exchange': { rate: 10, burst: 20 },
  'user-management': { rate: 10, burst: 20 },
  'admin-conversations': { rate: 10, burst: 20 },
  feedback: { rate: 15, burst: 30 },
  'assistant-admin': { rate: 25, burst: 50 },
  analytics: { rate: 100, burst: 200 },
};

/** A catalog path on `AdminApi`: the surface's mount, then the path (`analytics` `/` is `/query`). */
export function adminApiPath(api: AdminApiResource['api'], path: string): string {
  const mount = ADMIN_API_MOUNTS[api];
  if (!mount) return path;
  return path === '/' || path === '' ? mount : `${mount}${path}`;
}

/**
 * One admin route on `AdminApi`, for a catalog surface: mounted where the surface is, IAM-authorized
 * unless it says otherwise, and throttled as the surface is.
 */
export function adminRoute(
  api: AdminApiResource['api'],
  method: RouteMethod,
  path: string,
  handler: lambda.IFunction,
  opts: { auth?: RouteAuth; capability?: string } = {},
): RouteSpec {
  return {
    api: 'admin',
    method,
    path: adminApiPath(api, path),
    handler,
    capability: opts.capability ?? 'admin',
    ...(opts.auth ? { auth: opts.auth } : {}),
    throttle: ADMIN_SURFACE_THROTTLE[api],
  };
}

/**
 * Grant each console role `execute-api:Invoke` on exactly the routes its capabilities name on `AdminApi`,
 * read from the catalog. A role holding no capability on a surface gets nothing there, so it is refused at
 * the gateway on every route of it.
 *
 * ONE MANAGED POLICY PER SURFACE AND ROLE, rather than statements on the role's own policy. A console role
 * is granted on every surface, and inline, the routes of all of them together pass IAM's 10,240-byte
 * per-role limit; a managed policy has its own 6,144-character limit, and a role may carry ten.
 */
export function grantAdminRolesOnApi(
  scope: Construct,
  api: RouteTableApi,
  /** The console roles, created in `AdminServices`. */
  roles: Record<AdminRole, iam.IRole>,
): void {
  for (const surface of Object.keys(ADMIN_API_MOUNTS) as Array<AdminApiResource['api']>) {
    for (const role of ADMIN_ROLES) {
      const resources = roleExecuteApiResources(role, surface).map((r) => api.arnFor(r.method, adminApiPath(surface, r.path)));
      if (!resources.length) continue;
      // A ROUTE A PARAMETER'S WILDCARD WOULD REACH BEYOND WHAT THE ROLE HOLDS is denied by name (`routesReachedBeyondHeld`).
      const beyond = routesReachedBeyondHeld(role, surface).map((r) => api.arnFor(r.method, adminApiPath(surface, r.path)));
      new iam.ManagedPolicy(scope, `ConsoleRoleGrant-${surface}-${role}`, {
        description: `The ${role} console role's routes on the ${surface} admin surface`,
        roles: [roles[role]],
        statements: [
          new iam.PolicyStatement({ actions: ['execute-api:Invoke'], resources }),
          ...(beyond.length ? [new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: ['execute-api:Invoke'], resources: beyond })] : []),
        ],
      });
    }
  }
}

/**
 * Grant the admin plane `execute-api:Invoke` on its routes on THIS instance's `AdminApi`, named by the API's
 * own id, so a session vended on it reaches no other instance's admin API in the same account, whatever its
 * session policy names. A managed policy beside the API, as the console roles' grants are.
 */
export function grantAdminPlaneOnApi(scope: Construct, api: RouteTableApi, role: iam.IRole): void {
  new iam.ManagedPolicy(scope, 'AdminPlaneGrant', {
    description: 'The admin plane role\'s routes on this instance\'s admin API',
    roles: [role],
    statements: [new iam.PolicyStatement({
      actions: ['execute-api:Invoke'],
      resources: ADMIN_PLANE_ROUTES.map((r) => api.arnFor(r.method, r.path)),
    })],
  });
}
