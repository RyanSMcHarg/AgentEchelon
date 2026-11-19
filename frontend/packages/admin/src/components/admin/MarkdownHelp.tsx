/** The line under a field whose text the chat renders as Markdown, with a guide to the syntax. */
import React from 'react';
import { useTranslation } from 'react-i18next';

const MarkdownHelp: React.FC<{ testId: string }> = ({ testId }) => {
  const { t } = useTranslation();
  return (
    <span className="admin-field-hint" data-testid={testId}>
      {t('admin.workflowEditor.markdownHelp')}{' '}
      <a href={t('admin.workflowEditor.markdownGuideUrl')} target="_blank" rel="noreferrer">{t('admin.workflowEditor.markdownGuide')}</a>
    </span>
  );
};

export default MarkdownHelp;
