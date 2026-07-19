/**
 * client-events Lambda — input validation, claim extraction, normalisation,
 * Firehose delivery shape. The Athena/Firehose mocks intentionally fail
 * loud rather than silently no-op so an accidental real call surfaces.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const firehoseSendMock = jest.fn();

jest.mock('@aws-sdk/client-firehose', () => ({
  FirehoseClient: jest.fn().mockImplementation(() => ({
    send: (...args: unknown[]) => firehoseSendMock(...args),
  })),
  PutRecordBatchCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

process.env.CLIENT_EVENTS_DELIVERY_STREAM = 'test-client-events';

import { handler, __testing } from '../lambda/src/client-events';

const { VALID_EVENT_TYPES, normalize, extractClaims, isIsoTimestamp } = __testing;

function authedEvent(body: unknown, claims: Record<string, string> = defaultClaims()): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/events',
    body: JSON.stringify(body),
    requestContext: { authorizer: { claims } } as unknown as APIGatewayProxyEvent['requestContext'],
  } as APIGatewayProxyEvent;
}

function defaultClaims(): Record<string, string> {
  return {
    sub: 'cognito-sub-123',
    email: 'user@example.com',
    'cognito:groups': 'premium,users',
  };
}

beforeEach(() => {
  firehoseSendMock.mockReset();
  firehoseSendMock.mockResolvedValue({ FailedPutCount: 0 });
});

describe('VALID_EVENT_TYPES — allow-list', () => {
  it('contains the auth funnel events', () => {
    [
      'signup_form_viewed',
      'signup_submitted',
      'signup_confirmation_required',
      'signup_confirmation_completed',
      'signup_failed',
      'signin_form_viewed',
      'signin_submitted',
      'signin_succeeded',
      'signin_failed',
    ].forEach((t) => expect(VALID_EVENT_TYPES.has(t)).toBe(true));
  });

  it('contains the session/connection events', () => {
    ['session_started', 'websocket_connected', 'websocket_disconnected', 'websocket_reconnected'].forEach((t) =>
      expect(VALID_EVENT_TYPES.has(t)).toBe(true),
    );
  });

  it('contains channel_messages_listed (engagement signal for messaging-DAU)', () => {
    expect(VALID_EVENT_TYPES.has('channel_messages_listed')).toBe(true);
  });

  it('rejects an event name not in the list', () => {
    expect(VALID_EVENT_TYPES.has('arbitrary_event')).toBe(false);
  });
});

describe('extractClaims', () => {
  it('returns userId/email/clearance from the most privileged group', () => {
    const claims = extractClaims(authedEvent({}, { sub: 'u1', email: 'a@b', 'cognito:groups': 'basic,premium' }));
    expect(claims).toEqual({ userId: 'u1', email: 'a@b', clearance: 'premium' });
  });

  it('handles array-shaped cognito:groups', () => {
    const evt = authedEvent({}, { sub: 'u2', email: 'a@b' });
    // Authorizer can rehydrate cognito:groups as an array; verify path.
    (evt.requestContext!.authorizer as { claims: Record<string, unknown> }).claims['cognito:groups'] = ['standard'];
    const claims = extractClaims(evt);
    expect(claims?.clearance).toBe('standard');
  });

  it('defaults clearance to unknown when no group matches', () => {
    const claims = extractClaims(authedEvent({}, { sub: 'u', email: 'a@b', 'cognito:groups': 'misc' }));
    expect(claims?.clearance).toBe('unknown');
  });

  it('returns null when no claims present', () => {
    const evt = { httpMethod: 'POST', body: '{}' } as unknown as APIGatewayProxyEvent;
    expect(extractClaims(evt)).toBeNull();
  });
});

describe('normalize', () => {
  const claims = { userId: 'sub-1', email: 'u@e', clearance: 'premium' };

  it('accepts allow-listed events and stamps identity', () => {
    const out = normalize(
      {
        events: [
          { name: 'message_sent', properties: { conversationId: 'c1' }, timestamp: '2026-05-21T10:00:00Z', sessionId: 's' },
          { name: 'signin_succeeded', properties: {}, timestamp: '2026-05-21T10:00:01Z', sessionId: 's' },
        ],
      },
      claims,
    );
    expect(out.records).toHaveLength(2);
    expect(out.rejected).toBe(0);
    expect(out.records[0].partitionKey).toBe('message_sent');
    expect(out.records[0].payload).toMatchObject({
      record_type: 'event',
      event_type: 'message_sent',
      user_id: 'sub-1',
      user_email: 'u@e',
      user_tier: 'premium',
    });
  });

  it('rejects events not on the allow-list and counts them in rejected', () => {
    const out = normalize(
      { events: [{ name: 'bogus_event', timestamp: '2026-05-21T10:00:00Z' }] },
      claims,
    );
    expect(out.records).toHaveLength(0);
    expect(out.rejected).toBe(1);
  });

  it('accepts performance records under the "performance" partition', () => {
    const out = normalize(
      { performance: [{ metric: 'web_vital_lcp', value: 1234, timestamp: '2026-05-21T10:00:00Z' }] },
      claims,
    );
    expect(out.records).toHaveLength(1);
    expect(out.records[0].partitionKey).toBe('performance');
    expect(out.records[0].payload.record_type).toBe('performance');
    expect(out.records[0].payload.perf_value).toBe(1234);
    expect(out.records[0].payload.event_type).toBe('web_vital_lcp');
  });

  it('rejects performance entries with non-finite value', () => {
    const out = normalize(
      {
        performance: [
          { metric: 'web_vital_lcp', value: NaN, timestamp: '2026-05-21T10:00:00Z' },
          { metric: 'web_vital_lcp', value: 'oops' as unknown as number, timestamp: '2026-05-21T10:00:00Z' },
        ],
      },
      claims,
    );
    expect(out.records).toHaveLength(0);
    expect(out.rejected).toBe(2);
  });

  it('caps oversized batches at 200 events / 200 perf entries', () => {
    const events = Array.from({ length: 250 }, () => ({ name: 'message_sent' }));
    const perf = Array.from({ length: 250 }, () => ({ metric: 'web_vital_lcp', value: 1 }));
    const out = normalize({ events, performance: perf }, claims);
    expect(out.records.filter((r) => r.payload.record_type === 'event')).toHaveLength(200);
    expect(out.records.filter((r) => r.payload.record_type === 'performance')).toHaveLength(200);
  });

  it('substitutes timestamp when missing / malformed', () => {
    const out = normalize(
      { events: [{ name: 'message_sent', timestamp: 42 as unknown as string }] },
      claims,
    );
    expect(out.records).toHaveLength(1);
    expect(typeof out.records[0].payload.timestamp).toBe('string');
    expect(out.records[0].payload.timestamp).toMatch(/T/);
  });
});

describe('isIsoTimestamp', () => {
  it.each(['2026-05-21T10:00:00Z', '2026-05-21T10:00:00.000Z', '2026-05-21'])('accepts %s', (s) => {
    expect(isIsoTimestamp(s)).toBe(true);
  });

  it.each(['not-a-date', '', 42, null, undefined])('rejects %p', (v) => {
    expect(isIsoTimestamp(v as unknown)).toBe(false);
  });
});

describe('handler', () => {
  it('returns 401 when no authorizer claims', async () => {
    const evt = { httpMethod: 'POST', path: '/events', body: '{}' } as unknown as APIGatewayProxyEvent;
    const res = await handler(evt);
    expect(res.statusCode).toBe(401);
  });

  it('returns 405 for non-POST', async () => {
    const evt = {
      httpMethod: 'PUT',
      path: '/events',
      body: '{}',
      requestContext: { authorizer: { claims: defaultClaims() } },
    } as unknown as APIGatewayProxyEvent;
    const res = await handler(evt);
    expect(res.statusCode).toBe(405);
  });

  it('returns 200 + counts when given a mixed batch', async () => {
    const res = await handler(
      authedEvent({
        events: [
          { name: 'message_sent', timestamp: '2026-05-21T10:00:00Z' },
          { name: 'bogus', timestamp: '2026-05-21T10:00:00Z' },
        ],
        performance: [{ metric: 'web_vital_lcp', value: 1200, timestamp: '2026-05-21T10:00:00Z' }],
      }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ recorded: 1, performance: 1, delivered: 2, dropped: 0, skipped: 1 });
    expect(firehoseSendMock).toHaveBeenCalledTimes(1);
  });

  it('returns 400 on invalid JSON body', async () => {
    const evt = {
      httpMethod: 'POST',
      path: '/events',
      body: '{not-json',
      requestContext: { authorizer: { claims: defaultClaims() } },
    } as unknown as APIGatewayProxyEvent;
    const res = await handler(evt);
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 + delivered=0 when the batch is empty (no Firehose call)', async () => {
    const res = await handler(authedEvent({ events: [], performance: [] }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).delivered).toBe(0);
    expect(firehoseSendMock).not.toHaveBeenCalled();
  });

  it('returns 500 (generic) when Firehose throws (no detail leak)', async () => {
    firehoseSendMock.mockRejectedValueOnce(new Error('internal-secret: stream broken'));
    const res = await handler(
      authedEvent({ events: [{ name: 'message_sent', timestamp: '2026-05-21T10:00:00Z' }] }),
    );
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).not.toContain('internal-secret');
  });
});
