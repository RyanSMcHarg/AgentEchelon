import React from 'react';
import {
  INTENT_STRATEGY_CARDS,
  MODEL_STRATEGY_MODELS,
  PROVIDER_POSITIONING,
} from '../../config/modelStrategy';
import { DocLink } from './AdminHelp';
import { DOC_LINKS } from '../../config/docLinks';

function labelTone(value: string) {
  switch (value) {
    case 'premium':
    case 'high':
    case 'deep':
    case 'excellent':
      return 'premium';
    case 'standard':
    case 'medium':
    case 'balanced':
    case 'good':
      return 'standard';
    default:
      return 'basic';
  }
}

const ModelStrategyTab: React.FC = () => {
  const modelLookup = Object.fromEntries(MODEL_STRATEGY_MODELS.map((model) => [model.key, model]));

  return (
    <div className="admin-tab admin-strategy-tab">
      <div className="admin-info-banner">
        <strong>Model strategy is now capability-first.</strong> Routing is documented by intent, cost,
        latency, and provider so the platform can expand beyond a single model family without rewriting
        the whole product. This view is a read-only reference for the documented routing strategy and
        provider posture — use it to see which model serves each intent and why. To change routing or
        run head-to-head tests, use Experiments.{' '}
        <DocLink href={DOC_LINKS.modelStrategy}>Model strategy</DocLink>
        {' · '}
        <DocLink href={DOC_LINKS.abTesting}>Experiments &amp; battles</DocLink>
      </div>

      <section className="admin-section">
        <h3>Provider Posture</h3>
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
        <h3>Intent Routing</h3>
        <div className="strategy-route-grid">
          {INTENT_STRATEGY_CARDS.map((route) => (
            <article key={route.intent} className="strategy-route-card">
              <div className="strategy-route-header">
                <div>
                  <p className="strategy-eyebrow">{route.label}</p>
                  <h4>{modelLookup[route.primaryModel].displayName}</h4>
                </div>
                <span className={`strategy-chip strategy-chip-${labelTone(route.preferredTier)}`}>
                  {route.preferredTier}
                </span>
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
        <h3>Model Catalog</h3>
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
                {model.allowedTiers.map((tier) => (
                  <span key={tier} className={`strategy-pill strategy-pill-${labelTone(tier)}`}>
                    {tier}
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
