/**
 * MessageInput - nothing the person wrote is lost, and every mention is picked by id.
 *
 * - A send that is refused (a mention error, a private address the send would not honor) uploads nothing and keeps the
 *   staged file with the draft.
 * - The draft (its words and the members it picked, by id) and its staged file are kept on this device per person and per
 *   conversation, restored when the conversation opens again, and gone when the session ends. A file above the cap keeps
 *   its name, and the person is asked to attach it again.
 * - Offline, a message alone is queued and the field clears; a message with a file stays in the field.
 * - The sticky reply prefix and the roster's requests write a member by id, and the front of the message keeps its
 *   meaning: `/md` stays first, a leading `.env` stays, and a mention never lands in front of a private address.
 * - An `@` inside code opens no picker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, fireEvent, waitFor, screen } from '@testing-library/react';
import { requestComposerAddress } from '../utils/composerRequests';
import { setBlobStore, STAGED_FILE_CAP_BYTES, type BlobStore } from '../services/composerCache';
import { endSessionEpoch } from '@ae/shared/services/sessionEpoch.ts';

const sendMessage = vi.fn();
const uploadFile = vi.fn();

const INSTANCE = 'arn:aws:chime:us-east-1:111:app-instance/i';
const CHANNEL = `${INSTANCE}/channel/c1`;
const SELF = `${INSTANCE}/user/self-id`;
const OTHER_PERSON = `${INSTANCE}/user/other-id`;
const ALICE = `${INSTANCE}/user/alice-id`;
const RYAN = `${INSTANCE}/user/ryan-id`;
const SAM_1 = `${INSTANCE}/user/sam-1`;
const SAM_2 = `${INSTANCE}/user/sam-2`;
const BOT = `${INSTANCE}/bot/advisor`;

const MEMBERS = [
  { userArn: BOT, name: 'Advisor', isBot: true },
  { userArn: ALICE, name: 'Alice', isBot: false },
  { userArn: RYAN, name: 'Ryan McHarg', isBot: false },
  { userArn: SAM_1, name: 'Sam', isBot: false },
  { userArn: SAM_2, name: 'Sam', isBot: false },
  { userArn: SELF, name: 'Me', isBot: false },
];

const state: {
  viewer: string;
  stickyTarget: unknown;
  queuedMessages: unknown[];
  conversationId: string;
} = { viewer: SELF, stickyTarget: null, queuedMessages: [], conversationId: 'c1' };
const retryQueuedMessage = vi.fn();
const discardQueuedMessage = vi.fn();

vi.mock('../providers/ConversationProvider.chime', () => ({
  useConversations: () => ({
    activeConversation: { id: state.conversationId, conversationArn: `${INSTANCE}/channel/${state.conversationId}`, modelTier: 'premium' },
    sendMessage: (...a: unknown[]) => sendMessage(...a),
    isSending: false,
    sendError: null,
    clearSendError: () => {},
    channelMembers: MEMBERS,
    stickyTarget: state.stickyTarget,
    setStickyTarget: () => {},
    battleWaitingBots: [],
    openWorkItems: [],
    refreshOpenWorkItems: () => {},
    queuedMessages: state.queuedMessages,
    retryQueuedMessage,
    discardQueuedMessage,
  }),
}));
vi.mock('../providers/AwsClientProvider', () => ({
  useAwsClient: () => ({ userArn: state.viewer, isInitialized: true, error: null }),
}));
vi.mock('@ae/shared', () => ({
  useAuth: () => ({ user: { id: 'self-id', isAdmin: false } }),
  trackEvent: () => {},
}));
vi.mock('../services/attachmentService', () => ({ uploadFile: (...a: unknown[]) => uploadFile(...a) }));
vi.mock('../services/messageLatencyTracker', () => ({ markMessageSent: () => {} }));
vi.mock('../hooks/useAttachmentCapability', () => ({ useAttachmentCapability: () => true }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k }),
}));

import MessageInput from './MessageInput';

/** The bytes of staged files, held in memory as IndexedDB holds them in a browser. */
function memoryBlobStore(): BlobStore & { size: () => number } {
  const map = new Map<string, Blob>();
  return {
    put: async (k, b) => { map.set(k, b); },
    get: async (k) => map.get(k),
    delete: async (k) => { map.delete(k); },
    clear: async () => { map.clear(); },
    size: () => map.size,
  };
}

let blobs: ReturnType<typeof memoryBlobStore>;

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue({ queued: false });
  uploadFile.mockReset().mockImplementation(async (f: File) => ({ fileKey: 'k', name: f.name, size: f.size, type: f.type }));
  retryQueuedMessage.mockReset();
  discardQueuedMessage.mockReset();
  state.viewer = SELF;
  state.stickyTarget = null;
  state.queuedMessages = [];
  state.conversationId = 'c1';
  blobs = memoryBlobStore();
  setBlobStore(blobs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const textarea = () => document.querySelector('.message-textarea') as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(textarea(), { target: { value: text, selectionStart: text.length } });
const enter = () => fireEvent.keyDown(textarea(), { key: 'Enter', code: 'Enter' });
const attach = (file: File) => fireEvent.change(document.querySelector('.file-input-hidden') as HTMLInputElement, { target: { files: [file] } });
const pdf = (name = 'q3.pdf', bytes = 4) => new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });

describe('a refused send uploads nothing and keeps the staged file', () => {
  it('a mention error stops the send before the upload, and the file stays staged', async () => {
    render(<MessageInput />);
    attach(pdf());
    type('@all @Alice look at this');
    enter();
    await waitFor(() => expect(screen.getByText(/all/i, { selector: '.message-input-error span' })).toBeTruthy());
    expect(uploadFile).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(document.querySelector('.file-preview-name')?.textContent).toBe('q3.pdf');
  });

  it('a draft that reads as private but would not be sent privately uploads nothing, and the file stays staged', async () => {
    render(<MessageInput />);
    attach(pdf());
    type('.Ryan McHarg the numbers');
    enter();
    await waitFor(() => expect(document.querySelector('.message-input-error')?.textContent).toContain('message.sendWouldNotBePrivate'));
    expect(uploadFile).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(document.querySelector('.file-preview-name')?.textContent).toBe('q3.pdf');
  });

  it('a send that fails after the upload keeps the file and the words', async () => {
    sendMessage.mockRejectedValueOnce(new Error('AccessDenied'));
    render(<MessageInput />);
    attach(pdf());
    type('see attached');
    enter();
    await waitFor(() => expect(document.querySelector('.message-input-error')?.textContent).toContain('AccessDenied'));
    expect(textarea().value).toBe('see attached');
    expect(document.querySelector('.file-preview-name')?.textContent).toBe('q3.pdf');
  });

  it('a sent message lets the file go', async () => {
    render(<MessageInput />);
    attach(pdf());
    type('see attached');
    enter();
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][1]).toMatchObject({ name: 'q3.pdf' });
    await waitFor(() => expect(document.querySelector('.file-preview-name')).toBeNull());
  });
});

describe('the sticky reply prefix is the member by id', () => {
  it('two members named Sam: the one carried forward is the one addressed', async () => {
    state.stickyTarget = { userArn: SAM_2, name: 'Sam', isBot: false };
    render(<MessageInput />);
    type('hi');
    enter();
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0]).toBe('@<Sam|sam-2> hi');
    expect(sendMessage.mock.calls[0][2]).toMatchObject({ mentionArns: [SAM_2] });
  });

  it('`all` stays a word', async () => {
    state.stickyTarget = { userArn: 'EVERYONE', name: 'all', isBot: false, isAll: true };
    render(<MessageInput />);
    type('hi');
    enter();
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0]).toBe('@all hi');
  });
});

describe('the roster keeps the front of the message meaning what it means', () => {
  it('Message privately goes after /md, and leaves a leading .env alone', async () => {
    render(<MessageInput />);
    type('/md **numbers**');
    act(() => { requestComposerAddress({ member: MEMBERS[1], mode: 'private' }); });
    expect(textarea().value).toBe('/md .Alice **numbers**');
    type('');
    type('.env is missing');
    act(() => { requestComposerAddress({ member: MEMBERS[1], mode: 'private' }); });
    expect(textarea().value).toBe('.Alice .env is missing');
    enter();
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0]).toBe('.<Alice|alice-id> .env is missing');
    expect(sendMessage.mock.calls[0][2]).toMatchObject({ targetArn: ALICE });
  });

  it('a mention requested with the caret at the front lands after the private address', async () => {
    render(<MessageInput />);
    act(() => { requestComposerAddress({ member: MEMBERS[1], mode: 'private' }); });
    textarea().setSelectionRange(0, 0);
    act(() => { requestComposerAddress({ member: MEMBERS[0], mode: 'mention' }); });
    expect(textarea().value).toBe('.Alice @Advisor ');
  });
});

describe('an @ inside code opens no picker', () => {
  it('in an inline code span still being typed', () => {
    render(<MessageInput />);
    type('run `git blame @Al');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    type('ask @Al');
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  });
});

describe('the draft is kept on this device', () => {
  it('is restored with its picked members, by id, when the conversation opens again', async () => {
    const first = render(<MessageInput />);
    type('ping');
    textarea().setSelectionRange(4, 4);
    act(() => { requestComposerAddress({ member: MEMBERS[1], mode: 'mention' }); });
    first.unmount();

    render(<MessageInput />);
    expect(textarea().value).toBe('ping @Alice ');
    enter();
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0]).toBe('ping @<Alice|alice-id>');
  });

  it('is kept a moment after each change, without leaving the conversation', async () => {
    render(<MessageInput />);
    type('half a thought');
    await waitFor(() => expect(localStorage.getItem('ae.composer.v1.draft.self-id.c1')).toContain('half a thought'), { timeout: 2000 });
  });

  it('belongs to its conversation: another conversation opens on its own draft', () => {
    const view = render(<MessageInput />);
    type('for c1');
    state.conversationId = 'c2';
    view.rerender(<MessageInput />);
    expect(textarea().value).toBe('');
    state.conversationId = 'c1';
    view.rerender(<MessageInput />);
    expect(textarea().value).toBe('for c1');
  });

  it('belongs to its person: another person on this browser never sees it', () => {
    const first = render(<MessageInput />);
    type('mine alone');
    first.unmount();
    state.viewer = OTHER_PERSON;
    render(<MessageInput />);
    expect(textarea().value).toBe('');
  });

  it('is forgotten once sent', async () => {
    const first = render(<MessageInput />);
    type('sent soon');
    enter();
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    await waitFor(() => expect(textarea().value).toBe(''));
    first.unmount();
    render(<MessageInput />);
    expect(textarea().value).toBe('');
  });

  it('is gone when the session ends, including a write the leaving composer makes after it', async () => {
    const first = render(<MessageInput />);
    type('before sign-out');
    attach(pdf());
    await waitFor(() => expect(blobs.size()).toBe(1));
    await act(async () => { endSessionEpoch('signed-out'); });
    first.unmount();
    expect(localStorage.getItem('ae.composer.v1.draft.self-id.c1')).toBeNull();
    expect(blobs.size()).toBe(0);
    render(<MessageInput />);
    expect(textarea().value).toBe('');
  });

  it('a staged file within the cap comes back with the draft', async () => {
    const first = render(<MessageInput />);
    type('see attached');
    attach(pdf('plan.pdf'));
    await waitFor(() => expect(blobs.size()).toBe(1));
    first.unmount();
    render(<MessageInput />);
    await waitFor(() => expect(document.querySelector('.file-preview-name')?.textContent).toBe('plan.pdf'));
    expect(textarea().value).toBe('see attached');
  });

  it('a staged file above the cap keeps its name, and the person is asked to attach it again', async () => {
    const first = render(<MessageInput />);
    type('the big one');
    attach(pdf('huge.pdf', STAGED_FILE_CAP_BYTES + 1));
    first.unmount();
    expect(blobs.size()).toBe(0);
    render(<MessageInput />);
    await waitFor(() => expect(document.querySelector('.message-input-reattach')).not.toBeNull());
    expect(document.querySelector('.message-input-reattach')?.textContent).toContain('conversation.reattachFile');
    expect(document.querySelector('.file-preview-name')).toBeNull();
    // Sending without it lets the name go.
    fireEvent.click(screen.getByText('conversation.sendWithoutFile'));
    expect(document.querySelector('.message-input-reattach')).toBeNull();
  });
});

describe('offline', () => {
  it('a message alone is handed over and the field clears; the provider holds it', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    sendMessage.mockResolvedValue({ queued: true });
    render(<MessageInput />);
    type('when you can');
    enter();
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith('when you can', undefined, undefined, expect.objectContaining({ id: 'c1' })));
    await waitFor(() => expect(textarea().value).toBe(''));
  });

  it('a message with a file stays in the field with its file, and nothing is uploaded', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(<MessageInput />);
    attach(pdf());
    type('see attached');
    enter();
    await waitFor(() => expect(document.querySelector('.message-input-error')?.textContent).toContain('conversation.offlineFileKept'));
    expect(uploadFile).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(textarea().value).toBe('see attached');
    expect(document.querySelector('.file-preview-name')?.textContent).toBe('q3.pdf');
  });

  it('messages waiting to send are listed by name, and one refused can be retried or discarded', () => {
    state.queuedMessages = [
      { id: 'q1', conversationId: 'c1', channelArn: CHANNEL, content: 'ping @<Alice|alice-id>', createdAt: 1 },
      { id: 'q2', conversationId: 'c1', channelArn: CHANNEL, content: 'second', createdAt: 2, failed: 'AccessDenied' },
    ];
    render(<MessageInput />);
    const items = document.querySelectorAll('.message-input-queued-item');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('ping @Alice');
    expect(items[0].textContent).not.toContain('alice-id');
    // Online, a message waiting is said to go again in a moment, never to wait for a connection the person has.
    expect(items[0].textContent).toContain('conversation.queuedRetrying');
    expect(items[1].textContent).toContain('conversation.queuedNotSent');
    fireEvent.click(screen.getByText('conversation.queuedRetry'));
    expect(retryQueuedMessage).toHaveBeenCalledWith('q2');
    fireEvent.click(screen.getAllByText('conversation.queuedDiscard')[0]);
    expect(discardQueuedMessage).toHaveBeenCalledWith('q1');
  });
});

describe('a send belongs to the conversation it was written in', () => {
  it("a switch during the upload sends to the first conversation and leaves the second conversation's draft alone", async () => {
    let finishUpload!: () => void;
    uploadFile.mockImplementation((f: File) => new Promise((r) => { finishUpload = () => r({ fileKey: 'k', name: f.name, size: f.size, type: f.type }); }));
    localStorage.setItem('ae.composer.v1.draft.self-id.c2', JSON.stringify({ draft: { text: 'for c2', mentions: [] } }));
    const view = render(<MessageInput />);
    attach(pdf());
    type('for c1');
    enter();
    await waitFor(() => expect(uploadFile).toHaveBeenCalled());
    state.conversationId = 'c2';
    view.rerender(<MessageInput />);
    await waitFor(() => expect(textarea().value).toBe('for c2'));
    await act(async () => { finishUpload(); });
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0]).toBe('for c1');
    expect(sendMessage.mock.calls[0][3]).toEqual({ id: 'c1', conversationArn: CHANNEL });
    expect(textarea().value).toBe('for c2');
    expect(JSON.parse(localStorage.getItem('ae.composer.v1.draft.self-id.c2')!).draft.text).toBe('for c2');
    expect(localStorage.getItem('ae.composer.v1.draft.self-id.c1')).toBeNull();
  });

  it('the draft record goes when the message enters the outbox, so a reload during the send never offers it again', async () => {
    let finishSend!: () => void;
    sendMessage.mockImplementation(() => new Promise((r) => { finishSend = () => r({ queued: false }); }));
    render(<MessageInput />);
    type('only once');
    await new Promise((r) => setTimeout(r, 350));
    expect(localStorage.getItem('ae.composer.v1.draft.self-id.c1')).not.toBeNull();
    enter();
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(localStorage.getItem('ae.composer.v1.draft.self-id.c1')).toBeNull();
    await act(async () => { finishSend(); });
  });
});

describe('a sent message forgets the file the restored draft named', () => {
  it('the "attach again" notice does not outlive the send', async () => {
    localStorage.setItem('ae.composer.v1.draft.self-id.c1', JSON.stringify({
      draft: { text: 'notes', mentions: [] }, file: { name: 'big.pdf', size: STAGED_FILE_CAP_BYTES + 1, type: 'application/pdf', kept: false },
    }));
    render(<MessageInput />);
    await waitFor(() => expect(document.querySelector('.message-input-reattach')).not.toBeNull());
    enter();
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    await waitFor(() => expect(document.querySelector('.message-input-reattach')).toBeNull());
    await new Promise((r) => setTimeout(r, 350));
    expect(localStorage.getItem('ae.composer.v1.draft.self-id.c1')).toBeNull();
  });
});

describe('the file picker', () => {
  it('is emptied after each pick, so the same file picked again is heard', () => {
    render(<MessageInput />);
    const input = document.querySelector('.file-input-hidden') as HTMLInputElement;
    const file = pdf();
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    Object.defineProperty(input, 'value', { configurable: true, writable: true, value: 'C:\fakepath\q3.pdf' });
    fireEvent.change(input);
    expect(input.value).toBe('');
  });
});

describe('an input method composing', () => {
  it('keeps the Enter that confirms a conversion: nothing is sent', () => {
    render(<MessageInput />);
    type('にほんご');
    fireEvent.keyDown(textarea(), { key: 'Enter', code: 'Enter', isComposing: true });
    fireEvent.keyDown(textarea(), { key: 'Enter', code: 'Enter', keyCode: 229 });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('a private send to a member who shares a name', () => {
  it('picked from the list, the second Sam is sent to and not refused', async () => {
    render(<MessageInput />);
    act(() => { requestComposerAddress({ member: MEMBERS[4], mode: 'private' }); });
    type(`${textarea().value}hi`);
    enter();
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(sendMessage.mock.calls[0][0]).toBe('.<Sam|sam-2> hi');
    expect(sendMessage.mock.calls[0][2]).toMatchObject({ targetArn: SAM_2 });
  });
});
