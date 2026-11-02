/**
 * A PARAMETER THE CONSOLE SENDS REACHES THE QUERY, OR THE DRILL LIES.
 *
 * `buildParamsFromBody` is an ALLOWLIST. A name missing from it is dropped in silence - no error, no
 * warning, a 200 with rows - so a drill keyed on that dimension quietly returns a WIDER population
 * than the row it was opened from. The numbers then nearly reconcile, which is worse than an empty
 * table: the reader sees a discrepancy and has no way to learn it came from the request.
 *
 * Shipped exactly that way: the latency drill sent `day`, `deliveryOption` and `turnEntry`, none of
 * which were listed, so three of the seven dimensions of a breakdown row were ignored.
 *
 * The second half is the 'unknown' string. The breakdown COALESCEs a null dimension to 'unknown' so
 * the table has something to print; handing that back as a filter matches no row, because the column
 * holds NULL. Every row with an unrecorded dimension drilled to an empty table and looked broken. The
 * drill therefore compares the breakdown's own grouping expression (LATENCY_DIM), placeholder included.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'analytics-query.ts');
const source = fs.readFileSync(SRC, 'utf8');

/** The allowlist body, so a name is checked against what is actually accepted. */
function allowlist(): string {
  const at = source.indexOf("  for (const k of [");
  expect(at).toBeGreaterThan(-1);
  return source.slice(at, source.indexOf('  ]) {', at));
}

describe('every dimension the latency drill cuts on is accepted', () => {
  // The seven the breakdown row is grouped on. Named individually so a failure says which one.
  it.each([
    ['day', 'the breakdown groups by DATE(created_at), so a range returns a week for a one-day row'],
    ['deliveryOption', 'a row is one delivery option; without it the drill spans all of them'],
    ['turnEntry', 'standard and targeted turns do different work in front of the first frame'],
    ['agentType', 'the assistant that answered'],
    ['assistantRole', 'the role it occupied'],
    ['profileVersion', 'the version that produced the turn'],
    ['conversationClassification', 'the tier of the room'],
  ])('accepts %s', (param) => {
    expect(allowlist()).toContain(`'${param}'`);
  });
});

describe("a display 'unknown' is read as the NULL it stands for", () => {
  const drill = () => {
    const at = source.indexOf('async function getLatencyExchanges');
    expect(at).toBeGreaterThan(-1);
    return source.slice(at, source.indexOf('\n}\n', at));
  };
  /** The breakdown's grouping expressions, which the drill compares to its parameters. */
  const dims = (): string => {
    const at = source.indexOf('const LATENCY_DIM = {');
    expect(at).toBeGreaterThan(-1);
    return source.slice(at, source.indexOf('} as const;', at));
  };

  it.each([
    ['assistant', 'assistant', '$3', "COALESCE(e.assistant, c.assistant, m.assistant, 'unknown')"],
    ['role', 'assistant_role', '$5', "COALESCE(e.assistant_role, m.assistant_role, 'unknown')"],
    ['classification', 'conversation_classification', '$7', "COALESCE(e.conversation_classification, c.conversation_classification, m.conversation_classification, 'unknown')"],
    ['entry', 'turn_entry', '$8', "COALESCE(m.turn_entry, 'unknown')"],
  ])('matches a NULL %s when the caller sends unknown', (key, _col, param, expr) => {
    // The drill compares the breakdown's own expression, 'unknown' included, so a row with an
    // unrecorded dimension drills to the turns the breakdown put there rather than to nothing.
    expect(dims()).toContain(`${key}: \`${expr}\``);
    expect(drill()).toContain(`\${LATENCY_DIM.${key}} = ${param})`);
  });

  it('matches the delivery option by the label the breakdown shows, which is never unknown', () => {
    // The breakdown labels a row with no delivery option by its turn kind (turnLabelSql, in the lbl
    // lateral), so there is no 'unknown' to translate back.
    // every-turn-is-named-and-measured.test.ts pins the expression itself.
    expect(dims()).toContain('label: `lbl.delivery_option`');
    expect(drill()).toContain('($4::varchar IS NULL OR ${LATENCY_DIM.label} = $4)');
    expect(drill()).not.toMatch(/\$4 = 'unknown'/);
  });

  it('reads a NULL battle round as the none the breakdown shows', () => {
    expect(dims()).toContain("round: `COALESCE(m.battle_round::text, 'none')`");
    expect(drill()).toContain('($11::varchar IS NULL OR ${LATENCY_DIM.round} = $11)');
  });
});
