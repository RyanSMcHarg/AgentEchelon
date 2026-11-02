import { describe, it, expect } from 'vitest';
import { mayAnswerSide, personIdOfArn, sidesWaitingOn, waitingSides } from './battleSideReply';

const OWNER = 'arn:aws:chime:us-east-1:111:app-instance/i/user/owner-1';
const OTHER = 'arn:aws:chime:us-east-1:111:app-instance/i/user/dana';

describe('personIdOfArn', () => {
  it('reads the AppInstanceUser id at the end of the ARN', () => {
    expect(personIdOfArn(OWNER)).toBe('owner-1');
  });

  it('is null for no ARN', () => {
    expect(personIdOfArn(null)).toBeNull();
    expect(personIdOfArn('')).toBeNull();
  });
});

describe('mayAnswerSide', () => {
  it('offers the control to the duel owner the marker names', () => {
    expect(mayAnswerSide({ ownerId: 'owner-1' }, OWNER)).toBe(true);
  });

  it('withholds it from every other member', () => {
    expect(mayAnswerSide({ ownerId: 'owner-1' }, OTHER)).toBe(false);
  });

  it('withholds it while the viewer is not yet known', () => {
    expect(mayAnswerSide({ ownerId: 'owner-1' }, null)).toBe(false);
  });

  it('offers it to everyone when the marker names no owner, and the router decides', () => {
    expect(mayAnswerSide({}, OTHER)).toBe(true);
  });
});

describe('waitingSides and sidesWaitingOn', () => {
  const ATLAS = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/Alt-premium';
  const PIXEL = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/assistant-premium';
  const parked = (id: string, botArn: string, ownerId = 'owner-1') => ({
    id, isBot: true, sender: { arn: botArn }, battle: { battleId: 'b1' }, battleWaiting: { battleId: 'b1', botArn, ownerId },
  });

  it('lists each side waiting now, with the message it waits on', () => {
    const sides = waitingSides([parked('m1', ATLAS), parked('m2', PIXEL)]);
    expect(sides).toEqual([
      { battleId: 'b1', botArn: ATLAS, ownerId: 'owner-1', messageId: 'm1' },
      { battleId: 'b1', botArn: PIXEL, ownerId: 'owner-1', messageId: 'm2' },
    ]);
  });

  it('a side that posts its next round message has moved on', () => {
    const resumed = { id: 'm3', isBot: true, sender: { arn: ATLAS }, battle: { battleId: 'b1' } };
    expect(waitingSides([parked('m1', ATLAS), parked('m2', PIXEL), resumed]).map((s) => s.botArn)).toEqual([PIXEL]);
  });

  it('a side that parks again waits on its latest step, not the earlier one', () => {
    expect(waitingSides([parked('m1', ATLAS), parked('m4', ATLAS)]).map((s) => s.messageId)).toEqual(['m4']);
  });

  it('a person is waited on only by the sides of a duel they started', () => {
    const messages = [parked('m1', ATLAS), parked('m2', PIXEL)];
    expect(sidesWaitingOn(messages, OWNER)).toHaveLength(2);
    expect(sidesWaitingOn(messages, OTHER)).toHaveLength(0);
  });
});
