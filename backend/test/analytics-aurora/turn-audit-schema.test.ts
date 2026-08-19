/**
 * Migration 019 (`turn_events` + the latency calculation views) has properties that are load-bearing
 * and cannot be re-checked once it has applied: a migration runs ONCE per cluster.
 *
 * `applyPendingMigrations` (db-client.ts) executes unapplied `schema/*.sql` inside a single
 * transaction under an advisory lock, so a file that is non-idempotent, or that uses CONCURRENTLY,
 * fails the whole migration on some clusters and not others - the worst possible failure shape.
 *
 * These assertions are structural, not a substitute for executing the SQL. Syntax is proven only by
 * applying it to a real cluster; this file proves the properties a reviewer cannot eyeball reliably.
 */
import * as fs from 'fs';
import * as path from 'path';

const SCHEMA_DIR = path.join(__dirname, '../../lambda/src/analytics-aurora/schema');
const FILE = '019-turn-audit.sql';
const sql = fs.readFileSync(path.join(SCHEMA_DIR, FILE), 'utf8');

/** The turn_events CREATE TABLE body, which is what the no-content rule is about. */
function turnEventsBody(): string {
  const start = sql.indexOf('CREATE TABLE IF NOT EXISTS turn_events');
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf(');', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('019-turn-audit.sql — migration shape', () => {
  it('applies after every migration it depends on, and the directory stays ordered', () => {
    // This asserted `019` sorts LAST, which was true when written and false the moment another
    // migration was added - it failed on 020/021 while nothing about 019 had changed. The property
    // that is actually load-bearing is that `applyPendingMigrations` (which sorts filenames) applies
    // 019 after the tables its views read, and that the numbering keeps sorting numerically.
    const files = fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.sql')).sort();
    const nums = files.map((f) => Number(f.slice(0, 3)));

    // Zero-padded and unique, so lexical sort == numeric order. A `9-foo.sql` would sort after
    // `10-bar.sql` and silently reorder the whole sequence.
    expect(files.every((f) => /^\d{3}-/.test(f))).toBe(true);
    expect(new Set(nums).size).toBe(nums.length);
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);

    // And 019 still comes after everything numbered below it.
    expect(files.indexOf(FILE)).toBe(nums.indexOf(19));
    expect(files.slice(0, files.indexOf(FILE)).every((f) => Number(f.slice(0, 3)) < 19)).toBe(true);
  });

  it('is idempotent: tables and indexes guarded, views replaceable', () => {
    // A re-run must be a no-op. `applyPendingMigrations` tracks applied files, but a partially
    // applied transaction or a hand-run leaves the guard as the only protection.
    const creates = sql.match(/CREATE TABLE (?!IF NOT EXISTS)/g) || [];
    expect(creates).toEqual([]);
    const indexes = sql.match(/CREATE INDEX (?!IF NOT EXISTS)/g) || [];
    expect(indexes).toEqual([]);
    // A bare `CREATE VIEW` fails on the second apply; views must be CREATE OR REPLACE.
    const views = sql.match(/CREATE VIEW /g) || [];
    expect(views).toEqual([]);
    expect(sql).toContain('CREATE OR REPLACE VIEW v_turn_latency');
    expect(sql).toContain('CREATE OR REPLACE VIEW v_task_resolution');
  });

  it('uses no CONCURRENTLY — it cannot run inside the migration transaction', () => {
    // Strip `--` comments first. The header explains WHY CONCURRENTLY is banned, so a naive scan of
    // the whole file matches its own documentation and fails on prose rather than on SQL.
    const executable = sql.replace(/--[^\n]*/g, '');
    expect(executable.toUpperCase()).not.toContain('CONCURRENTLY');
  });
});

describe('019-turn-audit.sql — the ledger stores NO content', () => {
  // This is the privacy property the design promises. Enforced, not asserted in prose: a future
  // column that carries message text has to fail here rather than be caught in review.
  it('declares no free-form text column', () => {
    const body = turnEventsBody();
    expect(body).not.toMatch(/\bTEXT\b/i);
    expect(body).not.toMatch(/\bJSONB?\b/i);
  });

  it('declares no content-bearing column name', () => {
    const body = turnEventsBody().toLowerCase();
    for (const banned of [
      'content', 'updated_content', 'message_text', 'body', 'prompt',
      'sender_name', 'display_name', 'email', 'user_message',
    ]) {
      // `actor` holds an identity REFERENCE (sub / ARN); a name or address must never appear.
      expect(body.includes(`    ${banned} `) || body.includes(`${banned} varchar`)).toBe(false);
    }
  });

  it('keeps the columns to the declared allow-list', () => {
    const body = turnEventsBody();
    const declared = [...body.matchAll(/^\s{4}([a-z_]+)\s+(?:UUID|VARCHAR|TIMESTAMPTZ|BOOLEAN|SMALLINT)/gm)]
      .map((m) => m[1]);
    expect(declared.sort()).toEqual([
      'actor', 'archived_at', 'auditable', 'battle_round', 'channel_arn', 'clock', 'expires_at',
      'id', 'kind', 'occurred_at', 'response_id', 'source_event_type', 'source_message_id',
      'task_id', 'task_state', 'terminal_kind', 'trigger_kind', 'turn_id', 'turn_id_source',
    ]);
  });
});

describe('019-turn-audit.sql — retention and idempotency keys', () => {
  it('sets a retention window and can find expired rows without a scan', () => {
    // Without this the ledger is the one analytics table that grows forever AND the only one whose
    // reason to exist (provability against S3) expires. The column is meaningless without the index.
    expect(sql).toMatch(/expires_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT \(NOW\(\) \+ INTERVAL '90 days'\)/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_turn_events_expires\s*\n?\s*ON turn_events \(expires_at\)/);
  });

  it('is idempotent per EVENT, so a redelivery collides instead of double-counting', () => {
    // ADR-022: an updated persistent message re-invokes the channel flow, so the same event
    // legitimately arrives more than once. Keyed on the event, not on the message.
    expect(sql).toContain('UNIQUE (source_message_id, source_event_type, occurred_at)');
  });
});

describe('v_turn_latency — the rules that make the numbers honest', () => {
  it('returns NULL TTFF for a system-triggered response', () => {
    // A battle round-2 rebuttal, a welcome and a briefing have no user message to measure from.
    // A 0 there would be a lie that quietly drags the average down.
    expect(sql).toMatch(/WHEN r\.trigger_kind = 'user'[\s\S]{0,200}?AS ttff_ms/);
  });

  it('freezes the answer time on the FIRST final_response', () => {
    // Mirrors the COALESCE freeze: a later moderation edit must not move the latency.
    expect(sql).toMatch(/MIN\(occurred_at\) FILTER \(WHERE kind = 'final_response'\)/);
  });

  it('only final_response can close a response', () => {
    // The whole point of the redesign: a progress update carrying telemetry must stay inert.
    expect(sql).not.toMatch(/FILTER \(WHERE kind = 'progress_update'\)[\s\S]{0,80}AS t3_final_at/);
  });

  it('emits one row per response — the exchanges join cannot fan out', () => {
    // `exchanges` is unique on the (user, agent) PAIR, so one agent message can appear in two rows;
    // a plain LEFT JOIN would double-count the response in every average built on this view.
    expect(sql).toMatch(/LEFT JOIN LATERAL \([\s\S]*?LIMIT 1\s*\) e ON TRUE/);
  });

  it('keeps whole-task resolve time OUT of the latency view', () => {
    // resolve_ms is mostly human think time; next to latency it reads as a regression.
    const viewStart = sql.indexOf('CREATE OR REPLACE VIEW v_turn_latency');
    const viewEnd = sql.indexOf('CREATE OR REPLACE VIEW v_task_resolution');
    expect(sql.slice(viewStart, viewEnd)).not.toContain('resolve_ms');
  });
});

describe('027: the view measures LIVE rows, not only backfilled ones', () => {
  // The live writer's final_response carries turn_id NULL (an update's content has no corr marker)
  // and its placeholders carry no declared trigger - so the 019/026 grain split every live turn in
  // two with e2e_ms NULL, and the strict trigger gate nulled TTFF for all ordinary live traffic.
  // Healed at READ so already-written rows are repaired too.
  const sql027 = require('fs').readFileSync(
    require('path').join(SCHEMA_DIR, '027-turn-latency-live-rows.sql'), 'utf8');

  it('grains per RESPONSE and lifts the placeholder-declared turn id over the final row NULL', () => {
    expect(sql027).toContain('SELECT MAX(turn_id) AS turn_id');
    expect(sql027).toMatch(/GROUP BY response_id, channel_arn/);
    expect(sql027).not.toMatch(/GROUP BY turn_id, response_id/);
  });

  it('an undeclared trigger defaults to user, while a declared non-user still suppresses TTFF', () => {
    expect(sql027).toContain("COALESCE(r.trigger_kind, 'user') = 'user'");
  });

  it('keeps the 026 pushable-channel shape (a relabel, never a type change)', () => {
    expect(sql027).toContain('channel_arn::text');
  });
});
