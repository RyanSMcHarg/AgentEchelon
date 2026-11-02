/**
 * A TURN ACTS AS THE ASSISTANT IT WAS ROUTED TO, AND ONLY THAT ONE (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1b).
 *
 * The router records which bot a turn was routed to. The vend mints a session only from that record,
 * takes the assistant and its role from the assignment records rather than from anyone's say-so, and
 * refuses anything else. The processor sends on that session through `turnAware` clients and drops it
 * between turns.
 */
// Each client's `send` is one jest mock per service, answering by command name. The commands themselves
// are the real ones, so a test reads `.input` exactly as the SDK would send it.
const mockDdbSend = jest.fn();
const mockSsmSend = jest.fn();
const mockStsSend = jest.fn();
const mockLambdaSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/client-dynamodb');
  return { ...actual, DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })) };
});
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn(() => ({ send: mockSsmSend })) };
});
jest.mock('@aws-sdk/client-sts', () => {
  const actual = jest.requireActual('@aws-sdk/client-sts');
  return { ...actual, STSClient: jest.fn(() => ({ send: mockStsSend })) };
});
jest.mock('@aws-sdk/client-lambda', () => {
  const actual = jest.requireActual('@aws-sdk/client-lambda');
  return { ...actual, LambdaClient: jest.fn(() => ({ send: mockLambdaSend })) };
});
jest.unmock('../../lambda/src/lib/assistant-session');
jest.unmock('../../lambda/src/lib/turn-routing');
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

const BOT = 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1/bot/bot-advisor-1234';
const OPS_BOT = 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1/bot/bot-ops-5678';

process.env.CLASSIFICATION = 'premium';
process.env.TURN_ROUTING_TABLE = 'routing-premium';
process.env.ACTING_ROLE_ARN = 'arn:aws:iam::111122223333:role/agent-echelon/assistant/acting';
process.env.SSM_ROOT = '/agent-echelon';
process.env.GRANT_POLICY_PREFIX = 'arn:aws:iam::111122223333:policy/AgentEchelonAssistantGrant-premium-';
process.env.GRANT_EDGES = JSON.stringify(['base', 'speak', 'context', 'platform', 'telemetry', 'models-all', 'models-haiku', 'models-sonnet', 'models-opus', 'models-titan', 'image-stability_image_core', 'image-nova_canvas']);
process.env.GRANT_ROUTED_MODELS = JSON.stringify(['haiku', 'opus']);
process.env.GRANT_DEFAULT_IMAGE_MODEL = 'stability_image_core';

/** Calls of one command type on a send mock, as their inputs. */
const inputsOf = (send: jest.Mock, name: string) =>
  send.mock.calls.map((c) => c[0]).filter((cmd) => cmd?.constructor?.name === name).map((cmd) => cmd.input);

import { handler as vend, resetVendCaches } from '../../lambda/src/assistant-vend';
import { recordTurnRouting, readTurnRouting } from '../../lambda/src/lib/turn-routing';
import {
  vendAssistantSession,
  adoptAssistantSession,
  releaseAssistantSession,
  turnAware,
  holdSessionFor,
  releaseAfterHeldWork,
  AssistantSessionRefused,
} from '../../lambda/src/lib/assistant-session';
import { renderVoice } from '../../lambda/src/lib/voice-fill';
import { runWelcomePromptTurn } from '../../lambda/src/lib/welcome-prompt-turn';
import { resolveContextSources } from '../../lambda/src/lib/context-sources-runtime';
import { parseTemplate } from '../../lambda/src/lib/document-template';
import { shippedMessageTemplates } from '../../lambda/src/lib/shipped-message-templates';

const nowSec = () => Math.floor(Date.now() / 1000);
function routed(botArn: string, classification = 'premium', expiresAt = nowSec() + 600) {
  mockDdbSend.mockResolvedValue({
    Item: {
      correlationId: { S: 'corr-1' },
      botArn: { S: botArn },
      classification: { S: classification },
      createdAt: { S: new Date().toISOString() },
      expiresAt: { N: String(expiresAt) },
    },
  });
}
function assignments() {
  mockSsmSend.mockResolvedValue({
    Parameters: [
      { Value: JSON.stringify({ botArn: BOT, assistant: 'advisor', role: 'primary' }) },
      { Value: JSON.stringify({ botArn: OPS_BOT, assistant: 'ops-premium', role: 'ops' }) },
    ],
  });
}
function stsOk() {
  mockStsSend.mockResolvedValue({
    Credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(Date.now() + 3600_000) },
  });
}

beforeEach(() => {
  mockDdbSend.mockReset(); mockSsmSend.mockReset(); mockStsSend.mockReset(); mockLambdaSend.mockReset();
  resetVendCaches();
  releaseAssistantSession();
});

describe('the vend', () => {
  it('mints a session for the routed bot, tagged with the assistant and role the assignment records name', async () => {
    routed(OPS_BOT); assignments(); stsOk();
    const out = await vend({ correlationId: 'corr-1' });
    expect(out).toMatchObject({ ok: true, assistant: 'ops-premium', role: 'ops', botArn: OPS_BOT });
    const call = inputsOf(mockStsSend, 'AssumeRoleCommand')[0];
    expect(call.RoleArn).toBe(process.env.ACTING_ROLE_ARN);
    expect(call.SourceIdentity).toBe('ops-premium');
    expect(call.Tags).toEqual([
      { Key: 'assistant', Value: 'ops-premium' },
      { Key: 'classification', Value: 'premium' },
      { Key: 'role', Value: 'ops' },
      { Key: 'bot', Value: 'bot-ops-5678' },
    ]);
  });

  it('refuses a turn with no routing record, and assumes nothing', async () => {
    mockDdbSend.mockResolvedValue({});
    assignments(); stsOk();
    expect(await vend({ correlationId: 'corr-1' })).toEqual({ ok: false, reason: 'no routing record for this turn' });
    expect(inputsOf(mockStsSend, 'AssumeRoleCommand')).toHaveLength(0);
  });

  it('refuses an expired record, which TTL deletion has not removed yet', async () => {
    routed(BOT, 'premium', nowSec() - 5); assignments(); stsOk();
    expect((await vend({ correlationId: 'corr-1' })).ok).toBe(false);
  });

  it('refuses a record for another classification', async () => {
    routed(BOT, 'standard'); assignments(); stsOk();
    expect(await vend({ correlationId: 'corr-1' })).toEqual({ ok: false, reason: 'the routing record is for another classification' });
  });

  it('refuses a bot this classification does not assign', async () => {
    routed('arn:aws:chime:us-east-1:111122223333:app-instance/app-1/bot/someone-else'); assignments(); stsOk();
    expect(await vend({ correlationId: 'corr-1' })).toEqual({ ok: false, reason: 'the routed bot is not an assistant of this classification' });
  });

  it('refuses an assistant id that could widen an IAM path', async () => {
    routed(BOT);
    mockSsmSend.mockResolvedValue({
      Parameters: [{ Value: JSON.stringify({ botArn: BOT, assistant: 'advisor/*', role: 'primary' }) }],
    });
    stsOk();
    expect(await vend({ correlationId: 'corr-1' })).toEqual({ ok: false, reason: 'the assistant id is not safe for an IAM path' });
  });

  it('refuses an unoccupied challenger record, which names no assistant', async () => {
    routed(BOT);
    mockSsmSend.mockResolvedValue({
      Parameters: [{ Value: JSON.stringify({ botArn: BOT, assistant: null, role: 'primary' }) }],
    });
    stsOk();
    expect((await vend({ correlationId: 'corr-1' })).ok).toBe(false);
  });

  it('checks the routing record on every call, even when a session is cached', async () => {
    routed(BOT); assignments(); stsOk();
    await vend({ correlationId: 'corr-1' });
    mockDdbSend.mockResolvedValue({});
    expect((await vend({ correlationId: 'corr-2' })).ok).toBe(false);
    expect(inputsOf(mockStsSend, 'AssumeRoleCommand')).toHaveLength(1);
  });
});

describe('the routing record', () => {
  it('records one decision per turn: a second write must name the same bot', async () => {
    mockDdbSend.mockResolvedValue({});
    await recordTurnRouting(new DynamoDBClient({}), 'routing-premium', { correlationId: 'c', botArn: BOT, classification: 'premium' });
    const put = inputsOf(mockDdbSend, 'PutItemCommand')[0];
    expect(put.ConditionExpression).toBe('attribute_not_exists(correlationId) OR botArn = :bot');
    expect(put.ExpressionAttributeValues).toEqual({ ':bot': { S: BOT } });
  });

  it('reads strongly consistent, so a turn routed a moment ago is not refused', async () => {
    routed(BOT);
    await readTurnRouting(new DynamoDBClient({}), 'routing-premium', 'corr-1');
    expect(inputsOf(mockDdbSend, 'GetItemCommand')[0].ConsistentRead).toBe(true);
  });
});

describe('the processor side', () => {
  const vendReply = (body: unknown, functionError?: string) => mockLambdaSend.mockResolvedValue({
    ...(functionError ? { FunctionError: functionError } : {}),
    Payload: Buffer.from(JSON.stringify(body)) as never,
  });

  it('asks the vend synchronously, never as an event that would be retained and replayed', async () => {
    vendReply({ ok: true, assistant: 'advisor', role: 'primary', botArn: BOT,
      credentials: { accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'T', expiration: new Date(Date.now() + 3600_000).toISOString() } });
    const s = await vendAssistantSession('corr-1', { vendArn: 'arn:vend' });
    expect(s).toMatchObject({ assistant: 'advisor', role: 'primary', botArn: BOT });
    expect(inputsOf(mockLambdaSend, 'InvokeCommand')[0].InvocationType).toBe('RequestResponse');
  });

  it('throws on a refusal rather than continuing as some other identity', async () => {
    vendReply({ ok: false, reason: 'no routing record for this turn' });
    await expect(vendAssistantSession('corr-1', { vendArn: 'arn:vend' })).rejects.toBeInstanceOf(AssistantSessionRefused);
    vendReply({}, 'Unhandled');
    await expect(vendAssistantSession('corr-1', { vendArn: 'arn:vend' })).rejects.toBeInstanceOf(AssistantSessionRefused);
  });

  it('sends on the session while one is held, and on the ambient client otherwise', async () => {
    const ambient = { send: jest.fn(async () => 'ambient') };
    const made: Array<{ creds: unknown; send: jest.Mock }> = [];
    const client = turnAware(ambient, (creds) => {
      const c = { creds, send: jest.fn(async () => 'session') };
      made.push(c);
      return c as unknown as typeof ambient;
    });
    expect(await client.send()).toBe('ambient');
    adoptAssistantSession({ assistant: 'advisor', role: 'primary', botArn: BOT, credentials: { accessKeyId: 'A', secretAccessKey: 'S' } });
    expect(await client.send()).toBe('session');
    expect(await client.send()).toBe('session');
    expect(made).toHaveLength(1);
    releaseAssistantSession();
    expect(await client.send()).toBe('ambient');
  });

  it('builds a new client for the next turn\'s session rather than reusing the last one', async () => {
    const made: unknown[] = [];
    const client = turnAware({ send: jest.fn() }, (creds) => { made.push(creds); return { send: jest.fn() } as never; });
    adoptAssistantSession({ assistant: 'advisor', role: 'primary', botArn: BOT, credentials: { accessKeyId: 'A1', secretAccessKey: 'S' } });
    await client.send();
    releaseAssistantSession();
    adoptAssistantSession({ assistant: 'ops-premium', role: 'ops', botArn: OPS_BOT, credentials: { accessKeyId: 'A2', secretAccessKey: 'S' } });
    await client.send();
    expect(made.map((c) => (c as { accessKeyId: string }).accessKeyId)).toEqual(['A1', 'A2']);
  });
});

/**
 * A CALL THAT OUTLIVES ITS DEADLINE FINISHES AS THE ASSISTANT THAT STARTED IT.
 *
 * A voiced send and a welcome prompt race their model call against a deadline and post without it. The call keeps
 * running: its reply arrives later and its OUTPUT guardrail is sent after that. The turn holds its session until that
 * work settles, so the guardrail goes out on the turn's vended session, never on the Lambda's own role (which holds no
 * `ApplyGuardrail` grant) and never on the next turn's session in a warm container.
 */
describe('work a turn stopped waiting for still runs on its session', () => {
  const SESSION = { assistant: 'advisor', role: 'primary', botArn: BOT, credentials: { accessKeyId: 'TURN', secretAccessKey: 'S' } };

  /** A Bedrock-shaped client: which credentials each send went out on, `ambient` for the Lambda's own role. */
  const bedrockLike = () => {
    const sentOn: string[] = [];
    const client = turnAware({ send: jest.fn(async () => { sentOn.push('ambient'); return {}; }) },
      (creds) => ({ send: jest.fn(async () => { sentOn.push(creds.accessKeyId); return {}; }) }) as never);
    return { client, sentOn };
  };

  /** A model call that answers after its deadline, then applies the output guardrail on `client`, as `invokeBedrock` does. */
  const lateCall = (client: { send: (...a: never[]) => unknown }, response: string, afterMs = 30) =>
    async () => {
      await new Promise((r) => setTimeout(r, afterMs));
      await (client.send as () => Promise<unknown>)(); // the OUTPUT ApplyGuardrail
      return { response };
    };

  /** The processor's end of a turn (`endAssistantTurn`): held work settles, then the session is released. */
  const endTurn = releaseAfterHeldWork;

  it('a voiced send past its deadline posts the written text, and the late call\'s guardrail is sent on the turn\'s session', async () => {
    const { client, sentOn } = bedrockLike();
    adoptAssistantSession(SESSION);
    const written = parseTemplate(`---\n${JSON.stringify({ kind: 'message', description: 'd', name: 'workflow-subject-welcome', language: 'en', fill: 'voice', voice: { maxChars: 120, deadlineMs: 1 }, fields: {} })}\n---\n# chat\nWelcome. Ask me anything.\n`);
    const out = await renderVoice({ written, values: {}, target: 'ja', declared: ['en', 'ja'] }, {
      meter: async () => true, invoke: lateCall(client, '{"chat":"ようこそ"}'),
    });
    expect(out.outcome).toBe('fallback:deadline');
    await endTurn();
    // A later turn in the same container acts as someone else; nothing of the first turn reaches it.
    adoptAssistantSession({ ...SESSION, assistant: 'ops-premium', role: 'ops', botArn: OPS_BOT, credentials: { accessKeyId: 'NEXT', secretAccessKey: 'S' } });
    await new Promise((r) => setTimeout(r, 60));
    expect(sentOn).toEqual(['TURN']);
  });

  it('a welcome prompt past its deadline posts nothing, and the late call\'s guardrail is sent on the turn\'s session', async () => {
    const { client, sentOn } = bedrockLike();
    adoptAssistantSession(SESSION);
    const posted: string[] = [];
    const outcome = await runWelcomePromptTurn({ template: 'welcome-greeting', tools: [], values: { topic: 'Q3' }, deadlineMs: 1 },
      shippedMessageTemplates().get('welcome-greeting')!.template,
      { invoke: lateCall(client, 'Hi there'), post: async (c) => { posted.push(c); }, record: () => undefined });
    expect(outcome).toBe('fallback:deadline');
    await endTurn();
    await new Promise((r) => setTimeout(r, 60));
    expect({ sentOn, posted }).toEqual({ sentOn: ['TURN'], posted: [] });
  });

  it('a context read past its deadline finishes on the turn\'s session, and its section is omitted', async () => {
    const { client, sentOn } = bedrockLike();
    adoptAssistantSession(SESSION);
    const sections = await resolveContextSources([{ key: 'k', label: 'K', reader: 'r' } as never], {
      deadlineMs: 1,
      read: async () => { await new Promise((r) => setTimeout(r, 30)); await (client.send as () => Promise<unknown>)(); return { v: 'late' }; },
    } as never);
    expect(sections).toEqual([]);
    await endTurn();
    expect(sentOn).toEqual(['TURN']);
  });

  it('releaseAfterHeldWork lets held work finish on the session, so a later invocation\'s session never carries it', async () => {
    const { client, sentOn } = bedrockLike();
    adoptAssistantSession(SESSION);
    holdSessionFor(lateCall(client, 'x')());
    await releaseAfterHeldWork();
    adoptAssistantSession({ ...SESSION, credentials: { accessKeyId: 'NEXT', secretAccessKey: 'S' } });
    await new Promise((r) => setTimeout(r, 60));
    expect(sentOn).toEqual(['TURN']);
  });

  it('the router ends every invocation through releaseAfterHeldWork, never a bare release', () => {
    const src = (p: string) => require('fs').readFileSync(require('path').join(__dirname, '../../lambda/src', p), 'utf8') as string;
    const router = src('router-agent-handler.ts');
    const handler = router.slice(router.indexOf('export const handler = async (rawEvent'), router.indexOf('const handleTurn = async'));
    // One per event kind the handler routes that adopts a session, and the turn's own.
    expect(handler.match(/await releaseAfterHeldWork\(\);/g)?.length).toBeGreaterThanOrEqual(10);
    expect(handler).not.toMatch(/releaseAssistantSession\(\)/);
  });

  it('the processor ends every turn through endAssistantTurn, which waits for held work before releasing', () => {
    const src = (p: string) => require('fs').readFileSync(require('path').join(__dirname, '../../lambda/src', p), 'utf8') as string;
    const processor = src('assistant-async-processor.ts');
    const core = src('lib/async-processor-core.ts');
    expect(core).toMatch(/export async function endAssistantTurn\(\): Promise<void> \{\s*await releaseAfterHeldWork\(\);/);
    // The three ends of a turn that acted (a turn, a resumed parked turn, the room's naming run); the release below
    // refuses a mismatched bot before any work started.
    expect(processor.match(/await endAssistantTurn\(\);/g)).toHaveLength(3);
    expect(processor.match(/releaseAssistantIdentity\(\);/g)).toHaveLength(1);
  });
});

describe('the vend narrows the session to what the approved definition declares', () => {
  const PREFIX = process.env.GRANT_POLICY_PREFIX as string;
  /** The assignment records, and one active definition for `advisor` at version 7. */
  function withDefinition(definition: Record<string, unknown> | null) {
    mockSsmSend.mockImplementation(async (cmd: { constructor: { name: string }; input: { Name?: string } }) => {
      if (cmd.constructor.name === 'GetParametersByPathCommand') {
        return { Parameters: [{ Value: JSON.stringify({ botArn: BOT, assistant: 'advisor', role: 'primary' }) }] };
      }
      if (!definition) throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
      expect(cmd.input.Name).toBe('/agent-echelon/assistant/advisor/definition:active');
      return { Parameter: { Value: JSON.stringify(definition), Version: 7 } };
    });
  }
  const policyArns = () => (inputsOf(mockStsSend, 'AssumeRoleCommand')[0].PolicyArns as Array<{ arn: string }>).map((p) => p.arn.slice(PREFIX.length));

  it('passes only the edges the definition selects, and returns the version it read', async () => {
    routed(BOT); stsOk();
    withDefinition({ models: { default: 'sonnet' }, tools: ['load_company_context'], contextSources: ['company-docs'] });
    const out = await vend({ correlationId: 'corr-1' });
    expect(out).toMatchObject({ ok: true, definition: { profileName: 'advisor', version: 7 } });
    const edges = policyArns();
    expect(edges).toEqual(expect.arrayContaining(['base', 'context', 'models-sonnet', 'models-haiku', 'models-opus']));
    // No image model is named, so none is granted: no default an assistant did not choose.
    expect(edges.some((e: string) => e.startsWith('image-'))).toBe(false);
    // Not declared, so not reached: the platform's self-knowledge, telemetry, and every other model.
    expect(edges).not.toContain('platform');
    expect(edges).not.toContain('telemetry');
    expect(edges).not.toContain('models-titan');
    expect(edges).not.toContain('models-all');
  });

  it('two assistants of one classification and role reach different context when their definitions differ', async () => {
    routed(BOT); stsOk();
    withDefinition({ models: { default: 'sonnet' }, tools: ['load_platform_info'], contextSources: ['user-profile'] });
    await vend({ correlationId: 'corr-1' });
    expect(policyArns()).not.toContain('context');
    expect(policyArns()).toContain('platform');
  });

  it('a seed definition, which declares nothing, selects everything', async () => {
    routed(BOT); stsOk(); withDefinition(null);
    const out = await vend({ correlationId: 'corr-1' });
    expect(out).toMatchObject({ ok: true });
    expect((out as { definition?: unknown }).definition).toBeUndefined();
    expect(policyArns()).toEqual(expect.arrayContaining(['base', 'context', 'platform', 'telemetry', 'models-all']));
  });

  it('a recorded experiment variant narrows by the variant, not the assistant', async () => {
    mockDdbSend.mockResolvedValue({
      Item: {
        correlationId: { S: 'corr-1' }, botArn: { S: BOT }, classification: { S: 'premium' },
        createdAt: { S: new Date().toISOString() }, expiresAt: { N: String(nowSec() + 600) },
        variant: { S: JSON.stringify({ modelKeys: ['titan'], imageModelKey: 'nova_canvas' }) },
      },
    });
    stsOk(); withDefinition({ models: { default: 'sonnet' }, tools: [] });
    await vend({ correlationId: 'corr-1' });
    const edges = policyArns();
    expect(edges).toContain('image-nova_canvas');
    // The variant's model is reached: by its own edge, or by models-all when it completes the set.
    expect(edges.includes('models-titan') || edges.includes('models-all')).toBe(true);
  });

  it('versions with no active label read as absent, which is what SSM answers for the alt (ParameterVersionNotFound)', async () => {
    // Measured 2026-10-13: the alt's versions are published unlabelled, and `definition:active` on such a
    // parameter answers ParameterVersionNotFound. Treated as a failure, it refused every alt turn.
    routed(BOT); stsOk();
    mockSsmSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetParametersByPathCommand') {
        return { Parameters: [{ Value: JSON.stringify({ botArn: BOT, assistant: 'advisor', role: 'primary' }) }] };
      }
      throw Object.assign(new Error('version not found'), { name: 'ParameterVersionNotFound' });
    });
    expect(await vend({ correlationId: 'corr-1' })).toMatchObject({ ok: true });
  });

  it('refuses when the definition read fails for any reason but absence', async () => {
    routed(BOT); stsOk();
    mockSsmSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetParametersByPathCommand') {
        return { Parameters: [{ Value: JSON.stringify({ botArn: BOT, assistant: 'advisor', role: 'primary' }) }] };
      }
      throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    });
    await expect(vend({ correlationId: 'corr-1' })).resolves.toMatchObject({ ok: false });
    expect(inputsOf(mockStsSend, 'AssumeRoleCommand')).toHaveLength(0);
  });
});

describe('an alt with no pinned version (ADR-050)', () => {
  const ALT_BOT = 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1/bot/bot-alt-7777';
  const PREFIX = process.env.GRANT_POLICY_PREFIX as string;
  function altAssigned() {
    mockSsmSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetParametersByPathCommand') {
        return { Parameters: [
          { Value: JSON.stringify({ botArn: BOT, assistant: 'advisor', role: 'primary', occupancy: 'live' }) },
          { Value: JSON.stringify({ botArn: ALT_BOT, assistant: 'alt-primary-premium', role: 'primary', occupancy: 'alt' }) },
        ] };
      }
      // Its versions are unlabelled, which SSM answers like this.
      throw Object.assign(new Error('version not found'), { name: 'ParameterVersionNotFound' });
    });
  }

  it('posts for its duel on a speak route, with the speak edge alone', async () => {
    // The router posts as the alt on a speak route, so it never holds the alt's turn session.
    routed(ALT_BOT); stsOk(); altAssigned();
    const out = await vend({ correlationId: 'speak-router-0f2c' });
    expect(out).toMatchObject({ ok: true, assistant: 'alt-primary-premium' });
    const arns = (inputsOf(mockStsSend, 'AssumeRoleCommand')[0].PolicyArns as Array<{ arn: string }>).map((p) => p.arn.slice(PREFIX.length));
    expect(arns).toEqual(['speak']);
  });

  it('is refused a turn session, which would otherwise narrow by nothing', async () => {
    routed(ALT_BOT); stsOk(); altAssigned();
    expect(await vend({ correlationId: 'corr-1' })).toEqual({ ok: false, reason: 'the alt has no pinned version for this turn' });
    expect(inputsOf(mockStsSend, 'AssumeRoleCommand')).toHaveLength(0);
  });
});

describe('a runtime assistant is vended from its own record (ADR-048)', () => {
  const RUNTIME_BOT = 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1/bot/bot-finance-9999';
  const record = (over: Record<string, unknown> = {}) => ({
    classification: 'premium', role: 'primary', occupancy: 'live', assistant: 'finance-advisor', botArn: RUNTIME_BOT,
    source: 'runtime', status: 'active', displayName: 'Finance',
    descriptor: { modelKey: 'sonnet', classifierMode: 'llm', rateLimitPerHour: 120 }, ...over,
  });
  function assign(rec: Record<string, unknown>, definition: Record<string, unknown> | null) {
    mockSsmSend.mockImplementation(async (cmd: { constructor: { name: string }; input: { Name?: string } }) => {
      if (cmd.constructor.name === 'GetParametersByPathCommand') {
        return { Parameters: [
          { Value: JSON.stringify({ botArn: BOT, assistant: 'advisor', role: 'primary', occupancy: 'live' }) },
          { Value: JSON.stringify(rec) },
        ] };
      }
      if (!definition) throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
      expect(cmd.input.Name).toBe('/agent-echelon/assistant/finance-advisor/definition:active');
      return { Parameter: { Value: JSON.stringify(definition), Version: 2 } };
    });
  }

  it('mints a session tagged with its own name, narrowed by its active version, and hands over its seed', async () => {
    routed(RUNTIME_BOT); stsOk();
    assign(record(), { models: { default: 'sonnet' } });
    const out = await vend({ correlationId: 'corr-1' });
    expect(out).toMatchObject({
      ok: true, assistant: 'finance-advisor', role: 'primary',
      definition: { profileName: 'finance-advisor', version: 2 },
      seed: { name: 'finance-advisor', displayName: 'Finance', modelKey: 'sonnet', classifierMode: 'llm', rateLimitPerHour: 120 },
    });
    expect(inputsOf(mockStsSend, 'AssumeRoleCommand')[0].SourceIdentity).toBe('finance-advisor');
  });

  it('refuses one with no active version: there is no seed whose behavior could stand in', async () => {
    routed(RUNTIME_BOT); stsOk();
    assign(record(), null);
    expect(await vend({ correlationId: 'corr-1' })).toEqual({ ok: false, reason: 'the runtime assistant has no active version' });
    expect(inputsOf(mockStsSend, 'AssumeRoleCommand')).toHaveLength(0);
  });

  it('refuses one with no active version on a speak route too, so nothing posts in its name', async () => {
    // A fallback that posted as it would mask the fault; the router names it and reports it instead.
    routed(RUNTIME_BOT); stsOk();
    assign(record(), null);
    expect(await vend({ correlationId: 'speak-router-1' })).toEqual({ ok: false, reason: 'the runtime assistant has no active version' });
    expect(inputsOf(mockStsSend, 'AssumeRoleCommand')).toHaveLength(0);
  });

  it('refuses a retiring one, which reads as absent', async () => {
    routed(RUNTIME_BOT); stsOk();
    assign(record({ status: 'retiring' }), { models: { default: 'sonnet' } });
    expect(await vend({ correlationId: 'corr-1' })).toEqual({ ok: false, reason: 'the routed bot is not an assistant of this classification' });
  });

  it('refuses a runtime record that takes a reserved name', async () => {
    routed(RUNTIME_BOT); stsOk();
    assign(record({ assistant: 'alt-primary-premium' }), { models: { default: 'sonnet' } });
    expect((await vend({ correlationId: 'corr-1' })).ok).toBe(false);
  });

  it('the session carries the seed through to the processor', async () => {
    mockLambdaSend.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({
      ok: true, assistant: 'finance-advisor', role: 'primary', botArn: RUNTIME_BOT,
      seed: { name: 'finance-advisor', modelKey: 'sonnet', classifierMode: 'llm', timeoutSeconds: 60, contextScope: 'granted' },
      credentials: { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't', expiration: new Date(Date.now() + 3600_000).toISOString() },
    })) });
    const session = await vendAssistantSession('corr-1', { vendArn: 'arn:vend' });
    expect(session.seed?.name).toBe('finance-advisor');
  });
});
