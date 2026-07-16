import React, { useState, useEffect, useCallback } from 'react';
import {
  listFindings,
  getEnforce,
  setEnforce,
  revokeFinding,
  type MembershipAuditFinding,
} from '../../services/membershipAuditService';
import DataTable from './DataTable';
import { DocLink } from './AdminHelp';
import { DOC_LINKS } from '../../config/docLinks';

function shortArn(arn: string): string {
  const i = arn.indexOf('/');
  return i === -1 ? arn : arn.slice(i + 1);
}

// Segmented toggle, using design tokens (violet accent — matches the system,
// not the old undefined `--accent-color` that fell back to blue).
const toggleBtn = (active: boolean): React.CSSProperties => ({
  padding: '6px 14px',
  border: `1px solid ${active ? 'var(--accent-500)' : 'var(--surface-200)'}`,
  background: active ? 'var(--accent-500)' : 'var(--surface-0)',
  color: active ? 'var(--text-on-accent)' : 'var(--text-secondary)',
  borderRadius: 'var(--radius-md)',
  fontSize: 'var(--text-sm)',
  fontWeight: 500,
  cursor: 'pointer',
});

const MembershipAuditTab: React.FC = () => {
  const [findings, setFindings] = useState<MembershipAuditFinding[]>([]);
  const [enforce, setEnforceState] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const [f, e] = await Promise.all([listFindings(), getEnforce()]);
      setFindings(f);
      setEnforceState(e);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleEnforce = async (value: boolean) => {
    setBusy('enforce');
    setError(null);
    try {
      setEnforceState(await setEnforce(value));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (f: MembershipAuditFinding) => {
    setBusy(f.sk);
    setError(null);
    try {
      await revokeFinding(f.channelArn, f.memberArn, f.sk);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const open = findings.filter((f) => f.status === 'open');

  return (
    <div className="admin-tab">
      <div className="admin-tab-header">
        <h3>Membership audit</h3>
        <div role="group" aria-label="Enforcement mode" style={{ display: 'flex', gap: 6 }}>
          <button style={toggleBtn(!enforce)} disabled={busy === 'enforce'} onClick={() => toggleEnforce(false)}>
            Report only
          </button>
          <button style={toggleBtn(enforce)} disabled={busy === 'enforce'} onClick={() => toggleEnforce(true)}>
            Auto-revoke
          </button>
        </div>
      </div>

      <p className="admin-tab-description" style={{ maxWidth: 640 }}>
        Over-tier members and assistants flagged by the Layer 6 audit — a membership whose tier
        exceeds the conversation's classification. Enforcement is a runtime toggle: report-only
        alerts a security event; auto-revoke removes the membership. Review a finding, then revoke
        it to remove the over-tier member.{' '}
        <DocLink href={DOC_LINKS.adminIdentity}>How this works</DocLink>
      </p>

      {error && (
        <div className="admin-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {isLoading ? (
        <div className="admin-tab-loading">Loading findings…</div>
      ) : (
        <DataTable
          data={open}
          emptyMessage={
            enforce
              ? 'No open findings. Auto-revoke is on.'
              : 'No open findings. Report-only: findings are alerted, not revoked.'
          }
          columns={[
            { key: 'ts', label: 'When', render: (v) => new Date(v as string | number).toLocaleString() },
            { key: 'kind', label: 'Type' },
            { key: 'subjectTier', label: 'Subject tier' },
            { key: 'channelTier', label: 'Channel tier' },
            {
              key: 'memberArn',
              label: 'Member',
              sortable: false,
              render: (v) => <span className="font-mono" title={String(v)}>{shortArn(String(v))}</span>,
            },
            {
              key: 'channelArn',
              label: 'Channel',
              sortable: false,
              render: (v) => <span className="font-mono" title={String(v)}>{shortArn(String(v))}</span>,
            },
            {
              key: 'sk',
              label: '',
              sortable: false,
              render: (_v, row) => {
                const f = row as MembershipAuditFinding;
                return (
                  <button
                    style={{
                      padding: '4px 10px',
                      border: '1px solid var(--surface-200)',
                      background: 'var(--surface-0)',
                      color: 'var(--status-bad)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 'var(--text-sm)',
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                    disabled={busy === f.sk}
                    onClick={() => revoke(f)}
                  >
                    {busy === f.sk ? '…' : 'Revoke'}
                  </button>
                );
              },
            },
          ]}
        />
      )}
    </div>
  );
};

export default MembershipAuditTab;
