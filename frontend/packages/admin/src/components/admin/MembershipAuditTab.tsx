import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  listFindings,
  getEnforce,
  setEnforce,
  revokeFinding,
  type MembershipAuditFinding,
} from '../../services/membershipAuditService';
import DataTable from './DataTable';
import { GuideLinks, guide } from './AdminHelp';

function shortArn(arn: string): string {
  const i = arn.indexOf('/');
  return i === -1 ? arn : arn.slice(i + 1);
}

const MembershipAuditTab: React.FC = () => {
  const { t: translate } = useTranslation();
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
        <h3>{translate('admin.membershipAudit.membershipAudit')}</h3>
        <div role="group" aria-label={translate('admin.membershipAudit.enforcementMode')} className="admin-filter-group">
          <button className="admin-filter-btn" aria-pressed={!enforce} disabled={busy === 'enforce'} onClick={() => toggleEnforce(false)}>
            Report only
          </button>
          <button className="admin-filter-btn" aria-pressed={enforce} disabled={busy === 'enforce'} onClick={() => toggleEnforce(true)}>
            Auto-revoke
          </button>
        </div>
      </div>

      <p className="admin-tab-description" style={{ maxWidth: 640 }}>
        Members and assistants flagged by the Layer 6 audit as not cleared for the conversation's
        classification. Enforcement is a runtime toggle: report-only
        alerts a security event; auto-revoke removes the membership. Review a finding, then revoke
        it to remove the member.
      </p>
      <GuideLinks guides={[guide(translate('admin.guides.membershipAudit.identity'), 'adminIdentity')]} />

      {error && (
        <div className="admin-error">
          <span>{error}</span>
          <button className="btn-secondary" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {isLoading ? (
        <div className="admin-tab-loading">{translate('admin.membershipAudit.loadingFindings')}</div>
      ) : (
        <DataTable
          data={open}
          emptyMessage={
            enforce
              ? translate('admin.membershipAudit.noOpenFindingsAutoRevoke')
              : translate('admin.membershipAudit.noOpenFindingsReportOnly')
          }
          columns={[
            { key: 'ts', label: 'When', render: (v) => new Date(v as string | number).toLocaleString() },
            { key: 'kind', label: 'Type' },
            // The keys the finding is actually STORED under (`membership-audit.ts` spreads them in).
            // These read `subjectTier` / `channelTier`, which the record has never carried, so both
            // columns were blank on every row. The labels follow ADR-046 too: a holder has a
            // clearance, a channel has a classification, and this console is an operator surface
            // where that internal vocabulary is the correct one.
            { key: 'subjectClearance', label: translate('admin.membershipAudit.subjectClearance') },
            { key: 'channelClassification', label: translate('admin.membershipAudit.channelClassification') },
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
                  <button className="btn-danger"
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
