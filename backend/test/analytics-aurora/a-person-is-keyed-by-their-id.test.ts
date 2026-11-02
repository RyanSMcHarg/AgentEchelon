/**
 * A PERSON IS KEYED BY THEIR ID ON THE TURN TABLES (ADR-043 decision 4, migrations 074 and 079).
 *
 * `messages.person_id` is the sender's bare AppInstanceUser id, the shape drift_events already stores; an
 * assistant's message leaves it null, because the assistant is `agent_type`. Every exchange writer copies
 * the asking person's id off the user message it pairs. 074 adds the column (as `user_sub`) without
 * replacing the view and backfills in bounded, resumable batches; 079 renames it, and every other person
 * column, to `person_id`, and drops `conversations.user_id`.
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
import { transformToMessageRecord } from '../../lambda/src/analytics-aurora/kinesis-archival';

const APP = 'arn:aws:chime:us-east-1:1:app-instance/i';
const event = (senderArn: string) => ({
  EventType: 'CREATE_CHANNEL_MESSAGE',
  Payload: {
    MessageId: 'm-1', ChannelArn: `${APP}/channel/c1`, Content: 'hello there',
    Sender: { Arn: senderArn, Name: 'Someone' }, CreatedTimestamp: '2026-10-12T10:00:00.000Z', Persistence: 'PERSISTENT',
  },
});

describe('a message names its sender by id', () => {
  it("records a person's id, the admin plane's turn under the person who holds it, and a federated sender's", async () => {
    for (const [arn, sub] of [
      [`${APP}/user/0a1b2c3d-0000-4000-8000-000000000001`, '0a1b2c3d-0000-4000-8000-000000000001'],
      // The admin-plane twin's turn is filed under its owner, so it is counted and erased with them;
      // `user_role` still says it was the admin plane.
      [`${APP}/user/0a1b2c3d-0000-4000-8000-000000000001-admin`, '0a1b2c3d-0000-4000-8000-000000000001'],
      [`${APP}/user/fed_abc`, 'fed_abc'],
    ]) {
      const rec = await transformToMessageRecord(event(arn) as never);
      expect({ arn, sub: rec?.person_id }).toEqual({ arn, sub });
    }
  });

  it("leaves an assistant's message without one", async () => {
    const rec = await transformToMessageRecord(event(`${APP}/bot/advisor`) as never);
    expect(rec?.person_id).toBeNull();
  });
});

describe('the writers and the migration', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

  it('every exchange writer copies the asking person off the user message', () => {
    const src = read('lambda/src/analytics-aurora/kinesis-archival.ts');
    const inserts = src.split('INSERT INTO exchanges (').slice(1);
    expect(inserts.length).toBe(3);
    for (const ins of inserts) {
      expect(ins.slice(0, 300)).toContain('user_role, person_id, assistant');
      expect(ins).toMatch(/um\.user_role,\s*um\.person_id,/);
    }
    expect(src).toMatch(/'user_role',\s*'person_id',/);
    expect(src).not.toMatch(/\buser_sub\b/);
  });

  it('074 adds without replacing the view, and backfills in bounded, resumable batches', () => {
    const sql = read('lambda/src/analytics-aurora/schema/074-a-person-is-keyed-by-their-id.sql');
    const code = sql.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
    expect(code).toMatch(/ALTER TABLE messages\s+ADD COLUMN IF NOT EXISTS user_sub/);
    expect(code).toMatch(/ALTER TABLE exchanges ADD COLUMN IF NOT EXISTS user_sub/);
    expect(code).not.toMatch(/CREATE OR REPLACE VIEW/);
    expect(code).not.toMatch(/CONCURRENTLY/);
    expect(code.match(/LIMIT batch_size/g)).toHaveLength(2);
    expect(code).toContain("'074-a-person-is-keyed-by-their-id.sql'");
    expect(code).toMatch(/m\.is_bot = FALSE/);
  });
});

describe('079: a person key says it is a person', () => {
  const root = path.join(__dirname, '..', '..');
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  const SQL = 'lambda/src/analytics-aurora/schema/079-a-person-key-says-it-is-a-person.sql';
  const code = () => read(SQL).replace(/--[^\n]*/g, '');

  it('renames the person column in every table that carries it, guarded so a re-run is a no-op', () => {
    const sql = code();
    for (const table of [
      'client_events', 'cross_conversation_context', 'channel_membership', 'drift_events',
      'conversation_creation_tasks', 'messages', 'exchanges',
    ]) {
      expect(sql).toContain(`table_name = '${table}' AND column_name = 'user_sub'`);
      expect(sql).toContain(`table_name = '${table}' AND column_name = 'person_id'`);
      expect(sql).toContain(`ALTER TABLE ${table} RENAME COLUMN user_sub TO person_id;`);
    }
    expect(sql).toMatch(/column_name = 'user_sub'/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM information_schema\.columns[\s\S]*column_name = 'person_id'\)/);
    // Indexes are renamed only when the old one exists and the new one does not.
    expect(sql).toMatch(/to_regclass\(pair\[1\]\) IS NOT NULL AND to_regclass\(pair\[2\]\) IS NULL/);
  });

  it('drops conversations.user_id and its index, and restates the column comments', () => {
    const sql = code();
    expect(sql).toContain('DROP INDEX IF EXISTS idx_conversations_user_id;');
    expect(sql).toContain('ALTER TABLE conversations DROP COLUMN IF EXISTS user_id;');
    expect(sql).toMatch(/COMMENT ON COLUMN messages\.person_id IS/);
    expect(sql).toMatch(/COMMENT ON COLUMN exchanges\.person_id IS/);
    expect(sql).toContain('Never a Cognito sub');
  });

  it('is transaction-safe and touches no rows', () => {
    const sql = code();
    expect(sql).not.toMatch(/CONCURRENTLY/i);
    expect(sql).not.toMatch(/\bVACUUM\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE VIEW/);
  });

  it('leaves no reader of the old names', () => {
    const files = [
      'lambda/src/analytics-aurora/analytics-query.ts',
      'lambda/src/analytics-aurora/client-events-ingest.ts',
      'lambda/src/analytics-aurora/cross-conversation-context.ts',
      'lambda/src/analytics-aurora/drift-detection.ts',
      'lambda/src/analytics-aurora/kinesis-archival.ts',
      'lambda/src/lib/routing-state.ts',
      'lambda/src/analytics-query.ts',
      'lambda/src/client-events.ts',
    ];
    for (const f of files) {
      expect({ f, hit: /\buser_sub\b|\buser_email\b|\buser_id\b/.test(read(f)) }).toEqual({ f, hit: false });
    }
  });
});
