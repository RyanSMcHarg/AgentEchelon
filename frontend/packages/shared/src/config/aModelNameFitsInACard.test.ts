/**
 * A MODEL NAME HAS TO FIT WHERE IT IS RENDERED.
 *
 * The battle path, and any inference-profile-only model, records the full profile ARN rather than a
 * bare model id. A catalog lookup keyed on the bare id misses it, and the honest fallback - render the
 * id you were given - then puts ninety characters into a metric card's subtitle. One model makes the
 * cost card run several lines tall, and a column of cards runs tall with it.
 *
 * The rule is the one the backend already applies in `model-rate-table.ts`: take the segment after
 * `inference-profile/`, pass anything else through untouched. Mirrored rather than reinvented, and
 * these tests pin BOTH halves - that a known model resolves to its friendly name, and that an unknown
 * one still degrades to something honest and short rather than to an ARN.
 */
import { describe, it, expect } from 'vitest';
import { modelDisplayName, MODEL_STRATEGY_MODELS } from './modelStrategy';

const ARN_PREFIX = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/';

describe('an inference-profile ARN resolves to the model it names', () => {
  it('names a catalog model carried as a full ARN', () => {
    // The shape the battle path records. Opus is stored in the catalog WITHOUT a geography prefix,
    // so this also covers the half that needs the prefix stripped before the lookup.
    expect(modelDisplayName(`${ARN_PREFIX}us.anthropic.claude-opus-4-6-v1`)).toBe('Claude Opus 4.6');
  });

  it('names a catalog model stored WITH a geography prefix', () => {
    const haiku = MODEL_STRATEGY_MODELS.find((m) => m.key === 'haiku')!;
    expect(haiku.bedrockModelId).toMatch(/^us\./); // the fixture's premise, pinned
    expect(modelDisplayName(`${ARN_PREFIX}${haiku.bedrockModelId}`)).toBe(haiku.displayName);
  });

  it('still names a bare model id, which is the common case', () => {
    const sonnet = MODEL_STRATEGY_MODELS.find((m) => m.key === 'sonnet')!;
    expect(modelDisplayName(sonnet.bedrockModelId)).toBe(sonnet.displayName);
  });

  it('names an image model, which the text catalog cannot', () => {
    expect(modelDisplayName('stability.stable-image-core-v1:1')).toBe('Stability Image Core (Bedrock)');
  });
});

describe('an unrecognized model degrades to something short and honest', () => {
  it('never renders the ARN it arrived in', () => {
    const out = modelDisplayName(`${ARN_PREFIX}some.unlisted-model-v9`);
    expect(out).toBe('some.unlisted-model-v9');
    expect(out).not.toMatch(/^arn:/);
    expect(out).not.toMatch(/123456789012/); // no account id leaks into the console either
  });

  it('does not invent a name for a model it does not know', () => {
    // Honesty over tidiness: an unknown id renders as itself, never as a plausible-looking label.
    expect(modelDisplayName('totally.unknown')).toBe('totally.unknown');
  });

  it('is empty for an absent id rather than rendering a placeholder', () => {
    expect(modelDisplayName(undefined)).toBe('');
    expect(modelDisplayName(null)).toBe('');
    expect(modelDisplayName('')).toBe('');
  });
});

describe('the output is short enough to sit in a card subtitle', () => {
  it('keeps every resolved name well under the width that made the column run tall', () => {
    const ids = [
      `${ARN_PREFIX}us.anthropic.claude-opus-4-6-v1`,
      `${ARN_PREFIX}us.anthropic.claude-haiku-4-5-20251001-v1:0`,
      `${ARN_PREFIX}some.unlisted-model-v9`,
    ];
    for (const id of ids) {
      expect(id.length).toBeGreaterThan(60); // what the surface was being handed
      expect(modelDisplayName(id).length).toBeLessThan(45);
    }
  });
});
