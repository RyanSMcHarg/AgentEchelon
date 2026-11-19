/**
 * A LIVE MEETING'S "RUNNING FOR", counted on the viewer's clock (`useNow`). The clock lives in this element alone, so each
 * second re-renders only the length and never the page around it (the timeline, the roster, each person's panel).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from './useNow';
import { formatSeconds } from './meetingFormat';

export const RunningFor: React.FC<{ startedAt: string }> = ({ startedAt }) => {
  const { t } = useTranslation();
  const now = useNow(true);
  return <>{t('admin.meetings.live.runningFor', { length: formatSeconds((now - Date.parse(startedAt)) / 1000) })}</>;
};

export default RunningFor;
