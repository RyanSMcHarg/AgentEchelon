/**
 * The Amazon Chime SDK Meetings calls the POC makes: a meeting, an attendee per person or phone leg, and
 * deleting both. Standalone: this meeting is not bound to a conversation, unlike `meeting-api.ts`.
 */
import { randomUUID } from 'node:crypto';
import {
  ChimeSDKMeetingsClient,
  CreateMeetingCommand,
  CreateAttendeeCommand,
  DeleteAttendeeCommand,
  DeleteMeetingCommand,
} from '@aws-sdk/client-chime-sdk-meetings';

export function meetingsApi(region) {
  const client = new ChimeSDKMeetingsClient({ region });
  return {
    async createMeeting() {
      const { Meeting } = await client.send(new CreateMeetingCommand({
        ClientRequestToken: randomUUID(),
        MediaRegion: region,
        ExternalMeetingId: `phone-bridge-poc-${Date.now()}`,
      }));
      return Meeting;
    },
    async createAttendee(meetingId, externalUserId) {
      const { Attendee } = await client.send(new CreateAttendeeCommand({ MeetingId: meetingId, ExternalUserId: externalUserId.slice(0, 64) }));
      return Attendee;
    },
    async deleteAttendee(meetingId, attendeeId) {
      await client.send(new DeleteAttendeeCommand({ MeetingId: meetingId, AttendeeId: attendeeId })).catch(() => {});
    },
    async deleteMeeting(meetingId) {
      await client.send(new DeleteMeetingCommand({ MeetingId: meetingId })).catch(() => {});
    },
  };
}
