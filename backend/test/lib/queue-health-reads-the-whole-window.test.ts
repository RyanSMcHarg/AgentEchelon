/**
 * THE PANEL REPORTS THE WINDOW, NOT WHICHEVER BUCKET CAME FIRST.
 *
 * `Period` is the width of the window, but CloudWatch aligns periods to epoch boundaries rather than
 * to the times asked for - so a seven-day window almost never lands on a single bucket. Reading
 * `Values[0]` therefore reported a PARTIAL bucket as the seven-day total, and on a Sum that is the
 * difference between "no messages were dropped" and "some were, and you were shown the wrong day".
 *
 * There was no test here at all, which is its own finding: this is the surface an operator judges the
 * queue by, and nothing held it to reporting the right number.
 */
const mockSend = jest.fn();

jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class { send = (...a: unknown[]) => mockSend(...a); },
  GetMetricDataCommand: class { constructor(public input: any) {} },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getQueueHealth } = require('../../lambda/src/analytics-aurora/queue-health');

/** Two buckets per series, which is what an unaligned window actually returns. */
function results(byId: Record<string, number[]>) {
  return {
    MetricDataResults: Object.entries(byId).map(([Id, Values]) => ({ Id, Values })),
  };
}
const row = (rows: any[], name: string) => rows.find((r) => r.metric.startsWith(name));

beforeEach(() => mockSend.mockReset());

describe('a Sum covers every bucket in the window', () => {
  it('adds the buckets rather than taking the first', async () => {
    mockSend.mockResolvedValue(results({ drops: [2, 5], queued: [10, 4] }));

    const rows = await getQueueHealth({});

    // 7, not 2. Reading the first bucket hid five dropped messages.
    expect(row(rows, 'Overflow drops').value).toBe(7);
    expect(row(rows, 'Messages queued').value).toBe(14);
  });

  it('reports null when a metric has never been emitted', async () => {
    // Distinct from zero, and it must stay distinct: "nothing happened" and "nothing can emit this"
    // are the two readings this panel has already confused once.
    mockSend.mockResolvedValue(results({ drops: [] }));

    expect(row(await getQueueHealth({}), 'Overflow drops').value).toBeNull();
  });
});

describe('an average is not summed', () => {
  it('means the buckets for an Average series', async () => {
    mockSend.mockResolvedValue(results({ depth: [2, 4] }));

    expect(row(await getQueueHealth({}), 'Queue depth at drain').value).toBe(3);
  });
});

describe('the rows name the right signal', () => {
  it('has no row for a metric nothing can emit any more', async () => {
    mockSend.mockResolvedValue(results({}));
    const rows = await getQueueHealth({});

    // The reaper is gone. A row labeled THE HEALTH SIGNAL that can only ever be blank is worse than
    // no row: an operator reads the blank as "nothing has gone wrong".
    expect(rows.some((r: any) => /reaper/i.test(r.metric))).toBe(false);
  });

  it('shows whether the judged reading is running at all', async () => {
    mockSend.mockResolvedValue(results({ refused: [3, 1] }));
    const rows = await getQueueHealth({});

    // The condition that was true on every drain for the life of the feature, and counted by nothing.
    expect(row(rows, 'Readings refused').value).toBe(4);
  });
});
