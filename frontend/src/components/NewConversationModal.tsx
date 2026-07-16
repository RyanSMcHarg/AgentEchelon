import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../providers/AuthProvider';
import { useConversations } from '../providers/ConversationProvider.chime';
import type { UserTier } from '../types';
import { getTierModelSelection } from '../config/modelStrategy';
import './NewConversationModal.css';

interface NewConversationModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type ClassTierId = UserTier | 'open';

interface ClassificationOption {
  tier: ClassTierId;
  label: string;
  agentModel: string;
  modelId: string;
  description: string;
  contextAccess: string[];
  tools: string[];
  membershipRule: string;
  minTier: UserTier;
}

/**
 * Classification data-only definition. Labels, descriptions, and
 * membership rules are resolved from i18n at render time — only the
 * tier identifier, contextAccess list, tools list, and minTier live
 * here, since those are security/policy attributes not UI copy.
 *
 * The contextAccess + tools lists are kept as English-only arrays
 * because they reference data-system concepts that aren't translated
 * as a set. A future pass could move them into i18n too.
 */
const CLASSIFICATION_DATA: Array<Omit<ClassificationOption, 'agentModel' | 'modelId' | 'label' | 'description' | 'membershipRule'>> = [
  {
    tier: 'open',
    contextAccess: ['Company overview', 'Product descriptions', 'Public FAQ'],
    tools: ['Respond'],
    minTier: 'basic',
  },
  {
    tier: 'basic',
    contextAccess: ['Company overview', 'Product descriptions', 'Public FAQ'],
    tools: ['Respond'],
    minTier: 'basic',
  },
  {
    tier: 'standard',
    contextAccess: ['Everything in Basic', 'Employee directory', 'Product roadmap', 'Support data', 'Internal processes'],
    tools: ['Respond', 'Create conversations', 'Manage members', 'Load context'],
    minTier: 'standard',
  },
  {
    tier: 'premium',
    contextAccess: ['Everything in Standard', 'Financial data', 'Customer accounts', 'Board summaries', 'Competitive intel', 'Team metrics'],
    tools: ['All Standard tools', 'Query analytics', 'Share conversations'],
    minTier: 'premium',
  },
];

const TIER_RANK: Record<string, number> = { basic: 0, standard: 1, premium: 2 };

function canAccessClassification(userTier: UserTier, classification: ClassificationOption): boolean {
  return TIER_RANK[userTier] >= TIER_RANK[classification.minTier];
}

function getTierColorVar(tier: string): string {
  switch (tier) {
    case 'open': return 'var(--tier-basic)';
    case 'basic': return 'var(--tier-basic)';
    case 'standard': return 'var(--tier-standard)';
    case 'premium': return 'var(--tier-premium)';
    default: return 'var(--text-tertiary)';
  }
}

const NewConversationModal: React.FC<NewConversationModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { t } = useTranslation();
  // Title is optional. If the user names it, that name sticks (the bot's
  // auto-derive only renames a channel still called "New conversation" —
  // see channel-title.ts). Left blank, we default to "New conversation"
  // and auto-derive from the first message.
  const [title, setTitle] = useState('');
  const [selectedClassification, setSelectedClassification] = useState<ClassificationOption | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showContextDetail, setShowContextDetail] = useState<string | null>(null);
  const { user } = useAuth();
  const { createConversation } = useConversations();
  const tierModelSelection = getTierModelSelection();

  const userTier = user?.tier || 'basic';
  const classifications: ClassificationOption[] = CLASSIFICATION_DATA.map((classification) => {
    const tierModel = classification.tier === 'open'
      ? tierModelSelection.basic
      : tierModelSelection[classification.tier];

    return {
      ...classification,
      label: t(`newConversation.class.${classification.tier}.label`),
      description: t(`newConversation.class.${classification.tier}.description`),
      membershipRule: t(`newConversation.class.${classification.tier}.membership`),
      agentModel: tierModel.displayName,
      modelId: tierModel.bedrockModelId,
    };
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedClassification) {
      try {
        setIsCreating(true);
        setError(null);
        // The classification tier determines the model — map to model ID.
        // Title placeholder ("New conversation") is replaced on the first
        // user message by the auto-derive in ConversationProvider.
        await createConversation(
          title.trim() || t('newConversation.defaultTitle'),
          selectedClassification.modelId,
          selectedClassification.agentModel
        );
        setSelectedClassification(null);
        setTitle('');
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : t('newConversation.errorFallback'));
      } finally {
        setIsCreating(false);
      }
    }
  };

  const handleClose = () => {
    setSelectedClassification(null);
    setShowContextDetail(null);
    setError(null);
    onClose();
  };

  if (!isOpen) return null;

  const availableClassifications = classifications.filter(c =>
    canAccessClassification(userTier, c)
  );

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="ncm-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="ncm-header">
          <div className="ncm-header-text">
            <h2 className="ncm-title">{t('newConversation.title')}</h2>
            <p className="ncm-subtitle">{t('newConversation.subtitle')}</p>
          </div>
          <button className="modal-close-btn" onClick={handleClose} aria-label={t('newConversation.close')}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="close-icon">
              <path fillRule="evenodd" d="M5.47 5.47a.75.75 0 011.06 0L12 10.94l5.47-5.47a.75.75 0 111.06 1.06L13.06 12l5.47 5.47a.75.75 0 11-1.06 1.06L12 13.06l-5.47 5.47a.75.75 0 01-1.06-1.06L10.94 12 5.47 6.53a.75.75 0 010-1.06z" clipRule="evenodd" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="ncm-section">
            <label className="ncm-label" htmlFor="ncm-title-input">
              <span className="ncm-label-text">{t('newConversation.titleFieldLabel')}</span>
              <span className="ncm-label-hint">{t('newConversation.titleFieldHint')}</span>
            </label>
            <input
              id="ncm-title-input"
              type="text"
              className="ncm-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('newConversation.titleFieldPlaceholder')}
              maxLength={80}
            />
          </div>

          {/* Classification selector */}
          <div className="ncm-section">
            <label className="ncm-label">
              <span className="ncm-label-text">{t('newConversation.classificationLabel')}</span>
              <span className="ncm-label-hint">{t('newConversation.classificationHint')}</span>
            </label>
            <div className="ncm-classification-grid">
              {availableClassifications.map((classification) => {
                const isSelected = selectedClassification?.tier === classification.tier;
                const tierColor = getTierColorVar(classification.tier);
                const isExpanded = showContextDetail === classification.tier;

                return (
                  <div
                    key={classification.tier}
                    role="button"
                    tabIndex={0}
                    className={`ncm-class-card ${isSelected ? 'ncm-class-card--selected' : ''}`}
                    onClick={() => {
                      setSelectedClassification(classification);
                      setShowContextDetail(null);
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedClassification(classification); setShowContextDetail(null); }}}
                    style={{ '--tier-accent': tierColor } as React.CSSProperties}
                  >
                    <div className="ncm-class-card-header">
                      <div className="ncm-class-card-badge" style={{ background: tierColor }}>
                        {classification.label}
                      </div>
                      <span className="ncm-class-card-model">{classification.agentModel}</span>
                    </div>

                    <p className="ncm-class-card-desc">{classification.description}</p>

                    <div className="ncm-class-card-meta">
                      <div className="ncm-class-card-meta-item">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
                          <path fillRule="evenodd" d="M8 1a3.5 3.5 0 00-3.5 3.5V7H3a1 1 0 00-1 1v5a1 1 0 001 1h10a1 1 0 001-1V8a1 1 0 00-1-1h-1.5V4.5A3.5 3.5 0 008 1zm2 6V4.5a2 2 0 10-4 0V7h4z" clipRule="evenodd" />
                        </svg>
                        <span>{classification.membershipRule}</span>
                      </div>
                      <button
                        type="button"
                        className="ncm-class-card-detail-toggle"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowContextDetail(isExpanded ? null : classification.tier);
                        }}
                      >
                        {isExpanded ? t('newConversation.hideDetails') : t('newConversation.viewDetails')}
                      </button>
                    </div>

                    {isExpanded && (
                      <div className="ncm-class-card-details">
                        <div className="ncm-detail-group">
                          <span className="ncm-detail-label">{t('newConversation.contextAccessLabel')}</span>
                          <ul className="ncm-detail-list">
                            {classification.contextAccess.map((item, i) => (
                              <li key={i}>{item}</li>
                            ))}
                          </ul>
                        </div>
                        <div className="ncm-detail-group">
                          <span className="ncm-detail-label">{t('newConversation.agentToolsLabel')}</span>
                          <ul className="ncm-detail-list">
                            {classification.tools.map((tool, i) => (
                              <li key={i}>{tool}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    )}

                    {isSelected && (
                      <div className="ncm-class-card-check">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" width="16" height="16">
                          <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
                        </svg>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Security context bar */}
          {selectedClassification && (
            <div className="ncm-security-bar" style={{ '--tier-accent': getTierColorVar(selectedClassification.tier) } as React.CSSProperties}>
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
                <path fillRule="evenodd" d="M8 1a3.5 3.5 0 00-3.5 3.5V7H3a1 1 0 00-1 1v5a1 1 0 001 1h10a1 1 0 001-1V8a1 1 0 00-1-1h-1.5V4.5A3.5 3.5 0 008 1zm2 6V4.5a2 2 0 10-4 0V7h4z" clipRule="evenodd" />
              </svg>
              <span>
                <strong>{selectedClassification.label}</strong> {t('newConversation.securityBarSuffix')}
                {' '}&mdash; {selectedClassification.membershipRule.toLowerCase()}
              </span>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="ncm-error">{error}</div>
          )}

          {/* Actions */}
          <div className="ncm-actions">
            <button type="button" className="ncm-btn ncm-btn--secondary" onClick={handleClose}>
              {t('newConversation.cancelButton')}
            </button>
            <button
              type="submit"
              className="ncm-btn ncm-btn--primary"
              disabled={!selectedClassification || isCreating}
            >
              {isCreating ? t('newConversation.creating') : t('newConversation.createButton')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default NewConversationModal;
