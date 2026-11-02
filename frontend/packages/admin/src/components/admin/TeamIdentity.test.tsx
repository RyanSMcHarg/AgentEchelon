/**
 * A TEAM MEMBER IS NAMED BY THEIR TEAM, NOT BY A ROLE LABEL (owner decision, 2026-10-23).
 *
 * What it proves: the console's identity line reads "Ops team, owner of the ops-premium assistant"; a team
 * owning several assistants picks one; a person in several teams picks the team with the shared selector
 * and lands on that team's assistant; a team owning none is told so; and a team that owns none sees only
 * the Assistants tab, where it creates one.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import TeamIdentity from './TeamIdentity';
import { isTabAvailableToTeam, TEAM_TABS } from './AdminDashboard';

describe('the identity line', () => {
  it('names the team and the assistant it owns', () => {
    render(<TeamIdentity teams={['ops']} assistants={['ops-premium']} owners={{ 'ops-premium': 'ops' }} scopedTo="ops-premium" onChooseAssistant={vi.fn()} />);
    const line = screen.getByTestId('admin-team-scope');
    expect(line).toHaveTextContent('Ops team, owner of the ops-premium assistant');
    expect(line).not.toHaveTextContent('a team member');
    expect(within(line).queryByRole('combobox')).toBeNull();
  });

  it('lets a team owning several assistants pick one', () => {
    const choose = vi.fn();
    render(<TeamIdentity teams={['ops']} assistants={['ops-premium', 'ops-helper']} owners={{ 'ops-premium': 'ops', 'ops-helper': 'ops' }} scopedTo="ops-premium" onChooseAssistant={choose} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Assistant' }), { target: { value: 'ops-helper' } });
    expect(choose).toHaveBeenCalledWith('ops-helper');
  });

  it('lets a person in several teams pick the team, and lands on that team\'s assistant', () => {
    const choose = vi.fn();
    render(<TeamIdentity teams={['finance', 'ops']} assistants={['ops-premium', 'finance-advisor']}
      owners={{ 'ops-premium': 'ops', 'finance-advisor': 'finance' }} scopedTo="ops-premium" onChooseAssistant={choose} />);
    const team = within(screen.getByTestId('admin-team-scope-team')).getByRole('combobox');
    expect([...(team as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['Finance team', 'Ops team']);
    fireEvent.change(team, { target: { value: 'finance' } });
    expect(choose).toHaveBeenCalledWith('finance-advisor');
  });

  it('tells a team that owns nothing so', () => {
    render(<TeamIdentity teams={['ops']} assistants={[]} scopedTo={null} onChooseAssistant={vi.fn()} />);
    expect(screen.getByTestId('admin-team-scope')).toHaveTextContent('Ops team. Your team owns no assistants yet.');
  });
});

describe('the tabs a team sees', () => {
  it('a team that owns none sees Assistants alone', () => {
    for (const id of TEAM_TABS) expect(isTabAvailableToTeam(id, 'aurora', true)).toBe(id === 'profiles');
  });

  it('a team that owns one sees its team tabs, and in Athena mode its profile and experiments', () => {
    expect(isTabAvailableToTeam('conversations', 'aurora', false)).toBe(true);
    expect(isTabAvailableToTeam('conversations', 'athena', false)).toBe(false);
    expect(isTabAvailableToTeam('profiles', 'athena', false)).toBe(true);
    expect(isTabAvailableToTeam('users', 'aurora', false)).toBe(false);
  });
});

describe('picking a team that owns no assistant', () => {
  it('keeps the team chosen and says it owns none, while the console stays on its assistant', () => {
    const choose = vi.fn();
    render(<TeamIdentity teams={['finance', 'ops']} assistants={['ops-premium']} owners={{ 'ops-premium': 'ops' }} scopedTo="ops-premium" onChooseAssistant={choose} />);
    const team = within(screen.getByTestId('admin-team-scope-team')).getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(team, { target: { value: 'finance' } });
    expect(choose).not.toHaveBeenCalled();
    expect(team.value).toBe('finance');
    expect(screen.getByTestId('admin-team-scope')).toHaveTextContent('Finance team owns no assistants yet. Create one under Assistants; until then the console stays on ops-premium.');
    // Back to a team that owns one: it lands on that assistant.
    fireEvent.change(team, { target: { value: 'ops' } });
    expect(choose).toHaveBeenCalledWith('ops-premium');
    expect(screen.getByTestId('admin-team-scope')).toHaveTextContent('Ops team, owner of the ops-premium assistant');
  });
});
