import React, { useEffect, useState } from 'react';
import type { Attachment } from '@ae/shared';
import { getDownloadUrl } from '../services/attachmentService';
import { useAuth } from '@ae/shared';
import { useConversations } from '../providers/ConversationProvider.chime';
import './AttachmentDisplay.css';

interface AttachmentDisplayProps {
  attachment: Attachment;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageType(type: string): boolean {
  return type.startsWith('image/');
}

function getFileIcon(type: string): string {
  if (type.startsWith('image/')) return 'img';
  if (type.includes('pdf')) return 'PDF';
  if (type.includes('spreadsheet') || type.includes('excel') || type.includes('csv')) return 'XLS';
  if (type.includes('word') || type.includes('document')) return 'DOC';
  if (type.includes('json')) return 'JSON';
  if (type.includes('markdown') || type.includes('text/markdown')) return 'MD';
  return 'FILE';
}

const AttachmentDisplay: React.FC<AttachmentDisplayProps> = ({ attachment }) => {
  const [isDownloading, setIsDownloading] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const { user } = useAuth();
  const { activeConversation } = useConversations();

  const isImage = isImageType(attachment.type);

  // For image attachments, resolve the presigned URL up front so the picture
  // can render inline rather than as a click-to-open chip.
  useEffect(() => {
    if (!isImage || !user || !activeConversation) return;

    let cancelled = false;
    setImageFailed(false);

    getDownloadUrl(attachment.fileKey, activeConversation.id, user.id)
      .then((url) => {
        if (!cancelled) setImageUrl(url);
      })
      .catch((error) => {
        console.error('Failed to resolve image URL:', error);
        if (!cancelled) setImageFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [isImage, attachment.fileKey, user, activeConversation]);

  // Every failure path below MUST leave something on screen. This handler used to return
  // early when the auth/conversation context was missing and to swallow a failed URL vend
  // into console.error, so a user who clicked a delivered report got NO window, NO error,
  // and no indication the click had registered - indistinguishable from a dead UI. Observed
  // live on 2026-07-30: the report was delivered correctly and the click produced zero
  // presigned-URL requests, silently.
  const handleDownload = async () => {
    setDownloadError(null);

    if (!user || !activeConversation) {
      // Not the user's fault and not retryable by clicking again, so say what is wrong
      // rather than failing mute.
      setDownloadError('Not ready yet — reopen this conversation and try again.');
      return;
    }

    try {
      setIsDownloading(true);
      const url = await getDownloadUrl(
        attachment.fileKey,
        activeConversation.id,
        user.id
      );
      // AN ANCHOR CLICK, NOT `window.open`, and the reason is that its return value cannot be read.
      // `window.open(url, '_blank', 'noopener,noreferrer')` returns null WHENEVER `noopener` is set -
      // that is what the specification requires, since the opener must not receive a handle to the new
      // window. The old code read that null as "the popup was blocked", so every SUCCESSFUL download
      // told the person their browser had stopped it (measured live: the file downloaded, and the UI
      // said it was blocked).
      //
      // A user-gesture anchor click keeps the same hardening - `rel="noopener noreferrer"` prevents
      // reverse-tabnabbing on the presigned URL - without inventing a failure signal that cannot
      // exist. There is no reliable way to detect a blocked popup here, so nothing claims to.
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error('Failed to download file:', error);
      setDownloadError("Couldn't open this file. Please try again.");
    } finally {
      setIsDownloading(false);
    }
  };

  // A failed URL fetch or a broken image falls back to the click-to-open chip
  // so the user never sees a dead box.
  const showImageChipFallback = isImage && imageFailed;

  return (
    <div className="attachment-display">
      {isImage && !showImageChipFallback ? (
        <div className="attachment-image-preview" onClick={handleDownload}>
          {imageUrl ? (
            <img
              src={imageUrl}
              className="attachment-image"
              loading="lazy"
              alt={attachment.name}
              onError={() => setImageFailed(true)}
            />
          ) : (
            <div className="attachment-image-placeholder">
              <span className="attachment-image-spinner" />
            </div>
          )}
          <span className="attachment-name">{attachment.name}</span>
        </div>
      ) : (
        <div className="attachment-file" onClick={handleDownload}>
          <span className="attachment-file-icon">{getFileIcon(attachment.type)}</span>
          <div className="attachment-file-info">
            <span className="attachment-name">{attachment.name}</span>
            <span className="attachment-size">{formatFileSize(attachment.size)}</span>
          </div>
          <button className="attachment-download-btn" disabled={isDownloading}>
            {isDownloading ? '...' : '\u2193'}
          </button>
        </div>
      )}
      {/* role=alert so a screen reader announces the failure; a silently-dead download
          button is the bug this exists to prevent. */}
      {downloadError && (
        <p className="attachment-error" role="alert">
          {downloadError}
        </p>
      )}
    </div>
  );
};

export default AttachmentDisplay;
