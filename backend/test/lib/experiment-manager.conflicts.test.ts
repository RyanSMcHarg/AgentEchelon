/**
 * findClassificationConflicts - one live experiment per classification (DESIGN §3.2.1).
 *
 * The DB-backed gate that decides whether a new or activating experiment conflicts with one
 * already live on a shared classification. Any two live experiments that share a classification
 * conflict, whatever their types: the resolver measures only one, so a second was accepted and
 * then received no traffic. The suite covers the full type matrix, single vs
 * MULTIPLE targeted classifications, and the active-only status filter - the cases the live
 * conflict-resolution UX depends on.
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
  const { findClassificationConflicts } = await import('../../lambda/src/lib/experiment-manager');
  // `tiers` are validated Classification strings ('basic'|'standard'|'premium') — cast at the mock boundary.
  const { experimentType: _ignored, ...args } = candidate;
  const res = await findClassificationConflicts(args as Parameters<typeof findClassificationConflicts>[0]);
  return res.map((e) => e.experimentId);
}

describe('findClassificationConflicts — type matrix (every pair conflicts)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EXPERIMENTS_TABLE = 'experiments-test';
    jest.resetModules();
  });

  const TYPES: Type[] = ['intent', 'base_model', 'classification', 'profile'];

  it('ANY two types on a shared classification conflict, including two of the same type', async () => {
    for (const a of TYPES) {
      for (const b of TYPES) {
        expect(
          await conflicts(
            { experimentType: a, tiers: ['premium'], excludeExperimentId: 'self' },
            [exp('other', b, ['premium'])],
          ),
        ).toEqual(['other']);
      }
    }
  });

  it('two base_model experiments conflict - the pair that starved one silently on the deployment', async () => {
    expect(
      await conflicts(
        { experimentType: 'base_model', tiers: ['premium'], excludeExperimentId: 'new' },
        [exp('stale', 'base_model', ['premium'])],
      ),
    ).toEqual(['stale']);
  });
});

describe('findClassificationConflicts — single vs multiple classifications (tier overlap)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.EXPERIMENTS_TABLE = 'experiments-test';
    jest.resetModules();
  });

  it('no shared classification ⇒ no conflict, whatever the types', async () => {
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
        exp('a', 'intent', ['premium']),        // conflicts (premium overlap)
        exp('b', 'base_model', ['standard']),   // conflicts (standard overlap)
        exp('c', 'profile', ['basic']),         // no overlap → skip
        exp('d', 'classification', ['premium']),// conflicts (premium overlap, same type)
      ],
    );
    expect(ids.sort()).toEqual(['a', 'b', 'd']);
  });
});

describe('findClassificationConflicts — status + self filters', () => {
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
