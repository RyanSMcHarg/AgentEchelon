import { describe, it, expect } from 'vitest';
import { shortenModelId } from './modelLabel';

describe('shortenModelId', () => {
  it('returns null for undefined/null/empty', () => {
    expect(shortenModelId(undefined)).toBeNull();
    expect(shortenModelId(null)).toBeNull();
    expect(shortenModelId('')).toBeNull();
  });

  it('maps Anthropic models', () => {
    expect(shortenModelId('anthropic.claude-opus-4-6-v1')).toBe('Opus');
    expect(shortenModelId('anthropic.claude-sonnet-4-6')).toBe('Sonnet');
    expect(shortenModelId('anthropic.claude-3-haiku-20240307-v1:0')).toBe('Haiku');
  });

  it('maps Amazon Titan', () => {
    expect(shortenModelId('amazon.titan-text-premier-v1:0')).toBe('Titan');
  });

  it('maps GPT-OSS variants', () => {
    expect(shortenModelId('openai.gpt-oss-120b')).toBe('GPT-OSS');
    expect(shortenModelId('openai.gpt-oss-20b')).toBe('GPT-OSS');
  });

  it('is case-insensitive', () => {
    expect(shortenModelId('ANTHROPIC.CLAUDE-OPUS')).toBe('Opus');
    expect(shortenModelId('Amazon.TITAN-TEXT')).toBe('Titan');
  });

  it('falls back to last segment capitalized for unknown models', () => {
    expect(shortenModelId('meta.llama-3-70b')).toBe('70b');
    expect(shortenModelId('custom-model')).toBe('Model');
  });
});
