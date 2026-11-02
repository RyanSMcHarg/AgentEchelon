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
import { resolveDeploymentProfiles } from '../lib/config/profiles';

const BACKEND_DIR = path.join(__dirname, '..');
const EXAMPLE_PATH = path.join(BACKEND_DIR, 'deploy.config.example.json');

/**
 * Every context key the app reads, INCLUDING the ones it reads through a helper.
 *
 * A DIRECT-LITERAL SCAN WAS NOT ENOUGH, and what it missed was the spend controls. The classification
 * stacks read context through a local `ctxNum(k)` wrapper that supplies a default, so the only literal
 * is at the CALL SITE and `tryGetContext` itself never sees one. `bedrockUserHourlyBudget` and
 * `bedrockGlobalHourlyBudget` were therefore invisible here, missing from the example, and missing
 * from the real deploy config - so both shipped as "0", which `checkAndConsumeBudget` reads as "not
 * configured" and switches the entire spend limit off. The guard that exists to stop a flag hiding
 * in the source hid the two that bound cost.
 *
 * Same shape as the DynamoDB command guard beside it: resolve ONE hop, because one hop is where these
 * hide.
 */
function contextKeysInSource(roots: string[]): Map<string, string> {
  const found = new Map<string, string>();
  const add = (key: string, file: string): void => {
    if (!found.has(key)) found.set(key, path.relative(BACKEND_DIR, file));
  };
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        const src = fs.readFileSync(full, 'utf8');
        for (const m of src.matchAll(/tryGetContext\(\s*'([^']+)'/g)) add(m[1], full);

        // A helper whose body reads `tryGetContext` with a NON-literal argument is a reader by proxy,
        // so the keys live at its call sites instead. Named declarations only, and only within the
        // file that declares them, so a same-named function elsewhere cannot invent a key.
        const helpers = new Set<string>();
        for (const m of src.matchAll(/(?:const|function)\s+([A-Za-z_$][\w$]*)\s*(?:=|\()/g)) {
          const body = src.slice(m.index ?? 0, (m.index ?? 0) + 400);
          if (/tryGetContext\(\s*[A-Za-z_$]/.test(body)) helpers.add(m[1]);
        }
        for (const name of helpers) {
          for (const m of src.matchAll(new RegExp(name + "\\(\\s*'([^']+)'", 'g'))) add(m[1], full);
        }
      }
    }
  };
  for (const r of roots) walk(path.join(BACKEND_DIR, r));
  return found;
}

/**
 * The keys a provisioning script reads from the deployer's `deploy.config.json` itself (`config.<key>` in
 * `scripts/lib`), such as the demo cast's `presenterMailbox`. Documented beside the context flags, because
 * the deployer sets them in the same file; read by a script, never by the stacks.
 */
function scriptConfigKeys(): Set<string> {
  const dir = path.join(BACKEND_DIR, 'scripts', 'lib');
  const found = new Set<string>();
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.cjs'))) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const m of src.matchAll(/\bconfig\.([a-z][A-Za-z0-9]*)\b/g)) found.add(m[1]);
  }
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
    const byScripts = scriptConfigKeys();
    const stale = [...documentedKeys()].filter((k) => !inSource.has(k) && !byScripts.has(k)).sort();

    if (stale.length > 0) {
      throw new Error(
        'These keys are documented in deploy.config.example.json but no longer read anywhere in\n'
          + 'bin/, lib/ or a provisioning script in scripts/lib/. Either the key is misspelled (so setting it would silently do nothing) or\n'
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

/**
 * THE EXAMPLE'S CUSTOM SET IS RUN, NOT READ. A deployer copies it, so it goes through the same resolution and
 * validation a deployment's `profiles` does, and a key the validator retires fails here before it fails a synth.
 */
describe('deploy.config.example.json shows a profiles value that synthesizes', () => {
  const raw = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8')) as Record<string, unknown>;

  it('resolves the custom-set example through the deployment validator', () => {
    const example = raw._profilesCustomSetExample;
    expect(example).toEqual(expect.objectContaining({ classifications: expect.any(Array) }));
    const resolved = resolveDeploymentProfiles(example);
    expect(resolved.classifications.map((c) => c.value)).toContain('legal');
  });

  it('resolves the custom-set example passed as a JSON string, the form a context value takes', () => {
    expect(() => resolveDeploymentProfiles(JSON.stringify(raw._profilesCustomSetExample))).not.toThrow();
  });

  it('names no retired profiles key in its prose', () => {
    expect(String(raw._profiles)).not.toMatch(/modelSelectionKey|externalProviderAllowed/);
  });
});
