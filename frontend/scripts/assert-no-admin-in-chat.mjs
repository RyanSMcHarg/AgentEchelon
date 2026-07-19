#!/usr/bin/env node
/**
 * assert-no-admin-in-chat.mjs — the security-relevant invariant of the admin/chat
 * split (SPEC-SEPARATE-ADMIN-APP.md): the CHAT entry (packages/chat/src/main.tsx)
 * must never resolve a module physically under packages/admin/. If it did, the
 * public chat bundle would ship operator code again.
 *
 * Post-monorepo-split update: @ae/chat and @ae/admin are now separate npm
 * workspace packages (packages/chat, packages/admin) sharing @ae/shared
 * (packages/shared) — there is no longer a single `src/components/admin/`
 * tree to blocklist by path prefix. The invariant is now simply "the chat
 * entry's import graph never lands inside packages/admin/", checked by
 * walking chat's REAL module graph, including through the `@ae/shared`
 * package import (resolved to its source, mirroring @ae/shared's `exports`
 * map) so a future admin-only addition smuggled into shared is also caught.
 *
 * We assert on the SOURCE import graph, not the minified bundle: minification
 * mangles identifiers and drops module paths, so grepping the built JS for
 * "packages/admin" is unreliable. Walking the static import graph from the chat
 * entry is deterministic and fails a re-coupling refactor at build time.
 *
 * Usage (from frontend/):  node scripts/assert-no-admin-in-chat.mjs
 * Wired into the chat deploy so a regression cannot ship silently.
 */
import { readFile, access, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, '..');
const chatSrcDir = path.join(workspaceRoot, 'packages', 'chat', 'src');
const sharedSrcDir = path.join(workspaceRoot, 'packages', 'shared', 'src');
const adminDir = path.join(workspaceRoot, 'packages', 'admin');
const ENTRY = path.join(chatSrcDir, 'main.tsx');

// Any resolved import physically under this directory taints the chat bundle.
const FORBIDDEN_PREFIX = adminDir;

const CANDIDATE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs'];
const INDEX_EXTS = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function resolveWithExtensions(base) {
  for (const ext of CANDIDATE_EXTS) {
    const cand = base + ext;
    if (!(await exists(cand))) continue;
    try {
      if ((await stat(cand)).isFile()) return cand;
    } catch { /* fallthrough to index resolution */ }
  }
  for (const idx of INDEX_EXTS) {
    const cand = path.join(base, idx);
    if (await exists(cand)) return cand;
  }
  return null;
}

// @ae/shared's package.json `exports` map, mirrored here so the walker follows
// the bare `@ae/shared` import into real source instead of stopping at the
// package boundary — the whole point being to also catch an admin-only module
// smuggled into shared (belt-and-suspenders on top of the packages/admin/ prefix
// check).
function resolveSharedSpecifier(spec) {
  if (spec === '@ae/shared') return path.join(sharedSrcDir, 'index.ts');
  if (spec === '@ae/shared/i18n') return path.join(sharedSrcDir, 'i18n', 'index.ts');
  const rest = spec.slice('@ae/shared/'.length);
  return path.join(sharedSrcDir, rest);
}

// Resolve an import specifier (relative, or the `@ae/shared` workspace package)
// to a concrete on-disk module path, trying the usual TS/JS extension +
// index-file combinations. Any other bare/package import (react, aws-sdk, …)
// is out of our source graph and returns null.
async function resolveImport(fromFile, spec) {
  if (spec === '@ae/shared' || spec.startsWith('@ae/shared/')) {
    return resolveWithExtensions(resolveSharedSpecifier(spec));
  }
  if (!spec.startsWith('.')) return null; // other bare/package import — not our source graph
  const base = path.resolve(path.dirname(fromFile), spec);
  return resolveWithExtensions(base);
}

// Match static `from '...'`, side-effect `import '...'`, and dynamic `import('...')`.
const IMPORT_RE = /(?:import\s[^'"]*from\s*|import\s*|import\s*\()\s*['"]([^'"]+)['"]/g;

function specifiersOf(source) {
  const out = new Set();
  let m;
  while ((m = IMPORT_RE.exec(source))) out.add(m[1]);
  return out;
}

function taints(resolved) {
  return resolved === FORBIDDEN_PREFIX || resolved.startsWith(FORBIDDEN_PREFIX + path.sep);
}

async function main() {
  const visited = new Set();
  const violations = [];
  // BFS over the chat entry's static import graph (through @ae/shared too).
  // Track the path so a violation reports HOW the admin module got pulled in.
  const queue = [{ file: ENTRY, chain: ['main.tsx'] }];
  while (queue.length) {
    const { file, chain } = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);

    let source;
    try {
      source = await readFile(file, 'utf8');
    } catch {
      continue; // unreadable (e.g. a .css asset resolved as a module) — ignore
    }

    for (const spec of specifiersOf(source)) {
      const resolved = await resolveImport(file, spec);
      if (!resolved) continue;
      const label = resolved.startsWith(workspaceRoot)
        ? path.relative(workspaceRoot, resolved)
        : resolved;
      if (taints(resolved)) {
        violations.push(`${chain.join(' -> ')} -> ${label}`);
        continue; // don't descend into admin code
      }
      queue.push({ file: resolved, chain: [...chain, label] });
    }
  }

  if (violations.length) {
    console.error('\n❌ Chat bundle taint: the chat entry imports admin-only code.');
    console.error('   The public chat SPA must not carry operator code (SPEC-SEPARATE-ADMIN-APP.md).');
    console.error('   Offending import chains:');
    for (const v of violations) console.error(`     ${v}`);
    console.error('');
    process.exit(1);
  }

  console.log(`✅ Chat entry import graph is admin-free (${visited.size} modules scanned).`);
}

main().catch((err) => {
  console.error('assert-no-admin-in-chat failed:', err?.stack || err?.message || err);
  process.exit(1);
});
