/**
 * Turn correlation and placeholder mapping (ADR-022).
 *
 * These assert the properties the fix RESTS on, not that the functions run. The duplicate-reply bug
 * on the normal path had two halves - a retried Lex fulfillment minting a second label, and a second
 * placeholder reaching the channel - so the tests are written as those two failure modes plus the
 * repeat-message case the derivation trades against.
 */
import * as fs from 'fs';
import * as path from 'path';
import { turnCorrelationId, correlationMarkerOf, TURN_CORRELATION_WINDOW_SECONDS } from '../../lambda/src/lib/correlation';

const TURN = {
  channelArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/abc/channel/def',
  senderArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/abc/user/u1',
  userMessage: 'what is the refund policy?',
};

describe('turnCorrelationId', () => {
  it('is STABLE across a retried fulfillment of the same turn', () => {
    // The failure this fixes: Amazon Chime SDK retries a Lex fulfillment that did not answer in time.
    // A random id per fulfillment gave the retry its own label, so two placeholders appeared and two
    // answers landed. Same turn, seconds later, must be the same label.
    const first = turnCorrelationId({ ...TURN, nowMs: 1_000_000_000 });
    const retry = turnCorrelationId({ ...TURN, nowMs: 1_000_002_000 }); // 2s later, as observed
    expect(retry).toBe(first);
  });

  it('DIFFERS between turns, so two real questions never share a placeholder', () => {
    const a = turnCorrelationId({ ...TURN, nowMs: 1_000_000_000 });
    const b = turnCorrelationId({ ...TURN, userMessage: 'a different question', nowMs: 1_000_000_000 });
    expect(b).not.toBe(a);
  });

  it('DIFFERS between senders in the same channel at the same moment', () => {
    const a = turnCorrelationId({ ...TURN, nowMs: 1_000_000_000 });
    const b = turnCorrelationId({ ...TURN, senderArn: `${TURN.senderArn}-other`, nowMs: 1_000_000_000 });
    expect(b).not.toBe(a);
  });

  it('DIFFERS between channels, so the same question in two conversations is two turns', () => {
    const a = turnCorrelationId({ ...TURN, nowMs: 1_000_000_000 });
    const b = turnCorrelationId({ ...TURN, channelArn: `${TURN.channelArn}-other`, nowMs: 1_000_000_000 });
    expect(b).not.toBe(a);
  });

  it('hashes ONLY inputs a retry provably replays', () => {
    // The control is worthless if an input can vary between a fulfillment and its retry - the ids would
    // differ and nothing would collapse. The Lex `sessionId` was such an input: it separates nothing
    // that channel + sender do not already separate, and it depends on Amazon Chime SDK replaying the
    // same session on a retry, which is undocumented and was never measured.
    //
    // Asserted at SOURCE level (the pattern control-parity.test.ts uses) because the risk is someone
    // reintroducing the field, and a behavioural test cannot see an input that is merely ignored.
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'lambda', 'src', 'lib', 'correlation.ts'),
      'utf8',
    );
    const hashed = /\.update\(\[([^\]]*)\]/.exec(src);
    expect(hashed).not.toBeNull();
    expect(hashed![1]).not.toContain('sessionId');
    // And the inputs that must be there, are.
    for (const input of ['channelArn', 'senderArn', 'userMessage', 'bucket']) {
      expect(hashed![1]).toContain(input);
    }
  });

  it('separates identical text once the window has passed', () => {
    // The trade the derivation makes: identical text inside the window collapses to one turn. It must
    // NOT collapse forever, or a user who legitimately asks the same question later gets no reply.
    const first = turnCorrelationId({ ...TURN, nowMs: 1_000_000_000 });
    const later = turnCorrelationId({
      ...TURN,
      nowMs: 1_000_000_000 + (TURN_CORRELATION_WINDOW_SECONDS + 1) * 2 * 1000,
    });
    expect(later).not.toBe(first);
  });

  it('can re-derive the previous window, so a retry straddling a boundary is still recognised', () => {
    const nowMs = 1_000_000_000;
    const previous = turnCorrelationId({ ...TURN, nowMs, previousBucket: true });
    const asCurrentEarlier = turnCorrelationId({
      ...TURN,
      nowMs: nowMs - TURN_CORRELATION_WINDOW_SECONDS * 1000,
    });
    expect(previous).toBe(asCurrentEarlier);
  });

  it('stays short enough to ride in message content', () => {
    // It is embedded in the placeholder as `<!--corr:{id}-->` and charged against the 4KB Amazon
    // Chime SDK content limit.
    expect(turnCorrelationId({ ...TURN, nowMs: 1 })).toHaveLength(16);
  });
});

describe('correlationMarkerOf', () => {
  it('reads the marker from raw content', () => {
    expect(correlationMarkerOf('One moment... <!--corr:abc123-->')).toBe('abc123');
  });

  it('reads the marker from URL-encoded content, which is how the flow receives it', () => {
    const encoded = encodeURIComponent('One moment... <!--corr:abc123-->');
    expect(correlationMarkerOf(encoded)).toBe('abc123');
  });

  it('returns null for ordinary bot traffic, which is the common case', () => {
    expect(correlationMarkerOf('Here is your answer.')).toBeNull();
    expect(correlationMarkerOf('')).toBeNull();
  });

  it('ignores a marker whose id is not a plausible key', () => {
    // The id is parsed out of message CONTENT, which a user can influence. The character class and
    // length bound stop a crafted marker from smuggling an arbitrary table key.
    expect(correlationMarkerOf('<!--corr:has spaces-->')).toBeNull();
    expect(correlationMarkerOf(`<!--corr:${'x'.repeat(65)}-->`)).toBeNull();
  });

  it('survives malformed percent-encoding rather than throwing', () => {
    expect(correlationMarkerOf('%E0%A4%A')).toBeNull();
  });
});
