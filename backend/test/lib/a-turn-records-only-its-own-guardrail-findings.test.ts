/**
 * A TURN RECORDS ONLY ITS OWN GUARDRAIL FINDINGS.
 *
 * The output guardrail hands its findings to the turn through module state rather than through a
 * changed return type: `applyOutputGuardrail` returns the reply STRING and is called from several
 * places, and widening it to a tuple would touch every caller for a fact one of them wants.
 *
 * That is a safe handoff only while the state is scoped to a turn. A Lambda INVOCATION is one turn,
 * but a CONTAINER is many, and several turn paths never reach the output guardrail at all: an
 * input-guardrail block returns before the model runs, the external-provider path does its own
 * guarding, a failure announcement runs no model. Resetting inside `applyOutputGuardrail` guarded
 * only the path that was already safe. Each of the others read whatever the PREVIOUS turn left behind
 * and stamped it on its own analytics - which, now that guardrail findings ARE the deterministic half
 * of the compliance verdict, means recording another turn's interventions as this assistant's breach.
 *
 * Two properties are pinned:
 *  1. a turn that ran no output guardrail reads nothing, however warm the container;
 *  2. a turn that guards TWICE keeps both sets - a reply and an extracted document are separate
 *     guardrail evaluations, and the second call must not erase what the first found.
 */
const mockBedrockSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: mockBedrockSend })),
  ConverseCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'Converse', input })),
  ApplyGuardrailCommand: jest.fn().mockImplementation((input) => ({ __cmd: 'ApplyGuardrail', input })),
  InvokeModelCommand: jest.fn(),
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

import {
  applyOutputGuardrail,
  beginTurnGuardrailFindings,
  takeOutputGuardrailFindings,
} from '../../lambda/src/lib/async-processor-core';

/** A guardrail response that intervened on one content filter. */
const intervened = (type: string) => ({
  action: 'GUARDRAIL_INTERVENED',
  outputs: [{ text: 'a masked reply' }],
  assessments: [{ contentPolicy: { filters: [{ type, action: 'BLOCKED' }] } }],
});

describe('findings are scoped to the turn, not to the container', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GUARDRAIL_ID = 'gr-env';
    process.env.GUARDRAIL_VERSION = '7';
  });
  afterEach(() => { delete process.env.GUARDRAIL_ID; delete process.env.GUARDRAIL_VERSION; });

  it('does not hand one turn the findings of the turn before it', async () => {
    // Turn 1: the guardrail intervened, and the turn recorded it.
    beginTurnGuardrailFindings();
    mockBedrockSend.mockResolvedValueOnce(intervened('HATE'));
    await applyOutputGuardrail('something', 'gr-1');
    expect(takeOutputGuardrailFindings()).toEqual(['guardrail.output.content.hate']);

    // Turn 2, SAME warm container, and a path that never runs an output guardrail - an input block,
    // the external provider, a failure announcement. It must read nothing.
    beginTurnGuardrailFindings();
    expect(takeOutputGuardrailFindings()).toEqual([]);
  });

  it('drains on read, so a turn that dies before stamping cannot bleed into the next', async () => {
    beginTurnGuardrailFindings();
    mockBedrockSend.mockResolvedValueOnce(intervened('VIOLENCE'));
    await applyOutputGuardrail('something', 'gr-1');
    expect(takeOutputGuardrailFindings()).toEqual(['guardrail.output.content.violence']);
    // The name is `take`. A value still sitting there after being consumed is the residue.
    expect(takeOutputGuardrailFindings()).toEqual([]);
  });

  it('keeps every finding from a turn that guards more than one piece of output', async () => {
    // A turn can guard a reply AND an extracted document. Each is its own guardrail evaluation, and
    // replacing on each call meant the last one silently erased what an earlier one found - so a
    // policy that fired on the document and not on the reply left no trace at all.
    beginTurnGuardrailFindings();
    mockBedrockSend.mockResolvedValueOnce(intervened('HATE'));
    await applyOutputGuardrail('the document', 'gr-1');
    mockBedrockSend.mockResolvedValueOnce(intervened('INSULTS'));
    await applyOutputGuardrail('the reply', 'gr-1');

    const findings = takeOutputGuardrailFindings();
    expect(findings).toContain('guardrail.output.content.hate');
    expect(findings).toContain('guardrail.output.content.insults');
  });

  it('records one fact when the same policy fires on both pieces', async () => {
    beginTurnGuardrailFindings();
    mockBedrockSend.mockResolvedValueOnce(intervened('HATE'));
    await applyOutputGuardrail('the document', 'gr-1');
    mockBedrockSend.mockResolvedValueOnce(intervened('HATE'));
    await applyOutputGuardrail('the reply', 'gr-1');
    expect(takeOutputGuardrailFindings()).toEqual(['guardrail.output.content.hate']);
  });
});
