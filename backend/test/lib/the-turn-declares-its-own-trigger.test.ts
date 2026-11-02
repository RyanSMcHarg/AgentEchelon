/**
 * THE INTERACTION BREAKDOWN HAD ONE ROW, BECAUSE `trigger_kind` WAS NULL ON EVERY TURN.
 *
 * The view read it only from `placeholder_posted`, which is built from the CREATE event and then
 * frozen by `ON CONFLICT DO NOTHING`. The value is not knowable then: the placeholder is emitted
 * through the Lex response path, which sets no message Metadata, and the out-of-band analytics row
 * that carries the declared trigger is written after the model call - keyed, on a broadcast resume,
 * to the answer rather than the placeholder.
 *
 * So the fact arrives late, and the fix is to let a later row supply it: the processor stamps the
 * trigger onto an update it was already performing, the ledger stops nulling it, and the view takes
 * the turn's trigger from whichever of its rows declared one.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.resolve(ROOT, rel), 'utf8');

describe('the declared trigger survives to the archive', () => {
  it('rides the placeholder update, which the turn already performs', () => {
    const core = read('lambda/src/lib/async-processor-core.ts');
    // It is in `fullAnalytics` already, but only the frontend-kept fields are inlined once the
    // out-of-band store is on - so inline is where it has to be said again, explicitly.
    const meta = core.slice(core.indexOf('const messageMetadata'));
    // The whole object literal, not a fixed window: the object grows as facts are added to it.
    expect(meta.slice(0, meta.indexOf('\n  };'))).toContain('...(event.trigger && { trigger: event.trigger }),');
  });

  it('is carried by the ledger rather than nulled', () => {
    const live = read('lambda/src/analytics-aurora/turn-events-live.ts');
    // The UPDATE branch is the one row that can carry it; it used to hardcode null.
    expect(live).toContain('trigger_kind: r.trigger_kind ?? null,');
  });

  it('is still DECLARED, never inferred', () => {
    // 034 inferred it from whether an exchange paired and 037 took that back. A guess here would be a
    // second, disagreeing source for the one fact that decides whether a TTFF is meaningful.
    const live = read('lambda/src/analytics-aurora/turn-events-live.ts');
    expect(live).not.toMatch(/trigger_kind:\s*'user'\s*\/\/.*infer/i);
    expect(live).toContain("turn_id_source: 'paired', trigger_kind: 'user'");
  });
});

describe('the view takes the trigger from whichever row declared one', () => {
  const sql = read('lambda/src/analytics-aurora/schema/038-the-turn-declares-its-own-trigger.sql');

  it('no longer reads it only from the placeholder row', () => {
    expect(sql).not.toContain("MIN(trigger_kind) FILTER (WHERE kind = 'placeholder_posted')");
  });

  it('reads it from any row that declared one', () => {
    expect(sql).toContain('MIN(trigger_kind) FILTER (WHERE trigger_kind IS NOT NULL)');
  });

  it('is idempotent, because migrations here re-apply on every cold start', () => {
    expect(sql).toContain('CREATE OR REPLACE VIEW v_turn_latency AS');
  });

  it('still groups the turn by its response, so the trigger belongs to that turn', () => {
    // Taking the value from "any row" is only sound because the rows are already partitioned per
    // response - otherwise one turn's trigger could answer for another's.
    expect(sql).toContain('GROUP BY response_id, channel_arn');
  });
});
