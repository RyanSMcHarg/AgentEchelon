/**
 * AN ENDED EXPERIMENT STOPS RECEIVING TURNS AT ONCE, AND ITS SUCCESSOR STARTS AT ONCE.
 *
 * Measured live 2026-10-05: the router resolved experiments from a per-container 60 s cache, so an
 * experiment completed before its successor was created kept receiving turns for 25 s and the successor
 * received none. With one live experiment per classification, every handover lost its first minute.
 *
 * Pinned here: the cached pick is re-read before a turn is assigned to it, an ended one reloads the
 * cache and hands over to the successor, a "nothing live" answer is re-checked once it is older than
 * ten seconds, and a failed check keeps the cached pick rather than dropping attribution.
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

import { getModelCatalog } from '../../lib/config/model-strategy';

const catalog = getModelCatalog('us-east-1', '123456789012');

const exp = (experimentId: string, status = 'active') => ({
  experimentId,
  status,
  experimentType: 'base_model',
  tiers: ['premium'],
  variants: [
    { variantId: 'control', modelKey: 'sonnet', weight: 100 },
    { variantId: 'treatment', modelKey: 'haiku', weight: 0 },
  ],
});

/** Answer each command by kind: scans in order from `scans`, gets from `table`. */
function serve(scans: unknown[][], table: Record<string, unknown | Error>) {
  const queue = [...scans];
  mockSend.mockImplementation(async (cmd: { kind: string; input: { Key?: { experimentId: string } } }) => {
    if (cmd.kind === 'scan') return { Items: queue.shift() ?? [] };
    if (cmd.kind === 'get') {
      const row = table[cmd.input.Key!.experimentId];
      if (row instanceof Error) throw row;
      return { Item: row };
    }
    return {};
  });
}
const scanCount = () => mockSend.mock.calls.filter(([c]) => c.kind === 'scan').length;
const getCount = () => mockSend.mock.calls.filter(([c]) => c.kind === 'get').length;

async function load() {
  return import('../../lambda/src/lib/experiment-manager');
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.resetModules();
  process.env.EXPERIMENTS_TABLE = 'experiments-test';
});
afterEach(() => jest.restoreAllMocks());

it('an ended experiment hands over to its successor on the very next turn', async () => {
  serve([[exp('old')], [exp('new')]], { old: exp('old', 'completed'), new: exp('new') });
  const { resolveExperimentModel } = await load();
  const r = await resolveExperimentModel('premium', 'general', 'arn:chan', catalog);
  expect(r?.experimentId).toBe('new');
  expect(scanCount()).toBe(2); // the cache was reloaded because the cached pick had ended
});

it('a deleted experiment is treated as ended', async () => {
  serve([[exp('gone')], []], {});
  const { resolveExperimentModel } = await load();
  expect(await resolveExperimentModel('premium', 'general', 'arn:chan', catalog)).toBeNull();
});

it('a still-live experiment costs one read and no reload', async () => {
  serve([[exp('live')]], { live: exp('live') });
  const { resolveExperimentModel } = await load();
  const r = await resolveExperimentModel('premium', 'general', 'arn:chan', catalog);
  expect(r?.experimentId).toBe('live');
  expect(scanCount()).toBe(1);
  expect(getCount()).toBe(1);
});

it('a new experiment is found within seconds when nothing was live, not after the minute', async () => {
  let now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  serve([[], [exp('started')]], { started: exp('started') });
  const { resolveExperimentModel } = await load();
  expect(await resolveExperimentModel('premium', 'general', 'arn:chan', catalog)).toBeNull();
  now += 11_000; // older than the ten-second recheck, well inside the 60 s cache
  const r = await resolveExperimentModel('premium', 'general', 'arn:chan', catalog);
  expect(r?.experimentId).toBe('started');
  expect(scanCount()).toBe(2);
});

it('does not re-scan on every turn while nothing is live', async () => {
  let now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  serve([[], []], {});
  const { resolveExperimentModel } = await load();
  await resolveExperimentModel('premium', 'general', 'arn:chan', catalog);
  now += 5_000;
  await resolveExperimentModel('premium', 'general', 'arn:chan', catalog);
  expect(scanCount()).toBe(1);
});

it('a failed freshness read keeps the cached pick rather than dropping attribution', async () => {
  serve([[exp('cached')]], { cached: new Error('throttled') });
  const { resolveExperimentModel } = await load();
  const r = await resolveExperimentModel('premium', 'general', 'arn:chan', catalog);
  expect(r?.experimentId).toBe('cached');
});

it('a classification experiment hands over the same way', async () => {
  const cls = (id: string, status = 'active') => ({ ...exp(id, status), experimentType: 'classification' });
  serve([[cls('old')], [cls('new')]], { old: cls('old', 'completed'), new: cls('new') });
  const { resolveClassificationExperiment } = await load();
  const r = await resolveClassificationExperiment('premium', 'arn:chan', catalog);
  expect(r?.experimentId).toBe('new');
});
