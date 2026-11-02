/**
 * A PASSWORD RESET CANNOT CHANGE A CLEARANCE (security review, 2026-10-13).
 *
 * Cognito runs the post-confirmation trigger after a password reset as well as after sign-up, and
 * `custom:tier` is self-writable because sign-up sends it as the requested tier. The trigger mirrored
 * that attribute into a clearance group on every run, so an approved user could write
 * `custom:tier=premium`, reset their own password, and land in the premium group with no admin approval.
 * The trigger now acts on a confirmed sign-up only.
 */
const mockCognitoSend = jest.fn();
jest.mock('@aws-sdk/client-cognito-identity-provider', () => {
  const cmd = (type: string) => jest.fn().mockImplementation((input: unknown) => ({ type, input }));
  return {
    CognitoIdentityProviderClient: jest.fn(() => ({ send: mockCognitoSend })),
    AdminUpdateUserAttributesCommand: cmd('AdminUpdateUserAttributes'),
    AdminAddUserToGroupCommand: cmd('AdminAddUserToGroup'),
    AdminRemoveUserFromGroupCommand: cmd('AdminRemoveUserFromGroup'),
    AdminListGroupsForUserCommand: cmd('AdminListGroupsForUser'),
  };
}, { virtual: true });
const mockChimeSend = jest.fn();
jest.mock('@aws-sdk/client-chime-sdk-identity', () => {
  const cmd = (type: string) => jest.fn().mockImplementation((input: unknown) => ({ type, input }));
  return {
    ChimeSDKIdentityClient: jest.fn(() => ({ send: mockChimeSend })),
    CreateAppInstanceUserCommand: cmd('CreateAppInstanceUser'),
    DescribeAppInstanceUserCommand: cmd('DescribeAppInstanceUser'),
  };
}, { virtual: true });

// The deployment's registry rows, as the trigger reads them at runtime (`registry-admission.js`): the shipped catalog.
import { DEFAULT_PROFILES_CONFIG, registryRowsOf, registryRowValue } from '../lib/config/profiles';
process.env.AE_PROFILE_REGISTRY_PATH = '/test/registry/classification';
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../lambda/cognito-triggers/registry-admission.js').__setRowReaderForTest(async () => registryRowsOf(DEFAULT_PROFILES_CONFIG).map(registryRowValue));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/cognito-triggers/post-confirmation.js');

const event = (triggerSource: string) => ({
  triggerSource,
  userPoolId: 'us-east-1_pool',
  userName: 'user-sub-1',
  request: { userAttributes: { email: 'a@example.com', 'custom:tier': 'premium' } },
});
const sentTypes = () => mockCognitoSend.mock.calls.map((c) => (c[0] as { type: string }).type);

beforeEach(() => {
  mockCognitoSend.mockReset();
  mockCognitoSend.mockImplementation(async (cmd: { type: string }) => (cmd.type === 'AdminListGroupsForUser' ? { Groups: [{ GroupName: 'basic' }] } : {}));
  mockChimeSend.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('the post-confirmation trigger', () => {
  it('leaves clearance and approval alone after a password reset, whatever custom:tier says', async () => {
    const out = await handler(event('PostConfirmation_ConfirmForgotPassword'));
    expect(out.triggerSource).toBe('PostConfirmation_ConfirmForgotPassword');
    expect(sentTypes()).toEqual([]);
    expect(mockChimeSend).not.toHaveBeenCalled();
  });

  it('still records a confirmed sign-up: unapproved, with its requested tier', async () => {
    await handler(event('PostConfirmation_ConfirmSignUp'));
    expect(sentTypes()).toEqual(expect.arrayContaining(['AdminUpdateUserAttributes', 'AdminAddUserToGroup']));
    const approval = mockCognitoSend.mock.calls.map((c) => c[0]).find((c: any) => c.type === 'AdminUpdateUserAttributes') as any;
    expect(approval.input.UserAttributes).toEqual(expect.arrayContaining([{ Name: 'custom:approved', Value: 'false' }]));
  });

  it('creates no AppInstanceUser for a confirmed sign-up: the credential exchange mints the person at first sign-in', async () => {
    await handler(event('PostConfirmation_ConfirmSignUp'));
    expect(mockChimeSend).not.toHaveBeenCalled();
  });

  it('acts on no other trigger source either', async () => {
    await handler(event('PostConfirmation_SomethingNew'));
    expect(sentTypes()).toEqual([]);
  });
});
