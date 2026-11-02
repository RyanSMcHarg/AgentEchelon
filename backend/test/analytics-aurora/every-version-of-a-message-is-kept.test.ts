/**
 * EVERY VERSION OF A MESSAGE IS KEPT (SPEC-ADMIN-CONSOLE FR55, migration 070).
 *
 * An edit arrives as its own UPDATE event, and the fold overwrites `updated_content` with the latest,
 * so without a list every version between the original and the latest is lost from the CREATE row -
 * and a reply may have answered any of them. Each update appends its text to the CREATE row's
 * `content_versions`, on the message's own row so the read-time redaction join covers it (migration
 * 068). Each update is also its own row (migration 084); the list is the ordered read beside the original.
 */
jest.mock('../../lambda/src/analytics-aurora/db-client', () => ({
  query: jest.fn(),
  ownerQuery: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  transaction: jest.fn(async (fn: () => Promise<unknown>) => fn()),
  batchInsert: jest.fn(async () => 1),
  ensureSchema: jest.fn(),
  resetConnection: jest.fn(),
  isAuthError: jest.fn(() => false),
}));

import * as fs from 'fs';
import * as path from 'path';
import { query } from '../../lambda/src/analytics-aurora/db-client';
import { backfillFromUpdateEvents } from '../../lambda/src/analytics-aurora/kinesis-archival';
import { adminListMessages } from '../../lambda/src/analytics-aurora/admin-conversations-aurora';

const mockedQuery = query as jest.MockedFunction<typeof query>;
const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/a/channel/c-edits';

const update = (content: string, at: string) => ({
  message_id: 'm1-UPD', channel_arn: CHANNEL, content, created_at: '2026-10-10T00:00:00Z', last_updated_at: at,
});

/** The version-append statement, and its parameters, among everything the fold ran. */
const appends = () => mockedQuery.mock.calls
  .filter((c) => /content_versions = COALESCE\(content_versions/.test(String(c[0])))
  .map((c) => ({ sql: String(c[0]), params: c[1] as unknown[] }));

describe('archiving an edit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never);
  });

  it('appends each update to the CREATE row, so a second edit does not replace the first', async () => {
    await backfillFromUpdateEvents([update('second', '2026-10-10T00:01:00Z'), update('third', '2026-10-10T00:02:00Z')] as never);
    const a = appends();
    expect(a).toHaveLength(2);
    expect(JSON.parse(String(a[0].params[0]))).toEqual([{ at: '2026-10-10T00:01:00Z', content: 'second' }]);
    expect(JSON.parse(String(a[1].params[0]))).toEqual([{ at: '2026-10-10T00:02:00Z', content: 'third' }]);
    // The CREATE row, by its base id: the redaction join keys on it.
    expect(a[0].params.slice(1)).toEqual(['m1', CHANNEL]);
    expect(a[0].sql).toMatch(/event_type = 'CREATE_CHANNEL_MESSAGE'/);
  });

  it('appends nothing for a redelivered update', async () => {
    await backfillFromUpdateEvents([update('second', '2026-10-10T00:01:00Z')] as never);
    expect(appends()[0].sql).toMatch(/NOT \(COALESCE\(content_versions, '\[\]'::jsonb\) @> \$1::jsonb\)/);
  });

  it('is added by a migration, on the messages table and no other', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'schema', '070-every-version-of-a-message.sql'), 'utf8');
    expect(sql).toMatch(/ALTER TABLE messages ADD COLUMN IF NOT EXISTS content_versions JSONB/);
    expect(sql).not.toMatch(/CREATE TABLE/);
  });
});

describe('reading an edited message', () => {
  const row = (over: Record<string, unknown>) => ({
    message_id: 'm1', content: 'third', original_content: 'first', sender_arn: 'a/user/1', sender_name: 'Ada',
    created_at: '2026-10-10T00:00:00Z', is_bot: false, metadata: {}, redacted: false, deleted: false,
    content_versions: [{ at: '2026-10-10T00:01:00Z', content: 'second' }, { at: '2026-10-10T00:02:00Z', content: 'third' }],
    ...over,
  });
  beforeEach(() => jest.clearAllMocks());

  it('returns every version, the original first and the latest last', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [row({})], rowCount: 1 } as never);
    const [m] = await adminListMessages(CHANNEL);
    expect(m.content).toBe('third');
    expect(m.versions?.map((v) => v.content)).toEqual(['first', 'second', 'third']);
    expect(m.versions?.[0].at).toBe('2026-10-10T00:00:00Z');
  });

  it('returns no versions for a message never edited', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [row({ content: 'first', content_versions: null })], rowCount: 1 } as never);
    const [m] = await adminListMessages(CHANNEL);
    expect(m.versions).toBeUndefined();
  });

  it.each([['redacted'], ['deleted']])('returns no version of a %s message', async (state) => {
    mockedQuery.mockResolvedValueOnce({ rows: [row({ [state]: true })], rowCount: 1 } as never);
    const [m] = await adminListMessages(CHANNEL);
    expect(m.versions).toBeUndefined();
    expect(JSON.stringify(m)).not.toMatch(/first|second|third/);
  });
});
