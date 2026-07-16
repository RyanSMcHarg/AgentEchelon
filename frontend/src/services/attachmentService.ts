import type { Attachment } from '../types';
import { trackEvent } from './eventTrackingService';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const ALLOWED_TYPES = [
  'text/plain',
  'text/csv',
  'text/html',
  'text/markdown',
  'application/json',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

function getPresignedUrlEndpoint(): string {
  const url = import.meta.env.VITE_PRESIGNED_URL_API_URL;
  if (!url) {
    throw new Error('VITE_PRESIGNED_URL_API_URL not configured');
  }
  return url;
}

export async function uploadFile(
  file: File,
  conversationId: string,
  userId: string
): Promise<Attachment> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File size exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`);
  }

  if (ALLOWED_TYPES.length > 0 && !ALLOWED_TYPES.includes(file.type) && file.type !== '') {
    throw new Error(`File type "${file.type}" is not supported`);
  }

  // Get presigned upload URL (Cognito-authorized)
  const idToken = localStorage.getItem('idToken');
  if (!idToken) {
    throw new Error('Not authenticated');
  }

  const response = await fetch(getPresignedUrlEndpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      action: 'upload',
      fileName: file.name,
      fileType: file.type || 'application/octet-stream',
      conversationId,
      userId,
    }),
  });

  if (!response.ok) {
    throw new Error('Failed to get upload URL');
  }

  const { uploadUrl, fileKey } = await response.json();

  // Upload to S3
  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });

  if (!uploadResponse.ok) {
    throw new Error('Failed to upload file');
  }

  trackEvent('file_uploaded', {
    size: file.size,
    type: file.type || 'application/octet-stream',
    conversationId,
  });

  return {
    fileKey,
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream',
  };
}

export async function getDownloadUrl(
  fileKey: string,
  conversationId: string,
  userId: string
): Promise<string> {
  const idToken = localStorage.getItem('idToken');
  if (!idToken) {
    throw new Error('Not authenticated');
  }

  const response = await fetch(getPresignedUrlEndpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      action: 'download',
      fileKey,
      conversationId,
      userId,
    }),
  });

  if (!response.ok) {
    throw new Error('Failed to get download URL');
  }

  const { downloadUrl } = await response.json();
  return downloadUrl;
}
