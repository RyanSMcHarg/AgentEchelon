/**
 * WHAT A MEETING RECORD KEEPS OF TEXT IS CUT BETWEEN CHARACTERS, AND WHAT A CARD NAMES IS WHAT ITS PROPOSAL APPLIES.
 *
 *  - an app's reported text is cut on a code point boundary and kept well formed, so the projection's `jsonb` never
 *    refuses a report for a split character (`wellFormedPrefix`);
 *  - an invitee shown on a meeting proposal's card by their account's name is shown by a name the confirmed proposal's
 *    apply accepts, so a confirmation never fails on a name (`cardNameOf`).
 */
import { keptAttributes } from '../../lambda/src/lib/meeting-client-events';
import { wellFormedPrefix } from '../../lambda/src/lib/meeting-event-shape';
import { cardNameOf } from '../../lambda/src/lib/meeting-invite-offer';
import { meetingInvitesFromInput, MAX_INVITE_LABEL } from '../../lambda/src/lib/meeting-invites';
import { proposalDraftRefusal } from '../../lambda/src/lib/proposals';

const hasLoneSurrogate = (s: string): boolean => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('a report\'s text is cut whole', () => {
  it('never leaves half of a character where the cut falls inside it, and the projection can store it', () => {
    const message = `${'x'.repeat(199)}\u{1F600} more`;
    const kept = keptAttributes({ errorMessage: message }).errorMessage as string;
    expect(hasLoneSurrogate(kept)).toBe(false);
    expect(kept.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(kept)).not.toMatch(/\\ud83d/i);
  });

  it('replaces a lone surrogate the app sent, and keeps whole characters within the limit', () => {
    expect(hasLoneSurrogate(wellFormedPrefix('ok \uD83D end', 50))).toBe(false);
    expect(wellFormedPrefix('ab\u{1F600}c', 4)).toBe('ab\u{1F600}');
    expect(wellFormedPrefix('ab\u{1F600}c', 3)).toBe('ab');
  });
});

describe('a card names each invitee as the confirmed proposal applies them', () => {
  const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/abc';
  const invite = (name: string) => ({ person: `${APP}/user/p1`, name, accounts: ['Acme'], brief: 'Joining for the renewal.' });

  it('an account named by an address shows its local part, which the apply accepts', () => {
    const name = cardNameOf('jane.doe@corp.example.com', 'Jane');
    expect(name).toBe('jane.doe');
    expect(proposalDraftRefusal(name)).toBeUndefined();
    expect('invites' in meetingInvitesFromInput({ invites: [invite(name)] }, APP)).toBe(true);
  });

  it('an account name the rule still refuses shows the name the proposal was validated with', () => {
    expect(cardNameOf('see https://elsewhere.example', 'Jane Doe')).toBe('Jane Doe');
    expect(cardNameOf('@jdoe', 'Jane Doe')).toBe('Jane Doe');
  });

  it('a long account name is cut to the limit the apply reads it by, whole characters only', () => {
    const name = cardNameOf(`${'n'.repeat(MAX_INVITE_LABEL - 1)}\u{1F600}`, 'Jane');
    expect(name.length).toBeLessThanOrEqual(MAX_INVITE_LABEL);
    expect(hasLoneSurrogate(name)).toBe(false);
    expect('invites' in meetingInvitesFromInput({ invites: [invite(name)] }, APP)).toBe(true);
  });
});
