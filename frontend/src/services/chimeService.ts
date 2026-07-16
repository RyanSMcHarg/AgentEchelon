import {
  ChimeSDKMessagingClient,
  DeleteChannelMembershipCommand,
  SendChannelMessageCommand,
  ListChannelMessagesCommand,
  ListChannelMembershipsForAppInstanceUserCommand,
  ListChannelMembershipsCommand,
  DescribeChannelCommand,
  UpdateChannelCommand,
  UpdateChannelReadMarkerCommand,
  RedactChannelMessageCommand,
  DeleteChannelMessageCommand,
  CreateChannelMembershipCommand,
  CreateChannelModeratorCommand,
  ListChannelModeratorsCommand,
  ChannelMessageType,
  ChannelMessagePersistenceType,
} from '@aws-sdk/client-chime-sdk-messaging';
import { CognitoIdentityClient } from '@aws-sdk/client-cognito-identity';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-provider-cognito-identity';
import type { Conversation, Message, UserTier, ChannelMember, AdminConversationMember } from '../types';
import { trackEvent } from './eventTrackingService';
import {
  parseMessageContent,
  parseActiveTaskFromMetadata,
  parseMessageFeedbackFromMetadata,
  unwrapLexEnvelope,
} from '../utils/messageParser';

export interface ShareConversationResult {
  recipientName: string;
  isNowMultiUser: boolean;
  emailSent: boolean;
  emailError?: string;
}

const REGION = import.meta.env.VITE_AWS_REGION || 'us-east-1';
const APP_INSTANCE_ARN = import.meta.env.VITE_APP_INSTANCE_ARN;
const IDENTITY_POOL_ID = import.meta.env.VITE_IDENTITY_POOL_ID;
// Credential Exchange Service (SPEC-CREDENTIAL-EXCHANGE). When set, credentials are
// vended by the backend exchange (bearer-pinned to the caller's own AppInstanceUser)
// instead of the Identity Pool. Unset ⇒ the Identity-Pool path. Set the env after the
// exchange is deployed + deny-tested.
const CREDENTIAL_EXCHANGE_API_URL = import.meta.env.VITE_CREDENTIAL_EXCHANGE_API_URL;

/**
 * An AWS SDK credentials provider that fetches STS creds from the backend
 * Credential Exchange. Returns a provider (not static creds) so the SDK
 * auto-refreshes by re-calling the exchange when the session nears expiry; the
 * `idToken` is the Cognito ID token the exchange's API-GW authorizer validates.
 */
function exchangeCredentialsProvider(exchangeApiUrl: string, idToken: string) {
  const url = `${exchangeApiUrl.replace(/\/$/, '')}/exchange-credentials`;
  return async () => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body: '{}', // identity comes from the validated token, never the body (IDOR guard)
    });
    if (!resp.ok) throw new Error(`Credential exchange failed: ${resp.status}`);
    const data = await resp.json();
    const c = data.credentials;
    return {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration ? new Date(c.Expiration) : undefined,
    };
  };
}

/**
 * Vend an ADMIN-plane credential. The exchange provisions/uses the caller's SEPARATE
 * `${sub}-admin` identity (a standing app-instance-admin), scopes the cred to ONE channel
 * plus the requested capabilities, keeps it short-lived, and records the access
 * server-side (`admin_scoped_credential_vend`). Returns static creds + the admin
 * ChimeBearer ARN to name on the calls. Fetched eagerly (not a refreshing provider)
 * because each admin action is a discrete, immediate operation — the cred is meant to
 * expire, not renew. This is the admin acting as their OWN identity; there is no
 * server-side bearer swap.
 */
async function vendAdminCreds(
  channelArn: string,
  capabilities: string[],
): Promise<{
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration?: Date };
  adminArn: string;
}> {
  if (!CREDENTIAL_EXCHANGE_API_URL) {
    throw new Error('Admin moderation requires the Credential Exchange (VITE_CREDENTIAL_EXCHANGE_API_URL)');
  }
  const idToken = localStorage.getItem('idToken');
  if (!idToken) throw new Error('Not authenticated');
  const url = `${CREDENTIAL_EXCHANGE_API_URL.replace(/\/$/, '')}/exchange-credentials`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: 'admin', channelArn, capabilities }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({} as { error?: string }));
    throw new Error(body.error || `Admin credential exchange failed: ${resp.status}`);
  }
  const data = await resp.json();
  const c = data.credentials;
  return {
    credentials: {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration ? new Date(c.Expiration) : undefined,
    },
    adminArn: data.userArn,
  };
}

/** A short-lived messaging client bound to the admin identity, scoped to one channel. */
async function adminClientFor(
  channelArn: string,
  capabilities: string[],
): Promise<{ client: ChimeSDKMessagingClient; adminArn: string }> {
  const { credentials, adminArn } = await vendAdminCreds(channelArn, capabilities);
  const client = new ChimeSDKMessagingClient({ region: REGION, credentials });
  return { client, adminArn };
}

/**
 * Vend a short-lived CHAT-plane credential scoped to one channel with the `rename`
 * capability (chime:UpdateChannel), and return a client bound to it. Unlike the
 * admin plane, this acts as the caller's OWN `${sub}` identity; Chime authorizes
 * the UpdateChannel only if they are a ChannelModerator of the channel (a
 * conversation's creator is), so a non-moderator member is denied server-side.
 */
async function renameClientFor(channelArn: string): Promise<ChimeSDKMessagingClient> {
  if (!CREDENTIAL_EXCHANGE_API_URL) {
    throw new Error('Renaming requires the Credential Exchange (VITE_CREDENTIAL_EXCHANGE_API_URL)');
  }
  const idToken = localStorage.getItem('idToken');
  if (!idToken) throw new Error('Not authenticated');
  const url = `${CREDENTIAL_EXCHANGE_API_URL.replace(/\/$/, '')}/exchange-credentials`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelArn, capabilities: ['rename'] }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({} as { error?: string }));
    throw new Error(body.error || `Rename credential exchange failed: ${resp.status}`);
  }
  const data = await resp.json();
  const c = data.credentials;
  return new ChimeSDKMessagingClient({
    region: REGION,
    credentials: {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
      expiration: c.Expiration ? new Date(c.Expiration) : undefined,
    },
  });
}


/**
 * Service for interacting with AWS Chime SDK Messaging
 */
class ChimeService {
  private messagingClient: ChimeSDKMessagingClient | null = null;
  private userArn: string | null = null;

  /**
   * Initialize the Chime SDK clients with Cognito credentials
   */
  async initialize(idToken: string, userId: string): Promise<void> {
    try {
      // Create credentials provider using Cognito Identity Pool.
      // The `client` option's expected type comes from @aws-sdk/nested-clients
      // (which fromCognitoIdentityPool re-bundles) but our
      // @aws-sdk/client-cognito-identity ships an equivalent class via a
      // different submodule path. Structurally identical, nominally distinct
      // to TypeScript. Cast through unknown.
      // Credential source: the backend Credential Exchange (bearer-pinned) when
      // configured, else the Identity Pool. Both are SDK credential
      // providers, so the client refreshes transparently.
      const credentials = CREDENTIAL_EXCHANGE_API_URL
        ? exchangeCredentialsProvider(CREDENTIAL_EXCHANGE_API_URL, idToken)
        : fromCognitoIdentityPool({
            client: new CognitoIdentityClient({ region: REGION }) as unknown as Parameters<typeof fromCognitoIdentityPool>[0]['client'],
            identityPoolId: IDENTITY_POOL_ID!,
            logins: {
              [`cognito-idp.${REGION}.amazonaws.com/${import.meta.env.VITE_USER_POOL_ID}`]: idToken,
            },
          });

      // Initialize Chime SDK clients
      this.messagingClient = new ChimeSDKMessagingClient({
        region: REGION,
        credentials,
      });

      // Get App Instance User ARN (created by Lambda post-confirmation trigger)
      this.userArn = `${APP_INSTANCE_ARN}/user/${userId}`;

      console.log('Chime SDK initialized successfully', { userArn: this.userArn });
    } catch (error) {
      console.error('Failed to initialize Chime SDK:', error);
      throw error;
    }
  }

  /**
   * Create a new conversation via backend API
   * This ensures conversation creation and AI agent addition happen atomically
   */
  async createConversation(
    title: string,
    modelId: string,
    modelName: string,
    modelTier: UserTier,
    // Optional contextual seed: when provided, the create-conversation
    // lambda posts a Haiku-derived welcome message into the channel so
    // the chat opens with a real, on-topic first turn from the bot.
    topic?: string,
  ): Promise<Conversation> {
    if (!this.userArn) {
      throw new Error('Chime SDK not initialized');
    }

    try {
      // Support both new and legacy env var names
      const createConversationApiUrl = import.meta.env.VITE_CREATE_CONVERSATION_API_URL
        || import.meta.env.VITE_CREATE_CHANNEL_API_URL;
      if (!createConversationApiUrl) {
        throw new Error('VITE_CREATE_CONVERSATION_API_URL not configured');
      }

      console.log('Creating conversation via backend API:', { title, modelId, modelName, modelTier });

      // /create-conversation requires the Cognito authorizer (it is not
      // anonymous). Attach the ID token the same way
      // every other authed service does; without it API Gateway returns a 401
      // with no CORS header, which surfaces in the browser as a misleading
      // "No Access-Control-Allow-Origin" error.
      const idToken = localStorage.getItem('idToken');
      const response = await fetch(createConversationApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        },
        body: JSON.stringify({
          title,
          modelId,
          modelName,
          modelTier,
          userArn: this.userArn,
          ...(topic ? { topic } : {}),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to create conversation: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      console.log('Conversation created successfully:', data);

      return {
        ...data.conversation,
        createdAt: new Date(data.conversation.createdAt),
        updatedAt: new Date(data.conversation.updatedAt),
      };
    } catch (error) {
      console.error('Failed to create conversation:', error);
      throw error;
    }
  }

  /**
   * List all conversations for the current user
   */
  async listConversations(): Promise<Conversation[]> {
    if (!this.messagingClient || !this.userArn) {
      throw new Error('Chime SDK not initialized');
    }

    try {
      const response = await this.messagingClient.send(
        new ListChannelMembershipsForAppInstanceUserCommand({
          AppInstanceUserArn: this.userArn,
          ChimeBearer: this.userArn,
        })
      );

      const conversations: Conversation[] = [];

      for (const membership of response.ChannelMemberships || []) {
        const channel = membership.ChannelSummary;
        if (!channel || !channel.ChannelArn) continue;

        let metadata: any = {};
        try {
          if (channel.Metadata) {
            metadata = JSON.parse(channel.Metadata);
          }
        } catch (e) {
          console.warn('Failed to parse channel metadata:', e);
        }

        // Archived conversations are RETAINED in the list (membership is not removed,
        // so members keep read-only access until the channel expires — SPEC-CONVERSATION-
        // ARCHIVE, ADR-017). They are flagged here and hidden from the active list by
        // the "Show archived" toggle in the sidebar, not dropped. `metadata.archived`
        // is the display mirror of the authoritative `archived` channel tag.
        const isArchived = metadata.archived === true;

        const lastMessageAt = channel.LastMessageTimestamp
          ? new Date(channel.LastMessageTimestamp)
          : undefined;
        // Chime SDK native per-member read marker. Eventually consistent —
        // the ConversationProvider combines this with a local viewedAt map.
        const lastReadAt = membership.AppInstanceUserMembershipSummary?.ReadMarkerTimestamp
          ? new Date(membership.AppInstanceUserMembershipSummary.ReadMarkerTimestamp)
          : undefined;

        conversations.push({
          id: channel.ChannelArn.split('/').pop() || '',
          conversationArn: channel.ChannelArn,
          title: channel.Name || 'Untitled Conversation',
          modelId: metadata.modelId || 'anthropic.claude-3-haiku-20240307-v1:0',
          modelName: metadata.modelName || 'Claude Haiku',
          modelTier: metadata.modelTier || 'basic',
          createdAt: (channel as any).CreatedTimestamp ? new Date((channel as any).CreatedTimestamp) : new Date(),
          updatedAt: lastMessageAt || new Date(),
          lastMessage: lastMessageAt ? 'View messages' : undefined,
          lastMessageAt,
          lastReadAt,
          archived: isArchived,
        });
      }

      return conversations;
    } catch (error) {
      console.error('Failed to list conversations:', error);
      throw error;
    }
  }

  /**
   * Resolve a single conversation by its channel id (the last ARN segment) or
   * a full channel ARN, by describing the channel directly — independent of
   * the paginated conversation list.
   *
   * This follows the deep-link pattern where a channel is opened from an ARN
   * carried in a link (resolved via DescribeChannel) rather than found in a
   * loaded list. AE needs this so a share / proactive-briefing email deep link
   * (`?conversation=<id>`)
   * resolves even when the channel isn't in the recipient's sidebar yet (past
   * the first page, or freshly shared). Returns null when the channel can't be
   * described (caller isn't a member, or it doesn't exist).
   */
  async getConversation(conversationIdOrArn: string): Promise<Conversation | null> {
    if (!this.messagingClient || !this.userArn) {
      throw new Error('Chime SDK not initialized');
    }

    const channelArn = conversationIdOrArn.startsWith('arn:')
      ? conversationIdOrArn
      : `${APP_INSTANCE_ARN}/channel/${conversationIdOrArn}`;

    try {
      const response = await this.messagingClient.send(
        new DescribeChannelCommand({
          ChannelArn: channelArn,
          ChimeBearer: this.userArn,
        })
      );

      const channel = response.Channel;
      if (!channel || !channel.ChannelArn) return null;

      let metadata: any = {};
      try {
        if (channel.Metadata) {
          metadata = JSON.parse(channel.Metadata);
        }
      } catch (e) {
        console.warn('Failed to parse channel metadata:', e);
      }

      const lastMessageAt = channel.LastMessageTimestamp
        ? new Date(channel.LastMessageTimestamp)
        : undefined;

      return {
        id: channel.ChannelArn.split('/').pop() || '',
        conversationArn: channel.ChannelArn,
        title: channel.Name || 'Untitled Conversation',
        modelId: metadata.modelId || 'anthropic.claude-3-haiku-20240307-v1:0',
        modelName: metadata.modelName || 'Claude Haiku',
        modelTier: metadata.modelTier || 'basic',
        createdAt: channel.CreatedTimestamp ? new Date(channel.CreatedTimestamp) : new Date(),
        updatedAt: lastMessageAt || new Date(),
        lastMessage: lastMessageAt ? 'View messages' : undefined,
        lastMessageAt,
        lastReadAt: undefined,
      };
    } catch (error) {
      console.warn(`getConversation: could not describe channel ${channelArn}:`, error);
      return null;
    }
  }

  /**
   * Send a message to a conversation.
   *
   * `targetArn` sets the Chime SDK Target field — the message is then visible
   * only to the sender and that target ARN. `mentionBotArn` sets the
   * CHIME.mentions message attribute; combined with the bot's
   * `StandardMessages: AUTO` configuration, this is what makes AUTO route the
   * message to the bot in multi-member channels.
   */
  async sendMessage(
    channelArn: string,
    content: string,
    metadata?: Record<string, unknown>,
    options?: { targetArn?: string; mentionBotArn?: string },
  ): Promise<Message> {
    if (!this.messagingClient || !this.userArn) {
      throw new Error('Chime SDK not initialized');
    }

    try {
      const command: Record<string, unknown> = {
        ChannelArn: channelArn,
        Content: content,
        Type: ChannelMessageType.STANDARD,
        Persistence: ChannelMessagePersistenceType.PERSISTENT,
        ChimeBearer: this.userArn,
      };

      if (metadata) {
        command.Metadata = JSON.stringify(metadata);
      }

      if (options?.targetArn) {
        command.Target = [{ MemberArn: options.targetArn }];
      }

      // The caller (MessageInput → parseMentions) resolves @<MemberName>
      // against channelMembers and sets options.mentionBotArn to the bot's
      // actual ARN — whichever bot was @-mentioned, regardless of its name
      // (Atlas / Echo / Assistant / anything). Chime AUTO routes the
      // message to that bot via the CHIME.mentions attribute, and the
      // bot's TargetedMessages: ALL produces the targeted reply. Don't
      // synthesise an ARN here from a string match — that would stamp the
      // wrong bot if the channel's actual member has a non-default name.
      if (options?.mentionBotArn) {
        command.MessageAttributes = {
          'CHIME.mentions': { StringValues: [options.mentionBotArn] },
        };
      }

      const response = await this.messagingClient.send(
        new SendChannelMessageCommand(command as any)
      );

      return {
        id: response.MessageId || `msg-${Date.now()}`,
        content,
        sender: {
          arn: this.userArn,
          name: 'You',
        },
        timestamp: new Date(),
        isBot: false,
        status: 'sent',
      };
    } catch (error) {
      console.error('Failed to send message:', error);
      throw error;
    }
  }

  /**
   * List messages in a conversation
   */
  async listMessages(channelArn: string): Promise<Message[]> {
    if (!this.messagingClient || !this.userArn) {
      throw new Error('Chime SDK not initialized');
    }

    // Engagement signal — a user reading messages without typing still counts
    // as an active messaging user (see active_messaging_users_daily query).
    trackEvent('channel_messages_listed', { channelArn });

    try {
      const response = await this.messagingClient.send(
        new ListChannelMessagesCommand({
          ChannelArn: channelArn,
          ChimeBearer: this.userArn,
          MaxResults: 50,
        })
      );

      const messages: Message[] = [];

      for (const msg of response.ChannelMessages || []) {
        if (!msg.MessageId || !msg.Content) continue;

        // Filter out Lex's empty message responses
        // These appear as {"Messages":[]} with ContentType application/amz-chime-lex-msgs
        if (msg.ContentType === 'application/amz-chime-lex-msgs') {
          try {
            const parsed = JSON.parse(msg.Content);
            if (parsed.Messages && Array.isArray(parsed.Messages) && parsed.Messages.length === 0) {
              continue; // Skip empty Lex responses
            }
          } catch (e) {
            // If we can't parse it, include it
          }
        }

        // Parse metadata to check if it's a bot message
        let metadata: any = {};
        try {
          if (msg.Metadata) {
            metadata = JSON.parse(msg.Metadata);
          }
        } catch (e) {
          // Ignore metadata parse errors
        }

        const isBot = metadata.botResponse || msg.Sender?.Arn?.includes('/bot/');
        // Unwrap the Lex fulfillment envelope (e.g. the WelcomeIntent greeting)
        // BEFORE decoding, so users never see raw `{"Messages":[…]}` JSON.
        const { content: cleanContent, activeTask: contentTask, navigateChannel, battle, battleWaiting, battleImage } = parseMessageContent(decodeURIComponent(unwrapLexEnvelope(msg.Content, msg.ContentType)));
        const metadataTask = parseActiveTaskFromMetadata(metadata);
        const msgTargets = (msg as { Target?: Array<{ MemberArn?: string }> }).Target;
        const targetedToUser = Array.isArray(msgTargets)
          && msgTargets.some((t) => t?.MemberArn === this.userArn);

        messages.push({
          id: msg.MessageId,
          content: cleanContent,
          sender: {
            arn: msg.Sender?.Arn || '',
            name: msg.Sender?.Name || (isBot ? 'Assistant' : 'Unknown'),
          },
          timestamp: msg.CreatedTimestamp ? new Date(msg.CreatedTimestamp) : new Date(),
          isBot,
          activeTask: metadataTask || contentTask || undefined,
          attachment: metadata.attachment || undefined,
          modelId: typeof metadata.bedrockModel === 'string' ? metadata.bedrockModel : undefined,
          intent: typeof metadata.intent === 'string' ? metadata.intent : undefined,
          // Experiment feedback join — top-level
          // analytics-metadata keys; carried so a thumbs vote attributes per-variant.
          experimentId: typeof metadata.experimentId === 'string' ? metadata.experimentId : undefined,
          variantId: typeof metadata.variantId === 'string' ? metadata.variantId : undefined,
          assignmentMode: typeof metadata.assignmentMode === 'string' ? metadata.assignmentMode : undefined,
          feedback: parseMessageFeedbackFromMetadata(metadata),
          status: 'sent',
          targetedToUser: targetedToUser || undefined,
          // Multi-part response grouping
          responseGroup: typeof metadata.responseGroup === 'string' ? metadata.responseGroup : undefined,
          continuation: metadata.continuation === true,
          part: typeof metadata.part === 'number' ? metadata.part : undefined,
          totalParts: typeof metadata.totalParts === 'number' ? metadata.totalParts : undefined,
          // Drift-confirm redirect signal
          navigateChannel: navigateChannel || undefined,
          // /battle marker
          battle: battle || undefined,
          battleWaiting: battleWaiting || undefined,
          battleImage: battleImage || undefined,
        });
      }

      // Sort by timestamp (oldest first)
      return messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    } catch (error) {
      console.error('Failed to list messages:', error);
      throw error;
    }
  }

  /**
   * List members of a channel
   */
  async listChannelMembers(channelArn: string): Promise<ChannelMember[]> {
    if (!this.messagingClient || !this.userArn) {
      throw new Error('Chime SDK not initialized');
    }

    try {
      const response = await this.messagingClient.send(
        new ListChannelMembershipsCommand({
          ChannelArn: channelArn,
          ChimeBearer: this.userArn,
        })
      );

      return (response.ChannelMemberships || []).map((m) => ({
        userArn: m.Member?.Arn || '',
        name: m.Member?.Name || 'Unknown',
        isBot: m.Member?.Arn?.includes('/bot/') || false,
      }));
    } catch (error) {
      console.error('Failed to list channel members:', error);
      return [];
    }
  }

  /**
   * The channel's LIVE moderator ARNs, read from Chime's authoritative
   * ListChannelModerators — the source of truth for "who is a moderator right
   * now", never inferred from createdBy. Returns a Set of AppInstanceUser ARNs.
   * Empty on error (fail-closed: a failed read treats no one as a moderator).
   */
  async listModerators(channelArn: string): Promise<Set<string>> {
    if (!this.messagingClient || !this.userArn) {
      throw new Error('Chime SDK not initialized');
    }
    try {
      const response = await this.messagingClient.send(
        new ListChannelModeratorsCommand({
          ChannelArn: channelArn,
          ChimeBearer: this.userArn,
        })
      );
      return new Set(
        (response.ChannelModerators || [])
          .map((mod) => mod.Moderator?.Arn)
          .filter((arn): arn is string => !!arn),
      );
    } catch (error) {
      console.error('Failed to list channel moderators:', error);
      return new Set();
    }
  }

  /**
   * Rename a conversation (channel). Persists via Chime UpdateChannel using a
   * short-lived, channel-scoped `rename` credential vended on the caller's own
   * identity. Chime authorizes it on ChannelModerator status — a conversation's
   * creator is a moderator — so a non-owner member is rejected server-side.
   * Mode + Metadata are preserved (UpdateChannel replaces the channel's mutable
   * fields). The new name propagates to every client via the Chime channel-update
   * event, in addition to the caller's optimistic local update.
   */
  async updateChannelName(channelArn: string, name: string): Promise<void> {
    if (!this.messagingClient || !this.userArn) throw new Error('Chime client not initialized');
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Title cannot be empty');
    // DescribeChannel (in the default `view` cap) to preserve Mode + Metadata.
    const described = await this.messagingClient.send(
      new DescribeChannelCommand({ ChannelArn: channelArn, ChimeBearer: this.userArn })
    );
    const client = await renameClientFor(channelArn);
    await client.send(
      new UpdateChannelCommand({
        ChannelArn: channelArn,
        Name: trimmed,
        Mode: described.Channel?.Mode,
        Metadata: described.Channel?.Metadata,
        ChimeBearer: this.userArn,
      })
    );
  }

  /**
   * Mark a conversation as read up to "now". Uses Chime SDK's native
   * per-member read marker (UpdateChannelReadMarker). The marker persists
   * across sessions but is eventually consistent — combine with an in-
   * memory viewedAt map if you need immediate reads.
   */
  async markConversationRead(channelArn: string): Promise<void> {
    if (!this.messagingClient || !this.userArn) return;
    try {
      await this.messagingClient.send(
        new UpdateChannelReadMarkerCommand({
          ChannelArn: channelArn,
          ChimeBearer: this.userArn,
        })
      );
    } catch (error) {
      // Non-fatal — stale read marker just means the conversation stays
      // flagged as unread until the next successful call.
      console.warn('Failed to update channel read marker:', error);
    }
  }

  /**
   * Remove a member from a channel. Caller must be a moderator — Chime will
   * reject with 403 otherwise. This SDK call uses the caller's own userArn
   * as the ChimeBearer, so the server-side authorization decision is made
   * against the calling user (not the bot).
   */
  async removeMember(channelArn: string, memberArn: string): Promise<void> {
    if (!this.messagingClient || !this.userArn) {
      throw new Error('Chime SDK not initialized');
    }
    await this.messagingClient.send(
      new DeleteChannelMembershipCommand({
        ChannelArn: channelArn,
        MemberArn: memberArn,
        ChimeBearer: this.userArn,
      })
    );
  }

  /**
   * Share a conversation with another user via email
   */
  async shareConversation(
    conversationArn: string,
    conversationTitle: string,
    recipientEmail: string,
    senderName: string
  ): Promise<ShareConversationResult> {
    const shareApiUrl = import.meta.env.VITE_SHARE_CONVERSATION_API_URL;
    if (!shareApiUrl) {
      throw new Error('VITE_SHARE_CONVERSATION_API_URL not configured');
    }

    // The /share-conversation API sits
    // behind a Cognito authorizer (caller identity is pulled from the JWT,
    // not the body). Without the Bearer token API Gateway rejects with 401
    // before the Lambda ever runs and the modal shows a generic failure.
    // Matches the same idToken pattern used by createConversation above.
    const idToken = localStorage.getItem('idToken');
    const response = await fetch(shareApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      },
      body: JSON.stringify({
        conversationArn,
        conversationTitle,
        recipientEmail,
        senderName,
      }),
    });

    const bodyText = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      /* non-JSON error body */
    }

    if (!response.ok) {
      const code = (parsed.code as string) || `HTTP_${response.status}`;
      const message = (parsed.error as string) || bodyText || `HTTP ${response.status}`;
      const err: Error & { code?: string } = new Error(message);
      err.code = code;
      throw err;
    }

    return {
      recipientName: (parsed.recipientName as string) || recipientEmail,
      isNowMultiUser: !!parsed.isNowMultiUser,
      emailSent: !!parsed.emailSent,
      emailError: parsed.emailError as string | undefined,
    };
  }

  /**
   * ADMIN moderation, performed as the admin's OWN `${sub}-admin` identity, client-side.
   * Each call vends a fresh, channel-scoped, short-lived, audited credential (plane:'admin')
   * and names the admin ChimeBearer, so the elevated authority never attaches to the chat
   * cred and every action is attributable server-side. This replaces the old server-side
   * (service-admin bearer) moderation path — the actor now uses their own identity.
   */
  async adminRedactMessage(channelArn: string, messageId: string): Promise<void> {
    const { client, adminArn } = await adminClientFor(channelArn, ['redact']);
    await client.send(new RedactChannelMessageCommand({ ChannelArn: channelArn, MessageId: messageId, ChimeBearer: adminArn }));
    trackEvent('admin_message_redacted', { channelArn });
  }

  async adminDeleteMessage(channelArn: string, messageId: string): Promise<void> {
    const { client, adminArn } = await adminClientFor(channelArn, ['delete']);
    await client.send(new DeleteChannelMessageCommand({ ChannelArn: channelArn, MessageId: messageId, ChimeBearer: adminArn }));
    trackEvent('admin_message_deleted', { channelArn });
  }

  async adminRemoveMember(channelArn: string, memberArn: string): Promise<void> {
    const { client, adminArn } = await adminClientFor(channelArn, ['manage-membership']);
    await client.send(new DeleteChannelMembershipCommand({ ChannelArn: channelArn, MemberArn: memberArn, ChimeBearer: adminArn }));
    trackEvent('admin_member_removed', { channelArn });
  }

  /** List a channel's live members as the admin identity (scoped, audited view). */
  async adminListMembers(channelArn: string): Promise<AdminConversationMember[]> {
    const { client, adminArn } = await adminClientFor(channelArn, ['view']);
    const response = await client.send(new ListChannelMembershipsCommand({
      ChannelArn: channelArn, ChimeBearer: adminArn, MaxResults: 50,
    }));
    return (response.ChannelMemberships || []).map((m) => {
      const memberArn = m.Member?.Arn || '';
      return {
        memberArn,
        name: m.Member?.Name || 'Unknown',
        type: 'DEFAULT' as const,
        isBot: memberArn.includes('/bot/'),
      };
    });
  }

  async adminAddMember(
    channelArn: string,
    memberArn: string,
    type: 'DEFAULT' | 'HIDDEN' = 'DEFAULT',
    moderator = false,
  ): Promise<void> {
    const { client, adminArn } = await adminClientFor(channelArn, ['manage-membership']);
    try {
      await client.send(new CreateChannelMembershipCommand({
        ChannelArn: channelArn, MemberArn: memberArn, Type: type, ChimeBearer: adminArn,
      }));
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConflictException') throw err;
    }
    if (moderator && type === 'DEFAULT') {
      await client.send(new CreateChannelModeratorCommand({
        ChannelArn: channelArn, ChannelModeratorArn: memberArn, ChimeBearer: adminArn,
      }));
    }
    trackEvent('admin_member_added', { channelArn });
  }

  /** Add the admin's OWN chat identity to a conversation (to observe or participate). */
  async adminAddSelf(channelArn: string, type: 'DEFAULT' | 'HIDDEN' = 'HIDDEN', moderator = false): Promise<void> {
    if (!this.userArn) throw new Error('Chime SDK not initialized');
    await this.adminAddMember(channelArn, this.userArn, type, moderator);
  }

  /**
   * Get the current user ARN
   */
  getUserArn(): string | null {
    return this.userArn;
  }

  /**
   * Get the messaging client instance (for WebSocket subscriptions)
   */
  getMessagingClient(): ChimeSDKMessagingClient | null {
    return this.messagingClient;
  }
}

// Export singleton instance
export const chimeService = new ChimeService();
