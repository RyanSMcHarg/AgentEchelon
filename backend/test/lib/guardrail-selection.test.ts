/**
 * Per-assistant guardrail SELECTION at runtime (SPEC-CONFIGURABLE-ASSISTANTS 4.6) + the fail-safe
 * fallback chain. A profile-selected `guardrailId` must override the deployment default and apply its
 * live DRAFT; a SELECTED id that cannot be applied for ANY reason must FALL BACK to the deployment
 * default (never fail open and leave the turn unfiltered); only a genuine outage of the default fails
 * open. Pins the security property a regression could silently erase.
 *
 * "ANY reason" is load-bearing and is why the non-AccessDenied cases below exist. Nothing validates a
 * selected id beyond "non-empty string", and two ordinary situations produce a NON-AccessDenied error:
 * a profile carrying a catalog selection KEY ('strict') rather than a resolved id, and a PORTABLE
 * profile imported from another deployment, whose guardrail id does not name a resource here at all.
 * Both raise ValidationException / ResourceNotFoundException, and gating the fallback on AccessDenied
 * alone let them through completely unfiltered.
 */
const mockBedrockSend = jest.fn();
const mockMessagingSend = jest.fn();
const mockDdbSend = jest.fn();
const mockLambdaSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  ConverseCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Converse', input })),
  ApplyGuardrailCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'ApplyGuardrail', input })),
}), { virtual: true });
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn().mockImplementation(() => ({ send: mockMessagingSend })),
  ListChannelMessagesCommand: jest.fn(), UpdateChannelMessageCommand: jest.fn(),
  SendChannelMessageCommand: jest.fn(), DeleteChannelMessageCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn(), PutObjectCommand: jest.fn() }), { virtual: true });
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: mockLambdaSend })),
  InvokeCommand: jest.fn(), InvocationType: { Event: 'Event' },
}), { virtual: true });
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  ScanCommand: jest.fn(), PutCommand: jest.fn(), UpdateCommand: jest.fn(), GetCommand: jest.fn(), QueryCommand: jest.fn(),
}), { virtual: true });
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }), { virtual: true });
jest.mock('../../lambda/src/lib/company-context', () => ({ loadCompanyContext: jest.fn() }));

import { applyOutputGuardrail, applyInputGuardrail } from '../../lambda/src/lib/async-processor-core';

const accessDenied = () => Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
const validationError = () => Object.assign(new Error('invalid guardrail identifier'), { name: 'ValidationException' });
const notFound = () => Object.assign(new Error('no such guardrail'), { name: 'ResourceNotFoundException' });
const applyCalls = (): Array<Record<string, unknown>> =>
  mockBedrockSend.mock.calls.filter((c) => (c[0] as { __cmd?: string })?.__cmd === 'ApplyGuardrail').map((c) => (c[0] as { input: Record<string, unknown> }).input);

describe('guardrail selection + fail-safe fallback (SPEC-CONFIGURABLE-ASSISTANTS 4.6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GUARDRAIL_ID = 'gr-env';
    process.env.GUARDRAIL_VERSION = '7';
  });
  afterEach(() => { delete process.env.GUARDRAIL_ID; delete process.env.GUARDRAIL_VERSION; });

  it('a profile-selected guardrailId overrides the env default and applies its DRAFT', async () => {
    mockBedrockSend.mockResolvedValueOnce({ action: 'NONE' });
    await applyOutputGuardrail('some reply', 'gr-profile');
    const calls = applyCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].guardrailIdentifier).toBe('gr-profile');
    expect(calls[0].guardrailVersion).toBe('DRAFT');
    expect(calls[0].source).toBe('OUTPUT');
  });

  it('with NO selection uses the deployment default id + its pinned version', async () => {
    mockBedrockSend.mockResolvedValueOnce({ action: 'NONE' });
    await applyInputGuardrail('hello');
    const calls = applyCalls();
    expect(calls[0].guardrailIdentifier).toBe('gr-env');
    expect(calls[0].guardrailVersion).toBe('7');
    expect(calls[0].source).toBe('INPUT');
  });

  it('a SELECTED guardrail that AccessDenies falls back to the default and still masks (never open)', async () => {
    mockBedrockSend
      .mockRejectedValueOnce(accessDenied())
      .mockResolvedValueOnce({ action: 'GUARDRAIL_INTERVENED', outputs: [{ text: 'masked' }] });
    const out = await applyOutputGuardrail('leaky reply', 'gr-unprovisioned');
    const calls = applyCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].guardrailIdentifier).toBe('gr-unprovisioned'); // tried the selection first
    expect(calls[1].guardrailIdentifier).toBe('gr-env');           // fell back to the default
    expect(calls[1].guardrailVersion).toBe('7');
    expect(out).toBe('masked');                                    // filtered by the default, NOT passed open
  });

  it('input: a SELECTED guardrail AccessDenied falls back to the default and can still block', async () => {
    mockBedrockSend
      .mockRejectedValueOnce(accessDenied())
      .mockResolvedValueOnce({ action: 'GUARDRAIL_INTERVENED', outputs: [{ text: 'blocked' }] });
    const res = await applyInputGuardrail('injection attempt', 'gr-unprovisioned');
    expect(res.blocked).toBe(true);
    const calls = applyCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1].guardrailIdentifier).toBe('gr-env');
  });

  it('a SELECTED guardrail that is a catalog KEY (ValidationException) falls back to the default, not open', async () => {
    // A profile authored by hand (or an admin-console picker regression) can carry the catalog's
    // selection key 'strict' instead of the resolved id it publishes. Bedrock rejects it as a
    // malformed identifier - NOT AccessDenied - and the turn must still be filtered by the default.
    mockBedrockSend
      .mockRejectedValueOnce(validationError())
      .mockResolvedValueOnce({ action: 'GUARDRAIL_INTERVENED', outputs: [{ text: 'masked' }] });
    const out = await applyOutputGuardrail('leaky reply', 'strict');
    const calls = applyCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].guardrailIdentifier).toBe('strict');
    expect(calls[1].guardrailIdentifier).toBe('gr-env');
    expect(out).toBe('masked');
  });

  it('an IMPORTED profile whose guardrail id belongs to another deployment (ResourceNotFound) falls back', async () => {
    // The portable-profile path: an exported bundle carries the SOURCE deployment's resolved id, which
    // names no resource in the target. Without the fallback this silently disabled guardrails on every
    // turn for every conversation served by the imported profile.
    mockBedrockSend
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({ action: 'GUARDRAIL_INTERVENED', outputs: [{ text: 'blocked' }] });
    const res = await applyInputGuardrail('injection attempt', 'gr-from-other-deployment');
    expect(res.blocked).toBe(true);
    const calls = applyCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1].guardrailIdentifier).toBe('gr-env');
  });

  it('a genuine outage of the default fails OPEN (never drops a reply)', async () => {
    delete process.env.GUARDRAIL_ID; delete process.env.GUARDRAIL_VERSION;
    mockBedrockSend.mockRejectedValueOnce(Object.assign(new Error('boom'), { name: 'ThrottlingException' }));
    const out = await applyOutputGuardrail('a reply', 'gr-only');
    expect(out).toBe('a reply');
  });

  it('empty text is a no-op (no ApplyGuardrail call at all)', async () => {
    await applyOutputGuardrail('', 'gr-profile');
    expect(await applyInputGuardrail('', 'gr-profile')).toEqual({ blocked: false, message: '' });
    expect(applyCalls()).toHaveLength(0);
  });
});
