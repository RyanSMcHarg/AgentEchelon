/**
 * The Guest panel and the guest-to-customer funnel (E6, B12, L16): starts and refusals by reason from the
 * archive's funnel events, the kill switch with who changed it, each path's stages by journey, and every
 * stage whose recorder is not built named as not built rather than shown as zero.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@ae/shared/i18n';
import GuestFunnelPanel from './GuestFunnelPanel';

// THE DEPLOYED ADMIN API, AS A CONFIGURED CONSOLE HAS IT. The registrations list reads it when the panel is
// handed no list of its own, and whether it is configured comes from the package's `.env`, which a fresh
// checkout does not have. Declared here, so the test reads the same in every checkout.
vi.mock('../../services/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/adminApi')>()),
  adminApiConfigured: () => true,
}));
vi.mock('../../services/sigv4Fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/sigv4Fetch')>()),
  adminRequest: vi.fn(async () => ({ registrations: [] })),
}));

const funnel = { data: [
  { step: 'guest_started', journeys: 40, event_count: 41 },
  { step: 'guest_bound', journeys: 6, event_count: 6 },
  { step: 'claim_sent', journeys: 9, event_count: 11 },
  { step: 'claim_redeemed', journeys: 5, event_count: 5 },
] } as never;
const refusals = { data: [{ reason: 'rate_limited', refusals: 7 }, { reason: 'captcha_failed', refusals: 3 }] } as never;

describe('the Guest panel', () => {
  it('shows the starts, the refusals by reason, and the kill switch with who changed it', async () => {
    const loadSwitch = vi.fn(async () => ({ declared: true, paused: true, changedBy: 'arn:aws:iam::111122223333:user/ops', changedAt: '2026-10-19T10:00:00Z', reason: 'abuse' }));
    render(<GuestFunnelPanel funnelData={funnel} refusalsData={refusals} loadSwitch={loadSwitch} />);
    expect(screen.getByText('40 visits started in this window.')).toBeInTheDocument();
    expect(screen.getByText('Rate limited')).toBeInTheDocument();
    expect(screen.getByText('Captcha failed')).toBeInTheDocument();
    expect(await screen.findByText('Guest start is PAUSED, by arn:aws:iam::111122223333:user/ops at 2026-10-19T10:00:00Z (abuse).')).toBeInTheDocument();
  });

  it('says so when the deployment declares no guest issuer, and when the switch cannot be read', async () => {
    const { unmount } = render(<GuestFunnelPanel funnelData={funnel} loadSwitch={async () => ({ declared: false })} />);
    expect(await screen.findByText('This deployment declares no guest issuer.')).toBeInTheDocument();
    unmount();
    render(<GuestFunnelPanel funnelData={funnel} loadSwitch={async () => { throw new Error('denied'); }} />);
    expect(await screen.findByText('The guest kill switch could not be read.')).toBeInTheDocument();
  });

  it('asks for the registrations awaiting approval only where registrations wait for an operator', async () => {
    // Their route exists only then; asked for anyway, the console fetched a route that is not there.
    const { unmount } = render(<GuestFunnelPanel funnelData={funnel} loadSwitch={async () => ({ declared: true, registrationApproval: 'none' as const })} />);
    expect(await screen.findByText(/Guest start is/)).toBeInTheDocument();
    expect(screen.queryByTestId('guest-registrations')).toBeNull();
    unmount();
    render(<GuestFunnelPanel funnelData={funnel} loadSwitch={async () => ({ declared: true, registrationApproval: 'admin' as const })} registrationsApi={undefined} />);
    expect(await screen.findByTestId('guest-registrations')).toBeInTheDocument();
  });
});

describe('the guest-to-customer funnel', () => {
  it('draws each path by journey, and names every stage that is not built yet', () => {
    render(<GuestFunnelPanel funnelData={funnel} loadSwitch={async () => ({ declared: false })} />);
    expect(screen.getByText('Path A: the visitor becomes the account')).toBeInTheDocument();
    expect(screen.getByText('Path B: a registration is claimed')).toBeInTheDocument();
    expect(screen.getAllByText('Bound to an account').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Claim redeemed').length).toBeGreaterThan(0);
    expect(screen.getByTestId('guest-funnel-not-built').textContent).toBe(
      "Not built yet, so not counted: Registration offered, Registration started, Rep added, Rep's first reply, Hand-off unassigned, and time to rep.",
    );
  });
});
