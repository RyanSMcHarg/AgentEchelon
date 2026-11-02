/**
 * WHAT A STATEMENT'S CONDITION LETS IT REACH, BY THE RESOURCE'S `classification` TAG.
 *
 * Two shapes are legitimate, and a test that reads either must read both:
 *
 *  - a per-classification role names its own values: `StringEquals` on the tag (`{ any: false, values }`);
 *  - a shared role reaches every classification without naming one: `Null` false on the tag, so the resource
 *    must carry a classification, optionally less the admin plane by `StringNotEquals`
 *    (`{ any: true, except }`). An untagged resource matches neither.
 *
 * `null` is a statement with no classification condition at all.
 */
export const CLASSIFICATION_KEY = 'aws:ResourceTag/classification';

export type ClassificationReach = { any: true; except: string[] } | { any: false; values: string[] };

const asList = (v: unknown): string[] => (v === undefined ? [] : ([] as unknown[]).concat(v).map(String));

export function classificationReachOf(condition: unknown): ClassificationReach | null {
  const c = (condition ?? {}) as Record<string, Record<string, unknown> | undefined>;
  if (c.Null?.[CLASSIFICATION_KEY] === 'false') return { any: true, except: asList(c.StringNotEquals?.[CLASSIFICATION_KEY]) };
  const values = asList(c.StringEquals?.[CLASSIFICATION_KEY]);
  return values.length ? { any: false, values } : null;
}

/** True when `reach` admits a resource tagged `value`. */
export function reaches(reach: ClassificationReach | null, value: string): boolean {
  if (!reach) return false;
  return reach.any ? !reach.except.includes(value) : reach.values.includes(value);
}
