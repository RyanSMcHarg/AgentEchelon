/**
 * The INPUT guardrail scores what this turn's human submitted, not whatever sits last in the user role
 * (ADR-027 phase 1).
 *
 * WHY THE TWO DIVERGE. `loadChannelHistory` assigns roles by perspective: every participant that is not
 * this assistant takes the USER role, peer assistants included. In a channel with a second assistant, a
 * message that bot authored can therefore occupy the last-user-role slot. A platform notice is the worst
 * case, because it is a statement about how assistants behave: read as a user turn it is an instruction
 * aimed at the model, and Bedrock scores it as a prompt attack. Measured against the deployed guardrail,
 * "Battle Mode is now ON. Two assistants will answer the same prompt so you can compare them." returns
 * GUARDRAIL_INTERVENED / PROMPT_ATTACK while the user's actual question returns NONE.
 *
 * The failure is deterministic and one-sided: the assistant that did NOT author the notice is blocked
 * before its model is called, in every duel in that channel. The duel still completes - a blocked side
 * posts the guardrail's block message, which is attributed and rendered like any other reply - so the
 * experiment records a loss against a model that never ran. That is why the second test here asserts the
 * reply is an ANSWER: asserting only that two replies arrived is what let this pass unnoticed.
 */
const mockBedrockSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  ConverseCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Converse', input })),
  ApplyGuardrailCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'ApplyGuardrail', input })),
}), { virtual: true });
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  ListChannelMessagesCommand: jest.fn(), UpdateChannelMessageCommand: jest.fn(),
  SendChannelMessageCommand: jest.fn(), DeleteChannelMessageCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(), PutObjectCommand: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  InvokeCommand: jest.fn(), InvocationType: { Event: 'Event' },
}), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: jest.fn() })) },
  ScanCommand: jest.fn(), PutCommand: jest.fn(), UpdateCommand: jest.fn(), GetCommand: jest.fn(), QueryCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });
jest.mock('../../lambda/src/lib/company-context', () => ({ loadCompanyContext: jest.fn() }));

import { invokeBedrock } from '../../lambda/src/lib/async-processor-core';

/** The exact string the deployed guardrail scores as PROMPT_ATTACK (`channel-battle.ts`). */
const PLATFORM_NOTICE =
  'Battle Mode is now ON. Two assistants will answer the same prompt so you can compare them.';
const USER_PROMPT = 'Tabs or spaces for indentation? Answer in one short paragraph with a clear pick.';
const ANSWER = '**Spaces** - and specifically 4 of them.';
const BLOCK_MESSAGE = 'I cannot process that request. Please rephrase your message.';

/** A rival assistant's notice lands in the USER role, after the human's turn. */
const transcript = () => [
  { role: 'user' as const, content: USER_PROMPT },
  { role: 'user' as const, content: PLATFORM_NOTICE },
];

const baseConfig = { model: 'test-model', maxTokens: 1024, userType: 'premium' as const };

/** Blocks only the platform notice, exactly as the deployed guardrail does. */
function guardrailThatBlocksTheNotice() {
  return (cmd: { __cmd: string; input: Record<string, unknown> }) => {
    if (cmd.__cmd === 'ApplyGuardrail') {
      const scored = ((cmd.input.content as Array<{ text?: { text?: string } }>) ?? [])
        .map((c) => c.text?.text ?? '').join('');
      return Promise.resolve(
        scored.includes('Two assistants will answer')
          ? { action: 'GUARDRAIL_INTERVENED', outputs: [{ text: BLOCK_MESSAGE }] }
          : { action: 'NONE' },
      );
    }
    return Promise.resolve({
      output: { message: { content: [{ text: ANSWER }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  };
}

describe('the input guardrail scores the turn, not the transcript tail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GUARDRAIL_ID = 'gr-test';
    process.env.GUARDRAIL_VERSION = '1';
    mockBedrockSend.mockImplementation(guardrailThatBlocksTheNotice());
  });

  it('scores the human turn even when a peer assistant holds the last user-role entry', async () => {
    await invokeBedrock('system', transcript(), { ...baseConfig, userTurnText: USER_PROMPT });

    const scored = mockBedrockSend.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd) => cmd.__cmd === 'ApplyGuardrail' && cmd.input.source === 'INPUT')
      .flatMap((cmd) => (cmd.input.content as Array<{ text?: { text?: string } }>).map((c) => c.text?.text));

    expect(scored).toContain(USER_PROMPT);
    expect(scored).not.toContain(PLATFORM_NOTICE);
  });

  it('returns the model ANSWER, not the guardrail block message', async () => {
    // The assertion the battle e2e was missing. A blocked side still produces an attributed reply, so
    // "two replies arrived" is satisfied either way; only the CONTENT distinguishes a duel from a
    // walkover, and only this catches a side that was killed before its model ran.
    const result = await invokeBedrock('system', transcript(), { ...baseConfig, userTurnText: USER_PROMPT });

    expect(result.response).toBe(ANSWER);
    expect(result.response).not.toBe(BLOCK_MESSAGE);
  });

  it('still blocks when the HUMAN submits the offending text', async () => {
    // The guardrail is not weakened: scoring the right text is the change, not scoring less.
    const result = await invokeBedrock('system', transcript(), { ...baseConfig, userTurnText: PLATFORM_NOTICE });

    expect(result.response).toBe(BLOCK_MESSAGE);
  });

  it('falls back to the transcript tail when the caller cannot name the turn text', async () => {
    // Prior behaviour is preserved for any path that does not set it, so this is additive.
    const result = await invokeBedrock('system', transcript(), { ...baseConfig });

    expect(result.response).toBe(BLOCK_MESSAGE);
  });
});
