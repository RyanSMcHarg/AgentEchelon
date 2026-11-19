/**
 * THE WORKFLOWS BY ROOM TYPE: the same workflows as the list above, read from the room's side. For each kind of
 * conversation (the ops team room, an ops incident room, a meeting's conversation, an ordinary one), what runs there and
 * what starts it, each marked as the assistant's own or the platform's. A workflow belongs to the assistant's version and
 * names the room types it runs in, so this view is derived from the version (`workflowsByRoomType`) and edits nothing.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { EventWorkflow } from '../../../../../../backend/lambda/src/lib/event-workflow.ts';
import { workflowsByRoomType } from './assistantSections';

const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(' ');

const RoomTypeWorkflows: React.FC<{ name: string; workflows: Readonly<Record<string, EventWorkflow>> | null | undefined; classification?: string | null }> = ({ name, workflows, classification }) => {
  const { t } = useTranslation();
  const rooms = workflowsByRoomType(workflows, classification);
  return (
    <section data-testid="workflows-by-room-type">
      <h3>{t('admin.workflowsByRoom.heading')}</h3>
      <p className="admin-field-hint">{t('admin.workflowsByRoom.help', { name })}</p>
      <ul className="admin-workflow-list">
        {rooms.map(({ type, workflows: rows }) => (
          <li key={type} className="admin-workflow-item" data-testid={`workflows-room-${type}`}>
            <div className="admin-workflow-item-head"><code>{type}</code></div>
            <ul>
              {rows.map((r) => (
                <li key={r.name} data-testid={`workflows-room-${type}-${r.name}`}>
                  <span>{t([`admin.eventWorkflows.eventShort.${r.on}`, 'admin.workflowsByRoom.otherEvent'], { event: r.on })}</span>
                  {': '}
                  <code>{r.name}</code>{' '}
                  <span className={cx('admin-chip', r.own ? 'admin-chip-own' : 'admin-chip-platform')}>
                    {r.own ? t('admin.assistantPage.ownedBy', { name }) : t('admin.assistantPage.platformChip')}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
};

export default RoomTypeWorkflows;
