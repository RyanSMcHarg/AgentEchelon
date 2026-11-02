/**
 * A SWEEP THAT CANNOT FINISH IN ONE INVOCATION SAYS SO, AND CONTINUES.
 *
 * Trigger #2 (SPEC-CONVERSATION-SECURITY section 11) is the backstop for the membership boundary: the
 * scheduled pass that catches a membership the event stream could not, because nothing happened in
 * Amazon Chime SDK when the person's clearance changed underneath it.
 *
 * ── WHAT THIS EXISTS TO STOP, MEASURED LIVE 2026-09-14 ──────────────────────────────────────────
 *
 * The sweep ran serially over every channel inside a 30-second timeout. On a deployment with 698
 * channels it was killed by the runtime every single time, and it had ONE log line - after the loop -
 * so a killed sweep printed nothing. In CloudWatch that is identical to a sweep that ran clean and
 * found nothing wrong. The control whose entire job is noticing what the event stream missed was
 * reporting success by being silent.
 *
 * The existing `membership-audit.test.ts` covers what the sweep DOES to a violation it reaches. What
 * it could not see is the sweep never reaching one, because every test there has three channels and
 * finishes instantly. So these tests are about the shape of the run rather than the verdict: does it
 * stop before it is killed, does it say where it stopped, and does the rest of the work survive.
 */
const mockChimeSend = jest.fn();
const mockIdentitySend = jest.fn();
const mockCognitoSend = jest.fn();
const mockSsmSend = jest.fn();
const mockDdbSend = jest.fn();
const mockLambdaSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: mockChimeSend })),
  ListChannelsCommand: jest.fn((input: unknown) => ({ __type: 'ListChannels', input })),
  ListChannelMembershipsCommand: jest.fn((input: unknown) => ({ __type: 'ListChannelMemberships', input })),
  ListChannelMembershipsForAppInstanceUserCommand: jest.fn((input: unknown) => ({ __type: 'ListForUser', input })),
  DeleteChannelMembershipCommand: jest.fn((input: unknown) => ({ __type: 'DeleteChannelMembership', input })),
  ListTagsForResourceCommand: jest.fn((input: unknown) => ({ __type: 'ListTags', input })),
  DescribeChannelCommand: jest.fn((input: unknown) => ({ __type: 'DescribeChannel', input })),
}));
jest.mock('@aws-sdk/client-chime-sdk-identity', () => ({
  ChimeSDKIdentityClient: jest.fn(() => ({ send: mockIdentitySend })),
  ListTagsForResourceCommand: jest.fn((input: unknown) => ({ __type: 'IdentityListTags', input })),
}));
jest.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: jest.fn(() => ({ send: mockCognitoSend })),
  AdminListGroupsForUserCommand: jest.fn((input: unknown) => ({ __type: 'AdminListGroups', input })),
}));
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn((input: unknown) => ({ __type: 'GetParameter', input })),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ __type: 'Get', input })),
  PutCommand: jest.fn((input: unknown) => ({ __type: 'Put', input })),
}));
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ __type: 'Invoke', input })),
  InvocationType: { Event: 'Event' },
}));

const APP = 'arn:aws:chime:us-east-1:111:app-instance/abc';
const ADMIN = `${APP}/user/admin`;

/** Load the handler with a chosen time budget, so a deadline is reachable inside a unit test. */
function loadHandler(budgetMs: number, maxChannels = 500) {
  jest.resetModules();
  process.env.APP_INSTANCE_ARN = APP;
  process.env.USER_POOL_ID = 'pool-1';
  process.env.AUDIT_TABLE = '';
  process.env.MEMBERSHIP_AUDIT_ENFORCE = 'false';
  process.env.MAX_SWEEP_CHANNELS = String(maxChannels);
  process.env.SWEEP_BUDGET_MS = String(budgetMs);
  process.env.AWS_LAMBDA_FUNCTION_NAME = 'agent-echelon-membership-audit';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../lambda/src/membership-audit');
}

/** `pages` pages of `per` channels each; every channel has one compliant member. */
function wireChannels(pages: number, per: number, opts: { slowMs?: number } = {}) {
  const pageOf = (p: number) => ({
    Channels: Array.from({ length: per }, (_, i) => ({ ChannelArn: `${APP}/channel/p${p}-c${i}` })),
    NextToken: p + 1 < pages ? `tok-${p + 1}` : undefined,
  });
  mockChimeSend.mockImplementation(async (cmd: { __type: string; input: Record<string, unknown> }) => {
    if (cmd.__type === 'ListChannels') {
      const tok = cmd.input.NextToken as string | undefined;
      return pageOf(tok ? Number(tok.split('-')[1]) : 0);
    }
    if (cmd.__type === 'ListChannelMemberships') {
      // Each channel costs real time, the way it does live: a memberships page plus per-member reads.
      if (opts.slowMs) await new Promise((r) => setTimeout(r, opts.slowMs));
      return { ChannelMemberships: [] };
    }
    if (cmd.__type === 'ListTags') return { Tags: [{ Key: 'classification', Value: 'basic' }] };
    return {};
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSsmSend.mockResolvedValue({ Parameter: { Value: ADMIN } });
  mockIdentitySend.mockResolvedValue({ Tags: [] });
  mockCognitoSend.mockResolvedValue({ Groups: [] });
  mockDdbSend.mockResolvedValue({});
  mockLambdaSend.mockResolvedValue({});
});

const logsFrom = (spy: jest.SpyInstance) =>
  spy.mock.calls
    .map((c: unknown[]) => c.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
    .join('\n');

describe('the scheduled sweep survives not finishing', () => {
  it('stops on its own deadline instead of being killed mid-channel', async () => {
    const { handler } = loadHandler(40); // a budget the work below cannot fit in
    wireChannels(3, 10, { slowMs: 10 });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    await handler({ type: 'sweep' });

    // It stopped SHORT of the 30 channels available, which is the point - a sweep that ran them all
    // inside a 40ms budget would mean the deadline is not being consulted.
    const swept = mockChimeSend.mock.calls.filter((c) => c[0].__type === 'ListChannelMemberships').length;
    expect(`swept fewer than all 30: ${swept < 30}`).toBe('swept fewer than all 30: true');
    expect(`swept at least one: ${swept >= 1}`).toBe('swept at least one: true');
    expect(logsFrom(warn)).toMatch(/out of time; continuing in a follow-up invocation/);

    warn.mockRestore();
    log.mockRestore();
  });

  it('hands the remainder to a continuation carrying the page and the running count', async () => {
    const { handler } = loadHandler(40);
    wireChannels(3, 10, { slowMs: 10 });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    await handler({ type: 'sweep' });

    expect(`continuation invoked: ${mockLambdaSend.mock.calls.length >= 1}`).toBe('continuation invoked: true');
    const payload = JSON.parse(Buffer.from(mockLambdaSend.mock.calls[0][0].input.Payload).toString());
    expect(payload.type).toBe('sweep');
    // The COUNT TRAVELS, so MAX_SWEEP_CHANNELS bounds the whole chain rather than each link - a
    // continuation that reset it to zero would turn a bounded sweep into an unbounded one.
    expect(`scanned carried: ${typeof payload.scanned === 'number' && payload.scanned > 0}`)
      .toBe('scanned carried: true');
    // And it targets ITSELF by the runtime's own name, never a hardcoded one.
    expect(mockLambdaSend.mock.calls[0][0].input.FunctionName).toBe('agent-echelon-membership-audit');

    warn.mockRestore();
    log.mockRestore();
  });

  it('resumes where it stopped rather than starting over', async () => {
    const { handler } = loadHandler(60_000); // generous: the continuation itself must finish
    wireChannels(3, 5);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    await handler({ type: 'sweep', nextToken: 'tok-2', scanned: 10 });

    // Only the resumed page's channels are swept - the ten already covered are not done twice.
    const swept = mockChimeSend.mock.calls.filter((c) => c[0].__type === 'ListChannelMemberships').length;
    expect(`swept on resume: ${swept}`).toBe('swept on resume: 5');
    // And the completion line reports the CHAIN total, not this link's five.
    expect(logsFrom(log)).toMatch(/sweep\] complete.*"scanned":15/);

    log.mockRestore();
  });

  it('logs a line on EVERY exit path, because silence read as success', async () => {
    // The defect this whole file is about: a sweep that logged only after its loop said nothing at
    // all when it was killed inside one, and nothing is indistinguishable from clean.
    const { handler } = loadHandler(60_000);
    wireChannels(1, 3);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    await handler({ type: 'sweep' });
    expect(logsFrom(log)).toMatch(/sweep\] complete/);

    log.mockRestore();
  });

  it('still bounds the total at MAX_SWEEP_CHANNELS, and says it stopped for the cap', async () => {
    const { handler: capped } = loadHandler(60_000, 4);
    wireChannels(2, 10);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    await capped({ type: 'sweep' });

    const swept = mockChimeSend.mock.calls.filter((c) => c[0].__type === 'ListChannelMemberships').length;
    expect(`swept: ${swept}`).toBe('swept: 4');
    expect(logsFrom(warn)).toMatch(/hit MAX_SWEEP_CHANNELS/);
    // And it names the CONSEQUENCE - the channels past the cap are outside the control entirely.
    expect(logsFrom(warn)).toMatch(/NOT covered by this control/);
    // A cap is a deliberate stop, not a failure to finish, so it must NOT spawn a continuation -
    // that would loop the function against its own limit forever.
    expect(`continuation on cap: ${mockLambdaSend.mock.calls.length}`).toBe('continuation on cap: 0');

    warn.mockRestore();
    log.mockRestore();
  });

  it('reports a failed continuation instead of ending quietly', async () => {
    const { handler } = loadHandler(40);
    wireChannels(3, 10, { slowMs: 10 });
    mockLambdaSend.mockRejectedValue(new Error('AccessDeniedException'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    // A missing self-invoke permission must not silently shorten the membership backstop.
    await expect(handler({ type: 'sweep' })).resolves.toBeUndefined();
    expect(logsFrom(err)).toMatch(/continuation failed/);

    err.mockRestore();
    warn.mockRestore();
    log.mockRestore();
  });
});

describe('the deployed sweep has room to run', () => {
  it('is given a timeout a real sweep can work inside, and budgets under it', () => {
    // The 30-second timeout is the defect itself, so the guard is on the number. A sweep budget at or
    // above the timeout would be killed doing the one thing that makes a partial run legible.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'constructs', 'membership-audit.ts'), 'utf8');
    expect(`timeout: ${/timeout: cdk\.Duration\.minutes\(15\)/.test(src)}`).toBe('timeout: true');
    expect(`still 30s: ${/timeout: cdk\.Duration\.seconds\(30\)/.test(src)}`).toBe('still 30s: false');

    const handlerSrc = fs.readFileSync(path.join(__dirname, '..', 'lambda', 'src', 'membership-audit.ts'), 'utf8');
    const budget = handlerSrc.match(/const SWEEP_BUDGET_MS[\s\S]{0,120}?(\d+)\s*\*\s*60_000/);
    expect(budget).not.toBeNull();
    expect(`budget under the timeout: ${Number(budget![1]) < 15}`).toBe('budget under the timeout: true');
  });

  it('may invoke itself, and nothing else', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'constructs', 'membership-audit.ts'), 'utf8');
    // Scoped to ONE function by name. Not `this.fn.functionArn`: the function reads its role and the
    // role would then read the function, which CDK refuses as a circular dependency - it failed the
    // whole Aurora stack's synth. So the assertion is that the grant names THIS function and nothing
    // wildcarded, which is the property that matters either way.
    expect(src).toMatch(/actions: \['lambda:InvokeFunction'\]/);
    expect(src).toMatch(/resourceName: MEMBERSHIP_AUDIT_FN_NAME/);
    expect(`wildcarded: ${/actions: \['lambda:InvokeFunction'\][\s\S]{0,600}?resources: \['\*'\]/.test(src)}`)
      .toBe('wildcarded: false');
  });
});
