/**
 * A TEAM'S EXPERIMENT IS ONE THAT CHANGES ONLY ITS OWN ASSISTANT (SPEC-ADMIN-CONSOLE FR48, FR50).
 *
 * A `profile` experiment whose every variant is a version of the team's assistant, on classifications
 * that assistant serves. A base-model, classifier or intent experiment changes what every assistant of
 * a classification does, so it is never a team's, whatever it names.
 */
import { experimentBelongsTo } from '../lambda/src/lib/experiment-ownership';
import type { Experiment } from '../lambda/src/lib/experiment-manager';

const scope = {
  assistant: 'ops-premium',
  bots: [{ assistant: 'ops-premium', botArn: 'b', name: 'Ops', classification: 'premium', role: 'ops', ownerTeam: 'ops', ownerRecorded: true }],
};
const exp = (over: Partial<Experiment>): Experiment => ({
  experimentId: 'e', status: 'draft', intent: '', tiers: ['premium'], startDate: '', createdAt: '',
  experimentType: 'profile',
  variants: [
    { variantId: 'a', weight: 50, profileRef: { profileName: 'ops-premium', version: 1 } },
    { variantId: 'b', weight: 50, profileRef: { profileName: 'ops-premium', version: 2 } },
  ],
  ...over,
} as Experiment);

describe('whether an experiment is a team\'s', () => {
  it('is, when every variant is its assistant on a classification it serves', () => {
    expect(experimentBelongsTo(exp({}), scope)).toBe(true);
  });

  it.each([
    ['a variant naming another assistant', exp({ variants: [
      { variantId: 'a', weight: 50, profileRef: { profileName: 'ops-premium' } },
      { variantId: 'b', weight: 50, profileRef: { profileName: 'advisor' } },
    ] as Experiment['variants'] })],
    ['a classification the assistant does not serve', exp({ tiers: ['premium', 'standard'] as Experiment['tiers'] })],
    ['a base-model experiment', exp({ experimentType: 'base_model' })],
    ['an intent experiment', exp({ experimentType: 'intent' })],
    ['no variants', exp({ variants: [] })],
    ['a battle-armed experiment, which governs the classification', exp({ battleEnabled: true })],
  ])('is not, for %s', (_l, e) => {
    expect(experimentBelongsTo(e, scope)).toBe(false);
  });
});
