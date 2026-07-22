/**
 * Async Processor — /battle Helpers Unit Tests
 *
 * DESIGN-MULTI-ASSISTANT-TURN-ENGINE (Phase 1): a battle turn is a NORMAL
 * request for the bot's assigned experiment variant. The variant is resolved
 * ONCE in the fan-out and passed to the worker via battleContext, so the worker
 * layers the variant's persona addendum as normal persona and (round 2) appends
 * a minimal, non-adversarial rebuttal note via buildRebuttalContext. There are
 * no battle-specific prompt constraints and no second variant resolution.
 *
 * These tests pin:
 *   - buildRebuttalContext: the round-2 rebuttal note shape (rival name, the
 *     rival's reply in <other_reply> tags, the NO_REBUTTAL opt-out, and that it
 *     stays non-adversarial).
 *   - isNoRebuttal: false matches there cause real round-2 replies to be
 *     resolved as if they were opt-outs.
 *   - The resolve-once battleContext carries the variant fields the worker
 *     consumes without re-resolving.
 */

// Mock the AWS SDK + db-client transitively before importing
const mockBedrockSend = jest.fn();
const mockMessagingSend = jest.fn();
const mockDdbSend = jest.fn();
const mockLambdaSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  ConverseCommand: jest.fn(),
}), { virtual: true });

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  ListChannelMessagesCommand: jest.fn(),
  UpdateChannelMessageCommand: jest.fn().mockImplementation((args) => ({ __type: 'Update', input: args })),
  SendChannelMessageCommand: jest.fn(),
}), { virtual: true });

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(),
  PutObjectCommand: jest.fn(),
}), { virtual: true });

jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn(),
  InvocationType: { Event: 'Event' },
}), { virtual: true });

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  ScanCommand: jest.fn(),
  PutCommand: jest.fn(),
  UpdateCommand: jest.fn(),
  GetCommand: jest.fn(),
  QueryCommand: jest.fn(),
}), { virtual: true });

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}), { virtual: true });

import type { BattleContextPayload } from '../../lambda/src/lib/async-processor-core';
// Static import for pure helpers (isNoRebuttal, updateMessage, buildRebuttalContext).
import {
  isNoRebuttal,
  updateMessage,
  splitIntoChunks,
  buildRebuttalContext,
  buildRebuttalImageNote,
  buildBattleAwareness,
} from '../../lambda/src/lib/async-processor-core';

const DEFAULT_BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/default';
const ALT_SLOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/AltSlot0';

beforeEach(() => {
  jest.clearAllMocks();
  process.env.EXPERIMENTS_TABLE = 'experiments-test';
});

describe('isNoRebuttal', () => {
  it.each([
    'NO_REBUTTAL',
    'no_rebuttal',
    'No_Rebuttal',
    '  NO_REBUTTAL  ',
    'NO_REBUTTAL.',
    'NO_REBUTTAL!',
    'no rebuttal',
    'NO REBUTTAL',
  ])('matches %j', (input) => {
    expect(isNoRebuttal(input)).toBe(true);
  });

  it.each([
    '',
    'NO_REBUTTAL_NEEDED',
    'I have no rebuttal at this time',
    'no rebuttal here, but I do want to add...',
    'Actually, no_rebuttal — kidding, here is my rebuttal',
    'My response: NO_REBUTTAL is not what I would say',
    "Let's say NO_REBUTTAL and move on",
  ])('does NOT match %j', (input) => {
    expect(isNoRebuttal(input)).toBe(false);
  });

  it('does not match the empty string', () => {
    expect(isNoRebuttal('')).toBe(false);
  });
});

// Round-2 NO_REBUTTAL resolves the placeholder by UPDATING it to a "No rebuttal." state (reusing
// UpdateChannelMessage), NOT by deleting it — so it needs no chime:DeleteChannelMessage grant and the
// opt-out is shown honestly instead of a bubble that appears then vanishes.
describe('NO_REBUTTAL placeholder resolution (update, not delete)', () => {
  it('updateMessage issues an UpdateChannelMessage with URL-encoded content + the bot bearer', async () => {
    mockMessagingSend.mockResolvedValueOnce({});
    await updateMessage('arn:channel', 'msg-id-X', 'No rebuttal.', ALT_SLOT);
    expect(mockMessagingSend).toHaveBeenCalledTimes(1);
    const cmd = mockMessagingSend.mock.calls[0][0];
    expect(cmd.__type).toBe('Update'); // NOT Delete — no chime:DeleteChannelMessage dependency
    expect(cmd.input.ChannelArn).toBe('arn:channel');
    expect(cmd.input.MessageId).toBe('msg-id-X');
    expect(cmd.input.ChimeBearer).toBe(ALT_SLOT);
    expect(decodeURIComponent(cmd.input.Content)).toBe('No rebuttal.');
  });
});

// The round-2 rebuttal is a COMPETITIVE note (buildRebuttalContext): comment on the
// rival's answer and argue why THIS assistant's answer is better. Round 1 is a fully
// normal request (no length cap), plus a light battle-awareness note.
describe('buildRebuttalContext (round-2 rebuttal note)', () => {
  it('embeds the rival name and the rival reply inside <other_reply> tags', () => {
    const note = buildRebuttalContext('Echo', 'The rival argued for option B');
    expect(note).toContain('Echo');
    expect(note).toContain('<other_reply>');
    expect(note).toContain('The rival argued for option B');
    expect(note).toContain('</other_reply>');
  });

  it('is competitive: argue why YOUR answer is better, and offers the NO_REBUTTAL opt-out', () => {
    const note = buildRebuttalContext('Echo', 'reply text');
    expect(note).toContain('NO_REBUTTAL');
    // Competitive framing: make the case that this assistant's own answer is better.
    expect(note).toMatch(/why YOUR answer is the better one/);
    expect(note.toLowerCase()).toContain('where yours is stronger');
    // Not gratuitously hostile, and not a mere restatement.
    expect(note.toLowerCase()).toContain('fair');
    expect(note.toLowerCase()).toContain('do not just restate');
  });

  it('falls back gracefully when the rival name or reply is empty', () => {
    const note = buildRebuttalContext('', '');
    expect(note).toContain('the other assistant');
    expect(note).toContain('(no reply)');
  });

  it('is prefixed with blank lines so it appends cleanly to a system prompt', () => {
    expect(buildRebuttalContext('Echo', 'x').startsWith('\n\n')).toBe(true);
  });
});

// Image-battle round-2: an additive one-liner appended AFTER buildRebuttalContext (whose wording is
// unchanged) ONLY when the rival's round-1 image has been resolved into a vision block on the
// conversation. It points the model at the image it now perceives in the shared channel.
describe('buildRebuttalImageNote (image-battle round-2 addendum)', () => {
  it('tells the assistant to look at and critique the image shown in the conversation', () => {
    const note = buildRebuttalImageNote();
    expect(note.toLowerCase()).toContain('image');
    expect(note.toLowerCase()).toMatch(/critique|look at/);
    expect(note.toLowerCase()).toContain('conversation');
    // Appends cleanly to a system prompt.
    expect(note.startsWith('\n\n')).toBe(true);
  });

  it('is separate from buildRebuttalContext (its competitive wording is not modified)', () => {
    // The base rebuttal note stands alone; the image note is strictly additive.
    expect(buildRebuttalContext('Echo', 'x')).not.toContain('shown to you above');
  });
});

// Round-1 battle awareness (owner direction): the assistant KNOWS it is in battle
// mode and that a rebuttal turn follows, but round-1 content/length stay normal
// (no adversarial constraints, no word cap). Only a light note is added.
describe('buildBattleAwareness (round-1 note)', () => {
  it('names the rival and signals battle mode + a coming rebuttal turn', () => {
    const note = buildBattleAwareness('Echo');
    expect(note).toContain('battle mode');
    expect(note).toContain('Echo');
    expect(note).toMatch(/respond to theirs|turn to respond/i);
  });

  it('tells the assistant to answer normally (no length cap / adversarial framing)', () => {
    const note = buildBattleAwareness('Echo');
    expect(note).toMatch(/normally/i);
    // Must NOT reintroduce the old ~150-word cap or "battle with" adversarial framing.
    expect(note).not.toMatch(/150 words|be concise and high-signal|battle with/i);
  });

  it('falls back cleanly when the rival name is empty and appends with blank lines', () => {
    const note = buildBattleAwareness('');
    expect(note).toContain('another assistant');
    expect(note.startsWith('\n\n')).toBe(true);
  });
});

// Resolve-once contract (DESIGN-MULTI-ASSISTANT-TURN-ENGINE): the fan-out
// resolves each side's variant ONCE and stamps it into battleContext; the worker
// consumes these fields (variantModelKey for the model, variantAddendum as
// normal persona, rivalDisplayName for the rebuttal note) without a second
// resolution. This pins the payload shape the worker reads.
describe('resolve-once battleContext shape', () => {
  it('a round-2 payload carries the resolved variant fields the worker consumes', () => {
    const ctx: BattleContextPayload = {
      battleId: 'b1',
      round: 2,
      totalRounds: 2,
      selfBotArn: ALT_SLOT,
      rivalBotArn: DEFAULT_BOT,
      rivalReply: 'The rival argued for option B',
      variantModelKey: 'opus',
      variantAddendum: 'Be terse and intuition-first.',
      selfDisplayName: 'Echo',
      rivalDisplayName: 'Atlas',
    };
    // The worker sources its model override from ctx.variantModelKey (no re-resolution).
    expect(ctx.variantModelKey).toBe('opus');
    // The rebuttal note the worker appends uses ctx.rivalDisplayName + ctx.rivalReply.
    const note = buildRebuttalContext(ctx.rivalDisplayName!, ctx.rivalReply!);
    expect(note).toContain('Atlas');
    expect(note).toContain('The rival argued for option B');
  });
});

describe('splitIntoChunks encoded-length Content budget', () => {
  // Pins the bug: Chime caps the URL-encoded Content length, not the raw
  // char count. A long answer split by raw length then encodeURIComponent
  // overflowed the cap and threw "Channel Messages size limit exceeded".
  function enc(s: string): number {
    return encodeURIComponent(s).length;
  }
  function stripWs(s: string): string {
    return s.split(/\s+/).join('');
  }

  it('every chunk stays within its ENCODED budget (not raw length)', () => {
    const unit = 'Cache the hot rows. Use a read-through layer.\n\n';
    let heavy = '';
    for (let i = 0; i < 120; i++) heavy += unit;
    heavy = heavy.trim();
    expect(heavy.length).toBeGreaterThan(2000);
    const first = 800;
    const rest = 1200;
    const chunks = splitIntoChunks(heavy, first, rest);
    expect(chunks.length).toBeGreaterThan(1);
    expect(enc(chunks[0])).toBeLessThanOrEqual(first);
    for (let i = 1; i < chunks.length; i++) {
      expect(enc(chunks[i])).toBeLessThanOrEqual(rest);
    }
    expect(stripWs(chunks.join(''))).toBe(stripWs(heavy));
  });

  it('one chunk when the response already fits encoded', () => {
    const small = 'short answer';
    expect(splitIntoChunks(small, 4096)).toEqual([small]);
  });

  it('always makes progress on a degenerate tiny budget', () => {
    const chunks = splitIntoChunks('aaaa bbbb cccc dddd eeee ffff', 5);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
  });
});
