/**
 * THE GOLDEN GATE READS COVERAGE PER INTENT (ADR-065 decision 6, SPEC-EVALUATION FR27).
 *
 * What it proves:
 *  - the counts (`coverageOf`): every intent of the draft's pack is listed, in the pack's order, with what the set holds
 *    for it and what the latest run exercised; entries for intents the pack does not declare are listed apart;
 *  - the rule (`goldenGateOutcome`): with a minimum, an intent below it refuses as `GOLDEN_SET_THIN`, naming each such
 *    intent, before any run is asked for, and an intent with no counts read is counted as none; a passing result names
 *    the intents it exercised nothing for; with no minimum the gate is as before;
 *  - the field (`goldenSetErrors`): a whole number from 1 to the set's capacity, and nothing else;
 *  - the route: the minimum is read from the ACTIVE version, so a draft that lowers it is still measured against the
 *    active one, and the draft's own intents are what the counts are read for.
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { coverageOf, liveFailuresOnly } from '../../lambda/src/analytics-aurora/golden-run';
import { goldenGateOutcome, effectiveMinimum, type GoldenGateRead } from '../../lambda/src/lib/golden-gate';
import { goldenSetErrors } from '../../lambda/src/lib/active-profile';
import { GOLDEN_SET_CAPACITY } from '../../lambda/src/lib/golden-upload';
import { fakeSsmStore } from '../helpers/fake-ssm-store';
import { edgeContext } from '../helpers/edge-context';
import { PutParameterCommand } from '@aws-sdk/client-ssm';

jest.mock('@aws-sdk/client-s3', () => {
  class S3Client { async send(): Promise<unknown> { throw Object.assign(new Error('not found'), { name: 'NoSuchKey' }); } }
  return { S3Client, PutObjectCommand: class {}, GetObjectCommand: class {}, DeleteObjectCommand: class {}, ListObjectsV2Command: class {} };
});
const mockStore: { current: ReturnType<typeof fakeSsmStore> | null } = { current: null };
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn(() => ({ send: (cmd: unknown) => mockStore.current!.client.send(cmd as never) })) };
});
// The run function's read: no entries at all, and the intents it was asked about kept.
const mockAsked: Array<Record<string, unknown>> = [];
jest.mock('@aws-sdk/client-lambda', () => {
  const actual = jest.requireActual('@aws-sdk/client-lambda');
  class LambdaClient {
    async send(cmd: { input: { Payload: Uint8Array } }): Promise<unknown> {
      const p = JSON.parse(Buffer.from(cmd.input.Payload).toString('utf8'));
      mockAsked.push(p);
      const coverage = (p.intents as string[]).map((intent) => ({ intent, regression: 0, capability: 0, uploaded: 0, exercised: 0 }));
      return { Payload: Buffer.from(JSON.stringify({ entries: 0, regressionEntries: 0, uncoveredRegression: 0, run: null, coverage, outsidePack: [] })) };
    }
  }
  return { ...actual, LambdaClient };
});
jest.mock('../../lambda/src/lib/assistant-scope', () => {
  const actual = jest.requireActual('../../lambda/src/lib/assistant-scope');
  return { ...actual, requireOwnedAssistant: async () => null };
});

import { createDraft, editDraft } from '../../lambda/src/lib/profile-lifecycle';
import { handler } from '../../lambda/src/manage-profiles';

describe('coverageOf: the counts per intent', () => {
  it('lists every intent of the pack in its order, and entries outside the pack apart', () => {
    expect(coverageOf(['report_generation', 'data_extraction', 'code_review'], [
      { intent: 'data_extraction', regression: '2', capability: '1', uploaded: '1', exercised: '2' },
      { intent: 'weather', regression: '1', capability: '2', uploaded: '3', exercised: '0' },
      { intent: '', regression: '0', capability: '1', uploaded: '0', exercised: '0' },
    ])).toEqual({
      coverage: [
        { intent: 'report_generation', regression: 0, capability: 0, uploaded: 0, exercised: 0 },
        { intent: 'data_extraction', regression: 2, capability: 1, uploaded: 1, exercised: 2 },
        { intent: 'code_review', regression: 0, capability: 0, uploaded: 0, exercised: 0 },
      ],
      outsidePack: [{ intent: '', entries: 1 }, { intent: 'weather', entries: 3 }],
    });
  });
});

const cov = (intent: string, regression: number, exercised = regression) => ({ intent, regression, capability: 0, uploaded: 0, exercised });
const passedRun = (configId: string): GoldenGateRead['run'] => ({
  runId: 'run-1', draftConfigId: configId, status: 'complete', error: null, entriesTotal: 3, entriesDone: 3,
  result: { refused: false, failures: [], readyToPromote: [], pairedDifference: null, minimumDetectable: Infinity, notExercised: [], regressionExercised: 3, entries: 3, k: 3 },
});

describe('goldenGateOutcome: a minimum per intent', () => {
  const intents = ['report_generation', 'data_extraction', 'code_review'];

  it('refuses as GOLDEN_SET_THIN, naming each intent below the minimum, before a run is asked for', () => {
    const gate: GoldenGateRead = {
      entries: 3, regressionEntries: 3, run: null, intents, minRegressionPerIntent: 2,
      coverage: [cov('report_generation', 2), cov('data_extraction', 1), cov('code_review', 0)],
    };
    expect(goldenGateOutcome(gate, 'cfg-1')).toMatchObject({
      proceed: false, code: 'GOLDEN_SET_THIN', params: { count: 2, min: 2, intents: 'data_extraction, code_review' },
    });
  });

  it('refuses an empty set when a minimum applies, and counts an intent with no counts read as none', () => {
    expect(goldenGateOutcome({ entries: 0, regressionEntries: 0, run: null, intents, minRegressionPerIntent: 1 }, 'cfg-1')).toMatchObject({
      proceed: false, code: 'GOLDEN_SET_THIN', params: { count: 3 },
    });
  });

  it('with the minimum met, goes on to the run, and a pass names the intents it exercised nothing for', () => {
    const gate: GoldenGateRead = {
      entries: 4, regressionEntries: 4, run: passedRun('cfg-1'), intents, minRegressionPerIntent: 1,
      coverage: [cov('report_generation', 2), cov('data_extraction', 1), cov('code_review', 1, 0)],
    };
    expect(goldenGateOutcome(gate, 'cfg-1')).toEqual({ proceed: true, note: 'passed', unchecked: ['code_review'] });
    expect(goldenGateOutcome({ ...gate, run: null }, 'cfg-1')).toMatchObject({ proceed: false, code: 'GOLDEN_RUN_REQUIRED' });
  });

  it('with no minimum, gates as before, and still says which intents an empty set checks nothing for', () => {
    expect(goldenGateOutcome({ entries: 0, regressionEntries: 0, run: null, intents, coverage: intents.map((i) => cov(i, 0)) }, 'cfg-1'))
      .toEqual({ proceed: true, note: 'empty', unchecked: intents });
    expect(goldenGateOutcome({ entries: 0, regressionEntries: 0, run: null }, 'cfg-1')).toEqual({ proceed: true, note: 'empty' });
  });
});

describe('liveFailuresOnly: a run refuses only on entries still in the set', () => {
  const result = {
    refused: true, failures: [{ entryId: 'gone', attempt: 1, reason: 'blocked' as const }, { entryId: 'live', attempt: 2, reason: 'empty' as const }],
    readyToPromote: [], pairedDifference: null, minimumDetectable: Infinity, notExercised: [], regressionExercised: 2, entries: 2, k: 3,
  };
  it('drops the failures of an entry retired since the run, and refuses only if one of a live entry remains', () => {
    expect(liveFailuresOnly(result as never, new Set(['live']))).toMatchObject({ refused: true, failures: [{ entryId: 'live' }] });
    expect(liveFailuresOnly(result as never, new Set())).toMatchObject({ refused: false, failures: [] });
  });
});

describe('effectiveMinimum: a minimum the set could never hold', () => {
  it('is held at the most a set of that size can give each intent of the draft, and is otherwise the active one', () => {
    expect(effectiveMinimum(undefined, 10, 100)).toBeUndefined();
    expect(effectiveMinimum(8, 10, 100)).toBe(8);
    // Ten intents became fifteen in the draft: 8 each would need 120 of 100.
    expect(effectiveMinimum(8, 15, 100)).toBe(6);
    expect(effectiveMinimum(3, 0, 100)).toBe(3);
    expect(effectiveMinimum(2, 150, 100)).toBe(1);
  });
});

describe('goldenSetErrors: the field', () => {
  it('takes a whole number from 1 to the capacity, and nothing else', () => {
    expect(goldenSetErrors(undefined)).toEqual([]);
    expect(goldenSetErrors({})).toEqual([]);
    expect(goldenSetErrors({ minRegressionPerIntent: 1 })).toEqual([]);
    expect(goldenSetErrors({ minRegressionPerIntent: GOLDEN_SET_CAPACITY })).toEqual([]);
    for (const bad of [0, -1, 1.5, '2', GOLDEN_SET_CAPACITY + 1]) {
      expect(goldenSetErrors({ minRegressionPerIntent: bad })).toEqual([expect.stringContaining('whole number')]);
    }
    expect(goldenSetErrors({ minRegression: 2 })).toEqual([expect.stringContaining('no field minRegression')]);
    expect(goldenSetErrors([2])).toEqual(['goldenSet must be an object']);
  });
});

function evt(route: string, body: Record<string, unknown>): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: route,
    headers: { origin: 'http://localhost:5173' },
    body: JSON.stringify(body),
    requestContext: { authorizer: edgeContext({ claims: { sub: 'u-1', 'cognito:groups': 'admins' } }) },
  } as unknown as APIGatewayProxyEvent;
}
const parse = (r: { body: string }) => JSON.parse(r.body);

describe('the route: the minimum is the active version\'s', () => {
  const ROOT = '/agent-echelon';
  const GOLDEN_ROOT = '/agent-echelon/golden-run-test';

  beforeEach(async () => {
    process.env.GOLDEN_RUN_PARAM_ROOT = GOLDEN_ROOT;
    mockAsked.length = 0;
    mockStore.current = fakeSsmStore();
    const { client } = mockStore.current;
    for (const cls of ['basic', 'standard', 'premium']) {
      await client.send(new PutParameterCommand({ Name: `${GOLDEN_ROOT}/${cls}/golden-run-arn`, Value: `arn:aws:lambda:us-east-1:1:function:${cls}-GoldenRun`, Type: 'String' }));
      await client.send(new PutParameterCommand({ Name: `${ROOT}/assistant/${cls}/context-sources`, Value: JSON.stringify([{ key: 'user-profile' }]), Type: 'String' }));
    }
  });

  it('a draft that lowers the minimum is still refused against the active one, until it is active', async () => {
    const { client } = mockStore.current!;
    // The active version declares a minimum; the empty set has no regression entry, so its own activation proceeds.
    await createDraft(client, ROOT, 'advisor', 'admin-sub');
    await editDraft(client, ROOT, 'advisor', { goldenSet: { minRegressionPerIntent: 2 } }, 'admin-sub');
    const first = await handler(evt('/admin/profiles/activate', { profileName: 'advisor' }));
    expect([first.statusCode, first.body]).toEqual([200, expect.any(String)]);

    // A draft that lowers it is measured against the active version's 2, not its own.
    await createDraft(client, ROOT, 'advisor', 'admin-sub');
    await editDraft(client, ROOT, 'advisor', { goldenSet: { minRegressionPerIntent: 1 } }, 'admin-sub');
    const gate = parse(await handler(evt('/admin/profiles/golden-gate', { profileName: 'advisor' })));
    expect(gate.gate.minRegressionPerIntent).toBe(2);
    expect(gate.outcome).toMatchObject({ proceed: false, code: 'GOLDEN_SET_THIN', params: { min: 2 } });
    expect(mockAsked.at(-1)).toMatchObject({ op: 'gate', intents: expect.arrayContaining(['report_generation']) });
    const refused = await handler(evt('/admin/profiles/activate', { profileName: 'advisor' }));
    expect(refused.statusCode).toBe(409);
    expect(parse(refused).code).toBe('GOLDEN_SET_THIN');
  });

  it('a draft refuses a minimum outside its bounds', async () => {
    const { client } = mockStore.current!;
    await createDraft(client, ROOT, 'advisor', 'admin-sub');
    await expect(editDraft(client, ROOT, 'advisor', { goldenSet: { minRegressionPerIntent: 0 } }, 'admin-sub')).rejects.toThrow(/whole number/);
  });
});
