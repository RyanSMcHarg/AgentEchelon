/**
 * AN EXPERIMENT IS CREATED IN ONE CALL, A BATTLE INCLUDED (§3.7): the server derives both duel sides'
 * pinned versions when it arms the battle, so the console sends the experiment as set and derives nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Experiment } from '@ae/shared';
import { createOrArmExperiment, type ArmDeps } from './battleArm';

const deps = (): ArmDeps => ({ createExperiment: vi.fn(async (e) => e as Experiment) });

const variantsFor = (type: string) => (type === 'profile'
  ? [
    { variantId: 'control', profileRef: { profileName: 'advisor', version: 3 }, weight: 50 },
    { variantId: 'treatment', profileRef: { profileName: 'advisor', version: 4 }, weight: 50 },
  ]
  : [
    { variantId: 'control', modelKey: type === 'classification' ? 'haiku' : 'sonnet', weight: 50 },
    { variantId: 'treatment', modelKey: type === 'classification' ? 'titan' : 'opus', weight: 50, systemPromptAddendum: 'be terse' },
  ]);

const experiment = (experimentType: string, battle: boolean): Omit<Experiment, 'createdAt'> => ({
  experimentId: 'exp-1', status: 'active', experimentType, intent: experimentType === 'intent' ? 'general' : '', tiers: ['premium'],
  startDate: '2026-10-12', variants: variantsFor(experimentType),
  ...(battle ? { battleEnabled: true, challengerAssistant: 'alt-primary-premium' } : {}),
} as Omit<Experiment, 'createdAt'>);

describe('createOrArmExperiment', () => {
  for (const type of ['intent', 'base_model', 'classification', 'profile']) {
    for (const battle of [false, true]) {
      it(`${type}${battle ? ', battle' : ''}: one create call carrying the experiment exactly as set, with no pin`, async () => {
        const d = deps();
        const payload = experiment(type, battle);
        await createOrArmExperiment(payload, d);
        expect(d.createExperiment).toHaveBeenCalledTimes(1);
        const sent = (d.createExperiment as ReturnType<typeof vi.fn>).mock.calls[0][0] as Experiment;
        expect(sent).toEqual(payload);
        for (const v of sent.variants) {
          expect(v).not.toHaveProperty('altPin');
          expect(v).not.toHaveProperty('controlPin');
        }
      });
    }
  }
});
