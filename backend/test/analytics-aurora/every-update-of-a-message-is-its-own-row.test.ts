/**
 * EVERY UPDATE OF A MESSAGE IS ITS OWN ROW (migration 084, update-events.ts).
 *
 * The archive is a stream of events, and an event is never updated (tenet D7). Archival keyed every
 * update of a message as one fixed `<MessageId>-UPD` row, so a second update collided with the first and
 * `ON CONFLICT (message_id, channel_arn) DO NOTHING` dropped it. Seen live: a placeholder that became the
 * queue notice and then a receipt kept `turn_kind = queue_ack` and lost `receipt`.
 *
 * Pinned here: the key (one row per event, the same row for a redelivery), the in-batch choice, and the
 * choice each reader makes between a message's LATEST update and its FIRST. The SQL is checked as text,
 * as every sibling here checks it: there is no Postgres in the unit suite.
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
jest.mock('../../lambda/src/analytics-aurora/drift-detection', () => ({
  detectDrift: jest.fn(),
  recordDriftFire: jest.fn(),
}));
jest.mock('../../lambda/src/analytics-aurora/cross-conversation-context', () => ({
  updateConversationContext: jest.fn(),
}));
jest.mock('../../lambda/src/analytics-aurora/turn-events-live', () => ({
  ...jest.requireActual('../../lambda/src/analytics-aurora/turn-events-live'),
  writeTurnEvents: jest.fn(),
}));
jest.mock('../../lambda/src/lib/message-analytics', () => ({
  readMessageAnalytics: jest.fn(async () => null),
}));
jest.mock('../../lambda/src/lib/sleep-mode', () => ({
  touchActivity: jest.fn(),
}));
jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  recordMemberCount: jest.fn(),
  getChannelContext: jest.fn(async () => null),
  putChannelContext: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';
import { query, batchInsert } from '../../lambda/src/analytics-aurora/db-client';
import {
  handler,
  transformToMessageRecord,
  backfillFromUpdateEvents,
  latestUpdateInBatch,
} from '../../lambda/src/analytics-aurora/kinesis-archival';
import {
  updateEventMessageId,
  baseMessageIdOf,
  isUpdateEventId,
  updateJoinSql,
  supersededUpdateSql,
} from '../../lambda/src/analytics-aurora/update-events';
import { ledgerRowsFor } from '../../lambda/src/analytics-aurora/turn-events-live';

const mockedQuery = query as jest.MockedFunction<typeof query>;
const mockedInsert = batchInsert as jest.MockedFunction<typeof batchInsert>;

const SRC = path.resolve(__dirname, '../../lambda/src/analytics-aurora');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');
const flat = (s: string) => s.replace(/\s+/g, ' ');
const sqlOnly = (s: string) => s.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');

const APP = 'arn:aws:chime:us-east-1:1:app-instance/a';
const CHANNEL = `${APP}/channel/c-updates`;
const PERSON = `${APP}/user/u-1`;
const BOT = `${APP}/bot/advisor`;
const USER_MSG = 'u'.repeat(64);

type ChimePayload = Record<string, unknown> & { LastUpdatedTimestamp?: string; CreatedTimestamp: string; Content?: string; Metadata?: string };
const payload = (over: Record<string, unknown>): ChimePayload => ({
  ChannelArn: CHANNEL, Persistence: 'PERSISTENT', Type: 'STANDARD',
  MessageId: 'ph-1', Sender: { Arn: BOT, Name: 'Advisor' }, CreatedTimestamp: '2026-10-21T06:33:07.225Z',
  ...over,
});

/** The placeholder becomes the queue notice, then is closed out as the receipt of a moved answer. */
const NOTICE = payload({
  Content: 'Still working on your earlier message.', LastUpdatedTimestamp: '2026-10-21T06:33:08.000Z',
  Metadata: JSON.stringify({ respPhase: 'notice', turnKind: 'queue_ack', acknowledges: 'q-1' }),
});
const RECEIPT = payload({
  Content: 'I have replied to you privately.', LastUpdatedTimestamp: '2026-10-21T06:33:16.238Z',
  Metadata: JSON.stringify({ answersMessageId: USER_MSG, turnKind: 'receipt', respPhase: 'final' }),
});

const kinesis = (eventType: string, p: Record<string, unknown>) => ({
  kinesis: { data: Buffer.from(JSON.stringify({ EventType: eventType, Payload: p })).toString('base64') },
});

describe('the key', () => {
  it('gives each update event its own row, keyed by the event', async () => {
    const notice = await transformToMessageRecord({ EventType: 'UPDATE_CHANNEL_MESSAGE', Payload: NOTICE } as never);
    const receipt = await transformToMessageRecord({ EventType: 'UPDATE_CHANNEL_MESSAGE', Payload: RECEIPT } as never);
    expect(notice!.message_id).toMatch(/^ph-1-UPD-[0-9a-f]{12}$/);
    expect(receipt!.message_id).toMatch(/^ph-1-UPD-[0-9a-f]{12}$/);
    expect(notice!.message_id).not.toBe(receipt!.message_id);
    // Both are about the same message, and each carries its own instant.
    expect([notice!.base_message_id, receipt!.base_message_id]).toEqual(['ph-1', 'ph-1']);
    expect([notice!.last_updated_at, receipt!.last_updated_at]).toEqual([NOTICE.LastUpdatedTimestamp, RECEIPT.LastUpdatedTimestamp]);
    expect([notice!.turn_kind, receipt!.turn_kind]).toEqual(['queue_ack', 'receipt']);
  });

  it('keys a redelivered event to the row it already wrote', async () => {
    const once = await transformToMessageRecord({ EventType: 'UPDATE_CHANNEL_MESSAGE', Payload: RECEIPT } as never);
    const again = await transformToMessageRecord({ EventType: 'UPDATE_CHANNEL_MESSAGE', Payload: { ...RECEIPT } } as never);
    expect(again!.message_id).toBe(once!.message_id);
    expect(updateEventMessageId('ph-1', RECEIPT)).toBe(once!.message_id);
  });

  it('tells apart two updates that differ only in metadata, or only in instant', () => {
    const base = { LastUpdatedTimestamp: '2026-10-21T06:33:08.000Z', Content: 'same', Metadata: '{}' };
    const ids = new Set([
      updateEventMessageId('m', base),
      updateEventMessageId('m', { ...base, Metadata: '{"turnKind":"receipt"}' }),
      updateEventMessageId('m', { ...base, LastUpdatedTimestamp: '2026-10-21T06:33:09.000Z' }),
    ]);
    expect(ids.size).toBe(3);
  });

  it('keeps the fixed suffixes on a redaction and a deletion, which are terminal facts', async () => {
    const red = await transformToMessageRecord({ EventType: 'REDACT_CHANNEL_MESSAGE', Payload: payload({}) } as never);
    const del = await transformToMessageRecord({ EventType: 'DELETE_CHANNEL_MESSAGE', Payload: payload({}) } as never);
    expect([red!.message_id, del!.message_id]).toEqual(['ph-1-RED', 'ph-1-DEL']);
    expect([red!.base_message_id, del!.base_message_id]).toEqual(['ph-1', 'ph-1']);
  });

  it('strips every archival suffix to the base id, the pre-084 fixed one included', () => {
    for (const id of ['ph-1', 'ph-1-UPD', 'ph-1-UPD-0123456789ab', 'ph-1-RED', 'ph-1-DEL']) {
      expect(baseMessageIdOf(id)).toBe('ph-1');
    }
    expect(isUpdateEventId('ph-1-UPD')).toBe(true);
    expect(isUpdateEventId('ph-1-UPD-0123456789ab')).toBe(true);
    expect(isUpdateEventId('ph-1')).toBe(false);
    expect(isUpdateEventId('ph-1-RED')).toBe(false);
  });

  it('dates the ledger to the message, not to the row, for either shape', () => {
    const rows = ledgerRowsFor([{
      event_type: 'UPDATE_CHANNEL_MESSAGE', message_id: 'ph-1-UPD-0123456789ab', channel_arn: CHANNEL,
      sender_arn: BOT, is_bot: true, created_at: '2026-10-21T06:33:07.225Z',
      last_updated_at: '2026-10-21T06:33:16.238Z', resp_phase: 'final', content: 'x',
    } as never]);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.source_message_id).toBe('ph-1');
  });
});

describe('archiving a message with two updates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never);
  });

  /** Every row the batch inserted into `messages`, and the conflict clause it used. */
  const inserted = () => mockedInsert.mock.calls
    .filter(([table]) => table === 'messages')
    .map(([, cols, rows, conflict]) => ({ cols: cols as string[], rows: rows as Record<string, unknown>[], conflict }));

  it('inserts both updates, each with its base id and its own instant, and drops nothing on a redelivery', async () => {
    await handler({ Records: [kinesis('UPDATE_CHANNEL_MESSAGE', NOTICE), kinesis('UPDATE_CHANNEL_MESSAGE', RECEIPT)] } as never, { awsRequestId: 'r-1' } as never);
    const [ins] = inserted();
    expect(ins.cols).toEqual(expect.arrayContaining(['base_message_id', 'last_updated_at']));
    expect(ins.conflict).toBe('ON CONFLICT (message_id, channel_arn) DO NOTHING');
    const updates = ins.rows.filter((r) => r.event_type === 'UPDATE_CHANNEL_MESSAGE');
    expect(updates).toHaveLength(2);
    expect(new Set(updates.map((r) => r.message_id)).size).toBe(2);
    expect(updates.map((r) => r.base_message_id)).toEqual(['ph-1', 'ph-1']);
    expect(updates.map((r) => r.last_updated_at)).toEqual([NOTICE.LastUpdatedTimestamp, RECEIPT.LastUpdatedTimestamp]);

    // The same batch delivered again writes the same two ids, which the conflict clause absorbs.
    const firstIds = updates.map((r) => r.message_id);
    jest.clearAllMocks();
    mockedQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never);
    await handler({ Records: [kinesis('UPDATE_CHANNEL_MESSAGE', NOTICE), kinesis('UPDATE_CHANNEL_MESSAGE', RECEIPT)] } as never, { awsRequestId: 'r-2' } as never);
    expect(inserted()[0].rows.filter((r) => r.event_type === 'UPDATE_CHANNEL_MESSAGE').map((r) => r.message_id)).toEqual(firstIds);
  });

  it('takes the latest update in the batch by the event instant, whatever the arrival order', () => {
    const notice = { last_updated_at: NOTICE.LastUpdatedTimestamp ?? null, turn_kind: 'queue_ack' };
    const receipt = { last_updated_at: RECEIPT.LastUpdatedTimestamp ?? null, turn_kind: 'receipt' };
    expect(latestUpdateInBatch([notice, receipt])?.turn_kind).toBe('receipt');
    expect(latestUpdateInBatch([receipt, notice])?.turn_kind).toBe('receipt');
    expect(latestUpdateInBatch([])).toBeUndefined();
  });

  it('folds onto the CREATE row by its base id, and keeps the newer text against an older event', async () => {
    await backfillFromUpdateEvents([
      { event_type: 'UPDATE_CHANNEL_MESSAGE', message_id: 'ph-1-UPD-0123456789ab', base_message_id: 'ph-1', channel_arn: CHANNEL, content: 'x', last_updated_at: RECEIPT.LastUpdatedTimestamp, created_at: RECEIPT.CreatedTimestamp },
    ] as never);
    const fold = mockedQuery.mock.calls.find(([sql]) => /SET updated_content = CASE/.test(String(sql)))!;
    expect((fold[1] as unknown[])[11]).toBe('ph-1');
    const sql = flat(String(fold[0]));
    expect(sql).toContain('AND later.base_message_id = $12 AND later.last_updated_at > $14::timestamptz) THEN updated_content ELSE COALESCE($1, updated_content) END');
    // The FIRST completion still freezes agent_final_at: e2e_ms is defined by the first answer.
    expect(sql).toContain('agent_final_at = COALESCE(agent_final_at,');
  });
});

describe('what each reader takes', () => {
  it('builds one row or none, latest by the event instant with a pre-084 row last, first with it first', () => {
    const latest = flat(updateJoinSql({ alias: 'upd', create: 'm', pick: 'latest' }));
    expect(latest).toContain('LEFT JOIN LATERAL ( SELECT upd_ev.* FROM messages upd_ev');
    expect(latest).toContain("upd_ev.event_type = 'UPDATE_CHANNEL_MESSAGE' AND upd_ev.base_message_id = m.message_id");
    expect(latest).toContain('ORDER BY upd_ev.last_updated_at DESC NULLS LAST, upd_ev.archived_at DESC, upd_ev.message_id DESC LIMIT 1 ) upd ON TRUE');
    const first = flat(updateJoinSql({ alias: 'upd', create: 'm', pick: 'first' }));
    expect(first).toContain('ORDER BY upd_ev.last_updated_at ASC NULLS FIRST, upd_ev.archived_at ASC, upd_ev.message_id ASC LIMIT 1');
    // A superseded row is ordered the same way, a pre-084 NULL read as the earliest.
    expect(flat(supersededUpdateSql('m'))).toContain("(COALESCE(later.last_updated_at, '-infinity'::timestamptz), later.archived_at, later.message_id) > (COALESCE(m.last_updated_at, '-infinity'::timestamptz), m.archived_at, m.message_id)");
  });

  it('reads no update by the fixed id anywhere', () => {
    for (const f of ['analytics-query.ts', 'kinesis-archival.ts', 'evaluation-runner.ts', 'placeholder-backfill.ts', 'admin-conversations-aurora.ts', 'summary-updater.ts', 'turn-events-live.ts', 'classifier-replay.ts']) {
      expect({ f, fixed: /\|\| '-UPD'|'-\(UPD\|RED\|DEL\)\$'/.test(read(f)) }).toEqual({ f, fixed: false });
    }
  });

  it('takes the LATEST in every reader that asks what the message is now', () => {
    const latest = (alias: string, create: string) => `updateJoinSql({ alias: '${alias}', create: '${create}', pick: 'latest'`;
    // The Latency tab and its drill, unpaired turns, turn kinds, the tool lens and the platform actions
    // beside it, the workflow trajectory (its tasks and its turns), the safety readings, the template
    // outcomes and an intent's step and model breakdown (ADR-064): ten joins. The delivered-document reader
    // takes the latest under its own alias.
    expect(read('analytics-query.ts').split(latest('upd', 'm')).length - 1).toBe(10);
    expect(read('analytics-query.ts')).toContain(latest('ma_upd', 'ma'));
    // The sweep, and the queued-answer pass (the latest update that declared what it addressed).
    const archival = read('kinesis-archival.ts');
    expect(archival).toContain(`${latest('am_upd', 'am')} })`);
    expect(archival).toContain(`${latest('am_upd', 'am')}, and: 'answered_queued IS NOT NULL' })`);
    // The evaluation runner grades the message as it stands.
    expect(read('evaluation-runner.ts')).toContain(`${latest('ma_upd', 'ma')} })`);
    // The summary reads only the latest update of each message.
    expect(read('summary-updater.ts')).toContain("AND NOT (event_type = 'UPDATE_CHANNEL_MESSAGE' AND ${supersededUpdateSql('m')})");
    // The historical placeholder backfill, one latest row per message.
    expect(read('placeholder-backfill.ts')).toContain("ORDER BY ux.channel_arn, ux.base_message_id, ${latestUpdateOrderSql('ux')}");
    // The event log lists every update, each in its own order.
    expect(read('admin-conversations-aurora.ts')).toContain('ORDER BY m.created_at ASC, m.event_type ASC, m.last_updated_at ASC NULLS FIRST, m.message_id ASC');
  });

  it('names the notice-then-receipt placeholder from its latest update, and keeps the pre-084 arm for old rows', () => {
    const src = read('analytics-query.ts');
    // The declared kind is read from upd, which is the latest update: receipt, not queue_ack.
    expect(src).toContain("const declaredKind = `COALESCE(${upd}.turn_kind, ${m}.turn_kind, ${upd}.metadata->>'turnKind', ${m}.metadata->>'turnKind')`;");
    // The receipt arm excludes every row of the same message, the per-event update rows included.
    expect(src).toContain('AND COALESCE(moved.base_message_id, moved.message_id) <> ${m}.message_id))`;');
  });
});

describe('migration 084', () => {
  const FILE = '084-every-update-of-a-message-is-its-own-row.sql';
  const m084 = read(path.join('schema', FILE));
  const START = 'CREATE OR REPLACE VIEW v_turn_latency AS';
  const END = ') trg ON TRUE;';
  const viewOf = (m: string) => m.slice(m.indexOf(START), m.indexOf(END, m.indexOf(START)) + END.length);

  it('exists under a number no other migration holds', () => {
    const numbers = fs.readdirSync(path.join(SRC, 'schema')).filter((f) => f.endsWith('.sql')).map((f) => f.slice(0, 3));
    expect(numbers.filter((n) => n === '084')).toHaveLength(1);
  });

  it('adds the two columns, derives the base id for existing rows idempotently, and indexes the update rows', () => {
    const code = flat(sqlOnly(m084));
    expect(code).toContain('ALTER TABLE messages ADD COLUMN IF NOT EXISTS base_message_id VARCHAR(128);');
    expect(code).toContain('ALTER TABLE messages ADD COLUMN IF NOT EXISTS last_updated_at TIMESTAMPTZ;');
    // Bounded and resumable: one batch of rows still NULL per run, the remainder reported so the file
    // stays pending until it is zero.
    expect(code).toContain("SET base_message_id = regexp_replace(message_id, '-(UPD(-[0-9a-f]{12})?|RED|DEL)$', '') WHERE ctid IN ( SELECT ctid FROM messages WHERE base_message_id IS NULL");
    expect(code).toContain('LIMIT batch_size');
    expect(code).toContain("VALUES ('084-every-update-of-a-message-is-its-own-row.sql', left_to_do, NOW())");
    expect(code).toContain("CREATE INDEX IF NOT EXISTS idx_messages_update_events ON messages (channel_arn, base_message_id, last_updated_at) WHERE event_type = 'UPDATE_CHANNEL_MESSAGE';");
    expect(code).not.toContain('CONCURRENTLY');
  });

  it('replaces v_turn_latency with 080 and only the update join changed to the latest update', () => {
    const v080 = viewOf(read(path.join('schema', '080-a-moved-answer-keeps-its-first-feedback.sql')));
    const v084 = viewOf(m084);
    expect(flat(sqlOnly(v084))).toContain('LEFT JOIN LATERAL ( SELECT mu_ev.* FROM messages mu_ev WHERE mu_ev.channel_arn = m.channel_arn AND mu_ev.event_type = \'UPDATE_CHANNEL_MESSAGE\' AND mu_ev.base_message_id = m.message_id ORDER BY mu_ev.last_updated_at DESC NULLS LAST, mu_ev.archived_at DESC, mu_ev.message_id DESC LIMIT 1 ) mu ON TRUE');
    const strip = (v: string) => flat(sqlOnly(v
      .replace(/\n {2}-- THE RESPONSE'S (LATEST )?UPDATE ROW[\s\S]*?\) mu ON TRUE/, '')
      .replace(/\n {2}-- THE RESPONSE'S UPDATE ROW[\s\S]*?AND mu\.message_id = m\.message_id \|\| '-UPD'/, '')));
    expect(strip(v084)).toBe(strip(v080));
  });
});
