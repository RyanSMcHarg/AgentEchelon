/**
 * A CONVERSATION IS ENROLLED ONCE, AT CREATION (ADR-050).
 *
 * A profile experiment changes what a person sees, so it may not start, stop or skip between turns of
 * one conversation. Pinned here: a conversation created before the arm is never enrolled; one created
 * while it ran is enrolled and keeps its variant on every turn while the experiment stays active, and is
 * released to the live active version once it pauses, completes, is deleted or passes its end date;
 * the decision replays the experiment's lifecycle rather than reading its current status; a
 * profile experiment never reaches a turn by merely being live; and a model-only experiment keeps
 * resolving per turn.
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
const mockConcreteVersion = jest.fn();
jest.mock('../../lambda/src/lib/profile-version-lookup', () => ({
  lookupProfileVersion: (...a: unknown[]) => mockLookupVersion(...a),
  lookupProfileVersionModelKey: jest.fn(),
  concreteProfileVersion: (...a: unknown[]) => mockConcreteVersion(...a),
}));

const mockGetContext = jest.fn();
const mockPutContext = jest.fn();
jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  getChannelContext: (...a: unknown[]) => mockGetContext(...a),
  putChannelContext: (...a: unknown[]) => mockPutContext(...a),
}));

import { getModelCatalog } from '../../lib/config/model-strategy';
import type { Experiment } from '../../lambda/src/lib/experiment-manager';

const catalog = getModelCatalog('us-east-1', '123456789012');
const CHAN = 'arn:aws:chime:us-east-1:111:app-instance/i/channel/c1';

/** A profile experiment armed at 10:00 and completed at 12:00 on 2026-10-12. */
const profileExp = (over: Partial<Experiment> = {}): Experiment => ({
  experimentId: 'warm',
  status: 'completed',
  experimentType: 'profile',
  intent: '',
  tiers: ['premium'],
  startDate: '2026-10-12',
  createdAt: '2026-10-12T09:00:00.000Z',
  variants: [
    { variantId: 'control', profileRef: { profileName: 'premium' }, weight: 0 },
    { variantId: 'treatment', profileRef: { profileName: 'alt-primary-premium', version: 1 }, weight: 100 },
  ],
  transitions: [
    { from: 'create', to: 'draft', by: 'admin', at: '2026-10-12T09:00:00.000Z' },
    { from: 'draft', to: 'active', by: 'admin', at: '2026-10-12T10:00:00.000Z' },
    { from: 'active', to: 'completed', by: 'admin', at: '2026-10-12T12:00:00.000Z' },
  ],
  ...over,
} as Experiment);

const modelExp = (): Experiment => ({
  experimentId: 'fast', status: 'active', experimentType: 'base_model', intent: '', tiers: ['premium'],
  startDate: '2026-10-01', createdAt: '2026-10-01T00:00:00.000Z',
  variants: [
    { variantId: 'control', modelKey: 'sonnet', weight: 100 },
    { variantId: 'treatment', modelKey: 'haiku', weight: 0 },
  ],
} as Experiment);

function serve(scan: unknown[], table: Record<string, unknown>) {
  mockSend.mockImplementation(async (cmd: { kind: string; input: { Key?: { experimentId: string } } }) => {
    if (cmd.kind === 'scan') return { Items: scan };
    if (cmd.kind === 'get') return { Item: table[cmd.input.Key!.experimentId] };
    return {};
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.EXPERIMENTS_TABLE = 'experiments-test';
  mockLookupVersion.mockImplementation(async (_ssm: unknown, _root: unknown, ref: { profileName: string; version: number }) => ({
    profileName: ref.profileName, modelKey: 'sonnet', configId: `${ref.profileName}@${ref.version}`,
  }));
  mockPutContext.mockResolvedValue(true);
  // The control's active label points at version 5 when the conversation is enrolled.
  mockConcreteVersion.mockImplementation(async (_ssm: unknown, _root: unknown, ref: { version?: number }) => ref.version ?? 5);
});

describe('who is enrolled', () => {
  it('replays the lifecycle: live only between the arm and the end', async () => {
    const { wasLiveAt } = await import('../../lambda/src/lib/experiment-enrollment');
    const exp = profileExp();
    expect(wasLiveAt(exp, 'premium', new Date('2026-10-12T09:30:00Z'))).toBe(false);
    expect(wasLiveAt(exp, 'premium', new Date('2026-10-12T11:00:00Z'))).toBe(true);
    expect(wasLiveAt(exp, 'premium', new Date('2026-10-12T12:30:00Z'))).toBe(false);
    expect(wasLiveAt(exp, 'standard', new Date('2026-10-12T11:00:00Z'))).toBe(false);
  });

  it('a pause is a gap: nothing created during it is enrolled', async () => {
    const { wasLiveAt } = await import('../../lambda/src/lib/experiment-enrollment');
    const exp = profileExp({
      status: 'active',
      transitions: [
        { from: 'draft', to: 'active', by: 'a', at: '2026-10-12T10:00:00.000Z' },
        { from: 'active', to: 'paused', by: 'a', at: '2026-10-12T10:30:00.000Z' },
        { from: 'paused', to: 'active', by: 'a', at: '2026-10-12T11:00:00.000Z' },
      ],
    });
    expect(wasLiveAt(exp, 'premium', new Date('2026-10-12T10:45:00Z'))).toBe(false);
    expect(wasLiveAt(exp, 'premium', new Date('2026-10-12T11:15:00Z'))).toBe(true);
  });

  it('a conversation created before the arm is never enrolled; one created during it is', async () => {
    const { enrolledVariantFor } = await import('../../lambda/src/lib/experiment-enrollment');
    expect(enrolledVariantFor([profileExp()], 'premium', CHAN, '2026-10-12T09:59:59.000Z')).toBeNull();
    expect(enrolledVariantFor([profileExp()], 'premium', CHAN, '2026-10-12T10:30:00.000Z'))
      .toMatchObject({ experiment: { experimentId: 'warm' }, variant: { variantId: 'treatment' } });
  });

  it('a model-only experiment enrolls nobody: it resolves per turn', async () => {
    const { enrolledVariantFor } = await import('../../lambda/src/lib/experiment-enrollment');
    expect(enrolledVariantFor([modelExp()], 'premium', CHAN, '2026-10-12T10:30:00.000Z')).toBeNull();
  });
});

describe('the pin', () => {
  it('is decided from createdAt on the first turn and written once', async () => {
    serve([profileExp()], {});
    mockGetContext.mockResolvedValue({ channelArn: CHAN, createdAt: '2026-10-12T10:30:00.000Z' });
    const { enrollmentOf } = await import('../../lambda/src/lib/experiment-enrollment');
    const pin = await enrollmentOf(CHAN, 'premium');
    const stored = { experimentId: 'warm', variantId: 'treatment', profileRef: { profileName: 'alt-primary-premium', version: 1 } };
    // The enrollment instant rides the read (the conversation's createdAt); only the pin is stored.
    expect(pin).toEqual({ ...stored, enrolledAt: '2026-10-12T10:30:00.000Z' });
    expect(mockPutContext).toHaveBeenCalledWith(CHAN, { enrollment: stored });
  });

  it('a list loaded before the conversation was created is reloaded, so an arm in between is not missed', async () => {
    const { listEnrollableExperiments } = await import('../../lambda/src/lib/experiment-manager');
    const { enrollmentOf } = await import('../../lambda/src/lib/experiment-enrollment');
    jest.useFakeTimers({ now: new Date('2026-10-12T10:00:00.000Z') });
    try {
      // A warm container loads the list before the arm: nothing is enrollable yet.
      serve([], {});
      expect(await listEnrollableExperiments()).toEqual([]);
      // Armed at 10:00:10; the conversation is created at 10:00:15 and takes its first turn at 10:00:20,
      // well inside the cache's lifetime.
      jest.setSystemTime(new Date('2026-10-12T10:00:20.000Z'));
      serve([profileExp({ status: 'active', transitions: [{ from: 'draft', to: 'active', by: 'a', at: '2026-10-12T10:00:10.000Z' }] })], {});
      mockGetContext.mockResolvedValue({ channelArn: CHAN, createdAt: '2026-10-12T10:00:15.000Z' });
      expect(await enrollmentOf(CHAN, 'premium')).toMatchObject({ experimentId: 'warm', variantId: 'treatment' });
      // The reload is a consistent read, so an arm written a moment earlier is in it.
      const scans = mockSend.mock.calls.map((c) => c[0]).filter((c: { kind: string }) => c.kind === 'scan');
      expect(scans.at(-1).input.ConsistentRead).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a ref that tracks the active label is pinned to the version it points at', async () => {
    const controlOnly = profileExp({
      variants: [
        { variantId: 'control', profileRef: { profileName: 'premium' }, weight: 100 },
        { variantId: 'treatment', profileRef: { profileName: 'alt-primary-premium', version: 1 }, weight: 0 },
      ],
    });
    serve([controlOnly], {});
    mockGetContext.mockResolvedValue({ channelArn: CHAN, createdAt: '2026-10-12T10:30:00.000Z' });
    const { enrollmentOf } = await import('../../lambda/src/lib/experiment-enrollment');
    expect(await enrollmentOf(CHAN, 'premium')).toMatchObject({ variantId: 'control', profileRef: { profileName: 'premium', version: 5 } });
  });

  it('a variant whose profile has no active version enrolls nobody', async () => {
    mockConcreteVersion.mockResolvedValue(null);
    const controlOnly = profileExp({
      variants: [{ variantId: 'control', profileRef: { profileName: 'premium' }, weight: 100 }],
    });
    serve([controlOnly], {});
    mockGetContext.mockResolvedValue({ channelArn: CHAN, createdAt: '2026-10-12T10:30:00.000Z' });
    const { enrollmentOf } = await import('../../lambda/src/lib/experiment-enrollment');
    expect(await enrollmentOf(CHAN, 'premium')).toBeNull();
    expect(mockPutContext).not.toHaveBeenCalled();
  });

  it('a recorded pin is returned as is, without reading experiments', async () => {
    const recorded = { experimentId: 'warm', variantId: 'control', profileRef: { profileName: 'premium', version: 5 } };
    mockGetContext.mockResolvedValue({ channelArn: CHAN, enrollment: recorded });
    const { enrollmentOf } = await import('../../lambda/src/lib/experiment-enrollment');
    expect(await enrollmentOf(CHAN, 'premium')).toEqual(recorded);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockPutContext).not.toHaveBeenCalled();
  });

  it('a conversation with no createdAt predates the stamp and is never enrolled', async () => {
    mockGetContext.mockResolvedValue({ channelArn: CHAN });
    const { enrollmentOf } = await import('../../lambda/src/lib/experiment-enrollment');
    expect(await enrollmentOf(CHAN, 'premium')).toBeNull();
    expect(mockPutContext).not.toHaveBeenCalled();
  });
});

describe('a turn', () => {
  it('serves the pinned variant while the experiment is active', async () => {
    const live = profileExp({ status: 'active', transitions: profileExp().transitions!.slice(0, 2) });
    serve([], { warm: live });
    const { resolveExperimentModel } = await import('../../lambda/src/lib/experiment-manager');
    const r = await resolveExperimentModel('premium', 'general', CHAN, catalog,
      { experimentId: 'warm', variantId: 'treatment', profileRef: { profileName: 'alt-primary-premium', version: 1 }, enrolledAt: '2026-10-12T10:30:00.000Z' });
    expect(r).toMatchObject({ experimentId: 'warm', variantId: 'treatment', configId: 'alt-primary-premium@1' });
    // The number travels with the version, so the turn is attributed to the version it is.
    expect(r?.variantVersion).toBe(1);
  });

  it('serves the pinned version even after the experiment is edited or the label moves', async () => {
    serve([], { warm: profileExp({ status: 'active', transitions: undefined, variants: [{ variantId: 'control', profileRef: { profileName: 'premium', version: 9 }, weight: 100 }] }) });
    const { resolveExperimentModel } = await import('../../lambda/src/lib/experiment-manager');
    const r = await resolveExperimentModel('premium', 'general', CHAN, catalog,
      { experimentId: 'warm', variantId: 'control', profileRef: { profileName: 'premium', version: 5 } });
    expect(r?.configId).toBe('premium@5');
    expect(r?.variantVersion).toBe(5);
  });

  it('a live profile experiment does not reach an unenrolled conversation', async () => {
    const live = profileExp({ status: 'active', transitions: undefined });
    serve([live], { warm: live });
    const { resolveExperimentModel } = await import('../../lambda/src/lib/experiment-manager');
    expect(await resolveExperimentModel('premium', 'general', CHAN, catalog, null)).toBeNull();
  });

  it('a deleted experiment releases its pin, and the turn resolves as unenrolled', async () => {
    serve([modelExp()], { warm: profileExp({ status: 'deleted' }), fast: modelExp() });
    const { resolveExperimentModel } = await import('../../lambda/src/lib/experiment-manager');
    const r = await resolveExperimentModel('premium', 'general', CHAN, catalog,
      { experimentId: 'warm', variantId: 'treatment', profileRef: { profileName: 'alt-primary-premium', version: 1 } });
    expect(r?.experimentId).toBe('fast');
  });

  it('a model-only experiment still resolves per turn', async () => {
    serve([modelExp()], { fast: modelExp() });
    const { resolveExperimentModel } = await import('../../lambda/src/lib/experiment-manager');
    const r = await resolveExperimentModel('premium', 'general', CHAN, catalog);
    expect(r).toMatchObject({ experimentId: 'fast', variantId: 'control' });
  });
});
