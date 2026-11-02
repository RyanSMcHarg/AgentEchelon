/**
 * Deployment classifications + assistant capability profiles (SPEC-CAPABILITY-PROFILES).
 *
 * This is the single source that separates the four concepts "tier" used to conflate:
 *  - CLASSIFICATION: a deployment-defined data/sensitivity label carried on the channel's
 *    immutable `classification` tag. It declares the SET it grants, not a position in an order.
 *  - PROFILE: a named assistant capability bundle (model, classifier mode, timeout,
 *    RAG scope rule, rate limit), bound to a classification by config.
 *  - CLEARANCE: the group -> classification mapping (Cognito group names are a deployment choice).
 *
 * `DEFAULT_PROFILES_CONFIG` is the SHIPPED CATALOG. A deployment runs the set it declares in the
 * `profiles` context key (`resolveDeploymentProfiles`), which is the catalog minus its outside
 * classifications when it declares none. The catalog's member classifications are the
 * basic/standard/premium triple with ONE deliberate deviation from the legacy code: basic's
 * classifierMode is 'llm', not the legacy keyword classifier (see the profiles block). The registry
 * itself returns legacy-identical answers for classification/clearance/scope.
 *
 * The enforcement mechanism is unchanged: the tag key stays `classification`, immutable-by-policy,
 * IAM keyed on `aws:ResourceTag/classification`, resolution fail-closed. Classifications now
 * declare the set they grant explicitly. There is no rank: see `grants` on DeploymentClassification.
 */

import { gunzipSync, gzipSync } from 'zlib';

import { instanceModelKeys, modelKindOf } from './model-catalog';
import { ADVISOR_PERSONA, ANALYST_PERSONA, CONCIERGE_PERSONA } from './sample-personas';

/**
 * THE COMPUTE A CLASSIFICATION'S ASSISTANT STACK BUILDS (ADR-054, ADR-057).
 *
 * One `Assistants-<classification>` stack is created for each classification that declares this, and
 * none for one that does not, so the set of assistant stacks is read from this registry rather than
 * listed in `bin/backend.ts`. The shared body (`AssistantsStack`) reads it once; what differs between
 * classifications is this data, never a second copy of the stack.
 */
export interface AssistantTopology {
  /** async-processor Lambda sizing. */
  timeoutSeconds: number;
  memorySize: number;
  reservedConcurrency: number;
  /** MAX_TOKENS env: the response limit. */
  maxTokens: number;
  /** Also grant InvokeModelWithResponseStream (long-form streaming). */
  streaming: boolean;
  /**
   * Context-aware model routing (SPEC-CONTEXT-AWARE-MODEL-ROUTING): a turn in the classification's routing
   * language is sent to the Bedrock DeepSeek models it selects (`deepseek_v3`, and `deepseek_r1` for a
   * reasoning intent), or, where it selects the external DeepSeek adapter (`deepseek_api`) instead, to that. Synth
   * refuses the switch on a classification that selects neither `deepseek_v3` nor `deepseek_api`, and refuses
   * `deepseek_api` beside `deepseek_v3`, where no turn reaches it.
   */
  contextRouting: boolean;
  /** A per-deployment persona in SSM (ASSISTANT_SYSTEM_PROMPT_PARAM) and the empty-config warning. */
  systemPromptParam: boolean;
  /** A per-deployment intent taxonomy in SSM (the classifier hydrates it). */
  intentPackParam: boolean;
  /** Multi-turn tasks (fuller DynamoDB), experiments, generated-doc writes, attachment-in read, and
   *  (when battle is declared) the battle-state grant and orchestrator invoke. */
  richProcessor: boolean;
  /** The handler role also grants Query on the experiments GSI (experiments/index/*). */
  handlerExperimentsIndex: boolean;
}

/** A deployment-defined data/sensitivity label (the channel `classification` tag value). */
export interface DeploymentClassification {
  /** The tag value, e.g. 'confidential'. */
  value: string;
  /** Name of the assistant profile that serves channels with this classification. */
  profile: string;
  /** Legacy tag values this classification also recognizes (immutability: existing channels are
   *  never retagged). A fresh deploy that never used legacy values ships none. */
  aliases?: string[];
  /**
   * This classification is the ADMIN PLANE: it exists for administrative conversations, and no
   * ordinary user conversation is ever served at it.
   *
   * IT IS NOT A HIGHER TIER OF THE SAME LADDER, and the distinction is load-bearing in exactly one
   * place - what to stamp content whose classification cannot be established. Stamping it at the
   * top of the rank order means "readable by administrators only", which sounds like the safest
   * possible answer and is actually invisibility: an untagged knowledge-base document, or a
   * conversation summary whose channel tag could not be read, would stop being retrievable in every
   * user conversation at every tier, silently and with no error. `failClosedContentValue` is the
   * value those writers use, and this flag is what keeps it off the admin plane.
   *
   * Its `grants` set is itself alone: it clears a chat identity for admin conversations and for no
   * member conversation. Reach across every conversation is admin access, through the console and the
   * `${personId}-admin` identity, never a classification (SPEC-ADMIN-IDENTITY FR1).
   */
  adminPlane?: boolean;
  /**
   * The classifications a principal HOLDING this one may reach. REQUIRED, and it is the only model.
   *
   * IT USED TO BE OPTIONAL, falling back to "this one and every lower rank". That fallback was the
   * last thing holding the ladder up: a deployment could decline to think about the set and get an
   * ordering imposed on it. `rank` is gone: classifications are a set, not a ladder (a deployment
   * may declare legal and finance side by side), so there is no ordering left
   * to fall back to and every classification says what it reaches. A ladder-shaped deployment simply
   * declares prefix-shaped grants, which is what the default config below does.
   *
   * ── WHY A SET, AND WHY IT IS NAMED RATHER THAN LISTED ON THE PRINCIPAL ──────────────────────────
   *
   * A person's holdings are not a point on a ladder. A type like `admin` grants access to several
   * classifications at once, and the set it grants need not be a rank prefix - a deployment may well
   * have a `finance` type that reaches `finance` and `basic` but not `standard`. Rank cannot express
   * that, and a taxonomy that is a single ladder is the exception rather than the rule.
   *
   * The set does NOT go on the principal. A tag is one short Key->Value, so a delimited list would be
   * length-bounded, unreadable, and impossible to extend without rewriting every identity. Instead the
   * principal carries ONE short token - this classification's `value` - and THIS field is the lookup
   * that expands it. An enum on the resource, a set in config, and the expansion happens where the
   * policy is generated rather than where the identity is stored.
   *
   * ENFORCEMENT ALREADY WORKED THIS WAY. The IAM condition is
   * `StringEquals: { 'aws:ResourceTag/classification': [...] }`, and a list there is an OR - set
   * membership, never a rank comparison. Only the DERIVATION of that list was rank-bound, so this
   * changes what the set contains and nothing about how it is evaluated.
   *
   * Every entry must be a declared classification value; `validateProfilesConfig` refuses a grant
   * naming something the deployment does not declare, because an unresolvable grant is a silent hole
   * rather than a narrower one.
   */
  grants: string[];
  /**
   * THE ROLES THIS CLASSIFICATION INSTANTIATES, beyond the `primary` every classification has.
   *
   * A role is a JOB, and it is access structure rather than behavior: each role gets its own pair of
   * acting roles (`live` and `alt`) and its own contribution to the classification boundary, so a role
   * is the unit at which one assistant may reach something another may not. Declaring one is a
   * deploy for exactly that reason (DESIGN-ADDING-AN-ASSISTANT-ROLE §3).
   *
   * PER CLASSIFICATION, NOT PLATFORM-WIDE, because a role's access is always `(classification, role)`
   * and never `role` alone. The NAME may be shared - `ops` can mean the same job everywhere - but
   * `(premium, ops)` and `(standard, ops)` are different role instances with different scopes and
   * different acting roles, which is what keeps ADR-042 intact: a shared role name never produces a shared
   * principal. A classification that declares none holds only its primary.
   *
   * DECLARED IS DEPLOYED. Every role a deployment's set declares is built by its classification's stack,
   * with no switch beside it. In the SHIPPED CATALOG this list is what a classification OFFERS: a selection
   * (`shippedProfilesSelection`) deploys an offered role only when it names the role's assistant
   * (`ops-premium` in `profiles` in deploy.config.json), so a deployment that names none holds only primaries.
   * A custom set declares its roles here directly.
   */
  roles?: string[];
  /**
   * WHICH OF THIS CLASSIFICATION'S CONTEXT A ROLE MAY READ, per role (DESIGN-SEPARATE-ASSISTANTS-AND-
   * DELEGATION Phase 1b, the S3 context edge).
   *
   * Each value is a SUBSET of `grants`: the classifications whose `context/{c}/` prefixes that role's
   * assistant may read. A role not listed reads every prefix the classification grants, which is the primary's
   * scope and every classification's today. The boundary still caps every assistant at the classification's
   * grants, so a role can only be narrowed below its classification, never widened past it, and synthesis
   * refuses a value that names a classification `grants` does not hold.
   *
   * It is a property of the ROLE, not of a profile version: what an assistant may REACH is deploy-time,
   * reviewed infrastructure, and a version - what it DOES - carries no scope (SPEC-PORTABLE-PROFILES D-3).
   */
  roleContext?: Record<string, string[]>;
  /**
   * CAN a duel run in this classification at all: whether its stack wires the battle plumbing (the
   * battle-state grant, the orchestrator invoke, the alt bot's image guardrail).
   *
   * A CAPABILITY, NOT A POLICY, and the split is the point (ADR-049). Whether battle is TURNED ON for
   * a classification is operator policy, classification-level, runtime-settable from the Experiments
   * surface and off by default. This is the deploy-time fact underneath it, and an operator is never
   * offered the toggle for a classification that does not have it.
   *
   * ONE SOURCE, because the two halves already disagreed. This lived on the topology as
   * `battleCapable` and, separately, on `AssistantProfile` as `battleEligible`, which was `true` for
   * basic while basic's topology said `false`. The enable path read the profile flag and accepted
   * Battle Mode on a basic channel whose processor holds none of the grants a duel needs. That is the
   * failure `attachmentsReadable` records from 2026-09-12 - a surface offering what the IAM role
   * cannot back - so the two are one field here, read by the stack that wires the plumbing AND by the
   * runtime that refuses without it.
   *
   * Absent is FALSE: a classification whose deployment has not considered battle does not claim it.
   */
  battleCapable?: boolean;
  /**
   * WHAT A TURN IN THIS CLASSIFICATION CAN HAND OVER beyond its reply: a generated `document`. Absent is
   * NOTHING, so a classification that has not declared an output does not claim it.
   *
   * Read by the runtime to say WHERE a refused request would be served (DESIGN-CAPABILITY-REFUSAL §4):
   * a basic assistant refusing a report names the classifications the person reaches whose `produces`
   * includes `document`, without reading any other classification's configuration.
   *
   * `image` IS NOT DECLARED HERE. Whether a classification produces images is whether it selects an image
   * model (`models`), which is also what its stack's image grant and guardrail are built from; `ProfileRegistry.produces` derives it.
   * A config naming `image` is refused, so there is one place that decides.
   */
  produces?: Array<'document'>;
  /**
   * The name a person sees for this classification, as the chat app's New conversation picker shows
   * it. Absent reads as the value. Spoken by the assistant when it points somebody at a classification
   * (DESIGN-CAPABILITY-REFUSAL §6); authored in one language, like the rest of a deployment's copy.
   */
  displayName?: string;
  /**
   * WHO A CONVERSATION AT THIS CLASSIFICATION IS FOR. Absent is `members`: the deployment's own people,
   * signed in through an issuer whose clearance names this classification.
   *
   * `outside`: people from outside the deployment, the anonymous visitor the guest issuer vends
   * (`kind: 'guest'`, `lib/config/issuers.ts`) and the signed-in customer a path B claim opens a conversation for. An outside classification grants
   * only itself, no clearance group names it, and it is never where content whose classification cannot
   * be established is stamped (`failClosedContentValue`): withholding that content from everyone but the
   * deployment's least trusted readers would be the opposite of withholding it. The chat app's conversation
   * header shows the audience to its members, and an outside conversation's composer says it is visible to
   * the customer (`clientClassifications`, carried to the clients as the `Classifications` output).
   */
  audience?: 'members' | 'outside';
  /**
   * THE COLOR A CLIENT DRAWS THIS CLASSIFICATION'S BADGE IN: one of the design system's categorical palette,
   * `cls-1` to `cls-8` (`--cls-<n>` and `--cls-<n>-bg`, DESIGN-SYSTEM.md). Categorical, so no color reads
   * as higher than another, and never derived from the classification's name.
   *
   * Absent, the classification takes the lowest-numbered token no classification declares and none before
   * it took, in declaration order; once all eight are taken the palette repeats (`clientClassifications`).
   * Two classifications declaring the same token are refused (`validateProfilesConfig`): their badges
   * would be indistinguishable.
   */
  badgeToken?: BadgeToken;
  /**
   * THE ASSISTANT STACK THIS CLASSIFICATION DEPLOYS. Required on every conversational classification
   * and refused on the admin plane, which has no conversational runtime (`validateProfilesConfig`).
   * Each classification that declares it gets one `Assistants-<value>` stack.
   */
  topology?: AssistantTopology;
  /**
   * THE PROACTIVE BRIEFING IS HELD AT THIS CLASSIFICATION: it creates its conversation here, and this
   * classification's primary assistant seeds it (`lambda/src/proactive-briefing.ts`). At most one
   * classification declares it, never the admin plane or an outside one. None declaring it, the deployment
   * builds no briefing: no classification is guessed for it.
   */
  holdsBriefing?: boolean;
  /**
   * THE COGNITO PRECEDENCE OF THE GROUPS THAT CLEAR FOR THIS CLASSIFICATION, on the deployment's own pool
   * (`groupClearance`). A non-negative integer, declared, never computed from the set: a number derived from
   * the other classifications would change every group's precedence when one is declared, and the group is
   * built by the classification's own stack. Unique across the classifications that declare one, and never
   * `TEAM_MEMBERS_GROUP_PRECEDENCE`, which the team-members group holds. Absent, the group is created with no
   * precedence. A group carries no role (every credential is vended by the exchange from the person's groups
   * as a set), so precedence decides no access; Cognito reads it only to order the token's groups.
   */
  groupPrecedence?: number;
  /**
   * THE MODELS THIS CLASSIFICATION SELECTS FROM THE INSTANCE'S CATALOG, and its default (`model-catalog.ts`: the
   * platform allows, the classification selects, the profile uses). `selected` names catalog keys of every kind:
   * Bedrock text models, external adapters and image models. Its own stack grants exactly those: the Bedrock ARNs
   * of its Bedrock models and the secret reads of its external ones. `default` is a selected text model, what its
   * assistant answers on when nothing more specific chooses. A profile serving the classification, and each of
   * its versions, uses only these. Required on every classification with a `topology`; synth refuses an empty
   * selection, a key the catalog does not list, and a default that is not a Bedrock text model it selects.
   */
  models?: ClassificationModels;
}

/** A classification's selection from the instance's model catalog, and its default (`DeploymentClassification.models`). */
export interface ClassificationModels {
  selected: string[];
  default: string;
}

/** The Cognito precedence the admin backend's team-members group holds, which no classification may declare. */
export const TEAM_MEMBERS_GROUP_PRECEDENCE = 2;
/**
 * Where a membership group's precedence starts (DESIGN-CONVERSATION-TYPES §6): after every clearance group's,
 * as a fixed number rather than one derived from how many classifications are declared. A classification's
 * declared `groupPrecedence` is below it.
 */
export const MEMBERSHIP_GROUP_PRECEDENCE_BASE = 100;

/** The design system's categorical badge palette (`--cls-1` to `--cls-8`), which `badgeToken` names one of. */
export const BADGE_TOKENS = ['cls-1', 'cls-2', 'cls-3', 'cls-4', 'cls-5', 'cls-6', 'cls-7', 'cls-8'] as const;
export type BadgeToken = (typeof BADGE_TOKENS)[number];

/** A named assistant capability bundle, bound to classifications by config. */
export interface AssistantProfile {
  /**
   * THE STABLE IDENTIFIER, and the only thing that keys storage: the SSM segment
   * `/agent-echelon/assistant/{name}/…`, the assignment record's `assistant`, and the dimension
   * analytics groups by. It is never shown to a person and it never changes - renaming it is
   * creating a different assistant, because every key and every historical row is addressed by it.
   *
   * NOT WHAT ANYONE READS. That is `displayName` below. These were one field, which is why a profile
   * could not be renamed at all: the label a team wants to edit was also the primary key.
   */
  name: string;
  /**
   * WHAT A PERSON SEES - the assistant's name in the room and in the console, and the `Name` on its
   * `AppInstanceBot`. Editable, because a team owning an assistant owns what it is called.
   *
   * THIS IS A DEFAULT, NOT THE ANSWER. A profile VERSION may carry its own `displayName`, which wins
   * (`ProfileDefinitionBody`), so renaming is an ordinary versioned edit with a rollback like any
   * other. This field is what a newly provisioned assistant is called before anyone edits it, and it
   * is what the stack names the bot at deploy.
   *
   * Optional so a deployment that does not care gets the identifier rendered as-is.
   */
  displayName?: string;
  /** The base model, a catalog key its classification selects (`DeploymentClassification.models`). */
  modelKey: string;
  /** 'keyword' = the no-LLM keyword classifier; 'llm' = the model-backed classifier. */
  classifierMode: 'keyword' | 'llm';
  /** async-processor Lambda timeout. */
  timeoutSeconds: number;
  /**
   * THERE IS NO `taskSupport`, AND NOTHING REPLACES IT.
   *
   * It declared a per-assistant task-tracking depth, `'lightweight' | 'full'`, and nothing ever read
   * it: every reference outside this file and its test fixtures was a comment. Every conversational
   * profile set `'full'`, and the one `'lightweight'` was the admin assistant, which has no conversational
   * runtime and so no task loop to make shallow. It distinguished nothing.
   *
   * IT WAS ALSO ACTIVELY WRONG. Readers took the name at face value and wrote that basic had reduced
   * task tracking; `docs-drift-guard.test.ts` bans four separate phrases to catch that claim, because
   * the real switch is `richProcessor`, which gates generated-doc OUTPUT and grants the same DynamoDB
   * task permissions either way (`assistant-profile-stack.ts:355-357`). A field with no consumer whose
   * name misleads readers into writing false claims is worse than an absent one.
   *
   * Task management belongs to the CLASSIFICATION rather than the assistant (ADR-048), so depth is not
   * a thing one assistant differs from another in. A stored version that still carries the key
   * normalizes away on its next read, the same as every other deployment-time field.
   */
  /** RAG scope rule: the serving classification's own `grants` set. */
  contextScope: 'granted';
  /** replaces RATE_LIMIT_<TIER> env. */
  rateLimitPerHour?: number;
  /**
   * THERE IS NO `battleEligible` ON AN ASSISTANT. It asked two questions at once
   * and its two answers disagreed with each other.
   *
   * CAN a duel run here is `DeploymentClassification.battleCapable`, a deploy fact about plumbing and
   * grants. IS battle turned on is classification-level operator policy, held at runtime, off by
   * default, and offered in the Experiments surface. Neither is a property of one assistant, so
   * neither belongs here.
   *
   * WHAT THE OLD FIELD DID. It was `true` for every conversational profile INCLUDING basic, whose
   * topology said `battleCapable: false` and whose stack therefore wired no battle plumbing at all.
   * `channel-battle.ts` gated the enable on this field, so Battle Mode could be turned on for a basic
   * channel and then had no grant to run with - the surface promising what the role cannot back, which
   * is the defect `attachmentsReadable` below records from 2026-09-12.
   */
  /**
   * Whether this profile's async processor may READ a file the user attached (attachment-in).
   *
   * ONE SOURCE FOR THREE THINGS, and that is the point of declaring it here rather than at any of
   * them. `assistant-profile-stack` reads it to set `ATTACHMENTS_BUCKET` and to grant
   * `s3:GetObject` on `attachments/*`, and the channel-config endpoint reads it to tell the composer
   * whether to offer the paperclip. Split across those three, they drift - and the drift is silent
   * in the worst direction: the grant is what actually enforces this, so a surface that disagrees
   * lets somebody upload a file into a turn that cannot open it.
   *
   * MEASURED 2026-09-12: basic had no bucket and no grant while its composer still offered the
   * control, so a file was accepted, stored, shown as a chip, and answered from the caption alone -
   * with no error and nothing in the log, because the unset bucket failed the `if` and the only
   * `else` covered an ownership failure. The person was told nothing and the answer read fluently.
   *
   * Absent is FALSE, so a deployment that adds a profile without considering this does not
   * accidentally promise a capability its IAM role does not carry.
   */
  attachmentsReadable?: boolean;
  /**
   * THE TEAM THAT OWNS THIS ASSISTANT WHEN IT IS FIRST PROVISIONED (SPEC-ADMIN-CONSOLE FR47).
   *
   * A seed, not the authority. Ownership is the `owner-team` tag on the assistant's
   * `AppInstanceBot`, written only by the ownership function: it copies this value onto a bot that
   * carries no owner yet, and `manage-ownership` changes it afterwards. So initial ownership is
   * reviewable in a diff, and a later reassignment in the console is never undone by a deploy.
   *
   * A team is a Cognito group `team-<name>`; this is the `<name>`. Absent means no team owns the
   * assistant, which leaves it reachable by `admins` alone.
   */
  ownerTeam?: string;
  /**
   * THE PERSONA THIS PROFILE'S ASSISTANT ANSWERS WITH when no profile version, SSM parameter or environment
   * variable supplies one. `{model}` is replaced with the serving model's display name. Absent, the assistant
   * answers with the platform's generic persona, so a declared profile needs none to work.
   */
  defaultPersona?: string;
}

/** The shape of a team name: the `<name>` in a `team-<name>` group and an `owner-team` tag value. */
export const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

export interface ProfilesConfig {
  classifications: DeploymentClassification[];
  profiles: AssistantProfile[];
  /**
   * Cognito group name -> the classification it clears for.
   *
   * "HIGHEST it clears for" was the old wording and it presumed an ordering. A group clears for ONE
   * classification, and what that reaches is that classification's `grants`.
   */
  groupClearance: Record<string, string>;
  /**
   * MEMBERSHIP GROUPS: group name -> the classification its members MUST ALREADY BE CLEARED FOR
   * (DESIGN-CONVERSATION-TYPES §6).
   *
   * A membership group grants nothing. Clearance comes from `groupClearance` alone; a membership group
   * says who a conversation type adds, and requires that everyone in it already holds the clearance
   * the type's conversations need. `ops` requires `premium`, because the `ops` types are created at
   * `premium`: an administrator cannot add someone whose clearance does not reach it, and lowering a
   * member's clearance below it removes them from the group. So a group and a classification cannot
   * contradict each other, and `assertTypeGroupsRequireTheirClassifications` refuses a type whose group
   * does not require what the type is created at.
   *
   * Never a key of `groupClearance`: a group either grants a clearance or requires one, not both.
   */
  membershipGroups?: Record<string, string>;
}

/**
 * THERE IS NO `failClosedTo`, AND ITS ABSENCE IS THE POINT.
 *
 * It named the classification to use when a tag is absent, invalid or unreadable, and it had to be
 * "the lowest rank". With peer classifications there is no lowest: `legal` is not beneath `finance`,
 * so a fallback is not merely unsafe, it is undefined. Every consumer that substituted it now
 * REFUSES instead, which ADR-045 decision 2 had already done for the assistant-plane callers on the
 * narrower grounds that the floor was a WRONG classification.
 *
 * The one place a value is still needed is stamping content whose classification cannot be
 * established, and that is `failClosedContentValue` on the registry - a different question with a
 * different answer, which is why it survives and this did not.
 */

/**
 * The shipped default IS the current triple, verbatim — so Phase 0 changes zero behavior.
 * Values captured from the legacy code:
 *  - ranks/ordering: CLASSIFICATION_RANK {basic:1,standard:2,premium:3} (router-agent-handler.ts)
 *  - modelKey: each classification's default model ({haiku,sonnet,opus}), in its own `models`
 *  - classifierMode: 'llm' for all (DEVIATION: legacy basic used the keyword classifier;
 *    the new default classifies basic with the LLM too — surfaces when Phase 1 wires the router)
 *  - timeoutSeconds: per-classification async processor Lambda timeout (30/60/90; classification stacks)
 *  - rateLimitPerHour: rateLimitDefaults {60,120,240} (agent-classification-common.ts)
 *  - battleCapable: standard and premium, matching what their stacks wire. Basic is not capable.
 *  - groupClearance: resolveUserClearance maps a Cognito group to the classification it clears for
 */
export const DEFAULT_PROFILES_CONFIG: ProfilesConfig = {
  classifications: [
    // GRANTS ARE DECLARED, NOT DERIVED FROM AN ORDER. These three are prefix-shaped because the shipped
    // SAMPLE is configured that way, and writing them out is what makes that a choice rather than a
    // property of classifications. Sets need not nest, and in many deployments should not: `customer`
    // below is disjoint from all three, and `validateProfilesConfig` refuses any member classification
    // that grants it. A deployment whose classifications are `legal` and `finance` declares
    // `grants: ['legal']` and `grants: ['finance']` and nothing else changes.
    // A PROFILE NAME IS NOT A CLASSIFICATION VALUE, and these used to be.
    // `{ value: 'premium', profile: 'premium' }` made every reader that built `/assistant/{
    // classification}/…` correct by accident, and no test could tell the two apart because the
    // strings matched. `validateProfilesConfig` now refuses the collision; these names follow the
    // shape `AssistantProfile.name` documents ("e.g. 'analyst'"), which is what an assistant DOES
    // rather than which boundary it serves.
    // `battleCapable` MATCHES WHAT THE STACKS ACTUALLY WIRE, which is the point of moving it here.
    // Basic is `richProcessor: false` and its stack builds no battle plumbing, so it is not capable and
    // no longer claims to be; standard and premium are. Being capable does not turn battle ON - that is
    // classification-level operator policy, off by default, set from the Experiments surface.
    //
    // `produces` MATCHES WHAT EACH STACK WIRES: basic is `richProcessor: false`, and standard and premium
    // write generated documents. Images are each classification's model selection's to decide (`models`).
    //
    // `topology` is the compute each classification's `Assistants-<value>` stack builds. Basic carries the
    // narrow processor (`richProcessor: false`: no battle, image generation, generated documents, context
    // routing or persona parameter); standard adds the persona parameter and external model routing;
    // premium adds response streaming.
    {
      value: 'basic', profile: 'concierge', grants: ['basic'], displayName: 'Basic', badgeToken: 'cls-1', groupPrecedence: 5, models: { selected: ['haiku'], default: 'haiku' },
      topology: {
        timeoutSeconds: 30, memorySize: 512, reservedConcurrency: 100, maxTokens: 1024,
        streaming: false, contextRouting: false, systemPromptParam: false, intentPackParam: true,
        richProcessor: false, handlerExperimentsIndex: true,
      },
    },
    {
      value: 'standard', profile: 'analyst', grants: ['basic', 'standard'], battleCapable: true, produces: ['document'], displayName: 'Standard', badgeToken: 'cls-2', holdsBriefing: true, groupPrecedence: 4, models: { selected: ['haiku', 'sonnet', 'titan', 'gpt_oss_20b', 'deepseek_v3', 'deepseek_r1'], default: 'sonnet' },
      topology: {
        timeoutSeconds: 60, memorySize: 512, reservedConcurrency: 50, maxTokens: 4096,
        streaming: false, contextRouting: true, systemPromptParam: true, intentPackParam: true,
        richProcessor: true, handlerExperimentsIndex: false,
      },
    },
    // PREMIUM ALSO OFFERS AN `ops` ROLE, deployed where the deployment names its assistant (`ops-premium` in
    // `profiles`, `shippedProfilesSelection`). It is the worked case for a role reaching something its
    // classification's primary may not. Its acting role's boundary names the CloudWatch metric and alarm READS an
    // operations assistant needs, conditioned on the role tag every assistant session already carries, so
    // `advisor` (primary) is refused the same reads inside the same classification. That difference
    // is the point: a classification is not one reach, it is a set of grants that its roles divide up.
    //
    // AND THE OPS ROLE READS LESS CONTEXT THAN THE PRIMARY. An operations assistant needs the public
    // material, the directory and the internal processes and runbooks (basic and standard context), and
    // has no business reading the board summary, financials, customer accounts or competitive intel that
    // premium's own prefix holds. Its assistant is granted only those two prefixes, so the read is refused by
    // IAM rather than avoided by a prompt.
    //
    // Premium reads a per-deployment intent pack too. With no pack seeded or `assistantIntentPack`
    // passed, the router hydrates nothing and uses DEFAULT_INTENT_PACK; a pack takes effect once it exists
    // at ${SSM_ROOT}/assistant/premium/assistant-intent-pack, which is where the demo seeds premium's
    // domain intents.
    {
      value: 'premium', profile: 'advisor', grants: ['basic', 'standard', 'premium'], battleCapable: true, roles: ['primary', 'ops'], roleContext: { ops: ['basic', 'standard'] }, produces: ['document'], displayName: 'Premium', badgeToken: 'cls-3', groupPrecedence: 3,
      models: { selected: ['haiku', 'sonnet', 'opus', 'titan', 'gpt_oss_20b', 'gpt_oss_120b', 'deepseek_v3', 'titan_image', 'nova_canvas', 'stability_image_core', 'stability_image_ultra', 'openai_gpt_image_1', 'fal_flux_pro_1_1'], default: 'opus' },
      topology: {
        timeoutSeconds: 90, memorySize: 1024, reservedConcurrency: 20, maxTokens: 4096,
        streaming: true, contextRouting: false, systemPromptParam: false, intentPackParam: true,
        richProcessor: true, handlerExperimentsIndex: false,
      },
    },
    // ── THE ADMIN PLANE: THE CLASSIFICATION OF ADMIN CONVERSATIONS ─────────────────────────────
    //
    // Administration happens in conversations: the admin notification channel carries alerts derived
    // from every classification's traffic, and an operator talks to the admin assistant there. Those rooms
    // carry a classification like every other, judged by the same IAM condition, and this is it.
    //
    // IT GRANTS ITSELF AND NOTHING ELSE. Holding `admin` (the `admins` group) clears a person's CHAT
    // identity for admin conversations, and for no member conversation: the chat identity is
    // membership-gated like any user's, and no chat credential acquires cross-classification reach
    // (SPEC-ADMIN-IDENTITY FR1, the two-identity split). Reach across every conversation, the archive
    // and every admin capability is ADMIN ACCESS, which is a different thing: an issuer declaring
    // `admin: true`, its admin groups, the console session and the separate `${personId}-admin`
    // AppInstanceUser the admin credential exchange vends for one conversation at a time.
    //
    // A PERSON HOLDING IT BESIDE A MEMBER CLASSIFICATION is vended the member classification's role, with
    // the `adminPlane` session tag that adds admin-plane channels to it (`ProfileRegistry.holderOf`,
    // `exchangeVendStatements`). A person holding it alone is vended the admin plane's own role, which
    // reaches admin-plane channels only.
    //
    // AND MARKED ADMIN-PLANE, which keeps it off the stamp for content whose classification cannot be
    // established (`failClosedContentValue` excludes the admin plane): no user conversation is served at
    // it, so content stamped there would be retrievable by nobody.
    { value: 'admin', profile: 'admin-agent', adminPlane: true, grants: ['admin'], displayName: 'Admin', groupPrecedence: 1, models: { selected: ['haiku'], default: 'haiku' } },
    // ── THE GUEST: AN ANONYMOUS VISITOR, IN ITS OWN CONVERSATION (A7, L11) ──────────────────────
    //
    // The classification the guest issuer vends (`kind: 'guest'` in `issuers`): one conversation, read
    // and post only, under the guest-session permissions boundary. It grants itself and nothing else, and
    // no other classification grants it, so no member's clearance reaches a guest's conversation and no
    // guest reaches anybody else's. Its own assistant (`Assistants-guest`) answers on the narrow processor
    // with its own model selection: the one low-cost model it selects from the catalog (`models`).
    //
    // OUTSIDE AUDIENCE, so it is never the stamp for content whose classification cannot be established.
    {
      value: 'guest', profile: 'greeter', grants: ['guest'], displayName: 'Guest', audience: 'outside', badgeToken: 'cls-5', models: { selected: ['haiku'], default: 'haiku' },
      topology: {
        timeoutSeconds: 30, memorySize: 512, reservedConcurrency: 20, maxTokens: 1024,
        streaming: false, contextRouting: false, systemPromptParam: false, intentPackParam: true,
        richProcessor: false, handlerExperimentsIndex: false,
      },
    },
    // ── THE CUSTOMER: A SIGNED-IN PERSON FROM OUTSIDE THE DEPLOYMENT (path B) ──────
    //
    // The classification a `customer-engagement` conversation is created at, when a visitor's
    // registration is claimed by a signed-in account (path B, `lambda/src/guest-upgrade.ts`). OUTSIDE
    // AUDIENCE for the same reasons as the guest: it grants itself and nothing else, no member's clearance
    // reaches it as a standing grant, and it is never the stamp for content whose classification cannot
    // be established. Unlike the guest, its people sign in: an issuer whose classifications are all outside
    // classifications reaches it (`lib/config/issuers.ts`), and the exchange vends it a role like any
    // member classification. The guest classification stays the guest issuer's alone.
    {
      value: 'customer', profile: 'liaison', grants: ['customer'], displayName: 'Customer', audience: 'outside', badgeToken: 'cls-6', models: { selected: ['haiku'], default: 'haiku' },
      topology: {
        timeoutSeconds: 30, memorySize: 512, reservedConcurrency: 10, maxTokens: 1024,
        streaming: false, contextRouting: false, systemPromptParam: false, intentPackParam: true,
        richProcessor: false, handlerExperimentsIndex: false,
      },
    },
  ],
  profiles: [
    // classifierMode: 'llm' for ALL default profiles — basic is deliberately NOT keyword-classified
    // (a considered deviation from the legacy keyword-classifier path, `classifyIntentByKeyword`).
    // 'keyword' remains a valid
    // schema option a deployment can select for a cheap profile; it is just not the default.
    // attachmentsReadable mirrors what the classification stacks already build: `richProcessor` is
    // false for basic and true for standard/premium, and it is the flag that carried the attachment
    // bucket and the S3 grant. Stated here so the composer can ask the same question the IAM role
    // answers, instead of a client re-deriving it from a tier name.
    // WHETHER A DUEL MAY RUN IS NOT ON AN ASSISTANT AT ALL (ADR-049). It is the CLASSIFICATION's
    // `battleCapable` above, plus a runtime setting an operator turns on, and neither is a property
    // of the profile serving the room.
    //
    // This comment used to say every conversational classification was battle-eligible, which was a
    // correction of an earlier "premium-only" reading - and it was wrong in the other direction.
    // `concierge` serves `basic`, whose stack sets no battle plumbing, so marking it eligible let an
    // enable succeed into a duel with no grants behind it. Two opposite readings of one flag, both
    // written down confidently, is what makes the split worth keeping.
    //
    // A duel is up to four model invocations (two assistants, two rounds), so once battle IS on,
    // `rateLimitPerHour` is what bounds the cost: at 60/hour a basic conversation affords far fewer
    // than premium's 240.
    { name: 'concierge', displayName: 'Concierge', modelKey: 'haiku', classifierMode: 'llm', timeoutSeconds: 30, contextScope: 'granted', rateLimitPerHour: 60, attachmentsReadable: false, defaultPersona: CONCIERGE_PERSONA },
    { name: 'analyst', displayName: 'Analyst', modelKey: 'sonnet', classifierMode: 'llm', timeoutSeconds: 60, contextScope: 'granted', rateLimitPerHour: 120, attachmentsReadable: true, defaultPersona: ANALYST_PERSONA },
    { name: 'advisor', displayName: 'Advisor', modelKey: 'opus', classifierMode: 'llm', timeoutSeconds: 90, contextScope: 'granted', rateLimitPerHour: 240, attachmentsReadable: true, defaultPersona: ADVISOR_PERSONA },
    // ── THE `ops` ROLE'S ASSISTANT, SERVING (premium, ops) ───────────────────────────────────────
    //
    // A SECOND ASSISTANT IN ONE CLASSIFICATION, which is the shape the platform was built for and had
    // never held. It reaches what `advisor` cannot - the deployment's own CloudWatch metrics and logs -
    // and that difference lives in its ROLE's acting role, not here: a profile carries selections and never
    // a policy, so nothing in this entry could widen what it may touch.
    //
    // ITS NAME IS NOT A CLASSIFICATION VALUE, deliberately. `advisor` serving `premium` is a
    // coincidence the tree has been quietly relying on; `ops-premium` cannot be mistaken for the
    // classification it serves, which is what makes the console column and the analytics dimension
    // mean what they say.
    //
    // A SMALLER MODEL AND A KEYWORD CLASSIFIER, because the questions are narrow and repetitive
    // ("what is the error rate", "show me the slow lambdas") and paying for a frontier model plus a
    // model-backed classifier on them is the cost control tenet P5 asks for. A product manager can
    // raise either in a profile version without a deploy, which is the point of the split.
    //
    // OWNED BY THE OPS TEAM from the moment it is provisioned: its `team-ops` members manage it and read
    // its analytics in the console, and nothing else.
    { name: 'ops-premium', displayName: 'Ops', modelKey: 'sonnet', classifierMode: 'keyword', timeoutSeconds: 60, contextScope: 'granted', rateLimitPerHour: 120, ownerTeam: 'ops' },
    // ── THE ADMIN ASSISTANT, SERVING THE `admin` CLASSIFICATION (DESIGN-ADMIN-AGENT-NOTIFICATIONS) ──
    //
    // An assistant like any other, expressed as config rather than as a hardcoded bot ARN, which is
    // what makes the admin-plane identity AE-native instead of a special case.
    //
    // BOUND TO `admin`, THE TOP CLASSIFICATION. Administration happens in conversations, and those
    // conversations are judged by the same closed axis as every other room - so the assistant that
    // serves them is the profile the `admin` classification names.
    //
    // THE BOUNDARY IS THE CLASSIFICATION, NOT THE ABSENCE OF ONE. "Never in a user conversation"
    // (design §5.1) holds because no ORDINARY conversation is classified `admin` and no ordinary user
    // clears for it: `groupClearance` grants `admin` to the `admins` group alone, and Layer 1 allows a
    // channel only when its tag is within the caller's set. That is an enforced boundary rather than
    // an unenforceable absence, and it is the same one every other classification gets.
    //
    // It OWNS the admin notification channel and is the sender identity for admin alerts, and it has no
    // conversational runtime: the SSM tree publishes `/assistant/admin-agent/bot-arn` and none of the
    // `router-arn` / `processor-arn` / `task-service-arn` keys its peers carry. So no conversation is
    // created at `admin`: `ProfileRegistry.isConversational` refuses an admin-plane
    // classification on every creation path, and the notification channel stays the one admin channel.
    { name: 'admin-agent', displayName: 'Admin Assistant', modelKey: 'haiku', classifierMode: 'llm', timeoutSeconds: 30, contextScope: 'granted' },
    // ── THE GUEST CLASSIFICATION'S ASSISTANT ─────────────────────────────────────────────────────
    //
    // The narrowest rate of any assistant, because its people are anonymous: the per-person message
    // limit L16 names, on top of guest start's per-IP limit. A 0 is refused in production (bin/backend.ts).
    { name: 'greeter', displayName: 'Assistant', modelKey: 'haiku', classifierMode: 'llm', timeoutSeconds: 30, contextScope: 'granted', rateLimitPerHour: 20, attachmentsReadable: false },
    // ── THE CUSTOMER CLASSIFICATION'S ASSISTANT ──────────────────────────────────────────────────
    //
    // Answers in a `customer-engagement` conversation, opened when a visitor's registration is claimed.
    // A signed-in customer is not anonymous, so its rate sits between the guest's and basic's.
    { name: 'liaison', displayName: 'Assistant', modelKey: 'haiku', classifierMode: 'llm', timeoutSeconds: 30, contextScope: 'granted', rateLimitPerHour: 40, attachmentsReadable: false },
  ],
  // `admins` now clears for the `admin` classification rather than for nothing. An administrator's
  // clearance is their own, not an accident of which tier group they also hold.
  groupClearance: { basic: 'basic', standard: 'standard', premium: 'premium', admins: 'admin' },
  // `ops` is the operators' group the `ops` and `ops-team` conversation types take their people from.
  // It grants nothing: its members must already be cleared for `premium`, the classification those
  // types are created at.
  membershipGroups: { ops: 'premium' },
};

/**
 * THE GUEST'S TWO LIMITS, which are separate mechanisms (L16):
 *   1. Per person, messages per hour: the `greeter` profile's `rateLimitPerHour`, the same field every
 *      assistant carries.
 *   2. Per source address, guest starts per window: the guest issuer's `perIpLimit`
 *      (`lib/config/issuers.ts`), enforced at guest start before anything is minted or signed, because a
 *      visitor has no identity to count yet.
 */

// ── THE DEPLOYMENT'S OWN SET (`profiles` in deploy.config.json) ─────────────────────────────────────
//
// `DEFAULT_PROFILES_CONFIG` above is the SHIPPED CATALOG, not what every deployment runs. A deployment
// declares its set in the `profiles` context key, in one of two forms:
//
//   - a list of shipped classification values (`["basic", "standard", "premium", "guest", "customer"]`):
//     those classifications as shipped, with the profiles that serve them, their role assistants, and
//     the clearance and membership groups that name them. Grants narrow to the selection.
//   - an object (`{ "classifications": [...], "profiles": [...], "groupClearance": {...} }`): a fully
//     custom set, which replaces the shipped one.
//
// Absent, the deployment runs the shipped catalog minus its outside classifications (`guest`, `customer`):
// an outside classification serves people from outside the deployment, so it deploys only when declared.
// In every form the admin plane is the platform's and is always present: the shipped `admin`
// classification, granting itself alone, its `admin-agent`
// profile and the `admins` clearance group. Every result is checked by `validateProfilesConfig`.

/** The admin plane every deployment carries, whatever set it declares. */
const ADMIN_PLANE_PROFILE = 'admin-agent';
const ADMIN_PLANE_GROUP = 'admins';

/** The admin plane of the shipped catalog: its classification row. */
function shippedAdminPlane(): DeploymentClassification {
  const row = DEFAULT_PROFILES_CONFIG.classifications.find((c) => c.adminPlane);
  if (!row) throw new Error('profiles config: the shipped catalog declares no admin plane');
  return row;
}

/** The shipped catalog's outside classifications (`audience: 'outside'`), which deploy only when declared. */
export function shippedOutsideClassifications(): string[] {
  return DEFAULT_PROFILES_CONFIG.classifications.filter((c) => c.audience === 'outside').map((c) => c.value);
}

/**
 * The role assistants the shipped catalog offers, by name (`<role>-<classification>`): what a selection
 * names to deploy one. `ops-premium` is the premium classification's `ops` role.
 */
export function shippedRoleAssistants(): Map<string, { classification: string; role: string }> {
  const offered = new Map<string, { classification: string; role: string }>();
  for (const c of DEFAULT_PROFILES_CONFIG.classifications) {
    for (const role of c.roles ?? []) if (role !== 'primary') offered.set(`${role}-${c.value}`, { classification: c.value, role });
  }
  return offered;
}

/**
 * The shipped catalog narrowed to a selection, plus the admin plane. The selection names shipped
 * classifications and, beside one, any role assistant the catalog offers it (`ops-premium`): a role is
 * deployed exactly when its assistant is named, and a classification named alone holds only its primary.
 * Each selected classification brings the profile that serves it and the profiles of its named roles; a
 * grant, clearance group or membership group naming a classification left out is dropped with it.
 */
export function shippedProfilesSelection(values: readonly string[]): ProfilesConfig {
  const shipped = DEFAULT_PROFILES_CONFIG;
  const known = new Set(shipped.classifications.map((c) => c.value));
  const offered = shippedRoleAssistants();
  const roleNames = values.filter((v) => !known.has(v) && offered.has(v));
  for (const v of values) {
    if (!known.has(v) && !offered.has(v)) {
      throw new Error(`profiles: "${v}" is not a shipped classification or role assistant (the shipped classifications are `
        + `${[...known].join(', ')}; the role assistants are ${[...offered.keys()].join(', ') || 'none'}); `
        + 'declare a custom set (an object with classifications, profiles and groupClearance) to add one');
    }
  }
  for (const name of roleNames) {
    const { classification } = offered.get(name)!;
    if (!values.includes(classification)) {
      throw new Error(`profiles: "${name}" is a role of "${classification}", which the selection does not name; add "${classification}" beside it`);
    }
  }
  const selected = new Set([...values.filter((v) => known.has(v)), shippedAdminPlane().value]);
  if (![...selected].some((v) => !shipped.classifications.find((c) => c.value === v)?.adminPlane)) {
    throw new Error('profiles: the selection names no classification a conversation is held at; name at least one');
  }
  const namedRoles = (value: string): string[] =>
    roleNames.map((n) => offered.get(n)!).filter((r) => r.classification === value).map((r) => r.role);
  const classifications = shipped.classifications
    .filter((c) => selected.has(c.value))
    .map((c) => {
      const out: DeploymentClassification = { ...c, grants: c.grants.filter((g) => selected.has(g)) };
      const roles = (c.roles ?? []).filter((r) => r !== 'primary' && namedRoles(c.value).includes(r));
      const context = Object.fromEntries(Object.entries(c.roleContext ?? {}).filter(([r]) => roles.includes(r)));
      if (roles.length) out.roles = ['primary', ...roles];
      else delete out.roles;
      if (Object.keys(context).length) out.roleContext = context;
      else delete out.roleContext;
      return out;
    });
  const serving = new Set<string>();
  for (const c of classifications) {
    serving.add(c.profile);
    for (const role of c.roles ?? []) if (role !== 'primary') serving.add(`${role}-${c.value}`);
  }
  const pick = (m: Record<string, string> | undefined): Record<string, string> =>
    Object.fromEntries(Object.entries(m ?? {}).filter(([, target]) => selected.has(target)));
  const config: ProfilesConfig = {
    classifications,
    profiles: shipped.profiles.filter((p) => serving.has(p.name)),
    groupClearance: pick(shipped.groupClearance),
  };
  const membershipGroups = pick(shipped.membershipGroups);
  if (Object.keys(membershipGroups).length) config.membershipGroups = membershipGroups;
  return config;
}

/**
 * A fully custom set with the platform's admin plane added: the shipped `admin` classification, granting
 * itself alone, its profile, and the `admins` clearance group. The set
 * declares no admin plane of its own and does not reuse the admin plane's names.
 */
export function customProfilesWithAdminPlane(custom: ProfilesConfig): ProfilesConfig {
  if (!custom || typeof custom !== 'object' || !Array.isArray(custom.classifications) || !Array.isArray(custom.profiles)
    || !custom.groupClearance || typeof custom.groupClearance !== 'object' || Array.isArray(custom.groupClearance)) {
    throw new Error('profiles: a custom set is an object with a classifications list, a profiles list and a groupClearance map');
  }
  const admin = shippedAdminPlane();
  const adminProfile = DEFAULT_PROFILES_CONFIG.profiles.find((p) => p.name === admin.profile);
  if (!adminProfile) throw new Error(`profiles config: the shipped admin plane's profile '${admin.profile}' is not declared`);
  for (const c of custom.classifications) {
    if (c?.adminPlane) throw new Error(`profiles: custom classification '${c.value}' declares adminPlane; the admin plane is the platform's and every deployment carries it`);
    if (c?.value === admin.value) throw new Error(`profiles: custom classification '${c.value}' is the admin plane's value`);
  }
  if (custom.profiles.some((p) => p?.name === ADMIN_PLANE_PROFILE)) {
    throw new Error(`profiles: custom profile '${ADMIN_PLANE_PROFILE}' is the admin plane's assistant, which every deployment carries`);
  }
  const names = custom.profiles.map((p) => p?.name);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice !== undefined) throw new Error(`profiles: custom profile '${twice}' is declared twice`);
  if (ADMIN_PLANE_GROUP in custom.groupClearance) {
    throw new Error(`profiles: groupClearance['${ADMIN_PLANE_GROUP}'] is the admin plane's clearance group, which every deployment carries`);
  }
  const config: ProfilesConfig = {
    classifications: [...custom.classifications, { ...admin, grants: [admin.value] }],
    profiles: [...custom.profiles, adminProfile],
    groupClearance: { ...custom.groupClearance, [ADMIN_PLANE_GROUP]: admin.value },
  };
  if (custom.membershipGroups && Object.keys(custom.membershipGroups).length) config.membershipGroups = { ...custom.membershipGroups };
  return config;
}

/**
 * The `profiles` context value as declared: absent, a list of shipped classification values, or a custom
 * set. Accepts what a test passes (an array or an object), a JSON string (`-c` by hand), a comma list
 * (how `deploy.mjs` forwards a list of names) and `json64:<base64url JSON>` (how it forwards an object).
 */
export function parseProfilesContext(raw: unknown): string[] | ProfilesConfig | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  if (typeof raw === 'object') return raw as ProfilesConfig;
  let text = String(raw).trim();
  if (text.startsWith('json64:')) text = Buffer.from(text.slice('json64:'.length), 'base64url').toString('utf8').trim();
  if (!text) return undefined;
  if (text.startsWith('[') || text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`profiles: the value is not JSON: ${text.slice(0, 80)}`);
    }
    if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
    if (parsed && typeof parsed === 'object') return parsed as ProfilesConfig;
    throw new Error('profiles: the value is a list of shipped classification values or a custom set');
  }
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

/** The shipped classifications a deployment that declares no `profiles` runs: every member one (no outside one). */
function shippedMemberSelection(): string[] {
  const outside = new Set(shippedOutsideClassifications());
  return DEFAULT_PROFILES_CONFIG.classifications.filter((c) => !c.adminPlane && !outside.has(c.value)).map((c) => c.value);
}

/**
 * THE SET THIS DEPLOYMENT RUNS, from its `profiles` context value. Absent: the shipped catalog minus its
 * outside classifications, each holding only its primary. A list: that selection of the shipped catalog,
 * with each role assistant it names (`ops-premium`). An object: that custom set, roles as it declares them.
 * The admin plane is present in all three, and the result is validated (`validateProfilesConfig`).
 */
export function resolveDeploymentProfiles(raw: unknown): ProfilesConfig {
  const declared = parseProfilesContext(raw);
  const config = declared === undefined
    ? shippedProfilesSelection(shippedMemberSelection())
    : Array.isArray(declared)
      ? shippedProfilesSelection(declared)
      : customProfilesWithAdminPlane(declared);
  validateProfilesConfig(config);
  return config;
}

/**
 * THE RUNTIME REGISTRY: ONE ROW PER CLASSIFICATION, PUBLISHED BY THE STACK THAT OWNS IT.
 *
 * A handler resolves classifications, clearance and profiles through `defaultProfileRegistry`
 * (`lib/profile-registry.ts`), and it reads the deployment's set at runtime rather than from its
 * environment, so adding or removing a classification changes no other stack's template. Each
 * `Assistants-<classification>` stack publishes its classification's row, and `Identity` publishes the admin
 * plane's, as one SSM parameter each under {@link registryPathOf} (`<SSM root>/registry/classification/<value>`).
 * A handler reads them with one `GetParametersByPath` (`loadProfileRegistry`), and the stack delete that removes
 * a classification removes its row. Every runtime principal is denied a write on the path; IAM never reads it.
 *
 * A row carries its classification's own declaration and nothing about another's:
 *
 *   - `classification`: the classification's entry. The admin plane's `grants` names itself alone, and the
 *     registry reads it as every member classification the rows declare and itself (admins span every member
 *     classification without the admin plane's row naming one).
 *   - `profiles`: the profiles it serves: its primary's (`profile`) and each role's (`<role>-<value>`).
 *   - `groupClearance`: the groups that clear for it.
 *   - `membershipGroups`: the membership groups that require it.
 */
export interface ClassificationRegistryRow {
  classification: DeploymentClassification;
  profiles: AssistantProfile[];
  groupClearance: Record<string, string>;
  membershipGroups?: Record<string, string>;
}

/** The SSM path the rows are published under, below an instance's SSM root. */
export function registryPathOf(ssmRoot: string): string {
  return `${ssmRoot}/registry/classification`;
}

/** The environment variable naming the registry's path to every function the app builds. */
export const PROFILE_REGISTRY_PATH_ENV = 'AE_PROFILE_REGISTRY_PATH';

/**
 * THE S3 COPY OF THE ROWS, for the functions in the analytics VPC. That VPC is NAT-free and reaches S3 through a
 * free gateway endpoint but has no route to SSM, so the stack that publishes a row's parameter also writes the same
 * value to one object under {@link REGISTRY_S3_PREFIX} in the registry bucket ({@link registryBucketNameOf}), and a
 * VPC-attached function is told where with {@link PROFILE_REGISTRY_S3_ENV} (`s3://<bucket>/<prefix>/`). A function
 * outside the VPC reads the parameters.
 */
export const PROFILE_REGISTRY_S3_ENV = 'AE_PROFILE_REGISTRY_S3';

/** The key prefix the S3 copy of the rows is written under, one object per classification (`<prefix>/<value>`). */
export const REGISTRY_S3_PREFIX = 'registry/classification';

/** The registry bucket's name for an instance's resource prefix, account and region (`Identity` creates it). */
export function registryBucketNameOf(resPrefix: string, account: string, region: string): string {
  return `${resPrefix}-registry-${account}-${region}`;
}

/** The S3 location a VPC-attached function is told (`PROFILE_REGISTRY_S3_ENV`). */
export function registryS3LocationOf(bucket: string): string {
  return `s3://${bucket}/${REGISTRY_S3_PREFIX}/`;
}

/** The profile names a classification serves: its primary's and each declared role's (`<role>-<value>`). */
function servedProfileNames(c: DeploymentClassification, config: ProfilesConfig): string[] {
  const names = [c.profile];
  for (const role of c.roles ?? []) {
    const name = `${role}-${c.value}`;
    if (role !== 'primary' && config.profiles.some((p) => p.name === name)) names.push(name);
  }
  return names;
}

/**
 * The row of each classification in `config`, in its declaration order. Throws for a profile no
 * classification serves: the runtime registry carries a profile with the classification that serves it.
 */
export function registryRowsOf(config: ProfilesConfig): ClassificationRegistryRow[] {
  validateProfilesConfig(config);
  const owned = new Set<string>();
  const rows = config.classifications.map((c): ClassificationRegistryRow => {
    const names = servedProfileNames(c, config);
    names.forEach((n) => owned.add(n));
    const pick = (m: Record<string, string> | undefined): Record<string, string> =>
      Object.fromEntries(Object.entries(m ?? {}).filter(([, target]) => target === c.value));
    const membershipGroups = pick(config.membershipGroups);
    return {
      classification: c.adminPlane ? { ...c, grants: [c.value] } : { ...c },
      profiles: config.profiles.filter((p) => names.includes(p.name)),
      groupClearance: pick(config.groupClearance),
      ...(Object.keys(membershipGroups).length ? { membershipGroups } : {}),
    };
  });
  const orphans = config.profiles.filter((p) => !owned.has(p.name)).map((p) => p.name);
  if (orphans.length) {
    throw new Error(`profiles config: profile(s) ${orphans.join(', ')} serve no classification; a profile is published with the classification that serves it`);
  }
  return rows;
}

/** The row of one classification in `config`. Throws for a value `config` does not declare. */
export function registryRowOf(config: ProfilesConfig, value: string): ClassificationRegistryRow {
  const row = registryRowsOf(config).find((r) => r.classification.value === value);
  if (!row) throw new Error(`profiles config: '${value}' is not a declared classification, so it has no registry row`);
  return row;
}

/** The largest value a standard-tier SSM parameter holds; a larger row is compressed, then published on the advanced tier. */
export const STANDARD_PARAMETER_LIMIT = 4096;
/** The largest value an advanced-tier SSM parameter holds. */
export const ADVANCED_PARAMETER_LIMIT = 8192;

/**
 * A row as its parameter's value: the JSON, or `gz64:` and the gzipped JSON in base64 when the JSON is longer
 * than a standard parameter holds. Throws for a row that does not fit an advanced parameter compressed.
 */
export function registryRowValue(row: ClassificationRegistryRow): string {
  const json = JSON.stringify(row);
  if (Buffer.byteLength(json, 'utf8') <= STANDARD_PARAMETER_LIMIT) return json;
  const packed = `gz64:${gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64')}`;
  if (packed.length > ADVANCED_PARAMETER_LIMIT) {
    throw new Error(`profiles config: the registry row of '${row.classification.value}' is ${packed.length} bytes compressed, `
      + `more than an SSM parameter holds (${ADVANCED_PARAMETER_LIMIT}); shorten its profiles' personas`);
  }
  return packed;
}

/** The row a parameter value carries. Throws on a value it cannot read: a handler never guesses its set. */
export function registryRowFromValue(value: string): ClassificationRegistryRow {
  const json = value.startsWith('gz64:') ? gunzipSync(Buffer.from(value.slice('gz64:'.length), 'base64')).toString('utf8') : value;
  const row = JSON.parse(json) as ClassificationRegistryRow;
  if (!row || typeof row !== 'object' || !row.classification || typeof row.classification.value !== 'string' || !Array.isArray(row.profiles)) {
    throw new Error('profile registry: a row is not a classification registry row');
  }
  return row;
}

/**
 * THE DEPLOYMENT'S SET, ASSEMBLED FROM ITS ROWS, in the order of their classification values (the rows are read
 * by path, so no row's position depends on another's). The admin plane grants itself alone. A profile two rows both carry is one profile, and must be the same in both. Validated
 * like any declared set (`validateProfilesConfig`).
 */
export function profilesConfigFromRows(rows: readonly ClassificationRegistryRow[]): ProfilesConfig {
  const sorted = [...rows].sort((a, b) => (a.classification.value < b.classification.value ? -1 : a.classification.value > b.classification.value ? 1 : 0));
  const classifications = sorted.map((r): DeploymentClassification => (r.classification.adminPlane
    ? { ...r.classification, grants: [r.classification.value] }
    : { ...r.classification }));
  const profiles = new Map<string, AssistantProfile>();
  for (const r of sorted) {
    for (const p of r.profiles) {
      const prior = profiles.get(p.name);
      if (prior && JSON.stringify(prior) !== JSON.stringify(p)) {
        throw new Error(`profile registry: profile '${p.name}' is published twice, differently`);
      }
      profiles.set(p.name, p);
    }
  }
  const groupClearance: Record<string, string> = {};
  const membershipGroups: Record<string, string> = {};
  for (const r of sorted) {
    Object.assign(groupClearance, r.groupClearance ?? {});
    Object.assign(membershipGroups, r.membershipGroups ?? {});
  }
  const config: ProfilesConfig = { classifications, profiles: [...profiles.values()], groupClearance };
  if (Object.keys(membershipGroups).length) config.membershipGroups = membershipGroups;
  validateProfilesConfig(config);
  return config;
}

/** One item the runtime assembly left out of the set, and why (`profilesConfigFromPublishedRows`). */
export interface RegistryDrop {
  kind: 'unreadable-row' | 'duplicate-row' | 'dangling-grant' | 'conflicting-profile';
  /** The classification whose row the item was in, when the row could be read. */
  classification?: string;
  detail: string;
}

/** True when `row`'s classification serves the profile `name`: its primary's, or one of its declared roles'. */
function rowServes(row: ClassificationRegistryRow, name: string): boolean {
  const c = row.classification;
  return c.profile === name || (c.roles ?? []).some((role) => role !== 'primary' && `${role}-${c.value}` === name);
}

/**
 * THE DEPLOYMENT'S SET AS A RUNNING HANDLER ASSEMBLES IT FROM THE PUBLISHED ROWS, failing closed per item rather
 * than for the whole set. The rows are published by independently deployed stacks, so for a while one stack's
 * deploy or removal can leave the others naming what is not there; a handler that refused the whole set then
 * would take the platform down with it. Each defect costs only the item it is in:
 *
 *   - a row that cannot be read is left out;
 *   - a second row for a classification already read is left out (the first by value is kept);
 *   - a grant naming a classification no row declares is dropped, so it reaches nothing until that row exists;
 *   - a profile two rows publish differently is the copy of the row whose classification serves it (the first
 *     row by value when none does), and the other copies are left out.
 *
 * Each item left out is returned in `dropped`, for the caller to log and count. What remains is validated
 * like any declared set (`profilesConfigFromRows`); the synth-time validation of the declared set stays strict.
 */
export function profilesConfigFromPublishedRows(values: readonly string[]): { config: ProfilesConfig; dropped: RegistryDrop[] } {
  const dropped: RegistryDrop[] = [];
  const read: ClassificationRegistryRow[] = [];
  values.forEach((v, i) => {
    try {
      read.push(registryRowFromValue(v));
    } catch (err) {
      dropped.push({ kind: 'unreadable-row', detail: `row ${i}: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
  const byValue = (a: ClassificationRegistryRow, b: ClassificationRegistryRow) =>
    (a.classification.value < b.classification.value ? -1 : a.classification.value > b.classification.value ? 1 : 0);
  const rows: ClassificationRegistryRow[] = [];
  for (const r of [...read].sort(byValue)) {
    if (rows.some((k) => k.classification.value === r.classification.value)) {
      dropped.push({ kind: 'duplicate-row', classification: r.classification.value, detail: 'a second row for this classification' });
    } else rows.push(r);
  }
  const present = new Set(rows.map((r) => r.classification.value));
  const kept = rows.map((r): ClassificationRegistryRow => {
    const c = r.classification;
    if (c.adminPlane || !Array.isArray(c.grants)) return r;
    const missing = c.grants.filter((g) => !present.has(g));
    for (const g of missing) dropped.push({ kind: 'dangling-grant', classification: c.value, detail: `grants '${g}', which no row declares` });
    return missing.length ? { ...r, classification: { ...c, grants: c.grants.filter((g) => present.has(g)) } } : r;
  });
  // A PROFILE PUBLISHED TWICE, DIFFERENTLY, is its serving row's copy.
  const names = new Set(kept.flatMap((r) => r.profiles.map((p) => p.name)));
  const keep = new Map<string, ClassificationRegistryRow>();
  for (const name of names) {
    const carriers = kept.filter((r) => r.profiles.some((p) => p.name === name));
    const copies = new Set(carriers.map((r) => JSON.stringify(r.profiles.find((p) => p.name === name))));
    if (copies.size > 1) keep.set(name, carriers.find((r) => rowServes(r, name)) ?? carriers[0]);
  }
  const resolved = kept.map((r): ClassificationRegistryRow => {
    const losing = r.profiles.filter((p) => keep.has(p.name) && keep.get(p.name) !== r);
    for (const p of losing) {
      dropped.push({ kind: 'conflicting-profile', classification: r.classification.value,
        detail: `profile '${p.name}' differs from the copy '${keep.get(p.name)!.classification.value}' publishes, which is kept` });
    }
    return losing.length ? { ...r, profiles: r.profiles.filter((p) => !losing.includes(p)) } : r;
  });
  return { config: profilesConfigFromRows(resolved), dropped };
}

/**
 * The same set in a canonical order: classifications and profiles by value and name, and each map by key. A
 * declared set and the set its rows assemble to are equal in this form (`profilesConfigFromRows`).
 */
export function canonicalProfilesConfig(config: ProfilesConfig): ProfilesConfig {
  const byKey = (m: Record<string, string> | undefined) => Object.fromEntries(Object.entries(m ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const out: ProfilesConfig = {
    classifications: [...config.classifications].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
      .map((c) => (c.adminPlane ? { ...c, grants: [...c.grants].sort() } : { ...c })),
    profiles: [...config.profiles].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    groupClearance: byKey(config.groupClearance),
  };
  if (config.membershipGroups && Object.keys(config.membershipGroups).length) out.membershipGroups = byKey(config.membershipGroups);
  return out;
}

/**
 * The classifications that deploy an assistant stack, in declaration order: every classification
 * that declares a `topology`. `bin/backend.ts` creates one `Assistants-<value>` stack for each.
 */
export function assistantClassifications(config: ProfilesConfig = DEFAULT_PROFILES_CONFIG): string[] {
  return config.classifications.filter((c) => c.topology).map((c) => c.value);
}

/**
 * The assistant classifications a synth deploys, refusing a conversational classification with no
 * topology: it would be declared and never served, and every conversation created at it would find no
 * router. Called by `bin/backend.ts` on the registry it deploys.
 */
export function deployedAssistantClassifications(config: ProfilesConfig = DEFAULT_PROFILES_CONFIG): string[] {
  const unserved = config.classifications.filter((c) => !c.adminPlane && !c.topology).map((c) => c.value);
  if (unserved.length) {
    throw new Error(`profiles config: conversational classification(s) ${unserved.join(', ')} declare no topology, so no assistant stack would serve them`);
  }
  return assistantClassifications(config);
}

/** The topology a classification's assistant stack builds. Throws for a classification that declares none. */
export function requireTopology(value: string, config: ProfilesConfig = DEFAULT_PROFILES_CONFIG): AssistantTopology {
  const topology = config.classifications.find((c) => c.value === value)?.topology;
  if (!topology) throw new Error(`profiles config: classification '${value}' declares no topology, so it has no assistant stack`);
  return topology;
}

/**
 * Synth-time validation (mirrors the intent-pack hydrate checks). A malformed config fails
 * loudly at deploy rather than shipping an unreachable/degraded state. Throws on the first
 * violation with a named error.
 */
export function validateProfilesConfig(config: ProfilesConfig): void {
  const { classifications, profiles, groupClearance } = config;

  if (!classifications?.length) throw new Error('profiles config: at least one classification is required');
  if (!profiles?.length) throw new Error('profiles config: at least one profile is required');

  const classValues = new Set(classifications.map((c) => c.value));
  const profileNames = new Set(profiles.map((p) => p.name));

  // `alt-` NAMES BELONG TO THE ALTS (ADR-050): `alt-{role}-{classification}` is composed, never
  // declared, and its profile is published through an experiment. A declared profile under that prefix
  // would collide with a role's assistant or be mistaken for one.
  for (const p of profiles) {
    if (p.name.startsWith('alt-')) {
      throw new Error(`profiles config: profile '${p.name}' uses the 'alt-' prefix, which names a role's alt and is never declared`);
    }
  }

  // AN OWNER IS A TEAM NAME, NOTHING ELSE. It becomes a tag value and the suffix of a group name, so a
  // value outside the pattern would be refused by one and silently differ from the other.
  for (const p of profiles) {
    if (p.ownerTeam !== undefined && !TEAM_NAME_PATTERN.test(p.ownerTeam)) {
      throw new Error(`profiles config: profile '${p.name}' ownerTeam '${p.ownerTeam}' is not a team name (${TEAM_NAME_PATTERN})`);
    }
  }

  // CLASSIFICATION VALUES ARE UNIQUE. This checked that RANKS were unique, "unique/totally ordered",
  // which was the schema asserting the ladder. With no rank, what has to be unique is the value
  // itself - two classifications sharing a tag value would make the tag ambiguous.
  const seenValues = new Set<string>();
  for (const c of classifications) {
    if (seenValues.has(c.value)) throw new Error(`profiles config: duplicate classification value '${c.value}'`);
    seenValues.add(c.value);
  }

  // EVERY CLASSIFICATION DECLARES WHAT IT GRANTS. Optional before, falling back to own-rank-and-below;
  // that fallback was the ladder's last hiding place, so its absence is now an error rather than an
  // inherited ordering.
  for (const c of classifications) {
    if (!c.grants?.length) {
      throw new Error(`profiles config: classification '${c.value}' declares no grants; every classification must state the set it reaches`);
    }
    if (!c.grants.includes(c.value)) {
      throw new Error(`profiles config: classification '${c.value}' does not grant itself; a principal must reach its own classification`);
    }
    // A declared output is one the platform knows how to hand over. An unknown value would read as
    // "produces nothing" everywhere, which is safe, but a typo silently withdrawing an output from a
    // refusal's pointer is a configuration error, and it is said here rather than discovered later.
    for (const o of (c.produces ?? []) as string[]) {
      if (o === 'image') {
        throw new Error(`profiles config: classification '${c.value}' declares 'image' in produces; whether a classification produces images is its model selection's to decide (an image model in models.selected)`);
      }
      if (o !== 'document') {
        throw new Error(`profiles config: classification '${c.value}' declares unknown output '${o}' in produces; expected document`);
      }
    }
  }

  // TWO CLASSIFICATIONS WITH IDENTICAL GRANT SETS ARE AMBIGUOUS. `resolveHolderToken` picks the
  // declared classification whose grants ARE the union a person holds, so two identical sets make
  // that answer depend on declaration order. Caught here rather than decided there.
  const grantKeys = new Map<string, string>();
  for (const c of classifications) {
    const key = [...c.grants].sort().join(',');
    const prior = grantKeys.get(key);
    if (prior) {
      throw new Error(`profiles config: '${c.value}' and '${prior}' grant the same set (${key}); a holder token would be ambiguous`);
    }
    grantKeys.set(key, c.value);
  }

  // THE ADMIN PLANE GRANTS ITSELF ALONE, AND NOTHING ELSE GRANTS IT. A chat identity holding it reaches admin
  // conversations and no member conversation, and a member classification never reaches an admin conversation:
  // the admin plane is added to a member role by the `adminPlane` session tag alone (SPEC-ADMIN-IDENTITY FR1).
  const planeValues = classifications.filter((c) => c.adminPlane).map((c) => c.value);
  for (const c of classifications) {
    if (c.adminPlane && (c.grants.length !== 1 || c.grants[0] !== c.value)) {
      throw new Error(`profiles config: classification '${c.value}' is the admin plane and grants ${c.grants.join(', ')}; the admin plane grants itself alone`);
    }
    const grantsPlane = c.adminPlane ? undefined : c.grants.find((g) => planeValues.includes(g));
    if (grantsPlane) throw new Error(`profiles config: classification '${c.value}' grants the admin plane '${grantsPlane}'; only holding the admin plane reaches it`);
  }

  // THE ADMIN PLANE DECLARES NO ASSISTANT STACK. The assistant stacks are created from `topology`, and an
  // admin-plane one would deploy a runtime no conversation may reach. That every conversational
  // classification of the DEPLOYED registry declares one is the synth's check (`deployedAssistantClassifications`).
  for (const c of classifications) {
    if (c.adminPlane && c.topology) {
      throw new Error(`profiles config: classification '${c.value}' is the admin plane and declares a topology; the admin plane has no conversational runtime and no assistant stack`);
    }
  }

  // every classification's profile exists
  for (const c of classifications) {
    if (!profileNames.has(c.profile)) {
      throw new Error(`profiles config: classification '${c.value}' references unknown profile '${c.profile}'`);
    }
  }

  // Every grant names a declared classification, and a classification grants itself.
  //
  // AN UNRESOLVABLE GRANT IS A HOLE, NOT A NARROWING. It is dropped when the set is resolved, so a
  // typo silently removes reach somebody was meant to have - and the symptom is a conversation that
  // is simply missing, with no error anywhere. Caught here, where the mistake is.
  //
  // Self-inclusion is required for the same reason: a classification that grants others but not
  // itself would let a holder into every room except their own, which is never what anybody means.
  const declaredValues = new Set(classifications.map((c) => c.value));
  for (const c of classifications) {
    if (!c.grants) continue;
    for (const g of c.grants) {
      if (!declaredValues.has(g)) {
        throw new Error(`profiles config: classification '${c.value}' grants '${g}', which is not a declared classification`);
      }
    }
    if (!c.grants.includes(c.value)) {
      throw new Error(`profiles config: classification '${c.value}' declares grants that omit itself`);
    }
  }

  // ── A PROFILE NAME MAY NOT BE A CLASSIFICATION VALUE ────────────────────────────────────────
  //
  // The shipped sample named every profile after the classification it served, and that coincidence
  // was not a tidy default: it made every reader that built `/assistant/{classification}/…` correct
  // by accident, and no test could tell a classification from an assistant because the strings
  // matched. The admin plane was the only place they differed, which is why its key is the one
  // name-shaped parameter in the tree.
  //
  // CHECKED HERE RATHER THAN REVIEWED, because the failure it prevents is silent. A deployment that
  // reintroduces the collision gets a build error; one that does not gets a namespace where the two
  // questions cannot be confused by a reader or by a test.
  const classificationValues = new Set(classifications.map((c) => c.value));
  for (const p of profiles) {
    if (classificationValues.has(p.name)) {
      throw new Error(
        `profiles config: profile '${p.name}' is also a classification value. A profile name says what an `
        + 'assistant IS and a classification says which boundary it serves; naming them the same makes '
        + '/assistant/{name} and /assistant/{classification} collide and every reader correct by accident.',
      );
    }
  }

  // THERE IS NO `failClosedTo` TO VALIDATE. It had to be "the lowest rank", which is a check only a
  // ladder can pass. A deployment declaring `legal` and `finance` has no lowest, and the consumers
  // that used to substitute it now refuse instead (ADR-045 decision 2).

  // ── A GROUP'S PRECEDENCE IS DECLARED, AN INTEGER, AND ITS OWN ──────────────────────────────────────
  const precedences = new Map<number, string>();
  for (const c of classifications) {
    if (c.groupPrecedence === undefined) continue;
    const n = c.groupPrecedence;
    if (!Number.isInteger(n) || n < 0 || n >= MEMBERSHIP_GROUP_PRECEDENCE_BASE) {
      throw new Error(`profiles config: classification '${c.value}' groupPrecedence must be an integer from 0 to ${MEMBERSHIP_GROUP_PRECEDENCE_BASE - 1}; it is ${n}`);
    }
    if (n === TEAM_MEMBERS_GROUP_PRECEDENCE) throw new Error(`profiles config: classification '${c.value}' groupPrecedence ${n} is the team-members group's`);
    const other = precedences.get(n);
    if (other) throw new Error(`profiles config: '${other}' and '${c.value}' both declare groupPrecedence ${n}`);
    precedences.set(n, c.value);
  }

  // ── AN OUTSIDE CLASSIFICATION IS REACHED BY ITS OWN PEOPLE ALONE ────────────────────────────────
  //
  // Its people are not the deployment's (an anonymous visitor), so it grants only itself, and nothing
  // the deployment's own people hold reaches it: no other classification grants it and no clearance
  // group names it. A member joining a visitor's conversation is a decision made per conversation
  // (a hand-off, **NOT BUILT**), never a standing grant.
  for (const c of classifications) {
    if (c.audience !== undefined && c.audience !== 'members' && c.audience !== 'outside') {
      throw new Error(`profiles config: classification '${c.value}' audience must be 'members' or 'outside'`);
    }
    if (c.audience !== 'outside') continue;
    if (c.adminPlane) throw new Error(`profiles config: classification '${c.value}' is the admin plane and cannot have an outside audience`);
    // Battle Mode is the deployment's own people's tool, and its shared roles are denied every outside
    // conversation (`neverAnOutsideConversation`), so a duel declared here would be refused by IAM.
    if (c.battleCapable) throw new Error(`profiles config: outside classification '${c.value}' declares battleCapable; Battle Mode never reaches an outside conversation`);
    if (c.grants.length !== 1 || c.grants[0] !== c.value) {
      throw new Error(`profiles config: outside classification '${c.value}' grants only itself; it grants ${c.grants.join(', ')}`);
    }
    for (const other of classifications) {
      if (other.value !== c.value && other.grants?.includes(c.value)) {
        throw new Error(`profiles config: '${other.value}' grants the outside classification '${c.value}'; nothing the deployment's own people hold reaches it`);
      }
    }
    for (const [group, target] of Object.entries(groupClearance || {})) {
      if (target === c.value) throw new Error(`profiles config: groupClearance['${group}'] names the outside classification '${c.value}'; its people come from its own issuer`);
    }
  }

  // every membership group requires a declared classification, and is not also a clearance group
  for (const [g, required] of Object.entries(config.membershipGroups || {})) {
    if (!classValues.has(required)) {
      throw new Error(`profiles config: membershipGroups['${g}'] requires unknown classification '${required}'`);
    }
    if (g in (groupClearance || {})) {
      throw new Error(`profiles config: '${g}' is both a clearance group and a membership group; a group grants a clearance or requires one, not both`);
    }
  }

  // THE BRIEFING IS HELD AT ONE CONVERSATIONAL CLASSIFICATION OF THE DEPLOYMENT'S OWN PEOPLE, when one declares it.
  const briefing = classifications.filter((c) => c.holdsBriefing);
  if (briefing.length > 1) throw new Error(`profiles config: ${briefing.map((c) => c.value).join(' and ')} both declare holdsBriefing; the briefing is held at one classification`);
  for (const b of briefing) {
    if (b.adminPlane) throw new Error(`profiles config: '${b.value}' declares holdsBriefing and is the admin plane, which holds no conversation`);
    if (b.audience === 'outside') throw new Error(`profiles config: '${b.value}' declares holdsBriefing and is an outside classification; a briefing is for the deployment's own people`);
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

  // A BADGE TOKEN IS ONE OF THE PALETTE'S EIGHT, AND NAMES ONE CLASSIFICATION. A client draws a classification's
  // badge in the color its token names; a token outside the palette draws nothing, and two classifications
  // sharing one cannot be told apart at a glance.
  // THE CLASSIFICATION SELECTS, FROM WHAT THE PLATFORM ALLOWS (`model-catalog.ts`), AND ITS PROFILES USE ONLY THAT.
  const catalogKeys = new Set(instanceModelKeys());
  for (const c of classifications) {
    const m = c.models;
    // EVERY CLASSIFICATION A STACK IS BUILT FOR SELECTS ITS MODELS; one with no topology deploys nothing (the
    // admin plane declares its selection for its own assistant's profile, and is checked when it does).
    if (!c.topology && !m) continue;
    if (!m || !Array.isArray(m.selected) || m.selected.length === 0) {
      throw new Error(`profiles config: classification '${c.value}' selects no models; declare models: { selected: [<catalog keys>], default: <a selected text model> }`);
    }
    for (const k of m.selected) {
      if (!catalogKeys.has(k)) throw new Error(`profiles config: classification '${c.value}' selects '${k}', which the instance's model catalog does not list`);
    }
    if (new Set(m.selected).size !== m.selected.length) throw new Error(`profiles config: classification '${c.value}' selects a model twice`);
    if (!m.selected.includes(m.default) || modelKindOf(m.default) !== 'bedrock') {
      throw new Error(`profiles config: classification '${c.value}' default '${m.default}' is not a Bedrock text model it selects`);
    }
    // CONTEXT ROUTING NEEDS A CHINESE PATH THE CLASSIFICATION SELECTS: DeepSeek on Bedrock (`deepseek_v3`, with
    // `deepseek_r1` for reasoning intents when it selects that too), or the external adapter (`deepseek_api`).
    if (c.topology?.contextRouting && !m.selected.includes('deepseek_v3') && !m.selected.includes('deepseek_api')) {
      throw new Error(`profiles config: classification '${c.value}' routes by context and selects neither deepseek_v3 nor deepseek_api`);
    }
    // AN EXTERNAL ADAPTER IS SELECTED ONLY WHERE A TURN CAN REACH IT. `deepseek_api` serves context routing's
    // external path alone, and the in-AWS path wins wherever DeepSeek on Bedrock is selected, so selecting it
    // otherwise holds a provider's key the classification never uses.
    if (m.selected.includes('deepseek_api') && (!c.topology?.contextRouting || m.selected.includes('deepseek_v3'))) {
      throw new Error(`profiles config: classification '${c.value}' selects deepseek_api, which no turn reaches: `
        + (c.topology?.contextRouting
          ? 'it also selects deepseek_v3, and a Chinese-language turn takes that in-AWS path'
          : 'the external adapter serves context routing alone, and this classification does not route by context'));
    }
  }
  for (const c of classifications) {
    const served = [c.profile, ...(c.roles ?? []).filter((r) => r !== 'primary').map((r) => `${r}-${c.value}`)];
    for (const name of served) {
      const prof = profiles.find((x) => x.name === name);
      if (prof && c.models && !c.models.selected.includes(prof.modelKey)) {
        throw new Error(`profiles config: profile '${prof.name}' uses '${prof.modelKey}', which classification '${c.value}' does not select`);
      }
      // A BASE MODEL IS A BEDROCK TEXT MODEL. The processor answers on nothing else, so an external adapter or an
      // image model named here would be ignored and every turn answered on the classification default.
      if (prof && modelKindOf(prof.modelKey) !== 'bedrock') {
        throw new Error(`profiles config: profile '${prof.name}' uses '${prof.modelKey}', which is not a Bedrock text model; a profile's base model is one`);
      }
    }
  }

  const badgeOwners = new Map<string, string>();
  for (const c of classifications) {
    if (c.badgeToken === undefined) continue;
    if (!(BADGE_TOKENS as readonly string[]).includes(c.badgeToken)) {
      throw new Error(`profiles config: classification '${c.value}' badgeToken '${String(c.badgeToken)}' is not one of ${BADGE_TOKENS.join(', ')}`);
    }
    const prior = badgeOwners.get(c.badgeToken);
    if (prior) throw new Error(`profiles config: '${c.value}' and '${prior}' both declare badgeToken '${c.badgeToken}'; their badges would be indistinguishable`);
    badgeOwners.set(c.badgeToken, c.value);
  }
}

/**
 * WHAT A CLIENT IS TOLD ABOUT ONE CLASSIFICATION: what to call it, who its conversations are for, which
 * badge color it draws, and what a person holding it reaches (to offer the conversations they may create;
 * the server enforces it regardless). Nothing else about the definition leaves the backend.
 */
export interface ClientClassification {
  value: string;
  displayName: string;
  audience: 'members' | 'outside';
  badgeToken: BadgeToken;
  grants: string[];
  /** True when a conversation is held at it: it deploys an assistant stack (a `topology`). */
  conversational: boolean;
  /** The models it selects from the instance's catalog, and its default (`DeploymentClassification.models`). */
  models?: ClassificationModels;
  /** True on the admin plane, which no ordinary conversation is held at. */
  adminPlane?: true;
}

/**
 * THE DEPLOYMENT'S CLASSIFICATIONS AS ITS CLIENTS RENDER THEM, in declaration order, with every badge token
 * resolved: a declared one as declared, an absent one as the lowest-numbered token no classification
 * declares and none before it took, repeating the palette once all eight are taken. Published as the
 * `Classifications` output (`PersonApiStack`), which the frontend build bakes into `VITE_CLASSIFICATIONS`.
 */
export function clientClassifications(config: ProfilesConfig): ClientClassification[] {
  const taken = new Set<string>(config.classifications.flatMap((c) => (c.badgeToken ? [c.badgeToken] : [])));
  let cycle = 0;
  const next = (): BadgeToken => {
    const free = BADGE_TOKENS.find((t) => !taken.has(t));
    if (free) {
      taken.add(free);
      return free;
    }
    return BADGE_TOKENS[cycle++ % BADGE_TOKENS.length];
  };
  return config.classifications.map((c) => ({
    value: c.value,
    displayName: c.displayName ?? c.value,
    audience: c.audience ?? 'members',
    badgeToken: c.badgeToken ?? next(),
    grants: [...c.grants],
    conversational: !!c.topology,
    ...(c.models ? { models: { selected: [...c.models.selected], default: c.models.default } } : {}),
    ...(c.adminPlane ? { adminPlane: true as const } : {}),
  }));
}
