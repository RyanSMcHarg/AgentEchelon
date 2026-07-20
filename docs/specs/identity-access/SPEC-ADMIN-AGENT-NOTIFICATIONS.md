# SPEC: Admin Agent and Admin Notification Channel

**Status:** DESIGN (not yet built). This spec supersedes the initial admin-notification-channel attempt (the stack at `backend/lib/stacks/admin-notification-stack.ts` and its handler `backend/lambda/src/admin-notification-channel-provision.ts`), which created and posted to the channel as the service app-instance-admin. That is wrong (see Why) and is being reworked to the model below.

**Scope:** Give AgentEchelon a first-class **admin agent** - an assistant, defined by a capability profile like every other AE assistant - that OWNS an **admin notification channel** and POSTS the platform's admin-facing alerts into it (Layer 6 membership-audit findings, admin-error alerts, and future admin notifications), delivered in-app plus email. The channel's owner and message sender is the admin agent's AppInstanceBot; the service app-instance-admin is never a channel member. The pattern is ported from communication-hub's ADR-015 "the bot owns the channel", made AE-native by expressing the admin agent as a profile plus config rather than a hardcoded identity.

**Author:** Ryan McHarg

**Related:**
- `backend/lib/config/profiles.ts:36-53` - `AssistantProfile` (the capability bundle the admin agent is defined as); `:76-92` - `DEFAULT_PROFILES_CONFIG` (where the admin-agent profile is added)
- `backend/lib/stacks/assistant-profile-stack.ts:664-704` - the per-profile `CreateAppInstanceBot` custom resource + `…/assistant/{name}/bot-arn` SSM publish (`:697`); `:605` - the Lex bot; `:153` - the `adminErrorAlertWiring` call site
- `backend/lambda/lex-bot/create-bot.ts` - `CreateAppInstanceBot` (Identity API, no ChimeBearer)
- `backend/lib/stacks/agent-classification-common.ts:362-383` - `adminErrorAlertWiring` (today sets `ADMIN_ALERT_BEARER_ARN` to the service admin, `:369`); `:391` - the `…/assistant/{name}/bot-arn` SSM key; `:284` - `INSTANCE_SSM`
- `backend/lambda/src/membership-audit.ts:209-236` - `alertAdmins` (posts + email fan-out; today bears the service admin); `backend/lib/constructs/membership-audit.ts:70,93-98` - its env + Chime IAM
- `backend/lambda/src/lib/channel-notify.ts` - `fanOutChannelNotification` (resolves email recipients from the channel `Metadata.participants` roster)
- `docs/specs/identity-access/SPEC-ADMIN-IDENTITY.md` - the two credential planes; the service app-instance-admin's role (cross-channel administration, no membership)
- `docs/specs/admin-console/SPEC-ADMIN-CONSOLE.md` - the Security (Membership Audit) tab whose findings this delivers
- `docs/specs/conversation-messaging/SPEC-NOTIFICATION-BRIDGE.md` - the conversation-as-hub email/notify fan-out this rides
- `docs/guides/admin/ADMIN-GUIDE.md` - operator-facing usage (the admin notification channel section)

## Why

Two facts, one empirically verified against the live instance, force this design.

1. **AE has admin alerts but nowhere to send them.** The Layer 6 membership audit and the admin-error path both post a finding into an admin conversation and fan it out to admins over email (`membership-audit.ts:209-236`), but the channel ARN is unset by default, so both degrade to log-only. The admin has no notification channel.

2. **The service app-instance-admin cannot be the sender, and must never be a channel member.** The shipped wiring posts as the service admin: `adminErrorAlertWiring` sets `ADMIN_ALERT_BEARER_ARN` to `INSTANCE_SSM.appInstanceAdminArn` (`agent-classification-common.ts:369`), and membership-audit bears the same service-admin ARN. But a `SendChannelMessage` by the service admin to a RESTRICTED, PRIVATE channel it is not a member of is rejected. Verified on the live instance: with the service admin removed from a test channel's membership, `SendChannelMessage` as that identity returns `ForbiddenException: You do not have sufficient access to perform this action`. Making the service admin a member to work around this is not an option: the service admin is the cross-channel administration identity (it reads and moderates any channel WITHOUT membership, `SPEC-ADMIN-IDENTITY.md`), and putting it in a channel roster is both a privilege smell and, for email fan-out, wrong (it would be a recipient). So the sender must be a different identity that legitimately owns the channel.

The correct owner and sender is a bot. A bot that creates a channel is its moderator and can post to it, and bot-sent messages are the trusted trigger for the notify/email fan-out. AgentEchelon already provisions bots for every assistant profile; the admin agent is simply one more profile.

## Design Anchor

**The admin agent is an AgentEchelon assistant profile whose AppInstanceBot creates, owns, and posts to the admin notification channel. The service app-instance-admin is borrowed only as the bearer for the one operation a bot cannot perform - adding members - and is never itself a member.**

This is communication-hub's ADR-015 ("the bot creates the channel; the bot becomes creator and moderator and can post; the app-instance-admin user is used only as a bearer for CreateChannelMembership, which bots cannot call, and is kept out of the roster"), expressed in AE's terms:

- **communication-hub** hardcodes the admin agent's bot ARN as a static config value (`adminBotArn`) bootstrapped out of band.
- **AgentEchelon** defines the admin agent as a capability **profile** (`AssistantProfile`, `profiles.ts:36-53`). The profile stack provisions its Lex bot + AppInstanceBot and publishes the ARN to SSM exactly as it does for `basic`/`standard`/`premium` (`assistant-profile-stack.ts:664-704`). The admin agent is config, not a hardcoded identity.

Three identities, kept distinct:

| Identity | ARN shape | Role in this design |
|---|---|---|
| Admin agent | `…/bot/…` (AppInstanceBot) | Creates + moderates the channel; the ChimeBearer that POSTS every alert |
| Service app-instance-admin | `…/user/agent-echelon-admin` | Bearer for `CreateChannelMembership` ONLY (bots cannot add members); never a channel member |
| Human admins | `…/user/{sub}` | Channel members and email recipients |

## The admin agent (a capability profile)

The admin agent is added to `DEFAULT_PROFILES_CONFIG.profiles` (`profiles.ts:82-89`) as a new profile, e.g. `{ name: 'admin-agent', modelKey: 'haiku', classifierMode: 'llm', timeoutSeconds: 30, taskSupport: 'lightweight', contextScope: 'own-rank-and-below' }`. Unlike the per-classification profiles, it is NOT bound to a channel classification (no `DeploymentClassification.profile` points at it): it does not serve user conversations by clearance. It exists to own the admin-plane channel and to be the sender identity for alerts. Its persona and model matter only if and when the admin agent is later given a conversational role (the multi-agent support/admin-assistant direction); for notifications, only its bot identity is used.

The profile stack provisions it identically to a classification assistant: the Lex bot (`assistant-profile-stack.ts:605+`), the `CreateAppInstanceBot` custom resource (`:664-704`), and the SSM publish of `…/assistant/admin-agent/bot-arn` (`:697`, via the key helper `agent-classification-common.ts:391`). Provisioning the admin agent through the same path is the "profile plus config, not a hardcoded ARN" difference from communication-hub, and it means the admin agent inherits AE's persona-override, model-selection, and config-identity machinery for free.

## The admin notification channel

A custom resource (the reworked `admin-notification-stack.ts`) provisions ONE channel, ordered so the bot owns it:

1. **Create as the bot.** `CreateChannel` with `ChimeBearer = adminAgentBotArn`, `Mode: RESTRICTED`, `Privacy: PRIVATE`, `Name: "Admin Notifications"`. The bot becomes the creator and moderator. (`CreateAppInstanceBot` is an Identity API call with no bearer, but `CreateChannel` takes the bot as ChimeBearer.)
2. **Add human admins with the admin-user bearer.** For each member of the `admins` Cognito group (resolved by `ListUsersInGroup` -> `…/user/{sub}`), `CreateChannelMembership` with `ChimeBearer = serviceAdminUserArn`, `MemberArn = …/user/{sub}`, `Type: DEFAULT`. Bots cannot call `CreateChannelMembership` (Chime limitation), so the service-admin USER is borrowed as the bearer for this step only. The service admin is NOT added as a member.
3. **Stamp the roster.** `UpdateChannel` (bearer = the bot) writes `Metadata.participants = [{ sub }]` for the human admins. This is load-bearing: AE's email fan-out resolves recipients from `Metadata.participants`, not raw membership (`channel-notify.ts`). Without the stamp the email leg reaches no one.

Idempotent, matching the initial A6: the custom resource's `PhysicalResourceId` is the channel ARN; Update reuses it and re-syncs the admin roster (so admins added since the last deploy are picked up); Delete removes it.

## Posting alerts (the bearer rewire)

Both alert paths change their ChimeBearer from the service admin to the admin agent bot:

- **Admin-error alerts.** `adminErrorAlertWiring` (`agent-classification-common.ts:362-383`) stamps `ADMIN_ALERT_BEARER_ARN`; today it is `INSTANCE_SSM.appInstanceAdminArn` (`:369`). It becomes the admin-agent bot ARN (read from `…/assistant/admin-agent/bot-arn`). The IAM grant (`:371-381`) shifts to `chime:SendChannelMessage` on the bot resource (`…/bot/*`) plus the channel.
- **Membership-audit alerts.** `alertAdmins` (`membership-audit.ts:209-236`) posts with the bearer resolved from `ADMIN_ARN_PARAM` (today the service admin). It reads the admin-agent bot ARN instead. The construct's Chime IAM (`membership-audit.ts:93-98`) already spans `…/channel/*` and adds `…/bot/*` for the bot bearer.

Why the bot works where the service admin does not: a bot posting to its own channel is a member-equivalent (moderator) send, and bot-sent messages are the trusted trigger for the notify/email fan-out (the fan-out honors `notify` metadata only from a `/bot/` sender). The service admin, by contrast, is not a member and is rejected on `SendChannelMessage` to a RESTRICTED, PRIVATE channel (the verified `ForbiddenException`).

## Recipient resolution

Human admins receive an alert two ways, both keyed on the participant roster the provisioning stamps:

- **In-app:** the message is a real channel message; the human admins are members, so it appears in their conversation list.
- **Email:** `fanOutChannelNotification` (`channel-notify.ts`) reads `Metadata.participants`, resolves each `sub` to a Cognito email, and sends when the alert carries `notify.email`. Adding or removing an admin (and re-running the provisioning, or the Update re-sync) is the knob for who is notified.

## Provisioning and wiring (mechanism)

- **Profile:** add the `admin-agent` profile to `DEFAULT_PROFILES_CONFIG` (`profiles.ts`). The profile stack provisions its bot and publishes `…/assistant/admin-agent/bot-arn`.
- **Channel:** the reworked `AdminNotificationStack` custom resource reads the admin-agent bot ARN and the service-admin ARN from SSM, then runs the create-as-bot / add-members-as-admin-user / stamp-roster sequence above. It exposes the channel ARN as a cross-stack token (as the initial A6 does), which flows into `membershipAuditAlertChannelArn` in `bin/backend.ts` and thence to both alert paths.
- **Opt-in:** unchanged from the initial A6 (`-c enableAdminNotificationChannel=true`); when off, alerts stay log-only.

## IAM

- **Admin-agent bot creation:** `chime:CreateAppInstanceBot` on the app-instance and `…/bot/*` (the profile stack already grants this for classification bots, `assistant-profile-stack.ts:668`), plus the Lex creation actions.
- **Channel provisioning role:** `chime:CreateChannel` on the app-instance; `chime:CreateChannelMembership` / `chime:UpdateChannel` / `chime:DeleteChannel` / `chime:TagResource` / `chime:CreateChannelModerator` on `…/channel/*` and `…/user/*` (the admin-user bearer) and `…/bot/*` (the bot bearer); `cognito-idp:ListUsersInGroup` on the user-pool; `ssm:GetParameter` on the admin-agent bot and service-admin ARNs.
- **Alert posters:** `chime:SendChannelMessage` on `…/bot/*` (the bot bearer) and the channel, on the classification-processor roles (`adminErrorAlertWiring`) and the membership-audit role.

## What this supersedes and how to migrate

- The initial A6 stack + handler (`admin-notification-stack.ts`, `admin-notification-channel-provision.ts`, committed) are reworked, not extended: the create/post identity moves from the service admin to the admin-agent bot, and the member-add step gains the admin-user bearer.
- The shipped `adminErrorAlertWiring` and membership-audit bearer (`ADMIN_ALERT_BEARER_ARN` / `ADMIN_ARN_PARAM` = the service admin) are corrected to the admin-agent bot. This fixes a latent defect: those paths cannot post today even when a channel ARN is supplied, because the service admin is not a member.
- The manual repair script `backend/scripts/provision-admin-channel.mjs` is updated the same way (create + post as the bot; add members as the admin-user bearer), so an operator can provision or repair the channel without a deploy.

## Difference from communication-hub

| Concern | communication-hub | AgentEchelon |
|---|---|---|
| Admin agent identity | Static `adminBotArn` config, bootstrapped out of band | A capability **profile** (`profiles.ts`); the profile stack provisions the bot + publishes the SSM ARN |
| Channel owner | The bot (ADR-015) | The bot (same) |
| Member-add bearer | The app-instance-admin user | The service app-instance-admin user (same) |
| Alert sender | The bot | The bot (same) |
| Service admin as member | Never | Never |
| Recipient source | Real channel memberships | `Metadata.participants` roster (AE's fan-out reads the roster) |

The ownership and identity rules are ported verbatim; only the way the admin agent is defined (profile plus config) and the recipient source (roster) are AE-native.

## Phased build

- **P0** - add the `admin-agent` profile; provision its bot through the profile stack; publish `…/assistant/admin-agent/bot-arn`.
- **P1** - rework the channel custom resource to create-as-bot / add-members-as-admin-user / stamp-roster; expose the channel ARN.
- **P2** - rewire both alert bearers (`adminErrorAlertWiring` + membership-audit) to the admin-agent bot; adjust IAM.
- **P3** - update the repair script; re-validate on the live instance (bot creates the channel, bot posts an alert, an admin receives it in-app + email).
- **P4** - docs: the ADMIN-GUIDE section (below) and the ADMIN-INTEGRATION-GUIDE note for host-owned admin.

## Open questions

1. **Does the admin agent need a persona/model now, or only the bot identity?** For notifications, only the bot identity is used. A persona matters when the admin agent gains a conversational role (multi-agent support / the admin-assistant that runs meetings). The profile carries a default model regardless.
2. **One admin channel or per-severity?** One channel is the initial design (matches the single `membershipAuditAlertChannelArn`). Per-severity or per-category channels are a later refinement.
3. **Admin roster upkeep.** Admins are synced at provision/Update time. A new admin added between deploys is not a member until the next provision run. A future hook (the admin-user provisioning path) could add new admins to the channel on the fly.
4. **Host-owned admin (ADMIN-INTEGRATION-GUIDE).** When a host owns admin auth, the admin agent still owns the channel, but recipient resolution keys on the host's admin claim; document the interaction.

## Empirical validation (live, mcharg-dev)

Recorded so the rework is verified against reality, not just synthesis:

- The service app-instance-admin, when NOT a channel member, gets `ForbiddenException` on `SendChannelMessage` to a RESTRICTED, PRIVATE channel. This is the fact that rules out the service admin as the sender and drives the bot-owner design.
- The channel provisioning sequence (create, add the `admins` group, stamp `Metadata.participants`, verify membership) runs cleanly as a one-off against the live instance. The remaining live check for the rework is posting an alert AS THE ADMIN-AGENT BOT and confirming it lands in-app plus email - the step the service admin could not do.
