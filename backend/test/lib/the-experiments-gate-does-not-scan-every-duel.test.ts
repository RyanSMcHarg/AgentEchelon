/**
 * THE EXPERIMENTS GATE READS THE TABLE AT MOST ONCE A MINUTE PER CONTAINER.
 *
 * `listExperiments` is an unfiltered DynamoDB `Scan`, and the channel flow ran one on EVERY `/battle`
 * (`backend/lambda/src/channel-flow-processor.ts`, gate B4) inside a chain that is otherwise ordered
 * cheapest-first: a cached `GetItem` before it, a `Query` after it. It was also the only read in that
 * chain whose cost grows with how many experiments the deployment has ever created rather than with
 * the duel being started.
 *
 * WHY A CACHE IS THE RIGHT ANSWER HERE AND NOT SIMPLY A LATER POSITION IN THE CHAIN. The gate asks one
 * question in two halves - which experiment is this channel bound to, and is that experiment still
 * active - and the first half already comes from `loadChannelBattleConfig`'s 60 s per-container row
 * cache. Pairing a 60 s-stale id with a fresh status bought no freshness the decision could use. So
 * both halves now converge in the same window, which is also the window an operator ending an
 * experiment already waits out.
 *
 * WHAT THE STALENESS COSTS, because the rule this feeds is "ending an experiment stops the duels"
 * (`battleIsRunnable`): for up to a minute after an operator ends one, a bound channel can still start
 * a duel, and its outcome is recorded against an experiment that can never reach a recommendation.
 * Bounded to a minute per container rather than forever, which is the defect that rule exists for.
 */
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

const LIVE = { experimentId: 'exp-live', status: 'active' };
const ENDED = { experimentId: 'exp-live', status: 'completed' };

describe('listExperimentsCached', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env.EXPERIMENTS_TABLE = 'experiments-test';
  });

  it('scans once and answers the second caller from the memo', async () => {
    mockSend.mockResolvedValue({ Items: [LIVE] });
    const { listExperimentsCached } = await import('../../lambda/src/lib/experiment-manager');

    expect(await listExperimentsCached()).toEqual([LIVE]);
    expect(await listExperimentsCached()).toEqual([LIVE]);
    expect(await listExperimentsCached()).toEqual([LIVE]);

    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('re-reads after the window, so an ended experiment does stop the duels', async () => {
    // The whole point of bounding it. A memo with no expiry would keep a completed experiment running
    // duels for the life of the container, which is the forever-version of the defect.
    jest.useFakeTimers();
    try {
      mockSend.mockResolvedValueOnce({ Items: [LIVE] }).mockResolvedValueOnce({ Items: [ENDED] });
      const { listExperimentsCached } = await import('../../lambda/src/lib/experiment-manager');

      expect((await listExperimentsCached())[0].status).toBe('active');
      jest.advanceTimersByTime(60_001);
      expect((await listExperimentsCached())[0].status).toBe('completed');

      expect(mockSend).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('caches nothing when the scan fails, so an outage never reads as "no experiment is active"', async () => {
    // An empty list is not the same answer as an unreadable table. Pinning one for a minute would let
    // a transient failure decide the gate for every duel in that window.
    mockSend.mockRejectedValueOnce(new Error('ProvisionedThroughputExceeded'))
      .mockResolvedValueOnce({ Items: [LIVE] });
    const { listExperimentsCached } = await import('../../lambda/src/lib/experiment-manager');

    await expect(listExperimentsCached()).rejects.toThrow('ProvisionedThroughputExceeded');
    expect(await listExperimentsCached()).toEqual([LIVE]);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('leaves the uncached read available for a caller that must see its own write', async () => {
    mockSend.mockResolvedValue({ Items: [LIVE] });
    const { listExperiments, listExperimentsCached, invalidateExperimentsCache } =
      await import('../../lambda/src/lib/experiment-manager');

    await listExperimentsCached();
    await listExperiments();
    await listExperiments();
    expect(mockSend).toHaveBeenCalledTimes(3);

    // And the memo can be dropped outright, which is what a writer does after a write.
    invalidateExperimentsCache();
    await listExperimentsCached();
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it('answers an unset table without reading anything at all', async () => {
    delete process.env.EXPERIMENTS_TABLE;
    jest.resetModules();
    const { listExperimentsCached } = await import('../../lambda/src/lib/experiment-manager');

    expect(await listExperimentsCached()).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
