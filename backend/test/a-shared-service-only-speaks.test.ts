/**
 * A SHARED SERVICE ONLY SPEAKS, AND NO SHARED PRINCIPAL HOLDS A CLASSIFICATION'S TURN
 * (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION, Phase 1c).
 *
 * The channel flow, Battle Mode, notifications and post-processing serve every classification. Each posts
 * as an assistant through a session the vend mints from a routing record the service writes itself. Before
 * this phase the vend narrowed that session by the assistant's definition alone, so a record written to
 * post a notice yielded the same session a turn gets: models, company context, telemetry.
 *
 * Pinned here:
 * - a `speak-` route vends exactly the speak edge, and the speak edge grants exactly the speak actions;
 * - every service that speaks outside a turn writes a `speak-` route;
 * - every routing-table write outside a classification stack carries the speak-only key condition, and
 *   the vend invoke for a single-classification caller is scoped by the classification tag;
 * - a duel's rebuttal round is recorded by the classification's router, which refuses anything but a
 *   rebuttal for its own classification;
 * - each turn data plane reads only its own classification's routing table.
 */
const mockDdbSend = jest.fn();
const mockSsmSend = jest.fn();
const mockStsSend = jest.fn();
const mockLambdaSend = jest.fn();
const mockChimeSend = jest.fn();
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
jest.mock('@aws-sdk/client-chime-sdk-messaging', () => {
  const actual = jest.requireActual('@aws-sdk/client-chime-sdk-messaging');
  return { ...actual, ChimeSDKMessagingClient: jest.fn(() => ({ send: mockChimeSend })) };
});
const mockDocSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return { ...actual, DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDocSend })) } };
});
// THE SIDE A ROUND SERVES, as the router re-resolves it from the experiment's pins (never the payload).
const mockSides = jest.fn(async (..._a: unknown[]) => ({ self: null, rival: null }) as unknown);
jest.mock('../lambda/src/lib/battle-turn', () => {
  const actual = jest.requireActual('../lambda/src/lib/battle-turn');
  return { ...actual, resolveDuelSides: (...a: unknown[]) => mockSides(...a) };
});
jest.unmock('../lambda/src/lib/assistant-session');
jest.unmock('../lambda/src/lib/turn-routing');

import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

const BOT = 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1/bot/bot-advisor-1234';
const PREFIX = 'arn:aws:iam::111122223333:policy/AgentEchelonAssistantGrant-premium-';

process.env.CLASSIFICATION = 'premium';
process.env.TURN_ROUTING_TABLE = 'routing-premium';
process.env.ACTING_ROLE_ARN = 'arn:aws:iam::111122223333:role/agent-echelon/assistant/acting';
process.env.SSM_ROOT = '/agent-echelon';
process.env.GRANT_POLICY_PREFIX = PREFIX;
process.env.GRANT_EDGES = JSON.stringify(['base', 'context', 'platform', 'telemetry', 'models-all', 'speak']);
process.env.GRANT_ROUTED_MODELS = JSON.stringify(['haiku']);
process.env.TURN_ROUTING_TABLE_PREFIX = 'agent-echelon-turn-routing-';
process.env.BOT_ARN_PARAM = '/agent-echelon/premium/bot-arn';
process.env.BATTLE_STATE_TABLE = 'battle-state';

import { SPEAK_ACTIONS, SPEAK_EDGE, SPEAK_ROUTE_PREFIX, isSpeakRoute } from '../lambda/src/lib/assistant-grant';
import { handler as vend, resetVendCaches } from '../lambda/src/assistant-vend';
import { messagingClientAsAssistant, adoptSessionAsAssistant, releaseAssistantSession } from '../lambda/src/lib/assistant-session';
import { dispatchRebuttalRound, clearDuelMarkers } from '../lambda/src/router-agent-handler';
import { INSTANCE_NAME, ownInstanceFunctions, speakAsAssistantStatements, SPEAK_ROUTES_ONLY } from '../lib/stacks/agent-classification-common';
import { assistantsOf } from './helpers/assistants';
import { testMessageStream } from './helpers/synth';
import { assistantClassifications } from '../lib/config/profiles';

const inputsOf = (send: jest.Mock, name: string) =>
  send.mock.calls.map((c) => c[0]).filter((cmd) => cmd?.constructor?.name === name).map((cmd) => cmd.input);

const nowSec = () => Math.floor(Date.now() / 1000);
function routed(correlationId: string) {
  mockDdbSend.mockResolvedValue({
    Item: {
      correlationId: { S: correlationId },
      botArn: { S: BOT },
      classification: { S: 'premium' },
      createdAt: { S: new Date().toISOString() },
      expiresAt: { N: String(nowSec() + 600) },
    },
  });
}

beforeEach(() => {
  for (const m of [mockDdbSend, mockSsmSend, mockStsSend, mockLambdaSend, mockChimeSend]) m.mockReset();
  resetVendCaches();
  releaseAssistantSession();
});

describe('a speak route vends the speak edge and nothing a turn reaches', () => {
  beforeEach(() => {
    mockSsmSend.mockResolvedValue({ Parameters: [{ Value: JSON.stringify({ botArn: BOT, assistant: 'advisor', role: 'primary' }) }] });
    mockStsSend.mockResolvedValue({
      Credentials: { AccessKeyId: 'AKIA', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(Date.now() + 3600_000) },
    });
  });

  it('a speak- route is narrowed to exactly the speak policy', async () => {
    routed(`${SPEAK_ROUTE_PREFIX}briefing-1`);
    const out = await vend({ correlationId: `${SPEAK_ROUTE_PREFIX}briefing-1` });
    expect(out).toMatchObject({ ok: true, grants: [SPEAK_EDGE] });
    expect(inputsOf(mockStsSend, 'AssumeRoleCommand')[0].PolicyArns).toEqual([{ arn: `${PREFIX}${SPEAK_EDGE}` }]);
  });

  it('a turn route keeps the definition edges, so the prefix is the only thing that narrows', async () => {
    routed('corr-1');
    const out = await vend({ correlationId: 'corr-1' });
    expect(out.ok).toBe(true);
    expect((out as { grants: string[] }).grants).not.toContain(SPEAK_EDGE);
    expect((out as { grants: string[] }).grants).toContain('base');
  });

  it('only the prefix makes a speak route', () => {
    expect(isSpeakRoute('speak-flow-1')).toBe(true);
    expect(isSpeakRoute('flow-speak-1')).toBe(false);
    expect(isSpeakRoute('')).toBe(false);
  });
});

describe('every service that speaks outside a turn writes a speak route', () => {
  const vendOk = () => mockLambdaSend.mockResolvedValue({
    Payload: Buffer.from(JSON.stringify({
      ok: true, assistant: 'advisor', role: 'primary', botArn: BOT, grants: ['speak'],
      credentials: { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't', expiration: new Date(Date.now() + 3600_000).toISOString() },
    })),
  });

  it('messagingClientAsAssistant and adoptSessionAsAssistant both record speak- keys', async () => {
    vendOk();
    mockSsmSend.mockResolvedValue({ Parameter: { Value: 'arn:aws:lambda:us-east-1:111122223333:function:vend' } });
    mockDdbSend.mockResolvedValue({});
    await messagingClientAsAssistant({ botArn: BOT, classification: 'premium', purpose: 'briefing' });
    await adoptSessionAsAssistant({ botArn: BOT, classification: 'premium', purpose: 'triage' });
    const keys = inputsOf(mockDdbSend, 'PutItemCommand').map((i) => i.Item.correlationId.S as string);
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k.startsWith(SPEAK_ROUTE_PREFIX)).toBe(true);
  });

  it('neither the orchestrator nor the flow mints a speak id; the router posts a duel\'s lines on its own (source)', () => {
    const src = (f: string) => fs.readFileSync(path.join(__dirname, '../lambda/src', f), 'utf8');
    // The flow and the orchestrator speak as no assistant: no session, no routing record. The orchestrator
    // builds no message either.
    for (const f of ['channel-flow-processor.ts', 'battle-orchestrator.ts']) {
      expect([f, /sessionForRoutedAssistant|SPEAK_ROUTE_PREFIX/.test(src(f))]).toEqual([f, false]);
    }
    expect(src('battle-orchestrator.ts')).not.toMatch(/SendChannelMessageCommand|UpdateChannelMessageCommand|battlePlaceholderContent\(/);
    // The round is handed to the router, which posts its placeholder; the closing lines are notices.
    expect(src('battle-orchestrator.ts')).toContain('aeRebuttal');
    expect(src('battle-orchestrator.ts')).toContain('sayThroughRouter(');
    // The router posts the placeholder and clears markers on speak routes of its own.
    expect(src('router-agent-handler.ts').match(/routeId: `\$\{SPEAK_ROUTE_PREFIX\}duel-/g)).toHaveLength(2);
  });

  it('the modules that send on a speak session make only the speak calls', () => {
    // Each sends every Amazon Chime SDK call on the adopted or handed speak session.
    for (const f of ['lib/turn-queue-notice.ts', 'lib/queue-drain-task.ts', 'lib/battle-waiting-marker.ts']) {
      const used = new Set((fs.readFileSync(path.join(__dirname, '../lambda/src', f), 'utf8').match(/new (\w+ChannelMessage)Command/g) ?? [])
        .map((m) => `chime:${m.slice(4, -'Command'.length)}`));
      for (const action of used) expect([f, (SPEAK_ACTIONS as readonly string[]).includes(action)]).toEqual([f, true]);
    }
  });

  it('share and the archive name their lines to the router and post nothing themselves', () => {
    // The join line and the archived line are notices the router says (`sayThroughRouter`), and share's
    // recap is a turn by the room's assistant (`lib/join-recap.ts`), so neither holds a speak session.
    for (const file of ['share-conversation/index.js', 'src/conversation-management.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '../lambda', file), 'utf8');
      expect([file, src.includes('sayThroughRouter(')]).toEqual([file, true]);
      expect([file, /messagingClientAsAssistant|SendChannelMessageCommand/.test(src)]).toEqual([file, false]);
    }
  });
});

describe('IAM lets a shared service write only speak routes', () => {
  it('speakAsAssistantStatements conditions the write on the key and the vend invoke on the tags', () => {
    const stack = new cdk.Stack(new cdk.App(), 'S', { env: { account: '111122223333', region: 'us-east-1' } });
    const [write, , invoke] = speakAsAssistantStatements(stack, ['basic']).map((s) => s.toStatementJson());
    expect(write.Condition).toEqual(SPEAK_ROUTES_ONLY);
    expect(write.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys']).toEqual([`${SPEAK_ROUTE_PREFIX}*`]);
    // This instance's vends of the named classifications: the prefix pattern alone also matches an
    // instance whose prefix starts with this one.
    expect(invoke.Condition).toEqual(ownInstanceFunctions(['basic']));
    expect(invoke.Condition).toEqual({ StringEquals: { 'aws:ResourceTag/Instance': INSTANCE_NAME, 'aws:ResourceTag/classification': ['basic'] } });
  });

  it('no stack outside a classification stack writes a routing table without the speak-only condition (source)', () => {
    const dir = path.join(__dirname, '../lib/stacks');
    const writers = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')).filter((f) => {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      return /dynamodb:PutItem/.test(src) && /turn-routing-|turnRoutingTableName\(/.test(src);
    });
    // The classification stack's router writes turn records into its own table; everything else is shared.
    // assistant-profile-stack.ts IS the classification stack: its router writes turn records into its own table.
    // The channel flow and the battle orchestrator write no routing record: they speak as no assistant.
    expect(writers.sort()).toEqual(['agent-classification-common.ts', 'assistant-profile-stack.ts']);
  });

  const tableWrites = (tpl: Template) => {
    const stmts: any[] = [];
    for (const r of Object.values(tpl.toJSON().Resources ?? {}) as any[]) {
      const docs = [...(r.Properties?.Policies ?? []).map((p: any) => p.PolicyDocument), r.Properties?.PolicyDocument].filter(Boolean);
      for (const d of docs) stmts.push(...(d.Statement ?? []));
    }
    return stmts.filter((s) => [s.Action].flat().includes('dynamodb:PutItem') && JSON.stringify(s.Resource).includes('turn-routing'));
  };

  it('the synthesized battle roles and the flow write no routing record', async () => {
    const env = { account: '123456789012', region: 'us-east-1' };
    const appInstanceArn = 'arn:aws:chime:us-east-1:123456789012:app-instance/test';
    const { BattleStack } = await import('../lib/stacks/battle-stack');
    const { ChannelFlowStack } = await import('../lib/stacks/channel-flow-stack');
    const battle = Template.fromStack(new BattleStack(new cdk.App(), 'AgentEchelonBattle', { env, appInstanceArn, userPoolId: 'us-east-1_x', appUrl: 'https://app.example.com' } as never));
    const flow = Template.fromStack(new ChannelFlowStack(new cdk.App(), 'AgentEchelonChannelFlow', { env, classifications: assistantClassifications(), appInstanceArn } as never));
    expect(tableWrites(battle)).toEqual([]);
    expect(tableWrites(flow)).toEqual([]);
  });

  it('the orchestrator reads the version each duel side serves, under the path wildcard, and nothing else there', async () => {
    // A rebuttal round carries its side's variant and the vend narrows to it; without this read the alt's
    // pin resolved to nothing and every alt rebuttal was refused (measured live 2026-10-13).
    const env = { account: '123456789012', region: 'us-east-1' };
    const { BattleStack } = await import('../lib/stacks/battle-stack');
    const tpl = Template.fromStack(new BattleStack(new cdk.App(), 'AgentEchelonBattle', {
      env, appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test', userPoolId: 'us-east-1_x', appUrl: 'https://app.example.com',
    } as never));
    const roles = Object.entries(tpl.toJSON().Resources as Record<string, any>)
      .filter(([id, r]) => r.Type === 'AWS::IAM::Role' && id.startsWith('BattleOrchestratorRole'));
    expect(roles).toHaveLength(1);
    const definitionReads = (roles[0][1].Properties.Policies as any[])
      .flatMap((p) => p.PolicyDocument.Statement)
      .flatMap((s: any) => [s.Resource].flat())
      .map((r: unknown) => JSON.stringify(r))
      .filter((r: string) => r.includes('/definition'));
    // Any assistant's definition, so a duel in a classification declared later is read with no edit: the live
    // assistant's and the alt's are both under it. No list of assistant names.
    expect(definitionReads).toEqual([expect.stringContaining('/assistant/*/definition')]);
    const statement = (roles[0][1].Properties.Policies as any[]).flatMap((p) => p.PolicyDocument.Statement)
      .find((s: any) => JSON.stringify(s.Resource).includes('/definition'));
    expect([statement.Action].flat()).toEqual(['ssm:GetParameter']);
  });
});

describe('the speak edge grants exactly the speak actions', () => {
  it('the classification stack creates it', async () => {
    const stack = assistantsOf('basic')(new cdk.App(), 'AgentEchelonAssistants-basic', {
      env: { account: '123456789012', region: 'us-east-1' },
      appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
      attachmentsBucketName: 'test-bucket',
      attachmentsBucketArn: 'arn:aws:s3:::test-bucket',
    } as never);
    const policies = Object.values(Template.fromStack(stack).findResources('AWS::IAM::ManagedPolicy')) as any[];
    const speak = policies.find((p) => String(p.Properties.ManagedPolicyName).endsWith(`AssistantGrant-basic-${SPEAK_EDGE}`));
    expect(speak).toBeDefined();
    const actions = speak.Properties.PolicyDocument.Statement.flatMap((s: any) => [s.Action].flat());
    expect(actions.sort()).toEqual([...SPEAK_ACTIONS].sort());
  });
});

describe('each turn data plane reads only its own routing table', () => {
  it('a role per classification, each granted its own table, each in its classification\'s own stack', async () => {
    const { ArchiveStackAurora } = await import('../lib/stacks/archive-stack-aurora');
    const { assistantsOf } = await import('./helpers/assistants');
    const { CLASSIFICATION_TEST_PROPS } = await import('./helpers/synth');
    const app = new cdk.App();
    const archive = new ArchiveStackAurora(app, 'TestArchiveAurora', {
      env: { account: '123456789012', region: 'us-east-1' },
      appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
      messageStream: testMessageStream(app),
      userPoolId: 'us-east-1_TestPoolId',
    });
    const classifications = ['basic', 'premium'];
    const stacks = classifications.map((c) => assistantsOf(c)(app, `TestTurnDataPlane-${c}`, {
      ...CLASSIFICATION_TEST_PROPS, auroraDriftHookup: { rdsProxy: false, liveDrift: false },
    } as never));
    const turnDataPlanes = (res: Record<string, any>) => Object.values(res)
      .filter((r) => r.Type === 'AWS::Lambda::Function' && r.Properties?.Environment?.Variables?.DATA_PLANE_CLASSIFICATION);
    // The archive builds none: each classification's is its own stack's.
    expect(turnDataPlanes(Template.fromStack(archive).toJSON().Resources)).toEqual([]);
    stacks.forEach((stack, i) => {
      const c = classifications[i];
      const res = Template.fromStack(stack).toJSON().Resources as Record<string, any>;
      const fns = turnDataPlanes(res);
      expect([c, fns.map((fn) => fn.Properties.Environment.Variables.DATA_PLANE_CLASSIFICATION)]).toEqual([c, [c]]);
      const roleId = fns[0].Properties.Role['Fn::GetAtt'][0];
      const stmts = Object.values(res)
        .filter((r) => r.Type === 'AWS::IAM::Policy' && JSON.stringify(r.Properties.Roles).includes(`"${roleId}"`))
        .flatMap((r) => r.Properties.PolicyDocument.Statement);
      const reads = stmts.filter((st) => [st.Action].flat().includes('dynamodb:GetItem') && JSON.stringify(st.Resource).includes('turn-routing'));
      expect([c, reads.length]).toEqual([c, 1]);
      expect([c, JSON.stringify(reads[0].Resource)]).toEqual([c, expect.stringContaining(`turn-routing-${c}`)]);
      expect([c, (JSON.stringify(reads[0].Resource).match(/turn-routing-/g) ?? []).length]).toEqual([c, 1]);
    });
  });
});

describe('a rebuttal round is recorded by the classification router', () => {
  const round = (over: Record<string, unknown> = {}) => ({
    correlationId: 'corr-r2', botArn: BOT, channelArn: 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1/channel/c1',
    classification: 'premium', trigger: 'rebuttal', deliveryOption: 'PLACEHOLDER_UPDATE',
    battleContext: { battleId: 'b1', round: 2 }, routedVariant: { modelKeys: ['haiku'] }, ...over,
  });

  it('refuses another classification, a round-1 shape, or a task delivery, and writes nothing', async () => {
    for (const bad of [round({ classification: 'standard' }), round({ battleContext: { round: 1 } }), round({ deliveryOption: 'TASK_MULTI_STEP' }), round({ trigger: 'user' })]) {
      expect((await dispatchRebuttalRound(bad)).dispatched).toBe(false);
    }
    expect(inputsOf(mockDdbSend, 'PutItemCommand')).toHaveLength(0);
    expect(inputsOf(mockLambdaSend, 'InvokeCommand')).toHaveLength(0);
  });

  it('refuses a conversation of another classification', async () => {
    mockChimeSend.mockResolvedValue({ Tags: [{ Key: 'classification', Value: 'basic' }] });
    expect(await dispatchRebuttalRound(round())).toEqual({ dispatched: false, reason: 'the conversation is not this classification' });
    expect(inputsOf(mockDdbSend, 'PutItemCommand')).toHaveLength(0);
  });

  // The duel's state the router validates against (step 36): the fan-out was claimed, the side finished.
  const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1/channel/c1';
  const RIVAL = 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1/bot/bot-rival-5678';
  const duelRows = (over: Array<Record<string, unknown>> = []) => [
    { battleId: 'b1', botArn: '__round1__', channelArn: CHANNEL },
    { battleId: 'b1', botArn: '__orchestrator__', state: 'COMPLETED' },
    { battleId: 'b1', botArn: BOT, state: 'COMPLETED' },
    { battleId: 'b1', botArn: RIVAL, state: 'COMPLETED' },
    ...over,
  ];
  const VEND = 'arn:aws:lambda:us-east-1:111122223333:function:vend';
  const routerReady = (rows: Array<Record<string, unknown>>) => {
    process.env.ASSISTANT_VEND_ARN = VEND;
    mockDocSend.mockReset().mockResolvedValue({ Items: rows });
    mockChimeSend.mockImplementation(async (cmd: any) => (cmd?.constructor?.name === 'SendChannelMessageCommand'
      ? { MessageId: 'placeholder-1' }
      : { Tags: [{ Key: 'classification', Value: 'premium' }] }));
    mockSsmSend.mockImplementation(async (cmd: any) => {
      const name = String(cmd?.input?.Name ?? '');
      if (name === process.env.BOT_ARN_PARAM) return { Parameter: { Value: BOT } };
      if (name.endsWith('/processor-arn')) return { Parameter: { Value: 'arn:aws:lambda:us-east-1:111122223333:function:processor' } };
      return { Parameters: [] };
    });
    mockDdbSend.mockResolvedValue({});
    mockLambdaSend.mockImplementation(async (cmd: any) => (cmd?.input?.FunctionName === VEND
      ? {
        Payload: Buffer.from(JSON.stringify({
          ok: true, assistant: 'advisor', role: 'primary', botArn: BOT, grants: ['speak'],
          credentials: { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't', expiration: new Date(Date.now() + 3600_000).toISOString() },
        })),
      }
      : {}));
  };
  afterEach(() => { delete process.env.ASSISTANT_VEND_ARN; });

  /** The side's pinned version, as the experiment row and its version say. */
  const SIDE_VERSION = { schemaVersion: 1, profileName: 'alt-primary-premium', configId: 'cfg-side', modelKey: 'haiku', models: { default: 'haiku' } };
  const sidesAre = () => mockSides.mockResolvedValue({
    self: { experimentId: 'exp-1', variantId: 'treatment', modelKey: 'haiku', displayName: 'Echo', variantProfile: SIDE_VERSION },
    rival: { experimentId: 'exp-1', variantId: 'control', modelKey: 'opus', displayName: 'Atlas', variantProfile: { ...SIDE_VERSION, configId: 'cfg-rival' } },
  });

  it('posts the side\'s placeholder on a speak route, then records the round with the side, the conversation and the variant, then dispatches', async () => {
    routerReady(duelRows());
    sidesAre();
    const rivalRound = round({ battleContext: { battleId: 'b1', round: 2, rivalBotArn: RIVAL, rivalReplyMsgId: 'msg-rival' } });
    expect(await dispatchRebuttalRound(rivalRound)).toEqual({ dispatched: true, placeholderMessageId: 'placeholder-1' });
    const puts = inputsOf(mockDdbSend, 'PutItemCommand');
    // First the placeholder's speak route, then the round's own turn record.
    expect(puts.map((p) => p.Item.correlationId.S.startsWith(SPEAK_ROUTE_PREFIX))).toEqual([true, false]);
    const put = puts[1];
    expect(put.Item.correlationId.S).toBe('corr-r2');
    expect(put.Item.botArn.S).toBe(BOT);
    expect(JSON.stringify(put.Item)).toContain('channel/c1');
    expect(JSON.stringify(put.Item)).toContain('haiku');
    // The placeholder: as the side, the one marker builder's markers, and no answered message declared.
    const { battlePlaceholderContent } = await import('../lambda/src/lib/battle-turn');
    const sent = inputsOf(mockChimeSend, 'SendChannelMessageCommand');
    expect(sent).toHaveLength(1);
    expect(sent[0].ChimeBearer).toBe(BOT);
    // The side's profile name names the working state as round 1 did.
    expect(sent[0].Content).toBe(battlePlaceholderContent({
      correlationId: 'corr-r2', battleId: 'b1', round: 2, totalRounds: 2, rivalBotArn: RIVAL, rivalReplyMsgId: 'msg-rival', displayName: 'Echo',
    }));
    expect(sent[0].Content).not.toContain('<!--turn:');
    const inv = inputsOf(mockLambdaSend, 'InvokeCommand').filter((i) => i.FunctionName !== VEND)[0];
    expect(inv.FunctionName).toContain('processor');
    expect(inv.InvocationType).toBe('Event');
  });

  it('a forged payload version is neither served nor granted: the router re-resolves the side\'s pinned version', async () => {
    routerReady(duelRows());
    sidesAre();
    const forged = round({
      routedVariant: { modelKeys: ['opus'], definition: { models: ['opus'], tools: ['everything'] } },
      variantProfile: { schemaVersion: 1, profileName: 'advisor', configId: 'forged', modelKey: 'opus', persona: 'FORGED' },
      experimentId: 'not-this-one', variantId: 'control', resolvedModel: 'forged-model',
      battleContext: { battleId: 'b1', round: 2, rivalBotArn: RIVAL, rivalName: 'Forged', selfName: 'Forged too' },
    });
    expect((await dispatchRebuttalRound(forged)).dispatched).toBe(true);
    const record = JSON.stringify(inputsOf(mockDdbSend, 'PutItemCommand').find((p) => p.Item.correlationId.S === 'corr-r2')!.Item);
    expect(record).toContain('haiku');
    expect(record).not.toContain('opus');
    expect(record).not.toContain('everything');
    const inv = inputsOf(mockLambdaSend, 'InvokeCommand').filter((i) => i.FunctionName !== VEND)[0];
    const dispatched = JSON.parse(Buffer.from(inv.Payload).toString());
    expect(dispatched.variantProfile).toEqual(SIDE_VERSION);
    expect(dispatched).toMatchObject({ experimentId: 'exp-1', variantId: 'treatment' });
    expect(dispatched).not.toHaveProperty('resolvedModel');
    expect(dispatched.battleContext.rivalName).toBe('Atlas');
    // The side's own name for its scorecard column is its profile's too, never the payload's.
    expect(dispatched.battleContext.selfName).toBe('Echo');
  });

  it('a side with no pinned version is dispatched with no version and no variant grant from the payload', async () => {
    routerReady(duelRows());
    mockSides.mockResolvedValue({ self: null, rival: null });
    expect((await dispatchRebuttalRound(round({ variantProfile: { configId: 'forged' } }))).dispatched).toBe(true);
    const inv = inputsOf(mockLambdaSend, 'InvokeCommand').filter((i) => i.FunctionName !== VEND)[0];
    const dispatched = JSON.parse(Buffer.from(inv.Payload).toString());
    expect(dispatched).not.toHaveProperty('variantProfile');
    expect(dispatched).not.toHaveProperty('routedVariant');
  });

  it('refuses a round the duel\'s state does not support, and posts and records nothing', async () => {
    const cases: Array<[Array<Record<string, unknown>>, string]> = [
      [duelRows().filter((r) => r.botArn !== '__orchestrator__'), 'the duel has no claimed round 2'],
      [duelRows().map((r) => (r.botArn === BOT ? { ...r, state: 'FAILED' } : r)), 'the side did not finish round 1'],
      [duelRows().filter((r) => r.botArn !== BOT), 'the side did not finish round 1'],
      [duelRows().map((r) => (r.botArn === '__round1__' ? { ...r, channelArn: `${CHANNEL}-other` } : r)), 'the duel ran in another conversation'],
    ];
    for (const [rows, reason] of cases) {
      routerReady(rows);
      expect(await dispatchRebuttalRound(round())).toEqual({ dispatched: false, reason });
    }
    routerReady(duelRows());
    expect(await dispatchRebuttalRound(round({ battleContext: { battleId: 'b1', round: 2, rivalBotArn: `${RIVAL}-x` } })))
      .toEqual({ dispatched: false, reason: 'the rival is not a side of the duel' });
    expect(inputsOf(mockChimeSend, 'SendChannelMessageCommand')).toHaveLength(0);
    expect(inputsOf(mockDdbSend, 'PutItemCommand')).toHaveLength(0);
  });

  it('a duel whose experiment paused or ended is ended, and no rebuttal is posted or dispatched', async () => {
    routerReady(duelRows());
    mockSides.mockResolvedValueOnce({ self: null, rival: null, ended: true });
    expect(await dispatchRebuttalRound(round())).toEqual({
      dispatched: false, reason: 'the experiment of the duel is no longer active; the duel is ended',
    });
    expect(inputsOf(mockChimeSend, 'SendChannelMessageCommand')).toHaveLength(0);
    expect(inputsOf(mockLambdaSend, 'InvokeCommand').filter((i) => i.FunctionName !== VEND)).toHaveLength(0);
  });

  it('a placeholder that cannot be posted dispatches nothing', async () => {
    routerReady(duelRows());
    mockChimeSend.mockImplementation(async (cmd: any) => {
      if (cmd?.constructor?.name === 'SendChannelMessageCommand') throw new Error('ForbiddenException');
      return { Tags: [{ Key: 'classification', Value: 'premium' }] };
    });
    expect(await dispatchRebuttalRound(round())).toEqual({ dispatched: false, reason: 'placeholder-failed' });
    expect(inputsOf(mockLambdaSend, 'InvokeCommand').filter((i) => i.FunctionName !== VEND)).toHaveLength(0);
  });
});

describe('an ended duel\'s waiting markers are taken down by the router, as each side (step 36)', () => {
  const CHANNEL = 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1/channel/c1';
  const VEND = 'arn:aws:lambda:us-east-1:111122223333:function:vend';
  const ended = (over: Record<string, unknown> = {}) => [
    { battleId: 'b1', botArn: '__round1__', channelArn: CHANNEL },
    { battleId: 'b1', botArn: '__abandoned__', state: 'ABANDONED' },
    { battleId: 'b1', botArn: BOT, state: 'ABANDONED', waitingMessageId: 'question-1', ...over },
  ];
  const ready = (rows: Array<Record<string, unknown>>) => {
    process.env.ASSISTANT_VEND_ARN = VEND;
    mockDocSend.mockReset().mockResolvedValue({ Items: rows });
    mockChimeSend.mockImplementation(async (cmd: any) => {
      const name = cmd?.constructor?.name;
      if (name === 'GetChannelMessageCommand') return { ChannelMessage: { Content: encodeURIComponent('Which one?<!--battlewaiting:b1-->'), Metadata: '{}' } };
      if (name === 'UpdateChannelMessageCommand') return {};
      return { Tags: [{ Key: 'classification', Value: 'premium' }] };
    });
    mockSsmSend.mockImplementation(async (cmd: any) => (String(cmd?.input?.Name ?? '') === process.env.BOT_ARN_PARAM
      ? { Parameter: { Value: BOT } } : { Parameters: [] }));
    mockDdbSend.mockResolvedValue({});
    mockLambdaSend.mockResolvedValue({
      Payload: Buffer.from(JSON.stringify({
        ok: true, assistant: 'advisor', role: 'primary', botArn: BOT, grants: ['speak'],
        credentials: { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't', expiration: new Date(Date.now() + 3600_000).toISOString() },
      })),
    });
  };
  afterEach(() => { delete process.env.ASSISTANT_VEND_ARN; });

  it('clears the marker the side recorded, as that side, on a speak route, keeping the question', async () => {
    ready(ended());
    expect(await clearDuelMarkers({ channelArn: CHANNEL, battleId: 'b1', markers: [{ messageId: 'question-1', botArn: BOT }] })).toEqual({ cleared: 1 });
    const update = inputsOf(mockChimeSend, 'UpdateChannelMessageCommand');
    expect(update).toHaveLength(1);
    expect(update[0]).toMatchObject({ MessageId: 'question-1', ChimeBearer: BOT, Content: encodeURIComponent('Which one?') });
    expect(inputsOf(mockDdbSend, 'PutItemCommand').map((p) => p.Item.correlationId.S.startsWith(SPEAK_ROUTE_PREFIX))).toEqual([true]);
  });

  it('a duel the router ends itself has its waiting markers cleared in place, never by invoking a router', async () => {
    // The router carries ROUTER_ARN_PARAM only, so asking "the classification's router" by invoke resolved
    // nothing and every marker stayed. Here the experiment ended under a rebuttal round while the other side
    // was waiting on the person: the end is the router's, and so is the clear.
    const RIVAL = 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1/bot/bot-rival-5678';
    ready([
      { battleId: 'b1', botArn: '__round1__', channelArn: CHANNEL },
      { battleId: 'b1', botArn: '__orchestrator__', state: 'COMPLETED' },
      { battleId: 'b1', botArn: '__abandoned__', state: 'ABANDONED' },
      { battleId: 'b1', botArn: RIVAL, state: 'COMPLETED' },
      { battleId: 'b1', botArn: BOT, state: 'WAITING_FOR_USER', waitingMessageId: 'question-1' },
    ]);
    mockSides.mockResolvedValueOnce({ self: null, rival: null, ended: true });
    const rebuttal = {
      correlationId: 'corr-r2', botArn: RIVAL, channelArn: CHANNEL, classification: 'premium', trigger: 'rebuttal',
      deliveryOption: 'PLACEHOLDER_UPDATE', battleContext: { battleId: 'b1', round: 2, rivalBotArn: BOT },
    };
    // The rival is an assistant of this classification, so the round is admitted and its duel can be ended.
    mockSsmSend.mockImplementation(async (cmd: any) => {
      const name = String(cmd?.input?.Name ?? '');
      if (name === process.env.BOT_ARN_PARAM) return { Parameter: { Value: BOT } };
      if (name.endsWith('/processor-arn')) return { Parameter: { Value: 'arn:aws:lambda:us-east-1:111122223333:function:processor' } };
      return { Parameters: [{ Value: JSON.stringify({ botArn: RIVAL, role: 'ops', occupancy: 'live', assistant: 'ops-premium' }) }] };
    });
    (await import('../lambda/src/lib/default-agents')).__resetAssistantCacheForTests();
    expect((await dispatchRebuttalRound(rebuttal)).reason).toBe('the experiment of the duel is no longer active; the duel is ended');
    const update = inputsOf(mockChimeSend, 'UpdateChannelMessageCommand');
    expect(update).toHaveLength(1);
    expect(update[0]).toMatchObject({ MessageId: 'question-1', ChimeBearer: BOT, Content: encodeURIComponent('Which one?') });
    // No router was asked: the only invokes are the vend's.
    expect(inputsOf(mockLambdaSend, 'InvokeCommand').filter((i) => i.FunctionName !== VEND)).toHaveLength(0);
  });

  it('refuses a duel that was not ended, or ran elsewhere, and skips a message the side did not record', async () => {
    ready(ended().filter((r) => r.botArn !== '__abandoned__').map((r) => (r.botArn === BOT ? { ...r, state: 'WAITING_FOR_USER' } : r)));
    expect(await clearDuelMarkers({ channelArn: CHANNEL, battleId: 'b1', markers: [{ messageId: 'question-1', botArn: BOT }] }))
      .toEqual({ cleared: 0, reason: 'the duel was not ended' });
    ready(ended());
    expect(await clearDuelMarkers({ channelArn: `${CHANNEL}-other`, battleId: 'b1', markers: [{ messageId: 'question-1', botArn: BOT }] }))
      .toEqual({ cleared: 0, reason: 'the duel ran in another conversation' });
    ready(ended());
    expect(await clearDuelMarkers({ channelArn: CHANNEL, battleId: 'b1', markers: [{ messageId: 'someone-elses-message', botArn: BOT }] }))
      .toEqual({ cleared: 0 });
    expect(inputsOf(mockChimeSend, 'UpdateChannelMessageCommand')).toHaveLength(0);
    expect(inputsOf(mockDdbSend, 'PutItemCommand')).toHaveLength(0);
  });
});
