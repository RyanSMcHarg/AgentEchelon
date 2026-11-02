/**
 * `AdminApi`, the one HTTP API every admin route is served on (SPEC-ADMIN-CONSOLE), and how the console
 * composes a URL on it.
 *
 * ADMIN-ONLY CONFIG. It is read here, in the admin package, and never from the shared config the chat
 * bundle also carries, so the chat build holds no admin URL (`assert-no-admin-in-chat.mjs`).
 *
 * Admin routes are grouped into the catalog's surfaces (the `api` key of every capability route), and each
 * surface is mounted at a prefix on `AdminApi`. A surface's root is `${VITE_ADMIN_API_URL}${mount}`.
 */
import i18n from '@ae/shared/i18n';

/** A catalog surface of `AdminApi` (`AdminApiResource['api']` in `backend/lib/config/admin-capabilities.ts`). */
export type AdminSurface =
  | 'admin-conversations'
  | 'analytics'
  | 'assistant-admin'
  | 'user-management'
  | 'admin-exchange'
  | 'feedback';

/**
 * WHERE EACH SURFACE IS MOUNTED ON `AdminApi`. The same values as `ADMIN_API_MOUNTS` in
 * `backend/lib/config/admin-capabilities.ts`, which is authoritative: every surface sits at the API root
 * except the analytics query, which is mounted below `/query` in both archive modes.
 */
export const ADMIN_API_MOUNTS: Readonly<Record<AdminSurface, string>> = {
  'admin-conversations': '',
  analytics: '/query',
  'assistant-admin': '',
  'user-management': '',
  'admin-exchange': '',
  feedback: '',
};

/** `VITE_ADMIN_API_URL` without a trailing slash, read at call time so a test that stubs the env sees it. */
function adminApiBase(): string {
  return String(import.meta.env.VITE_ADMIN_API_URL || '').replace(/\/$/, '');
}

/** A comma-separated capability list as a set, ignoring blanks and case. */
function capabilitySet(raw: unknown): Set<string> {
  return new Set(
    String(raw || '')
      .split(',')
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** The base URL of `AdminApi` (`VITE_ADMIN_API_URL`), trailing slash stripped; '' when unset. */
export const ADMIN_API_URL: string = adminApiBase();

/**
 * The capabilities whose admin routes `AdminApi` serves (`VITE_ADMIN_API_CAPABILITIES`, e.g.
 * `admin,experiments`). THE LIST IS THE SIGNAL THAT A FEATURE EXISTS: experiment administration exists
 * only when it names `experiments`.
 */
export const ADMIN_API_CAPABILITIES: ReadonlySet<string> = capabilitySet(import.meta.env.VITE_ADMIN_API_CAPABILITIES);

/** Whether `AdminApi` is configured and serves a capability's routes. */
export function adminApiServes(capability: string): boolean {
  if (!adminApiBase()) return false;
  return capabilitySet(import.meta.env.VITE_ADMIN_API_CAPABILITIES).has(capability.trim().toLowerCase());
}

/** Whether `VITE_ADMIN_API_URL` is set, so any admin route can be called. */
export function adminApiConfigured(): boolean {
  return adminApiBase() !== '';
}

/** A surface's root on `AdminApi`, `${VITE_ADMIN_API_URL}${mount}`; '' when the API is unconfigured. */
export function adminSurfaceRoot(surface: AdminSurface): string {
  const base = adminApiBase();
  return base ? `${base}${ADMIN_API_MOUNTS[surface]}` : '';
}

/**
 * The URL of an admin route: `${VITE_ADMIN_API_URL}${mount}${path}`, with `path` starting at '/'. CALL IT
 * WITH THE PATH WRITTEN OUT (`adminUrl('analytics', '/analytics/drift')`), so the route the console calls
 * is readable, and checkable, at the call: the backend's route-table test holds every `adminUrl(...)` call
 * to `AdminApi`'s routes. A path of '/' is the surface's own root (`adminUrl('analytics', '/')` is
 * `${VITE_ADMIN_API_URL}/query`). Throws when `VITE_ADMIN_API_URL` is unset.
 */
export function adminUrl(surface: AdminSurface, path: string): string {
  const base = adminApiBase();
  if (!base) throw new Error(i18n.t('admin.adminApi.notConfigured'));
  const rooted = path.startsWith('/');
  if (!rooted) throw new Error(i18n.t('admin.adminApi.pathMustStartWithSlash', { path }));
  const mount = ADMIN_API_MOUNTS[surface];
  return path === '/' && mount ? `${base}${mount}` : `${base}${mount}${path}`;
}
