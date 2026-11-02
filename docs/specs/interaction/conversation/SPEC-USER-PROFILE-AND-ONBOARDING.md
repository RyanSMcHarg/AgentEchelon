# SPEC: User profile store and once-per-user onboarding

**Status:** Partial (the store, the swap seam, the once-per-user gate and the participant rule ship; identity provenance through the `Identities` index and the guest's two upgrade paths are built; the resolution model, SMS consent, and the record lifecycle are design, and the requirements table states which is which). Email preferences and unsubscribe by AppInstanceUser ship (FR26).

**Coverage:** `tests/e2e/onboarding-intake.spec.ts` - runs against a live deployment. It drives the full intake (greeting, a field per turn, confirmation, hand-off) and then asserts the PROFILE STORE rather than the transcript: the row carries `onboardedAt` and the collected `facts`. It then requires a second conversation for the same user to answer directly AND to leave `onboardedAt` byte-for-byte unchanged, which is the once-per-user contract stated as a property of the store instead of a property of what the assistant chose to say. `tests/e2e/reply-preferences.spec.ts` covers reply preferences the same way: the premium offer, a question answered while the offer stays open with nothing stored, a choice that writes `preferences.answerStyle` and `onboardedAt`, no offer in a later conversation, and the `show_preferences` and `set_preference` intents, each storage claim read from the row.

**Verified by:** `backend/test/lib/user-profile-client.test.ts` covers the client boundary: the built-in DynamoDB path, the `USER_PROFILE_SERVICE_ARN` delegation seam, and the fail-open reads that make a store outage degrade to "not yet onboarded" rather than erroring a turn.

**Related:** [SPEC-WELCOME-AND-CONTEXT.md](../assistants/SPEC-WELCOME-AND-CONTEXT.md) - the welcome and onboarding flow that consumes this. [SPEC-CHAT-APP.md](../../interface/SPEC-CHAT-APP.md) - the surface a person meets the intake on.

**Site section:** Interaction layer, conversation.

---

## Overview

**A person who has already told the platform who they are should never be asked again, and that is a property of a stored record rather than of what a model chose to say.** The onboarding intake is an opt-in first-conversation questionnaire: where a deployment supplies a schema for a classification, the assistant opens a new conversation by asking those fields and drives a short state machine across the following turns to collect the answers. The intake's own progress lives on the conversation, which cannot express "this person has already been onboarded" - so without a durable per-user record the flow re-asks a known person on every new conversation, consumes the first real turn of each one as a field answer, and leaves the answers in a history nothing carries forward.

**The gate keys on the participant, and the participant is read as a shape rather than as one id.** One human means a focused conversation with a subject to personalize for and to onboard; several humans means peers with no single subject, so onboarding is not this conversation's job; nobody yet is an alert-initiated room, which is a steady state rather than a race to wait out. That shape is written **before the channel exists**, from what the creation request already knew, which is what makes "no participant" a real answer instead of an unconverged read.

**The store is a reference stand-in, and the platform is only ever its client.** A narrow boundary - read a profile, ask whether this person has onboarded, record that they have - sits in front of either a built-in table or an implementer's own profile service selected by ARN, the same way the identity provider is pluggable. The built-in table exists so the platform runs end to end out of the box, not to prescribe where real user data lives. Every record is keyed by the person's AppInstanceUser id, whichever identity provider signed them in, because a human is one AppInstanceUser and every signal the platform handles resolves to that ARN first.

**The identity provider is the first source, and this store holds only what no issuer asserts.** An attribute a provider asserts is resolved from that provider at the point of need and is never persisted here; a failed provider lookup is a skip rather than a cue to read a stale copy. That rule is what makes this store's fail-open reads correct rather than merely convenient: failing open to "not yet onboarded" is safe because onboarding state is this store's own to own, and failing open on a display name or a clearance would not be, which is exactly why neither is sourced here.

> **"User profile" means a durable per-end-user record of what the person told the platform and what it learned about them:** whether they have been onboarded, the answers they gave, and the preferences they stated. It is deliberately not a copy of who they are according to their identity provider, and it is not the assistant capability profile of [SPEC-PER-PROFILE-OWNERSHIP.md](../assistants/SPEC-PER-PROFILE-OWNERSHIP.md). The two are unrelated; this document says "user profile" for the per-user record and "assistant profile" where it must name the capability bundle.

## Business Problem

A person who spends a minute telling an assistant their company and their role expects it to remember, and being asked the same questions at the start of their next conversation reads as a platform that was not listening - which is the opposite of what a conversational product is sold on. The business has the mirror-image problem: the answers it collects are the cheapest context it will ever get, and they are worthless if they live in one conversation's history. A business that already holds its people's profiles wants the platform to point at that store rather than to build a parallel one, because a second copy of who somebody is means two answers to every question and a second thing to keep lawful. The alternative to all of this is stitching together a profile store, an onboarding gate and a memory layer per deployment.

## Personas

Personas are defined in [PERSONAS.md](../../../overview/PERSONAS.md) and are not redefined here. The End user is the person the whole mechanism is about, and they never see it working - they only ever see it fail.

### End user

**How this relates to them:** they experience this as being remembered. Every requirement below is invisible when it holds, and each way it breaks is visible: being asked twice, having their first real question consumed as an answer to a form, or being greeted with a bare question instead of an orientation.

| What they need | Requirement |
|---|---|
| To be asked once, ever, and not again at another classification | FR1, FR2 |
| To not have their opening question consumed as a form answer | FR3, FR4 |
| A conversation that still says what it is for when an intake runs | FR5 |
| Not to be asked what the platform already knows | FR6 |
| To be called what they asked to be called, without that overriding who they verifiably are | FR12, FR13 |
| Their answers gone when they ask to be deleted | FR16 |
| To keep what they told the platform as a guest when they register, without being found by their email | FR20 |
| To choose which notices reach them, by which route, and to unsubscribe | FR26 |

### AI developer

**How this relates to them:** they write the intake schema and decide which classifications have one, and they are the ones who discover that a field they declared reads nothing. The mechanism they rely on is the one that decides whether asking is even in scope.

| What they need | Requirement |
|---|---|
| Supply an intake per classification as configuration, not as code | FR7 |
| A schema edit that reaches new conversations within the cache window rather than at the next cold start | FR7 |
| A field the profile already answers dropped rather than asked | FR6 |
| A store outage that degrades to asking again rather than erroring a turn | FR8 |
| Nested fields readable by the context reader that walks them | FR10 |

### Platform developer / implementer

**How this relates to them:** they are the audience for the boundary. Their question is whether they can point the platform at their own profile store, and whether anything in the platform quietly assumes the built-in one.

| What they need | Requirement |
|---|---|
| One narrow client boundary, swappable by ARN with no code change | FR9 |
| A key that is the AppInstanceUser id rather than a pool subject | FR11 |
| One resolver per attribute, with the owner and the forbidden sources declared | FR12 |
| To know which identity provider a given member signed in through | FR14 |
| A response from a pluggable store that cannot widen access | FR14 |
| Deletion as part of the boundary rather than a table operation | FR16 |

### Admin / operator

**How this relates to them:** they answer for what the deployment holds about people and for whether the intake is working. An intake that silently stops onboarding anyone produces no error and no complaint - only a user base that is asked twice.

| What they need | Requirement |
|---|---|
| The funnel: started, completed, and why the gate decided as it did | FR15 |
| A member-writable value never feeding a per-user decision | FR18 |
| A record that is deleted when a person is deleted | FR16 |
| To know how many identities have no provenance and cannot get one | FR14 |

## Functional Requirements and Acceptance Criteria

**Priority is a keep-or-cut decision set against what the field expects, not against how interesting the work is.** `Table stakes` means a deployment without it is behind. `Differentiator` is worth the cost because few platforms do it. `Gap - prioritize` marks a requirement whose absence puts this below comparable systems. `Above bar - optional` is more than the field asks and can wait. `Optional - attach instead` should be bought rather than built. `Enabler` is not user-visible and is what makes another row affordable.

| # | Requirement | Priority | Delivered | Validated by |
|---|---|---|---|---|
| FR1 | A person is onboarded once. The gate reads the participant shape, applies only to the one-human shape, and skips the intake for a person whose record says they are onboarded | Table stakes | Yes | `onboarding-intake` (e2e, behavior), `participant-shape` (unit, behavior), `user-profile-client` (unit, behavior) |
| FR2 | Onboarding is per user rather than per classification, so a person onboarded under one classification is answered directly at another | Table stakes | Yes | `onboarding-intake` (e2e, behavior) |
| FR3 | A shape with several humans or with nobody is not onboarded, and that is recorded as a decision rather than as a failure | Differentiator | Yes | `participant-shape` (unit, behavior) |
| FR4 | An already-onboarded person's first real turn is answered rather than intercepted as a field answer | Table stakes | Yes | `an-intake-is-advanced-only-by-its-subject` (unit, behavior), `an-intake-answer-lands-on-the-question-asked` (unit, behavior), `an-intake-asks-only-what-is-unknown` (unit, behavior) |
| FR5 | An intake adds its question to the conversation's own orientation rather than standing in place of it | Table stakes | Yes | `onboarding-intake` (unit, behavior) |
| FR6 | A field the stored profile already answers is dropped rather than asked, from the same read that answers the gate, and an intake with nothing left to ask asks nothing | Differentiator | Yes | `an-intake-asks-only-what-is-unknown` (unit, behavior) |
| FR7 | The intake schema is written by the deployer per classification, and a write, change or removal reaches new conversations within 30 seconds, the intake-config cache's time to live, rather than at the next cold start | Enabler | Yes | `onboarding-intake` (unit, behavior) |
| FR8 | A store error fails open to asking again rather than erroring the turn, a negative result is never cached, and a positive onboarding result is cached for five minutes | Table stakes | Yes | `user-profile-client` (unit, behavior) |
| FR9 | The platform depends on a narrow client boundary, not a table: an implementer points it at their own profile service by ARN with no code change | Differentiator | Yes - `userProfileService` beside the registry (`userProfileServiceArn`, `backend/lib/config/issuers.ts`) sets `USER_PROFILE_SERVICE_ARN` on each classification's router and grants it the invoke (`assistant-profile-stack.ts`), and synth refuses a value that is not a Lambda function ARN | `user-profile-client` (the `USER_PROFILE_SERVICE_ARN` swap seam), `a-claims-issuer-keeps-its-contact-copy-under-a-key` (the environment and the invoke grant), `an-issuer-declares-its-reach` (the ARN refusal) |
| FR10 | Nested fields are stored as maps rather than as serialized JSON, so the reader that walks dotted paths resolves them | Enabler | Yes | none |
| FR11 | The key is the person's AppInstanceUser id, an opaque id the credential exchange mints once and never derives from a provider's subject, so a person from any issuer, a guest and an invitee all resolve the same way | Table stakes | Partly - every read and write keys on the sender's AppInstanceUser id, taken from the sender ARN through `personIdFromArn` (`router-agent-handler.ts`), and the key attribute is `personId` (`UserProfile`, `user-profile-client.ts`). The one exchange mints the id through `mintOrResolvePerson` (`credential-exchange.ts`) for every issuer, the guest's and an invitee's included (`guest-session.ts`, `lib/invitation-redemption.ts`). **NOT VERIFIED:** no test drives a guest's or an invitee's turn through the profile read | `user-profile-client` (the record key is `personId`) |
| FR12 | One resolver answers every per-user attribute, with the owning source, the ordered fallbacks and the forbidden sources declared per attribute, including the caching rules | Gap - prioritize | No | none |
| FR13 | What a person asked to be called is a separate attribute from what their provider says they are, and copy renders only the derived addressing name | Gap - prioritize | No | none |
| FR14 | Which identity provider a person signed in through is answered by the `Identities` index, `(issuer, subject) -> AppInstanceUser ARN`, which only the credential exchange writes, at a sign-in or at a binding. This store records no provider pointer, and an AppInstanceUser with no row is unknown to every provider rather than assumed to be in the platform's own pool | Differentiator | Yes - the `Identities` index is in `Identity` (`identity-stack.ts`), written by the credential exchange (`lib/person-identity.ts`) and, for a `provisioned-only` issuer, pre-assigned as `pending` rows by the subject provisioners, which the exchange binds once; the edge authorizer reads it and never writes it | `only-the-exchange-writes-identities`, `the-edge-authorizer-reads-identities-and-never-writes-them` |
| FR15 | The flow reports intake started, intake completed, and the gate's decision with its reason | Gap - prioritize | No | none |
| FR16 | Deleting a person, by AppInstanceUser, deletes their profile record, preferences and consent through the client boundary rather than against the built-in table, and reaches a guest conversation of theirs through the tag on the account's conversation (Appendix E) | Table stakes | Partly - offboarding deletes the built-in table's record by AppInstanceUser (`backend/lambda/src/lib/offboarding.ts`, **NOT VERIFIED** on a deployment); deleting through the client boundary, for a deployment pointing at its own store, and reaching a guest conversation are **NOT BUILT** | `user-management-delete` (unit, behavior) covers the built-in table |
| FR17 | Preferences and facts are read and written against the person's AppInstanceUser, so the admin-plane AppInstanceUser, the one second principal a person holds, does not acquire a second record. It is attributed to its owner through the owner tag the credential exchange writes on it, never by parsing its id | Table stakes | No | none |
| FR18 | No member-writable value feeds the gate or any other per-user decision | Table stakes | Partly - nothing keys the gate on one, and one creation path still writes a creator copy into channel metadata that two others refuse to write | `participant-shape` (unit, behavior) |
| FR19 | The participant shape is written under a derived, collision-resistant channel ARN before the channel is created | Enabler | Partly - both paths derive the ARN from a collision-resistant id and write ahead of creation; only the spawned path's ordering is pinned by a test | `conversation-channel-id` (unit, behavior), `channel-creation` (unit, behavior), `participant-shape` (unit, behavior) |
| FR20 | A guest upgrades by the path its conversation type declares. Path A: the guest's AppInstanceUser becomes the account, so its record is the account's and nothing is re-keyed. Path B: a registration record, claimed with a single-use token by a signed-in session, seeds a new conversation for the account's AppInstanceUser, and self-asserted fields carry forward only where the account's record holds no value. Neither path merges by email, and no record links two people | Differentiator | Partly - both paths exist (Appendix E), active only on a deployment that declares a guest issuer and the `guest` and `customer` classifications. **NOT BUILT:** carrying self-asserted fields into the account's record; a path B registration's fields seed the new conversation's grounding only | `binding-a-guest-ends-the-guest-credential`, `a-claim-opens-a-tagged-customer-conversation` (unit, behavior) |
| FR21 | A field added to a schema applies to new users only, and a field never asked is distinguishable from one that was asked and declined | Above bar - optional | Partly - added fields apply to new users only, because the record carries one flag; nothing distinguishes never-asked from declined | none |
| FR22 | A stated reply preference shapes every reply in every conversation, rendered from the deployment's registry (`lib/config/reply-preferences.ts`) so no typed text reaches a prompt, and "no preference" is a choice that renders nothing | Differentiator | Yes | `reply-preferences` (unit, behavior), `reply-preferences` (e2e, behavior) |
| FR23 | An intake field may offer a preference. A message that is not itself one of the offered answers is answered by the assistant and the offer stays open; onboarding is recorded only once a value is chosen | Table stakes | Yes - the demo seed configures no offer, so the end-to-end case needs an Advisor version carrying `PREMIUM_ONBOARDING` | `reply-preferences` (unit, behavior), `reply-preferences` (e2e, behavior) |
| FR24 | Setting and listing preferences are platform intents (`set_preference`, `show_preferences`) on every assistant whose classifier is the model. The router writes the store; the assistant confirms or lists in its own voice and language, and never claims a write that failed | Table stakes | Partly - an assistant on the keyword classifier receives neither intent, though it still makes the onboarding offer | `reply-preferences` (unit, behavior), `reply-preferences` (e2e, behavior) |
| FR25 | A person onboarded before a preference was offered is not offered it again, and sets it through the intent | Above bar - optional | Partly - the intent works; nothing tells an already-onboarded person the preference exists | none |
| FR26 | Notification preferences, consent and unsubscribe are keyed by the person's AppInstanceUser ARN: per route (email, SMS), per kind of notice, with an unsubscribe that every sender honors. SMS consent is recorded there and checked before every send. A delivery address is a route found from the ARN, never a key | Table stakes | Partly - email: one `<personId>#notices` item per person in this table (`lib/notice-preferences.ts`), muted per kind or for every kind, read by every sender before it sends (`emailPeople`, `lib/channel-notify.ts`), changed from the preference page every stoppable email links to and by RFC 8058 one-click unsubscribe (`email-preferences.ts`), and erased at offboarding. A declared transactional set (invitation, claim, reply receipt) is sent whatever is muted. **NOT BUILT:** SMS consent, because no SMS sender is deployed, so every SMS send is refused; blocking one inviter's invitations | `email-preferences-and-unsubscribe` (unit, behavior), `user-management-delete` (unit, behavior), `preferences` (e2e, behavior) |

**Reading the "Validated by" column.** Each entry is one specific test, named by its filename without its extension. Backend unit tests live in `backend/test/`, with the shared-library ones under `backend/test/lib/`; end-to-end specs live in `tests/e2e/` and are listed against their phase in [e2e-coverage-matrix.md](../../../reference/e2e-coverage-matrix.md). Where `onboarding-intake` appears twice, the bracket says which it is: the end-to-end spec drives a live deployment, and the unit spec covers the intake state machine. The status in brackets is what the test does:

- **behavior** - executes the code path and asserts on the result.
- **source text** - asserts that a convention still appears in the source. It catches the convention being dropped; it does not catch a wrong number.
- **none** - no test exists, which is expected where `Delivered` is No.

**The store assertions are what make the end-to-end row evidence.** "The assistant did not re-ask" is a consequence of a persisted profile and not proof of one: a deployment whose write silently failed passes on prose whenever the model happens not to re-ask, and the person is re-interrogated as soon as the positive cache expires or the function goes cold. The spec is falsified by deleting the row before the second conversation, which trips its vacuity guard rather than passing quietly.

**Acceptance criteria.** A person completes an intake once; their record carries the completion timestamp and the collected facts; a second conversation for that person answers directly and leaves the timestamp byte-for-byte unchanged. A conversation with several humans, and one with none, are not onboarded, and each decision is recorded with its reason. An intake opens with the deployment's orientation copy and then asks its first question, and the configured greeting does not also appear. An intake whose every field the profile already answers asks nothing; an assertion that cannot be resolved is asked rather than skipped on a guess; an unrecognized assertion source is dropped from the config so a typo asks rather than silently skipping. A store outage starts the intake rather than failing the turn. The participant shape is written under the derived ARN before the channel is created. A premium person who asks a question while the answer-style offer is open is answered and the row stays unwritten; choosing a style writes it and `onboardedAt` together; a later conversation makes no offer; asking what the preferences are names the saved choice; a lasting change is written without re-stamping `onboardedAt`.

**Coverage that does not exist, stated so it is not read into the rows above.** FR12, FR13, FR15 and FR17 are covered by nothing; FR14, FR16 and FR20 have only the unit tests their rows name. Each carries its own coverage requirement: the per-attribute ownership rule needs a test that an attribute resolves from its declared owner and not from a forbidden source; the `Identities` read needs one asserting an AppInstanceUser with no row never reaches a provider lookup; and each upgrade path needs a deny-test that no second AppInstanceUser is created for a subject that already has a row and that a bound AppInstanceUser carries no expiration. The primary creation path's write of the participant shape has no unit test of its own, so FR19 is code that ships with its ordering pinned on the spawned path alone.

**OPEN:** whether orphaned context rows are swept or tolerated. A row written before a creation that then fails outlives nothing that reads it, and a stable derived key means a retry overwrites rather than accumulating, so this is a tidiness question and not a correctness one - but it should be answered rather than discovered.

**One human is one AppInstanceUser.** A person who signs in through two identity providers has two `Identities` rows pointing at one AppInstanceUser ARN, and the second row is added only by a session already pinned to that AppInstanceUser presenting the second provider's token, in one call; nothing matches the two by email. The admin-plane AppInstanceUser is the one second principal a person holds: personal attributes are read against its owner, found through its owner tag, and attribution stays on the principal that acted.

## Non-Goals - Out of Scope

| Out of scope | Why | Where it is covered instead |
|---|---|---|
| **Being the authoritative identity or account store** | The built-in table is a stand-in so the platform runs out of the box. A real deployment's user data lives in its own systems, and a platform that became a second authority would be a second thing to keep lawful and a second answer to every question | FR9, and the identity-provider guide |
| **Holding an attribute a provider asserts** | Two sources for one attribute produce disagreement nothing detects, and the fallback direction is the dangerous one: plausible stale data at exactly the moment the authoritative source was unreachable | FR12 states the rule over fields rather than over stores |
| **Approval, verification or engagement analytics** | The interface is deliberately three questions wide. A real store may model all of it; the platform requires none of it | FR9 |
| **Changing the intake state machine** | The engine stays a pure state machine. What this document changes is the trigger gate and the completion hook | FR1, FR5 |
| **A targeted re-ask when a schema grows** | Re-opening an intake on every schema edit would re-interrogate the whole user base for one added field. Asking a specific question of specific people is a different feature | FR21 |
| **Per-classification facts** | The gate is per user, so a deployment wanting different questions per classification is asking for per-classification facts, which is a different feature from the gate | FR2 |
| **Minting guest identities, and the guest's abuse controls** | The credential exchange mints every AppInstanceUser, a guest's included, and the guest start's captcha and limits belong to the routes that serve it. This store holds what a guest told the platform, keyed like anyone else's | FR20, [SPEC-CREDENTIAL-EXCHANGE.md](../governance/SPEC-CREDENTIAL-EXCHANGE.md), [SPEC-ABUSE-CONTROLS.md](../governance/SPEC-ABUSE-CONTROLS.md) |
| **A provider pointer on this record** | Which identity provider signed a person in is the `Identities` index, written by the credential exchange. A copy here would be a second answer to the same question, and this store's reads fail open | FR14 |
| **A copied creator value as a backstop for the gate** | Channel metadata is member-writable, so a copy there is rewritable by a participant and duplicates state the messaging service already owns. Keying a per-user gate on it would let a member skip their own intake or force somebody else's | FR18 |

## User Experience Description and Mocks

Nothing here has a surface of its own. What a person experiences is one of five openings, and which one they get is the whole of this document's visible effect.

### The End user's first conversation, where an intake is configured

1. **The conversation opens with the deployment's own orientation** - the access line, the example prompts, the platform note - because that copy is the opening whether or not an intake runs (FR5).
2. **The first question follows, in the same message.** The person is asked one field per turn, can leave an optional one, and is re-asked rather than advanced past a required one they left blank.
3. **A summary confirms what was collected**, and answering no restarts from the first field rather than losing what was said.
4. **The conversation hands off**, and the person is talking to their assistant with what they just said already known.

### The End user's second conversation, and every one after

1. **They ask their question and are answered.** No intake, no interception, and the same orientation as anyone else (FR1, FR2, FR4).
2. **At a different classification, the same thing happens.** The gate is per person, not per classification (FR2).

### The End user who has answered some of it already

The intake asks only what is not already known, and where the stored record answers every field it asks nothing at all and the conversation simply opens (FR6). An assertion the platform cannot resolve is asked rather than assumed, because a guess here silently loses the answer.

### A conversation that is not about one person

A room with several humans gets an opening addressed to the group and no intake - personalizing to one member would be wrong and there is no single subject to onboard. A room opened by an alert has nobody to greet at all and is oriented to the situation instead. Both are decisions, recorded as such (FR3).

### When the store cannot be read

The intake starts. Asking again is recoverable; the alternative risks never onboarding anyone, and a person who has to answer twice has lost a minute rather than a conversation (FR8).

**Mocks.** None. The rendered experience is the chat application's, and the intake is a sequence of ordinary messages in it.

## Appendix A - The client boundary and the record

The platform depends on this boundary and not on a table:

```
getUserProfile(personId): Promise<UserProfile | null>
hasOnboarded(personId): Promise<boolean>          // derived; the gate's answer
onboardingStatus(personId): Promise<{ onboarded: boolean; facts: Record<string,string>|null }>
                                                 // the gate's read: one store read, answering the gate
                                                 // and handing back the facts an intake need not ask for
markOnboarded(personId, facts): Promise<void>
```

```
interface UserProfile {
  personId: string;         // the AppInstanceUser id (partition key)
  onboardedAt?: string;     // ISO timestamp; presence == "already onboarded"
  facts?: Record<string,string>; // collected intake answers (e.g. company, role)
  updatedAt?: string;

  preferences?: {           // what the person asked for, as opposed to what a provider asserts
    answerStyle?: string;   // a registry value: brief | explained | none
    // --- design; see the appendices below and the requirements table ---
    preferredName?: string;
    language?: string;
  };

}

// FR26, as built: a SEPARATE item per person, `<personId>#notices`, so the key names its owner and an
// assistant's read of the profile item never carries it (lib/notice-preferences.ts).
interface NoticePreferencesItem {
  personId: string;                 // `<AppInstanceUser id>#notices`
  personArn: string;                // the full AppInstanceUser ARN; an item naming another person mutes nothing
  muted: Record<string, string>;    // `email:<kind>` or `email:*`, each with when it was set
  updatedAt: string;
  // --- design: SMS consent (number, wording shown, time, surface), checked before every SMS send ---
}
```

No field names an identity provider, an email address or another person. Which provider signed a person in is the `Identities` index (FR14), an address is a route found from the AppInstanceUser when a notice is sent, and a guest's upgrade writes no link between two people (Appendix E).

**Nested fields must be stored as maps, not as serialized JSON** (FR10). The context reader walks dotted paths through map attributes only. A store returning a JSON string for a nested object resolves the field as absent with no error, which is exactly how the company and role paths came to read nothing for every user.

**The key is the AppInstanceUser id, never a pool subject** (FR11). The id is opaque: the credential exchange mints it once, for a person from any issuer, a guest or an invitee, and it carries no meaning, so nothing parses it and nothing treats it as a pool subject. The attribute is `personId`.

**One person is one AppInstanceUser, and the store holds one record for them** (FR17). The admin-plane AppInstanceUser is the one second principal a person holds, created by the credential exchange and tagged with its owner's ARN. Preferences and facts are read and written against the owner, found through that tag, because they describe the person; anything attributional stays on the principal that acted, because that is the point of having two.

- **Built-in implementation:** a single DynamoDB table keyed on the identity id, no expiry, point-in-time recovery on, in the foundations stack. The router reads and writes it directly. This is the reference stand-in.
- **Swap seam:** the client selects its implementation from `USER_PROFILE_SERVICE_ARN`. Set, it invokes the implementer's function with `{ operation, params }`, where `params.personId` names the person; unset, it uses the built-in table. A deployment declares the function as `userProfileService` in `backend/deploy.config.json`, beside the trusted-issuer registry; synth validates it as a Lambda function ARN, sets `USER_PROFILE_SERVICE_ARN` on each classification's router and grants it `lambda:InvokeFunction` on that function (`backend/lib/stacks/assistant-profile-stack.ts`), with no code change.

A worked record, the same shape whichever issuer signed the person in:

```
{ personId: "<opaque AppInstanceUser id>", onboardedAt: "2026-07-02T10:14:22Z",
  facts: { company: "Acme", role: "Recruiter" },
  preferences: { preferredName: "Sam", answerStyle: "brief" } }
```

Note what is absent: no display name, no email, no clearance, no issuer. Those are provider-owned and resolved at the point of need. The name stamped at credential mint is not an exception - it records what was put on the messaging identity so a later mismatch is detectable, and it is not the answer to "what is this person's name".

## Appendix B - What belongs in this store

The boundary above says where per-user context lives. It does not say **which** per-user context belongs there, and without that rule one attribute accumulates several homes that disagree. The rule is stated over fields rather than over stores:

> **The identity provider is the first source.** An attribute an identity provider asserts is resolved from that identity's provider at the point of need and is never persisted here. This store holds only attributes no issuer asserts, plus the case where an identity has no provider at all.
>
> A failed provider lookup is a **skip**, never a cue to read a stale copy from here.

That last clause is what keeps the boundary meaningful. A store that may answer for a provider-owned attribute "when the provider is unavailable" is a second source of truth with extra steps, failing in the worst direction: quietly, with plausible stale data, at the moment the authoritative source was unreachable.

**Per-attribute ownership** (FR12). Each row names the owning source, the order in which fallbacks are tried, and the sources that must never be consulted for it.

| Attribute | Owner | Ordered fallbacks | Never consulted | May be cached |
|---|---|---|---|---|
| The name the provider says they have | Identity provider | live provider read, then the name captured at credential mint, then absent | channel metadata; a host's participant label; this store's facts | yes, on success only |
| The name they asked to be called | This store | the stated preference, then absent | the identity provider, because a provider's name is not a stated preference | yes |
| The addressing name used in copy | derived | the stated preference if set, else the provider's name | - | follows its inputs |
| Email address or phone number | Identity provider, at time of use | a live read through the `Directory` seam from the AppInstanceUser, then nothing; it is a delivery route and never a key | this store; channel metadata; any prompt | **no** |
| Clearance or entitlement | The issuer's declared clearance source, read through `ClearanceSource` | that source, then nothing: an issuer that declares none reaches only its restricted default | channel metadata; this store; the geographic segment | short lifetime only |
| Reply language, geographic segment | The conversation | channel metadata, then stated preferences, then the deployment default | each other, because a geography is not a language | per conversation |
| Onboarding state and collected facts | **This store, sole owner** | this store, then nothing | the identity provider; channel metadata; per-conversation session state | the positive onboarding result only, for five minutes |

**Caching rules follow from ownership rather than from convenience,** and two are load-bearing. A **failure is never cached**: caching "this lookup failed" for the life of a warm container converts one transient error into a persistent one for every later request that container serves, and it reads as a product defect rather than as an outage. The **onboarding result is cached positively only, and for five minutes** (`ONBOARDED_CACHE_TTL_MS` in `user-profile-client.ts`), because onboarding is monotonic: once true it stays true, so a positive cache can only ever skip a re-onboard, which is the goal, while caching the negative would keep re-asking a person who completed the intake during that container's life. The time to live is a timer, and it is named as one: it bounds how long a deleted or corrected record keeps answering from memory. The intake configuration itself is cached for 30 seconds (`INTAKE_CONFIG_TTL_MS` in `onboarding-intake.ts`), including a null result, which is the window FR7 promises.

**The split between the provider's name and the stated one is load-bearing rather than cosmetic** (FR13). Both are "the user's name", and collapsing them forces a false choice: either a name somebody typed outranks the verified identity, or a stated preference is ignored. Keeping them as separate attributes with separate owners lets both rules hold, and makes the derived addressing name the only thing copy ever renders.

**Why an attribute must not be resolvable from two places.** Three independent display names can reach one assistant turn today, with no reconciliation between them: one from the identity provider, one declared by the context-source catalog against this store, and one supplied by a host about a participant. Nothing detects that they disagree. A resolution model is therefore incomplete without the observability half (FR15): a resolver must report which source answered, and must count the case where two sources both answer with different non-empty values. An attribute resolved from an unexpected source, or resolved inconsistently, is a defect that produces no error and no complaint, only worse output.

## Appendix C - Who the gate keys on

Source comments cite this part of the document by number, so the number stays as the heading below.

### 2. Participants, and why the gate keys on them

"Created by" is three different facts, and the gate breaks if they are conflated. Naming them separately is the point.

| Fact | What it is | Where it comes from | Use it for |
|---|---|---|---|
| **Calling principal** | which principal invoked the channel creation | the Amazon Chime SDK channel's own creator field | nothing here. It is **always the assistant**, because the bot is the acting bearer on every creation path |
| **Initiator** | the person whose action caused this conversation to exist | the request that triggered creation | attribution and audit. **Never** the onboarding gate |
| **Participants** | who is in the conversation now, and how many | Amazon Chime SDK channel membership | the onboarding gate, and how personal the welcome should be |
| **Sender** | who wrote the turn being handled | the turn itself | every per-turn per-user context read |

**The gate keys on the participant, not the initiator.** The question is "has the person I am about to talk to been onboarded", and that person is a member by definition. An initiator need not be: accepting a drift suggestion makes somebody the initiator of a new conversation and also a member, so the two coincide there, which is exactly why it is tempting to record one and use it for the other; an operator escalating on somebody else's behalf is an initiator who may not be a member at all; and an alert-initiated conversation has no human initiator whatsoever, so there is no person to key on and the gate must handle that rather than resolve to something incorrect.

**The participant and the sender are different questions and must not share an answer.** The gate asks about the conversation and fires before anyone has spoken, so it has no sender. A per-turn context read asks about the person who just wrote, which is always known from the turn. Resolving a turn's display name from "the participant" would name the wrong person in any conversation with more than one member.

**Membership is the participant truth.** Amazon Chime SDK Messaging already stores who belongs to a channel and when each joined, that record is service-managed and not member-writable, so participation is read from it rather than copied into a field the platform maintains in parallel (tenet D7). Two details for those live reads, because both are easy to get wrong: the channel's own creator field resolves to the bot on every path, and reading the **sole** non-bot member is narrower than reading the **earliest** - a sole-member read returns nothing the moment a second person joins, so it silently stops resolving on any shared conversation, while the join timestamp makes the earliest human member stable as the conversation grows.

### Membership shape is the context, not a single person

| Shape | What it means | Welcome behavior |
|---|---|---|
| one human | a focused conversation; that person is the subject | personalize; onboarding is in scope |
| several humans | peers, no single subject | address the group; personalizing to one member would be wrong, and onboarding is not this conversation's job |
| none yet | alert-initiated, nobody has joined | no one to greet or onboard; orient to the situation instead |

This is a steady state and not a transient one, and that distinction is the whole reason the shape is written ahead of creation.

### The ordering, and what it buys

The welcome fires before membership converges, so a live read at that moment cannot tell "genuinely nobody" from "not yet". The platform creates the conversation, so it controls the order, and the assistant is added as part of creation itself - by the service admin immediately after the channel flow is attached, or as the acting bearer where the service-admin parameter is unset - which means there is no window after creation in which to write something the welcome will need. So the participant shape is written **before the conversation exists** (FR19):

1. Derive the channel ARN. Amazon Chime SDK channel ARNs are the app instance plus the channel id, and the caller supplies the id, so the ARN is known before creation returns.
2. Write the participant shape to the server-only store under that ARN.
3. Create the channel.

By the time anything can fire, the shape is a completed write rather than an eventually-consistent read. No retry loop, no window, and nothing to substitute a weaker source for; it also stops depending on which membership event triggers the welcome. Under the previous read-live design, a convergence miss started the intake for somebody who had already completed it - the precise defect this document exists to prevent.

Two consequences to design for rather than discover. **The channel id is load-bearing:** it keys a row written before the channel exists, so two requests generating the same id would write into one row and the loser's participant context would attach to the winner's conversation, which is a cross-user context leak arising from an id that otherwise only has to be unique enough for one creation call - which is why the id is collision-resistant on both creation paths, and why that had to be true before the ordering changed rather than after. And **a row can outlive a failed creation,** which is benign: nothing reads a context row for a channel that does not exist, and a stable derived key means a retry overwrites rather than accumulating.

A creator copy in channel metadata is not the backstop (FR18). Channel metadata is member-writable, so a copy there is rewritable by a participant and duplicates state the messaging service already owns. Both properties disqualify it for a gate, and a reader may use a legacy copy for attribution only - naming who appears to have started a conversation in an audit view - never for a per-user decision. A conversation with no pre-creation row resolves its participants from live membership, which is correct for such a conversation: its welcome fired long ago and any later read happens well after convergence.

## Appendix D - Identity provenance

"The identity provider is first source" presumes the platform knows **which** provider a member signed in through. The members of one conversation may come from different providers, so this is a per-member question, and it is answered from the member's AppInstanceUser.

**Channel membership answers who is in the conversation.** It is service-managed, not member-writable, and has no practical size limit. The participant list carried in channel metadata is not the roster: metadata is member-writable, is bounded at roughly a kilobyte, and is dropped entirely when the rest of the metadata leaves no room for it. It is a hint and must not be the authority.

**The member ARN answers who the person is, and nothing else.** The AppInstanceUser id is opaque, so its shape reveals no provider, no namespace and no kind of person; an assistant is an AppInstanceBot, a different resource.

**The `Identities` index answers which provider** (FR14). Its rows are `(issuer, subject) -> AppInstanceUser ARN`, written only by the credential exchange, at a sign-in (a guest's first message included) or at a binding (an invitation redeemed, or a path B claim), which is the one point where a verified issuer and the AppInstanceUser exist together. It is an index rather than an entity: the AppInstanceUser is authoritative, a row whose AppInstanceUser is gone resolves to nothing, and a guest has a row under the guest issuer from its first message, and a pending invitee, not yet bound to any provider, has no row until redemption binds one. A person who signs in through two providers has two rows and one AppInstanceUser.

**A provider lookup starts from the ARN.** Every attribute a provider owns is read through the `Directory` seam, which asks the issuer adapter the person's row names. No row means no provider lookup: the lookup is skipped and counted, and never falls back to the platform's own pool, which would be a category error rather than a lookup failure.

**An issuer is only ever a routing key.** It selects which provider to ask, grants nothing, and is always filtered through the deployment's registry of trusted issuers before use. That matters because this store is pluggable: a value a deployment's own profile service returns is not platform-controlled, so this store holds no issuer, and nothing read back from it can widen access. Authority continues to come from the checks in the identity and access model.

**Partial; NOT VERIFIED on a deployment.** The `Identities` index exists and the exchange mints every person's AppInstanceUser id as an opaque UUID v7 (`backend/lambda/src/lib/person-identity.ts`), so the id says nothing about the provider. Names, contacts and clearance groups are read back by person through the index's `byPerson` lookup (`Directory`, `backend/lambda/src/lib/membership-source.ts`), and federated membership resolves the host's subject through `resolvePerson` rather than deriving an id.

## Appendix E - The guest, and its upgrade

**A guest is an AppInstanceUser like any other** (FR20). The guest issuer is a registry entry whose short-lived token the platform signs, and the credential exchange mints the guest's opaque AppInstanceUser on the first message, with an AppInstanceUser expiration set so an abandoned guest lapses. The id carries no prefix and no meaning; its `Identities` row under the guest issuer, written on that first message, is what makes it a guest. The guest start's captcha, limits and kill switch belong to [SPEC-ABUSE-CONTROLS.md](../governance/SPEC-ABUSE-CONTROLS.md).

**This store is a guest's only home for what they say about themselves.** A guest has no provider that asserts a name or an address, so every attribute is self-asserted and no provider lookup is attempted: the guest issuer's `Directory` adapter answers nothing rather than failing.

**The upgrade follows the path the conversation type declares** ([SPEC-CONVERSATION-TYPES.md](./SPEC-CONVERSATION-TYPES.md) FR24). Neither path merges two people, and neither looks anyone up by email.

| | A. The guest's AppInstanceUser becomes the account | B. A registration record carries the context forward |
|---|---|---|
| What carries over | The AppInstanceUser itself. Signing in adds an `Identities` row pointing at its ARN, and in the same operation the credential exchange removes its expiration, which counts from creation and would otherwise delete the customer (**OPEN:** whether an AppInstanceUser's expiration can be removed at binding) | A registration record with its own id, written when the visitor registers: the guest's AppInstanceUser ARN, the guest conversation's channel ARN and the structured fields; the assistant's assessment of the visit is written into the new conversation's seed when the claim is redeemed. The account is a separate AppInstanceUser |
| This store | The guest's record is the account's record, so nothing is copied or re-keyed | Self-asserted fields from the record are copied onto the account's record only where it holds no value, so nothing the person stated after signing up is overwritten |
| How the account is bound | One call presenting the live guest session and the new sign-in | A single-use claim token, sent in the verification link and redeemed by a signed-in session; never by finding the record by email |
| Where the conversation goes | The guest conversation may continue, or a new conversation opens | Always a new conversation for the account, seeded from the record and tagged with the guest conversation's channel ARN; the guest conversation ends |
| The guest's AppInstanceUser | Is the person | Lapses at its expiration once the record is claimed |
| Fits | A visitor who keeps chatting in the same place, with no review step | An approval step before an account exists, an existing account, a visitor on another device, a lead in a CRM |

**No record links two people.** In path A there is one AppInstanceUser, so there is nothing to link. In path B the only relation is the resource tag between the two conversations' channels, which no member can write. History keeps the AppInstanceUser it was written under in both paths. Without a live guest session (path A) or a claim token (path B) at upgrade time, the visitor simply starts as a new person.

**The relation is personal data.** A tag from an account's conversation to a guest conversation de-anonymizes that guest session permanently, so it appears in the deployment's privacy notice, it is followed by the account's deletion path rather than orphaned (FR16), and it is visible to the operator surfaces that inspect a conversation.

**Active only on a deployment that declares a `guest` entry in `issuers`:** the guest issuer. A deployment that declares none synthesizes none of its resources. Guest start mints a guest AppInstanceUser through the one minter, with an expiration, an `Identities` row under the guest issuer and the privacy-notice version recorded ([GUEST-ISSUER](../../../guides/admin/GUEST-ISSUER.md)). **Active only where the guest issuer is declared:** both upgrade paths. Path A binds the guest AppInstanceUser to a first sign-in that presents the live guest session, removing its expiration and ending the guest credential in one transaction; path B writes a registration record and a single-use claim token, and a signed-in account's claim opens a `customer-engagement` conversation tagged with the visitor's ([GUEST-ISSUER](../../../guides/admin/GUEST-ISSUER.md#becoming-a-person)). Neither path asks the visitor to opt in: path A binds on the first sign-in from the widget, and path B emails the sign-in link that carries the claim, which the chat app redeems once the person signs in from it; a deployment may declare that a registration waits for an operator's approval first (`guest.registration.approval`). The carried-over conversation is seeded with the visitor's assistant's assessment of the visit, and the visitor's conversation is then deleted ([SPEC-CONVERSATION-TYPES](SPEC-CONVERSATION-TYPES.md) FR26).

## Appendix F - Record lifecycle

Two lifecycle questions the gate raises and does not answer on its own.

**A schema that grows does not re-ask** (FR21). The onboarding flag is a single value, so a person onboarded before a deployment added a field is never asked the new question: they are onboarded, and the gate is per user rather than per field. That is the correct default, because re-opening an intake on every schema edit would re-interrogate the entire user base for one added field. The consequence to accept explicitly is that added fields apply to new users only, and a deployment that needs an existing answer from everybody is asking for a targeted re-ask, which is a different feature. What this document does require is that the absence of a field is distinguishable from a field that was asked and skipped, so a later feature can tell "never asked" from "declined".

**Deletion must reach this record** (FR16). Deleting a person runs by their AppInstanceUser and deletes their record, including the collected facts, the stated preferences, consent and unsubscribe state (the `<personId>#notices` item is erased by offboarding, `noticePreferences` in `OFFBOARDED_STORES`), and follows the tag from the account's conversation to a guest conversation of theirs (Appendix E). The `Identities` rows are removed by offboarding, which runs by AppInstanceUser over every store, not by this boundary. Because the store is pluggable, deletion is part of the client boundary rather than an operation performed against the built-in table: a deployment pointing at its own store owns the deletion, and the platform's obligation is to call it.

## Appendix G - Test impact

A per-user gate is what keeps the intake from colliding with every other suite that opens a conversation at a classification where onboarding is enabled. The onboarding suite completes the intake once for its own user; other suites resolve an already-onboarded profile and are answered directly instead of having their first turn consumed as a field answer.

Two properties make that reliable rather than order-dependent, and both are asserted. The onboarding suite completes the intake and then requires a second conversation for the same user to leave the onboarding timestamp unchanged, which states the once-per-user contract as a property of the store rather than of what the assistant chose to say. And suites that need an already-onboarded user arrange that precondition rather than depending on the onboarding suite having run first, so any suite can run alone.

## Related Documents

- [SPEC-WELCOME-AND-CONTEXT.md](../assistants/SPEC-WELCOME-AND-CONTEXT.md) - the welcome this gate sits inside, and the context sources a profile field is declared against
- [PERSONAS.md](../../../overview/PERSONAS.md) - the canonical definitions of the personas above
- [SPEC-CHAT-APP.md](../../interface/SPEC-CHAT-APP.md) - the surface the intake is experienced on
- [SPEC-CONVERSATION-TYPES.md](./SPEC-CONVERSATION-TYPES.md) - the type whose welcome configuration consumes the participant shape
- [SPEC-CREDENTIAL-EXCHANGE.md](../governance/SPEC-CREDENTIAL-EXCHANGE.md) - the only minter of an AppInstanceUser, and the only writer of the `Identities` index
- [SPEC-FEDERATED-PARTICIPANTS.md](../governance/SPEC-FEDERATED-PARTICIPANTS.md) - a person from another issuer, resolved the same way as any other
- [IDENTITY-AND-ACCESS-MODEL.md](../governance/IDENTITY-AND-ACCESS-MODEL.md) - where authority comes from, which is never this store
- [SPEC-PER-PROFILE-OWNERSHIP.md](../assistants/SPEC-PER-PROFILE-OWNERSHIP.md) - the assistant capability profile, which this record is unrelated to
