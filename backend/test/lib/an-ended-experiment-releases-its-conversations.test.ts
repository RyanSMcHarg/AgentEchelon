/**
 * AN ENDED EXPERIMENT NEVER KEEPS A CONVERSATION ON A VERSION (ADR-050 as amended).
 *
 * Only an ACTIVE experiment holds an enrolled conversation to its arm. Completed (whatever the decision),
 * deleted, past its end date or paused: the conversation is served the live assistant's active version from
 * its next turn, with no experiment attribution, so its later turns count toward nothing. A resume enrolls
 * only conversations created after it. A duel on an experiment that is no longer active ends rather than
 * letting the treatment answer.
 */
const mockSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  ScanCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: 'scan', input })),
  PutCommand: jest.fn(),
  UpdateCommand: jest.fn(),
  GetCommand: jest.fn().mockImplementation((input: unknown) => ({ kind: 'get', input })),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });

const mockLookupVersion = jest.fn();
jest.mock('../../lambda/src/lib/profile-version-lookup', () => ({
  lookupProfileVersion: (...a: unknown[]) => mockLookupVersion(...a),
  lookupProfileVersionModelKey: jest.fn(),
  concreteProfileVersion: jest.fn(async (_s: unknown, _r: unknown, ref: { version?: number }) => ref.version ?? 5),
}));

const mockGetContext = jest.fn();
jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  getChannelContext: (...a: unknown[]) => mockGetContext(...a),
  putChannelContext: jest.fn().mockResolvedValue(true),
}));

const mockChallenger = jest.fn();
jest.mock('../../lambda/src/lib/alt-assignment', () => ({
  ...jest.requireActual('../../lambda/src/lib/alt-assignment'),
  duelChallengerOf: (...a: unknown[]) => mockChallenger(...a),
}));

import { getModelCatalog } from '../../lib/config/model-strategy';
import type { Experiment } from '../../lambda/src/lib/experiment-manager';

const catalog = getModelCatalog('us-east-1', '123456789012');
const CHAN = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';
const ENROLLMENT = {
  experimentId: 'exp', variantId: 'treatment',
  profileRef: { profileName: 'alt-primary-premium', version: 4 },
  enrolledAt: '2026-10-12T10:30:00.000Z',
};

/** A base-model experiment armed at 10:00, two pinned versions, with a battle on the alt. */
const exp = (over: Partial<Experiment> = {}): Experiment => ({
  experimentId: 'exp', status: 'active', experimentType: 'base_model', intent: '', tiers: ['premium'],
  startDate: '2026-10-12T00:00:00.000Z', createdAt: '2026-10-12T09:00:00.000Z', servesVersions: true,
  battleEnabled: true, challengerAssistant: 'alt-primary-premium',
  variants: [
    { variantId: 'control', weight: 50, controlPin: { profileName: 'advisor', version: 3 } },
    { variantId: 'treatment', weight: 50, altPin: { profileName: 'alt-primary-premium', version: 4 } },
  ],
  transitions: [{ from: 'draft', to: 'active', by: 'a', at: '2026-10-12T10:00:00.000Z' }],
  ...over,
} as Experiment);

/** The experiments table holds `row`: its Get and its active-only Scan both answer from it. */
function table(row: Experiment | null) {
  mockSend.mockImplementation(async (cmd: { kind: string }) => {
    if (cmd.kind === 'get') return { Item: row ?? undefined };
    if (cmd.kind === 'scan') return { Items: row && row.status === 'active' ? [row] : [] };
    return {};
  });
}

const ended = (to: Experiment['status'], extra: Partial<Experiment> = {}) => exp({
  status: to,
  transitions: [
    { from: 'draft', to: 'active', by: 'a', at: '2026-10-12T10:00:00.000Z' },
    { from: 'active', to, by: 'a', at: '2026-10-12T11:00:00.000Z' },
  ],
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.EXPERIMENTS_TABLE = 'experiments-test';
  mockLookupVersion.mockImplementation(async (_s: unknown, _r: unknown, ref: { profileName: string; version: number }) => ({
    profileName: ref.profileName, modelKey: 'sonnet', configId: `${ref.profileName}@${ref.version}`,
  }));
  mockChallenger.mockResolvedValue({ assistant: 'alt-primary-premium', botArn: 'arn:alt-bot' });
});

async function nextTurn(row: Experiment | null, enrollment = ENROLLMENT) {
  table(row);
  const { resolveEnrollment } = await import('../../lambda/src/lib/experiment-manager');
  return resolveEnrollment(enrollment, 'premium', CHAN, catalog);
}

describe('the next turn of an enrolled conversation', () => {
  it('is served its arm while the experiment is active, attributed to it', async () => {
    expect(await nextTurn(exp())).toMatchObject({ experimentId: 'exp', variantId: 'treatment', configId: 'alt-primary-premium@4' });
  });

  it.each([
    ['completed with no decision', ended('completed')],
    ['completed as promoted_treatment', ended('completed', { decision: { outcome: 'promoted_treatment', by: 'a', at: '2026-10-12T11:00:00.000Z' } } as Partial<Experiment>)],
    ['completed as kept_control', ended('completed', { decision: { outcome: 'kept_control', by: 'a', at: '2026-10-12T11:00:00.000Z' } } as Partial<Experiment>)],
    ['deleted', ended('deleted')],
    ['paused', ended('paused')],
    ['active but past its end date', exp({ endDate: '2026-10-12T11:00:00.000Z' })],
    ['missing', null],
  ])('%s: serves no experiment version (the live active version) and carries no attribution', async (_label, row) => {
    expect(await nextTurn(row)).toBeNull();
  });

  it('a resume does not re-hold a conversation the pause released', async () => {
    const resumed = exp({
      transitions: [
        { from: 'draft', to: 'active', by: 'a', at: '2026-10-12T10:00:00.000Z' },
        { from: 'active', to: 'paused', by: 'a', at: '2026-10-12T11:00:00.000Z' },
        { from: 'paused', to: 'active', by: 'a', at: '2026-10-12T12:00:00.000Z' },
      ],
    });
    expect(await nextTurn(resumed)).toBeNull();
    // A conversation created after the resume is enrolled and held.
    expect(await nextTurn(resumed, { ...ENROLLMENT, enrolledAt: '2026-10-12T12:30:00.000Z' }))
      .toMatchObject({ experimentId: 'exp', variantId: 'treatment' });
  });

  it('a conversation created during the pause is not enrolled at all', async () => {
    const { enrolledVariantFor } = await import('../../lambda/src/lib/experiment-enrollment');
    const resumed = exp({
      transitions: [
        { from: 'draft', to: 'active', by: 'a', at: '2026-10-12T10:00:00.000Z' },
        { from: 'active', to: 'paused', by: 'a', at: '2026-10-12T11:00:00.000Z' },
        { from: 'paused', to: 'active', by: 'a', at: '2026-10-12T12:00:00.000Z' },
      ],
    });
    expect(enrolledVariantFor([resumed], 'premium', CHAN, '2026-10-12T11:30:00.000Z')).toBeNull();
    expect(enrolledVariantFor([resumed], 'premium', CHAN, '2026-10-12T12:30:00.000Z')).not.toBeNull();
  });

  it('enrollmentHolds is the rule: active now, in its window, and never left active since enrollment', async () => {
    const { enrollmentHolds } = await import('../../lambda/src/lib/experiment-manager');
    const now = new Date('2026-10-12T13:00:00.000Z');
    expect(enrollmentHolds(exp(), 'premium', ENROLLMENT.enrolledAt, now)).toBe(true);
    expect(enrollmentHolds(exp(), 'standard', ENROLLMENT.enrolledAt, now)).toBe(false);
    expect(enrollmentHolds(exp({ startDate: '2026-10-13T00:00:00.000Z' }), 'premium', ENROLLMENT.enrolledAt, now)).toBe(false);
    expect(enrollmentHolds(ended('paused'), 'premium', ENROLLMENT.enrolledAt, now)).toBe(false);
  });
});

describe('a duel on an experiment that is no longer active', () => {
  it.each([
    ['paused', ended('paused')],
    ['completed', ended('completed')],
    ['past its end date', exp({ endDate: '2026-10-12T11:00:00.000Z' })],
  ])('%s: the sides read as ended, so the duel stops and the treatment does not answer', async (_label, row) => {
    table(row);
    const { resolveDuelSides, resolveBattleSide } = await import('../../lambda/src/lib/battle-turn');
    const sides = await resolveDuelSides({ classification: 'premium', selfBotArn: 'arn:alt-bot' });
    expect(sides).toEqual({ self: null, rival: null, ended: true });
    const side = await resolveBattleSide({ classification: 'premium', selfBotArn: 'arn:alt-bot', intent: 'general' });
    expect(side.ended).toBe(true);
    expect(side.selfVariant).toBeNull();
  });

  it('an active one resolves both sides and is not ended', async () => {
    table(exp());
    const { resolveDuelSides } = await import('../../lambda/src/lib/battle-turn');
    const sides = await resolveDuelSides({ classification: 'premium', selfBotArn: 'arn:alt-bot' });
    expect(sides.ended).toBeUndefined();
    expect(sides.self?.variantId).toBe('treatment');
  });
});
