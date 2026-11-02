/**
 * THE OWNING TEAM IS PART OF AN ASSISTANT'S CONFIGURATION (owner decision, 2026-10-23).
 *
 * What it proves: an admin chooses any team or none and saves on the admin route; a team member with one
 * team sees their team and is offered nothing to move it to; a team member with several teams is offered
 * only those, never "no team", and saves on the assistant's team route; a session without
 * `manage-ownership` sees the owner read-only. The reason prompt is the service's (`setOwnership`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import AssistantOwnerControl from './AssistantOwnerControl';
import TeamSelector from './TeamSelector';
import { setOwnership } from '../../services/ownershipService';

vi.mock('../../services/ownershipService', () => ({ setOwnership: vi.fn() }));

beforeEach(() => vi.mocked(setOwnership).mockReset().mockResolvedValue(undefined));

const renderControl = (over: Partial<React.ComponentProps<typeof AssistantOwnerControl>> = {}) => {
  const onSaved = vi.fn();
  render(<AssistantOwnerControl assistant="ops-premium" ownerTeam="ops" teams={['finance', 'ops']} isAdmin canManage onSaved={onSaved} {...over} />);
  return onSaved;
};
const select = () => within(screen.getByTestId('assistant-owner-select')).getByRole('combobox') as HTMLSelectElement;

describe('an admin', () => {
  it('chooses any team or none, and saves on the admin route', async () => {
    const onSaved = renderControl();
    expect([...select().options].map((o) => o.textContent)).toEqual(['No team (admins only)', 'Finance team', 'Ops team']);
    const save = screen.getByRole('button', { name: 'Save the owning team for ops-premium' });
    expect(save).toBeDisabled();
    fireEvent.change(select(), { target: { value: 'finance' } });
    fireEvent.click(save);
    await waitFor(() => expect(setOwnership).toHaveBeenCalledWith('ops-premium', 'finance', false));
    expect(onSaved).toHaveBeenCalled();
  });

  it('may clear the owner', async () => {
    renderControl();
    fireEvent.change(select(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the owning team for ops-premium' }));
    await waitFor(() => expect(setOwnership).toHaveBeenCalledWith('ops-premium', null, false));
  });
});

describe('a team member', () => {
  it('with one team sees it and is offered nothing to move it to', () => {
    renderControl({ teams: ['ops'], isAdmin: false });
    const owner = screen.getByTestId('assistant-owner');
    expect(owner).toHaveTextContent('Ops team');
    expect(owner).toHaveTextContent('An administrator can assign it to another team.');
    expect(within(owner).queryByRole('combobox')).toBeNull();
    expect(within(owner).queryByRole('button')).toBeNull();
  });

  it('with several teams is offered only those, never no team, and saves on the team route', async () => {
    renderControl({ teams: ['finance', 'ops'], isAdmin: false });
    expect([...select().options].map((o) => o.textContent)).toEqual(['Finance team', 'Ops team']);
    fireEvent.change(select(), { target: { value: 'finance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the owning team for ops-premium' }));
    await waitFor(() => expect(setOwnership).toHaveBeenCalledWith('ops-premium', 'finance', true));
  });
});

it('without manage-ownership the owner is read-only', () => {
  renderControl({ canManage: false });
  expect(screen.getByTestId('assistant-owner')).toHaveTextContent('Ops team');
  expect(screen.queryByRole('combobox')).toBeNull();
});

describe('the one team selector', () => {
  it('is a fixed label for one team with nothing else to choose', () => {
    render(<TeamSelector teams={['ops']} value="ops" onChange={vi.fn()} testId="sel" />);
    expect(screen.getByTestId('sel')).toHaveTextContent('Team: Ops team');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('is a labeled select for several, with All teams for a filter', () => {
    const onChange = vi.fn();
    render(<TeamSelector teams={['finance', 'ops']} value="" onChange={onChange} allOption label="Owned by" />);
    const box = screen.getByLabelText('Owned by') as HTMLSelectElement;
    expect([...box.options].map((o) => o.textContent)).toEqual(['All teams', 'Finance team', 'Ops team']);
    fireEvent.change(box, { target: { value: 'ops' } });
    expect(onChange).toHaveBeenCalledWith('ops');
  });
});
