/**
 * message-markers — the canonical deterministic marker stripper.
 * Mirrors the SPA parser's marker set so analytics/eval never sees a raw marker.
 */
import { stripMessageMarkers } from '../../lambda/src/lib/message-markers';

describe('stripMessageMarkers', () => {
  it('strips the NAVIGATE_CHANNEL drift-redirect marker (the leak the judge scored)', () => {
    const raw = "Done — I've created a new conversation. NAVIGATE_CHANNEL:arn:aws:chime:us-east-1:111:app-instance/i/channel/conv-drift-1|Drift Follow-up";
    expect(stripMessageMarkers(raw)).toBe("Done — I've created a new conversation.");
  });

  it('strips every HTML-comment control marker', () => {
    const cases: Array<[string, string]> = [
      ['Hi<!--corr:abc-123-->', 'Hi'],
      ['Reply<!--ACTIVE_TASK:{"taskId":"t1"}-->', 'Reply'],
      ['Pick<!--suggestions:[{"a":1}]-->', 'Pick'],
      ['Do it<!--proposal:{"op":"x"}-->', 'Do it'],
      ['Answer [1]<!--sources:[{"id":"d1"}]-->', 'Answer [1]'],
      ['Round 1<!--battle:battleId=b1,round=1-->', 'Round 1'],
      ['x<!--battlestats:battleId=b1,responseMs=10-->', 'x'],
      ['y<!--battlewaiting:battleId=b1,botArn=z-->', 'y'],
      ['see<!--battleimage:{"url":"https://x/y.png"}-->', 'see'],
    ];
    for (const [raw, want] of cases) expect(stripMessageMarkers(raw)).toBe(want);
  });

  it('strips multiple markers in one message and tidies whitespace', () => {
    const raw = 'The answer is 42.<!--corr:x--> <!--sources:[]-->\n\n\n<!--suggestions:[]-->';
    expect(stripMessageMarkers(raw)).toBe('The answer is 42.');
  });

  it('is idempotent and null-safe', () => {
    const once = stripMessageMarkers('hi<!--corr:x-->');
    expect(stripMessageMarkers(once)).toBe('hi');
    expect(stripMessageMarkers(null)).toBe('');
    expect(stripMessageMarkers(undefined)).toBe('');
  });

  it('leaves ordinary content (incl. markdown) untouched', () => {
    const md = '**Spaces** — they render identically. Here is `code` and a [link](http://x).';
    expect(stripMessageMarkers(md)).toBe(md);
  });
});
