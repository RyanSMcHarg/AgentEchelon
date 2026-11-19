/**
 * A SHARE FINDS ITS RECIPIENT BY PERSON, NEVER BINDS ONE BY ADDRESS.
 *
 * The address is input: it finds one subject in this deployment's own directory, which becomes a person
 * through `Identities` exactly as a sign-in does (`Directory.findByAddress`). The member added is that
 * AppInstanceUser, never an ARN built from the address or the pool's username, and an address that
 * resolves to nobody - no such subject, more than one, or a subject that has never signed in - is refused
 * before anything is added. There is no invitation for an unknown address.
 */
// The conversation's type allows what these cases do; the refusal is `a-type-that-turns-a-capability-off-is-refused`.
jest.mock('../../lambda/src/lib/type-capability', () => ({ ...jest.requireActual('../../lambda/src/lib/type-capability'), typeAllows: jest.fn(async () => ({ ok: true })) }));
import { seedRegistryRows } from '../helpers/registry-rows';
const mockChime = jest.fn();
const mockSes = jest.fn();

const tagged = (t: string) => class { __t = t; constructor(public input: any) {} };
// The sharer is cleared for the premium conversation (`lib/conversation-access.ts`); an uncleared sharer's
// refusal is proven in `lib/a-person-route-reaches-only-a-conversation-its-caller-reaches.test.ts`.
jest.mock('../../lambda/src/lib/auth', () => ({
  ...jest.requireActual('../../lambda/src/lib/auth'),
  callerHolderToken: () => 'premium',
}));
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
  // No tag memo here: every request reads the tags it asks for.
  memoizedTagReader: (client: unknown) => client,
  tagMemoHolds: () => false,
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

function directory(found: string | null, asked: Array<[string, string]>, groups: string[]): Directory {
  return {
    personsInGroup: async () => ({ persons: [], unminted: [] }),
    personOf: async () => null,
    admins: async () => ({ persons: [], unminted: [] }),
    clearanceOf: async () => ({ state: 'none' as const }),
    listGroups: async () => [],
    findByAddress: async (issuer, address) => { asked.push([issuer, address]); return found; },
    accountState: async () => 'active' as const,
    groupsFor: async () => groups,
    clearedByGroups: async () => null,
    displayNameFor: async () => 'Bob',
    contactFor: async () => ({ route: 'email', address: 'bob@example.com', name: 'Bob' }),
  };
}

/** Each refusal's hold, by a clock the directory's reads advance: what the refusal waited for. */
let waited: number[] = [];
async function share(found: string | null, recipientEmail = 'bob@example.com', channelName: string | Error = 'Q3 Planning', groups: string[] = ['premium'], readMs = 0) {
  jest.resetModules();
  const asked: Array<[string, string]> = [];
  const ms = await import('../../lambda/src/lib/membership-source');
  // Every directory read takes `readMs` on the test's clock, so a refusal after more reads starts its hold later.
  let t = 1_000_000;
  const d = directory(found, asked, groups);
  const slow = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => { t += readMs; return f(...a); };
  ms.__setDefaultDirectoryForTests({ ...d, findByAddress: slow(d.findByAddress), groupsFor: slow(d.groupsFor), clearanceOf: slow(d.clearanceOf) });
  mockChime.mockReset().mockImplementation((cmd: { __t: string }) => {
    if (cmd.__t === 'DescribeChannel') return channelName instanceof Error ? Promise.reject(channelName) : Promise.resolve({ Channel: { Name: channelName } });
    return Promise.resolve(cmd.__t === 'ListTagsForResource' ? { Tags: [{ Key: 'classification', Value: 'premium' }] } : {});
  });
  mockSes.mockReset().mockImplementation(async (r: Array<{ email: string }>) => ({ sent: r.map((x) => x.email), failed: [] }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { handler, __forTests } = require('../../lambda/share-conversation/index.js');
  waited = [];
  __forTests.setTiming({ clock: () => t, pause: async (msLeft: number) => { waited.push(msLeft); t += msLeft; } });
  const quiet = [jest.spyOn(console, 'log').mockImplementation(() => {}), jest.spyOn(console, 'warn').mockImplementation(() => {})];
  const res = await handler({
    httpMethod: 'POST',
    requestContext: { authorizer: edgeContext({ claims: { sub: 'caller', email: 'lead@example.com' } }) },
    body: JSON.stringify({ conversationArn: `${APP}/channel/c1`, recipientEmail, conversationTitle: 'Open https://elsewhere.example now' }),
  });
  const logged = JSON.stringify(quiet.flatMap((spy) => spy.mock.calls));
  quiet.forEach((s) => s.mockRestore());
  const adds = mockChime.mock.calls.map(([c]) => c).filter((c) => c.__t === 'CreateChannelMembership');
  return { res, asked, adds, logged };
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
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('RECIPIENT_NOT_ADDABLE');
    expect(adds).toEqual([]);
    expect(mockSes).not.toHaveBeenCalled();
  });

  it('refuses a person of another app instance, which this conversation cannot hold', async () => {
    const { res, adds } = await share('arn:aws:chime:us-east-1:1:app-instance/other/user/x');
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('RECIPIENT_NOT_ADDABLE');
    expect(adds).toEqual([]);
  });

  // THE SHARE ROUTE IS NOT A DIRECTORY ORACLE. A person not cleared for the conversation is refused with the
  // very answer an address that names nobody gets, so a caller cannot learn that an account exists, or which
  // classifications its owner holds, by sharing with it.
  it('refuses a person not cleared for the conversation with the same answer as nobody at all', async () => {
    const nobody = await share(null);
    const uncleared = await share(RECIPIENT, 'bob@example.com', 'Q3 Planning', ['basic']);
    expect(uncleared.adds).toEqual([]);
    expect(uncleared.res.statusCode).toBe(nobody.res.statusCode);
    expect(JSON.parse(uncleared.res.body)).toEqual(JSON.parse(nobody.res.body));
    const body = uncleared.res.body;
    expect(body).not.toMatch(/recipientTier|channelTier|basic|premium|Bob/);
  });

  // THE ANSWER'S TIME SAYS NO MORE THAN ITS BODY: a refusal after one directory read and one after several both answer
  // at the same moment from the start of the lookup.
  it('DENY: refuses nobody at all and an uncleared person at the same time after the lookup began', async () => {
    const { __forTests } = require('../../lambda/share-conversation/index.js');
    const floor = __forTests.RECIPIENT_ANSWER_FLOOR_MS as number;
    await share(null, 'bob@example.com', 'Q3 Planning', ['premium'], 40);
    const nobody = waited[0];
    await share(RECIPIENT, 'bob@example.com', 'Q3 Planning', ['basic'], 40);
    const uncleared = waited[0];
    // One read before the first refusal, two before the second: each waits out the rest of the same floor.
    expect(nobody).toBe(floor - 40);
    expect(uncleared).toBe(floor - 80);
    expect(nobody - uncleared).toBe(40);
  });

  it('never writes the typed address to the log, found or not', async () => {
    for (const run of [await share(null, 'carol@example.com'), await share(RECIPIENT, 'carol@example.com', 'Q3 Planning', ['basic'])]) {
      expect(run.logged).not.toContain('carol@example.com');
    }
    const uncleared = await share(RECIPIENT, 'carol@example.com', 'Q3 Planning', ['basic']);
    // The person is named by id once resolved.
    expect(uncleared.logged).toContain('0192f0e0-0000-7000-8000-00000000b0b0');
  });

  it('the welcome names the conversation by its own name, whatever title the request sent', async () => {
    said.length = 0;
    await share(RECIPIENT);
    expect(said.find((n) => n.kind === 'memberWelcome')?.vars.recap).toBe('Q3 Planning');
  });

  it('a name that cannot be read leaves it out, and the share and its welcome stand', async () => {
    said.length = 0;
    const { res } = await share(RECIPIENT, 'bob@example.com', new Error('throttled'));
    expect(res.statusCode).toBe(200);
    expect(said.find((n) => n.kind === 'memberWelcome')?.vars.recap).toBe('');
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
