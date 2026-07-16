import React from 'react';
import { useAuth } from '../providers/AuthProvider';
import type { Model } from '../types';
import { getAvailableModels } from '../utils/mockData';
import './ModelSelector.css';

interface ModelSelectorProps {
  selectedModel: Model | null;
  onModelSelect: (model: Model) => void;
}

const ModelSelector: React.FC<ModelSelectorProps> = ({
  selectedModel,
  onModelSelect,
}) => {
  const { user } = useAuth();
  const availableModels = user ? getAvailableModels(user.tier) : [];

  const getTierBadgeClass = (tier: string) => {
    switch (tier) {
      case 'basic':
        return 'tier-badge-basic';
      case 'standard':
        return 'tier-badge-standard';
      case 'premium':
        return 'tier-badge-premium';
      default:
        return 'tier-badge-basic';
    }
  };

  return (
    <div className="model-selector">
      <label className="model-selector-label">Select AI Model</label>
      <div className="model-options">
        {availableModels.map((model: Model) => (
          <div
            key={model.id}
            className={`model-option ${
              selectedModel?.id === model.id ? 'selected' : ''
            }`}
            onClick={() => onModelSelect(model)}
          >
            <div className="model-option-header">
              <span className="model-name">{model.name}</span>
              <span className={`tier-badge ${getTierBadgeClass(model.tier)}`}>
                {model.tier}
              </span>
            </div>
            <p className="model-description">{model.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ModelSelector;
