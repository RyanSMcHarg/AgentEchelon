/**
 * A TEAM'S EXPERIMENT IS STORED UNDER ITS ASSISTANT AND WRITTEN ON ITS TEAM WRITER SESSION
 * (DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT 5.1; SPEC-ADMIN-CONSOLE FR48, FR50).
 *
 * The experiments table is keyed by `experimentId`, so a team route stores its experiment under `<assistant>.<id>`
 * (`teamExperimentId`) and writes it on a session tagged with the path's assistant, whose `dynamodb:LeadingKeys`
 * condition admits only ids beginning with that assistant (`a-team-writer-reaches-only-its-assistant.test.ts`).
 * Through the handler, with the DynamoDB document client's real commands:
 *
 *   - a team route's create stores `<assistant>.<id>` and its Put goes out on the session; its reads stay on the
 *     function's own role, and an administrator's route assumes nothing;
 *   - an experiment stored before ids carried their assistant is the administrator's to change: a team route's status
 *     change, delete or edit of one is refused before anything is written;
 *   - arming or promoting on a team route asks the profile writer to act for that assistant alone, which refuses an
 *     experiment of another.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockAssumes: Array<{ Tags?: Array<{ Key: string; Value: string }> }> = [];
const mockRows = new Map<string, Record<string, unknown>>();
const mockDdbSends: Array<{ name: string; onSession: boolean; key?: string }> = [];

jest.mock('@aws-sdk/client-sts', () => {
  const actual = jest.requireActual('@aws-sdk/client-sts');
  return {
    ...actual,
    STSClient: jest.fn(() => ({
      send: async (cmd: { input: (typeof mockAssumes)[number] }) => {
        mockAssumes.push(cmd.input);
        return { Credentials: { AccessKeyId: 'ASIA-TEAM', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(Date.now() + 900_000) } };
      },
    })),
  };
});
jest.mock('@aws-sdk/client-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/client-dynamodb');
  class DynamoDBClient {
    constructor(public readonly cfg: { credentials?: { accessKeyId?: string } } = {}) {}
  }
  return { ...actual, DynamoDBClient };
});
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: (client: { cfg?: { credentials?: { accessKeyId?: string } } }) => ({
        send: async (cmd: { constructor: { name: string }; input: Record<string, any> }) => {
          const name = cmd.constructor.name;
          const key = cmd.input.Key?.experimentId ?? cmd.input.Item?.experimentId;
          mockDdbSends.push({ name, onSession: client.cfg?.credentials?.accessKeyId === 'ASIA-TEAM', key });
          if (name === 'GetCommand') return { Item: mockRows.get(key) };
          if (name === 'ScanCommand') return { Items: [...mockRows.values()] };
          if (name === 'PutCommand') { mockRows.set(key, cmd.input.Item); return {}; }
          if (name === 'DeleteCommand') { mockRows.delete(key); return {}; }
          if (name === 'UpdateCommand') return {};
          throw new Error(`unexpected ${name}`);
        },
      }),
    },
  };
});
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn(() => ({ send: async () => { throw Object.assign(new Error('nf'), { name: 'ParameterNotFound' }); } })) };
});
const mockLambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => {
  const actual = jest.requireActual('@aws-sdk/client-lambda');
  return { ...actual, LambdaClient: jest.fn(() => ({ send: mockLambdaSend })) };
});
// The team route's scope: the path's assistant, owned. The real path read (`scopedAssistant`) is kept.
jest.mock('../lambda/src/lib/assistant-scope', () => {
  const actual = jest.requireActual('../lambda/src/lib/assistant-scope');
  return {
    ...actual,
    requireOwnedAssistant: async (event: APIGatewayProxyEvent) => {
      const assistant = actual.scopedAssistant(event);
      return assistant ? { assistant, bots: [{ assistant, classification: 'premium', role: 'ops', botArn: 'b', name: assistant, ownerTeam: 'ops', ownerRecorded: true }] } : null;
    },
  };
});

process.env.EXPERIMENTS_TABLE = 'experiments-test';
process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:1:app-instance/app';
process.env.MANAGE_PROFILES_FUNCTION_NAME = 'manage-profiles-fn:experiments';
process.env.TEAM_WRITER_ROLE_ARN = 'arn:aws:iam::123456789012:role/ExperimentsTeamWriter';

/* eslint-disable import/first */
import { handler } from '../lambda/src/admin-experiments';
import { deriveExperimentVersions, promoteExperimentCandidate } from '../lambda/src/manage-profiles';
import { _resetTeamWriterSessions } from '../lambda/src/lib/team-scoped-writer';
import { edgeContext } from './helpers/edge-context';
/* eslint-enable import/first */

const TEAM = 'ops-premium';

function evt(method: string, path: string, opts: { assistant?: string; experimentId?: string; body?: unknown } = {}): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    path,
    headers: { origin: 'http://localhost:5173' },
    requestContext: { authorizer: edgeContext({ claims: { sub: 'admin-sub', 'cognito:groups': 'admins' } }) },
    pathParameters: { ...(opts.assistant ? { assistant: opts.assistant } : {}), ...(opts.experimentId ? { experimentId: opts.experimentId } : {}) },
    body: opts.body === undefined ? null : JSON.stringify(opts.body),
  } as unknown as APIGatewayProxyEvent;
}

/** A profile experiment whose every variant is the team's assistant: one a team may hold (`experimentBelongsTo`). */
const teamExperiment = (experimentId: string, over: Record<string, unknown> = {}) => ({
  experimentId,
  status: 'draft',
  experimentType: 'profile',
  intent: '',
  tiers: ['premium'],
  startDate: '2026-11-01T00:00:00Z',
  variants: [
    { variantId: 'control', weight: 50, profileRef: { profileName: TEAM, version: 1 } },
    { variantId: 'treatment', weight: 50, profileRef: { profileName: TEAM, version: 2 } },
  ],
  ...over,
});

const writes = () => mockDdbSends.filter((s) => ['PutCommand', 'UpdateCommand', 'DeleteCommand'].includes(s.name));

beforeEach(() => {
  mockAssumes.length = 0;
  mockRows.clear();
  mockDdbSends.length = 0;
  mockLambdaSend.mockReset();
  _resetTeamWriterSessions();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('a team route', () => {
  it('stores a new experiment under its assistant and writes it on the session tagged with the path\'s assistant', async () => {
    const res = await handler(evt('POST', `/admin/assistants/${TEAM}/experiments`, { assistant: TEAM, body: teamExperiment('q3-tone') }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).experimentId).toBe(`${TEAM}.q3-tone`);
    expect([...mockRows.keys()]).toEqual([`${TEAM}.q3-tone`]);
    expect(writes()).toEqual([{ name: 'PutCommand', onSession: true, key: `${TEAM}.q3-tone` }]);
    expect(mockDdbSends.filter((s) => s.name === 'GetCommand').every((s) => !s.onSession)).toBe(true);
    expect(mockAssumes.map((a) => a.Tags)).toEqual([[{ Key: 'assistant', Value: TEAM }]]);
  });

  it('keeps an id that already carries its assistant, and deletes it on the session', async () => {
    const created = await handler(evt('POST', `/admin/assistants/${TEAM}/experiments`, { assistant: TEAM, body: teamExperiment(`${TEAM}.q4`) }));
    expect(JSON.parse(created.body).experimentId).toBe(`${TEAM}.q4`);
    const res = await handler(evt('DELETE', `/admin/assistants/${TEAM}/experiments/${TEAM}.q4`, { assistant: TEAM, experimentId: `${TEAM}.q4` }));
    expect(res.statusCode).toBe(200);
    expect(writes().map((w) => [w.name, w.onSession])).toEqual([['PutCommand', true], ['DeleteCommand', true]]);
  });

  it('DENIED: an experiment stored before ids carried their assistant is changed by an administrator, and nothing is written', async () => {
    mockRows.set('q3-tone', teamExperiment('q3-tone'));
    for (const req of [
      evt('POST', `/admin/assistants/${TEAM}/experiments/q3-tone/status`, { assistant: TEAM, experimentId: 'q3-tone', body: { status: 'completed' } }),
      evt('DELETE', `/admin/assistants/${TEAM}/experiments/q3-tone`, { assistant: TEAM, experimentId: 'q3-tone' }),
      evt('POST', `/admin/assistants/${TEAM}/experiments`, { assistant: TEAM, body: teamExperiment('q3-tone', { objective: { statement: 'edit' } }) }),
    ]) {
      const res = await handler(req);
      expect([req.httpMethod, req.path, res.statusCode, JSON.parse(res.body).code]).toEqual([req.httpMethod, req.path, 409, 'EXPERIMENT_ID_NOT_THE_TEAMS']);
    }
    expect(writes()).toEqual([]);
    expect(mockAssumes).toEqual([]);
    expect(mockRows.get('q3-tone')).toEqual(teamExperiment('q3-tone'));
  });

  it('lists every experiment of its assistant, the ones stored before ids carried it included', async () => {
    mockRows.set('q3-tone', teamExperiment('q3-tone'));
    mockRows.set(`${TEAM}.q4`, teamExperiment(`${TEAM}.q4`));
    const res = await handler(evt('GET', `/admin/assistants/${TEAM}/experiments`, { assistant: TEAM }));
    expect(JSON.parse(res.body).experiments.map((e: { experimentId: string }) => e.experimentId).sort()).toEqual([`${TEAM}.q4`, 'q3-tone']);
  });
});

describe('an administrator\'s route', () => {
  it('stores the id as sent, assumes nothing, and writes on the function\'s own role', async () => {
    const res = await handler(evt('POST', '/admin/experiments', { body: teamExperiment('q3-tone') }));
    expect(res.statusCode).toBe(200);
    expect([...mockRows.keys()]).toEqual(['q3-tone']);
    expect(writes()).toEqual([{ name: 'PutCommand', onSession: false, key: 'q3-tone' }]);
    expect(mockAssumes).toEqual([]);
  });

  it('changes an experiment stored before ids carried their assistant', async () => {
    mockRows.set('q3-tone', teamExperiment('q3-tone'));
    const res = await handler(evt('DELETE', '/admin/experiments/q3-tone', { experimentId: 'q3-tone' }));
    expect(res.statusCode).toBe(200);
    expect(writes()).toEqual([{ name: 'DeleteCommand', onSession: false, key: 'q3-tone' }]);
  });
});

describe('the profile writer, asked on a team route', () => {
  it('a team route\'s promotion names its assistant to the profile writer', async () => {
    mockRows.set(`${TEAM}.q4`, { ...teamExperiment(`${TEAM}.q4`), status: 'active', servesVersions: true });
    mockLambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ ok: false, status: 409, error: 'refused', code: 'X' })) });
    await handler(evt('POST', `/admin/assistants/${TEAM}/experiments/${TEAM}.q4/promote`, { assistant: TEAM, experimentId: `${TEAM}.q4`, body: {} }));
    const payload = JSON.parse(Buffer.from(mockLambdaSend.mock.calls[0][0].input.Payload).toString());
    expect(payload.aePromoteCandidate.teamAssistant).toBe(TEAM);
  });

  it('DENIED: derives a candidate for the team\'s own assistant alone', async () => {
    const r = await deriveExperimentVersions({ experiment: teamExperiment(`${TEAM}.q4`), actor: 'a', teamAssistant: 'advisor' });
    expect(r).toEqual(expect.objectContaining({ ok: false, status: 403, code: 'ASSISTANT_MISMATCH' }));
  });

  it('DENIED: promotes into the team\'s own assistant alone', async () => {
    const exp = teamExperiment(`${TEAM}.q4`, {
      variants: [
        { variantId: 'control', weight: 50, profileRef: { profileName: TEAM, version: 1 }, controlPin: { profileName: TEAM, version: 1 } },
        { variantId: 'treatment', weight: 50, profileRef: { profileName: TEAM, version: 2 }, altPin: { profileName: 'alt-ops-premium', version: 2 } },
      ],
    });
    const r = await promoteExperimentCandidate({ experiment: exp, actor: 'a', teamAssistant: 'advisor' });
    expect(r).toEqual(expect.objectContaining({ ok: false, status: 403, code: 'ASSISTANT_MISMATCH' }));
  });
});
