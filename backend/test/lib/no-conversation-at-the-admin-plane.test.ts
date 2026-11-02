/**
 * NO CONVERSATION IS CREATED AT AN ADMIN-PLANE CLASSIFICATION.
 *
 * `admin` is a classification, at the top of the ladder, and its assistant owns the admin notification
 * channel. It has no conversational runtime: no router, processor or task service, and its Lex
 * fulfillment is silent by design. A conversation created at `admin` would therefore be held by an
 * assistant that never answers. So every path that creates a conversation refuses it, and the admin
 * notification channel, provisioned by its own stack, stays the one admin-classified channel.
 *
 * An administrator is the case that matters: they reach `admin`, so a reach check alone admits them.
 *
 * The paths, enumerated, every one rather than the ones someone happened to look at:
 *  - `lambda/src/create-conversation.ts` - the person-facing API. Refused here, asserted below. It
 *    asks the registry directly (`profiles.isConversational`) now rather than applying a mirrored
 *    `CLASSIFICATION_ADMISSION_JSON` payload, so this suite exercises the registry's own answer.
 *  - `lib/channel-creation.ts` - drift-spawned conversations and the queue's split offer
 *    (`live-drift-flow.ts`, `conversation-split.ts`). Refused here, asserted below.
 *  - a host's context conversation (`create-conversation-at-classification.ts`, `conversation-management.ts`)
 *    - created at the classification the trusted-issuer registry's oneChannel issuers name, which the
 *    registry refuses at synth when it is admin-plane. Asserted below.
 *  - `proactive-briefing.ts` - always `standard`, through the shared creator's briefing entry, which
 *    refuses an admin-plane classification as every entry does (asserted in `channel-creation.test.ts`).
 *  - `admin-notification-channel-provision.ts` - the sanctioned admin channel. Deliberately unchanged.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockMessagingSend = jest.fn();
const mockSsmSend = jest.fn();

jest.mock('@aws-sdk/client-chime-sdk-messaging', () => ({
  ChimeSDKMessagingClient: jest.fn(() => ({ send: mockMessagingSend })),
  CreateChannelCommand: jest.fn((input: unknown) => ({ __type: 'CreateChannel', input })),
  CreateChannelMembershipCommand: jest.fn((input: unknown) => ({ __type: 'CreateMembership', input })),
  CreateChannelModeratorCommand: jest.fn((input: unknown) => ({ __type: 'CreateModerator', input })),
  AssociateChannelFlowCommand: jest.fn((input: unknown) => ({ __type: 'AssociateFlow', input })),
  SendChannelMessageCommand: jest.fn((input: unknown) => ({ __type: 'SendMessage', input })),
  ChannelMessageType: { STANDARD: 'STANDARD' },
  ChannelMessagePersistenceType: { PERSISTENT: 'PERSISTENT' },
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: mockSsmSend })),
  GetParameterCommand: jest.fn((input: unknown) => ({ __type: 'GetParameter', input })),
}), { virtual: true });

/**
 * THE API DISPATCHES TO THE CLASSIFICATION'S CREATOR. The invoke is
 * answered by running that creator in-process, as the function deployed for that classification, so
 * the Amazon Chime SDK calls asserted below are the creator's own.
 */
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({
    send: async (cmd: { input: { FunctionName: string; Payload: Uint8Array } }) => {
      const classification = cmd.input.FunctionName.replace(/^creator-/, '');
      let result: unknown;
      await jest.isolateModulesAsync(async () => {
        process.env.CREATOR_CLASSIFICATION = classification;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { handler } = require('../../lambda/src/create-conversation-at-classification');
        result = await handler(JSON.parse(new TextDecoder().decode(cmd.input.Payload)));
      });
      return { Payload: new TextEncoder().encode(JSON.stringify(result)) };
    },
  })),
  InvokeCommand: jest.fn((input: unknown) => ({ input })),
}), { virtual: true });

jest.mock('../../lambda/src/lib/channel-context-client', () => ({
  putChannelContext: jest.fn(),
  getChannelContext: jest.fn(),
}));

import { defaultProfileRegistry } from '../../lib/profile-registry';
import { classificationAdmissionJson } from '../../lib/classification-admission';
import { createConversationFromDrift } from '../../lambda/src/lib/channel-creation';
import { edgeContext } from '../helpers/edge-context';

const APP = 'arn:aws:chime:us-east-1:111:app-instance/inst';
const ADMIN_PARAM = '/test/app-instance-admin-arn';
const channelCreates = () => mockMessagingSend.mock.calls.map((c) => c[0]).filter((c) => c?.__type === 'CreateChannel');

beforeEach(() => {
  jest.clearAllMocks();
  mockMessagingSend.mockResolvedValue({ ChannelArn: `${APP}/channel/c1` });
  // The service admin the creation function creates as, and a bot for every other parameter.
  mockSsmSend.mockImplementation(async (cmd: { input?: { Name?: string } }) => ({
    Parameter: { Value: cmd?.input?.Name === ADMIN_PARAM ? `${APP}/user/service-admin` : `${APP}/bot/some-bot` },
  }));
});

describe('the registry names which classifications a conversation can be created at', () => {
  it('admits the ordinary classifications and refuses the admin plane', () => {
    const verdicts = ['basic', 'standard', 'premium', 'admin']
      .map((c) => `${c}=${defaultProfileRegistry.isConversational(c)}`);
    expect(verdicts.join(' ')).toBe('basic=true standard=true premium=true admin=false');
  });

  it('refuses a value the deployment never declared, rather than admitting a misspelling', () => {
    expect(defaultProfileRegistry.isConversational('platinum')).toBe(false);
    expect(defaultProfileRegistry.isConversational('')).toBe(false);
    expect(defaultProfileRegistry.isConversational(undefined)).toBe(false);
  });

  it('carries the admin plane to the raw Lambdas, which cannot import the registry', () => {
    expect(JSON.parse(classificationAdmissionJson(defaultProfileRegistry)).adminPlane).toEqual(['admin']);
  });
});

describe('create-conversation refuses an admin-plane classification', () => {
  function loadHandler() {
    jest.resetModules();
    process.env.APP_INSTANCE_ARN = APP;
    process.env.CREATOR_BEARER_ARN_PARAM = ADMIN_PARAM;
    // One creator per conversational classification, as the stack deploys them.
    process.env.CONVERSATION_CREATORS = JSON.stringify({ basic: 'creator-basic', standard: 'creator-standard', premium: 'creator-premium' });
    // NO `CLASSIFICATION_ADMISSION_JSON`. The handler is bundled and imports the registry, so the
    // mirror it used to be handed does not exist - setting it would suggest the refusal still depends
    // on a payload the deployment passes in, when it now depends on the registry itself.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../lambda/src/create-conversation').handler as (e: unknown) => Promise<any>;
  }

  const request = (groups: string[], modelTier: string) => ({
    requestContext: { authorizer: edgeContext({ claims: { sub: 'admin-person', 'cognito:groups': groups } }) },
    body: JSON.stringify({ title: 'Ops', modelId: 'm', modelName: 'M', modelTier }),
  });

  it('refuses an administrator, who reaches admin and would otherwise pass', async () => {
    const handler = loadHandler();
    const res = await handler(request(['admins'], 'admin'));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('CLASSIFICATION_NOT_CONVERSATIONAL');
    // Refused before anything exists: no channel, and no participant context written for one.
    expect(channelCreates()).toHaveLength(0);
  });

  it('lets an administrator who also holds premium create a premium conversation', async () => {
    // Non-vacuity: the refusal is about the classification, not about the person.
    //
    // AND THE STATUS IS ASSERTED, not only the absence of one code. `not.toBe(...)` alone passes on a
    // 403 `TIER_FORBIDDEN` just as happily as on a success, so it would have gone on reporting green if
    // the reach gate started refusing administrators outright - a control that cannot fail is not one.
    const handler = loadHandler();
    const res = await handler(request(['admins', 'premium'], 'premium'));
    expect(`${res.statusCode} ${JSON.parse(res.body).code ?? 'none'}`).toBe('200 none');
  });

  it('refuses an admins-only caller a premium conversation: the admin classification grants itself alone', async () => {
    // SPEC-ADMIN-IDENTITY FR1: the chat identity is membership-gated like any user's, and the admin
    // classification reaches admin conversations only. Reach across every conversation is admin access.
    const handler = loadHandler();
    const res = await handler(request(['admins'], 'premium'));
    expect(`${res.statusCode} ${JSON.parse(res.body).code}`).toBe('403 TIER_FORBIDDEN');
    expect(channelCreates()).toHaveLength(0);
  });

  // NO SERVICE ADMIN, NO CONVERSATION (step 33): never created as an assistant instead.
  it('refuses a deployment with no service admin, before anything exists', async () => {
    mockSsmSend.mockImplementation(async (cmd: { input?: { Name?: string } }) => ({
      Parameter: { Value: cmd?.input?.Name === ADMIN_PARAM ? '' : `${APP}/bot/some-bot` },
    }));
    const handler = loadHandler();
    const res = await handler(request(['admins', 'premium'], 'premium'));
    expect(`${res.statusCode} ${JSON.parse(res.body).code}`).toBe('500 SERVER_MISCONFIG');
    expect(channelCreates()).toHaveLength(0);
  });

  // NO `|| 'basic'` FLOOR. An omitted classification is refused, never defaulted to
  // one the deployment may not even declare (ADR-046: a classification is a set of grants, not a ladder).
  it.each([
    ['omitted', undefined],
    ['empty', ''],
  ])('refuses a request whose classification is %s, before anything exists', async (_label, modelTier) => {
    const handler = loadHandler();
    const res = await handler({
      requestContext: { authorizer: edgeContext({ claims: { sub: 'a-person', 'cognito:groups': ['basic'] } }) },
      body: JSON.stringify({ title: 'Untyped', modelId: 'm', modelName: 'M', ...(modelTier === undefined ? {} : { modelTier }) }),
    });
    expect(`${res.statusCode} ${JSON.parse(res.body).code}`).toBe('400 CLASSIFICATION_REQUIRED');
    expect(channelCreates()).toHaveLength(0);
  });
});

describe('a drift-spawned or split conversation is never created at the admin plane', () => {
  const input = {
    appInstanceArn: APP,
    botArn: `${APP}/bot/admin-agent`,
    userArn: `${APP}/user/u1`,
    modelId: '',
    modelName: '',
    topicLabel: 'Anything',
    parentChannelArn: `${APP}/channel/parent`,
    originatingMessageId: 'm-1',
  };

  it('throws before creating a channel', async () => {
    await expect(createConversationFromDrift({ ...input, modelTier: 'admin' as never }))
      .rejects.toThrow(/cannot be created at classification "admin"/);
    expect(channelCreates()).toHaveLength(0);
  });
});

describe("a host's context conversations cannot be configured at the admin plane", () => {
  it('the trusted-issuer registry refuses a oneChannel issuer naming an admin-plane classification', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { issuerErrors } = require('../../lib/config/issuers') as typeof import('../../lib/config/issuers');
    const errors = issuerErrors([
      { id: 'deployment', kind: 'cognito-pool', pool: 'self', clearance: { groups: true, classifications: ['basic', 'standard', 'premium', 'admin'] }, admin: true },
      { id: 'host', kind: 'cognito-pool', pool: 'us-east-1_HostApp', clearance: { oneChannel: 'admin', classifications: ['admin'] } },
    ], defaultProfileRegistry);
    expect(errors).toEqual([expect.stringMatching(/oneChannel names "admin", which is not a classification a conversation can be created at/)]);
  });

  it('the stack hands each context Lambda the value the registry checked, not a second read of the context', () => {
    // Source-level: synthesizing the whole foundations stack to hit one throw would cost minutes.
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'stacks', 'conversations-stack.ts'), 'utf8');
    expect(src).toMatch(/const contextClassification = issuersOf\(this\)\.contextClassification\(\);/);
    expect(src).toMatch(/CONTEXT_CLASSIFICATION: contextClassification,/);
    expect(src).not.toMatch(/tryGetContext\('assistantTier'\)/);
  });
});

describe('a classification\'s creator creates only its own classification', () => {
  async function creatorFor(classification: string) {
    let handler: (r: unknown) => Promise<any> = async () => undefined;
    await jest.isolateModulesAsync(async () => {
      process.env.APP_INSTANCE_ARN = APP;
      process.env.CREATOR_BEARER_ARN_PARAM = ADMIN_PARAM;
      process.env.CREATOR_CLASSIFICATION = classification;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ({ handler } = require('../../lambda/src/create-conversation-at-classification'));
    });
    return handler;
  }
  const request = (classification: string) => ({
    classification, userArn: `${APP}/user/u1`, title: 'T', modelId: 'm',
  });

  it('refuses a request for another classification, before anything exists', async () => {
    const create = await creatorFor('basic');
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await create(request('premium'));
    error.mockRestore();
    expect(res).toEqual(expect.objectContaining({ ok: false, code: 'CLASSIFICATION_MISMATCH' }));
    expect(channelCreates()).toHaveLength(0);
  });

  it('creates its own, tagged as it', async () => {
    const create = await creatorFor('premium');
    const res = await create(request('premium'));
    expect(res.ok).toBe(true);
    expect(channelCreates()).toHaveLength(1);
    expect(channelCreates()[0].input.Tags).toEqual(expect.arrayContaining([{ Key: 'classification', Value: 'premium' }]));
  });

  it('a creator deployed at the admin plane creates nothing', async () => {
    const create = await creatorFor('admin');
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await create(request('admin'));
    error.mockRestore();
    expect(res).toEqual(expect.objectContaining({ ok: false, code: 'SERVER_MISCONFIG' }));
    expect(channelCreates()).toHaveLength(0);
  });
});
