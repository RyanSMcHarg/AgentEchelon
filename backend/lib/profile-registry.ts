/**
 * Profile registry (SPEC-CAPABILITY-PROFILES §3) — the ONLY place that interprets a
 * classification tag value or maps groups to clearance. Runtime sites (channel-flow,
 * router, RAG, abuse, battle, membership-audit) migrate to read through this in Phase 1,
 * replacing hardcoded VALID_TIERS / TIER_RANK / TIER_GROUPS / minTier / isAdvancedTier.
 *
 * Phase 0 guarantee: constructed from DEFAULT_PROFILES_CONFIG, every method returns the
 * SAME answer the legacy constants did — proven by profile-registry.test.ts. No behavior
 * changes until the runtime is wired in Phase 1.
 */

import {
  ProfilesConfig,
  DeploymentClassification,
  AssistantProfile,
  DEFAULT_PROFILES_CONFIG,
  validateProfilesConfig,
} from './config/profiles';

export class ProfileRegistry {
  private readonly byValue = new Map<string, DeploymentClassification>();
  private readonly byAlias = new Map<string, DeploymentClassification>();
  private readonly profilesByName = new Map<string, AssistantProfile>();

  constructor(private readonly config: ProfilesConfig) {
    // Fail loud on a malformed config, exactly as hydrate-time validation would.
    validateProfilesConfig(config);
    for (const c of config.classifications) {
      this.byValue.set(c.value, c);
      for (const a of c.aliases || []) this.byAlias.set(a, c);
    }
    for (const p of config.profiles) this.profilesByName.set(p.name, p);
  }

  /** The fail-closed default classification value (tag absent/invalid/unreadable). */
  get failClosedValue(): string {
    return this.config.failClosedTo;
  }

  /**
   * Resolve a raw tag value to a declared classification value. Primary match wins; else an
   * alias maps onto its successor classification; else fail-closed to `failClosedTo`.
   * Legacy equivalent: `VALID_TIERS.has(tag) ? tag : 'basic'` (getChannelTier), now with aliases.
   */
  resolveClassification(tagValue: string | null | undefined): string {
    if (tagValue) {
      if (this.byValue.has(tagValue)) return tagValue;
      const aliased = this.byAlias.get(tagValue);
      if (aliased) return aliased.value;
    }
    return this.config.failClosedTo;
  }

  /** True if the value is a declared classification (primary or alias). Lets callers distinguish
   *  a legitimately-floor-tagged channel from an unknown tag that fell back — preserving the
   *  fail-closed SecurityEvent warning. Legacy equivalent: `!!TIER_RANK[tag]`. */
  isKnownClassification(value: string | null | undefined): boolean {
    return !!value && (this.byValue.has(value) || this.byAlias.has(value));
  }

  /** Rank of a classification value; unknown values resolve fail-closed first. Legacy: TIER_RANK. */
  rank(classification: string): number {
    const c = this.byValue.get(classification) ?? this.byValue.get(this.config.failClosedTo)!;
    return c.rank;
  }

  /**
   * The lower-privilege (lower-rank) of two classifications — the min-cap downgrade.
   * Legacy: `minTier(a,b) = TIER_RANK[a] <= TIER_RANK[b] ? a : b` (ties return the first arg).
   */
  min(a: string, b: string): string {
    return this.rank(a) <= this.rank(b) ? a : b;
  }

  /**
   * Highest classification the caller's Cognito groups clear for; fail-closed floor when none match.
   * Legacy: resolveUserTier — highest matching tier group, default 'basic'.
   */
  clearanceForGroups(groups: string[]): string {
    let best = this.config.failClosedTo;
    for (const g of groups) {
      const target = this.config.groupClearance[g];
      if (target && this.byValue.has(target) && this.rank(target) > this.rank(best)) best = target;
    }
    return best;
  }

  /**
   * RAG scope for `contextScope: 'own-rank-and-below'`: every classification value at or below the
   * given classification's rank, ascending by rank. Legacy: the hardcoded tierScope ladders
   * (premium -> [basic,standard,premium], standard -> [basic,standard], basic -> [basic]).
   */
  scopeAtOrBelow(classification: string): string[] {
    const ceiling = this.rank(classification);
    return this.config.classifications
      .filter((c) => c.rank <= ceiling)
      .sort((x, y) => x.rank - y.rank)
      .map((c) => c.value);
  }

  /** The assistant profile serving a classification. Fail-closed classification first. */
  profileFor(classification: string): AssistantProfile {
    const c = this.byValue.get(classification) ?? this.byValue.get(this.config.failClosedTo)!;
    const p = this.profilesByName.get(c.profile);
    if (!p) throw new Error(`profile-registry: classification '${c.value}' -> unknown profile '${c.profile}'`);
    return p;
  }

  /** The Cognito group -> highest-classification-it-clears-for map (a copy). Group names are a
   *  deployment choice; used to create the groups and attach each to its classification's role. */
  get groupClearance(): Record<string, string> {
    return { ...this.config.groupClearance };
  }

  /** All declared classification values, ascending by rank. */
  classificationValues(): string[] {
    return [...this.config.classifications].sort((a, b) => a.rank - b.rank).map((c) => c.value);
  }

  /** The MOST-restrictive (highest-rank) classification value. Note this is the opposite end from
   *  `failClosedValue` (the lowest). RAG ingestion defaults untagged content here so it is never
   *  exposed to a lower classification (legacy `RAG_DEFAULT_TIER='premium'`, fail-closed). */
  get mostRestrictiveValue(): string {
    return this.config.classifications.reduce((hi, c) => (c.rank > hi.rank ? c : hi)).value;
  }
}

/** The registry over the shipped default (legacy-identical). Phase 1 reads this; a per-deployment
 *  config later replaces DEFAULT_PROFILES_CONFIG at the construction site. */
export const defaultProfileRegistry = new ProfileRegistry(DEFAULT_PROFILES_CONFIG);
