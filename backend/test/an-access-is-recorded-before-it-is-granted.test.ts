/**
 * AN ACCESS IS RECORDED BEFORE IT IS GRANTED, AND READING THE RECORD IS AN ACCESS (ADR-052, FR30).
 *
 * `lib/access-log.ts` turns the exchange's audit line into a durable record, and refuses (throws) when it
 * cannot write one. The reader admits only an admin console session, records its own read first, and
 * serves nothing when that record cannot be written. The stack keeps the table beside its writer, retains
 * it, expires records after 400 days, and lets the exchange add to it and nothing else.
 */
const mockDocSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDocSend })) },
  PutCommand: jest.fn((input: unknown) => ({ __type: 'Put', input })),
  QueryCommand: jest.fn((input: unknown) => ({ __type: 'Query', input })),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));

import * as fs from 'fs';
import * as path from 'path';
import {
  accessRecordOf, recordAccess, readAccessLog, AccessLogUnavailable, ACCESS_LOG_RETENTION_DAYS,
} from '../lambda/src/lib/access-log';
import { ADMIN_CAPABILITIES } from '../lib/config/admin-capabilities';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/i';
const CHANNEL = `${APP}/channel/conv-42`;
/** A person, as a console session names one: their AppInstanceUser id. */
const LEGAL = '0a1b2c3d-0000-4000-8000-00000000beef';
const puts = () => mockDocSend.mock.calls.map((c) => c[0]).filter((c) => c.__type === 'Put').map((c) => c.input);
const queries = () => mockDocSend.mock.calls.map((c) => c[0]).filter((c) => c.__type === 'Query').map((c) => c.input);

beforeEach(() => {
  mockDocSend.mockReset();
  mockDocSend.mockResolvedValue({});
  process.env.ACCESS_LOG_TABLE = 'access-log';
});

describe('the record an access becomes', () => {
  it('keys the day, names the person and the conversation, keeps the reason and the whole line, and expires in 400 days', () => {
    const at = '2026-10-12T10:00:00.000Z';
    const r = accessRecordOf({
      _auditEvent: 'admin_scoped_credential_vend', timestamp: at, adminPersonId: 'person-1', channelArn: CHANNEL,
      capabilities: ['view-messages'], reason: '  Matter 118  ',
    }, new Date(), 'id-1');
    expect(r).toMatchObject({
      pk: 'day#2026-10-12', sk: `${at}#id-1`, event: 'admin_scoped_credential_vend', actorPersonId: 'person-1',
      conversation: CHANNEL, capabilities: ['view-messages'], reason: 'Matter 118',
    });
    expect(JSON.parse(r.detail).reason).toBe('  Matter 118  ');
    expect(r.expiresAt).toBe(Date.parse(at) / 1000 + ACCESS_LOG_RETENTION_DAYS * 86_400);
    expect(ACCESS_LOG_RETENTION_DAYS).toBe(400);
  });

  it('leaves a console session out of the conversation index', () => {
    const r = accessRecordOf({ _auditEvent: 'admin_console_session_vend', personId: 'person-1', capabilities: [] });
    expect(r.conversation).toBeUndefined();
    expect(r.actorPersonId).toBe('person-1');
  });
});

describe('writing it', () => {
  it('writes once and never replaces', async () => {
    await recordAccess({ _auditEvent: 'admin_console_session_vend', personId: 'person-1' });
    expect(puts()[0]).toMatchObject({ TableName: 'access-log', ConditionExpression: 'attribute_not_exists(pk)' });
  });

  it('throws when the table refuses, has no name, or the access names no person', async () => {
    mockDocSend.mockRejectedValueOnce(new Error('throttled'));
    await expect(recordAccess({ _auditEvent: 'x', personId: 's' })).rejects.toBeInstanceOf(AccessLogUnavailable);
    delete process.env.ACCESS_LOG_TABLE;
    await expect(recordAccess({ _auditEvent: 'x', personId: 's' })).rejects.toBeInstanceOf(AccessLogUnavailable);
    process.env.ACCESS_LOG_TABLE = 'access-log';
    await expect(recordAccess({ _auditEvent: 'x' })).rejects.toBeInstanceOf(AccessLogUnavailable);
  });
});

describe('reading it', () => {
  it('reads a conversation through its index, newest first, from the window start', async () => {
    mockDocSend.mockResolvedValue({ Items: [{ id: 'a', conversation: CHANNEL, actorPersonId: 's' }] });
    const now = new Date('2026-10-12T00:00:00.000Z');
    const out = await readAccessLog({ days: 30, conversation: CHANNEL, limit: 10 }, { now });
    expect(out).toHaveLength(1);
    const [q] = queries();
    expect(q).toMatchObject({ IndexName: 'byConversation', ScanIndexForward: false });
    expect(q.ExpressionAttributeValues).toEqual({ ':c': CHANNEL, ':since': '2026-09-12T00:00:00.000Z' });
  });

  it('reads a person through theirs, and day by day with no filter, stopping at the limit', async () => {
    await readAccessLog({ days: 7, actor: 'person-1', limit: 10 });
    expect(queries()[0].IndexName).toBe('byActor');
    expect(queries()[0].KeyConditionExpression).toBe('actorPersonId = :a AND #at >= :since');
    mockDocSend.mockReset();
    mockDocSend.mockResolvedValue({ Items: [{ id: 'a' }, { id: 'b' }] });
    const out = await readAccessLog({ days: 30, limit: 3 }, { now: new Date('2026-10-12T00:00:00.000Z') });
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'a']);
    expect(queries().map((q) => q.ExpressionAttributeValues[':p'])).toEqual(['day#2026-10-12', 'day#2026-10-11']);
  });

  it('with no filter, reads the same rolling window the indexed reads do, not calendar days', async () => {
    mockDocSend.mockResolvedValue({ Items: [] });
    // One day back from 01:00 is 01:00 yesterday: both partitions, each bounded by the window start.
    await readAccessLog({ days: 1, limit: 100 }, { now: new Date('2026-10-12T01:00:00.000Z') });
    expect(queries().map((q) => q.ExpressionAttributeValues)).toEqual([
      { ':p': 'day#2026-10-12', ':since': '2026-10-11T01:00:00.000Z' },
      { ':p': 'day#2026-10-11', ':since': '2026-10-11T01:00:00.000Z' },
    ]);
    expect(queries()[0].KeyConditionExpression).toBe('pk = :p AND sk >= :since');
  });
});

describe('the reader', () => {
  const CONSOLE = (sub: string, kind = 'admin') => `arn:aws:sts::111122223333:assumed-role/agent-echelon-${kind}-console/console-${sub}`;
  const load = () => {
    jest.resetModules();
    process.env.APP_INSTANCE_ARN = APP;
    process.env.ALLOWED_ORIGIN = 'https://admin.example';
    process.env.ADMIN_IAM_ENFORCEMENT = 'true';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../lambda/src/access-log-reader').handler as (e: unknown) => Promise<{ statusCode: number; body: string }>;
  };
  const get = (userArn: string, query: Record<string, string> = {}) => ({
    httpMethod: 'GET', headers: { origin: 'https://admin.example' }, queryStringParameters: query,
    requestContext: { identity: { userArn } },
  });

  it('records the read before it serves, naming the reader and the filter', async () => {
    mockDocSend.mockImplementation(async (c: { __type: string }) => (c.__type === 'Query' ? { Items: [] } : {}));
    const handler = load();
    const res = await handler(get(CONSOLE(LEGAL), { channelId: 'conv-42', days: '90' }));
    expect(res.statusCode).toBe(200);
    const order = mockDocSend.mock.calls.map((c) => c[0].__type);
    expect(order[0]).toBe('Put');
    expect(puts()[0].Item).toMatchObject({ event: 'access_log_read', actorPersonId: LEGAL, conversation: CHANNEL });
    expect(JSON.parse(puts()[0].Item.detail).filter).toMatchObject({ days: 90 });
  });

  it('serves nothing when the read cannot be recorded', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockDocSend.mockRejectedValue(new Error('down'));
    const handler = load();
    const res = await handler(get(CONSOLE(LEGAL)));
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).records).toBeUndefined();
    expect(queries()).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('admits only an admin console session', async () => {
    const handler = load();
    for (const arn of [CONSOLE(`${LEGAL}@premium`, 'team'), 'arn:aws:sts::111122223333:assumed-role/some-role/x', '']) {
      const res = await handler(get(arn));
      expect({ arn, status: res.statusCode }).toEqual({ arn, status: 403 });
    }
    expect(mockDocSend).not.toHaveBeenCalled();
  });

  it('refuses a malformed filter', async () => {
    const handler = load();
    const bad: Array<Record<string, string>> = [{ days: '0' }, { days: '401' }, { days: '1.5' }, { limit: '501' }, { channelId: '../x' }, { actor: 'a b' }];
    for (const q of bad) {
      const res = await handler(get(CONSOLE(LEGAL), q));
      expect({ q, status: res.statusCode }).toEqual({ q, status: 400 });
    }
  });
});

describe('the stack and the capability', () => {
  it('view-access-log is admins only, on its own signed route', () => {
    expect(ADMIN_CAPABILITIES['view-access-log']).toMatchObject({
      roles: ['admins'], enforcement: 'signOnRole', wired: true,
      resources: [{ api: 'admin-exchange', method: 'GET', path: 'admin/access-log' }],
    });
  });

  it('the table is retained, expires on its TTL, and the exchange may only add to it (source)', () => {
    const stack = fs.readFileSync(path.join(__dirname, '..', 'lib', 'stacks', 'identity-stack.ts'), 'utf8');
    const table = stack.slice(stack.indexOf("new dynamodb.Table(this, 'AccessLogTable'"), stack.indexOf('const accessLogReaderFn'));
    expect(table).toContain("timeToLiveAttribute: 'expiresAt'");
    expect(table).toContain('removalPolicy: cdk.RemovalPolicy.RETAIN');
    expect(table).toContain("indexName: 'byConversation'");
    expect(table).toContain("indexName: 'byActor'");
    expect(table).toMatch(/indexName: 'byActor',\s*partitionKey: \{ name: 'actorPersonId'/);
    expect(table).toMatch(/credentialExchangeRole\.addToPolicy\(new iam\.PolicyStatement\(\{\s*actions: \['dynamodb:PutItem'\],\s*resources: \[accessLogTable\.tableArn\],/);
    // The read is the admin backend's (AdminServices), a route AdminApi serves under the admin-exchange surface.
    const admin = fs.readFileSync(path.join(__dirname, '..', 'lib', 'stacks', 'admin-services-stack.ts'), 'utf8');
    expect(admin).toContain("adminRoute('admin-exchange', 'GET', '/admin/access-log', accessLogReaderFn),");
  });
});
