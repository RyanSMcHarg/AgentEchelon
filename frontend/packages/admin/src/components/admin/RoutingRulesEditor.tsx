/**
 * A VERSION'S ROUTING RULES (ADR-060 decision 6): an ordered list of `{ when, model }`. After an experiment's override
 * and before the built-in context rules, the first rule whose condition holds serves the turn on its model.
 *
 * The models offered are the ones the assistant's classification selects (the platform allows, the classification
 * selects, the version uses), and a rule naming any other is passed over at run time and dropped where the version is
 * confined. A condition is read as the room reads the reply, so no fact about a person routes a turn; the builder does
 * not offer one, and the server's own `routingRuleErrors` and catalog check say the same under each rule.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { PublishedVariables, When } from '../../../../../../backend/lambda/src/lib/variables.ts';
import ConditionBuilder from './ConditionBuilder';

type T = (key: string, opts?: Record<string, unknown>) => string;
type Rule = { when: When; model: string };

const RoutingRulesEditor: React.FC<{
  rules: Rule[];
  onChange: (next: Rule[] | undefined) => void;
  /** The text models the classification selects. */
  models: string[];
  published?: PublishedVariables;
}> = ({ rules, onChange, models, published }) => {
  const { t: translate } = useTranslation();
  const t = translate as unknown as T;
  const save = (next: Rule[]) => onChange(next.length ? next : undefined);
  const put = (i: number, next: Rule | undefined) => save(next ? rules.map((r, j) => (j === i ? next : r)) : rules.filter((_, j) => j !== i));
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= rules.length) return;
    const next = [...rules];
    [next[i], next[j]] = [next[j], next[i]];
    save(next);
  };
  return (
    <div className="profiles-persona-field" data-testid="routing-rules">
      <h5>{t('admin.routingRules.title')}</h5>
      <span className="admin-field-hint">{t('admin.routingRules.help')}</span>
      <ol>
        {rules.map((rule, i) => {
          const id = `routing-rule-${i}`;
          return (
            <li key={i} data-testid={id}>
              <div className="admin-filter-group">
                <label><span className="admin-field-label">{t('admin.routingRules.model')}</span>
                  <select className="select" data-testid={`${id}-model`} value={rule.model} onChange={(e) => put(i, { ...rule, model: e.target.value })}>
                    {!models.includes(rule.model) && <option value={rule.model}>{t('admin.routingRules.notSelected', { model: rule.model })}</option>}
                    {models.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
                <button type="button" className="btn-secondary" data-testid={`${id}-up`} disabled={i === 0} onClick={() => move(i, -1)}>{t('admin.workflowEditor.up')}</button>
                <button type="button" className="btn-secondary" data-testid={`${id}-down`} disabled={i === rules.length - 1} onClick={() => move(i, 1)}>{t('admin.workflowEditor.down')}</button>
                <button type="button" className="btn-secondary" data-testid={`${id}-remove`} onClick={() => put(i, undefined)}>{t('admin.routingRules.remove')}</button>
              </div>
              {/* A routing rule names sources, never a version's variable: the processor reads its rules by source. */}
              <ConditionBuilder value={rule.when} selects="room" published={published} testId={`${id}-when`}
                onChange={(when) => put(i, { ...rule, when: when ?? ({} as When) })} />
            </li>
          );
        })}
      </ol>
      <button type="button" className="btn-secondary" data-testid="routing-rule-add" disabled={!models.length}
        onClick={() => save([...rules, { when: {} as When, model: models[0] }])}>
        {t('admin.routingRules.add')}
      </button>
    </div>
  );
};

export default RoutingRulesEditor;
