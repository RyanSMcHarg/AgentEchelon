import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import AttachmentDisplay from './AttachmentDisplay';
import { useAuth, type User } from '@ae/shared';
import { getDownloadUrl } from '../services/attachmentService';
import { useConversations } from '../providers/ConversationProvider.chime';

// Isolate the component from auth, the conversation provider, and the presigned-URL vend.
vi.mock('@ae/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ae/shared')>()),
  useAuth: vi.fn(),
}));
vi.mock('../services/attachmentService', () => ({ getDownloadUrl: vi.fn() }));
vi.mock('../providers/ConversationProvider.chime', () => ({ useConversations: vi.fn() }));

const ATTACHMENT = {
  fileKey: 'generated/report-2026-07-30.md',
  name: 'report-2026-07-30.md',
  size: 1536,
  type: 'text/markdown',
};

function renderWith(opts: { user?: Partial<User> | null; conversation?: { id: string } | null } = {}) {
  const { user = { id: 'u1', email: 'a@x', tier: 'premium' }, conversation = { id: 'conv-1' } } = opts;
  vi.mocked(useAuth).mockReturnValue({ user } as unknown as ReturnType<typeof useAuth>);
  vi.mocked(useConversations).mockReturnValue({
    activeConversation: conversation,
  } as unknown as ReturnType<typeof useConversations>);
  return render(<AttachmentDisplay attachment={ATTACHMENT} />);
}

/**
 * A delivered document the user cannot open, with NO error shown, is indistinguishable from a
 * dead button. Observed live 2026-07-30: the report was delivered correctly and the click
 * produced zero presigned-URL requests, silently — the handler had returned early on missing
 * context and logged the failure to the console only.
 *
 * Each test below drives one of the three silent paths and asserts something reaches the user.
 */
describe('AttachmentDisplay — a failed download is never silent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('open', vi.fn().mockReturnValue({}));
  });

  it('shows an error when the presigned URL vend fails', async () => {
    vi.mocked(getDownloadUrl).mockRejectedValue(new Error('403 from presigned-url'));
    const { container } = renderWith();

    (container.querySelector('.attachment-file') as HTMLElement).click();

    await waitFor(() => {
      expect(container.querySelector('.attachment-error')?.textContent).toMatch(/couldn't open this file/i);
    });
  });

  it('shows an error when the conversation context is missing (the silent early-return)', async () => {
    const { container } = renderWith({ conversation: null });

    (container.querySelector('.attachment-file') as HTMLElement).click();

    await waitFor(() => {
      expect(container.querySelector('.attachment-error')?.textContent).toMatch(/not ready yet/i);
    });
    // It must not pretend to have tried.
    expect(getDownloadUrl).not.toHaveBeenCalled();
  });

  // THIS TEST USED TO PIN A DEFECT. It asserted that a null return from `window.open` produced "your
  // browser blocked the download window" - but `window.open(url, '_blank', 'noopener,noreferrer')`
  // returns null WHENEVER `noopener` is set, by specification, because the opener must not receive a
  // handle to the new window. So the message appeared on every SUCCESSFUL download (measured live: the
  // file downloaded, and the UI said it was blocked), and this test kept that in place.
  //
  // The download is now an anchor click, which has no return value to misread. There is no reliable
  // way to detect a blocked popup here, so nothing claims to - and what is asserted instead is that a
  // successful download says nothing at all.
  it('opens the presigned URL in a new tab with reverse-tabnabbing protection', async () => {
    vi.mocked(getDownloadUrl).mockResolvedValue('https://s3.example.com/report.md?sig=abc');
    const clicked: HTMLAnchorElement[] = [];
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patched(this: HTMLAnchorElement) { clicked.push(this); };
    try {
      const { container } = renderWith();
      (container.querySelector('.attachment-file') as HTMLElement).click();

      await waitFor(() => expect(clicked).toHaveLength(1));
      expect(clicked[0].href).toBe('https://s3.example.com/report.md?sig=abc');
      expect(clicked[0].target).toBe('_blank');
      expect(clicked[0].rel).toBe('noopener noreferrer');
      // And it does not tell the person their browser stopped something that worked.
      expect(container.querySelector('.attachment-error')).toBeNull();
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
    }
  });

  it('leaves nothing appended to the document after the click', async () => {
    vi.mocked(getDownloadUrl).mockResolvedValue('https://s3.example.com/report.md?sig=abc');
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patched(this: HTMLAnchorElement) { /* no navigation */ };
    try {
      const { container } = renderWith();
      (container.querySelector('.attachment-file') as HTMLElement).click();

      await waitFor(() => expect(getDownloadUrl).toHaveBeenCalled());
      await waitFor(() => expect(document.querySelectorAll('a[rel="noopener noreferrer"]')).toHaveLength(0));
    } finally {
      HTMLAnchorElement.prototype.click = realClick;
    }
  });

  it('shows NO error on a successful download', async () => {
    vi.mocked(getDownloadUrl).mockResolvedValue('https://s3.example.com/report.md?sig=abc');
    const { container } = renderWith();

    (container.querySelector('.attachment-file') as HTMLElement).click();

    await waitFor(() => expect(getDownloadUrl).toHaveBeenCalled());
    expect(container.querySelector('.attachment-error')).toBeNull();
  });
});
