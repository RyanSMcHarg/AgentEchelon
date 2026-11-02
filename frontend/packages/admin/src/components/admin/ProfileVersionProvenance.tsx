/**
 * WHERE A VERSION CAME FROM, IN THE PROFILES TAB (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.5, §3.6).
 *
 * An experiment's candidate is a version in the alt's history that never served a conversation: it is
 * labeled with the experiment that derived it and cannot be activated, because the server refuses a
 * candidate as a rollback target and the only way it reaches the live assistant is the experiment's
 * Promote action. A promoted version is a copy of a measured candidate, and says which candidate and which
 * experiment, so evidence keyed on its `configId` can be traced back. A version activated past the golden gate says which
 * refusal it went live past, who passed it and why (ADR-065 decision 5).
 */
import { useTranslation } from 'react-i18next';
import type { ProfileVersionSummary } from '../../services/profileService';

/** Whether the console offers to activate (roll back to) this version. A candidate never; the active one needs none. */
export function canActivateVersion(row: Pick<ProfileVersionSummary, 'active' | 'derivedFrom'>): boolean {
  return !row.active && !row.derivedFrom;
}

/** The provenance mark for one version row: a derived candidate, a promoted copy, or nothing. */
export function VersionProvenance({ row }: { row: Pick<ProfileVersionSummary, 'derivedFrom' | 'promotedFrom' | 'activatedPastGate'> }) {
  const { t, i18n } = useTranslation();
  if (row.derivedFrom) {
    const d = row.derivedFrom;
    return (
      <span data-testid="version-derived" title={t('admin.profiles.derivedCannotActivate', { experimentId: d.experimentId })}>
        {t('admin.profiles.derivedCandidate', { experimentId: d.experimentId, variantId: d.variantId })}
        {d.baseProfile && (
          <em className="exp-hint">
            {' '}
            {d.baseVersion != null
              ? t('admin.profiles.derivedFromBase', { baseProfile: d.baseProfile, baseVersion: d.baseVersion })
              : t('admin.profiles.derivedFromSeed', { baseProfile: d.baseProfile })}
          </em>
        )}
      </span>
    );
  }
  if (row.promotedFrom) {
    const p = row.promotedFrom;
    return (
      <span data-testid="version-promoted">
        {t('admin.profiles.promotedFrom', { profileName: p.profileName, version: p.version, experimentId: p.experimentId })}
      </span>
    );
  }
  if (row.activatedPastGate) {
    const g = row.activatedPastGate;
    return (
      <span data-testid="version-past-gate" title={g.reason}>
        {t('admin.profiles.activatedPastGate', { refusal: t(`admin.assistantPage.golden.refusal.${g.code}`, g.params), actor: g.actor, at: new Date(g.at).toLocaleString(i18n.language), reason: g.reason })}
      </span>
    );
  }
  return <>—</>;
}

/** What the rollback cell says for a candidate: why there is no button, and where activation lives. */
export function CandidateNotActivatable({ experimentId }: { experimentId: string }) {
  const { t } = useTranslation();
  return (
    <span className="admin-muted" data-testid="version-not-activatable">
      {t('admin.profiles.derivedCannotActivate', { experimentId })}
    </span>
  );
}
