/**
 * NO HANDLER READS THE REGISTRY BEFORE IT LOADS IT (the classification-independence plan, step 5).
 *
 * A deployed handler reads the deployment's set at runtime (`loadProfileRegistry`, `lib/profile-registry.ts`),
 * and until that resolves every read of the registry throws, so a value computed from it while modules load
 * would fail the function's cold start. This test finds every Lambda module whose import graph reaches the
 * registry and exports a handler, read from the source rather than listed, and:
 *
 *   - loads each one as a deployed handler would (`PROFILE_REGISTRY_PATH_ENV` set, the registry not loaded), so
 *     a read at module load throws here;
 *   - requires each exported handler to load the registry before it runs: an `await loadProfileRegistry()`, or
 *     the handler wrapped in `withProfileRegistry`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PROFILE_REGISTRY_PATH_ENV } from '../../lib/config/profiles';

const ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY = path.join(ROOT, 'lib', 'profile-registry.ts');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const ALL = [...sources(path.join(ROOT, 'lambda')), ...sources(path.join(ROOT, 'lib'))];
const KNOWN = new Set(ALL);
const IMPORT = /(?:from\s+|require\(|import\()\s*['"](\.[^'"]+)['"]/g;
const deps = new Map<string, string[]>();
for (const f of ALL) {
  // A TYPE-ONLY IMPORT IS ERASED AT BUILD, so it carries no runtime code and reaches nothing: dropped before
  // the walk, or a module that only names a type from a registry reader is wrongly counted as reading it.
  const text = fs.readFileSync(f, 'utf8').replace(/(?:import|export)\s+type\s[^;]*?from\s*['"][^'"]+['"];?/g, '');
  const found: string[] = [];
  for (const m of text.matchAll(IMPORT)) {
    const base = path.resolve(path.dirname(f), m[1]).replace(/\.js$/, '');
    const hit = [`${base}.ts`, path.join(base, 'index.ts')].find((c) => KNOWN.has(c));
    if (hit) found.push(hit);
  }
  deps.set(f, found);
}
function reachesRegistry(f: string): boolean {
  const seen = new Set<string>();
  const stack = [f];
  while (stack.length) {
    const x = stack.pop()!;
    if (x === REGISTRY) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    stack.push(...(deps.get(x) ?? []));
  }
  return false;
}

const HANDLER = /export\s+(?:const|async\s+function|function|let)\s+([A-Za-z0-9_]*[hH]andler)\b/g;
const HANDLER_MODULES = ALL
  .filter((f) => f.includes(`${path.sep}lambda${path.sep}`))
  .map((f) => ({ f, handlers: [...new Set([...fs.readFileSync(f, 'utf8').matchAll(HANDLER)].map((m) => m[1]))] }))
  .filter((m) => m.handlers.length && reachesRegistry(m.f));
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');

describe('no handler reads the registry before it loads it', () => {
  it('finds the handlers that read the registry, so the checks below are not vacuous', () => {
    expect(HANDLER_MODULES.length).toBeGreaterThan(50);
    expect(HANDLER_MODULES.map((m) => rel(m.f))).toEqual(expect.arrayContaining([
      'lambda/src/router-agent-handler.ts', 'lambda/src/credential-exchange.ts', 'lambda/src/edge-authorizer.ts',
    ]));
  });

  it('loads the registry at the start of every handler that reads it', () => {
    const missing: string[] = [];
    for (const { f, handlers } of HANDLER_MODULES) {
      const text = fs.readFileSync(f, 'utf8');
      for (const h of handlers) {
        // The handler's own text: from its last export (the implementation, after any overload signatures) to
        // the next top-level export.
        const exports = [...text.matchAll(new RegExp(`export\\s+(?:const|async\\s+function|function|let)\\s+${h}\\b`, 'g'))];
        const at = exports[exports.length - 1].index!;
        const rest = text.slice(at);
        const next = rest.slice(1).search(/\nexport\s/);
        const body = next < 0 ? rest : rest.slice(0, next + 1);
        if (!/await loadProfileRegistry\(\)|withProfileRegistry\(/.test(body)) missing.push(`${rel(f)} ${h}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('reads nothing from the registry while a handler module loads', () => {
    const failed: string[] = [];
    const saved = process.env[PROFILE_REGISTRY_PATH_ENV];
    process.env[PROFILE_REGISTRY_PATH_ENV] = '/module-load-check/registry/classification';
    try {
      for (const { f } of HANDLER_MODULES) {
        jest.isolateModules(() => {
          try {
            require(f);
          } catch (err) {
            const message = String((err as Error)?.message ?? err);
            if (/before it was loaded/.test(message)) failed.push(`${rel(f)}: ${message.split('\n')[0]}`);
          }
        });
      }
    } finally {
      if (saved === undefined) delete process.env[PROFILE_REGISTRY_PATH_ENV];
      else process.env[PROFILE_REGISTRY_PATH_ENV] = saved;
    }
    expect(failed).toEqual([]);
  }, 600_000);
});
