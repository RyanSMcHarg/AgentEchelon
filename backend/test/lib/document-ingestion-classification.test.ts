/**
 * deriveContentClassification — the per-classification gate stamped onto KB chunks at ingestion.
 *
 * Security-critical: before this, ingestion stamped no classification, so the retrieval
 * filter (`metadata->>'classification' = ANY(scope)`) matched nothing and ALL KB content
 * was returned to ALL classifications. These pin the fail-closed contract: an explicit
 * `rag/{type}/{classification}/` segment wins; anything else defaults to the
 * most-restrictive classification (or RAG_DEFAULT_CLASSIFICATION) so untagged content never leaks
 * down to a lower tier. See docs/IDENTITY-AND-ACCESS-MODEL.md §8 (row 5).
 */
import { deriveContentClassification } from '../../lambda/src/analytics-aurora/document-ingestion';

describe('deriveContentClassification (KB per-classification gate, fail-closed)', () => {
  afterEach(() => {
    delete process.env.RAG_DEFAULT_CLASSIFICATION;
  });

  it('uses an explicit tier segment: rag/{type}/{classification}/...', () => {
    expect(deriveContentClassification('rag/wiki/basic/onboarding.md')).toBe('basic');
    expect(deriveContentClassification('rag/wiki/standard/policy.md')).toBe('standard');
    expect(deriveContentClassification('rag/doc/premium/financials.md')).toBe('premium');
  });

  it('defaults untagged content to premium (most-restrictive, fail-closed)', () => {
    expect(deriveContentClassification('rag/wiki/onboarding.md')).toBe('premium');
    expect(deriveContentClassification('rag/doc/notes.md')).toBe('premium');
    expect(deriveContentClassification('rag/toplevel.md')).toBe('premium');
  });

  it('treats a non-tier second segment as untagged → default', () => {
    // `handbook` is not a tier, so it is NOT read as one — falls back to default.
    expect(deriveContentClassification('rag/wiki/handbook/page.md')).toBe('premium');
  });

  it('honors RAG_DEFAULT_CLASSIFICATION when set to a valid tier', () => {
    process.env.RAG_DEFAULT_CLASSIFICATION = 'basic';
    expect(deriveContentClassification('rag/wiki/onboarding.md')).toBe('basic');
    // an explicit segment still wins over the default
    expect(deriveContentClassification('rag/wiki/premium/secret.md')).toBe('premium');
  });

  it('ignores an invalid RAG_DEFAULT_CLASSIFICATION and stays fail-closed (premium)', () => {
    process.env.RAG_DEFAULT_CLASSIFICATION = 'public';
    expect(deriveContentClassification('rag/wiki/onboarding.md')).toBe('premium');
  });
});
