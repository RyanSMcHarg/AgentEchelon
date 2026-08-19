/**
 * findTypeExclusionConflicts — the type-exclusion / classification-slot rule (DESIGN §3.2.1).
 *
 * The DB-backed mutual-exclusion gate that decides whether a new/activating experiment
 * conflicts with one already active on a shared classification. The rule: a conflict fires
 * when EXACTLY ONE side is a `classification`-type experiment (testing the classifier itself)
 * and the two share a targeted classification. Two same-family types (intent + base_model +
 * profile, in any combination) coexist. This suite exercises the full type MATRIX plus single
 * vs MULTIPLE targeted classifications and the active-only status filter — the exact cases the
 * live conflict-resolution UX depends on, previously untested (only its inputs were validated).
 */
import type { QueryCommandOutput } from '@aws-sdk/lib-dynamodb';

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

type Type = 'intent' | 'base_model' | 'classification' | 'profile';
const exp = (experimentId: string, experimentType: Type, tiers: string[], status = 'active') => ({
  experimentId, experimentType, tiers, status,
});

/** Mock the active-experiments scan, then run the gate for a candidate. Returns conflicting ids. */
async function conflicts(
  candidate: { experimentType: Type; tiers: string[]; excludeExperimentId?: string },
  existing: ReturnType<typeof exp>[],
): Promise<string[]> {
  mockSend.mockResolvedValueOnce({ Items: existing } as unknown as QueryCommandOutput);
  const { findTypeExclusionConflicts } = await import('../../lambda/src/lib/experiment-manager');
  // `tiers` are validated Classification strings ('basic'|'standard'|'premium') — cast at the mock boundary.
  const res = await findTypeExclusionConflicts(candidate as Parameters<typeof findTypeExclusionConflicts>[0]);
  return res.map((e) => e.experimentId);
}

describe('findTypeExclusionConflicts — type matrix (classification XOR other)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EXPERIMENTS_TABLE = 'experiments-test';
    jest.resetModules();
  });

  it('classification vs a NON-classification type on a shared classification CONFLICTS', async () => {
    // A classification candidate conflicts with an active intent/base_model/profile experiment.
    for (const otherType of ['intent', 'base_model', 'profile'] as Type[]) {
      expect(
        await conflicts(
          { experimentType: 'classification', tiers: ['premium'], excludeExperimentId: 'self' },
          [exp('other', otherType, ['premium'])],
        ),
      ).toEqual(['other']);
    }
  });

  it('a NON-classification candidate conflicts with an active CLASSIFICATION experiment (symmetric)', async () => {
    for (const candType of ['intent', 'base_model', 'profile'] as Type[]) {
      expect(
        await conflicts(
          { experimentType: candType, tiers: ['premium'], excludeExperimentId: 'self' },
          [exp('cls', 'classification', ['premium'])],
        ),
      ).toEqual(['cls']);
    }
  });

  it('two NON-classification types NEVER conflict (intent/base_model/profile coexist)', async () => {
    const pairs: [Type, Type][] = [
      ['intent', 'base_model'],
      ['intent', 'intent'],
      ['intent', 'profile'],
      ['base_model', 'profile'],
      ['base_model', 'base_model'],
      ['profile', 'profile'],
    ];
    for (const [a, b] of pairs) {
      expect(
        await conflicts(
          { experimentType: a, tiers: ['premium'], excludeExperimentId: 'self' },
          [exp('other', b, ['premium'])],
        ),
      ).toEqual([]);
    }
  });

  it('classification vs classification does NOT conflict (XOR is false when both are classification)', async () => {
    expect(
      await conflicts(
        { experimentType: 'classification', tiers: ['premium'], excludeExperimentId: 'self' },
        [exp('cls2', 'classification', ['premium'])],
      ),
    ).toEqual([]);
  });
});

describe('findTypeExclusionConflicts — single vs multiple classifications (tier overlap)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EXPERIMENTS_TABLE = 'experiments-test';
    jest.resetModules();
  });

  it('no shared classification ⇒ no conflict even across the exclusive types', async () => {
    expect(
      await conflicts(
        { experimentType: 'classification', tiers: ['standard'], excludeExperimentId: 'self' },
        [exp('other', 'intent', ['premium'])],
      ),
    ).toEqual([]);
  });

  it('a MULTI-classification candidate conflicts if ANY targeted classification overlaps', async () => {
    // candidate targets [standard, premium]; the blocker is classification on [premium].
    expect(
      await conflicts(
        { experimentType: 'intent', tiers: ['standard', 'premium'], excludeExperimentId: 'self' },
        [exp('cls', 'classification', ['premium'])],
      ),
    ).toEqual(['cls']);
  });

  it('a single-classification candidate conflicts with a MULTI-classification blocker that includes it', async () => {
    expect(
      await conflicts(
        { experimentType: 'classification', tiers: ['premium'], excludeExperimentId: 'self' },
        [exp('other', 'intent', ['standard', 'premium'])],
      ),
    ).toEqual(['other']);
  });

  it('returns every overlapping blocker (multiple conflicts), skipping non-overlapping ones', async () => {
    const ids = await conflicts(
      { experimentType: 'classification', tiers: ['premium', 'standard'], excludeExperimentId: 'self' },
      [
        exp('a', 'intent', ['premium']),        // conflicts (classification XOR intent, premium overlap)
        exp('b', 'base_model', ['standard']),   // conflicts (standard overlap)
        exp('c', 'profile', ['basic']),         // no overlap → skip
        exp('d', 'classification', ['premium']),// both classification → skip
      ],
    );
    expect(ids.sort()).toEqual(['a', 'b']);
  });
});

describe('findTypeExclusionConflicts — status + self filters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EXPERIMENTS_TABLE = 'experiments-test';
    jest.resetModules();
  });

  it('only ACTIVE experiments conflict (paused/completed/draft are ignored)', async () => {
    for (const status of ['paused', 'completed', 'draft', 'deleted']) {
      expect(
        await conflicts(
          { experimentType: 'classification', tiers: ['premium'], excludeExperimentId: 'self' },
          [exp('other', 'intent', ['premium'], status)],
        ),
      ).toEqual([]);
    }
  });

  it('the candidate never conflicts with itself (excludeExperimentId)', async () => {
    expect(
      await conflicts(
        { experimentType: 'classification', tiers: ['premium'], excludeExperimentId: 'self' },
        [exp('self', 'classification', ['premium'])],
      ),
    ).toEqual([]);
  });
});
