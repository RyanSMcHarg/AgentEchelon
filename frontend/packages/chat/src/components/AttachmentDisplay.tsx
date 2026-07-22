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

  const handleDownload = async () => {
    if (!user || !activeConversation) return;

    try {
      setIsDownloading(true);
      const url = await getDownloadUrl(
        attachment.fileKey,
        activeConversation.id,
        user.id
      );
      // noopener+noreferrer prevents the opened window from accessing
      // window.opener (reverse-tabnabbing).
      // Low risk here (presigned S3 URL) but free hardening.
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      console.error('Failed to download file:', error);
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
    </div>
  );
};

export default AttachmentDisplay;
