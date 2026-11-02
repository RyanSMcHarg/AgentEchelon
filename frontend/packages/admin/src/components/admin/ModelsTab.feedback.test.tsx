/**
 * A FEEDBACK READ THAT FAILS IS SAID, NOT SHOWN AS AN EMPTY TABLE.
 *
 * The Models tab caught every failure of the feedback summary and rendered its table empty, with the
 * copy "No user feedback submitted yet." - so a refused read looked exactly like a deployment nobody had
 * voted in. These pin the four states apart: a read still in flight, rows, a stated failure, and a
 * console the summary is not shown to.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ModelsTab from './ModelsTab';
import { fetchFeedbackSummary } from '../../services/feedbackSummaryService';

vi.mock('../../services/feedbackSummaryService', () => ({ fetchFeedbackSummary: vi.fn() }));

const renderTab = () => render(<ModelsTab data={null} effectivenessData={null} isLoading={false} />);


describe('the Models tab feedback summary', () => {
  it('says it is loading, not that nobody voted, while the read is in flight', () => {
    vi.mocked(fetchFeedbackSummary).mockImplementation(() => new Promise(() => {}));
    renderTab();
    expect(screen.getByText(/Loading user feedback|admin\.models\.loadingFeedback/)).toBeTruthy();
    expect(screen.queryByText(/No user feedback submitted yet|admin\.models\.noUserFeedbackSubmittedYet/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the summary rows it read', async () => {
    vi.mocked(fetchFeedbackSummary).mockResolvedValue({
      data: [{ model_name: 'model-a', intent: 'billing', thumbs_up: 3, thumbs_down: 1, feedback_count: 4, approval_rate: 75 }],
    });
    renderTab();
    await waitFor(() => expect(screen.getByText('billing')).toBeTruthy());
    expect(screen.getByText('75.0%')).toBeTruthy();
    expect(vi.mocked(fetchFeedbackSummary)).toHaveBeenCalledWith(30);
  });

  it('says the read failed, with the refusal text, instead of an empty table', async () => {
    const refusal = 'Your role does not hold view-analytics, so this was refused.';
    vi.mocked(fetchFeedbackSummary).mockImplementation(async () => { throw new Error(refusal); });
    renderTab();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(refusal);
    expect(alert.textContent).toMatch(/not shown, rather than shown empty|admin\.models\.feedbackNotShownOnFailure/);
    expect(screen.queryByText(/No user feedback submitted yet|admin\.models\.noUserFeedbackSubmittedYet/)).toBeNull();
  });

  it('still says it failed when the error carries no message', async () => {
    vi.mocked(fetchFeedbackSummary).mockImplementation(async () => { throw new Error(''); });
    renderTab();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Could not read the user feedback summary|admin\.models\.couldNotReadFeedback/);
  });

  it('explains why a console that is not shown the summary sees no table', async () => {
    vi.mocked(fetchFeedbackSummary).mockResolvedValue({ data: [], unsupported: true, reason: 'Not attributed per assistant.' });
    renderTab();
    await waitFor(() => expect(screen.getByText('Not attributed per assistant.')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/No user feedback submitted yet|admin\.models\.noUserFeedbackSubmittedYet/)).toBeNull();
  });
});
