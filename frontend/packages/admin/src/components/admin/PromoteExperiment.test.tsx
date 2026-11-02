/**
 * THE PROMOTE ACTION (DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP §3.6).
 *
 * Promotion activates a version of the live assistant, so the button is offered only where the server would
 * accept it (an experiment that pinned two versions, running or paused, to a role holding `activate-profiles`),
 * and a refusal the server answers - the live version moved, the copy does not hash to what was measured -
 * is shown as given rather than as a success.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { Experiment } from '@ae/shared';
import PromoteExperiment, { promotable } from './PromoteExperiment';
import { controlIsLiveVersion } from './experimentControl';
import { promoteExperiment } from '../../services/experimentsService';

vi.mock('../../services/experimentsService', () => ({ promoteExperiment: vi.fn() }));
const mockPromote = vi.mocked(promoteExperiment);

const armed = (over: Partial<Experiment> = {}): Experiment => ({
  experimentId: 'exp-1', status: 'active', experimentType: 'base_model', intent: '', tiers: ['premium'],
  startDate: '2026-10-01', createdAt: '2026-10-01', servesVersions: true,
  variants: [
    { variantId: 'control', weight: 50, controlPin: { profileName: 'advisor', version: 3 } },
    { variantId: 'treatment', modelKey: 'sonnet', weight: 50, altPin: { profileName: 'alt-primary-premium', version: 4 } },
  ],
  ...over,
});
const allowed = (cap: string) => cap === 'activate-profiles';

beforeEach(() => { mockPromote.mockReset(); });

describe('promotable', () => {
  it('is offered for a running or paused experiment that pinned two versions, to a role that may activate profiles', () => {
    expect(promotable(armed(), allowed)).toBe(true);
    expect(promotable(armed({ status: 'paused' }), allowed)).toBe(true);
  });

  it('is not offered without the capability, before versions were pinned, or once the experiment ended', () => {
    expect(promotable(armed(), (cap) => cap === 'manage-experiments')).toBe(false);
    expect(promotable(armed({ servesVersions: undefined }), allowed)).toBe(false);
    expect(promotable(armed({ status: 'completed' }), allowed)).toBe(false);
  });
});

describe('the Promote button', () => {
  it('confirms, sends the note, says what now serves, and asks the list to re-read', async () => {
    mockPromote.mockResolvedValue({ promotion: { profileName: 'advisor', version: 5, configId: 'cfg' } });
    const onPromoted = vi.fn();
    render(<PromoteExperiment exp={armed()} can={allowed} onPromoted={onPromoted} />);
    fireEvent.click(screen.getByRole('button', { name: 'Promote' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ship it' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Promote' }));
    await waitFor(() => expect(onPromoted).toHaveBeenCalled());
    expect(mockPromote).toHaveBeenCalledWith('exp-1', 'ship it');
    expect(screen.getByRole('status').textContent).toContain('advisor now serves version 5');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows a refusal as a refusal, and does not report the experiment promoted', async () => {
    mockPromote.mockImplementation(async () => { throw new Error("'advisor' now serves version 6, not the control version 3"); });
    const onPromoted = vi.fn();
    render(<PromoteExperiment exp={armed()} can={allowed} onPromoted={onPromoted} />);
    fireEvent.click(screen.getByRole('button', { name: 'Promote' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Promote' }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(screen.getAllByRole('alert')[0].textContent).toContain('Not promoted: ');
    expect(onPromoted).not.toHaveBeenCalled();
  });

  it('renders nothing where promotion is not offered', () => {
    const { container } = render(<PromoteExperiment exp={armed({ servesVersions: undefined })} can={allowed} onPromoted={() => {}} />);
    expect(container.textContent).toBe('');
  });
});

describe('the create form names no model for a control that is the live version', () => {
  it('intent and base-model controls are the live version; profile and classification controls are named', () => {
    expect(controlIsLiveVersion('intent')).toBe(true);
    expect(controlIsLiveVersion('base_model')).toBe(true);
    expect(controlIsLiveVersion('profile')).toBe(false);
    expect(controlIsLiveVersion('classification')).toBe(false);
  });
});
