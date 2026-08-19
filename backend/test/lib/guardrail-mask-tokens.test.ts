/**
 * A GUARDRAIL MASK IS A USER-VISIBLE STRING, and for an internal-marker filter it is a leak.
 *
 * Amazon Bedrock Guardrails replaces an `ANONYMIZE` match with the literal `{FILTER_NAME}`. The
 * default policy declares a regex filter named `MetadataMarkerFilter` over `<!--ACTIVE_TASK|corr-->`,
 * so a control marker the model leaked came back as the literal `{MetadataMarkerFilter}` and reached
 * the person at the end of a report reply. `stripMessageMarkers` could not help: the text it matches
 * on was rewritten by the guardrail before the runtime ever saw the response.
 *
 * Three properties are pinned here:
 *  1. the provisioned filter NAME and the stripped TOKEN come from one declaration, so they cannot
 *     drift apart;
 *  2. the class is closed - a new internal-marker regex filter added to the policy without being
 *     declared fails this file rather than shipping a new visible token;
 *  3. the strip happens at the guardrail boundary, so no surface downstream stores or renders one.
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

import { applyOutputGuardrail } from '../../lambda/src/lib/async-processor-core';
import { buildGuardrailPolicy } from '../../lib/constructs/bedrock-guardrails';
import { guardrailCatalog } from '../../lib/config/guardrail-catalog';
import {
  METADATA_MARKER_FILTER_NAME,
  INTERNAL_MARKER_MASK_FILTER_NAMES,
  guardrailMaskToken,
} from '../../lib/config/guardrail-masks';

type RegexFilter = { name: string; action?: string };
const regexFilters = (policy: { sensitiveInformationPolicyConfig?: unknown }): RegexFilter[] =>
  ((policy.sensitiveInformationPolicyConfig as { regexesConfig?: RegexFilter[] })?.regexesConfig) ?? [];

describe('the provisioned filter name and the stripped token are ONE declaration', () => {
  it('the policy provisions the metadata filter under the shared name', () => {
    const names = regexFilters(buildGuardrailPolicy({ name: 'x' })).map((f) => f.name);
    expect(names).toContain(METADATA_MARKER_FILTER_NAME);
  });

  it('every guardrail in the catalog uses the same name (a stricter variant is not a second token)', () => {
    for (const entry of guardrailCatalog('agent-echelon')) {
      for (const filter of regexFilters(entry.policy)) {
        expect(INTERNAL_MARKER_MASK_FILTER_NAMES).toContain(filter.name);
      }
    }
  });

  it('closes the CLASS: an ANONYMIZE regex filter not declared here would ship a visible token', () => {
    // The failure this prevents is the original one arriving under a new name. A regex filter added
    // to the policy for a new internal marker masks into `{ItsName}` exactly the same way, and only
    // an enumerated class strips it. Declare the name in `config/guardrail-masks`, or give the
    // filter a BLOCK action, which produces no token.
    const anonymizing = regexFilters(buildGuardrailPolicy({ name: 'x' }))
      .filter((f) => f.action === 'ANONYMIZE')
      .map((f) => f.name);
    expect(anonymizing.length).toBeGreaterThan(0);
    for (const name of anonymizing) expect(INTERNAL_MARKER_MASK_FILTER_NAMES).toContain(name);
  });
});

describe('the mask never leaves the guardrail boundary', () => {
  const TOKEN = guardrailMaskToken(METADATA_MARKER_FILTER_NAME);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GUARDRAIL_ID = 'gr-env';
    process.env.GUARDRAIL_VERSION = '7';
  });
  afterEach(() => { delete process.env.GUARDRAIL_ID; delete process.env.GUARDRAIL_VERSION; });

  it('strips the mask token out of a masked reply (the live symptom)', async () => {
    mockBedrockSend.mockResolvedValueOnce({
      action: 'GUARDRAIL_INTERVENED',
      outputs: [{ text: `Here is the summary in this condensed 1-2 page report format.${TOKEN}` }],
    });
    const out = await applyOutputGuardrail('Here is the summary in this condensed 1-2 page report format.<!--ACTIVE_TASK:{"taskId":"t1"}-->');
    expect(out).toBe('Here is the summary in this condensed 1-2 page report format.');
    expect(out).not.toContain('MetadataMarkerFilter');
  });

  it('keeps a PII mask, which is the intended output of an ANONYMIZE entity rule', async () => {
    mockBedrockSend.mockResolvedValueOnce({
      action: 'GUARDRAIL_INTERVENED',
      outputs: [{ text: 'Reach the team at {EMAIL}.' }],
    });
    expect(await applyOutputGuardrail('Reach the team at a@b.com.')).toBe('Reach the team at {EMAIL}.');
  });

  it('an intervention with nothing but the token still returns a reply (never drops one)', async () => {
    mockBedrockSend.mockResolvedValueOnce({ action: 'GUARDRAIL_INTERVENED', outputs: [{ text: TOKEN }] });
    expect(await applyOutputGuardrail('original text')).toBe('original text');
  });

  it('an unmasked reply passes through untouched', async () => {
    mockBedrockSend.mockResolvedValueOnce({ action: 'NONE' });
    expect(await applyOutputGuardrail('a plain answer')).toBe('a plain answer');
  });
});
