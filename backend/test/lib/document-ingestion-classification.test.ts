/**
 * deriveContentClassification — the per-classification gate stamped onto KB chunks at ingestion.
 *
 * Security-critical: before this, ingestion stamped no classification, so the retrieval
 * filter (`metadata->>'classification' = ANY(scope)`) matched nothing and ALL KB content
 * was returned to ALL classifications. These pin the fail-closed contract: an explicit
 * `rag/{type}/{classification}/` segment wins; anything else defaults to the
 * most-restrictive classification (or RAG_DEFAULT_CLASSIFICATION) so untagged content never leaks
 * down to a lower tier. See docs/IDENTITY-AND-ACCESS-MODEL.md §8.
 */
import { deriveContentClassification } from '../../lambda/src/analytics-aurora/document-ingestion';
import { DEFAULT_PROFILES_CONFIG } from '../../lib/config/profiles';
import { defaultProfileRegistry } from '../../lib/profile-registry';

/**
 * THE FAIL-CLOSED DEFAULT IS DERIVED, NOT NAMED.
 *
 * These assertions used to say `premium`, which was the most restrictive classification on the day
 * they were written. Naming it inverts what this file is for: the subject is "untagged content
 * defaults to the most restrictive classification A READER CAN STILL REACH", and a literal asserts
 * something weaker and more brittle - that the default is one specific tier.
 *
 * ── AND "MOST RESTRICTIVE" IS NOT THE TOP OF THE RANK ORDER ──────────────────────────────────────
 *
 * This file briefly derived the maximum rank, on the reasoning that no untagged chunk should be
 * readable by any classification below the top. That reasoning has an end state nobody wants: when an
 * ADMIN PLANE classification was declared above the ordinary tiers, the maximum became a value no
 * user conversation is ever served at - so every untagged document became retrievable by nothing at
 * all, silently and with no error. Strictest is not safest once it passes the last reader.
 *
 * So the derivation matches the code's: the highest-ranked classification that is NOT admin-plane.
 * Untagged content is still withheld from every tier below it, and is still reachable by the one it
 * is stamped at.
 */
// FROM THE REGISTRY, not recomputed. This reduced over `rank` to find "the highest ordinary
// classification"; the registry owns that definition and no longer expresses it as an order.
const FAIL_CLOSED_DEFAULT = defaultProfileRegistry.failClosedContentValue;

describe('deriveContentClassification (KB per-classification gate, fail-closed)', () => {
  afterEach(() => {
    delete process.env.RAG_DEFAULT_CLASSIFICATION;
  });

  it('the derived default is the top of the CONVERSATIONAL ladder, so these are not vacuous', () => {
    // Two ways this file could pass while proving nothing, and both are checked here.
    //
    // If the default ever equalled the LOWEST rank, every assertion below would still pass while the
    // gate published untagged content to everyone.
    // STATED AS REACH, because there is no rank to compare. The stamp must be a conversational
    // classification (so something can read it) that NOT every other one reaches (so it withholds
    // from somebody). Those two together are what "fail closed but not invisible" means.
    const conversational = DEFAULT_PROFILES_CONFIG.classifications.filter((c) => !c.adminPlane);
    expect(conversational.map((c) => c.value)).toContain(FAIL_CLOSED_DEFAULT);
    const reachers = conversational.filter((c) => defaultProfileRegistry.reaches(c.value, FAIL_CLOSED_DEFAULT));
    expect(reachers.length).toBeGreaterThanOrEqual(1);
    expect(reachers.length).toBeLessThan(conversational.length);
    expect(conversational.length).toBeGreaterThan(1);

    // And if it ever landed ON the admin plane, they would all still pass while untagged content
    // became invisible to every user conversation - the failure this derivation exists to avoid.
    const adminPlane = DEFAULT_PROFILES_CONFIG.classifications.filter((c) => c.adminPlane);
    expect(adminPlane.map((c) => c.value)).not.toContain(FAIL_CLOSED_DEFAULT);
  });

  it('uses an explicit tier segment: rag/{type}/{classification}/...', () => {
    expect(deriveContentClassification('rag/wiki/basic/onboarding.md')).toBe('basic');
    expect(deriveContentClassification('rag/wiki/standard/policy.md')).toBe('standard');
    expect(deriveContentClassification('rag/doc/premium/financials.md')).toBe('premium');
  });

  it('defaults untagged content to the most-restrictive classification (fail-closed)', () => {
    expect(deriveContentClassification('rag/wiki/onboarding.md')).toBe(FAIL_CLOSED_DEFAULT);
    expect(deriveContentClassification('rag/doc/notes.md')).toBe(FAIL_CLOSED_DEFAULT);
    expect(deriveContentClassification('rag/toplevel.md')).toBe(FAIL_CLOSED_DEFAULT);
  });

  it('treats a non-tier second segment as untagged → default', () => {
    // `handbook` is not a tier, so it is NOT read as one — falls back to default.
    expect(deriveContentClassification('rag/wiki/handbook/page.md')).toBe(FAIL_CLOSED_DEFAULT);
  });

  it('honors RAG_DEFAULT_CLASSIFICATION when set to a valid tier', () => {
    process.env.RAG_DEFAULT_CLASSIFICATION = 'basic';
    expect(deriveContentClassification('rag/wiki/onboarding.md')).toBe('basic');
    // an explicit segment still wins over the default
    expect(deriveContentClassification('rag/wiki/premium/secret.md')).toBe('premium');
  });

  it('ignores an invalid RAG_DEFAULT_CLASSIFICATION and stays fail-closed', () => {
    process.env.RAG_DEFAULT_CLASSIFICATION = 'public';
    expect(deriveContentClassification('rag/wiki/onboarding.md')).toBe(FAIL_CLOSED_DEFAULT);
  });
});
