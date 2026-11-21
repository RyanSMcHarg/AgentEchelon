/**
 * AN OPERATIONAL ADMIN NOTICE IS SWITCHED, A SECURITY NOTICE NEVER IS (DESIGN-EVENT-TARGETS section 12), through the trigger
 * service: the switch enables or disables the notice's rule, then records the state a deploy keeps and the console reads, and
 * changes nothing else; the console never shows a state the rule is not in.
 */
const mockRequireAdmin = jest.fn();
jest.mock('../../lambda/src/lib/auth', () => ({ requireAdmin: (...a: unknown[]) => mockRequireAdmin(...a) }));
jest.mock('../../lib/profile-registry', () => ({ ...jest.requireActual('../../lib/profile-registry'), loadProfileRegistry: jest.fn(async () => undefined) }));
jest.mock('../../lambda/src/lib/chime/clients', () => ({ chimeMessagingClient: () => ({ send: jest.fn() }) }));

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { SSMClient } from '@aws-sdk/client-ssm';

const ebSend = jest.spyOn(EventBridgeClient.prototype, 'send') as unknown as jest.Mock;
const ssmSend = jest.spyOn(SSMClient.prototype, 'send') as unknown as jest.Mock;
let handler: (e: APIGatewayProxyEvent) => Promise<{ statusCode: number; body: string }>;
let params: Map<string, string>;

beforeAll(async () => {
  process.env.APP_INSTANCE_ARN = 'arn:aws:chime:us-east-1:111122223333:app-instance/i';
  process.env.EVENT_TRIGGER_RULE_PREFIX = 'ae-';
  process.env.SSM_ROOT = '/ae';
  ({ handler } = await import('../../lambda/src/event-triggers-api'));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireAdmin.mockResolvedValue({ claims: { actor: 'admin-1' } });
  params = new Map([['/ae/admin-notices/alarm/state', 'ENABLED'], ['/ae/admin-notices/assistant-error/state', 'DISABLED']]);
  ssmSend.mockImplementation(async (cmd: { constructor: { name: string }; input: { Name: string; Value?: string } }) => {
    if (cmd.constructor.name === 'PutParameterCommand') { params.set(cmd.input.Name, cmd.input.Value!); return {}; }
    if (cmd.constructor.name === 'GetParameterCommand') {
      if (!params.has(cmd.input.Name)) throw Object.assign(new Error('nf'), { name: 'ParameterNotFound' });
      return { Parameter: { Value: params.get(cmd.input.Name) } };
    }
    throw new Error(`unexpected ${cmd.constructor.name}`);
  });
  ebSend.mockResolvedValue({});
});

const list = () => handler({ httpMethod: 'GET', resource: '/admin/admin-notices', headers: {}, requestContext: {} } as unknown as APIGatewayProxyEvent);
const flip = (key: string, body: unknown) => handler({
  httpMethod: 'POST', resource: '/admin/admin-notices/{key}', headers: {}, pathParameters: { key }, body: JSON.stringify(body), requestContext: {},
} as unknown as APIGatewayProxyEvent);

describe('the admin notices, through the trigger service', () => {
  it('lists every notice: a security one always on, an operational one as recorded, and an unreadable state as unknown', async () => {
    const res = await list();
    expect(res.statusCode).toBe(200);
    const notices = JSON.parse(res.body).notices as Array<{ key: string; security: boolean; enabled: boolean | null }>;
    expect(notices.find((n) => n.key === 'membership-audit')).toMatchObject({ security: true, enabled: true });
    expect(notices.find((n) => n.key === 'alarm')).toMatchObject({ security: false, enabled: true });
    expect(notices.find((n) => n.key === 'assistant-error')).toMatchObject({ security: false, enabled: false });
    expect(notices.find((n) => n.key === 'turn-not-started')).toMatchObject({ security: false, enabled: null });
  });

  it('switches an operational notice off: the rule first, then the recorded state, and nothing else', async () => {
    const res = await flip('alarm', { enabled: false });
    expect(res.statusCode).toBe(200);
    expect(params.get('/ae/admin-notices/alarm/state')).toBe('DISABLED');
    expect(ebSend.mock.calls.map(([c]) => [c.constructor.name, c.input.Name])).toEqual([['DisableRuleCommand', 'ae-admin-notice-alarm']]);
    expect(ebSend.mock.invocationCallOrder[0]).toBeLessThan(ssmSend.mock.invocationCallOrder[0]);
  });

  it('DENY: a security notice is refused a switch, and nothing is written', async () => {
    for (const key of ['membership-audit', 'activated-past-golden-gate', 'boundary-refusal-alarm']) {
      const res = await flip(key, { enabled: false });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).code).toBe('NOTICE_ALWAYS_ON');
    }
    expect(ebSend).not.toHaveBeenCalled();
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it('DENY: an unknown notice, or a switch that is not true or false, changes nothing', async () => {
    expect((await flip('nope', { enabled: false })).statusCode).toBe(404);
    expect((await flip('alarm', { enabled: 'no' })).statusCode).toBe(400);
    expect(ebSend).not.toHaveBeenCalled();
    expect(ssmSend).not.toHaveBeenCalled();
  });
});

describe('DENY: the console never shows a notice state its rule is not in', () => {
  it('a rule that cannot be switched records nothing', async () => {
    ebSend.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'InternalException' }));
    const res = await flip('alarm', { enabled: false });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(params.get('/ae/admin-notices/alarm/state')).toBe('ENABLED');
  });

  it('a state that cannot be recorded switches the rule back', async () => {
    ssmSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'PutParameterCommand') throw Object.assign(new Error('x'), { name: 'InternalServerError' });
      return {};
    });
    const res = await flip('alarm', { enabled: false });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(ebSend.mock.calls.map(([c]) => c.constructor.name)).toEqual(['DisableRuleCommand', 'EnableRuleCommand']);
  });
});
