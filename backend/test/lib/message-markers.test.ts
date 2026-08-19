/**
 * message-markers — the canonical deterministic marker stripper.
 * Mirrors the SPA parser's marker set so analytics/eval never sees a raw marker.
 */
import {
  stripMessageMarkers,
  stripReasoningTags,
  stripGuardrailMaskTokens,
} from '../../lambda/src/lib/message-markers';
import {
  METADATA_MARKER_FILTER_NAME,
  guardrailMaskToken,
} from '../../lib/config/guardrail-masks';

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
      // An UNKNOWN marker: the pattern strips every HTML comment, so a marker this module has never
      // heard of is covered without a code change. (This was `battleimage`, retired with that path.)
      ['see<!--somefuturemarker:{"k":"v"}-->', 'see'],
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

  it('strips a marker the guardrail already rewrote (stored text still carries the token)', () => {
    // Every reader of STORED text - the admin browser, the judge, analytics - has to see what the
    // human was meant to see, and messages written before the strip at the guardrail boundary
    // still hold the mask token.
    const raw = `...in this condensed 1-2 page report format.${guardrailMaskToken(METADATA_MARKER_FILTER_NAME)}`;
    expect(stripMessageMarkers(raw)).toBe('...in this condensed 1-2 page report format.');
  });
});

/**
 * A GUARDRAIL MASK IS ITSELF A LEAK when the filter exists to hide an internal marker. Amazon Bedrock
 * Guardrails replaces an ANONYMIZE match with `{FILTER_NAME}`, so a leaked control marker reaches the
 * person as the literal `{MetadataMarkerFilter}` - and the marker stripper cannot catch it, because
 * the text it matches on was rewritten before the runtime saw the response. Live symptom: a reply
 * ended `...in this condensed 1-2 page report format.{MetadataMarkerFilter}`.
 */
describe('stripGuardrailMaskTokens', () => {
  const TOKEN = guardrailMaskToken(METADATA_MARKER_FILTER_NAME);

  it('removes the mask token the metadata-marker filter leaves behind', () => {
    expect(stripGuardrailMaskTokens(`Here is the report.${TOKEN}`)).toBe('Here is the report.');
  });

  it('removes every occurrence, mid-text as well as trailing', () => {
    expect(stripGuardrailMaskTokens(`One ${TOKEN}two${TOKEN} three`)).toBe('One two three');
  });

  it('names the token from the SAME constant the guardrail construct provisions', () => {
    // A second hardcoded string here would silently stop matching the day the filter is renamed,
    // and the leak would return with no test failing.
    expect(TOKEN).toBe('{MetadataMarkerFilter}');
    expect(stripGuardrailMaskTokens('x{MetadataMarkerFilter}')).toBe('x');
  });

  it('leaves PII masks alone: the mask IS the intended output there', () => {
    // `{EMAIL}` is what an EMAIL ANONYMIZE rule is supposed to show. Removing it would delete the
    // evidence that a redaction happened, which is the opposite of the fix.
    const redacted = 'Reach the team at {EMAIL} or {PHONE}.';
    expect(stripGuardrailMaskTokens(redacted)).toBe(redacted);
  });

  it('leaves ordinary braces and code untouched', () => {
    const md = 'Use `{ "key": "value" }` and the {placeholder} convention.';
    expect(stripGuardrailMaskTokens(md)).toBe(md);
  });

  it('is idempotent and null-safe', () => {
    const once = stripGuardrailMaskTokens(`hi${TOKEN}`);
    expect(stripGuardrailMaskTokens(once)).toBe('hi');
    expect(stripGuardrailMaskTokens(null)).toBe('');
    expect(stripGuardrailMaskTokens(undefined)).toBe('');
  });
});

describe('stripReasoningTags', () => {
  it('removes a whole <thinking> block, content included', () => {
    const raw = '<thinking>\nIt appears there was an error transitioning the task.\n</thinking>\n\nTo ensure the report meets your needs, please provide the audience.';
    expect(stripReasoningTags(raw)).toBe('To ensure the report meets your needs, please provide the audience.');
  });

  it('unwraps a <result> wrapper but keeps the inner answer (the live drift leak)', () => {
    expect(stripReasoningTags('<result>Yes — created a new conversation.</result>')).toBe('Yes — created a new conversation.');
    // The exact fragment the drift confirm test captured mid-stream.
    expect(stripReasoningTags('<result>')).toBe('');
  });

  it('tolerates an unclosed <thinking> (strips to end) and orphaned closing tags', () => {
    expect(stripReasoningTags('Here is the report.\n<thinking>still reasoning, never closed')).toBe('Here is the report.');
    expect(stripReasoningTags('Done.</thinking>')).toBe('Done.');
  });

  it('keeps a real report body intact (does not touch markdown headings)', () => {
    const report = '# Monorepo vs. Multi-Repo\n\n## Executive Summary\n\n- Delivery velocity\n- CI cost';
    expect(stripReasoningTags(report)).toBe(report);
  });

  it('is idempotent and null-safe', () => {
    const once = stripReasoningTags('<thinking>x</thinking>Answer.');
    expect(once).toBe('Answer.');
    expect(stripReasoningTags(once)).toBe('Answer.');
    expect(stripReasoningTags(null)).toBe('');
    expect(stripReasoningTags(undefined)).toBe('');
  });
});
