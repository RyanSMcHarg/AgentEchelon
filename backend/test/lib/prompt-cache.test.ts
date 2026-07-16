/**
 * Bedrock prompt-caching prefix split (docs/GUIDE-ASSISTANT-CONTEXT.md).
 *
 * The tier processors build a STABLE system-prompt base (persona + standing
 * policy) then append DYNAMIC per-turn context. buildSystemBlocks inserts a
 * Bedrock cachePoint at that boundary so the stable prefix is billed/processed
 * once and reused across tool-loop iterations and turns — but only for
 * supporting models and a prefix that clears the minimum size.
 */
import {
  buildSystemBlocks,
  modelSupportsPromptCaching,
  PROMPT_CACHE_MIN_PREFIX_CHARS,
} from '../../lambda/src/lib/async-processor-core';

// A supporting model (Claude 3.5) and a stable base long enough to cache,
// plus a short dynamic suffix appended per turn.
const SUPPORTED_MODEL = 'anthropic.claude-3-5-sonnet-20241022-v2:0';
const STABLE_PREFIX = 'PERSONA+POLICY '.repeat(400); // ~5600 chars, > min
const DYNAMIC_SUFFIX = '\n\n## EARLIER IN THIS CONVERSATION\n- point';

describe('modelSupportsPromptCaching', () => {
  it('returns true for Claude 3.5 / 4.x families on Bedrock', () => {
    expect(modelSupportsPromptCaching('anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe(true);
    expect(modelSupportsPromptCaching('anthropic.claude-sonnet-4-6')).toBe(true);
    expect(modelSupportsPromptCaching('anthropic.claude-opus-4-6-v1')).toBe(true);
    expect(modelSupportsPromptCaching('us.anthropic.claude-haiku-4-1')).toBe(true);
    expect(modelSupportsPromptCaching('anthropic.claude-sonnet-5-0')).toBe(true);
    expect(modelSupportsPromptCaching('anthropic.claude-fable-5-0')).toBe(true);
  });

  it('returns false for Titan, Claude-3 Haiku, and external LLMs', () => {
    expect(modelSupportsPromptCaching('amazon.titan-text-express-v1')).toBe(false);
    expect(modelSupportsPromptCaching('anthropic.claude-3-haiku-20240307-v1:0')).toBe(false);
    expect(modelSupportsPromptCaching('deepseek.r1-v1:0')).toBe(false);
    expect(modelSupportsPromptCaching('')).toBe(false);
  });
});

describe('buildSystemBlocks', () => {
  it('(a) supported model + long prefix → 3-block array with a cachePoint splitting prefix/suffix', () => {
    const systemPrompt = STABLE_PREFIX + DYNAMIC_SUFFIX;
    const blocks = buildSystemBlocks(systemPrompt, STABLE_PREFIX.length, SUPPORTED_MODEL);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ text: STABLE_PREFIX });
    expect(blocks[1]).toEqual({ cachePoint: { type: 'default' } });
    expect(blocks[2]).toEqual({ text: DYNAMIC_SUFFIX });

    // The cached prefix clears the conservative minimum, and prefix+suffix
    // reconstruct the original prompt exactly (no bytes lost at the split).
    expect(STABLE_PREFIX.length).toBeGreaterThanOrEqual(PROMPT_CACHE_MIN_PREFIX_CHARS);
    expect((blocks[0].text ?? '') + (blocks[2].text ?? '')).toBe(systemPrompt);
  });

  it('(b) prefix shorter than the minimum → single text block (no cachePoint)', () => {
    const shortPrefix = 'short base'; // < PROMPT_CACHE_MIN_PREFIX_CHARS
    const systemPrompt = shortPrefix + DYNAMIC_SUFFIX;
    expect(shortPrefix.length).toBeLessThan(PROMPT_CACHE_MIN_PREFIX_CHARS);

    const blocks = buildSystemBlocks(systemPrompt, shortPrefix.length, SUPPORTED_MODEL);
    expect(blocks).toEqual([{ text: systemPrompt }]);
  });

  it('(c) unsupported model → single text block even with a long prefix', () => {
    const systemPrompt = STABLE_PREFIX + DYNAMIC_SUFFIX;

    for (const model of ['amazon.titan-text-express-v1', 'anthropic.claude-3-haiku-20240307-v1:0']) {
      const blocks = buildSystemBlocks(systemPrompt, STABLE_PREFIX.length, model);
      expect(blocks).toEqual([{ text: systemPrompt }]);
    }
  });

  it('(d) undefined prefix length → single text block', () => {
    const systemPrompt = STABLE_PREFIX + DYNAMIC_SUFFIX;
    const blocks = buildSystemBlocks(systemPrompt, undefined, SUPPORTED_MODEL);
    expect(blocks).toEqual([{ text: systemPrompt }]);
  });

  it('prefix length equal to the whole prompt → single block (nothing left to cache separately)', () => {
    const blocks = buildSystemBlocks(STABLE_PREFIX, STABLE_PREFIX.length, SUPPORTED_MODEL);
    expect(blocks).toEqual([{ text: STABLE_PREFIX }]);
  });
});
