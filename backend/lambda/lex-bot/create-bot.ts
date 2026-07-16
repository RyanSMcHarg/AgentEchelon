import {
  ChimeSDKIdentityClient,
  CreateAppInstanceBotCommand,
  UpdateAppInstanceBotCommand,
} from '@aws-sdk/client-chime-sdk-identity';
import { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';

const { AWS_REGION, APP_INSTANCE_ARN, APP_INSTANCE_ADMIN_ARN, BOT_HANDLER_LAMBDA_ARN, LEX_BOT_ALIAS_ARN } = process.env;
// BOT_NAME defaults to 'Assistant' to preserve behavior for the default bot.
// Alt-bot slots (per SPEC-BATTLE.md) override with names like 'AltSlot0'.
const BOT_NAME = process.env.BOT_NAME || 'Assistant';
// The Chime Lex `WelcomeIntent` fires when the bot is ADDED to a channel. Default bots
// want it (the tier router greets on join). Alt-slot battle bots set WELCOME_INTENT=''
// to OMIT it: they must stay silent on join (their real battle replies come from the
// channel-flow → premium async-processor, not Lex), and their silent Lex fulfillment
// returns no message — which made Chime post a `{"Code":500}` system message on join.
// Unset (default bot) → 'WelcomeIntent'; explicitly '' (alt-slot) → omitted.
const WELCOME_INTENT = process.env.WELCOME_INTENT ?? 'WelcomeIntent';
const identityClient = new ChimeSDKIdentityClient({ region: AWS_REGION });

exports.handler = async (event: CloudFormationCustomResourceEvent) => {
  console.log('CreateBot - Starting');
  console.log('Environment variables:', {
    APP_INSTANCE_ARN,
    APP_INSTANCE_ADMIN_ARN,
    BOT_HANDLER_LAMBDA_ARN,
    LEX_BOT_ALIAS_ARN,
    AWS_REGION,
  });

  // Shared comment for the Lex block (inlined in each command call below so the
  // literal union types survive contextual typing):
  //   WelcomeIntent fires on channel-add. Included for default bots; OMITTED for
  //   alt-slots (WELCOME_INTENT='') so Chime does not invoke them on join — their
  //   silent Lex fulfillment returned no message, which made Chime post `{"Code":500}`
  //   on join. (An earlier default-bot removal cited "403 errors" — that was the MISSING
  //   Lex resource policy for messaging.chime, see create-lex-bot.ts, not this param.)

  if (event.RequestType === 'Create') {
    try {
      const appInstanceBotData = await identityClient.send(
        new CreateAppInstanceBotCommand({
          AppInstanceArn: APP_INSTANCE_ARN,
          ClientRequestToken: uuidv4(),
          Name: BOT_NAME,
          Configuration: {
            Lex: {
              LexBotAliasArn: LEX_BOT_ALIAS_ARN!,
              LocaleId: 'en_US',
              ...(WELCOME_INTENT ? { WelcomeIntent: WELCOME_INTENT } : {}),
              InvokedBy: { StandardMessages: 'AUTO', TargetedMessages: 'ALL' },
            },
          },
        })
      );
      const botArn = appInstanceBotData.AppInstanceBotArn;
      console.log('AppInstanceBot created:', botArn);
      if (!botArn) {
        throw new Error(`Bot was created but ARN is missing. Response keys: ${Object.keys(appInstanceBotData || {}).join(', ')}`);
      }
      return { PhysicalResourceId: botArn, Data: { AppInstanceBotArn: botArn } };
    } catch (error: any) {
      console.error('Failed to create AppInstanceBot:', JSON.stringify(error, null, 2));
      throw new Error(`Failed to create bot: ${error?.message || error}`);
    }
  } else if (event.RequestType === 'Update') {
    // Re-apply the current config to the EXISTING bot so a redeploy pushes changes
    // (e.g. dropping WelcomeIntent for alt-slots) to already-provisioned, RETAINed
    // bots. Best-effort: never fail the stack on a config refresh.
    const botArn = event.PhysicalResourceId;
    try {
      await identityClient.send(
        new UpdateAppInstanceBotCommand({
          AppInstanceBotArn: botArn,
          Name: BOT_NAME,
          Metadata: '',
          Configuration: {
            Lex: {
              LexBotAliasArn: LEX_BOT_ALIAS_ARN!,
              LocaleId: 'en_US',
              ...(WELCOME_INTENT ? { WelcomeIntent: WELCOME_INTENT } : {}),
              InvokedBy: { StandardMessages: 'AUTO', TargetedMessages: 'ALL' },
            },
          },
        })
      );
      console.log('AppInstanceBot configuration updated:', botArn);
    } catch (error: any) {
      console.warn('UpdateAppInstanceBot failed (non-fatal):', JSON.stringify(error, null, 2));
    }
    return { PhysicalResourceId: botArn, Data: { AppInstanceBotArn: botArn } };
  } else {
    // Delete: the bot is RETAINed / cleaned up with the AppInstance.
    console.log('Delete request - bot retained / cleaned up with AppInstance');
    return {};
  }
};
