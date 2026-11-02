/**
 * THE REGISTRY IS ONE MODULE IN A BUNDLE. `tsc` emits `lib/profile-registry.js` beside the source, and esbuild
 * bundles an existing `.js` file when an import names it, so `'../../lib/profile-registry.js'` and
 * `'../../lib/profile-registry'` in one bundle are two copies of the module, each with its own registry. A handler
 * that loads one copy and reads the other reads a registry that is never loaded, and every read throws.
 *
 * Every import of the registry names it without an extension, which esbuild resolves to the one source file.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const DIRS = ['lambda/src', 'lib', 'bin'];
const IMPORT_WITH_EXTENSION = /from\s+['"][^'"]*profile-registry\.js['"]|import\(\s*['"][^'"]*profile-registry\.js['"]\s*\)/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...sources(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('the profile registry is one module in a bundle', () => {
  it('no source imports the registry by its compiled .js path', () => {
    const offenders = DIRS
      .flatMap((d) => sources(path.join(ROOT, d)))
      .filter((f) => IMPORT_WITH_EXTENSION.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
    expect(offenders).toEqual([]);
  });
});
