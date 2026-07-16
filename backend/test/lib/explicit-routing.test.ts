/**
 * Explicit Routing Allowlist Unit Tests
 *
 * Per SPEC-DRIFT-CONVERGENCE.md, detectExplicitRoutingRequest is the
 * ONLY legitimate string-matching path in drift detection. Its allowlist
 * must:
 *   - match unambiguous "switch to a new conversation" intent
 *   - NOT match conversational continuations ("let's talk about X")
 *   - degrade gracefully on short/empty input
 *   - cap haystack length so long messages don't accidentally match
 *     a routing phrase buried in the middle
 *
 * These tests pin the contract that drift detection depends on.
 */

import { detectExplicitRoutingRequest } from '../../lambda/src/lib/explicit-routing';

describe('detectExplicitRoutingRequest', () => {
  describe('matches canonical routing phrases', () => {
    it.each([
      "let's start a new conversation about API design",
      "let's open a new chat about quarterly forecasting",
      "let us begin a new channel about the migration plan",
      "let's create a separate conversation for billing",
      "i'd like to start a new conversation about retros",
      "i want to start a different chat about onboarding",
      "can we start a new conversation about Q3 OKRs",
      "could you open a new conversation about deployment",
      "please start a new conversation about the redesign",
    ])('matches %j', (msg) => {
      const result = detectExplicitRoutingRequest(msg);
      expect(result.matched).toBe(true);
      expect(result.topicHint).toBeDefined();
      expect(result.topicHint!.length).toBeGreaterThan(0);
    });

    it('matches switch/move patterns', () => {
      const cases = [
        "let's switch to a new conversation about retrospectives",
        "let's move to a separate chat about Acme",
        "i want to switch to a separate channel about pricing",
      ];
      for (const msg of cases) {
        expect(detectExplicitRoutingRequest(msg).matched).toBe(true);
      }
    });

    it('matches direct imperative form', () => {
      expect(detectExplicitRoutingRequest('Start a new conversation about API design').matched).toBe(true);
      expect(detectExplicitRoutingRequest('Open a separate channel for billing').matched).toBe(true);
      expect(detectExplicitRoutingRequest('Begin a new chat about deployment').matched).toBe(true);
    });

    it('matches "i need" / "i would like" variants', () => {
      expect(detectExplicitRoutingRequest('I need a new conversation about onboarding').matched).toBe(true);
      expect(detectExplicitRoutingRequest('I would like a separate chat for compliance').matched).toBe(true);
    });

    it('extracts the topic hint correctly', () => {
      const r = detectExplicitRoutingRequest("let's start a new conversation about quarterly forecasting");
      expect(r.matched).toBe(true);
      expect(r.topicHint).toContain('quarterly forecasting');
    });

    it('strips trailing punctuation from the topic hint', () => {
      const r = detectExplicitRoutingRequest("let's start a new conversation about retros.");
      expect(r.topicHint).toBe('retros');
    });

    it('caps the topic hint at 200 chars', () => {
      const veryLongTopic = 'X'.repeat(250);
      const r = detectExplicitRoutingRequest(`let's start a new conversation about ${veryLongTopic}`);
      expect(r.matched).toBe(true);
      expect(r.topicHint!.length).toBeLessThanOrEqual(200);
    });
  });

  describe('does NOT match conversational continuations', () => {
    it.each([
      "let's talk about pricing strategy",
      "tell me more about that",
      "I want to discuss salary expectations",
      "thanks, can you elaborate?",
      "what about the migration plan?",
      "could you explain the architecture",
      "I have a question about API design",
      "let's go deeper on this topic",
      "could you walk me through the deployment",
    ])('does not match %j', (msg) => {
      expect(detectExplicitRoutingRequest(msg).matched).toBe(false);
    });

    it('does not match "let\'s discuss" without explicit new-conversation framing', () => {
      expect(detectExplicitRoutingRequest("let's discuss the new API endpoints").matched).toBe(false);
    });

    it('does not match "switch to" without "new/separate" qualifier', () => {
      expect(detectExplicitRoutingRequest("let's switch to discussing pricing").matched).toBe(false);
    });

    it('does not match "I want to" requests that are not routing', () => {
      expect(detectExplicitRoutingRequest("I want to understand the deployment process").matched).toBe(false);
      expect(detectExplicitRoutingRequest("I want to ship the migration by Friday").matched).toBe(false);
    });
  });

  describe('graceful degradation on short / empty input', () => {
    it.each(['', ' ', '   ', '\n\t', 'hi', 'ok', 'thanks'])(
      'returns matched=false for %j',
      (msg) => {
        expect(detectExplicitRoutingRequest(msg).matched).toBe(false);
      },
    );
  });

  describe('haystack length cap', () => {
    it('caps the scanned message at 500 chars — a routing phrase past the cap does NOT match', () => {
      // 600 chars of filler + the routing phrase at the end
      const filler = 'lorem ipsum '.repeat(60); // ~720 chars
      const message = filler + " let's start a new conversation about X";
      expect(message.length).toBeGreaterThan(500);
      expect(detectExplicitRoutingRequest(message).matched).toBe(false);
    });

    it('a routing phrase at the very start always matches (regardless of trailing length)', () => {
      const message = "let's start a new conversation about X. " + 'lorem ipsum '.repeat(100);
      expect(detectExplicitRoutingRequest(message).matched).toBe(true);
    });
  });

  describe('case + whitespace insensitivity', () => {
    it('matches mixed case (topics ≥2 chars per the .{2,} guard)', () => {
      expect(detectExplicitRoutingRequest("LET'S START A NEW CONVERSATION ABOUT AI").matched).toBe(true);
      expect(detectExplicitRoutingRequest("Let'S StArT a NeW cOnVeRsAtIoN aBoUt AI").matched).toBe(true);
    });

    it('tolerates extra whitespace between words', () => {
      // Within reason — regex uses \s+ in some places.
      // Topic must be ≥2 chars per the .{2,} guard.
      expect(detectExplicitRoutingRequest("let's start  a new  conversation  about  AI").matched).toBe(true);
    });
  });

  describe('topic hint trimming edge cases', () => {
    it('rejects empty-ish topics (just "X")', () => {
      // The regex requires .{2,} so single-char topics still match
      // but topics shorter than 2 chars after trim are rejected
      const r = detectExplicitRoutingRequest("let's start a new conversation about a");
      // 'a' is 1 char, fails the {2,} guard
      expect(r.matched).toBe(false);
    });

    it('accepts 2-char topics', () => {
      const r = detectExplicitRoutingRequest("let's start a new conversation about AI");
      expect(r.matched).toBe(true);
      expect(r.topicHint).toBe('AI');
    });
  });
});
