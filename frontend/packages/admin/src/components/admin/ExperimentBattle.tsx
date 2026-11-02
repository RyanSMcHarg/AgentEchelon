/**
 * AN EXPERIMENT'S SETTINGS: HOW ITS TRAFFIC IS SPLIT, AND WHETHER IT RUNS BATTLES.
 *
 * A battle is a sub-result of an experiment: someone in Battle Mode gets both versions' answers over a few
 * turns and picks the better one. So arming it (the challenger, and whether Battle Mode is on in the
 * experiment's classification) is read and changed from inside the experiment: in the create form's battle
 * card, and in the Settings section of the experiment's page. Battle Mode itself is a classification's
 * setting, so the switch names the classification it governs.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { classificationName, modelDisplayName, type BattleSetting, type Experiment } from '@ae/shared';
import { InfoTooltip } from './AdminHelp';
import { duelSideName, versionLabelOf, versionRoleOf } from './experimentControl';

/**
 * Battle Mode for one classification: on, off, or not built by this deployment. Changed only by a role
 * holding `manage-battle-settings`; shown to every reader so the state is never a guess.
 */
export const BattleModeSwitch: React.FC<{
  setting: BattleSetting | undefined;
  saving: boolean;
  canChange: boolean;
  onToggle: (classification: string, enabled: boolean) => void;
}> = ({ setting, saving, canChange, onToggle }) => {
  const { t } = useTranslation();
  if (!setting) return null;
  const name = classificationName(setting.classification);
  return (
    <div className="admin-filter-group" data-testid="battle-settings">
      <label
        className="admin-inline-label"
        title={setting.capable ? undefined : t('admin.experiments.battleModeNotBuilt')}
      >
        <input
          type="checkbox"
          checked={setting.enabled}
          disabled={!setting.capable || saving || !canChange}
          onChange={(e) => onToggle(setting.classification, e.target.checked)}
          data-testid={`battle-toggle-${setting.classification}`}
        />
        {' '}{t('admin.battle.modeIn', { name })}
      </label>
      <InfoTooltip label={t('admin.battle.modeAbout')} content={t('admin.experiments.battleModePutsTwoAssistants')} />
      {!setting.capable && <span className="admin-muted">{t('admin.experiments.notAvailable')}</span>}
    </div>
  );
};

/**
 * The Settings section of an experiment's page: each version's share of traffic and what it runs, then,
 * for a battle-enabled experiment, the challenger and the classification's Battle Mode switch.
 */
export const ExperimentSettings: React.FC<{
  experiment: Experiment;
  setting: BattleSetting | undefined;
  saving: boolean;
  canChange: boolean;
  onToggle: (classification: string, enabled: boolean) => void;
}> = ({ experiment, setting, saving, canChange, onToggle }) => {
  const { t } = useTranslation();
  return (
    <section className="admin-section" data-testid="experiment-settings" aria-labelledby="experiment-settings-title">
      <h4 id="experiment-settings-title">{t('admin.experiments.settings.title')}</h4>
      <h5>{t('admin.experiments.settings.split')}</h5>
      <dl className="admin-config-list" data-testid="experiment-split">
        {(experiment.variants ?? []).map((v) => {
          const role = versionRoleOf(experiment, v.variantId);
          const name = duelSideName(experiment, v.variantId);
          return (
            <React.Fragment key={v.variantId}>
              <dt>{role ? t(`admin.battles.role.${role}`) : v.variantId}</dt>
              <dd>
                {t('admin.experiments.settings.share', { weight: v.weight })}
                {' · '}
                {[name, versionLabelOf(experiment, v.variantId, modelDisplayName)].filter(Boolean).join(' · ')}
              </dd>
            </React.Fragment>
          );
        })}
      </dl>
      {experiment.battleEnabled && (
        <>
          <h5>{t('admin.battle.mode')}</h5>
          <dl className="admin-config-list" data-testid="experiment-battle">
            <dt>{t('admin.experiments.battleChallenger')}</dt>
            <dd>{experiment.challengerAssistant ? <code>{experiment.challengerAssistant}</code> : '—'}</dd>
            <dt>{t('admin.battle.mode')}</dt>
            <dd>
              {setting
                ? <BattleModeSwitch setting={setting} saving={saving} canChange={canChange} onToggle={onToggle} />
                : t('admin.battle.modeUnknown')}
            </dd>
          </dl>
        </>
      )}
    </section>
  );
};
