/**
 * External (non-Bedrock) LLM adapter — pure helpers. The HTTP invoke is integration-tested
 * live (needs a real key); here we pin the message translation + cost math, which are the
 * parts most likely to drift.
 */
import {
  toOpenAiMessages,
  estimateExternalCostUsd,
  externalProviderFromEnv,
} from '../../lambda/src/lib/providers/external-llm';
import { WORK_ITEM_OPENAI_TOOLS, WORK_ITEM_TOOL_NAMES } from '../../lambda/src/lib/async-processor-core';

describe('toOpenAiMessages', () => {
  it('prepends the system prompt and preserves role/content order', () => {
    const out = toOpenAiMessages('SYS', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: '你好' },
    ]);
    expect(out).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: '你好' },
    ]);
  });

  it('omits the system message when the system prompt is empty', () => {
    const out = toOpenAiMessages('', [{ role: 'user', content: 'hi' }]);
    expect(out).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('estimateExternalCostUsd', () => {
  it('computes USD from the per-MTok rate card', () => {
    const cfg = {
      provider: 'deepseek' as const,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKeySecretId: 's',
      usdPerMTokIn: 0.27,
      usdPerMTokOut: 1.1,
    };
    // 1,000,000 in + 1,000,000 out → exactly the two rates summed.
    expect(estimateExternalCostUsd(cfg, 1_000_000, 1_000_000)).toBeCloseTo(0.27 + 1.1, 6);
    expect(estimateExternalCostUsd(cfg, 0, 0)).toBe(0);
  });
});

describe('externalProviderFromEnv', () => {
  const SAVED = { ...process.env };
  afterEach(() => {
    process.env = { ...SAVED };
  });

  it('returns null when the provider is not configured', () => {
    delete process.env.DEEPSEEK_BASE_URL;
    delete process.env.DEEPSEEK_MODEL;
    delete process.env.DEEPSEEK_API_KEY_SECRET;
    expect(externalProviderFromEnv('deepseek')).toBeNull();
  });

  it('builds a config from env with default rates', () => {
    process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
    process.env.DEEPSEEK_MODEL = 'deepseek-chat';
    process.env.DEEPSEEK_API_KEY_SECRET = 'agent-echelon/deepseek-key';
    delete process.env.DEEPSEEK_USD_PER_MTOK_IN;
    const cfg = externalProviderFromEnv('deepseek');
    expect(cfg).toMatchObject({
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKeySecretId: 'agent-echelon/deepseek-key',
    });
    expect(cfg!.usdPerMTokIn).toBeGreaterThan(0);
  });
});

describe('WORK_ITEM_OPENAI_TOOLS', () => {
  it('exposes every work-item tool in OpenAI function format', () => {
    expect(WORK_ITEM_OPENAI_TOOLS).toHaveLength(WORK_ITEM_TOOL_NAMES.size);
    for (const t of WORK_ITEM_OPENAI_TOOLS) {
      expect(t.type).toBe('function');
      expect(WORK_ITEM_TOOL_NAMES.has(t.function.name)).toBe(true);
      expect(t.function.description).toBeTruthy();
      expect(t.function.parameters).toBeTruthy(); // JSON Schema carried straight through
    }
  });
});
