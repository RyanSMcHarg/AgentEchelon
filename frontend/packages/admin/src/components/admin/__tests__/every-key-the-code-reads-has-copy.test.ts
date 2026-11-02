/**
 * EVERY KEY THE CODE READS IS COPY IN THE LOCALE FILE.
 *
 * A key with no value renders as the key itself: `admin.effectiveness.clearFilter` on a button, measured on a
 * deployed console. i18next does not fail on it, the type checker cannot see it, and the existing locale guards
 * check what the file holds rather than what the code asks for. Five were missing at once: one dropped by a
 * locale cleanup, three written into the code and never into the file, and one naming a group (`column.costPerReply`)
 * instead of its text, which renders as the key too.
 *
 * What it checks: every literal key passed to `t(`, `translate(` or `i18n.t(` in the admin, chat and shared
 * sources resolves to a string, or to a plural form (`_one` / `_other`). A key built at runtime is not seen here;
 * `module-scope-copy-resolves-not-the-key.test.ts` covers the maps that build them.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const PACKAGES = path.resolve(__dirname, '..', '..', '..', '..', '..');
const en = JSON.parse(fs.readFileSync(path.join(PACKAGES, 'shared', 'src', 'locales', 'en.json'), 'utf8')) as Record<string, unknown>;

const valueOf = (key: string): unknown => key.split('.')
  .reduce<unknown>((o, part) => (o && typeof o === 'object' && part in (o as object) ? (o as Record<string, unknown>)[part] : undefined), en);
const isCopy = (key: string): boolean => typeof valueOf(key) === 'string'
  || typeof valueOf(`${key}_one`) === 'string' || typeof valueOf(`${key}_other`) === 'string';

const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.name === 'node_modules' || e.name === '__tests__') return [];
  if (e.isDirectory()) return sources(p);
  return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
});

const KEY = /\b(?:t|translate|i18n\.t)\(\s*['"]((?:admin|auth|app|common|chat|conversation)\.[A-Za-z0-9_.-]+)['"]/g;

describe('the locale file', () => {
  const read: Array<{ key: string; file: string }> = [];
  for (const pkg of ['admin', 'chat', 'shared']) {
    for (const file of sources(path.join(PACKAGES, pkg, 'src'))) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(KEY)) read.push({ key: m[1], file: path.relative(PACKAGES, file) });
    }
  }

  it('finds the keys the code reads, so the check below is not vacuous', () => {
    expect(read.length).toBeGreaterThan(500);
  });

  it('holds copy for every key the code reads', () => {
    const missing = read.filter((r) => !isCopy(r.key)).map((r) => `${r.key} (${r.file})`);
    expect([...new Set(missing)]).toEqual([]);
  });
});
