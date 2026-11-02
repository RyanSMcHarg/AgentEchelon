# The Guest Issuer

How a deployment admits an anonymous visitor, what holds the visitor to their own conversation, how a visitor becomes a person, and how an operator runs it: the kill switch, the signing key's rotation and the alarms. This guide describes what is built.

Everything below is synthesized and unit-tested. **NOT VERIFIED:** every live claim here is unverified until the deny-tests in [Verified by](#verified-by) have run against a deployment that declares a guest issuer and recorded their result in this guide. The widget (`frontend/packages/widget`, [SPEC-EMBEDDABLE-WIDGET](../../specs/interface/SPEC-EMBEDDABLE-WIDGET.md)) is the client that calls these routes, described in [The widget](#the-widget); any other client may call them the same way.

## Declaring it

A guest issuer is one entry in `issuers` in `backend/deploy.config.json`, of kind `guest`, declared beside the two outside classifications it needs in `profiles`: `guest`, which its visitors' conversations are held at, and `customer`, which its path B claim opens a conversation at ([Becoming a person](#becoming-a-person)). A deployment that declares no `profiles` runs neither, and synth refuses the guest issuer, naming each one to add:

```json
"profiles": ["basic", "standard", "premium", "guest", "customer"]
```

The entry:

```json
{
  "id": "guest",
  "kind": "guest",
  "clearance": { "fixed": ["guest"], "classifications": ["guest"] },
  "allowedOrigins": ["https://www.example.com"],
  "guest": {
    "captcha": { "vendor": "turnstile", "siteKey": "<site key>", "secretName": "<Secrets Manager secret name>" },
    "perIpLimit": { "max": 5, "windowMinutes": 60 },
    "tokenMinutes": 10,
    "refreshMinutes": 60,
    "signingKeys": ["g1"],
    "noticeVersion": "sample-1",
    "registration": { "approval": "none" }
  }
}
```

- **The clearance is fixed at one visitor classification and bound to it**: an outside classification (`audience: 'outside'` in `backend/lib/config/profiles.ts`) that the `guest-visitor` type permits. `guest` is the shipped one: it grants only itself, no other classification grants it, no clearance group names it, and no other issuer's classifications may name it. The other shipped outside classification, `customer`, is reached by a signed-in issuer instead ([Becoming a person](#becoming-a-person)). A guest issuer never declares `admin: true`, and a deployment declares at most one.
- **Every `guest` setting has a default** (shown above). A setting the block does not know is refused at synth, in every environment, so no bypass can be declared by naming one.
- **The captcha is Cloudflare Turnstile, verified server-side.** Outside production, a guest issuer that names no captcha uses the vendor's published always-pass test keys. The secret is named, never stored in the configuration: a Secrets Manager secret (`secretName`) or an SSM SecureString (`secretParameter`), which the operator creates. The deployment never creates or reads it at synth.
- **Production refuses** (`environment: "production"`): the vendor's test keys, a missing site key or secret, any setting the block does not know, a per-address limit of 0, and a guest classification whose assistant has a message limit of 0.
- **Registration approval** (`registration.approval`, path B): `none`, the default, emails a registration's sign-in link the moment the visitor registers; `admin` holds each registration until an operator approves it from the admin console, and only then sends the link ([Path B](#path-b-the-registration-and-the-claim)). Synth refuses any other value, any other `registration` setting, and `admin` without the `admin` capability, which serves the operator's action. A declaration: there is no runtime switch.

Declaring the issuer adds, in `Identity`: the signing key, the kill switch, the address salt, the guest-session role and its boundary, the two alarms, and the routes `POST /guest/start` and `POST /guest/refresh` on `PersonApi`. In `Conversations` it adds the exchange's grants on `Tokens`, on the abuse-controls table and on the guest classification's conversation creator, and that creator's grants to read and delete a visitor's conversation of its own classification as the service admin and to call its assistant's model ([The seed](#the-seed-and-the-visitors-conversation)). With `registration.approval: "admin"` and the `admin` capability, `AdminServices` adds the console's two registration routes. The `guest` and `customer` classifications and their `Assistants-guest` and `Assistants-customer` stacks are in a deployment only where `profiles` declares them (`resolveDeploymentProfiles`, [HOW-TO-ADD-OR-MANAGE-A-PROFILE 1.5](../developer/HOW-TO-ADD-OR-MANAGE-A-PROFILE.md)).

## Guest start

`POST /guest/start`, with no authorizer and a route throttle of 5 requests per second (burst 10), on the credential exchange's function. The body is `{ "captchaToken": "<the widget's Turnstile response>", "noticeVersion": "<the version the widget showed>" }`. In this order, and nothing later runs when anything earlier refuses:

1. **The kill switch** (`paused`, 503).
2. **The per-address limit** (`rate_limited`, 429, with `retryAfterSeconds` and a `Retry-After` header). An IPv4 address, or an IPv6 address's /64, is counted per window, stored only as an HMAC-SHA256 under a generated per-deployment salt, and the row expires with its window.
3. **The captcha** (`captcha_failed`, 403).
4. The visitor is minted through the one minter (`mintOrResolvePerson`): a fresh subject under the guest issuer, an AppInstanceUser that expires one day after its creation, and an `Identities` row.
5. The privacy-notice version shown is recorded in the access log (`guest_notice_shown`, keyed by the visitor's AppInstanceUser in the `byActor` index). A notice that cannot be recorded refuses the visit.
6. The visitor's conversation is opened by the guest classification's creator, as type `guest-visitor`: the visitor is a member and never a moderator, nobody else is added, and the conversation expires one day after its last message.
7. The guest token is signed (KMS `Sign`, the only KMS call), the refresh credential is written to `Tokens`, and the first session is vended.

**Every control fails closed.** A kill switch, limit store, salt, captcha secret or verifier, token store, creator or signing key that cannot answer refuses with `unavailable` (503), raises an `ae.alert`, and counts toward the `guest-unavailable` alarm. There is no bypass token.

The answer carries the guest token (an ES256 JWT, minutes long, naming the visitor's conversation in `ch`), the refresh credential, the conversation and AppInstanceUser ARNs and a session credential.

## The session, and what holds it to one conversation

A guest token is verified at the edge like any other issuer's: the `kid` names a key generation, the public key is read from KMS, and the issuer URI, the deployment id as audience, the expiry and the token's lifetime are checked. A verified guest is allowed on `POST /exchange-credentials` and `POST /guest/register` alone (`GUEST_ROUTES`); a guest subject with no `Identities` row is denied every route.

At the exchange, a guest is vended the conversation its token names and nothing else. Four layers hold it there:

- **The edge** allows the guest token on the exchange route only.
- **The exchange** refuses a body naming another conversation, an identity or a capability, and every other handler resolves nobody for a guest (`callerPerson`).
- **IAM.** The guest-session role's trust requires the `person`, `channel` and `classification` session tags, and its policy and its permissions boundary name the channel as `channel/${aws:PrincipalTag/channel}` (tagged with the guest classification) and the bearer as `user/${aws:PrincipalTag/person}`, with the read-and-post set only. Assumed with no session policy, it is refused `CreateChannel`, `CreateChannelMembership` and every other channel. The session policy narrows the same set again, and the credential lasts 15 minutes.
- **Amazon Chime SDK membership**: the visitor is a member of their own conversation only.

## Guest refresh

`POST /guest/refresh`, with no authorizer and a route throttle of 20 requests per second (burst 40). The body is `{ "refreshToken": "<the credential>" }`. The kill switch applies. The refresh credential is a `Tokens` record, `guest-refresh#<sha256>`, single-use and rotated on every use, in one family per visit, and never valid past the visit's end (one day after guest start).

- A used credential presented again within 10 seconds of its first use, up to twice, is another tab of the same visitor, and gets its own successor in the same family.
- After that it is a **replay**: the whole family is revoked (`replayed`), so the most recent legitimate credential is refused too (`revoked`) and the visitor starts again. The widget shows this as "this conversation was opened elsewhere", in every tab of the visit, with a way to start a new conversation. A guest token already issued stays valid until it expires, at most one token lifetime.
- An expired credential is refused by the store (`expired`) before DynamoDB TTL has reclaimed it, and a visitor offboarded since is refused (`revoked`).

## The widget

The client half of the visit, in `frontend/packages/widget`:

- **The notice comes first.** The panel shows the privacy notice, with the deployment's version (`GuestNoticeVersion`, written into the widget's build env), before the first message. Accepting it runs the captcha (Turnstile, with the site key from `GuestCaptchaSiteKey`) and sends guest start with that version. The notice text is the widget locale's `widget.notice.body`, which ships as a sample marked "sample" to be replaced with the deployment's own.
- **One refresh holder per visit, across tabs.** The tabs on the widget's origin elect one leader with a Web Lock (`navigator.locks`); only the leader presents the refresh credential, and it publishes every rotation to the other tabs on a `BroadcastChannel`. A follower whose guest token is near its expiry asks the leader; a new tab asks whether a visit is open and joins it; when the leader closes, the lock passes to the next tab (`frontend/packages/widget/src/session/refreshLeader.ts`). The server's 10-second reuse grace stays as the backstop for a leader that closed mid-rotation, a follower the leader did not answer in time, and a browser without Web Locks, where each tab refreshes for itself.
- **The visit survives a reload, and nothing else.** The tokens are kept in the tab's `sessionStorage` until the visit ends, never in `localStorage`.
- **Every refusal is a settled state**, localized: `paused` and `unavailable` (each with the host's declared contact route, `contact` on the loader, when the host passes one), `rate_limited` (with its `retryAfterSeconds`), `captcha_failed` and `invalid_request` at guest start; `replayed` and `revoked` ("this conversation was opened elsewhere") and `expired` and `ended` ("this conversation has ended") at refresh, each ending the visit in every tab.
- **The session credential renews itself.** The Amazon Chime SDK clients are built with a provider that, shortly before the 15-minute session ends, takes a live guest token from the leader and exchanges it again.
- **The visit carries over with nothing to click.** A visitor is never asked whether to keep their visit. Under a live guest session's conversation, when the visitor's conversation type declares an upgrade path (`GuestUpgradePaths`, written into the widget's build env as `VITE_GUEST_UPGRADE_PATHS`) and the deployment names its chat app (`GuestSignInUrl`, `appUrl`), the widget shows what is declared: "Sign in" (path A) opens the chat app's sign-in in a new tab and hands the visit off to that tab alone (a single-use nonce in its URL fragment, `#bindNonce=`, and a secret the widget gives only to the tab it opened, below), and the conversation does not run while the visit is handed over; the registration form (path B) takes a name and the address the sign-in link is emailed to, and says where the link went. The widget never holds a claim token. Every state of both paths is in [SPEC-EMBEDDABLE-WIDGET](../../specs/interface/SPEC-EMBEDDABLE-WIDGET.md#as-built).

## The sample host page

`examples/widget-host/` is a static page that embeds the widget as a host website does: it loads the widget's loader, embed.js (`frontend/packages/widget/src/embed/embed.ts`), from the widget's origin and mounts it in guest mode. It is served from an origin of its own, so `frame-ancestors` is exercised against a real third-party origin rather than the widget's own.

- **Declared as a host, never typed as a domain.** A guest issuer that lists `"widget-host"` in `allowedOrigins` stands up the test-only `WidgetHost` stack (`backend/lib/stacks/widget-host-stack.ts`): a private S3 bucket behind its own CloudFront distribution, with origin access control and HTTPS only, from the same `FrontendDistribution` construct as the other web stacks. The widget's `frame-ancestors` names that distribution's origin by a reference to the stack. `PersonApi`'s CORS does not name it, because the page calls no API: the frame calls from the widget's own origin.
- **Refused where it does not belong.** Synth refuses `"widget-host"` in production, on any issuer that is not the guest issuer, and without the `widget` capability.
- **Published by the deploy.** `npm run deploy` publishes the page after the widget (`node scripts/deploy-frontend.mjs --widget-host`), with a generated `host-config.js` naming the widget's origin from the Widget stack's `WidgetDistributionUrl` output.

`backend/deploy.config.guest-widget.example.json` is a whole deployment built around it, under its own instance name: `guest` and `customer` in `profiles`, the guest issuer with the sample page as its host, the `widget`, `chat`, `admin` and `notifications` capabilities, no connectors, and a test-fixture pool for path B's customer. The guest e2e (`tests/e2e/guest-widget.spec.ts`), the upgrade paths, link invitations and their deny-tests run against that deployment.

## The token store

`Tokens`, in `Conversations`, holds every single-use or bounded token: `pk` is `<kind>#<sha256(token)>`, so the store never holds a usable token, and DynamoDB TTL on `reclaimAt` (`expiresAt` plus 7 days) only reclaims space. Each writer's grant carries `dynamodb:LeadingKeys` limited to its own kinds: the credential exchange writes `guest-refresh#` and `guest-family#`, and, with a `host-assertion` issuer declared, the edge authorizer records `assertion-jti#` (a host assertion's `jti`, which the exchange consumes and never writes); path B's function (`GuestUpgradeFunction`, in `Conversations`) writes `registration#` and `claim#`; the invitations function (`InvitationsFunction`, in `Conversations`) writes `invitation#`, which the exchange reads and consumes and never writes; and the email senders write `reply#` and `unsubscribe#` (`backend/lambda/src/lib/tokens.ts`). One sparse index lists a conversation's invitations; it holds no token.

## Becoming a person

A visitor becomes a person by one of two paths, which the visitor's conversation type declares (`upgrade` in `backend/lib/config/conversation-types.ts`). The shipped `guest-visitor` type declares both: which applies is whether the visitor already has an account, which only the sign-in can say. Neither path ever matches anything by email, and neither asks the visitor to opt in to keeping their visit: signing in from the widget, or from the emailed link, is the whole act, and the visit carries over on its own.

### Path A: the bind

For a visitor with no account yet. The bind starts only from the widget session that owns the visit:

1. "Sign in" opens a tab at once (the named window `ae-widget-sign-in`, keeping its opener), makes a secret that stays in the widget's page, and refreshes the visit once with the secret's SHA-256 (`POST /guest/refresh` with `bindSecretHash`). The refresh answers with `bindNonce` and records a sign-in hand-off (`guest-bind` in `Tokens`): single-use, ten minutes long, naming the refresh credential that refresh issued and the hash. The refresh credential never leaves the widget.
2. The tab is sent to the chat app's sign-in with the nonce alone in its fragment (`#bindNonce=`), asks its opener for the secret with a `postMessage` naming the nonce (`requestPendingBindSecret`), and keeps the answer for this tab. The widget answers only the window it opened, at the chat app's origin, for that nonce (`answerHandOff`, `frontend/packages/widget/src/session/upgrade.ts`). The chat app posts the request only to the widget's origin and takes an answer only from it: `VITE_WIDGET_ORIGIN`, the Widget stack's `WidgetDistributionUrl` output, which `gen-frontend-env.mjs` writes into the chat app's env with the `widget` capability. A page on any other origin that opens the sign-in with its own visit's nonce and secret is ignored, so it cannot bind the person signing in to its visit, and with no widget origin declared nothing is asked.
3. The chat app's first call to `POST /exchange-credentials` after the visitor signs in (`presentPendingBind`, `frontend/packages/shared/src/services/pendingUpgrade.ts`) carries the sign-in token on `Authorization` and the hand-off in the body:

```json
{ "bindGuest": { "nonce": "<the hand-off's nonce>", "secret": "<the widget's secret>" } }
```

A link copied out of that tab, forwarded, or opened in another tab or browser has no widget behind it: no secret arrives, the chat app drops it and says so (`BIND_NOT_HANDED_OFF`), and a nonce presented with any other secret is refused the same way. A body naming a refresh credential is malformed (400), and a `#bindGuest=` link is taken out of the address bar and never presented. No confirmation is asked for or sent; a `confirmed` field an older client still sends is ignored. What makes an unasked bind safe is that hand-off and the refusals below: an existing account is never bound. The exchange (`backend/lambda/src/lib/guest-bind.ts`):

1. refuses a sign-in whose subject already has an `Identities` row or an offboarding marker (`SUBJECT_ALREADY_BOUND`, 409): an existing account takes path B, and the refusal closes login CSRF;
2. refuses a hand-off nobody minted, one already used or expired, another issuer's, or one presented with a secret whose hash is not its own (`BIND_NOT_HANDED_OFF`, 403);
3. refuses a refresh credential that is used, expired, past its visit's end, in a revoked family, or whose visitor is no longer active (`GUEST_SESSION_NOT_LIVE`, 401);
4. removes the visitor's AppInstanceUser expiration (`PutAppInstanceUserExpirationSettings` with no settings);
5. in ONE DynamoDB transaction consumes the refresh credential, revokes its family, writes the signing-in subject's row naming the visitor's AppInstanceUser, deletes the guest issuer's row, and spends the hand-off. A cancelled transaction puts the expiration back and binds nobody;
6. writes `identity_bound_guest` to the access log;
7. opens the visit's continuation: a new conversation at the account's own classification, through that classification's creator, for the visitor's AppInstanceUser (now the account's), and vends the account's session as any sign-in, with `bound: { from: "guest", channelArn, conversationArn }` in the answer, `conversationArn` being the continuation for the client to open.

After the bind, every refresh credential of the visit is refused (`revoked`), and the guest token is refused at the edge, because its subject has no row. The visitor's guest-session AWS credential lasts out its 15 minutes. The account is vended at its own issuer's classification, which never reaches the guest classification, so the visitor's conversation is out of the account's reach: the person is never given `guest`, and the visit continues in the new conversation instead.

The continuation is an ordinary `general` conversation, or a `customer-engagement` one for an account at the `customer` classification: the type that names `guest-visitor` in its `seedFrom` and permits the account's classification (`bindTargetOf` in `backend/lib/config/conversation-types.ts`). It carries the same two tags as a claimed conversation, `upgradedFrom` (the visitor's conversation ARN) and `upgradedFromPerson` (the visitor's AppInstanceUser ARN, the account's own under this path), and the same seed ([The seed](#the-seed-and-the-visitors-conversation)): the visitor's assistant's assessment of the visit, and the visit's registration fields when the visitor registered, in the server-only channel context (`visitSeedOf` in `backend/lambda/src/lib/upgrade.ts`). Once it is open, the visitor's conversation is deleted. Its channel id is derived from the visitor's conversation ARN, so it is created once. A continuation that cannot be opened vends nothing (`CONTINUATION_UNAVAILABLE`, 503): the chat app signs the account in and offers "Try again", which makes the same call; the same call retried, which the exchange recognizes as the bind that already happened (the visit's refresh credential, in a family the bind revoked, presented by the AppInstanceUser it names), binds nothing again and opens or completes the same conversation. Choosing the continuation per conversation type is **ROADMAP**.

**OPEN (O13).** Whether `PutAppInstanceUserExpirationSettings` with no settings removes an existing expiration is probed live by `backend/scripts/deny-test-upgrade.mjs` (row A4). If it cannot, the fallback is to create visitors without an expiration and sweep the unbound ones; that fallback is **NOT BUILT**.

### Path B: the registration and the claim

For a visitor who has an account, or signs up somewhere else. The claim token travels in one place only, the sign-in link emailed to the address the visitor registered; whichever account signs in from that link carries the visit over. Both routes are on `PersonApi` and served by `GuestUpgradeFunction` (`backend/lambda/src/guest-upgrade.ts`).

- `POST /guest/register`, with the guest token: `{ "fields": { "name": "...", "company": "...", "role": "...", "note": "..." }, "email": "..." }` (a name and an address required, every field bounded, any other field dropped, and an address inside `fields` dropped with them). It writes the visit's one registration record (keyed by the hash of the visitor's conversation ARN, kept 30 days). Then, as the issuer declares `registration.approval`:
  - `none`: a fresh `claim` token is issued and any claim issued for the visit before is revoked, the record names it, and the claim email is sent at once, as the transactional `claim` kind in the visit's assistant's words (`AssistantCopy.email`, the `claim*` keys of `backend/lambda/src/lib/email-copy.ts`). Its link is the chat app with the token in the fragment, `<appUrl>/#claim=<token>`. The address is a delivery route for that one email and is stored nowhere. The answer is `{ registrationId, status: "sent", into }`; a mail that could not be sent answers `CLAIM_EMAIL_UNSENT` (503), and registering again sends a fresh link. The email is sent by the `Notifications` stack (`backend/lambda/src/lib/transactional-mail.ts`), so registration needs the `notifications` capability: without it every registration answers `CLAIM_EMAIL_UNSENT`, and the function logs that the capability is not deployed.
  - `admin`: the record waits (`status: "awaiting-approval"`), holding the address, and no claim exists yet. The answer is `{ registrationId, status: "awaiting-approval", into }`.
  The answer never carries the claim token. One visit registers at most 5 times (`REGISTRATION_LIMIT`, 429), so the route sends a bounded number of emails to addresses an anonymous visitor typed.
- `POST /upgrade/claim`, with a signed-in account's token, never answered from the authorizer cache: `{ "claimToken": "..." }`, made by the chat app on its own when the person signs in from the link (`settlePendingUpgrade`). It is refused for an unknown claim (404), a used one (409) and an expired one (410), and for an account whose clearance does not reach the target classification (`NOT_CLEARED_FOR_TARGET`, 403, nothing consumed). Otherwise the claim is redeemed once, the visitor's assistant assesses the visit, the `customer` classification's creator opens a `customer-engagement` conversation for the account seeded with the assessment and the fields, the registration is marked claimed, the visitor's conversation is deleted, and the answer is `{ conversationArn, type, sourceChannelArn }`. A creator that fails undoes the redemption (503) and deletes nothing, so the claim can be tried again.

**Approving a registration** (`registration.approval: "admin"`). The admin console's Guest panel lists the registrations waiting, with what each visitor registered and the address the link goes to, and Approve (`approve-registrations`: `GET /users/guest/registrations`, `POST /users/guest/registrations/{registrationId}/approve` on `AdminApi`, IAM-authorized, served by `AdminRegistrationsFunction`, which invokes `GuestUpgradeFunction` and holds no other grant). Approving issues the claim and sends the email, then marks the record open and forgets the address; a mail that could not be sent leaves it waiting. A sparse index on `Tokens` (`registrationsAwaitingApproval`) lists the waiting records, and exists only where `admin` is declared. Rejecting a registration is **NOT BUILT**: an unapproved one expires with its record.

The new conversation carries two resource tags beside its classification: `upgradedFrom` (the visitor's conversation ARN) and `upgradedFromPerson` (the visitor's AppInstanceUser ARN). Only the creator's role writes them. The visitor's AppInstanceUser lapses on its own expiration.

### The seed and the visitor's conversation

When a visit carries over (a claim, or a bind's continuation), the caller asks the guest classification's creator to assess the visitor's conversation (`kind: "assess"`, `backend/lambda/src/lib/visit-assessment.ts`). It reads the newest 50 messages as the service admin, and the visitor's assistant writes its account of the visit: what it was about, what the visitor appears to want and how well the deployment can serve it, what is still open, and one or two sentences that open the new conversation, all in the language the visitor wrote in. The model and the prompt are the assistant's: its active profile version's base model (`models.default`, else the profile's `modelKey`), its persona, and its intent pack's `conversation_summary` instructions when it declares any. The seed, in the new conversation's server-only channel context (`domainContext`), is that assessment beside the registered fields; no message is copied, and the address never travels. The welcome opens on the assessment's line (`visitSummary` in the channel context, rendered by `composeWelcome`). Before it is stored or shown, every field the model wrote passes the guest classification's own Bedrock guardrail as model output (`ApplyGuardrail`: the one its active version selects, else the default its assistant stack publishes at `/assistant/guest/guardrails`; the creator's grant reaches only guardrails tagged with that classification). A model that does not answer within 8 seconds, an answer that is not an assessment, and an assessment the guardrail blocks or cannot be applied to all leave the seed with the fields alone, and the carry-over goes ahead.

Once the new conversation and its seed exist, the caller asks the same creator to delete the visitor's conversation (`kind: "retire"`, `retireVisitorConversation` in `backend/lambda/src/lib/channel-creation.ts`), which it does only for a visitor's conversation of its own classification. A deletion that fails is logged, and the conversation lapses on its own expiration a day after its last message.

Erasing the account follows the tag, on a claimed conversation and on a bind's continuation alike: offboarding deletes, from the visitor's conversation, every message sent by the account or by the visitor the tag names, and the visit's registration record (`upgradeSources` in the `offboarding` event). A visitor's conversation already deleted has nothing left to remove, and the registration record still goes.

The `customer` classification is reached by a signed-in issuer whose classifications are all outside classifications, such as a customers' pool with `clearance: { fixed: ["customer"], classifications: ["customer"] }`. Without one, no account can claim.

## The funnel

Each stage of a visit is one event the platform appends to the archive at the moment it happens, keyed by the AppInstanceUser it is about and carrying the visitor's conversation as its journey (`backend/lambda/src/lib/funnel.ts`):

| Stage | Recorded by | Path |
|---|---|---|
| `guest_started` | guest start | both |
| `guest_refused` | guest start, by reason code, naming nobody | both |
| `claim_sent` | the registration, when its claim email is sent (at registration, or at approval) | B |
| `claim_redeemed` | the claim, on the account | B |
| `guest_bound` | the bind, on the visitor who is now the account | A |

`registration_offered`, `registration_started`, `rep_added`, `rep_first_reply` and `handoff_unassigned` are declared and **NOT BUILT**: no component records them yet, so the console names them as not built rather than counting zero. Under path B the account is another AppInstanceUser, and the stages are joined by the journey, the visitor's conversation, which the customer conversation's `upgradedFrom` tag names too; nothing is joined by an address. A stage that cannot be archived is logged and never fails the visit. The console reads the funnel and the refusals by reason through the analytics query (`guest_to_customer_funnel`, `guest_refusals`), in either archive mode, and `guest_to_customer_funnel` takes a `journey` to read one visit's stages.

## The kill switch

An SSM parameter, `/<instance>/guest/<issuer id>/paused`, created off. A deploy never resets it (its template value never changes). Guest start and guest refresh read it, cached for ten seconds, and refuse with `paused` while it is on; an unreadable value refuses with `unavailable`. Change it with the caller's identity recorded:

```bash
cd backend
AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> node scripts/guest-switch.mjs pause --reason "abuse from one network"
AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> node scripts/guest-switch.mjs resume --reason "cleared"
AWS_PROFILE=<profile> AE_INSTANCE_NAME=<instance> node scripts/guest-switch.mjs status
```

SSM's parameter history records the IAM principal of every change as well. The admin console's Guest panel shows the switch's state and who changed it (`GET /users/guest`, `view-guest-sessions`); changing it from the console is **NOT BUILT**.

## Rotating the signing key

KMS does not rotate an asymmetric key, so a key generation is replaced by declaring a new one. Each generation in `guest.signingKeys` is its own `ECC_NIST_P256` `SIGN_VERIFY` key, aliased `alias/<instance>-guest-<issuer id>-<generation>`; the last one listed signs, and the edge verifies against every one listed (at most two).

1. Append the new generation (`["g1"]` becomes `["g1", "g2"]`) and deploy `Identity` and `PersonApi`. New tokens are signed with `g2`; tokens signed with `g1` still verify.
2. Wait at least one token lifetime (`tokenMinutes`) plus the edge cache (5 minutes).
3. Remove the old generation (`["g2"]`) and deploy again. Tokens naming `g1` are refused, and its key is scheduled for deletion after KMS's 7-day pending window (kept in production by the stack's removal policy, and deleted by hand when no longer needed).

## Alarms

- `<Identity stack>-guest-signing-throttled`: KMS throttled a `Sign`. The KMS request quota is shared with every other key in the account and region, so guest start is refusing visitors with `unavailable` until it clears.
- `<Identity stack>-guest-unavailable`: guest start or refresh refused a visitor because a control could not answer.

Both count from metric lines the exchange writes (`AgentEchelon/Guest`), and treat missing data as not breaching. Refusals by every reason are in the same namespace (`GuestRefused`, by `Reason`), the alarm's signal; the count of starts and of refusals by reason a person reads is the funnel's, from the archive.

## Verified by

- Widget: `frontend/packages/widget/src/session/refreshLeader.test.ts` (one leader, one refresh across tabs, a replay ends every tab), `frontend/packages/widget/src/components/GuestStart.test.tsx` (the notice, guest start, each refusal's state, a second locale) and `frontend/packages/widget/src/components/CarryOver.test.tsx` (no step to keep the visit, signing in, the registration and its outcomes, a second locale). Chat app: `frontend/packages/shared/src/services/pendingUpgrade.test.ts` (the hand-off asked of and taken from the declared widget origin alone). Console: `frontend/packages/admin/src/components/admin/GuestRegistrations.test.tsx`.
- Unit: `backend/test/the-guest-session-fails-closed.test.ts`, `backend/test/lib/the-edge-verifies-a-guest-token.test.ts`, `backend/test/the-guest-session-reaches-one-conversation.test.ts`, `backend/test/the-guest-issuer-is-declared-with-its-controls.test.ts`, `backend/test/the-token-store-redeems-a-token-once.test.ts`; for the two paths, `backend/test/lib/binding-a-guest-ends-the-guest-credential.test.ts`, `backend/test/a-bind-continues-the-visit-in-a-new-conversation.test.ts`, `backend/test/the-exchange-continues-a-bound-visit.test.ts`, `backend/test/a-claim-opens-a-tagged-customer-conversation.test.ts`, `backend/test/the-visit-carries-over-with-nothing-to-click.test.ts`, `backend/test/the-upgrade-paths-are-granted-narrowly.test.ts` and `backend/test/user-management-delete.test.ts`; for the sample host page, `backend/test/the-sample-host-page-is-its-own-origin.test.ts`.
- Live: `backend/scripts/deny-test-guest.mjs`, `backend/scripts/deny-test-tokens.mjs`, `backend/scripts/deny-test-upgrade.mjs`, and `tests/e2e/guest-widget.spec.ts` and `tests/e2e/funnel.spec.ts` (the optional `guest-and-invitations` phase of `node scripts/validate.mjs`, run against a guest-widget deployment), written and **NOT RUN**. Each run is recorded here, dated, with its result.
