/**
 * A FLAG CAN BE RAISED BY A PERSON, NOT ONLY BY THE JUDGE.
 *
 * The Flagged list had exactly one author. `getFlaggedResponses` derived it from `evaluation_results`
 * and the only human writer, `flagged_review`, records a verdict against an exchange the judge had
 * ALREADY raised - so a moderator reading a conversation and seeing a bad answer had nowhere to put
 * that judgement, and the only human signal in the system was the one an end user volunteered.
 *
 * These tests pin the three properties that make the new path trustworthy rather than merely present:
 * the reason is validated (an ungroupable value is refused, not stored), the actor comes from the
 * verified caller and never the body, and withdrawing a flag deletes it rather than inventing a
 * 'cleared' state that the list would then have to filter out.
 */
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
import { analyticsPathFor as pathFor } from '../helpers/analytics-path';
import { edgeContext } from '../helpers/edge-context';



const RANGE = { start: '2026-05-13', end: '2026-05-20' };

function postEvent(body: unknown, sub = 'moderator-sub'): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: pathFor(body),
    body: JSON.stringify(body),
    requestContext: { authorizer: edgeContext({ claims: { sub, 'cognito:groups': 'admins' } }) },
  } as unknown as APIGatewayProxyEvent;
}

const flagBody = (extra: Record<string, unknown> = {}) => ({
  queryType: 'flagged_responses',
  dateRange: RANGE,
  action: 'flag',
  channelArn: 'arn:aws:chime:::channel/c1',
  messageId: 'msg-1',
  reason: 'wrong_assistant',
  ...extra,
});

/** Every SQL statement the handler ran, whitespace-collapsed so formatting cannot hide a match. */
const statements = (): string[] =>
  mockDbQuery.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' '));

const wrote = (table: string): boolean => statements().some((s) => s.includes(table));

/** The flag write's check that an exchange claims the message as its answer. */
const isAnswerCheck = (sql: unknown): boolean =>
  /SELECT 1 FROM messages m\s+JOIN exchanges e ON e.agent_message_id = m.id/.test(String(sql));

beforeEach(() => {
  jest.clearAllMocks();
  // By default the flagged message is an answer; the test that needs otherwise says so.
  mockDbQuery.mockImplementation(async (sql: unknown) => (isAnswerCheck(sql) ? { rows: [{ '?column?': 1 }] } : { rows: [] }));
});

describe('a moderator raises a flag', () => {
  it('writes the flag with the reason and the VERIFIED caller as the actor', async () => {
    const res = await handler(postEvent(flagBody()));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ flagged: true, messageId: 'msg-1', reason: 'wrong_assistant' });

    const insert = mockDbQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO human_flag'));
    expect(insert).toBeDefined();
    expect(insert![1]).toEqual([
      'arn:aws:chime:::channel/c1', 'msg-1', 'wrong_assistant', null, 'moderator-sub',
    ]);
  });

  it('takes the actor from the caller even when the body names somebody else', async () => {
    // Attribution has to survive a dispute about who raised a flag, so a body field must not be able
    // to put a colleague's name on one.
    await handler(postEvent(flagBody({ callerSub: 'somebody-else', flaggedBySub: 'somebody-else' })));
    const insert = mockDbQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO human_flag'));
    expect(insert![1][4]).toBe('moderator-sub');
  });

  it('REFUSES an unrecognized reason and writes nothing', async () => {
    // The reason exists to group onto one of three axes. Storing an unknown value would split a
    // rollup silently - no error, just a number that is quietly wrong.
    const res = await handler(postEvent(flagBody({ reason: 'i_just_did_not_like_it' })));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).flagged).toBe(false);
    expect(wrote('human_flag')).toBe(false);
  });

  it('refuses a flag with no reason at all', async () => {
    // Unlike the end user's vote - which counts before any reason is offered - a moderator is acting
    // deliberately on one response, so there is no vote to preserve by accepting a blank.
    const res = await handler(postEvent(flagBody({ reason: undefined })));
    expect(JSON.parse(res.body).flagged).toBe(false);
    expect(wrote('human_flag')).toBe(false);
  });

  it('refuses a flag that names no message', async () => {
    const res = await handler(postEvent(flagBody({ messageId: undefined })));
    expect(JSON.parse(res.body).flagged).toBe(false);
    expect(wrote('human_flag')).toBe(false);
  });

  it('REFUSES a flag on a message no exchange claims, because the list could never show it', async () => {
    // The Flagged list reaches a moderator flag through its exchange. A welcome or a join notice has
    // none, so a flag on it was stored and never listed (e2e, 2026-10-23).
    mockDbQuery.mockImplementation(async () => ({ rows: [] }));
    const res = await handler(postEvent(flagBody()));
    expect(JSON.parse(res.body).flagged).toBe(false);
    expect(statements().some((s) => s.includes('INSERT INTO human_flag'))).toBe(false);
    const check = mockDbQuery.mock.calls.find((c) => isAnswerCheck(c[0]));
    expect(check![1]).toEqual(['msg-1', 'arn:aws:chime:::channel/c1']);
  });

  it('replaces rather than accumulating, so one response carries one current reason', async () => {
    await handler(postEvent(flagBody()));
    const insert = statements().find((s) => s.includes('INSERT INTO human_flag'))!;
    expect(insert).toContain('ON CONFLICT (channel_arn, message_id) DO UPDATE');
    expect(insert).toContain('reason = EXCLUDED.reason');
  });
});

describe('a moderator withdraws a flag', () => {
  it('DELETES it rather than storing a cleared state', async () => {
    // An unflagged response is the ABSENCE of a flag, the same way an unreviewed one is the absence
    // of a review. A 'cleared' row would be a third state every reader has to filter out.
    const res = await handler(postEvent({
      queryType: 'flagged_responses', dateRange: RANGE, action: 'unflag',
      channelArn: 'arn:aws:chime:::channel/c1', messageId: 'msg-1',
    }));
    expect(JSON.parse(res.body)).toMatchObject({ unflagged: true, messageId: 'msg-1' });
    const del = statements().find((s) => s.includes('DELETE FROM human_flag'));
    expect(del).toBeDefined();
    expect(statements().some((s) => s.includes("'cleared'"))).toBe(false);
  });

  it('refuses an unflag that names no message', async () => {
    const res = await handler(postEvent({
      queryType: 'flagged_responses', dateRange: RANGE, action: 'unflag',
      channelArn: 'arn:aws:chime:::channel/c1',
    }));
    expect(JSON.parse(res.body).unflagged).toBe(false);
    expect(wrote('human_flag')).toBe(false);
  });
});

describe('the flagged list reads all three origins', () => {
  it('names the origin of every row, so a judge score and a colleague are not the same claim', async () => {
    await handler(postEvent({ queryType: 'flagged_responses', dateRange: RANGE }));
    const read = statements().find((s) => s.includes('raised_agg'));
    expect(read).toBeDefined();
    // All three origins, and the source carried out to the caller.
    expect(read).toContain("'judge'");
    expect(read).toContain("'moderator'");
    expect(read).toContain("'person'");
    expect(read).toContain('flag_sources');
  });

  it('joins a human flag to its exchange at READ time, not at write time', async () => {
    // Archival is asynchronous. Resolving the exchange when the flag is raised would pin a NULL for
    // any response flagged before its exchange row landed, and that flag would never appear in the
    // list it was raised for.
    await handler(postEvent({ queryType: 'flagged_responses', dateRange: RANGE }));
    const read = statements().find((s) => s.includes('raised_agg'))!;
    expect(read).toContain('JOIN messages m ON m.message_id = hf.message_id');
    expect(read).toContain('JOIN exchanges e ON e.agent_message_id = m.id');
  });

  it('never compares a Chime MessageId directly to an exchange foreign key', async () => {
    // THIS ASSERTION USED TO DEMAND THE BROKEN JOIN, so it pinned the bug rather than the property.
    //
    // A human flag records the CHIME MessageId (varchar) - the only id a transcript can hand a
    // moderator - while `exchanges.agent_message_id` is a uuid foreign key to `messages.id`, this
    // database's own key. They are two different identifiers, not two spellings of one, so the
    // comparison is not a missing cast: Postgres raised `operator does not exist: uuid = character
    // varying` and the whole Flagged tab 502'd. Caught by the admin e2e, not by this file, because
    // every test here mocks the database and a mock has no types.
    await handler(postEvent({ queryType: 'flagged_responses', dateRange: RANGE }));
    const read = statements().find((s) => s.includes('raised_agg'))!;
    expect(read).not.toMatch(/agent_message_id\s*=\s*(hf|pf)\.message_id/);
  });

  it('matches only the CREATE row, so one flag raises one row', async () => {
    // Archival writes a `<MessageId>-UPD` sibling for the answer, and exchanges link to the CREATE
    // row. Without this the join could match both and the response would appear twice.
    await handler(postEvent({ queryType: 'flagged_responses', dateRange: RANGE }));
    const read = statements().find((s) => s.includes('raised_agg'))!;
    expect(read.match(/m\.event_type = 'CREATE_CHANNEL_MESSAGE'/g) ?? []).toHaveLength(2);
  });

  it('LEFT joins the evaluation, because a human can flag what the judge never scored', async () => {
    await handler(postEvent({ queryType: 'flagged_responses', dateRange: RANGE }));
    const read = statements().find((s) => s.includes('raised_agg'))!;
    expect(read).toContain('LEFT JOIN evaluation_results er');
  });

  it('orders human-raised rows first, so they are not buried under machine ones', async () => {
    // The old ordering was score-ascending with NULLS LAST. A human flag carries no score, so that
    // ordering would have put every one of them below every judge flag.
    await handler(postEvent({ queryType: 'flagged_responses', dateRange: RANGE }));
    const read = statements().find((s) => s.includes('raised_agg'))!;
    expect(read).toMatch(/ORDER BY \('moderator' = ANY\(ra\.flag_sources\) OR 'person' = ANY\(ra\.flag_sources\)\) DESC/);
  });

  it('shows one row per response however many origins raised it', async () => {
    await handler(postEvent({ queryType: 'flagged_responses', dateRange: RANGE }));
    const read = statements().find((s) => s.includes('raised_agg'))!;
    expect(read).toContain('GROUP BY exchange_id');
    expect(read).toContain('array_agg(DISTINCT flag_source)');
  });
});
