import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uploadFile, getDownloadUrl } from './attachmentService';

// Mock import.meta.env
vi.stubEnv('VITE_PRESIGNED_URL_API_URL', 'https://api.example.com/presigned-url');

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockGetItem = vi.fn();
vi.stubGlobal('localStorage', { getItem: mockGetItem, setItem: vi.fn(), removeItem: vi.fn() });

beforeEach(() => {
  mockFetch.mockReset();
  mockGetItem.mockReturnValue('mock-id-token');
});

function createFile(name: string, size: number, type: string): File {
  const content = new Uint8Array(size);
  return new File([content], name, { type });
}

describe('uploadFile', () => {
  it('rejects files over 10MB', async () => {
    const bigFile = createFile('big.pdf', 11 * 1024 * 1024, 'application/pdf');
    await expect(uploadFile(bigFile, 'conv-1', 'user-1')).rejects.toThrow('File size exceeds 10MB limit');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects unsupported file types', async () => {
    const exe = createFile('malware.exe', 1024, 'application/x-msdownload');
    await expect(uploadFile(exe, 'conv-1', 'user-1')).rejects.toThrow('not supported');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('allows supported file types', async () => {
    const pdf = createFile('doc.pdf', 1024, 'application/pdf');

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ uploadUrl: 'https://s3.example.com/upload', fileKey: 'attachments/conv-1/user-1/123-doc.pdf' }),
      })
      .mockResolvedValueOnce({ ok: true });

    const result = await uploadFile(pdf, 'conv-1', 'user-1');

    expect(result).toEqual({
      fileKey: 'attachments/conv-1/user-1/123-doc.pdf',
      name: 'doc.pdf',
      size: 1024,
      type: 'application/pdf',
    });

    // First call: get presigned URL
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [presignedUrl, presignedOptions] = mockFetch.mock.calls[0];
    expect(presignedUrl).toBe('https://api.example.com/presigned-url');
    expect(JSON.parse(presignedOptions.body)).toMatchObject({
      action: 'upload',
      fileName: 'doc.pdf',
      fileType: 'application/pdf',
    });

    // Second call: PUT to S3
    const [s3Url, s3Options] = mockFetch.mock.calls[1];
    expect(s3Url).toBe('https://s3.example.com/upload');
    expect(s3Options.method).toBe('PUT');
  });

  it('allows files with empty type', async () => {
    const noType = createFile('data.bin', 1024, '');

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ uploadUrl: 'https://s3.example.com/upload', fileKey: 'key' }),
      })
      .mockResolvedValueOnce({ ok: true });

    const result = await uploadFile(noType, 'conv-1', 'user-1');
    expect(result.type).toBe('application/octet-stream');
  });

  it('throws on presigned URL failure', async () => {
    const pdf = createFile('doc.pdf', 1024, 'application/pdf');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(uploadFile(pdf, 'conv-1', 'user-1')).rejects.toThrow('Failed to get upload URL');
  });

  it('throws on S3 upload failure', async () => {
    const pdf = createFile('doc.pdf', 1024, 'application/pdf');
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ uploadUrl: 'https://s3.example.com/upload', fileKey: 'key' }),
      })
      .mockResolvedValueOnce({ ok: false, status: 403 });

    await expect(uploadFile(pdf, 'conv-1', 'user-1')).rejects.toThrow('Failed to upload file');
  });
});

describe('getDownloadUrl', () => {
  it('returns download URL on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ downloadUrl: 'https://s3.example.com/download/file' }),
    });

    const url = await getDownloadUrl('attachments/conv-1/user-1/file.pdf', 'conv-1', 'user-1');
    expect(url).toBe('https://s3.example.com/download/file');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toMatchObject({
      action: 'download',
      fileKey: 'attachments/conv-1/user-1/file.pdf',
    });
  });

  it('throws on failure', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(getDownloadUrl('key', 'conv-1', 'user-1')).rejects.toThrow('Failed to get download URL');
  });
});
