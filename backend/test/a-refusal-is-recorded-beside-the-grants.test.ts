/**
 * A REFUSAL IS RECORDED BESIDE THE GRANTS (ADR-052, SPEC-CREDENTIAL-EXCHANGE §4d, SPEC-ADMIN-CONSOLE FR30).
 *
 * Both credential exchanges write every answer that vends nothing to the access log, as a record with
 * `outcome: 'refused'`: who asked, what they asked for, the refusal's code and status, and when. A grant is
 * written exactly as before, before its credential leaves. A refusal whose record cannot be written, or
 * whose write never returns, is answered all the same and never becomes a grant. The reader returns each
 * record with its outcome.
 */
const mockStsSend = jest.fn();
const mockMessagingSend = jest.fn();
const mockScope = jest.fn();
const mockDocSend = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDocSend })) },
  PutCommand: jest.fn((input: unknown) => ({ __type: 'Put', input })),
  GetCommand: jest.fn((input: unknown) => ({ __type: 'Get', input })),
  QueryCommand: jest.fn((input: unknown) => ({ __type: 'Query', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ __type: 'Update', input })),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn(() => ({ send: mockStsSend })),
  AssumeRoleCommand: jest.fn((input: unknown) => ({ __type: 'AssumeRole', input })),
}));
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: mockMessagingSend })),
  DescribeChannelMembershipForAppInstanceUserCommand: jest.fn((input: unknown) => ({ __type: 'DescribeMembership', input })),
}));
jest.mock('@aws-sdk/client-chime-sdk-identity', () => ({
  ChimeSDKIdentityClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({}) })),
  CreateAppInstanceUserCommand: jest.fn(),
  UpdateAppInstanceUserCommand: jest.fn(),
  DescribeAppInstanceUserCommand: jest.fn(),
  CreateAppInstanceAdminCommand: jest.fn(),
  TagResourceCommand: jest.fn(),
  ListAppInstanceBotsCommand: jest.fn(),
  ListTagsForResourceCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: jest.fn().mockResolvedValue({ Parameter: { Value: 'arn:aws:s3:::attach' } }) })),
  GetParameterCommand: jest.fn(),
}));
jest.mock('../lambda/src/lib/assistant-scope.js', () => ({
  ...jest.requireActual('../lambda/src/lib/assistant-scope.js'),
  requireOwnedAssistant: (...a: unknown[]) => mockScope(...a),
}));

import { edgeContext } from './helpers/edge-context';

const APP = 'arn:aws:chime:us-east-1:111:app-instance/abc';
process.env.APP_INSTANCE_ARN = APP;
process.env.ACCESS_LOG_TABLE = 'access-log';
process.env.IDENTITIES_TABLE = 'identities';
process.env.USER_POOL_ID = 'us-east-1_pool';
process.env.ALLOWED_ORIGIN = 'https://admin.example';
process.env.ADMIN_IAM_ENFORCEMENT = 'true';
process.env.ADMIN_CONSOLE_ROLE_ARN = 'arn:aws:iam::111:role/agent-echelon-admin-console';
process.env.TEAM_CONSOLE_ROLE_ARN = 'arn:aws:iam::111:role/agent-echelon-team-console';
process.env.TEAM_ATTACHMENT_ROLE_ARN = 'arn:aws:iam::111:role/team-attachments';
process.env.EXCHANGE_ROLE_ADMIN_PLANE = 'arn:aws:iam::111:role/ex-admin-plane';
process.env.EXCHANGE_ATTACHMENTS_BUCKET_ARN = 'arn:aws:s3:::attach';
delete process.env.TRUSTED_ISSUERS;

/* eslint-disable @typescript-eslint/no-var-requires */
const admin = require('../lambda/src/admin-credential-exchange').handler as (e: unknown) => Promise<{ statusCode: number; body: string }>;
const person = require('../lambda/src/credential-exchange').handler as (e: unknown) => Promise<{ statusCode: number; body: string }>;
const reader = require('../lambda/src/access-log-reader').handler as (e: unknown) => Promise<{ statusCode: number; body: string }>;
const { accessRecordOf, recordRefusal, ACCESS_LOG_RETENTION_DAYS } = require('../lambda/src/lib/access-log');
const { refusalLineOf, refusalsRecorded } = require('../lambda/src/lib/vend');
/* eslint-enable @typescript-eslint/no-var-requires */

/** A person, as a console session names one: their AppInstanceUser id. */
const SUB = '0a1b2c3d-0000-4000-8000-00000000abcd';
const CHANNEL = `${APP}/channel/conv-1`;
const BOT = `${APP}/bot/hr-standard`;

const teamVend = (body: Record<string, unknown>) => ({
  httpMethod: 'POST',
  path: '/exchange-credentials/admin/assistants/hr/attachment-read',
  pathParameters: { assistant: 'hr' },
  requestContext: { identity: { userArn: `arn:aws:sts::111:assumed-role/agent-echelon-team-console/console-${SUB}@standard` } },
  body: JSON.stringify(body),
});
const adminVend = (capability: string, body: Record<string, unknown>) => ({
  httpMethod: 'POST',
  path: `/exchange-credentials/admin/${capability}`,
  requestContext: { identity: { userArn: `arn:aws:sts::111:assumed-role/agent-echelon-admin-console/console-${SUB}` } },
  body: JSON.stringify(body),
});
const tokenRequest = (claims: Record<string, unknown>, body?: unknown) => ({
  httpMethod: 'POST', requestContext: { authorizer: edgeContext({ claims }) }, body: body ? JSON.stringify(body) : undefined,
});

/** The access-log rows written, in order. */
const rows = (): Array<Record<string, any>> => mockDocSend.mock.calls.map((c) => c[0])
  .filter((c) => c.__type === 'Put' && c.input.TableName === 'access-log')
  .map((c) => c.input.Item);
const refusals = () => rows().filter((r) => r.outcome === 'refused');

let warnSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  mockDocSend.mockReset().mockResolvedValue({});
  mockScope.mockResolvedValue({ assistant: 'hr', bots: [{ assistant: 'hr', botArn: BOT, classification: 'standard' }] });
  mockMessagingSend.mockResolvedValue({ ChannelMembership: {} });
  mockStsSend.mockResolvedValue({ Credentials: { AccessKeyId: 'A', SecretAccessKey: 'S', SessionToken: 'T' } });
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warnSpy.mockRestore());

describe('the admin credential exchange records each refusal', () => {
  it('a conversation the assistant is not in: CONVERSATION_NOT_FOUND, with who, what and why', async () => {
    mockMessagingSend.mockRejectedValue(Object.assign(new Error('not a member'), { name: 'ForbiddenException' }));
    const res = await admin(teamVend({ channelArn: CHANNEL, reason: 'customer asked about the report' }));
    expect(res.statusCode).toBe(404);
    const [r] = refusals();
    expect(r).toMatchObject({
      event: 'admin_credential_refused', outcome: 'refused', code: 'CONVERSATION_NOT_FOUND', status: 404,
      actorPersonId: SUB, conversation: CHANNEL, capabilities: ['attachment-read'], reason: 'customer asked about the report',
    });
    expect(JSON.parse(r.detail)).toMatchObject({ assistant: 'hr', route: '/exchange-credentials/admin/assistants/hr/attachment-read' });
    expect(refusals()).toHaveLength(1);
  });

  it('an assistant the team does not own: ASSISTANT_NOT_OWNED', async () => {
    mockScope.mockResolvedValue({ statusCode: 403, headers: {}, body: '{}' });
    const res = await admin(teamVend({ channelArn: CHANNEL, reason: 'r' }));
    expect(res.statusCode).toBe(403);
    expect(refusals()).toEqual([expect.objectContaining({ code: 'ASSISTANT_NOT_OWNED', status: 403, actorPersonId: SUB, conversation: CHANNEL })]);
  });

  it('a per-conversation vend with no reason: REASON_REQUIRED, naming the capability the route asks for, not the body', async () => {
    const res = await admin(adminVend('view-messages', { channelArn: CHANNEL, capabilities: ['delete'] }));
    expect(res.statusCode).toBe(400);
    expect(refusals()).toEqual([expect.objectContaining({
      code: 'REASON_REQUIRED', status: 400, actorPersonId: SUB, conversation: CHANNEL, capabilities: ['view-messages'],
    })]);
  });

  it('a person whose issuer reports them disabled: PERSON_NOT_ACTIVE, and nothing is assumed', async () => {
    const { accountState } = jest.requireMock('../lambda/src/lib/membership-source').__accountStateForTests;
    accountState.mockResolvedValue('disabled');
    try {
      const res = await admin(teamVend({ channelArn: CHANNEL, reason: 'r' }));
      expect(res.statusCode).toBe(403);
      expect(mockStsSend).not.toHaveBeenCalled();
      expect(refusals()).toEqual([expect.objectContaining({ code: 'PERSON_NOT_ACTIVE', actorPersonId: SUB })]);
    } finally {
      accountState.mockResolvedValue('active');
    }
  });

  it('a console session for a sign-in holding no admin role: NO_ADMIN_CAPABILITY, under the person the token resolves to', async () => {
    const res = await admin(tokenRequest({ sub: 'u1', 'cognito:groups': 'standard' }, { identity: 'console' }));
    expect(res.statusCode).toBe(403);
    expect(refusals()).toEqual([expect.objectContaining({ code: 'NO_ADMIN_CAPABILITY', status: 403, actorPersonId: 'u1' })]);
  });
});

describe('the person credential exchange records each refusal', () => {
  it('an admin credential asked of the person exchange: ADMIN_VEND_MOVED', async () => {
    const res = await person(tokenRequest({ sub: 'u1', 'cognito:groups': 'standard' }, { identity: 'admin', channelArn: CHANNEL }));
    expect(res.statusCode).toBe(403);
    const [r] = refusals();
    expect(r).toMatchObject({ event: 'person_credential_refused', code: 'ADMIN_VEND_MOVED', status: 403, actorPersonId: 'u1', conversation: CHANNEL });
    expect(JSON.parse(r.detail).identity).toBe('admin');
  });

  it('a refusal the exchange gives no code: its status and its words are recorded', async () => {
    const res = await person(tokenRequest({ sub: 'u1', 'cognito:groups': 'standard' }, { capabilities: ['view', 'fly'] }));
    expect(res.statusCode).toBe(400);
    const [r] = refusals();
    expect(r).toMatchObject({ status: 400, capabilities: ['view', 'fly'] });
    expect(r.code).toBeUndefined();
    expect(JSON.parse(r.detail).error).toBe('unknown capabilities: fly');
  });

  it('a token from an issuer this deployment does not trust: ISSUER_NOT_TRUSTED', async () => {
    const res = await person({
      httpMethod: 'POST',
      requestContext: { authorizer: edgeContext({ claims: { sub: 'u1', iss: 'https://issuer.example' }, issuerId: 'removed-issuer' }) },
    });
    expect(res.statusCode).toBe(403);
    expect(refusals()).toEqual([expect.objectContaining({ code: 'ISSUER_NOT_TRUSTED', status: 403 })]);
  });

  it('answers a route that takes no token without a record, so an anonymous caller writes nothing', async () => {
    const res = await person({ httpMethod: 'POST', resource: '/guest/start', body: '{}' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(rows()).toEqual([]);
  });
});

describe('a refusal whose record cannot be written is refused all the same', () => {
  it('the table refuses the write: the same refusal, no credential, and a security event', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mockDocSend.mockRejectedValue(Object.assign(new Error('down'), { name: 'ServiceUnavailable' }));
      mockMessagingSend.mockRejectedValue(Object.assign(new Error('not a member'), { name: 'ForbiddenException' }));
      const res = await admin(teamVend({ channelArn: CHANNEL, reason: 'r' }));
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'No conversation with that id in your scope', code: 'CONVERSATION_NOT_FOUND' });
      expect(mockStsSend).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('a refusal could not be recorded'), expect.objectContaining({ code: 'CONVERSATION_NOT_FOUND' }));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('the write never returns: the refusal is answered when the bound runs out', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mockDocSend.mockImplementation(() => new Promise(() => undefined));
      const started = Date.now();
      const res = await person(tokenRequest({ sub: 'u1', 'cognito:groups': 'standard' }, { identity: 'console' }));
      expect(res.statusCode).toBe(403);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(await recordRefusal({ _auditEvent: 'x', personId: 'p' }, { timeoutMs: 10 })).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  }, 10_000);

  it('no table at all: refused, never thrown', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await recordRefusal({ _auditEvent: 'x', personId: 'p' }, { table: '' })).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a handler that throws is recorded as refused and the throw reaches the caller', async () => {
    const written: unknown[] = [];
    const wrapped = refusalsRecorded('admin', async () => { throw new Error('boom'); }, {
      record: async (line: unknown) => { written.push(line); return true; },
    });
    await expect(wrapped({ httpMethod: 'POST', path: '/exchange-credentials' })).rejects.toThrow('boom');
    expect(written).toEqual([expect.objectContaining({ outcome: 'refused', status: 500 })]);
  });

  it('a writer that throws does not change the answer, and is logged as a security event', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const answer = { statusCode: 403, headers: {}, body: JSON.stringify({ error: 'no', code: 'NO' }) };
      const wrapped = refusalsRecorded('person', async () => answer, { record: async () => { throw new Error('down'); } });
      await expect(wrapped({ httpMethod: 'POST', path: '/exchange-credentials' })).resolves.toBe(answer);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[SecurityEvent]'), expect.objectContaining({ status: 403 }));
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('grants are recorded as before', () => {
  it('a team attachment vend writes its grant record and no refusal', async () => {
    const res = await admin(teamVend({ channelArn: CHANNEL, reason: 'customer asked about the report' }));
    expect(res.statusCode).toBe(200);
    expect(rows()).toEqual([expect.objectContaining({
      event: 'team_scoped_credential_vend', outcome: 'granted', actorPersonId: SUB, conversation: CHANNEL, capabilities: ['attachment-read'],
    })]);
    expect(rows()[0].code).toBeUndefined();
    expect(rows()[0].status).toBeUndefined();
  });

  it('a grant whose record fails is still withheld, and that withholding is itself a refusal', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mockDocSend.mockRejectedValue(Object.assign(new Error('down'), { name: 'ServiceUnavailable' }));
      const res = await admin(teamVend({ channelArn: CHANNEL, reason: 'r' }));
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).credentials).toBeUndefined();
      const attempted = mockDocSend.mock.calls.map((c) => c[0].input.Item);
      expect(attempted.map((i) => [i.outcome, i.code ?? null])).toEqual([['granted', null], ['refused', 'ACCESS_LOG_UNAVAILABLE']]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('the record a refusal becomes', () => {
  it('keys its own instant and id, so it lands beside the grants of its day and never replaces one, and expires with them', async () => {
    const at = '2026-10-12T10:00:00.000Z';
    const refusal = accessRecordOf({ _auditEvent: 'admin_credential_refused', outcome: 'refused', timestamp: at, personId: SUB, code: 'X', status: 403 }, new Date(), 'id-r');
    const grant = accessRecordOf({ _auditEvent: 'admin_scoped_credential_vend', timestamp: at, adminPersonId: SUB }, new Date(), 'id-g');
    expect(refusal.pk).toBe(grant.pk);
    expect(refusal.sk).not.toBe(grant.sk);
    expect(refusal.expiresAt).toBe(grant.expiresAt);
    expect(refusal.expiresAt).toBe(Date.parse(at) / 1000 + ACCESS_LOG_RETENTION_DAYS * 86_400);
    await recordRefusal({ _auditEvent: 'admin_credential_refused', personId: SUB });
    expect(mockDocSend.mock.calls[0][0].input.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  it('names no person, rather than an empty index key, for a sign-in that never became one', () => {
    const r = accessRecordOf({ _auditEvent: 'person_credential_refused', outcome: 'refused', issuer: 'deployment', subject: 's-1', status: 403 });
    expect('actorPersonId' in r).toBe(false);
    expect(JSON.parse(r.detail)).toMatchObject({ issuer: 'deployment', subject: 's-1' });
  });

  it('reads only the named fields of a body, so a token, a refresh credential or an invitation never reaches the log', () => {
    const line = refusalLineOf('person', {
      httpMethod: 'POST', path: '/exchange-credentials',
      body: JSON.stringify({ link: { token: 'SECRET-1' }, bind: { refresh: 'SECRET-2' }, invitation: 'SECRET-3', channelArn: CHANNEL }),
    }, { statusCode: 400, body: JSON.stringify({ error: 'Malformed body', code: 'UPGRADE_MALFORMED' }) }, null);
    expect(JSON.stringify(line)).not.toMatch(/SECRET/);
    expect(line).toMatchObject({ channelArn: CHANNEL, code: 'UPGRADE_MALFORMED', status: 400 });
  });

  it('builds from a body whose capabilities are not strings, so no value a caller sends keeps its refusal out of the log', async () => {
    const event = { httpMethod: 'POST', path: '/exchange-credentials', body: JSON.stringify({ capabilities: [{ toString: 0 }, 'read'], channelArn: CHANNEL }) };
    const answer = { statusCode: 403, body: JSON.stringify({ code: 'PERSON_NOT_ACTIVE' }) };
    expect(refusalLineOf('person', event, answer, null).capabilities).toEqual(['read']);
    const lines: unknown[] = [];
    const wrapped = refusalsRecorded('person', async () => answer, { record: async (l: unknown) => { lines.push(l); return true; } });
    await wrapped(event);
    expect(lines).toHaveLength(1);
  });

  it('files a refusal under a conversation only when the body names a literal channel of this instance', () => {
    const lineFor = (channelArn: string) => refusalLineOf('person', {
      httpMethod: 'POST', path: '/exchange-credentials', body: JSON.stringify({ channelArn }),
    }, { statusCode: 403, body: '{}' }, null);
    for (const planted of ['anything', `${APP}/channel/*`, 'arn:aws:chime:us-east-1:999:app-instance/other/channel/c1']) {
      const line = lineFor(planted);
      expect({ planted, channelArn: line.channelArn, askedChannel: line.askedChannel }).toEqual({ planted, channelArn: null, askedChannel: planted });
      expect('conversation' in accessRecordOf(line)).toBe(false);
    }
    expect(lineFor(CHANNEL).channelArn).toBe(CHANNEL);
  });
});

describe('the reader returns refusals beside grants', () => {
  it('states each record\'s outcome, a refusal\'s code and status, and reads an older record as a grant', async () => {
    const at = '2026-10-12T10:00:00.000Z';
    const refusal = accessRecordOf({ _auditEvent: 'admin_credential_refused', outcome: 'refused', timestamp: at, personId: SUB, channelArn: CHANNEL, code: 'CONVERSATION_NOT_FOUND', status: 404 }, new Date(), 'r');
    const anonymous = accessRecordOf({ _auditEvent: 'person_credential_refused', outcome: 'refused', timestamp: at, status: 403 }, new Date(), 'a');
    const older = { ...accessRecordOf({ _auditEvent: 'admin_scoped_credential_vend', timestamp: at, adminPersonId: SUB }, new Date(), 'g') };
    delete (older as Record<string, unknown>).outcome;
    mockDocSend.mockImplementation(async (c: { __type: string }) => (c.__type === 'Query' ? { Items: [refusal, anonymous, older] } : {}));
    const res = await reader({
      httpMethod: 'GET', headers: { origin: 'https://admin.example' }, queryStringParameters: { days: '1' },
      requestContext: { identity: { userArn: `arn:aws:sts::111122223333:assumed-role/agent-echelon-admin-console/console-${SUB}` } },
    });
    expect(res.statusCode).toBe(200);
    const records = JSON.parse(res.body).records as Array<Record<string, unknown>>;
    const byId = (id: string) => records.find((r) => r.id === id);
    expect(byId('r')).toEqual(expect.objectContaining({ outcome: 'refused', code: 'CONVERSATION_NOT_FOUND', status: 404, actor: SUB, conversation: CHANNEL }));
    expect(byId('a')).toEqual(expect.objectContaining({ outcome: 'refused', code: null, status: 403, actor: null }));
    expect(byId('g')).toEqual(expect.objectContaining({ outcome: 'granted', actor: SUB }));
    expect(byId('g')?.code).toBeUndefined();
  });

  it('reads grants and refusals on separate budgets, so a flood of refusals never pushes a grant out of the view', async () => {
    const at = (i: number) => new Date(Date.parse('2026-10-12T10:00:00.000Z') + i * 1000).toISOString();
    const flood = Array.from({ length: 50 }, (_, i) =>
      accessRecordOf({ _auditEvent: 'person_credential_refused', outcome: 'refused', timestamp: at(100 + i), channelArn: CHANNEL, status: 403 }, new Date(), `f${i}`));
    const grant = accessRecordOf({ _auditEvent: 'admin_scoped_credential_vend', timestamp: at(0), adminPersonId: SUB, channelArn: CHANNEL }, new Date(), 'g');
    const newestFirst = [...flood].reverse().concat(grant);
    mockDocSend.mockImplementation(async (c: { __type: string }) => (c.__type === 'Query' ? { Items: newestFirst } : {}));
    const res = await reader({
      httpMethod: 'GET', headers: { origin: 'https://admin.example' },
      queryStringParameters: { days: '1', limit: '5', channelId: CHANNEL.split('/channel/')[1] },
      requestContext: { identity: { userArn: `arn:aws:sts::111122223333:assumed-role/agent-echelon-admin-console/console-${SUB}` } },
    });
    expect(res.statusCode).toBe(200);
    const records = JSON.parse(res.body).records as Array<{ id: string; outcome: string }>;
    expect(records.filter((r) => r.outcome === 'refused')).toHaveLength(5);
    expect(records.find((r) => r.id === 'g')).toEqual(expect.objectContaining({ outcome: 'granted' }));
  });
});

// The console role is read from the person's groups now at every admin vend (R6). These suites are about the vend,
// so the person signs in through no directory that keeps groups and the session's role stands; the recheck itself is
// `test/lib/a-removed-admin-is-vended-nothing-more.test.ts`.
beforeEach(() => {
  const { groupsFor } = jest.requireMock('../lambda/src/lib/membership-source').__accountStateForTests;
  groupsFor.mockResolvedValue(null);
});
