/**
 * THE TOOL LENS READS THE ROW THE STEPS LANDED ON.
 *
 * The Effectiveness dashboard's "Tools" column was empty for every intent, always. Not because the
 * assistants answered without tools - measured over three days, 71 "tool:<name>" step labels across
 * the live processors - but because the aggregate read a row whose steps are structurally absent.
 *
 * A reply is delivered placeholder-then-update. The CREATE row is the "One moment..." placeholder;
 * the answer arrives as separate update rows (one per update event). Exchanges link `agent_message_id` to the CREATE
 * row, so the join landed on the placeholder - written before any tool ran.
 * `backfillFromUpdateEvents` folds the update's TELEMETRY onto the CREATE row (model, tokens,
 * latency, final content) but not its `metadata`, and `steps[].tools[]` live in metadata.
 *
 * WHY IT SURVIVED SO LONG: an empty tool table reads as an assistant that answered without tools,
 * which is a legitimate outcome. The lens reported a plausible falsehood rather than an obvious gap.
 *
 * These are source assertions. The aggregate cannot be exercised without a database, and a mocked
 * one has no rows to join - which is exactly how the defect reached production in the first place.
 */
import * as fs from 'fs';
import * as path from 'path';

const QUERY = path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'analytics-query.ts');
const source = fs.readFileSync(QUERY, 'utf8');

/** The tool aggregate, isolated so a match elsewhere in this 6000-line file cannot satisfy it. */
function toolAgg(): string {
  const start = source.indexOf('tool_agg AS (');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n     )', start);
  return source.slice(start, end > start ? end : start + 2500);
}

describe('the tool lens reads the row the steps landed on', () => {
  it('joins the latest update row (migration 084: every update is its own row)', () => {
    expect(toolAgg()).toContain("updateJoinSql({ alias: 'upd', create: 'm', pick: 'latest' })");
  });

  it('reads steps from the sibling, falling back to the CREATE row', () => {
    // The fallback matters: a handler-answered turn that never produced an update still has its
    // steps on the row exchanges point at, and must keep counting.
    const agg = toolAgg();
    expect(agg).toContain("COALESCE(upd.metadata, m.metadata)->'steps'");
  });

  it('no longer reads steps from the CREATE row alone', () => {
    // The defect, stated as the thing that must not come back.
    const agg = toolAgg();
    expect(agg).not.toMatch(/jsonb_typeof\(m\.metadata->'steps'\)/);
  });

  it('keeps the non-array guard, which protects the WHOLE dashboard query', () => {
    // One row with a JSON null or scalar where an array was expected errors the entire query, not
    // just its own row - so the guard has to survive any rewrite of this join.
    const agg = toolAgg();
    expect(agg).toContain('jsonb_typeof');
    expect(agg).toContain("ELSE '[]'::jsonb END");
  });

  it('leaves the sibling join OUTER, so a turn with no update still reports', () => {
    // An inner join here would silently drop every handler-answered turn from the tool counts.
    // updateJoinSql renders a LEFT JOIN LATERAL ... ON TRUE, one row or none.
    expect(toolAgg()).toContain("${updateJoinSql({ alias: 'upd', create: 'm', pick: 'latest' })}");
    expect(require('../../lambda/src/analytics-aurora/update-events')
      .updateJoinSql({ alias: 'upd', create: 'm', pick: 'latest' })).toMatch(/^LEFT JOIN LATERAL \([\s\S]*\) upd ON TRUE$/);
  });
});
