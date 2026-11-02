/**
 * WHO A TEAM MEMBER IS IN THIS CONSOLE: THEIR TEAM AND THE ASSISTANT IT OWNS (SPEC-ADMIN-CONSOLE FR48).
 *
 * "Ops team, owner of the ops-premium assistant" rather than a bare role label. The console is scoped to
 * one owned assistant at a time; a person in several teams picks the team with the same selector the
 * Assistants list uses, and a team owning several assistants picks the assistant. A team that owns none
 * yet is told so, and its console opens on Assistants, where it creates one.
 *
 * PICKING A TEAM THAT OWNS NONE keeps the selector on that team and says so, rather than snapping back to the
 * team the console is scoped to: the scope stays on the assistant it was on (a team route needs one), and the
 * line says the picked team has none yet and where to create one.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import TeamSelector, { useTeamName } from './TeamSelector';

interface TeamIdentityProps {
  teams: readonly string[];
  assistants: readonly string[];
  /** The team that owns each assistant, from the console session. */
  owners?: Readonly<Record<string, string>>;
  scopedTo: string | null;
  onChooseAssistant: (assistant: string) => void;
}

const TeamIdentity: React.FC<TeamIdentityProps> = ({ teams, assistants, owners = {}, scopedTo, onChooseAssistant }) => {
  const { t } = useTranslation();
  const teamName = useTeamName();
  const scopedTeam = (scopedTo && owners[scopedTo]) || teams[0] || '';
  // A team picked that owns no assistant: shown as chosen, while the scope stays where it was.
  const [emptyTeam, setEmptyTeam] = useState<string | null>(null);
  const team = emptyTeam ?? scopedTeam;
  // The assistants of the chosen team; every owned assistant when the session did not say who owns which.
  const ofTeam = assistants.filter((a) => !owners[a] || owners[a] === team);
  const chooseTeam = (next: string) => {
    const first = assistants.find((a) => owners[a] === next);
    if (first) {
      setEmptyTeam(null);
      onChooseAssistant(first);
    } else {
      setEmptyTeam(next);
    }
  };

  return (
    <div className="admin-field-hint" data-testid="admin-team-scope">
      {teams.length > 1 && <><TeamSelector teams={teams} value={team} onChange={chooseTeam} testId="admin-team-scope-team" />{' '}</>}
      {emptyTeam && scopedTo
        ? t('admin.access.teamPickedOwnsNone', { team: teamName(emptyTeam), assistant: scopedTo })
        : assistants.length === 0 || !scopedTo
        ? t('admin.access.teamOwnsNone', { team: teams.map(teamName).join(', ') })
        : ofTeam.length > 1
          ? (
            <label>
              {t('admin.access.teamOwnerChoose', { team: teamName(team) })}{' '}
              <select className="select" aria-label={t('admin.access.assistantLabel')} value={scopedTo} onChange={(e) => onChooseAssistant(e.target.value)}>
                {ofTeam.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
          )
          : t('admin.access.teamOwner', { team: teamName(team), assistant: scopedTo })}
    </div>
  );
};

export default TeamIdentity;
