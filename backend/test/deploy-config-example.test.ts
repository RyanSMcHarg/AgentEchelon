/**
 * The deploy context is the one piece of deploy-time configuration that is NOT in the repo:
 * `deploy.config.json` is gitignored because its VALUES are per-instance (account id, VPC id,
 * secret ARNs, sender address). Its KEYS are not sensitive - they are already public in
 * `bin/backend.ts` and `lib/**` - so a partial example protects nothing and only hides flags.
 *
 * That is not a cosmetic gap. Many flags gate resources that ALREADY EXIST, and an absent flag
 * reads as "off", so deploying with an incomplete set DELETES things (the admin persona/IAM teeth
 * cascade, live drift + Aurora RAG unwiring, CORS reset to localhost). A deployer who cannot
 * discover a flag cannot forward it.
 *
 * So: every `tryGetContext` key the app reads must appear in `deploy.config.example.json`. This
 * test is what keeps that true as flags are added - the example had drifted to 8 of 59 keys before
 * it existed, purely because nothing enforced it.
 */
import * as fs from 'fs';
import * as path from 'path';

const BACKEND_DIR = path.join(__dirname, '..');
const EXAMPLE_PATH = path.join(BACKEND_DIR, 'deploy.config.example.json');

/** Every distinct `tryGetContext('key')` literal under the given roots. */
function contextKeysInSource(roots: string[]): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        const src = fs.readFileSync(full, 'utf8');
        for (const m of src.matchAll(/tryGetContext\(\s*'([^']+)'/g)) {
          if (!found.has(m[1])) found.set(m[1], path.relative(BACKEND_DIR, full));
        }
      }
    }
  };
  for (const r of roots) walk(path.join(BACKEND_DIR, r));
  return found;
}

/** Documented keys. `_`-prefixed entries are comments (deploy.mjs skips them). */
function documentedKeys(): Set<string> {
  const raw = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8')) as Record<string, unknown>;
  return new Set(Object.keys(raw).filter((k) => !k.startsWith('_')));
}

describe('deploy.config.example.json documents the real deploy context', () => {
  it('documents every context flag the CDK app reads', () => {
    const inSource = contextKeysInSource(['bin', 'lib']);
    const documented = documentedKeys();

    const undocumented = [...inSource.entries()]
      .filter(([key]) => !documented.has(key))
      .map(([key, file]) => `  ${key}  (read in ${file})`)
      .sort();

    if (undocumented.length > 0) {
      throw new Error(
        'These cdk context flags are read by the app but are missing from deploy.config.example.json.\n'
          + 'A deployer cannot forward a flag they cannot discover, and an absent flag reads as "off" -\n'
          + 'which for the admin/IAM/drift flags DELETES existing grants. Add each key (an empty value\n'
          + 'is skipped by deploy.mjs, so it safely means "take the default"):\n'
          + undocumented.join('\n'),
      );
    }
    expect(undocumented).toEqual([]);
  });

  it('documents no flag the app does not read (catches typos and retired flags)', () => {
    const inSource = contextKeysInSource(['bin', 'lib']);
    const stale = [...documentedKeys()].filter((k) => !inSource.has(k)).sort();

    if (stale.length > 0) {
      throw new Error(
        'These keys are documented in deploy.config.example.json but no longer read anywhere in\n'
          + 'bin/ or lib/. Either the key is misspelled (so setting it would silently do nothing) or\n'
          + 'the flag was retired and its entry should be removed:\n'
          + stale.map((k) => `  ${k}`).join('\n'),
      );
    }
    expect(stale).toEqual([]);
  });

  it('is valid JSON with a value for every documented key', () => {
    const raw = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8')) as Record<string, unknown>;
    for (const [key, value] of Object.entries(raw)) {
      // undefined/null would be skipped by deploy.mjs the same way "" is, but "" is the explicit,
      // reviewable way to say "take the default" - keep the file unambiguous.
      if (value === undefined || value === null) {
        throw new Error(`${key} must have a concrete value; use "" to mean "take the default".`);
      }
    }
  });
});
