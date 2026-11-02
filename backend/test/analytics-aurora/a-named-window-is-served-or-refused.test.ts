/**
 * A NAMED WINDOW IS SERVED, OR IT IS REFUSED. IT IS NEVER QUIETLY REPLACED.
 *
 * Two ways a named window can be answered with a different one, both pinned here:
 *
 * 1. A range the translation rejects falls through to each query fn's 7-day default, so a pull asking
 *    for 24h, 7d, 30d and 90d gets four byte-identical results.
 * 2. A range reduced to a DAY COUNT, filtered `>= NOW() - N days`, ignores its own end. "August" comes
 *    back as the last 31 days, while Athena mode serves August from the same request.
 *
 * So the query is handed BOTH bounds, as one `tstzrange`, and every window predicate reads both. The
 * bounds are calendar days with both ends included, which is what Athena's `BETWEEN start AND end` over
 * its UTC date partitions means.
 *
 * `conversation_volumes` stands in for the translation, which every query fn shares through
 * `queryWindow`. The predicate half is checked over the whole file, because a predicate that still
 * reads only a lower bound is a defect in one query and invisible from any other.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
}));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send: jest.fn().mockRejectedValue(new Error('no model in tests')) })),
  InvokeModelCommand: jest.fn((input: unknown) => input),
}));

import { handler } from '../../lambda/src/analytics-aurora/analytics-query';
import { edgeContext } from '../helpers/edge-context';

function postEvent(body: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/query',
    body: JSON.stringify(body),
    requestContext: {
      authorizer: edgeContext({ claims: { sub: 'test-admin-sub', 'cognito:groups': 'admins' } }),
    },
  } as unknown as APIGatewayProxyEvent;
}

/** The `tstzrange` literal the query was actually run with. */
function rangeUsed(): string {
  expect(mockDbQuery).toHaveBeenCalled();
  return (mockDbQuery.mock.calls[0][1] as unknown[])[0] as string;
}

/** The two bounds of a `[lo,hi)` literal, as epoch ms (`hi` is Infinity for `infinity`). */
function bounds(range: string): { lo: number; hi: number } {
  const m = /^\[([^,]+),([^)]+)\)$/.exec(range);
  expect(m).not.toBeNull();
  return { lo: Date.parse(m![1]), hi: m![2] === 'infinity' ? Infinity : Date.parse(m![2]) };
}

/**
 * Evaluates a window predicate the way Postgres does against the bound range - `col >= lower(r) AND
 * col < upper(r)` - which is enough to prove which rows a window admits without a database.
 */
function admits(range: string, at: string): boolean {
  const { lo, hi } = bounds(range);
  const t = Date.parse(at);
  return t >= lo && t < hi;
}

const DAY = 86_400_000;

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [] });
});

describe('a window the caller named is the window the query runs', () => {
  it('runs from the start of the first day to the end of the last, both included', async () => {
    const res = await handler(postEvent({
      queryType: 'conversation_volumes',
      dateRange: { start: '2026-09-04', end: '2026-09-05' },
    }));

    expect(res.statusCode).toBe(200);
    expect(rangeUsed()).toBe('[2026-09-04T00:00:00.000Z,2026-09-06T00:00:00.000Z)');
  });

  it('a past window excludes the rows after its end - the case that served trailing data', async () => {
    await handler(postEvent({
      queryType: 'conversation_volumes',
      dateRange: { start: '2026-08-01', end: '2026-08-31' },
    }));
    const range = rangeUsed();

    expect(admits(range, '2026-08-01T00:00:00Z')).toBe(true);
    expect(admits(range, '2026-08-31T23:59:59Z')).toBe(true);
    // After the end: the rows a trailing window returns instead.
    expect(admits(range, '2026-09-01T00:00:00Z')).toBe(false);
    expect(admits(range, new Date().toISOString())).toBe(false);
    // Before the start.
    expect(admits(range, '2026-07-31T23:59:59Z')).toBe(false);
  });

  it('a single day is a whole day, as it is in Athena mode', async () => {
    const res = await handler(postEvent({
      queryType: 'conversation_volumes',
      dateRange: { start: '2026-09-05', end: '2026-09-05' },
    }));

    expect(res.statusCode).toBe(200);
    const { lo, hi } = bounds(rangeUsed());
    expect(hi - lo).toBe(DAY);
  });

  it('a bound with a time of day is read as the UTC day it falls on', async () => {
    await handler(postEvent({
      queryType: 'conversation_volumes',
      dateRange: { start: '2026-09-02T15:30:00.000Z', end: '2026-09-05T09:12:00.000Z' },
    }));

    expect(rangeUsed()).toBe('[2026-09-02T00:00:00.000Z,2026-09-06T00:00:00.000Z)');
  });

  it('naming no window at all accepts the trailing default, open above', async () => {
    const before = Date.now();
    const res = await handler(postEvent({ queryType: 'conversation_volumes' }));

    expect(res.statusCode).toBe(200);
    const { lo, hi } = bounds(rangeUsed());
    expect(hi).toBe(Infinity);
    expect(lo).toBeGreaterThanOrEqual(before - 7 * DAY - 1000);
    expect(lo).toBeLessThanOrEqual(Date.now() - 7 * DAY + 1000);
  });

  it('a window wider than the query allows keeps its end and loses its oldest days', async () => {
    // conversation_volumes caps its span at 180 days.
    await handler(postEvent({
      queryType: 'conversation_volumes',
      dateRange: { start: '2025-01-01', end: '2026-08-31' },
    }));

    const { lo, hi } = bounds(rangeUsed());
    expect(hi).toBe(Date.parse('2026-09-01T00:00:00Z'));
    expect(hi - lo).toBe(180 * DAY);
  });
});

describe('a window that cannot be served is refused, not reinterpreted', () => {
  it('a backwards range is refused', async () => {
    const res = await handler(postEvent({
      queryType: 'conversation_volumes',
      dateRange: { start: '2026-09-05', end: '2026-08-06' },
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/on or before dateRange.end/);
    // The point of the refusal: no query ran, so no number was produced to be misread.
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('a range missing a bound is refused, and says omitting dateRange is how to take the default', async () => {
    const res = await handler(postEvent({
      queryType: 'conversation_volumes',
      dateRange: { start: '2026-09-04' },
    }));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/omit dateRange/);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('an unparseable bound is refused rather than becoming an unbounded window', async () => {
    const res = await handler(postEvent({
      queryType: 'conversation_volumes',
      dateRange: { start: 'last tuesday', end: '2026-09-05' },
    }));

    expect(res.statusCode).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe('the windows an operator compares are distinguishable', () => {
  it('24h, 7d, 30d and 90d each run their own window', async () => {
    const ranges: Array<[string, string]> = [
      ['2026-09-04', '2026-09-05'],
      ['2026-08-29', '2026-09-05'],
      ['2026-08-06', '2026-09-05'],
      ['2026-06-07', '2026-09-05'],
    ];

    const used: string[] = [];
    for (const [start, end] of ranges) {
      jest.clearAllMocks();
      mockDbQuery.mockResolvedValue({ rows: [] });
      await handler(postEvent({ queryType: 'conversation_volumes', dateRange: { start, end } }));
      used.push(rangeUsed());
    }

    expect(used.map((r) => new Date(bounds(r).lo).toISOString().slice(0, 10))).toEqual(ranges.map(([s]) => s));
    // Four requests, four distinct windows.
    expect(new Set(used).size).toBe(4);
  });
});

describe('every window predicate reads both bounds', () => {
  const src = readFileSync(join(__dirname, '../../lambda/src/analytics-aurora/analytics-query.ts'), 'utf8');

  it('no predicate filters on a trailing interval from now', () => {
    expect(src).not.toMatch(/NOW\(\)\s*-\s*INTERVAL\s*\\?'1 day\\?'\s*\*\s*\$\d/);
  });

  it('every lower bound is paired with the upper bound of the same range, on the same column', () => {
    const lowers = [...src.matchAll(/([\w.]+) >= lower\(\$(\d+)::tstzrange\)(.{0,120})/g)];
    expect(lowers.length).toBeGreaterThanOrEqual(41);
    const unpaired = lowers
      .filter(([, col, n, rest]) => !rest.startsWith(` AND ${col} < upper($${n}::tstzrange)`))
      .map(([m]) => m);
    expect(unpaired).toEqual([]);
  });
});
