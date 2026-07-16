/**
 * Experiment Manager — Experiment Type + Objective Validation (Phase 0)
 *
 * These cover the PURE validation
 * surface only (no DynamoDB): the experimentType discriminator default +
 * shape rules, and the advisory objective's metric/target/type pairing.
 * The DB-backed mutual-exclusion rule (findTypeExclusionConflicts) is
 * exercised in the broader suite (see the test-update task).
 */

// Mock the AWS SDK — only available at Lambda runtime.
const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  ScanCommand: jest.fn(),
  PutCommand: jest.fn(),
  UpdateCommand: jest.fn(),
  GetCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(),
}), { virtual: true });

import {
  validateAndSanitizeExperiment,
  validateObjective,
  ExperimentValidationError,
  EXPERIMENT_TYPES,
  type Experiment,
} from '../../lambda/src/lib/experiment-manager';

const base: Experiment = {
  experimentId: 'exp-test',
  status: 'active',
  intent: 'general_qa',
  tiers: ['standard'],
  variants: [
    { variantId: 'control', modelKey: 'sonnet', weight: 50 },
    { variantId: 'treatment', modelKey: 'opus', weight: 50 },
  ],
  startDate: '2026-06-19T00:00:00Z',
  createdAt: '2026-06-19T00:00:00Z',
};

describe('experimentType validation', () => {
  it('defaults absent experimentType to "intent"', () => {
    const out = validateAndSanitizeExperiment({ ...base });
    expect(out.experimentType).toBe('intent');
  });

  it('preserves each canonical type', () => {
    for (const t of EXPERIMENT_TYPES) {
      // base_model/classification do not need an intent
      const intent = t === 'intent' ? 'general_qa' : '';
      const out = validateAndSanitizeExperiment({ ...base, experimentType: t, intent });
      expect(out.experimentType).toBe(t);
    }
  });

  it('rejects an unknown experimentType', () => {
    expect(() =>
      validateAndSanitizeExperiment({ ...base, experimentType: 'bogus' as never }),
    ).toThrow(ExperimentValidationError);
  });

  it('requires a non-empty intent for an intent experiment', () => {
    expect(() =>
      validateAndSanitizeExperiment({ ...base, experimentType: 'intent', intent: '   ' }),
    ).toThrow(/intent experiments require a non-empty intent/);
  });

  it('does not require an intent for base_model / classification', () => {
    expect(() =>
      validateAndSanitizeExperiment({ ...base, experimentType: 'base_model', intent: '' }),
    ).not.toThrow();
    expect(() =>
      validateAndSanitizeExperiment({ ...base, experimentType: 'classification', intent: '' }),
    ).not.toThrow();
  });
});

describe('validateObjective', () => {
  it('returns undefined for an absent objective', () => {
    expect(validateObjective(undefined, 'intent')).toBeUndefined();
  });

  it('accepts a valid cost objective for any type', () => {
    expect(validateObjective({ metric: 'cost', target: 20 }, 'base_model')).toEqual({ metric: 'cost', target: 20 });
  });

  it('rejects an out-of-range target', () => {
    expect(() => validateObjective({ metric: 'latency', target: 150 }, 'intent')).toThrow(/\[0, 100\]/);
    expect(() => validateObjective({ metric: 'latency', target: -1 }, 'intent')).toThrow(ExperimentValidationError);
  });

  it('rejects an unknown metric', () => {
    expect(() => validateObjective({ metric: 'speed' as never, target: 10 }, 'intent')).toThrow(/objective.metric/);
  });

  it("allows 'accuracy' only for classification", () => {
    expect(validateObjective({ metric: 'accuracy', target: 90 }, 'classification')).toEqual({ metric: 'accuracy', target: 90 });
    expect(() => validateObjective({ metric: 'accuracy', target: 90 }, 'intent')).toThrow(/accuracy/);
  });

  it("disallows 'quality' for classification", () => {
    expect(() => validateObjective({ metric: 'quality', target: 80 }, 'classification')).toThrow(/quality/);
    expect(validateObjective({ metric: 'quality', target: 80 }, 'intent')).toEqual({ metric: 'quality', target: 80 });
  });

  it('threads the objective through validateAndSanitizeExperiment', () => {
    const out = validateAndSanitizeExperiment({ ...base, objective: { metric: 'cost', target: 15 } });
    expect(out.objective).toEqual({ metric: 'cost', target: 15 });
  });
});
