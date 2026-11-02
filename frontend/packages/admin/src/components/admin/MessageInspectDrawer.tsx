import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AdminConversationMessage, Attachment } from '@ae/shared';
import { attachmentCapabilityForKey, isUserUploadedAttachment } from '../../services/adminAttachmentService';
import { queryAnalytics } from '../../services/analyticsService';

interface Props {
  message: AdminConversationMessage;
  onClose: () => void;
  /** Open a conversation attachment (vends scoped, audited S3 creds and opens the presigned GET). */
  onOpenAttachment?: (fileKey: string, name: string) => void;
  /** fileKey currently being vended/opened, so its button can show a pending state. */
  openingAttachment?: string | null;
  /**
   * The conversation the message is in. With it, a file the assistant delivered shows its own grade
   * (`document_evaluation`, SPEC-EVALUATION FR22) next to the file.
   */
  channelArn?: string;
}

type DocumentScore = Record<string, unknown>;

/**
 * THE DELIVERED FILE'S OWN GRADE, NEXT TO THE FILE. One row of `document_evaluation` for this
 * conversation, matched on the file key. Every grading state says what it is, so "not graded" never
 * reads as a missing score: skipped (with its reason), retrying, stopped after its attempts, or waiting.
 */
const DocumentScoreField: React.FC<{ channelArn: string; fileKey: string }> = ({ channelArn, fileKey }) => {
  const { t } = useTranslation();
  const [score, setScore] = useState<DocumentScore | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setScore(undefined);
    Promise.resolve()
      .then(() => queryAnalytics('document_evaluation', undefined, { channelArn }))
      .then((res) => {
        if (cancelled) return;
        const rows = (res?.data ?? []) as DocumentScore[];
        setScore(rows.find((r) => r.file_key === fileKey) ?? null);
      })
      .catch(() => { if (!cancelled) setScore(null); });
    return () => { cancelled = true; };
  }, [channelArn, fileKey]);

  // A verdict the judge did not give (NULL) shows no badge, never a pass.
  const verdict = (v: unknown, yes: string, no: string) =>
    (typeof v === 'boolean'
      ? <span className={['badge', v ? 'badge-success' : 'badge-error'].join(' ')}>{v ? yes : no}</span>
      : null);

  let body: React.ReactNode;
  if (score === undefined) body = <div className="admin-muted">{t('admin.messageInspectDrawer.documentScoreLoading')}</div>;
  else if (score === null) body = <div className="admin-muted">{t('admin.messageInspectDrawer.documentScoreUnavailable')}</div>;
  else if (score.grading_status !== 'scored') {
    const state = String(score.grading_status || 'awaiting');
    const reason = score.skip_reason ? t(`admin.deliveredDocuments.skipReason.${String(score.skip_reason)}`) : '';
    body = (
      <div className="admin-muted">
        {t(`admin.messageInspectDrawer.gradingState.${state}`, { reason, attempts: Number(score.grading_attempts ?? 0) })}
      </div>
    );
  } else {
    body = (
      <>
        <div>
          {t('admin.messageInspectDrawer.documentRelevance', { score: String(score.relevance_score), classification: String(score.classification ?? '') })}
        </div>
        {score.reply_relevance_score != null && (
          <div className="admin-muted">{t('admin.messageInspectDrawer.replyRelevance', { score: String(score.reply_relevance_score) })}</div>
        )}
        <div className="admin-drawer-badges" style={{ marginTop: 'var(--space-2)' }}>
          {verdict(score.is_grounded, t('admin.messageInspectDrawer.grounded'), t('admin.messageInspectDrawer.ungrounded'))}
          {verdict(score.is_compliant, t('admin.messageInspectDrawer.compliant'), t('admin.messageInspectDrawer.notCompliant'))}
        </div>
        {score.reasoning ? (
          <div className="admin-muted" style={{ marginTop: 'var(--space-2)' }}>
            {t('admin.messageInspectDrawer.judgeSaid', { reasoning: String(score.reasoning) })}
          </div>
        ) : null}
      </>
    );
  }
  return (
    <div style={{ marginTop: 'var(--space-2)' }} data-testid="document-score">
      <span className="label">{t('admin.messageInspectDrawer.documentScore')}</span>
      {body}
    </div>
  );
};

/**
 * Right slide-in drawer that inspects ONE archived message — every field
 * including the full raw Payload + metadata + MessageAttributes (CHIME.LEX.*).
 * This is the "info" surface for admin moderation; the faithful stored record
 * is the point, so we render raw values (mono) rather than prettified copies.
 */
const MessageInspectDrawer: React.FC<Props> = ({ message, onClose, onOpenAttachment, openingAttachment, channelArn }) => {
  const { t } = useTranslation();
  const meta = (message.metadata || {}) as Record<string, unknown>;
  const metaEntries = Object.entries(meta);
  // The attachment (if any) stored on the message Metadata as {fileKey,name,size,type}.
  const rawAtt = meta.attachment as Partial<Attachment> | undefined;
  const attachment =
    rawAtt && typeof rawAtt.fileKey === 'string' && attachmentCapabilityForKey(rawAtt.fileKey)
      ? (rawAtt as Attachment)
      : undefined;
  const attIsUpload = attachment ? isUserUploadedAttachment(attachment.fileKey) : false;

  return (
    <div className="admin-drawer-overlay" onClick={onClose}>
      <aside className="admin-drawer" onClick={(e) => e.stopPropagation()}>
        <header className="admin-drawer-header">
          <div>
            <h4>{t('admin.messageInspect.message')}</h4>
            <code className="admin-mono-id">{message.id}</code>
          </div>
          <button className="btn-secondary" onClick={onClose} aria-label={t('admin.messageInspect.close')}>×</button>
        </header>

        <div className="admin-drawer-body">
          <div className="admin-drawer-badges">
            <span className={`badge ${message.isBot ? 'badge-accent' : 'badge-neutral'}`}>
              {message.isBot ? 'Assistant' : 'User'}
            </span>
            {message.redacted && <span className="badge badge-error">{t('admin.messageInspect.redacted')}</span>}
            {message.intent && <span className="badge badge-info">{message.intent}</span>}
            {message.modelId && <span className="badge badge-neutral">{message.modelId}</span>}
          </div>

          <section className="admin-drawer-field">
            <span className="label">{t('admin.messageInspect.content')}</span>
            <div className="admin-drawer-content">{message.content || <em>(empty)</em>}</div>
          </section>

          <section className="admin-drawer-field">
            <span className="label">{t('admin.messageInspect.sender')}</span>
            {/* The name is a separate grant and the server omits it when the caller does not
                hold it. The ARN below always identifies the sender, so the field is labelled rather
                than left blank - a blank reads as missing data instead of as withheld. */}
            <div>{message.senderName || <span className="admin-muted">{t('admin.messageInspect.identityNotShown')}</span>}</div>
            <code className="admin-mono-arn">{message.senderArn}</code>
          </section>

          <section className="admin-drawer-field">
            <span className="label">{t('admin.messageInspect.timestamp')}</span>
            <code className="admin-mono-arn">{message.timestamp}</code>
          </section>

          {attachment && (
            <section className="admin-drawer-field">
              <span className="label">{t('admin.messageInspect.attachment')}</span>
              <div>{attachment.name}</div>
              <code className="admin-mono-arn">
                {attachment.type || 'file'}
                {typeof attachment.size === 'number' ? ` · ${Math.round(attachment.size / 1024)} KB` : ''}
              </code>
              <div className="admin-drawer-badges" style={{ marginTop: 'var(--space-2)' }}>
                <span className={`badge ${attIsUpload ? 'badge-error' : 'badge-neutral'}`}>
                  {attIsUpload ? t('admin.messageInspectDrawer.userUploadMayContainPii') : t('admin.messageInspectDrawer.assistantDeliverable')}
                </span>
              </div>
              {onOpenAttachment ? (
                <button
                  className="btn-secondary"
                  style={{ marginTop: 'var(--space-2)' }}
                  disabled={openingAttachment === attachment.fileKey}
                  onClick={() => onOpenAttachment(attachment.fileKey, attachment.name)}
                  title={attIsUpload ? t('admin.messageInspectDrawer.openingAUserUploadedFile') : t('admin.messageInspectDrawer.openTheDeliveredDocument')}
                >
                  {openingAttachment === attachment.fileKey ? 'Opening…' : t('admin.messageInspectDrawer.openAttachment')}
                </button>
              ) : null}
              {/* Only a file the assistant delivered is graded; an upload is the person's, not a deliverable. */}
              {channelArn && message.isBot && !attIsUpload && (
                <DocumentScoreField channelArn={channelArn} fileKey={attachment.fileKey} />
              )}
            </section>
          )}

          {metaEntries.length > 0 && (
            <section className="admin-drawer-field">
              <span className="label">{t('admin.messageInspect.metadata')}</span>
              <table className="admin-kv-table">
                <tbody>
                  {metaEntries.map(([k, v]) => (
                    <tr key={k}>
                      <td className="admin-kv-key">{k}</td>
                      <td className="admin-kv-val">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {message.raw && (
            <details className="admin-drawer-field">
              <summary className="label" style={{ cursor: 'pointer' }}>Raw payload (all fields)</summary>
              <pre className="admin-raw-json">{JSON.stringify(message.raw, null, 2)}</pre>
            </details>
          )}
        </div>
      </aside>
    </div>
  );
};

export default MessageInspectDrawer;
