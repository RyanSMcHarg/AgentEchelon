/**
 * THE ADMIN CONSOLE BUILDS FOR THE BROWSER, so a backend module it imports may import no Node-only module (`node:*`, or
 * `canonical-json`, which hashes with Node's crypto). Vitest runs in Node and cannot catch this; the browser build can.
 */
import * as fs from 'fs';
import * as path from 'path';

const backendSrc = path.join(__dirname, '..', '..', 'lambda', 'src');
const adminSrc = path.join(__dirname, '..', '..', '..', 'frontend', 'packages', 'admin', 'src');

const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);

it('imports no Node-only module through any backend file the console reaches', () => {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const visit = (file: string): void => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^import(?!\s+type)[^'"]*from\s+'([^']+)'/gm)) {
      const spec = m[1];
      if (spec.startsWith('node:') || /canonical-json/.test(spec)) offenders.push(`${path.relative(backendSrc, file)} -> ${spec}`);
      else if (spec.startsWith('.')) visit(path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts')));
    }
  };
  for (const f of walk(adminSrc)) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/^import(?!\s+type)[^'"]*from\s+'([^']*backend\/lambda\/src[^']*)'/gm)) {
      visit(path.resolve(path.dirname(f), m[1].replace(/\.js$/, '.ts')));
    }
  }
  expect(seen.size).toBeGreaterThan(0);
  expect(offenders).toEqual([]);
});
