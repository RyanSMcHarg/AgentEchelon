import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import UsersTab from './UsersTab';
import { CapabilityTestProvider } from '../../capabilities';

const listPeople = vi.fn();
vi.mock('../../services/peopleService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/peopleService')>()),
  userManagementUrl: () => 'https://um.example/prod/users',
  listPeople: () => listPeople(),
}));

const PERSON = '01928a3b-1c2d-7e4f-8a9b-0c1d2e3f4a5b';
const rows = { data: [{ rank: 1, person_id: PERSON, user_tier: 'basic', message_count: 12 }] } as never;

function renderAs(capabilities: string[]) {
  return render(
    <CapabilityTestProvider capabilities={capabilities}>
      <UsersTab data={null} activeUsersData={null} messagingUsersData={null} messagesPerUserData={rows}
        signupFunnelData={null} signinFunnelData={null} isLoading={false} />
    </CapabilityTestProvider>,
  );
}

/**
 * The leaderboard holds person ids, because the analytics read has no route to an identity provider. It
 * names them from the console's list of people, only for a role that may be told who a person is.
 */
describe('UsersTab leaderboard names', () => {
  beforeEach(() => {
    listPeople.mockReset().mockResolvedValue({
      users: [{ personId: PERSON, displayName: 'Jane Doe' }],
      membershipGroups: [],
    });
  });

  it('names a sender for a role holding view-users and see-user-identity', async () => {
    renderAs(['view-users', 'see-user-identity', 'view-user-activity']);
    expect(await screen.findByText('Jane Doe')).toBeInTheDocument();
  });

  it('shows the id, and asks for no names, without see-user-identity', async () => {
    renderAs(['view-users', 'view-user-activity']);
    expect(await screen.findByText(`${PERSON.slice(0, 12)}…`)).toBeInTheDocument();
    expect(listPeople).not.toHaveBeenCalled();
  });
});
