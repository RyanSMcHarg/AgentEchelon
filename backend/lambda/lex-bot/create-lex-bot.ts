import {
  LexModelsV2Client,
  CreateBotCommand,
  CreateBotLocaleCommand,
  CreateIntentCommand,
  BuildBotLocaleCommand,
  CreateBotVersionCommand,
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
import { CloudFormationCustomResourceEvent } from 'aws-lambda';

const { AWS_REGION } = process.env;
const lexClient = new LexModelsV2Client({ region: AWS_REGION });

const DEFAULT_BOT_NAME = 'Assistant';

// Helper to wait for bot locale to be ready for intent creation
async function waitForBotLocaleReady(botId: string, localeId: string, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    const response = await lexClient.send(
      new DescribeBotLocaleCommand({
        botId,
        botVersion: 'DRAFT',
        localeId,
      })
    );

    console.log(`Bot locale status: ${response.botLocaleStatus}`);

    if (response.botLocaleStatus === BotLocaleStatus.NotBuilt ||
        response.botLocaleStatus === BotLocaleStatus.ReadyExpressTesting ||
        response.botLocaleStatus === BotLocaleStatus.Built) {
      return;
    }

    if (response.botLocaleStatus === BotLocaleStatus.Failed) {
      throw new Error(`Bot locale failed: ${response.failureReasons?.join(', ')}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error('Timeout waiting for bot locale to be ready');
}

// Helper to wait for bot locale build to complete
async function waitForBotLocaleBuild(botId: string, localeId: string, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    const response = await lexClient.send(
      new DescribeBotLocaleCommand({
        botId,
        botVersion: 'DRAFT',
        localeId,
      })
    );

    console.log(`Bot locale build status: ${response.botLocaleStatus}`);

    if (response.botLocaleStatus === BotLocaleStatus.Built || response.botLocaleStatus === BotLocaleStatus.ReadyExpressTesting) {
      return;
    }

    if (response.botLocaleStatus === BotLocaleStatus.Failed) {
      throw new Error(`Bot locale build failed: ${response.failureReasons?.join(', ')}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10000));
  }

  throw new Error('Timeout waiting for bot locale build to complete');
}

export const handler = async (event: CloudFormationCustomResourceEvent) => {
  console.log('CreateLexBot event:', JSON.stringify(event, null, 2));

  // Classification this Lex bot is created for. Read from CloudFormation
  // ResourceProperties (the `tier` property is the stack↔custom-resource contract)
  // so the same Lambda code can back per-classification Custom Resources without
  // spinning up 3 Lambda functions. Defaults to 'standard' for back-compat with
  // the original single-bot deploy.
  const props = (event as { ResourceProperties?: Record<string, string> }).ResourceProperties || {};
  const classification = (props.tier || process.env.DEFAULT_AGENT_TIER || 'standard') as
    | 'basic'
    | 'standard'
    | 'premium';
  const customBotName = props.botName;
  // botName naming: per-classification Custom Resources pass an explicit base name
  // like 'Assistant-basic'; the legacy default-bot CR uses 'Assistant'.
  const baseBotName = customBotName || DEFAULT_BOT_NAME;

  if (event.RequestType === 'Create') {
    let botId: string | undefined;
    try {
      // Step 1: Create a new bot
      const botName = `${baseBotName}-${Date.now()}`;
      console.log('Creating new Lex bot:', botName, 'classification:', classification);
      const createBotResponse = await lexClient.send(
        new CreateBotCommand({
          botName,
          description: 'Assistant bot for Chime messaging with Bedrock Agent integration',
          roleArn: process.env.LEX_BOT_ROLE_ARN!,
          dataPrivacy: {
            childDirected: false,
          },
          idleSessionTTLInSeconds: 300,
        })
      );

      botId = createBotResponse.botId!;
      console.log('Bot created:', botId);

      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Step 2: Create bot locale
      console.log('Creating bot locale...');
      await lexClient.send(
        new CreateBotLocaleCommand({
          botId,
          botVersion: 'DRAFT',
          localeId: 'en_US',
          nluIntentConfidenceThreshold: 0.4,
        })
      );

      await waitForBotLocaleReady(botId, 'en_US');

      // Step 3: Create WelcomeIntent and wire its fulfillment to the same
      // router Lambda as FallbackIntent. Without the fulfillmentCodeHook,
      // Lex matches the greeting utterances and then has nothing to say
      // (no closing message, no Lambda) -- the bot silently consumes
      // greetings and produces no welcome. With it enabled, the router
      // sees event.sessionState.intent.name === 'WelcomeIntent' and can
      // gather context (userName from Chime, drift-trigger or other
      // creation context from channel Metadata / sessionAttributes) and
      // return a tailored welcome reply.
      console.log('Creating WelcomeIntent...');
      const welcomeResult = await lexClient.send(
        new CreateIntentCommand({
          botId,
          botVersion: 'DRAFT',
          localeId: 'en_US',
          intentName: 'WelcomeIntent',
          description: 'Welcome intent — fulfillment handled by the shared router so it can produce a context-aware first reply',
          sampleUtterances: [
            { utterance: 'hello' },
            { utterance: 'hi' },
            { utterance: 'hey' },
            { utterance: 'welcome' },
            { utterance: 'what can you do' },
            { utterance: 'who are you' },
          ],
          fulfillmentCodeHook: { enabled: true },
        })
      );
      console.log('WelcomeIntent created with fulfillment enabled:', welcomeResult.intentId);

      // NB: no AMAZON.BedrockAgentIntent here. That built-in is console-only
      // (the SDK's CreateIntent has no bedrockAgentIntentConfiguration field —
      // ADR-011), so it can't be created via IaC. Per ADR-011 the bot is just
      // WelcomeIntent + FallbackIntent → router; the router (not the bot)
      // invokes the classification's Bedrock Agent via InvokeAgent.

      // Step 4: Enable fulfillment on FallbackIntent so the alias Lambda handles it
      console.log('Enabling fulfillment on FallbackIntent...');
      const intents = await lexClient.send(new ListIntentsCommand({
        botId, botVersion: 'DRAFT', localeId: 'en_US',
      }));
      const fallbackIntent = intents.intentSummaries?.find(i => i.intentName === 'FallbackIntent');
      if (fallbackIntent?.intentId) {
        await lexClient.send(new UpdateIntentCommand({
          botId, botVersion: 'DRAFT', localeId: 'en_US',
          intentId: fallbackIntent.intentId,
          intentName: 'FallbackIntent',
          parentIntentSignature: 'AMAZON.FallbackIntent',
          fulfillmentCodeHook: { enabled: true },
        }));
        console.log('FallbackIntent fulfillment enabled');
      }

      // Step 5: Build bot locale
      console.log('Building bot locale...');
      await lexClient.send(
        new BuildBotLocaleCommand({
          botId,
          botVersion: 'DRAFT',
          localeId: 'en_US',
        })
      );

      console.log('Waiting for bot locale to be ready...');
      await waitForBotLocaleBuild(botId, 'en_US');

      // Step 6: Create bot version
      console.log('Creating bot version...');
      const versionResponse = await lexClient.send(
        new CreateBotVersionCommand({
          botId,
          botVersionLocaleSpecification: {
            en_US: {
              sourceBotVersion: 'DRAFT',
            },
          },
        })
      );

      const botVersion = versionResponse.botVersion!;
      console.log('Bot version created:', botVersion);

      // Step 7: Get the TestBotAlias
      console.log('Getting TestBotAlias...');
      const listAliasesResponse = await lexClient.send(
        new ListBotAliasesCommand({
          botId,
        })
      );

      const testAlias = listAliasesResponse.botAliasSummaries?.find(
        (alias) => alias.botAliasName === 'TestBotAlias'
      );

      if (!testAlias) {
        throw new Error('Failed to find TestBotAlias for bot');
      }

      const botAliasId = testAlias.botAliasId!;
      const lexBotAliasArn = `arn:aws:lex:${AWS_REGION}:${process.env.AWS_ACCOUNT_ID}:bot-alias/${botId}/${botAliasId}`;

      // Step 8: Configure alias with fulfillment Lambda
      const handlerArn = process.env.BOT_HANDLER_LAMBDA_ARN;
      if (handlerArn) {
        console.log('Configuring bot alias with fulfillment Lambda:', handlerArn);
        await lexClient.send(new UpdateBotAliasCommand({
          botId,
          botAliasId,
          botAliasName: 'TestBotAlias',
          botVersion: 'DRAFT',
          botAliasLocaleSettings: {
            en_US: {
              enabled: true,
              codeHookSpecification: {
                lambdaCodeHook: {
                  lambdaARN: handlerArn,
                  codeHookInterfaceVersion: '1.0',
                },
              },
            },
          },
        }));
        console.log('Bot alias configured with Lambda');
      }

      // Step 9: Resource policies so Amazon Chime SDK Messaging can invoke the
      // bot. Chime invokes via the bot-ALIAS ARN, but BOTH the bot and the
      // alias need a policy (the alias one is easy to miss). Without these,
      // every bot message returns {"Code":403} — Chime is forbidden from
      // calling Lex. ArnLike (not ArnEquals) so the app-instance/bot/* wildcard
      // matches. See docs/TROUBLESHOOTING.md "Bot replies with {Code:403}".
      const appInstanceArn = process.env.APP_INSTANCE_ARN;
      if (appInstanceArn) {
        const botArn = `arn:aws:lex:${AWS_REGION}:${process.env.AWS_ACCOUNT_ID}:bot/${botId}`;
        const mkPolicy = (resourceArn: string) =>
          JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'AllowChimeMessagingToInvokeLex',
                Effect: 'Allow',
                Principal: { Service: 'messaging.chime.amazonaws.com' },
                Action: 'lex:*',
                Resource: resourceArn,
                Condition: {
                  StringEquals: { 'AWS:SourceAccount': process.env.AWS_ACCOUNT_ID },
                  ArnLike: { 'AWS:SourceArn': `${appInstanceArn}/bot/*` },
                },
              },
            ],
          });
        for (const resourceArn of [botArn, lexBotAliasArn]) {
          try {
            await lexClient.send(new CreateResourcePolicyCommand({ resourceArn, policy: mkPolicy(resourceArn) }));
            console.log('Created Chime invoke resource policy:', resourceArn);
          } catch (err) {
            // Idempotent: replace if it already exists.
            await lexClient.send(new UpdateResourcePolicyCommand({ resourceArn, policy: mkPolicy(resourceArn) }));
            console.log('Replaced Chime invoke resource policy:', resourceArn);
          }
        }
      } else {
        console.warn('APP_INSTANCE_ARN unset — skipping Chime invoke resource policies; bot will 403 on invoke.');
      }

      console.log('Lex bot alias ARN:', lexBotAliasArn);

      return {
        PhysicalResourceId: botId,
        Data: {
          BotId: botId,
          BotAliasId: botAliasId,
          LexBotAliasArn: lexBotAliasArn,
        },
      };
    } catch (error) {
      console.error('Failed to create Lex bot:', error);
      if (botId) {
        console.log('Cleaning up partially created bot:', botId);
        try {
          await lexClient.send(
            new DeleteBotCommand({
              botId,
              skipResourceInUseCheck: true,
            })
          );
          console.log('Bot cleaned up successfully');
        } catch (deleteError) {
          console.error('Failed to clean up bot:', deleteError);
        }
      }
      throw new Error(`Failed to create Lex bot: ${(error as any)?.message || error}`);
    }
  } else if (event.RequestType === 'Delete') {
    try {
      const botId = event.PhysicalResourceId;
      if (botId && botId !== 'FAILED') {
        console.log('Deleting Lex bot:', botId);
        await lexClient.send(
          new DeleteBotCommand({
            botId,
            skipResourceInUseCheck: true,
          })
        );
        console.log('Lex bot deleted');
      }
      return {};
    } catch (error) {
      console.error('Failed to delete Lex bot:', error);
      return {};
    }
  } else {
    return {
      PhysicalResourceId: event.PhysicalResourceId,
    };
  }
};
