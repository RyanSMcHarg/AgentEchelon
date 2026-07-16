/**
 * Suggestions extraction (suggest → review). The model emits a fenced
 * ```suggestions JSON block in its TEXT (tool-free, so DeepSeek-R1 — which can't use Converse
 * tools — can still produce structured suggestions). extractSuggestions validates + re-encodes it
 * as a `<!--suggestions:-->` marker and strips the block from the visible prose.
 */
import { extractSuggestions, suggestionsMarker } from '../../lambda/src/lib/async-processor-core';

function decodeMarker(text: string): { items: Array<Record<string, unknown>> } | null {
  const m = /<!--suggestions:([A-Za-z0-9+/=]+)-->/.exec(text);
  if (!m) return null;
  return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
}

describe('extractSuggestions', () => {
  it('extracts a valid block → marker, and strips the fence from the prose', () => {
    const reply = [
      'Here are two ideas to consider:',
      '',
      '```suggestions',
      '[{"title":"Draft the proposal","why":"unblocks the review","category":"writing"}]',
      '```',
    ].join('\n');
    const out = extractSuggestions(reply);
    expect(out).toContain('two ideas to consider');
    expect(out).not.toContain('```');
    const decoded = decodeMarker(out);
    expect(decoded?.items).toHaveLength(1);
    expect(decoded?.items[0]).toMatchObject({ title: 'Draft the proposal', category: 'writing' });
  });

  it('accepts a `name` field as the title and a ```json suggestions tag', () => {
    const reply = '```json suggestions\n[{"name":"Review the spec"}]\n```';
    const decoded = decodeMarker(extractSuggestions(reply));
    expect(decoded?.items[0]).toMatchObject({ title: 'Review the spec' });
  });

  it('drops entries missing a title; keeps the rest', () => {
    const reply = '```suggestions\n[{"title":"OK"},{"why":"no title"},{"name":"Also OK"}]\n```';
    const decoded = decodeMarker(extractSuggestions(reply));
    expect(decoded?.items).toHaveLength(2);
    expect(decoded?.items[0].title).toBe('OK');
    expect(decoded?.items[1].title).toBe('Also OK');
  });

  it('only keeps an https link; category is free-text', () => {
    const reply =
      '```suggestions\n[{"title":"X","link":"javascript:bad()","category":"anything"},{"title":"Y","link":"https://ok.example/p","category":"food"}]\n```';
    const decoded = decodeMarker(extractSuggestions(reply));
    const [x, y] = decoded!.items;
    expect(x.link).toBeUndefined();
    expect(x.category).toBe('anything'); // free-text category is allowed
    expect(y.link).toBe('https://ok.example/p');
    expect(y.category).toBe('food');
  });

  it('no fence → text unchanged, no marker', () => {
    const reply = 'Just prose, no suggestions.';
    expect(extractSuggestions(reply)).toBe(reply);
  });

  it('malformed JSON in the fence → prose kept, fence stripped, no marker', () => {
    const reply = 'Lead in.\n```suggestions\n[not json,,,]\n```';
    const out = extractSuggestions(reply);
    expect(out).toContain('Lead in.');
    expect(out).not.toContain('```');
    expect(decodeMarker(out)).toBeNull();
  });

  it('caps at 12 items', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ title: `P${i}` }));
    const reply = '```suggestions\n' + JSON.stringify(items) + '\n```';
    expect(decodeMarker(extractSuggestions(reply))?.items).toHaveLength(12);
  });

  it('suggestionsMarker round-trips', () => {
    const marker = suggestionsMarker([{ title: 'A' }]);
    expect(decodeMarker(marker)?.items[0]).toMatchObject({ title: 'A' });
  });
});
