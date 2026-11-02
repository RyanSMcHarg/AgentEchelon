/**
 * AN ANSWER GOES TO THE PERSON WHO ASKED, NOT TO WHOEVER THE PLACEHOLDER NAMES.
 *
 * A targeted answer inherits the placeholder's `Target`, so a question asked privately is answered
 * privately. What decided that inheritance was `Target.length > 0` - "is this addressed to somebody" -
 * rather than "is this addressed to the person who ASKED". A placeholder naming a different member
 * would hand that turn's answer to them, and the answer is the longer and more revealing half of the
 * exchange.
 *
 * The same existence-for-identity substitution appeared in three places: `inboundWasTargeted`, the
 * content match in `lib/inbound-message.ts`, and here. This file guards the third.
 *
 * ── WHY A PURE PREDICATE, AND WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────
 *
 * The first version of this guard asserted the SecurityEvent log emitted by the caller, and passed
 * with the comparison removed - the log fired on its own condition, so the test agreed with a broken
 * implementation. Moving the decision into `replyTargetAudience` is what makes it assertable: there is
 * one expression, it returns one of three answers, and a test can name each.
 *
 * `UpdateChannelMessage` cannot change a message's `Target` - it is fixed at creation - so a mismatched
 * placeholder cannot be redirected. What this prevents is the turn COMPOUNDING it: nothing further is
 * addressed to a member who did not ask.
 */

import { replyTargetAudience } from '../../lambda/src/lib/private-command';

const ASKER = 'arn:aws:chime:us-east-1:111:app-instance/i/user/asker';
const OTHER = 'arn:aws:chime:us-east-1:111:app-instance/i/user/other';
const BOT = 'arn:aws:chime:us-east-1:111:app-instance/i/bot/atlas';

describe('a targeted answer is confirmed to be addressed to the asker', () => {
  it('inherits a target that names the person whose turn it is', () => {
    expect(replyTargetAudience([ASKER], ASKER)).toBe('asker');
  });

  it('refuses a target that names somebody else, which is the defect this file exists for', () => {
    // The whole point. Before this, a placeholder addressed to OTHER made the answer targeted and the
    // answer went to OTHER, because the only question asked was whether a target existed.
    expect(replyTargetAudience([OTHER], ASKER)).toBe('someone-else');
  });

  it('accepts a multi-member target that includes the asker, and refuses one that does not', () => {
    // `Target` is a list in the API shape even though a channel message carries one member, so the
    // predicate reads the list rather than assuming its length.
    expect(replyTargetAudience([OTHER, ASKER], ASKER)).toBe('asker');
    expect(replyTargetAudience([OTHER, BOT], ASKER)).toBe('someone-else');
  });

  it('calls no target untargeted rather than a mismatch, so a broadcast reply is unaffected', () => {
    // The common path. An ordinary reply has no target to confirm and must not be dragged into this
    // decision at all: reporting 'someone-else' here would make every broadcast turn a finding.
    expect(replyTargetAudience([], ASKER)).toBe('untargeted');
    expect(replyTargetAudience([], undefined)).toBe('untargeted');
  });

  it('treats an absent asker as confirmable rather than as a mismatch', () => {
    // A platform-driven turn has nobody to compare against. Treating that as a mismatch would stop
    // inheriting a target that was set correctly, and would report a finding nobody can act on.
    expect(replyTargetAudience([OTHER], undefined)).toBe('asker');
  });

  it('ignores empty entries rather than counting them as a target', () => {
    // A `Target` whose entries carry no MemberArn is not an address. Counting the list length would
    // make such a message "targeted at somebody" and send the answer nowhere useful.
    expect(replyTargetAudience(['', ''], ASKER)).toBe('untargeted');
    expect(replyTargetAudience(['', ASKER], ASKER)).toBe('asker');
  });

  it('is not vacuous: the three answers are genuinely different for one asker', () => {
    // If the predicate ignored its arguments every case above would still pass by agreeing.
    const seen = new Set([
      replyTargetAudience([], ASKER),
      replyTargetAudience([ASKER], ASKER),
      replyTargetAudience([OTHER], ASKER),
    ]);
    expect(`distinct answers: ${seen.size}`).toBe('distinct answers: 3');
  });
});
