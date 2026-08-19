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

  it('uploads via presigned POST when the backend returns policy fields', async () => {
    // The current backend shape. A presigned PUT signed an exact ContentLength believing it was a
    // ceiling, so every real upload failed SignatureDoesNotMatch (measured live); a POST policy's
    // content-length-range is a true cap. The signed fields must be posted verbatim, ahead of the
    // file part - S3 ignores any field after the file.
    const pdf = createFile('doc.pdf', 1024, 'application/pdf');

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          uploadUrl: 'https://s3.example.com/bucket',
          fileKey: 'attachments/conv-1/user-1/123-doc.pdf',
          fields: { key: 'attachments/conv-1/user-1/123-doc.pdf', 'Content-Type': 'application/pdf', 'X-Amz-Signature': 'sig' },
        }),
      })
      .mockResolvedValueOnce({ ok: true });

    await uploadFile(pdf, 'conv-1', 'user-1');

    const [s3Url, s3Options] = mockFetch.mock.calls[1];
    expect(s3Url).toBe('https://s3.example.com/bucket');
    expect(s3Options.method).toBe('POST');
    const form = s3Options.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const entries = [...form.keys()];
    expect(entries).toEqual(['key', 'Content-Type', 'X-Amz-Signature', 'file']);
    expect(entries[entries.length - 1]).toBe('file');
  });

  it('infers the type from the extension when the browser reports none', async () => {
    // Browsers report '' for extensions they don't know (.md on Windows is the common case). The old
    // behaviour admitted these and sent application/octet-stream, which the presigner categorically
    // rejects - a guaranteed LATE 400 for a file this function had just accepted. The type is
    // inferred and the real type is what reaches the presigner and S3.
    const md = createFile('notes.md', 1024, '');

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ uploadUrl: 'https://s3.example.com/upload', fileKey: 'key' }),
      })
      .mockResolvedValueOnce({ ok: true });

    const result = await uploadFile(md, 'conv-1', 'user-1');
    expect(result.type).toBe('text/markdown');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).fileType).toBe('text/markdown');
  });

  it('refuses a file whose type cannot be determined, BEFORE anything uploads', async () => {
    // The counterpart: an unknown binary must fail here, with the reason, not three hops later as a
    // presigner 400 the user cannot interpret.
    const bin = createFile('data.bin', 1024, '');
    await expect(uploadFile(bin, 'conv-1', 'user-1')).rejects.toThrow('not supported');
    expect(mockFetch).not.toHaveBeenCalled();
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
