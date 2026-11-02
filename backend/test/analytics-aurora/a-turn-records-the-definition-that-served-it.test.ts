/**
 * A TURN RECORDS THE NAME OF THE DEFINITION THAT SERVED IT (migration 091), beside its version and config id.
 *
 * The name was read only as `metadata->>'profileName'`. The full analytics record reaches the archive on the
 * update event, and the row an exchange joins to is the placeholder's CREATE, onto which only columns fold,
 * so on that row the key was empty and the experiment drill-down and the intent breakdown named no
 * definition. Archival now writes `profile_name` from the analytics record, folds it onto the CREATE row,
 * and copies it onto the exchange; the readers take the column first and the metadata key after it.
 */
const mockReadAnalytics = jest.fn();
jest.mock('../../lambda/src/lib/message-analytics', () => ({
  readMessageAnalytics: (...args: unknown[]) => mockReadAnalytics(...args),
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
jest.mock('../../lambda/src/analytics-aurora/drift-detection', () => ({
  detectDrift: jest.fn(),
  recordDriftFire: jest.fn(),
}));
jest.mock('../../lambda/src/analytics-aurora/cross-conversation-context', () => ({
  updateConversationContext: jest.fn(),
}));
jest.mock('../../lambda/src/lib/sleep-mode', () => ({
  touchActivity: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';
import { query } from '../../lambda/src/analytics-aurora/db-client';
import { transformToMessageRecord, backfillFromUpdateEvents } from '../../lambda/src/analytics-aurora/kinesis-archival';

const mockedQuery = query as jest.MockedFunction<typeof query>;
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

const APP = 'arn:aws:chime:us-east-1:1:app-instance/i';
/** A bot answer whose inline Metadata is the client's slim set: no profile name. */
const botEvent = (eventType: string) => ({
  EventType: eventType,
  Payload: {
    MessageId: 'm-1', ChannelArn: `${APP}/channel/c1`, Content: 'An answer.',
    Sender: { Arn: `${APP}/bot/advisor`, Name: 'Advisor' },
    CreatedTimestamp: '2026-10-27T10:00:00.000Z', LastUpdatedTimestamp: '2026-10-27T10:00:02.000Z',
    Persistence: 'PERSISTENT',
    Metadata: JSON.stringify({ botResponse: true, experimentId: 'exp-1', variantId: 'treatment', respPhase: 'final' }),
  },
});

beforeEach(() => {
  mockReadAnalytics.mockReset();
  mockedQuery.mockClear();
});

describe('archival writes the served definition from the analytics record', () => {
  it('takes the name from the out-of-band record when the inline Metadata lacks it', async () => {
    mockReadAnalytics.mockResolvedValue({
      profileName: 'alt-primary-premium', profileVersion: 4, profileConfigId: 'cfg-cand',
    });
    const rec = await transformToMessageRecord(botEvent('UPDATE_CHANNEL_MESSAGE') as never);
    expect(rec?.profile_name).toBe('alt-primary-premium');
    expect(rec?.profile_version).toBe(4);
    expect(rec?.profile_config_id).toBe('cfg-cand');
  });

  it('records null, never a guess, when no record names one', async () => {
    mockReadAnalytics.mockResolvedValue(null);
    const rec = await transformToMessageRecord(botEvent('CREATE_CHANNEL_MESSAGE') as never);
    expect(rec?.profile_name).toBeNull();
  });

  it('folds the name onto the CREATE row an exchange joins to', async () => {
    mockReadAnalytics.mockResolvedValue({ profileName: 'alt-primary-premium', profileVersion: 4, profileConfigId: 'cfg-cand' });
    const upd = await transformToMessageRecord(botEvent('UPDATE_CHANNEL_MESSAGE') as never);
    expect(upd).toBeTruthy();
    await backfillFromUpdateEvents([upd!]);
    const fold = mockedQuery.mock.calls.find(([sql]) => /UPDATE messages/.test(String(sql)) && /profile_name/.test(String(sql)));
    expect(fold).toBeTruthy();
    const [sql, params] = fold as unknown as [string, unknown[]];
    expect(sql).toMatch(/profile_name\s*=\s*COALESCE\(\$33, profile_name\)/);
    expect(params[32]).toBe('alt-primary-premium');
  });
});

describe('the writers, the readers and the migration', () => {
  it('both exchange writers that carry the profile dimensions copy the name off the answering message', () => {
    const src = read('lambda/src/analytics-aurora/kinesis-archival.ts');
    expect(src).toMatch(/assistant_role, profile_version, profile_config_id, profile_name,\s*\n\s*battle_id, battle_round,/g);
    expect(src.match(/assistant_role, profile_version, profile_config_id, profile_name,/g)).toHaveLength(2);
    expect(src).toMatch(/am\.profile_config_id,\s*am\.profile_name,/);
    expect(src).toMatch(/COALESCE\(am_upd\.profile_name, am\.profile_name\)/);
    expect(src).toMatch(/'profile_config_id',\s*'profile_name',/);
  });

  it('every read of the name takes the column first and the metadata key after it', () => {
    const q = read('lambda/src/analytics-aurora/analytics-query.ts');
    expect(q).toContain("name: `COALESCE(e.profile_name, m.profile_name, m.metadata->>'profileName')`");
    // No query reads the metadata key on its own any more.
    const bare = q.split('\n').filter((l) => l.includes("m.metadata->>'profileName'") && !l.includes('COALESCE(e.profile_name'));
    expect(bare).toEqual([]);
  });

  it('091 adds the column to both turn tables, idempotently, with no data step', () => {
    const sql = read('lambda/src/analytics-aurora/schema/091-a-turn-records-the-definition-that-served-it.sql');
    const code = sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    expect(code).toMatch(/ALTER TABLE messages\s+ADD COLUMN IF NOT EXISTS profile_name VARCHAR\(128\)/);
    expect(code).toMatch(/ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS profile_name VARCHAR\(128\)/);
    expect(code).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/i);
  });
});
