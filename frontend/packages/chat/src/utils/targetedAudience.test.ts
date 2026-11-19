/**
 * WHO CAN SEE A TARGETED MESSAGE (`targetedAudience.ts`): the sender reads it as theirs and the recipient's, the
 * recipient as theirs and the sender's, and a message the room reads says nothing.
 */
import { describe, it, expect } from 'vitest';
import en from '@ae/shared/locales/en.json';
import { targetedAudienceOf } from './targetedAudience';

const I = 'arn:aws:chime:us-east-1:1:app-instance/i';
const ME = `${I}/user/me`;
const ALICE = `${I}/user/alice`;
const OPS = `${I}/bot/ops`;
const MEMBERS = [{ userArn: ME, name: 'Me' }, { userArn: ALICE, name: 'Alice' }, { userArn: OPS, name: 'Ops' }];

describe('who can see a targeted message', () => {
  it('names the recipient to the sender', () => {
    expect(targetedAudienceOf({ sender: { arn: ME, name: 'You' }, targetArns: [ALICE] }, ME, MEMBERS))
      .toEqual({ side: 'sender', names: ['Alice'] });
  });

  it('names the sender to the recipient', () => {
    expect(targetedAudienceOf({ sender: { arn: OPS, name: 'Ops' }, targetedToUser: true }, ME, MEMBERS))
      .toEqual({ side: 'recipient', name: 'Ops' });
  });

  it('says nothing on a message the room reads', () => {
    expect(targetedAudienceOf({ sender: { arn: ALICE, name: 'Alice' } }, ME, MEMBERS)).toBeNull();
    expect(targetedAudienceOf({ sender: { arn: ME, name: 'You' } }, ME, MEMBERS)).toBeNull();
  });

  it('has its words in the locale', () => {
    expect(en.message.onlyYouAnd).toContain('{{names}}');
    expect(en.message.onlyYouAndRecipient).toBeTruthy();
    expect(en.message.onlyYouAndSender).toBeTruthy();
  });

  it('says the audience is the people in this conversation, which is what Target limits', () => {
    expect(en.message.onlyYouAnd).toBe('Only you and {{names}} in this conversation can see this');
    expect(en.message.onlyYouAndRecipient).toMatch(/in this conversation can see this$/);
    expect(en.message.onlyYouAndSender).toMatch(/in this conversation can see this$/);
  });
});
