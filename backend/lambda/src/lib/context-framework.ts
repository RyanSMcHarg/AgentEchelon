/**
 * Per-turn context framework.
 *
 * A `contextType → resolver` REGISTRY (code-registered in the processor, NOT a runtime plugin) plus a
 * defensive composer that assembles the system prompt EVERY turn — ordered, empty-section-filtered —
 * instead of hardwiring context branches into one function.
 *
 * A host (e.g. a domain-specific deployment) registers its own resolvers (domain grounding, user
 * profile) instead of the platform carrying a hardwired branch; core stays generic. This is a
 * refactor for reuse/testability — context already injects per turn; this makes the assembly a tested
 * seam (see backend/test/lib/context-framework.test.ts).
 */

/** One per-turn context contributor. `render` returns the system-prompt SECTION for this turn — an
 *  empty/whitespace string means "nothing to contribute", and the composer omits it. Resolvers own
 *  their own separators/headers (mirrors the existing AE section formatters). */
export interface ContextResolver<TInput> {
  /** Stable key — registry identity + ordering + (future) telemetry. */
  contextType: string;
  render(input: TInput): string;
}

/**
 * Ordered, code-populated registry of context resolvers. Registration order IS prompt order. Keyed
 * by `contextType`: re-registering the same type REPLACES it in place (so a host can override a
 * resolver) without changing its position.
 */
export class ContextResolverRegistry<TInput> {
  private readonly resolvers = new Map<string, ContextResolver<TInput>>();
  private readonly order: string[] = [];

  register(resolver: ContextResolver<TInput>): this {
    if (!this.resolvers.has(resolver.contextType)) this.order.push(resolver.contextType);
    this.resolvers.set(resolver.contextType, resolver);
    return this;
  }

  /** Registered resolvers in registration (= prompt) order. */
  list(): ContextResolver<TInput>[] {
    return this.order.map((t) => this.resolvers.get(t)!);
  }

  /**
   * Render every resolver for this turn, in order. A resolver that throws is isolated (logged,
   * rendered as '') so one bad host resolver can't break the whole prompt — the defensive contract.
   * Empty sections are kept here and filtered by `buildSystemPrompt`.
   */
  resolveSections(input: TInput): string[] {
    return this.list().map((r) => {
      try {
        return r.render(input);
      } catch (err) {
        console.warn(`[context-framework] resolver '${r.contextType}' threw; omitting its section:`, err);
        return '';
      }
    });
  }
}

/**
 * Defensive system-prompt composer. Assembled EVERY turn: drops
 * empty/whitespace-only sections, then concatenates the persona followed by the surviving sections.
 * AE section formatters each lead with their own spacing/wrapper, so sections are joined as-is —
 * preserving the exact prompt while making the assembly a tested function.
 */
export function buildSystemPrompt(persona: string, sections: Array<string | undefined | null>): string {
  const kept = sections.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
  return [persona, ...kept].join('');
}
