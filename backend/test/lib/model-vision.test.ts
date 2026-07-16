/**
 * Model vision-capability flag + helper (SPEC-BATTLE.md Phase 3,
 * image vision-in prerequisite).
 *
 * Load-bearing invariants:
 *  - Catalog exhaustiveness: EVERY model declares visionCapable
 *    (it's a required field — adding a model without it fails the
 *    deployable tsc build; this test pins the runtime values).
 *  - Claude family accepts image input; Titan-text / GPT-OSS do not.
 *  - isVisionCapableModel resolves the flag and is safe on unknowns.
 */
import { getModelCatalog } from '../../lib/config/model-strategy';
import { isVisionCapableModel } from '../../lambda/src/lib/model-resolver';

const catalog = getModelCatalog('us-east-1', '123456789012');

describe('catalog visionCapable flag', () => {
  it('every model declares a boolean visionCapable', () => {
    for (const def of Object.values(catalog)) {
      expect(typeof def.visionCapable).toBe('boolean');
    }
  });

  it('Claude models are vision-capable', () => {
    expect(catalog.haiku.visionCapable).toBe(true);
    expect(catalog.sonnet.visionCapable).toBe(true);
    expect(catalog.opus.visionCapable).toBe(true);
  });

  it('Titan-text and GPT-OSS are NOT vision-capable', () => {
    expect(catalog.titan.visionCapable).toBe(false);
    expect(catalog.gpt_oss_20b.visionCapable).toBe(false);
    expect(catalog.gpt_oss_120b.visionCapable).toBe(false);
  });
});

describe('isVisionCapableModel', () => {
  it('mirrors the catalog flag for each key', () => {
    for (const def of Object.values(catalog)) {
      expect(isVisionCapableModel(def.key, catalog)).toBe(def.visionCapable);
    }
  });

  it('returns false (not throw) for an unknown key', () => {
    // Cast (not @ts-expect-error — the project's TS config wouldn't
    // flag it, making the directive "unused"/TS2578). Feeds an invalid
    // key to exercise the runtime guard.
    expect(isVisionCapableModel('not-a-model' as never, catalog)).toBe(false);
  });
});
