/**
 * THE ROUTE TABLE IS EVERY URL A CLIENT CALLS (plan risk R4: a route lost in the move to two APIs).
 *
 * The chat app, the admin console, the widget and the e2e helpers compose every URL they call on the two HTTP APIs
 * through one of two helpers, with the path written as a literal:
 *
 *  - `personUrl('/path')` (`frontend/packages/shared/src/platform/config.ts`, `tests/e2e/helpers/api-urls.ts`)
 *    for `PersonApi`;
 *  - `adminUrl('<surface>', '/path')` (`frontend/packages/admin/src/services/adminApi.ts`, the e2e helper) for
 *    `AdminApi`, the surface's mount (`ADMIN_API_MOUNTS`) before the path; `'/'` is the surface's root.
 *
 * So the calls can be read off the sources, and each is checked against the routes the synthesized app
 * serves: every path a client composes is a route of the API it names (a client calling a path that no
 * longer exists fails here, not in a browser), and every route the APIs serve is called by some client or
 * is named below with the reason no client calls it.
 *
 * A `${...}` in a literal is one path segment, matched against a route's path parameter. A query string is
 * not part of the route.
 */
import * as fs from 'fs';
import * as path from 'path';
import { synthesizeApp, SYNTH_CAPABILITIES, SYNTH_GUEST_ISSUERS, SYNTH_GUEST_PROFILES, SYNTH_LINK_ISSUERS } from '../lib/docs/api-contract';
import { adminApiPath } from '../lib/constructs/admin-role-grants';
import { ADMIN_API_MOUNTS, ADMIN_CAPABILITIES, vendRoutePath, type AdminApiResource } from '../lib/config/admin-capabilities';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNTH_TIMEOUT_MS = 600_000;
const SCAN_ROOTS = ['frontend/packages/chat/src', 'frontend/packages/admin/src', 'frontend/packages/shared/src', 'frontend/packages/widget/src', 'tests/e2e'];

/** Routes no client in this repository composes, each with why. Removing a client call must add a reason here. */
const SERVED_FOR_OTHERS: Record<string, string> = {
  'person GET /email/preferences':
    'the email preference page (B9): opened from the link in every email a person can stop, never by a client of this app; read by the preferences e2e (tests/e2e/preferences.spec.ts) and the reply-token deny-test (backend/scripts/deny-test-reply-token.mjs) from the email itself',
  'person POST /email/preferences':
    'RFC 8058 one-click unsubscribe, posted by a mail client from the List-Unsubscribe header, and the preference page\'s own form; the URL is read from the email, which this scan does not read',
  'admin POST /admin/assistants/{assistant}/profiles/variant-version':
    'a team member\'s battle candidate: the catalog grants it (edit-profiles), and no console view or e2e spec issues it yet',
  'admin POST /admin/tasks/channel/{channelId}/cancel':
    'an operator stopping a task (tasks-manage): vended per conversation, called by an operator or a host console; no view here issues it',
  'admin POST /users/readmit':
    'readmitting an offboarded subject (manage-users): called by the offboarding deny-test (backend/scripts/deny-test-offboarded-sign-in.mjs), which this scan does not read',
  'admin POST /users/provision':
    'pre-assigning a provisioned-only issuer subject (manage-users, P-13): called by the pending-row deny-test (backend/scripts/deny-test-pending-identities.mjs); no console view issues it, which is NOT BUILT',
  'admin GET /query/analytics/context':
    'the analytics handler\'s cross-conversation context read (view-analytics); no console view reads it',
  'admin GET /query/analytics/conversations':
    'the analytics handler\'s conversation list (view-analytics); no console view reads it',
  'admin GET /query/analytics/evaluation/exchanges':
    'the analytics handler\'s scored exchanges (view-analytics); no console view reads it',
  'admin GET /query/analytics/evaluation/flows':
    'the analytics handler\'s scored flows (view-analytics); no console view reads it',
  'admin GET /query/analytics/model-effectiveness':
    'the analytics handler\'s model effectiveness read (view-analytics); no console view reads it',
  'person POST /connectors/{connectorId}/grant':
    'a person linking a vendor account to a connector (K3): the linking screen is NOT BUILT, so a host client calls it',
  'person DELETE /connectors/{connectorId}/grant':
    'a person revoking their own connector grant (K3): the linking screen is NOT BUILT, so a host client calls it',
};

function listFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!['node_modules', 'dist'].includes(e.name)) listFiles(path.join(dir, e.name), out); continue; }
    if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(path.join(dir, e.name));
  }
  return out;
}

/** A path as a client writes it, with each `${...}` one segment and no query string. */
function normalize(literal: string): string {
  const noQuery = literal.replace(/\$\{[^}]*\}/g, '{}').split('?')[0];
  return noQuery.length > 1 ? noQuery.replace(/\/$/, '') : noQuery;
}

interface Call { file: string; api: 'person' | 'admin'; path: string }

/** Every `personUrl(...)` and `adminUrl(...)` call with a literal path, in the client sources. */
function clientCalls(): { calls: Call[]; unreadable: string[] } {
  const calls: Call[] = [];
  const unreadable: string[] = [];
  const lit = String.raw`(?:'([^']*)'|"([^"]*)"|\x60((?:[^\x60\\]|\\.)*)\x60)`;
  const person = new RegExp(String.raw`\bpersonUrl\(\s*${lit}`, 'g');
  const admin = new RegExp(String.raw`\badminUrl\(\s*'([a-z-]+)'\s*,\s*${lit}`, 'g');
  for (const root of SCAN_ROOTS) {
    for (const file of listFiles(path.join(REPO_ROOT, root))) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(person)) calls.push({ file: rel, api: 'person', path: normalize(m[1] ?? m[2] ?? m[3]) });
      for (const m of src.matchAll(admin)) {
        const surface = m[1] as AdminApiResource['api'];
        if (!(surface in ADMIN_API_MOUNTS)) { unreadable.push(`${rel}: adminUrl names no surface "${surface}"`); continue; }
        calls.push({ file: rel, api: 'admin', path: normalize(adminApiPath(surface, m[2] ?? m[3] ?? m[4])) });
      }
      // A call whose path is not a literal cannot be checked, so it is refused. The helpers' own
      // definitions (and their re-exports) are not calls.
      const defines = /\b(function|const)\s+(personUrl|adminUrl)\b/.test(src);
      const firstArgs = [
        ...[...src.matchAll(/\bpersonUrl\(\s*([^'"\x60\s)][^,)]*)/g)].map((m) => ['personUrl', m[1]]),
        ...[...src.matchAll(/\badminUrl\(\s*'[a-z-]+'\s*,\s*([^'"\x60\s)][^,)]*)/g)].map((m) => ['adminUrl', m[1]]),
        ...[...src.matchAll(/\badminUrl\(\s*([^'"\x60\s)][^,)]*)/g)].map((m) => ['adminUrl', m[1]]),
      ];
      if (!defines) for (const [fn, arg] of firstArgs) unreadable.push(`${rel}: ${fn}(${arg.trim()}...) builds its path at run time`);
    }
  }
  return { calls, unreadable };
}

/**
 * Whether a client path names a route path: literal segments equal, and a client's `{}` against any one
 * segment, a route's `{param}` or a literal (the console names the admin vend route by its capability,
 * `/exchange-credentials/admin/${capability}`, which is one IAM-authorized route per capability; the
 * last test below holds each of those to its own literal route).
 */
function names(client: string, route: string): boolean {
  const c = client.split('/');
  const r = route.split('/');
  return c.length === r.length && c.every((seg, i) => seg === r[i] || (seg === '{}' && r[i].length > 0));
}

describe('the route table is every URL a client calls', () => {
  let routes: { api: 'person' | 'admin'; key: string; path: string }[];
  const { calls, unreadable } = clientCalls();

  beforeAll(() => {
    const app = synthesizeApp(REPO_ROOT, {
      id: 'client-routes',
      // With the guest issuer, so its two entry points (which the widget calls) are in the table, and the
      // invitation-link issuer, so a link invitation's redemption (which the landing page calls) is too. The guest
      // issuer is declared beside the outside classifications it needs.
      context: { analyticsMode: 'aurora', sleepMode: true, capabilities: [...SYNTH_CAPABILITIES], issuers: [...SYNTH_GUEST_ISSUERS, ...SYNTH_LINK_ISSUERS.slice(1)], profiles: [...SYNTH_GUEST_PROFILES] },
    });
    const read = (stack: string, api: 'person' | 'admin') => Object.values(
      ((app.templates[stack] as { Resources?: Record<string, { Type: string; Properties?: Record<string, unknown> }> }).Resources) ?? {},
    ).filter((r) => r.Type === 'AWS::ApiGatewayV2::Route').map((r) => {
      const key = String(r.Properties!.RouteKey);
      return { api, key, path: key.split(' ')[1] };
    });
    routes = [...read('AgentEchelonPersonApi', 'person'), ...read('AgentEchelonAdminApi', 'admin')];
  }, SYNTH_TIMEOUT_MS);

  it('reads the client calls (a scan over nothing passes vacuously)', () => {
    expect(calls.filter((c) => c.api === 'person').length).toBeGreaterThan(10);
    expect(calls.filter((c) => c.api === 'admin').length).toBeGreaterThan(20);
    expect(new Set(calls.map((c) => c.file.split('/')[0])).size).toBe(2);
  });

  it('writes every client path as a literal, so each one can be checked', () => {
    expect(unreadable).toEqual([]);
  });

  it('calls no path the API it names does not serve', () => {
    const lost = calls.filter((c) => !routes.some((r) => r.api === c.api && names(c.path, r.path)))
      .map((c) => `${c.file}: ${c.api} ${c.path}`);
    expect([...new Set(lost)]).toEqual([]);
  });

  it('serves no route that no client calls, unless it says who does', () => {
    const uncalled = routes.filter((r) => !calls.some((c) => c.api === r.api && names(c.path, r.path)))
      .map((r) => `${r.api} ${r.key}`)
      .filter((k) => !SERVED_FOR_OTHERS[k]);
    expect(uncalled).toEqual([]);
    // And every reason still names a route nobody calls.
    for (const k of Object.keys(SERVED_FOR_OTHERS)) {
      const [api, ...key] = k.split(' ');
      const route = routes.find((r) => r.api === api && r.key === key.join(' '));
      expect({ k, served: !!route, called: route ? calls.some((c) => c.api === route.api && names(c.path, route.path)) : false })
        .toEqual({ k, served: true, called: false });
    }
  });

  it('serves one IAM-authorized route per capability the admin exchange vends (SPEC-ADMIN-CONSOLE FR45)', () => {
    const vends = Object.values(ADMIN_CAPABILITIES).filter((c) => c.enforcement === 'exchangeVend' && c.wired && c.vends?.length);
    expect(vends.length).toBeGreaterThan(5);
    for (const cap of vends) {
      const key = `POST /${vendRoutePath(cap.key)}`;
      expect({ key, served: routes.some((r) => r.api === 'admin' && r.key === key) }).toEqual({ key, served: true });
    }
  });
});
