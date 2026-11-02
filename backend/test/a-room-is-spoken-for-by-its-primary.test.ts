/**
 * A ROOM IS SPOKEN FOR BY ITS PRIMARY, AND ALWAYS HAS ONE (DESIGN-SEPARATE-ASSISTANTS-AND-DELEGATION §3.8).
 *
 * Pinned here:
 * - `primaryAssistantOf` resolves a room's `primaryAssistant` tag through the assignment records, and a
 *   missing or stale tag falls back to the classification's primary assistant with a logged fault;
 * - a classification with no primary assistant throws, and creation refuses a bot that is not a live assistant
 *   of the room's classification, so no room is created without a primary;
 * - the primary's assignment record is written only at deploy, with a bot, and the only runtime
 *   assignment writer writes the alt's record;
 * - every path that speaks for a room resolves its bot through the resolver, and the classification's
 *   `bot-arn` pointer is read only by the listed paths, none of which posts a message.
 */
jest.unmock('../lambda/src/lib/conversation-primary');
const mockSsmSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => {
  const actual = jest.requireActual('@aws-sdk/client-ssm');
  return { ...actual, SSMClient: jest.fn(() => ({ send: mockSsmSend })) };
});

import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template } from 'aws-cdk-lib/assertions';
import {
  primaryAssistantOf, primaryTagFor, primaryAssignmentOf, RoomHasNoPrimary, PRIMARY_TAG, __resetRoomPrimaryCache,
} from '../lambda/src/lib/conversation-primary';
import { __resetAssistantCacheForTests } from '../lambda/src/lib/default-agents';
import { assistantsOf } from './helpers/assistants';
import { assistantClassifications } from '../lib/config/profiles';

const APP = 'arn:aws:chime:us-east-1:111122223333:app-instance/app-1';
const ROOM = `${APP}/channel/room-1`;
const ADVISOR = `${APP}/bot/advisor-bot`;
const OPS = `${APP}/bot/ops-bot`;

const assignments = (records: Array<{ assistant: string; role: string; botArn: string } & Record<string, unknown>>) =>
  mockSsmSend.mockResolvedValue({
    Parameters: records.map((r) => ({ Value: JSON.stringify({ ...r, occupancy: 'live' }) })),
  });
const roomTags = (tags: Record<string, string>) => ({
  send: jest.fn(async () => ({ Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) })),
});

beforeEach(() => {
  mockSsmSend.mockReset();
  __resetAssistantCacheForTests();
  __resetRoomPrimaryCache();
});

describe('primaryAssistantOf', () => {
  const premiumAssistants = [
    { assistant: 'advisor', role: 'primary', botArn: ADVISOR },
    { assistant: 'ops-premium', role: 'ops', botArn: OPS },
  ];

  it("resolves the room's tag to that assistant's bot", async () => {
    assignments(premiumAssistants);
    const p = await primaryAssistantOf(ROOM, roomTags({ classification: 'premium', [PRIMARY_TAG]: 'ops-premium' }));
    expect(p).toEqual({ assistant: 'ops-premium', botArn: OPS, classification: 'premium', source: 'tag' });
  });

  it("a room without the tag uses the classification's primary assistant, and logs the fault", async () => {
    assignments(premiumAssistants);
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = await primaryAssistantOf(ROOM, roomTags({ classification: 'premium' }));
    expect(p).toMatchObject({ assistant: 'advisor', botArn: ADVISOR, source: 'record' });
    expect(String(err.mock.calls[0][0])).toContain('PrimaryAssistantFault');
    err.mockRestore();
  });

  it('a tag naming an assistant the classification does not have falls back to the primary assistant', async () => {
    assignments(premiumAssistants);
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const p = await primaryAssistantOf(ROOM, roomTags({ classification: 'premium', [PRIMARY_TAG]: 'someone-else' }));
    expect(p).toMatchObject({ assistant: 'advisor', source: 'record' });
    err.mockRestore();
  });

  it("a runtime assistant in the primary role never becomes the classification's primary, even listed first", async () => {
    const HELPER = `${APP}/bot/helper-bot`;
    // `{c}/primary/assistants/helper` sorts before `{c}/primary/live`, so it is enumerated first.
    assignments([
      {
        assistant: 'helper', role: 'primary', botArn: HELPER, classification: 'premium', source: 'runtime', status: 'active',
        displayName: 'Helper', descriptor: { modelKey: 'sonnet', classifierMode: 'llm' },
      },
      { assistant: 'advisor', role: 'primary', botArn: ADVISOR },
    ]);
    expect(await primaryAssignmentOf('premium')).toEqual({ assistant: 'advisor', botArn: ADVISOR });
    // It is still a live assistant of the classification, so a room tagged for it resolves to it.
    expect(await primaryTagFor('premium', HELPER)).toEqual({ Key: PRIMARY_TAG, Value: 'helper' });
  });

  it('throws for a room with no readable classification, or a classification with no primary assistant', async () => {
    assignments([{ assistant: 'ops-premium', role: 'ops', botArn: OPS }]);
    await expect(primaryAssistantOf(ROOM, roomTags({}))).rejects.toBeInstanceOf(RoomHasNoPrimary);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(primaryAssistantOf(`${ROOM}-2`, roomTags({ classification: 'premium' }))).rejects.toBeInstanceOf(RoomHasNoPrimary);
    await expect(primaryAssignmentOf('premium')).rejects.toBeInstanceOf(RoomHasNoPrimary);
  });
});

describe('no room is created without a primary', () => {
  it('the creation tag names the handle of the assistant the room is created for', async () => {
    assignments([{ assistant: 'advisor', role: 'primary', botArn: ADVISOR }]);
    expect(await primaryTagFor('premium', ADVISOR)).toEqual({ Key: PRIMARY_TAG, Value: 'advisor' });
  });

  it('creation refuses a bot that is not a live assistant of the classification', async () => {
    assignments([{ assistant: 'advisor', role: 'primary', botArn: ADVISOR }]);
    await expect(primaryTagFor('premium', `${APP}/bot/stranger`)).rejects.toBeInstanceOf(RoomHasNoPrimary);
  });

  it('every room creator writes the tag in its CreateChannel call (source)', () => {
    const src = (f: string) => fs.readFileSync(path.join(__dirname, '../lambda/src', f), 'utf8');
    expect(src('lib/channel-creation.ts')).toMatch(/Key: 'classification', Value: input\.modelTier \},(\s*\/\/[^\n]*\n|\s*audienceTagFor\(input\.modelTier\),)*\s*primaryTag,/);
    // The briefing, a host's add-member and the classification creator create through the shared creator
    //, so they hold no `CreateChannel` of their own to tag.
    for (const f of ['proactive-briefing.ts', 'conversation-management.ts', 'create-conversation-at-classification.ts']) {
      expect([f, /CreateChannelCommand/.test(src(f)), /createConversationFor(Briefing|Context|Person)\(/.test(src(f))]).toEqual([f, false, true]);
    }
  });
});

describe('a classification always has its primary assistant assigned', () => {
  it('the classification stack declares its primary to the seed, and writes no record or identity of its own', async () => {
    const stack = assistantsOf('basic')(new cdk.App(), 'AgentEchelonAssistants-basic', {
      env: { account: '123456789012', region: 'us-east-1' },
      appInstanceArn: 'arn:aws:chime:us-east-1:123456789012:app-instance/test',
      attachmentsBucketName: 'test-bucket',
      attachmentsBucketArn: 'arn:aws:s3:::test-bucket',
    } as never);
    const tpl = Template.fromStack(stack);
    const params = Object.values(tpl.findResources('AWS::SSM::Parameter')) as any[];
    // ADR-048, amended 2026-10-23: the provisioner writes every assignment record.
    expect(params.filter((p) => JSON.stringify(p.Properties.Name).includes('assistant-assignments'))).toEqual([]);
    const seeds = Object.values(tpl.findResources('Custom::DeclaredAssistants')) as any[];
    expect(seeds).toHaveLength(1);
    const declaration = JSON.parse(seeds[0].Properties.declaration);
    expect(declaration.assistants).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'primary', occupancy: 'live', assistantId: expect.stringMatching(/^[a-z]/) }),
    ]));
  });

  it('nothing at runtime writes a live assignment record but the provisioner, at its own path family (source)', () => {
    const root = path.join(__dirname, '../lambda');
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|js)$/.test(e.name) && !e.name.endsWith('.d.ts') && !(e.name.endsWith('.js') && fs.existsSync(p.replace(/\.js$/, '.ts')))) {
          const s = fs.readFileSync(p, 'utf8');
          if (/PutParameterCommand/.test(s) && /assistant-assignments/.test(s)) writers.push(path.relative(root, p).replace(/\\/g, '/'));
        }
      }
    };
    walk(root);
    // The alt's occupant writer, the console's create (a console assistant's record), and the provisioner's seeding
    // of a declaration (a declared one's), which the seed's adapter asks for (ADR-048, amended 2026-10-24).
    expect(writers).toEqual(['src/admin-experiments.ts', 'src/lib/declared-assistants.ts', 'src/manage-assistants.ts']);
    const src = fs.readFileSync(path.join(root, 'src/admin-experiments.ts'), 'utf8');
    expect(src).toContain("/assistant-assignments/${record.classification}/${record.role}/alt`");
    expect(src).not.toMatch(/assistant-assignments\/[^`]*\/live`/);
    // Every record the provisioner puts is named by the path builders, and no `live` path is written or read.
    const runtime = fs.readFileSync(path.join(root, 'src/manage-assistants.ts'), 'utf8');
    const puts = [...runtime.matchAll(/await putJson\(([^,]+),/g)].map((m) => m[1].trim());
    expect(puts.length).toBeGreaterThan(0);
    for (const target of puts) expect(target).toMatch(/^(runtimeAssignmentParamName|directoryParamName|buildClaimParamName|displayNameLockParamName)\(|^recordName$/);
    expect(runtime).toMatch(/const recordName = runtimeAssignmentParamName\(/);
    const seed = fs.readFileSync(path.join(root, 'src/lib/declared-assistants.ts'), 'utf8');
    const seedPuts = [...seed.matchAll(/await putJson\(cfg, ([^,]+),/g)].map((m) => m[1].trim());
    expect(seedPuts.length).toBeGreaterThan(0);
    for (const target of seedPuts) expect(target).toMatch(/^(recordNameOf|directoryParamName|displayNameLockParamName)\(|^name$/);
    for (const f of [runtime, seed]) expect(f).not.toMatch(/\/live`/);
    // The two locks live under the directory tree, never under the assignment records.
    const lockBuilders = fs.readFileSync(path.join(root, 'src/lib/runtime-directory.ts'), 'utf8');
    expect(lockBuilders).toContain('`${ssmRoot}/assistant-directory/_build/${assistantId}`');
    expect(lockBuilders).toMatch(/`\$\{ssmRoot\}\/assistant-directory\/_name\/\$\{classification\}\//);
    expect(lockBuilders).toContain('/assistant-assignments/${classification}/${role}/assistants/${assistantId}');
  });
});

describe('every role that resolves a room primary may read what the resolver reads', () => {
  // The resolver enumerates the assignment records (GetParametersByPath on the classification's path) and
  // reads the room's tags. A role holding only single-key reads passes every mocked suite and goes quiet
  // in production, which is how the channel flow nearly shipped.
  const canResolve = (tpl: Template, roleIdPrefix: string): boolean => {
    const res = tpl.toJSON().Resources as Record<string, any>;
    const roleId = Object.keys(res).find((k) => res[k].Type === 'AWS::IAM::Role' && k.startsWith(roleIdPrefix));
    if (!roleId) throw new Error(`no role ${roleIdPrefix}`);
    const stmts = [
      ...(res[roleId].Properties?.Policies ?? []).flatMap((p: any) => p.PolicyDocument.Statement),
      ...Object.values(res).filter((r: any) => r.Type === 'AWS::IAM::Policy' && JSON.stringify(r.Properties.Roles).includes(`"${roleId}"`))
        .flatMap((r: any) => r.Properties.PolicyDocument.Statement),
    ];
    // The classification's own path, or (a shared role) every classification's under the path wildcard.
    const byPath = stmts.some((s) => [s.Action].flat().includes('ssm:GetParametersByPath')
      && /assistant-assignments\/(premium|\*)"/.test(JSON.stringify(s.Resource)));
    const tags = stmts.some((s) => [s.Action].flat().includes('chime:ListTagsForResource'));
    return byPath && tags;
  };

  it('the channel flow and the battle orchestrator', async () => {
    const env = { account: '123456789012', region: 'us-east-1' };
    const appInstanceArn = 'arn:aws:chime:us-east-1:123456789012:app-instance/test';
    const { ChannelFlowStack } = await import('../lib/stacks/channel-flow-stack');
    const { BattleStack } = await import('../lib/stacks/battle-stack');
    const flow = Template.fromStack(new ChannelFlowStack(new cdk.App(), 'AgentEchelonChannelFlow', { env, classifications: assistantClassifications(), appInstanceArn } as never));
    const battle = Template.fromStack(new BattleStack(new cdk.App(), 'AgentEchelonBattle', { env, appInstanceArn, userPoolId: 'us-east-1_x', appUrl: 'https://app.example.com' } as never));
    expect(canResolve(flow, 'ChannelFlowProcessorRole')).toBe(true);
    expect(canResolve(battle, 'BattleOrchestratorRole')).toBe(true);
    expect(canResolve(battle, 'ChannelBattleRole')).toBe(true);
  });

  it('a service that names the room primary in a notice', async () => {
    const env = { account: '123456789012', region: 'us-east-1' };
    const appInstanceArn = 'arn:aws:chime:us-east-1:123456789012:app-instance/test';
    const { NotificationStack } = await import('../lib/stacks/notification-stack');
    const app = new cdk.App();
    const host = new cdk.Stack(app, 'Host', { env });
    const notes = Template.fromStack(new NotificationStack(app, 'AgentEchelonNotifications', {
      env, userPoolId: 'us-east-1_x', classifications: assistantClassifications(), appInstanceArn, senderEmail: 'assistant@example.com',
      tokens: dynamodb.Table.fromTableArn(host, 'Tokens', 'arn:aws:dynamodb:us-east-1:123456789012:table/tokens'),
    } as never));
    expect(canResolve(notes, 'ShareConversationRole')).toBe(true);
  });
});

describe('every path that speaks for a room resolves its bot through the resolver', () => {
  const lambda = path.join(__dirname, '../lambda');
  const read = (f: string) => fs.readFileSync(path.join(lambda, f), 'utf8');

  // Each file that speaks on an assistant session, and where its bot comes from (§3.8, the first table).
  // A service that names a notice (`sayThroughRouter`) does not speak, so it is not here.
  const SPEAKERS: Record<string, 'room' | 'sanctioned'> = {
    // Unaddressed turns resolve the room's primary; addressed, owned and duel turns are sanctioned sources.
    'src/router-agent-handler.ts': 'room',
    // A queue notice is said by the assistant whose queue it is.
    'src/lib/triage-on-arrival.ts': 'sanctioned',
  };

  it('the speaker list is complete', () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|js)$/.test(e.name) && !e.name.endsWith('.d.ts') && !(e.name.endsWith('.js') && fs.existsSync(p.replace(/\.js$/, '.ts')))) {
          const rel = path.relative(lambda, p).replace(/\\/g, '/');
          if (rel === 'src/lib/assistant-session.ts') continue;
          if (/(messagingClientAsAssistant|adoptSessionAsAssistant|sessionForRoutedAssistant|speakAsRoutedAssistant)\(/.test(fs.readFileSync(p, 'utf8'))) found.push(rel);
        }
      }
    };
    walk(lambda);
    expect(found.sort()).toEqual(Object.keys(SPEAKERS).sort());
  });

  it.each(Object.entries(SPEAKERS).filter(([, k]) => k === 'room').map(([f]) => f))('%s resolves the room primary through the resolver', (f) => {
    expect(read(f)).toMatch(/primaryAssistantOf|primaryAssignmentOf/);
  });

  it("the classification's bot-arn pointer is read only by paths that post nothing", () => {
    const READERS = new Set([
      // Membership administration and read bearers, never a speaker.
      'src/conversation-management.ts',
      'src/group-membership-reconcile.ts',
      'src/membership-audit.ts',
      'src/user-tasks-api.ts',
      // The router's own bot: sanction checks, read bearers, and an invocation with no conversation.
      'src/router-agent-handler.ts',
    ]);
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|js)$/.test(e.name) && !e.name.endsWith('.d.ts') && !(e.name.endsWith('.js') && fs.existsSync(p.replace(/\.js$/, '.ts')))) {
          const code = fs.readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
          if (/\/assistant\/\$\{[^}]+\}\/bot-arn|process\.env\.BOT_ARN_PARAM/.test(code)) found.push(path.relative(lambda, p).replace(/\\/g, '/'));
        }
      }
    };
    walk(lambda);
    expect(found.sort()).toEqual([...READERS].sort());
    for (const f of READERS) {
      if (f === 'src/router-agent-handler.ts' || f === 'src/membership-audit.ts') continue;
      expect([f, /SendChannelMessage/.test(read(f))]).toEqual([f, false]);
    }
  });
});
