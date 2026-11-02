/**
 * AN OPS SCRIPT IMPORTS ONLY WHAT THE LIBRARY STILL EXPORTS. Scripts under `scripts/` load the compiled `lib/`
 * by name (`import { x } from '../lib/m.js'`, `const { x } = require('../lib/m.js')`). Nothing type-checks them,
 * so an export a refactor removes or renames surfaces only when someone runs the script against a deployment.
 * This reads each named import and requires the TypeScript module beside the compiled path to export it.
 */
import * as fs from 'fs';
import * as path from 'path';

const BACKEND = path.join(__dirname, '..');
const SCRIPTS = path.join(BACKEND, 'scripts');
const IMPORT =
  /(?:import\s*\{([^}]*)\}\s*from|const\s*\{([^}]*)\}\s*=\s*(?:createRequire\(import\.meta\.url\)|require)\()\s*'((?:\.\.\/)+lib\/[^']+)\.js'/g;

interface NamedImport {
  script: string;
  target: string;
  name: string;
}

function scriptFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : scriptFiles(p);
    return /\.(mjs|cjs|js)$/.test(e.name) ? [p] : [];
  });
}

function exportsName(source: string, name: string): boolean {
  const n = name.replace(/\$/g, '\\$');
  return (
    new RegExp(
      `export\\s+(?:declare\\s+)?(?:async\\s+)?(?:const|let|var|function\\*?|class|abstract\\s+class|enum|interface|type)\\s+${n}\\b`,
    ).test(source) ||
    new RegExp(`export\\s*\\{[^}]*\\b${n}\\b[^}]*\\}`).test(source) ||
    /export\s*\*\s*from/.test(source)
  );
}

const imports: NamedImport[] = scriptFiles(SCRIPTS).flatMap((file) => {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(IMPORT)].flatMap((m) => {
    const names = (m[1] ?? m[2])
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+|\s*:\s*/)[0].trim())
      .filter(Boolean);
    const target = path.resolve(path.dirname(file), m[3]);
    return names.map((name) => ({ script: path.relative(BACKEND, file).replace(/\\/g, '/'), target, name }));
  });
});

describe('an ops script imports only what lib exports', () => {
  it('finds the scripts that import lib by name', () => {
    expect(imports.length).toBeGreaterThan(5);
  });

  it.each(imports.map((i) => [i.script, i.name, i] as const))('%s imports %s', (_script, _name, i) => {
    const ts = `${i.target}.ts`;
    expect(fs.existsSync(ts)).toBe(true);
    expect(exportsName(fs.readFileSync(ts, 'utf8'), i.name)).toBe(true);
  });
});
