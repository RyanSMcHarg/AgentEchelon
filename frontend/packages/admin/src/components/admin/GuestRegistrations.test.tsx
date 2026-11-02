/**
 * The registrations waiting for an operator (B6, P-12): what each visitor registered and where the link goes,
 * Approve, which emails it, a refused approval said with its code, and a deployment that sends each link
 * straight away (its listing route is not served) said as such rather than shown as an empty queue.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@ae/shared';
import '@ae/shared/i18n';
import GuestRegistrations, { type RegistrationsApi } from './GuestRegistrations';

const ID = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
const waiting = { registrationId: ID, fields: { name: 'Ada', company: 'Example Co' }, deliverTo: 'ada@example.com', createdAt: '2026-10-19T10:00:00Z' };

describe('the registrations waiting for approval', () => {
  it('lists what each visitor registered, and approving one emails its link and refreshes the list', async () => {
    const list = vi.fn().mockResolvedValueOnce({ registrations: [waiting] }).mockResolvedValueOnce({ registrations: [] });
    const approve = vi.fn(async () => ({ status: 'sent' }));
    render(<GuestRegistrations api={{ list, approve } as RegistrationsApi} />);
    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Example Co')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(approve).toHaveBeenCalledWith(ID);
    expect(await screen.findByRole('status')).toHaveTextContent('Approved: the sign-in link was emailed.');
    expect(await screen.findByText('No registration is waiting.')).toBeInTheDocument();
  });

  it('says a refused approval with its code', async () => {
    const approve = vi.fn(async () => { throw new ApiError(503, 'unsent', { code: 'CLAIM_EMAIL_UNSENT' }); });
    render(<GuestRegistrations api={{ list: async () => ({ registrations: [waiting] }), approve }} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('status')).toHaveTextContent('The registration could not be approved (CLAIM_EMAIL_UNSENT).');
  });

  it('says a deployment sends each link straight away when the listing is not served, and when it cannot be read', async () => {
    const { unmount } = render(<GuestRegistrations api={{ list: async () => { throw new ApiError(404, 'Not Found'); }, approve: vi.fn() }} />);
    expect(await screen.findByText("This deployment sends each registration's sign-in link as soon as the visitor registers.")).toBeInTheDocument();
    unmount();
    render(<GuestRegistrations api={{ list: async () => { throw new ApiError(500, 'boom'); }, approve: vi.fn() }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The registrations could not be read.');
  });
});
