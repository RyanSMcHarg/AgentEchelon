import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConversations } from '../providers/ConversationProvider.chime';
import type { Conversation } from '@ae/shared';
import './ConversationList.css';

interface ConversationListProps {
  onNewConversation: () => void;
}

const ConversationList: React.FC<ConversationListProps> = ({ onNewConversation }) => {
  const { t } = useTranslation();
  const { conversations, activeConversation, selectConversation, isInitializing, isConversationUnread } = useConversations();
  const [showArchived, setShowArchived] = useState(false);

  // Archived conversations are retained (read-only access) but hidden from the
  // active list by default; the "Show archived" toggle reveals them (ADR-017).
  const active = conversations.filter((c) => !c.archived);
  const archived = conversations.filter((c) => c.archived);

  const handleSelectConversation = (conversation: Conversation) => {
    selectConversation(conversation.id);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - date.getTime());
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return t('conversationList.date.today');
    } else if (diffDays === 1) {
      return t('conversationList.date.yesterday');
    } else if (diffDays < 7) {
      return t('conversationList.date.daysAgo', { count: diffDays });
    } else {
      return date.toLocaleDateString();
    }
  };

  const renderItem = (conversation: Conversation) => {
    const isActive = activeConversation?.id === conversation.id;
    const unread = !isActive && !conversation.archived && isConversationUnread(conversation);
    return (
      <button
        type="button"
        key={conversation.id}
        className={[
          'conversation-item',
          `conversation-item--${conversation.modelTier}`,
          isActive ? 'active' : '',
          unread ? 'unread' : '',
          conversation.archived ? 'conversation-item--archived' : '',
        ].filter(Boolean).join(' ')}
        onClick={() => handleSelectConversation(conversation)}
        aria-current={isActive ? 'page' : undefined}
      >
        <div className="conversation-item-body">
          <div className="conversation-title">
            {conversation.title}
          </div>
          <div className="conversation-meta">
            <span
              className="conversation-tier"
              title={conversation.modelName}
            >
              {t(`tier.${conversation.modelTier}`)}
            </span>
            {conversation.archived && (
              <span className="conversation-archived-badge">{t('conversation.archivedBadge')}</span>
            )}
            <span className="conversation-date">
              {formatDate(conversation.updatedAt.toISOString())}
            </span>
          </div>
        </div>
        {unread && (
          <span
            className="conversation-item-unread-dot"
            aria-label={t('conversationList.unreadLabel')}
            title={t('conversationList.unreadLabel')}
          />
        )}
      </button>
    );
  };

  return (
    <div className="conversation-list">
      <div className="conversation-list-header">
        <h2>{t('conversationList.heading')}</h2>
        <button className="new-conversation-btn" onClick={onNewConversation}>
          {t('conversationList.newButton')}
        </button>
      </div>
      <div className="conversation-items">
        {isInitializing ? (
          <div className="no-conversations">
            <p>{t('conversationList.loading')}</p>
          </div>
        ) : conversations.length === 0 ? (
          <div className="no-conversations">
            <p>{t('conversationList.emptyTitle')}</p>
            <p className="hint">{t('conversationList.emptyHint')}</p>
          </div>
        ) : (
          <>
            {active.map(renderItem)}
            {archived.length > 0 && (
              <>
                <button
                  type="button"
                  className="conversation-archived-toggle"
                  onClick={() => setShowArchived((v) => !v)}
                  aria-expanded={showArchived}
                >
                  {showArchived
                    ? t('conversationList.hideArchived', { count: archived.length })
                    : t('conversationList.showArchived', { count: archived.length })}
                </button>
                {showArchived && archived.map(renderItem)}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default ConversationList;
