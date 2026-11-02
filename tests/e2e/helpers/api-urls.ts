/**
 * THE TWO HTTP APIS A SPEC CALLS, AND HOW A SPEC COMPOSES A URL ON THEM.
 *
 * `PersonApi` serves every route a person calls (`VITE_PERSON_API_URL`), at its root. `AdminApi` serves
 * every admin route (`VITE_ADMIN_API_URL`), grouped into the catalog's surfaces, each mounted at a prefix:
 * every surface at the root except the analytics query, below `/query`. The mount table is the backend's
 * own (`ADMIN_API_MOUNTS` in `backend/lib/config/admin-capabilities.ts`), imported rather than copied.
 *
 * CALL THE BUILDERS WITH THE PATH WRITTEN OUT (`personUrl('/create-conversation')`,
 * `adminUrl('analytics', '/analytics/drift')`). `backend/test/the-route-table-is-every-url-a-client-calls.test.ts`
 * reads those calls and holds every path to a route of the right API, so a spec cannot call a route the
 * deployment does not declare.
 */
import { ADMIN_API_MOUNTS } from '../../../backend/lib/config/admin-capabilities';

export { ADMIN_API_MOUNTS };

/** A catalog surface of `AdminApi`. */
export type AdminSurface = keyof typeof ADMIN_API_MOUNTS;

/** `PersonApi`'s base URL, trailing slash stripped; '' when unset. */
export const PERSON_API_URL = (process.env.VITE_PERSON_API_URL || '').replace(/\/$/, '');

/** `AdminApi`'s base URL, trailing slash stripped; '' when unset. */
export const ADMIN_API_URL = (process.env.VITE_ADMIN_API_URL || '').replace(/\/$/, '');

/** A comma-separated capability list as a set, ignoring blanks and case. */
function capabilitySet(raw: string | undefined): Set<string> {
  return new Set((raw || '').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean));
}

/**
 * Whether `PersonApi` serves a capability's routes (`VITE_PERSON_API_CAPABILITIES`). `core` is served
 * whenever the API is configured. A spec for an optional feature skips on this, not on a URL.
 */
export function personApiServes(capability: string): boolean {
  if (!PERSON_API_URL) return false;
  const c = capability.trim().toLowerCase();
  return c === 'core' || capabilitySet(process.env.VITE_PERSON_API_CAPABILITIES).has(c);
}

/** Whether `AdminApi` is configured and serves a capability's routes (`VITE_ADMIN_API_CAPABILITIES`). */
export function adminApiServes(capability: string): boolean {
  if (!ADMIN_API_URL) return false;
  return capabilitySet(process.env.VITE_ADMIN_API_CAPABILITIES).has(capability.trim().toLowerCase());
}

/**
 * A person route's URL, `${VITE_PERSON_API_URL}${path}`. Returns a path-only URL when the API is unset,
 * so a spec that guards on `PERSON_API_URL` reads the same and one that does not fails at its request.
 */
export function personUrl(path: string): string {
  if (!path.startsWith('/')) throw new Error(`A person route path starts with '/': ${path}`);
  return `${PERSON_API_URL}${path}`;
}

/**
 * An admin route's URL, `${VITE_ADMIN_API_URL}${mount}${path}`. A path of '/' is the surface's own root
 * (`adminUrl('analytics', '/')` is `${VITE_ADMIN_API_URL}/query`).
 */
export function adminUrl(surface: AdminSurface, path: string): string {
  if (!path.startsWith('/')) throw new Error(`An admin route path starts with '/': ${path}`);
  const mount = ADMIN_API_MOUNTS[surface];
  return path === '/' && mount ? `${ADMIN_API_URL}${mount}` : `${ADMIN_API_URL}${mount}${path}`;
}

/**
 * The route of one profile action (`/version`, `/draft`, ...), for the specs that drive a profile through
 * its lifecycle by action name. Each route is written out, so the route table reads every one; an action
 * with no declared route throws rather than composing one.
 */
export function profileActionUrl(action: string): string {
  switch (action) {
    case '/version': return adminUrl('assistant-admin', '/admin/profiles/version');
    case '/variant-version': return adminUrl('assistant-admin', '/admin/profiles/variant-version');
    case '/draft': return adminUrl('assistant-admin', '/admin/profiles/draft');
    case '/validate': return adminUrl('assistant-admin', '/admin/profiles/validate');
    case '/activate': return adminUrl('assistant-admin', '/admin/profiles/activate');
    case '/rollback': return adminUrl('assistant-admin', '/admin/profiles/rollback');
    case '/export': return adminUrl('assistant-admin', '/admin/profiles/export');
    case '/import': return adminUrl('assistant-admin', '/admin/profiles/import');
    default: throw new Error(`No profile route is declared for the action ${action}`);
  }
}
