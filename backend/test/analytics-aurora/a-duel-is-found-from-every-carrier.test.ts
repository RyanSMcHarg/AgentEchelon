/**
 * A DUEL IS FOUND FROM THE ID EVERY BATTLE REPLY CARRIES.
 *
 * The slimmed channel-message Metadata carries the duel as the scalar `battleId`; the full
 * `battleContext` rides only the out-of-band analytics record. Archival read only the object, so a reply
 * whose out-of-band record had not arrived was stored with no duel although its own Metadata named one.
 * These pin the writer (`battleIdOf`), the reader (`resolveBattleChannels` reads the columns), and the
 * repair (migration 073).
 */
jest.mock('../../lambda/src/lib/message-analytics', () => ({
  readMessageAnalytics: jest.fn(async () => null),
  writeMessageAnalytics: jest.fn(async () => undefined),
}));

jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  batchInsert: jest.fn(async () => 0),
  query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  transaction: jest.fn(),
  ensureSchema: jest.fn(),
  resetConnection: jest.fn(),
  isAuthError: jest.fn(() => false),
}));

import * as fs from 'fs';
import * as path from 'path';
import { battleIdOf, transformToMessageRecord } from '../../lambda/src/analytics-aurora/kinesis-archival';

const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c-duel';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/default';
const HUMAN = 'arn:aws:chime:us-east-1:1:app-instance/i/user/u1';

const event = (sender: string, metadata: Record<string, unknown>) => ({
  EventType: 'CREATE_CHANNEL_MESSAGE',
  Payload: {
    MessageId: 'm-side-a',
    ChannelArn: CHANNEL,
    Content: 'Here is my answer.',
    Sender: { Arn: sender, Name: 'Side' },
    CreatedTimestamp: '2026-10-12T10:00:03.000Z',
    Persistence: 'PERSISTENT',
    Metadata: JSON.stringify(metadata),
  },
});

describe('battleIdOf', () => {
  it('reads every carrier, nested first', () => {
    expect(battleIdOf({ battleContext: { battleId: 'nested' } }, { battleId: 'flat' })).toBe('nested');
    expect(battleIdOf({}, { battleContext: { battleId: 'legacy' } })).toBe('legacy');
    expect(battleIdOf({ battleId: 'analytics-flat' }, {})).toBe('analytics-flat');
    expect(battleIdOf({}, { battleId: 'flat' })).toBe('flat');
  });

  it('answers null when no carrier names a duel, and ignores a blank id', () => {
    expect(battleIdOf({}, {})).toBeNull();
    expect(battleIdOf({}, { battleId: '  ' })).toBeNull();
    expect(battleIdOf({}, undefined)).toBeNull();
  });
});

describe('archival files a battle reply under its duel from the slimmed Metadata alone', () => {
  it('a bot reply with only the scalar id gets battle_id', async () => {
    const rec = await transformToMessageRecord(event(BOT, { battleId: 'btl-1', battleRound: 1 }) as never);
    expect(rec?.battle_id).toBe('btl-1');
  });

  it("never reads a duel off a person's message", async () => {
    const rec = await transformToMessageRecord(event(HUMAN, { battleId: 'btl-1' }) as never);
    expect(rec?.battle_id).toBeNull();
  });
});

describe('the reader and the repair', () => {
  const src = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

  it('resolveBattleChannels reads the battle_id columns, not one JSON path', () => {
    const q = src('lambda/src/analytics-aurora/analytics-query.ts');
    const fn = q.slice(q.indexOf('async function resolveBattleChannels'), q.indexOf('async function resolveBattleChannels') + 1500);
    expect(fn).toMatch(/COALESCE\(e\.battle_id, m\.battle_id\)/);
    expect(fn).not.toMatch(/battleContext'->>'battleId'/);
  });

  it('migration 073 is bounded, resumable, reads bot rows only and fills only NULLs', () => {
    const sql = src('lambda/src/analytics-aurora/schema/073-a-duel-is-found-from-the-id-every-reply-carries.sql');
    const code = sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    expect(code).toMatch(/LIMIT batch_size/);
    expect(code).toMatch(/INSERT INTO _migration_progress[\s\S]*'073-a-duel-is-found-from-the-id-every-reply-carries\.sql'/);
    expect(code).toMatch(/m\.is_bot = TRUE/);
    expect(code).toMatch(/battle_id\s+= COALESCE\(tgt\.battle_id,/);
    expect(code).toMatch(/battle_id\s+= COALESCE\(c\.battle_id, u\.battle_id\)/);
    expect(code).toMatch(/battle_id\s+= COALESCE\(ex\.battle_id, m\.battle_id\)/);
    expect(code).not.toMatch(/CONCURRENTLY/);
  });
});
