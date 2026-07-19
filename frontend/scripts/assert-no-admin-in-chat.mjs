#!/usr/bin/env node
/**
 * assert-no-admin-in-chat.mjs — the security-relevant invariant of the admin/chat
 * split (SPEC-SEPARATE-ADMIN-APP.md): the CHAT entry (src/main.tsx) must import
 * NOTHING under src/components/admin/ and no admin-only service. If it did, the
 * public chat bundle would ship operator code again.
 *
 * We assert on the SOURCE import graph, not the minified bundle: minification
 * mangles identifiers and drops module paths, so grepping the built JS for
 * "components/admin" is unreliable. Walking the static import graph from the chat
 * entry is deterministic and fails a re-coupling refactor at build time.
 *
 * Usage (from frontend/):  node scripts/assert-no-admin-in-chat.mjs
 * Wired into the chat deploy so a regression cannot ship silently.
 */
import { readFile, access, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, '..', 'src');
const ENTRY = path.join(srcDir, 'main.tsx');

// Any import resolving under these (relative to src/) taints the chat bundle.
const FORBIDDEN_PREFIXES = [
  path.join(srcDir, 'components', 'admin'),
];
// Admin-only services that live outside components/admin/ but must not be in chat.
const FORBIDDEN_FILES = new Set(
  ['adminConversationService', 'membershipAuditService'].map((n) =>
    path.join(srcDir, 'services', n),
  ),
);

const CANDIDATE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs'];
const INDEX_EXTS = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

// Resolve a relative import specifier to a concrete on-disk module path, trying
// the usual TS/JS extension + index-file combinations.
async function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // bare/package import — not our source graph
  const base = path.resolve(path.dirname(fromFile), spec);
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

// Match static `from '...'`, side-effect `import '...'`, and dynamic `import('...')`.
const IMPORT_RE = /(?:import\s[^'"]*from\s*|import\s*|import\s*\()\s*['"]([^'"]+)['"]/g;

function specifiersOf(source) {
  const out = new Set();
  let m;
  while ((m = IMPORT_RE.exec(source))) out.add(m[1]);
  return out;
}

function taints(resolved) {
  if (FORBIDDEN_PREFIXES.some((p) => resolved.startsWith(p + path.sep) || resolved === p)) return true;
  for (const f of FORBIDDEN_FILES) {
    if (resolved === f || CANDIDATE_EXTS.some((e) => resolved === f + e)) return true;
  }
  return false;
}

async function main() {
  const visited = new Set();
  const violations = [];
  // BFS over the chat entry's static import graph. Track the path so a violation
  // reports HOW the admin module got pulled in.
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
      if (taints(resolved)) {
        violations.push(`${chain.join(' -> ')} -> ${path.relative(srcDir, resolved)}`);
        continue; // don't descend into admin code
      }
      queue.push({ file: resolved, chain: [...chain, path.relative(srcDir, resolved)] });
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
