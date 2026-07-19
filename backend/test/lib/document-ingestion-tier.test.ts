/**
 * deriveTier — the per-tier gate stamped onto KB chunks at ingestion.
 *
 * Security-critical: before this, ingestion stamped no tier, so the retrieval
 * filter (`metadata->>'tier' = ANY(scope)`) matched nothing and ALL KB content
 * was returned to ALL tiers. These pin the fail-closed contract: an explicit
 * `rag/{type}/{tier}/` segment wins; anything else defaults to the
 * most-restrictive tier (or RAG_DEFAULT_CLASSIFICATION) so untagged content never leaks
 * down to a lower tier. See docs/IDENTITY-AND-ACCESS-MODEL.md §8 (row 5).
 */
import { deriveTier } from '../../lambda/src/analytics-aurora/document-ingestion';

describe('deriveTier (KB per-tier gate, fail-closed)', () => {
  afterEach(() => {
    delete process.env.RAG_DEFAULT_CLASSIFICATION;
  });

  it('uses an explicit tier segment: rag/{type}/{tier}/...', () => {
    expect(deriveTier('rag/wiki/basic/onboarding.md')).toBe('basic');
    expect(deriveTier('rag/wiki/standard/policy.md')).toBe('standard');
    expect(deriveTier('rag/doc/premium/financials.md')).toBe('premium');
  });

  it('defaults untagged content to premium (most-restrictive, fail-closed)', () => {
    expect(deriveTier('rag/wiki/onboarding.md')).toBe('premium');
    expect(deriveTier('rag/doc/notes.md')).toBe('premium');
    expect(deriveTier('rag/toplevel.md')).toBe('premium');
  });

  it('treats a non-tier second segment as untagged → default', () => {
    // `handbook` is not a tier, so it is NOT read as one — falls back to default.
    expect(deriveTier('rag/wiki/handbook/page.md')).toBe('premium');
  });

  it('honors RAG_DEFAULT_CLASSIFICATION when set to a valid tier', () => {
    process.env.RAG_DEFAULT_CLASSIFICATION = 'basic';
    expect(deriveTier('rag/wiki/onboarding.md')).toBe('basic');
    // an explicit segment still wins over the default
    expect(deriveTier('rag/wiki/premium/secret.md')).toBe('premium');
  });

  it('ignores an invalid RAG_DEFAULT_CLASSIFICATION and stays fail-closed (premium)', () => {
    process.env.RAG_DEFAULT_CLASSIFICATION = 'public';
    expect(deriveTier('rag/wiki/onboarding.md')).toBe('premium');
  });
});
