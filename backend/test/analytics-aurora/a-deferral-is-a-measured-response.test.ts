/**
 * A DEFERRAL IS A RESPONSE, AND IT WAS NOT MEASURED AT ALL (maintainer, 2026-09-02).
 *
 * A message that arrives while the assistant is busy is queued, and the person gets a real, visible
 * reply saying so within about 20 to 50ms. That is their first feedback. Nothing recorded it:
 * `ttff_ms` and `ack_ms` both anchor on `t2_placeholder_at`, a queued message produces no
 * `placeholder_posted`, and so both came back NULL for every queued turn.
 *
 * The direction matters. It was not a bad number, it was an ABSENT one - queued turns left the
 * latency population entirely, the averages stayed healthy, and the wait the platform deliberately
 * imposes appeared nowhere. ADR-033 asserts the acknowledgement sets TTFF; that was a decision that
 * was never built, and SPEC-TURN-QUEUE restated it as satisfied.
 *
 * ── WHY THE VIEW ALONE COULD NOT FIX IT ─────────────────────────────────────────────────────────
 *
 * Adding `notice_posted` to that FILTER changes nothing, and this file exists partly to stop the next
 * person trying it:
 *
 *   1. The notice carries no correlation marker - that is what makes a bot message a response - so
 *      its rows have a NULL turn_id and nothing joins them to the person's message.
 *   2. The notice is ONE message updated in place, so every queued send shares its response_id. A
 *      MIN-per-response rule collapses a burst into a single instant, leaving the second and third
 *      sends with no first feedback of their own.
 *
 * So the acknowledged message id travels on the post that acknowledges it. These tests pin that it
 * is captured at every hop, because a field that is declared and never populated is the failure this
 * codebase has shipped before.
 */
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../..', 'lambda/src');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8');

describe('the notice names the message it acknowledges', () => {
  const notice = read('lib/turn-queue-notice.ts');

  it('carries the acknowledged id in the metadata it POSTS', () => {
    expect(notice).toContain('acknowledges?: string;');
    // Both the create and the update: a burst updates the notice, and it is the UPDATE that carries
    // the second and third sends. Capturing only the create measures one message per conversation.
    // AND THE WRITE INTO THE RUNNING ANSWER'S PLACEHOLDER, which is how the first
    // notice is shown when that placeholder can hold it.
    const sites = notice.match(/\.\.\.\(acknowledges \? \{ acknowledges \} : \{\}\)/g) ?? [];
    expect(sites.length).toBe(3);
  });

  it('the router tells it which message, or the field is dead weight', () => {
    const router = read('router-agent-handler.ts');
    const passes = router.match(/acknowledges: queuedMessageId/g) ?? [];
    // Both call sites: the ordinary post and the retry that waits for the notice id to appear.
    expect(passes.length).toBe(2);
  });
});

describe('the acknowledgement survives every hop to the ledger', () => {
  it('the archival record parses it from the message metadata', () => {
    const archival = read('analytics-aurora/kinesis-archival.ts');
    expect(archival).toMatch(/const acknowledges: string \| null =/);
    expect(archival).toContain('acknowledges,');
  });

  it('the ledger row is written with it, and the column list includes it', () => {
    const live = read('analytics-aurora/turn-events-live.ts');
    // The column list is what the insert actually sends. A row field absent from it is silently
    // dropped, which is the shape of "declared and never populated".
    expect(live).toMatch(/'task_id', 'task_state', 'acknowledges',/);
  });

  it('ONLY a notice carries it, so no other kind grows a second, disagreeing key', () => {
    const live = read('analytics-aurora/turn-events-live.ts');
    expect(live).toContain("r.resp_phase === 'notice' && r.acknowledges");
  });
});

/**
 * A VIEW COLUMN IS RENAMED BY DROPPING THE VIEW, AND ITS READER MOVES WITH IT (migration 043).
 *
 * `CREATE OR REPLACE VIEW` may add columns but may not rename one - Postgres refuses with "cannot
 * change name of view column". Migrations run in `ensureSchema` on every cold start and rethrow, so a
 * rename written as a replace fails schema init for every Aurora Lambda, every cold start.
 */
describe('the drained_ms rename applies, and nothing still reads the old name', () => {
  const sql043 = fs.readFileSync(
    path.join(root, 'analytics-aurora/schema/043-the-metric-is-named-for-what-it-measures.sql'),
    'utf8',
  );

  it('drops the view before recreating it, because a replace cannot rename a column', () => {
    const drop = sql043.indexOf('DROP VIEW IF EXISTS v_queue_acknowledgement;');
    const create = sql043.indexOf('CREATE VIEW v_queue_acknowledgement AS');
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
    expect(sql043).not.toContain('CREATE OR REPLACE VIEW v_queue_acknowledgement');
    expect(sql043).toContain('AS drained_ms');
  });

  it('the one reader outside the schema selects the new name', () => {
    const backfill = fs.readFileSync(path.join(root, 'analytics-aurora/turn-events-backfill.ts'), 'utf8');
    expect(backfill).toContain('drained_ms');
    expect(backfill).not.toContain('triaged_ms');
  });
});

describe('the migration makes it queryable and does not over-claim', () => {
  const sql = fs.readFileSync(
    path.join(root, 'analytics-aurora/schema/039-a-deferral-is-a-response.sql'),
    'utf8',
  );
  // 040 supersedes 039's view definition; both must keep their promises.
  const sql040 = fs.readFileSync(
    path.join(root, 'analytics-aurora/schema/040-the-queue-was-read-when-it-settled.sql'),
    'utf8',
  );

  it('adds the column idempotently, because migrations re-apply on every cold start', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS acknowledges');
    expect(sql).toContain('CREATE OR REPLACE VIEW v_queue_acknowledgement');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS');
  });

  it('reports ack_ms per QUEUED MESSAGE, not per notice', () => {
    // Grouping by the notice is the collapse this whole change exists to avoid.
    expect(sql).toMatch(/GROUP BY acknowledges, channel_arn/);
    expect(sql).toContain('AS ack_ms');
  });

  it('stops at the handoff and does NOT call it queue_ms', () => {
    // DRAINING THE QUEUE DOES NOT START THE WORK. A queued message becomes a `queued_request` task
    // created in `proposed`, which awaits the requester - so the span from the send to work beginning
    // is mostly a person deciding, and ADR-033 already puts that on the task-resolution surface,
    // where human think time is kept out of `agent_ms`. Calling this `queue_ms` would both claim a
    // measurement the drain cannot make and mix the two surfaces the ADR deliberately separates.
    expect(sql).not.toMatch(/AS queue_ms/);
    expect(sql).toContain('AS triaged_ms');
    expect(sql).toMatch(/DRAINING THE QUEUE DOES NOT START THE WORK/);
    expect(sql).toMatch(/task-resolution surface/);
  });

  it('names what joins the two surfaces, so the handoff can be followed', () => {
    // The drain sets the task's `userMessageId` to the queued message id for exactly this purpose.
    // Saying the work moves surfaces without saying what joins them leaves the next reader stuck.
    expect(sql).toMatch(/userMessageId/);
  });
});

/**
 * THE READ INSTANT IS THE SETTLE, NOT THE FIRST UPDATE (maintainer, 2026-09-03).
 *
 * Migration 039 took `MIN(occurred_at)` over every `notice_posted` row for a notice and called it
 * `settled_at`. The notice is ONE message updated in place - posted, updated per queued send, updated
 * per drain stage, settled - so all of those share a response id and a kind, and MIN is the moment it
 * was CREATED.
 *
 * Caught on live data: rows where `triaged_ms` was SMALLER than `ack_ms` (6225/3180, 2723/1190,
 * 5078/3229). A queue cannot be read before the message waiting in it was acknowledged. The number
 * was impossible, and impossible in the direction that flatters.
 *
 * MAX would be wrong more quietly: mid-drain it returns the latest STAGE, reporting a read that has
 * not happened. So the stage is recorded rather than inferred, and a queue that has not settled has
 * no read instant at all.
 */
describe('the read instant is recorded, not guessed', () => {
  const fs2 = require('fs') as typeof import('fs');
  const path2 = require('path') as typeof import('path');
  const root2 = path2.resolve(__dirname, '../..', 'lambda/src');
  const sql = fs2.readFileSync(
    path2.join(root2, 'analytics-aurora/schema/040-the-queue-was-read-when-it-settled.sql'), 'utf8',
  );

  it('the settle is selected by STAGE, not by MIN or MAX over every update', () => {
    expect(sql).toMatch(/queue_status = 'settled'/);
    // The defect in one line: a MIN over unfiltered notice rows is the notice's creation.
    expect(sql).not.toMatch(/MIN\(occurred_at\)\s+AS settled_at\s*\n\s*FROM turn_events\s*\n\s*WHERE kind = 'notice_posted'\s*\n\s*GROUP BY/);
  });

  it('the stage is captured end to end, or the filter above matches nothing', () => {
    const live = fs2.readFileSync(path2.join(root2, 'analytics-aurora/turn-events-live.ts'), 'utf8');
    const archival = fs2.readFileSync(path2.join(root2, 'analytics-aurora/kinesis-archival.ts'), 'utf8');
    expect(archival).toMatch(/const queueStatus: string \| null =/);
    expect(live).toMatch(/'task_id', 'task_state', 'acknowledges', 'queue_status',/);
    // ONLY a notice carries it: every other kind would be declaring a drain stage it has no part in.
    expect(live).toContain("r.resp_phase === 'notice' && r.queue_status");
  });

  it('an unsettled queue reports NO read instant rather than a small one', () => {
    // The LEFT JOIN plus the >= guard is what makes this NULL instead of a number. Losing either
    // would report a read that has not happened, which is the failure this migration exists for.
    expect(sql).toMatch(/LEFT JOIN settled st/);
    expect(sql).toMatch(/st\.settled_at >= s\.sent_at/);
  });
});
