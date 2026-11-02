/**
 * BUILDING AN ASSISTANT'S AMAZON LEX BOT, for the provisioner's one build path (`assistant-provisioner.ts`).
 *
 * Every assistant's bot is the same: a `WelcomeIntent` and the `FallbackIntent`, both fulfilled by the
 * classification's router (or the admin assistant's silent handler), the test alias pointed at it, and resource
 * policies that let Amazon Chime SDK Messaging invoke it.
 *
 * WHY EVERY ASSISTANT HAS A LEX BOT OF ITS OWN. Amazon Chime SDK hands a targeted message to Lex and
 * says nothing about which assistant was addressed; the only thing in the request that identifies the
 * assistant is the Lex bot it arrived on (`event.bot.id`), which the router matches against the
 * assignment records (`router-agent-handler.ts`, `resolveBotArnForLexBot`). Two assistants on one Lex bot
 * cannot be told apart.
 *
 * The alias serves DRAFT. No numbered version is published, which is also why the provisioner's grant names no
 * bot-version resource.
 */
import {
  LexModelsV2Client,
  CreateBotCommand,
  CreateBotLocaleCommand,
  CreateIntentCommand,
  BuildBotLocaleCommand,
  DescribeBotLocaleCommand,
  BotLocaleStatus,
  DeleteBotCommand,
  ListBotAliasesCommand,
  ListIntentsCommand,
  UpdateIntentCommand,
  UpdateBotAliasCommand,
  CreateResourcePolicyCommand,
  UpdateResourcePolicyCommand,
} from '@aws-sdk/client-lex-models-v2';
import { botArnFor } from './person-arn.js';

export const TEST_ALIAS_NAME = 'TestBotAlias';
/** Lex V2 gives every bot's test alias this fixed id, so an ARN can be built without a lookup. */
export const TEST_ALIAS_ID = 'TSTALIASID';
export const LOCALE_ID = 'en_US';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long the builder waits between status reads. Tests set it to zero. */
export const timing = { readyPollMs: 5000, buildPollMs: 10000, afterCreateMs: 5000 };

async function waitForLocale(lex: LexModelsV2Client, botId: string, done: BotLocaleStatus[], pollMs: number, what: string, maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const response = await lex.send(new DescribeBotLocaleCommand({ botId, botVersion: 'DRAFT', localeId: LOCALE_ID }));
    console.log(`Bot locale ${what} status: ${response.botLocaleStatus}`);
    if (response.botLocaleStatus && done.includes(response.botLocaleStatus)) return;
    if (response.botLocaleStatus === BotLocaleStatus.Failed) {
      throw new Error(`Bot locale ${what} failed: ${response.failureReasons?.join(', ')}`);
    }
    await sleep(pollMs);
  }
  throw new Error(`Timeout waiting for bot locale ${what}`);
}

export interface DraftBotSpec {
  botName: string;
  description: string;
  /** The role Lex runs the bot as. */
  roleArn: string;
  /** Tags for the bot and its test alias, so a tag-conditioned grant can reach both. */
  tags?: Record<string, string>;
  /**
   * Called with the bot id as soon as the bot exists, before the minutes of locale and build work. A
   * caller that can be killed mid-build (a Lambda timeout) records the id here, because a killed build
   * never reaches the `partialBotId` on the error.
   */
  onCreated?: (botId: string) => Promise<void>;
}

/**
 * Create the bot, its locale, `WelcomeIntent` and a fulfilled `FallbackIntent`, and build the DRAFT
 * locale. Returns the bot id. The caller owns cleanup: on a throw after the bot exists, `botId` is on
 * the error as `partialBotId`.
 */
export async function createDraftBot(lex: LexModelsV2Client, spec: DraftBotSpec): Promise<string> {
  let botId: string | undefined;
  try {
    const created = await lex.send(new CreateBotCommand({
      botName: spec.botName,
      description: spec.description,
      roleArn: spec.roleArn,
      dataPrivacy: { childDirected: false },
      idleSessionTTLInSeconds: 300,
      ...(spec.tags ? { botTags: spec.tags, testBotAliasTags: spec.tags } : {}),
    }));
    botId = created.botId!;
    console.log('Bot created:', botId);
    if (spec.onCreated) await spec.onCreated(botId);
    await sleep(timing.afterCreateMs);

    await lex.send(new CreateBotLocaleCommand({
      botId, botVersion: 'DRAFT', localeId: LOCALE_ID, nluIntentConfidenceThreshold: 0.4,
    }));
    await waitForLocale(lex, botId, [BotLocaleStatus.NotBuilt, BotLocaleStatus.ReadyExpressTesting, BotLocaleStatus.Built], timing.readyPollMs, 'ready');

    // WelcomeIntent is fulfilled by the router, so a greeting reaches the code that composes the
    // welcome rather than being matched and answered with nothing.
    await lex.send(new CreateIntentCommand({
      botId,
      botVersion: 'DRAFT',
      localeId: LOCALE_ID,
      intentName: 'WelcomeIntent',
      description: 'Welcome intent - fulfillment handled by the shared router so it can produce a context-aware first reply',
      sampleUtterances: ['hello', 'hi', 'hey', 'welcome', 'what can you do', 'who are you'].map((utterance) => ({ utterance })),
      fulfillmentCodeHook: { enabled: true },
    }));

    // Every other message lands on FallbackIntent, which must be fulfilled by the router too.
    const intents = await lex.send(new ListIntentsCommand({ botId, botVersion: 'DRAFT', localeId: LOCALE_ID }));
    const fallback = intents.intentSummaries?.find((i) => i.intentName === 'FallbackIntent');
    if (fallback?.intentId) {
      await lex.send(new UpdateIntentCommand({
        botId, botVersion: 'DRAFT', localeId: LOCALE_ID,
        intentId: fallback.intentId,
        intentName: 'FallbackIntent',
        parentIntentSignature: 'AMAZON.FallbackIntent',
        fulfillmentCodeHook: { enabled: true },
      }));
    }

    await lex.send(new BuildBotLocaleCommand({ botId, botVersion: 'DRAFT', localeId: LOCALE_ID }));
    await waitForLocale(lex, botId, [BotLocaleStatus.Built, BotLocaleStatus.ReadyExpressTesting], timing.buildPollMs, 'build');
    return botId;
  } catch (err) {
    if (botId) (err as { partialBotId?: string }).partialBotId = botId;
    throw err;
  }
}

/** The alias id of the bot's test alias, or undefined when it cannot be found. */
export async function resolveTestAliasId(lex: LexModelsV2Client, botId: string): Promise<string | undefined> {
  const resp = await lex.send(new ListBotAliasesCommand({ botId }));
  return resp.botAliasSummaries?.find((a) => a.botAliasName === TEST_ALIAS_NAME)?.botAliasId;
}

/**
 * Point the alias at the fulfillment Lambda, with text conversation logs when a log group is given.
 *
 * Both settings go in ONE call: `UpdateBotAlias` replaces alias settings wholesale, so configuring logs
 * in a second call would drop the code hook and take every turn down.
 */
export async function configureBotAlias(
  lex: LexModelsV2Client,
  botId: string,
  botAliasId: string,
  handlerArn: string,
  logGroupArn?: string,
): Promise<void> {
  const conversationLogSettings = logGroupArn
    ? {
        textLogSettings: [{
          enabled: true,
          destination: {
            cloudWatch: {
              // Lex rejects the trailing `:*` that a CloudWatch log-group ARN often carries.
              cloudWatchLogGroupArn: logGroupArn.replace(/:\*$/, ''),
              logPrefix: 'aelex/',
            },
          },
        }],
      }
    : undefined;
  await lex.send(new UpdateBotAliasCommand({
    botId,
    botAliasId,
    botAliasName: TEST_ALIAS_NAME,
    botVersion: 'DRAFT',
    botAliasLocaleSettings: {
      [LOCALE_ID]: {
        enabled: true,
        codeHookSpecification: { lambdaCodeHook: { lambdaARN: handlerArn, codeHookInterfaceVersion: '1.0' } },
      },
    },
    ...(conversationLogSettings ? { conversationLogSettings } : {}),
  }));
  console.log('Bot alias configured', { botId, botAliasId, conversationLogs: conversationLogSettings ? 'enabled' : 'not configured' });
}

/**
 * Let Amazon Chime SDK Messaging invoke the bot. Chime invokes through the ALIAS ARN, but both the bot
 * and the alias need a policy; without them every message to the assistant returns `{"Code":403}`.
 * `ArnLike` so the app instance's `bot/*` wildcard matches.
 */
export async function allowChimeToInvoke(
  lex: LexModelsV2Client,
  args: { region: string; accountId: string; botId: string; botAliasId: string; appInstanceArn: string },
): Promise<void> {
  const botArn = `arn:aws:lex:${args.region}:${args.accountId}:bot/${args.botId}`;
  const aliasArn = lexBotAliasArn(args.region, args.accountId, args.botId, args.botAliasId);
  const policyFor = (resourceArn: string) => JSON.stringify({
    Version: '2012-10-17',
    Statement: [{
      Sid: 'AllowChimeMessagingToInvokeLex',
      Effect: 'Allow',
      Principal: { Service: 'messaging.chime.amazonaws.com' },
      Action: 'lex:*',
      Resource: resourceArn,
      Condition: {
        StringEquals: { 'AWS:SourceAccount': args.accountId },
        ArnLike: { 'AWS:SourceArn': botArnFor(args.appInstanceArn, '*') },
      },
    }],
  });
  for (const resourceArn of [botArn, aliasArn]) {
    try {
      await lex.send(new CreateResourcePolicyCommand({ resourceArn, policy: policyFor(resourceArn) }));
    } catch {
      // Idempotent: replace a policy that already exists.
      await lex.send(new UpdateResourcePolicyCommand({ resourceArn, policy: policyFor(resourceArn) }));
    }
  }
}

export function lexBotAliasArn(region: string, accountId: string, botId: string, botAliasId: string): string {
  return `arn:aws:lex:${region}:${accountId}:bot-alias/${botId}/${botAliasId}`;
}

/** Delete a bot and everything under it. */
export async function deleteBot(lex: LexModelsV2Client, botId: string): Promise<void> {
  await lex.send(new DeleteBotCommand({ botId, skipResourceInUseCheck: true }));
}
