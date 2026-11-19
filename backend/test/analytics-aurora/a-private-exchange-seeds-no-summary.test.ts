/**
 * A PRIVATE EXCHANGE SEEDS NO SUMMARY.
 *
 * The running summary is read by every later turn in the room, so it is built only from what the room can read: the
 * summarizer keeps a targeted message out (`target_arn IS NULL`), and the first exchange that seeds the summary is held
 * to the same rule. The exchange is private when the turn's task is private or the person's message carries a Target
 * (the reply mirrors it), and a message whose Target cannot be read counts as private.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { requestVisibility } from '../../lambda/src/lib/task-visibility';

const src = readFileSync(join(__dirname, '../../lambda/src/assistant-async-processor.ts'), 'utf8');
const seedCall = src.indexOf('await seedConversationSummary(');
const gate = src.slice(src.lastIndexOf('if (pipeline.earlyInConversation', seedCall), seedCall);
const helperAt = src.lastIndexOf('const exchangeIsPrivate', seedCall);
const helper = src.slice(helperAt, src.indexOf('if (pipeline.earlyInConversation', helperAt));

describe('the first summary is seeded only from an exchange the room can read', () => {
  it('the seed waits on the exchange being public, beside the guardrail\'s refusal', () => {
    expect(gate).toContain('!bedrockResult.inputGuardBlocked');
    expect(gate).toContain('!(await exchangeIsPrivate())');
  });

  it('a private task or a targeted message makes the exchange private', () => {
    expect(helperAt).toBeGreaterThan(-1);
    expect(helper).toMatch(/isPrivateVisibility\(taskContext\.task\.visibility\)/);
    expect(helper).toMatch(/requestVisibility\(messagingClient, event\.channelArn, event\.userMessageId, event\.botArn\)\)\s*===\s*'private'/);
  });
});

describe('what the stored message says about its audience', () => {
  const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/a/channel/c';
  const BOT = 'arn:aws:chime:us-east-1:1:app-instance/a/bot/advisor';
  const PERSON = 'arn:aws:chime:us-east-1:1:app-instance/a/user/p1';
  const clientAnswering = (answer: () => unknown) => ({ send: async () => answer() }) as never;

  it('a message sent to the room is public', async () => {
    expect(await requestVisibility(clientAnswering(() => ({ ChannelMessage: {} })), CHANNEL, 'm1', BOT)).toBe('conversation');
  });

  it('a message carrying a Target is private', async () => {
    expect(await requestVisibility(clientAnswering(() => ({ ChannelMessage: { Target: [{ MemberArn: BOT }] } })), CHANNEL, 'm1', BOT)).toBe('private');
    expect(await requestVisibility(clientAnswering(() => ({ ChannelMessage: { Target: [{ MemberArn: PERSON }] } })), CHANNEL, 'm1', BOT)).toBe('private');
  });

  it('a message with no id, or one that cannot be read, is private', async () => {
    expect(await requestVisibility(clientAnswering(() => ({ ChannelMessage: {} })), CHANNEL, undefined, BOT)).toBe('private');
    const refused = clientAnswering(() => { throw Object.assign(new Error('nope'), { name: 'ServiceFailureException' }); });
    expect(await requestVisibility(refused, CHANNEL, 'm1', BOT)).toBe('private');
  });
});
