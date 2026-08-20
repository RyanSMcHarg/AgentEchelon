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

import { applyOutputGuardrail, GUARDRAIL_BLOCK_FALLBACK } from '../../lambda/src/lib/async-processor-core';
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

  // THE FALLBACK MUST NOT UNDO THE MASK. Stripping the token made an empty masked result reachable
  // for the first time, and the one input that produces it is a reply that was NOTHING BUT the thing
  // the filter matched. `masked || text` returns the raw marker there - the leak the filter exists to
  // prevent, and worse than the token, because the channel flow reads a `corr` marker back out of
  // posted content to map a placeholder.
  it('a reply that was ONLY a leaked marker does not come back as the raw marker', async () => {
    const markerOnly = '<!--ACTIVE_TASK:{"taskId":"t1","status":"in_progress"}-->';
    mockBedrockSend.mockResolvedValueOnce({ action: 'GUARDRAIL_INTERVENED', outputs: [{ text: TOKEN }] });
    const out = await applyOutputGuardrail(markerOnly);
    expect(out).not.toContain('ACTIVE_TASK');
    expect(out).not.toContain('MetadataMarkerFilter');
    expect(out).toBe(GUARDRAIL_BLOCK_FALLBACK);
  });

  it('a corr marker is covered by the same fallback, since the flow reads it back off the wire', async () => {
    mockBedrockSend.mockResolvedValueOnce({ action: 'GUARDRAIL_INTERVENED', outputs: [{ text: `${TOKEN}\n\n${TOKEN}` }] });
    const out = await applyOutputGuardrail('<!--corr:abc-123-->\n\n<!--corr:def-456-->');
    expect(out).not.toContain('corr:');
    expect(out).toBe(GUARDRAIL_BLOCK_FALLBACK);
  });

  // The masked reply is empty only because the marker was the whole of it. Prose that SURVIVES the
  // masking still comes back as prose - the fallback is not allowed to swallow a real answer.
  it('prose surviving beside the token is returned, not replaced by the block copy', async () => {
    mockBedrockSend.mockResolvedValueOnce({
      action: 'GUARDRAIL_INTERVENED',
      outputs: [{ text: `${TOKEN} The report is ready.` }],
    });
    expect(await applyOutputGuardrail('<!--corr:x--> The report is ready.')).toBe('The report is ready.');
  });

  it('an unmasked reply passes through untouched', async () => {
    mockBedrockSend.mockResolvedValueOnce({ action: 'NONE' });
    expect(await applyOutputGuardrail('a plain answer')).toBe('a plain answer');
  });
});
