/**
 * Central registry of documentation deep-links surfaced in the admin console.
 *
 * EVERY LINK POINTS AT THE REPO, and that is the rule rather than a stopgap.
 *
 * Four of these used to point at blog posts on mcharg.site, and all four were dead. The failure was
 * silent in a way worth recording: that site is a client-rendered SPA with a catch-all route, so a
 * slug that does not exist returns HTTP 200 with the site's generic title. Nothing an automated
 * checker looks at goes red. The only reliable discriminator is that a real post prerenders its OWN
 * title, which is how the four were finally confirmed dead against a known-good slug and a
 * deliberately bogus one.
 *
 * So a link from this console lives where its target is versioned with the code it describes. The
 * docs in this repo are published on the public GitHub repo, they move when the behavior they
 * describe moves, and a wrong path is a plain 404 that anybody can see. A separately published
 * article cannot make either promise: it was accurate when written, and this registry has no way to
 * find out when it stops being.
 *
 * ADDING ONE: point at a path under `docs/` in this repo, and check it resolves at
 * `https://github.com/RyanSMcHarg/AgentEchelon/blob/main/<path>` before shipping. A `blob` URL for a
 * path that does not exist returns a real 404, so the check is worth something here.
 */

/** The public repo. Keeping the base here means a move (a docs domain, a rename) is a one-file edit. */
const REPO_BASE = 'https://github.com/RyanSMcHarg/AgentEchelon/blob/main';

export const DOC_LINKS = {
  /** End-to-end message journey: the legs a turn passes through and where the time goes. */
  messageFlowGuide: `${REPO_BASE}/docs/guides/developer/MESSAGE-FLOW.md`,
  /** How a reply is delivered (the placeholder-then-update pattern). */
  messageDelivery: `${REPO_BASE}/docs/guides/developer/MESSAGE-DELIVERY-GUIDE.md`,
  /** Basis for the latency targets shown on the Latency tab. */
  latencyTargets: `${REPO_BASE}/docs/guides/developer/LATENCY-TARGETS.md`,
  /** How to reduce latency (cold starts, RDS Proxy, classifier hop). */
  performanceOptimization: `${REPO_BASE}/docs/guides/developer/PERFORMANCE-OPTIMIZATION.md`,
  /** How quality is judged: the passes, what each column means, and where a NULL comes from. */
  evaluation: `${REPO_BASE}/docs/guides/admin/ADMIN-GUIDE.md`,
  /** What evaluation is for, who reads it, and the two kinds of correctness evaluation. */
  evaluationSpec: `${REPO_BASE}/docs/specs/interaction/quality/SPEC-EVALUATION.md`,
  /** The evaluation mechanics: the passes, the rubrics, the selection, and the flows. */
  evaluationDesign: `${REPO_BASE}/docs/specs/interaction/quality/DESIGN-EVALUATION.md`,
  /** The Effectiveness surface: every column, the worst-first ranking, and the population each rate is over. */
  effectiveness: `${REPO_BASE}/docs/specs/interface/SPEC-ADMIN-CONSOLE-EFFECTIVENESS.md`,
  /** The console's surfaces: what each tab answers and which reading it is built from. */
  adminConsole: `${REPO_BASE}/docs/specs/interface/SPEC-ADMIN-CONSOLE.md`,
  /** Experiments end to end: variants, guardrails, power, and how a recommendation is reached. */
  experimentDecisionLoop: `${REPO_BASE}/docs/specs/interaction/quality/DESIGN-EXPERIMENTS-BATTLE-DECISION-LOOP.md`,
  /** Drift detection: when a split is offered, and what each outcome means. */
  driftConvergence: `${REPO_BASE}/docs/specs/interaction/assistants/SPEC-DRIFT-CONVERGENCE.md`,
  /** Moderation: redaction, deletion, and the membership a moderator acts through. */
  moderation: `${REPO_BASE}/docs/specs/interaction/governance/SPEC-MODERATION.md`,
  /** Client telemetry: which events and web vitals the browser emits, and where they land. */
  frontendObservability: `${REPO_BASE}/docs/specs/interface/SPEC-FRONTEND-OBSERVABILITY.md`,
  /** Aurora vs Athena analytics capabilities. */
  auroraMode: `${REPO_BASE}/docs/guides/admin/AURORA-MODE-GUIDE.md`,
  /** A/B experiments, model tiering, and Battle mode. */
  abTesting: `${REPO_BASE}/docs/guides/admin/GUIDE-AB-TESTING-AND-BATTLES.md`,
  /** Documented model-routing strategy. */
  modelStrategy: `${REPO_BASE}/docs/guides/developer/MODEL_STRATEGY.md`,
  /** Admin identity, credential planes, membership audit. */
  adminIdentity: `${REPO_BASE}/docs/specs/interaction/governance/IDENTITY-AND-ACCESS-MODEL.md`,
  /** Adding a classification or a role, and managing a profile: the steps that need a deploy. */
  profileGuide: `${REPO_BASE}/docs/guides/developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md`,
  /** What a role is, what it reaches, and how a deployment adds one. */
  roleDesign: `${REPO_BASE}/docs/specs/interaction/assistants/DESIGN-ADDING-AN-ASSISTANT-ROLE.md`,
  /** The intent pack: what an assistant recognizes and the behavior each intent carries. */
  intentPack: `${REPO_BASE}/docs/specs/interaction/assistants/SPEC-CONFIGURABLE-INTENT-PACK.md`,
  /** The task lifecycle: the platform's default machines and how a task moves between states. */
  taskStates: `${REPO_BASE}/docs/specs/interaction/conversation/SPEC-TASK-STATE-TRANSITIONS.md`,
  /** The turn queue: one turn at a time per conversation, and what a person sees while they wait. */
  turnQueue: `${REPO_BASE}/docs/specs/interaction/conversation/SPEC-TURN-QUEUE.md`,
  /** Where the queue's work happens: triage, clearing the queue, and targeted requests. */
  queueProcessing: `${REPO_BASE}/docs/specs/interaction/conversation/DESIGN-TASK-ACCESS-AND-QUEUE-PROCESSING.md`,
  /** A person's profile, onboarding and reply preferences. */
  userProfile: `${REPO_BASE}/docs/specs/interaction/conversation/SPEC-USER-PROFILE-AND-ONBOARDING.md`,
} as const;

export type DocLinkKey = keyof typeof DOC_LINKS;

/**
 * A section of a registered doc, by its heading's GitHub anchor. Kept apart from the registry so the
 * registry test resolves every entry to a file on disk.
 */
export const DOC_SECTIONS = {
  addClassification: `${DOC_LINKS.profileGuide}#5-adding-a-classification`,
  addRole: `${DOC_LINKS.profileGuide}#5b-adding-a-role`,
  removeClassification: `${DOC_LINKS.profileGuide}#5c-removing-a-classification`,
  manageProfile: `${DOC_LINKS.profileGuide}#6-managing-an-existing-profile`,
  portability: `${DOC_LINKS.profileGuide}#213-portability-export-import-manifest-contracts`,
  liveVersusDeploy: `${DOC_LINKS.profileGuide}#live-versus-deploy`,
  seedFields: `${DOC_LINKS.profileGuide}#23-profile-seed-fields-assistantprofile`,
  topology: `${DOC_LINKS.profileGuide}#24-stack-topology-assistanttopology`,
  modelsSection: `${DOC_LINKS.profileGuide}#62-change-the-model`,
  personaOrPack: `${DOC_LINKS.profileGuide}#63-change-the-persona-or-intent-pack`,
  changeGuardrail: `${DOC_LINKS.profileGuide}#64-change-the-guardrail`,
  retrievalScope: `${DOC_LINKS.profileGuide}#65-change-context-retrieval-scope`,
  sizing: `${DOC_LINKS.profileGuide}#66-change-sizing-or-a-capability`,
  globalWorkflows: `${DOC_LINKS.profileGuide}#29-global-workflows`,
  messageTemplates: `${DOC_LINKS.profileGuide}#210-message-templates`,
  variables: `${DOC_LINKS.profileGuide}#variables-and-conditions`,
  goldenSet: `${DOC_LINKS.profileGuide}#the-golden-set-a-draft-is-measured-on`,
  documentTemplates: `${DOC_LINKS.profileGuide}#document-templates`,
  deliveryChecks: `${DOC_LINKS.profileGuide}#211-what-the-runtime-checks-before-it-delivers`,
  contextSources: `${DOC_LINKS.profileGuide}#33-context-sources-the-catalog`,
  welcomeOrientation: `${DOC_LINKS.profileGuide}#36-welcome-orientation`,
  onboarding: `${DOC_LINKS.profileGuide}#4-how-onboarding-is-customized`,
  queueTriage: `${DOC_LINKS.queueProcessing}#23-what-the-triage-turn-is-told-and-what-it-may-do`,
  queueClearing: `${DOC_LINKS.queueProcessing}#26-clearing-the-queue-step-by-step`,
} as const;
