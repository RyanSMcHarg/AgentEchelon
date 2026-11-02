/**
 * A DECLARED ANSWER WITH NO EXCHANGE IS TWO FINDINGS, AND THE QUERY HAS TO SAY WHICH.
 *
 * `unpaired_bot_messages` splits the turns with no exchange by whether they carry a correlation
 * marker, because a reply is born as a corr-marked placeholder: unmarked reads as "could never have
 * paired", marked reads as a pairing defect. That rule is right about a welcome and about a drain's
 * reading, and wrong about a row that DECLARED its target - it named the message it answers, so it
 * was plainly an answer to something, and filing it under the sentence written for a welcome is how a
 * whole class went unexamined.
 *
 * MEASURED 2026-09-15 on the deployment, through the signed analytics API: 33 unpaired rows in one
 * day carried a declaration (32 `report_generation`, 1 `general`) and every one was counted as "could
 * never pair". They are the SECOND message of a turn whose delivery moved off its placeholder - a
 * privately targeted answer, a broadcast answer, or an answer posted at the end of a queue whose
 * notice sits above it. The placeholder left behind is corr-marked and adjacent, so it takes the
 * exchange; 31 of that day's 220 exchanges were minted against an acknowledgement reading
 * "Caught up..." or "I have replied to you privately.", and 30 of those carry no intent at all.
 *
 * SO THE DECIDING AXIS IS WHETHER THE TURN IT NAMED WAS ANSWERED, not whether this row was:
 *
 *   target_paired = true   the turn was answered through the message that acknowledged it. One turn
 *                          mints one exchange, so a second message has nothing left to pair with.
 *   target_paired = false  the turn named a message and nothing anywhere answers it - an answer the
 *                          projection lost, and the only half worth chasing.
 *   target_paired = NULL   nothing was declared, so the question does not apply.
 *
 * Read-only and additive: no existing column changes meaning, and a caller that does not read the new
 * one is unaffected.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDbQuery = jest.fn();

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: mockDbQuery,
  ensureSchema: jest.fn().mockResolvedValue(undefined),
  getClient: jest.fn(),
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

const RANGE = { start: '2026-09-14', end: '2026-09-15' };

/** Compare SQL by its tokens, so a reformat cannot fail this and cannot hide a removed clause. */
const flat = (s: string) => s.replace(/\s+/g, ' ');

async function unpairedSql(): Promise<string> {
  mockDbQuery.mockReset();
  mockDbQuery.mockResolvedValue({ rows: [] });
  await handler(postEvent({ queryType: 'unpaired_bot_messages', dateRange: RANGE }));
  const call = mockDbQuery.mock.calls.find(([sql]) => /FROM messages m/.test(sql as string));
  expect(call).toBeDefined();
  return call![0] as string;
}

describe('an unpaired answer says whether the turn it named was answered', () => {
  it('publishes target_paired beside declared_target', async () => {
    const sql = flat(await unpairedSql());
    expect(sql).toContain('AS declared_target');
    expect(sql).toContain('tp.target_paired');
    expect(sql).toContain('AS target_paired');
  });

  it('asks whether the DECLARED message has an exchange, from this same responder', async () => {
    const sql = flat(await unpairedSql());
    // The same responder, not any responder: a duel's two sides answer one message as two bot
    // identities, so "somebody answered it" would let a rival's reply stand in for this one's.
    expect(sql).toContain('JOIN exchanges tex ON tex.user_message_id = tgt.id');
    expect(sql).toContain('JOIN messages tam ON tam.id = tex.agent_message_id');
    expect(sql).toContain('AND tam.sender_arn = m.sender_arn');
    expect(sql).toContain('AND tgt.message_id = d.target');
    expect(sql).toContain("AND tgt.event_type = 'CREATE_CHANNEL_MESSAGE'");
  });

  it('answers NULL where nothing was declared, so the question is not put to a welcome', async () => {
    // A literal false there would read as "its turn went unanswered" on every row that never claimed
    // to answer anything, which is the opposite of what this column is for.
    expect(flat(await unpairedSql())).toContain('SELECT CASE WHEN d.target IS NULL THEN NULL ELSE EXISTS (');
  });

  it('asks it with EXISTS, so a turn with several replies is not counted several times', async () => {
    // One user message can hold several exchanges (a duel), and a plain join would emit this bot
    // message once per one of them - multiplying unpaired_count by however many replies the turn
    // attracted. Existence is the whole question, so EXISTS is the whole answer.
    const sql = flat(await unpairedSql());
    expect(sql).not.toMatch(/LEFT JOIN exchanges tex/);
    expect(sql).toContain('ELSE EXISTS (');
  });

  it('resolves the declaration ONCE, so the two columns cannot disagree about what a row declared', async () => {
    const sql = flat(await unpairedSql());
    // The COLUMN first, then the JSON (migration 042), exactly as turn_kind is read: the column is the
    // archival fold of whichever carrier the turn had, and the JSON is what older rows have.
    expect(sql).toContain(flat(`SELECT COALESCE(upd.answers_message_id, m.answers_message_id,
                       upd.metadata->>'answersMessageId', m.metadata->>'answersMessageId') AS target`));
    expect(sql).toContain('(d.target IS NOT NULL) AS declared_target');
  });

  it('groups by the new column, or every row collapses onto one of the two answers', async () => {
    // Without it Postgres refuses the statement outright, so this is really a guard against the column
    // being added to the SELECT and the grouping left behind in a later edit.
    expect(flat(await unpairedSql())).toContain('GROUP BY 1, 2, 3, 4, 5');
  });

  it('pairs on the same exchange latency_metrics takes, so a folded reading is unpaired in both', async () => {
    // 2026-10-16: on queue days the two unpaired counts differed (176 vs 204) because a drain's folding
    // reading holds only queued_as = 'folded' exchanges, which latency_metrics excludes and this joined.
    expect(flat(await unpairedSql())).toContain('LEFT JOIN exchanges e ON e.agent_message_id = m.id AND e.queued_as IS NULL');
  });
});
