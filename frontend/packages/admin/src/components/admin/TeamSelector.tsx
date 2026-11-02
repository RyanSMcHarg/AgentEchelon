/**
 * ONE TEAM SELECTOR, EVERYWHERE THE CONSOLE SCOPES BY TEAM.
 *
 * The Assistants list filter, the owning-team field when an assistant is created, the owner control in
 * an assistant's configuration and the identity line at the top of a team member's console all choose or
 * show a team, so they share this control: same label, same order, same behavior. One team and nothing
 * else to pick is shown as a fixed label rather than a select with one option.
 *
 * The teams it offers are decided by the caller from the session: every team for an admin, the person's
 * own teams for a team member. NOT AN ENFORCEMENT LAYER: the routes refuse a team the caller may not name.
 */
import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';

/** The value of "All teams" in a filter and of "No team" in an assignment. */
export const ANY_TEAM = '';

/** How a team is named in copy: "Ops team" for `ops`. */
export function useTeamName(): (team: string) => string {
  const { t } = useTranslation();
  return (team: string) => t('admin.team.name', { team: team.charAt(0).toUpperCase() + team.slice(1) });
}

interface TeamSelectorProps {
  teams: readonly string[];
  value: string;
  onChange: (team: string) => void;
  /** Offer "All teams" as {@link ANY_TEAM}: a filter. */
  allOption?: boolean;
  /** Offer "No team" as {@link ANY_TEAM}: an admin's assignment. */
  noneOption?: boolean;
  /** The visible label; defaults to "Team". */
  label?: string;
  /** Keep the label for assistive technology but not on screen, where a neighboring heading already names the field. */
  labelHidden?: boolean;
  disabled?: boolean;
  testId?: string;
}

const TeamSelector: React.FC<TeamSelectorProps> = ({ teams, value, onChange, allOption, noneOption, label, labelHidden, disabled, testId }) => {
  const { t } = useTranslation();
  const teamName = useTeamName();
  const id = useId();
  const caption = label ?? t('admin.team.label');
  const emptyOption = allOption ? t('admin.team.all') : noneOption ? t('admin.team.none') : null;
  // One team and nothing else to choose: a fixed label, so a person with one team is not handed a control.
  if (teams.length === 1 && emptyOption === null) {
    return (
      <span className="admin-team-select" data-testid={testId}>
        <span>{caption}:</span> <span className="admin-team-select-fixed">{teamName(teams[0])}</span>
      </span>
    );
  }
  return (
    <span className="admin-team-select" data-testid={testId}>
      <label htmlFor={id} className={labelHidden ? "visually-hidden" : undefined}>{caption}</label>
      <select id={id} className="select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {emptyOption !== null && <option value={ANY_TEAM}>{emptyOption}</option>}
        {teams.map((team) => <option key={team} value={team}>{teamName(team)}</option>)}
      </select>
    </span>
  );
};

export default TeamSelector;
