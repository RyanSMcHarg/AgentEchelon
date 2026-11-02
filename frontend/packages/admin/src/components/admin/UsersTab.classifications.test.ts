/**
 * THE USAGE CHIPS COME FROM THE DATA, and are named by the deployment's declared set.
 *
 * The strip rendered a hardcoded `['premium', 'standard', 'basic']`, which failed in both directions
 * at once for a deployment declaring its own classifications: three chips reading zero, and real
 * traffic at every other classification counted and then never shown. It was also an ORDER, and a
 * classification does not have one - it is a declared set of grants (ADR-046), so `legal` sits neither
 * above nor below `finance`.
 *
 * Whatever the rollup contains is what appears, named by the classification's declared display name
 * (`GET /classifications`), and `unknown` (a row with no classification) by the console's own copy.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { classificationChips } from './UsersTab';
import { classificationName, setClassificationsForTest } from '@ae/shared';
import { SAMPLE_CLASSIFICATIONS } from '@ae/shared/config/sampleClassifications.ts';
import en from '@ae/shared/locales/en.json';

/** The resolver the console passes: the declared name, and the locale's copy for the unclassified bucket. */
const label = (value: string): string =>
  value === 'unknown' ? (en as { admin: { users: { classification: { unknown: string } } } }).admin.users.classification.unknown : classificationName(value);

afterEach(() => setClassificationsForTest(null));

describe('classificationChips', () => {
  it('shows a classification this file has never heard of', () => {
    const chips = classificationChips(new Map([['legal', 12], ['finance', 30]]));
    expect(chips.map((c) => c.value)).toEqual(['finance', 'legal']);
    // Unlabeled falls through to the value itself rather than disappearing or reading "undefined".
    expect(chips.map((c) => c.label)).toEqual(['finance', 'legal']);
    expect(chips.map((c) => c.count)).toEqual([30, 12]);
  });

  it('labels the declared classifications and orders by count, not by a ladder', () => {
    setClassificationsForTest(SAMPLE_CLASSIFICATIONS);
    // `basic` is busiest here. A rank order would have put premium first and buried the finding.
    const chips = classificationChips(new Map([['premium', 2], ['basic', 40], ['standard', 9]]), label);
    expect(chips.map((c) => c.label)).toEqual(['Basic', 'Standard', 'Premium']);
  });

  it('labels a custom set by its own display names', () => {
    setClassificationsForTest([{ value: 'legal', displayName: 'Legal team', audience: 'members', badgeToken: 'cls-4', grants: ['legal'], conversational: true }]);
    expect(classificationChips(new Map([['legal', 3]]), label).map((c) => c.label)).toEqual(['Legal team']);
  });

  it('breaks a tie on the value, so the order is stable across renders', () => {
    const chips = classificationChips(new Map([['standard', 5], ['basic', 5], ['premium', 5]]));
    expect(chips.map((c) => c.value)).toEqual(['basic', 'premium', 'standard']);
  });

  it('shows no chips for no data, rather than a row of zeroes', () => {
    expect(classificationChips(new Map())).toEqual([]);
  });

  it('keeps the unclassified bucket visible', () => {
    setClassificationsForTest(SAMPLE_CLASSIFICATIONS);
    // `unknown` is what the rollup writes for a row with no classification. Hiding it would make the
    // per-classification numbers silently fail to add up to the total above them.
    const chips = classificationChips(new Map([['unknown', 3], ['basic', 1]]), label);
    expect(chips.map((c) => c.label)).toEqual(['Unknown', 'Basic']);
  });
});
