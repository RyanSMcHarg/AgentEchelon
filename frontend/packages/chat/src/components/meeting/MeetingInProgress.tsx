/**
 * A CONVERSATION'S MEETING IS RUNNING, AND THE VIEWER IS NOT IN IT: one line with Join, above the conversation, for a
 * person who arrived late, came back after a drop, left and wants back in, or dismissed the ring (`useConversationMeeting`,
 * read by the conversation and handed here). Join opens the meeting window, or brings forward the one the person already
 * has. Its host and the moderators also see End meeting, which ends it for everyone without joining it; the server
 * holds the same rule.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationMeeting } from '../../hooks/useConversationMeeting';
import { meetingService, type MeetingApiError } from '../../services/meetingService';
import { openMeetingWindow } from '../../utils/meetingWindow';
import './MeetingRoom.css';

export default function MeetingInProgress({ channelArn, meeting }: { channelArn: string; meeting: ConversationMeeting }) {
  const { t } = useTranslation();
  const [ending, setEnding] = useState(false);
  const [errorCode, setErrorCode] = useState<string | undefined>();
  const [ended, setEnded] = useState(false);
  // The end this banner made holds until the service says the meeting no longer runs, so a later meeting shows again.
  useEffect(() => { if (!meeting.running) setEnded(false); }, [meeting.running]);
  if (!meeting.running || meeting.joinedHere || ended) return null;

  const end = async () => {
    setEnding(true);
    setErrorCode(undefined);
    try {
      await meetingService.endMeeting(channelArn);
      setEnded(true);
    } catch (e) {
      setErrorCode((e as MeetingApiError).code || 'END_FAILED');
    } finally {
      setEnding(false);
    }
  };

  return (
    <div className="mention-banner ae-meeting-banner" role="status" data-testid="meeting-in-progress">
      <div className="mention-banner-body">
        {t('meeting.inProgress')}
        {errorCode && (
          <span className="ae-meeting-error" role="alert"> {t([`meeting.errors.${errorCode}`, 'meeting.errors.END_FAILED'])}</span>
        )}
      </div>
      <button type="button" className="ae-meeting-join-btn" onClick={() => openMeetingWindow(channelArn, meeting.meetingConversationId)}>
        {t('meeting.join')}
      </button>
      {meeting.mayEnd && (
        <button type="button" className="ae-meeting-join-btn ae-meeting-join-btn--danger" onClick={() => { void end(); }} disabled={ending}>
          {ending ? t('meeting.ending') : t('meeting.end')}
        </button>
      )}
    </div>
  );
}
