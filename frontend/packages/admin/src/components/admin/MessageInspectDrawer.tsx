import React from 'react';
import type { AdminConversationMessage, Attachment } from '@ae/shared';
import { attachmentCapabilityForKey, isUserUploadedAttachment } from '../../services/adminAttachmentService';

interface Props {
  message: AdminConversationMessage;
  onClose: () => void;
  /** Open a conversation attachment (vends scoped, audited S3 creds and opens the presigned GET). */
  onOpenAttachment?: (fileKey: string, name: string) => void;
  /** fileKey currently being vended/opened, so its button can show a pending state. */
  openingAttachment?: string | null;
}

/**
 * Right slide-in drawer that inspects ONE archived message — every field
 * including the full raw Payload + metadata + MessageAttributes (CHIME.LEX.*).
 * This is the "info" surface for admin moderation; the faithful stored record
 * is the point, so we render raw values (mono) rather than prettified copies.
 */
const MessageInspectDrawer: React.FC<Props> = ({ message, onClose, onOpenAttachment, openingAttachment }) => {
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
            <h4>Message</h4>
            <code className="admin-mono-id">{message.id}</code>
          </div>
          <button className="admin-inline-btn" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="admin-drawer-body">
          <div className="admin-drawer-badges">
            <span className={`badge ${message.isBot ? 'badge-accent' : 'badge-neutral'}`}>
              {message.isBot ? 'Assistant' : 'User'}
            </span>
            {message.redacted && <span className="badge badge-error">Redacted</span>}
            {message.intent && <span className="badge badge-info">{message.intent}</span>}
            {message.modelId && <span className="badge badge-neutral">{message.modelId}</span>}
          </div>

          <section className="admin-drawer-field">
            <span className="label">Content</span>
            <div className="admin-drawer-content">{message.content || <em>(empty)</em>}</div>
          </section>

          <section className="admin-drawer-field">
            <span className="label">Sender</span>
            <div>{message.senderName}</div>
            <code className="admin-mono-arn">{message.senderArn}</code>
          </section>

          <section className="admin-drawer-field">
            <span className="label">Timestamp</span>
            <code className="admin-mono-arn">{message.timestamp}</code>
          </section>

          {attachment && (
            <section className="admin-drawer-field">
              <span className="label">Attachment</span>
              <div>{attachment.name}</div>
              <code className="admin-mono-arn">
                {attachment.type || 'file'}
                {typeof attachment.size === 'number' ? ` · ${Math.round(attachment.size / 1024)} KB` : ''}
              </code>
              <div className="admin-drawer-badges" style={{ marginTop: 'var(--space-2)' }}>
                <span className={`badge ${attIsUpload ? 'badge-error' : 'badge-neutral'}`}>
                  {attIsUpload ? 'User upload (may contain PII)' : 'Assistant deliverable'}
                </span>
              </div>
              {onOpenAttachment ? (
                <button
                  className="admin-inline-btn"
                  style={{ marginTop: 'var(--space-2)' }}
                  disabled={openingAttachment === attachment.fileKey}
                  onClick={() => onOpenAttachment(attachment.fileKey, attachment.name)}
                  title={attIsUpload ? 'Opening a user-uploaded file is an audited action' : 'Open the delivered document'}
                >
                  {openingAttachment === attachment.fileKey ? 'Opening…' : '⬇ Open attachment'}
                </button>
              ) : null}
            </section>
          )}

          {metaEntries.length > 0 && (
            <section className="admin-drawer-field">
              <span className="label">Metadata</span>
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
