const {
  ChimeSDKMessagingClient,
  CreateChannelCommand,
  CreateChannelMembershipCommand,
  CreateChannelModeratorCommand,
  AssociateChannelFlowCommand,
} = require('@aws-sdk/client-chime-sdk-messaging');
const crypto = require('crypto');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
// Tier comes from the JWT `cognito:groups` claim, so no Cognito Identity Provider
// client is needed here (previously used for AdminListGroupsForUser).

const messagingClient = new ChimeSDKMessagingClient({});
const ssmClient = new SSMClient({});

// NOTE: this handler posts NO synchronous/automated welcome. The assistant greets the user through
// the bot's WelcomeIntent (Lex → router), which fires when the user JOINS the channel the bot is
// already a member of — see the membership order below and lib/welcome-orientation.ts. That path is
// personalized (userName + per-tier orientation); a hardcoded message here would duplicate it and
// bypass the personalization, so the earlier `buildWelcome` helper was removed.

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
 * Resolved formulaically from SSM `/agent-echelon/assistant/{tier}/bot-arn` (written
 * by each tier stack), so adding a tier needs no change here. There is NO shared
 * cross-tier bot fallback: if the per-tier key is missing the request errors
 * rather than silently binding a wrong-tier assistant. `tier` is the ENFORCED
 * tier (create-conversation 403s over-tier requests, so the channel's tier ==
 * an authorized tier).
 */
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
// Whether to surface internal error detail (IAM ARNs, resource paths, stack traces) in the HTTP
// response. OFF by default: production returns a generic message and logs the full error server-side
// (CloudWatch). Set DEBUG_ERRORS=true on the Lambda to echo the detail to the client while debugging.
const DEBUG_ERRORS = process.env.DEBUG_ERRORS === 'true';
async function getBotArnForTier(tier) {
  const t = tier || 'basic';
  if (tierBotArnCache[t]) return tierBotArnCache[t];
  const arn = await getSsmParam(`${SSM_ROOT}/assistant/${t}/bot-arn`);
  if (!arn) {
    throw new Error(
      `[CreateChannel] per-tier bot ARN ${SSM_ROOT}/assistant/${t}/bot-arn is empty; ` +
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
          // welcomeUserSub — the creator's sub, stamped so the WelcomeIntent can personalize the
          // greeting. This is a DELIBERATE, scoped exception to Tenet 6 (don't copy the owner into
          // metadata): the Chime WelcomeIntent fires on the bot's CHANNEL_MEMBERSHIP at channel
          // creation, BEFORE the user's membership is visible to a ListChannelMemberships read — so
          // membership-derivation races and the router sees humanMembers=0 (verified empirically).
          // Metadata is set atomically at creation and always readable, so it is the only race-free
          // way to give the welcome the user's identity. The router resolves the display NAME from
          // this sub via Cognito (router-agent-handler.resolveUserName), so no name is stored here.
          welcomeUserSub: sub,
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

    // Step 1b: Explicitly enroll the bot as a DEFAULT channel member. This is what FIRES the bot's
    // Lex WelcomeIntent: Chime invokes it on the bot's CHANNEL_MEMBERSHIP event (verified against live
    // Chime + AWS docs — https://docs.aws.amazon.com/chime-sdk/latest/dg/welcome-intent.html). The
    // creator (ChimeBearer=botArn) is auto-added as a channel member at CreateChannel, but that
    // auto-membership does NOT fire the welcome — only this explicit CreateChannelMembership does; it
    // also (idempotently) ensures ListChannelMemberships returns the bot, which @mention routing needs.
    // NOTE: the welcome fires here, before/independent of the user's membership, which is why the
    // user's identity for the greeting is carried in channel metadata (welcomeUserSub), not membership.
    // Non-fatal on ConflictException (the bot is already a member from creation).
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
        // Never leak internal detail (IAM role ARNs, resource paths) to the web client; the full
        // error is logged above (CloudWatch). DEBUG_ERRORS=true echoes it here while debugging.
        error: DEBUG_ERRORS ? error.message : 'Could not create the conversation. Please try again; if it persists, contact an administrator.',
        code: 'CONVERSATION_CREATION_FAILED',
      }),
    };
  }
};
