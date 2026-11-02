/**
 * THE ASSISTANTS: ONE LIST, HOWEVER EACH WAS CREATED (ADR-048, SPEC-ADMIN-CONSOLE "Assistants").
 *
 * An assistant declared in `deploy.config.json` and one created in the console behave the same: each is built
 * by the provisioner, answers in one classification and role, and its configuration is a versioned profile. So
 * there is one list, and how an assistant came to exist is a quiet detail under its name. A row shows its build
 * state (being created, failed with what it left behind, retired), and an admin retires from here any assistant
 * the retire route accepts: every one but a classification's primary (ADR-048, amended 2026-10-23). A declared
 * assistant retired here stays retired: a deploy does not recreate it.
 *
 * WHAT IS LISTED IS WHAT THE SERVER RETURNED. An admin's listing is every assistant; a team member's is
 * read on each owned assistant's own route, so nothing outside their reach is fetched. The team filter
 * narrows what was returned; it is not how reach is enforced.
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProfileListing, RuntimeAssistant } from '../../services/profileService';
import { retireAssistant } from '../../services/rosterService';
import { ReasonDeclinedError } from '../../services/adminReason';
import TeamSelector, { ANY_TEAM, useTeamName } from './TeamSelector';

export interface AssistantRow {
  name: string;
  displayName?: string;
  classification?: string;
  role?: string;
  ownerTeam?: string | null;
  origin: 'deployed' | 'console';
  /** Whether retire accepts it, as the server says (`retirable`). How it was created decides nothing. */
  retirable: boolean;
  status: RuntimeAssistant['status'];
  activeVersion: number | null;
  hasDraft: boolean;
  /** Whether it has a profile to open: a console-created assistant has one once it is active. */
  opens: boolean;
  error?: string;
  leftover?: string[];
  /** The build could not record its owning team on the identity. */
  ownerSeedError?: string;
  /** The build could not seed its first draft. */
  firstDraftError?: string;
  /** The active version's event workflows, as the listing names them; absent when none is active. */
  eventWorkflows?: ProfileListing['activeEventWorkflows'];
  /** Whether the active version declares an onboarding intake. */
  onboarding?: boolean;
}

/** The profiles and the console-created roster, merged into one row per assistant. */
export function assistantRows(profiles: ProfileListing[], runtime: RuntimeAssistant[]): AssistantRow[] {
  const rows = new Map<string, AssistantRow>();
  for (const p of profiles) {
    rows.set(p.profileName, {
      name: p.profileName,
      displayName: p.displayName,
      classification: p.classification,
      role: p.role,
      ownerTeam: p.ownerTeam,
      origin: p.origin ?? 'deployed',
      retirable: p.retirable === true,
      status: 'active',
      activeVersion: p.activeVersion,
      hasDraft: p.hasDraft,
      opens: true,
      ...(p.activeEventWorkflows ? { eventWorkflows: p.activeEventWorkflows } : {}),
      ...(p.activeOnboarding !== undefined ? { onboarding: p.activeOnboarding } : {}),
    });
  }
  for (const r of runtime) {
    const listed = rows.get(r.assistant);
    rows.set(r.assistant, {
      name: r.assistant,
      displayName: r.displayName ?? listed?.displayName,
      classification: r.classification,
      role: r.role,
      // THE TAG DECIDES. The profile listing's owner is read from the `owner-team` tag, and `null` there is
      // a decision (cleared, or bots that disagree), so it is kept rather than replaced by the team the
      // assistant was created for. Only a row with no profile yet (being built, failed) falls back.
      ownerTeam: listed ? listed.ownerTeam : r.ownerTeam,
      origin: r.origin === 'declared' ? 'deployed' : 'console',
      retirable: r.retirable ?? listed?.retirable ?? true,
      status: r.status,
      activeVersion: listed?.activeVersion ?? null,
      hasDraft: listed?.hasDraft ?? false,
      opens: !!listed,
      ...(listed?.eventWorkflows ? { eventWorkflows: listed.eventWorkflows } : {}),
      ...(listed?.onboarding !== undefined ? { onboarding: listed.onboarding } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(r.leftover?.length ? { leftover: r.leftover } : {}),
      ...(r.ownerSeedError ? { ownerSeedError: r.ownerSeedError } : {}),
      ...(r.firstDraftError ? { firstDraftError: r.firstDraftError } : {}),
    });
  }
  // Retired names last: they are tombstones, kept because a name is never reused.
  return [...rows.values()].sort((a, b) => Number(a.status === 'retired') - Number(b.status === 'retired') || a.name.localeCompare(b.name));
}

const RETIRABLE = new Set(['active', 'failed', 'retiring']);

/**
 * Whether retired assistants are listed. Off by default, so the list shows the assistants that answer, and
 * remembered per browser. Storage that cannot be read or written leaves the default in place.
 */
const SHOW_RETIRED_KEY = 'ae.admin.assistants.showRetired';
function readShowRetired(): boolean {
  try { return window.localStorage.getItem(SHOW_RETIRED_KEY) === '1'; } catch { return false; }
}
function writeShowRetired(on: boolean): void {
  try { window.localStorage.setItem(SHOW_RETIRED_KEY, on ? '1' : '0'); } catch { /* the choice lasts for this view */ }
}

interface AssistantsListProps {
  rows: AssistantRow[];
  /** The teams the filter offers: every team for an admin, the person's own for a team member. */
  teams: readonly string[];
  isAdmin: boolean;
  /** Retiring an assistant is an admin's alone. */
  canRetire: boolean;
  onOpen: (name: string) => void;
  onChanged: () => void;
}

// NO IMPORT HERE. An import lands on one assistant, so it lives in that assistant's configuration
// (Versions), where the console names the target. A console-created assistant already has a seeded
// first draft, so a list-level "first version" import had nothing left to do.
const AssistantsList: React.FC<AssistantsListProps> = ({ rows, teams, isAdmin, canRetire, onOpen, onChanged }) => {
  const { t } = useTranslation();
  const teamName = useTeamName();
  const [team, setTeam] = useState<string>(ANY_TEAM);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [showRetired, setShowRetired] = useState<boolean>(readShowRetired);
  const toggleRetired = (on: boolean) => { setShowRetired(on); writeShowRetired(on); };
  const forTeam = useMemo(() => (team === ANY_TEAM ? rows : rows.filter((r) => r.ownerTeam === team)), [rows, team]);
  const retiredCount = useMemo(() => forTeam.filter((r) => r.status === 'retired').length, [forTeam]);
  const shown = useMemo(() => (showRetired ? forTeam : forTeam.filter((r) => r.status !== 'retired')), [forTeam, showRetired]);

  const act = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      if (done) setNotice(done);
      onChanged();
    } catch (err) {
      if (!(err instanceof ReasonDeclinedError)) setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // A failed create never answered, so removing it releases its name; retiring an assistant that did
  // answer leaves its name as a tombstone.
  const retire = (a: AssistantRow) => {
    const label = a.displayName || a.name;
    if (!window.confirm(t(a.status === 'failed' ? 'admin.assistants.confirmRemove' : 'admin.assistants.confirmRetire', { assistant: label }))) return;
    void act(`retire:${a.name}`, async () => {
      const result = await retireAssistant(a.name);
      if (result.status === 'released') setNotice(t('admin.assistants.released', { assistant: label }));
    });
  };

  const profileCell = (a: AssistantRow) => {
    if (a.status !== 'active') return '-';
    if (a.activeVersion == null && a.hasDraft) {
      return <span data-testid="draft-ready">{t('admin.assistants.profile.draftReady')}</span>;
    }
    if (a.activeVersion != null) {
      return <>{t('admin.assistants.profile.version', { version: a.activeVersion })}{a.hasDraft && <span className="admin-field-hint"> · {t('admin.assistants.profile.draft')}</span>}</>;
    }
    return <span className="admin-muted">{t('admin.assistants.profile.none')}</span>;
  };

  /**
   * THE ACTIVE VERSION'S EVENT WORKFLOWS, by the event that starts each, so an assistant's welcomes and other workflows are
   * found without opening it. One with none says how it welcomes people instead.
   */
  const workflowsCell = (a: AssistantRow) => {
    if (a.status !== 'active' || a.activeVersion == null) return '-';
    if (!a.eventWorkflows) return <span className="admin-muted">{t('admin.assistants.eventWorkflows.notRead')}</span>;
    if (!a.eventWorkflows.length) {
      return <span className="admin-muted" data-testid={`assistant-workflows-${a.name}`}>
        {t(a.onboarding ? 'admin.assistants.eventWorkflows.throughOnboarding' : 'admin.assistants.eventWorkflows.none')}
      </span>;
    }
    const byEvent = new Map<string, NonNullable<AssistantRow['eventWorkflows']>>();
    for (const w of a.eventWorkflows) byEvent.set(w.on, [...(byEvent.get(w.on) ?? []), w]);
    return (
      <div className="admin-assistants-workflows" data-testid={`assistant-workflows-${a.name}`}>
        {[...byEvent.entries()].map(([on, list]) => (
          <div key={on} data-event={on}>
            <span className="admin-field-hint">{t(`admin.eventWorkflows.eventShort.${on}`)}</span>{' '}
            {list.map((w) => (
              <code key={w.name} className="admin-chip" title={w.types?.length ? t('admin.assistants.eventWorkflows.inRooms', { types: w.types.join(', ') }) : undefined}>{w.name}</code>
            ))}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="admin-section" data-testid="assistants-list">
      <div className="admin-assistants-toolbar">
        <div className="admin-assistants-toolbar-group">
          {teams.length > 0 && (
            <TeamSelector teams={teams} value={team} onChange={setTeam} allOption={isAdmin || teams.length > 1}
              label={t('admin.team.filterLabel')} testId="assistants-team-filter" />
          )}
          {retiredCount > 0 && (
            <label className="admin-assistants-retired-toggle">
              <input type="checkbox" checked={showRetired} onChange={(e) => toggleRetired(e.target.checked)} data-testid="assistants-show-retired" />
              {t('admin.assistants.showRetired', { count: retiredCount })}
            </label>
          )}
          <span className="admin-assistants-count" data-testid="assistants-count">
            {shown.length === rows.length
              ? t('admin.assistants.countAll', { count: rows.length })
              : t('admin.assistants.countOf', { shown: shown.length, total: rows.length })}
          </span>
        </div>
      </div>

      {error && <div className="admin-error" role="alert"><span>{error}</span>
        <button className="btn-secondary" onClick={() => setError(null)}>{t('admin.assistants.dismiss')}</button></div>}
      {notice && <div className="admin-info-banner" role="status"><span>{notice}</span>
        <button className="btn-secondary" onClick={() => setNotice(null)}>{t('admin.assistants.dismiss')}</button></div>}

      {shown.length === 0 ? (
        <div className="admin-assistants-empty" data-testid="assistants-empty">
          {isAdmin
            ? <strong>{t('admin.assistants.emptyFilter')}</strong>
            : <><strong>{t('admin.assistants.emptyTeam')}</strong>{t('admin.assistants.emptyTeamHow')}</>}
        </div>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">{t('admin.assistants.column.assistant')}</th>
              <th scope="col">{t('admin.assistants.column.classification')}</th>
              <th scope="col">{t('admin.assistants.column.role')}</th>
              <th scope="col">{t('admin.assistants.column.owner')}</th>
              <th scope="col">{t('admin.assistants.column.status')}</th>
              <th scope="col">{t('admin.assistants.column.profile')}</th>
              <th scope="col">{t('admin.assistants.column.eventWorkflows')}</th>
              <th><span className="visually-hidden">{t('admin.assistants.column.action')}</span></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => (
              // THE ROW OPENS THE ASSISTANT for a pointer; the name button is the keyboard and screen-reader
              // control. A click on any control in the row is that control's, not the row's.
              <tr key={a.name} data-assistant={a.name}
                onClick={(e) => { if (a.opens && !(e.target as HTMLElement).closest('button, label, input, a')) onOpen(a.name); }}>
                <td>
                  {a.opens
                    ? <button className="btn-link" aria-label={t('admin.assistants.open', { assistant: a.displayName || a.name })} onClick={() => onOpen(a.name)}>{a.displayName || a.name}</button>
                    : <span>{a.displayName || a.name}</span>}
                  {a.displayName && a.displayName !== a.name && <>{' '}<code className="admin-field-hint">{a.name}</code></>}
                  <div className="admin-field-hint">{t(`admin.assistants.origin.${a.origin}`)}</div>
                </td>
                <td>{a.classification ?? '-'}</td>
                <td>{a.role ?? '-'}</td>
                <td>{a.ownerTeam ? teamName(a.ownerTeam) : a.ownerTeam === null ? <span className="admin-muted">{t('admin.assistants.noOwner')}</span> : '-'}</td>
                <td>
                  {t(`admin.assistants.status.${a.status}`)}
                  {a.ownerSeedError && (
                    <div className="admin-field-hint" role="note">{t('admin.assistants.ownerSeedError', { reason: a.ownerSeedError })}</div>
                  )}
                  {a.firstDraftError && a.activeVersion == null && !a.hasDraft && (
                    <div className="admin-field-hint" role="note">{t('admin.assistants.firstDraftError', { reason: a.firstDraftError })}</div>
                  )}
                  {a.status === 'failed' && (
                    <span className="admin-field-hint">
                      {' '}{a.error}{a.leftover?.length ? <> {t('admin.assistants.leftover', { what: a.leftover.join(', ') })}</> : null}
                    </span>
                  )}
                </td>
                <td>{profileCell(a)}</td>
                <td>{workflowsCell(a)}</td>
                <td>
                  {canRetire && a.retirable && RETIRABLE.has(a.status) && (
                    <button className="btn-danger" disabled={busy !== null}
                      aria-label={t(a.status === 'failed' ? 'admin.assistants.removeFor' : 'admin.assistants.retireFor', { assistant: a.displayName || a.name })}
                      onClick={() => retire(a)}>
                      {t(a.status === 'failed' ? 'admin.assistants.remove' : 'admin.assistants.retire')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default AssistantsList;
