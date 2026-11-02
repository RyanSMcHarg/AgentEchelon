/**
 * NO IDENTITY POOL ANYWHERE IN THE FRONTEND.
 *
 * The credential exchange is the only source of Amazon Chime SDK credentials: it vends a credential
 * bearer-pinned to the caller's own AppInstanceUser and bound to their classification. A second path
 * through a Cognito Identity Pool would hand out credentials that answer to neither, so its client, its
 * SDK packages, its configuration variable and its name are refused everywhere under `frontend/`:
 * source, tests, manifests, the lockfile and the `.env` examples, and in the script that writes the
 * apps' `.env` files (`backend/scripts/gen-frontend-env.mjs`).
 *
 * The patterns are assembled from parts so this file does not match itself.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SELF = fileURLToPath(import.meta.url);
const ENV_WRITERS = ['gen-frontend-env.mjs', 'lib/sign-in-issuers.cjs'].map((f) => path.resolve(FRONTEND, '../backend/scripts', f));
const SKIP_DIRS = new Set(['node_modules', 'dist', '.vite', 'coverage']);
// The checked-in examples only: a generated, gitignored `.env` is the developer's own.
const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|css|html|md)$|^\.env\.example$/;

const POOL = ['identity', 'pool'];
const FORBIDDEN: Array<[string, RegExp]> = [
  ['the Identity Pool by name', new RegExp(POOL.join('[\\s_-]*'), 'i')],
  ['the Identity Pool SDK client', new RegExp('@aws-sdk/client-cognito-' + 'identity(?!-provider)')],
  ['the Identity Pool credential provider', new RegExp('credential-provider-cognito-' + 'identity')],
  ['the Identity Pool credential helper', new RegExp('from' + 'CognitoIdentity')],
  ['the Identity Pool client class', new RegExp('CognitoIdentity' + 'Client\\b')],
];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full));
    else if (TEXT.test(name) && full !== SELF) out.push(full);
  }
  return out;
}

describe('the frontend has no Identity Pool', () => {
  const scanned = [...files(FRONTEND), ...ENV_WRITERS];

  it('scans the whole frontend, not an empty directory', () => {
    // Non-vacuity: a wrong root would scan nothing and pass.
    expect(scanned.some((f) => f.endsWith(path.join('chat', 'src', 'services', 'chimeService.ts')))).toBe(true);
    expect(scanned.some((f) => f.endsWith('package-lock.json'))).toBe(true);
    expect(scanned.some((f) => f.endsWith(path.join('chat', '.env.example')))).toBe(true);
  });

  it('neither imports nor names it anywhere', () => {
    const hits: string[] = [];
    for (const file of scanned) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const [what, re] of FORBIDDEN) {
          if (re.test(line)) hits.push(`${path.relative(FRONTEND, file)}:${i + 1} names ${what}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
