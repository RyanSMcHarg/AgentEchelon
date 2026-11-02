/**
 * THE CAPABILITY REGISTRY: what a deployment may declare in `capabilities`, and what each one stands up.
 *
 * A deployment is the required core (the stacks every deployment has, and one `Assistants-<classification>`
 * stack per classification the profile registry declares) plus the capabilities `deploy.config.json`
 * names. `bin/backend.ts` creates exactly that: a capability that is not declared leaves no stack
 * behind, and every consumer in the core learns at synth whether a capability is present, from a value
 * bin passes it, never from a parameter it finds missing at runtime.
 *
 * Each entry carries:
 *  - `requires`: the capabilities it cannot run without. Synth refuses a declaration missing one.
 *  - `stacks`: the stacks it stands up, without the instance prefix. Bin checks the factory builds
 *    exactly these.
 *  - `attaches`: the stacks outside its own that change when it is declared, and how. These are its
 *    attach points; nothing else changes.
 *  - `stage`: every capability is `surface`, built after the core (the assistant stacks and the channel
 *    flow included) and wired to it: a capability attaches its own grants and resources to the core, and
 *    the core is told only the fixed names of what it uses (`CAPABILITY_RESOURCES`), so declaring one
 *    changes a core stack's environment and nothing else (STACKS.md, additivity).
 *  - `build`: the stack factory, or `notBuilt`: the reason synth refuses the capability, for one
 *    whose stacks do not exist yet.
 *
 * Adding a capability is one entry here and its own stack file.
 *
 * The stack classes are loaded inside each factory rather than at the top, so a reader of the registry's
 * data (the deploy matrix, the API reference, `deploy.mjs`'s tests) does not load every stack module.
 */
import type * as cdk from 'aws-cdk-lib';
import type { MessagingStack } from '../stacks/messaging-stack';
import type { IdentityStack } from '../stacks/identity-stack';
import type { ConversationsStack } from '../stacks/conversations-stack';
import type { ArchiveStackAurora } from '../stacks/archive-stack-aurora';
import type { IArchiveStackOutputs } from '../interfaces/archive-stack-interface';
import type { AssistantsStack } from '../stacks/assistant-profile-stack';
import type { ChannelFlowStack } from '../stacks/channel-flow-stack';

/** The core stacks a capability's factory may wire to. */
export interface CoreStacks {
  messaging: MessagingStack;
  identity: IdentityStack;
  conversations: ConversationsStack;
  archive: IArchiveStackOutputs & cdk.Stack;
  /** The Archive stack, in Aurora mode only. */
  aurora?: ArchiveStackAurora;
}

/** Deployment settings a capability's factory reads, resolved once from the context by bin. */
export interface DeploymentSettings {
  appUrl: string;
  senderEmail: string;
  senderEmailPreVerified: boolean;
  enableManagedWaf: boolean;
  wafRateLimit?: number;
  wafAllowedIps: string[];
  /**
   * Whether this deployment's own pool is a trusted issuer, which the email bridge resolves a
   * recipient's contact through. False, the Notifications stack carries no bridge.
   */
  notifyBridge: boolean;
  /** The other pools the trusted-issuer registry declares, for a recipient of another issuer. */
  notifyAdditionalUserPoolIds: string[];
  /** The group that marks an admin of this deployment's own pool (the registry's `adminGroups`), or undefined for `admins`. */
  adminGroupName?: string;
  /**
   * The sample host page's origin, from the opt-in `WidgetHost` stack, when the guest issuer lists
   * `"widget-host"` (`WIDGET_HOST_ORIGIN`, lib/config/issuers.ts); the widget names it in `frame-ancestors`.
   */
  widgetHostOrigin?: string;
}

export interface CapabilityBuildContext {
  app: cdk.App;
  env: cdk.Environment;
  /** The instance's stack-name prefix (`STACK_PREFIX`). */
  prefix: string;
  declared: DeclaredCapabilities;
  /** The classifications this deployment creates an `Assistants-*` stack for. */
  classifications: readonly string[];
  settings: DeploymentSettings;
  core: CoreStacks;
  /** The assistant stacks. */
  assistants: readonly AssistantsStack[];
  /** The channel flow. */
  channelFlow: ChannelFlowStack;
  /** The capability stacks built so far, by name without the prefix. */
  stacks: ReadonlyMap<string, cdk.Stack>;
}

export type CapabilityStage = 'surface';

export interface CapabilityDefinition {
  name: string;
  summary: string;
  requires: readonly string[];
  stacks: readonly string[];
  attaches: readonly { stack: string; change: string }[];
  stage: CapabilityStage;
  build?: (ctx: CapabilityBuildContext) => cdk.Stack[];
  /** Set for a capability whose stacks are not built: synth refuses it with this reason. */
  notBuilt?: string;
}

/** A built capability stack, read by the core that is wired to it. Throws when it was not built. */
function builtStack<T extends cdk.Stack>(ctx: CapabilityBuildContext, name: string): T {
  const stack = ctx.stacks.get(name);
  if (!stack) throw new Error(`capability stack ${name} is not built; the capability that stands it up must be declared and built first`);
  return stack as T;
}

export const CAPABILITIES: readonly CapabilityDefinition[] = [
  {
    name: 'experiments',
    summary: 'A/B experiments and alternate assistants. Their admin routes join AdminServices when admin is declared',
    requires: [],
    stacks: ['Experiments'],
    attaches: [
      { stack: 'Assistants-*', change: 'EXPERIMENTS_TABLE in the environment of the processor and the router, and the grants on the table on their roles (`attachExperiments`)' },
      { stack: 'Assistants-*', change: 'the read of its stacks\' alarms, its own policy on the acting role of a classification with an observability role (`capabilityAlarmNamePrefixes`)' },
      { stack: 'ChannelFlow', change: 'EXPERIMENTS_TABLE, for a duel\'s per-variant image models; the grant on its role is this stack\'s' },
      { stack: 'AdminServices', change: 'the experiment administration handlers, on the experiments table, when admin is declared' },
      { stack: 'AdminApi', change: 'the experiment administration routes, when admin is declared' },
    ],
    stage: 'surface',
    build: (ctx) => {
      const { ExperimentsStack } = require('../stacks/experiments-stack') as typeof import('../stacks/experiments-stack');
      const stack = new ExperimentsStack(ctx.app, `${ctx.prefix}Experiments`, {
        env: ctx.env,
        channelFlowRole: ctx.channelFlow.processorRole,
        description: 'A/B experiments table, the grant on it of the channel flow, and its shared SSM contract',
      });
      // ON THE ONE CORE ROLE IT ATTACHES TO, the channel flow's. Each classification's stack grants its own roles.
      stack.addDependency(ctx.channelFlow);
      return [stack];
    },
  },
  {
    name: 'battle',
    summary: 'Battles: the /battle orchestrator, its tables and the channel-battle routes',
    // A duel is armed by an experiment, and the battle handlers read the experiments table.
    requires: ['experiments'],
    stacks: ['Battle'],
    attaches: [
      { stack: 'Assistants-*', change: 'the battle tables and the orchestrator in the environment, and the grants on them and each alt, on battle-capable classifications (`attachBattle`)' },
      { stack: 'Assistants-*', change: 'the read of its stacks\' alarms, its own policy on the acting role of a classification with an observability role (`capabilityAlarmNamePrefixes`)' },
      { stack: 'ChannelFlow', change: 'the battle tables in the environment, which the flow reads as battle being declared (`battleDeclared`); the grants on its role, the tables and the operator\'s battle setting, are this stack\'s' },
      { stack: 'AdminServices', change: 'the analytics battle-wins join (Aurora mode), when admin is declared' },
      { stack: 'PersonApi', change: 'the channel-battle and battle-outcome routes' },
      { stack: 'Identity', change: 'offboarding\'s erasure of the person named on a conversation\'s battle setting: the table\'s parameter in its environment and the read of it on its role; the grant on the table is this stack\'s' },
    ],
    stage: 'surface',
    build: (ctx) => {
      const { BattleStack } = require('../stacks/battle-stack') as typeof import('../stacks/battle-stack');
      const { core } = ctx;
      const stack = new BattleStack(ctx.app, `${ctx.prefix}Battle`, {
        env: ctx.env,
        appInstanceArn: core.messaging.appInstanceArn,
        selfPoolId: core.identity.selfPoolId,
        appUrl: ctx.settings.appUrl,
        channelFlowRole: ctx.channelFlow.processorRole,
        offboardingRoleArn: core.identity.offboardingRoleArn,
        description: 'AgentEchelon /battle — orchestrator + tables + the channel-battle routes',
      });
      stack.addDependency(core.messaging);
      stack.addDependency(core.identity); // the trusted-issuer registry its handlers read the caller through
      stack.addDependency(builtStack(ctx, 'Experiments')); // its handlers read the experiments table
      // ON THE ONE CORE ROLE IT ATTACHES TO, the channel flow's. Each battle-capable classification's stack
      // builds its alt and grants its own roles (`attachBattle`).
      stack.addDependency(ctx.channelFlow);
      return [stack];
    },
  },
  {
    name: 'chat',
    summary: 'The chat web app hosting (S3 and CloudFront)',
    requires: [],
    stacks: ['ChatApp'],
    attaches: [{ stack: 'Assistants-*', change: 'the read of its stacks\' alarms, its own policy on the acting role of a classification with an observability role (`capabilityAlarmNamePrefixes`)' }],
    stage: 'surface',
    build: (ctx) => {
      const { FrontendStack } = require('../stacks/frontend-stack') as typeof import('../stacks/frontend-stack');
      const { INVITATION_LANDING_DOCUMENT, invitationLandingPolicy } = require('../stacks/widget-stack') as typeof import('../stacks/widget-stack');
      return [new FrontendStack(ctx.app, `${ctx.prefix}ChatApp`, {
        env: ctx.env,
        enableManagedWaf: ctx.settings.enableManagedWaf,
        wafRateLimit: ctx.settings.wafRateLimit,
        wafAllowedIps: ctx.settings.wafAllowedIps,
        // EVERY INVITATION LANDS IN THE CHAT APP (`invitationLandingFor`): it serves the landing page, never framed.
        tokenDocuments: [{ path: INVITATION_LANDING_DOCUMENT, contentSecurityPolicy: invitationLandingPolicy() }],
        description: 'CloudFront + S3 hosting for the AgentEchelon chat app',
      })];
    },
  },
  {
    name: 'admin',
    summary: 'The admin backend (AdminServices: every admin handler, the admin credential exchange, the admin notification channel; AdminApi: every admin route) and the admin console hosting',
    requires: [],
    stacks: ['AdminServices', 'AdminApi', 'AdminApp'],
    // The admin backend sits on the core and takes what it needs by reference; a core alert is an
    // `ae.alert` event, and the rule that posts it into the admin channel is AdminServices' own. The one
    // core change is the admin console's app client, on this deployment's pool, whose tokens are an
    // audience both APIs' edge authorizers check.
    attaches: [
      { stack: 'Identity', change: 'the admin console app client, on this deployment\'s own pool' },
      { stack: 'Identity', change: 'the admin subject provisioner, when the registry declares a provisioned-only issuer' },
      { stack: 'PersonApi', change: 'the admin console app client as an audience of the edge authorizer' },
      { stack: 'Assistants-*', change: 'the read of its stacks\' alarms, its own policy on the acting role of a classification with an observability role (`capabilityAlarmNamePrefixes`)' },
    ],
    stage: 'surface',
    build: (ctx) => {
      const { AdminServicesStack } = require('../stacks/admin-services-stack') as typeof import('../stacks/admin-services-stack');
      const { AdminApiStack } = require('../stacks/admin-api-stack') as typeof import('../stacks/admin-api-stack');
      const { FrontendStack } = require('../stacks/frontend-stack') as typeof import('../stacks/frontend-stack');
      const { core } = ctx;
      const experiments = ctx.stacks.get('Experiments') as import('../stacks/experiments-stack').ExperimentsStack | undefined;
      const battle = ctx.stacks.get('Battle');
      const services = new AdminServicesStack(ctx.app, `${ctx.prefix}AdminServices`, {
        env: ctx.env,
        appInstanceArn: core.messaging.appInstanceArn,
        appInstanceAdminArn: core.messaging.appInstanceAdminArn,
        userPool: core.identity.userPool,
        selfPoolId: core.identity.selfPoolId,
        conversationManagementFunction: core.conversations.conversationManagementFunction,
        invitationsFunction: core.conversations.invitationsFunction,
        guestUpgradeFunction: core.conversations.guestUpgradeFunction,
        identitiesTable: core.identity.identitiesTable,
        accessLogTable: core.identity.accessLogTable,
        offboardingFunction: core.identity.offboardingFunction,
        subjectProvisioner: core.identity.subjectProvisioners.admin,
        attachmentsBucketArn: core.conversations.attachmentsBucket.bucketArn,
        feedbackTable: { tableName: core.conversations.feedbackTable.tableName, tableArn: core.conversations.feedbackTable.tableArn },
        archiveBucketArn: core.archive.archiveBucketArn,
        aurora: core.aurora,
        experimentsTable: experiments?.experimentsTable,
        battle: Boolean(battle),
        adminGroupName: ctx.settings.adminGroupName,
        description: 'AgentEchelon admin backend: every admin handler, the admin credential exchange and the admin notification channel',
      });
      // Messaging holds the provisioner, which the admin assistant's seed and the console's create and retire ask.
      services.addDependency(core.messaging);
      services.addDependency(core.identity);
      // The conversation-management function the console's archive route reaches.
      services.addDependency(core.conversations);
      services.addDependency(core.archive);
      // NOT AFTER THE ASSISTANT STACKS: the admin task route finds each classification's task service by name
      // at call time, so no deploy-time value comes from them and a classification deploys on its own.
      // The analytics battle-wins join resolves the BattleOutcome table name from the battle contract at deploy.
      if (battle) services.addDependency(battle);
      if (experiments) services.addDependency(experiments);

      // Every admin route, on one HTTP API, and the console roles' grants on them.
      const adminApi = new AdminApiStack(ctx.app, `${ctx.prefix}AdminApi`, {
        env: ctx.env,
        routes: services.routes,
        consoleRoles: services.consoleRoles,
        appInstanceArn: core.messaging.appInstanceArn,
        selfPoolId: core.identity.selfPoolId,
        selfClientIds: core.identity.selfClientIds,
        identities: core.identity.identitiesTable,
        description: 'AgentEchelon admin API: every admin route, behind IAM',
      });
      adminApi.addDependency(services);
      adminApi.addDependency(core.identity);

      // The admin console hosting, its own origin. 'Admin'-prefixed outputs so they do not collide with
      // the chat app's.
      const adminApp = new FrontendStack(ctx.app, `${ctx.prefix}AdminApp`, {
        env: ctx.env,
        enableManagedWaf: ctx.settings.enableManagedWaf,
        wafRateLimit: ctx.settings.wafRateLimit,
        wafAllowedIps: ctx.settings.wafAllowedIps,
        outputPrefix: 'Admin',
        description: 'CloudFront + S3 hosting for the AgentEchelon admin console',
      });
      // The admin interface sits on the admin backend: the console is built from its outputs.
      adminApp.addDependency(services);
      adminApp.addDependency(adminApi);
      return [services, adminApi, adminApp];
    },
  },
  {
    name: 'notifications',
    summary: 'Email: the SES identity, conversation sharing, the proactive briefing, the email bridge, the archival alarm, the email preference page and, with `replyDomain`, replies by email',
    requires: [],
    stacks: ['Notifications'],
    attaches: [
      { stack: 'Conversations', change: 'TRANSACTIONAL_MAIL_FUNCTION in the environment of the invitation and guest-upgrade functions; the invoke grant on their roles is this stack\'s' },
      { stack: 'PersonApi', change: 'the share route, and the email preference page' },
      { stack: 'Assistants-*', change: 'the read of its stacks\' alarms, its own policy on the acting role of a classification with an observability role (`capabilityAlarmNamePrefixes`)' },
      { stack: 'Identity', change: 'the email reply poster role on the one-conversation role, when replyDomain is set' },
    ],
    stage: 'surface',
    build: (ctx) => {
      const { NotificationStack } = require('../stacks/notification-stack') as typeof import('../stacks/notification-stack');
      const { core } = ctx;
      const stack = new NotificationStack(ctx.app, `${ctx.prefix}Notifications`, {
        env: ctx.env,
        appInstanceArn: core.messaging.appInstanceArn,
        userPoolId: core.identity.selfPoolId,
        classifications: ctx.classifications,
        senderEmail: ctx.settings.senderEmail,
        senderEmailPreVerified: ctx.settings.senderEmailPreVerified,
        appUrl: ctx.settings.appUrl,
        messageStream: core.messaging.messageStream,
        notifyBridge: ctx.settings.notifyBridge,
        notifyAdditionalUserPoolIds: ctx.settings.notifyAdditionalUserPoolIds,
        tokens: core.conversations.tokensTable,
        mailSenders: [core.conversations.invitationsFunction, core.conversations.guestUpgradeFunction].filter((fn): fn is NonNullable<typeof fn> => Boolean(fn)),
        replyPoster: core.identity.replyPoster,
        templateBucket: { bucketName: core.conversations.attachmentsBucket.bucketName, bucketArn: core.conversations.attachmentsBucket.bucketArn },
        description: 'Email: conversation sharing, the proactive briefing and the email bridge on the message stream',
      });
      stack.addDependency(core.messaging);
      stack.addDependency(core.identity);
      // The shared channel-context table parameters, read at deploy for the share's membership check.
      stack.addDependency(core.conversations);
      // NOT AFTER THE ASSISTANT STACKS: the share and the briefing find each classification's router by name
      // at call time, so no deploy-time value comes from them and a classification deploys on its own.
      return [stack];
    },
  },
  {
    name: 'widget',
    summary: 'The embeddable assistant widget hosting',
    requires: [],
    stacks: ['Widget'],
    attaches: [{ stack: 'PersonApi', change: 'the widget\'s own origin (`widgetUrl`) in CORS' }, { stack: 'Assistants-*', change: 'the read of its stacks\' alarms, its own policy on the acting role of a classification with an observability role (`capabilityAlarmNamePrefixes`)' }],
    stage: 'surface',
    build: (ctx) => {
      const { WidgetStack } = require('../stacks/widget-stack') as typeof import('../stacks/widget-stack');
      // The frame calls the person API and the Amazon Chime SDK from the browser; the stack itself holds
      // only the hosting, so it depends on nothing in the core.
      return [new WidgetStack(ctx.app, `${ctx.prefix}Widget`, {
        env: ctx.env,
        enableManagedWaf: ctx.settings.enableManagedWaf,
        wafRateLimit: ctx.settings.wafRateLimit,
        wafAllowedIps: ctx.settings.wafAllowedIps,
        widgetHostOrigin: ctx.settings.widgetHostOrigin,
        description: 'CloudFront + S3 hosting for the AgentEchelon embeddable widget, framed only by the declared hosts',
      })];
    },
  },
  {
    name: 'connectors',
    summary: 'The connector runtime (the declared connectors in `connectors`): an EventBridge rule per connector that subscribes to vendor events, on its partner event bus, and the per-person grants',
    requires: [],
    stacks: ['Connectors'],
    attaches: [
      { stack: 'Identity', change: 'the connector grant revoker\'s name on offboarding, when a connector takes per-person grants' },
      { stack: 'Identity', change: 'the connector subject provisioner, when a subscribing connector names a provisioned-only personIssuer' },
      { stack: 'PersonApi', change: 'a person\'s own grant routes, when a connector takes per-person grants' },
      { stack: 'Assistants-*', change: 'the read of its stacks\' alarms, its own policy on the acting role of a classification with an observability role (`capabilityAlarmNamePrefixes`)' },
    ],
    stage: 'surface',
    build: (ctx) => {
      const { ConnectorsStack } = require('../stacks/connectors-stack') as typeof import('../stacks/connectors-stack');
      const { core } = ctx;
      const connectors = new ConnectorsStack(ctx.app, `${ctx.prefix}Connectors`, {
        env: ctx.env,
        appInstanceArn: core.messaging.appInstanceArn,
        selfPoolId: core.identity.selfPoolId,
        identities: { tableName: core.identity.identitiesTable.tableName, tableArn: core.identity.identitiesTable.tableArn },
        offboardingRoleArn: core.identity.offboardingRoleArn,
        subjectProvisioner: core.identity.subjectProvisioners.connectors,
        description: 'AgentEchelon connectors: the vendor event rules and receiver, the per-person grants and their revoker',
      });
      connectors.addDependency(core.messaging);
      connectors.addDependency(core.identity);
      return [connectors];
    },
  },
  {
    name: 'operations',
    summary: 'The deployment-wide dashboard. Each stack keeps its own alarms, so this adds a view and no signal',
    requires: [],
    stacks: ['Operations'],
    attaches: [{ stack: 'Assistants-*', change: 'the read of its stacks\' alarms, its own policy on the acting role of a classification with an observability role (`capabilityAlarmNamePrefixes`)' }],
    stage: 'surface',
    build: (ctx) => {
      const { OperationsStack } = require('../stacks/operations-stack') as typeof import('../stacks/operations-stack');
      const { core } = ctx;
      const stack = new OperationsStack(ctx.app, `${ctx.prefix}Operations`, {
        env: ctx.env,
        messageStream: core.messaging.messageStream,
        description: 'AgentEchelon deployment-wide operations dashboard',
      });
      stack.addDependency(core.messaging);
      return [stack];
    },
  },
  {
    name: 'meetings',
    summary: 'Meetings as conversation state',
    requires: ['chat'],
    stacks: ['Meetings'],
    attaches: [],
    stage: 'surface',
    notBuilt: 'the Meetings stack is not in this code base yet: it lands with the meetings work as its own stack file and this entry, so meetings cannot be declared yet',
  },
];

/** The registry entry for a capability name, or undefined for a name it does not know. */
export function capabilityDefinition(name: string): CapabilityDefinition | undefined {
  return CAPABILITIES.find((c) => c.name === name);
}

/**
 * The `capabilities` context value as a list of names. `deploy.mjs` forwards the `deploy.config.json`
 * array as a comma-separated string; `cdk.json` or a test passes the array itself; a JSON array string is
 * accepted too. Absent or empty is the empty list: the required core alone.
 */
export function parseCapabilities(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  const text = String(raw).trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error(`capabilities: ${text} is not a list of capability names`);
    return parsed.map((s) => String(s).trim()).filter(Boolean);
  }
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

export interface DeclaredCapabilities {
  /** The declared names, deduplicated, in registry order. */
  readonly names: readonly string[];
  has(name: string): boolean;
}

/** Every reason a declared list cannot be synthesized, one line each. Empty when it can. */
export function capabilityErrors(names: readonly string[]): string[] {
  const errors: string[] = [];
  const declared = new Set(names);
  for (const name of declared) {
    const def = capabilityDefinition(name);
    if (!def) {
      errors.push(`"${name}" is not a capability; the registry (lib/config/capabilities.ts) declares ${CAPABILITIES.map((c) => c.name).join(', ')}`);
      continue;
    }
    if (def.notBuilt) errors.push(`"${name}" cannot be declared: ${def.notBuilt}`);
    const missing = def.requires.filter((r) => !declared.has(r));
    if (missing.length) errors.push(`"${name}" requires ${missing.map((m) => `"${m}"`).join(' and ')}, which ${missing.length > 1 ? 'are' : 'is'} not declared`);
  }
  return errors;
}

/** The declared capabilities, refused at synth when any name is unknown, not built, or missing a prerequisite. */
export function resolveCapabilities(raw: unknown): DeclaredCapabilities {
  const names = parseCapabilities(raw);
  const errors = capabilityErrors(names);
  if (errors.length) throw new Error(`capabilities cannot be synthesized:\n  ${errors.join('\n  ')}`);
  const declared = new Set(names);
  const ordered = CAPABILITIES.map((c) => c.name).filter((n) => declared.has(n));
  return { names: ordered, has: (name) => declared.has(name) };
}

/**
 * Build every declared capability of one stage, in registry order, adding each stack to `built`.
 * Refuses a factory that builds a different set of stacks than its entry declares, so the registry's
 * `stacks` is what a declaration stands up.
 */
export function buildCapabilities(stage: CapabilityStage, ctx: Omit<CapabilityBuildContext, 'stacks'>, built: Map<string, cdk.Stack>): void {
  for (const def of CAPABILITIES) {
    if (def.stage !== stage || !ctx.declared.has(def.name)) continue;
    if (!def.build) throw new Error(`capability "${def.name}" has no stack factory`);
    const stacks = def.build({ ...ctx, stacks: built });
    const names = stacks.map((s) => s.node.id.slice(ctx.prefix.length));
    if (def.stacks.some((s) => !names.includes(s)) || names.some((n) => !def.stacks.includes(n))) {
      throw new Error(`capability "${def.name}" built ${names.join(', ')}, and its registry entry declares ${def.stacks.join(', ')}`);
    }
    stacks.forEach((s, i) => built.set(names[i], s));
  }
}
