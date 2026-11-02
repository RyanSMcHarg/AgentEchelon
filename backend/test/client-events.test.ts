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
import { asPerson, edgeContext } from './helpers/edge-context';

const { VALID_EVENT_TYPES, normalize, callerFacts: extractClaims, isIsoTimestamp } = __testing;

function authedEvent(body: unknown, claims: Record<string, string> = defaultClaims()): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/events',
    body: JSON.stringify(body),
    requestContext: { authorizer: edgeContext({ claims }) } as unknown as APIGatewayProxyEvent['requestContext'],
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

describe('the caller of a client event', () => {
  it('returns the declared token for the set of groups held, not the first of a fixed order', async () => {
    // basic grants [basic]; premium grants [basic, standard, premium]. The union IS premium's grant
    // set, so `premium` is the declared token for holding both - a SET comparison. This file carried
    // its own `['admins', 'premium', 'standard', 'basic']` and took the first match, which gave the
    // same answer here and no answer at all for a deployment declaring its own classifications.
    const claims = await extractClaims(authedEvent({}, { sub: 'u1', email: 'a@b', 'cognito:groups': 'basic,premium' }));
    expect(claims).toEqual({ personId: 'u1', clearance: 'premium' });
  });

  it('handles array-shaped cognito:groups', async () => {
    const evt = authedEvent({}, { sub: 'u2', email: 'a@b' });
    // Authorizer can rehydrate cognito:groups as an array; verify path.
    (evt.requestContext!.authorizer as { tokenClaims: Record<string, unknown> }).tokenClaims['cognito:groups'] = ['standard'];
    const claims = await extractClaims(evt);
    expect(claims?.clearance).toBe('standard');
  });

  it('handles the BRACKETED multi-group claim API Gateway actually sends', async () => {
    // THE BUG THE SHARED PARSER FIXES HERE. This Lambda split on commas only, so a person holding two
    // groups arrived as the single token `"[admins premium]"`, matched nothing, and every analytics row
    // they generated was stamped `unknown` - silently, and only for multi-group users.
    const claims = await extractClaims(authedEvent({}, { sub: 'u3', email: 'a@b', 'cognito:groups': '[admins premium]' }));
    // The member token: the admin plane grants itself alone and rides beside it (`ProfileRegistry.holderOf`).
    expect(claims?.clearance).toBe('premium');
  });

  it('records unknown when no declared classification covers the groups held', async () => {
    // `unknown` is a persisted analytics dimension, written because the resolver answered nothing. It
    // is not a classification and nothing reads it as one.
    const claims = await extractClaims(authedEvent({}, { sub: 'u', email: 'a@b', 'cognito:groups': 'misc' }));
    expect(claims?.clearance).toBe('unknown');
  });

  it('stamps the PERSON the token resolves to, never the token sub', async () => {
    const PERSON = '0190f5c2-7b3a-7c11-9d2e-5a6b7c8d9e0f';
    const claims = await extractClaims(asPerson(authedEvent({}, { sub: 'token-sub', email: 'a@b', 'cognito:groups': 'standard' }), PERSON));
    expect(claims?.personId).toBe(PERSON);
  });

  it('returns null when no claims present', async () => {
    const evt = { httpMethod: 'POST', body: '{}' } as unknown as APIGatewayProxyEvent;
    expect(await extractClaims(evt)).toBeNull();
  });
});

describe('normalize', () => {
  const claims = { personId: 'sub-1', clearance: 'premium' };

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
      person_id: 'sub-1',
      user_tier: 'premium',
    });
    // The person is their id; no address travels with the event.
    expect(JSON.stringify(out.records[0].payload)).not.toMatch(/email/);
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

  /**
   * A TIMING IS CLIENT INPUT, AND ITS NAME AND PROPERTIES ARE BOUNDED.
   *
   * The metric name becomes the row's event_type and the page-load panel's GROUP BY key, and
   * `client_ttff_ms` is joined to the server's TTFF by `correlationId`. Free-form, any signed-in client
   * could mint rows under any name or post TTFF rows paired to a turn of its choosing.
   */
  describe('performance metric allow-list and property shape', () => {
    it('declares every metric the emitter sends', () => {
      [
        'web_vital_lcp', 'web_vital_inp', 'web_vital_cls', 'web_vital_fcp', 'web_vital_ttfb',
        'message_round_trip_ms', 'client_ttff_ms',
      ].forEach((m) => expect(__testing.VALID_PERF_METRICS.has(m)).toBe(true));
    });

    it('rejects an undeclared metric name and names the reason', () => {
      const out = normalize(
        { performance: [{ metric: 'made_up_metric', value: 5 }, { metric: '', value: 5 }, { value: 5 }] },
        claims,
      );
      expect(out.records).toHaveLength(0);
      expect(out.rejected).toBe(3);
      expect(out.reasons).toEqual({ unknown_perf_metric: 3 });
    });

    it('rejects a value outside the accepted range', () => {
      const out = normalize(
        { performance: [{ metric: 'client_ttff_ms', value: -1 }, { metric: 'client_ttff_ms', value: 1e12 }] },
        claims,
      );
      expect(out.records).toHaveLength(0);
      expect(out.reasons).toEqual({ perf_value_out_of_range: 2 });
    });

    it('keeps a declared, well-formed property', () => {
      const out = normalize(
        { performance: [{ metric: 'client_ttff_ms', value: 900, properties: { correlationId: 'turn-abc.1_2' } }] },
        claims,
      );
      expect(out.records).toHaveLength(1);
      expect(out.records[0].payload.properties).toEqual({ correlationId: 'turn-abc.1_2' });
      expect(out.reasons).toEqual({});
    });

    it('drops undeclared keys and malformed values but keeps the timing', () => {
      const out = normalize(
        {
          performance: [{
            metric: 'client_ttff_ms',
            value: 900,
            properties: {
              correlationId: 'turn-ok',
              channelArn: 'arn:aws:chime:x',
              extra: 7,
            },
          }, {
            metric: 'client_ttff_ms',
            value: 800,
            // Wider than the placeholder marker grammar allows, and not a string at all.
            properties: { correlationId: 'x'.repeat(65) },
          }, {
            metric: 'client_ttff_ms',
            value: 700,
            properties: { correlationId: 12345 },
          }],
        },
        claims,
      );
      expect(out.records).toHaveLength(3);
      expect(out.rejected).toBe(0);
      expect(out.records[0].payload.properties).toEqual({ correlationId: 'turn-ok' });
      // Nothing survived: null, not an empty object that reads as "correlated".
      expect(out.records[1].payload.properties).toBeNull();
      expect(out.records[2].payload.properties).toBeNull();
      expect(out.reasons).toEqual({ perf_property_dropped: 4 });
    });

    it('a metric that declares no properties carries none', () => {
      const out = normalize(
        { performance: [{ metric: 'web_vital_lcp', value: 1, properties: { correlationId: 'turn-ok' } }] },
        claims,
      );
      expect(out.records[0].payload.properties).toBeNull();
      expect(out.reasons).toEqual({ perf_property_dropped: 1 });
    });

    it('drops a properties value that is not an object', () => {
      const out = normalize(
        { performance: [{ metric: 'client_ttff_ms', value: 1, properties: ['correlationId'] }] },
        claims,
      );
      expect(out.records[0].payload.properties).toBeNull();
      expect(out.reasons).toEqual({ perf_property_dropped: 1 });
    });

    it('does not accept a key from the prototype chain as declared', () => {
      const out = normalize(
        { performance: [{ metric: 'client_ttff_ms', value: 1, properties: { toString: 'abc' } }] },
        claims,
      );
      expect(out.records[0].payload.properties).toBeNull();
    });

    it('counts a rejected event by reason too', () => {
      const out = normalize({ events: [{ name: 'bogus_event' }] }, claims);
      expect(out.reasons).toEqual({ unknown_event_type: 1 });
    });
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
      requestContext: { authorizer: edgeContext({ claims: defaultClaims() }) },
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

  it('logs what it refused by reason, without echoing the refused input', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = await handler(authedEvent({
        performance: [{ metric: 'secret_metric_name', value: 1 }],
      }));
      expect(JSON.parse(res.body)).toMatchObject({ performance: 0, skipped: 1 });
      const call = warn.mock.calls.find((c) => String(c[0]).includes('[ClientEvents]'));
      expect(call?.[1]).toMatchObject({ reasons: { unknown_perf_metric: 1 } });
      expect(JSON.stringify(call)).not.toContain('secret_metric_name');
    } finally {
      warn.mockRestore();
    }
  });

  it('returns 400 on invalid JSON body', async () => {
    const evt = {
      httpMethod: 'POST',
      path: '/events',
      body: '{not-json',
      requestContext: { authorizer: edgeContext({ claims: defaultClaims() }) },
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
