import React, { useState } from 'react';
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
  const { user } = useAuth();
  const { activeConversation } = useConversations();

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

  return (
    <div className="attachment-display">
      {isImageType(attachment.type) ? (
        <div className="attachment-image-preview" onClick={handleDownload}>
          <div className="attachment-image-placeholder">
            <span className="attachment-file-icon">img</span>
          </div>
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
