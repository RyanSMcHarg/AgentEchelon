import React from 'react';
import { useTranslation } from 'react-i18next';
import { useMessaging } from '../providers/MessagingProvider';
import { useAuth } from '../providers/AuthProvider';
import './ConnectionStatus.css';

const ConnectionStatus: React.FC = () => {
  const { isAuthenticated } = useAuth();

  // Only render when authenticated - the hook is safe because
  // MessagingProvider wraps this component in the tree
  if (!isAuthenticated) return null;

  return <ConnectionStatusInner />;
};

const ConnectionStatusInner: React.FC = () => {
  const { t } = useTranslation();
  const { isConnected } = useMessaging();

  // Only show when NOT connected
  if (isConnected) return null;

  return (
    <div className="connection-status connection-status--disconnected">
      <span className="connection-dot connection-dot--red" />
      <span className="connection-label">{t('connection.reconnecting')}</span>
    </div>
  );
};

export default ConnectionStatus;
