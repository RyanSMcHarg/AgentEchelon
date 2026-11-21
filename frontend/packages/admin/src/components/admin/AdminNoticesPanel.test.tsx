import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdminNoticesPanel from './AdminNoticesPanel';

const svc = vi.hoisted(() => ({ listAdminNotices: vi.fn(), switchAdminNotice: vi.fn() }));
vi.mock('../../services/eventTriggerService', () => svc);
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

describe('the admin notices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.listAdminNotices.mockResolvedValue([
      { key: 'membership-audit', messageType: 'membership_audit_finding', security: true, enabled: true },
      { key: 'alarm', messageType: 'cloudwatch_alarm', security: false, enabled: true },
      { key: 'turn-not-started', messageType: 'turn_not_started', security: false, enabled: null },
    ]);
  });

  it('shows a security notice as always on, with no switch, and says why', async () => {
    render(<AdminNoticesPanel />);
    expect((await screen.findByTestId('admin-notice-membership-audit')).textContent).toContain('admin.adminNotices.alwaysOn');
    expect(screen.queryByTestId('admin-notice-membership-audit-switch')).toBeNull();
    expect(screen.getByTestId('admin-notice-membership-audit-why')).toBeTruthy();
  });

  it('switches an operational notice, and shows the state the server answered', async () => {
    svc.switchAdminNotice.mockResolvedValue({ key: 'alarm', messageType: 'cloudwatch_alarm', security: false, enabled: false });
    render(<AdminNoticesPanel />);
    fireEvent.click(await screen.findByTestId('admin-notice-alarm-switch'));
    await waitFor(() => expect(svc.switchAdminNotice).toHaveBeenCalledWith('alarm', false));
    await waitFor(() => expect(screen.getByTestId('admin-notice-alarm').textContent).toContain('admin.adminNotices.off'));
  });

  it('shows a state that could not be read as unknown, never as on', async () => {
    render(<AdminNoticesPanel />);
    expect((await screen.findByTestId('admin-notice-turn-not-started')).textContent).toContain('admin.adminNotices.unknown');
  });

  it('says why the server refused a switch', async () => {
    svc.switchAdminNotice.mockRejectedValue(new Error('refused'));
    render(<AdminNoticesPanel />);
    fireEvent.click(await screen.findByTestId('admin-notice-alarm-switch'));
    expect((await screen.findByTestId('admin-notices-error')).textContent).toBe('refused');
  });
});
