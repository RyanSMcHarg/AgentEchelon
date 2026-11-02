/**
 * Profile registry (SPEC-CAPABILITY-PROFILES §3) — the ONLY place that interprets a
 * classification tag value or maps groups to clearance. Runtime sites (channel-flow,
 * router, RAG, abuse, battle, membership-audit) migrate to read through this in Phase 1,
 * replacing hardcoded VALID_CLASSIFICATIONS / CLASSIFICATION_RANK / CLEARANCE_GROUPS / minRank / isAdvancedClassification.
 *
 * Constructed from the shipped catalog (DEFAULT_PROFILES_CONFIG), every method returns the SAME answer
 * the legacy constants did - proven by profile-registry.test.ts. A deployment runs the set it declares
 * (`resolveDeploymentProfiles`), which `defaultProfileRegistry` below carries.
 */

import {
  ProfilesConfig,
  DeploymentClassification,
  AssistantProfile,
  DEFAULT_PROFILES_CONFIG,
  validateProfilesConfig,
  PROFILE_REGISTRY_PATH_ENV,
  PROFILE_REGISTRY_S3_ENV,
  profilesConfigFromPublishedRows,
  type RegistryDrop,
  requireTopology,
  clientClassifications,
  registryRowOf,
  type ClassificationRegistryRow,
  type AssistantTopology,
  type ClassificationModels,
  type ClientClassification,
} from './config/profiles';

import { imageModelsAllowedFor } from './config/model-availability';
import { emitEmfMetric } from '../lambda/src/lib/emf-metrics';

/** The session tag a chat vend carries when the person holds the admin plane classification (`Holder.adminPlane`). */
export const ADMIN_PLANE_SESSION_TAG = 'adminPlane';

/**
 * WHAT A PERSON HOLDS, AS A VEND CARRIES IT: one member token and whether the admin plane is held beside it.
 *
 * The admin plane grants itself alone, so a person holding it with a member classification is not one
 * declared grant set. The token stands for the member classifications they hold, and `adminPlane` adds
 * admin conversations on top (the vend's `adminPlane` session tag). A person holding only the admin plane
 * has the admin plane as their token. Admin ACCESS (the console, the archive, every conversation) is
 * never read from here: it is the issuer's `admin: true` and its admin groups (SPEC-ADMIN-IDENTITY FR1).
 */
export interface Holder {
  /** The declared classification standing for exactly the member classifications held, or undefined. */
  token: string | undefined;
  /** True when the admin plane is held. */
  adminPlane: boolean;
}

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

  /** The classifications as the clients render them: names, audience, badge tokens and grants (`clientClassifications`). */
  /**
   * THE ROW `value` PUBLISHES TO THE RUNTIME REGISTRY (`registryRowOf`): its own declaration, its profiles and its
   * groups, as the stack that owns it writes it. Throws for a value this set does not declare.
   */
  registryRowOf(value: string): ClassificationRegistryRow {
    return registryRowOf(this.config, value);
  }

  forClients(): ClientClassification[] {
    return clientClassifications(this.config);
  }

  /**
   * THERE IS NO `failClosedValue`, AND NOTHING REPLACES IT.
   *
   * It returned the classification to use when a tag is absent, invalid or unreadable, and it was
   * only ever definable because the set was a ladder with a bottom. With `legal` and `finance` there
   * is no bottom: neither is the safe one, so substituting either is a guess about which data a
   * person may see. Every consumer that reached for it now refuses instead.
   *
   * `failClosedContentValue` below is NOT this under another name. It answers a different question -
   * what to STAMP content whose classification cannot be established - and a stamp has to be some
   * value or the row cannot be written at all. An access decision has the option of saying no.
   */

  /**
   * Resolve a raw tag value to a declared classification value, or `undefined`.
   *
   * IT USED TO FALL CLOSED TO THE FLOOR. There is no floor, so an unrecognized
   * tag is now unrecognized rather than quietly becoming the least-privileged classification. The
   * distinction matters most where it used to be invisible: a channel carrying a typo'd tag read as
   * a legitimately basic channel, and every consumer treated it as one.
   *
   * This normalizes an ALIAS onto the classification it names, which is the reason the function
   * exists at all.
   */
  resolveClassification(tagValue: string | null | undefined): string | undefined {
    if (tagValue) {
      if (this.byValue.has(tagValue)) return tagValue;
      const aliased = this.byAlias.get(tagValue);
      if (aliased) return aliased.value;
    }
    return undefined;
  }

  /** True if the value is a declared classification (primary or alias). Lets callers distinguish
   *  a legitimately-floor-tagged channel from an unknown tag that fell back — preserving the
   *  fail-closed SecurityEvent warning. Legacy equivalent: `!!CLASSIFICATION_RANK[tag]`. */
  isKnownClassification(value: string | null | undefined): boolean {
    return !!value && (this.byValue.has(value) || this.byAlias.has(value));
  }

  /**
   * True if a conversation may be CREATED at this classification.
   *
   * An admin-plane classification has no conversational runtime: its assistant owns the admin
   * notification channel and is silent by design, with no router, processor or task service behind
   * it. A conversation created at it would have an assistant that holds it and never answers.
   * The admin notification channel is provisioned by its own stack and is the one
   * admin-classified channel; no conversation-creation path may make another.
   *
   * An unknown value is not conversational either, so a caller cannot reach a classification this
   * deployment never declared by misspelling one.
   */
  isConversational(value: string | null | undefined): boolean {
    const c = value ? (this.byValue.get(value) ?? this.byAlias.get(value)) : undefined;
    return !!c && !c.adminPlane;
  }

  /**
   * CAN a duel run in this classification: does its deployment wire the battle plumbing (ADR-049).
   *
   * THE CAPABILITY ONLY. It does not say battle is turned ON, which is classification-level operator
   * policy held at runtime and off by default. Both are required, and they are asked in this order so
   * that nothing offers an operator a switch for a classification whose processor holds none of the
   * grants a duel needs.
   *
   * An unknown or admin-plane value is not capable: an admin-plane classification has no conversational
   * runtime to duel in, so the flag cannot make it one.
   */
  isBattleCapable(value: string | null | undefined): boolean {
    const c = value ? (this.byValue.get(value) ?? this.byAlias.get(value)) : undefined;
    return !!c && !c.adminPlane && c.battleCapable === true;
  }

  /**
   * DOES THIS CLASSIFICATION HAND OVER `output` (DESIGN-CAPABILITY-REFUSAL §2)? A `document` is what its
   * config declares (`produces`). An `image` is DERIVED from its model selection: a classification produces
   * images exactly when it selects an image model (`imageModelsAllowedFor`), the same list its stack's image
   * grant is built from, so the refusal's pointer and the grant cannot disagree. An unknown
   * or admin-plane value produces nothing a conversation can be pointed at.
   */
  produces(value: string | null | undefined, output: 'document' | 'image'): boolean {
    const c = value ? (this.byValue.get(value) ?? this.byAlias.get(value)) : undefined;
    if (!c || c.adminPlane) return false;
    if (output === 'image') return imageModelsAllowedFor(c.value).length > 0;
    return (c.produces ?? []).includes(output);
  }

  /** The name a person sees for a classification; its value when none is declared. */
  displayNameOf(value: string): string {
    const c = this.byValue.get(value) ?? this.byAlias.get(value);
    return c?.displayName || c?.value || value;
  }

  /** The admin-plane classification values, for a consumer that receives the registry as data. */
  adminPlaneValues(): string[] {
    return this.config.classifications.filter((c) => c.adminPlane).map((c) => c.value);
  }

  /**
   * MAY A PRINCIPAL HOLDING `holder` REACH `target`? This replaces the min-cap.
   *
   * `min(a, b)` returned the lower-ranked of two classifications, and the router used it to serve a
   * person at the lesser of their clearance and the conversation's. That is a coherent question only
   * on a ladder. Between `legal` and `finance` there is no lesser: the honest answer is not a
   * downgrade but a yes or a no, and it comes from the set.
   *
   * SET MEMBERSHIP, WHICH IS WHAT IAM WAS ALREADY EVALUATING. The condition generated from `grants`
   * is `StringEquals: { 'aws:ResourceTag/classification': [...] }`, and a list there is an OR. So
   * this function agrees with the deployed policy by construction rather than by a second reading of
   * the same intent - which is how the audit and the exchange came to disagree.
   */
  reaches(holder: string, target: string): boolean {
    return this.grantsFor(holder).includes(target);
  }

  /**
   * The classification these Cognito groups clear the caller for, or `undefined`.
   *
   * WAS "THE HIGHEST GROUP THEY HOLD", WHICH IS NOT A QUESTION A SET CAN ANSWER. Someone in both
   * `legal` and `finance` holds neither "higher"; they hold a combination. `resolveHolderToken`
   * already answers this correctly - union the grants, find the declared classification whose own
   * grant set IS that union - and this now delegates to it rather than keeping a second, rank-based
   * answer to the same question beside it.
   *
   * `undefined` when the groups name a combination this deployment has not declared. That is not a
   * degradation to be smoothed over: a combination worth granting is worth declaring, and the
   * alternative is inventing reach nobody wrote down.
   */
  clearanceForGroups(groups: string[]): string | undefined {
    return this.resolveHolderToken(groups);
  }

  /**
   * THE CLASSIFICATIONS A PRINCIPAL HOLDING `classification` MAY REACH.
   *
   * The ONE resolver for a principal's reach, and the only place the enum token a principal carries
   * is expanded into the set a policy is generated from. A classification that declares `grants` uses
   * it verbatim, and every classification declares one. There is no order left to fall back to.
   *
   * THIS IS THE ONLY REACH QUESTION LEFT. It used to sit beside `scopeAtOrBelow`, which answered
   * "what sits at or below this rank". The two agreed only while every grant happened to be a rank
   * prefix, and a deployment whose classifications are `legal` and `finance` has no prefixes at all.
   *
   * Ordered by declaration on the way out, so a generated policy and a generated role name are stable across
   * runs rather than reflecting the order somebody happened to write the config in. Unknown entries
   * are dropped here as defence in depth; `validateProfilesConfig` refuses them at construction.
   */
  grantsFor(classification: string): string[] {
    const resolved = this.resolveClassification(classification);
    const c = resolved ? this.byValue.get(resolved) : undefined;
    // NO FALLBACK TO AN ORDER. This used to drop to `scopeAtOrBelow` when a classification declared
    // no grants, which quietly re-imposed the ladder on a deployment that had not asked for one.
    // `grants` is required now, so an absent set means an unknown classification, and the honest
    // answer to "what does an unknown classification reach" is nothing.
    if (!c?.grants?.length) return [];
    // DECLARATION ORDER, so a generated policy and a generated role name stay stable across runs.
    // It used to sort by rank; with no rank, the order the deployment wrote is the stable one.
    const declared = this.config.classifications.map((x) => x.value);
    return c.grants
      .filter((v) => this.byValue.has(v))
      .sort((x, y) => declared.indexOf(x) - declared.indexOf(y));
  }

  /**
   * THE ROLES A CLASSIFICATION INSTANTIATES, always including `primary`.
   *
   * `primary` is implicit rather than something every classification has to remember to declare: a
   * classification with no assistant serving it is not a state the platform has, so omitting it
   * could only ever be a mistake. A declared list that forgets it gets it back, in first position,
   * because the seeded assistant holds it.
   *
   * ORDER IS THE DECLARATION'S, and stable, because it feeds generated construct ids and therefore
   * deployed role names. Sorting here would rename a deployed acting role the first time a role was added.
   */
  rolesFor(classification: string): string[] {
    const resolved = this.resolveClassification(classification);
    const c = resolved ? this.byValue.get(resolved) : undefined;
    const declared = c?.roles?.length ? c.roles : ['primary'];
    return declared.includes('primary') ? declared : ['primary', ...declared];
  }


  /**
   * EVERY classification the caller's groups clear them for, in declaration order.
   *
   * `clearanceForGroups` answers "the highest one", which is the right question only while the axis is
   * a ladder. This answers what they actually HOLD, which is a set - a person may be in `premium` and
   * in `finance`, and neither contains the other.
   *
   * Groups that map to nothing are ignored rather than fail-closed to the floor: a persona group, a
   * directory group, an SSO group the deployment does not map are not clearances and must not be read
   * as the lowest one. An empty result is the caller's real answer and `resolveHolderToken` decides
   * what to do with it.
   */
  clearancesForGroups(groups: string[]): string[] {
    const held = new Set<string>();
    for (const g of groups) {
      const target = this.config.groupClearance[g];
      if (target && this.byValue.has(target)) held.add(target);
    }
    const declared = this.config.classifications.map((x) => x.value);
    return [...held].sort((a, b) => declared.indexOf(a) - declared.indexOf(b));
  }

  /**
   * THE ONE ENUM TOKEN that stands for everything these groups clear for.
   *
   * ── WHY A TOKEN AND NOT THE SET ─────────────────────────────────────────────────────────────────
   *
   * A principal carries its classification as a TAG, and a tag is one bounded Key->Value. An IAM
   * session tag is single-valued, and a policy compares strings rather than sets - so the set cannot
   * live on the principal, and it cannot be evaluated there either. The token lives on the principal;
   * `grants` expands it where the policy is generated. That is also why an exchange role exists per
   * token: the expansion has to happen at deploy, not at request time.
   *
   * ── HOW THE TOKEN IS CHOSEN ─────────────────────────────────────────────────────────────────────
   *
   * Take the UNION of what every held classification grants, then find the declared classification
   * whose own grant set IS that union. That token means exactly what the person holds - no more, and
   * no less.
   *
   * Nothing is invented. If no declared classification matches the union, the person holds a
   * combination this deployment has not given a name to, and the answer is `undefined` rather than
   * the nearest fit. A "closest" token is either too much reach or too little, and one of those is a
   * breach: a combination worth granting is worth declaring. It used to answer with the fail-closed
   * floor, which was the nearest fit by another name.
   *
   * Ties resolve to DECLARATION ORDER, so the choice is deterministic across runs. Two declared
   * classifications with identical grant sets are a config smell, not a decision this function should
   * be making.
   */
  resolveHolderToken(groups: string[]): string | undefined {
    return this.tokenForHeldClassifications(this.clearancesForGroups(groups));
  }

  /**
   * The one token standing for a set of classifications somebody already HOLDS.
   *
   * Split out of `resolveHolderToken` because two callers ask the same question from different
   * starting points: that one starts from Cognito GROUP names, and the admin scope starts from
   * classification VALUES a caller's groups are named after. Both then need "which declared
   * classification means exactly this set", and having it once is what stops the two answers drifting
   * the way the audit and the exchange did.
   */
  tokenForHeldClassifications(held: string[]): string | undefined {
    return this.holderOf(held).token;
  }

  /**
   * THE HOLDER A SET OF HELD CLASSIFICATIONS STANDS FOR: the token for the member classifications held,
   * and whether the admin plane is held beside them. The admin plane is left out of the token's union,
   * because it grants itself alone and no declared classification grants it with anything else; held
   * alone, it is the token. See `Holder`.
   */
  holderOf(held: string[]): Holder {
    const plane = new Set(this.adminPlaneValues());
    const heldPlane = held.filter((v) => plane.has(v));
    const members = held.filter((v) => !plane.has(v));
    if (members.length === 0) return { token: heldPlane[0], adminPlane: heldPlane.length > 0 };
    return { token: this.tokenForUnion(members), adminPlane: heldPlane.length > 0 };
  }

  /** The holder these groups stand for (`holderOf` over `clearancesForGroups`). */
  holderForGroups(groups: string[]): Holder {
    return this.holderOf(this.clearancesForGroups(groups));
  }

  /** EVERYTHING A HOLDER REACHES: its token's grants, and the admin plane when it is held. */
  reachOf(holder: Holder): string[] {
    const reach = holder.token ? this.grantsFor(holder.token) : [];
    if (!holder.adminPlane) return reach;
    return [...new Set([...reach, ...this.adminPlaneValues()])];
  }

  /** May this holder reach `target`? `reaches` for a token, plus the admin plane when it is held. */
  holderReaches(holder: Holder, target: string): boolean {
    return this.reachOf(holder).includes(target);
  }

  private tokenForUnion(held: string[]): string | undefined {
    if (held.length === 0) return undefined;

    const union = new Set(held.flatMap((v) => this.grantsFor(v)));
    const matches = this.config.classifications.filter((c) => {
      const g = this.grantsFor(c.value);
      return g.length === union.size && g.every((v) => union.has(v));
    });
    if (matches.length === 0) return undefined;
    // Ties resolve to DECLARATION ORDER now that there is no rank to break them with. Two declared
    // classifications with identical grant sets are a config smell rather than a decision this
    // function should be making, and `validateProfilesConfig` is where that belongs.
    return matches[0].value;
  }

  /**
   * Whether these groups resolve to a token that genuinely covers them.
   *
   * `resolveHolderToken` fail-closes silently, which is correct for an access decision and useless
   * for an operator: a person who was granted two clearances and reaches neither has a CONFIG defect,
   * and nothing in the vend would say so. A caller that can log asks this first.
   */
  holderTokenCovers(groups: string[]): boolean {
    const held = this.clearancesForGroups(groups);
    if (held.length === 0) return true;
    const token = this.resolveHolderToken(groups);
    // NO TOKEN MEANS NOT COVERED. `resolveHolderToken` used to answer the floor for an undeclared
    // combination, so this compared the person's holdings against the floor's grants and reported
    // the shortfall. It now answers `undefined`, and the honest reading of "there is no token for
    // what this person holds" is that nothing covers them.
    if (!token) return false;
    const granted = new Set(this.reachOf(this.holderOf(held)));
    return held.every((v) => granted.has(v));
  }

  // `scopeAtOrBelow` IS DELETED. It answered "what sits at or below this rank", which only has an
  // answer on a ladder, and its sole remaining caller was the fallback inside `grantsFor`. Deleted
  // rather than left unused, because the next person wanting "everything below this" would find it
  // and reintroduce the ordering by hand.

  /**
   * The ONE resolver both the IAM statement generator and the retrieval walk consume for
   * `contextScope: 'granted'` (the only value the schema admits): the S3 `context/{classification}/`
   * prefixes the assistant may read, derived from `grantsFor` so a renamed or added classification can
   * never drift IAM apart from retrieval (the fix for the hardcoded `CLASSIFICATION_PREFIXES` list).
   * Trailing slash included; append `*` for an IAM resource or prefix condition.
   *
   * THE NAME WAS `contextPrefixesAtOrBelow` AND THE OPTION WAS `highestFirst`, both of which describe a
   * ladder. There is no rank (ADR-046): the prefixes are the declared grant set, and `contextScope`
   * accepts one literal, `'granted'`, which the old name contradicted.
   *
   * `reversed` reverses `grantsFor`'s declaration order, and it is spelled as what it does rather than
   * as what its one caller wants. On a PREFIX-SHAPED deployment, where a classification's grants read
   * up to itself, reversing puts the serving classification's own documents first, so those survive a
   * character budget when the retrieval walk truncates. That is why the option exists; it is not a
   * guarantee the method can make, because a deployment free to declare its grants in any order can
   * put anything last. The IAM generator takes the default order, where the order does not matter.
   */
  contextPrefixesForRole(classification: string, role: string, opts?: { reversed?: boolean }): string[] {
    const granted = this.grantsFor(classification);
    const resolved = this.resolveClassification(classification);
    const declared = resolved ? this.byValue.get(resolved)?.roleContext?.[role] : undefined;
    if (declared === undefined) return this.contextPrefixesGranted(classification, opts);
    const outside = declared.filter((c) => !granted.includes(c));
    if (outside.length) {
      throw new Error(
        `roleContext for (${classification}, ${role}) names ${outside.join(', ')}, which ${classification} does not grant; `
        + 'a role can be narrowed below its classification, never widened past it',
      );
    }
    // In the classification's own grant order, so `reversed` means the same thing it means above.
    const values = granted.filter((c) => declared.includes(c));
    const ordered = opts?.reversed ? [...values].reverse() : values;
    return ordered.map((c) => `context/${c}/`);
  }

  /**
   * The `context/{c}/` prefixes the classification grants, every role's boundary. See `contextPrefixesForRole`
   * for one role's own scope, which is what an assistant holds and what a turn reads.
   */
  contextPrefixesGranted(classification: string, opts?: { reversed?: boolean }): string[] {
    // THE HOLDER SET, so the S3 prefixes an assistant may read and the channels it may act on are
    // derived from one answer. These are both reach questions; deriving one from grants and the other
    // from rank is how an assistant ends up able to message a conversation whose context it cannot
    // read, or the reverse.
    const values = this.grantsFor(classification);
    const ordered = opts?.reversed ? [...values].reverse() : values;
    return ordered.map((c) => `context/${c}/`);
  }

  /**
   * The assistant profile serving a classification, or `undefined` for one this deployment does not
   * declare.
   *
   * IT USED TO SUBSTITUTE THE FLOOR'S PROFILE for an unknown classification, so a caller asking about
   * a classification that does not exist got a working profile back and never learned it had asked a
   * nonsense question. With no floor there is nothing to substitute, and the caller decides.
   */
  /**
   * THE MODELS A CLASSIFICATION SELECTS FROM THE INSTANCE'S CATALOG, and its default (`DeploymentClassification.models`;
   * the platform allows, the classification selects, the profile uses). Undefined for a value this deployment
   * does not declare, so a caller refuses rather than reading another classification's.
   */
  modelsOf(classification: string | null | undefined): ClassificationModels | undefined {
    const c = classification ? (this.byValue.get(classification) ?? this.byAlias.get(classification)) : undefined;
    return c?.models ? { selected: [...c.models.selected], default: c.models.default } : undefined;
  }

  /** Whether a classification selects this catalog key. False for an undeclared classification or key. */
  selectsModel(classification: string | null | undefined, key: string | null | undefined): boolean {
    return !!key && (this.modelsOf(classification)?.selected.includes(key) ?? false);
  }

  /** A classification's default model key, or undefined for a value this deployment does not declare. */
  defaultModelOf(classification: string | null | undefined): string | undefined {
    return this.modelsOf(classification)?.default;
  }

  /** The topology a classification's assistant stack builds. Throws for a classification that declares none. */
  requireTopology(classification: string): AssistantTopology {
    return requireTopology(classification, this.config);
  }

  profileFor(classification: string): AssistantProfile | undefined {
    const c = this.byValue.get(classification);
    if (!c) return undefined;
    const p = this.profilesByName.get(c.profile);
    if (!p) throw new Error(`profile-registry: classification '${c.value}' -> unknown profile '${c.profile}'`);
    return p;
  }

  /**
   * The profile for a classification the caller KNOWS this deployment declares - its own.
   *
   * FOR THE CALL SITES WHERE `undefined` IS NOT A RUNTIME CONDITION BUT A BROKEN DEPLOYMENT. A
   * per-classification Lambda asking for its own classification's profile cannot meaningfully handle
   * "there isn't one": it was deployed by the stack that declares it. Throwing says that plainly and
   * once, which is better than the two alternatives - a non-null assertion at forty call sites, which
   * silences the question without answering it, or an `undefined` branch at each that no test can
   * reach and whose fallback would be invented.
   *
   * Use `profileFor` wherever the classification came from OUTSIDE this deployment's own config - a
   * channel tag, a request, a stored row - because there `undefined` is a real answer.
   */
  requireProfileFor(classification: string): AssistantProfile {
    const p = this.profileFor(classification);
    if (!p) {
      throw new Error(
        `profile-registry: no profile for classification '${classification}'. This is a deployment `
        + 'fault: a component asked for its own classification and the config does not declare it.',
      );
    }
    return p;
  }

  /** The compiled-in (seed) profile by its NAME, or undefined if none is declared. This is the
   *  fail-closed fallback the runtime active-version resolver reverts to when the SSM definition is
   *  absent/corrupt (SPEC-PORTABLE-PROFILES §3 "fail-closed: ... falls back to the seed").
   *  Unlike profileFor(classification), this keys on the profile name (the /assistant/{name} segment). */
  profileByName(name: string): AssistantProfile | undefined {
    return this.profilesByName.get(name);
  }

  /**
   * EVERY DECLARED ASSISTANT, not one per classification.
   *
   * The distinction became real when a classification gained a second role: deriving the set by
   * mapping each classification to `requireProfileFor` returns the assistant that classification
   * NAMES, which is its primary, so every other assistant it hosts was invisible - including to the
   * console that is supposed to let a team manage it. An assistant nobody can list is an assistant
   * nobody can version, validate or roll back.
   *
   * Declaration order, and deduplicated, because two classifications may name one profile.
   */
  profileNames(): string[] {
    return [...new Set(this.config.profiles.map((p) => p.name))];
  }

  /**
   * THE CLASSIFICATION AN ASSISTANT SERVES, keyed by the assistant's NAME.
   *
   * The reverse of `profileFor`, and it exists because the two stopped being the same string. An
   * assistant used to be named after its classification, so every caller that needed one from the
   * other just used the value it had. Once assistants got their own names (`premium` is served by
   * `advisor`), each of those sites became a comparison between two things that can never be equal -
   * and none of them errored, because a mismatch is exactly what they were built to report.
   *
   * Returns `undefined` rather than guessing when the name names no declared assistant. A caller
   * building an SSM key wants a fallback; a caller making a SECURITY decision wants the absence, so
   * neither gets to inherit the other's choice from here.
   */
  classificationFor(profileName: string): string | undefined {
    if (!profileName) return undefined;
    return this.classificationValues().find((c) => this.profileFor(c)?.name === profileName);
  }

  /**
   * The assistant assigned to one classification and role: the classification's own profile for
   * `primary`, and `${role}-${classification}` for every other declared role. ONE naming rule, read by
   * the stack that provisions the assistant and by everything that resolves an assistant back to its role.
   */
  roleAssistantName(classification: string, role: string): string | undefined {
    if (role === 'primary') return this.profileFor(classification)?.name;
    return this.rolesFor(classification).includes(role) ? `${role}-${classification}` : undefined;
  }

  /**
   * The `(classification, role)` assignment a deploy-time assistant holds: its classification's primary, or
   * the role whose composed name it is. Undefined for an alt (see `roleOfAlt`), an ambiguous name, or a
   * name this deployment does not declare.
   */
  roleOfAssistant(name: string): { classification: string; role: string } | undefined {
    if (!name) return undefined;
    const primaryOf = this.classificationFor(name);
    if (primaryOf) return { classification: primaryOf, role: 'primary' };
    const matches: Array<{ classification: string; role: string }> = [];
    for (const c of this.classificationValues()) {
      for (const role of this.rolesFor(c)) {
        if (role !== 'primary' && this.roleAssistantName(c, role) === name) matches.push({ classification: c, role });
      }
    }
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * THE ALT'S NAME: the challenger assistant of one `(classification, role)` assignment (ADR-050).
   *
   * It carries the classification because an assistant's name is instance-wide (`/assistant/{name}`) and
   * a role is not: `alt-primary` would name a different assistant in every classification. Undefined for a
   * role the classification does not declare, or a classification this deployment does not declare.
   */
  altAssistantName(classification: string, role: string): string | undefined {
    const resolved = this.resolveClassification(classification);
    if (!resolved || !this.rolesFor(resolved).includes(role)) return undefined;
    return `alt-${role}-${resolved}`;
  }

  /**
   * The `(classification, role)` an alt's name belongs to, or undefined when the name is not an alt this deployment declares.
   * EXACTLY ONE OR NONE, like `classificationOfAssistant`: a role and a classification that both contain a
   * dash can compose one name two ways, and neither reading is more correct than the other.
   */
  roleOfAlt(name: string): { classification: string; role: string } | undefined {
    if (!name || !name.startsWith('alt-')) return undefined;
    const matches: Array<{ classification: string; role: string }> = [];
    for (const c of this.classificationValues()) {
      for (const role of this.rolesFor(c)) {
        if (this.altAssistantName(c, role) === name) matches.push({ classification: c, role });
      }
    }
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * THE ALT'S DEPLOY-TIME DESCRIPTOR: the compiled profile of its role's live assistant, under the alt's
   * name. A DECLARED DERIVATION, not a substitution at turn time: the fields it carries (`classifierMode`,
   * `rateLimitPerHour`, the timeout) describe the role's infrastructure, which the alt shares, and
   * everything a person sees comes from the alt's own published version (ADR-049, ADR-050).
   */
  altSeedFor(name: string): AssistantProfile | undefined {
    const role = this.roleOfAlt(name);
    if (!role) return undefined;
    const roleAssistant = this.roleAssistantName(role.classification, role.role);
    const live = roleAssistant ? this.profileByName(roleAssistant) : undefined;
    return live ? { ...live, name } : undefined;
  }

  /**
   * A name no runtime assistant may take: a classification value, a declared profile, any alt name, or
   * any composed role-assistant name. These are the names the deploy-time assistants and the alts already own.
   */
  isReservedAssistantName(name: string): boolean {
    if (!name) return true;
    if (name.startsWith('alt-')) return true;
    if (this.classificationValues().includes(name)) return true;
    if (this.profileByName(name)) return true;
    return this.classificationValues().some((c) => this.rolesFor(c).some((r) => r !== 'primary' && `${r}-${c}` === name));
  }

  /**
   * THE CLASSIFICATION AN ASSISTANT ACTS IN, for ANY declared assistant (ADR-042, ADR-043 decision 3).
   *
   * `classificationFor` answers only for a classification's primary, because it reads the
   * classification's `profile` field; a role's assistant (`ops-premium`) is named by no classification,
   * so it answered undefined, and a boundary check built on it reported every one of that assistant's
   * messages as an undeclared identity acting out of place. This also walks the declared roles.
   *
   * EXACTLY ONE OR NONE: two declared `(classification, role)` pairs can compose to one name (`ops` in
   * `a-b`, `ops-a` in `b`), and the first in declaration order is not more correct than the second.
   */
  classificationOfAssistant(name: string): string | undefined {
    if (!name) return undefined;
    const primary = this.classificationFor(name);
    if (primary) return primary;
    const alt = this.roleOfAlt(name);
    if (alt) return alt.classification;
    const matches = new Set<string>();
    for (const c of this.classificationValues()) {
      for (const role of this.rolesFor(c)) {
        if (role !== 'primary' && this.roleAssistantName(c, role) === name) matches.add(c);
      }
    }
    return matches.size === 1 ? [...matches][0] : undefined;
  }

  /**
   * WHAT AN ASSISTANT IS CALLED, resolved in one place so no caller invents its own fallback.
   *
   * Precedence: the active VERSION's `displayName` (a team renamed it), then the profile's configured
   * `displayName` (what it was provisioned as), then the profile NAME itself (a deployment that never
   * set one). The version is passed in rather than read here, because this registry is synth-time
   * config and a version is runtime data - a resolver that reached for SSM would work in the stack and
   * not in the Lambda, or the reverse.
   *
   * The identifier is never a fallback for anything else: it renders as a name only when no name was
   * ever given, which is a deployment that has not decided rather than a lookup that failed.
   */
  displayNameFor(profileName: string, versionDisplayName?: string): string {
    if (versionDisplayName && versionDisplayName.trim()) return versionDisplayName;
    return this.profileByName(profileName)?.displayName?.trim() || profileName;
  }

  /** The Cognito group -> the-classification-it-clears-for map (a copy). Group names are a
   *  deployment choice; used to create the groups and attach each to its classification's role. */
  get groupClearance(): Record<string, string> {
    return { ...this.config.groupClearance };
  }

  /**
   * THE MUTUALLY-EXCLUSIVE CLEARANCE GROUPS, in the declaration order of what they clear for.
   *
   * The groups a person holds exactly one of, so a writer that sets somebody's clearance knows which
   * other groups it must remove. Derived from `groupClearance` rather than listed, because a listed
   * copy is deployment config frozen in code: two Lambdas carried
   * `['basic', 'standard', 'premium']` and a deployment that declared a fourth classification could
   * leave a person in two groups at once, with precedence decided by whichever writer ran last.
   *
   * ── ADMIN-PLANE GROUPS ARE DELIBERATELY EXCLUDED ────────────────────────────────────────────────
   *
   * `admins` maps to a classification too, but it is a SEPARATE GRANT rather than a level somebody
   * moves between - an administrator also holds a member clearance beside it. Returning it here would
   * make every clearance change strip administration from whoever it touched: set an administrator's
   * clearance to `standard` and the exclusivity sweep would remove them from `admins`, silently
   * demoting them as a side effect of an unrelated clearance edit.
   *
   * So this is the answer to "which groups are exclusive of each other", NOT "which groups convey a
   * classification" - `groupClearance` already answers that, and `clearancesForGroups` reads all of
   * them.
   */
  clearanceGroups(): string[] {
    return Object.entries(this.config.groupClearance)
      .filter(([, value]) => {
        const c = this.byValue.get(value);
        return !!c && !c.adminPlane;
      })
      .sort((a, b) => this.declarationIndex(a[1]) - this.declarationIndex(b[1]))
      .map(([group]) => group);
  }

  /** Membership group -> the classification its members must already be cleared for (ProfilesConfig.membershipGroups). */
  membershipGroups(): Record<string, string> {
    return { ...(this.config.membershipGroups || {}) };
  }

  /**
   * May a person holding `groups` be in membership group `group`? Only when the clearance those groups
   * resolve to (the same token the credential exchange vends) reaches what the group requires. A
   * membership group in `groups` contributes nothing to that, because it grants nothing.
   */
  meetsMembershipRequirement(groups: string[], group: string): boolean {
    const required = this.config.membershipGroups?.[group];
    if (!required) return false;
    return this.holderReaches(this.holderForGroups(groups), required);
  }

  /** The classification the proactive briefing is held at (the one declaring `holdsBriefing`), or `undefined` when none does. */
  briefingClassification(): string | undefined {
    return this.config.classifications.find((c) => c.holdsBriefing)?.value;
  }

  /** All declared classification values, in declaration order. */
  classificationValues(): string[] {
    return this.config.classifications.map((c) => c.value);
  }

  /** The classifications whose people are the deployment's own (every one but an outside audience). */
  memberClassificationValues(): string[] {
    return this.config.classifications.filter((c) => c.audience !== 'outside').map((c) => c.value);
  }

  /**
   * The classifications whose people come from outside the deployment (`audience: 'outside'`): the
   * guest. An issuer of kind `guest` vends exactly one of them.
   */
  outsideClassificationValues(): string[] {
    return this.config.classifications.filter((c) => c.audience === 'outside').map((c) => c.value);
  }

  /** The Cognito precedence a classification's clearance groups are created with (`groupPrecedence`), or undefined. */
  groupPrecedenceOf(value: string): number | undefined {
    return (this.byValue.get(value) ?? this.byAlias.get(value))?.groupPrecedence;
  }

  /**
   * WHO A CONVERSATION AT `value` IS FOR, as its channel's immutable `audience` tag carries it: `outside` for
   * a classification declaring that audience, `members` for every other (the admin plane included). Thrown
   * for an undeclared value, so a creator never stamps an audience it guessed.
   */
  audienceOf(value: string): 'members' | 'outside' {
    const c = this.byValue.get(value) ?? this.byAlias.get(value);
    if (!c) throw new Error(`audienceOf: unknown classification ${value}`);
    return c.audience === 'outside' ? 'outside' : 'members';
  }

  /** Where a classification sits in the config, which is the only stable order left. */
  private declarationIndex(value: string): number {
    return this.config.classifications.findIndex((c) => c.value === value);
  }

  /**
   * THE CLASSIFICATION THAT REACHES EVERY OTHER, or `undefined` when no single one does.
   *
   * This was `mostRestrictiveValue`, "the top of the ladder", read by boundary proofs. There is no
   * top: between `legal` and `finance` neither is above the other and this correctly answers
   * `undefined`. What a boundary proof actually wants is the classification whose reach contains
   * everything, which on a ladder IS the top one and on a peer set may simply not exist.
   *
   * AMONG THE DEPLOYMENT'S OWN CLASSIFICATIONS. An outside classification (the guest) is reached by its
   * own people alone, by declaration, so no member classification contains it and none is meant to.
   */
  get widestReachingValue(): string | undefined {
    // THE ADMIN PLANE IS NOT AMONG THEM: it grants itself alone and nothing else grants it.
    const plane = new Set(this.adminPlaneValues());
    const all = this.memberClassificationValues().filter((v) => !plane.has(v));
    return all.find((v) => {
      const g = this.grantsFor(v);
      return all.every((other) => g.includes(other));
    });
  }

  /**
   * The value to stamp CONTENT whose classification cannot be established.
   *
   * The most restrictive classification an ordinary conversation can still be served at - so the
   * content is withheld from every classification below it, and is not withheld from everyone.
   *
   * ── WHY THIS IS NOT `mostRestrictiveValue` ──────────────────────────────────────────────────────
   *
   * They agreed until an admin-plane classification was declared beside the ordinary classifications, and the
   * difference is not cosmetic. Three writers use this value: untagged knowledge-base ingestion, a
   * conversation summary whose channel tag could not be read, and the NULL-classification bootstrap
   * that stamps every bounded table. Retrieval runs as a per-classification database role and reads
   * the set its classification grants, and no user conversation is ever served on the admin plane - so content
   * stamped there is read by nothing, in silence and with no error. "Readable by administrators only"
   * is the sentence that makes that sound safe; "retrievable by nobody" is what it does.
   *
   * Throws for a deployment that declares no ordinary classification at
   * all, which is a degenerate config rather than a case to design for.
   */
  /**
   * The conversations an ASSISTANT of this classification may act in, which is its own and no other.
   *
   * ── WHY THIS IS NOT `grantsFor` ────────────────────────────────────────────────────────────────
   *
   * `grantsFor` answers "what may a principal HOLDING this classification reach", and for a person
   * that is the declared grant set: a premium user speaking in a basic room is ordinary where premium
   * declares basic. An assistant is not a person holding a set. Every classification has its own assistant, and a channel is intended to
   * carry only its classification-matched one, so an assistant's reach is a point.
   *
   * The two were one function because one helper built both boundaries, and the comment on that
   * helper says so: "the same boundary, one definition". It was correct for the user roles it was
   * written for and was applied unchanged to the assistant roles. ADR-042 is the record.
   *
   * ── ONE READER, TWO PROJECTIONS ────────────────────────────────────────────────────────────────
   *
   * Derived from `grantsFor` rather than read from config independently, so this cannot drift away
   * from the set it narrows. That drift is not hypothetical: `scopeAtOrBelow` and `grantsFor` once
   * diverged and the Aurora reader roles and the retrieval filter disagreed silently, which is the
   * failure `classification-boundary-sql.ts` warns about. The filter is a no-op on a well-formed
   * config, because `validateProfilesConfig` refuses a grant set that omits its own value - and on a
   * malformed one it yields an EMPTY set, which fails closed rather than falling back to a ladder.
   */
  channelsActableBy(classification: string): string[] {
    const own = this.resolveClassification(classification);
    return this.grantsFor(classification).filter((v) => v === own);
  }


  get failClosedContentValue(): string {
    // NEVER AN OUTSIDE CLASSIFICATION. The guest is reached by the fewest holders of all (its own people),
    // so counting reach would pick it, and content nobody could classify would be shown to anonymous
    // visitors and to nobody else: the opposite of withholding it.
    const conversational = this.config.classifications.filter((c) => !c.adminPlane && c.audience !== 'outside').map((c) => c.value);
    // NOT OPTIONAL, because a stamp has to be some value and every caller is a WRITE that cannot
    // proceed without one. A deployment with no conversational classification has no conversations,
    // so nothing can reach these call sites; that is a broken config rather than a state to branch on.
    if (conversational.length === 0) {
      throw new Error('profile-registry: no conversational classification declared; there is nothing to stamp content as');
    }
    // "MOST RESTRICTIVE" WITHOUT AN ORDER: the classification the FEWEST holders reach. It used to be
    // the highest rank among the conversational classifications, which is the same answer on a ladder
    // (premium is reached only by premium and admin) and has no meaning between `legal` and
    // `finance`. Counting reach is the order-free form of the same question, and it is the question
    // that was always being asked - withhold this content from as many principals as possible while
    // still leaving somebody able to read it.
    //
    // A TIE IS REAL AND IS NOT AN ERROR. With `legal` and `finance` as peers, neither reaches the
    // other and both tie at one. Declaration order breaks it, and the deployment is telling us there
    // is no safest place to put unclassifiable content - which is a fact about the taxonomy, not a
    // bug here. A deployment that wants a specific answer declares a classification for it.
    const reachCount = (target: string): number =>
      this.config.classifications.filter((c) => this.grantsFor(c.value).includes(target)).length;
    return conversational.reduce((best, v) => (reachCount(v) < reachCount(best) ? v : best));
  }
}


/**
 * A REGISTRY THAT IS NOT LOADED YET, in a deployed handler. Every read throws, so a handler that reads the
 * registry before `loadProfileRegistry` resolves fails loudly rather than answering from the shipped catalog
 * compiled into its bundle, which would be another deployment's set.
 */
function unloadedRegistry(path: string): ProfileRegistry {
  return new Proxy({} as ProfileRegistry, {
    get(_target, property) {
      if (property === 'then') return undefined;
      throw new Error(`profile registry: read (${String(property)}) before it was loaded from ${path}; `
        + 'the handler awaits loadProfileRegistry() before it reads the registry');
    },
  });
}

/** The registry path a deployed handler is told (`PROFILE_REGISTRY_PATH_ENV`), or undefined outside one. */
function registryPath(): string | undefined {
  const value = (typeof process !== 'undefined' ? process.env?.[PROFILE_REGISTRY_PATH_ENV] : undefined)?.trim();
  return value || undefined;
}

/**
 * THE REGISTRY OF THIS DEPLOYMENT'S SET. In a deployed handler it is the set `loadProfileRegistry` read from the
 * rows the deployment's stacks publish (`registryPathOf`), and nothing until that resolves (every read before
 * then throws). In the CDK app it is the set the deployment declares (`resolveDeploymentProfiles`), installed by
 * `bin/backend.ts` through {@link useDeploymentProfiles} before any stack is built. Where neither applies (a unit
 * test, a script run by hand) it is the shipped catalog, `DEFAULT_PROFILES_CONFIG`.
 *
 * READ AT CALL TIME, never captured at module load: a value computed from it while modules load would be read
 * before the handler loaded it, and throws (`test/lib/no-handler-reads-the-registry-at-module-load.test.ts`).
 */
export let defaultProfileRegistry: ProfileRegistry = (() => {
  const path = registryPath();
  return path ? unloadedRegistry(path) : new ProfileRegistry(DEFAULT_PROFILES_CONFIG);
})();

/** Install the deployment's set as {@link defaultProfileRegistry}. Called once by `bin/backend.ts`, and by the loader. */
export function useDeploymentProfiles(config: ProfilesConfig): ProfileRegistry {
  defaultProfileRegistry = new ProfileRegistry(config);
  return defaultProfileRegistry;
}

/**
 * HOW LONG A HANDLER KEEPS THE SET IT READ BEFORE IT READS IT AGAIN. The set changes only when a classification's
 * stack is deployed or deleted, so a warm handler sees an added or removed classification within this.
 */
export const PROFILE_REGISTRY_TTL_MS = 5 * 60_000;

/**
 * HOW LONG A SET MAY BE KEPT, counted from the last read that succeeded, while reads fail. Past it the loader
 * throws rather than answer from a set that may name a classification since removed or miss one since added.
 */
export const PROFILE_REGISTRY_MAX_STALE_MS = 2 * PROFILE_REGISTRY_TTL_MS;

/** How soon a read that failed is tried again, while the set read before is still within its staleness. */
const RETRY_AFTER_FAILURE_MS = 30_000;

/** The namespace of the registry's metrics, one alarm each (`Identity`, `registryHealthAlarms`). */
export const PROFILE_REGISTRY_METRIC_NAMESPACE = 'AgentEchelon/ProfileRegistry';

/** One read of every row under `path`: the registry's only network call. Replaceable by a test. */
export type RegistryRowReader = (path: string) => Promise<string[]>;

// ONE CLIENT PER CONTAINER, with the SDK's adaptive retry, so the cold starts of a burst share a client and back
// off together rather than each opening its own and throttling into a failed first read.
let ssmClient: import('@aws-sdk/client-ssm').SSMClient | undefined;

/**
 * READ THE ROWS THROUGH THE HANDLER'S OWN SSM CLIENT rather than one this module builds. A cold function pays each
 * client's first-call setup (middleware, endpoint rules, credentials, TLS) once per client, so a handler that
 * already holds one hands it here (`create-conversation-at-classification.ts`, `create-conversation.ts`).
 * Optional: without it the module builds its own on the first read.
 */
export function useProfileRegistrySsmClient(client: import('@aws-sdk/client-ssm').SSMClient): void {
  ssmClient = client;
}

const readRowsFromSsm: RegistryRowReader = async (path) => {
  const { SSMClient, GetParametersByPathCommand } = await import('@aws-sdk/client-ssm');
  ssmClient ??= new SSMClient({ retryMode: 'adaptive', maxAttempts: 6 });
  const values: string[] = [];
  let NextToken: string | undefined;
  do {
    const page = await ssmClient.send(new GetParametersByPathCommand({ Path: path, Recursive: false, MaxResults: 10, NextToken }));
    for (const p of page.Parameters ?? []) if (typeof p.Value === 'string') values.push(p.Value);
    NextToken = page.NextToken;
  } while (NextToken);
  return values;
};

/** The S3 copy of the rows a VPC-attached handler is told (`PROFILE_REGISTRY_S3_ENV`), or undefined. */
function registryS3Location(): string | undefined {
  const value = (typeof process !== 'undefined' ? process.env?.[PROFILE_REGISTRY_S3_ENV] : undefined)?.trim();
  return value || undefined;
}

/** `s3://<bucket>/<prefix>/` as its bucket and its key prefix (ending in `/`). Throws on any other shape. */
export function parseRegistryS3Location(location: string): { bucket: string; prefix: string } {
  const match = /^s3:\/\/([^/]+)\/(.+?)\/?$/.exec(location.trim());
  if (!match) throw new Error(`profile registry: ${PROFILE_REGISTRY_S3_ENV} is not s3://<bucket>/<prefix>/ (${location})`);
  return { bucket: match[1], prefix: `${match[2]}/` };
}

let s3Client: import('@aws-sdk/client-s3').S3Client | undefined;

/**
 * ONE READ OF EVERY ROW IN THE S3 COPY at `location`: the objects directly under its prefix, each one row's value,
 * the same value its parameter holds. An object removed between the listing and its read is a row removed (its
 * stack's delete), and is skipped, as `GetParametersByPath` would no longer return it. One client per container,
 * with adaptive retry, like the SSM read.
 */
export async function readRowsFromS3(location: string): Promise<string[]> {
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = await import('@aws-sdk/client-s3');
  s3Client ??= new S3Client({ retryMode: 'adaptive', maxAttempts: 6 });
  const client = s3Client;
  const { bucket, prefix } = parseRegistryS3Location(location);
  const keys: string[] = [];
  let ContinuationToken: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/', ContinuationToken }));
    for (const o of page.Contents ?? []) if (o.Key && o.Key !== prefix) keys.push(o.Key);
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  const values = await Promise.all(keys.map(async (Key) => {
    try {
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key }));
      return object.Body ? await object.Body.transformToString('utf-8') : undefined;
    } catch (err) {
      if ((err as { name?: string })?.name === 'NoSuchKey') return undefined;
      throw err;
    }
  }));
  return values.filter((v): v is string => typeof v === 'string');
}

/** A deployed handler's read: the S3 copy when it is told one (a VPC-attached handler), the parameters otherwise. */
const readDeployedRows: RegistryRowReader = (path) => {
  const location = registryS3Location();
  return location ? readRowsFromS3(location) : readRowsFromSsm(path);
};

/**
 * A TEST'S ROW READER, held on the global object rather than in this module, so a test that resets its modules
 * still reaches every copy of the registry the handler under test loads. Never set in a deployed handler.
 */
const TEST_READER = Symbol.for('agent-echelon.profile-registry.row-reader');
const rowReader = (): RegistryRowReader =>
  ((globalThis as Record<symbol, unknown>)[TEST_READER] as RegistryRowReader | undefined) ?? readDeployedRows;
/** When the set was last refreshed or last kept after a failure (which schedules the retry). */
let loadedAt = 0;
/** When a read last succeeded: what the staleness is counted from. */
let readAt = 0;
let loading: Promise<ProfileRegistry> | undefined;

/** Test-only: replace the row reader (`undefined` restores the deployed read) and forget what was loaded. */
export function __setRegistryRowReaderForTest(reader: RegistryRowReader | undefined): void {
  if (reader) (globalThis as Record<symbol, unknown>)[TEST_READER] = reader;
  else delete (globalThis as Record<symbol, unknown>)[TEST_READER];
  loadedAt = 0;
  readAt = 0;
  loading = undefined;
  const path = registryPath();
  if (path) defaultProfileRegistry = unloadedRegistry(path);
}

/**
 * WHAT AN OPERATOR ALARMS ON: one structured line per event, which is an EMF document, so the count is a metric
 * (`RegistryItemDropped`, `RegistryReadFailed`) with the registry's path as its one dimension.
 */
function reportRegistry(path: string, metric: 'RegistryItemDropped' | 'RegistryReadFailed', fields: Record<string, string>): void {
  emitEmfMetric({
    namespace: PROFILE_REGISTRY_METRIC_NAMESPACE,
    metrics: [{ name: metric, unit: 'Count' }],
    dimensionSets: [['RegistryPath']],
    properties: { RegistryPath: path, [metric]: 1, event: `profile-registry.${metric}`, ...fields },
  });
}

function reportDrops(path: string, dropped: readonly RegistryDrop[]): void {
  for (const d of dropped) {
    reportRegistry(path, 'RegistryItemDropped', { kind: d.kind, classification: d.classification ?? '', detail: d.detail });
  }
}

/**
 * LOAD THE DEPLOYMENT'S SET, ONCE PER {@link PROFILE_REGISTRY_TTL_MS}, AND INSTALL IT AS {@link defaultProfileRegistry}.
 * Every deployed handler awaits this before it reads the registry. Outside a deployed handler (no
 * `PROFILE_REGISTRY_PATH_ENV`) it returns the registry already installed and reads nothing.
 *
 * THE SET IS ASSEMBLED PER ITEM (`profilesConfigFromPublishedRows`): a row, grant or profile copy one stack's
 * deploy order left inconsistent is left out and reported, and the rest of the set is served.
 *
 * A READ THAT FAILS keeps the set read before for at most {@link PROFILE_REGISTRY_MAX_STALE_MS} from the last read
 * that succeeded, retrying every thirty seconds, and throws past it or when there is none: a handler never answers
 * from a set it guessed. Concurrent callers share one read.
 */
export async function loadProfileRegistry(): Promise<ProfileRegistry> {
  const path = registryPath();
  if (!path) return defaultProfileRegistry;
  const now = Date.now();
  if (loadedAt && now - loadedAt < PROFILE_REGISTRY_TTL_MS && now - readAt < PROFILE_REGISTRY_MAX_STALE_MS) return defaultProfileRegistry;
  if (loading) return loading;
  loading = (async () => {
    try {
      return await readAndInstall(path);
    } catch (err) {
      const at = Date.now();
      if (readAt && at - readAt < PROFILE_REGISTRY_MAX_STALE_MS) {
        console.warn(`[profile-registry] reading ${path} failed; keeping the set read ${Math.round((at - readAt) / 1000)}s ago`, err);
        loadedAt = at - PROFILE_REGISTRY_TTL_MS + RETRY_AFTER_FAILURE_MS;
        return defaultProfileRegistry;
      }
      if (readAt) console.error(`[profile-registry] reading ${path} failed and the set read before is past its staleness; refusing`, err);
      throw err;
    } finally {
      loading = undefined;
    }
  })();
  return loading;
}

/** One read of the rows, assembled and installed. Throws when the read fails, after reporting it. */
async function readAndInstall(path: string): Promise<ProfileRegistry> {
  try {
    const values = await rowReader()(path);
    const { config, dropped } = profilesConfigFromPublishedRows(values);
    if (dropped.length) {
      console.error(`[profile-registry] ${path}: ${dropped.length} item(s) left out of the set`, JSON.stringify(dropped));
      reportDrops(path, dropped);
    }
    const registry = useDeploymentProfiles(config);
    loadedAt = readAt = Date.now();
    return registry;
  } catch (err) {
    reportRegistry(path, 'RegistryReadFailed', { detail: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/**
 * READ THE SET AGAIN NOW, whatever the cache holds: for a caller that decides on a row its own deploy has just
 * published (the provisioner seeding a declaration, `assistant-provisioner-function.ts`), which a set read before
 * that deploy would not hold. So it is a read of its own, begun after the call: a read already in flight began
 * before it and may predate the row, so it is waited out and not joined. And it FAILS LOUDLY: a refresh that cannot
 * read throws "the registry could not be read", never the set read before, which would answer from exactly the
 * stale rows the caller asked to be rid of.
 */
export async function refreshProfileRegistry(): Promise<ProfileRegistry> {
  const path = registryPath();
  if (!path) return defaultProfileRegistry;
  if (loading) await loading.catch(() => undefined);
  try {
    return await readAndInstall(path);
  } catch (err) {
    throw new Error(`the registry could not be read (${path}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * A HANDLER THAT READS THE REGISTRY, with the registry loaded before it runs: `export const handler =
 * withProfileRegistry(async (event) => ...)`. The same as awaiting {@link loadProfileRegistry} first.
 */
export function withProfileRegistry<A extends unknown[], R>(fn: (...args: A) => Promise<R> | R): (...args: A) => Promise<R> {
  return async (...args: A) => {
    await loadProfileRegistry();
    return fn(...args);
  };
}
