/**
 * MessageInput - saying so when the assistant here cannot read the file being attached.
 *
 * MEASURED BROKEN 2026-09-12, on a live deployment. A basic-profile conversation offered the
 * paperclip like any other. The file uploaded, staged, sent, and the assistant answered - fluently,
 * from the caption, having read nothing, because its Lambda had no `ATTACHMENTS_BUCKET` and no
 * `s3:GetObject` on the attachments prefix. No error surfaced, and the one branch that could have
 * logged it covered a different failure, so there was not even a log line. The person was told
 * nothing and the answer sounded right.
 *
 * ── WHY A NOTICE AND NOT A REMOVED CONTROL ───────────────────────────────────────────────────────
 *
 * Hiding the paperclip closes the silent failure by deleting a working feature: a person sending a
 * COLLEAGUE a file needs no assistant to read it, that path works on every profile, and it has its
 * own e2e. The composer also cannot know at staging time whether the finished message will address a
 * colleague or the assistant - so it must not decide for them. It tells them instead.
 *
 * ── AND THE ANSWER COMES FROM THE DEPLOYMENT ─────────────────────────────────────────────────────
 *
 * `attachmentsReadable` is the same profile flag that decides whether the turn's IAM role carries
 * the read grant. The client does not decide from the tier name it holds - that is channel Metadata,
 * which members can write, and a rule keyed on it would be a capability decision living in one
 * client for a boundary IAM enforces.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

const ARN = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const SELF = 'arn:aws:chime:us-east-1:111:app-instance/i/user/self';
const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/assistant-basic';

const getBattleConfig = vi.fn();

vi.mock('../providers/ConversationProvider.chime', () => ({
  useConversations: () => ({
    activeConversation: { conversationArn: ARN, modelTier: 'basic' },
    sendMessage: vi.fn(),
    isSending: false,
    sendError: null,
    clearSendError: () => {},
    channelMembers: [
      { userArn: BOT, name: 'Assistant-basic', isBot: true },
      { userArn: SELF, name: 'Me', isBot: false },
    ],
    stickyTarget: null,
    setStickyTarget: () => {},
    battleWaitingBots: [],
    openWorkItems: [],
    refreshOpenWorkItems: () => {},
  }),
}));
// The sender is the ARN the messaging client acts as, never a field of the signed-in user.
vi.mock('../providers/AwsClientProvider', () => ({
  useAwsClient: () => ({ userArn: SELF, isInitialized: true, error: null }),
}));
vi.mock('@ae/shared', () => ({
  useAuth: () => ({ user: { id: 'self', isAdmin: false } }),
  trackEvent: () => {},
}));
vi.mock('../services/attachmentService', () => ({ uploadFile: vi.fn() }));
vi.mock('../services/messageLatencyTracker', () => ({ markMessageSent: () => {} }));
vi.mock('../services/channelBattleService', () => ({
  getBattleConfig: (...a: unknown[]) => getBattleConfig(...a),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k }),
}));

import MessageInput from './MessageInput';

const NOTICE = '.message-input-attachment-notice';
const notice = () => document.querySelector(NOTICE);

/** Stage a file the way the picker does. */
const stage = () => {
  const input = document.querySelector('.file-input-hidden') as HTMLInputElement;
  const file = new File(['brief'], 'brief.txt', { type: 'text/plain' });
  fireEvent.change(input, { target: { files: [file] } });
};

beforeEach(() => {
  getBattleConfig.mockReset();
});

describe('MessageInput - attaching a file the assistant cannot read', () => {
  it('says so once a file is staged, when the profile cannot read attachments', async () => {
    getBattleConfig.mockResolvedValue({ channelArn: ARN, enabled: false, attachmentsReadable: false });
    render(<MessageInput />);
    // The capability is fetched per conversation; wait for it rather than assuming a resolved promise
    // has already flushed.
    await waitFor(() => expect(getBattleConfig).toHaveBeenCalledWith(ARN));

    // NOTHING BEFORE A FILE EXISTS. A standing warning on an empty composer would be noise in every
    // conversation on the profile, and would be telling people about a decision they have not made.
    expect(notice()).toBeNull();

    stage();
    await waitFor(() => expect(notice()).not.toBeNull());
  });

  it('stays silent where the assistant CAN read attachments', async () => {
    getBattleConfig.mockResolvedValue({ channelArn: ARN, enabled: false, attachmentsReadable: true });
    render(<MessageInput />);
    await waitFor(() => expect(getBattleConfig).toHaveBeenCalledWith(ARN));

    stage();
    // The file stages either way - this is a notice, never a gate.
    await waitFor(() => expect(document.querySelector('.file-upload-preview, .file-preview')).not.toBeNull());
    expect(notice()).toBeNull();
  });

  it('still lets the file be staged, because sending a colleague a file needs no assistant', async () => {
    // THE REGRESSION THIS TEST EXISTS TO PREVENT. The obvious fix for the defect above is to hide the
    // paperclip, which would remove person-to-person file sending from every conversation on the
    // profile - trading an invisible wrong answer for a visible missing capability.
    getBattleConfig.mockResolvedValue({ channelArn: ARN, enabled: false, attachmentsReadable: false });
    render(<MessageInput />);
    await waitFor(() => expect(getBattleConfig).toHaveBeenCalledWith(ARN));

    stage();
    await waitFor(() => expect(notice()).not.toBeNull());
    expect(document.querySelector('.file-upload-preview, .file-preview')).not.toBeNull();
  });

  it('says nothing while the capability is still in flight', async () => {
    // THE WINDOW EVERY OTHER TEST IN THIS FILE AWAITS PAST. The notice is a statement of fact about
    // the assistant, and before the config lands there is no fact - so a person who picks a file in
    // the first moments of a PREMIUM conversation must not be told their assistant cannot read it.
    //
    // Held open deliberately rather than raced: a promise that never settles is the in-flight state,
    // exactly and without a timing assumption.
    getBattleConfig.mockReturnValue(new Promise(() => {}));
    render(<MessageInput />);
    await waitFor(() => expect(getBattleConfig).toHaveBeenCalledWith(ARN));

    stage();
    // The file stages - the notice is never a gate - and no claim is made about it.
    await waitFor(() => expect(document.querySelector('.file-upload-preview, .file-preview')).not.toBeNull());
    expect(notice()).toBeNull();
  });

  it('fails closed when the capability cannot be read at all', async () => {
    // An unreadable capability is not evidence of one. Warning on a conversation that could in fact
    // read the file costs a sentence somebody ignores; staying silent on one that cannot is the
    // original defect.
    getBattleConfig.mockRejectedValue(new Error('network'));
    render(<MessageInput />);
    await waitFor(() => expect(getBattleConfig).toHaveBeenCalledWith(ARN));

    stage();
    await waitFor(() => expect(notice()).not.toBeNull());
  });

  it('treats an ABSENT field as cannot-read, so an older backend does not read as permission', async () => {
    getBattleConfig.mockResolvedValue({ channelArn: ARN, enabled: false });
    render(<MessageInput />);
    await waitFor(() => expect(getBattleConfig).toHaveBeenCalledWith(ARN));

    stage();
    await waitFor(() => expect(notice()).not.toBeNull());
  });
});
