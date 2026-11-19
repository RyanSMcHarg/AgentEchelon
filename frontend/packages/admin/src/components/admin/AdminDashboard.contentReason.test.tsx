/**
 * A REASON IS ASKED FOR CONTENT, AND ONLY FOR CONTENT.
 *
 * The Alerts tab is assembled from counts and measurements, so opening it asks for no reason and sends
 * none. The Flagged tab lists what was said, so it asks; declining sends nothing, mounts no list, and
 * says why, with a way to ask again. Giving a reason sends it with the read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@ae/shared/i18n';

const ACCESS = {
  status: 'ready' as const,
  role: 'admins' as const,
  capabilities: new Set(['view-analytics', 'view-events']),
  assistants: [] as string[],
  teams: [] as string[],
  owners: {},
  onRequest: null,
};
vi.mock('../../capabilities', () => ({
  useConsoleAccess: () => ACCESS,
  useCan: () => (c: string) => ACCESS.capabilities.has(c),
}));
vi.mock('../../services/adminApi', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adminApiConfigured: () => true,
  adminUrl: (_surface: string, path: string) => `https://api.test${path}`,
}));
const sigv4PostJson = vi.fn(async (..._a: unknown[]) => ({ data: [], columns: [] }));
vi.mock('../../services/sigv4Fetch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  consoleCredentials: async () => ({ accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' }),
  sigv4PostJson: (...a: unknown[]) => sigv4PostJson(...a),
}));
vi.mock('./FlaggedResponsesTab', () => ({ default: () => <div>FLAGGED LIST</div> }));

import AdminDashboard from './AdminDashboard';
import { clearReasons } from '../../services/adminReason';

const bodies = () => sigv4PostJson.mock.calls.map((c) => c[1] as Record<string, unknown>);

beforeEach(() => {
  clearReasons();
  sigv4PostJson.mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

describe('the Alerts tab', () => {
  it('asks for no reason and reads no conversation content', async () => {
    window.history.replaceState(null, '', '/?admin=alerts');
    render(<AdminDashboard onBack={() => {}} analyticsMode="aurora" />);
    await waitFor(() => expect(sigv4PostJson).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/Scanning/i)).toBeNull());
    expect(screen.queryByTestId('admin-reason-dialog')).toBeNull();
    const queried = bodies().map((b) => b.queryType);
    expect(queried).toEqual(expect.arrayContaining(['intent_effectiveness', 'error_rate_daily']));
    expect(queried).not.toContain('flagged_responses');
    expect(bodies().some((b) => 'accessReason' in b)).toBe(false);
    for (const [url] of sigv4PostJson.mock.calls) expect(String(url)).not.toMatch(/events-log/);
  });
});

describe('the Flagged tab', () => {
  it('declined: sends nothing, mounts no list, explains, and asks again on request', async () => {
    window.history.replaceState(null, '', '/?admin=flagged');
    render(<AdminDashboard onBack={() => {}} analyticsMode="aurora" />);
    expect(await screen.findByTestId('admin-reason-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByTestId('admin-reason-declined')).toBeInTheDocument();
    expect(screen.queryByText('FLAGGED LIST')).toBeNull();
    expect(bodies().map((b) => b.queryType)).not.toContain('flagged_responses');

    fireEvent.click(screen.getByRole('button', { name: 'Give a reason' }));
    expect(await screen.findByTestId('admin-reason-dialog')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('admin-reason-input'), { target: { value: 'a reported wrong answer' } });
    fireEvent.click(screen.getByTestId('admin-reason-confirm'));

    expect(await screen.findByText('FLAGGED LIST')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-reason-declined')).toBeNull();
    const read = bodies().find((b) => b.queryType === 'flagged_responses');
    expect(read?.accessReason).toBe('a reported wrong answer');
    const [url] = sigv4PostJson.mock.calls.find((c) => (c[1] as { queryType?: string }).queryType === 'flagged_responses')!;
    expect(String(url)).toMatch(/\/events-log$/);
  });
});
