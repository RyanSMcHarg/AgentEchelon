/**
 * THE MEETING'S RECORD ON THE CONVERSATION'S ROW IS WRITTEN BY ONE MODULE (`channel-context-client.ts`): a host's sets
 * (`activeMeeting.heldPersonIds`, `removedPersonIds`, `speakRequestIds`) and the recording parts (`lastMeeting.recordings`)
 * are read and written there, on its one client and table, so the row's shape, its `meetingId` guards and its client are
 * in one place. The modules that decide those changes send no DynamoDB command of their own.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', 'lambda', 'src', 'lib');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

describe('the meeting record on the conversation row', () => {
  it.each(['meeting-host-controls.ts', 'meeting-media-capture.ts'])('%s sends no DynamoDB command of its own', (file) => {
    const src = read(file);
    expect(src).not.toMatch(/from '@aws-sdk\/client-dynamodb'/);
    expect(src).not.toMatch(/\bnew (GetCommand|UpdateCommand|PutCommand|DeleteCommand)\(/);
  });

  it('channel-context-client writes the sets and the recording parts', () => {
    const src = read('channel-context-client.ts');
    for (const fn of ['changeMeetingSets', 'readActiveMeetingNow', 'readMeetingRecordings', 'recordMeetingRecordingPart', 'moveMeetingRecordingPart']) {
      expect(src).toMatch(new RegExp(`export async function ${fn}\\(`));
    }
  });
});
