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
 * A new conversation's channel id.
 *
 * Timestamp PLUS cryptographic randomness. The timestamp alone is only millisecond-resolution, so two
 * concurrent creates collide, and this id is load-bearing beyond the CreateChannel call: the channel ARN is
 * derived from it (`{appInstance}/channel/{id}`), which makes it the key for per-conversation context written
 * BEFORE the channel exists (SPEC-USER-PROFILE-AND-ONBOARDING §2 - the assistant is added by creation
 * itself, so there is no window afterwards). A collision would therefore let one request's participant
 * context attach to another's conversation, which is a cross-user leak rather than a retryable conflict.
 *
 * `crypto` not `Math.random`: the consequence of a repeated id here is a context mix-up, so it gets a real
 * random source. Exported for the collision/legality test - the property is the point, not the format.
 */
function newConversationChannelId() {
  return `conv-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}
exports.newConversationChannelId = newConversationChannelId;

/**
 * Record WHO will be in this conversation, BEFORE the channel exists.
 *
 * SPEC-USER-PROFILE-AND-ONBOARDING §2. The assistant is added to the channel BY creation (the bot is the
 * acting bearer), so there is no window after `CreateChannel` in which to write something the welcome will
 * read. Writing ahead of creation is possible because the channel ARN is derived from a channel id we supply.
 *
 * This conversation has exactly one human by construction: the authenticated caller. So the shape is
 * `single`, written literally rather than computed - there is no member list to classify yet. The shape, NOT
 * an initiator: "who asked for this conversation" and "who is in it" are different facts, and only the second
 * belongs here (§2).
 *
 * BEST-EFFORT, deliberately. A failure here degrades the welcome (the router falls back to reading live
 * membership, which is the pre-existing behaviour) and must never fail conversation creation. The DynamoDB
 * client is required lazily for the same reason: this is a raw Lambda asset with no bundled dependencies, so
 * it relies on the runtime-provided SDK, and a missing client degrades the welcome rather than breaking the
 * endpoint.
 */
async function writeParticipantContext(channelArn, humanSub) {
  const table = process.env.CHANNEL_CONTEXT_TABLE;
  if (!table) {
    console.warn('[CreateChannel] CHANNEL_CONTEXT_TABLE unset - participant shape not recorded');
    return;
  }
  try {
    // eslint-disable-next-line global-require
    const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
    const ddb = new DynamoDBClient({});
    await ddb.send(new UpdateItemCommand({
      TableName: table,
      Key: { channelArn: { S: channelArn } },
      UpdateExpression: 'SET #participants = :participants, #updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#participants': 'participants', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: {
        // Shape mirrors lambda/src/lib/participant-shape.ts ParticipantContext. The reader re-derives the
        // focus from `humans`, so an inconsistent triple cannot key the onboarding gate on a bad subject.
        ':participants': {
          M: {
            focus: { S: 'single' },
            humans: { L: [{ S: humanSub }] },
            subject: { S: humanSub },
          },
        },
        ':updatedAt': { S: new Date().toISOString() },
      },
    }));
    console.log('[CreateChannel] participant shape recorded before creation', { channelArn });
  } catch (err) {
    console.warn('[CreateChannel] participant shape write failed (non-fatal):', err && err.name);
  }
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
    const conversationId = newConversationChannelId();
    console.log('Creating conversation:', { conversationId, title, modelId, userArn, requestedTier });

    // Step 0: record the participant shape BEFORE the channel exists. Ordering is the whole mechanism -
    // see writeParticipantContext. The ARN is derived, not read back, precisely because the channel is not
    // there yet.
    const derivedArn = `${appInstanceArn}/channel/${conversationId}`;
    await writeParticipantContext(derivedArn, sub);

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
          // createdBy — the creator's AppInstanceUser ARN (…/user/<sub>), server-set from the JWT
          // callerSub (never the request body). ATTRIBUTION ONLY, for share-conversation and the admin
          // views: channel Metadata is member-WRITABLE (a participant holds UpdateChannel, which sets
          // Name and Metadata in one call), so another member can rewrite this and it must never key a
          // per-user decision or grant anything.
          //
          // It is NOT what the once-per-user onboarding gate reads
          // (SPEC-USER-PROFILE-AND-ONBOARDING.md). That gate reads the participant shape written to the
          // server-only channel-context store ABOVE, before CreateChannel, which no member can write and
          // which is settled by the time WelcomeIntent fires.
          createdBy: userArn,
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

    // Step 1a: Associate the channel flow IMMEDIATELY, before any membership.
    //
    // This used to run last, after both membership calls, and that left a window in which the channel
    // had a bot but no flow. The bot is a member from `CreateChannel` itself (ChimeBearer=botArn), so
    // Lex can fire `WelcomeIntent` from this point on - and every message Amazon Chime SDK materialises
    // during the window bypasses the flow entirely.
    //
    // Measured 2026-08-06, in one channel: the flow was invoked for the user's message and for a
    // Lex-materialised bot message mid-conversation, but NOT for the welcome. A clean-channel probe
    // reproduced it - welcome delivered, zero flow invocations. So the exemption was ours, not a
    // property of Lex-created messages.
    //
    // It matters because the flow is what writes the `corr#<id> -> MessageId` mapping the async
    // processor resolves placeholders from, and what denies a duplicate placeholder. Anything created
    // in the gap has neither. No placeholder is created there today, so this was latent rather than
    // broken - but it is exactly the kind of gap that bites when work moves earlier in this sequence.
    //
    // `CreateChannel` cannot take the flow itself: its input has no channel-flow field (AppInstanceArn,
    // Name, Mode, Privacy, Metadata, ClientRequestToken, Tags, ChimeBearer, ChannelId, MemberArns,
    // ModeratorArns, ElasticChannelConfiguration, ExpirationSettings). Immediately after is the
    // earliest the association can happen.
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
        // Non-fatal: the channel still works, but @assistant/@all routing and the placeholder mapping
        // do not. Log loudly so this is visible in alarms.
        console.error('[CreateChannel] Failed to associate channel flow:', flowErr);
      }
    } else {
      console.warn('[CreateChannel] CHANNEL_FLOW_ARN_PARAM unset or missing — flow not associated');
    }

    // Step 1b: Add the USER as a member + moderator FIRST — BEFORE the bot membership that fires the
    // welcome (step 1c). Ordering matters: the WelcomeIntent handler resolves the creator to gate
    // once-per-user onboarding (SPEC-USER-PROFILE-AND-ONBOARDING), and it does so most reliably by
    // reading the channel's human membership. If the user is added AFTER the welcome-firing bot
    // membership, that membership has not settled when the welcome runs and the creator sometimes fails
    // to resolve, re-onboarding an already-onboarded user (observed ~30% of the time). Adding the user
    // first makes the creator present the instant the welcome fires. (The bot is already a member/
    // moderator from CreateChannel via ChimeBearer=botArn, so the user-add does not depend on the
    // explicit bot membership below.)
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

    // Step 1c: Idempotently ensure the bot is a DEFAULT channel member, so `ListChannelMemberships`
    // returns it — which `@mention` routing needs.
    //
    // This does NOT fire the WelcomeIntent, and the comment here used to claim it did. CORRECTED after
    // testing against live Chime (2026-08-03): a channel created with `ChimeBearer=botArn` auto-adds the bot
    // as a member, and THAT automatic membership is what fires the welcome — a channel created with no
    // `CreateChannelMembership` call at all still receives the composed welcome within seconds. So this call
    // conflicts on every normal creation and exists purely for the membership-listing guarantee.
    //
    // Worth knowing when reasoning about ordering: because the welcome fires on creation, it can arrive
    // BEFORE the user's own membership settles. That is why per-conversation participant context is written
    // ahead of CreateChannel (step 0) rather than read back afterwards.
    // Non-fatal on ConflictException (the expected case).
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
