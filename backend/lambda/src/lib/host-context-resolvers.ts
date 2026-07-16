/**
 * Host per-turn context resolvers.
 *
 * Registers the host's per-turn context contributors with the generic
 * `ContextResolverRegistry` (lib/context-framework.ts): domain grounding (the current plan + its
 * work items, plus other plans/contexts for disambiguation) and the participant profile. Each
 * resolver delegates to the section formatters in async-processor-core, so the rendered prompt is
 * byte-identical to the previous hardwired `systemPrompt += formatX(event)` path. Every resolver
 * no-ops to '' when its fields are absent, so a generic AE turn (no host fields) yields the persona
 * only — no stray sections.
 */

import { ContextResolverRegistry } from './context-framework.js';
import {
  formatDomainContextForPrompt,
  formatUserProfileForPrompt,
} from './async-processor-core.js';

/** The per-turn input the host resolvers read (a superset of AsyncProcessorEvent's grounding fields). */
export interface HostContextInput {
  domainContext?: unknown;
  otherContexts?: unknown;
  userName?: string;
  userLanguage?: string;
  participants?: unknown;
  participantProfile?: string;
}

/**
 * Build the ordered registry of host context resolvers. Registration order IS prompt order:
 * domain grounding first (primary grounding + work-item edit affordance), then the participant
 * profile. A host can override either by re-registering the same `contextType`.
 */
export function createHostContextRegistry(): ContextResolverRegistry<HostContextInput> {
  return new ContextResolverRegistry<HostContextInput>()
    .register({
      contextType: 'domain-grounding',
      render: (input) => formatDomainContextForPrompt(input),
    })
    .register({
      contextType: 'participant-profile',
      render: (input) => formatUserProfileForPrompt(input),
    });
}
