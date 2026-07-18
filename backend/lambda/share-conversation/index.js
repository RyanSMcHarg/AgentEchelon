const {
  ChimeSDKMessagingClient,
  CreateChannelMembershipCommand,
  ListChannelMembershipsCommand,
  ListChannelMessagesCommand,
  SendChannelMessageCommand,
  DescribeChannelCommand,
  ListTagsForResourceCommand,
} = require('@aws-sdk/client-chime-sdk-messaging');
const {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminListGroupsForUserCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

const messagingClient = new ChimeSDKMessagingClient({});
const cognitoClient = new CognitoIdentityProviderClient({});
const sesClient = new SESClient({});
const ssmClient = new SSMClient({});
const bedrockClient = new BedrockRuntimeClient({});

const APP_INSTANCE_ARN = process.env.APP_INSTANCE_ARN;
const USER_POOL_ID = process.env.USER_POOL_ID;
const SENDER_EMAIL = process.env.SENDER_EMAIL || 'noreply@example.com';
const APP_URL = process.env.APP_URL || 'http://localhost:5173';
const SUMMARY_MODEL_ID =
  process.env.SUMMARY_MODEL_ID || 'anthropic.claude-3-haiku-20240307-v1:0';

const TIER_RANK = { basic: 1, standard: 2, premium: 3 };
const PLACEHOLDER_SENDER = 'noreply@example.com';

// Mirror lib/notification.ts: escape user-controlled text before it lands in
// the HTML email body, so a conversation title (or sender label) can't inject
// markup/links and turn a trusted notification into a phishing primitive.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Shape-check a recipient email before it's interpolated into the Cognito
// ListUsers Filter (a `"` would break out of the quoted literal) and used as
// an SES destination. Deliberately permissive but rejects quotes/whitespace.
const EMAIL_RE = /^[^\s"@]+@[^\s"@]+\.[^\s"@]+$/;

// Resolve the channel's PER-TIER bot (this bot is the channel's creator+member,
// so it holds the authority to add members and send as the assistant). There is
// no shared cross-tier bot fallback: a missing
// per-tier SSM key is an error (the tier stack publishes it on deploy).
const SSM_ROOT = process.env.SSM_ROOT || '/agent-echelon';
// Gate internal error detail out of the HTTP response by default (logged server-side); DEBUG_ERRORS=true echoes it.
const DEBUG_ERRORS = process.env.DEBUG_ERRORS === 'true';
const tierBotArnCache = {};
async function resolveTierBotArn(tier) {
  if (tierBotArnCache[tier]) return tierBotArnCache[tier];
  const key = `${SSM_ROOT}/assistant/${tier}/bot-arn`;
  const resp = await ssmClient.send(new GetParameterCommand({ Name: key }));
  const arn = resp.Parameter?.Value;
  if (!arn) {
    throw new Error(`[Share] per-tier bot param ${key} is empty`);
  }
  tierBotArnCache[tier] = arn;
  return arn;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
  };
}

async function getUserGroupTier(username) {
  try {
    const result = await cognitoClient.send(
      new AdminListGroupsForUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
      })
    );
    const groups = (result.Groups || []).map((g) => g.GroupName);
    if (groups.includes('premium')) return 'premium';
    if (groups.includes('standard')) return 'standard';
    if (groups.includes('basic')) return 'basic';
    return null;
  } catch (err) {
    console.warn('Failed to list groups for user:', username, err.name);
    return null;
  }
}

// The channel's enforced tier comes from the IMMUTABLE `classification` tag, NOT
// `metadata.modelTier`. Metadata is mutable via the owner rename cap (chime:UpdateChannel),
// so trusting it would let a moderator tamper the tier to weaken the over-tier-invite gate
// or attract a higher-tier bot. The tag cannot be changed by UpdateChannel. Fail-closed to basic.
async function getChannelTier(conversationArn, _botArn) {
  const VALID_TIERS = new Set(['basic', 'standard', 'premium']);
  try {
    const resp = await messagingClient.send(
      new ListTagsForResourceCommand({ ResourceARN: conversationArn })
    );
    const tag = (resp.Tags || []).find((t) => t.Key === 'classification')?.Value;
    if (tag && VALID_TIERS.has(tag)) return tag;
    console.warn('[Share][SecurityEvent] channel missing/invalid classification tag; failing closed to basic', {
      conversationArn, tag,
    });
    return 'basic';
  } catch (err) {
    console.warn('Failed to read channel classification tag:', err.name);
    return 'basic';
  }
}

async function listHumanMembers(conversationArn, botArn) {
  const resp = await messagingClient.send(
    new ListChannelMembershipsCommand({
      ChannelArn: conversationArn,
      ChimeBearer: botArn,
      MaxResults: 50,
    })
  );
  const all = resp.ChannelMemberships || [];
  return all.filter((m) => {
    const arn = m.Member?.Arn || '';
    return arn && !arn.includes('/bot/');
  });
}

async function generateHistorySummary(conversationArn, botArn) {
  try {
    const resp = await messagingClient.send(
      new ListChannelMessagesCommand({
        ChannelArn: conversationArn,
        ChimeBearer: botArn,
        MaxResults: 30,
        SortOrder: 'DESCENDING',
      })
    );
    const messages = (resp.ChannelMessages || [])
      .slice()
      .reverse()
      .map((m) => {
        let content = m.Content || '';
        try {
          content = decodeURIComponent(content);
        } catch {
          /* keep raw */
        }
        content = content.replace(/<!--[^>]*-->/g, '').trim();
        const isBot = (m.Sender?.Arn || '').includes('/bot/');
        const name = m.Sender?.Name || (isBot ? 'Assistant' : 'Member');
        return content ? `${name}: ${content}` : null;
      })
      .filter(Boolean);

    if (messages.length === 0) {
      return 'This conversation is empty — no prior history to summarize.';
    }

    const transcript = messages.join('\n');
    const bedrockResp = await bedrockClient.send(
      new ConverseCommand({
        modelId: SUMMARY_MODEL_ID,
        system: [
          {
            text:
              'You summarize chat transcripts for someone who is joining the conversation mid-stream. ' +
              'Produce a 3–5 sentence recap focused on: the topic, the current question or goal, and any decisions made so far. ' +
              'Do not greet the reader. Do not list participants. Write as if briefing a colleague.',
          },
        ],
        messages: [{ role: 'user', content: [{ text: transcript }] }],
        inferenceConfig: { maxTokens: 400, temperature: 0.3 },
      })
    );
    const content = bedrockResp.output?.message?.content?.[0];
    if (content && 'text' in content && content.text) {
      return content.text.trim();
    }
    return 'Summary unavailable — please scroll up to review the conversation history.';
  } catch (err) {
    console.error('Failed to generate history summary:', err);
    return 'Summary unavailable — please scroll up to review the conversation history.';
  }
}

async function announceNewMember(conversationArn, botArn, recipientName, isNowMultiUser) {
  const mentionHint = isNowMultiUser
    ? ' This is now a multi-user conversation — mention **@assistant** or **@all** to get a response from me.'
    : '';
  await messagingClient.send(
    new SendChannelMessageCommand({
      ChannelArn: conversationArn,
      Content: `**${recipientName}** joined the conversation.${mentionHint}`,
      Type: 'STANDARD',
      Persistence: 'PERSISTENT',
      ChimeBearer: botArn,
      Metadata: JSON.stringify({ botResponse: true, systemAnnouncement: 'member_joined' }),
    })
  );
}

async function sendTargetedSummary(conversationArn, botArn, recipientArn, recipientName, summary) {
  await messagingClient.send(
    new SendChannelMessageCommand({
      ChannelArn: conversationArn,
      Content:
        `Welcome, ${recipientName}. Here's a quick recap so you can jump in:\n\n${summary}\n\n` +
        `_Only you can see this message. Mention **@assistant** or **@all** to engage me in the conversation._`,
      Type: 'STANDARD',
      Persistence: 'PERSISTENT',
      ChimeBearer: botArn,
      Target: [{ MemberArn: recipientArn }],
      Metadata: JSON.stringify({ botResponse: true, systemAnnouncement: 'join_summary' }),
    })
  );
}

/**
 * Share a conversation with another user by email.
 * 1. Verify recipient exists in Cognito
 * 2. Enforce tier: recipient's group tier must be >= channel's modelTier
 * 3. Add recipient as a Chime channel member
 * 4. Bot announces the join to the room (with mention hint if now multi-user)
 * 5. Bot sends the new member a targeted history summary
 * 6. Send email notification with deep link
 */
exports.handler = async (event) => {
  // Do NOT dump the full event — it carries the caller's JWT claims (email,
  // sub) and the request body (recipientEmail) into CloudWatch. Log only
  // non-PII request routing info.
  console.log('ShareConversation - Received event:', event.httpMethod, event.resource || event.path || '');

  try {
    // Without auth, a body-supplied senderName + caller identity would be
    // trusted, making this a phishing primitive. The gate is:
    //   1. Cognito authorizer at API Gateway
    //   2. Caller identity pulled from JWT (sub + email)
    //   3. Caller must be a member of conversationArn (verified below)
    const claims = event.requestContext?.authorizer?.claims || {};
    const callerSub = claims.sub || claims['cognito:username'];
    if (!callerSub) {
      return respond(401, { error: 'Unauthorized', code: 'MISSING_CLAIMS' });
    }
    const callerEmailFromJwt = claims.email || null;
    const callerUserArn = `${APP_INSTANCE_ARN}/user/${callerSub}`;

    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    const { conversationArn, conversationTitle, recipientEmail } = body;
    // senderName is NO LONGER taken from the body — it's derived from
    // the caller's JWT email (or a generic label if none) to prevent
    // sender-spoofing in the outbound SES email.
    const senderName = callerEmailFromJwt || 'A user of Agent Echelon';

    if (!conversationArn || !recipientEmail) {
      return respond(400, {
        error: 'conversationArn and recipientEmail are required',
        code: 'MISSING_REQUIRED_FIELDS',
      });
    }

    if (typeof recipientEmail !== 'string' || recipientEmail.length > 254 || !EMAIL_RE.test(recipientEmail)) {
      return respond(400, {
        error: 'recipientEmail is not a valid email address',
        code: 'INVALID_RECIPIENT_EMAIL',
      });
    }

    // Verify caller is a member of the target channel before allowing
    // them to add anyone else.
    try {
      const { DescribeChannelMembershipCommand } = require('@aws-sdk/client-chime-sdk-messaging');
      // Bearer = the caller themselves: they're a member, so they can read their
      // own membership. No shared bot is a member/creator, so it can't.
      await messagingClient.send(
        new DescribeChannelMembershipCommand({
          ChannelArn: conversationArn,
          MemberArn: callerUserArn,
          ChimeBearer: callerUserArn,
        }),
      );
    } catch (membershipErr) {
      console.warn('[Share] caller not a member of channel', {
        callerSub, conversationArn, err: membershipErr.name,
      });
      return respond(403, {
        error: 'Caller is not a member of the target conversation',
        code: 'NOT_A_MEMBER',
      });
    }

    // Step 1: Look up recipient in Cognito
    const listUsersResponse = await cognitoClient.send(
      new ListUsersCommand({
        UserPoolId: USER_POOL_ID,
        Filter: `email = "${recipientEmail}"`,
        Limit: 1,
      })
    );

    const recipientUser = listUsersResponse.Users?.[0];
    if (!recipientUser) {
      return respond(404, {
        error: 'No user found with that email address',
        code: 'USER_NOT_FOUND',
      });
    }

    const recipientSub = recipientUser.Username;
    const recipientUserArn = `${APP_INSTANCE_ARN}/user/${recipientSub}`;
    const recipientName =
      recipientUser.Attributes?.find((a) => a.Name === 'email')?.Value || recipientEmail;

    console.log('Found recipient:', { recipientSub, recipientUserArn });

    // Read the channel's tier as the CALLER (a member): no shared bot is a
    // member/creator, so it can't DescribeChannel. Then resolve the channel's
    // REAL per-tier bot — the
    // creator+member with authority to add members and send as the assistant —
    // and use it for every bot-attributed action below (membership add,
    // announce, recap).
    const channelTier = await getChannelTier(conversationArn, callerUserArn);
    const botArn = await resolveTierBotArn(channelTier);

    // Step 2: Tier enforcement — recipient must have group tier >= channel tier
    const recipientGroupTier = await getUserGroupTier(recipientSub);
    const channelRank = TIER_RANK[channelTier] || 1;
    const recipientRank = TIER_RANK[recipientGroupTier] || 0;

    if (recipientRank < channelRank) {
      console.warn('[Share] Membership admission denied (over-tier invite)', {
        channelTier,
        recipientGroupTier,
        recipientEmail,
      });
      // SPEC-CONVERSATION-SECURITY §4b — error at INVITE time rather than add a
      // member who'd be inert (Layer 1 would deny their send/read anyway).
      return respond(403, {
        error:
          `This user cannot be added to this conversation. Their access level ` +
          `(${recipientGroupTier || 'none'}) does not meet the conversation's ` +
          `${channelTier} tier.`,
        code: 'TIER_FORBIDDEN',
        recipientTier: recipientGroupTier,
        channelTier,
      });
    }

    // Step 3: Add recipient as channel member
    try {
      await messagingClient.send(
        new CreateChannelMembershipCommand({
          ChannelArn: conversationArn,
          MemberArn: recipientUserArn,
          Type: 'DEFAULT',
          ChimeBearer: botArn,
        })
      );
    } catch (membershipErr) {
      if (membershipErr.name === 'ConflictException') {
        console.log('[Share] Recipient already a member, continuing');
      } else {
        throw membershipErr;
      }
    }

    console.log('Recipient added to conversation');

    // Step 4: Announce the join (after membership so the new member sees it too)
    // Count human members AFTER the add to decide whether this flips to multi-user.
    let isNowMultiUser = false;
    try {
      const humans = await listHumanMembers(conversationArn, botArn);
      isNowMultiUser = humans.length > 1;
      await announceNewMember(conversationArn, botArn, recipientName, isNowMultiUser);
    } catch (announceErr) {
      console.error('[Share] Failed to announce new member:', announceErr);
    }

    // Step 5: Targeted history summary for the new user
    try {
      const summary = await generateHistorySummary(conversationArn, botArn);
      await sendTargetedSummary(conversationArn, botArn, recipientUserArn, recipientName, summary);
    } catch (summaryErr) {
      console.error('[Share] Failed to send join summary:', summaryErr);
    }

    // Step 6: Email notification with deep link
    const conversationId = conversationArn.split('/').pop();
    const conversationLink = `${APP_URL}?conversation=${conversationId}`;
    let emailSent = false;
    let emailError;

    if (SENDER_EMAIL === PLACEHOLDER_SENDER) {
      emailError = `SENDER_EMAIL is unset (placeholder). Redeploy with --context senderEmail=<verified address>.`;
      console.warn('[Share] Skipping email send:', emailError);
    } else {
      try {
        await sesClient.send(
          new SendEmailCommand({
            Source: SENDER_EMAIL,
            Destination: { ToAddresses: [recipientEmail] },
            Message: {
              Subject: {
                Data: `${senderName || 'Someone'} shared a conversation with you`,
                Charset: 'UTF-8',
              },
              Body: {
                Text: {
                  Data:
                    `Hi,\n\n${senderName || 'A team member'} has shared the conversation ` +
                    `"${conversationTitle || 'Untitled'}" with you.\n\nView it here: ${conversationLink}\n\n` +
                    `Best regards,\nAgentEchelon`,
                  Charset: 'UTF-8',
                },
                Html: {
                  Data: `
                    <html>
                      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                        <h2 style="color: #2d2d2d;">Conversation Shared With You</h2>
                        <p><strong>${escapeHtml(senderName || 'A team member')}</strong> shared "<strong>${escapeHtml(conversationTitle || 'Untitled')}</strong>" with you.</p>
                        <p style="margin: 24px 0;">
                          <a href="${conversationLink}" style="background: #2d2d2d; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">
                            Open Conversation
                          </a>
                        </p>
                        <p style="color: #8e8e8e; font-size: 14px;">AgentEchelon</p>
                      </body>
                    </html>
                  `,
                  Charset: 'UTF-8',
                },
              },
            },
          })
        );
        emailSent = true;
        console.log('Email notification sent to', recipientEmail);
      } catch (err) {
        emailError = err.message || String(err);
        console.error('Failed to send email notification:', err);
      }
    }

    return respond(200, {
      success: true,
      recipientName,
      isNowMultiUser,
      emailSent,
      ...(emailError && { emailError }),
    });
  } catch (error) {
    console.error('Error sharing conversation:', error);
    return respond(500, {
      error: DEBUG_ERRORS ? error.message : 'Could not share the conversation. Please try again; if it persists, contact an administrator.',
      code: 'SHARE_FAILED',
    });
  }
};
