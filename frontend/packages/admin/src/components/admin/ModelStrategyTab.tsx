import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  INTENT_STRATEGY_CARDS,
  MODEL_STRATEGY_MODELS,
  PROVIDER_POSITIONING,
} from '@ae/shared';
import { GuideLinks, guide } from './AdminHelp';
import { classificationBadgeStyle, classificationName, deploymentClassifications } from '@ae/shared/config/classifications.ts';
import { classificationSelectsModel } from '@ae/shared/config/modelStrategy.ts';

/** A cost, latency or fit grade as low, middle or high. A grade, not a classification. */
function labelTone(value: string): 'low' | 'mid' | 'high' {
  switch (value) {
    case 'high':
    case 'deep':
    case 'excellent':
      return 'high';
    case 'medium':
    case 'balanced':
    case 'good':
      return 'mid';
    default:
      return 'low';
  }
}

/** A classification pill in the classification's declared badge colors (`classificationBadgeStyle`). */
function badgeColors(value: string): React.CSSProperties {
  return { ...classificationBadgeStyle(value), background: 'var(--cls-bg)', color: 'var(--cls-fg)' };
}

const ModelStrategyTab: React.FC = () => {
  const { t } = useTranslation();
  const modelLookup = Object.fromEntries(MODEL_STRATEGY_MODELS.map((model) => [model.key, model]));

  return (
    <div className="admin-tab admin-strategy-tab">
      <div className="admin-info-banner">
        <strong>{t('admin.modelStrategy.modelStrategyIsNowCapability')}</strong> Routing is documented by intent, cost,
        latency, and provider so the platform can expand beyond a single model family without rewriting
        the whole product. This view is a read-only reference for the documented routing strategy and
        provider posture — use it to see which model serves each intent and why. To change routing or
        run head-to-head tests, use Experiments.
        <GuideLinks guides={[
          guide(t('admin.guides.modelStrategy.strategy'), 'modelStrategy'),
          guide(t('admin.guides.modelStrategy.experiments'), 'abTesting'),
        ]} />
      </div>

      <section className="admin-section">
        <h3>{t('admin.modelStrategy.providerPosture')}</h3>
        <div className="strategy-provider-grid">
          {PROVIDER_POSITIONING.map((provider) => (
            <article key={provider.provider} className="strategy-provider-card">
              <p className="strategy-eyebrow">{provider.provider}</p>
              <p className="strategy-copy">{provider.summary}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="admin-section">
        <h3>{t('admin.modelStrategy.intentRouting')}</h3>
        <div className="strategy-route-grid">
          {INTENT_STRATEGY_CARDS.map((route) => (
            <article key={route.intent} className="strategy-route-card">
              <div className="strategy-route-header">
                <div>
                  <p className="strategy-eyebrow">{route.label}</p>
                  <h4>{modelLookup[route.primaryModel].displayName}</h4>
                </div>
              </div>
              <p className="strategy-copy">{route.rationale}</p>
              <div className="strategy-route-meta">
                <span>Primary: {modelLookup[route.primaryModel].displayName}</span>
                <span>Fallback: {modelLookup[route.fallbackModel].displayName}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="admin-section">
        <h3>{t('admin.modelStrategy.modelCatalog')}</h3>
        <div className="strategy-model-grid">
          {MODEL_STRATEGY_MODELS.map((model) => (
            <article key={model.key} className="strategy-model-card">
              <div className="strategy-model-header">
                <div>
                  <p className="strategy-eyebrow">{model.provider}</p>
                  <h4>{model.displayName}</h4>
                </div>
                <div className="strategy-chip-row">
                  <span className={`strategy-chip strategy-chip-${labelTone(model.costClass)}`}>
                    {model.costClass} cost
                  </span>
                  <span className={`strategy-chip strategy-chip-${labelTone(model.latencyClass)}`}>
                    {model.latencyClass}
                  </span>
                </div>
              </div>
              <p className="strategy-copy">{model.deploymentNotes}</p>
              <div className="strategy-pill-row">
                {/* WHICH OF THE DEPLOYMENT'S CLASSIFICATIONS SELECT IT: each classification's own selection, never a
                    list on the model (the platform allows, the classification selects). */}
                {deploymentClassifications().filter((c) => classificationSelectsModel(c, model.key)).map((c) => (
                  <span key={c.value} className="strategy-pill" style={badgeColors(c.value)}>
                    {classificationName(c.value)}
                  </span>
                ))}
              </div>
              <div className="strategy-pill-row">
                {model.strengths.map((strength) => (
                  <span key={strength} className="strategy-pill strategy-pill-neutral">
                    {strength}
                  </span>
                ))}
              </div>
              <p className="strategy-footnote">Coding fit: {model.codingFit}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
};

export default ModelStrategyTab;
