/**
 * A PICKUP IS NAMED TO THE ROUTER THE PROCESSOR ALREADY HOLDS (ADR-063 decision 5).
 *
 * The turn that ends with nothing queued hands the lock to a pickup turn and names it to its classification's router. That
 * exit runs in the processor, whose environment carries its own classification's router parameter (`ROUTER_ARN_PARAM`)
 * and neither a router variable nor a by-name root. So the router is read from that parameter, the one the processor's
 * other re-dispatches read (`resolveRouterArn` in `turn-triage.ts`), and the pickup is invoked on it.
 *
 * What it proves, with the environment the deployed processor has: the exit's default dispatch reads the processor's own
 * router parameter and invokes that router asynchronously with the pickup's ids, and nothing releases the lock it handed
 * over. And with no router parameter at all, the hand-off is refused and the handed lock is given back.
 */
const lambdaSend = jest.fn();
const ssmSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => {
  const actual = jest.requireActual('@aws-sdk/client-lambda');
  return { ...actual, LambdaClient: jest.fn().mockImplementation(() => ({ send: lambdaSend })) };
});
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn().mockImplementation(() => ({ send: ssmSend })) };
});

import type { Task } from '../../lambda/src/lib/task-tracking';

const CH = 'arn:aws:chime:us-east-1:1:app-instance/i/channel/c1';
const BOT = 'arn:aws:chime:us-east-1:1:app-instance/i/bot/advisorbot';
const ROUTER = 'arn:aws:lambda:us-east-1:1:function:premium-router';
const PARAM = '/agent-echelon/assistant/premium/router-arn';

const task = (over: Partial<Task> = {}): Task => ({
  taskId: 't1', channelArn: CH, taskType: 'guided_troubleshooting', taskState: 'diagnosing', status: 'in_progress',
  assigneeId: 'advisorbot', assigneeType: 'assistant', priority: 'high', createdAt: '2026-10-29T00:00:00Z',
  ...over,
} as Task);

const ENV_KEYS = ['CLASSIFICATION', 'ROUTER_ARN_PARAM', 'PREMIUM_ROUTER_ARN', 'ROUTER_ARN_PARAM_ROOT'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.resetModules();
  lambdaSend.mockReset().mockResolvedValue({});
  ssmSend.mockReset().mockImplementation(async (cmd: { input: { Name: string } }) => (
    cmd.input.Name === PARAM ? { Parameter: { Value: ROUTER } } : Promise.reject(Object.assign(new Error('nf'), { name: 'ParameterNotFound' }))
  ));
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.CLASSIFICATION = 'premium';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function exitDeps(calls: string[]) {
  return {
    takePending: async () => [],
    ready: async () => [task()],
    handOver: async () => { calls.push('handover'); return true; },
    release: async () => { calls.push('release'); return 'released' as const; },
    releaseHeld: async () => { calls.push('release-held'); return true; },
  } as never;
}

describe('the exit names its pickup to the router the processor holds', () => {
  it('reads the processor\'s own router parameter and invokes that router with the pickup\'s ids', async () => {
    process.env.ROUTER_ARN_PARAM = PARAM;
    const { handOverToPickup } = await import('../../lambda/src/lib/turn-handover');
    const calls: string[] = [];
    expect(await handOverToPickup({ channelArn: CH, botArn: BOT, correlationId: 'turn-1', classification: 'premium' }, exitDeps(calls))).toBe(true);
    expect(calls).toEqual(['handover']);
    expect(lambdaSend).toHaveBeenCalledTimes(1);
    const input = lambdaSend.mock.calls[0][0].input;
    expect(input.FunctionName).toBe(ROUTER);
    expect(input.InvocationType).toBe('Event');
    const payload = JSON.parse(Buffer.from(input.Payload).toString());
    expect(payload.aeTaskPickup).toMatchObject({ channelArn: CH, botArn: BOT, taskId: 't1' });
    expect(payload.aeTaskPickup.correlationId).toMatch(/^pickup-[0-9a-f]{32}$/);
  });

  it('with no router to name, the hand-off is refused and the lock it handed over is given back', async () => {
    const { handOverToPickup } = await import('../../lambda/src/lib/turn-handover');
    const calls: string[] = [];
    expect(await handOverToPickup({ channelArn: CH, botArn: BOT, correlationId: 'turn-1', classification: 'premium' }, exitDeps(calls))).toBe(true);
    expect(lambdaSend).not.toHaveBeenCalled();
    expect(calls).toEqual(['handover', 'release-held']);
  });
});
