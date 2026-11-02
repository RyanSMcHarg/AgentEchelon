/**
 * user identity directive — a name asserted in conversation cannot replace the one the user signed in
 * with.
 *
 * THE DEFECT THIS EXISTS FOR. The assistant resolves the signed-in user's name and greets them with it,
 * but nothing told it that name was AUTHORITATIVE. A user who wrote "My name is TestBot" was answered
 * "Hi TestBot, it's nice to meet you!" - by an assistant that had opened the same conversation
 * addressing them as someone else. It did not knowingly accept the claim or flag the conflict; it had
 * no idea there was one.
 *
 * This is an authenticated enterprise assistant, not a guest flow: who the user is, is settled at
 * sign-in, and a claim typed into a message is not evidence about it. An assistant that answers to
 * whatever name it is handed will also carry that name into summaries, tasks, and anything else
 * downstream that reads the transcript.
 */
import { userIdentityDirective } from '../../lambda/src/lib/async-processor-core';

describe('userIdentityDirective', () => {
  it('names the signed-in user as the only authority on who they are', () => {
    const d = userIdentityDirective('Dana');
    expect(d).toContain('Dana');
    expect(d).toContain('authenticated');
    expect(d).toMatch(/only authority/i);
  });

  it('tells the assistant to decline a different self-asserted name WITHOUT arguing', () => {
    const d = userIdentityDirective('Dana');
    // Both halves matter: adopting the claim is the defect, and litigating it is a bad experience.
    expect(d).toMatch(/do NOT adopt/i);
    expect(d).toMatch(/do NOT argue/i);
    expect(d).toMatch(/records have them as Dana/i);
  });

  it('leaves a name mentioned about SOMEONE ELSE alone', () => {
    // Without this the directive would have the assistant correcting a user who mentions a colleague.
    expect(userIdentityDirective('Dana')).toMatch(/someone ELSE/i);
  });

  it('says nothing for a GUEST or federated sender — the exemption falls out of the fallback', () => {
    // The router resolves an unauthenticated / unresolvable sender to 'there'. No identity was
    // established, so there is nothing to contradict and no constraint is stated. A guest flow needs no
    // special-casing anywhere else because of this.
    expect(userIdentityDirective('there')).toBe('');
  });

  it('says nothing for a missing or blank name', () => {
    expect(userIdentityDirective()).toBe('');
    expect(userIdentityDirective('')).toBe('');
    expect(userIdentityDirective('   ')).toBe('');
  });

  it('trims surrounding whitespace, like its greeting sibling', () => {
    expect(userIdentityDirective('  Dana  ')).toContain('The person you are talking to is Dana.');
  });

  it('does not invent a preferred-name allowance', () => {
    // A preferred name is PROFILE DATA a deployment populates and chooses to honor, not something the
    // model infers or a user asserts mid-conversation: "call me X" and "I am X" are indistinguishable
    // in free text. Granting latitude here would reopen the hole from the other side.
    const d = userIdentityDirective('Dana');
    expect(d).not.toMatch(/preferred|nickname|shortened|call you/i);
  });

  it('establishes identity WITHOUT instructing the model to say the name', () => {
    // This block is on EVERY turn. It used to end "Address them as Dana.", which the model read as a
    // style instruction rather than an identity fact, so the name came back reply after reply -
    // observed live as three consecutive turns addressing the user by name. It also contradicted the
    // two directives that already govern this: the first-turn greeting says "not again", and the
    // work-items block says "do NOT address them by name in normal replies". Three instructions, one
    // pulling the other way, and the contradicting one fired every turn.
    const d = userIdentityDirective('Dana');
    expect(d).not.toMatch(/Address them as Dana/);
    expect(d).toMatch(/not an instruction to say their name/i);
    expect(d).toMatch(/Address them as "you"/);
  });

  it('still establishes the identity fact, which is the whole point of the block', () => {
    // The anti-impersonation purpose must survive the wording change: a user typing "my name is
    // TestBot" is still answered from their authenticated identity rather than from the claim.
    const d = userIdentityDirective('Dana');
    expect(d).toContain('The person you are talking to is Dana.');
    expect(d).toMatch(/only authority on who they are/);
    expect(d).toMatch(/do NOT adopt it and do NOT argue/);
  });
});
