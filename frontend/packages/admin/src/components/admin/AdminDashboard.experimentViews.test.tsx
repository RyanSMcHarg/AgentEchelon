/**
 * The Experiments section's two views: Experiments and Classifier accuracy. Battles are read on their
 * experiment's page, so there is no Battles (or Duels) view: an old link to either lands on Experiments,
 * keeping the experiment and battle it names, and leaving the section drops both from the URL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const ACCESS = {
  status: 'ready' as const,
  role: 'admins' as const,
  capabilities: new Set(['view-analytics', 'view-experiments', 'manage-experiments']),
  assistants: [] as string[],
  teams: [] as string[],
  owners: {},
  onRequest: null,
};
vi.mock('../../capabilities', () => ({
  useConsoleAccess: () => ACCESS,
  useCan: () => (c: string) => ACCESS.capabilities.has(c),
}));
vi.mock('../../services/analyticsService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  queryAnalytics: vi.fn(async () => ({ data: [], columns: [] })),
}));
vi.mock('../../services/experimentsService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  experimentsAvailable: () => true,
}));
vi.mock('./ClassifierGatePanel', () => ({ default: () => <div>GATE VIEW</div> }));
vi.mock('./ExperimentsTab', () => ({ default: () => <div>EXPERIMENTS VIEW</div> }));

import AdminDashboard, { SECTIONS, TEAM_TABS } from './AdminDashboard';

const param = (k: string) => new URLSearchParams(window.location.search).get(k);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

describe('the Experiments section', () => {
  it('holds Experiments and Classifier accuracy, and no Battles or Duels view', () => {
    expect(SECTIONS.find((s) => s.id === 'experiments')?.tabs).toEqual(['experiments', 'classifier_gate']);
    const all = SECTIONS.flatMap((s) => s.tabs) as string[];
    expect(all).not.toContain('battles');
    expect(all).not.toContain('duels');
    expect(TEAM_TABS.has('classifier_gate')).toBe(false);
  });

  it.each(['battles', 'duels'])('lands ?admin=%s on the Experiments list, once', async (old) => {
    window.history.replaceState(null, '', `/?admin=${old}`);
    const before = window.history.length;
    render(<AdminDashboard onBack={() => {}} analyticsMode="aurora" />);
    expect(await screen.findByText('EXPERIMENTS VIEW')).toBeInTheDocument();
    await waitFor(() => expect(param('admin')).toBe('experiments'));
    expect(document.getElementById('admin-tab-experiments')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: /Battles|Duels/ })).toBeNull();
    // A redirect, not a loop: the URL is rewritten in place and no history entry is added.
    expect(window.history.length).toBe(before);
  });

  it('keeps the experiment an old battle link names', async () => {
    window.history.replaceState(null, '', '/?admin=duels&exp=exp-a&battle=b-1');
    render(<AdminDashboard onBack={() => {}} analyticsMode="aurora" />);
    expect(await screen.findByText('EXPERIMENTS VIEW')).toBeInTheDocument();
    await waitFor(() => expect(param('admin')).toBe('experiments'));
    expect(param('exp')).toBe('exp-a');
  });

  it('opens the classifier gate as its own view, saying what it is', async () => {
    window.history.replaceState(null, '', '/?admin=classifier_gate');
    render(<AdminDashboard onBack={() => {}} analyticsMode="aurora" />);
    expect(await screen.findByText('GATE VIEW')).toBeInTheDocument();
    expect(screen.getByTestId('classifier-gate-what')).toHaveTextContent(/sorted into intents/);
  });

  it('leaving Experiments drops the open experiment from the URL', async () => {
    window.history.replaceState(null, '', '/?admin=experiments&exp=exp-a');
    render(<AdminDashboard onBack={() => {}} analyticsMode="aurora" />);
    expect(await screen.findByText('EXPERIMENTS VIEW')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Classifier accuracy' }));
    await waitFor(() => expect(param('admin')).toBe('classifier_gate'));
    expect(param('exp')).toBeNull();
  });
});
