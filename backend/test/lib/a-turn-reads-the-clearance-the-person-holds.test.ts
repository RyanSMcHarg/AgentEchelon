/**
 * A TURN ANSWERS THE PERSON'S CURRENT CLEARANCE, AND ONLY THIS SYSTEM DECLARES A TURN'S ATTRIBUTES.
 *
 * A session vended before a downgrade can still post for its remaining life, so the router ends a turn
 * whose sender holds a clearance that does not reach the conversation. A clearance that cannot be read
 * is an outage, and the turn goes on. And a turn that arrives through Amazon Lex carries none of the
 * `AE.*` attributes the system writes for a turn it dispatched to itself.
 *
 * Asserted against the router SOURCE, like the neighboring claim guards: observing either needs a whole turn.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const router = readFileSync(join(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');

describe('the clearance a turn reads', () => {
  const start = router.indexOf('if (!scopedByIssuer && !senderReach.includes(channelClassification)) {');
  const check = router.slice(start, router.indexOf('A SENDER WHOSE ISSUER DECIDES ONLY FROM A TOKEN', start));

  it('ends the turn when a clearance it can read does not reach the conversation', () => {
    expect(start).toBeGreaterThan(-1);
    expect(check).toContain('if (userClearance !== undefined) {');
    expect(check).toContain('return formatLexSilentResponse(event);');
  });

  it('is reported to the person and an administrator, never silent', () => {
    expect(check).toContain('reportTurnNotStarted(');
    expect(check).toContain("refusedAt: 'sender-reach'");
  });
});

describe('the attributes a Lex turn carries', () => {
  it('drops every AE.* attribute from anything that did not come through the system itself', () => {
    expect(router).toMatch(/\.aeTurn\)\s+: withoutDeclaredTurnAttributes\(rawEvent as LexEvent\);/);
    expect(router).toContain("filter(([k]) => !k.startsWith('AE.'))");
  });
});
