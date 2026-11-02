import i18n from '@ae/shared/i18n';
import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import './UserManagementTab.css';
import { adminRequest } from '../../services/sigv4Fetch';
import { type PersonEntry } from '../../services/peopleService';
import { adminUrl } from '../../services/adminApi';
import { useCan } from '../../capabilities';
import { classificationBadgeStyle, classificationName } from '@ae/shared/config/classifications.ts';
import { GUEST_EXPERIENCE_SHOWN } from '../../config/guestExperience';
import { useTeamName } from './TeamSelector';

/** One person, or one pool account that has not signed in yet. */
type User = PersonEntry;

/** The key a list entry is acted on by: the person, or the pool account that is not one yet. */
const entryKey = (u: User): string => u.personArn || u.username || '';

type Filter = 'all' | 'pending' | 'approved' | 'disabled';

/** A signed call on the operator's sign-on credentials: every user-management route is IAM-authorized,
 *  and listing, changing and deleting users are separate capabilities (`view-users`, `manage-users`,
 *  `delete-users`). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function apiCall(url: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<any> {
  const signedIn = !!localStorage.getItem('idToken');
  if (!signedIn) throw new Error(i18n.t('admin.userManagement.notAuthenticated'));
  return adminRequest(method, url, { body });
}

function getInitials(email: string): string {
  const parts = email.split('@')[0].split(/[._-]/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return email.substring(0, 2).toUpperCase();
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '--';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getUserStatus(user: User): 'pending' | 'approved' | 'disabled' {
  if (!user.enabled) return 'disabled';
  // A person of another issuer was admitted by that issuer: there is nothing here to approve.
  if (user.account === 'other') return 'approved';
  return user.approved === 'true' ? 'approved' : 'pending';
}

/**
 * Which identity provider governs end users on this deployment (CfnOutput -> VITE_IDENTITY_PROVIDER).
 * Defaults to the bundled provider so an env without the var behaves exactly as before.
 */
function getIdentityProvider(): string {
  return (import.meta.env.VITE_IDENTITY_PROVIDER || 'cognito').trim();
}

/**
 * Shown INSTEAD of the user table when this deployment does not use Cognito for end users.
 *
 * The actions on this tab (approve, reject, change tier, enable, delete) are implemented by
 * `user-management.ts`, which calls Cognito User Pool admin APIs directly. On a deployment that
 * replaced User Pools with its own IdP, those buttons would act on a directory that no longer
 * governs anyone - so the honest surface is a pointer, not a disabled-looking table.
 */
const ExternalIdpNotice: React.FC<{ provider: string }> = ({ provider }) => {
  const { t: translate } = useTranslation();
  return (
  <div className="admin-tab">
    <div className="um-external-idp">
      <h3>{translate('admin.userManagement.usersAreManagedInYour')}</h3>
      <p>
        {translate('admin.userManagement.thisDeploymentAuthenticatesEndUsers')} <strong>{provider}</strong>{translate('admin.userManagement.notTheBundledAmazonCognito')}
      </p>
      <p className="um-external-idp__detail">
        Tier still comes from group membership as usual. Map your provider&apos;s groups or claims onto
        the <code>basic</code> / <code>standard</code> / <code>premium</code> / <code>admins</code> {translate('admin.userManagement.groupsAsDescribedInThe')}
      </p>
    </div>
  </div>
  );
};

const UserManagementTab: React.FC = () => {
  const { t: translate } = useTranslation();
  const identityProvider = getIdentityProvider();
  const isCognito = identityProvider.toLowerCase() === 'cognito';
  const [users, setUsers] = useState<User[]>([]);
  // The membership groups the deployment declares, with the clearance each requires, from the API.
  const [membershipGroups, setMembershipGroups] = useState<Array<{ name: string; requires: string }>>([]);
  // The person whose details are open, by entry key. Group membership is edited there, one person at a time.
  const [detailKey, setDetailKey] = useState<string | null>(null);
  // The console teams that exist (their `team-<name>` groups), offered in a person's details.
  const [teams, setTeams] = useState<string[]>([]);
  const teamName = useTeamName();
  // THE CLEARANCE GROUPS THIS DEPLOYMENT DECLARES, from the API: what an approval or a clearance change may
  // name, each shown by the classification it clears for. None listed offers none.
  const [clearanceGroups, setClearanceGroups] = useState<Array<{ name: string; clears: string }>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('pending');
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  // AN UNBOUND VISITOR IS NOT A USER TO ADMINISTER (E6): hidden unless asked for.
  const [showVisitors, setShowVisitors] = useState(false);
  const can = useCan();

  const loadUsers = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await apiCall(adminUrl('user-management', '/users'));
      setUsers(data.users || []);
      setMembershipGroups(Array.isArray(data.membershipGroups) ? data.membershipGroups : []);
      setClearanceGroups(Array.isArray(data.clearanceGroups) ? data.clearanceGroups : []);
      setTeams(Array.isArray(data.teams) ? data.teams : []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Skip the fetch entirely when users live in another IdP: the endpoint is Cognito-backed, so
  // calling it would surface a spurious error on a deployment that is working exactly as intended.
  useEffect(() => {
    if (!isCognito) { setIsLoading(false); return; }
    loadUsers();
  }, [loadUsers, isCognito]);

  const doAction = async (fn: () => Promise<unknown>) => {
    try { await fn(); await loadUsers(); }
    catch (err) { setError((err as Error).message); }
  };

  // An approval always names the clearance chosen in the row; the approve control is disabled until one is.
  const handleApprove = (username: string, tier: string) => {
    setActionInProgress(username);
    doAction(() => apiCall(adminUrl('user-management', '/users/approve'), 'POST', { username, tier })).finally(() => setActionInProgress(null));
  };

  const handleReject = (username: string) => {
    setActionInProgress(username);
    doAction(() => apiCall(adminUrl('user-management', '/users/reject'), 'POST', { username })).finally(() => setActionInProgress(null));
  };

  const handleEnable = (username: string) => {
    setActionInProgress(username);
    doAction(() => apiCall(adminUrl('user-management', '/users/enable'), 'POST', { username })).finally(() => setActionInProgress(null));
  };

  // A membership group (e.g. `ops`) is a toggle beside the clearance select. It grants nothing: the API
  // refuses anyone not already cleared for what it requires. Changing it is a directory group change,
  // which the conversations sourced from the group follow.
  const handleMembershipGroup = (username: string, group: string, member: boolean) => {
    setActionInProgress(username);
    doAction(() => apiCall(adminUrl('user-management', '/users/group'), 'POST', { username, group, member })).finally(() => setActionInProgress(null));
  };

  // A console team. Joining a first team also gives the team-member console role, and leaving the last takes it.
  const handleTeam = (username: string, team: string, member: boolean) => {
    setActionInProgress(username);
    doAction(() => apiCall(adminUrl('user-management', '/users/team'), 'POST', { username, team, member })).finally(() => setActionInProgress(null));
  };

  const handleTierChange = (username: string, tier: string) => {
    setActionInProgress(username);
    doAction(() => apiCall(adminUrl('user-management', '/users/tier'), 'POST', { username, tier })).finally(() => setActionInProgress(null));
  };

  // OFFBOARDING, by AppInstanceUser for a person and by username for a pool account that never became
  // one. What it keeps is stated on the tab, and repeated in the confirmation.
  const handleDelete = (user: User) => {
    const name = user.displayName || user.email || user.username || user.personId || '';
    if (!window.confirm(translate('admin.userManagement.confirmDelete', { name }))) return;
    setActionInProgress(entryKey(user));
    const body = user.personArn ? { personArn: user.personArn } : { username: user.username };
    doAction(() => apiCall(adminUrl('user-management', '/users/delete'), 'POST', body)).finally(() => setActionInProgress(null));
  };

  /**
   * EXPORT EVERYTHING KEPT ABOUT ONE PERSON (B13): one archive, read from the inventory an erasure walks, saved
   * as a file. Nothing is changed by it.
   */
  const handleExport = (user: User) => {
    if (!user.personArn) return;
    setActionInProgress(entryKey(user));
    apiCall(adminUrl('user-management', '/users/export'), 'POST', { personArn: user.personArn })
      .then((archive) => {
        const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `person-export-${user.personId || 'person'}.json`;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setActionInProgress(null));
  };

  const detailUser = detailKey ? users.find((u) => entryKey(u) === detailKey) ?? null : null;
  const listed = users.filter(u => showVisitors || !u.guest);
  const visitors = users.length - users.filter(u => !u.guest).length;
  const counts = {
    all: listed.length,
    pending: listed.filter(u => getUserStatus(u) === 'pending').length,
    approved: listed.filter(u => getUserStatus(u) === 'approved').length,
    disabled: listed.filter(u => getUserStatus(u) === 'disabled').length,
  };

  const filteredUsers = listed.filter(user => filter === 'all' || getUserStatus(user) === filter);

  const statItems: { key: Filter; label: string }[] = [
    { key: 'pending', label: 'Pending' },
    { key: 'approved', label: 'Approved' },
    { key: 'disabled', label: 'Disabled' },
    { key: 'all', label: 'Total' },
  ];

  // Placed after every hook so hook order stays unconditional across renders.
  if (!isCognito) return <ExternalIdpNotice provider={identityProvider} />;

  return (
    <div className="admin-tab">
      {/* What offboarding keeps, stated rather than left to be discovered (tenet D11). */}
      <p className="um-offboarding-note" data-testid="offboarding-keeps">{translate('admin.userManagement.offboardingKeeps')}</p>

      {/* Summary cards — doubles as filter */}
      <div className="um-summary">
        {statItems.map(({ key, label }) => (
          <div
            key={key}
            className={`um-stat ${filter === key ? 'um-stat--active' : ''}`}
            onClick={() => setFilter(key)}
            role="button"
            tabIndex={0}
          >
            <div className="um-stat-count">{counts[key]}</div>
            <div className="um-stat-label">{label}</div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="um-toolbar">
        <h3>
          {filter === 'all' ? 'All Users' : `${filter.charAt(0).toUpperCase() + filter.slice(1)} Users`}
        </h3>
        <div className="um-toolbar-actions">
          {GUEST_EXPERIENCE_SHOWN && <label className="um-group-toggle" title={translate('admin.userManagement.showVisitors', { count: visitors })}>
            <input type="checkbox" checked={showVisitors} onChange={(e) => setShowVisitors(e.target.checked)} aria-label={translate('admin.userManagement.showVisitors', { count: visitors })} />
            <span>{translate('admin.userManagement.showVisitors', { count: visitors })}</span>
          </label>}
          <span className="um-user-count">{filteredUsers.length} user{filteredUsers.length !== 1 ? 's' : ''}</span>
          <button className="btn-secondary" onClick={loadUsers} disabled={isLoading}>
            <span className="um-refresh-icon" />
            {isLoading ? 'Loading' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="um-error">
          <span>{error}</span>
          <button className="um-error-dismiss" onClick={() => setError(null)} aria-label={translate('admin.userManagement.dismiss')}>&times;</button>
        </div>
      )}

      {/* One person's details, where their teams and groups are chosen. */}
      {detailUser && (() => {
        const user = detailUser;
        const status = getUserStatus(user);
        const isBusy = actionInProgress === entryKey(user);
        const poolAccount = user.account === 'pool' && !!user.username;
        const awaitingApproval = poolAccount && status === 'pending';
        const label = user.displayName || user.email || user.username || user.personId || '';
        return (
          <section className="admin-config-group" aria-labelledby="um-detail-title" data-testid="person-detail">
            <button className="btn-link" onClick={() => setDetailKey(null)}>← {translate('admin.userManagement.backToUsers')}</button>
            <h4 id="um-detail-title">{label}</h4>
            <dl className="admin-config-list">
              {user.email && <><dt>{translate('admin.userManagement.email')}</dt><dd>{user.email}</dd></>}
              <dt>{translate('admin.userManagement.status')}</dt>
              <dd>{status === 'pending' ? translate('admin.userManagement.awaitingApproval') : status === 'approved' ? translate('admin.userManagement.active') : translate('admin.userManagement.disabled')}</dd>
              <dt>{translate('admin.userManagement.clearance')}</dt><dd>{user.tier ? classificationName(user.tier) : translate('admin.userManagement.noClearance')}</dd>
            </dl>
            <fieldset className="admin-choice-group" data-testid="person-teams-edit">
              <legend>{translate('admin.userManagement.teamsTitle')}</legend>
              <p className="admin-field-hint">{translate('admin.userManagement.teamsHelp')}</p>
              {!poolAccount ? (
                <p className="admin-muted">{translate('admin.userManagement.groupsAtProvider')}</p>
              ) : teams.length === 0 ? (
                <p className="admin-muted">{translate('admin.userManagement.teamsNone')}</p>
              ) : teams.map((team) => (
                <label key={team} className="admin-choice">
                  <input type="checkbox" checked={(user.teams || []).includes(team)}
                    disabled={isBusy || !user.enabled || status === 'pending'}
                    onChange={(e) => handleTeam(user.username!, team, e.target.checked)} />
                  <span><strong>{teamName(team)}</strong></span>
                </label>
              ))}
              {awaitingApproval && <p className="admin-field-hint">{translate('admin.userManagement.teamsAfterApproval')}</p>}
            </fieldset>
            <fieldset className="admin-choice-group" data-testid="person-groups-edit">
              <legend>{translate('admin.userManagement.groupsTitle')}</legend>
              <p className="admin-field-hint">{translate('admin.userManagement.groupsHelp')}</p>
              {!poolAccount ? (
                <p className="admin-muted">{translate('admin.userManagement.groupsAtProvider')}</p>
              ) : membershipGroups.length === 0 ? (
                <p className="admin-muted">{translate('admin.userManagement.groupsNone')}</p>
              ) : membershipGroups.map(({ name: group, requires }) => {
                const inGroup = (user.membershipGroups || []).includes(group);
                // Named with the clearance it requires, so an operator knows why a person below it is refused
                // rather than finding out from the error.
                return (
                  <label key={group} className="admin-choice">
                    <input type="checkbox" checked={inGroup}
                      disabled={isBusy || !user.enabled || status === 'pending'}
                      onChange={(e) => handleMembershipGroup(user.username!, group, e.target.checked)} />
                    <span>
                      <strong>{group}</strong>
                      <span className="admin-field-hint">{translate('admin.userManagement.groupRequires', { requires: classificationName(requires) })}</span>
                    </span>
                  </label>
                );
              })}
              {awaitingApproval && <p className="admin-field-hint">{translate('admin.userManagement.groupsAfterApproval')}</p>}
            </fieldset>
          </section>
        );
      })()}

      {/* Content */}
      {detailUser ? null : isLoading ? (
        <div className="um-loading">
          <div className="um-loading-spinner" />
          <div className="um-loading-text">{translate('admin.userManagement.loadingUsers')}</div>
        </div>
      ) : filteredUsers.length === 0 ? (
        <div className="um-empty">
          <div className="um-empty-icon">{filter === 'pending' ? '\u2709' : '\u2713'}</div>
          {filter === 'pending' ? translate('admin.userManagement.noPendingApprovals') : `No ${filter === 'all' ? '' : filter + ' '}users`}
        </div>
      ) : (
        <div className="um-user-list">
          {filteredUsers.map(user => {
            const status = getUserStatus(user);
            const tier = user.tier || 'none';
            // The clearance group the person's recorded clearance names: the group itself, or the group that clears for it.
            const clearanceGroup = clearanceGroups.find((g) => g.name === tier)?.name
              ?? clearanceGroups.find((g) => g.clears === tier)?.name
              ?? 'none';
            const isBusy = actionInProgress === entryKey(user);
            const poolAccount = user.account === 'pool' && !!user.username;
            const label = user.displayName || user.email || user.username || user.personId || '';

            return (
              <div
                key={entryKey(user)}
                className={`um-card ${status === 'disabled' ? 'um-card--disabled' : ''} ${status === 'pending' ? 'um-card--pending' : ''}`}
              >
                <div className="um-card-info">
                  <div className={`um-avatar ${user.tier ? 'um-avatar--cls' : 'um-avatar--none'}`} style={user.tier ? classificationBadgeStyle(user.tier) : undefined}>
                    {getInitials(label)}
                  </div>
                  <div className="um-card-details">
                    <div className="um-card-email">{label}</div>
                    <div className="um-card-meta">
                      <span className={`um-status-dot um-status-dot--${status}`} />
                      <span>{status === 'pending' ? translate('admin.userManagement.awaitingApproval') : status === 'approved' ? 'Active' : 'Disabled'}</span>
                      <span className="um-card-meta-sep" />
                      <span>{formatDate(user.createdAt)}</span>
                      <span className="um-card-meta-sep" />
                      <span className={`um-tier-badge ${user.tier ? 'um-tier-badge--cls' : 'um-tier-badge--none'}`} style={user.tier ? classificationBadgeStyle(user.tier) : undefined}>{user.tier ? classificationName(user.tier) : tier}</span>
                      {!user.personArn && (
                        <><span className="um-card-meta-sep" /><span>{translate('admin.userManagement.notSignedInYet')}</span></>
                      )}
                      {user.account === 'other' && (
                        <><span className="um-card-meta-sep" /><span>{translate('admin.userManagement.otherIssuer')}</span></>
                      )}
                      {!user.enabled && user.account === 'other' && (
                        <><span className="um-card-meta-sep" /><span>{translate('admin.userManagement.disabledAtProvider')}</span></>
                      )}
                      {(user.issuers?.length ?? 0) > 0 && (
                        <><span className="um-card-meta-sep" /><span data-testid="person-issuers">{translate('admin.userManagement.issuers', { issuers: user.issuers!.join(', ') })}</span></>
                      )}
                      {GUEST_EXPERIENCE_SHOWN && user.guest && (
                        <><span className="um-card-meta-sep" /><span>{translate('admin.userManagement.visitor')}</span></>
                      )}
                    </div>
                  </div>
                </div>

                <div className="um-card-actions">
                  {isBusy ? (
                    <div className="um-action-spinner" />
                  ) : (
                    <>
                      {poolAccount && (<>
                      <select
                        className="select"
                        value={clearanceGroup}
                        disabled={isBusy || !user.enabled}
                        onChange={(e) => handleTierChange(user.username!, e.target.value)}
                      >
                        <option value="none" disabled>--</option>
                        {clearanceGroups.map(({ name, clears }) => (
                          <option key={name} value={name}>{classificationName(clears)}</option>
                        ))}
                      </select>
                      </>)}

                      {/* GROUPS ARE SHOWN ON THE ROW AND CHANGED IN THE PERSON'S DETAILS: a checkbox per group on every row
                          reads as one setting while there is one group and becomes a wall of them once there are several. */}
                      {(user.teams?.length ?? 0) > 0 && (
                        <span className="um-groups" data-testid="person-teams">
                          {user.teams!.map((tm) => <span key={tm} className="admin-chip">{teamName(tm)}</span>)}
                        </span>
                      )}
                      {(user.membershipGroups?.length ?? 0) > 0 && (
                        <span className="um-groups" data-testid="person-groups">
                          {user.membershipGroups!.map((g) => <span key={g} className="admin-chip">{g}</span>)}
                        </span>
                      )}
                      <button className="btn-secondary" onClick={() => setDetailKey(entryKey(user))}
                        aria-label={translate('admin.userManagement.detailsFor', { name: label })}>
                        {translate('admin.userManagement.details')}
                      </button>

                      {poolAccount && status === 'pending' && (
                        <>
                          {/*
                            DISABLED UNTIL A CLEARANCE IS CHOSEN. A pending user has no `custom:tier`,
                            so the select above sits on its disabled `none` placeholder and Approve
                            used to post that - the API defaulted it to the floor and granted a
                            clearance nobody picked. There is no floor to default to now (ADR-046) and
                            the API refuses `none`, so offering the button would offer a guaranteed
                            400. The operator names the clearance, which is the decision anyway.
                          */}
                          <button
                            className="btn-primary"
                            disabled={clearanceGroup === 'none'}
                            title={clearanceGroup === 'none' ? translate('admin.userManagement.chooseAClearanceFirst') : undefined}
                            onClick={() => handleApprove(user.username!, clearanceGroup)}
                          >
                            Approve
                          </button>
                          <button className="btn-danger" onClick={() => handleReject(user.username!)}>
                            Reject
                          </button>
                        </>
                      )}
                      {poolAccount && status === 'approved' && (
                        <button className="btn-danger" onClick={() => handleReject(user.username!)}>
                          Disable
                        </button>
                      )}
                      {poolAccount && status === 'disabled' && (
                        <button className="btn-secondary" onClick={() => handleEnable(user.username!)}>
                          Re-enable
                        </button>
                      )}
                      {can('export-users') && user.personArn && (
                        <button className="btn-secondary" onClick={() => handleExport(user)}>
                          {translate('admin.userManagement.export')}
                        </button>
                      )}
                      {can('delete-users') && (
                        <button className="btn-danger" onClick={() => handleDelete(user)}>
                          {translate('admin.userManagement.delete')}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default UserManagementTab;
