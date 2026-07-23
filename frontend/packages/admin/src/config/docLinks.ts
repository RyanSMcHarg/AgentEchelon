/**
 * Central registry of documentation deep-links surfaced in the admin console.
 *
 * These point at the published documentation on the mcharg.site blog (route
 * `/blog/:slug`). Each entry is a curated post slug — the blog rewrote titles and
 * merged some repo docs, so the mapping is by topic, not a 1:1 of the repo path.
 * Keeping every link here means a future move (e.g. a dedicated docs domain) is a
 * one-file edit.
 */

const DOCS_BASE = 'https://mcharg.site/blog';
// Repo docs that have no curated blog post yet link straight to GitHub (source of truth).
const REPO_BASE = 'https://github.com/RyanSMcHarg/AgentEchelon/blob/main';

export const DOC_LINKS = {
  /** End-to-end message journey (latency steps, delivery). */
  messageFlow: `${DOCS_BASE}/ai-assistant-response-patterns`,
  /** How a reply is delivered (placeholder → update pattern). */
  messageDelivery: `${DOCS_BASE}/ai-assistant-response-patterns`,
  /** Basis for the latency targets shown on the Latency tab. */
  latencyTargets: `${DOCS_BASE}/ai-assistant-latency-testing`,
  /** How to reduce latency (cold starts, RDS Proxy, classifier hop). Repo doc; no blog post yet. */
  performanceOptimization: `${REPO_BASE}/docs/guides/developer/PERFORMANCE-OPTIMIZATION.md`,
  /** Aurora analytics mode: two-pass evaluation + multi-turn scoring. */
  evaluation: `${DOCS_BASE}/ai-assistant-evaluation-implementation`,
  /** Aurora vs Athena analytics capabilities. */
  auroraMode: `${DOCS_BASE}/agentechelon-guide-aurora-mode-guide`,
  /** A/B experiments, model tiering, and Battle mode. */
  abTesting: `${DOCS_BASE}/agentechelon-guide-a-b-testing-and-running-battles`,
  /** Documented model-routing strategy (closest published post: Assistant Configuration). */
  modelStrategy: `${DOCS_BASE}/agentechelon-requirements-assistant-configuration`,
  /** Admin identity, credential planes, membership audit (closest post: Identity and Access). */
  adminIdentity: `${DOCS_BASE}/agentechelon-requirements-identity-and-access`,
} as const;

export type DocLinkKey = keyof typeof DOC_LINKS;
