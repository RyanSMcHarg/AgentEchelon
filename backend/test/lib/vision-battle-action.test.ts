/**
 * Phase-3 vision-in decision helper (SPEC-BATTLE.md §"Image Battles —
 * Vision-In"). Pins the per-turn branching so the in-flight async path
 * just switches on the result:
 *   - no image            → 'text'
 *   - image + vision model → 'vision'
 *   - image + text-only    → 'reject-text-only' (+ actionable message)
 */
import { getModelCatalog } from '../../lib/config/model-strategy';
import {
  resolveVisionBattleAction,
  visionRejectMessage,
} from '../../lambda/src/lib/model-resolver';

const catalog = getModelCatalog('us-east-1', '123456789012');

describe('resolveVisionBattleAction', () => {
  it("no image attachment → 'text' regardless of model", () => {
    for (const def of Object.values(catalog)) {
      expect(resolveVisionBattleAction(def.key, catalog, false)).toBe('text');
    }
  });

  it("image + vision-capable model (Claude) → 'vision'", () => {
    expect(resolveVisionBattleAction('haiku', catalog, true)).toBe('vision');
    expect(resolveVisionBattleAction('sonnet', catalog, true)).toBe('vision');
    expect(resolveVisionBattleAction('opus', catalog, true)).toBe('vision');
  });

  it("image + text-only model → 'reject-text-only'", () => {
    expect(resolveVisionBattleAction('titan', catalog, true)).toBe('reject-text-only');
    expect(resolveVisionBattleAction('gpt_oss_20b', catalog, true)).toBe('reject-text-only');
    expect(resolveVisionBattleAction('gpt_oss_120b', catalog, true)).toBe('reject-text-only');
  });

  it('decision matches the catalog visionCapable flag exactly (with an image)', () => {
    for (const def of Object.values(catalog)) {
      const expected = def.visionCapable ? 'vision' : 'reject-text-only';
      expect(resolveVisionBattleAction(def.key, catalog, true)).toBe(expected);
    }
  });
});

describe('visionRejectMessage', () => {
  it('is actionable: names the model and tells the user what to do', () => {
    const msg = visionRejectMessage('amazon.titan-text-premier-v1:0');
    expect(msg).toContain('amazon.titan-text-premier-v1:0');
    expect(msg).toMatch(/vision-capable/i);
    expect(msg).toMatch(/text-only prompt|Claude/i);
  });
});
