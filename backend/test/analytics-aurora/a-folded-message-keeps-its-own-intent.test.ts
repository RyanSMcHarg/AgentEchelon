/**
 * ADR-064 DECISION B: A FOLDED QUEUED MESSAGE KEEPS ITS OWN INTENT AND TAKES THE COMPLETING TURN'S ATTRIBUTION.
 *
 * A queued message was classified before it queued. When a reading judges it to amend the work in flight and the
 * running answer folds it in, its exchange (`paired_by = 'declared'`, `queued_as = 'folded'`) is attributed to what it
 * asked for, never to the answering turn's own message, and carries the `task_type`, `task_step`, `model_kind` and
 * `model_from` of the turn that completed it. The intent travels with the message from the enqueue to the answer:
 *
 *   router (classified, enqueued with it) -> turn record (`queuedIntents`) -> the fold (`foldedIntents`, accumulated)
 *   -> the router hop (`AE.turn.foldedIntents`) -> the answer (`answeredQueuedIntents`) -> the queue-fold pass.
 */
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: (...a: unknown[]) => mockSend(...a) }) },
  UpdateCommand: class { __t = 'Update'; constructor(public input: any) {} },
  GetCommand: class { __t = 'Get'; constructor(public input: any) {} },
}));
jest.mock('../../lambda/src/lib/abuse-controls', () => ({ readPlaceholderMapping: jest.fn().mockResolvedValue(null) }));

process.env.TURN_STATE_TABLE = 'test-table';
process.env.TURN_QUEUE_ENABLED = '1';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lock = require('../../lambda/src/lib/turn-lock');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const flat = (s: string) => s.replace(/\s+/g, ' ');
const code = (s: string) => s.replace(/--[^\n]*/g, '');

beforeEach(() => mockSend.mockReset());

describe('the router enqueues a message with the intent it was classified as', () => {
  it('records the intent beside the id in the same write, leaving the queue a list of ids', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { queued: ['m1'], queuedIntents: [{ messageId: 'm1', intent: 'report_generation' }] } });
    await lock.enqueueMessage({ channelArn: CHANNEL, responderId: 'b', messageId: 'm1', intent: 'report_generation' });
    const { input } = mockSend.mock.calls[0][0];
    expect(input.UpdateExpression).toContain('queued = list_append(if_not_exists(queued, :empty), :one)');
    expect(input.UpdateExpression).toContain('queuedIntents = list_append(if_not_exists(queuedIntents, :empty), :intent)');
    expect(input.ExpressionAttributeValues[':one']).toEqual(['m1']);
    expect(input.ExpressionAttributeValues[':intent']).toEqual([{ messageId: 'm1', intent: 'report_generation' }]);
  });

  it('writes nothing more when no intent is known', async () => {
    mockSend.mockResolvedValueOnce({ Attributes: { queued: ['m1'] } });
    await lock.enqueueMessage({ channelArn: CHANNEL, responderId: 'b', messageId: 'm1' });
    expect(mockSend.mock.calls[0][0].input.UpdateExpression).not.toContain('queuedIntents');
  });

  it('keeps the record bounded, dropping the oldest intents by a write a moving list refuses', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ messageId: `m${i}`, intent: 'general' }));
    mockSend.mockResolvedValueOnce({ Attributes: { queued: ['m29'], queuedIntents: many } }).mockResolvedValueOnce({});
    await lock.enqueueMessage({ channelArn: CHANNEL, responderId: 'b', messageId: 'm29', intent: 'general' });
    const trim = mockSend.mock.calls[1][0].input;
    expect(trim.ConditionExpression).toBe('queuedIntents = :current');
    expect(trim.ExpressionAttributeValues[':kept'].length).toBeLessThan(30);
    expect(trim.ExpressionAttributeValues[':kept'].at(-1)).toEqual({ messageId: 'm29', intent: 'general' });
  });

  it('the turn state reads them back by message id, dropping a malformed entry', async () => {
    mockSend.mockResolvedValueOnce({ Item: { queued: ['m1', 'm2'], queuedIntents: [
      { messageId: 'm1', intent: 'report_generation' }, { messageId: 'm2' }, 'junk', { messageId: 'm2', intent: 'data_extraction' },
    ] } });
    const state = await lock.readTurnState({ channelArn: CHANNEL, responderId: 'b' });
    expect(state.queuedIntents).toEqual({ m1: 'report_generation', m2: 'data_extraction' });
  });

  it('the router passes the classified intent to the enqueue', () => {
    expect(read('lambda/src/router-agent-handler.ts'))
      .toContain('enqueueMessage({ channelArn, responderId, messageId: queuedMessageId, intent: classification.intent })');
  });
});

describe('the fold carries each folded message\'s intent to the answer', () => {
  it('accumulates across folds, beside the ids, from the turn record it already read', () => {
    const core = read('lambda/src/lib/async-processor-core.ts');
    expect(flat(core)).toContain(flat(`foldedIntents: {
            ...(event.foldedIntents ?? {}),
            ...Object.fromEntries(foldable
              .map((m) => [m.messageId, foldState?.queuedIntents?.[m.messageId]] as const)`));
    expect(read('lambda/src/lib/turn-triage.ts')).toContain('{ foldedIntents: args.foldedIntents }');
  });

  it('survives the router hop as checked pairs, and a mangled pair is dropped rather than misattributed', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { encodeFoldedIntents, decodeFoldedIntents } = require('../../lambda/src/router-agent-handler');
    const encoded = encodeFoldedIntents({ m1: 'report_generation', 'm 2': 'general', m3: 'bad intent' });
    expect(encoded).toBe('m1:report_generation');
    expect(decodeFoldedIntents('m1:report_generation,m2:data_extraction')).toEqual({ m1: 'report_generation', m2: 'data_extraction' });
    expect(decodeFoldedIntents('m1:report:extra,:general,m2:,m3:ok')).toEqual({ m3: 'ok' });
    expect(decodeFoldedIntents(undefined)).toEqual({});
  });

  it('the router keeps an intent only for a declared folded id, and hands it to the worker', () => {
    const router = read('lambda/src/router-agent-handler.ts');
    expect(router).toContain('.filter(([id]) => foldedMessageIds.includes(id)));');
    expect(router).toContain('...(Object.keys(foldedIntents).length ? { foldedIntents } : {}),');
  });

  it('the answer declares them out of band, never in the size-capped inline Metadata', () => {
    const core = read('lambda/src/lib/async-processor-core.ts');
    expect(core).toContain('? { answeredQueuedIntents: event.foldedIntents }');
    const inline = core.slice(core.indexOf('const messageMetadata: Record<string, unknown> = {'), core.indexOf('const writeTurnAnalytics = () =>'));
    expect(inline).not.toContain('answeredQueuedIntents');
  });
});

describe('the queue-fold pass writes the folded message\'s own intent and the completing turn\'s attribution', () => {
  const archival = read('lambda/src/analytics-aurora/kinesis-archival.ts');
  const start = archival.indexOf('async function createQueuedExchanges');
  const pass = flat(code(archival.slice(start, archival.indexOf('\n}\n', start))));

  it('reads the declared intents and the completing turn\'s columns off the answer', () => {
    expect(pass).toContain("COALESCE(am_upd.metadata->'answeredQueuedIntents', am.metadata->'answeredQueuedIntents') AS queued_intents");
    for (const col of ['task_type', 'task_step', 'model_kind', 'model_from']) {
      expect(pass).toContain(`COALESCE(am_upd.${col}, am.${col}) AS ${col}`);
    }
  });

  it('inserts the folded message\'s own intent first, never the answer\'s ahead of it', () => {
    expect(pass).toContain("COALESCE(NULLIF(d.queued_intents->>d.queued_message_id, ''), d.task_type, d.intent)");
    expect(pass).toContain('paired_by, queued_as, e2e_ms, task_type, task_step, model_kind, model_from )');
    expect(pass).toContain("'declared', 'folded',");
    expect(pass).toMatch(/END, d\.task_type, d\.task_step, d\.model_kind, d\.model_from FROM declared d/);
  });
});
