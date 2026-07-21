import { describe, it, expect, vi } from 'vitest';
import {
  attachmentCapabilityForKey,
  isUserUploadedAttachment,
  getAdminAttachmentDownloadUrl,
} from './adminAttachmentService';

// The generated-doc vs user-upload split is a security boundary (two exchange capabilities),
// so the key→capability mapping must be exact and closed (unknown keys are not reviewable).
describe('attachmentCapabilityForKey', () => {
  it('maps assistant DELIVERABLES to the archive-grade capability', () => {
    expect(attachmentCapabilityForKey('generated-docs/room-1/report.md')).toBe('attachment-read');
  });
  it('maps USER UPLOADS to the moderation-grade capability', () => {
    expect(attachmentCapabilityForKey('attachments/room-1/user-sub/data.csv')).toBe('attachment-read-uploads');
  });
  it('rejects any key outside the two known prefixes (not reviewable)', () => {
    expect(attachmentCapabilityForKey('other/x')).toBeNull();
    expect(attachmentCapabilityForKey('generated-docs')).toBeNull(); // prefix must include the slash
    expect(attachmentCapabilityForKey('')).toBeNull();
  });
});

describe('isUserUploadedAttachment', () => {
  it('is true only for the user-upload prefix', () => {
    expect(isUserUploadedAttachment('attachments/room-1/u/x.csv')).toBe(true);
    expect(isUserUploadedAttachment('generated-docs/room-1/r.md')).toBe(false);
    expect(isUserUploadedAttachment('nope/x')).toBe(false);
  });
});

describe('getAdminAttachmentDownloadUrl', () => {
  it('refuses a key that is not an admin-reviewable attachment (never calls the exchange)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(getAdminAttachmentDownloadUrl('arn:...:channel/room-1', 'secrets/passwd')).rejects.toThrow(
      /not an admin-reviewable attachment/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
