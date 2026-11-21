/**
 * The task card (ADR-063 decision 2): a person answers a task a workflow assigned them by pressing one of the choices its
 * step declares. The press is sent with the state the card was drawn in; a refusal the server named is said in the
 * client's own words and, where the task can no longer be answered, leaves no buttons behind (tenet D11).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@ae/shared/i18n';
import { TaskCard } from './TaskCard';
import { TaskCardError, taskCardFromMetadata } from '../services/taskCardService';

const NOW = 1_800_000_000_000;
const CH = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c';
const approval = { id: 'evt-1', state: 'deciding', choices: ['approved', 'declined'], expiresAt: NOW / 1000 + 3600 };

describe('the task card', () => {
  it('offers the step\'s choices and sends the one pressed, with the state it was drawn in', async () => {
    const user = userEvent.setup();
    const choose = vi.fn().mockResolvedValue({ state: 'approved' });
    render(<TaskCard card={approval} channelArn={CH} choose={choose} now={() => NOW} />);
    expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(choose).toHaveBeenCalledWith(CH, approval, 'approved');
    expect(await screen.findByRole('status')).toHaveTextContent('Done: Approve.');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('says once the task took the answer, so the open items are read again at once', async () => {
    const user = userEvent.setup();
    const onAnswered = vi.fn();
    render(<TaskCard card={approval} channelArn={CH} onAnswered={onAnswered} choose={vi.fn().mockResolvedValue({ state: 'approved' })} now={() => NOW} />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByRole('status');
    expect(onAnswered).toHaveBeenCalledTimes(1);
  });

  it('names the incident\'s customer impact and customer messaging choices in words, and sends the state each records', async () => {
    const user = userEvent.setup();
    const impact = { id: 'evt-triage', state: 'asking', choices: ['impacted', 'not_impacted'], expiresAt: NOW / 1000 + 3600 };
    const choose = vi.fn().mockResolvedValue({ state: 'impacted' });
    render(<TaskCard card={impact} channelArn={CH} choose={choose} now={() => NOW} />);
    expect(screen.getByRole('button', { name: 'No customer impact' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Customers impacted' }));
    expect(choose).toHaveBeenCalledWith(CH, impact, 'impacted');
    const updates = { id: 'evt-updates', state: 'open', choices: ['draft_update', 'draft_final'], expiresAt: NOW / 1000 + 3600 };
    render(<TaskCard card={updates} channelArn={CH} choose={vi.fn()} now={() => NOW} />);
    expect(screen.getByRole('button', { name: 'Draft an update' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Draft final notice' })).toBeTruthy();
  });

  it('a press the task took to another state (a confirmation) says to answer the card that follows, never done', async () => {
    const user = userEvent.setup();
    const incident = { id: 'evt-lead', state: 'open', choices: ['resolved'] };
    const choose = vi.fn().mockResolvedValue({ state: 'confirming_resolve' });
    render(<TaskCard card={incident} channelArn={CH} choose={choose} now={() => NOW} />);
    await user.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Answer the card that follows to finish.');
    expect(screen.getByRole('status')).not.toHaveTextContent('Done');
    expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
  });

  it('says a refusal in its own words, and a settled task leaves no buttons', async () => {
    const user = userEvent.setup();
    const choose = vi.fn().mockRejectedValue(new TaskCardError('NOT_ASSIGNEE', 'no'));
    render(<TaskCard card={approval} channelArn={CH} choose={choose} now={() => NOW} />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('status')).toHaveTextContent('This task is not yours to answer.');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('a transient failure keeps the choices so the person can try again', async () => {
    const user = userEvent.setup();
    const choose = vi.fn().mockRejectedValue(new Error('network'));
    render(<TaskCard card={approval} channelArn={CH} choose={choose} now={() => NOW} />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Your answer could not be recorded. Try again.');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it.each([
    ['NOT_CLEARED', 'Your access does not reach this conversation.'],
    ['CLASSIFICATION_UNREADABLE', 'This conversation cannot be acted on until its classification is set.'],
    ['NOT_A_PERSON_SESSION', 'Answer from your own sign-in, not an administrator session.'],
  ])('a conversation access refusal %s is final, in its own words', async (code, text) => {
    const user = userEvent.setup();
    render(<TaskCard card={approval} channelArn={CH} choose={vi.fn().mockRejectedValue(new TaskCardError(code, 'server sentence'))} now={() => NOW} />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('status')).toHaveTextContent(text);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('an access check that could not be answered keeps the choices, and says to try again', async () => {
    const user = userEvent.setup();
    render(<TaskCard card={approval} channelArn={CH} choose={vi.fn().mockRejectedValue(new TaskCardError('UNAVAILABLE', 'server sentence'))} now={() => NOW} />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('status')).toHaveTextContent('The conversation could not be checked just now. Try again.');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it('an ended task offers nothing', () => {
    render(<TaskCard card={{ ...approval, expiresAt: NOW / 1000 - 1 }} channelArn={CH} now={() => NOW} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('This task has ended.');
  });

  it('lifts a card from Metadata and nothing malformed', () => {
    expect(taskCardFromMetadata({ task: approval })).toEqual(approval);
    expect(taskCardFromMetadata({ task: { id: 'x', state: 's', choices: [] } })).toBeUndefined();
    expect(taskCardFromMetadata({ task: 'nope' })).toBeUndefined();
    expect(taskCardFromMetadata({})).toBeUndefined();
  });
});

describe('a form on the card (ADR-067 WT50)', () => {
  it('shows each field, holds the answer choice until a required field is filled, and sends the answers with it', async () => {
    const { render, screen, fireEvent, waitFor } = await import('@testing-library/react');
    const { TaskCard } = await import('./TaskCard');
    const choose = vi.fn().mockResolvedValue({ state: 'answered' });
    const card = { id: 't1', state: 'asked', choices: ['answered', 'declined'], fields: [
      { name: 'reason', type: 'text' as const, required: true }, { name: 'rating', type: 'number' as const }, { name: 'again', type: 'yes-no' as const },
    ] };
    render(<TaskCard card={card} channelArn="arn:ch" choose={choose} />);
    const submit = screen.getByRole('button', { name: /answered/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'too slow' } });
    fireEvent.change(screen.getByLabelText(/rating/i), { target: { value: '4' } });
    fireEvent.click(screen.getByLabelText(/again/i));
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(choose).toHaveBeenCalled());
    expect(choose.mock.calls[0][2]).toBe('answered');
    expect(choose.mock.calls[0][3]).toEqual({ reason: 'too slow', rating: 4, again: true });
  });

  it('declining sends no answers', async () => {
    const { render, screen, fireEvent, waitFor } = await import('@testing-library/react');
    const { TaskCard } = await import('./TaskCard');
    const choose = vi.fn().mockResolvedValue({ state: 'declined' });
    render(<TaskCard card={{ id: 't1', state: 'asked', choices: ['answered', 'declined'], fields: [{ name: 'reason', type: 'text' as const }] }} channelArn="arn:ch" choose={choose} />);
    fireEvent.click(screen.getAllByRole('button').find((b) => /declin/i.test(b.textContent ?? ''))!);
    await waitFor(() => expect(choose).toHaveBeenCalled());
    expect(choose.mock.calls[0].length).toBe(3);
  });

  it('reads the fields from a message\'s Metadata, and nothing malformed', async () => {
    const { taskCardFromMetadata } = await import('../services/taskCardService');
    const card = taskCardFromMetadata({ task: { id: 't1', state: 'asked', choices: ['answered'], fields: [{ name: 'reason', type: 'text', required: true }, { name: 'x', type: 'html' }] } });
    expect(card?.fields).toEqual([{ name: 'reason', type: 'text', required: true }]);
  });
});

// A FINISHED TASK'S CARD STAYS FINISHED AFTER A RELOAD: the conversation draws it closed once its task is no longer among the
// person's open items, so it never offers a choice the task service would refuse.
describe('a card whose task is no longer open', () => {
  it('is drawn finished, with no choices and no answer-by time', () => {
    render(<TaskCard card={approval} channelArn={CH} choose={vi.fn()} now={() => NOW} closed />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('This task is already finished.')).toBeTruthy();
    expect(screen.queryByText(/Answer by/)).toBeNull();
  });
});

// AN APPROVAL NAMES THE VERSION IT APPROVES: the task's own versions, never a file found in the conversation.
describe('a card that approves a document', () => {
  const docCard = { ...approval, documents: true };
  const draft = { fileKey: 'generated-docs/c/document-1.md', name: 'document-1.md', by: 'assistant:advisor' };
  const edited = { fileKey: 'attachments/c/p1/2-notice.md', name: 'notice.md', by: 'p1' };

  it('names the latest version, attaches an edited one, and approves exactly the version it shows', async () => {
    const user = userEvent.setup();
    const read = vi.fn().mockResolvedValue([draft]);
    const attach = vi.fn().mockResolvedValue([draft, edited]);
    const upload = vi.fn().mockResolvedValue({ fileKey: edited.fileKey, name: edited.name });
    const choose = vi.fn().mockResolvedValue({ state: 'approved' });
    render(<TaskCard card={docCard} channelArn={CH} choose={choose} now={() => NOW} documents={{ read, attach, upload }} />);
    expect((await screen.findByTestId('task-card-approves')).textContent).toBe("Approves: document-1.md (the assistant's draft)");
    await user.upload(screen.getByTestId('task-card-attach'), new File(['# Notice'], 'notice.md', { type: 'text/markdown' }));
    expect(upload).toHaveBeenCalled();
    expect(attach).toHaveBeenCalledWith(CH, docCard.id, edited.fileKey, edited.name);
    expect((await screen.findByTestId('task-card-approves')).textContent).toBe('Approves: notice.md (your edited version)');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(choose).toHaveBeenCalledWith(CH, docCard, 'approved', undefined, edited.fileKey);
  });

  it('a card that approves no document shows no versions', () => {
    render(<TaskCard card={approval} channelArn={CH} choose={vi.fn()} now={() => NOW} documents={{ read: vi.fn(), attach: vi.fn(), upload: vi.fn() }} />);
    expect(screen.queryByTestId('task-card-documents')).toBeNull();
  });
});

describe('asking the assistant that drafted it to revise it', () => {
  const docCard = { ...approval, documents: true };
  const draft = { fileKey: 'generated-docs/c/document-1.md', name: 'document-1.md', by: 'assistant:advisor' };
  const revised = { fileKey: 'generated-docs/c/document-2.md', name: 'document-2.md', by: 'assistant:advisor' };

  it('sends the approver\'s instructions, says it was asked, and shows the revision once it arrives', async () => {
    const user = userEvent.setup();
    const read = vi.fn().mockResolvedValueOnce([draft]).mockResolvedValue([draft, revised]);
    const revise = vi.fn().mockResolvedValue([]);
    const { rerender } = render(<TaskCard card={docCard} channelArn={CH} choose={vi.fn()} now={() => NOW} refreshKey={1} documents={{ read, attach: vi.fn(), upload: vi.fn(), revise }} />);
    await screen.findByTestId('task-card-approves');
    await user.type(screen.getByTestId('task-card-revise-instructions'), 'Shorten it.');
    await user.click(screen.getByTestId('task-card-revise'));
    expect(revise).toHaveBeenCalledWith(CH, docCard.id, 'Shorten it.');
    expect(await screen.findByTestId('task-card-revise-asked')).toBeTruthy();
    // The revised file's message arrives in the conversation, and the card reads the versions again.
    rerender(<TaskCard card={docCard} channelArn={CH} choose={vi.fn()} now={() => NOW} refreshKey={2} documents={{ read, attach: vi.fn(), upload: vi.fn(), revise }} />);
    await vi.waitFor(() => expect(screen.getByTestId('task-card-approves').textContent).toBe("Approves: document-2.md (the assistant's draft)"));
    expect(screen.queryByTestId('task-card-revise-asked')).toBeNull();
  });
});

describe('an approval that cannot read its versions', () => {
  it('is not offered, so nobody approves a version they did not see', async () => {
    const read = vi.fn().mockRejectedValue(new Error('unreachable'));
    render(<TaskCard card={{ ...approval, documents: true }} channelArn={CH} choose={vi.fn()} now={() => NOW} documents={{ read, attach: vi.fn(), upload: vi.fn() }} />);
    await vi.waitFor(() => expect(screen.getByText('The versions could not be read just now.')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Decline' })).not.toBeDisabled();
  });
});
