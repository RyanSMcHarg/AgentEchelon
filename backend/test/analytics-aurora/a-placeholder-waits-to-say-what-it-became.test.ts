/**
 * A PLACEHOLDER THAT NAMED ITS TARGET WAITS TO SAY WHAT IT BECAME.
 *
 * A flow turn's placeholder declares `answers=<message>` in its CREATE content, so the in-batch pairer
 * paired it the moment it was archived. The CREATE is posted before the turn knows whether the answer
 * stays in it: when the answer moves to a message of its own, the placeholder's update declares it a
 * `receipt` or a `queue_ack`, and the moved answer is the message that pairs. Paired from the CREATE
 * alone, the placeholder took the exchange and the answer counted as a turn with no exchange and no kind.
 *
 * Run through the archival handler with the database mocked, so the pairing walk is the real one.
 */
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: jest.fn(),
  transaction: jest.fn(async (fn: () => Promise<unknown>) => fn()),
  batchInsert: jest.fn(async () => 1),
  ensureSchema: jest.fn(),
  resetConnection: jest.fn(),
  isAuthError: jest.fn(() => false),
}));
jest.mock('../../lambda/src/analytics-aurora/drift-detection', () => ({
  detectDrift: jest.fn(),
  recordDriftFire: jest.fn(),
}));
jest.mock('../../lambda/src/analytics-aurora/cross-conversation-context', () => ({
  updateConversationContext: jest.fn(),
}));
jest.mock('../../lambda/src/analytics-aurora/turn-events-live', () => ({
  ...jest.requireActual('../../lambda/src/analytics-aurora/turn-events-live'),
  writeTurnEvents: jest.fn(),
}));
jest.mock('../../lambda/src/lib/message-analytics', () => ({
  readMessageAnalytics: jest.fn(async () => null),
}));
jest.mock('../../lambda/src/lib/sleep-mode', () => ({
  touchActivity: jest.fn(),
}));
jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  recordMemberCount: jest.fn(),
  getChannelContext: jest.fn(async () => null),
  putChannelContext: jest.fn(),
}));

import { query } from '../../lambda/src/analytics-aurora/db-client';
import { handler } from '../../lambda/src/analytics-aurora/kinesis-archival';

const mockedQuery = query as jest.MockedFunction<typeof query>;

const APP = 'arn:aws:chime:us-east-1:1:app-instance/a';
const CHANNEL = `${APP}/channel/c-moved`;
const PERSON = `${APP}/user/u-1`;
const BOT = `${APP}/bot/advisor`;
const USER_MSG = 'u'.repeat(64);

function chimeEvent(eventType: string, payload: Record<string, unknown>): { kinesis: { data: string } } {
  return {
    kinesis: {
      data: Buffer.from(JSON.stringify({
        EventType: eventType,
        Payload: { ChannelArn: CHANNEL, Persistence: 'PERSISTENT', Type: 'STANDARD', ...payload },
      })).toString('base64'),
    },
  };
}

const userMessage = chimeEvent('CREATE_CHANNEL_MESSAGE', {
  MessageId: USER_MSG, Content: 'Add a design review to the plan.',
  Sender: { Arn: PERSON, Name: 'Test' }, CreatedTimestamp: '2026-10-21T06:33:05.274Z',
});
const placeholder = chimeEvent('CREATE_CHANNEL_MESSAGE', {
  MessageId: 'ph-1',
  Content: encodeURIComponent(`Working on that... <!--corr:mention-${USER_MSG}--><!--turn:answers=${USER_MSG};entry=flow-->`),
  Sender: { Arn: BOT, Name: 'Advisor' }, CreatedTimestamp: '2026-10-21T06:33:07.225Z',
  Metadata: JSON.stringify({ botResponse: true }),
});
const answerCreate = chimeEvent('CREATE_CHANNEL_MESSAGE', {
  MessageId: 'ans-1', Content: '...', Sender: { Arn: BOT, Name: 'Advisor' },
  CreatedTimestamp: '2026-10-21T06:33:15.435Z', Target: [{ MemberArn: PERSON }],
  Metadata: JSON.stringify({ botResponse: true, targetedSender: PERSON }),
});
const answerUpdate = chimeEvent('UPDATE_CHANNEL_MESSAGE', {
  MessageId: 'ans-1', Content: 'Done - the design review is on the plan.', Sender: { Arn: BOT, Name: 'Advisor' },
  CreatedTimestamp: '2026-10-21T06:33:15.435Z', LastUpdatedTimestamp: '2026-10-21T06:33:16.036Z',
  Metadata: JSON.stringify({ intent: 'general', answersMessageId: USER_MSG, respPhase: 'final' }),
});
const receiptUpdate = chimeEvent('UPDATE_CHANNEL_MESSAGE', {
  MessageId: 'ph-1', Content: 'I have replied to you privately.', Sender: { Arn: BOT, Name: 'Advisor' },
  CreatedTimestamp: '2026-10-21T06:33:07.225Z', LastUpdatedTimestamp: '2026-10-21T06:33:16.238Z',
  Metadata: JSON.stringify({ answersMessageId: USER_MSG, intent: 'general', turnKind: 'receipt', respPhase: 'final' }),
});

/** The (user, agent) pairs the in-batch pairer inserted, read off its own parameters. */
function inBatchPairs(): Array<[string, string]> {
  return mockedQuery.mock.calls
    .filter(([sql]) => String(sql).includes('INSERT INTO exchanges') && String(sql).includes('um.message_id = $4'))
    .map(([, params]) => [String((params as unknown[])[3]), String((params as unknown[])[4])]);
}

describe('the in-batch pairer and a placeholder that named its target', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never);
  });

  it('does not pair the placeholder before its update says what it became', async () => {
    await handler({ Records: [userMessage, placeholder] } as never, { awsRequestId: 'r-1' } as never);
    expect(inBatchPairs()).toEqual([]);
  });

  it('pairs the moved answer, not the receipt, once the updates are in hand', async () => {
    await handler({ Records: [userMessage, placeholder, answerCreate, answerUpdate, receiptUpdate] } as never, { awsRequestId: 'r-1' } as never);
    expect(inBatchPairs()).toEqual([[USER_MSG, 'ans-1']]);
  });

  it('pairs the placeholder itself when its update is the answer', async () => {
    const answeredInPlace = chimeEvent('UPDATE_CHANNEL_MESSAGE', {
      MessageId: 'ph-1', Content: 'Done.', Sender: { Arn: BOT, Name: 'Advisor' },
      CreatedTimestamp: '2026-10-21T06:33:07.225Z', LastUpdatedTimestamp: '2026-10-21T06:33:12.000Z',
      Metadata: JSON.stringify({ intent: 'general', answersMessageId: USER_MSG, respPhase: 'final' }),
    });
    await handler({ Records: [userMessage, placeholder, answeredInPlace] } as never, { awsRequestId: 'r-1' } as never);
    expect(inBatchPairs()).toEqual([[USER_MSG, 'ph-1']]);
  });
});

describe('an Amazon Lex placeholder, which names no target, waits the same way', () => {
  // Posted from the Lex fulfillment: a correlation marker and no content declaration.
  const lexPlaceholder = chimeEvent('CREATE_CHANNEL_MESSAGE', {
    MessageId: 'ph-1', Content: encodeURIComponent('One moment... <!--corr:883933798a03523c-->'),
    Sender: { Arn: BOT, Name: 'Advisor' }, CreatedTimestamp: '2026-10-21T06:33:07.225Z',
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never);
  });

  it('does not pair the placeholder by adjacency before its update says what it became', async () => {
    await handler({ Records: [userMessage, lexPlaceholder] } as never, { awsRequestId: 'r-1' } as never);
    expect(inBatchPairs()).toEqual([]);
  });

  it('pairs the moved answer, not the private receipt, once the updates are in hand', async () => {
    await handler({ Records: [userMessage, lexPlaceholder, answerCreate, answerUpdate, receiptUpdate] } as never, { awsRequestId: 'r-1' } as never);
    expect(inBatchPairs()).toEqual([[USER_MSG, 'ans-1']]);
  });
});

describe('an answer written into the queue notice is the answer', () => {
  // The notice was written into the placeholder first; then posting the answer at the end failed and
  // the answer was written into the same message, declaring so.
  const noticeWrite = chimeEvent('UPDATE_CHANNEL_MESSAGE', {
    MessageId: 'ph-1', Content: 'Still working on your earlier message.', Sender: { Arn: BOT, Name: 'Advisor' },
    CreatedTimestamp: '2026-10-21T06:33:07.225Z', LastUpdatedTimestamp: '2026-10-21T06:33:08.000Z',
    Metadata: JSON.stringify({ botResponse: true, respPhase: 'notice', turnKind: 'queue_ack', inPlaceholder: true, acknowledges: 'q-1' }),
  });
  const answerInNotice = chimeEvent('UPDATE_CHANNEL_MESSAGE', {
    MessageId: 'ph-1', Content: 'Here is the report.', Sender: { Arn: BOT, Name: 'Advisor' },
    CreatedTimestamp: '2026-10-21T06:33:07.225Z', LastUpdatedTimestamp: '2026-10-21T06:33:30.000Z',
    Metadata: JSON.stringify({ intent: 'report_generation', answersMessageId: USER_MSG, answeredInNotice: true, respPhase: 'final' }),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never);
  });

  it('pairs the placeholder through the answer it now holds, not as a notice', async () => {
    await handler({ Records: [userMessage, placeholder, noticeWrite, answerInNotice] } as never, { awsRequestId: 'r-1' } as never);
    expect(inBatchPairs()).toEqual([[USER_MSG, 'ph-1']]);
  });

  it('still never pairs a notice that holds no answer', async () => {
    await handler({ Records: [userMessage, placeholder, noticeWrite] } as never, { awsRequestId: 'r-1' } as never);
    expect(inBatchPairs()).toEqual([]);
  });

  it('pairs again after the fold for that conversation, and the sweep and the fold read the final', async () => {
    await handler({ Records: [noticeWrite, answerInNotice] } as never, { awsRequestId: 'r-1' } as never);
    const sweeps = mockedQuery.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO exchanges') && String(sql).includes('DISTINCT ON'));
    // Once before the fold, and once after it for the conversation whose answer landed in the notice.
    expect(sweeps.length).toBe(2);
    const sweep = String(sweeps[0][0]).replace(/\s+/g, ' ');
    expect(sweep).toContain("= 'queue_ack' AND am.agent_final_at IS NOT NULL))");
    // The fold carries the target the answer declared, and only from the answer: the notice names none.
    const folds = mockedQuery.mock.calls.filter(([sql]) => String(sql).includes('answers_message_id     = COALESCE(answers_message_id, $32)'));
    expect(folds.map(([, params]) => (params as unknown[])[31])).toEqual([null, USER_MSG]);
  });
});
