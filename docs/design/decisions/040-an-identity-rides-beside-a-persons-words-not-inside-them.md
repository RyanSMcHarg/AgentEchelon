---
title: "ADR-040: An identity rides beside a person's words, not inside them"
status: >-
  Accepted 2026-09-29. Two proposals the owner named about identity: showing user ids rather than display names in the admin console, endorsed in substance and declined in the form proposed, because the operator cost of an opaque id alone is real; and substituting stable identifiers for mentions and private addresses inside the message body, declined, because the body is the one field that holds what a person wrote and the archive is the system of record for it. The code runs the decision: the console renders the principal id on every person-bearing surface it has the id for, with a display name as a separate grant on top of it (SPEC-ADMIN-CONSOLE FR41, FR42; `ConversationsTab.identity.test.tsx`, `who-a-person-is-is-a-separate-grant.test.ts`), and the middle option is built for the `.` private address: the composer declares the picked member's id, the server resolves the addressee by id first (`private-prefix.ts`), and the stored `Target` is compared by exact ARN (`enforcePrivateAddressTarget` in `private-command.ts`; `a-private-address-names-a-member-by-id.test.ts`). **OPEN:** the two console surfaces that hold a name with no id in the payload (moderation tombstones, the membership `invitedBy`), an id-based `@mention`, the same-name collision at the picker, and the ASCII-only `tokenContinues` boundary.
date: 2026-09-16
related:
  - "./016-message-metadata-encoding.md"
  - "./017-conversation-archive-mechanism.md"
  - "./020-versioned-rows-hold-provenance-not-current-state.md"
  - "./021-user-administration-is-not-idp-abstracted.md"
  - "./022-message-identity-is-established-at-the-channel-flow.md"
  - "./027-speaker-attributed-transcript.md"
  - "./034-addressing-a-message-is-not-making-it-private.md"
  - "./039-a-routing-decision-is-made-from-the-message.md"
  - "../../overview/TENETS.md"
  - "../../specs/communication/SPEC-MESSAGE-METADATA-CODEBOOK.md"
  - "../../specs/interaction/conversation/SPEC-USER-PROFILE-AND-ONBOARDING.md"
  - "../../specs/interface/SPEC-ADMIN-CONSOLE.md"
  - "../../guides/developer/MESSAGE-FLOW.md"
  - "../../../backend/lambda/src/lib/private-prefix.ts"
  - "../../../backend/lambda/src/lib/private-command.ts"
  - "../../../backend/lambda/src/lib/flow-bypass.ts"
  - "../../../backend/lambda/src/lib/channel-size.ts"
  - "../../../backend/lambda/src/lib/transcript-attribution.ts"
  - "../../../backend/lambda/src/credential-exchange.ts"
  - "../../../backend/lib/stacks/identity-stack.ts"
  - "../../../backend/lambda/src/analytics-aurora/kinesis-archival.ts"
  - "../../../backend/lambda/src/analytics-aurora/admin-conversations-aurora.ts"
  - "../../../frontend/packages/chat/src/utils/mentionParser.ts"
  - "../../../frontend/packages/chat/src/components/MessageInput.tsx"
  - "../../../frontend/packages/chat/src/services/chimeService.ts"
  - "../../../frontend/packages/admin/src/components/admin/MessageInspectDrawer.tsx"
  - "../../../frontend/packages/admin/src/components/admin/ConversationsTab.tsx"
tracking: |
  Accepted 2026-09-29. The console renders the principal id with the display name as a separate grant,
  and the `.` private address is resolved by id and compared by exact ARN; both are verified by the
  tests named in the status. The two console surfaces with no id in the payload, an id-based
  `@mention`, the picker's same-name collision and the ASCII-only `tokenContinues` boundary are OPEN. No option is measured against another on a deployment. The same-name defect it
  reports, that two members of one conversation may carry the same display name and a name resolver
  takes the first, is read from the resolvers rather than reproduced against a deployment, and remains
  for `@mention`, which still resolves by name.
---

# ADR-040: An identity rides beside a person's words, not inside them

## Status

**Accepted, and the `.` private address is BUILT (verified against the tree 2026-09-29).** This record answers two questions the owner asked about identity, states what each would cost against the code as it stands, and recommends yes to the first in a different form, no to the second, and a middle option the questions did not name.

**What is built, for the `.` private address:** option B2 and recommendation 5, end to end. The composer declares the id its picker resolved (`mentionParser.ts`, `.<Name|id>`), the server resolves the addressee by ID FIRST with the name as fallback (`private-prefix.ts`, "THE ID WINS"), and the stored Chime `Target` is compared against that resolved addressee by exact ARN (`private-command.ts` `enforcePrivateAddressTarget`, whose `addresseeArn` is required so a caller cannot get the existence-only check back). A mismatch is a `misdirected` outcome with its own counter, and the sender is told. Guarded by `a-private-address-names-a-member-by-id.test.ts` and `one-private-address-grammar.test.ts`, which also keeps the two copies of the grammar textually identical.

**What is NOT built:** the same treatment for `@mention`, which still travels as a display name in the body and is resolved by a name match server-side. The route this record's title suggests - the id riding beside the words - is blocked for it: the resolved ARNs do ride in the `CHIME.mentions` attribute, but the channel-flow callback carries no `MessageAttributes` at all, and the one beside-channel that does reach the flow is `Metadata`, which is member-writable. Routing on an id there would let a different member redirect somebody else's mention, so an id-based `@mention` has to be the body grammar too. Also not built: the same-name collision at the picker (the dropdown filters on name with no secondary id line), and the ASCII-only `tokenContinues` boundary.

## Problem, and who has it

An operator reading the admin console needs to know **which person** a row is about, with enough precision to act on it: to revoke a membership, to answer an access request, to read a transcript and attribute a sentence. A display name is what a person recognizes and an identifier is what is unique, and those are not the same property.

A member of a conversation needs a private message to reach the person they meant. Today a `.`-prefixed private address and an `@` mention both resolve by display name, so the name is not only shown, it decides.

On 2026-09-16 a security review found that a signed-in user could rewrite their own Cognito `name` attribute, because the app clients set no `writeAttributes` and Cognito's default lets a user write every attribute with their own access token. A member could therefore take another member's display name and have a private `.Name` message resolve to them. That is fixed: the pool clients now write only `email` and `custom:tier` (`backend/lib/stacks/identity-stack.ts:1152`), and the display name is refreshed from the verified token claim at every credential exchange (`backend/lambda/src/lib/vend.ts:287-300`).

The two proposals are:

**(A) The admin console shows user ids rather than display names.**

**(B) Mentions and targets are stored in the message body as stable identifiers, and the client translates them back to names for display.**

They are asked together because both are about making identity precise rather than nominal, and (B) reads as a second layer under the security fix above: if the body carried identifiers, a display name would stop being load-bearing for routing at all.

## Where a display name is load-bearing today

"Load-bearing" here means the name decides something, not that it is shown.

| Site | What the name decides | Where |
|---|---|---|
| The private address `.<member>` | which member a `Target` is meant for; the message is stripped of the prefix only when it resolved | `backend/lambda/src/lib/private-prefix.ts:136-144`, `:160-169` |
| The mention `@<member>` | which member the channel flow routes the turn to, which assistant must answer, and whether the handler stands down | `backend/lambda/src/lib/flow-bypass.ts:294-321`, `:346`, `:416` |
| Stripping the mention before the model sees it | what text the turn is actually asked about | `backend/lambda/src/lib/flow-bypass.ts:482-500` |
| The composer's picker and its private chip | which member the person is offered, and which one the chip names | `frontend/packages/chat/src/components/MessageInput.tsx:124`, `:243-248`, `:748` |
| The client's own parse before send | which ARN goes in `Target` and in `CHIME.mentions` | `frontend/packages/chat/src/utils/mentionParser.ts:246`, `:253`, `:275-277` |
| A `/stop` that names somebody | whether the stop targets this responder outright, decided from the PRESENCE of an `@` token and never resolved against the roster | `backend/lambda/src/lib/stop-target.ts:38`, `:63-64`, `:88` |
| The speaker label in the model's transcript | who the model is told said a line, in a label it is instructed to trust | `backend/lambda/src/lib/transcript-attribution.ts:47-50` |
| Whether the transcript is labeled at all | a set membership that falls back to the name when a speaker has no id | `backend/lambda/src/lib/transcript-attribution.ts:149` |
| The conversation summary's transcript | who the summarizing model reads each line as | `backend/lambda/src/analytics-aurora/summary-updater.ts:254` |
| The admin surfaces that render a name with no id | who an operator reads as having sent, joined, invited, redacted or deleted | the table under (A) below |

**The roster those resolvers read is the Amazon Chime SDK's own membership list**, read live and carried through the flow rather than copied (`backend/lambda/src/lib/channel-size.ts:145-147`, reading `Member.Arn` and `Member.Name`). That is the authoritative current-state source tenet D7 names, and it is why the backend re-derives rather than trusting the client's parse (`backend/lambda/src/lib/private-prefix.ts:6-7`).

**The backend roster is bounded and the client's is not.** The backend pages to ten pages of fifty and warns when it truncates, in which case a mention of a later member resolves to nobody (`backend/lambda/src/lib/channel-size.ts:66`, `:156-160`). The client makes one `ListChannelMemberships` call with no continuation (`frontend/packages/chat/src/services/chimeService.ts:538-548`), so past the service's default page the picker and the backend resolve different rosters.

**One name-shaped token decides without being resolved at all.** `/stop` counts any `@` token other than `@all` as "addressed" and targets this responder on that basis (`backend/lambda/src/lib/stop-target.ts:63-64`), using a narrower character class than the mention resolver does (`:38`). So an email-named member lexes differently on the two paths. That is a third lexer for the same shape, alongside the resolver's and the composer's draft pattern (`frontend/packages/chat/src/components/MessageInput.tsx:305`), and only the first two are on a decision path.

**The ledger already forbids a name where an identity belongs, mechanically.** `backend/test/analytics-aurora/turn-audit-schema.test.ts:79-98` fails the build if the turn ledger declares a `sender_name`, `display_name` or `email` column, on the stated rule that `actor` holds an identity REFERENCE and a name or address must never appear. That rule is proposal (A)'s principle, already written down and already enforced, on the one table where it was worth enforcing.

**The name on that roster is a cache of an identity-provider fact**, copied from the verified `name` claim at the credential exchange (`backend/lambda/src/lib/vend.ts:287-300`). `SPEC-USER-PROFILE-AND-ONBOARDING` states the same rule from the store side: the identity provider owns `displayName`, it is resolved at the point of need, and this platform never sources it from channel metadata or from its own profile store.

### Where an id is already the decider, and this is most places

**Every field that routes is already an id.** `Target` is a `MemberArn` (`frontend/packages/chat/src/services/chimeService.ts:371`), `CHIME.mentions` is a list of ARNs (`frontend/packages/chat/src/services/chimeService.ts:392-402`), and the AppInstanceUser id is the person id, minted once per issuer and subject (`backend/lambda/src/credential-exchange.ts:228-232`). The name's entire job is to turn typed characters into one of those ids, at the two places a person types a token.

> **Amended 2026-10-17: the person key is the AppInstanceUser id, not the Cognito `sub`.** The convention named in the paragraph above is not the contract. A person is one AppInstanceUser whichever identity provider signed them in; the id is opaque, minted once by the credential exchange, and mapped from an issuer's record through the `Identities` index, so it is never a `sub` ([IDENTITY-AND-ACCESS-MODEL.md](../../specs/interaction/governance/IDENTITY-AND-ACCESS-MODEL.md) §1a). This record's decision is unchanged and is strengthened by it: every routing field is an ARN, and the ARN names the person for every issuer, where a `sub` names them only for the deployment's own pool. The exchange mints the id as a UUID v7 through `mintOrResolvePerson` (`backend/lambda/src/lib/person-identity.ts`).

**The archive already holds both.** A message row carries `sender_arn`, `sender_name` and `target_arn` side by side (`backend/lambda/src/analytics-aurora/schema/001-initial.sql:51-53`), with the name taken as it stood at that moment (`backend/lambda/src/analytics-aurora/kinesis-archival.ts:525`). So the archive is already the pairing that proposal (B) wants, recorded per row rather than substituted into text, and it is already immune to a later rename.

**The admin console is already mostly id-first**, which is the finding that reshapes proposal (A) and is set out under it below.

### The defect that is live today, and it is not the one the security fix closed

**Nothing prevents two members of one conversation from carrying the same display name, and both resolvers take the first one they find.**

`resolvePrivateTarget` is a `members.find` on an exact lowercase match (`backend/lambda/src/lib/private-prefix.ts:143`). `resolveMentionedMember` prefers the earliest token position and breaks a tie on equal position by the longer name (`backend/lambda/src/lib/flow-bypass.ts:312`), which for two identical names is no tie-break at all and resolves to whichever the roster iterated first. The composer's own chip does the same (`frontend/packages/chat/src/components/MessageInput.tsx:124`).

**A collision is not hypothetical on a deployment without a `name` claim.** The display name falls back through the email local part, then the username when it is not a UUID (`backend/lambda/src/lib/vend.ts:215-225`), so `jane@example.com` and `jane@other.example` both become `jane`.

**And the picker cannot show the difference.** The dropdown renders the trigger character and the name and nothing else (`frontend/packages/chat/src/components/MessageInput.tsx:748`), and filters on the name alone (`:248`). Two members named `jane` are two identical rows, and picking either writes the same characters.

This matters to both proposals, because it is the one place where "the name decides" produces a wrong answer with no bad actor involved, and neither proposal as stated fixes it. Proposal (B) moves the ambiguity from the resolver to the person choosing in the picker; it does not remove it.

### One language asymmetry in the resolver, recorded because tenet D11 is asked about below

`tokenContinues` decides whether a matched token ends where it appears to (`backend/lambda/src/lib/flow-bypass.ts:285-293`). It asks `/\w/`, which in JavaScript is `[A-Za-z0-9_]` and ASCII only.

So in a Latin script `@alice` correctly does not match inside `@alicewong`, and in a non-Latin script the character after the match is neither `\w` nor name punctuation, the token is treated as finished, and a shorter name matches inside a longer one.

The prefilter one function above it was already corrected for exactly this class of error and its comment names tenet D11 (`backend/lambda/src/lib/flow-bypass.ts:210-216`). The boundary test was not corrected with it. This is a narrow bug rather than an argument for either proposal, and it is recorded here because it is the honest answer to "does name resolution behave the same in another language": today it does not.

## (A) The admin console shows ids rather than names

### What it shows today, read from the tree

| Surface | Shows | Id present? |
|---|---|---|
| User management (approve, tier, enable) | the email, with the username as fallback; every action posts `username` | Yes. The name is not shown at all (`frontend/packages/admin/src/components/admin/UserManagementTab.tsx:244-247`, `:268`) |
| Users analytics tab | the first twelve characters of `person_id` | Yes, by construction (`frontend/packages/admin/src/components/admin/UsersTab.tsx:281`) |
| Membership audit findings | `memberArn` shortened, full ARN on hover, and **no name at all** | Yes, to the exclusion of the name (`frontend/packages/admin/src/components/admin/MembershipAuditTab.tsx:131`) |
| Message inspect drawer | the ARN in a monospace line, and the sender name above it only under `see-user-identity`, with the literal `identity not shown` in its place otherwise | **Yes, and the name is the part that is conditional** (`frontend/packages/admin/src/components/admin/MessageInspectDrawer.tsx`) |
| Conversation transcript column | `senderName` under the grant, the Cognito `sub` from `senderArn` without it | Yes, through `principalOf` (`frontend/packages/admin/src/components/admin/ConversationsTab.tsx`) |
| Conversation members table | the principal id alone, for every caller | Yes, to the exclusion of the name. This panel is read client-side from Amazon Chime SDK `ListChannelMemberships`, so no server omission reaches it and the client cannot gate what it was never told (`frontend/packages/admin/src/components/admin/ConversationsTab.tsx`) |
| Conversation events column | `senderName` under the grant, falling back to `senderArn` | Yes. The fallback is the withholding path rather than an accident of missing data (`frontend/packages/admin/src/components/admin/ConversationsTab.tsx`) |
| Moderation tombstones, "Deleted by" and "Redacted by" | `moderatedByName` under the grant, the role otherwise | No id, and `moderatedByArn` is null in practice, so a withheld name leaves only "by an admin". The subject here is the OPERATOR rather than the participant, and naming them is what `view-moderation-audit` is for (`frontend/packages/admin/src/components/admin/ConversationsTab.tsx`) |
| Membership timeline `invitedBy` | the inviter's name under the grant, and the clause is absent without it | No. `invited_by` is a `sender_name` and no inviter ARN is archived beside it, so this is the one field with no id to degrade to (`backend/lambda/src/analytics-aurora/admin-conversations-aurora.ts`) |

**Why it is shaped this way.** The surfaces that ACT on a person were built against the identity they act with: user management calls Cognito by username, the membership audit revokes by ARN, and the analytics tabs aggregate on `person_id`. The surfaces that READ a conversation were built to be read, and a transcript of ARNs is not one. The split is the same one the codebook spec draws between what a person reads and what a system joins on.

**No admin aggregation keys on a name.** Every per-user rollup groups on the person id (`backend/lambda/src/analytics-aurora/analytics-query.ts:3060`, `COUNT(DISTINCT person_id)` at `:3016` and `:3036`; the Athena twin at `backend/lambda/src/analytics-query.ts:305`), the member count dedupes on `target_arn` (`backend/lambda/src/analytics-aurora/admin-conversations-aurora.ts:152-161`), and the client-side dedupe is a set of `person_id` (`frontend/packages/admin/src/components/admin/UsersTab.tsx:146`). No React key in the console is a display name. So the exposure is presentational rather than arithmetic, and no figure an operator reads is wrong because of it.

### Which admin surfaces cannot distinguish two people with the same display name

**Two, and they are the two rows above with no id to render.** The moderation tombstones, whose `moderatedByArn` is null in practice, and the membership timeline's `invitedBy`, which the archive stores as a name alone. Every other person-bearing surface renders the Cognito `sub` from the ARN it already has, so two people sharing a display name are distinguishable on it (FR42).

**Sorting makes it worse rather than revealing it.** The shared table sorts client-side by `String(aVal).localeCompare(String(bVal))` (`frontend/packages/admin/src/components/admin/DataTable.tsx:76-85`), so clicking the Sender or Name header gathers two different people with the same name into one contiguous block with nothing on screen to separate them.

**The remaining two cannot be closed on the client, because the id is not in the payload.** Closing them means archiving the actor ARN beside the action: `moderation_actions` stores `actor_arn` and the tombstone does not read it, and the membership event stores no inviter ARN at all, so that one needs the archival write to change before any surface can render it. **OPEN.**

**The fourth needs one column added to a query rather than a new fact.** The inviter's ARN IS archived: `kinesis-archival.ts:630` writes `sender_arn` from `Payload.InvitedBy?.Arn`. `adminMembershipHistory` selects `sender_name` and not `sender_arn` (`backend/lambda/src/analytics-aurora/admin-conversations-aurora.ts:420-424`), so the id exists in the store and is dropped on the way to the operator.

**One genuinely missing fact, and it is on the moderation path rather than the membership one.** `moderation_actions.actor_arn` is selected by the admin read (`backend/lambda/src/analytics-aurora/admin-conversations-aurora.ts:271`) and is always null, because `recordModerationAction` is called with `actorSub` and `actorName` and never an `actorArn` (`backend/lambda/src/analytics-aurora/analytics-query.ts:860-863`, written at `:231-234`). The actor's SUB is stored and is not returned to the client. So "who redacted this message" is a bare display name on the surface where accountability is the entire point, and the id to fix it is one field in the response rather than a new write.

**The two user tabs share one key.** `listPeople` lists every AppInstanceUser a subject signs in as, from any issuer, and returns its `personArn` and `personId` beside the pool account (`backend/lambda/src/user-management.ts:468-520`), the same AppInstanceUser ARN a conversation's members carry.

### The recommendation on (A)

**Yes to the substance, no to the form.** Showing an id INSTEAD of a name would make an operator worse at the thing an operator is for, which is recognizing a person and deciding. An opaque `sub` is precise and unrecognizable, and the console has a surface where a name genuinely is the useful label: a transcript.

**Show the id beside the name, in the shape the console already uses.** Two patterns are already built and either fits: `MessageInspectDrawer` renders the name and then the ARN in a monospace line below it (`frontend/packages/admin/src/components/admin/MessageInspectDrawer.tsx:59-60`), and the membership audit renders a shortened ARN in a monospace span with the full value on hover (`frontend/packages/admin/src/components/admin/MembershipAuditTab.tsx:13-16`, `:131`). The stylesheet already carries `.admin-mono-id` and `.admin-mono-arn` (`frontend/packages/admin/src/components/admin/AdminDashboard.css:1301-1303`). Extending either is a rendering change rather than a model change.

**Four corrections are worth naming as work rather than as taste, in increasing cost:**

- **Draw the id that is already on the row** for the transcript Sender column and the members table. Nothing new is fetched.
- **Show the id alongside the name on the events column**, rather than only when the name is absent. A fallback that shows an id only when there is no name is the opposite of what precision wants: it hides the id exactly when two names might collide.
- **Select the inviter's ARN on the membership history query**, which is one column on a statement that already reads the row, plus a field on the event type.
- **Return the moderation actor's identity.** This is the only item here where the operator-facing fact is genuinely absent rather than merely undrawn, and it sits on the accountability surface.

**And one correlation gap that is not about display names but is found by asking this question.** `listUsers` should return the sub, or the two user tabs remain two populations an operator cannot join.

**And the sharper version of (A) is the picker, not the console.** The place where an operator or a member is actually harmed by two identical names is the composer's member dropdown, where picking the wrong `jane` sends a private message to the wrong person. Applying (A)'s principle there, a secondary line under the name in the dropdown, fixes a routing defect rather than a display one. That is the same change and it is worth more.

## (B) Identifiers in the message body

### What it would actually change

The message body is the person's own words. The platform's standing position on that field is already written: a marker in user content is treated as attacker-supplied and stripped (`stripMessageMarkers`), and ADR-037 records why the platform does not write its own identifiers into a person's message at all, in one sentence that answers this proposal directly: "Writing a platform marker into a person's message would make the archive disagree with what they typed."

**The archive is the system of record for what a message said** (tenet D7). Substituting `@<arn>` for `@Alice` means the S3 and Athena archive, which is append-only and outlives the channel, holds text the person did not write. Every later reader of that archive, including an evaluation run, a compliance read and a summarizer, reads the substituted form.

**A client that cannot resolve the id shows the id.** This is not an edge case here:

- The chat client resolves names from `listChannelMembers`, which is one `ListChannelMemberships` call with no pagination loop (`frontend/packages/chat/src/services/chimeService.ts:538-548`). On a large conversation the roster is already partial.
- The roster holds CURRENT members. A person who has left the conversation is not in it, so every historical message naming them renders as a raw ARN forever, and a conversation's history is precisely where a departed member is most often named.
- **The admin console has no roster at all.** It reads the archive (`backend/lambda/src/analytics-aurora/admin-conversations-aurora.ts:258`), so every transcript an operator reads would carry ARNs in the body. That is the exact opposite of what proposal (A) is asking for, from the same owner, in the same tab.

**It does not remove the display name from the decision.** The name is what the person types and what the picker matches (`frontend/packages/chat/src/components/MessageInput.tsx:243-248`). A body full of ids is downstream of a choice still made by name, so the collision described above is unchanged: two members named `jane` are still two identical rows, and the client still writes one of their ids because the person picked one of two indistinguishable entries.

**It does not change who is trusted.** An id in the body is a string a client wrote, exactly as a name is. The flow's rule today is that a client is not the authority on who is in the room, so it re-derives from the roster. With ids in the body it would still have to check the id is a member of this channel, which is the same roster read it makes now.

**It would also lose a real property the name has.** A name in the body is legible to the model that reads the transcript, and the transcript already labels each line with a speaker name the model is instructed to trust (`backend/lambda/src/lib/transcript-attribution.ts:47-50`). A body that says `@arn:aws:chime:...:user/9f2a...` hands the model an identifier it cannot connect to any speaker label, so the mention stops being readable as an address by the one participant whose whole job is reading.

### The migration, priced

The proposal changes how messages are stored, so it is priced rather than asserted.

**The Amazon Chime SDK's own stored content would have to be rewritten per message**, with one `UpdateChannelMessage` for each historical message containing a token. Every one of those emits an UPDATE event onto the Kinesis stream, so the archive would record the deployment's entire history as edited, and Aurora's admin read derives redaction and deletion state from exactly those sibling rows. An audit of "what changed in this conversation" becomes unreadable for the sake of a display convention.

**The S3 and Athena archive cannot be rewritten at all.** It is append-only by design (tenet D7, ADR-017). Rewriting the live message does not reach the row already written; it adds a second row. So the archive would hold the original text and the substituted text for the same message, and a reader would have to know which is authoritative.

**Would existing messages render correctly afterwards? No, and in both directions.** Messages written before the change carry names, messages after carry ids, and every reader, the chat client, the admin console, the summarizer, the evaluation runner, needs both grammars indefinitely. ADR-034 already settled that a permanent fork in the meaning of a token is worse than a declared break, and this would be exactly that fork inside the one field that is supposed to be a person's own words.

**The honest conclusion is that there is no migration worth buying**, because the thing it buys, an id in the body, is already available beside the body at no cost.

### The recommendation on (B)

**No.** Not as a staged change, not behind a flag, and not as a forward-only convention that leaves old messages alone.

## The middle option, which is most of the way built

**Carry the resolved ids in message metadata beside the human text, rather than in place of it.**

This is not a new idea here. It is the shape `CHIME.mentions` already has: a message attribute listing every resolved member's ARN, written beside the words, while the body keeps what the person typed (`frontend/packages/chat/src/services/chimeService.ts:392-402`, populated from `mentionedArns` at `frontend/packages/chat/src/utils/mentionParser.ts:305`). ADR-034 records the correction that made it carry every resolved member rather than only an assistant.

**So for `@`, the middle option is already the shipped design**, and what it buys is exactly what proposal (B) was reaching for: the body says `@Alice` and the message carries Alice's ARN, so a rename does not rewrite history and an unresolvable id never reaches a reader's eye.

**The gap is the `.` private address, and it is one specific thing.** A private message deliberately does NOT go into `CHIME.mentions`, because a `Target` already routes it and a second route to a targeted assistant would be a duplicate (ADR-034). But the `Target` was checked only for EXISTENCE: `readStoredTarget` returned targeted when any `MemberArn` was present, and nothing compared that ARN to the member the text's `.Name` token resolved to.

**That gap is CLOSED (2026-09-29).** `readStoredTarget` now returns the member ARNs rather than a boolean, and `enforcePrivateAddressTarget` compares them against the id-resolved addressee - which it takes as a required argument precisely so a caller cannot reintroduce the existence-only check. The paragraph is kept rather than deleted because it states the reasoning the fix rests on, and a reader arriving at the recommendation below needs to know which half of it already shipped.

So a client can write `.Alice` in the body and set the `Target` to Bob. The room sees nothing, because the message is private; Bob receives a message that opens by addressing Alice. The platform has the roster, has the text and has the stored `Target`, and does not make the comparison.

**What the middle option adds, therefore, is one declaration and one check.** The composer declares the id its picker resolved, and the existing post-release read compares it to the `Target` it already fetches. The check is against a fact the sender's own client asserted, so it detects a client defect rather than an attack, which is the same job `recordPrivateMessageWithoutTarget` already does on the adjacent branch (`backend/lambda/src/lib/private-command.ts:234-242`).

**On the metadata budget, stated because it is the reflex objection.** `SPEC-MESSAGE-METADATA-CODEBOOK` measures a premium experiment turn at 1022 of 1024 encoded characters and warns that "there is room for one more small field" has never been true. Two things keep that from binding here. The budget is measured on the ASSISTANT's message, and the spec states plainly that a person's message carries no platform metadata at all, so a declaration on a person's own message starts from zero. And `CHIME.mentions` is a message ATTRIBUTE, a separate field from `Metadata`, so the existing mention carrier does not spend that budget either. A new field on an assistant's message would bind; this one does not.

**What the middle option does not fix, and should not be sold as fixing.** It does not disambiguate two members with the same display name. That is fixed at the picker, by showing something beside the name, which is proposal (A) applied to the client.

## Options

**A1. Replace names with ids in the admin console.** Rejected. It degrades recognition on every surface to add precision on the two that lack it, and the console already identifies by email or username wherever it acts.

**A2. Show the id beside the name, following the inspect drawer.** Endorsed. The precedent is built (`frontend/packages/admin/src/components/admin/MessageInspectDrawer.tsx:59-60`), the payloads already carry the ARN on every surface except one, and the exception is a two-column change to one query.

**A3. Show the id on hover only.** Declined as the primary form. A title attribute is invisible to a reader scanning for a collision, unavailable on touch, and not copyable, and the moment an operator needs an id is the moment they are going to paste it somewhere.

**B1. Substitute identifiers into the message body, client translates back.** Rejected, for the archive, the unresolvable-id rendering, the unchanged trust boundary, the unchanged collision, and a migration that cannot reach the archive it would need to reach.

**B2. Carry the resolved ids in metadata beside the words.** Endorsed as the direction, and it is already how `@` works. The one piece worth adding is a declared addressee on a private address so the existing `Target` read can compare rather than merely count.

**C. Do nothing, on the argument that the security fix already closed the risk.** Declined, narrowly. The fix removed the self-rename, which was the attack. It did not remove the collision, which needs no attacker, and it did not give the audit record an id for `invitedBy`.

## Recommendation

1. **(A) yes, in the both-and form.** Name first, id beside it, using the shape `MessageInspectDrawer` already uses. Not ids instead of names.
2. **(A) has one missing fact rather than a missing rendering.** `adminMembershipHistory` must select the inviter's ARN, or `invitedBy` cannot be disambiguated on any surface.
3. **(A) is worth more in the composer than in the console.** A secondary line under each name in the member dropdown turns a display improvement into a routing fix, because that picker is where choosing the wrong person actually sends a private message to the wrong person.
4. **(B) no.** The body holds what the person wrote, the archive is the system of record for it, and the id the proposal wants is already available beside the body.
5. **The middle option is the answer, and for `@` it is already the design.** For `.` the gap is that the stored `Target` is checked for existence and never compared to the member the text addressed.
6. **Fix the two live defects this record found before building anything from the proposals**, because both are cheaper than either proposal and both are correctness rather than presentation: the same-name collision at the picker and at the two resolvers, and the ASCII boundary test in `tokenContinues`.

## Tenet D11, and what each proposal does to another language

**Resolving `@Name` against the roster is not a tenet D11 violation, and this is worth stating so nobody removes it on that basis.** The tenet permits matching what the platform itself wrote and forbids matching what a person or a model SAID in order to decide what happens next. The name on the roster is a value the platform stamped on the identity from a verified claim (`backend/lambda/src/lib/vend.ts:287-300`), and the token is matched against that same value. It is an identifier that happens to be legible, not a language judgement.

**(A) improves the position slightly and only in the both-and form.** An id is language-neutral, and in a column that truncates, a name in a script the operator does not read is a poor discriminator. An id alone would be worse in every language equally, which is not an improvement.

**(B) is neutral at best and negative in one specific way.** Replacing a name with an identifier removes the ASCII boundary bug described above, and that is a real point in its favor, stated because the case against (B) does not need to pretend otherwise. Against it: an unresolvable id is meaningless in every language, whereas a stale name is at least a name; and the archive would hold platform text where a person's text was, for every deployment, in every language.

**The boundary bug is fixable without (B).** `tokenContinues` is a character-class decision in one function, and the prefilter above it was already corrected for the same class of error.

## What is not yet true

- **Nothing in this record is measured against a deployment.** The collision, the `Target` comparison gap and the boundary asymmetry are all read from the resolvers.
- **The comment on `safeSpeakerName` is stale and says the opposite of what is now true.** It states that the name is self-writable because the user-pool client sets no `writeAttributes` (`backend/lambda/src/lib/transcript-attribution.ts:55-57`). That is the condition the 2026-09-16 fix removed. The escaping it justifies is still correct and must stay, because a name set by an administrator or an identity provider is still not platform text, but the reason given for it is now wrong and a reader could take the comment for a live finding.
- **Nothing counts a same-name collision.** There is no metric, no log line and no admin surface that would tell an operator two members of one conversation share a display name, so the defect above is invisible until somebody reports a private message that reached the wrong person.
- **The number of conversations and messages that would need rewriting under (B) is not known here**, because establishing it requires reading a deployment. The migration is rejected on the archive's append-only property rather than on a volume, and that argument does not depend on the number.
- **Whether a deployment exists whose identity provider asserts no `name` claim is not established.** The fallback chain that produces the collision is in the code; whether a live deployment reaches it is not read from anywhere.

## Revisit when

- **An ingress arrives that composes a message without the roster.** ADR-034 names an inbound message from another surface as out of scope and says it would be parsed into a targeted message on the sender's behalf. A sender who cannot see a picker cannot disambiguate a name, and that is the first situation where an id in the payload becomes the only workable address. It is still metadata rather than body.
- **A deployment reports a same-name collision in the wild.** That moves the picker disambiguator from a recommendation to a defect fix with a reproduction behind it.
- **The archive gains a redaction or erasure path that rewrites content.** Today it does not, and that is the load-bearing fact under the rejection of (B). If it ever does, the cost of (B)'s migration changes and this record should be re-read rather than cited.
