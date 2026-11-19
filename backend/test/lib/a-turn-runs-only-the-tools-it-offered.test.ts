/**
 * A TURN RUNS ONLY THE TOOLS IT OFFERED.
 *
 * The offered set (the profile's allowlist, narrowed by the step, among the tools whose runtime precondition
 * holds) is the dispatch allowlist. A call naming a tool outside it is refused with an error result and the
 * tool's executor is never reached: `load_platform_info` on a turn with no platform context, `load_platform_info`
 * on a profile whose allowlist leaves it out, and `read_deployment_health` for a role it is not offered to.
 * An offered tool still runs.
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

const mockLoadPlatformInfo = jest.fn(async () => ({ documentCount: 1, documents: [] }));
jest.mock('../../lambda/src/lib/company-context', () => ({
  loadCompanyContext: jest.fn(async () => ({ documentCount: 0, documents: [] })),
  loadPlatformInfo: (...a: unknown[]) => mockLoadPlatformInfo(...(a as [])),
  loadContextDigest: jest.fn(async () => null),
  buildDigestHint: jest.fn(() => ''),
}));
const mockReadHealth = jest.fn(async () => ({ alarms: [] }));
jest.mock('../../lambda/src/lib/deployment-health', () => ({
  ...jest.requireActual('../../lambda/src/lib/deployment-health'),
  readDeploymentHealth: (...a: unknown[]) => mockReadHealth(...(a as [])),
}));
// THE ROLE IS NOT ONE `read_deployment_health` IS OFFERED TO.
jest.mock('../../lambda/src/lib/tool-registry', () => ({
  ...jest.requireActual('../../lambda/src/lib/tool-registry'),
  toolOfferedToRole: (name: string) => name !== 'read_deployment_health',
}));
jest.mock('../../lambda/src/lib/assistant-session', () => ({
  ...jest.requireActual('../../lambda/src/lib/assistant-session'),
  vendAssistantSession: jest.fn(async () => ({
    assistant: 'concierge', role: 'primary', botArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/a/bot/b',
    credentials: { accessKeyId: 'AKIAROLE', secretAccessKey: 's', sessionToken: 't' },
  })),
}));

import { invokeBedrock, actAsAssistant, releaseAssistantIdentity } from '../../lambda/src/lib/async-processor-core';

const BASE = { model: 'anthropic.claude-3-haiku-20240307-v1:0', maxTokens: 512, userType: 'basic' as const };
// An open-work summary is offered whenever the turn supplies its rows, so the loop has a tool surface.
const WITH_SUMMARY = { ...BASE, openWorkSummary: [] };

const calls = (name: string) => ({
  stopReason: 'tool_use',
  output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name, input: {} } }] } },
  usage: { inputTokens: 1, outputTokens: 1 },
});
const ends = {
  stopReason: 'end_turn',
  output: { message: { role: 'assistant', content: [{ text: 'done' }] } },
  usage: { inputTokens: 1, outputTokens: 1 },
};

/** The tool result the loop returned to the model for its first call. */
const firstToolResult = (): Record<string, unknown> => {
  const second = mockBedrockSend.mock.calls[1][0].input.messages as Array<{ role: string; content: Array<Record<string, any>> }>;
  const results = second.filter((m) => m.role === 'user' && m.content?.some((c) => c.toolResult));
  return results[results.length - 1].content[0].toolResult.content[0].json;
};
const offered = (): string[] =>
  ((mockBedrockSend.mock.calls[0][0].input.toolConfig?.tools ?? []) as Array<{ toolSpec?: { name?: string } }>).map((t) => t.toolSpec?.name ?? '');

beforeEach(async () => {
  jest.clearAllMocks();
  delete process.env.CONTEXT_BUCKET;
  await actAsAssistant('corr-offered-tools');
});
afterEach(() => releaseAssistantIdentity());

describe('a call to a tool the turn did not offer', () => {
  it('DENY: load_platform_info on a turn with no platform context is refused before it runs', async () => {
    mockBedrockSend.mockResolvedValueOnce(calls('load_platform_info')).mockResolvedValueOnce(ends);
    await invokeBedrock('sys', [{ role: 'user', content: 'what is this platform?' }], WITH_SUMMARY, undefined, false);
    expect(offered()).not.toContain('load_platform_info');
    expect(mockLoadPlatformInfo).not.toHaveBeenCalled();
    expect(String(firstToolResult().error)).toContain('not offered');
  });

  it('DENY: load_platform_info on a profile whose allowlist leaves it out is refused before it runs', async () => {
    process.env.CONTEXT_BUCKET = 'context-bucket';
    mockBedrockSend.mockResolvedValueOnce(calls('load_platform_info')).mockResolvedValueOnce(ends);
    await invokeBedrock('sys', [{ role: 'user', content: 'what is this platform?' }], { ...WITH_SUMMARY, tools: ['open_work_summary'] }, undefined, true);
    expect(offered()).not.toContain('load_platform_info');
    expect(mockLoadPlatformInfo).not.toHaveBeenCalled();
    expect(String(firstToolResult().error)).toContain('not offered');
  });

  it('DENY: read_deployment_health for a role it is not offered to is refused before it runs', async () => {
    mockBedrockSend.mockResolvedValueOnce(calls('read_deployment_health')).mockResolvedValueOnce(ends);
    await invokeBedrock('sys', [{ role: 'user', content: 'is the deployment healthy?' }], WITH_SUMMARY, undefined, false);
    expect(offered()).not.toContain('read_deployment_health');
    expect(mockReadHealth).not.toHaveBeenCalled();
    expect(String(firstToolResult().error)).toContain('not offered');
  });
});

describe('a call to a tool the turn offered', () => {
  it('runs: load_platform_info where platform context is on and the allowlist is open', async () => {
    process.env.CONTEXT_BUCKET = 'context-bucket';
    mockBedrockSend.mockResolvedValueOnce(calls('load_platform_info')).mockResolvedValueOnce(ends);
    await invokeBedrock('sys', [{ role: 'user', content: 'what is this platform?' }], BASE, undefined, true);
    expect(offered()).toContain('load_platform_info');
    expect(mockLoadPlatformInfo).toHaveBeenCalledTimes(1);
    expect(firstToolResult().error).toBeUndefined();
  });
});
