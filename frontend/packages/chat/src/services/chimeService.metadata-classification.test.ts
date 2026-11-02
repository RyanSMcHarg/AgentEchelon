/**
 * THE CLASSIFICATION CHANNEL METADATA CLAIMS IS SHOWN, NEVER DEFAULTED.
 *
 * Metadata is member-writable, so the value is display-only, and an absent or unrecognized one is
 * absent: the conversation renders with no classification badge rather than a `basic` one nobody set. What it
 * recognizes is the set the deployment declares (`GET /classifications`), a custom one included.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setClassificationsForTest } from '@ae/shared';
import { SAMPLE_CLASSIFICATIONS } from '@ae/shared/config/sampleClassifications.ts';

vi.mock('@ae/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ae/shared')>()),
  trackEvent: vi.fn(),
}));

import { metadataClassification } from './chimeService';

afterEach(() => setClassificationsForTest(null));

describe('metadataClassification', () => {
  it('passes through a classification the deployment declares', () => {
    setClassificationsForTest(SAMPLE_CLASSIFICATIONS);
    expect(metadataClassification('basic')).toBe('basic');
    expect(metadataClassification('standard')).toBe('standard');
    expect(metadataClassification('premium')).toBe('premium');
  });

  it("passes through a custom set's own values, and not the sample's", () => {
    setClassificationsForTest([{ value: 'legal', displayName: 'Legal', audience: 'members', badgeToken: 'cls-1', grants: ['legal'], conversational: true }]);
    expect(metadataClassification('legal')).toBe('legal');
    expect(metadataClassification('premium')).toBeUndefined();
  });

  it('is absent when Metadata names none or names something else', () => {
    setClassificationsForTest(SAMPLE_CLASSIFICATIONS);
    for (const value of [undefined, null, '', 'enterprise', 42, { tier: 'premium' }]) {
      expect(metadataClassification(value)).toBeUndefined();
    }
  });
});
