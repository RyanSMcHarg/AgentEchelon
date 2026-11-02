/**
 * A COLUMN THE RESPONSE DECLARES IS A COLUMN THE RESPONSE CARRIES.
 *
 * `intent_effectiveness` answers with a `columns` list beside its rows, and the console reads that
 * list as the contract for what a row contains. The two are maintained by hand in different places,
 * roughly four hundred lines apart, and they drifted: six evaluation signals were aggregated inside
 * the `ex_agg` CTE, named in `columns`, rendered by a card on the Effectiveness surface with a
 * passing frontend test behind it - and left out of the OUTER select that projects `ex_agg`. So the
 * query computed them, the response promised them, and the API returned rows without them.
 *
 * Nothing caught it. The frontend tests hand the component a row they build themselves, so they
 * prove the card renders a value it is given rather than that anything supplies one. The backend
 * tests mock `query` and assert on rows they also build. A live probe through the signed path is
 * what found it, which is a slow way to learn that a SELECT list is short by six names.
 *
 * So this reads the source. For every name the handler declares, the name has to appear either in
 * the outer projection or in the JavaScript that decorates each row afterwards. It is a text check
 * and it cannot prove the value is right, but it is the exact shape of the defect: a promise with
 * no producer.
 */
import * as fs from 'fs';
import * as path from 'path';

const SOURCE = path.join(__dirname, '..', '..', 'lambda', 'src', 'analytics-aurora', 'analytics-query.ts');
const src = fs.readFileSync(SOURCE, 'utf8');

/** The outer projection of the intent_effectiveness query, and the JS that decorates its rows. */
function intentEffectivenessParts() {
  const selectAt = src.indexOf('SELECT ex_agg.intent');
  expect(selectAt).toBeGreaterThan(-1);
  const orderAt = src.indexOf('ORDER BY ex_agg.exchange_count DESC', selectAt);
  expect(orderAt).toBeGreaterThan(selectAt);
  const columnsAt = src.indexOf('columns: [', orderAt);
  expect(columnsAt).toBeGreaterThan(orderAt);
  const columnsEnd = src.indexOf(']', columnsAt);
  const declared = Array.from(src.slice(columnsAt, columnsEnd).matchAll(/'([a-z0-9_]+)'/g)).map((m) => m[1]);
  return {
    outerSelect: src.slice(selectAt, orderAt),
    // Everything between the query and the response: the .map() that folds in cost and user signal.
    decoration: src.slice(orderAt, columnsAt),
    declared,
  };
}

describe('intent_effectiveness returns every column it declares', () => {
  it('names a producer for each declared column', () => {
    const { outerSelect, decoration, declared } = intentEffectivenessParts();
    expect(declared.length).toBeGreaterThan(40); // the list is long; a truncated parse must not pass

    const orphans = declared.filter((c) => !outerSelect.includes(c) && !decoration.includes(c));
    expect(orphans).toEqual([]);
  });

  it('projects the four evaluation signals the surface reads', () => {
    // Named individually because these are the six that drifted, and a generic check that goes
    // green for the wrong reason is worse here than no check: the whole point of surfacing them was
    // that a stored signal nobody can read is not delivered.
    const { outerSelect } = intentEffectivenessParts();
    for (const col of [
      'groundedness_rate', 'groundedness_assessed_count', 'avg_retrieved_passages',
      'rubric_version', 'rubric_version_count', 'sampled_always_count', 'sampled_random_count',
    ]) {
      expect(outerSelect).toContain(`ex_agg.${col}`);
    }
  });

  it('can actually fail, so a green run means something', () => {
    // A guard that cannot fail is a guard nobody should trust. Run the same orphan detection over a
    // name that is declared nowhere and confirm it is caught, rather than assuming the empty result
    // above came from the check working.
    const { outerSelect, decoration } = intentEffectivenessParts();
    const invented = 'groundedness_rate_per_fortnight';
    const orphans = [invented].filter((c) => !outerSelect.includes(c) && !decoration.includes(c));
    expect(orphans).toEqual([invented]);
  });
});
