/**
 * THE CONSOLE OPENS ON WHAT THE SESSION HOLDS (SPEC-ADMIN-CONSOLE FR44, FR53).
 *
 * A session with capabilities opens the console on them. A session holding none, or a team member in no
 * team, is a refusal stated once, not a console rendered with every section missing. A team that owns no
 * assistant yet opens unscoped, on Assistants, so it can create one.
 * An exchange refusal is a refusal; any other failure is an error the operator can read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// A plain function rather than a vi.fn: with a spy returning a rejected promise, the runner failed the
// test on that rejection although the provider catches it, and the plain function does not.
let session: () => Promise<unknown> = async () => ({});
vi.mock('./services/sigv4Fetch', () => ({
  consoleSession: () => session(),
  resetSignOnCredentials: vi.fn(),
}));
vi.mock('@ae/shared', () => ({
  useAuth: () => ({ isAuthenticated: true, user: { email: 'operator@example.com' } }),
}));

import { CapabilityProvider, useConsoleAccess } from './capabilities';
import { teamAssistant, setTeamAssistant } from './services/teamScope';

function Probe() {
  const access = useConsoleAccess();
  return <div data-testid="access">{access.status === 'ready' ? `ready ${access.role} ${[...access.capabilities].join(',')}` : access.status}</div>;
}
const renderProvider = () => render(<CapabilityProvider><Probe /></CapabilityProvider>);

describe('CapabilityProvider', () => {
  beforeEach(() => { session = async () => ({}); });

  it('opens on the capabilities the session holds, scoped to the team\'s assistant', async () => {
    setTeamAssistant(null);
    session = async () => ({ role: 'team-members', capabilities: ['view-analytics'], assistants: ['ops-premium'] });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('access').textContent).toBe('ready team-members view-analytics'));
    expect(teamAssistant()).toBe('ops-premium');
  });

  it('opens an admin unscoped', async () => {
    setTeamAssistant('left-over');
    session = async () => ({ role: 'admins', capabilities: ['view-analytics'] });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('access').textContent).toBe('ready admins view-analytics'));
    expect(teamAssistant()).toBeNull();
  });

  it('refuses a team member in no team, with no assistant to be scoped to', async () => {
    session = async () => ({ role: 'team-members', capabilities: ['view-analytics'], assistants: [] });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('access').textContent).toBe('denied'));
  });

  it('opens a team that owns no assistant yet, unscoped, so it can create one for itself', async () => {
    setTeamAssistant('left-over');
    session = async () => ({ role: 'team-members', capabilities: ['manage-assistants', 'view-profiles'], assistants: [], teams: ['ops'] });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('access').textContent).toBe('ready team-members manage-assistants,view-profiles'));
    expect(teamAssistant()).toBeNull();
  });

  it('refuses a session that holds nothing, rather than opening an empty console', async () => {
    session = async () => ({ role: 'team-members', capabilities: [] });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('access').textContent).toBe('denied'));
  });

  it('refuses when the exchange refuses', async () => {
    session = async () => { throw Object.assign(new Error('no admin capability is held by this sign-in'), { status: 403 }); };
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('access').textContent).toBe('denied'));
  });

  it('refuses a team too large for one session, with its reason', async () => {
    session = async () => { throw Object.assign(new Error('too many'), { status: 409, body: { code: 'TEAM_SCOPE_TOO_LARGE' } }); };
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('access').textContent).toBe('denied'));
  });

  it('reports any other failure as an error', async () => {
    session = async () => { throw Object.assign(new Error('network down'), { status: 0 }); };
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('access').textContent).toBe('error'));
  });
});
