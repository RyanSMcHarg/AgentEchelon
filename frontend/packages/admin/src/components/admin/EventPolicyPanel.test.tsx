import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import EventPolicyPanel from './EventPolicyPanel';

const svc = vi.hoisted(() => ({ readEventPolicy: vi.fn(), saveEventPolicy: vi.fn() }));
vi.mock('../../services/eventTriggerService', () => svc);
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

describe('the deployment\'s event policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.readEventPolicy.mockResolvedValue({ enabled: true, maxTriggers: 20 });
  });

  it('shows the policy as it is stored', async () => {
    render(<EventPolicyPanel />);
    await waitFor(() => expect((screen.getByTestId('event-policy-text') as HTMLTextAreaElement).value).toContain('"maxTriggers": 20'));
  });

  it('saves it whole, and switching it off is one edit', async () => {
    svc.saveEventPolicy.mockImplementation(async (p: unknown) => p);
    render(<EventPolicyPanel />);
    await waitFor(() => expect((screen.getByTestId('event-policy-text') as HTMLTextAreaElement).value).toBeTruthy());
    fireEvent.change(screen.getByTestId('event-policy-text'), { target: { value: '{"enabled": false, "maxTriggers": 20}' } });
    fireEvent.click(screen.getByTestId('event-policy-save'));
    await waitFor(() => expect(svc.saveEventPolicy).toHaveBeenCalledWith({ enabled: false, maxTriggers: 20 }));
    expect(await screen.findByTestId('event-policy-saved')).toBeTruthy();
  });

  it('says why the server refused it', async () => {
    svc.saveEventPolicy.mockRejectedValue(new Error('maxTriggers is a whole number from 0 to 250'));
    render(<EventPolicyPanel />);
    await waitFor(() => expect((screen.getByTestId('event-policy-text') as HTMLTextAreaElement).value).toBeTruthy());
    fireEvent.click(screen.getByTestId('event-policy-save'));
    expect((await screen.findByTestId('event-policy-error')).textContent).toContain('from 0 to 250');
  });
});
