/**
 * NAMING RATCHET: internal surfaces say "classification", not "tier".
 *
 * "tier" is the customer-facing word. Internally the concept is a CLASSIFICATION, and every live
 * decision reads the immutable classification tag. Mixing the two makes it unclear whether a given
 * "tier" is a user-visible label or a platform boundary, which is precisely the confusion the
 * rename existed to remove.
 *
 * WHY A RATCHET, AND NOT A ONE-OFF SWEEP.
 *
 * This has been "fixed" before. An earlier migration renamed the symbols on the decision path -
 * real work, correctly done - and was then remembered as "renamed tier to classification", which
 * reads as complete. It never covered test names, labels, operator tooling or docs, and NOTHING
 * ENFORCED IT. Roughly 2000 occurrences survived, and the next person to look found them again and
 * had to be told a second time.
 *
 * So the goal here is not to finish the rename in one pass. It is to make "is the naming clean"
 * a question the BUILD answers rather than one a person answers from memory. New code cannot
 * introduce internal "tier"; the existing debt is enumerated below and burned down deliberately.
 *
 * HOW TO USE IT:
 *  - Adding a file? It must be classification-clean, or the build fails.
 *  - Cleaning a file? Delete its line from GRANDFATHERED. The count only goes down.
 *  - Tempted to add a line? Don't. That is how the previous attempt quietly stopped.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Internal surfaces only. Customer-facing copy is handled by the exemptions below. */
const SCAN_ROOTS = ['backend/lambda/src', 'backend/lib', 'backend/scripts', 'tests/e2e'];
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.sql']);

/**
 * Legitimate uses that are NOT drift. Each needs a reason; this list is the only way to silence the
 * ratchet, so an unjustified entry is how it rots.
 */
const EXEMPT: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /\buserTier\b|\bmodelTier\b/,
    why: 'Wire/DTO fields the CHAT UI renders as the user-visible tier badge. Renaming these is a '
      + 'customer-facing change, not an internal one.',
  },
  {
    // Matches a JSONB operator applied to the OLD key (`metadata - 'tier'`, `metadata ? 'tier'`,
    // `metadata -> 'tier'`) - a shape only a migration that MOVES that key would ever write.
    pattern: /metadata\s*(->>?|-|\?)\s*'tier'/,
    why: 'the schema-020 rename migration has to name the old key in order to move it. Scoped to the '
      + 'JSONB-operator form so it exempts the migration and nothing else: a new read or write of '
      + "`metadata->>'tier'` outside a migration still fails this ratchet.",
  },
  // The blanket `metadata->>'tier'` exemption is GONE: schema 020 renamed the key to `classification` and
  // moved the value on every existing row, so the isolation filter now says what it means. It was
  // exempted because renaming a key stamped on every embedded row is a data migration, not a naming
  // sweep - which stayed true; it was done as one, with the isolation tests re-run against it.
  // Do not re-add it. A `tier` key reappearing on the embeddings path is drift again.
  {
    pattern: /user_tier|messages_per_tier_daily/,
    why: 'Persisted analytics JSONB key and an analytics queryType. Both need a data migration plus '
      + 'a coordinated reader/writer change; scheduled, not silently kept.',
  },
  {
    // Deliberately anchored to the ARRAY LITERAL that starts an experiment payload's field, so a
    // sentence like "the premium tier assistant" in the same file is still caught. A bare /tiers/
    // would exempt any prose using the plural.
    pattern: /\btiers:\s*\[/,
    why: 'The `tiers` field on the PERSISTED experiment record and its POST /admin/experiments wire '
      + 'contract. Same class as userTier/modelTier above: renaming it is a data migration plus a '
      + 'coordinated API change, not a naming sweep. Exempted as a pattern rather than by '
      + 'grandfathering each caller, because the GRANDFATHERED list only ever shrinks and every new '
      + 'experiment test would otherwise have to be added to it.',
  },
  {
    // Requires SSM / Parameter Store ON THE SAME LINE. A bare /Standard[- ]tier/ would also exempt
    // "the standard tier assistant" - a genuine classification reference - and silently punch a hole
    // in the ratchet. Two GRANDFATHERED files went "clean" under the looser form, which is how the
    // over-match surfaced.
    pattern: /(SSM|Parameter Store)[^\n]*\b(Standard|Advanced)[ -]tier\b/i,
    why: 'AWS SSM Parameter Store\'s OWN product tiers (Standard = 4096 characters, Advanced = 8KB). '
      + 'This is a third-party name for a storage limit and has nothing to do with an AgentEchelon '
      + 'classification; renaming it would make the code disagree with the AWS documentation and the '
      + 'error the API actually returns. Exempted as a PATTERN rather than by grandfathering the '
      + 'file, so any genuine classification "tier" in the same file is still caught.',
  },
];

/**
 * Files with known remaining internal "tier". Burn down; never extend.
 *
 * Seeded 2026-07-31 from the state at the time the ratchet was added, so it goes green immediately
 * without a 2000-line change that nobody could review.
 */
const GRANDFATHERED = new Set<string>([
  'backend/lambda/src/admin-conversations.ts',
  'backend/lambda/src/admin-experiments.ts',
  'backend/lambda/src/analytics-aurora/analytics-query.ts',
  'backend/lambda/src/analytics-aurora/schema/008-document-embeddings.sql',
  'backend/lambda/src/analytics-query.ts',
  'backend/lambda/src/assistant-async-processor.ts',
  'backend/lambda/src/channel-battle.ts',
  'backend/lambda/src/channel-flow-processor.ts',
  'backend/lambda/src/create-app-instance-admin.ts',
  'backend/lambda/src/credential-exchange.ts',
  'backend/lambda/src/federated-credential-exchange.ts',
  'backend/lambda/src/lib/analytics-metadata.ts',
  'backend/lambda/src/lib/async-processor-core.ts',
  'backend/lambda/src/lib/auth.ts',
  'backend/lambda/src/lib/caller-scope.ts',
  'backend/lambda/src/lib/experiment-manager.ts',
  'backend/lambda/src/lib/live-drift-flow.ts',
  'backend/lambda/src/lib/onboarding-intake.ts',
  'backend/lambda/src/lib/profile-lifecycle.ts',
  'backend/lambda/src/lib/profile-manifest.ts',
  'backend/lambda/src/lib/seed-profile-definitions.ts',
  'backend/lambda/src/membership-audit.ts',
  'backend/lambda/src/user-management.ts',
  'backend/lib/config/admin-capabilities.ts',
  'backend/lib/config/profiles.ts',
  'backend/lib/constructs/membership-audit.ts',
  'backend/lib/stacks/agent-classification-common.ts',
  'backend/lib/stacks/analytics-stack-aurora.ts',
  'backend/lib/stacks/analytics-stack.ts',
  'backend/lib/stacks/assistant-profile-stack.ts',
  // `battle-stack.ts` left this list 2026-08-16: its last offending token was a citation of
  // `SPEC-PER-TIER-OWNERSHIP`, a document renamed to `SPEC-PER-PROFILE-OWNERSHIP` by the
  // tier→classification work. Repointing the citation at the document that exists cleaned the file,
  // and the ratchet caught that the list had gone stale in the same motion.
  'backend/lib/stacks/channel-flow-stack.ts',
  'backend/lib/stacks/cognito-auth-stack.ts',
  'backend/lib/stacks/experiments-stack.ts',
  'backend/lib/stacks/foundations-stack.ts',
  'backend/scripts/backfill-analytics-placeholders.mjs',
  'backend/scripts/backfill-channel-classification-tags.mjs',
  'backend/scripts/backfill-channel-flow.mjs',
  'backend/scripts/backfill-tier-groups.mjs',
  'backend/scripts/concurrency-check.ts',
  'backend/scripts/deny-test-credential-exchange.mjs',
  'backend/scripts/deploy.mjs',
  'backend/scripts/e2e-router-dispatch.ts',
  'backend/scripts/provision-admin.mjs',
  'backend/scripts/provision-test-users.mjs',
  'backend/scripts/seed-demo.ts',
  'backend/scripts/spike-invoke-agent.ts',
  'backend/scripts/sync-context.mjs',
  'backend/scripts/sync-project-knowledge.mjs',
  'backend/scripts/validate-tier-context.ts',
  'tests/e2e/admin-dashboard-render.spec.ts',
  'tests/e2e/admin-dashboard.spec.ts',
  'tests/e2e/agent-intents.spec.ts',
  'tests/e2e/classification-context.spec.ts',
  'tests/e2e/credential-exchange.spec.ts',
  'tests/e2e/experiments.spec.ts',
  'tests/e2e/global-setup.ts',
  'tests/e2e/helpers/agent-helpers.ts',
  'tests/e2e/helpers/task-validation.ts',
  'tests/e2e/helpers/test-credentials.ts',
  'tests/e2e/mentions.spec.ts',
  'tests/e2e/onboarding-intake.spec.ts',
  'tests/e2e/signin.spec.ts',
  'tests/e2e/task-state-machine.spec.ts',
  'tests/e2e/tasks.spec.ts',
]);

function walk(abs: string, out: string[]): void {
  if (!fs.existsSync(abs)) return;
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    if (SCAN_EXTENSIONS.has(path.extname(abs))) out.push(abs);
    return;
  }
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'cdk.out' || entry.name === 'dist') continue;
    if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.js')) continue;
    walk(path.join(abs, entry.name), out);
  }
}

function offendingLines(file: string): string[] {
  const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
  const hits: string[] = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!/tier/i.test(line)) return;
    if (EXEMPT.some((e) => e.pattern.test(line))) return;
    hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
  return hits;
}

describe('classification naming ratchet', () => {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(path.join(REPO_ROOT, root), files);

  it('scans a non-trivial surface (a ratchet that scans nothing passes vacuously)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('no internal surface says "tier" outside the documented exemptions', () => {
    const offenders = new Map<string, string[]>();
    for (const f of files) {
      const rel = path.relative(REPO_ROOT, f).replace(/\\/g, '/');
      if (GRANDFATHERED.has(rel)) continue;
      const hits = offendingLines(f);
      if (hits.length) offenders.set(rel, hits);
    }

    if (offenders.size > 0) {
      const sample = [...offenders.values()].flat().slice(0, 25);
      throw new Error(
        `Internal surfaces must say "classification", not "tier" (${offenders.size} file(s)).\n`
          + 'If this is a NEW occurrence: rename it. "tier" is the customer-facing word only.\n'
          + 'If it is legitimate (a user-visible label, or a persisted name pending migration), add it\n'
          + 'to EXEMPT with a reason - do NOT add it to GRANDFATHERED, which only ever shrinks.\n\n'
          + sample.join('\n'),
      );
    }
    expect(offenders.size).toBe(0);
  });

  it('the grandfather list only shrinks: every entry still exists and still offends', () => {
    // A stale entry silently weakens the ratchet - it would keep a file exempt after it was cleaned
    // or deleted, so the next regression in that file would pass unnoticed.
    const stale: string[] = [];
    for (const rel of GRANDFATHERED) {
      const abs = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(abs)) { stale.push(`${rel} (file no longer exists)`); continue; }
      if (offendingLines(abs).length === 0) stale.push(`${rel} (now clean - remove it from the list)`);
    }
    if (stale.length > 0) {
      throw new Error(`GRANDFATHERED entries are stale; remove them:\n  ${stale.join('\n  ')}`);
    }
    expect(stale).toEqual([]);
  });
});
