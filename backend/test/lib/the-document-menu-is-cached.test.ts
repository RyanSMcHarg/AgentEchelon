/**
 * THE COMPANY DOCUMENT MENU IS INSIDE THE CACHED PREFIX.
 *
 * The menu (`AVAILABLE COMPANY CONTEXT`, from `_digest.json`) depends only on the classification and the
 * assistant's role scope, so invokeBedrock places it at the end of the cacheable prefix and moves the
 * cachePoint past it. The per-turn suffix stays after the cachePoint, and a turn with the tool off has no
 * menu at all.
 */

const mockBedrockSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  ConverseCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Converse', input })),
  ApplyGuardrailCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'ApplyGuardrail', input })),
}), { virtual: true });

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  ListChannelMessagesCommand: jest.fn(),
  UpdateChannelMessageCommand: jest.fn(),
  SendChannelMessageCommand: jest.fn(),
  DeleteChannelMessageCommand: jest.fn(),
}), { virtual: true });

jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(), PutObjectCommand: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  InvokeCommand: jest.fn(),
  InvocationType: { Event: 'Event' },
}), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: jest.fn() })) },
  ScanCommand: jest.fn(), PutCommand: jest.fn(), UpdateCommand: jest.fn(), GetCommand: jest.fn(), QueryCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });

const mockLoadDigest = jest.fn();
jest.mock('../../lambda/src/lib/company-context', () => ({
  ...jest.requireActual('../../lambda/src/lib/company-context'),
  loadCompanyContext: jest.fn(),
  loadContextDigest: (...args: unknown[]) => mockLoadDigest(...args),
}));

const ROLE_CREDS = { accessKeyId: 'AKIAROLE', secretAccessKey: 'assistant-secret', sessionToken: 'assistant-token' };
jest.mock('../../lambda/src/lib/assistant-session', () => {
  const actual = jest.requireActual('../../lambda/src/lib/assistant-session');
  return {
    ...actual,
    vendAssistantSession: jest.fn(async () => ({
      assistant: 'concierge', role: 'primary', botArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/a/bot/b',
      credentials: ROLE_CREDS,
    })),
  };
});

import {
  invokeBedrock, actAsAssistant, releaseAssistantIdentity, insertIntoCacheablePrefix, PROMPT_CACHE_MIN_PREFIX_CHARS,
} from '../../lambda/src/lib/async-processor-core';
import { buildDigestHint } from '../../lambda/src/lib/company-context';

const config = { model: 'anthropic.claude-sonnet-4-6', maxTokens: 1024, userType: 'basic' as const };
const STABLE = 'PERSONA AND HOST CONTEXT '.repeat(200);
const SUFFIX = '\n\n## THIS TURN\nper-turn directives';
const DIGEST = [{ file: 'handbook.md', title: 'Handbook', description: 'How we work', classification: 'basic' }];

function endTurn() {
  return { stopReason: 'end_turn', output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, usage: { inputTokens: 1, outputTokens: 1 } };
}

beforeEach(async () => {
  jest.clearAllMocks();
  process.env.CONTEXT_BUCKET = 'test-context-bucket';
  mockLoadDigest.mockResolvedValue(DIGEST);
  mockBedrockSend.mockResolvedValue(endTurn());
  await actAsAssistant('corr-menu-cached');
});

afterEach(() => releaseAssistantIdentity());

describe('the company document menu is cached', () => {
  it('places the menu at the end of the cached prefix, before the cachePoint, with the suffix after it', async () => {
    expect(STABLE.length).toBeGreaterThanOrEqual(PROMPT_CACHE_MIN_PREFIX_CHARS);
    await invokeBedrock(STABLE + SUFFIX, [{ role: 'user', content: 'hi' }], config, undefined, true, false, undefined, STABLE.length);

    const system = mockBedrockSend.mock.calls[0][0].input.system;
    expect(system).toEqual([
      { text: STABLE + buildDigestHint(DIGEST) },
      { cachePoint: { type: 'default' } },
      { text: SUFFIX },
    ]);
    // Read for the assistant's role, on its own session.
    expect(mockLoadDigest).toHaveBeenCalledWith('test-context-bucket', 'basic', {
      prefixes: ['context/basic/'],
      credentials: ROLE_CREDS,
    });
  });

  it('has no menu when the company-context tool is off', async () => {
    await invokeBedrock(STABLE + SUFFIX, [{ role: 'user', content: 'hi' }], config, undefined, false, false, undefined, STABLE.length);

    const system = mockBedrockSend.mock.calls[0][0].input.system;
    expect(JSON.stringify(system)).not.toContain('AVAILABLE COMPANY CONTEXT');
    expect(mockLoadDigest).not.toHaveBeenCalled();
  });

  it('appends the menu to an uncached prompt when the caller names no prefix', async () => {
    await invokeBedrock(STABLE + SUFFIX, [{ role: 'user', content: 'hi' }], config, undefined, true);

    expect(mockBedrockSend.mock.calls[0][0].input.system).toEqual([{ text: STABLE + SUFFIX + buildDigestHint(DIGEST) }]);
  });
});

describe('insertIntoCacheablePrefix', () => {
  it('inserts at the boundary and grows the prefix by the block length', () => {
    const r = insertIntoCacheablePrefix('AAAbbb', '+menu', 3);
    expect(r).toEqual({ systemPrompt: 'AAA+menubbb', cacheablePrefixLength: 8 });
    expect(r.systemPrompt.slice(0, r.cacheablePrefixLength!)).toBe('AAA+menu');
  });

  it('keeps a battle prefix valid: the prefix is still a leading slice after the suffix grows', () => {
    // A battle turn appends its framing after the prefix capture, so the prompt only grows at the end.
    const base = 'STABLE';
    const r = insertIntoCacheablePrefix(`${base}|turn|battle`, '+menu', base.length);
    expect(r.systemPrompt.startsWith(`${base}+menu`)).toBe(true);
    expect(r.cacheablePrefixLength).toBe(`${base}+menu`.length);
  });

  it('appends without a prefix, and is a no-op for an empty block', () => {
    expect(insertIntoCacheablePrefix('abc', '+m', undefined)).toEqual({ systemPrompt: 'abc+m', cacheablePrefixLength: undefined });
    expect(insertIntoCacheablePrefix('abc', '', 2)).toEqual({ systemPrompt: 'abc', cacheablePrefixLength: 2 });
  });
});
