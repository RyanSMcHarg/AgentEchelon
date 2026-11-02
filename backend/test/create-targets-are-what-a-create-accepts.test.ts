/**
 * WHERE THE CONSOLE OFFERS TO CREATE AN ASSISTANT IS WHERE A CREATE IS ACCEPTED (ADR-048).
 *
 * Both listings that offer create targets (the admin listing, `manage-profiles` GET, and a team's roster,
 * `manage-assistants` team GET) answer through `lib/roster-targets.ts`, from the same facts the create
 * checks: the deployment's own conversational classifications (never an `outside` one) and the roles the
 * registry row says the classification deploys. No assignment record is read to decide it (ADR-048, amended
 * 2026-10-23), so a role whose declared assistant was retired is still offered, and the two routes agree for a
 * session cleared for every classification.
 */
const ssmSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn(() => ({ send: ssmSend })) };
});
jest.mock('@aws-sdk/client-chime-sdk-identity', () => {
  const actual = jest.requireActual('@aws-sdk/client-chime-sdk-identity');
  return { ...actual, ChimeSDKIdentityClient: jest.fn(() => ({ send: async () => ({}) })) };
});
jest.mock('@aws-sdk/client-lex-models-v2', () => {
  const actual = jest.requireActual('@aws-sdk/client-lex-models-v2');
  return { ...actual, LexModelsV2Client: jest.fn(() => ({ send: async () => ({}) })) };
});
jest.mock('@aws-sdk/client-lambda', () => {
  const actual = jest.requireActual('@aws-sdk/client-lambda');
  return {
    ...actual,
    LambdaClient: jest.fn(() => ({
      send: async (cmd: { input: { Payload?: Uint8Array } }) => {
        const p = JSON.parse(Buffer.from(cmd.input.Payload ?? []).toString() || '{}');
        const answer = p.op === 'in-team' ? { inTeam: true } : p.op === 'owned-by' ? { assistants: [] } : {};
        return { Payload: Buffer.from(JSON.stringify(answer)) };
      },
    })),
  };
});

process.env.AWS_REGION = 'us-east-1';
process.env.AWS_ACCOUNT_ID = '123456789012';
process.env.SSM_ROOT = '/ae';
process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:123456789012:app-instance/ai';
process.env.OWNERSHIP_FUNCTION_NAME = 'ae-assistant-ownership';
process.env.ADMIN_IAM_ENFORCEMENT = 'true';

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler as profilesHandler } from '../lambda/src/manage-profiles';
import { handler as assistantsHandler } from '../lambda/src/manage-assistants';
import { defaultProfileRegistry as profiles, loadProfileRegistry } from '../lib/profile-registry';

const SUB = '11111111-2222-3333-4444-555555555555';
let params: Map<string, string>;

function signed(kind: 'team' | 'admin', path: string, clearance: string): APIGatewayProxyEvent {
  const session = kind === 'team' ? `console-${SUB}@${clearance}` : `console-${SUB}`;
  return {
    httpMethod: 'GET',
    path,
    headers: { origin: 'http://localhost:5173' },
    requestContext: { identity: { userArn: `arn:aws:sts::1:assumed-role/ae-${kind}-console/${session}` } },
  } as unknown as APIGatewayProxyEvent;
}

type Target = { classification: string; roles: string[] };

beforeAll(async () => { await loadProfileRegistry(); });

beforeEach(() => {
  ssmSend.mockReset().mockImplementation(async (cmd: { constructor: { name: string }; input: { Name?: string; Path?: string } }) => {
    if (cmd.constructor.name === 'GetParametersByPathCommand') return { Parameters: [] };
    const value = cmd.input.Name ? params.get(cmd.input.Name) : undefined;
    if (value === undefined) throw Object.assign(new Error('nf'), { name: 'ParameterNotFound' });
    return { Parameter: { Name: cmd.input.Name, Value: value } };
  });
  // NO RECORD AT ALL: the offer is the registry's deployed roles, not what records exist.
  params = new Map();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

const adminTargets = async (): Promise<Target[]> =>
  JSON.parse((await profilesHandler(signed('admin', '/admin/profiles', ''))).body).rosterTargets;
const teamTargets = async (clearance: string): Promise<Target[]> =>
  JSON.parse(((await assistantsHandler(signed('team', '/admin/teams/ops/roster', clearance))) as { body: string }).body).rosterTargets;

describe('create targets', () => {
  it('offer every role the registry row deploys, with no record read to decide it', async () => {
    expect(profiles.rolesFor('premium')).toContain('ops');
    const premium = (await adminTargets()).find((t) => t.classification === 'premium');
    expect(premium?.roles).toEqual(profiles.rolesFor('premium'));
    expect(ssmSend.mock.calls.some(([c]) => String(c.input?.Name ?? '').endsWith('/live'))).toBe(false);
  });

  it('leave out every outside-audience classification and the admin plane', async () => {
    const offered = (await adminTargets()).map((t) => t.classification);
    for (const c of profiles.classificationValues()) {
      if (profiles.audienceOf(c) === 'outside' || !profiles.isConversational(c)) expect(offered).not.toContain(c);
    }
    for (const c of profiles.adminPlaneValues()) expect(offered).not.toContain(c);
    expect(offered.length).toBeGreaterThan(0);
  });

  it('are the same on the admin route and on a team route whose clearance reaches every one of them', async () => {
    const admin = await adminTargets();
    // A clearance that reaches every offered classification, from the registry rather than a name here.
    const holder = profiles.classificationValues().find((h) => admin.every((t) => profiles.reaches(h, t.classification)));
    if (!holder) throw new Error('no declared classification reaches every create target; the comparison needs one');
    expect(await teamTargets(holder)).toEqual(admin);
  });

  it('on a team route are narrowed by clearance, never widened', async () => {
    const admin = await adminTargets();
    for (const clearance of profiles.memberClassificationValues()) {
      const team = await teamTargets(clearance);
      for (const t of team) {
        expect(profiles.reaches(clearance, t.classification)).toBe(true);
        expect(admin).toContainEqual(t);
      }
    }
  });
});
