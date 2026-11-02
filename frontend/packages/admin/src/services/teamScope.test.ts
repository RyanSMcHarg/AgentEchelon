/**
 * A TEAM MEMBER'S CALLS GO TO THEIR ASSISTANT'S ROUTES (SPEC-ADMIN-CONSOLE FR48).
 *
 * The services make the same call for an admin and a team member; only the URL differs, and only
 * when the console is scoped to an assistant.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { setTeamAssistant } from './teamScope';

const ROOT = 'https://api.example.com';
vi.stubEnv('VITE_ADMIN_API_URL', `${ROOT}/`);
vi.stubEnv('VITE_ADMIN_API_CAPABILITIES', 'admin,experiments');
vi.mock('@ae/shared/i18n', () => ({ default: { t: (k: string) => k } }));

/** Every signed call's method and URL, answered with an empty body. */
const calls: Array<[string, string]> = [];
vi.mock('./sigv4Fetch', () => ({
  consoleCredentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }),
  adminCredentialExchangeConfigured: () => true,
  sigv4GetJson: async (url: string) => { calls.push(['GET', url]); return {}; },
  sigv4PostJson: async (url: string) => { calls.push(['POST', url]); return {}; },
  adminRequest: async (method: string, url: string) => { calls.push([method, url]); return {}; },
  vendAdminCapability: async () => ({ credentials: {} }),
}));

import { listProfiles } from './profileService';
import { listExperiments } from './experimentsService';
import { listAdminConversations } from './adminConversationService';
import { queryAnalytics } from './analyticsService';

/** The URLs one admin read of each kind goes to. */
async function urls(): Promise<string[]> {
  calls.length = 0;
  await listProfiles();
  await listExperiments();
  await listAdminConversations();
  await queryAnalytics('intent_effectiveness' as never, undefined);
  return calls.map(([, url]) => url);
}

describe('the route a call goes to', () => {
  afterEach(() => setTeamAssistant(null));

  it('is the admin route for an admin', async () => {
    expect(await urls()).toEqual([
      `${ROOT}/admin/profiles`,
      `${ROOT}/admin/experiments`,
      `${ROOT}/admin/conversations`,
      `${ROOT}/query`,
    ]);
  });

  it('puts the assistant in front of the admin path for a team member', async () => {
    setTeamAssistant('ops-premium');
    expect(await urls()).toEqual([
      `${ROOT}/admin/assistants/ops-premium/profiles`,
      `${ROOT}/admin/assistants/ops-premium/experiments`,
      `${ROOT}/admin/assistants/ops-premium/conversations`,
      `${ROOT}/query/analytics/assistants/ops-premium/query`,
    ]);
  });
});

describe('the analytics a team may ask for', () => {
  it('is exactly what the backend answers on a team route', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.join(__dirname, '../../../../../backend/lambda/src/analytics-aurora/analytics-query.ts'), 'utf8');
    const listed = (name: string) => {
      // The set literal after the declaration, read without a regex over the declaration itself.
      const at = src.indexOf(`export const ${name}`);
      if (at < 0) return [];
      const open = src.indexOf('new Set([', at);
      const close = src.indexOf('])', open);
      return [...src.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    };
    const backend = [...listed('ASSISTANT_FILTERED_QUERIES'), ...listed('ASSISTANT_ROW_QUERIES'), ...listed('ASSISTANT_BOUND_QUALITY')].sort();
    const { TEAM_QUERY_TYPES } = await import('./teamScope');
    expect(backend.length).toBeGreaterThan(0);
    expect([...TEAM_QUERY_TYPES].sort()).toEqual(backend);
  });
});
