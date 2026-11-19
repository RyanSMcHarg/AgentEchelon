/**
 * THE `meetings` CAPABILITY NAMES EACH CHANGE IT MAKES TO ANOTHER STACK (`capabilities.ts` `attaches`). Each grant a core
 * or classification stack builds only where `meetings` is declared is named in the capability's attach list, so the
 * registry says everything declaring it changes.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { capabilityDefinition } from '../lib/config/capabilities';

const source = (file: string) => readFileSync(join(__dirname, '..', 'lib', 'stacks', file), 'utf8');

describe('the meetings capability\'s attach list', () => {
  const attaches = capabilityDefinition('meetings')!.attaches;
  const named = (stack: string) => attaches.filter((a) => a.stack === stack).map((a) => a.change).join('\n');

  it.each([
    ['AssistantTranscriptRead', 'TRANSCRIPT_BUCKET'],
    ['ProcessorMeetingInviteeNames', 'ProcessorMeetingInviteeNames'],
    ['TypedCreatorReadsRoomMembership', 'TypedCreatorReadsRoomMembership'],
    ['MEETING_RING_SECONDS', 'MEETING_RING_SECONDS'],
    ['CONVERSATION_MANAGEMENT_FUNCTION', 'CONVERSATION_MANAGEMENT_FUNCTION'],
  ])('names the classification stack\'s %s', (built, words) => {
    expect(source('assistant-profile-stack.ts')).toContain(built);
    expect(named('Assistants-*')).toContain(words);
  });

  it('names the attachments bucket\'s recording sink on the Conversations stack', () => {
    expect(source('conversations-stack.ts')).toContain('meetingRecordingsSinkStatements');
    expect(named('Conversations')).toContain('meetingRecordingsSinkStatements');
  });
});

describe('the console\'s meetings function', () => {
  it('is told the deployment\'s longest meeting, so a meeting within it is never folded as abandoned', () => {
    const stack = source('admin-services-stack.ts');
    const start = stack.indexOf("'AdminMeetingsFunction'");
    const block = stack.slice(start, stack.indexOf('bundling:', start));
    expect(start).toBeGreaterThan(0);
    expect(block).toContain('MEETING_MAX_MINUTES: meetingMaxMinutes');
    expect(stack).toContain("this.node.tryGetContext('meetingMaxMinutes')");
  });

  it('is told the experience thresholds the deployment tunes', () => {
    const stack = source('admin-services-stack.ts');
    const start = stack.indexOf("'AdminMeetingsFunction'");
    const block = stack.slice(start, stack.indexOf('bundling:', start));
    expect(block).toContain('MEETING_EXPERIENCE_THRESHOLDS: meetingExperienceThresholds');
    expect(stack).toContain("this.node.tryGetContext('meetingExperienceThresholds')");
  });
});
