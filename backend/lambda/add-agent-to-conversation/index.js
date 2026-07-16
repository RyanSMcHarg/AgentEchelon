const {
  ChimeSDKMessagingClient,
  CreateChannelMembershipCommand,
  DescribeChannelCommand,
  DescribeChannelMembershipCommand,
  ListTagsForResourceCommand,
} = require('@aws-sdk/client-chime-sdk-messaging');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const messagingClient = new ChimeSDKMessagingClient({});
const ssmClient = new SSMClient({});
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';

// Per-tier AppInstanceBot ARNs, resolved once per (tier, cold start). There is
// NO shared cross-tier bot fallback: a conversation of a given tier is answered
// only by that tier's own assistant, resolved from SSM
// `/agent-echelon/tier/{tier}/bot-arn` (written by each tier stack).
const tierBotArnCache = {};

async function getBotArnForTier(tier) {
  const t = tier || 'basic';
  if (tierBotArnCache[t]) return tierBotArnCache[t];
  const response = await ssmClient.send(
    new GetParameterCommand({ Name: `${SSM_ROOT}/tier/${t}/bot-arn` })
  );
  const arn = response.Parameter?.Value;
  if (!arn) {
    throw new Error(`per-tier bot ARN ${SSM_ROOT}/tier/${t}/bot-arn is empty`);
  }
  tierBotArnCache[t] = arn;
  return arn;
}

/**
 * Lambda function to add the AI agent to a conversation.
 * The bot adds itself using its own identity (no system-admin needed).
 *
 * Conversations are backed by Chime SDK channels.
 */
exports.handler = async (event) => {
  console.log('AddAgentToConversation - Received event:', JSON.stringify(event, null, 2));

  try {
    // Cognito-authed (API Gateway); additionally verify the caller is a member
    // of the target channel before adding the bot — otherwise an authed user
    // could attach the bot to a channel they aren't in, driving Bedrock
    // spend and bot spam in unrelated rooms.
    const claims = event.requestContext?.authorizer?.claims || {};
    const callerSub = claims.sub || claims['cognito:username'];
    if (!callerSub) {
      return {
        statusCode: 401,
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
        body: JSON.stringify({ error: 'Unauthorized', code: 'MISSING_CLAIMS' }),
      };
    }
    const appInstanceArn = process.env.APP_INSTANCE_ARN;
    if (!appInstanceArn) {
      return {
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
        body: JSON.stringify({ error: 'APP_INSTANCE_ARN not configured', code: 'SERVER_MISCONFIG' }),
      };
    }
    const callerUserArn = `${appInstanceArn}/user/${callerSub}`;

    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    const conversationArn = body.conversationArn || body.channelArn;

    if (!conversationArn) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
        },
        body: JSON.stringify({
          error: 'conversationArn is required',
          code: 'MISSING_CONVERSATION_ARN'
        }),
      };
    }

    // Membership check — caller must already be in the target channel.
    try {
      await messagingClient.send(
        new DescribeChannelMembershipCommand({
          ChannelArn: conversationArn,
          MemberArn: callerUserArn,
          ChimeBearer: callerUserArn,
        }),
      );
    } catch (membershipErr) {
      console.warn('[AddAgent] caller not a member of target channel', {
        callerSub, conversationArn, err: membershipErr.name,
      });
      return {
        statusCode: 403,
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
        body: JSON.stringify({
          error: 'Caller is not a member of the target channel',
          code: 'NOT_A_MEMBER',
        }),
      };
    }

    // Resolve the channel's enforced tier from its IMMUTABLE `classification` tag
    // (set once at creation, ungated by chime:UpdateChannel), then bind THAT tier's
    // assistant. We deliberately do NOT read `metadata.modelTier`: metadata is mutable
    // via the owner rename cap, so trusting it would let a moderator tamper the tier up
    // and attract a higher-tier bot into a lower-tagged channel. Fail-closed to basic.
    // No shared cross-tier bot — a wrong-tier assistant must never be added.
    const VALID_TIERS = new Set(['basic', 'standard', 'premium']);
    let channelTier = 'basic';
    try {
      const tagResp = await messagingClient.send(
        new ListTagsForResourceCommand({ ResourceARN: conversationArn }),
      );
      const tag = (tagResp.Tags || []).find((t) => t.Key === 'classification')?.Value;
      if (tag && VALID_TIERS.has(tag)) {
        channelTier = tag;
      } else {
        console.warn('[AddAgent][SecurityEvent] channel missing/invalid classification tag; failing closed to basic', {
          conversationArn, tag,
        });
      }
    } catch (tagErr) {
      console.warn('[AddAgent] could not read channel classification tag; defaulting to basic', {
        conversationArn, err: tagErr.name,
      });
    }

    const botArn = await getBotArnForTier(channelTier);

    console.log('Adding AI agent to conversation:', { conversationArn, botArn, channelTier });

    // Bot adds itself as a member using its own identity
    await messagingClient.send(
      new CreateChannelMembershipCommand({
        ChannelArn: conversationArn,
        MemberArn: botArn,
        Type: 'DEFAULT',
        ChimeBearer: botArn,
      })
    );

    console.log('AI agent added successfully to conversation:', conversationArn);

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
      },
      body: JSON.stringify({
        success: true,
        message: 'AI agent added to conversation'
      }),
    };
  } catch (error) {
    console.error('Error adding AI agent to conversation:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
      },
      body: JSON.stringify({
        error: error.message,
        code: 'AGENT_ADDITION_FAILED'
      }),
    };
  }
};
