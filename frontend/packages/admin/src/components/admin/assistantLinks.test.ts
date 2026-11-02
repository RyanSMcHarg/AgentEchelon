/**
 * AN ASSISTANT PAGE'S PERFORMANCE LINKS OPEN THE CONSOLE NARROWED TO THE ASSISTANT.
 *
 * Each link is a URL the console reads on load: the Performance filter set's own keys for the assistant and version,
 * and `intent` for the intent whose Effectiveness detail opens. A link written and a link read are the same values.
 */
import { describe, it, expect } from 'vitest';
import { filtersFromUrl } from './PerformanceFilters';
import { intentFromUrl, linkFilters, linkSearch, withIntentParam } from './assistantLinks';

describe('the links an assistant page writes', () => {
  it('opens Effectiveness on one assistant and one version', () => {
    const search = linkSearch({ tab: 'effectiveness', assistant: 'advisor', version: 30 });
    const q = new URLSearchParams(search);
    expect(q.get('admin')).toBe('effectiveness');
    expect(filtersFromUrl(search)).toMatchObject({ assistant: 'advisor', version: '30' });
    expect(intentFromUrl(search)).toBeNull();
  });

  it('opens Effectiveness on one assistant and one intent, any version', () => {
    const search = linkSearch({ tab: 'effectiveness', assistant: 'advisor', intent: 'report_generation' });
    expect(filtersFromUrl(search)).toMatchObject({ assistant: 'advisor', version: null });
    expect(intentFromUrl(search)).toBe('report_generation');
  });

  it('opens Conversations on one assistant, with no version or intent riding along', () => {
    const search = linkSearch({ tab: 'conversations', assistant: 'advisor', version: 30, intent: 'x' });
    expect(new URLSearchParams(search).get('admin')).toBe('conversations');
    expect(filtersFromUrl(search)).toMatchObject({ assistant: 'advisor', version: null });
    expect(intentFromUrl(search)).toBeNull();
    expect(linkFilters({ tab: 'conversations', assistant: 'advisor', version: 30 }).version).toBeNull();
  });

  it('sets and clears the intent without touching the rest of the URL', () => {
    expect(withIntentParam('a', '?admin=effectiveness&as=advisor')).toBe('?admin=effectiveness&as=advisor&intent=a');
    expect(withIntentParam(null, '?admin=effectiveness&as=advisor&intent=a')).toBe('?admin=effectiveness&as=advisor');
  });
});
