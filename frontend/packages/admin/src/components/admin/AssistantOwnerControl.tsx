/**
 * THE OWNING TEAM, PART OF AN ASSISTANT'S CONFIGURATION (SPEC-ADMIN-CONSOLE FR47, `manage-ownership`).
 *
 * An assistant's owning team decides whose console reaches it: its `team-<name>` members manage its
 * profile and experiments and read its analytics, and nothing else. A change asks for a reason, is
 * recorded, and takes effect on each team member's next sign-in.
 *
 * An admin assigns any team or none. A team member moves an assistant their team owns to another of their
 * own teams; with one team there is nothing to move it to, so the owner is shown and not offered. The
 * route enforces the same rule, whatever this offers.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setOwnership } from '../../services/ownershipService';
import { ReasonDeclinedError } from '../../services/adminReason';
import TeamSelector, { ANY_TEAM, useTeamName } from './TeamSelector';

interface AssistantOwnerControlProps {
  assistant: string;
  /** The current owner; null when no team owns it. */
  ownerTeam: string | null;
  /** The assistant's identities disagree about their owner. */
  mixed?: boolean;
  /** Every team for an admin; the person's own teams for a team member. */
  teams: readonly string[];
  isAdmin: boolean;
  /** Whether the session holds `manage-ownership`. Without it the owner is shown read-only. */
  canManage: boolean;
  /** The select label is read out but not shown, for a place that already names the field (the configuration list). */
  labelHidden?: boolean;
  onSaved: () => void;
}

const AssistantOwnerControl: React.FC<AssistantOwnerControlProps> = ({ assistant, ownerTeam, mixed, teams, isAdmin, canManage, labelHidden, onSaved }) => {
  const { t } = useTranslation();
  const teamName = useTeamName();
  const [chosen, setChosen] = useState<string>(ownerTeam ?? ANY_TEAM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setChosen(ownerTeam ?? ANY_TEAM); }, [ownerTeam]);

  // A team member with one team owns this through it and has nowhere else to move it.
  const offers = canManage && (isAdmin || teams.length > 1);
  if (!offers) {
    return (
      <div data-testid="assistant-owner">
        <span>{ownerTeam ? teamName(ownerTeam) : t('admin.assistants.noOwner')}</span>
        {canManage && !isAdmin && <div className="admin-field-hint">{t('admin.ownerControl.single')}</div>}
      </div>
    );
  }

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await setOwnership(assistant, chosen || null, !isAdmin);
      onSaved();
    } catch (err) {
      if (!(err instanceof ReasonDeclinedError)) setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="assistant-owner">
      <div className="admin-assistants-toolbar-group">
        <TeamSelector teams={teams} value={chosen} onChange={setChosen} noneOption={isAdmin}
          label={t('admin.ownerControl.label')} labelHidden={labelHidden} disabled={busy} testId="assistant-owner-select" />
        <button type="button" className="btn-secondary"
          aria-label={t('admin.ownerControl.saveFor', { assistant })}
          disabled={busy || (chosen === (ownerTeam ?? ANY_TEAM) && !mixed) || (!isAdmin && !chosen)}
          onClick={() => void save()}>
          {t('admin.ownerControl.save')}
        </button>
      </div>
      <div className="admin-field-hint">{t(isAdmin ? 'admin.ownerControl.help' : 'admin.ownerControl.teamOnly')}</div>
      {mixed && <div className="admin-field-hint">{t('admin.ownerControl.mixed')}</div>}
      {error && <div className="admin-error" role="alert"><span>{error}</span>
        <button className="btn-secondary" onClick={() => setError(null)}>{t('admin.assistants.dismiss')}</button></div>}
    </div>
  );
};

export default AssistantOwnerControl;
