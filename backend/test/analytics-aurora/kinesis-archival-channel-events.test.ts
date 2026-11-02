/**
 * kinesis-archival — channel-lifecycle event parsing.
 *
 * Chime streams CREATE/UPDATE/DELETE_CHANNEL with the channel fields at the TOP
 * LEVEL of Payload (ChannelArn, Name, Metadata, CreatedBy, timestamps, Mode,
 * Privacy) — the same convention as message/membership events, NOT nested under
 * Payload.Channel. The transform previously read Payload.Channel and dropped every
 * channel event ("missing Channel payload"), so Aurora held no channel name or
 * lifecycle rows: titles fell back to the first user message and archived/deleted
 * conversation state could not be derived. These tests pin the top-level parse
 * (with the nested shape kept as a defensive fallback).
 */
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: jest.fn(),
  transaction: jest.fn(),
  batchInsert: jest.fn(),
  ensureSchema: jest.fn(),
  resetConnection: jest.fn(),
  isAuthError: jest.fn(() => false),
}));

import { transformToMessageRecord } from '../../lambda/src/analytics-aurora/kinesis-archival';
import { withTurnDeclaration } from '../../lambda/src/lib/turn-declaration';
// The names are deployment configuration, so a hardcoded one would fail the day a deployment renamed
// its profiles - reporting a config change as a contract break.
import { defaultProfileRegistry } from '../../lib/profile-registry';

const CH = 'arn:aws:chime:us-east-1:1:app-instance/a/channel/c1';

describe('kinesis-archival channel-event parsing', () => {
  it('parses a top-level CREATE_CHANNEL payload (name + creator + mode)', async () => {
    const rec = await transformToMessageRecord({
      EventType: 'CREATE_CHANNEL',
      Payload: {
        Privacy: 'PRIVATE', Mode: 'RESTRICTED', Name: 'Q3 Forecast',
        ChannelArn: CH, Metadata: JSON.stringify({ kind: 'chat' }),
        CreatedBy: { Name: 'Ada', Arn: 'a/user/1' },
        CreatedTimestamp: '2026-07-18T00:00:00Z', LastUpdatedTimestamp: '2026-07-18T00:00:00Z',
      },
    } as any);
    expect(rec).not.toBeNull();
    expect(rec!.event_type).toBe('CREATE_CHANNEL');
    expect(rec!.channel_arn).toBe(CH);
    expect(rec!.content).toBe('Q3 Forecast'); // channel name is archived in content
    expect(rec!.sender_name).toBe('Ada');
    expect(rec!.metadata).toMatchObject({ kind: 'chat', channelMode: 'RESTRICTED', channelPrivacy: 'PRIVATE' });
  });

  it('parses UPDATE_CHANNEL carrying the archived metadata mirror', async () => {
    const rec = await transformToMessageRecord({
      EventType: 'UPDATE_CHANNEL',
      Payload: {
        Name: 'Q3 Forecast', ChannelArn: CH,
        Metadata: JSON.stringify({ kind: 'chat', archived: true }),
        CreatedBy: { Name: 'Ada', Arn: 'a/user/1' },
        CreatedTimestamp: '2026-07-18T00:00:00Z', LastUpdatedTimestamp: '2026-07-18T02:00:00Z',
      },
    } as any);
    expect(rec).not.toBeNull();
    // The archived flag must survive so the read path can derive 'archived' state.
    expect(rec!.metadata).toMatchObject({ archived: true });
    // UPDATE sorts after CREATE: created_at reflects LastUpdatedTimestamp, not create time.
    expect(rec!.created_at).toBe('2026-07-18T02:00:00Z');
  });

  it('parses DELETE_CHANNEL (top-level ARN) so deleted state can be derived', async () => {
    const rec = await transformToMessageRecord({
      EventType: 'DELETE_CHANNEL',
      Payload: {
        Name: 'Q3 Forecast', ChannelArn: CH, Metadata: '{}',
        CreatedBy: { Name: 'Ada', Arn: 'a/user/1' },
        CreatedTimestamp: '2026-07-18T00:00:00Z', LastUpdatedTimestamp: '2026-07-18T03:00:00Z',
      },
    } as any);
    expect(rec).not.toBeNull();
    expect(rec!.event_type).toBe('DELETE_CHANNEL');
    expect(rec!.channel_arn).toBe(CH);
  });

  it('still parses the legacy nested Payload.Channel shape', async () => {
    const rec = await transformToMessageRecord({
      EventType: 'CREATE_CHANNEL',
      Payload: {
        Channel: {
          ChannelArn: CH, Name: 'Nested', Mode: 'RESTRICTED', Privacy: 'PRIVATE',
          Metadata: '{}', CreatedBy: { Name: 'Ada', Arn: 'a/user/1' },
          CreatedTimestamp: '2026-07-18T00:00:00Z', LastUpdatedTimestamp: '2026-07-18T00:00:00Z',
        },
      },
    } as any);
    expect(rec).not.toBeNull();
    expect(rec!.content).toBe('Nested');
    expect(rec!.channel_arn).toBe(CH);
  });

  it('gives two same-type channel events distinct message_ids (no batch collision)', async () => {
    // A rename UPDATE_CHANNEL followed by the archived-metadata UPDATE_CHANNEL for the
    // same channel in one batch must NOT collide — else `ON CONFLICT (message_id,
    // channel_arn) DO NOTHING` drops the archived one and archived state is lost.
    const rename = await transformToMessageRecord({
      EventType: 'UPDATE_CHANNEL',
      Payload: { Name: 'Renamed', ChannelArn: CH, Metadata: '{}',
        CreatedTimestamp: '2026-07-18T00:00:00Z', LastUpdatedTimestamp: '2026-07-18T02:00:00Z' },
    } as any);
    const archived = await transformToMessageRecord({
      EventType: 'UPDATE_CHANNEL',
      Payload: { Name: 'Renamed', ChannelArn: CH, Metadata: JSON.stringify({ archived: true }),
        CreatedTimestamp: '2026-07-18T00:00:00Z', LastUpdatedTimestamp: '2026-07-18T02:00:01Z' },
    } as any);
    expect(rename!.message_id).not.toBe(archived!.message_id);
  });

  it('is idempotent: the same channel event yields the same message_id (dedup on replay)', async () => {
    const ev = { EventType: 'UPDATE_CHANNEL', Payload: { Name: 'Q', ChannelArn: CH,
      Metadata: JSON.stringify({ archived: true }), LastUpdatedTimestamp: '2026-07-18T02:00:00Z' } } as any;
    const a = await transformToMessageRecord(ev);
    const b = await transformToMessageRecord(ev);
    expect(a!.message_id).toBe(b!.message_id);
  });

  it('drops a channel event with no resolvable ARN', async () => {
    const rec = await transformToMessageRecord({
      EventType: 'CREATE_CHANNEL',
      Payload: { Name: 'no arn' },
    } as any);
    expect(rec).toBeNull();
  });

  /**
   * THE ASSISTANT A LEX-ENTRY ANSWER DECLARED IN ITS CONTENT.
   *
   * A Lex-entry answer is materialized by Amazon Chime SDK from the fulfillment return and carries NO
   * message metadata, so `analytics.agentType` is absent and there is nowhere else for the responder's
   * identity to ride. Two such returns carry a correlation marker and are therefore COUNTED as turns -
   * the DIRECT quick answer and the drift-spawned welcome - and both landed with a NULL `agent_type`
   * that the latency query renders as an unknown assistant.
   *
   * Asserted on the record archival builds, not on the parser, because the parser round-trip passed
   * while this fold did not exist: removing the fallback left every declaration-only turn unattributed
   * and no test noticed.
   */
  describe('the assistant on a turn with no metadata channel', () => {
    const botMessage = (content: string) => ({
      EventType: 'CREATE_CHANNEL_MESSAGE',
      Payload: {
        MessageId: 'm-direct-1',
        ChannelArn: CH,
        Content: content,
        Sender: { Arn: 'a/bot/assistant-standard', Name: 'Assistant' },
        CreatedTimestamp: '2026-07-18T00:00:00Z',
        LastUpdatedTimestamp: '2026-07-18T00:00:00Z',
        Persistence: 'PERSISTENT',
        Type: 'STANDARD',
      },
    });

    it('folds a declared assistant onto assistant when metadata carries none', async () => {
      const name = defaultProfileRegistry.profileNames()[0];
      const rec = await transformToMessageRecord(
        botMessage(withTurnDeclaration('4', { phase: 'final', assistant: name })) as any,
      );
      expect(rec).not.toBeNull();
      expect(rec!.assistant).toBe(name);
    });

    it('leaves assistant NULL when nothing declared one, rather than guessing from the ARN', async () => {
      // The ARN says `assistant-standard`, and substring-matching it is exactly the guess this column
      // stopped making: it cannot be right about a deployment whose bots are named anything else, and
      // every miss landed as a row that looked like a measurement.
      const rec = await transformToMessageRecord(botMessage('plain answer, no declaration') as any);
      expect(rec).not.toBeNull();
      expect(rec!.assistant).toBeNull();
    });

    it('does not accept an assistant this deployment never declared', async () => {
      const rec = await transformToMessageRecord(
        botMessage(withTurnDeclaration('hi', { assistant: 'not-a-real-assistant' })) as any,
      );
      expect(rec).not.toBeNull();
      expect(rec!.assistant).toBeNull();
    });
  });
});
