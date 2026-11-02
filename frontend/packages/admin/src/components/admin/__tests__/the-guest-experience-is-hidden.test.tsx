/**
 * THE GUEST EXPERIENCE IS HIDDEN FROM THE CONSOLE UNTIL IT IS BUILT.
 *
 * Hidden, not removed (`config/guestExperience.ts`): the Users tab renders no guest panel or funnel even when guest
 * data is present, and the dashboard runs no guest query for it. Manage users' visitor toggle is covered beside
 * its other tests (`UserManagementTab.issuers.test.tsx`).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import UsersTab from '../UsersTab';
import { QUERIES_BY_TAB } from '../AdminDashboard';
import { CapabilityTestProvider } from '../../../capabilities';
import { GUEST_EXPERIENCE_SHOWN } from '../../../config/guestExperience';

vi.mock('../../../services/peopleService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/peopleService')>()),
  userManagementUrl: () => 'https://um.example/prod/users',
  listPeople: () => Promise.resolve({ users: [], membershipGroups: [] }),
}));

const guestRows = { data: [{ step: 'guest_started', journeys: 3, event_count: 3 }] } as never;

describe('the guest experience', () => {
  it('is hidden', () => {
    expect(GUEST_EXPERIENCE_SHOWN).toBe(false);
  });

  it('shows no guest panel or funnel on the Users tab, even with guest data in hand', () => {
    render(
      <CapabilityTestProvider capabilities={['view-users', 'view-user-activity']}>
        <UsersTab data={null} activeUsersData={null} messagingUsersData={null} messagesPerUserData={null}
          signupFunnelData={null} signinFunnelData={null} guestFunnelData={guestRows} guestRefusalsData={guestRows} isLoading={false} />
      </CapabilityTestProvider>,
    );
    expect(screen.queryByTestId('guest-panel')).toBeNull();
    expect(screen.queryByTestId('guest-funnel')).toBeNull();
  });

  it('runs no guest query for the Users tab', () => {
    expect(QUERIES_BY_TAB.users).not.toEqual(expect.arrayContaining(['guest_to_customer_funnel']));
    expect(QUERIES_BY_TAB.users).not.toEqual(expect.arrayContaining(['guest_refusals']));
  });
});
