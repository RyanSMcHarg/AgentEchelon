/**
 * The silent Lex response (ADR-022).
 *
 * When the router suppresses a RETRIED fulfillment it still has to return something: Amazon Chime SDK
 * posts the Lex envelope into the channel either way, so the only question is whether the client
 * recognises it as nothing. Both client ingestion paths drop a Lex envelope whose `Messages` is present
 * AND empty; an ABSENT field leaves `parsed.Messages` undefined, falls through that guard, and renders
 * the raw envelope to the user.
 *
 * So "suppressed" is a property of the SHAPE, not of the intent to suppress. Omitting the field
 * entirely is already impossible: `messages` is required on `LexResponse`, so `tsc` rejects it. What
 * the type CANNOT catch is a non-empty array - a single message with empty content type-checks
 * perfectly and puts a blank bubble in the conversation for every suppressed retry. That is the
 * reachable regression, and it is the one these assert against.
 */
import { formatLexSilentResponse } from '../../lambda/src/router-agent-handler';

const EVENT = {
  sessionState: {
    intent: { name: 'FallbackIntent' },
    sessionAttributes: { existing: 'kept' },
  },
} as never;

describe('formatLexSilentResponse', () => {
  it('emits messages as an EMPTY ARRAY, so the client guard fires', () => {
    // The client suppresses on `Messages` present AND length 0. A non-empty array - even one carrying
    // empty content - fails that guard and reaches the conversation as a visible message.
    const res = formatLexSilentResponse(EVENT);
    expect('messages' in res).toBe(true);
    expect(Array.isArray(res.messages)).toBe(true);
    expect(res.messages).toHaveLength(0);
  });

  it('serialises to the exact envelope the client suppression matches', () => {
    // Asserted on the serialised form because that is what crosses the wire and what the client
    // JSON.parses back out, rather than on the object the function happens to return.
    const parsed = JSON.parse(JSON.stringify(formatLexSilentResponse(EVENT)));
    expect(parsed.messages).toEqual([]);
  });

  it('closes the intent as fulfilled, so Lex does not re-prompt the user', () => {
    const res = formatLexSilentResponse(EVENT);
    expect(res.sessionState.dialogAction.type).toBe('Close');
    expect(res.sessionState.intent.state).toBe('Fulfilled');
    expect(res.sessionState.intent.name).toBe('FallbackIntent');
  });

  it('preserves session attributes, so suppressing a duplicate does not reset the session', () => {
    const res = formatLexSilentResponse(EVENT);
    expect(res.sessionState.sessionAttributes).toEqual({ existing: 'kept' });
  });
});
