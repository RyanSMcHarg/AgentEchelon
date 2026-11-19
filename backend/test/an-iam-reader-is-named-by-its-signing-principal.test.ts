/**
 * A READER THAT IS NOT A PERSON IS NAMED BY THE IAM PRINCIPAL THAT SIGNED ITS REQUEST (`access-log.ts`, owner decision
 * 2026-11-12).
 *
 * A content read by a signed principal no person id resolves from is recorded with `actorKind: 'iam'`, its principal's ARN,
 * and `iam#<arn>` as its `byActor` key, then served. The ARN is the one API Gateway set on the request context; a header
 * or body naming one is never read. A read that names neither a person nor a principal is refused with 403
 * `READER_UNIDENTIFIED`, and nothing is recorded or served.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
jest.mock('../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ownerQuery: jest.fn().mockResolvedValue({ rows: [] }),
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

process.env.ADMIN_IAM_ENFORCEMENT = 'true';
const ROLE = 'App-AdminRole-def';
process.env.CLASSIFICATION_ROLE_SCOPES = JSON.stringify([{ role: `arn:aws:iam::111122223333:role/${ROLE}`, scope: 'full' }]);

import {
  accessRecordOf, recordAccess, signingPrincipalArn, AccessReaderUnidentified, AccessLogUnavailable, IAM_ACTOR_PREFIX,
} from '../lambda/src/lib/access-log';
import { handler, __setContentReadRecorder } from '../lambda/src/analytics-aurora/analytics-query';
import { __clearScopeCache } from '../lambda/src/lib/caller-scope';
import { analyticsPathFor } from './helpers/analytics-path';

const PRINCIPAL = `arn:aws:sts::111122223333:assumed-role/${ROLE}/ops-automation`;
const FORGED = 'arn:aws:sts::111122223333:assumed-role/Someone-Else/forged';

const read = (identity: Record<string, unknown>, extra: { headers?: Record<string, string>; body?: Record<string, unknown> } = {}): APIGatewayProxyEvent => {
  const body = { queryType: 'flagged_responses', accessReason: 'a reported wrong answer', ...(extra.body ?? {}) };
  return {
    httpMethod: 'POST', path: analyticsPathFor(body), body: JSON.stringify(body), headers: extra.headers ?? {},
    requestContext: { identity },
  } as unknown as APIGatewayProxyEvent;
};

const recorded: Array<Record<string, unknown>> = [];
beforeAll(() => __clearScopeCache());
beforeEach(() => {
  recorded.length = 0;
  __setContentReadRecorder(async (line) => { recorded.push(line); });
  mockDbQuery.mockReset().mockResolvedValue({ rows: [] });
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('the access log record', () => {
  it('names a principal-only reader as an iam actor, keyed iam#<arn> in byActor', async () => {
    const put = jest.fn(async () => ({}));
    const record = await recordAccess({ _auditEvent: 'analytics_content_read', actorPrincipalArn: PRINCIPAL, reason: 'r' }, { doc: { send: put } as never, table: 't' });
    expect(record).toMatchObject({ actorPersonId: `${IAM_ACTOR_PREFIX}${PRINCIPAL}`, actorKind: 'iam', actorPrincipalArn: PRINCIPAL });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('names a person by their id, whatever principal the line also carries', () => {
    const record = accessRecordOf({ _auditEvent: 'x', personId: 'p1', actorPrincipalArn: PRINCIPAL });
    expect(record.actorPersonId).toBe('p1');
    expect(record.actorKind).toBeUndefined();
  });

  it('refuses an access that names neither a person nor a principal, and writes nothing', async () => {
    const put = jest.fn(async () => ({}));
    const refused = recordAccess({ _auditEvent: 'x', actorPrincipalArn: 'not-an-arn' }, { doc: { send: put } as never, table: 't' });
    await expect(refused).rejects.toBeInstanceOf(AccessReaderUnidentified);
    await expect(recordAccess({ _auditEvent: 'x' }, { doc: { send: put } as never, table: 't' })).rejects.toBeInstanceOf(AccessLogUnavailable);
    expect(put).not.toHaveBeenCalled();
  });
});

describe('the signing principal', () => {
  it('is the one API Gateway set on the request context, never one a header or the body names', () => {
    expect(signingPrincipalArn({ requestContext: { identity: { userArn: PRINCIPAL } } })).toBe(PRINCIPAL);
    const forged = { headers: { 'x-amzn-principal-arn': FORGED, 'x-ae-actor-principal-arn': FORGED }, body: JSON.stringify({ actorPrincipalArn: FORGED }), requestContext: { identity: { accountId: '111122223333' } } };
    expect(signingPrincipalArn(forged)).toBeNull();
  });
});

describe('a content read by a reader that is not a person', () => {
  it('is served, and recorded under the principal that signed it', async () => {
    const res = await handler(read({ userArn: PRINCIPAL }));
    expect(res.statusCode).toBe(200);
    expect(recorded).toEqual([expect.objectContaining({ _auditEvent: 'analytics_content_read', actorPrincipalArn: PRINCIPAL })]);
    expect(recorded[0].personId).toBeUndefined();
  });

  it('is refused READER_UNIDENTIFIED when the signature names no principal ARN, whatever a header or the body forges', async () => {
    const res = await handler(read({ accountId: '111122223333' }, {
      headers: { 'x-amzn-principal-arn': FORGED, 'x-ae-actor-principal-arn': FORGED },
      body: { actorPrincipalArn: FORGED, userArn: FORGED },
    }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe('READER_UNIDENTIFIED');
    expect(recorded).toEqual([]);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});
