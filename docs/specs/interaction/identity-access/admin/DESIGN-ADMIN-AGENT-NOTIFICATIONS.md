# DESIGN: Admin Agent and Admin Notification Channel

**Status:** Design (not yet built). This design supersedes an initial admin-notification-channel attempt (the stack at `backend/lib/stacks/admin-notification-stack.ts` and its handler `admin-notification-channel-provision.ts`), which created and posted to the channel as the service app-instance-admin. That identity cannot legitimately post to the channel (section 4), so it is being reworked to the model below. **Layer:** Interaction **Pillar:** Identity & Access **Plane:** admin **Product spec:** [`SPEC-ADMIN-IDENTITY.md`](SPEC-ADMIN-IDENTITY.md) (the two credential planes and the admin trust boundary this delivery mechanism must stay inside). **Summary:** A first-class admin agent (an assistant defined by a capability profile like every other assistant) owns an admin notification channel and posts the platform's admin-facing alerts into it, delivered in-app plus email, while the service app-instance-admin is never a channel member.

## 1. Architecture

The scope is a delivery path for admin-facing alerts (membership-audit findings, admin-error alerts, and future admin notifications) that respects the admin trust boundary. The moving parts:

- **The admin agent**, an assistant capability profile (`AssistantProfile`, `backend/lib/config/profiles.ts`) added to `DEFAULT_PROFILES_CONFIG`. Unlike the per-classification profiles it is bound to no channel classification, so no channel maps to it and the router never routes a user turn to it. It exists to own the admin-plane channel and be the sender identity for alerts.
- **The profile stack** (`backend/lib/stacks/assistant-profile-stack.ts`) provisions the admin agent identically to a classification assistant: its Lex bot, the `CreateAppInstanceBot` custom resource, and the SSM publish of `.../assistant/admin-agent/bot-arn`. Defining the admin agent as a profile plus config, rather than a hardcoded identity, is what makes it AE-native.
- **The notification channel custom resource** (the reworked `admin-notification-stack.ts`) provisions one channel owned by the admin-agent bot and exposes its ARN as a cross-stack token.
- **The alert posters**: `adminErrorAlertWiring` (`backend/lib/stacks/agent-classification-common.ts`) and the membership-audit `alertAdmins` (`backend/lambda/src/membership-audit.ts`), both rewired to post with the admin-agent bot bearer.
- **The email fan-out** (`backend/lambda/src/lib/channel-notify.ts`), `fanOutChannelNotification`, which resolves recipients from the channel `Metadata.participants` roster, not raw membership.

Three identities are kept distinct:

| Identity | ARN shape | Role in this design |
|---|---|---|
| Admin agent | `.../bot/...` (AppInstanceBot) | Creates and moderates the channel; the bearer that posts every alert |
| Service app-instance-admin | `.../user/agent-echelon-admin` | Bearer for `CreateChannelMembership` only (bots cannot add members); never a channel member |
| Human admins | `.../user/{sub}` | Channel members and email recipients |

The pattern (a bot owns the channel and posts; the app-instance-admin user is borrowed only to add members, never joins the roster) is ported from a sibling messaging project and made AE-native by expressing the admin agent as a profile plus config rather than a hardcoded bot ARN.

## 2. Data model

- **The admin-agent profile** (`profiles.ts`), for example `{ name: 'admin-agent', modelKey: 'haiku', classifierMode: 'llm', timeoutSeconds: 30, taskSupport: 'lightweight', contextScope: 'own-rank-and-below' }`. Not bound to any `DeploymentClassification.profile`. Its persona and model matter only if it later gains a conversational role; for notifications only its bot identity is used.
- **The bot ARN** published to SSM at `.../assistant/admin-agent/bot-arn` (via the key helper in `agent-classification-common.ts`), read by the channel custom resource and both alert posters.
- **The channel `Metadata.participants[]`** roster, stamped at provisioning with the human admins' subs. This is load-bearing: the email fan-out resolves recipients from the roster, not from raw channel membership. Without the stamp the email leg reaches no one.
- **The channel** itself: `RESTRICTED` + `PRIVATE`, `Name: "Admin Notifications"`, owned (created and moderated) by the admin-agent bot. Its ARN flows through `membershipAuditAlertChannelArn` in `bin/backend.ts` to both alert paths.

## 3. APIs and interfaces

- **Bearer contract.** `CreateAppInstanceBot` is an Identity API call with no bearer. `CreateChannel` takes the admin-agent bot as `ChimeBearer`. `CreateChannelMembership` takes the service-admin user as `ChimeBearer` (bots cannot call it). `UpdateChannel` (roster stamp) and `SendChannelMessage` (alerts) take the admin-agent bot as `ChimeBearer`.
- **SSM contracts consumed:** the admin-agent bot ARN (`.../assistant/admin-agent/bot-arn`) and the service-admin ARN (`/agent-echelon/app-instance-admin-arn`).
- **Alert env contract.** `adminErrorAlertWiring` stamps `ADMIN_ALERT_BEARER_ARN`; membership-audit reads its bearer from `ADMIN_ARN_PARAM`. Both change from the service-admin ARN to the admin-agent bot ARN.
- **Notify trigger.** The fan-out honors `notify` metadata only from a `/bot/` sender, so a bot-sent message is the trusted trigger for the in-app plus email fan-out.

## 4. Key flows and algorithms

**Why the sender must be the bot, not the service admin.** Two facts force the design, one empirically verified against the live instance:

1. AE has admin alerts but, by default, nowhere to send them: the membership-audit and admin-error paths post into an admin conversation and fan out over email, but the channel ARN is unset by default, so both degrade to log-only.
2. The service app-instance-admin cannot be the sender and must never be a channel member. A `SendChannelMessage` by the service admin to a `RESTRICTED`, `PRIVATE` channel it is not a member of is rejected (verified: `ForbiddenException: You do not have sufficient access to perform this action`). Making it a member to work around this is wrong: the service admin is the cross-channel administration identity that reads and moderates without membership, and as an email recipient it would be incorrect. So the sender must be a different identity that legitimately owns the channel. A bot that creates a channel is its moderator and can post to it, and bot-sent messages are the trusted fan-out trigger.

**Channel provisioning (custom resource, idempotent).** The `PhysicalResourceId` is the channel ARN; Update reuses it and re-syncs the roster; Delete removes it.

1. **Create as the bot.** `CreateChannel` with `ChimeBearer = adminAgentBotArn`, `Mode: RESTRICTED`, `Privacy: PRIVATE`. The bot becomes creator and moderator.
2. **Add human admins with the admin-user bearer.** For each member of the `admins` Cognito group (resolved by `ListUsersInGroup` to `.../user/{sub}`), `CreateChannelMembership` with `ChimeBearer = serviceAdminUserArn`, `Type: DEFAULT`. The service admin is not added as a member.
3. **Stamp the roster.** `UpdateChannel` (bearer = the bot) writes `Metadata.participants` for the human admins, so the email fan-out has recipients.

**Posting an alert.** Both alert paths resolve the admin-agent bot ARN and post with it as `ChimeBearer` (`SendChannelMessage`). Human admins receive the alert two ways, both keyed on the stamped roster: in-app (they are channel members, so it appears in their conversation list) and email (`fanOutChannelNotification` reads `Metadata.participants`, resolves each sub to a Cognito email via SES `AdminGetUser`, and sends when the alert carries `notify.email`).

**Fail modes.** An admin without a usable email in the identity provider receives in-app delivery only until another channel (SMS, PSTN, webhook) is attached. A new admin added between deploys is not a member until the next provision/Update re-sync; a future hook could add new admins on the fly. When the opt-in is off (`-c enableAdminNotificationChannel=true` unset), alerts stay log-only.

## 5. Security and IAM

**Security boundary (normative).** The admin agent participates only in admin conversations, and admin conversations are accessible only to admins. Concretely:

1. **Never in a user conversation.** The admin agent's bot is never added to, and never responds in, a user/classification channel. It is bound to no `DeploymentClassification.profile`, so no channel classification maps to it and the router never routes a user turn to it. There is no code path that invokes the admin agent from a non-admin channel.
2. **Admin-only membership.** Every channel the admin agent owns or joins is `RESTRICTED` + `PRIVATE`, with membership limited to the `admins` Cognito group (plus the admin agent bot itself). A non-admin can neither read nor post; the service app-instance-admin is not a member either (it is only the member-add bearer).
3. **The boundary binds the future conversational role too.** If the admin agent later gains a conversational role (the multi-agent support / admin-assistant direction), the same two rules hold unchanged: admin-only membership, and no presence in user conversations. Admin-plane content and the admin assistant stay strictly inside the admin trust boundary.
4. **Access to the admin assistant is itself a privileged capability.** The admin agent holds admin capabilities, so reaching it is equivalent to reaching those capabilities. Access is gated to admins the same way the admin console is ([`DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md`](DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md)): only an authenticated admin can invoke it. And the assistant is a deputy, never an amplifier: it exercises an admin capability only under the requesting admin's own entitlement, so a limited or persona admin cannot do through the assistant what their own capabilities forbid. Every capability it exercises is scoped and audited (`admin_scoped_credential_vend`) exactly as the equivalent direct admin action would be. The assistant is never a way around the capability model.

This is the same trust separation as the two credential planes ([`SPEC-ADMIN-IDENTITY.md`](SPEC-ADMIN-IDENTITY.md)): the admin agent is an admin-plane identity and must never cross into the chat plane.

**IAM grants.**

- **Admin-agent bot creation:** `chime:CreateAppInstanceBot` on the app-instance and `.../bot/*` (the profile stack already grants this for classification bots), plus the Lex creation actions.
- **Channel provisioning role:** `chime:CreateChannel` on the app-instance; `chime:CreateChannelMembership` / `UpdateChannel` / `DeleteChannel` / `TagResource` / `CreateChannelModerator` on `.../channel/*` and `.../user/*` (the admin-user bearer) and `.../bot/*` (the bot bearer); `cognito-idp:ListUsersInGroup` on the user pool; `ssm:GetParameter` on the admin-agent bot and service-admin ARNs.
- **Alert posters:** `chime:SendChannelMessage` on `.../bot/*` (the bot bearer) and the channel, on the classification-processor roles (`adminErrorAlertWiring`) and the membership-audit role.

## 6. Testing

- **Unit / integration:** the channel custom resource sequence (create-as-bot, add-members-as-admin-user, stamp-roster) and the two alert-poster bearer rewires.
- **End-to-end / empirical (live instance):** the service app-instance-admin, when not a channel member, gets `ForbiddenException` on `SendChannelMessage` to a `RESTRICTED`, `PRIVATE` channel (the fact that rules out the service admin as sender). The provisioning sequence (create, add the `admins` group, stamp `Metadata.participants`, verify membership) runs cleanly against the live instance.
- **Deferred / gaps:** the remaining live check is posting an alert as the admin-agent bot and confirming it lands in-app plus email, the step the service admin could not perform. Deferred until the rework is built.

## 7. Migration / phasing / rollout

- **P0.** Add the `admin-agent` profile; provision its bot through the profile stack; publish `.../assistant/admin-agent/bot-arn`.
- **P1.** Rework the channel custom resource to create-as-bot / add-members-as-admin-user / stamp-roster; expose the channel ARN.
- **P2.** Rewire both alert bearers (`adminErrorAlertWiring` and membership-audit) to the admin-agent bot; adjust IAM.
- **P3.** Update the manual repair script `backend/scripts/provision-admin-channel.mjs` the same way; re-validate on the live instance.
- **P4.** Docs: the operator-facing admin-notification-channel section and the host-owned-admin note.

**What this supersedes.** The initial stack and handler are reworked, not extended: the create/post identity moves from the service admin to the admin-agent bot, and the member-add step gains the admin-user bearer. This fixes a latent defect, that the shipped alert paths cannot post today even when a channel ARN is supplied, because the service admin is not a member. Opt-in is unchanged (`-c enableAdminNotificationChannel=true`); when off, alerts stay log-only.

## 8. Open technical questions

- **Does the admin agent need a persona/model now, or only the bot identity?** For notifications, only the bot identity is used; a persona matters when it gains a conversational role. The profile carries a default model regardless.
- **One admin channel or per-severity?** One channel is the initial design (matches the single `membershipAuditAlertChannelArn`); per-severity or per-category channels are a later refinement.
- **Admin roster upkeep.** Admins are synced at provision/Update time; a new admin added between deploys is not a member until the next run. A future hook could add new admins on the fly.
- **Host-owned admin.** When a host owns admin auth, the admin agent still owns the channel, but recipient resolution keys on the host's admin claim; document the interaction.
