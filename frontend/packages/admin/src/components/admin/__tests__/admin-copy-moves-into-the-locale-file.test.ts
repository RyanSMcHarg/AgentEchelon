/**
 * THE CONSOLE'S COPY MOVES INTO THE LOCALE FILE, AND CANNOT MOVE BACK.
 *
 * The chat client is localized: `react-i18next`, one `en.json`, 341 keys, `t('surface.key')` at 282
 * call sites. The admin console is not - one component (`LatencyShadowDiff`) is fully converted, the
 * dashboard chrome is converted, and everything else is hardcoded English. A thorough count puts it at
 * 1,219 strings across 43 files.
 *
 * NOTHING GUARDED THIS. No ESLint rule, no test, no CI step, in either frontend package - so the
 * forty-fourth hardcoded file was free to appear, and the conversion would have been outrun by new
 * copy. This is the ratchet: a per-file count that may FALL and may not RISE.
 *
 * ── THE NUMBERS BELOW ARE THIS SCANNER'S OUTPUT, NOT THE SIZE OF THE JOB ─────────────────────────
 *
 * `countHardcodedCopy` is blunt on purpose (see its docstring): a 12-character floor, per-file
 * dedupe, no knowledge of which prop a literal is passed to. It reports 777 where a careful pass
 * reports 1,219. That gap is NOT a defect to tune away - the baseline stores this function's exact
 * output, so what is asserted is the direction of change, and a cleverer scanner would shift every
 * number and throw the baseline away. Determinism is the only property it needs.
 *
 * So: 777 is a yardstick, not an estimate. Do not quote it as the remaining work.
 *
 * ── THE COUNT HAS A FLOOR, AND IT IS NOT ZERO ────────────────────────────────────────────────────
 *
 * Measured 2026-10-02, with the total at 172: about 68 of those are className lists and 18 are fragments
 * the scanner tore out of a longer expression. Neither can become a locale key, so an entry reaching zero
 * is the exception rather than the goal, and a file sitting at a small number is usually DONE.
 *
 * Three kinds of string look like copy here and must NOT be converted:
 *
 *   - className lists. `admin-section experiment-conflict-panel` reads as prose to any heuristic, and
 *     ExperimentsTab's remaining count is mostly these.
 *   - Developer annotations. `AdminDashboard.TABS_THAT_FETCH_NOTHING_HERE` holds a sentence per tab
 *     explaining why that tab issues no query; it is read by `AdminDashboard.fetches.test.tsx` and by
 *     nobody else, so translating it would move a note about the code into the product's copy.
 *   - Product names. The image-model options ("FLUX 1.1 Pro via FAL", "Stability Image Core") name
 *     third-party models, and a translated model name is wrong rather than localized.
 *
 * What IS left to convert is module-scope constant maps, each needing its consumers moved to resolve a key
 * at render - the pattern `metricTargets.ts`, `VERDICT_META` and `FLAG_REASON_KEYS` already follow.
 *
 * ── WORKING WITH IT ──────────────────────────────────────────────────────────────────────────────
 *
 * Convert a file's copy to `t()` keys, re-run, and lower its number here - or delete the entry when it
 * reaches zero. A file that is not listed must stay at zero. The pattern is borrowed from
 * `everyAdminClassIsStyled.test.ts`, which holds its own shrinking list the same way and for the same
 * reason: an exception list that cannot grow converges, and a lint rule everybody disables does not.
 */
import { describe, it, expect } from 'vitest';
import { scanAdminSource } from './hardcodedCopyScanner';

/** Hardcoded user-facing strings per file, as of 2026-10-01. LOWER these; never raise one. */
const BASELINE: Record<string, number> = {
  'components/admin/AdminDashboard.tsx': 8,
  'components/admin/AdminHelp.tsx': 1,
  'components/admin/alerts.ts': 2,
  'components/admin/AlertsTab.tsx': 1,
  // components/admin/BattlesTab.tsx: folded into ExperimentBattles.tsx, entry removed
  'components/admin/ClassifierGatePanel.tsx': 2,
  'components/admin/ClientTab.tsx': 3,
  'components/admin/ConversationsTab.tsx': 5,
  'components/admin/DataTable.tsx': 1,
  'components/admin/EffectivenessTab.tsx': 9,
  // components/admin/EvaluationsTab.tsx: converted, entry removed
  // components/admin/ExperimentDrillDown.tsx: converted, entry removed. The note that used to sit here
  // said threading a translator into `columnsFor` had been tried and abandoned as dead weight. It was
  // reinstated on 2026-10-02 and carries every column header in that helper, so the file is at zero.
  'components/admin/ExperimentsTab.tsx': 22,
  'components/admin/FlaggedResponsesTab.tsx': 4,
  // Two className lists (`admin-modal admin-section`, `textarea input`); every word of its copy is a key.
  'components/admin/ReasonDialog.tsx': 2,
  'components/admin/FunnelChart.tsx': 3,
  'components/admin/GroundTruthTab.tsx': 2,
  // components/admin/latencyAggregate.ts: converted, entry removed
  'components/admin/LatencyTab.tsx': 7,
  // components/admin/LineChart.tsx: converted, entry removed
  // components/admin/MembershipAuditTab.tsx: converted, entry removed
  'components/admin/MessageInspectDrawer.tsx': 4,
  // components/admin/metricTargets.ts: converted, entry removed
  // components/admin/ModelsTab.tsx: converted, entry removed
  'components/admin/ModelStrategyTab.tsx': 2,
  'components/admin/OverviewTab.tsx': 9,
  'components/admin/PerformanceFilters.tsx': 1,
  // Two className lists (`admin-modal experiment-confirm admin-section`, `textarea input`), as in
  // ReasonDialog; every word of its copy is a key.
  'components/admin/PromoteExperiment.tsx': 2,
  'components/admin/QueueHealth.tsx': 2,
  // components/admin/Sparkline.tsx: converted, entry removed
  // components/admin/TurnKinds.tsx: converted, entry removed
  'components/admin/TurnLatencyAudit.tsx': 1,
  'components/admin/UnsupportedAnalyticsBanner.tsx': 1,
  // components/admin/UserManagementTab.tsx: converted, entry removed
  'components/admin/UsersTab.tsx': 7,
  // services/adminAttachmentService.ts: converted, entry removed
  // services/adminChime.ts: converted, entry removed
  // services/adminConversationService.ts: converted, entry removed
  // services/analyticsService.ts: converted, entry removed
  // services/membershipAuditService.ts: converted, entry removed
  // services/profileService.ts: converted, entry removed
  // services/sigv4Fetch.ts: converted, entry removed
};

describe('hardcoded admin copy only ever decreases', () => {
  const counts = scanAdminSource();

  it('no file carries more hardcoded copy than its baseline', () => {
    const risen: string[] = [];
    for (const [file, n] of counts) {
      const allowed = BASELINE[file] ?? 0;
      if (n > allowed) {
        risen.push(`${file}: ${n} hardcoded strings, baseline ${allowed}`);
      }
    }
    if (risen.length) {
      throw new Error(
        'Hardcoded user-facing copy increased. Put the new strings in '
        + "packages/shared/src/locales/en.json under `admin.<surface>.*` and read them with "
        + "useTranslation()'s `t()`, as LatencyShadowDiff.tsx does.\n\n"
        + risen.map((r) => `  ${r}`).join('\n'),
      );
    }
  });

  it('names no file that has since been fully converted', () => {
    // A baseline entry at zero is a claim about work still to do that is no longer true, and a stale
    // exception list is how the whole mechanism quietly stops meaning anything.
    const done = Object.keys(BASELINE).filter((f) => !counts.has(f));
    expect(done).toEqual([]);
  });

  it('records a count that is still accurate, so progress is visible', () => {
    // Converting a file WITHOUT lowering its number leaves room for new hardcoded copy to be added
    // back silently, which is exactly the regression this guard exists to prevent.
    const stale = [...counts]
      .filter(([file, n]) => BASELINE[file] !== undefined && n < BASELINE[file])
      .map(([file, n]) => `${file}: now ${n}, baseline still says ${BASELINE[file]}`);
    if (stale.length) {
      throw new Error(
        'Copy was converted but the baseline was not lowered. Update it so the ratchet holds:\n\n'
        + stale.map((s) => `  ${s}`).join('\n'),
      );
    }
  });
});
