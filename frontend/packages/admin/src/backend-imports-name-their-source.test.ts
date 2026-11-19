/**
 * THE CONSOLE IMPORTS BACKEND SOURCE BY ITS `.ts` NAME. The backend compiles CommonJS `.js` beside each source file, and a
 * production build resolves an extensionless import to that `.js`, whose named exports it cannot read; `tsc` and vitest
 * resolve the `.ts` and pass. Only `vite build` would fail, at deploy, so this reads every import here instead.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('backend imports', () => {
  it('name their .ts source', () => {
    const offenders = sources(__dirname).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/from '((?:\.\.\/)+backend\/[^']+)'/g)]
        .map((m) => m[1])
        .filter((spec) => !spec.endsWith('.ts'))
        .map((spec) => `${file}: ${spec}`));
    expect(offenders).toEqual([]);
  });
});
