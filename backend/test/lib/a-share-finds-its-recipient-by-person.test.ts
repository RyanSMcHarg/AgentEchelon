/**
 * A SHARE FINDS ITS RECIPIENT BY PERSON, NEVER BINDS ONE BY ADDRESS.
 *
 * The address is input: it finds one subject in this deployment's own directory, which becomes a person
 * through `Identities` exactly as a sign-in does (`Directory.findByAddress`). The member added is that
 * AppInstanceUser, never an ARN built from the address or the pool's username, and an address that
 * resolves to nobody - no such subject, more than one, or a subject that has never signed in - is refused
 * before anything is added. There is no invitation for an unknown address.
 */
import { seedRegistryRows } from '../helpers/registry-rows';
const mockChime = jest.fn();
const mockSes = jest.fn();

const tagged = (t: string) => class { __t = t; constructor(public input: any) {} };
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: (...a: unknown[]) => mockChime(...a) })),
  CreateChannelMembershipCommand: tagged('CreateChannelMembership'),
  ListChannelMembershipsCommand: tagged('ListChannelMemberships'),
  ListChannelMessagesCommand: tagged('ListChannelMessages'),
  SendChannelMessageCommand: tagged('SendChannelMessage'),
  DescribeChannelCommand: tagged('DescribeChannel'),
  DescribeChannelMembershipCommand: tagged('DescribeChannelMembership'),
  ListTagsForResourceCommand: tagged('ListTagsForResource'),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: async () => ({ Item: {} }) })),
  GetItemCommand: tagged('GetItem'),
}));
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: async () => ({ Parameter: { Value: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/premium' } }) })),
  GetParameterCommand: tagged('GetParameter'),
}));
jest.mock('../../lambda/src/lib/notification', () => ({
  ...jest.requireActual('../../lambda/src/lib/notification'),
  sendEmailNotifications: (...a: unknown[]) => mockSes(...a),
}));
jest.mock('../../lambda/src/lib/conversation-primary', () => ({
  primaryAssistantOf: async () => ({ classification: 'premium', botArn: 'arn:aws:chime:us-east-1:1:app-instance/i/bot/premium' }),
}));
const said: Array<{ kind: string; to: string[]; vars: Record<string, string> }> = [];
jest.mock('../../lambda/src/lib/say-through-router', () => ({
  sayThroughRouter: async (_c: string, n: { kind: string; to: string[]; vars: Record<string, string> }) => { said.push(n); return { posted: true }; },
  // No `person-joined` workflow is declared, so the event owns nobody's welcome (ADR-061 decision 5).
  personJoinedThroughRouter: async () => new Set<string>(),
}));
jest.mock('../../lambda/src/lib/join-recap', () => ({ dispatchJoinRecapTurn: async () => undefined }));

const APP = 'arn:aws:chime:us-east-1:1:app-instance/i';
process.env.APP_INSTANCE_ARN = APP;
process.env.USER_POOL_ID = 'us-east-1_pool';
// The deployment's registry rows, read at runtime by the handler: the shipped catalog.
seedRegistryRows();

import * as fs from 'fs';
import * as path from 'path';
import type { Directory } from '../../lambda/src/lib/membership-source';
import { edgeContext } from '../helpers/edge-context';

const RECIPIENT = `${APP}/user/0192f0e0-0000-7000-8000-00000000b0b0`;

function directory(found: string | null, asked: Array<[string, string]>): Directory {
  return {
    personsInGroup: async () => ({ persons: [], unminted: [] }),
    personOf: async () => null,
    admins: async () => ({ persons: [], unminted: [] }),
    clearanceOf: async () => ({ state: 'none' as const }),
    listGroups: async () => [],
    findByAddress: async (issuer, address) => { asked.push([issuer, address]); return found; },
    accountState: async () => 'active' as const,
    groupsFor: async () => ['premium'],
    clearedByGroups: async () => null,
    displayNameFor: async () => 'Bob',
    contactFor: async () => ({ route: 'email', address: 'bob@example.com', name: 'Bob' }),
  };
}

async function share(found: string | null, recipientEmail = 'bob@example.com') {
  jest.resetModules();
  const asked: Array<[string, string]> = [];
  const ms = await import('../../lambda/src/lib/membership-source');
  ms.__setDefaultDirectoryForTests(directory(found, asked));
  mockChime.mockReset().mockImplementation((cmd: { __t: string }) =>
    Promise.resolve(cmd.__t === 'ListTagsForResource' ? { Tags: [{ Key: 'classification', Value: 'premium' }] } : {}));
  mockSes.mockReset().mockImplementation(async (r: Array<{ email: string }>) => ({ sent: r.map((x) => x.email), failed: [] }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { handler } = require('../../lambda/share-conversation/index.js');
  const quiet = [jest.spyOn(console, 'log').mockImplementation(() => {}), jest.spyOn(console, 'warn').mockImplementation(() => {})];
  const res = await handler({
    httpMethod: 'POST',
    requestContext: { authorizer: edgeContext({ claims: { sub: 'caller', email: 'lead@example.com' } }) },
    body: JSON.stringify({ conversationArn: `${APP}/channel/c1`, recipientEmail }),
  });
  quiet.forEach((s) => s.mockRestore());
  const adds = mockChime.mock.calls.map(([c]) => c).filter((c) => c.__t === 'CreateChannelMembership');
  return { res, asked, adds };
}

describe('the share finds its recipient through the directory', () => {
  it('looks the address up in this deployment\'s own pool, and adds the person it resolves to', async () => {
    const { res, asked, adds } = await share(RECIPIENT);
    expect(res.statusCode).toBe(200);
    // This deployment's own pool, by its trusted-issuer registry id.
    expect(asked).toEqual([['deployment', 'bob@example.com']]);
    expect(adds.map((c) => c.input.MemberArn)).toEqual([RECIPIENT]);
    // The response names them by display name, not by the address it was given.
    expect(JSON.parse(res.body).recipientName).toBe('Bob');
  });

  it('refuses an address that resolves to nobody, before anything is added', async () => {
    const { res, adds } = await share(null);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('USER_NOT_FOUND');
    expect(adds).toEqual([]);
    expect(mockSes).not.toHaveBeenCalled();
  });

  it('refuses a person of another app instance, which this conversation cannot hold', async () => {
    const { res, adds } = await share('arn:aws:chime:us-east-1:1:app-instance/other/user/x');
    expect(res.statusCode).toBe(404);
    expect(adds).toEqual([]);
  });

  it('sends no email itself: the welcome it has the router say to the new member carries it, for the bridge', async () => {
    said.length = 0;
    const { res } = await share(RECIPIENT);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).not.toHaveProperty('emailSent');
    expect(mockSes).not.toHaveBeenCalled();
    const welcome = said.find((n) => n.kind === 'memberWelcome');
    expect(welcome).toMatchObject({ to: [RECIPIENT], vars: { notifyPerson: RECIPIENT } });
  });

  it('binds nobody by address: the handler reads no pool and builds no ARN itself', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'share-conversation', 'index.js'), 'utf8');
    expect(src).not.toMatch(/ListUsersCommand|AdminListGroupsForUserCommand|client-cognito-identity-provider|SendEmailCommand/);
    expect(src).not.toMatch(/userArnFor\(/);
    expect(src).toMatch(/directory\.findByAddress\(primaryIssuer\(\), recipientEmail\)/);
  });
});
