/**
 * A FAILED HANDOVER DOES NOT ANSWER, AND DOES NOT REASSIGN.
 *
 * A person's message answers work a DIFFERENT assistant owns, so the router hands the turn to that
 * assistant. When the handover fails - the invoke threw, the owning bot could not be sanctioned, the
 * function could not name itself - the message fell through and was answered as THIS assistant, and
 * `applyUserResponseToTask` ran with `assistantId = self`: the owner's chain moved onto the assistant
 * that happened to receive the message, on the strength of a transient failure, with nothing saying so.
 *
 * The rule is now that the chain stays where it is and the person is told its owner could not be
 * reached. Asserted against the router SOURCE, because observing it needs a failed Lambda invoke inside
 * a whole Lex turn, and the property is one deleted `return` away from being untrue.
 */

import { shippedLineText } from '../../lambda/src/lib/message-lines';

const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const router = fs.readFileSync(
  path.resolve(__dirname, '../../lambda/src/router-agent-handler.ts'), 'utf8');

describe('a handover that could not be made', () => {
  const at = router.indexOf('const handed = senderArn && await handOverToOwningAssistant({');
  const branch = router.slice(at, router.indexOf('if (answered && !isMachineWrittenTurn(event) && !isAmendmentFold(event))', at));

  it('the branch exists, so the assertions below are not vacuous', () => {
    expect(at).toBeGreaterThan(-1);
    expect(branch.length).toBeGreaterThan(500);
  });

  it('returns on failure as well as on success, so nothing below it runs for another assistant\'s work', () => {
    // The fall-through is what answered and reassigned. Both outcomes must leave this block.
    expect(branch).toContain('if (handed) return formatLexSilentResponse(event);');
    const afterSuccess = branch.slice(branch.indexOf('if (handed) return'));
    expect(afterSuccess).toMatch(/return formatLexResponse\(event, \[\{/);
  });

  it('never applies the message to the chain as this assistant', () => {
    expect(branch).not.toContain('applyUserResponseToTask');
  });

  it('tells the person, in the assistant\'s configured words, that the owner could not be reached', () => {
    // The assistant's own `handover-owner-unavailable` template, else its legacy copy line, else the shipped one (ADR-062).
    expect(branch).toContain("templateLine('handover-owner-unavailable', await turnWords()");
    const shipped = shippedLineText('handover-owner-unavailable');
    expect(shipped).toMatch(/couldn't reach them/);
    expect(shipped).toMatch(/haven't answered in their place/);
    // Named the way the receipt names it, never by principal id.
    expect(branch).toContain('owningAssistantDisplayName(');
    expect(branch).toContain('values: { name: ownerName }');
  });

  it('the handover documents what its false return now means', () => {
    const doc = router.slice(router.indexOf('Returns TRUE when the turn was handed over'), router.indexOf('async function handOverToOwningAssistant('));
    expect(doc).toContain('It must not answer in the owner\'s place');
    expect(doc).not.toMatch(/must answer the message as an ordinary turn/);
  });
});

describe('the slice above is bounded', () => {
  it('its end anchor exists, so the branch assertions cannot read the rest of the file', () => {
    const at = router.indexOf('const handed = senderArn && await handOverToOwningAssistant({');
    expect(router.indexOf('if (answered && !isMachineWrittenTurn(event) && !isAmendmentFold(event))', at)).toBeGreaterThan(at);
  });
});
