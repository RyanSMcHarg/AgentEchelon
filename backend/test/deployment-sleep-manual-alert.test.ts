/**
 * Cost sleep mode — the MANUAL sleep/wake path raises the same alert the automatic one does.
 *
 * The asymmetry this pins: `runIdleCheck` published an SNS alert when auto-sleep failed, while a
 * failed admin POST returned a 500 into one operator's HTTP response and told nobody. Someone drives
 * sleep/wake by hand during a cost incident, which is exactly when a silent failure costs money.
 *
 * lib/sleep-mode is mocked so these tests pin the ORCHESTRATION contract (does a failure alert, does
 * a success not raise a false alarm, does an alerting failure mask the error it reports); the pure
 * decision logic is covered by lib/sleep-mode.test.ts.
 */

import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockGetState = jest.fn();
const mockSetState = jest.fn();
const mockSetAurora = jest.fn();
const mockNotify = jest.fn();
jest.mock('../lambda/src/lib/sleep-mode', () => ({
  getDeploymentState: (...a: unknown[]) => mockGetState(...a),
  setDeploymentState: (...a: unknown[]) => mockSetState(...a),
  setAuroraMinCapacity: (...a: unknown[]) => mockSetAurora(...a),
  notify: (...a: unknown[]) => mockNotify(...a),
  parseIdleThresholdMs: () => null,
  shouldSleep: () => false,
}));

const mockCallerIsAdmin = jest.fn();
jest.mock('../lambda/src/lib/auth', () => ({
  callerIsAdmin: (...a: unknown[]) => mockCallerIsAdmin(...a),
}));

import { handler } from '../lambda/src/deployment-sleep';

const ADMIN_SUB = 'admin-sub-1';

function makeEvent(path: string, sub: string = ADMIN_SUB): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path,
    resource: path,
    requestContext: { authorizer: { claims: { sub } } },
  } as unknown as APIGatewayProxyEvent;
}

/** The alert this row exists for: a FAILED manual transition, not the routine success notice. */
function failureAlerts(): Array<[string, string]> {
  return mockNotify.mock.calls.filter(([subject]) => String(subject).includes('FAILED')) as Array<[string, string]>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCallerIsAdmin.mockReturnValue(true);
  mockGetState.mockResolvedValue({ state: 'awake', lastActivityAt: 1 });
  mockSetState.mockResolvedValue(undefined);
  mockSetAurora.mockResolvedValue(undefined);
  mockNotify.mockResolvedValue(undefined);
});

describe('manual sleep/wake failure alerting', () => {
  it('publishes an alert when a manual SLEEP fails, and still answers 500', async () => {
    mockSetAurora.mockRejectedValueOnce(new Error('ModifyDBCluster throttled'));

    const res = (await handler(makeEvent('/deployment/sleep'))) as { statusCode: number };

    expect(res.statusCode).toBe(500);
    const alerts = failureAlerts();
    expect(alerts).toHaveLength(1);
    const [subject, message] = alerts[0];
    expect(subject).toContain('sleep');
    // The alert has to carry WHO asked and WHAT to check; a bare "it failed" sends the operator back
    // to the console to work out whether Aurora moved.
    expect(message).toContain(`admin:${ADMIN_SUB}`);
    expect(message).toContain('ModifyDBCluster throttled');
    expect(message).toMatch(/capacity/i);
  });

  it('names WAKE in the alert when the failing transition was a wake', async () => {
    mockGetState.mockResolvedValue({ state: 'asleep', lastActivityAt: 1 });
    mockSetAurora.mockRejectedValueOnce(new Error('cluster unavailable'));

    const res = (await handler(makeEvent('/deployment/wake'))) as { statusCode: number };

    expect(res.statusCode).toBe(500);
    const [subject] = failureAlerts()[0];
    expect(subject).toContain('wake');
    expect(subject).not.toContain('sleep');
  });

  it('records the state only after Aurora moves, so a failed transition leaves it unchanged', async () => {
    mockSetAurora.mockRejectedValueOnce(new Error('boom'));

    await handler(makeEvent('/deployment/sleep'));

    expect(mockSetState).not.toHaveBeenCalled();
  });

  it('raises no failure alert when the manual transition succeeds', async () => {
    const res = (await handler(makeEvent('/deployment/sleep'))) as { statusCode: number };

    expect(res.statusCode).toBe(200);
    expect(failureAlerts()).toHaveLength(0);
    expect(mockSetState).toHaveBeenCalled();
  });

  it('an alerting failure never replaces the failure it reports', async () => {
    mockSetAurora.mockRejectedValueOnce(new Error('the real failure'));
    mockNotify.mockRejectedValueOnce(new Error('SNS is down too'));
    const errors: unknown[][] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a);
    });

    const res = (await handler(makeEvent('/deployment/sleep'))) as { statusCode: number };

    expect(res.statusCode).toBe(500);
    // Both are visible: the transition failure AND the fact that the alert about it never left.
    const flat = errors.map((a) => a.map(String).join(' ')).join('\n');
    expect(flat).toContain('the real failure');
    expect(flat).toContain('SNS is down too');
    spy.mockRestore();
  });

  it('a non-admin caller is refused without alerting anyone', async () => {
    mockCallerIsAdmin.mockReturnValue(false);

    const res = (await handler(makeEvent('/deployment/sleep', 'ordinary-user'))) as { statusCode: number };

    expect(res.statusCode).toBe(403);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockSetAurora).not.toHaveBeenCalled();
  });
});
