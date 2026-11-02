/**
 * THE NOTICE AND THE FOLD NOTE LIVE IN THE RUNNING ANSWER'S PLACEHOLDER, AND THE ANSWER POSTS AT THE
 * END.
 *
 * The owner's burst after the park/resume deploy: the answer landed in the original placeholder above
 * the follow-ups it addressed, the queue notice was a separate message that never settled, and the
 * reading's "I'm folding your follow-ups in" note was a third message at the end. The direction: the
 * placeholder, right after the question, carries the notice and the fold note; the answer is a new
 * message after everything it addresses.
 *
 * And the notice that never settled (live 2026-09-15): the resumed answer's fold took the queue first,
 * `clearQueue` returned early on an empty queue without ending the drain, and the answering exit saw
 * the reading's claim still held and skipped the settle.
 */

const mockSend = jest.fn();
const mockRemember = jest.fn();
const mockMapping = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: class { send = (...a: unknown[]) => mockSend(...a); },
  GetChannelMessageCommand: class { __t = 'Get'; constructor(public input: any) {} },
  SendChannelMessageCommand: class { __t = 'Send'; constructor(public input: any) {} },
  UpdateChannelMessageCommand: class { __t = 'Update'; constructor(public input: any) {} },
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}));
jest.mock('../../lambda/src/lib/turn-lock.js', () => ({
  rememberNotice: (...a: unknown[]) => mockRemember(...a),
  advanceQueueStatus: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../lambda/src/lib/abuse-controls.js', () => ({
  readPlaceholderMapping: (...a: unknown[]) => mockMapping(...a),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const notice = require('../../lambda/src/lib/turn-queue-notice');

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/b1';

const placeholder = (over: Record<string, unknown> = {}) => ({
  ChannelMessage: {
    Sender: { Arn: BOT },
    Content: encodeURIComponent('One moment... <!--corr:abc-->'),
    Metadata: JSON.stringify({ respPhase: 'ack' }),
    ...over,
  },
});

beforeEach(() => {
  mockSend.mockReset();
  mockRemember.mockReset().mockResolvedValue(undefined);
  mockMapping.mockReset();
});

describe('finding the running answer\'s placeholder', () => {
  it('returns a public placeholder that is still waiting for its answer', async () => {
    mockMapping.mockResolvedValue('ph-1');
    mockSend.mockResolvedValueOnce(placeholder());
    expect(await notice.findHolderPlaceholder({ channelArn: CHANNEL, botArn: BOT, holderCorrelationId: 'abc' })).toBe('ph-1');
  });

  it('refuses a targeted placeholder, because the notice is room-visible', async () => {
    mockMapping.mockResolvedValue('ph-1');
    mockSend.mockResolvedValueOnce(placeholder({ Target: [{ MemberArn: 'someone' }] }));
    expect(await notice.findHolderPlaceholder({ channelArn: CHANNEL, botArn: BOT, holderCorrelationId: 'abc' })).toBeUndefined();
  });

  it('refuses a placeholder that already holds an answer or a notice', async () => {
    mockMapping.mockResolvedValue('ph-1');
    mockSend.mockResolvedValueOnce(placeholder({ Metadata: JSON.stringify({ respPhase: 'final' }) }));
    expect(await notice.findHolderPlaceholder({ channelArn: CHANNEL, botArn: BOT, holderCorrelationId: 'abc' })).toBeUndefined();
    mockSend.mockResolvedValueOnce(placeholder({ Content: encodeURIComponent('The answer.') }));
    expect(await notice.findHolderPlaceholder({ channelArn: CHANNEL, botArn: BOT, holderCorrelationId: 'abc' })).toBeUndefined();
  });

  it('has nothing to find for a holder with no placeholder, such as a reading', async () => {
    mockMapping.mockResolvedValue(null);
    expect(await notice.findHolderPlaceholder({ channelArn: CHANNEL, botArn: BOT, holderCorrelationId: 'arrival-x-1' })).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('the first notice goes into that placeholder', () => {
  it('updates the placeholder instead of posting, and records it as the notice', async () => {
    mockSend.mockResolvedValueOnce({});
    const id = await notice.showQueueNotice({
      channelArn: CHANNEL, botArn: BOT, responderId: 'b1', depth: 1, overflowed: false, placeholderId: 'ph-1',
    });
    expect(id).toBe('ph-1');
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.__t).toBe('Update');
    expect(cmd.input.MessageId).toBe('ph-1');
    expect(JSON.parse(cmd.input.Metadata)).toMatchObject({ respPhase: 'notice', queueDepth: 1 });
    expect(mockRemember).toHaveBeenCalledWith({ channelArn: CHANNEL, responderId: 'b1', noticeId: 'ph-1' });
  });

  it('falls back to posting a notice of its own when the placeholder cannot be written', async () => {
    mockSend.mockRejectedValueOnce(new Error('in processing')).mockResolvedValueOnce({ MessageId: 'n-1' });
    const id = await notice.showQueueNotice({
      channelArn: CHANNEL, botArn: BOT, responderId: 'b1', depth: 1, overflowed: false, placeholderId: 'ph-1',
    });
    expect(id).toBe('n-1');
    expect(mockSend.mock.calls[1][0].__t).toBe('Send');
  });
});

describe('the fold note survives the notice machinery', () => {
  it('is written with the notice metadata and marked as a note', async () => {
    // The read (the notice does not hold an answer), then the write.
    mockSend.mockResolvedValueOnce({ ChannelMessage: { Metadata: JSON.stringify({ respPhase: 'notice' }) } }).mockResolvedValueOnce({});
    expect(await notice.writeProposalIntoNotice({
      channelArn: CHANNEL, botArn: BOT, noticeId: 'ph-1', content: 'Including those now.', depth: 2,
    })).toBe(true);
    expect(mockSend.mock.calls[0][0].__t).toBe('Get');
    expect(JSON.parse(mockSend.mock.calls[1][0].input.Metadata)).toMatchObject({ respPhase: 'notice', carriesProposal: true });
  });

  it('a settle keeps the note text and only marks the queue settled', async () => {
    const note = encodeURIComponent('Including those now.');
    mockSend
      .mockResolvedValueOnce({ ChannelMessage: { Content: note, Metadata: JSON.stringify({ carriesProposal: true }) } })
      .mockResolvedValueOnce({});
    await notice.settleQueueNotice({ channelArn: CHANNEL, botArn: BOT, noticeId: 'ph-1', triaged: 2 });
    const update = mockSend.mock.calls[1][0].input;
    expect(update.Content).toBe(note);
    expect(JSON.parse(update.Metadata)).toMatchObject({ queueDepth: 0, queueStatus: 'settled', carriesProposal: true });
  });

  it('a settle without a note still says caught up', async () => {
    mockSend
      .mockResolvedValueOnce({ ChannelMessage: { Content: 'x', Metadata: JSON.stringify({ respPhase: 'notice' }) } })
      .mockResolvedValueOnce({});
    await notice.settleQueueNotice({ channelArn: CHANNEL, botArn: BOT, noticeId: 'n-1', triaged: 2 });
    expect(decodeURIComponent(mockSend.mock.calls[1][0].input.Content)).toMatch(/Caught up/);
  });

  it('a later stage does not repaint the note', async () => {
    mockSend.mockResolvedValueOnce({ ChannelMessage: { Content: 'x', Metadata: JSON.stringify({ carriesProposal: true }) } });
    expect(await notice.advanceQueueNotice({
      channelArn: CHANNEL, botArn: BOT, responderId: 'b1', noticeId: 'ph-1', depth: 2, status: 'clearing',
    })).toBe(true);
    expect(mockSend.mock.calls.filter(([c]: any[]) => c.__t === 'Update')).toHaveLength(0);
  });
});

describe('where it is wired', () => {
  const core = read('lambda/src/lib/async-processor-core.ts');
  const router = read('lambda/src/router-agent-handler.ts');
  const lock = read('lambda/src/lib/turn-lock.ts');

  it('the router resolves the holder\'s placeholder for the first notice only', () => {
    expect(router).toContain('const holderPlaceholder = mayPost && !queued.noticeId');
    expect(router).toContain('...(holderPlaceholder ? { placeholderId: holderPlaceholder } : {}),');
  });

  it('an answer whose placeholder became the notice posts at the end', () => {
    expect(core).toContain("placeholderIsNotice = JSON.parse(phForTarget.ChannelMessage?.Metadata || '{}')?.respPhase === 'notice';");
    const at = core.indexOf('if (placeholderIsNotice && !event.triage && !delivery.broadcastTheAnswer && !delivery.targetTheAnswer) {');
    expect(at).toBeGreaterThan(-1);
    const block = core.slice(at, at + 900);
    expect(block).toContain('sendChannelMessage(');
    expect(block).toContain('deliveryMessageId = posted.MessageId;');
  });

  it('a fold-only proposal is written into the notice; one that asks something posts at the end', () => {
    expect(core).toContain("proposal.items.every((item) => item.intent === 'amends')");
    const at = core.indexOf('const notedInNotice = !!noteNotice && await writeProposalIntoNotice({');
    expect(at).toBeGreaterThan(-1);
    expect(core.slice(at, at + 1400)).toContain('await postReadingCarrier();');
  });

  it('clearing an already-empty queue still ends the drain', () => {
    const at = lock.indexOf('if (!current.length) {');
    expect(at).toBeGreaterThan(-1);
    const block = lock.slice(at, at + 900);
    expect(block).toContain("'REMOVE noticeId, triagedBy, triageAt, queueStatus, drainTaskId'");
    expect(block).toContain('attribute_not_exists(queued)');
    expect(lock).not.toContain('if (!current.length) return true;');
  });
});

describe('a private answer leaves the notice for the settle', () => {
  const core = read('lambda/src/lib/async-processor-core.ts');

  it('does not close out a placeholder that became the notice as a receipt', () => {
    // Closed out, the receipt overwrote the note as `final`; the settle then refused it as an answer
    // and the notice never reached `settled` (e2e, 2026-10-23: `stages seen: reviewing`).
    const at = core.indexOf('if (delivery.targetTheAnswer && event.senderArn) {');
    expect(at).toBeGreaterThan(-1);
    const block = core.slice(at, at + 2400);
    const guard = block.indexOf('if (!placeholderIsNotice) {');
    expect(guard).toBeGreaterThan(-1);
    expect(block.indexOf('acknowledgementMessageId = messageId;')).toBeGreaterThan(guard);
    expect(block.indexOf("placeholderCloseOut = templateLine('answered-privately', { copy });")).toBeGreaterThan(guard);
  });
});
