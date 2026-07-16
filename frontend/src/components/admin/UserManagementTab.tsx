import React, { useState, useEffect, useCallback } from 'react';
import './UserManagementTab.css';

interface User {
  username: string;
  email: string;
  tier: string;
  approved: string;
  status: string;
  enabled: boolean;
  createdAt: string;
}

type Filter = 'all' | 'pending' | 'approved' | 'disabled';

function getApiUrl(): string {
  return import.meta.env.VITE_USER_MANAGEMENT_API_URL || '';
}

async function apiCall(path: string, method: string = 'GET', body?: unknown) {
  const idToken = localStorage.getItem('idToken');
  if (!idToken) throw new Error('Not authenticated');

  const response = await fetch(`${getApiUrl()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    throw new Error(err.error || `Request failed: ${response.status}`);
  }

  return response.json();
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
  return user.approved === 'true' ? 'approved' : 'pending';
}

const UserManagementTab: React.FC = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('pending');
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await apiCall('');
      setUsers(data.users || []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const doAction = async (fn: () => Promise<unknown>) => {
    try { await fn(); await loadUsers(); }
    catch (err) { setError((err as Error).message); }
  };

  const handleApprove = (username: string, tier: string = 'basic') => {
    setActionInProgress(username);
    doAction(() => apiCall('/approve', 'POST', { username, tier })).finally(() => setActionInProgress(null));
  };

  const handleReject = (username: string) => {
    setActionInProgress(username);
    doAction(() => apiCall('/reject', 'POST', { username })).finally(() => setActionInProgress(null));
  };

  const handleEnable = (username: string) => {
    setActionInProgress(username);
    doAction(() => apiCall('/enable', 'POST', { username })).finally(() => setActionInProgress(null));
  };

  const handleTierChange = (username: string, tier: string) => {
    setActionInProgress(username);
    doAction(() => apiCall('/tier', 'POST', { username, tier })).finally(() => setActionInProgress(null));
  };

  const counts = {
    all: users.length,
    pending: users.filter(u => u.approved !== 'true' && u.enabled).length,
    approved: users.filter(u => u.approved === 'true' && u.enabled).length,
    disabled: users.filter(u => !u.enabled).length,
  };

  const filteredUsers = users.filter(user => {
    switch (filter) {
      case 'pending': return user.approved !== 'true' && user.enabled;
      case 'approved': return user.approved === 'true' && user.enabled;
      case 'disabled': return !user.enabled;
      default: return true;
    }
  });

  const statItems: { key: Filter; label: string }[] = [
    { key: 'pending', label: 'Pending' },
    { key: 'approved', label: 'Approved' },
    { key: 'disabled', label: 'Disabled' },
    { key: 'all', label: 'Total' },
  ];

  return (
    <div className="admin-tab">
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
          <span className="um-user-count">{filteredUsers.length} user{filteredUsers.length !== 1 ? 's' : ''}</span>
          <button className="um-refresh-btn" onClick={loadUsers} disabled={isLoading}>
            <span className="um-refresh-icon" />
            {isLoading ? 'Loading' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="um-error">
          <span>{error}</span>
          <button className="um-error-dismiss" onClick={() => setError(null)} aria-label="Dismiss">&times;</button>
        </div>
      )}

      {/* Content */}
      {isLoading ? (
        <div className="um-loading">
          <div className="um-loading-spinner" />
          <div className="um-loading-text">Loading users...</div>
        </div>
      ) : filteredUsers.length === 0 ? (
        <div className="um-empty">
          <div className="um-empty-icon">{filter === 'pending' ? '\u2709' : '\u2713'}</div>
          {filter === 'pending' ? 'No pending approvals' : `No ${filter === 'all' ? '' : filter + ' '}users`}
        </div>
      ) : (
        <div className="um-user-list">
          {filteredUsers.map(user => {
            const status = getUserStatus(user);
            const tier = user.tier || 'none';
            const isBusy = actionInProgress === user.username;

            return (
              <div
                key={user.username}
                className={`um-card ${status === 'disabled' ? 'um-card--disabled' : ''} ${status === 'pending' ? 'um-card--pending' : ''}`}
              >
                <div className="um-card-info">
                  <div className={`um-avatar um-avatar--${tier}`}>
                    {getInitials(user.email || user.username)}
                  </div>
                  <div className="um-card-details">
                    <div className="um-card-email">{user.email || user.username}</div>
                    <div className="um-card-meta">
                      <span className={`um-status-dot um-status-dot--${status}`} />
                      <span>{status === 'pending' ? 'Awaiting approval' : status === 'approved' ? 'Active' : 'Disabled'}</span>
                      <span className="um-card-meta-sep" />
                      <span>{formatDate(user.createdAt)}</span>
                      <span className="um-card-meta-sep" />
                      <span className={`um-tier-badge um-tier-badge--${tier}`}>{tier}</span>
                    </div>
                  </div>
                </div>

                <div className="um-card-actions">
                  {isBusy ? (
                    <div className="um-action-spinner" />
                  ) : (
                    <>
                      <select
                        className="um-tier-select"
                        value={tier}
                        disabled={isBusy || !user.enabled}
                        onChange={(e) => handleTierChange(user.username, e.target.value)}
                      >
                        <option value="none" disabled>--</option>
                        <option value="basic">Basic</option>
                        <option value="standard">Standard</option>
                        <option value="premium">Premium</option>
                      </select>

                      {status === 'pending' && (
                        <>
                          <button className="um-action-btn um-action-btn--approve" onClick={() => handleApprove(user.username, tier)}>
                            Approve
                          </button>
                          <button className="um-action-btn um-action-btn--reject" onClick={() => handleReject(user.username)}>
                            Reject
                          </button>
                        </>
                      )}
                      {status === 'approved' && (
                        <button className="um-action-btn um-action-btn--disable" onClick={() => handleReject(user.username)}>
                          Disable
                        </button>
                      )}
                      {status === 'disabled' && (
                        <button className="um-action-btn um-action-btn--enable" onClick={() => handleEnable(user.username)}>
                          Re-enable
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
