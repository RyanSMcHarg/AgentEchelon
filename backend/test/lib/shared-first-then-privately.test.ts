/**
 * SHARED FIRST, IN THE OPEN. THEN EACH PERSON PRIVATELY (DESIGN 2.4.2).
 *
 * A queue can hold several people's messages, and they are not the same kind of thing. What is
 * everyone's belongs in the room, where everyone can see what was understood and what is being done.
 * What one person sent privately belongs with that person alone, and putting it in the same public
 * paragraph would publish it in the act of confirming it.
 *
 * THE ORDER IS THE RULE, NOT A CONVENIENCE. Shared subjects are addressed and acted on first, and do
 * not wait on anybody's private answer: a room whose common work is blocked while one person is asked
 * about something the others cannot see is a room where nothing visible is happening, for no visible
 * reason.
 */

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: class { send = (...a: unknown[]) => mockSend(...a); },
  SendChannelMessageCommand: class { constructor(public input: any) {} },
}));

import { ownWords } from '../helpers/own-templates';
import {
  privateSubjectsByRequestor,
  sendPrivateFollowUps,
  addressingPrivatelyLine,
} from '../../lambda/src/lib/turn-private-followup';

const ALICE = 'arn:aws:chime:us-east-1:1:app-instance/i/user/alice';
const BOB = 'arn:aws:chime:us-east-1:1:app-instance/i/user/bob';
const CHANNEL = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/atlas';
// The app instance is what turns a stored principal id back into an address.
const INSTANCE = 'arn:aws:chime:us-east-1:1:app-instance/i';

const SUBJECTS = [
  { label: 'the failed deploy' },
  { label: 'my expenses query', private: true, requestorId: 'alice' },
  { label: 'my leave dates', private: true, requestorId: 'alice' },
  { label: 'my laptop request', private: true, requestorId: 'bob' },
];

const chime = { send: (...a: unknown[]) => mockSend(...a) } as never;

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue({});
});

describe('grouping the private half by person', () => {
  it('gives each person one message covering everything of theirs', () => {
    // BY PERSON, not by subject. Three notifications for one turn is how a private channel becomes
    // something people mute.
    expect(privateSubjectsByRequestor(SUBJECTS)).toEqual([
      { requestorId: 'alice', labels: ['my expenses query', 'my leave dates'] },
      { requestorId: 'bob', labels: ['my laptop request'] },
    ]);
  });

  it('leaves shared subjects out of the private half entirely', () => {
    const labels = privateSubjectsByRequestor(SUBJECTS).flatMap((g) => g.labels);

    // They were dealt with in the room already. Repeating them privately would tell one person the
    // shared work was somehow theirs.
    expect(labels).not.toContain('the failed deploy');
  });

  it('has nothing to do when nothing was private', () => {
    expect(privateSubjectsByRequestor([{ label: 'the failed deploy' }])).toEqual([]);
  });
});

describe('reaching each person, and only them', () => {
  it('addresses every message to the person whose request it is', async () => {
    await sendPrivateFollowUps({
      chime, channelArn: CHANNEL, botArn: BOT, appInstanceArn: INSTANCE, groups: privateSubjectsByRequestor(SUBJECTS),
    });

    expect(mockSend).toHaveBeenCalledTimes(2);
    const targets = mockSend.mock.calls.map((c: any[]) => c[0].input.Target);
    // WITHOUT THIS the message is in the room, and confirming a private request becomes publishing it.
    expect(targets).toEqual([[{ MemberArn: ALICE }], [{ MemberArn: BOB }]]);
  });

  it('never names one person subject in another person message', async () => {
    await sendPrivateFollowUps({
      chime, channelArn: CHANNEL, botArn: BOT, appInstanceArn: INSTANCE, groups: privateSubjectsByRequestor(SUBJECTS),
    });

    const toBob = decodeURIComponent(mockSend.mock.calls[1][0].input.Content);
    expect(toBob).toContain('my laptop request');
    expect(toBob).not.toContain('my expenses query');
    expect(toBob).not.toContain('my leave dates');
  });

  it('still reaches the others when one person cannot be reached', async () => {
    mockSend.mockRejectedValueOnce(new Error('Forbidden'));

    const notified = await sendPrivateFollowUps({
      chime, channelArn: CHANNEL, botArn: BOT, appInstanceArn: INSTANCE, groups: privateSubjectsByRequestor(SUBJECTS),
    });

    // One failed send costs that person a confirmation. Throwing would cost the confirmations of
    // everybody after them in the loop, and the shared half has already happened either way.
    expect(notified).toEqual(['bob']);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});

describe('what the room is told while that happens', () => {
  it('says something is happening, and nothing about what', () => {
    const line = addressingPrivatelyLine();

    // Silence reads as a stalled turn; detail defeats the point of the message being private.
    expect(line.toLowerCase()).toContain('private');
    expect(line).not.toContain('alice');
    expect(line).not.toMatch(/\d/);
  });

  it('lets a deployment word it, in the assistant\'s own template', () => {
    expect(addressingPrivatelyLine(ownWords({ addressingPrivately: 'Following up one to one.' }))).toBe('Following up one to one.');
  });
});
