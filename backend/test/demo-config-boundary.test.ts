/**
 * The demo is CONFIGURATION, not part of the product.
 *
 * The platform ships generic: the CDK stacks, the Lambda code and the SSM parameters they provision
 * are seams with no customer in them. Everything that makes this deployment *Stratum Technologies* -
 * the personas, the context corpus, the intent packs, the welcome copy - is configuration applied by
 * the seeder into profiles and parameters. That split is what lets someone deploy this platform for
 * their own company by replacing configuration, without forking the product.
 *
 * It is also easy to break by accident and hard to notice: a demo persona dropped into `lib/` still
 * compiles, still passes every other test, and quietly ships Stratum prose inside the generic
 * artifact. That is exactly what happened - these personas were first written into
 * `backend/lib/demo-personas.ts`, alongside the profile registry that Lambda code imports.
 *
 * So this pins the direction of the dependency: demo config may import from core, never the reverse.
 */
import * as fs from 'fs';
import * as path from 'path';

const BACKEND = path.join(__dirname, '..');

/** Source roots that ship as the generic product. */
const CORE_ROOTS = ['lambda', 'lib', 'bin'];

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(full);
    // .ts only — committed .js/.d.ts build artifacts mirror their sources and would double-report.
    return e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [full] : [];
  });
}

describe('demo configuration stays out of the generic product', () => {
  it('no core source imports from backend/demo', () => {
    const offenders: string[] = [];
    for (const root of CORE_ROOTS) {
      for (const file of sourceFiles(path.join(BACKEND, root))) {
        const src = fs.readFileSync(file, 'utf8');
        // `from '../demo/x'`, `from '../../demo/x'`, require('.../demo/x') — any depth.
        for (const m of src.matchAll(/(?:from|require\()\s*['"]([^'"]*\/demo\/[^'"]*)['"]/g)) {
          offenders.push(`${path.relative(BACKEND, file)} -> ${m[1]}`);
        }
      }
    }
    // Thrown rather than asserted with a message: this Jest does not take a second argument to
    // expect(), and a bare `toEqual([])` failure would print the paths without saying what to do.
    if (offenders.length > 0) {
      throw new Error(
        'Core code must not import demo configuration. Move the demo-specific value into backend/demo/ '
          + 'and have the SEEDER apply it (into a profile definition or an SSM parameter), so the shipped '
          + `product stays generic. Offenders:\n  ${offenders.join('\n  ')}`,
      );
    }
    expect(offenders).toEqual([]);
  });

  it('scans a non-trivial surface (a guard that scans nothing passes vacuously)', () => {
    const count = CORE_ROOTS.reduce((n, r) => n + sourceFiles(path.join(BACKEND, r)).length, 0);
    expect(count).toBeGreaterThan(50);
  });

  it('detects an offending import when one is present (the guard actually fires)', () => {
    // Falsification: the regex above must match the shape it claims to. Without this the test could
    // pass because the pattern is wrong rather than because the codebase is clean.
    const sample = "import { X } from '../demo/personas.js';";
    expect([...sample.matchAll(/(?:from|require\()\s*['"]([^'"]*\/demo\/[^'"]*)['"]/g)]).toHaveLength(1);
  });
});
