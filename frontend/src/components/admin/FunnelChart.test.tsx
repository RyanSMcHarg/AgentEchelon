import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import FunnelChart, { type FunnelStep } from './FunnelChart';

const baseSteps: FunnelStep[] = [
  { id: 'signup_form_viewed', label: 'Form viewed', eventCount: 200, sessionCount: 100 },
  { id: 'signup_submitted', label: 'Submitted', eventCount: 80, sessionCount: 75 },
  { id: 'signup_confirmation_required', label: 'Verify email', eventCount: 70, sessionCount: 70 },
  { id: 'signup_confirmation_completed', label: 'Confirmed', eventCount: 50, sessionCount: 50 },
  { id: 'signup_failed', label: 'Failed', eventCount: 5, sessionCount: 5 },
];

describe('FunnelChart', () => {
  it('renders each step in the canonical order it was given', () => {
    render(<FunnelChart steps={baseSteps} successStepId="signup_confirmation_completed" failureStepId="signup_failed" />);
    const labels = screen.getAllByText(/Form viewed|Submitted|Verify email|Confirmed/);
    expect(labels.map((el) => el.textContent)).toEqual([
      'Form viewed',
      'Submitted',
      'Verify email',
      'Confirmed',
    ]);
  });

  it('peels the failure step out of the main funnel row', () => {
    render(<FunnelChart steps={baseSteps} successStepId="signup_confirmation_completed" failureStepId="signup_failed" />);
    // The failure label exists in its own peel-off region.
    const failureLabel = screen.getByText('Failed');
    expect(failureLabel.closest('.funnel-chart-failure')).not.toBeNull();
  });

  it('marks the success step with the success class', () => {
    const { container } = render(
      <FunnelChart steps={baseSteps} successStepId="signup_confirmation_completed" failureStepId="signup_failed" />
    );
    const successStep = container.querySelector('.funnel-chart-step--success');
    expect(successStep).not.toBeNull();
    expect(successStep?.textContent).toContain('Confirmed');
  });

  it('shows session_count as the primary tile value', () => {
    render(<FunnelChart steps={baseSteps.slice(0, 2)} />);
    // Form viewed → 100 sessions (visible). Submitted → 75 sessions (visible).
    expect(screen.getByText('100')).toBeTruthy();
    expect(screen.getByText('75')).toBeTruthy();
  });

  it('renders empty-state when no steps are passed', () => {
    render(<FunnelChart steps={[]} />);
    expect(screen.getByText(/No events recorded/i)).toBeTruthy();
  });

  it('renders loading placeholder when isLoading=true', () => {
    const { container } = render(<FunnelChart steps={baseSteps} isLoading />);
    expect(container.querySelector('.funnel-chart--loading')).not.toBeNull();
  });

  it('drops the failure step from inter-step % math (denominator stays clean)', () => {
    // If the failure step were in the funnel, the chevron between Confirmed
    // and Failed would print a tiny conversion %. With the peel-off, the
    // last chevron is between Verify email (70) and Confirmed (50) = 71%.
    render(<FunnelChart steps={baseSteps} successStepId="signup_confirmation_completed" failureStepId="signup_failed" />);
    // Look for the 71% drop-off between Verify email and Confirmed.
    expect(screen.getByText('71%')).toBeTruthy();
    // 5/50 = 10% would only appear if the failure step were in the funnel.
    expect(screen.queryByText('10%')).toBeNull();
  });
});
