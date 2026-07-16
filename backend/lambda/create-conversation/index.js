const {
  ChimeSDKMessagingClient,
  CreateChannelCommand,
  CreateChannelMembershipCommand,
  CreateChannelModeratorCommand,
  AssociateChannelFlowCommand,
  SendChannelMessageCommand,
} = require('@aws-sdk/client-chime-sdk-messaging');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const crypto = require('crypto');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
// Tier comes from the JWT `cognito:groups` claim, so no Cognito Identity Provider
// client is needed here (previously used for AdminListGroupsForUser).

const messagingClient = new ChimeSDKMessagingClient({});
const ssmClient = new SSMClient({});
const bedrockClient = new BedrockRuntimeClient({});

const WELCOME_PROMPT_TOPICAL = `You are the assistant in a new conversation. The
user just created this chat with the topic provided below. Write a
SHORT welcome (2-3 sentences, no emoji) that:
- briefly introduces yourself by role for this topic (concrete capability
  framed by the topic, not "Hi, I am an AI"),
- restates the topic in your own words to confirm understanding, and
- ends with one concrete first move the user can take.

Topic: {{topic}}

Respond with the welcome message body only. No preamble.`;

/** Fallback when no topic is provided. Static so it lands instantly with
 *  no Bedrock dependency — fast, free, and predictable for tests. The
 *  assistant should always welcome the user; without a topic to ground
 *  the intro, a generic prompt-to-start works better than silence. */
const WELCOME_GENERIC =
  "Hi — I'm your assistant for this conversation. " +
  "I can answer questions, draft documents, analyse data, help with code, or work through a plan with you. " +
  "What would you like to start with?";

/** Generate the channel's opening message. When a topic was supplied, ask
 *  Haiku 3 to produce a contextual welcome grounded in it; otherwise fall
 *  back to a static generic prompt. Best-effort on the Bedrock path: any
 *  failure logs and falls back to the generic copy so the channel always
 *  greets the user. */
async function buildWelcome(topic) {
  if (!topic || typeof topic !== 'string') return WELCOME_GENERIC;
  try {
    const resp = await bedrockClient.send(new InvokeModelCommand({
      modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 200,
        temperature: 0.3,
        messages: [{
          role: 'user',
          content: WELCOME_PROMPT_TOPICAL.replace('{{topic}}', String(topic).slice(0, 500)),
        }],
      }),
    }));
    const body = JSON.parse(new TextDecoder().decode(resp.body));
    const text = (body?.content?.[0]?.text || '').trim();
    return text || WELCOME_GENERIC;
  } catch (err) {
    console.warn('[CreateChannel] Contextual welcome generation failed; using generic:', err);
    return WELCOME_GENERIC;
  }
}

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN;
const CHANNEL_FLOW_ARN_PARAM = process.env.CHANNEL_FLOW_ARN_PARAM;
const USER_POOL_ID = process.env.USER_POOL_ID;

const TIER_RANK = { basic: 1, standard: 2, premium: 3 };

let cachedChannelFlowArn = null;

async function getSsmParam(name) {
  const response = await ssmClient.send(new GetParameterCommand({ Name: name }));
  return response.Parameter.Value;
}

const tierBotArnCache = {};

/**
 * The per-tier AppInstanceBot — the channel's creator AND member, used as the
 * ChimeBearer for every operation in this handler.
 *
 * Full per-tier isolation (no shared cross-tier identity): a conversation of a
 * given tier is created by, owned by, and answered by that tier's own assistant
 * (its name, WelcomeIntent greeting, Bedrock guardrail, and tier-scoped IAM).
 * Resolved formulaically from SSM `/agent-echelon/tier/{tier}/bot-arn` (written
 * by each tier stack), so adding a tier needs no change here. There is NO shared
 * cross-tier bot fallback: if the per-tier key is missing the request errors
 * rather than silently binding a wrong-tier assistant. `tier` is the ENFORCED
 * tier (create-conversation 403s over-tier requests, so the channel's tier ==
 * an authorized tier).
 */
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
async function getBotArnForTier(tier) {
  const t = tier || 'basic';
  if (tierBotArnCache[t]) return tierBotArnCache[t];
  const arn = await getSsmParam(`${SSM_ROOT}/tier/${t}/bot-arn`);
  if (!arn) {
    throw new Error(
      `[CreateChannel] per-tier bot ARN ${SSM_ROOT}/tier/${t}/bot-arn is empty; ` +
        `cannot create a ${t} conversation without its tier assistant.`,
    );
  }
  tierBotArnCache[t] = arn;
  return arn;
}

async function getChannelFlowArn() {
  if (cachedChannelFlowArn !== null) return cachedChannelFlowArn;
  if (!CHANNEL_FLOW_ARN_PARAM) {
    cachedChannelFlowArn = '';
    return '';
  }
  try {
    cachedChannelFlowArn = await getSsmParam(CHANNEL_FLOW_ARN_PARAM);
  } catch (err) {
    console.warn('[CreateChannel] Channel flow ARN not in SSM yet:', err.name);
    cachedChannelFlowArn = '';
  }
  return cachedChannelFlowArn;
}

// Authoritative tier from the caller's Cognito groups, read from the `cognito:groups`
// JWT claim the API Gateway Cognito authorizer already validated — no
// AdminListGroupsForUser round-trip. The claim carries the same groups; this mirrors
// credential-exchange.parseGroups/resolveRoleKey, the security-critical path that also
// keys the tier off the claim. The claim arrives as an array, a `[a b]` string, or a
// comma/space list depending on the authorizer.
function tierFromGroupsClaim(rawGroups) {
  let groups = [];
  if (Array.isArray(rawGroups)) {
    groups = rawGroups.map((g) => String(g).trim()).filter(Boolean);
  } else if (typeof rawGroups === 'string') {
    groups = rawGroups.replace(/^\[|\]$/g, '').split(/[\s,]+/).map((g) => g.trim()).filter(Boolean);
  }
  if (groups.includes('premium')) return 'premium';
  if (groups.includes('standard')) return 'standard';
  if (groups.includes('basic')) return 'basic';
  return null;
}

/**
 * Lambda function to create a conversation and add the AI agent atomically.
 *
 * Steps:
 * 1. Validate request + extract user sub from userArn
 * 2. Tier gate: reject if requested modelTier exceeds creator's Cognito group tier
 * 3. Create the channel (bot is creator/moderator)
 * 4. Add the user as member + moderator
 * 5. Associate the AgentEchelon channel flow so @all / @assistant routing works
 */
exports.handler = async (event) => {
  console.log('CreateConversation - Received event:', JSON.stringify(event, null, 2));

  try {
    // Never trust a body-supplied userArn — that would let a caller impersonate
    // any user (or bypass the tier gate by submitting a premium user's sub).
    // Instead:
    //   1. API Gateway Cognito authorizer rejects unauth'd requests
    //   2. Caller sub is pulled from the JWT claims and used to compose
    //      the AppInstanceUser ARN — body userArn is IGNORED if it
    //      doesn't match.
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
    const userArn = `${appInstanceArn}/user/${callerSub}`;
    const sub = callerSub;

    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    // `topic`: optional, durable "what this conversation is about" string
    //   stored on Channel.Metadata; the router reads it on WelcomeIntent
    //   to ground the greeting.
    // `triggerContext`: optional, one-shot "what brought this conversation
    //   into existence" string (e.g. the drift-suggestion prompt that
    //   redirected the user here). Also stored on Channel.Metadata; the
    //   router reads it on WelcomeIntent and weighs it above `topic`.
    //   See docs/SPEC-WELCOME-AND-CONTEXT.md.
    const { title, modelId, modelName, modelTier, topic, triggerContext, expirationDays, expirationCriterion } = body;

    if (!title || !modelId) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
        },
        body: JSON.stringify({
          error: 'title and modelId are required (userArn is derived from JWT)',
          code: 'MISSING_REQUIRED_FIELDS',
        }),
      };
    }

    const requestedTier = modelTier || 'basic';

    // Optional per-conversation expiration (channel TTL — how long the
    // conversation remains stored in the Chime SDK). Mirrors the Chime
    // CreateChannel `ExpirationSettings` shape exactly: both fields are required
    // together, or omit entirely (default: never expires). Retention toggle 3 —
    // see docs/SPEC-ACCESS-AND-CONTROLS-AUDITING.md §4c.
    const EXPIRATION_CRITERIA = ['CREATED_TIMESTAMP', 'LAST_MESSAGE_TIMESTAMP'];
    let expirationSettings;
    if (expirationDays !== undefined || expirationCriterion !== undefined) {
      const days = Number(expirationDays);
      if (!Number.isInteger(days) || days < 1 || days > 5475) {
        return {
          statusCode: 400,
          headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
          body: JSON.stringify({
            error: 'expirationDays must be an integer between 1 and 5475 (Chime ExpirationSettings)',
            code: 'INVALID_EXPIRATION_DAYS',
          }),
        };
      }
      if (!EXPIRATION_CRITERIA.includes(expirationCriterion)) {
        return {
          statusCode: 400,
          headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' },
          body: JSON.stringify({
            error: `expirationCriterion must be one of: ${EXPIRATION_CRITERIA.join(', ')}`,
            code: 'INVALID_EXPIRATION_CRITERION',
          }),
        };
      }
      expirationSettings = { ExpirationDays: days, ExpirationCriterion: expirationCriterion };
    }

    // No per-request override ⇒ fall back to the deployment-wide default TTL.
    // The conversation-type `expiration` default (backend/lib/config/conversation-types.ts)
    // is surfaced to this standalone-asset handler as env vars by the Foundations stack
    // (this handler is bundled separately and cannot import the CDK-side TS config).
    // Ships as 90-day LAST_MESSAGE_TIMESTAMP so every conversation hard-expires 90 days
    // after its last message (retention toggle 2 — SPEC-ACCESS-AND-CONTROLS-AUDITING §4c;
    // also the "eventual hard delete" ADR-017 composes archive with).
    if (!expirationSettings) {
      const defDays = Number(process.env.DEFAULT_EXPIRATION_DAYS);
      const defCriterion = process.env.DEFAULT_EXPIRATION_CRITERION;
      if (
        Number.isInteger(defDays) &&
        defDays >= 1 &&
        defDays <= 5475 &&
        EXPIRATION_CRITERIA.includes(defCriterion)
      ) {
        expirationSettings = { ExpirationDays: defDays, ExpirationCriterion: defCriterion };
      }
    }

    // Tier gate: reject if the user's group tier is below the requested channel tier.
    // We only downgrade — we don't auto-elevate a user missing from any group.
    // Tier comes from the JWT `cognito:groups` claim (already validated), not a live
    // AdminListGroupsForUser call. The IAM classification-tag gate remains the real
    // enforcement, so a claim at most one token-lifetime stale cannot exceed it.
    const userGroupTier = tierFromGroupsClaim(claims['cognito:groups']);
    const requestedRank = TIER_RANK[requestedTier] || 1;
    const userRank = TIER_RANK[userGroupTier] || 0;

    if (userRank < requestedRank) {
      console.warn('[CreateChannel] Tier denied', {
        requestedTier,
        userGroupTier,
        sub,
      });
      return {
        statusCode: 403,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
        },
        body: JSON.stringify({
          error: `Your tier (${userGroupTier || 'none'}) does not authorize ${requestedTier} conversations`,
          code: 'TIER_FORBIDDEN',
          userTier: userGroupTier,
          requestedTier,
        }),
      };
    }

    // Tier-aware bot lookup — new channels use the per-tier bot whose
    // Lex fulfillment invokes that tier's async processor (the self-hosted
    // Converse tool loop). The channel's permanent bot membership is the
    // per-tier bot, so every message routes to the tier's processor at
    // runtime. Falls back to the legacy single bot if the SSM param hasn't
    // rolled out yet.
    const botArn = await getBotArnForTier(requestedTier);
    const conversationId = `conv-${Date.now()}`;
    console.log('Creating conversation:', { conversationId, title, modelId, userArn, requestedTier });

    // Step 1: Bot creates the channel (bot is the creator, making it a moderator)
    // RESTRICTED mode: only moderators can send messages
    // PRIVATE: channel is not discoverable
    const createChannelResponse = await messagingClient.send(
      new CreateChannelCommand({
        AppInstanceArn: APP_INSTANCE_ARN,
        ChannelId: conversationId,
        Name: title,
        Mode: 'RESTRICTED',
        Privacy: 'PRIVATE',
        ChimeBearer: botArn,
        // SPEC-CONVERSATION-SECURITY Layer 1 (channel-join boundary). The
        // `classification` tag is the IMMUTABLE source of truth for the
        // channel's tier; per-tier IAM Deny policies key on
        // `chime:ResourceTag/classification`, so a tier-X assistant (and, once
        // per-tier user roles land, a tier-X user) physically cannot
        // send/join/read a higher-tier channel — enforced by IAM before any
        // app logic. The `modelTier` metadata below mirrors it for the
        // app-layer checks (Layer 2); the tag is what IAM evaluates.
        Tags: [
          { Key: 'classification', Value: requestedTier },
          { Key: 'conversationType', Value: 'private' },
        ],
        Metadata: JSON.stringify({
          modelId,
          modelName,
          modelTier: requestedTier,
          // No `createdBy`: the owner is derived from Chime membership (the sole human
          // member of a 1:1), not copied into member-readable metadata (Tenet 10).
          // topic + triggerContext — read by the router on WelcomeIntent
          // (docs/SPEC-WELCOME-AND-CONTEXT.md). Both bounded to keep
          // Chime's 1KB Metadata cap headroom for everything else.
          ...(topic ? { topic: String(topic).slice(0, 500) } : {}),
          ...(triggerContext ? { triggerContext: String(triggerContext).slice(0, 240) } : {}),
        }),
        // Optional channel TTL (retention toggle 3) — omitted ⇒ never expires.
        ...(expirationSettings ? { ExpirationSettings: expirationSettings } : {}),
      })
    );

    const conversationArn = createChannelResponse.ChannelArn;
    if (!conversationArn) {
      throw new Error('Failed to create conversation - no ARN returned');
    }

    console.log('Conversation created by bot:', conversationArn);

    // Step 1b: Enroll the bot as a DEFAULT channel member BEFORE adding the
    // user. Chime fires the bot's WelcomeIntent when a user JOINS a channel
    // that ALREADY has the bot present — so the bot must be a member first, or
    // the on-join greeting never fires. (CreateChannel with ChimeBearer=botArn
    // gives the bot creator authority but NOT a membership record, so it must
    // be enrolled explicitly; this also makes ListChannelMemberships return the
    // bot, which @mention routing depends on.) Non-fatal on ConflictException.
    try {
      await messagingClient.send(
        new CreateChannelMembershipCommand({
          ChannelArn: conversationArn,
          MemberArn: botArn,
          Type: 'DEFAULT',
          ChimeBearer: botArn,
        })
      );
      console.log('Bot enrolled as channel member');
    } catch (botMembershipErr) {
      if (botMembershipErr.name === 'ConflictException') {
        console.log('Bot already a member, continuing');
      } else {
        console.warn('[CreateChannel] Failed to enroll bot as member (non-fatal):', botMembershipErr);
      }
    }

    // Step 2: Add the user as a member and moderator
    try {
      await messagingClient.send(
        new CreateChannelMembershipCommand({
          ChannelArn: conversationArn,
          MemberArn: userArn,
          Type: 'DEFAULT',
          ChimeBearer: botArn,
        })
      );

      await messagingClient.send(
        new CreateChannelModeratorCommand({
          ChannelArn: conversationArn,
          ChannelModeratorArn: userArn,
          ChimeBearer: botArn,
        })
      );

      console.log('User added as member and moderator');
    } catch (userError) {
      console.error('Failed to add user to conversation:', userError);
      throw new Error(`User could not be added to conversation: ${userError.message}`);
    }

    // Step 3: Associate the channel flow so the processor runs on every message.
    // This enables @all / @assistant routing and multi-member mention enforcement.
    const channelFlowArn = await getChannelFlowArn();
    if (channelFlowArn) {
      try {
        await messagingClient.send(
          new AssociateChannelFlowCommand({
            ChannelArn: conversationArn,
            ChannelFlowArn: channelFlowArn,
            ChimeBearer: botArn,
          })
        );
        console.log('[CreateChannel] Associated channel flow');
      } catch (flowErr) {
        // Non-fatal: channel will work but @assistant routing in multi-member
        // conversations won't. Log loudly so this is visible in alarms.
        console.error('[CreateChannel] Failed to associate channel flow:', flowErr);
      }
    } else {
      console.warn('[CreateChannel] CHANNEL_FLOW_ARN_PARAM unset or missing — flow not associated');
    }

    // No synchronous welcome here. The bot's WelcomeIntent (Lex) is now
    // wired with fulfillment to the router (create-lex-bot.ts), so the
    // assistant greets users contextually on their first interaction
    // (userName + triggerContext from channel metadata + topic). See
    // docs/SPEC-WELCOME-AND-CONTEXT.md. `topic` and `triggerContext`
    // (when set in the request body) are persisted on Channel.Metadata
    // above so the router can read them when WelcomeIntent fires.

    // Step 4: Return the complete conversation info
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
      },
      body: JSON.stringify({
        success: true,
        conversation: {
          id: conversationId,
          conversationArn,
          title,
          modelId,
          modelName,
          modelTier: requestedTier,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }),
    };
  } catch (error) {
    console.error('Error creating conversation:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
      },
      body: JSON.stringify({
        error: error.message,
        code: 'CONVERSATION_CREATION_FAILED',
      }),
    };
  }
};
