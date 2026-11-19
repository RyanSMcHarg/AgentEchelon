/**
 * A PRIVATE ITEM ANSWERED THROUGH AMAZON LEX KEEPS ITS CHOSEN ITEM AND ITS ATTACHMENT (ADR-035, ADR-036).
 *
 * A private item answered by id is a targeted message, which Amazon Chime SDK hands to its assistant's Amazon Lex entry, and
 * Lex carries neither the message's Metadata nor its attachment. What it proves:
 *  - the read that finds the turn's message (`findInboundMessage`) carries its Metadata, with no second read;
 *  - the turn reads the item's id and the file from that Metadata with the readers the channel flow uses, and the id is
 *    honored only where the task service says the sender may answer that item;
 *  - DENY: an id the service does not confirm, a check that fails, a confirmation of another item, a message with no
 *    person sender, and malformed Metadata name no item;
 *  - the router reads it once on a turn Lex entered, shares that read with the rest of the turn, names the item from it
 *    beside the flow's declaration (intersected with the rows the person holds or owns, as the flow's is), and attaches its file.
 */
const mockChimeSend = jest.fn();
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => {
  const actual = jest.requireActual('@aws-sdk/client-chime-sdk-messaging');
  return { ...actual, ChimeSDKMessagingClient: class { send = (...a: unknown[]) => mockChimeSend(...a); } };
});

import { lexEnteredFacts } from '../../lambda/src/lib/lex-entered-message';
import { findInboundMessage } from '../../lambda/src/lib/inbound-message';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const APP = 'arn:aws:chime:us-east-1:1:app-instance/i';
const CHANNEL = `${APP}/channel/c1`;
const SENDER = `${APP}/user/person-a`;
const BOT = `${APP}/bot/advisor`;
const META = JSON.stringify({ task: { id: 'evt-2' }, attachment: { fileKey: 'attachments/c1/person-a/f.pdf', type: 'application/pdf', name: 'f.pdf' } });

beforeEach(() => mockChimeSend.mockReset());

describe('the read that finds the message carries its Metadata', () => {
  it('returns the matched message\'s Metadata beside its id, from the one listing', async () => {
    mockChimeSend.mockResolvedValue({ ChannelMessages: [
      { MessageId: 'm2', Content: 'here it is', Sender: { Arn: SENDER }, Target: [{ MemberArn: BOT }], Metadata: META, CreatedTimestamp: new Date() },
    ] });
    const found = await findInboundMessage({ channelArn: CHANNEL, senderArn: SENDER, botArn: BOT, userMessage: 'here it is' });
    expect(found).toMatchObject({ messageId: 'm2', targeted: true, metadata: META });
    expect(mockChimeSend).toHaveBeenCalledTimes(1);
  });
});

describe('the item and the file a Lex-entered turn reads back', () => {
  const turn = { channelArn: CHANNEL, senderArn: SENDER };

  it('names the item the task service confirms the sender may answer, and attaches the file', async () => {
    const asked: unknown[] = [];
    const facts = await lexEnteredFacts({ metadata: META }, turn, async (input) => { asked.push(input); return { taskId: 'evt-2' }; });
    expect(facts).toEqual({ answersTaskId: 'evt-2', attachment: { fileKey: 'attachments/c1/person-a/f.pdf', contentType: 'application/pdf', name: 'f.pdf' } });
    expect(asked).toEqual([{ channelArn: CHANNEL, taskId: 'evt-2', senderSub: 'person-a' }]);
  });

  it('DENY: an id the service does not confirm, a failed check, or a confirmation of another item names nothing; the file still rides', async () => {
    for (const answer of [async () => null, async () => { throw new Error('throttled'); }, async () => ({ taskId: 'evt-9' })]) {
      const facts = await lexEnteredFacts({ metadata: META }, turn, answer as never);
      expect(facts.answersTaskId).toBeUndefined();
      expect(facts.attachment?.fileKey).toBe('attachments/c1/person-a/f.pdf');
    }
  });

  it('DENY: a message with no person sender is never checked and names nothing', async () => {
    const check = jest.fn(async () => ({ taskId: 'evt-2' }));
    expect((await lexEnteredFacts({ metadata: META }, { channelArn: CHANNEL, senderArn: BOT }, check)).answersTaskId).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it('DENY: malformed or absent Metadata is an ordinary message', async () => {
    const check = jest.fn(async () => ({ taskId: 'evt-2' }));
    expect(await lexEnteredFacts({ metadata: '{not json' }, turn, check)).toEqual({});
    expect(await lexEnteredFacts({ metadata: JSON.stringify({ task: { id: 7 } }) }, turn, check)).toEqual({});
    expect(await lexEnteredFacts(undefined, turn, check)).toEqual({});
    expect(check).not.toHaveBeenCalled();
  });
});

describe('the router reads it once, on a turn Lex entered', () => {
  const router = readFileSync(resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');

  it('reads the message back only on a Lex entry, and checks the item through the task service', () => {
    expect(router).toMatch(/const lexEnteredRead = !isFlowEntry\(event\) && channelArn\s*\? resolveOriginatingMessage\(\{/);
    expect(router).toMatch(/lexEnteredRead\.then\(\(m\) => lexEnteredFacts\(m, \{ channelArn, senderArn: event\.requestAttributes\?\.\['CHIME\.sender\.arn'\] \|\| '' \}, answerableTaskById\)\)/);
  });

  it('starts the read before the classification and awaits it at its first reader, after it', () => {
    const started = router.indexOf('const lexEnteredPending');
    const classified = router.indexOf('await classifyIntent(userMessage, {');
    const awaited = router.indexOf('= await lexEnteredPending;');
    expect(started).toBeGreaterThan(-1);
    expect(started).toBeLessThan(classified);
    expect(awaited).toBeGreaterThan(classified);
    expect(awaited).toBeLessThan(router.indexOf('const turnAttachment = bypassAttachment(event) ?? lexEntered.attachment;'));
  });

  it('attaches its file and names its item where the flow\'s declaration would, and shares the read with the rest of the turn', () => {
    expect(router).toMatch(/const turnAttachment = bypassAttachment\(event\) \?\? lexEntered\.attachment;/);
    expect(router).toMatch(/\? event\.requestAttributes\?\.\[BYPASS_ANSWERS_TASK_ATTR\] \|\| lexEntered\.answersTaskId \|\| null/);
    expect(router).toMatch(/inboundLookup \?\?= \(lexEnteredRead \?\? resolveOriginatingMessage\(\{/);
    // THE DECLARED ITEM IS STILL INTERSECTED WITH THE ROWS THE PERSON HOLDS OR OWNS HERE, whichever entry declared it.
    expect(router).toMatch(/const referenced = declaredTaskId\s*\? answerable\.find\(\(t\) => t\.taskId === declaredTaskId\) \?\? null/);
  });
});
