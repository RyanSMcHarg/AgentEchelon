/**
 * THE DEPLOYMENT CONFIGURATIONS THE MATRIX SYNTHESIZES, AS DATA.
 *
 * Each configuration is a capability set: what an operator declares, and the stacks that declaration
 * must produce. The matrix synthesizes every configuration in both analytics modes through the real
 * CDK app (`synthesizeApp`, the same synthesis the API reference and the SSM-edge check use) and checks
 * four things about each one:
 *
 *  - the stack set is exactly the one the configuration declares;
 *  - the component rule: the core depends on no admin or interface stack, `ChatApp` needs only the
 *    core, the admin backend (`AdminServices` plus `AdminApi`) is present or absent as one unit and
 *    depends on no interface stack (it sits on the core and on the capabilities it administers, such as
 *    `Experiments`), and `AdminApp` needs only the core and the admin backend;
 *  - additivity: against the configuration before it, every earlier stack is still there and a
 *    stack changes only where it is an attach point, in the way that attach point allows;
 *  - every SSM parameter a stack resolves at deploy is published by a stack it deploys after.
 *
 * The layers (Interface, Communication, Interaction, Foundations) are labels and are not checked here:
 * no per-stack layer dependency is enforced. The components are.
 *
 * ── WHAT IS DATA HERE, AND WHAT IS NOT YET ─────────────────────────────────────────────────────────
 *
 * The context each configuration passes is `analyticsMode` plus `capabilities`, the declared list
 * `deploy.config.json` carries, which the CDK app reads through the capability registry
 * (`lib/config/capabilities.ts`). The core carries its target names (`Messaging`, `Identity`,
 * `Conversations`, `Archive`, `PersonApi`) and the admin backend is `AdminServices` with `AdminApi`. So
 * every configuration's exact stack set, the component rule, its SSM edges and its additivity are ordinary
 * tests. A configuration declares only built capabilities; one that declared another would not synthesize,
 * and `the-matrix-covers-every-configuration` refuses it.
 *
 * The issuers and classifications below are what each configuration declares, recorded as data. An
 * issuer with a registry entry (`entry`, the `lib/config/issuers.ts` shape) is passed in the `issuers`
 * context; the guest issuer and this deployment's own pool carry one. An issuer whose resource the
 * configuration does not hold carries none and is left out of what the app synthesizes: the staff pool
 * (a pool the deployment does not create), the partner provider (a provider configured on the pool) and
 * the host assertion (it pins a key the configuration does not hold). So C0 synthesizes the guest-only
 * deployment it describes: the guest issuer alone, `guest` and `customer`, and the widget.
 *
 * ADDITIVITY IS OVER CAPABILITIES, AT ONE ISSUER SET AND ONE CLASSIFICATION SET. A configuration is diffed
 * against the one before it only where both synthesize the same registry and the same classifications,
 * because neither is a capability: the registry travels in every function's environment
 * (`TRUSTED_ISSUERS`), a pool adds the directory reads and the membership audit, and the declared
 * classifications name every stack's grants and its `AE_PROFILES_CONFIG`. So C1, which adds this
 * deployment's pool and the member classifications to C0, and C0 + admin, which adds a pool for its
 * administrators, are diffed against nothing, and `the-matrix-covers-every-configuration` refuses a
 * `previous` that synthesizes another registry or another classification set.
 *
 * A configuration's classifications are what it declares in `profiles` (`resolveDeploymentProfiles`,
 * `lib/config/profiles.ts`), passed as context when it declares any. Declared as nothing, a deployment runs
 * the shipped catalog minus its outside classifications (`DEFAULT_CLASSIFICATIONS`: no `guest`, no
 * `customer`), which is what a configuration with no guest issuer and no `profiles` runs. An outside
 * classification deploys only when declared, and a configuration that passes a guest issuer declares
 * `guest` and `customer` (its path B claim opens a `customer-engagement` conversation), since synth
 * refuses the issuer otherwise. C1-custom declares a fully custom set: none of the shipped classifications,
 * and no guest.
 *
 * A CLASSIFICATION IS ADDED ON ITS OWN, AND CHECKED THE SAME WAY. `C1-custom+enterprise` is C1-custom with one
 * more classification and nothing else (`addsClassification`). Its own check diffs the two in both directions:
 * adding the classification and removing it change nothing outside its `Assistants-<classification>` stack,
 * and no other stack deploys after that one. The couplings that still hold are named in its test file, each
 * with the work that removes it, as a list that only shrinks.
 *
 * The app refuses a capability whose stacks are not built (`notBuilt` in the registry); no configuration
 * declares one, and the matrix refuses a configuration that does.
 *
 * Meetings (C4) is declared absent: its stacks and capability are owned by the meetings line of work,
 * and it joins the matrix as one entry here when that capability is in the registry.
 */

import { capabilityDefinition } from '../../lib/config/capabilities';
import { deployedAssistantClassifications, resolveDeploymentProfiles, DEFAULT_PROFILES_CONFIG, type ProfilesConfig } from '../../lib/config/profiles';
import { defaultProfileRegistry } from '../../lib/profile-registry';

/**
 * The classifications a deployment gets an `Assistants-*` stack for when it declares none: every one the
 * shipped catalog declares with a topology, less the outside ones (`guest`, `customer`).
 */
export const DEFAULT_CLASSIFICATIONS: readonly string[] = deployedAssistantClassifications(resolveDeploymentProfiles(undefined));

/** The outside classifications the shipped catalog offers: each deploys only where a configuration declares it. */
export const OUTSIDE_CLASSIFICATIONS = ['guest', 'customer'] as const;

export type AnalyticsMode = 'athena' | 'aurora';
export const ANALYTICS_MODES: readonly AnalyticsMode[] = ['athena', 'aurora'];

export type IssuerKind = 'guest' | 'cognito-pool' | 'cognito-federated' | 'oidc-entra' | 'host-assertion';

export interface DeclaredIssuer {
  id: string;
  kind: IssuerKind;
  /** True for an issuer whose people may obtain an admin session. */
  admin?: boolean;
  /**
   * The registry entry `deploy.config.json` declares for it (`lib/config/issuers.ts`), passed as the
   * `issuers` context. Absent where the issuer is a kind or a resource that is not built yet, so an entry
   * for it would be a guess; a configuration with such an issuer passes no `issuers` at all.
   */
  entry?: Record<string, unknown>;
}

/**
 * How a stack that exists in the configuration before may differ in this one.
 *
 *  - `any`: its template may change. The APIs' route tables and the interface stacks' generated
 *    settings (CORS origins, `frame-ancestors` from the declared hosts) are attach points.
 *  - `add-only`: every resource it had is still there with the same type; it may gain resources and
 *    outputs. `Identity` gains an issuer's resources when an issuer is added, and `AdminServices`
 *    gains the admin handlers of a capability declared after it (experiments), its nested stacks included:
 *    a nested stack's template changes as its parent may (`owningStackOf`, `matrix.ts`).
 *  - `env-and-add`: every resource it had is still there with the same properties, except a Lambda function's
 *    environment, and its outputs are unchanged; it may gain resources. A classification's own stack
 *    (`Assistants-<classification>`) builds its part in a capability that runs per classification (its grants
 *    on the capability's tables, in policies of their own, and each duel's alt; `classification-capabilities.ts`),
 *    so declaring the capability adds those and changes nothing the stack had.
 *  - `env-only`: the same resources with the same properties, except a Lambda function's environment
 *    (the synth-time capability values and declared tools). Never a resource, a grant or an export: a
 *    capability attaches its grants to these stacks' roles from its own stack (`Battle`, `Experiments`).
 *  - `none`: identical.
 */
export type AttachKind = 'any' | 'add-only' | 'env-and-add' | 'env-only' | 'none';

/** Stack name (without the instance prefix) -> how it may change between two configurations. */
export function attachKindOf(stack: string): AttachKind {
  if (/^(PersonApi|AdminApi)$/.test(stack)) return 'any';
  if (/^(ChatApp|AdminApp|Widget)$/.test(stack)) return 'any';
  if (/^(Identity|AdminServices)$/.test(stack)) return 'add-only';
  if (/^Assistants-.+$/.test(stack)) return 'env-and-add';
  if (/^(ChannelFlow|PostProcessing|Conversations)$/.test(stack)) return 'env-only';
  return 'none';
}

/**
 * The core stacks the target layout names that no work has built yet, each with the work that builds it.
 * The component-rule check reads the core without them, and refuses an entry for a stack that exists, so
 * the work that builds one deletes its entry here. Every core stack is built.
 */
export const CORE_NOT_BUILT: Readonly<Record<string, string>> = {};

/** The required core: present in every configuration. `Assistants-*` stacks are core as well. */
export const CORE_STACKS = [
  'Messaging',
  'Identity',
  'Conversations',
  'Archive',
  'ChannelFlow',
  'PostProcessing',
  'PersonApi',
] as const;

export const ADMIN_BACKEND_STACKS = ['AdminServices', 'AdminApi'] as const;
export const ADMIN_INTERFACE_STACK = 'AdminApp';
export const CHAT_INTERFACE_STACK = 'ChatApp';
export const INTERFACE_STACKS = ['ChatApp', 'AdminApp', 'Widget'] as const;

/** True for a stack that belongs to the core component: a required stack, an assistant stack, or an image guardrail. */
export function isCoreStack(stack: string): boolean {
  return (CORE_STACKS as readonly string[]).includes(stack)
    || /^Assistants-.+$/.test(stack)
    || /^ImageGuardrail-.+$/.test(stack);
}

export interface Configuration {
  /** Matrix id, e.g. `C0`, `C1-headless`, `C0+admin`. */
  id: string;
  /** The test file that synthesizes it, relative to this directory. One file per configuration. */
  file: string;
  summary: string;
  /** What `deploy.config.json` declares in `capabilities`. */
  capabilities: readonly string[];
  /** The registry entries it declares, passed as `issuers` when each has its entry (see the header). */
  issuers: readonly DeclaredIssuer[];
  /**
   * What `deploy.config.json` declares in `profiles`, passed as context when present: a list of shipped
   * classifications, or a custom set. Absent is the shipped catalog minus its outside classifications.
   */
  profiles?: readonly string[] | ProfilesConfig;
  /** The classifications it deploys, one `Assistants-<classification>` stack each: read from `profiles`. */
  classifications: readonly string[];
  /** Every stack the configuration stands up besides the core and the assistant stacks, `ImageGuardrail-*` excluded. */
  addedStacks: readonly string[];
  /** The configuration it is diffed against for additivity, or null when it extends none. */
  previous: string | null;
  /**
   * The configuration this one adds exactly one classification to, and that classification. Its independence
   * check (`describeClassificationIndependence`) diffs the two in both directions: adding the classification
   * and removing it change nothing outside its own `Assistants-<classification>` stack.
   */
  addsClassification?: { to: string; classification: string };
  /** The work that turns this configuration's stack-set, component-rule and additivity checks green. */
  greenAt: string;
  /** The connector registry it declares (`connectors`, `lib/config/connectors.ts`), passed as context. */
  connectors?: readonly Record<string, unknown>[];
}

/** The platform's own guest issuer: an anonymous visitor, fixed at and bound to the guest classification. */
const GUEST: DeclaredIssuer = {
  id: 'guest',
  kind: 'guest',
  entry: { id: 'guest', kind: 'guest', clearance: { fixed: ['guest'], classifications: ['guest'] } },
};
/**
 * What a configuration declaring the guest issuer deploys: its member classifications, and the two outside
 * ones the guest issuer requires (`guest`, the visitor's, and `customer`, where path B's claim opens its
 * conversation).
 */
const WITH_GUEST = (members: readonly string[]): string[] => [...members, ...OUTSIDE_CLASSIFICATIONS];
const DEPLOYMENT_POOL: DeclaredIssuer = {
  id: 'deployment',
  kind: 'cognito-pool',
  admin: true,
  entry: {
    id: 'deployment',
    kind: 'cognito-pool',
    pool: 'self',
    clearance: { groups: true, classifications: defaultProfileRegistry.memberClassificationValues() },
    admin: true,
  },
};
/**
 * C1-CUSTOM'S OWN SET: two peer classifications, neither a shipped one, each with its own assistant. Each
 * selects its own models from the instance's catalog (`models`), the same models a shipped one selects. The admin
 * plane is added by the app, as in every deployment.
 */
export const CUSTOM_PROFILES: ProfilesConfig = {
  classifications: [
    {
      value: 'legal', profile: 'counsel', grants: ['legal'], displayName: 'Legal', models: { selected: ['haiku', 'sonnet', 'titan', 'gpt_oss_20b', 'deepseek_v3'], default: 'sonnet' },
      topology: {
        timeoutSeconds: 60, memorySize: 512, reservedConcurrency: 10, maxTokens: 4096,
        streaming: false, contextRouting: false, systemPromptParam: false, intentPackParam: true,
        richProcessor: true, handlerExperimentsIndex: false,
      },
    },
    {
      value: 'finance', profile: 'controller', grants: ['finance'], displayName: 'Finance', models: { selected: ['haiku'], default: 'haiku' },
      topology: {
        timeoutSeconds: 30, memorySize: 512, reservedConcurrency: 10, maxTokens: 1024,
        streaming: false, contextRouting: false, systemPromptParam: false, intentPackParam: true,
        richProcessor: false, handlerExperimentsIndex: false,
      },
    },
  ],
  profiles: [
    { name: 'counsel', displayName: 'Counsel', modelKey: 'sonnet', classifierMode: 'llm', timeoutSeconds: 60, contextScope: 'granted', rateLimitPerHour: 60, attachmentsReadable: true },
    { name: 'controller', displayName: 'Controller', modelKey: 'haiku', classifierMode: 'llm', timeoutSeconds: 30, contextScope: 'granted', rateLimitPerHour: 60 },
  ],
  groupClearance: { legal: 'legal', finance: 'finance' },
};

/**
 * This deployment's own pool, under C1-custom's set: its groups clear for whatever they name, with no listed set
 * (`issuerClassificationsOf`), so the entry is the same whichever classifications the deployment declares, and a
 * classification added beside them is reached with no change to it.
 */
const CUSTOM_DEPLOYMENT_POOL: DeclaredIssuer = {
  id: 'deployment',
  kind: 'cognito-pool',
  admin: true,
  entry: {
    id: 'deployment',
    kind: 'cognito-pool',
    pool: 'self',
    clearance: { groups: true },
    admin: true,
  },
};
/**
 * THE CLASSIFICATION A BUILDER ADDS TO C1-CUSTOM, ON ITS OWN: one more peer, with its own assistant, and
 * nothing else in the configuration changed but what declaring it takes (the registry entry and its group; the
 * pool lists no classifications, so its entry does not change). `C1-custom+enterprise` deploys it, and its independence check
 * diffs it against C1-custom in both directions (`describeClassificationIndependence`, `matrix.ts`).
 */
export const ADDED_CLASSIFICATION = 'enterprise';
export const CUSTOM_PROFILES_PLUS_ENTERPRISE: ProfilesConfig = {
  classifications: [
    ...CUSTOM_PROFILES.classifications,
    {
      value: ADDED_CLASSIFICATION, profile: 'steward', grants: [ADDED_CLASSIFICATION], displayName: 'Enterprise', models: { selected: ['haiku'], default: 'haiku' },
      topology: {
        timeoutSeconds: 30, memorySize: 512, reservedConcurrency: 10, maxTokens: 1024,
        streaming: false, contextRouting: false, systemPromptParam: false, intentPackParam: true,
        richProcessor: false, handlerExperimentsIndex: false,
      },
    },
  ],
  profiles: [
    ...CUSTOM_PROFILES.profiles,
    { name: 'steward', displayName: 'Steward', modelKey: 'haiku', classifierMode: 'llm', timeoutSeconds: 30, contextScope: 'granted', rateLimitPerHour: 60 },
  ],
  groupClearance: { ...CUSTOM_PROFILES.groupClearance, [ADDED_CLASSIFICATION]: ADDED_CLASSIFICATION },
};
/**
 * C7-CUSTOM'S OWN SET: C1-custom's two peers with Battle Mode on `legal`, and the shipped outside classifications
 * a guest issuer needs (`guest`, the visitor's, and `customer`, where path B's claim opens its conversation).
 * So the pair below sees what a classification adds where Battle, a guest issuer and a host's one-conversation
 * issuer are declared: Battle's per-classification alts and grants, the guest's upgrade path, and the host's
 * context membership role.
 */
const SHIPPED_OUTSIDE = DEFAULT_PROFILES_CONFIG.classifications.filter((c) => c.audience === 'outside');
const SHIPPED_OUTSIDE_PROFILES = DEFAULT_PROFILES_CONFIG.profiles.filter((p) => SHIPPED_OUTSIDE.some((c) => c.profile === p.name));
export const CUSTOM_BATTLE_PROFILES: ProfilesConfig = {
  classifications: [
    ...CUSTOM_PROFILES.classifications.map((c) => (c.value === 'legal' ? { ...c, battleCapable: true } : c)),
    ...SHIPPED_OUTSIDE,
  ],
  profiles: [...CUSTOM_PROFILES.profiles, ...SHIPPED_OUTSIDE_PROFILES],
  groupClearance: { ...CUSTOM_PROFILES.groupClearance },
};
/** THE BATTLE-CAPABLE MEMBER CLASSIFICATION A BUILDER ADDS TO C7-CUSTOM, on its own. */
export const ADDED_BATTLE_CLASSIFICATION = 'research';
export const CUSTOM_BATTLE_PROFILES_PLUS_RESEARCH: ProfilesConfig = {
  ...CUSTOM_BATTLE_PROFILES,
  classifications: [
    ...CUSTOM_BATTLE_PROFILES.classifications,
    {
      value: ADDED_BATTLE_CLASSIFICATION, profile: 'researcher', grants: [ADDED_BATTLE_CLASSIFICATION], displayName: 'Research', battleCapable: true,
      models: { selected: ['haiku', 'sonnet', 'titan', 'gpt_oss_20b', 'deepseek_v3'], default: 'sonnet' },
      produces: ['document'],
      topology: {
        timeoutSeconds: 60, memorySize: 512, reservedConcurrency: 10, maxTokens: 4096,
        streaming: false, contextRouting: false, systemPromptParam: false, intentPackParam: true,
        richProcessor: true, handlerExperimentsIndex: false,
      },
    },
  ],
  profiles: [
    ...CUSTOM_BATTLE_PROFILES.profiles,
    { name: 'researcher', displayName: 'Researcher', modelKey: 'sonnet', classifierMode: 'llm', timeoutSeconds: 60, contextScope: 'granted', rateLimitPerHour: 60, attachmentsReadable: true },
  ],
  groupClearance: { ...CUSTOM_BATTLE_PROFILES.groupClearance, [ADDED_BATTLE_CLASSIFICATION]: ADDED_BATTLE_CLASSIFICATION },
};
/** A host app's own pool whose people reach one context conversation at `legal` (a `oneChannel` issuer). */
const HOST_CONTEXT_POOL: DeclaredIssuer = {
  id: 'host',
  kind: 'cognito-pool',
  entry: { id: 'host', kind: 'cognito-pool', pool: 'us-east-1_HostApp', clearance: { oneChannel: 'legal', classifications: ['legal'] }, audience: 'host-client', admin: false },
};
const STAFF_POOL: DeclaredIssuer = { id: 'staff-pool', kind: 'cognito-pool', admin: true };
/** A partner's OIDC provider, federated into the deployment's pool: a generic OIDC issuer is never verified directly. */
const PARTNER_OIDC: DeclaredIssuer = { id: 'partner-oidc', kind: 'cognito-federated' };
const HOST_ASSERTION: DeclaredIssuer = { id: 'host-app', kind: 'host-assertion' };
/**
 * C0 + ADMIN'S ADMINISTRATORS: this deployment's own pool, holding its administrators alone. Its clearance reaches
 * the admin plane and no member classification, since the configuration declares none.
 */
const ADMIN_ONLY_POOL: DeclaredIssuer = {
  id: 'deployment',
  kind: 'cognito-pool',
  admin: true,
  entry: { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ['admin'] }, admin: true },
};

/**
 * C6's one vendor (plan 14.3): PagerDuty, subscribing to incident events through its EventBridge partner
 * event source, so `Connectors` builds the receiver and one rule on that partner event bus. Its people are
 * named in the connector's own `Identities` namespace (PagerDuty is no issuer).
 */
export const PAGERDUTY_CONNECTOR: Readonly<Record<string, unknown>> = {
  id: 'pagerduty',
  vendor: 'pagerduty',
  subscribes: ['incident.trigger', 'incident.acknowledge', 'incident.resolve'],
  classification: 'standard',
  eventSource: 'aws.partner/pagerduty.com/example-agent-echelon',
};

/**
 * Cumulative from C0: each configuration adds capabilities to the one before. The two side rows,
 * headless C1 (no first-party client) and C0 + `admin`, are synthesized too.
 */
export const CONFIGURATIONS: readonly Configuration[] = [
  {
    id: 'C0',
    file: 'c0-anonymous-widget.test.ts',
    summary: 'an anonymous visitor in the widget, one assistant, no user pool',
    capabilities: ['widget'],
    issuers: [GUEST],
    profiles: [...OUTSIDE_CLASSIFICATIONS],
    classifications: [...OUTSIDE_CLASSIFICATIONS],
    addedStacks: ['Widget'],
    previous: null,
    greenAt: 'W14',
  },
  {
    id: 'C1',
    file: 'c1-accounts-and-chat.test.ts',
    summary: 'accounts through the deployment pool, and the chat app',
    capabilities: ['widget', 'chat'],
    issuers: [GUEST, DEPLOYMENT_POOL],
    profiles: WITH_GUEST(DEFAULT_CLASSIFICATIONS),
    classifications: WITH_GUEST(DEFAULT_CLASSIFICATIONS),
    addedStacks: ['Widget', 'ChatApp'],
    // NOT DIFFED AGAINST C0: it adds this deployment's pool and the member classifications, and neither is a
    // capability. Both are inputs every stack reads (see "Additivity" in the header), so C1 heads the chain
    // of configurations that add capabilities to one issuer set and one classification set.
    previous: null,
    greenAt: 'W14',
  },
  {
    id: 'C1-headless',
    file: 'c1-headless.test.ts',
    summary: 'accounts with no first-party client: a host app calls PersonApi with its own issuer',
    capabilities: [],
    issuers: [DEPLOYMENT_POOL],
    classifications: DEFAULT_CLASSIFICATIONS,
    addedStacks: [],
    previous: null,
    greenAt: 'W7',
  },
  // THE CORE PLUS ONE LAYER AT A TIME: headless C1 with each component or capability declared on its own, so
  // every layer a deployer may stand up alone is proven to synthesize, and to leave the core as it was
  // outside its attach points.
  {
    id: 'C1-headless+chat',
    file: 'c1-headless-chat.test.ts',
    summary: 'the core and the chat app alone',
    capabilities: ['chat'],
    issuers: [DEPLOYMENT_POOL],
    classifications: DEFAULT_CLASSIFICATIONS,
    addedStacks: ['ChatApp'],
    previous: 'C1-headless',
    greenAt: 'W14',
  },
  {
    id: 'C1-headless+admin',
    file: 'c1-headless-admin.test.ts',
    summary: 'the core and the admin backend and console alone, with no chat app',
    capabilities: ['admin'],
    issuers: [DEPLOYMENT_POOL],
    classifications: DEFAULT_CLASSIFICATIONS,
    addedStacks: ['AdminServices', 'AdminApi', 'AdminApp'],
    previous: 'C1-headless',
    greenAt: 'W14',
  },
  {
    id: 'C1-headless+chat+admin',
    file: 'c1-headless-chat-admin.test.ts',
    summary: 'the core, the chat app, and the admin backend and console',
    capabilities: ['chat', 'admin'],
    issuers: [DEPLOYMENT_POOL],
    classifications: DEFAULT_CLASSIFICATIONS,
    addedStacks: ['ChatApp', 'AdminServices', 'AdminApi', 'AdminApp'],
    previous: 'C1-headless+chat',
    greenAt: 'W14',
  },
  {
    id: 'C1-headless+experiments',
    file: 'c1-headless-experiments.test.ts',
    summary: 'the core and experiments alone, with no client and no admin backend',
    capabilities: ['experiments'],
    issuers: [DEPLOYMENT_POOL],
    classifications: DEFAULT_CLASSIFICATIONS,
    addedStacks: ['Experiments'],
    previous: 'C1-headless',
    greenAt: 'W16',
  },
  {
    id: 'C1-headless+duels',
    file: 'c1-headless-duels.test.ts',
    summary: 'experiments and battle on the core, with the chat app and the admin backend and console',
    capabilities: ['chat', 'admin', 'experiments', 'battle'],
    issuers: [DEPLOYMENT_POOL],
    classifications: DEFAULT_CLASSIFICATIONS,
    addedStacks: ['ChatApp', 'AdminServices', 'AdminApi', 'AdminApp', 'Experiments', 'Battle'],
    previous: 'C1-headless+chat+admin',
    greenAt: 'W16',
  },
  {
    id: 'C-example',
    file: 'c-example.test.ts',
    summary: 'what deploy.config.example.json declares: its capabilities, and its classifications with the premium ops assistant',
    capabilities: ['chat', 'admin', 'notifications', 'experiments', 'battle'],
    issuers: [DEPLOYMENT_POOL],
    profiles: ['basic', 'standard', 'premium', 'ops-premium'],
    classifications: DEFAULT_CLASSIFICATIONS,
    addedStacks: ['ChatApp', 'AdminServices', 'AdminApi', 'AdminApp', 'Notifications', 'Experiments', 'Battle'],
    // NOT DIFFED: it declares the premium ops assistant, which changes Assistants-premium; that is a role, not a capability.
    previous: null,
    greenAt: 'W16',
  },
  {
    id: 'C2',
    file: 'c2-admin.test.ts',
    summary: 'the admin backend and console, and the operations dashboards',
    capabilities: ['widget', 'chat', 'admin', 'operations'],
    issuers: [GUEST, DEPLOYMENT_POOL, STAFF_POOL],
    profiles: WITH_GUEST(DEFAULT_CLASSIFICATIONS),
    classifications: WITH_GUEST(DEFAULT_CLASSIFICATIONS),
    addedStacks: ['Widget', 'ChatApp', 'AdminServices', 'AdminApi', 'AdminApp', 'Operations'],
    previous: 'C1',
    greenAt: 'W14',
  },
  {
    id: 'C3',
    file: 'c3-email.test.ts',
    summary: 'email transport',
    capabilities: ['widget', 'chat', 'admin', 'operations', 'notifications'],
    issuers: [GUEST, DEPLOYMENT_POOL, STAFF_POOL],
    profiles: WITH_GUEST(DEFAULT_CLASSIFICATIONS),
    classifications: WITH_GUEST(DEFAULT_CLASSIFICATIONS),
    addedStacks: ['Widget', 'ChatApp', 'AdminServices', 'AdminApi', 'AdminApp', 'Operations', 'Notifications'],
    previous: 'C2',
    greenAt: 'W14',
  },
  {
    id: 'C5',
    file: 'c5-more-issuers.test.ts',
    summary: 'a partner OIDC provider federated into the pool and a host assertion, with a classification each',
    capabilities: ['widget', 'chat', 'admin', 'operations', 'notifications'],
    issuers: [GUEST, DEPLOYMENT_POOL, STAFF_POOL, PARTNER_OIDC, HOST_ASSERTION],
    profiles: WITH_GUEST(DEFAULT_CLASSIFICATIONS),
    classifications: WITH_GUEST(DEFAULT_CLASSIFICATIONS),
    addedStacks: ['Widget', 'ChatApp', 'AdminServices', 'AdminApi', 'AdminApp', 'Operations', 'Notifications'],
    previous: 'C3',
    greenAt: 'W14',
  },
  {
    id: 'C6',
    file: 'c6-connectors.test.ts',
    summary: 'connectors, with a connector that subscribes to vendor events',
    capabilities: ['widget', 'chat', 'admin', 'operations', 'notifications', 'connectors'],
    issuers: [GUEST, DEPLOYMENT_POOL, STAFF_POOL, PARTNER_OIDC, HOST_ASSERTION],
    profiles: WITH_GUEST(DEFAULT_CLASSIFICATIONS),
    classifications: WITH_GUEST(DEFAULT_CLASSIFICATIONS),
    addedStacks: ['Widget', 'ChatApp', 'AdminServices', 'AdminApi', 'AdminApp', 'Operations', 'Notifications', 'Connectors'],
    previous: 'C5',
    greenAt: 'W15',
    connectors: [PAGERDUTY_CONNECTOR],
  },
  {
    id: 'C7',
    file: 'c7-battle-and-experiments.test.ts',
    summary: 'battle and experiments',
    capabilities: ['widget', 'chat', 'admin', 'operations', 'notifications', 'connectors', 'battle', 'experiments'],
    issuers: [GUEST, DEPLOYMENT_POOL, STAFF_POOL, PARTNER_OIDC, HOST_ASSERTION],
    profiles: WITH_GUEST(DEFAULT_CLASSIFICATIONS),
    classifications: WITH_GUEST(DEFAULT_CLASSIFICATIONS),
    addedStacks: ['Widget', 'ChatApp', 'AdminServices', 'AdminApi', 'AdminApp', 'Operations', 'Notifications', 'Connectors', 'Battle', 'Experiments'],
    previous: 'C6',
    greenAt: 'W16',
    connectors: [PAGERDUTY_CONNECTOR],
  },
  {
    id: 'C1-custom',
    file: 'c1-custom-classifications.test.ts',
    summary: 'a fully custom set of classifications and assistants, none of them shipped, and no guest',
    capabilities: ['chat', 'admin', 'operations'],
    issuers: [CUSTOM_DEPLOYMENT_POOL],
    profiles: CUSTOM_PROFILES,
    classifications: deployedAssistantClassifications(resolveDeploymentProfiles(CUSTOM_PROFILES)),
    addedStacks: ['ChatApp', 'AdminServices', 'AdminApi', 'AdminApp', 'Operations'],
    previous: null,
    greenAt: 'W12',
  },
  {
    id: 'C1-custom+enterprise',
    file: 'c1-custom-plus-enterprise.test.ts',
    summary: 'C1-custom with one more classification, added on its own',
    capabilities: ['chat', 'admin', 'operations'],
    issuers: [CUSTOM_DEPLOYMENT_POOL],
    profiles: CUSTOM_PROFILES_PLUS_ENTERPRISE,
    classifications: deployedAssistantClassifications(resolveDeploymentProfiles(CUSTOM_PROFILES_PLUS_ENTERPRISE)),
    addedStacks: ['ChatApp', 'AdminServices', 'AdminApi', 'AdminApp', 'Operations'],
    // NOT DIFFED BY THE CAPABILITY CHECK: it declares another classification set. Its own check diffs it against
    // C1-custom, the configuration it adds one classification to (`addsClassification`).
    previous: null,
    addsClassification: { to: 'C1-custom', classification: ADDED_CLASSIFICATION },
    greenAt: 'W12',
  },
  {
    id: 'C7-custom',
    file: 'c7-custom-battle.test.ts',
    summary: 'a custom set with Battle Mode, experiments, a guest issuer and a host app\'s one-conversation issuer',
    capabilities: ['widget', 'chat', 'admin', 'operations', 'battle', 'experiments'],
    issuers: [GUEST, CUSTOM_DEPLOYMENT_POOL, HOST_CONTEXT_POOL],
    profiles: CUSTOM_BATTLE_PROFILES,
    classifications: deployedAssistantClassifications(resolveDeploymentProfiles(CUSTOM_BATTLE_PROFILES)),
    addedStacks: ['Widget', 'ChatApp', 'AdminServices', 'AdminApi', 'AdminApp', 'Operations', 'Battle', 'Experiments'],
    previous: null,
    greenAt: 'W16',
  },
  {
    id: 'C7-custom+research',
    file: 'c7-custom-battle-plus-research.test.ts',
    summary: 'C7-custom with one more battle-capable member classification, added on its own',
    capabilities: ['widget', 'chat', 'admin', 'operations', 'battle', 'experiments'],
    issuers: [GUEST, CUSTOM_DEPLOYMENT_POOL, HOST_CONTEXT_POOL],
    profiles: CUSTOM_BATTLE_PROFILES_PLUS_RESEARCH,
    classifications: deployedAssistantClassifications(resolveDeploymentProfiles(CUSTOM_BATTLE_PROFILES_PLUS_RESEARCH)),
    addedStacks: ['Widget', 'ChatApp', 'AdminServices', 'AdminApi', 'AdminApp', 'Operations', 'Battle', 'Experiments'],
    // NOT DIFFED BY THE CAPABILITY CHECK: it declares another classification set. Its own check diffs it against
    // C7-custom, the configuration it adds one classification to (`addsClassification`).
    previous: null,
    addsClassification: { to: 'C7-custom', classification: ADDED_BATTLE_CLASSIFICATION },
    greenAt: 'W16',
  },
  {
    id: 'C0+admin',
    file: 'c0-with-admin.test.ts',
    summary: 'the anonymous widget plus the admin backend and console, with this deployment\'s pool for its administrators',
    capabilities: ['widget', 'admin'],
    // Admin needs an issuer that is not the guest issuer, so this deployment's pool is declared with it, for
    // its administrators alone.
    issuers: [GUEST, ADMIN_ONLY_POOL],
    profiles: [...OUTSIDE_CLASSIFICATIONS],
    classifications: [...OUTSIDE_CLASSIFICATIONS],
    addedStacks: ['Widget', 'AdminServices', 'AdminApi', 'AdminApp'],
    // NOT DIFFED AGAINST C0: it adds an issuer, which every stack reads, as C1 does.
    previous: null,
    greenAt: 'W14',
  },
];

/** The capabilities a configuration declares that the registry refuses as not built, in declaration order. */
export function refusedCapabilities(config: Configuration): string[] {
  return config.capabilities.filter((name) => capabilityDefinition(name)?.notBuilt);
}

/** Configurations the matrix leaves out, each with the reason. */
export const ABSENT_CONFIGURATIONS: readonly { id: string; reason: string }[] = [
  {
    id: 'C4',
    reason: 'meetings: the Meetings stack and the `meetings` capability are built and owned by the meetings line of work, '
      + 'and C4 joins the matrix as one entry here when that capability is in the registry',
  },
];

export function configuration(id: string): Configuration {
  const found = CONFIGURATIONS.find((c) => c.id === id);
  if (!found) throw new Error(`no configuration "${id}" in the deploy matrix`);
  return found;
}

/** The stack names (without the instance prefix, `ImageGuardrail-*` excluded) a configuration must stand up. */
export function expectedStacks(config: Configuration): string[] {
  return [
    ...CORE_STACKS,
    ...config.classifications.map((c) => `Assistants-${c}`),
    ...config.addedStacks,
  ].sort();
}

/** The CDK context a configuration synthesizes with. */
export function contextFor(config: Configuration, mode: AnalyticsMode): Record<string, unknown> {
  const context: Record<string, unknown> = { analyticsMode: mode, capabilities: [...config.capabilities] };
  if (config.profiles !== undefined) context.profiles = Array.isArray(config.profiles) ? [...config.profiles] : config.profiles;
  if (config.connectors) context.connectors = config.connectors.map((c) => ({ ...c }));
  // The registry is the entries the configuration records. An issuer recorded without one (a pool, a provider
  // or a host key the configuration does not hold) is left out of what the app synthesizes, and the rest stand.
  const entries = config.issuers.filter((i) => i.entry).map((i) => i.entry);
  if (entries.length) context.issuers = entries;
  return context;
}
