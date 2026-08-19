import type { Attachment } from '@ae/shared';
import { trackEvent } from '@ae/shared';

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

/**
 * Browsers report `file.type === ''` for extensions they don't know (`.md` on Windows is the common
 * case). The old behaviour admitted those and sent 'application/octet-stream', which the presigner
 * categorically rejects - a guaranteed late 400 for a file this function had just accepted. The type
 * is inferred from the extension instead, and a file that is STILL unknown is refused here, with the
 * reason, before anything is uploaded.
 */
const TYPE_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
};

function effectiveFileType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return TYPE_BY_EXTENSION[ext] ?? '';
}

export async function uploadFile(
  file: File,
  conversationId: string,
  userId: string
): Promise<Attachment> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File size exceeds ${MAX_FILE_SIZE / (1024 * 1024)}MB limit`);
  }
  // The presigned POST policy's content-length-range starts at 1 byte, so a 0-byte file would fail
  // at S3 with an opaque policy error three hops from here. Refused where the reason can be said.
  if (file.size === 0) {
    throw new Error('File is empty');
  }

  const fileType = effectiveFileType(file);
  if (!ALLOWED_TYPES.includes(fileType)) {
    throw new Error(`File type "${file.type || file.name.split('.').pop() || 'unknown'}" is not supported`);
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
      fileType,
      conversationId,
      userId,
    }),
  });

  if (!response.ok) {
    throw new Error('Failed to get upload URL');
  }

  const { uploadUrl, fileKey, fields } = await response.json();

  // Presigned POST (fields present): the S3 mechanism built for browser uploads, whose
  // content-length-range condition is a true size cap. The signed fields go ahead of the file part,
  // verbatim. (The previous presigned PUT signed an exact ContentLength believing it was a ceiling,
  // so every real upload failed SignatureDoesNotMatch.) The PUT branch remains only for a backend
  // that predates the POST shape.
  let uploadResponse: Response;
  if (fields && typeof fields === 'object') {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields as Record<string, string>)) form.append(k, v);
    form.append('file', file);
    uploadResponse = await fetch(uploadUrl, { method: 'POST', body: form });
  } else {
    uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': fileType },
      body: file,
    });
  }

  if (!uploadResponse.ok) {
    throw new Error('Failed to upload file');
  }

  trackEvent('file_uploaded', {
    size: file.size,
    type: fileType,
    conversationId,
  });

  return {
    fileKey,
    name: file.name,
    size: file.size,
    type: fileType,
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
