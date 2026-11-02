import {
  ChimeSDKMessagingClient,
  DeleteChannelMembershipCommand,
  SendChannelMessageCommand,
  ListChannelMessagesCommand,
  ListChannelMembershipsForAppInstanceUserCommand,
  type ChannelMembershipForAppInstanceUserSummary,
  ListChannelMembershipsCommand,
  DescribeChannelCommand,
  UpdateChannelCommand,
  UpdateChannelReadMarkerCommand,
  ListChannelModeratorsCommand,
  ChannelMessageType,
  ChannelMessagePersistenceType,
} from '@aws-sdk/client-chime-sdk-messaging';
import type { Conversation, Message, UserTier, ChannelMember } from '@ae/shared';
import { isDeclaredClassification } from '@ae/shared/config/classifications.ts';
import {
  REGION,
  APP_INSTANCE_ARN,
  PERSON_API_URL,
  personApiServes,
  personUrl,
  exchangeCredentialsProvider,
  exchangeCredentials,
  trackEvent,
  parseMessageContent,
  decodeMessageText,
  parseActiveTaskFromMetadata,
  parseMessageFeedbackFromMetadata,
  unwrapLexEnvelope,
  isEmptyLexEnvelope,
  isAssistantArn,
} from '@ae/shared';
import { liftTurnStateFields } from './turnStateFields';
import { proposalFromMetadata } from './proposalService';
import { taskCardFromMetadata } from './taskCardService';

export interface ShareConversationResult {
  recipientName: string;
  isNowMultiUser: boolean;
}

/**
 * The classification a channel's Metadata claims, for DISPLAY only, or undefined.
 *
 * Metadata is member-writable (`chime:UpdateChannel`), so this value is never trusted for a decision and
 * never defaulted: an absent value, or one the deployment does not declare (`GET /classifications`), is
 * absent, and the badge it would label is hidden.
 * The classification that governs access is the channel's immutable tag, enforced by IAM.
 */
export function metadataClassification(value: unknown): UserTier | undefined {
  return isDeclaredClassification(value) ? value : undefined;
}

/**
 * One membership summary as the Conversation the sidebar renders, or null when the row carries no channel.
 *
 * Extracted from `listConversations` so a page can be converted the moment it arrives rather than after
 * every page has been fetched - see that method for why eagerness there was the wrong shape.
 */
function toConversation(membership: ChannelMembershipForAppInstanceUserSummary): Conversation | null {
  const channel = membership.ChannelSummary;
  if (!channel?.ChannelArn) return null;

  let metadata: Record<string, unknown> = {};
  try {
    if (channel.Metadata) metadata = JSON.parse(channel.Metadata) as Record<string, unknown>;
  } catch (e) {
    console.warn('Failed to parse channel metadata:', e);
  }

  // Archived conversations are RETAINED in the list (membership is not removed, so members keep read-only
  // access until the channel expires — SPEC-CONVERSATION-ARCHIVE, ADR-017). They are flagged here and hidden
  // from the active list by the "Show archived" toggle in the sidebar, not dropped. `metadata.archived` is
  // the display mirror of the authoritative `archived` channel tag.
  const isArchived = metadata.archived === true;

  const lastMessageAt = channel.LastMessageTimestamp ? new Date(channel.LastMessageTimestamp) : undefined;
  // Chime SDK native per-member read marker. Eventually consistent — the ConversationProvider combines
  // this with a local viewedAt map.
  const lastReadAt = membership.AppInstanceUserMembershipSummary?.ReadMarkerTimestamp
    ? new Date(membership.AppInstanceUserMembershipSummary.ReadMarkerTimestamp)
    : undefined;

  return {
    id: channel.ChannelArn.split('/').pop() || '',
    conversationArn: channel.ChannelArn,
    title: channel.Name || 'Untitled Conversation',
    modelId: (metadata.modelId as string) || 'anthropic.claude-3-haiku-20240307-v1:0',
    modelName: (metadata.modelName as string) || 'Claude Haiku',
    modelTier: metadataClassification(metadata.modelTier),
    createdAt: (channel as { CreatedTimestamp?: Date }).CreatedTimestamp
      ? new Date((channel as { CreatedTimestamp?: Date }).CreatedTimestamp as Date)
      : new Date(),
    updatedAt: lastMessageAt || new Date(),
    lastMessage: lastMessageAt ? 'View messages' : undefined,
    lastMessageAt,
    lastReadAt,
    archived: isArchived,
    ...(typeof metadata.membershipSource === 'string' && metadata.membershipSource
      ? { membershipSource: metadata.membershipSource as string } : {}),
  };
}

/**
 * A drift redirect recorded on a message's Chime Metadata: the conversation this one continued into.
 *
 * Tolerant, and returns undefined rather than a partial object. A half-formed value would render a link that
 * goes nowhere, which is worse than rendering nothing - the announcement text still reads sensibly on its own.
 */
function parseDriftRedirect(raw: unknown): { childChannelArn: string; label: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const childChannelArn = typeof r.childChannelArn === 'string' ? r.childChannelArn.trim() : '';
  if (!childChannelArn) return undefined;
  const label = typeof r.label === 'string' && r.label.trim() ? r.label.trim() : 'the new conversation';
  return { childChannelArn, label };
}

/**
 * Vend a short-lived CHAT-plane credential scoped to one channel with the `rename`
 * capability (chime:UpdateChannel), and return a client bound to it. Unlike the
 * admin plane, this acts as the caller's OWN AppInstanceUser; Chime authorizes
 * the UpdateChannel only if they are a ChannelModerator of the channel (a
 * conversation's creator is), so a non-moderator member is denied server-side.
 *
 * Reuses the shared `exchangeCredentials` primitive — the same
 * `/exchange-credentials` endpoint the admin plane and the chat refreshing
 * provider both call, differing only in the request body.
 */
async function renameClientFor(channelArn: string): Promise<ChimeSDKMessagingClient> {
  if (!PERSON_API_URL) {
    throw new Error('Renaming requires the Credential Exchange (VITE_PERSON_API_URL)');
  }
  const idToken = localStorage.getItem('idToken');
  if (!idToken) throw new Error('Not authenticated');
  const { credentials } = await exchangeCredentials(
    { channelArn, capabilities: ['rename'] },
    idToken,
  );
  return new ChimeSDKMessagingClient({ region: REGION, credentials });
}

/**
 * Service for interacting with AWS Chime SDK Messaging (the chat plane).
 * Carries NO admin/moderation code — that lives in `@ae/admin`'s
 * `adminChime.ts`, which vends its own scoped credentials via the same
 * shared `exchangeCredentials` primitive this file uses for the chat plane.
 */
class ChimeService {
  private messagingClient: ChimeSDKMessagingClient | null = null;
  private userArn: string | null = null;

  /**
   * Initialize the Chime SDK clients with credentials from the credential exchange
   */
  async initialize(idToken: string, userArn: string): Promise<void> {
    try {
      // The credential exchange is the only source of Amazon Chime SDK credentials: it vends a
      // credential bearer-pinned to the caller's own AppInstanceUser and capped at their
      // classification. It is an SDK credential provider, so the client refreshes transparently.
      if (!PERSON_API_URL) {
        throw new Error('The Amazon Chime SDK needs the credential exchange (VITE_PERSON_API_URL)');
      }
      const credentials = exchangeCredentialsProvider(idToken);

      // Initialize Chime SDK clients
      this.messagingClient = new ChimeSDKMessagingClient({
        region: REGION,
        credentials,
      });

      // The person's AppInstanceUser ARN, as the credential exchange returned it. Never built from the
      // token: the exchange mints the id, and it is not the token's `sub`.
      this.userArn = userArn;

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
    // Absent for a room the person has not named: the server opens it with the platform's unnamed marker.
    title: string | undefined,
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
      const createConversationApiUrl = personUrl('/create-conversation');

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
          ...(title ? { title } : {}),
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
  /**
   * Every conversation this person is a member of, on every page.
   *
   * ── WHY `onPage` EXISTS, AND WHY EAGERNESS WAS THE WRONG SHAPE ───────────────────────────────────
   *
   * This method used to send one request and ignore `NextToken`, so the sidebar silently stopped at a page
   * boundary - a person's older conversations simply were not there, with nothing on screen to say so.
   * Following every page fixed that and introduced a different problem: startup became linear in
   * membership count. On an account with 289 memberships that is six sequential round trips before the
   * sidebar can render anything, and an e2e that reloads a second browser and waits on it blew a 60-second
   * budget a one-page sidebar never came close to.
   *
   * So pages are CONVERTED AND HANDED OVER AS THEY ARRIVE. A caller that passes `onPage` renders the first
   * page immediately and grows; awaiting the promise still yields the complete list, so a caller that needs
   * all of it is unchanged. Nothing is hidden either way - the difference is only when it appears.
   *
   * Deduped by channel ARN: pagination is only safe while pages are disjoint, and a service that repeated a
   * membership would put the same conversation in the sidebar twice, which is worse than the truncation
   * this loop exists to fix.
   *
   * Bounded at `MAX_PAGES`, and a token that fails to advance stops the loop at once. Both of those leave
   * the list incomplete, so both say so - a truncated sidebar that looks complete is the whole defect.
   */
  async listConversations(
    onPage?: (conversationsSoFar: Conversation[]) => void,
  ): Promise<Conversation[]> {
    if (!this.messagingClient || !this.userArn) {
      throw new Error('Chime SDK not initialized');
    }

    try {
      const MAX_PAGES = 20;
      const conversations: Conversation[] = [];
      const seen = new Set<string>();
      let nextToken: string | undefined;
      let pages = 0;

      do {
        const response = await this.messagingClient.send(
          new ListChannelMembershipsForAppInstanceUserCommand({
            AppInstanceUserArn: this.userArn,
            ChimeBearer: this.userArn,
            ...(nextToken ? { NextToken: nextToken } : {}),
          })
        );

        for (const membership of response.ChannelMemberships || []) {
          const arn = membership.ChannelSummary?.ChannelArn;
          if (arn && seen.has(arn)) continue;
          if (arn) seen.add(arn);
          const conversation = toConversation(membership);
          if (conversation) conversations.push(conversation);
        }

        // A copy, so a caller holding it cannot be mutated underneath by the next page.
        onPage?.([...conversations]);

        const stalled = response.NextToken !== undefined && response.NextToken === nextToken;
        nextToken = stalled ? undefined : response.NextToken;
        pages += 1;
        if (stalled) {
          console.warn(
            '[chimeService] conversation list stopped early: the service returned the same NextToken twice, '
            + `so it could not be advanced. ${conversations.length} conversations loaded; the sidebar is incomplete.`,
          );
        }
      } while (nextToken && pages < MAX_PAGES);

      if (nextToken) {
        console.warn(
          `[chimeService] conversation list stopped at ${MAX_PAGES} pages with more available; `
          + `${conversations.length} conversations loaded. The sidebar is incomplete.`,
        );
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
        modelTier: metadataClassification(metadata.modelTier),
        createdAt: channel.CreatedTimestamp ? new Date(channel.CreatedTimestamp) : new Date(),
        updatedAt: lastMessageAt || new Date(),
        lastMessage: lastMessageAt ? 'View messages' : undefined,
        lastMessageAt,
        lastReadAt: undefined,
        ...(typeof metadata.membershipSource === 'string' && metadata.membershipSource
          ? { membershipSource: metadata.membershipSource } : {}),
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
   * only to the sender and that target ARN. It is set by the `.` private prefix
   * and by nothing else (ADR-034); an `@` mention leaves the message readable
   * by the whole conversation.
   *
   * `mentionBotArn` and `mentionArns` both feed the CHIME.mentions message
   * attribute. `mentionBotArn` is the AUTO-routing input — combined with the
   * bot's `StandardMessages: AUTO` configuration it is what can make AUTO route
   * the message to that bot in a multi-member channel. `mentionArns` is every
   * member the parser resolved, so a person named with `@` is mentioned to the
   * platform rather than only in the text.
   */
  async sendMessage(
    channelArn: string,
    content: string,
    metadata?: Record<string, unknown>,
    options?: { targetArn?: string; mentionBotArn?: string; mentionArns?: string[] },
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
      // (Atlas / Echo / Assistant / anything).
      //
      // THE MENTION ATTRIBUTE ADDRESSES IN PUBLIC. An @<assistant> sets no
      // `targetArn` (ADR-034); only a private `.<member>` message sets a Target.
      // AUTO invokes the mentioned assistant on this attribute alone (measured
      // 2026-09-15, MESSAGE-FLOW.md §3.3), which is what the shared-task-answer
      // path in MessageInput relies on.
      // Don't
      // synthesize an ARN here from a string match — that would stamp the
      // wrong bot if the channel's actual member has a non-default name.
      // EVERY MENTIONED MEMBER, NOT ONLY AN ASSISTANT (ADR-034). This carried the bot ARN alone, and
      // a person named with `@` therefore got no platform mention and no push - so "an `@` mention
      // notifies the member it names" was true of assistants and of nobody else. A human mention was
      // plain text that happened to start with an `@`.
      //
      // `mentionBotArn` stays the AUTO-routing input and is listed first; `mentionArns` is what the
      // parser resolved, which includes that bot when one was named. Deduped, because the same ARN
      // arriving twice is a message attribute that disagrees with itself.
      const mentions = [...new Set([
        ...(options?.mentionBotArn ? [options.mentionBotArn] : []),
        ...(options?.mentionArns || []),
      ])];
      if (mentions.length > 0) {
        command.MessageAttributes = {
          'CHIME.mentions': { StringValues: mentions },
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

        // Filter out Lex's empty message responses. These appear as {"Messages":[]} with ContentType
        // application/amz-chime-lex-msgs, and are how the router suppresses a retried fulfillment
        // (ADR-022). Shared with the realtime path so the two cannot drift.
        if (isEmptyLexEnvelope(msg.Content, msg.ContentType)) continue;

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
        const { content: cleanContent, activeTask: contentTask, navigateChannel, battle, battleWaiting } = parseMessageContent(decodeMessageText(unwrapLexEnvelope(msg.Content, msg.ContentType)));
        const metadataTask = parseActiveTaskFromMetadata(metadata);
        const msgTargets = (msg as { Target?: Array<{ MemberArn?: string }> }).Target;
        const targetedToUser = Array.isArray(msgTargets)
          && msgTargets.some((t) => t?.MemberArn === this.userArn);

        messages.push({
          id: msg.MessageId,
          content: cleanContent,
          sender: {
            arn: msg.Sender?.Arn || '',
            // CARRIED, NOT INVENTED - the same rule the live path follows (`MessagingProvider`).
            // Substituting 'Assistant' here made a renamed assistant indistinguishable from one whose
            // name the service did not return, and put untranslatable English in the data layer.
            name: msg.Sender?.Name || '',
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
          // A conversation this one continued into (drift redirect). Lifted from METADATA rather than parsed
          // out of the content: the `NAVIGATE_CHANNEL:` marker that drives the one-shot switch is stripped
          // before display, so without this the parent conversation keeps the announcement and loses the way
          // to reach what it announced.
          driftRedirect: parseDriftRedirect(metadata.driftRedirect),
          // A proposal addressed to this person, by the function the live path uses too.
          proposal: proposalFromMetadata(metadata),
          // A task a workflow assigned this person, by the function the live path uses too.
          taskCard: taskCardFromMetadata(metadata),
          feedback: parseMessageFeedbackFromMetadata(metadata),
          status: 'sent',
          targetedToUser: targetedToUser || undefined,
          // The answer's phase and the queue's depth and stage, by the SAME function the live path
          // uses. Without them a reload dropped the queue indicator, and the notice it dropped from is
          // the oldest one in the window - the person who has waited longest.
          ...liftTurnStateFields(metadata),
          // Multi-part response grouping
          responseGroup: typeof metadata.responseGroup === 'string' ? metadata.responseGroup : undefined,
          continuation: metadata.continuation === true,
          parentMessageId: typeof metadata.parentMessageId === 'string' ? metadata.parentMessageId : undefined,
          part: typeof metadata.part === 'number' ? metadata.part : undefined,
          totalParts: typeof metadata.totalParts === 'number' ? metadata.totalParts : undefined,
          // Drift-confirm redirect signal
          navigateChannel: navigateChannel || undefined,
          // /battle marker
          battle: battle || undefined,
          battleWaiting: battleWaiting || undefined,
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
        isBot: isAssistantArn(m.Member?.Arn),
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
    // Sharing is served only where VITE_PERSON_API_CAPABILITIES names `notifications`.
    if (!personApiServes('notifications')) {
      throw new Error('Sharing is not served here (VITE_PERSON_API_CAPABILITIES does not name notifications)');
    }
    const shareApiUrl = personUrl('/share-conversation');

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
      const err: Error & { code?: string; membershipSource?: string } = new Error(message);
      err.code = code;
      // The refusal names the source so the client can say why in the reader's language (shareAvailability).
      if (typeof parsed.membershipSource === 'string') err.membershipSource = parsed.membershipSource;
      throw err;
    }

    return {
      recipientName: (parsed.recipientName as string) || recipientEmail,
      isNowMultiUser: !!parsed.isNowMultiUser,
    };
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
