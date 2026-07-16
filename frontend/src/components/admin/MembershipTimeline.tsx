import React from 'react';
import type { AdminMembershipEvent } from '../../types';

interface Props {
  events: AdminMembershipEvent[];
}

const ACTION_LABEL: Record<string, string> = {
  joined: 'joined',
  left: 'left',
  granted_moderator: 'became moderator',
  revoked_moderator: 'lost moderator',
};

function actionClass(action: string): string {
  if (action === 'left' || action === 'revoked_moderator') return 'admin-timeline-dot--leave';
  if (action === 'granted_moderator') return 'admin-timeline-dot--mod';
  return 'admin-timeline-dot--join';
}

/**
 * Vertical audit timeline of membership changes (joins/leaves/moderator),
 * sourced from the conversation archive. Required for audits — Chime exposes
 * only the current membership, not history.
 */
const MembershipTimeline: React.FC<Props> = ({ events }) => {
  if (!events || events.length === 0) {
    return <p className="admin-tab-description">No membership events recorded yet.</p>;
  }
  return (
    <ol className="admin-timeline">
      {events.map((e, i) => (
        <li key={`${e.memberArn}-${e.timestamp}-${i}`} className="admin-timeline-item">
          <span className={`admin-timeline-dot ${actionClass(e.action)}`} aria-hidden />
          <div className="admin-timeline-body">
            <div>
              <strong>{e.memberName}</strong>{' '}
              <span className="admin-timeline-action">{ACTION_LABEL[e.action] || e.action}</span>
              {e.isBot && <span className="badge badge-accent" style={{ marginLeft: 6 }}>bot</span>}
              {e.invitedBy && <span className="admin-timeline-meta"> · by {e.invitedBy}</span>}
            </div>
            <code className="admin-mono-arn">{e.timestamp ? new Date(e.timestamp).toLocaleString() : ''}</code>
          </div>
        </li>
      ))}
    </ol>
  );
};

export default MembershipTimeline;
