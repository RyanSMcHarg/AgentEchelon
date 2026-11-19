/**
 * Every data message topic the meeting app sends or listens on is one the Amazon Chime SDK accepts. The SDK validates a
 * topic on send and throws on one outside its pattern, and that throw ends the sender's session, so the check reads the
 * pattern out of the installed SDK itself rather than a copy of it.
 */
import { describe, expect, it } from 'vitest';
import SendAndReceiveDataMessagesTask from 'amazon-chime-sdk-js/build/task/SendAndReceiveDataMessagesTask';
import { TRANSCRIPTION_TOPIC } from './meetingTranscription';
import { HOST_CONTROL_TOPIC } from '../providers/meetingSignals';

const sdkTopicPattern = (SendAndReceiveDataMessagesTask as unknown as { TOPIC_REGEX: RegExp }).TOPIC_REGEX;

describe('meeting data message topics', () => {
  it('reads the topic pattern from the installed SDK', () => {
    expect(sdkTopicPattern).toBeInstanceOf(RegExp);
  });

  it.each([
    ['HOST_CONTROL_TOPIC', HOST_CONTROL_TOPIC],
    ['TRANSCRIPTION_TOPIC', TRANSCRIPTION_TOPIC],
  ])('%s is a topic the SDK sends', (_name, topic) => {
    expect(sdkTopicPattern.test(topic)).toBe(true);
  });
});
