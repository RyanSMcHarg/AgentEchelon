/**
 * AN ANSWER THAT MOVED TO A MESSAGE OF ITS OWN IS THE ONE THAT PAIRS.
 *
 * Latency is paired from whatever triggered a message to the message itself. A turn that delivers its
 * answer as a NEW message - a private answer targeted at the person, an answer posted at the end because
 * the placeholder became the queue notice, a broadcast duel answer - leaves its placeholder behind as a
 * receipt or a notice. Both pairers took the placeholder, because it is the earlier bot message and a flow
 * turn's placeholder names its target in its CREATE content. The answer then counted as a turn with no
 * exchange and no kind: 16 of them on 2026-10-21.
 *
 * WHAT THIS PINS:
 *   - `receipt` and `queue_ack` are declarable kinds, so both pairers skip them by the closed-set test;
 *   - every queue notice write declares `queue_ack`, including the settle that carries attribution;
 *   - the receipt close-out declares `receipt`;
 *   - archival does not pair a placeholder that named its target until its update says what it became,
 *     and with the update in the batch it pairs the moved answer instead;
 *   - an answer written into the notice is never overwritten: no stage, note, count or settle writes
 *     over it, and the turn record stops pointing at it so the next queued message gets a fresh notice.
 */

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: class { send = (...a: unknown[]) => mockSend(...a); },
  GetChannelMessageCommand: class { __t = 'Get'; constructor(public input: any) {} },
  SendChannelMessageCommand: class { __t = 'Send'; constructor(public input: any) {} },
  UpdateChannelMessageCommand: class { __t = 'Update'; constructor(public input: any) {} },
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}));
jest.mock('../../lambda/src/lib/turn-lock.js', () => ({
  rememberNotice: jest.fn().mockResolvedValue(undefined),
  advanceQueueStatus: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../lambda/src/lib/abuse-controls.js', () => ({
  readPlaceholderMapping: jest.fn(),
}));

import { TURN_KINDS, turnDeclarationOf, RECEIPT_TURN_KIND, QUEUE_ACK_TURN_KIND } from '../../lambda/src/lib/turn-declaration';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const notice = require('../../lambda/src/lib/turn-queue-notice');

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/b1';

/** The Metadata of every write the notice module sent, parsed. */
function writtenMetadata(): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .map(([cmd]) => cmd as { __t: string; input: { Metadata?: string } })
    .filter((cmd) => cmd.__t !== 'Get' && cmd.input.Metadata)
    .map((cmd) => JSON.parse(cmd.input.Metadata as string));
}

beforeEach(() => {
  mockSend.mockReset();
});

describe('the kinds a placeholder becomes are declarable', () => {
  it('are in the closed set, so both pairers skip them', () => {
    expect(TURN_KINDS).toEqual(expect.arrayContaining(['receipt', 'queue_ack']));
    expect(RECEIPT_TURN_KIND).toBe('receipt');
    expect(QUEUE_ACK_TURN_KIND).toBe('queue_ack');
  });

  it('are read back off a content declaration as themselves', () => {
    expect(turnDeclarationOf('x<!--turn:kind=receipt-->').kind).toBe('receipt');
    expect(turnDeclarationOf('x<!--turn:kind=queue_ack-->').kind).toBe('queue_ack');
  });
});

describe('every queue notice write declares queue_ack', () => {
  it('when the notice is written into the running answer\'s placeholder', async () => {
    mockSend.mockResolvedValue({});
    const id = await notice.showQueueNotice({
      channelArn: CHANNEL, botArn: BOT, responderId: 'b1', depth: 1, overflowed: false,
      acknowledges: 'q-1', placeholderId: 'ph-1',
    });
    expect(id).toBe('ph-1');
    const [meta] = writtenMetadata();
    expect(meta).toMatchObject({ respPhase: 'notice', inPlaceholder: true, acknowledges: 'q-1', turnKind: 'queue_ack' });
  });

  it('when the notice is updated, and when it is posted on its own', async () => {
    mockSend.mockResolvedValue({ MessageId: 'n-1' });
    await notice.showQueueNotice({ channelArn: CHANNEL, botArn: BOT, responderId: 'b1', depth: 2, overflowed: false, existingNoticeId: 'n-1' });
    await notice.showQueueNotice({ channelArn: CHANNEL, botArn: BOT, responderId: 'b1', depth: 1, overflowed: false });
    const metas = writtenMetadata();
    expect(metas).toHaveLength(2);
    for (const meta of metas) expect(meta.turnKind).toBe('queue_ack');
  });

  it('when a stage is shown, when the reading\'s note is written, and when it settles', async () => {
    // Get (does the notice carry a note?) answers no; every update succeeds.
    mockSend.mockImplementation(async (cmd: { __t: string }) =>
      (cmd.__t === 'Get' ? { ChannelMessage: { Metadata: '{}' } } : {}));
    await notice.advanceQueueNotice({ channelArn: CHANNEL, botArn: BOT, responderId: 'b1', noticeId: 'ph-1', depth: 1, status: 'reviewing' });
    await notice.writeProposalIntoNotice({ channelArn: CHANNEL, botArn: BOT, noticeId: 'ph-1', content: 'Folded in.', depth: 1 });
    await notice.settleQueueNotice({
      channelArn: CHANNEL, botArn: BOT, noticeId: 'ph-1', triaged: 1,
      // The answering turn's attribution rides the settle. Nothing it carries may take the kind away.
      attribution: { answersMessageId: 'u-1', intent: 'report_generation', turnKind: 'something-else' },
    });
    const metas = writtenMetadata();
    expect(metas).toHaveLength(3);
    for (const meta of metas) expect(meta.turnKind).toBe('queue_ack');
    expect(metas[2]).toMatchObject({ answersMessageId: 'u-1', queueStatus: 'settled' });
  });
});

describe('the receipt close-out declares receipt', () => {
  it('rides the update that closes the placeholder out, after the attribution', () => {
    const core = read('lambda/src/lib/async-processor-core.ts');
    const at = core.indexOf('const closeOutAcknowledgement = async');
    expect(at).toBeGreaterThan(-1);
    const body = core.slice(at, core.indexOf('\n  };\n', at));
    expect(body).toContain('closeOutAttribution({');
    expect(body.replace(/\s+/g, ' ')).toContain('}) ?? {}), turnKind: RECEIPT_TURN_KIND },');
  });
});

describe('an answer written into the notice stays the answer', () => {
  it('is declared on the answer when posting it at the end failed', () => {
    const core = read('lambda/src/lib/async-processor-core.ts').replace(/\s+/g, ' ');
    expect(core).toContain('const answersInTheNotice = placeholderIsNotice && !event.triage && !delivery.broadcastTheAnswer && !delivery.targetTheAnswer && deliveryMessageId === messageId;');
    expect(core).toContain('...(answersInTheNotice ? { answeredInNotice: true } : {}),');
  });

  it('is never settled over with "caught up"', async () => {
    mockSend.mockImplementation(async (cmd: { __t: string }) =>
      (cmd.__t === 'Get' ? { ChannelMessage: { Metadata: JSON.stringify({ respPhase: 'final', answeredInNotice: true }) } } : {}));
    await notice.settleQueueNotice({ channelArn: CHANNEL, botArn: BOT, noticeId: 'ph-1', triaged: 1 });
    expect(writtenMetadata()).toEqual([]);
  });

  // The message reads back as the answer: the final the turn wrote into it.
  const holdingTheAnswer = () => mockSend.mockImplementation(async (cmd: { __t: string }) =>
    (cmd.__t === 'Get'
      ? { ChannelMessage: { Metadata: JSON.stringify({ respPhase: 'final', answeredInNotice: true }) } }
      : { MessageId: 'n-fresh' }));
  const updatesTo = (id: string) => mockSend.mock.calls
    .map(([cmd]) => cmd as { __t: string; input: { MessageId?: string } })
    .filter((cmd) => cmd.__t === 'Update' && cmd.input.MessageId === id);

  it('is never painted over by a drain stage', async () => {
    holdingTheAnswer();
    const advanced = await notice.advanceQueueNotice({ channelArn: CHANNEL, botArn: BOT, responderId: 'b1', noticeId: 'ph-1', depth: 1, status: 'reviewing' });
    // The stage is recorded on the queue record; the message keeps the answer.
    expect(advanced).toBe(true);
    expect(updatesTo('ph-1')).toEqual([]);
  });

  it('is never overwritten by a reading\'s note, which then posts at the end', async () => {
    holdingTheAnswer();
    const noted = await notice.writeProposalIntoNotice({ channelArn: CHANNEL, botArn: BOT, noticeId: 'ph-1', content: 'Folded in.', depth: 1 });
    expect(noted).toBe(false);
    expect(updatesTo('ph-1')).toEqual([]);
  });

  it('is never updated with another queued message\'s count; a fresh notice is posted instead', async () => {
    holdingTheAnswer();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { rememberNotice } = require('../../lambda/src/lib/turn-lock.js');
    (rememberNotice as jest.Mock).mockClear();
    const id = await notice.showQueueNotice({
      channelArn: CHANNEL, botArn: BOT, responderId: 'b1', depth: 2, overflowed: false, existingNoticeId: 'ph-1',
    });
    expect(updatesTo('ph-1')).toEqual([]);
    expect(id).toBe('n-fresh');
    expect(rememberNotice).toHaveBeenCalledWith({ channelArn: CHANNEL, responderId: 'b1', noticeId: 'n-fresh' });
  });

  it('takes the notice pointer off the turn record once the answer lands in it', () => {
    const core = read('lambda/src/lib/async-processor-core.ts').replace(/\s+/g, ' ');
    const update = core.indexOf('await updateMessage(event.channelArn, deliveryMessageId, finalContent, event.botArn, closingPhase, messageMetadata);');
    expect(update).toBeGreaterThan(-1);
    const forget = core.indexOf('if (answersInTheNotice) { await forgetNoticeHoldingAnswer({ channelArn: event.channelArn, responderId: principalIdFromArn(event.botArn), noticeId: messageId, })', update);
    expect(forget).toBeGreaterThan(update);
  });

  it('is labeled as the answer, not as the notice its first update was', () => {
    const query = read('lambda/src/analytics-aurora/analytics-query.ts').replace(/\s+/g, ' ');
    // The Latency tab's kind, and the Turn kinds breakdown's.
    expect(query).toContain("WHEN ${declaredKind} = 'queue_ack' AND ${m}.agent_final_at IS NOT NULL THEN NULL");
    expect(query).toContain("= 'queue_ack' AND m.agent_final_at IS NOT NULL THEN NULL ELSE COALESCE(upd.turn_kind, m.turn_kind,");
  });
});

describe('the console names both kinds', () => {
  it('has help text for receipt and queue_ack', () => {
    const en = JSON.parse(read('../frontend/packages/shared/src/locales/en.json'));
    expect(typeof en.admin.turnKinds.help.receipt).toBe('string');
    expect(typeof en.admin.turnKinds.help.queue_ack).toBe('string');
  });
});
