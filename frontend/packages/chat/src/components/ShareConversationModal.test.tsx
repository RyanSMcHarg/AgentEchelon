/**
 * A SHARE THAT CANNOT ADD ITS RECIPIENT SAYS SO IN THE READER'S LANGUAGE, AND NAMES NOTHING ABOUT THEM.
 *
 * The share API answers every recipient who cannot be added with one code, `RECIPIENT_NOT_ADDABLE`: nobody at
 * the address, a person not cleared for the conversation, and a person whose issuer the conversation does not
 * admit. The modal shows its own localized sentence for that code rather than the server's English.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const shareConversation = vi.fn();
vi.mock('../providers/ConversationProvider.chime', () => ({
  useConversations: () => ({ shareConversation, activeConversation: null }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('./InvitePanel', () => ({ default: () => null }));

import ShareConversationModal from './ShareConversationModal';

async function shareWith(address: string) {
  render(<ShareConversationModal isOpen onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText('share.emailLabel'), { target: { value: address } });
  fireEvent.click(screen.getByText('share.shareButton'));
}

describe('the share modal', () => {
  it('shows its own sentence for a recipient who cannot be added, never the server\'s text', async () => {
    shareConversation.mockRejectedValueOnce(Object.assign(new Error('That address cannot be added to this conversation'), { code: 'RECIPIENT_NOT_ADDABLE' }));
    await shareWith('someone@example.com');
    await waitFor(() => expect(document.querySelector('.alert-error')).toHaveTextContent('share.recipientNotAddable'));
    expect(document.querySelector('.alert-error')).not.toHaveTextContent('That address cannot be added');
  });
});
