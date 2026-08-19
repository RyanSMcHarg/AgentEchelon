/**
 * The `.env.example` files advertise which model keys a deployer may set, and that list is a
 * hand-copy of the backend catalog.
 *
 * It drifted: `deepseek_v3` was added to `BackendModelKey`, selectable per classification at deploy
 * time, and both `.env.example` files went on listing six keys. Nothing breaks - the deployer simply
 * never learns the key exists, which is the quiet half of a capability gap: the feature ships and the
 * only document that would tell anyone about it does not mention it.
 *
 * There is no importable boundary (a `.env.example` is a comment in a text file), so the duplication
 * is deliberate and this test is what keeps it honest.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getModelCatalog } from '../../lib/config/model-strategy';

const ENV_EXAMPLES = ['chat', 'admin'].map((pkg) =>
  path.resolve(__dirname, '..', '..', '..', 'frontend', 'packages', pkg, '.env.example'),
);

/** The catalog is the authority; region/account do not affect which KEYS exist. */
function catalogKeys(): string[] {
  return Object.keys(getModelCatalog('us-east-1', '000000000000')).sort();
}

describe('.env.example model keys match the backend catalog', () => {
  it('the catalog has a plausible number of keys (the check is wired to something real)', () => {
    expect(catalogKeys().length).toBeGreaterThanOrEqual(4);
  });

  for (const file of ENV_EXAMPLES) {
    it(`${path.basename(path.dirname(file))}/.env.example lists exactly the catalog keys`, () => {
      const src = fs.readFileSync(file, 'utf8');
      const line = src.split(/\r?\n/).find((l) => l.startsWith('# Supported keys:'));
      if (!line) throw new Error(`no "# Supported keys:" line in ${file}`);
      const listed = line
        .replace('# Supported keys:', '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .sort();
      // Set equality, reported as the two directions, so a failure says WHICH key is missing rather
      // than printing two lists for the reader to diff.
      const catalog = catalogKeys();
      expect(listed.filter((k) => !catalog.includes(k))).toEqual([]); // listed but not a real key
      expect(catalog.filter((k) => !listed.includes(k))).toEqual([]); // real key, undocumented
    });
  }
});
