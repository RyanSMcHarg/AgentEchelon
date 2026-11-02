/**
 * A CONSOLE-CREATED ASSISTANT'S RENAME REACHES ITS IDENTITY (ADR-048, DESIGN-SEPARATE-ASSISTANTS 3.0).
 *
 * No stack deploys an applier beside an assistant (ADR-048, amended 2026-10-23), so one applier serves them all.
 * It finds the identity through the assistant's directory entry, inherits the name the assistant was provisioned
 * with, re-sends the configuration the identity already has, and refuses an assistant with no active entry. Its
 * IAM grant (identities stamped `provisioner = runtime`) is pinned at synth.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockIdentitySend = jest.fn();
jest.mock('@aws-sdk/client-chime-sdk-identity', () => {
  const cmd = (t: string) => jest.fn((input: unknown) => ({ __t: t, input }));
  return {
    ChimeSDKIdentityClient: jest.fn(() => ({ send: mockIdentitySend })),
    DescribeAppInstanceBotCommand: cmd('DescribeAppInstanceBot'),
    UpdateAppInstanceBotCommand: cmd('UpdateAppInstanceBot'),
  };
});
const mockParams = new Map<string, string>();
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return {
    ...actual,
    SSMClient: jest.fn(() => ({
      send: async (cmd: { input: { Name: string } }) => {
        const v = mockParams.get(cmd.input.Name);
        if (v === undefined) throw Object.assign(new Error('nf'), { name: 'ParameterNotFound' });
        return { Parameter: { Value: v } };
      },
    })),
  };
});

const BOT = 'arn:aws:chime:us-east-1:123456789012:app-instance/ai/bot/rt-finance';
const LEX = { Lex: { LexBotAliasArn: 'arn:aws:lex:us-east-1:123456789012:bot-alias/L/T', LocaleId: 'en_US', InvokedBy: { StandardMessages: 'NONE', TargetedMessages: 'ALL' } } };

function loadRuntimeApplier() {
  jest.resetModules();
  process.env.SSM_ROOT = '/ae';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../lambda/src/apply-assistant-name').handler;
}

beforeEach(() => {
  mockIdentitySend.mockReset().mockImplementation((cmd: { __t: string }) => Promise.resolve(
    cmd.__t === 'DescribeAppInstanceBot' ? { AppInstanceBot: { Name: 'Finance', Configuration: LEX, Metadata: 'm' } } : {},
  ));
  mockParams.clear();
  mockParams.set('/ae/assistant-directory/finance-advisor', JSON.stringify({
    classification: 'premium', role: 'primary', status: 'active', botArn: BOT, displayName: 'Finance',
  }));
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
});

const updates = () => mockIdentitySend.mock.calls.map(([c]) => c).filter((c: { __t: string }) => c.__t === 'UpdateAppInstanceBot');

describe('the runtime applier', () => {
  it('renames the identity its directory entry names, keeping its configuration and metadata', async () => {
    const out = await loadRuntimeApplier()({ assistant: 'finance-advisor', displayName: 'Penny' });
    expect(out).toEqual({ applied: true, name: 'Penny', previous: 'Finance' });
    expect(updates()).toEqual([expect.objectContaining({ input: { AppInstanceBotArn: BOT, Name: 'Penny', Metadata: 'm', Configuration: LEX } })]);
  });

  it('puts back the name the assistant was created with when a version names none', async () => {
    mockIdentitySend.mockImplementation((cmd: { __t: string }) => Promise.resolve(
      cmd.__t === 'DescribeAppInstanceBot' ? { AppInstanceBot: { Name: 'Penny', Configuration: LEX } } : {},
    ));
    const out = await loadRuntimeApplier()({ assistant: 'finance-advisor' });
    expect(out).toMatchObject({ applied: true, name: 'Finance' });
  });

  it.each([
    ['an assistant with no directory entry (one no deploy has seeded)', 'advisor'],
    ['a retired assistant', 'old-advisor'],
    ['a name that is not an assistant id', '../finance'],
  ])('refuses %s and touches no identity', async (_what, assistant) => {
    mockParams.set('/ae/assistant-directory/old-advisor', JSON.stringify({ classification: 'premium', role: 'primary', status: 'retired', botArn: BOT }));
    const out = await loadRuntimeApplier()({ assistant, displayName: 'Penny' });
    expect(out.applied).toBe(false);
    expect(mockIdentitySend).not.toHaveBeenCalled();
  });
});

describe('its grant', () => {
  const src = fs.readFileSync(path.join(__dirname, '../lib/constructs/admin-assistant-administration.ts'), 'utf8');
  it('renames only identities stamped provisioner = runtime, and reads only the directory', () => {
    const block = src.slice(src.indexOf("'RuntimeApplyAssistantNameFunction'"), src.indexOf('RUNTIME_NAME_APPLIER_ARN'));
    expect(block).toMatch(/environment: { SSM_ROOT }/);
    expect(block).toMatch(/actions: \['chime:DescribeAppInstanceBot', 'chime:UpdateAppInstanceBot'\][\s\S]*?'aws:ResourceTag\/provisioner': 'runtime'/);
    expect(block).toMatch(/actions: \['ssm:GetParameter'\],\s*resources: \[`[^`]*\/assistant-directory\/\*`\]/);
  });
});
