/**
 * The empty Lex envelope, recognised without a ContentType.
 *
 * The channel flow drops these so no client has to know the shape exists. The flow event
 * carries no ContentType, so detection is STRUCTURAL - and the risk that buys is eating real user
 * content. Most of this file is therefore about what must NOT be recognised.
 */
import {
  isEmptyLexEnvelope,
  unwrapLexEnvelope,
  unwrapLexEnvelopeForChannel,
} from '../../lambda/src/lib/lex-envelope';

describe('isEmptyLexEnvelope', () => {
  it('recognises the empty envelope a silent fulfillment produces', () => {
    expect(isEmptyLexEnvelope('{"Messages":[]}')).toBe(true);
    expect(isEmptyLexEnvelope(JSON.stringify({ Messages: [] }))).toBe(true);
  });

  it('recognises it percent-encoded, because the flow sees Content in either form', () => {
    expect(isEmptyLexEnvelope(encodeURIComponent('{"Messages":[]}'))).toBe(true);
  });

  it('tolerates surrounding whitespace', () => {
    expect(isEmptyLexEnvelope('  {"Messages":[]}\n')).toBe(true);
  });

  // ── What must NOT be dropped. Each of these would be a user-visible message destroyed. ──

  it('does NOT recognise an envelope that CARRIES a message', () => {
    // The placeholder path depends on this: Chime materialises the placeholder from a fulfillment
    // response, and dropping that would drop the turn.
    const placeholder = JSON.stringify({
      Messages: [{ Content: 'One moment... <!--corr:abc-->', ContentType: 'PlainText' }],
    });
    expect(isEmptyLexEnvelope(placeholder)).toBe(false);
  });

  it('does NOT recognise an assistant answer that QUOTES the shape in a fenced block', () => {
    const answer = 'A silent fulfillment looks like this:\n\n```json\n{"Messages":[]}\n```\n';
    expect(isEmptyLexEnvelope(answer)).toBe(false);
  });

  it('does NOT recognise a JSON object that merely HAS a Messages key', () => {
    // The `Object.keys(...).length === 1` clause is what carries the safety guarantee. An answer that
    // is legitimately a JSON document with an empty Messages field is user content.
    expect(isEmptyLexEnvelope('{"Messages":[],"Count":0}')).toBe(false);
    expect(isEmptyLexEnvelope('{"conversation":{"Messages":[]}}')).toBe(false);
  });

  it('does NOT recognise a non-empty, non-envelope, or unparseable content', () => {
    expect(isEmptyLexEnvelope('what is 2+2?')).toBe(false);
    expect(isEmptyLexEnvelope('{"Messages":[] ')).toBe(false); // truncated, unparseable
    expect(isEmptyLexEnvelope('{"Messages":"nope"}')).toBe(false);
    expect(isEmptyLexEnvelope('[{"Messages":[]}]')).toBe(false); // array, not the envelope
    expect(isEmptyLexEnvelope('')).toBe(false);
    expect(isEmptyLexEnvelope(null)).toBe(false);
    expect(isEmptyLexEnvelope(undefined)).toBe(false);
  });
});

describe('unwrapLexEnvelopeForChannel (the WRITE-side rewrite)', () => {
  it('returns the carried text for a carrying envelope', () => {
    const welcome = JSON.stringify({
      Messages: [{ Content: "Hi - I'm your assistant at Stratum.", ContentType: 'PlainText' }],
    });
    expect(unwrapLexEnvelopeForChannel(welcome)).toBe("Hi - I'm your assistant at Stratum.");
  });

  it('keeps the placeholder marker, which the duplicate guard reads', () => {
    const placeholder = JSON.stringify({
      Messages: [{ Content: 'One moment... <!--corr:abc123-->', ContentType: 'PlainText' }],
    });
    expect(unwrapLexEnvelopeForChannel(placeholder)).toBe('One moment... <!--corr:abc123-->');
  });

  it('PRESERVES the encoding convention it arrived in', () => {
    // A rewrite that changed convention mid-message would leave the reader decoding text that was
    // never encoded, or not decoding text that was.
    const encoded = encodeURIComponent(JSON.stringify({ Messages: [{ Content: 'hello there' }] }));
    expect(unwrapLexEnvelopeForChannel(encoded)).toBe(encodeURIComponent('hello there'));
  });

  it('returns NULL - not the input - when there is nothing to rewrite', () => {
    // The caller rewrites a channel message, so "no change" must not be confusable with "changed to
    // the same string".
    expect(unwrapLexEnvelopeForChannel('an ordinary answer')).toBeNull();
    expect(unwrapLexEnvelopeForChannel('{"Messages":[],"Count":0}')).toBeNull();
    expect(unwrapLexEnvelopeForChannel('```json\n{"Messages":[{"Content":"x"}]}\n```')).toBeNull();
    expect(unwrapLexEnvelopeForChannel('')).toBeNull();
    expect(unwrapLexEnvelopeForChannel(null)).toBeNull();
  });

  it('returns NULL for an EMPTY envelope, which is dropped rather than rewritten', () => {
    expect(unwrapLexEnvelopeForChannel('{"Messages":[]}')).toBeNull();
  });

  it('returns NULL when the envelope carries no usable text', () => {
    expect(unwrapLexEnvelopeForChannel('{"Messages":[{"ContentType":"PlainText"}]}')).toBeNull();
    expect(unwrapLexEnvelopeForChannel('{"Messages":[{"Content":42}]}')).toBeNull();
  });
});

describe('unwrapLexEnvelope', () => {
  it('returns the human-readable text of a carrying envelope', () => {
    const welcome = JSON.stringify({
      Messages: [{ Content: 'Hi, I can help with billing.', ContentType: 'PlainText' }],
    });
    expect(unwrapLexEnvelope(welcome)).toBe('Hi, I can help with billing.');
  });

  it('leaves anything that is not an envelope untouched', () => {
    expect(unwrapLexEnvelope('ordinary prose')).toBe('ordinary prose');
    expect(unwrapLexEnvelope('{"Messages":[]}')).toBe('{"Messages":[]}');
    expect(unwrapLexEnvelope('{"Messages":[],"Count":0}')).toBe('{"Messages":[],"Count":0}');
  });

  it('leaves a fenced code block quoting the shape untouched', () => {
    const answer = 'Like so:\n\n```json\n{"Messages":[{"Content":"x"}]}\n```';
    expect(unwrapLexEnvelope(answer)).toBe(answer);
  });
});
