/**
 * The frontend model-strategy MIRROR must match the backend model CATALOG.
 *
 * THE DEFECT THIS EXISTS FOR. The catalog is defined once in the backend
 * (`lib/config/model-strategy.ts`) and mirrored for the admin console in
 * `frontend/packages/shared/src/config/modelStrategy.ts`. Nothing held the two together, and they
 * drifted: `deepseek_v3` shipped in the backend catalog - allowed on standard and premium, and the
 * model behind CN geography routing (SPEC-CONTEXT-AWARE-MODEL-ROUTING) - while the mirror still listed
 * six keys. The admin Experiments form built its model dropdown from a THIRD hardcoded copy of that
 * same list, so an operator could not select DeepSeek for an experiment at all.
 *
 * It failed in the direction that never raises an error: a missing entry does not break a form, it
 * just silently omits an option, so "you can A/B any model in the catalog" quietly stopped being true.
 *
 * The mirror is READ AS TEXT rather than imported. The two live in different packages with different
 * module resolution and build setups, and a cross-package import here would couple this suite to the
 * frontend's toolchain for no gain - the assertion is about a KEY SET, which is extractable from the
 * source. Same approach the docs drift guard already uses.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getModelCatalog } from '../../lib/config/model-strategy';

const MIRROR = path.join(
  __dirname, '..', '..', '..',
  'frontend', 'packages', 'shared', 'src', 'config', 'modelStrategy.ts',
);

/** Every `key: '<value>',` in the mirror's card list. */
function mirrorKeys(src: string): string[] {
  return [...src.matchAll(/^\s{4}key:\s*'([a-z0-9_]+)'/gm)].map((m) => m[1]).sort();
}

/** The `ModelStrategyKey` union members, which must agree with the cards. */
function mirrorUnionKeys(src: string): string[] {
  const decl = src.match(/export type ModelStrategyKey =([\s\S]*?);/);
  if (!decl) return [];
  return [...decl[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).sort();
}

describe('the admin model mirror tracks the backend catalog', () => {
  const src = fs.readFileSync(MIRROR, 'utf8');
  const backendKeys = Object.keys(getModelCatalog('us-east-1', '111122223333')).sort();

  it('reads a mirror with a non-trivial number of cards (the guard is wired to a real file)', () => {
    expect(mirrorKeys(src).length).toBeGreaterThanOrEqual(5);
  });

  it('exposes exactly the backend catalog keys — no missing model, no invented one', () => {
    expect(mirrorKeys(src)).toEqual(backendKeys);
  });

  it('keeps the ModelStrategyKey union in step with its own cards', () => {
    // A card added without widening the union (or the reverse) type-errors in the frontend but only
    // when that package is built; catching it here fails the backend suite too, which runs on every PR.
    expect(mirrorUnionKeys(src)).toEqual(mirrorKeys(src));
  });

  /** The mirror's card body for one key, or '' when there is none. */
  const cardFor = (key: string): string =>
    src.match(new RegExp(`key: '${key}',[\\s\\S]{0,1500}?\\n  \\}`, 'm'))?.[0] ?? '';

  it('agrees with the backend on displayName and bedrockModelId for every model', () => {
    // The dropdown LABEL comes from the mirror's displayName, so a mismatch mislabels a real model in
    // the console - worse than omitting it, because it reads as correct. Compared as whole maps so a
    // failure names the offending key instead of just the first mismatching string.
    const catalog = getModelCatalog('us-east-1', '111122223333') as Record<string, {
      displayName: string; bedrockModelId: string;
    }>;
    const expected: Record<string, string> = {};
    const actual: Record<string, string> = {};
    for (const key of backendKeys) {
      const card = cardFor(key);
      expected[key] = `${catalog[key].displayName} | ${catalog[key].bedrockModelId}`;
      actual[key] = `${card.match(/displayName: '([^']*)'/)?.[1] ?? 'NO CARD'} `
        + `| ${card.match(/bedrockModelId: '([^']*)'/)?.[1] ?? 'NO CARD'}`;
    }
    expect(actual).toEqual(expected);
  });

  it('agrees with the backend on which classifications may use each model', () => {
    // allowedTiers drives what the console offers per classification; a mirror that over-permits lets an
    // operator build an experiment the backend will refuse to resolve (resolveVariantForProfile enforces
    // the real ceiling), which surfaces as an experiment that silently serves nothing.
    const catalog = getModelCatalog('us-east-1', '111122223333') as Record<string, {
      allowedClassifications: string[];
    }>;
    const expected: Record<string, string> = {};
    const actual: Record<string, string> = {};
    for (const key of backendKeys) {
      expected[key] = [...catalog[key].allowedClassifications].sort().join(',');
      actual[key] = [...(cardFor(key).match(/allowedTiers: \[([^\]]*)\]/)?.[1] ?? '')
        .matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort().join(',');
    }
    expect(actual).toEqual(expected);
  });
});
