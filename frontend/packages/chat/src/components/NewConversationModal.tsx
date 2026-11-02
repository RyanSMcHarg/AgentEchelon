import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@ae/shared';
import { creatableClassifications, deploymentClassifications, classificationBadgeStyle, type ClientClassification } from '@ae/shared/config/classifications.ts';
import { modelForClassification } from '@ae/shared/config/modelStrategy.ts';
import { useConversations } from '../providers/ConversationProvider.chime';
import './NewConversationModal.css';

interface NewConversationModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ClassificationOption {
  tier: string;
  label: string;
  agentModel: string;
  modelId: string;
  description: string;
  /** The sample's access copy for this classification, when the catalog carries it; empty otherwise. */
  contextAccess: string[];
  tools: string[];
  membershipRule: string;
}

/**
 * WHICH CONVERSATIONS TO OFFER, AND WHAT EACH IS CALLED: read from the deployment's declared set.
 *
 * The options are the conversational, members-audience classifications the person's own classification
 * grants (`creatableClassifications`, from `GET /classifications`, the set `backend/lib/config/profiles.ts`
 * declares), so a deployment declaring `legal` and `finance` offers those, by their declared names and in
 * their declared badge colors, and an administrator is offered every one the admin plane grants. Who may
 * join each is the declared classifications whose grants reach it.
 *
 * AN AFFORDANCE, never the enforcement: `lib/channel-creation.ts` refuses a classification the caller does
 * not clear for, so a stale build costs a confusing offer, not access.
 *
 * The description and the access details are copy: the catalog carries the sample's for its three member
 * classifications (`newConversation.class.<value>`), and a deployment adds its own the same way. A
 * classification with none shows the generic description and no details.
 */
function membersOf(value: string, all: ClientClassification[]): string[] {
  return all.filter((c) => c.grants.includes(value)).map((c) => c.displayName);
}

const NewConversationModal: React.FC<NewConversationModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { t } = useTranslation();
  // NO TITLE STATE. A conversation is named from its own first turn, so there is nothing to collect
  // here and nothing to carry - see the note on the form below.
  const [selectedClassification, setSelectedClassification] = useState<ClassificationOption | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showContextDetail, setShowContextDetail] = useState<string | null>(null);
  const { user } = useAuth();
  const { createConversation } = useConversations();

  const all = deploymentClassifications();
  const availableClassifications: ClassificationOption[] = creatableClassifications(user?.tier).map((c) => {
    const model = modelForClassification(c);
    const copy = (key: string) => t(`newConversation.class.${c.value}.${key}`, { returnObjects: true, defaultValue: [] }) as unknown;
    const list = (key: string) => { const v = copy(key); return Array.isArray(v) ? v.map(String) : []; };
    return {
      tier: c.value,
      label: c.displayName,
      description: t(`newConversation.class.${c.value}.description`, { defaultValue: t('newConversation.genericDescription') }),
      membershipRule: t('newConversation.membership', { names: membersOf(c.value, all).join(', ') }),
      agentModel: model?.displayName ?? '',
      modelId: model?.bedrockModelId ?? '',
      contextAccess: list('contextAccess'),
      tools: list('tools'),
    };
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedClassification) {
      try {
        setIsCreating(true);
        setError(null);
        // The chosen option names both the classification and its model; the classification is sent
        // as chosen, never inferred from the model.
        //
        // NO TITLE: the server opens the room with the platform's own unnamed marker, which its first message
        // replaces (`channel-title.ts`). Sending display text here would tie that rename to the reader's language.
        await createConversation(
          undefined,
          selectedClassification.modelId,
          selectedClassification.agentModel,
          selectedClassification.tier,
        );
        setSelectedClassification(null);
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
          {/*
            * NO TITLE FIELD. A conversation is named from what it turns out to be
            * about, not from what someone guessed before it started - asking up front makes a person
            * name a thing they have not had yet, and the name they invent is usually worse than the
            * one the first message would have produced.
            *
            * The channel is created with the placeholder the auto-name looks for, and the first
            * substantive turn replaces it (`channel-title.ts`). Measured over two days: 118 renames,
            * no skips and no derivation failures, so the path this now depends on entirely is the one
            * that was already doing the work.
            */}

          {/* Classification selector */}
          <div className="ncm-section">
            <label className="ncm-label">
              <span className="ncm-label-text">{t('newConversation.classificationLabel')}</span>
              <span className="ncm-label-hint">{t('newConversation.classificationHint')}</span>
            </label>
            <div className="ncm-classification-grid">
              {availableClassifications.map((classification) => {
                const isSelected = selectedClassification?.tier === classification.tier;
                const isExpanded = showContextDetail === classification.tier;
                const hasDetails = classification.contextAccess.length > 0 || classification.tools.length > 0;

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
                    style={classificationBadgeStyle(classification.tier)}
                  >
                    <div className="ncm-class-card-header">
                      <div className="ncm-class-card-badge">
                        {classification.label}
                      </div>
                    </div>

                    <p className="ncm-class-card-desc">{classification.description}</p>

                    <div className="ncm-class-card-meta">
                      <div className="ncm-class-card-meta-item">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
                          <path fillRule="evenodd" d="M8 1a3.5 3.5 0 00-3.5 3.5V7H3a1 1 0 00-1 1v5a1 1 0 001 1h10a1 1 0 001-1V8a1 1 0 00-1-1h-1.5V4.5A3.5 3.5 0 008 1zm2 6V4.5a2 2 0 10-4 0V7h4z" clipRule="evenodd" />
                        </svg>
                        <span>{classification.membershipRule}</span>
                      </div>
                      {hasDetails && (
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
                      )}
                    </div>

                    {isExpanded && hasDetails && (
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
            <div className="ncm-security-bar" style={classificationBadgeStyle(selectedClassification.tier)}>
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
