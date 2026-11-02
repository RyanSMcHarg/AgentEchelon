/**
 * THE WORKFLOWS A CLASSIFICATION OFFERS, SPLIT BY WHAT A PERSON CAN DO ABOUT THEM.
 *
 * Two groups, never one list:
 *   - every assistant's: the platform machines the turn queue runs on (`required` in the catalog, from
 *     `PLATFORM_TASK_MACHINE_KEYS`). Platform-level and not editable: no version selection removes one and no
 *     classification pack replaces one, because the queue depends on their states by name;
 *   - the ones an assistant can open: the platform's reference workflows and any the classification's pack adds.
 *     A version selects among these, and the pack is where a classification adds or changes its own, each said
 *     beside the group with where it is edited.
 *
 * Used by the create flow and by an assistant's configuration, so the two cannot describe the same workflows
 * differently.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ClassificationCatalog } from '../../services/profileService';

type Workflow = NonNullable<ClassificationCatalog['workflows']>[number];

const WorkflowGroups: React.FC<{ workflows: readonly Workflow[]; testId?: string }> = ({ workflows, testId = 'workflow-groups' }) => {
  const { t } = useTranslation();
  const required = workflows.filter((w) => w.required);
  const optional = workflows.filter((w) => !w.required);
  return (
    <div className="admin-workflow-groups" data-testid={testId}>
      <section aria-labelledby={`${testId}-required`} data-testid={`${testId}-required`}>
        <h6 id={`${testId}-required`}>
          {t('admin.workflows.required')} <span className="admin-badge">{t('admin.assistantPage.platform.badge')}</span>
        </h6>
        <p className="admin-field-hint">{t('admin.workflows.requiredHelp')}</p>
        <div>{required.length ? required.map((w) => <code key={w.key} className="admin-chip">{w.key}</code>) : t('admin.assistantPage.none')}</div>
      </section>
      <section aria-labelledby={`${testId}-optional`} data-testid={`${testId}-optional`}>
        <h6 id={`${testId}-optional`}>{t('admin.workflows.optional')}</h6>
        <p className="admin-field-hint">{t('admin.workflows.optionalHelp')}</p>
        <div>
          {optional.length ? optional.map((w) => (
            <code key={w.key} className="admin-chip" data-source={w.source}>
              {w.key}{w.source === 'classification' ? ` (${t('admin.workflows.fromClassification')})` : ''}
            </code>
          )) : t('admin.assistantPage.none')}
        </div>
      </section>
    </div>
  );
};

export default WorkflowGroups;
