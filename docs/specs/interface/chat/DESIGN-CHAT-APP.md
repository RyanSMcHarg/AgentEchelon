# DESIGN: Chat Application

**Status:** Implemented **Layer:** Interface (chat interface - reference client) **Plane:** core **Product spec:** [`SPEC-CHAT-APP.md`](SPEC-CHAT-APP.md) **Summary:** A standalone React SPA (`@ae/chat`) whose provider stack (auth, AWS clients, messaging, conversations) drives an Amazon Chime SDK Messaging-backed real-time conversation surface, sharing `@ae/shared` with the admin app but carrying zero admin code.

## 1. Architecture

The chat app is one of three packages in the frontend npm-workspaces monorepo (`frontend/packages/`): `@ae/chat` (this app), `@ae/admin` (the operator console, a separate build and origin), and `@ae/shared` (code both import). It is a single-entry Vite build (`index.html` -> `src/main.tsx` -> `App.tsx`), synced to its own S3 bucket and CloudFront origin. The app-split mechanics, CORS, and env wiring are in [`../admin/DESIGN-SEPARATE-ADMIN-APP.md`](../admin/DESIGN-SEPARATE-ADMIN-APP.md); this doc covers the chat app's internals.

`App.tsx` composes the provider stack, outermost to innermost:

- **`ErrorBoundary`** (`@ae/shared`) wraps everything; **`DeploymentStatusBanner`** sits alongside as the cost-sleep banner.
- **`AuthProvider`** (`@ae/shared`) owns Cognito auth: the `user`, `idToken`, the login / register / verify / forgot-password / MFA / new-password flows, and a 50-minute credential refresh.
- **`AwsClientProvider`** (`packages/chat/src/providers/`) initializes `chimeService` with the `idToken` once a user exists, and exposes `isInitialized` and `userArn`.
- **`MessagingProvider`** owns the single Amazon Chime SDK `MessagingSession` (the WebSocket): connect, reconnect, per-channel `subscribe`/`unsubscribe`, and a global cross-channel listener.
- **`ConversationProvider`** (`ConversationProvider.chime.tsx`) is the app state hub: the conversation list, the active conversation, its messages and members, unread tracking, and every user action (create, select, send, share, archive, leave, rename).
- **`AppContent`** renders the authenticated shell: `Header`, the sidebar (`ConversationList` + new-conversation button), the main pane (`ConversationInterface` + `MessageInput`), and `NewConversationModal`. A `has-active` class on the content div drives the mobile master-detail swap.

Surface components (`packages/chat/src/components/`): `ConversationList`, `ConversationInterface` (message rendering, day dividers, `CollapsibleText`, empty-state greeting), `MessageInput` (composer, mentions, attachments, battle "Replying to"), `NewConversationModal` (classification and model pick), `ChannelMembersPanel` (roles, add/remove, Battle Mode toggle), `ShareConversationModal`, `ArchiveConversationModal`, `AttachmentDisplay`, `FileUploadPreview`, `ModelSelector`, `ConnectionStatus`, `DeploymentStatusBanner`, `TaskStatusIndicator`, `BattleScorecard`, `BattleTallyBar`, and the auth screens `RegistrationScreen` and `EmailVerificationScreen` (login and forgot-password screens live in `@ae/shared`).

Platform fit: the chat app is a layer-4 **chat interface** over the layer-1/2 foundations (the Amazon Chime SDK Messaging conversation substrate, Cognito identity, the credential-exchange, the conversation stores). It owns no store and no admin capability; it is one of two pluggable interfaces on the same foundations, the Admin Console being the other.

## 2. Data model

The app holds only session UI state; it is a client over platform stores.

- **Conversations** (`Conversation[]` in `ConversationProvider`): built from Amazon Chime SDK Messaging channels via `chimeService.listConversations`, filtered client-side to the user's classification ceiling (`user.tier` vs `conv.modelTier`). Carries `id`, `conversationArn`, `title`, `modelTier`, `lastMessageAt`, `lastReadAt`, and an `archived` flag.
- **Messages** (`Message[]`): parsed from Amazon Chime SDK message payloads. Beyond `content`/`sender`/`timestamp`/`isBot`, a message carries derived fields from content markers and metadata: `activeTask`, `attachment`, `modelId`, `intent`, `targetedToUser`, the experiment-feedback join (`experimentId`, `variantId`, `assignmentMode`, `feedback`), multi-part grouping (`responseGroup`, `continuation`, `part`, `totalParts`), and the drift/battle markers (`navigateChannel`, `battle`, `battleWaiting`, `battleImage`).
- **Channel members** (`ChannelMember[]`): fetched via `chimeService.listChannelMembers`; refetched wholesale on any membership event (Amazon Chime SDK Messaging's at-least-once delivery makes incremental reconciliation brittle).
- **Unread state**: a dual source. Amazon Chime SDK Messaging's eventually-consistent `ReadMarkerTimestamp` (authoritative, slow) combined with an in-session `viewedAt` map and ephemeral `unreadTicks` from the global WebSocket listener (immediate), so a channel flips to unread in real time without a refetch and does not flicker on reopen.
- **Sticky mention target** (`StickyMentionTarget`): the last member/assistant a targeted message came from, prepended to the next send.
- **Attachments**: uploaded to S3 via a presigned URL; the app holds only the returned `Attachment` descriptor.

## 3. APIs and interfaces

- **Amazon Chime SDK Messaging** (`chimeService.ts`, `@aws-sdk/client-chime-sdk-messaging`), authorized by Cognito Identity Pool credentials from the user's `idToken`: `ListChannelMessages`, `SendChannelMessage`, `ListChannelMemberships(ForAppInstanceUser)`, `DescribeChannel`, `UpdateChannel`, `UpdateChannelReadMarker`, `ListChannelModerators`, `DeleteChannelMembership`. All act as the user's own `${sub}` app-instance-user identity.
- **Credential-exchange** (`plane` chat, via the shared `exchangeCredentials` primitive in `@ae/shared`): vends a short-lived, single-channel-scoped credential with a named capability. The chat app uses it for `rename` (a `chime:UpdateChannel` credential that Amazon Chime SDK Messaging authorizes only if the caller is a ChannelModerator, so a non-moderator member is denied server-side). This is the same `/exchange-credentials` endpoint the admin plane calls with `plane:'admin'`; the two differ only in the request body, and its CORS trusts both app origins.
- **Conversation-management API** (`conversationManagementService.ts`, Cognito-authorized): `POST /conversations/{archive,remove-member,leave}` for moderator membership mutations that a non-admin cannot do on the chat plane (the moderator check and the app-instance-admin bearer live server-side). Never a local-only state change.
- **Create-conversation, share, presigned-URL, channel-battle, deployment-state APIs**: chat-only backend endpoints (`VITE_CREATE_CONVERSATION_API_URL`, the share path, `VITE_PRESIGNED_URL_API_URL`, `VITE_CHANNEL_BATTLE_API_URL`, and `{analyticsApi}/deployment/state`), all Cognito-authorized and CORS-pinned to the chat origin.
- **Message markers**: assistant replies encode structured signals as HTML-comment markers in message content, parsed by `@ae/shared`'s `parseMessageContent` (`navigateChannel`, `battle`, `battleWaiting`, `battleImage`) and by metadata parsers (`parseActiveTaskFromMetadata`, `parseMessageFeedbackFromMetadata`). The Lex bot envelope (`application/amz-chime-lex-msgs`) is unwrapped so the user sees the plain text; an async placeholder is detected by a `<!--corr:-->` marker.

## 4. Key flows and algorithms

**Session and connect (FR-10).** `AwsClientProvider` initializes `chimeService` when `user` and `idToken` exist. `MessagingProvider.connect` then opens one `DefaultMessagingSession` for the user ARN and installs a single observer. On `visibilitychange` to visible, `forceReconnect` runs if the session is missing, the page was hidden past the stale threshold (5 min), or no message arrived in that window: it stops the old session, refreshes credentials (critical after long idle, when the tab-throttled 50-min refresh has not fired), waits briefly for the fresh client to propagate, and reconnects, emitting `websocket_reconnected` vs `websocket_connected`. `ConnectionStatus` renders a reconnecting indicator only while disconnected.

**Message routing (FR-4).** The observer parses each WebSocket event's JSON payload for the `ChannelArn`, fires the **global listener** first on any `CREATE_CHANNEL_MESSAGE` (for cross-channel unread and browser notifications), then dispatches to the per-channel `subscribe`d callbacks for CREATE / UPDATE / DELETE message and membership and channel-update events. Latency and analytics tracking fire when the *actual* answer arrives, not on the async placeholder (detected by the `corr` marker), so the metric measures time-to-response, not time-to-acknowledgment.

**Send and reply (FR-4).** `sendMessage` optimistically appends the user message, calls `chimeService.sendMessage`, and starts a 90-second typing indicator. The reply returns either as a direct CREATE or as a placeholder CREATE ("One moment...") followed by an UPDATE carrying the real content. `handleMessageUpdate` does a selective field merge: it preserves fields the UPDATE does not carry (critically `battle`, `sender`, `navigateChannel`), merges the compact battle summary onto the placeholder-derived `battle`, and treats `battleWaiting` as replace-not-preserve (its clearing is the "waiting ended" signal the composer keys off). Title auto-derive happens server-side and arrives as an `UPDATE_CHANNEL` event that renames the sidebar entry and header on every client.

**Select and subscribe (FR-2, FR-4).** `selectConversation` unsubscribes the previous channel, resolves the conversation from the loaded list (or falls back to `DescribeChannel` for a deep-linked conversation not yet in the list), marks it read (immediate `viewedAt` + eventual Amazon Chime SDK Messaging read marker, clearing any unread tick), loads messages and members in parallel, and subscribes. Every per-channel callback is guarded against the live `activeConversationRef` so a late event after a switch cannot leak into the wrong chat; `createConversation` mirrors the same unsubscribe-then-subscribe discipline (a missed unsubscribe once leaked an in-flight battle reply into a newly-opened chat).

**Unread tracking (FR-2).** `isConversationUnread` returns true when the channel's last activity (the max of `lastMessageAt` and the realtime `unreadTicks` entry) is newer than the effective read time (the max of the Amazon Chime SDK Messaging read marker and the in-session `viewedAt`). The active, focused conversation is always read and marks read eagerly on each new message.

**Mentions and sticky target (FR-5).** `MessageInput` offers an `@`-picker from `channelMembers` (adding `@all` in a multi-person channel); `mentionParser` validates and resolves the mention to a target ARN passed as a send option. A targeted incoming message (`targetedToUser`, set from the Amazon Chime SDK Messaging `Target` field or a `targetedSender` metadata fallback) pins a `stickyTarget` so the next send continues that thread; it clears on channel change or dismiss.

**Attachments (FR-6).** `attachmentService.uploadFile` enforces the allowed-type list and 10 MB cap client-side, requests a Cognito-authorized presigned upload URL, uploads to S3, and returns an `Attachment` descriptor sent as message metadata. Assistant attachment replies render via `AttachmentDisplay`.

**Battle chat surface (FR-9).** In a battle-enabled channel, `ConversationInterface` maps round-1 replies to `BattleScorecard` variants (label from the battle marker's resolved display name, response time and estimated cost from the compact per-message summary) and renders `BattleTallyBar` from `computeBattleTally`. `battleWaitingBots` is derived from messages still carrying a `battleWaiting` marker (insertion-ordered), driving the composer's "Replying to" affordance so a targeted reply routes to the waiting assistant. Enabling/disabling Battle Mode on a premium channel is the `ChannelMembersPanel` toggle calling `channelBattleService`.

**Membership actions (FR-8).** Archive, remove-member, and leave post to the conversation-management API and only then update local state (archive flips the local `archived` flag and drops the conversation from the active list behind "Show archived"; leave removes it). Rename vends a `rename`-capability credential and calls `UpdateChannel` directly, authorized server-side only for a moderator. Fail modes: a non-moderator's rename or archive is denied server-side, not hidden client-side; a deep link to a not-yet-listed conversation resolves via `DescribeChannel`; a `NAVIGATE_CHANNEL` marker (drift-confirm) retries briefly for the target to appear in the local list before giving up.

**Mobile master-detail (FR-11).** `clearActiveConversation` unsubscribes and clears the active conversation without deleting it, driving the Back affordance; the `has-active` class swaps list and detail panes below the breakpoint while both show side by side on desktop.

## 5. Security and IAM

- **Chat identity only.** Every action runs as the user's own `${sub}` app-instance-user, never an elevated identity; the chat app has no admin plane. Privileged-looking actions (rename, archive, remove-member) are authorized server-side (ChannelModerator or the moderator-check Lambda), so the client cannot grant itself capability it lacks.
- **Scoped, short-lived credentials.** The one client-side Amazon Chime SDK Messaging credential the chat app vends (rename) comes from the credential-exchange as a single-channel-scoped, short-lived credential; it is not a standing bearer.
- **Classification cap.** The conversation list and the new-conversation options are filtered to the user's classification ceiling; a user is never offered a conversation or model above their level. Backend enforcement is the authority; the client filter is UX.
- **No admin in the bundle.** The chat entry carries no `components/admin/*` code and no admin endpoint URLs (the admin-only `VITE_*` vars are dropped from the chat env). `frontend/scripts/assert-no-admin-in-chat.mjs` does a BFS over the chat entry's import graph (through `@ae/shared`'s real source) and fails the build if any resolved path is under `packages/admin/`. See [`../admin/DESIGN-SEPARATE-ADMIN-APP.md`](../admin/DESIGN-SEPARATE-ADMIN-APP.md).
- **Injection defense.** Message content is marker-parsed and decoded before render; the Lex envelope is unwrapped and control markers are consumed, not shown. The same deterministic marker handling the platform uses keeps a raw control marker from ever rendering.

## 6. Testing

- **Unit (Vitest, `packages/chat/src/`):** `components/CollapsibleText.test.tsx`, `components/Header.test.tsx`; `services/attachmentService.test.ts` (type/size validation and upload), `services/battleOutcomeService.test.ts`, `services/channelBattleService.test.ts`; `utils/mentionParser.test.ts`, `utils/battleTally.test.ts`, `utils/modelLabel.test.ts`. Shared parsing is covered by `packages/shared/src/utils/messageParser.test.ts` and `packages/shared/src/services/eventTrackingService.test.ts`.
- **End-to-end (Playwright, `tests/e2e/`):** `signup.spec.ts`, `signin.spec.ts` (custom auth screens), `welcome.spec.ts` (first-turn greeting), `onboarding-intake.spec.ts`, `mentions.spec.ts`, `tier-context.spec.ts` (classification-capped conversations), `agent-intents.spec.ts`, `tasks.spec.ts` and `task-state-machine.spec.ts` (task status), `feedback.spec.ts`, `battle.spec.ts` (the `/battle` chat flow and scorecard), `credential-exchange.spec.ts` (the chat-plane vend), `drift-detection.spec.ts` (the navigate-channel redirect).
- **Deferred / gaps:** cross-device continuity and WebSocket reconnect are exercised by manual/visibility testing, not an automated multi-client harness; the mobile master-detail swap is covered by component behavior rather than a device-emulation e2e; attachment upload against real S3 presigning is validated at deploy rather than in CI.

## 7. Migration / phasing / rollout

- **Single entry, single build.** The chat app is one Vite entry synced to its own bucket/origin; no phasing within the app.
- **The split it came from.** Removing admin from the chat app was a one-way cutover (P1 in the separate-admin-app rollout); there is no bundled-into-chat mode, and the import-graph assertion pins it. See [`../admin/DESIGN-SEPARATE-ADMIN-APP.md`](../admin/DESIGN-SEPARATE-ADMIN-APP.md).
- **Feature flags read by the app.** `VITE_SLEEP_MODE_ENABLED` (deployment-state banner), `VITE_CHANNEL_BATTLE_API_URL` (Battle Mode toggle), and the classification-model config gate optional surfaces; when unset the app degrades to inert (no banner, no toggle).
- **Classification symbol rename.** Product copy presents classification; several code symbols still read `tier`/`UserTier`/`modelTier`. The rename is tracked separately and does not change runtime behavior.

## 8. Open technical questions

- **Reconnect test coverage.** Whether to add an automated multi-client or network-fault harness for the WebSocket reconnect and cross-device continuity paths, versus keeping them deploy-verified.
- **Selective merge fragility.** The `handleMessageUpdate` field-merge (preserve `battle`, replace `battleWaiting`) is load-bearing and marker-order-sensitive; whether to move more of it into a single typed reducer over markers is open.
- **Membership reconciliation.** Refetching the whole member list on every membership event is robust but chatty on busy channels; whether an incremental path is worth the at-least-once-delivery risk is unresolved.
- **Attachment policy source.** Whether the allowed-type list and size cap should move from a client constant to a deployer-tunable config.

## Related

- [`SPEC-CHAT-APP.md`](SPEC-CHAT-APP.md) - the product spec this design serves.
- [`../admin/DESIGN-SEPARATE-ADMIN-APP.md`](../admin/DESIGN-SEPARATE-ADMIN-APP.md) - the workspace split, shared `@ae/shared`, CORS/env, and the no-admin-in-chat invariant.
- [`../../capabilities/DESIGN-BATTLE.md`](../../capabilities/DESIGN-BATTLE.md) - the battle mechanics behind the chat-side scorecard and tally.
- [`../../interaction/identity-access/admin/SPEC-ADMIN-IDENTITY.md`](../../interaction/identity-access/admin/SPEC-ADMIN-IDENTITY.md) - the identity model (chat `${sub}` is never elevated here).
