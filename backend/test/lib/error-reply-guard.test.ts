/**
 * `assertNotAnErrorReply` must actually fire. A guard that cannot fail is a silent pass, and this
 * suite has shipped two of those before (a console guard reading fields off a `string[]`, and an
 * assertion matching `/picks up/i` against percent-encoded content).
 *
 * Run with the unit suite, not Playwright: it is a pure function over strings.
 */
import { assertNotAnErrorReply } from '../../../tests/e2e/helpers/drift-backend';

describe('assertNotAnErrorReply', () => {
  it('throws on every failure notice the backend can show a user', () => {
    // Verbatim from lambda/src. If a new one is added and not listed, this suite keeps passing while
    // the guard stops covering it - so the list is the contract, and it is asserted here.
    // PROVEN NON-VACUOUS: with the ERROR_REPLY_SHAPES list emptied, all four throwing cases fail.
    const failures = [
      'Sorry, I encountered an issue processing your request. Please try again.',
      'I encountered an issue. Could you try rephrasing?',
      "I couldn't start on that just now. Please try again.",
      'We are experiencing unusually high demand right now. Please try again in a little while.',
      'A battle is already in progress here. Give it a moment, then try again.',
    ];
    for (const f of failures) {
      expect(() => assertNotAnErrorReply(f)).toThrow(/FAILURE NOTICE, not an answer/);
    }
  });

  it('throws when the notice arrives PERCENT-ENCODED, which is how the channel stores it', () => {
    // The failure mode that matters most. Content is percent-encoded in Amazon Chime SDK, so a
    // substring test against the raw form never matches and the guard passes for the wrong reason.
    const encoded = encodeURIComponent('Sorry, I encountered an issue processing your request. Please try again.');
    expect(encoded).not.toContain('Sorry, I encountered'); // the raw form genuinely does not contain it
    expect(() => assertNotAnErrorReply(encoded)).toThrow(/FAILURE NOTICE/);
  });

  it('throws when the notice is wrapped in a Lex envelope', () => {
    // Messages that reach the channel through the Lex path are stored wrapped, so the text a guard
    // needs is one level down (tracker row 87).
    const wrapped = JSON.stringify({
      Messages: [{ Content: 'I encountered an issue. Could you try rephrasing?', ContentType: 'PlainText' }],
    });
    expect(() => assertNotAnErrorReply(wrapped)).toThrow(/FAILURE NOTICE/);
  });

  it('does NOT throw on a real answer, including one that discusses errors', () => {
    // A guard that fires on the word "error" would make every troubleshooting answer a failure. The
    // list matches the backend's exact sentences, not a topic.
    expect(() => assertNotAnErrorReply('4')).not.toThrow();
    expect(() => assertNotAnErrorReply('Fun fact about the moon: it is drifting away.')).not.toThrow();
    expect(() => assertNotAnErrorReply(
      'To debug this, check whether the handler logged an error and whether the request was retried.',
    )).not.toThrow();
    expect(() => assertNotAnErrorReply(JSON.stringify({ Messages: [] }))).not.toThrow();
    expect(() => assertNotAnErrorReply('')).not.toThrow();
  });

  it('names the offending text, so a failure is diagnosable without a re-run', () => {
    expect(() => assertNotAnErrorReply('Sorry, I encountered an issue processing your request.', 'battle side A'))
      .toThrow(/battle side A/);
  });
});
