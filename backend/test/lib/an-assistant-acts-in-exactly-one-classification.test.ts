/**
 * AN ASSISTANT ACTS IN EXACTLY ONE CLASSIFICATION, AND A PERSON KEEPS THEIR DECLARED GRANT SET.
 *
 * One helper built both boundaries and its own comment said so: "the same boundary, one definition".
 * That is correct for a person, whose reach is the grant set their classification declares - a premium
 * user speaking in a basic room is ordinary where premium declares basic - and it was applied unchanged to the assistant roles, where it is wrong. Every
 * classification has its own assistant and a channel carries only its matched one, so an assistant
 * reaching any other classification was reach nothing needed. ADR-042 is the record; the owner stated the rule on
 * 2026-09-13 and what followed was identity tagging rather than IAM pinning.
 *
 * ── WHY BOTH HALVES ARE IN ONE FILE ─────────────────────────────────────────────────────────────
 *
 * The risk in narrowing a shared resolver is narrowing too much. Asserting only that the assistant
 * set is a point would pass just as well if the person's role had collapsed to a point with it, which
 * would silently drop every premium user out of every basic room. The contrast is the assertion.
 */

import { ProfileRegistry, defaultProfileRegistry } from '../../lib/profile-registry';
import { DEFAULT_PROFILES_CONFIG } from '../../lib/config/profiles';

describe('the assistant boundary is a point and the person boundary is the declared grant set', () => {
  const declared = DEFAULT_PROFILES_CONFIG.classifications.map((c) => c.value);

  it('gives every declared classification exactly itself, and nothing else', () => {
    const rows = declared
      .map((c) => `${c}: ${defaultProfileRegistry.channelsActableBy(c).join(',') || '(empty)'}`)
      .join(' | ');
    expect(rows).toBe(declared.map((c) => `${c}: ${c}`).join(' | '));
  });

  it('is STRICTLY narrower than the person boundary wherever a person reaches more than one', () => {
    // The contrast, and the non-vacuity. If `channelsActableBy` were quietly returning `grantsFor`,
    // every row here would read "same" and the file would prove nothing.
    const narrowed = declared.filter(
      (c) => defaultProfileRegistry.grantsFor(c).length > defaultProfileRegistry.channelsActableBy(c).length,
    );
    // EVERY CLASSIFICATION WHOSE DECLARED GRANT SET HOLDS MORE THAN ONE, derived rather than listed,
    // so removing a classification (as `probe` was on 2026-09-17) does not turn this boundary guard
    // into an arithmetic failure. The property is "narrower wherever a person reaches more than one".
    const reachesMoreThanOne = declared.filter((c) => defaultProfileRegistry.grantsFor(c).length > 1);
    expect(`narrowed for: ${narrowed.join(',')}`).toBe(`narrowed for: ${reachesMoreThanOne.join(',')}`);
    // And it is not vacuous: at least one classification must reach more than one, or the comparison
    // above is comparing two empty lists.
    expect(reachesMoreThanOne.length).toBeGreaterThan(0);
    // And `basic` is a classification where the two legitimately agree, because its declared set is
    // itself alone. A file asserting "always narrower" would be wrong here rather than stronger.
    expect(`basic person: ${defaultProfileRegistry.grantsFor('basic').join(',')}`).toBe('basic person: basic');
  });

  it('leaves the person boundary alone, which is what makes this a split rather than a narrowing', () => {
    // The failure this guards is narrowing BOTH. A premium person must still reach a basic room.
    // A premium PERSON still reaches every classification premium declares. Asserted as that declared
    // set, because what matters is that it was not narrowed alongside the
    // assistant, not which classifications happen to be declared today.
    // COMPARED AGAINST THE DECLARED SET rather than against a second derivation of it.
    // `scopeAtOrBelow` was the rank-based twin of `grantsFor`, and asserting one against the other
    // only ever proved the two agreed - which stopped being a question when the rank one was deleted.
    expect(`premium person: ${defaultProfileRegistry.grantsFor('premium').join(',')}`)
      .toBe('premium person: basic,standard,premium');
    // Non-vacuity: premium must reach more than itself, or "left alone" proves nothing.
    expect(defaultProfileRegistry.grantsFor('premium').length).toBeGreaterThan(1);
  });

  it('resolves an alias to the canonical value rather than echoing what it was asked', () => {
    // `channelsActableBy` filters `grantsFor` by the RESOLVED own value. Asked with a legacy alias it
    // must answer with the canonical classification, or a deployment carrying aliases would produce a
    // condition naming a tag value no channel carries, and the assistant would be denied everywhere.
    const withAlias = new ProfileRegistry({
      ...DEFAULT_PROFILES_CONFIG,
      classifications: DEFAULT_PROFILES_CONFIG.classifications.map((c) => (
        c.value === 'premium' ? { ...c, aliases: ['gold'] } : c
      )),
    });
    expect(`gold resolves to: ${withAlias.channelsActableBy('gold').join(',')}`).toBe('gold resolves to: premium');
  });

  it('fails CLOSED on a grant set that omits its own value, rather than falling back to a ladder', () => {
    // `validateProfilesConfig` refuses such a config, so this cannot ship - but the accessor is what
    // an IAM condition is built from, and the direction it fails in is the whole question. An empty
    // set matches no tag, so no Allow applies and the action is denied. A fallback to
    // `scopeAtOrBelow` would silently restore the boundary this record exists to remove.
    const registry = Object.create(ProfileRegistry.prototype) as ProfileRegistry;
    Object.assign(registry, defaultProfileRegistry);
    jest.spyOn(registry, 'grantsFor').mockReturnValue(['basic', 'standard']);
    jest.spyOn(registry, 'resolveClassification').mockReturnValue('premium');
    expect(`premium assistant: ${registry.channelsActableBy('premium').join(',') || '(empty)'}`)
      .toBe('premium assistant: (empty)');
  });
});
