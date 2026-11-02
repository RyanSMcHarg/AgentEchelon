import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import UsersTab, { funnelConversion, successesOutsideFunnel, formOnlyFromSearch, withFormOnly } from './UsersTab';
import { CapabilityTestProvider } from '../../capabilities';
import type { FunnelStep } from './FunnelChart';

vi.mock('../../services/peopleService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/peopleService')>()),
  userManagementUrl: () => '',
}));

/**
 * The rows the session-ordered funnel returns on dev for the window that read "Sign-in success: 105.6%":
 * 18 sessions viewed the form, submitted and signed in, and one more signed in with no form view before it.
 * By default the card counts every session that signed in, so it reads 19 over 18; with the form-only filter
 * it counts the sessions that went through the form, 18 over 18.
 */
const signinRows = {
  data: [
    { step: 'signin_form_viewed', event_count: '18', session_count: '18', sessions_outside_funnel: '0' },
    { step: 'signin_submitted', event_count: '18', session_count: '18', sessions_outside_funnel: '0' },
    { step: 'signin_succeeded', event_count: '18', session_count: '18', sessions_outside_funnel: '1' },
  ],
} as never;

function renderTab(signinFunnelData: unknown) {
  return render(
    <CapabilityTestProvider capabilities={['view-user-activity']}>
      <UsersTab data={null} activeUsersData={null} messagingUsersData={null} messagesPerUserData={null}
        signupFunnelData={null} signinFunnelData={signinFunnelData as never} isLoading={false} />
    </CapabilityTestProvider>,
  );
}

const step = (id: string, sessionCount: number, outsideSessions = 0): FunnelStep => ({ id, label: id, eventCount: sessionCount, sessionCount, outsideSessions });

beforeEach(() => {
  window.history.replaceState(null, '', '/?admin=users');
});

describe('a funnel conversion', () => {
  it('counts every session that succeeded by default, in the funnel or outside it', () => {
    const steps = [step('signin_form_viewed', 20), step('signin_submitted', 18), step('signin_succeeded', 15, 4)];
    expect(funnelConversion(steps, 'signin_form_viewed', 'signin_succeeded')).toBe(95);
    expect(successesOutsideFunnel(steps, 'signin_succeeded')).toBe(4);
  });

  it('counts only the sessions that went through the form when asked, which never exceeds 100%', () => {
    const steps = [step('signin_form_viewed', 18), step('signin_succeeded', 18, 1)];
    expect(funnelConversion(steps, 'signin_form_viewed', 'signin_succeeded')).toBeCloseTo(105.56, 2);
    expect(funnelConversion(steps, 'signin_form_viewed', 'signin_succeeded', true)).toBe(100);
  });

  it('reads the entry step by id, not by position', () => {
    const steps = [step('signin_submitted', 30), step('signin_form_viewed', 10), step('signin_succeeded', 5)];
    expect(funnelConversion(steps, 'signin_form_viewed', 'signin_succeeded', true)).toBe(50);
  });

  it('is no rate at all when no session entered', () => {
    expect(funnelConversion([step('signin_succeeded', 0, 3)], 'signin_form_viewed', 'signin_succeeded')).toBeNull();
  });
});

describe('the form-only URL parameter', () => {
  it('round-trips, keeping every other parameter', () => {
    const on = withFormOnly('?admin=users&range=7d', true);
    expect(formOnlyFromSearch(on)).toBe(true);
    const off = withFormOnly(on, false);
    expect(formOnlyFromSearch(off)).toBe(false);
    expect(new URLSearchParams(off).get('admin')).toBe('users');
    expect(new URLSearchParams(off).get('range')).toBe('7d');
  });
});

describe('the Users tab sign-in card', () => {
  it('reads over 100% by default, and says why in a note', () => {
    renderTab(signinRows);
    expect(screen.getByText('105.6%')).toBeInTheDocument();
    expect(screen.getByTestId('funnel-over-100-note').textContent).toMatch(/can read over 100%/);
    expect(screen.queryByTestId('signin-outside-funnel')).not.toBeInTheDocument();
  });

  it('shows the rate within the funnel with the filter on, the sign-in outside it apart, and puts the choice in the URL', () => {
    renderTab(signinRows);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Only sessions that went through the form' }));
    expect(screen.getByText('100.0%')).toBeInTheDocument();
    expect(screen.queryByText('105.6%')).not.toBeInTheDocument();
    expect(screen.queryByTestId('funnel-over-100-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('signin-outside-funnel').textContent).toBe(
      '1 session signed in with no sign-in form view recorded before it in this window. It is counted here and not in the funnel.',
    );
    expect(new URLSearchParams(window.location.search).get('funnel')).toBe('form');
    expect(new URLSearchParams(window.location.search).get('admin')).toBe('users');
  });

  it('opens with the filter on from a shared URL', () => {
    window.history.replaceState(null, '', '/?admin=users&funnel=form');
    renderTab(signinRows);
    expect(screen.getByRole('checkbox', { name: 'Only sessions that went through the form' })).toBeChecked();
    expect(screen.getByText('100.0%')).toBeInTheDocument();
  });

  it('says nothing about sign-ins outside the funnel when there are none', () => {
    window.history.replaceState(null, '', '/?admin=users&funnel=form');
    renderTab({ data: [
      { step: 'signin_form_viewed', event_count: '4', session_count: '4', sessions_outside_funnel: '0' },
      { step: 'signin_succeeded', event_count: '3', session_count: '3', sessions_outside_funnel: '0' },
    ] });
    expect(screen.getByText('75.0%')).toBeInTheDocument();
    expect(screen.queryByTestId('signin-outside-funnel')).not.toBeInTheDocument();
  });
});
