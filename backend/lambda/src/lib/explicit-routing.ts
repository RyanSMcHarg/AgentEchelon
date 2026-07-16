/**
 * Explicit Routing Request Detector
 *
 * Per SPEC-DRIFT-CONVERGENCE.md, this is the **only** legitimate
 * string-matching path in AE's drift detection. It matches unambiguous
 * explicit user intent to start a new conversation — phrases like:
 *
 *   "let's start a new conversation about X"
 *   "switch to a new conversation about X"
 *   "open a separate chat for X"
 *
 * On match, drift detection skips the embedding round-trip and routes
 * immediately with high confidence. This is a UX latency optimization,
 * not a drift signal. It should NOT match phrases like:
 *
 *   "let's talk about X"          (could be on-topic)
 *   "tell me more about X"        (continuation)
 *   "I want to discuss X next"    (within-conversation steering)
 *
 * The allowlist is intentionally narrow. If you find yourself loosening
 * it to catch a case, that case probably belongs in the cosine-similarity
 * path instead.
 */

const EXPLICIT_ROUTING_PATTERNS: ReadonlyArray<RegExp> = [
  // "let's start/open/begin a new/separate/different conversation/chat/channel/thread about/for/on X"
  /\b(?:let'?s|let us|i(?:'?d)? (?:like|want) to|can (?:we|you|i)|could (?:we|you|i)|please)\s+(?:start|open|begin|create|kick off)\s+(?:a\s+)?(?:new|separate|different|another|fresh)\s+(?:conversation|chat|channel|thread|discussion|topic)\s+(?:about|for|on|regarding|to discuss)\s+(.{2,})/i,

  // "switch/move to a new/separate conversation about X"
  /\b(?:let'?s|let us|i(?:'?d)? (?:like|want) to|can (?:we|you|i)|could (?:we|you|i)|please)\s+(?:switch|move|change|jump)\s+(?:to\s+)?(?:a\s+)?(?:new|separate|different|another|fresh)\s+(?:conversation|chat|channel|thread|discussion|topic)\s+(?:about|for|on|regarding|to discuss)\s+(.{2,})/i,

  // Direct request without "let's" — "I want a separate conversation about X"
  /\bi\s+(?:want|need|would like)\s+(?:a\s+)?(?:new|separate|different)\s+(?:conversation|chat|channel|thread)\s+(?:about|for|on|regarding|to discuss)\s+(.{2,})/i,

  // Imperative form — "Start a new conversation about X"
  /^\s*(?:please\s+)?(?:start|open|begin|create)\s+(?:a\s+)?(?:new|separate|different|another)\s+(?:conversation|chat|channel|thread)\s+(?:about|for|on|regarding)\s+(.{2,})/i,
];

export interface ExplicitRoutingMatch {
  matched: boolean;
  /** The text after "about"/"for"/"on" — what the user wants the new conversation to cover. Trimmed; cap of 200 chars. */
  topicHint?: string;
}

/**
 * Detect an unambiguous explicit-routing request in the user's message.
 *
 * Returns `{matched: true, topicHint: '<topic text>'}` if any allowlist
 * pattern matches; `{matched: false}` otherwise.
 *
 * This function is deterministic and pure — no IO, no logging. Suitable
 * for use directly on the drift critical path.
 */
export function detectExplicitRoutingRequest(message: string): ExplicitRoutingMatch {
  if (!message || message.length < 8) {
    return { matched: false };
  }

  // Cap message length we look at — explicit routing phrases are short.
  // A 5000-char message is almost certainly substantive content, not a
  // routing request.
  const haystack = message.slice(0, 500);

  for (const pattern of EXPLICIT_ROUTING_PATTERNS) {
    const m = haystack.match(pattern);
    if (m && m[1]) {
      const topicHint = m[1]
        .trim()
        .replace(/[.!?]+$/, '')
        .slice(0, 200);
      if (topicHint.length >= 2) {
        return { matched: true, topicHint };
      }
    }
  }

  return { matched: false };
}
