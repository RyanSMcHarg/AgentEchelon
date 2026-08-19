/**
 * A doc that cites a repo path must cite one that EXISTS.
 *
 * Docs are the first thing an implementer trusts, and a path is the most checkable claim a doc makes —
 * so a broken one is both the cheapest defect to catch and the most misleading to leave. Two kinds
 * were found on 2026-08-08, neither visible to any existing guard:
 *
 *  - **Off-by-one relative paths in ADRs.** Three ADRs listed `../../backend/…` under `related:`, which
 *    from `docs/design/decisions/` resolves to `docs/backend/…`. Ten references, every one dead, in
 *    decision records that name the code implementing the decision. A newer ADR in the same directory
 *    used the correct `../../../backend/…`, so the convention was right and the copies drifted.
 *  - **A transposed filename.** `SPEC-DRIFT-CONVERGENCE` cited
 *    `backend/lib/stacks/analytics-aurora-stack.ts`; the file is `analytics-stack-aurora.ts`.
 *
 * A path that names something not yet built is fine — the bilingual spec's `translation.ts` is a
 * design-level hook point — but it must SAY so, which is why the allowlist below carries a reason
 * rather than just a path.
 */
import * as fs from 'fs';
import * as path from 'path';
import { excludeIgnored } from './helpers/shipped-files';

const ROOT = path.resolve(__dirname, '../..');
const DOCS = path.join(ROOT, 'docs');

/**
 * Paths a doc names deliberately although they do not exist. Each needs a reason: this list is the
 * only way to silence the check, so an unjustified entry is how the guard would rot.
 */
const NOT_YET_BUILT: Record<string, string> = {
  'backend/lambda/src/lib/translation.ts':
    'SPEC-BILINGUAL-CONVERSATIONS level 2 (the inference pivot) is design, not built. The spec marks '
    + 'the path as not existing yet, so a reader is not misled.',
  'backend/lib/stacks/enterprise-classification-stack.ts':
    'HOW-TO-ADD-OR-MANAGE-A-PROFILE tells the reader to CREATE this file ("Create `…` mirroring '
    + 'premium-classification-stack.ts"). Prescriptive, not a claim that it exists.',
  'backend/lambda/cognito-triggers/post-authentication.js':
    'IDENTITY-PROVIDER-GUIDE offers it as a "Lambda handler sketch" for the reader to add. Its '
    + 'sibling `post-confirmation.js` DOES exist and is checked by this guard.',
  'tests/e2e/demo/post2-abtest-battle.demo.spec.ts':
    'A TROUBLESHOOTING entry about a demo driver that is not present in this repository; the entry '
    + 'now says so explicitly rather than pointing at nothing.',
};

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) markdownFiles(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

describe('docs cite code paths that exist', () => {
  // Gitignored docs are private working files, not the shipped surface: their `file:line` citations
  // are a historical record and are expected to go stale.
  const docs = excludeIgnored(markdownFiles(DOCS), ROOT);

  it('every inline repo path in a doc resolves to a real file', () => {
    const broken: string[] = [];
    for (const f of docs) {
      const text = fs.readFileSync(f, 'utf8');
      // Backticked paths rooted at a source directory — the form a doc uses to point at real code.
      const re = // Directory segments may not contain dots — that is what excludes an ABBREVIATED path like
// `frontend/.../messageParser.ts`, which is a doc convention meaning "somewhere under here" rather
// than a claim about a file. The FINAL segment may contain them, or this would silently stop
// matching every `*.spec.ts` and `*.test.ts` — the exact files that were stale.
/`((?:backend|frontend|tests)(?:\/[\w-]+)*\/[\w.-]+\.(?:ts|tsx|js|mjs|sql))`/g;
      for (const m of text.matchAll(re)) {
        const rel = m[1];
        if (NOT_YET_BUILT[rel]) continue;
        if (!fs.existsSync(path.join(ROOT, rel))) {
          broken.push(`${path.relative(ROOT, f).replace(/\\/g, '/')} -> ${rel}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('every code path an ADR lists under `related:` resolves, relative to the ADR', () => {
    // These are RELATIVE, which is what made them wrong: the directory depth has to be counted, and
    // three ADRs counted it one short. Resolving from the ADR's own directory is the only check that
    // would have caught it.
    const broken: string[] = [];
    for (const f of docs.filter((d) => d.includes(`decisions${path.sep}`))) {
      const text = fs.readFileSync(f, 'utf8');
      const frontMatter = text.split('---')[1] || '';
      for (const m of frontMatter.matchAll(/^\s*-\s*"?([^"\n]+?)"?\s*$/gm)) {
        const ref = m[1].trim();
        if (!/\.(ts|tsx|js|mjs|sql|json)$/.test(ref)) continue;
        if (!fs.existsSync(path.resolve(path.dirname(f), ref))) {
          broken.push(`${path.relative(ROOT, f).replace(/\\/g, '/')} -> ${ref}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  /**
   * A CITED LINE NUMBER MUST EXIST.
   *
   * Added 2026-08-08 after a sweep found four dead citations the path check could not see, in specs
   * whose own headings read "verified against the code": `premium-classification-stack.ts:129` in a
   * 50-line file (the per-classification stacks were consolidated into `agent-classification-common`
   * and the citation did not move), plus off-by-many numbers for the moderator create and
   * `AUDITED_EVENT_TYPES`.
   *
   * Resolution is by path SUFFIX and an AMBIGUOUS basename is reported rather than guessed - a first
   * scan of this repo silently resolved a bare `index.js` to the wrong file and invented two failures.
   */
  it('every cited line number is inside the file it cites', () => {
    const all: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (['node_modules', '.git', 'cdk.out', 'dist', 'coverage'].includes(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else all.push(path.relative(ROOT, p).replace(/\\/g, '/'));
      }
    };
    walk(ROOT);

    const broken: string[] = [];
    for (const f of docs) {
      const text = fs.readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      for (const m of text.matchAll(/`([\w./-]*[\w-]+\.(?:ts|tsx|js|mjs|sql)):(\d+)(?:-(\d+))?`/g)) {
        const ref = m[1];
        const end = parseInt(m[3] || m[2], 10);
        const exact = all.filter((x) => x === ref);
        const hits = exact.length ? exact : all.filter((x) => x.endsWith(`/${ref}`));
        if (hits.length === 0) { broken.push(`${rel} -> ${ref}:${m[2]} (no such file)`); continue; }
        if (hits.length > 1) { broken.push(`${rel} -> ${ref}:${m[2]} (AMBIGUOUS: ${hits.length} files; qualify the path)`); continue; }
        const lines = fs.readFileSync(path.join(ROOT, hits[0]), 'utf8').split('\n').length;
        if (end > lines) broken.push(`${rel} -> ${ref}:${m[2]} (${hits[0]} has ${lines} lines)`);
      }
    }
    expect(broken).toEqual([]);
  });

  /**
   * A BARE FILENAME must name a real file. The path check above only sees backticked paths ROOTED at
   * backend/frontend/tests, and that boundary is not academic: commit `1c7bad6` fixed two stale
   * filenames exactly where this guard could see them and left three bare-name copies live
   * (`analytics-aurora-stack.ts`, and `tier-context.spec.ts` in two docs). The guard's regex defined
   * the scope of its own fix.
   */
  it('every bare source filename a doc names exists somewhere in the repo', () => {
    const basenames = new Set<string>();
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (['node_modules', '.git', 'cdk.out', 'dist', 'coverage'].includes(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else basenames.add(e.name);
      }
    };
    walk(ROOT);

    // Prescriptive or deliberately-absent names, each with the reason it is allowed to not exist.
    const ALLOWED: Record<string, string> = {
      ...NOT_YET_BUILT,
      '005-embeddings-titan-v2.sql':
        'ADR-002 proposed this migration name; the decision shipped as 005-summary-embeddings.sql + '
        + '008-document-embeddings.sql. Kept as the historical proposal in a decision record.',
      '012-your-feature.sql': 'AURORA-MODE-GUIDE placeholder telling the reader to CREATE a migration.',
      'multi-party-privacy.ts': 'ADR-007 names it as post-v0.3 future work and says so inline.',
      'agent-invoke.ts': 'ADR-011 records an Option-B swap that was unwound; the file no longer exists by design.',
      'tier-stack.ts': 'ADR-011 historical record, pre the tier -> classification rename.',
      'iam-policies-stack.ts': 'Removed. Named in ADR history only.',
      'manage-conversation.ts': 'Never existed; retained here only if a doc references it historically.',
      'post-authentication.js': 'IDENTITY-PROVIDER-GUIDE offers it as a handler sketch to add.',
      'post2-abtest-battle.demo.spec.ts': 'A demo driver not present in this repository.',
      'translation.ts': 'SPEC-BILINGUAL level 2 is design, not built.',
      'enterprise-classification-stack.ts': 'HOW-TO guide tells the reader to CREATE it.',
    };
    const allowedBase = new Set(
      Object.keys(ALLOWED).map((k) => k.split('/').pop() as string),
    );

    const broken: string[] = [];
    for (const f of docs) {
      const text = fs.readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      for (const m of text.matchAll(/`([\w-]+\.(?:ts|tsx|js|mjs|sql))`/g)) {
        const name = m[1];
        if (allowedBase.has(name) || basenames.has(name)) continue;
        broken.push(`${rel} -> ${name}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('the check is not vacuous — it finds paths to check', () => {
    // A regex that matches nothing passes both assertions above while verifying nothing at all.
    let cited = 0;
    for (const f of docs) {
      const text = fs.readFileSync(f, 'utf8');
      cited += [...text.matchAll(// Directory segments may not contain dots — that is what excludes an ABBREVIATED path like
// `frontend/.../messageParser.ts`, which is a doc convention meaning "somewhere under here" rather
// than a claim about a file. The FINAL segment may contain them, or this would silently stop
// matching every `*.spec.ts` and `*.test.ts` — the exact files that were stale.
/`((?:backend|frontend|tests)(?:\/[\w-]+)*\/[\w.-]+\.(?:ts|tsx|js|mjs|sql))`/g)].length;
    }
    expect(cited).toBeGreaterThan(50);
  });
});
