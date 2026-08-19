/**
 * THE LEDGER'S COLUMN COMMENT MUST ENUMERATE WHAT THE WRITERS EMIT.
 *
 * `019-turn-audit.sql` declared the `turn_events.kind` vocabulary and omitted two kinds the producer
 * actually writes: `error_response` and `notice_posted`. The first is the one that matters, because it
 * is what distinguishes a turn that CORRECTLY did not close from an answer that was lost - the entire
 * question the unclosed-turn split exists to answer. A reader auditing the ledger from its own schema
 * would have concluded that distinction was not recorded at all.
 *
 * A comment cannot be unit-tested by reading it. It can be tested by DERIVING the vocabulary from the
 * writers and refusing to let the two disagree, which is what this does.
 *
 * THE CORRECTION EXPOSED SOMETHING LARGER, and the reserved list is where it is recorded. Four
 * declared kinds have no writer anywhere: `processor_entry`, `content_edited`, `task_opened`,
 * `task_terminal`. Three of those are the entire input to `v_task_resolution`, which is therefore
 * inert - measured live over 47 days of real task traffic, it returns zero rows. Marking them RESERVED
 * rather than deleting them keeps that visible; deleting them would make the view look like a working
 * measurement that simply found nothing.
 */
import * as fs from 'fs';
import * as path from 'path';

const SCHEMA_DIR = path.resolve(__dirname, '../../lambda/src/analytics-aurora/schema');
const WRITERS = ['turn-events-live.ts', 'turn-events-backfill.ts'].map((f) =>
  path.resolve(__dirname, '../../lambda/src/analytics-aurora', f)
);

/** The latest migration that comments the `kind` column - the one in force. */
function kindComment(): string {
  const files = fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.sql')).sort();
  let latest = '';
  for (const f of files) {
    const sql = fs.readFileSync(path.join(SCHEMA_DIR, f), 'utf8');
    const m = /COMMENT ON COLUMN turn_events\.kind IS([\s\S]*?);/.exec(sql);
    if (m) latest = m[1];
  }
  return latest;
}

/**
 * Kinds the producers can write.
 *
 * Read as STRING LITERALS out of the writer modules rather than from an exported constant on purpose:
 * an exported list is one more thing a new `kind:` literal can be added without touching, which is
 * precisely how the comment drifted in the first place.
 */
function emittedKinds(): Set<string> {
  const out = new Set<string>();
  for (const file of WRITERS) {
    const src = fs.readFileSync(file, 'utf8');
    // `kind: 'x'` (row construction) and `return 'x';` (the phase mapper).
    for (const m of src.matchAll(/\bkind:\s*'([a-z_]+)'/g)) out.add(m[1]);
    for (const m of src.matchAll(/\breturn\s+'([a-z_]+)';/g)) out.add(m[1]);
    // `'x'` used directly as the inserted kind in a SQL SELECT list.
    for (const m of src.matchAll(/SELECT\s+'([a-z_]+)'/g)) out.add(m[1]);
    for (const m of src.matchAll(/\?\s*'([a-z_]+)'\s*:\s*'([a-z_]+)'/g)) { out.add(m[1]); out.add(m[2]); }
  }
  // `trigger_kind` values share the literal shape but are not ledger kinds.
  for (const notAKind of ['user', 'orchestrator', 'system', 'declared', 'paired', 'chime', 'server']) {
    out.delete(notAKind);
  }
  return out;
}

const comment = kindComment();
const written = new Set(
  (/WRITTEN TODAY[^:]*:([\s\S]*?)RESERVED/.exec(comment)?.[1] || '').match(/[a-z_]{4,}/g) || []
);
const reserved = new Set(
  (/NOT WRITTEN BY ANY PRODUCER:([\s\S]*?)-/.exec(comment)?.[1] || '').match(/[a-z_]{4,}/g) || []
);

describe('the ledger vocabulary is one list, not two', () => {
  it('finds a kind comment and both sections, so this cannot pass vacuously', () => {
    expect(comment).not.toBe('');
    expect(written.size).toBeGreaterThan(5);
    expect(reserved.size).toBeGreaterThan(0);
  });

  it('every kind a producer can write is enumerated as WRITTEN', () => {
    // The mutation this catches is the original defect: adding a phase to `kindForPhase` and leaving
    // the schema comment alone.
    const missing = [...emittedKinds()].filter((k) => !written.has(k)).sort();
    expect(missing).toEqual([]);
  });

  it('names error_response and notice_posted specifically', () => {
    // Named as well as swept. These two were the omission, and `error_response` is load-bearing for
    // the unclosed-turn split: without it an explained non-closure is indistinguishable from a lost
    // answer. A sweep regression should fail above; these two regressing should be unmistakable.
    expect(written.has('error_response')).toBe(true);
    expect(written.has('notice_posted')).toBe(true);
  });

  it('nothing is listed as both written and reserved', () => {
    const both = [...reserved].filter((k) => written.has(k));
    expect(both).toEqual([]);
  });

  it('every RESERVED kind genuinely has no writer', () => {
    // The reserved list is a claim about the code, so it rots the same way the written list did. If a
    // producer starts emitting one, it must move rather than sit here as a false absence.
    const nowWritten = [...reserved].filter((k) => emittedKinds().has(k)).sort();
    expect(nowWritten).toEqual([]);
  });

  it('records that v_task_resolution is LIVE, and still names the kinds it depends on', () => {
    // This assertion INVERTED when migration 024 gave the task kinds a producer, and the inversion is
    // the point: the comment on a view is where a reader learns whether an empty result is a statement
    // about the product or about the pipeline. It said INERT while nothing wrote the kinds; it says
    // LIVE now, and it must keep naming the three, so a kind that loses its writer is visible here.
    const files = fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.sql')).sort();
    const viewComment = files
      .map((f) => /COMMENT ON VIEW v_task_resolution IS([\s\S]*?);/.exec(fs.readFileSync(path.join(SCHEMA_DIR, f), 'utf8'))?.[1])
      .filter(Boolean)
      .pop() as string;
    expect(viewComment).toMatch(/LIVE/);
    expect(viewComment).not.toMatch(/INERT/);
    for (const kind of ['task_opened', 'task_terminal', 'task_transition']) {
      expect(viewComment).toContain(kind);
    }
  });
});
