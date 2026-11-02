/**
 * AN ACCOUNT DISABLED AT ITS ISSUER IS REFUSED AT THE NEXT VEND (SPEC-CREDENTIAL-EXCHANGE §4b, "An account
 * disabled at its issuer").
 *
 * The `Identities` table keeps no copy of an identity provider's state. Both credential exchanges ask the
 * caller's issuer whether the account may still sign in at every vend (`refuseInactiveAccount`,
 * lib/vend.ts), through the directory's seam (`Directory.accountState`):
 *
 *  - a pool account the pool reports disabled, or a pool with no such user, is refused 403
 *    `PERSON_NOT_ACTIVE`;
 *  - a pool that cannot be read refuses 503 `DIRECTORY_UNAVAILABLE`: a failed read is never an enabled
 *    account;
 *  - a federated person's account is read by the pool username `ListUsers` finds for their `sub`;
 *  - an `oidc` entry, whose signed token is its provider's answer, makes no directory call.
 *
 * And the roles that ask hold `AdminGetUser` and `ListUsers` on exactly the registry's Cognito pools. The
 * exchanges' own behavior around the answer (nothing minted, recorded or assumed) is in
 * `credential-exchange.test.ts` and `admin-credential-exchange.test.ts`.
 */
import { createDirectory } from '../../lambda/src/lib/membership-source';
import { cognitoPoolDirectory, __clearFederatedUsernamesForTests } from '../../lambda/src/lib/cognito-pool-directory';
import { clearanceSourceFor, cognitoAdapter, noDirectory, type IssuerSeam } from '../../lambda/src/lib/issuer-seams';
import { refuseInactiveAccount } from '../../lambda/src/lib/vend';
import type { TrustedIssuer } from '../../lib/config/issuers';
import { oidcIssuer, poolIssuer } from '../helpers/directory';
import { adminServicesOnLiteralsTemplate, conversationsTemplate, identityTemplate } from '../helpers/synth';

const POOL = 'us-east-1_Pool';
const SUB = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f';
const FED_SUB = '22222222-2222-4222-8222-222222222222';
const FED_USERNAME = 'CorpSSO_8f2a1c';

type Account = { Username: string; sub: string; enabled: boolean; federated?: boolean };

/** A pool that answers as Cognito does: a `sub` addresses a local user only, and a failure throws. */
function pool(accounts: Account[], opts: { fails?: boolean } = {}) {
  const calls: string[] = [];
  const named = (name: string) => Object.assign(new Error(name), { name });
  const client = {
    send: jest.fn(async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
      const k = cmd.constructor.name;
      calls.push(`${k}:${cmd.input.Username ?? cmd.input.Filter ?? ''}`);
      if (opts.fails) throw named('TooManyRequestsException');
      if (k === 'ListUsersCommand') {
        const m = /^sub = "(.+)"$/.exec(cmd.input.Filter || '');
        return { Users: accounts.filter((a) => m && a.sub === m[1]).map((a) => ({ Username: a.Username, Attributes: [{ Name: 'sub', Value: a.sub }], Enabled: a.enabled })) };
      }
      const a = accounts.find((x) => x.Username === cmd.input.Username || (!x.federated && x.sub === cmd.input.Username));
      if (!a) throw named('UserNotFoundException');
      return { Username: a.Username, UserAttributes: [{ Name: 'sub', Value: a.sub }], Enabled: a.enabled };
    }),
  };
  return { client, calls };
}

/** The deployment's directory over one pool entry and one oidc entry, built by the seams a deployment uses. */
function directoryOver(client: { send(c: unknown): Promise<any> }, issuers: TrustedIssuer[]) {
  return createDirectory({
    appInstanceArn: 'arn:aws:chime:us-east-1:111:app-instance/abc',
    issuers,
    seams: (issuer): IssuerSeam => {
      const directory = issuer.directory === 'cognito' && issuer.pool
        ? cognitoAdapter(issuer.id, cognitoPoolDirectory(issuer.pool, client), { name: 'groups', groupsFor: async () => [] })
        : noDirectory(issuer.id);
      return { issuer, directory, clearance: clearanceSourceFor(issuer, directory) };
    },
    identities: { resolve: async () => null, subjectsOf: async () => [] },
  });
}

const DEPLOYMENT = poolIssuer('deployment', POOL);
const OKTA = oidcIssuer('okta', { fixed: ['basic'], classifications: ['basic'] } as never);
const event = { headers: { origin: 'https://app.example' } };

beforeEach(() => {
  __clearFederatedUsernamesForTests();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('the vend asks the issuer, live, whether the account may sign in', () => {
  it('admits an enabled pool account, asking the pool by the token\'s sub', async () => {
    const { client, calls } = pool([{ Username: 'jane@example.com', sub: SUB, enabled: true }]);
    expect(await refuseInactiveAccount(event, { issuer: DEPLOYMENT, subject: SUB }, directoryOver(client, [DEPLOYMENT]))).toBeNull();
    expect(calls).toEqual([`AdminGetUserCommand:${SUB}`]);
  });

  it('refuses a pool account the pool reports disabled: 403 PERSON_NOT_ACTIVE', async () => {
    const { client } = pool([{ Username: 'jane@example.com', sub: SUB, enabled: false }]);
    const res = await refuseInactiveAccount(event, { issuer: DEPLOYMENT, subject: SUB }, directoryOver(client, [DEPLOYMENT]));
    expect(res?.statusCode).toBe(403);
    expect(JSON.parse(res!.body).code).toBe('PERSON_NOT_ACTIVE');
  });

  it('refuses an account the pool no longer holds: 403 PERSON_NOT_ACTIVE', async () => {
    const { client } = pool([]);
    const res = await refuseInactiveAccount(event, { issuer: DEPLOYMENT, subject: SUB }, directoryOver(client, [DEPLOYMENT]));
    expect(res?.statusCode).toBe(403);
    expect(JSON.parse(res!.body).code).toBe('PERSON_NOT_ACTIVE');
  });

  it('refuses 503 DIRECTORY_UNAVAILABLE when the pool cannot be read, never taking the failure for enabled', async () => {
    const { client } = pool([{ Username: 'jane@example.com', sub: SUB, enabled: true }], { fails: true });
    const res = await refuseInactiveAccount(event, { issuer: DEPLOYMENT, subject: SUB }, directoryOver(client, [DEPLOYMENT]));
    expect(res?.statusCode).toBe(503);
    expect(JSON.parse(res!.body).code).toBe('DIRECTORY_UNAVAILABLE');
  });

  it('reads a federated person\'s account by the pool username their sub resolves to', async () => {
    const fed = poolIssuer('corp-sso', POOL, { kind: 'cognito-federated' });
    const { client, calls } = pool([{ Username: FED_USERNAME, sub: FED_SUB, enabled: false, federated: true }]);
    const res = await refuseInactiveAccount(event, { issuer: fed, subject: FED_SUB }, directoryOver(client, [fed]));
    expect(res?.statusCode).toBe(403);
    expect(calls).toEqual([`AdminGetUserCommand:${FED_SUB}`, `ListUsersCommand:sub = "${FED_SUB}"`, `AdminGetUserCommand:${FED_USERNAME}`]);
  });

  it('makes no directory call for an oidc entry: its signed token is the provider\'s answer', async () => {
    const { client } = pool([]);
    expect(await refuseInactiveAccount(event, { issuer: OKTA, subject: 'okta-sub' }, directoryOver(client, [DEPLOYMENT, OKTA]))).toBeNull();
    expect(client.send).not.toHaveBeenCalled();
  });

  it('answers gone for an issuer the registry no longer declares', async () => {
    const { client } = pool([]);
    expect(await directoryOver(client, [DEPLOYMENT]).accountState('removed-issuer', SUB)).toBe('gone');
    expect(client.send).not.toHaveBeenCalled();
  });
});

describe('the roles that ask hold the pool reads on exactly the registry\'s Cognito pools', () => {
  const HOST_POOL = 'us-east-1_HostPool';
  const context = { issuers: [
    { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true },
    { id: 'host', kind: 'cognito-pool', pool: HOST_POOL, clearance: { oneChannel: 'basic', classifications: ['basic'] } },
  ] };
  const asking = (t: ReturnType<typeof identityTemplate>, rolePrefix: string) => (Object.entries(t.findResources('AWS::IAM::Policy')) as Array<[string, any]>)
    .filter(([, p]) => JSON.stringify(p.Properties.Roles).includes(rolePrefix))
    .flatMap(([, p]) => p.Properties.PolicyDocument.Statement)
    .filter((s: any) => s.Sid === 'AskTheIssuerWhetherTheAccountIsActive');

  it('the person exchange: AdminGetUser and ListUsers on its own pool and the host pool, and nothing else on them', () => {
    const statements = asking(identityTemplate(context), 'CredentialExchangeRole');
    expect(statements).toHaveLength(1);
    expect(statements[0].Action).toEqual(['cognito-idp:AdminGetUser', 'cognito-idp:ListUsers']);
    const resources = JSON.stringify(statements[0].Resource);
    expect(statements[0].Resource).toHaveLength(2);
    expect(resources).toContain('UserPool');
    expect(resources).toContain(`userpool/${HOST_POOL}`);
  });

  it('the admin exchange and user management: the same two reads on the same pools', () => {
    const t = adminServicesOnLiteralsTemplate(context);
    for (const role of ['AdminCredentialExchangeRole', 'UserManagementFunction']) {
      const statements = asking(t, role);
      expect([role, statements.length]).toEqual([role, 1]);
      expect(statements[0].Action).toEqual(['cognito-idp:AdminGetUser', 'cognito-idp:ListUsers']);
      expect(statements[0].Resource).toEqual([
        'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_TestPool',
        `arn:aws:cognito-idp:us-east-1:123456789012:userpool/${HOST_POOL}`,
      ]);
    }
  });

  it('the admin exchange reads the session\'s person\'s subjects through the byPerson index, read only, for every admin vend', () => {
    const t = adminServicesOnLiteralsTemplate(context);
    const statements = (Object.entries(t.findResources('AWS::IAM::Policy')) as Array<[string, any]>)
      .filter(([, p]) => JSON.stringify(p.Properties.Roles).includes('AdminCredentialExchangeRole'))
      .flatMap(([, p]) => p.Properties.PolicyDocument.Statement)
      .filter((s: any) => s.Sid === 'TheSubjectsOfTheSessionsPerson');
    expect(statements).toHaveLength(1);
    expect(statements[0].Action).toBe('dynamodb:Query');
    expect(JSON.stringify(statements[0].Resource)).toMatch(/\/index\/byPerson/);
  });

  it('a host\'s add asks the same two reads on the same pools before it admits anyone', () => {
    const statements = asking(conversationsTemplate(context), 'ConversationMembershipRole');
    expect(statements).toHaveLength(1);
    expect(statements[0].Action).toEqual(['cognito-idp:AdminGetUser', 'cognito-idp:ListUsers']);
    expect(JSON.stringify(statements[0].Resource)).toContain(`userpool/${HOST_POOL}`);
    expect(statements[0].Resource).toHaveLength(2);
  });
});
