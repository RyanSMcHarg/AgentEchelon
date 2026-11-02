import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import '@ae/shared/i18n';

/**
 * A TEAM THAT OWNS NO ASSISTANT IS NEVER SENT AN ADMIN'S REQUEST. Its console is the Assistants tab alone,
 * and there is no assistant to scope an analytics query to, so any query sent on its behalf is the
 * unscoped admin one, which IAM refuses. Found live: a 403 on /query and /query/user-activity.
 *
 * Opened on a tab it cannot see (`?admin=conversations`), the dashboard must neither fetch that tab's
 * data nor mount its view while the redirect to Assistants is pending.
 */
const ACCESS = {
  status: 'ready' as const,
  role: 'team-members' as const,
  capabilities: new Set(['view-profiles']),
  assistants: [] as string[],
  teams: ['ops'],
  owners: {},
  onRequest: null,
};
vi.mock('../../capabilities', () => ({
  useConsoleAccess: () => ACCESS,
  useCan: () => (c: string) => ACCESS.capabilities.has(c),
}));

const queryAnalytics = vi.fn(async () => ({ data: [], columns: [] }));
const listChannelEvents = vi.fn(async () => ({ data: [] }));
vi.mock('../../services/analyticsService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  queryAnalytics: (...a: unknown[]) => queryAnalytics(...(a as [])),
  listChannelEvents: (...a: unknown[]) => listChannelEvents(...(a as [])),
}));
const listAdminConversations = vi.fn(async () => ({ conversations: [], total: 0 }));
vi.mock('../../services/adminConversationService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listAdminConversations: (...a: unknown[]) => listAdminConversations(...(a as [])),
}));
// The Assistants tab the console lands on reads its own list; it is not what this test is about.
vi.mock('./ProfilesTab', () => ({ default: () => <div>ASSISTANTS</div> }));

import AdminDashboard from './AdminDashboard';

const fetchSpy = vi.fn(async (_input: RequestInfo | URL) => new Response('{}', { status: 200 }));
beforeEach(() => {
  queryAnalytics.mockClear();
  listChannelEvents.mockClear();
  listAdminConversations.mockClear();
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
  window.history.replaceState(null, '', '/?admin=conversations');
});
afterEach(() => vi.unstubAllGlobals());

describe('a team that owns no assistant', () => {
  it('lands on Assistants and sends no analytics or conversation request on the way', async () => {
    const { findByText } = render(<AdminDashboard onBack={() => {}} analyticsMode="aurora" />);
    expect(await findByText('ASSISTANTS')).toBeTruthy();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('admin')).toBe('profiles'));
    expect(queryAnalytics).not.toHaveBeenCalled();
    expect(listChannelEvents).not.toHaveBeenCalled();
    // The Conversations view never mounts, so its own list read never runs.
    expect(listAdminConversations).not.toHaveBeenCalled();
    const queried = fetchSpy.mock.calls.map(([u]) => String(u)).filter((u) => /\/query|\/conversations/.test(u));
    expect(queried).toEqual([]);
  });
});
