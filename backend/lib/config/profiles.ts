/**
 * Deployment classifications + assistant capability profiles (SPEC-CAPABILITY-PROFILES).
 *
 * This is the single source that separates the four concepts "tier" used to conflate:
 *  - CLASSIFICATION: a deployment-defined data/sensitivity label carried on the channel's
 *    immutable `classification` tag, with a declared rank order (the min-cap + RAG-scope order).
 *  - PROFILE: a named assistant capability bundle (model, classifier mode, timeout, task depth,
 *    RAG scope rule, rate limit, battle eligibility), bound to a classification by config.
 *  - CLEARANCE: the group -> classification mapping (Cognito group names are a deployment choice).
 *
 * Phase 0 (this file + profile-registry.ts) changes ZERO runtime behavior — nothing reads this
 * config yet; runtime sites migrate to read through the registry in Phase 1. `DEFAULT_PROFILES_CONFIG`
 * encodes the legacy basic/standard/premium triple with ONE deliberate deviation: basic's
 * classifierMode is 'llm', not the legacy keyword classifier (see the profiles block). The registry
 * itself returns legacy-identical answers for classification/rank/clearance/scope.
 *
 * The enforcement mechanism is unchanged: the tag key stays `classification`, immutable-by-policy,
 * IAM keyed on `aws:ResourceTag/classification`, resolution fail-closed. Classifications now
 * declare their rank order explicitly instead of inheriting it from a hardcoded `TIER_RANK`.
 */

/** A deployment-defined data/sensitivity label (the channel `classification` tag value). */
export interface DeploymentClassification {
  /** The tag value, e.g. 'confidential'. */
  value: string;
  /** Ordering for the min-cap and RAG scope (higher = more privileged). Unique across the set. */
  rank: number;
  /** Name of the assistant profile that serves channels with this classification. */
  profile: string;
  /** Legacy tag values this classification also recognizes (immutability: existing channels are
   *  never retagged). A fresh deploy that never used legacy values ships none. */
  aliases?: string[];
}

/** A named assistant capability bundle, bound to classifications by config. */
export interface AssistantProfile {
  /** e.g. 'analyst' — also the SSM segment: /agent-echelon/assistant/{name}/... */
  name: string;
  /** model-catalog key (replaces the {basic,standard,premium}ModelKey context). */
  modelKey: string;
  /** 'keyword' = the no-LLM keyword classifier; 'llm' = the model-backed classifier. */
  classifierMode: 'keyword' | 'llm';
  /** async-processor Lambda timeout. */
  timeoutSeconds: number;
  /** task-tracking depth. */
  taskSupport: 'lightweight' | 'full';
  /** RAG scope rule; the rank comes from the serving classification. */
  contextScope: 'own-rank-and-below';
  /** replaces RATE_LIMIT_<TIER> env. */
  rateLimitPerHour?: number;
  /** replaces allowedBattleTiers. */
  battleEligible?: boolean;
}

export interface ProfilesConfig {
  classifications: DeploymentClassification[];
  profiles: AssistantProfile[];
  /** Classification value used when the tag is absent/invalid/unreadable. MUST be the lowest rank. */
  failClosedTo: string;
  /** Cognito group name -> highest classification it clears for. */
  groupClearance: Record<string, string>;
}

/**
 * The shipped default IS the current triple, verbatim — so Phase 0 changes zero behavior.
 * Values captured from the legacy code:
 *  - ranks/ordering: TIER_RANK {basic:1,standard:2,premium:3} (router-agent-handler.ts)
 *  - modelKey: DEFAULT_TIER_MODEL_SELECTION {haiku,sonnet,opus} (model-strategy.ts)
 *  - classifierMode: 'llm' for all (DEVIATION: legacy basic used the keyword classifier;
 *    the new default classifies basic with the LLM too — surfaces when Phase 1 wires the router)
 *  - timeoutSeconds: per-tier async processor Lambda timeout (30/60/90; tier stacks)
 *  - rateLimitPerHour: rateLimitDefaults {60,120,240} (agent-tier-common.ts)
 *  - battleEligible: allowedBattleTiers default ['premium']
 *  - failClosedTo / groupClearance: resolveUserTier + getChannelTier fail-closed to 'basic'
 */
export const DEFAULT_PROFILES_CONFIG: ProfilesConfig = {
  classifications: [
    { value: 'basic', rank: 1, profile: 'basic' },
    { value: 'standard', rank: 2, profile: 'standard' },
    { value: 'premium', rank: 3, profile: 'premium' },
  ],
  profiles: [
    // classifierMode: 'llm' for ALL default profiles — basic is deliberately NOT keyword-classified
    // (a considered deviation from the legacy `classifyIntentBasic` path). 'keyword' remains a valid
    // schema option a deployment can select for a cheap profile; it is just not the default.
    { name: 'basic', modelKey: 'haiku', classifierMode: 'llm', timeoutSeconds: 30, taskSupport: 'full', contextScope: 'own-rank-and-below', rateLimitPerHour: 60, battleEligible: false },
    { name: 'standard', modelKey: 'sonnet', classifierMode: 'llm', timeoutSeconds: 60, taskSupport: 'full', contextScope: 'own-rank-and-below', rateLimitPerHour: 120, battleEligible: false },
    { name: 'premium', modelKey: 'opus', classifierMode: 'llm', timeoutSeconds: 90, taskSupport: 'full', contextScope: 'own-rank-and-below', rateLimitPerHour: 240, battleEligible: true },
  ],
  failClosedTo: 'basic',
  groupClearance: { basic: 'basic', standard: 'standard', premium: 'premium' },
};

/**
 * GUEST READINESS (not in the default deploy; introduced with a guest example).
 * A guest is expressible today with NO schema change: a lowest-rank classification
 * (e.g. rank 0) whose profile carries the strictest `rateLimitPerHour`, and
 * `failClosedTo: 'guest'` so an absent/invalid tag lands on the MOST restrictive profile.
 * The min-cap guarantees a guest in any higher-classified conversation resolves to guest.
 *
 * Reference model — communication-hub throttles guests on TWO layers:
 *   1. Per-message ceiling (messages/hour): guest 10 vs customer 100 vs staff 200 vs admin ∞.
 *      -> This maps directly onto `AssistantProfile.rateLimitPerHour` (guest = 10).
 *   2. Anonymous credential-vend throttle: 5 vends/hour PER SOURCE IP + captcha, enforced pre-auth
 *      at the guest credential-exchange (guests have no user identity to count yet).
 *      -> This is a SEPARATE mechanism, NOT a per-profile message-rate field. When a guest example
 *      is introduced, it belongs on a guest credential-exchange (IP-keyed), alongside this config.
 */

/**
 * Synth-time validation (mirrors the intent-pack hydrate checks). A malformed config fails
 * loudly at deploy rather than shipping an unreachable/degraded state. Throws on the first
 * violation with a named error.
 */
export function validateProfilesConfig(config: ProfilesConfig): void {
  const { classifications, profiles, failClosedTo, groupClearance } = config;

  if (!classifications?.length) throw new Error('profiles config: at least one classification is required');
  if (!profiles?.length) throw new Error('profiles config: at least one profile is required');

  const classValues = new Set(classifications.map((c) => c.value));
  const profileNames = new Set(profiles.map((p) => p.name));

  // ranks are unique
  const ranks = new Set<number>();
  for (const c of classifications) {
    if (ranks.has(c.rank)) throw new Error(`profiles config: duplicate rank ${c.rank} (ranks must be unique/totally ordered)`);
    ranks.add(c.rank);
  }

  // every classification's profile exists
  for (const c of classifications) {
    if (!profileNames.has(c.profile)) {
      throw new Error(`profiles config: classification '${c.value}' references unknown profile '${c.profile}'`);
    }
  }

  // failClosedTo exists and is the LOWEST rank (a fail-closed default that is not the floor is a misconfiguration)
  const failClosed = classifications.find((c) => c.value === failClosedTo);
  if (!failClosed) throw new Error(`profiles config: failClosedTo '${failClosedTo}' is not a declared classification`);
  const lowestRank = Math.min(...classifications.map((c) => c.rank));
  if (failClosed.rank !== lowestRank) {
    throw new Error(`profiles config: failClosedTo '${failClosedTo}' (rank ${failClosed.rank}) must be the lowest-rank classification (rank ${lowestRank})`);
  }

  // every groupClearance target exists
  for (const [group, target] of Object.entries(groupClearance || {})) {
    if (!classValues.has(target)) {
      throw new Error(`profiles config: groupClearance['${group}'] targets unknown classification '${target}'`);
    }
  }

  // alias values collide with no primary value and no other alias
  const seenAlias = new Set<string>();
  for (const c of classifications) {
    for (const a of c.aliases || []) {
      if (classValues.has(a)) throw new Error(`profiles config: alias '${a}' collides with a primary classification value`);
      if (seenAlias.has(a)) throw new Error(`profiles config: alias '${a}' is declared on more than one classification`);
      seenAlias.add(a);
    }
  }
}
