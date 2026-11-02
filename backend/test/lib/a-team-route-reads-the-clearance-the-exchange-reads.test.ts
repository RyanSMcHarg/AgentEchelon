/**
 * A TEAM ROUTE READS THE CLEARANCE THE EXCHANGE READS (SPEC-ADMIN-CONSOLE FR48, tenet D3).
 *
 * The handler's own check on `.../assistants/{assistant}/...` (`requireOwnedAssistant`) is the second layer behind the
 * session policy the exchange wrote. It binds the scope to the clearance the caller's groups give within each issuer's
 * classifications (`heldWithinIssuer`), not to what the groups alone would name, so it is never looser than the layer
 * in front of it. A person signing in through no directory that keeps groups reaches nothing.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockClearance: { current: unknown } = { current: null };
jest.mock('../../lambda/src/lib/membership-source', () => ({
  ...jest.requireActual('../../lambda/src/lib/membership-source'),
  defaultDirectory: () => ({
    // The groups name the premium clearance and the team; what the directory says is held is the test's.
    groupsFor: async () => ['premium', 'team-ops'],
    clearedByGroups: async () => mockClearance.current,
  }),
}));
jest.mock('../../lambda/src/lib/auth', () => ({
  ...jest.requireActual('../../lambda/src/lib/auth'),
  callerPersonArn: async () => 'arn:aws:chime:us-east-1:1:app-instance/ai/user/person-1',
}));
jest.mock('../../lambda/src/lib/assistant-ownership', () => ({
  ...jest.requireActual('../../lambda/src/lib/assistant-ownership'),
  listAssistantIdentities: async () => [{
    assistant: 'advisor', botArn: 'arn:aws:chime:us-east-1:1:app-instance/ai/bot/advisor', name: 'Advisor',
    classification: 'premium', role: 'primary', ownerTeam: 'ops', ownerRecorded: true,
  }],
}));
jest.mock('../../lambda/src/lib/chime/clients', () => ({ chimeIdentityClient: () => ({}) }));

import { requireOwnedAssistant, isRefusal } from '../../lambda/src/lib/assistant-scope';

const event = { pathParameters: { assistant: 'advisor' } } as unknown as APIGatewayProxyEvent;

beforeAll(() => {
  process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:1:app-instance/ai';
});

describe('a team route reads the clearance the exchange reads', () => {
  it('reaches the assistant its team owns, within the clearance the directory holds', async () => {
    mockClearance.current = ['basic', 'standard', 'premium'];
    const scope = await requireOwnedAssistant(event);
    expect(scope && !isRefusal(scope) ? scope.assistant : null).toBe('advisor');
  });

  it('DENIED: the groups name premium, but the issuer bounds the clearance below it', async () => {
    mockClearance.current = ['basic', 'standard'];
    const scope = await requireOwnedAssistant(event);
    expect(scope && isRefusal(scope) ? scope.statusCode : null).toBe(403);
  });

  it('DENIED: a person with no directory that keeps groups, or no clearance from them', async () => {
    for (const state of [null, []]) {
      mockClearance.current = state;
      const scope = await requireOwnedAssistant(event);
      expect(scope && isRefusal(scope) ? scope.statusCode : null).toBe(403);
    }
  });
});
