# SPEC: User profile store and once-per-user onboarding

**Status:** Partial (the store, the swap seam and the once-per-user gate ship; the resolution model and identity provenance sections below are design).

**Coverage:** `tests/e2e/onboarding-intake.spec.ts` - runs against a live deployment. It drives the full intake (greeting, a field per turn, confirmation, hand-off) and then asserts the PROFILE STORE rather than the transcript: the row carries `onboardedAt` and the collected `facts`. It then requires a second conversation for the same user to answer directly AND to leave `onboardedAt` byte-for-byte unchanged, which is the once-per-user contract stated as a property of the store instead of a property of what the assistant chose to say.

**Verified by:** `backend/test/lib/user-profile-client.test.ts` covers the client boundary: the built-in DynamoDB path, the `USER_PROFILE_SERVICE_ARN` delegation seam, and the fail-open reads that make a store outage degrade to "not yet onboarded" rather than erroring a turn.

The design sections (§1a, §2, §2a, §4, §5) are not covered by either of the above and must not be read as though they were. Each carries its own coverage requirement, stated with its checklist item: the per-attribute ownership rule needs a test that an attribute resolves from its declared owner and not from a forbidden source; the ordering in §2 needs a test that the context row exists before the channel does; and the provenance pointer needs one asserting a derived identity never reaches a provider lookup.

The store assertions are what make it evidence. "The assistant did not re-ask" is a CONSEQUENCE of a persisted profile, not proof of one: a deployment whose write silently failed passes on prose whenever the model happens not to re-ask, and the next cold Lambda re-interrogates the user (the onboarded cache is warm-life only). Falsified by deleting the row before the second test, which trips the vacuity guard rather than passing quietly.

**Problem and who it's for:** A person who was already onboarded should never be re-interrogated on their next conversation - the assistant should remember what they told it rather than re-asking - and a business should be able to point that memory at its own user store instead of rebuilding profile-and-onboarding plumbing. This is for the end user (remembered, not re-onboarded) and the AI developer / platform implementer, who plugs in their own user-profile store by ARN the same way the identity provider is pluggable; the alternative is stitching together your own profile store, onboarding gate, and memory layer. It defines a narrow user-profile client boundary, a rule for which per-user context belongs in that store at all, and a once-per-user onboarding gate, with a built-in DynamoDB store as the reference stand-in the platform is merely a client of.

**Site section:** Interaction layer, Assistant Configuration pillar (core plane). Consumed by the welcome / onboarding flow in `SPEC-WELCOME-AND-CONTEXT.md`.

> "User profile" here means a durable per-END-USER record of what the person told the platform and what it learned about them: whether they have been onboarded, the answers they gave, and the preferences they stated. It is deliberately NOT a copy of who they are according to their identity provider (see §1a). It is NOT the assistant capability-"profile" of SPEC-PER-PROFILE-OWNERSHIP. The two are unrelated; this document uses "user profile" strictly for the per-user record and "assistant profile" when it must refer to the capability bundle. AgentEchelon ships a minimal built-in user profile store. It is a **reference stand-in for an OSS implementer's own profile store**, not a system of record. A real deployment plugs in its own store behind the client boundary defined below, the same way the identity provider is pluggable (IDENTITY-PROVIDER-GUIDE.md): the router is a *client* of a profile store it does not own, reaching an externally owned profile service by ARN when one is configured. The built-in store exists so the platform runs end to end out of the box, not to prescribe where real user data lives.

## Problem

Onboarding intake (SPEC / `lib/onboarding-intake.ts`) is an opt-in first-conversation questionnaire. When a deployment supplies an intake schema for a classification, the assistant opens a new conversation by asking the schema's fields instead of the static welcome, then drives a short FSM across the next turns to collect the answers.

The intake's own progress rides in Lex `sessionAttributes`, which is **per conversation**. Per-conversation
state alone cannot express "this person has already been onboarded", and without that the flow fails three
ways:

- Onboarding fires on **every** new conversation for that classification, re-asking a user who already answered. Re-onboarding a known user is a context bug: the platform is meant to remember the person, not interrogate them again.
- The first real user turn of every new conversation is consumed as a field answer, which collides with any flow that expects "open a conversation, ask a question, get a direct answer".
- The answers land only in that conversation's history. Nothing carries the collected company and role forward to the user's next conversation.

The behavior this defines is **once per user**: onboard a person the first time, remember that they were
onboarded and what they said, and never re-onboard them. That requires two things the intake FSM cannot
supply on its own, both addressed below: durable per-user state (§1), and a participant identity the gate
can key on at welcome time (§2).

## Design

### 1. User profile store (pluggable stand-in)

Define a narrow client boundary the router depends on, not a concrete table:

```
getUserProfile(userSub): Promise<UserProfile | null>
hasOnboarded(userSub): Promise<boolean>          // derived; the gate's read
markOnboarded(userSub, facts): Promise<void>
```

```
interface UserProfile {
  userSub: string;          // the AppInstanceUser id (partition key) - see the note below
  onboardedAt?: string;     // ISO timestamp; presence == "already onboarded"
  facts?: Record<string,string>; // collected intake answers (e.g. company, role)
  updatedAt?: string;

  // --- design, not built (see the sections below) ---
  preferences?: {           // what the person asked for, as opposed to what a provider asserts
    preferredName?: string;
    language?: string;
  };
  identity?: IdentityPointer;   // which provider this identity belongs to (§2a)
  linkedFrom?: string[];        // prior identities whose context may carry forward (§4)
  linkedTo?: string;            // write-once, on a no-provider record only (§4)
}
```

**Nested fields must be stored as maps, not as serialized JSON.** The context-source reader walks dotted
paths (`preferences.preferredName`) through map attributes only. A store that returns a JSON string for
`preferences` resolves the field as absent, with no error, which is exactly how the `facts.company` and
`facts.role` paths came to read nothing for every user.

**The key is the AppInstanceUser id, not "the Cognito sub".** For a native user the two are the same
value, which is why the distinction is easy to lose. They are not the same for every identity: a
federated participant's id is `fed_<40hex>` (a derived value that is not a username in any user pool),
an operator's admin identity is `${sub}-admin`, and a guest id would be `guest_<32hex>`. Treating the key
as a Cognito sub is what produces lookups that silently return nothing for those identities, because the
id is well-formed, the read succeeds, and there is simply no row.

**One person can hold more than one identity, and the store must not split them.** An operator has a chat
identity and a separate admin identity, so keying blindly on whichever id is in hand gives them two profile
rows: they can be onboarded twice, and their stated preferences apply in one plane but not the other. The
rule is that **`preferences` and `facts` are read and written against the base identity** an elevated
identity belongs to, because they describe the *person*. Anything attributional stays on the identity that
acted, because that is the point of having two.

The same asymmetry decides the guest case in §4: preferences and facts carry across the link, attribution
does not.

- **Built-in implementation:** a single DynamoDB table `UserProfileTable` (pk `userSub`, no TTL, PITR on) in the foundations stack. The router reads/writes it directly. This is the reference stand-in.
- **Swap seam:** the router selects the implementation from an env var (`USER_PROFILE_SERVICE_ARN`). When set, the client invokes the implementer's Lambda instead of the built-in table; when unset, it uses the built-in table. An implementer therefore points AgentEchelon at their existing profile store without a code change, and the built-in table is purely the default.

The interface is deliberately narrow: read a profile, ask whether the person has onboarded, record that
they have. The stand-in does not model account requests, approval workflow, verification, or engagement
analytics; a real store may, but the platform does not require it. The design sections below add to this
surface, so the count is not the contract; the ownership rule in §1a is.

A worked record, spanning a native and a federated participant, so the key distinction is concrete:

```
// native user: the AppInstanceUser id and the pool subject are the same value
{ userSub: "8f3c...-a1",  onboardedAt: "2026-07-02T10:14:22Z",
  facts: { company: "Acme", role: "Recruiter" },
  preferences: { preferredName: "Sam" },
  identity: { iss: "<the deployment's own pool>", provider: "platform-pool",
              firstSeenAt: "2026-07-02T10:12:01Z", lastSeenAt: "2026-08-03T08:31:44Z" } }

// federated participant: the id is derived and is NOT a username in any pool
{ userSub: "fed_9a2f...", onboardedAt: "2026-07-19T14:02:10Z",
  facts: { company: "Northwind" },
  identity: { iss: "<the host's issuer>", provider: "external-issuer",
              nameAtMint: "Dana Okafor",
              firstSeenAt: "2026-07-19T13:58:44Z", lastSeenAt: "2026-07-31T21:05:12Z" } }
```

Note what is *absent* from both: no display name, no email, no clearance. Those are provider-owned and are
resolved at the point of need, per §1a. `nameAtMint` is not an exception; it records what was stamped on
the messaging identity so a later mismatch is detectable, and it is not the answer to "what is this
person's name".

### 1a. What belongs in this store (design)

The store above says where per-user context lives. It does not say **which** per-user context belongs
there, and without that rule the same attribute accumulates several homes that disagree. The rule is
stated over fields, not over stores:

> **The identity provider is the first source.** An attribute an identity provider asserts is resolved
> from that identity's provider at the point of need, and is never persisted here. This store holds only
> attributes that no issuer asserts, plus the case where an identity has no provider at all.
>
> A failed provider lookup is a **skip**, never a cue to read a stale copy from here.

That last clause is what keeps the boundary meaningful. A store that may answer for a provider-owned
attribute "when the provider is unavailable" is a second source of truth with extra steps, and it fails in
the worst direction: quietly, with plausible stale data, at exactly the moment the authoritative source
was unreachable.

It is also what makes this store's fail-open reads **correct** rather than merely convenient. Failing open
to "not yet onboarded" is safe because onboarding state is the store's own to own. Failing open on a
display name or a clearance would not be, which is why neither is sourced here.

**Per-attribute ownership.** Each row names the owning source, the order in which fallbacks are tried, and
the sources that must never be consulted for it.

| Attribute | Owner | Ordered fallbacks | Never consulted | May be cached |
|---|---|---|---|---|
| `displayName` (who the provider says they are) | Identity provider | live provider read, then the name captured at credential-mint, then absent | channel metadata; a host's participant label; this store's `facts` | yes, on success only |
| `preferredName` (what they asked to be called) | This store | `preferences.preferredName`, then absent | the identity provider (a provider's name is not a stated preference) | yes |
| the addressing name used in copy | derived | `preferredName` if set, else `displayName` | - | follows its inputs |
| `email` | Identity provider, at time of use | live provider read, then nothing | this store; channel metadata; any prompt | **no** |
| clearance / entitlement | Identity provider groups | provider groups for a native identity, then the channel's classification for a federated participant, then the fail-closed floor | channel metadata; this store; the geographic segment | short TTL only |
| reply language, geographic segment | The conversation | channel metadata, then `preferences`, then the deployment default | each other (a geography is not a language) | per conversation |
| `onboardedAt`, `facts` | **This store, sole owner** | this store, then nothing | the identity provider; channel metadata; per-conversation session state | `onboardedAt` positive only |

**Caching rules follow from ownership, not from convenience.** Two of these are load-bearing:

- A **failure is never cached for long.** Caching "this lookup failed" for the life of a warm container
  converts one transient error into a persistent one for every later request that container serves, and it
  reads as a product defect rather than an outage. A negative result gets seconds, not a container
  lifetime.
- `onboardedAt` may be cached **positively only**, because onboarding is monotonic: once true it stays
  true, so a positive cache can only ever skip a re-onboard, which is the goal. Caching the negative would
  keep re-asking a user who completed the intake during that container's life.

The split between `displayName` and `preferredName` is load-bearing rather than cosmetic. Both are "the
user's name", and collapsing them forces a false choice: either a name the user typed outranks the
verified identity, or a stated preference is ignored. Keeping them as separate attributes with separate
owners lets "the provider is first source" and "the intake asked what to call me" both hold, and makes the
derived addressing name the only thing copy ever renders.

**Why an attribute must not be resolvable from two places.** Three independent display names can reach one
assistant turn today, with no reconciliation between them: one from the identity provider, one declared by
the context-source catalog against this store, and one supplied by a host about a participant. Nothing
detects that they disagree. A resolution model is therefore incomplete without the observability half: a
resolver must report which source answered, and must count the case where two sources both answer with
different non-empty values. An attribute resolved from an unexpected source, or resolved inconsistently, is
a defect that produces no error and no complaint, only worse output.

### 2. Who the gate keys on (membership is the source)

"Created by" is three different facts, and the once-per-user gate breaks if they are conflated. Naming them
separately is the point of this section.

| Fact | What it is | Where it comes from | Use it for |
|---|---|---|---|
| **Calling principal** | which principal invoked `CreateChannel` | Amazon Chime SDK `Channel.CreatedBy` | nothing here. It is **always the assistant**, because the bot is the acting bearer on every creation path |
| **Initiator** | the person whose action caused this conversation to exist | the request that triggered creation | attribution and audit. **Never** the onboarding gate |
| **Participants** | who is in the conversation now, and how many | Amazon Chime SDK channel membership | the onboarding gate, and how personal the welcome should be |
| **Sender** | who wrote the turn being handled | `CHIME.sender.arn` on the turn | every per-turn per-user context read |

**The gate keys on the participant, not the initiator.** The question the gate asks is "has the person I am
about to talk to been onboarded", and that person is a member by definition. An initiator need not be:

- Accepting a drift suggestion makes someone the **initiator** of the new conversation. In that flow they
  are also added as a member, so a membership read resolves them. The two facts coincide there, which is
  exactly why it is tempting to record one and use it for the other. Resolving the participant from
  membership means they never have to be conflated.
- An operator escalating on someone else's behalf is an initiator who may not be a member at all. Keying a
  per-user gate on them would read the wrong person's onboarding state.
- An **alert-initiated** conversation has no human initiator whatsoever (the assistant acts as bot bearer,
  with no human request behind it). There is no person to key on, and the gate must handle that rather than
  resolve to something incorrect.

**The participant and the sender are different questions, and must not share an answer.** The gate asks a
question about the conversation ("is there one person here, and have they been onboarded"), which has no
sender because the welcome fires before anyone has spoken. A per-turn context read asks about the person who
just wrote, which is always known from the turn itself. Resolving a turn's display name from "the
participant" would name the wrong person in any conversation with more than one member.

**Membership is the participant truth.** Amazon Chime SDK Messaging already stores who belongs to a channel
and when each member joined. That record is service-managed and not member-writable, so participation is
**read** from it rather than copied into a field the platform maintains in parallel. The one exception is the
welcome, which fires before membership converges; §2's ordering handles that by recording the shape the
creation request already knew, ahead of creation, rather than by reading a store that has not settled.

Two details for those later live reads, because both are easy to get wrong:

- **`Channel.CreatedBy` is the assistant, not the person.** The bot creates the channel as the acting
  bearer, so Amazon Chime SDK's own creator field resolves to the bot ARN for every conversation on every path. It
  answers "which principal called `CreateChannel`", which is not a question about the user.
- **Reading the *sole* non-bot member is narrower than reading the *earliest*.** A sole-member read returns
  nothing as soon as a second person joins, so it silently stops resolving on any shared conversation. The
  membership record carries a join timestamp per member, so the earliest human member is available and
  stays stable as the conversation grows.

**A copied `createdBy` in channel metadata is not the backstop.** Channel metadata is member-writable (a
participant holds `UpdateChannel`, which sets Name and Metadata in one call), so a copy there is
rewritable by a participant, and it duplicates state the messaging service already owns. Both properties
disqualify it for a gate: the once-per-user check would key on a value another member can change, letting
them skip their own intake or force someone else's. Two of the three conversation-creation paths already
refuse to write it for this reason.

**The copy was reached for because of timing, and the ordering removes the timing problem.** A copy looks
necessary only if the context has to be *read back* during the creation sequence. It does not. The
conversation is created by the platform, so the platform controls the order, and the assistant is added
**by creation itself** (it is the acting bearer). There is therefore no window after creation in which to
write something the welcome will need.

So the participant context is written **before the conversation exists**:

1. Derive the channel ARN. Amazon Chime SDK channel ARNs are `{appInstance}/channel/{channelId}` and the caller
   supplies `channelId`, so the ARN is known before `CreateChannel` returns. Both creation paths already
   generate their own channel id, and the federated path already derives the ARN this way.
2. Write the participant context to the server-only store under that ARN.
3. Create the channel.

By the time anything can fire, the context is a completed write rather than an eventually-consistent read.
No retry loop, no window, and nothing to substitute a weaker source for. It also stops depending on *which*
membership event triggers the welcome: the assistant's automatic membership at creation and any later
explicit membership call both happen after the write, so the design holds either way rather than resting on
that detail staying true.

Two consequences to design for rather than discover:

- **The channel id becomes load-bearing.** It is now the key of a row written before the channel exists, so
  two requests generating the same id would write into one row before either channel is created, and the
  loser's participant context would attach to the winner's conversation. That is a cross-user context leak
  arising from an id that today only has to be unique enough for one `CreateChannel` call. The id must be
  collision-resistant before the ordering changes, not after.
- **A row can outlive a failed creation.** This is benign, because nothing reads a context row for a
  channel that does not exist, and it is self-correcting on retry: a stable derived key means a retry
  overwrites rather than accumulating. Whether orphans are swept or simply tolerated should be stated, but
  it is not a correctness problem.

**Live membership is the source for every later read.** A recap when someone joins, or any per-turn context,
reads membership directly, where it has long since settled. The pre-creation write exists only to serve the
one moment that precedes convergence.

#### Membership shape is the context, not a single person

Reducing membership to "the participant" is wrong for most conversation types. What the welcome needs is the
**shape**, because that is what decides how personal to be and whether onboarding is even in scope:

| Shape | What it means | Welcome behaviour |
|---|---|---|
| one human | a focused conversation; that person is the subject | personalize; onboarding is in scope |
| several humans | peers, no single subject | address the group; personalizing to one member would be wrong, and onboarding is not this conversation's job |
| none yet | alert-initiated, nobody has joined | no one to greet or onboard; orient to the situation instead |

This is a steady state, not a transient one. An alert-initiated conversation legitimately has no human
member, so "no participant" is an answer the welcome must handle correctly rather than a race it should wait
out.

The conversation type's welcome configuration consumes this shape. A focused onboarding conversation and an
incident room with nobody in it yet are then the same mechanism with different declared context, not two
code paths.

> **State of this section: DESIGN.** The rule above is the target, not what ships. Today
> `create-conversation` writes a `createdBy` copy into channel metadata and the router reads it *before*
> membership, while the two other creation paths refuse to write it. The work to close that is listed in the
> design checklist.
>
> **Migration.** New conversations should not write the copy. Conversations created before this rule carry
> one, and a reader may use it **for attribution only**: naming who appears to have started a conversation
> in an audit view. It must never feed the once-per-user gate or any other per-user decision, because it is
> member-rewritable and that is precisely the substitution this section rules out.
>
> Legacy conversations also have no pre-creation context row, so their welcome resolves participants from
> live membership as before. That is correct for them: their welcome already fired long ago, and any later
> read happens well after convergence.

### 2a. Identity provenance: which provider a member belongs to (design)

"The identity provider is first source" presumes the platform knows **which** provider a given member
belongs to. The members of one conversation may come from different providers, so this is a per-member
question, not a per-deployment one.

**Channel membership answers who is in the conversation.** Amazon Chime SDK Messaging membership is
managed by the service, is not member-writable, and has no practical size limit. It is the roster. The
participant list carried in channel `Metadata` is not: channel metadata is member-writable (a participant
holds `UpdateChannel`, which sets Name and Metadata in one call), is bounded at roughly one kilobyte, and
is dropped entirely when the rest of the metadata does not leave room for it. It is usable as a hint and
must not be the authority.

**The member ARN answers what kind of identity it is,** by the shape of the id after `/user/`: a native
user, a federated participant, an operator's admin identity, the service admin, or a reserved guest shape.
For a native identity, the kind settles the provider, because a native id is a username in the platform's
own pool.

**The ARN does not reveal which provider a federated participant belongs to.** A federated id is a
truncated one-way hash of the issuer and the subject together, so every federated participant from every
issuer shares one prefix and the issuer cannot be recovered from the id. That is a deliberate property: it
is what keeps a foreign subject from colliding with a native one. The consequence is that provenance
cannot be derived later. It has to be **recorded at the moment it is verified**, which is credential
exchange, the one point where the issuer and the derived id exist together.

Writing it at exchange time has a cost worth naming: the credential exchange is the highest-availability
path in the system, and it does not otherwise touch this store. So the write is **strictly best-effort and
off the critical path**. It must not block a credential vend, must not add latency to one, and a failure is
counted rather than propagated. A vend that succeeds with no pointer recorded is acceptable; a vend that
fails because a profile write failed is not.

There is also a population that can never be backfilled. Provenance is unrecoverable from an existing
`fed_` id, because the derivation is one-way, so identities provisioned before this pointer exists stay
provider-unknown until that person's next exchange. That is a consequence of a derivation that is itself
correct, not a defect to engineer around, and the size of that population should be measured rather than
assumed.

Provenance therefore lives on this record, as a server-owned block written at exchange time:

```
interface IdentityPointer {
  iss: string;           // the verified issuer, from validated token claims - never from user input
  provider: string;      // which kind of provider (the platform's own pool, a second pool, an
                         //   external OIDC issuer, or none)
  poolId?: string;       // evaluated when the pointer is written, so a later change in issuer
                         //   format cannot silently break resolution
  nameAtMint?: string;   // the name stamped on the messaging identity, for conflict detection
  firstSeenAt: string;   // set once
  lastSeenAt: string;
}
```

Keeping it here rather than in a second table follows the same rule as the rest of this document: one
place to look for per-user data. The trade-off is deliberate and worth stating, because this store's reads
fail open while a routing key wants to fail closed. It is resolved by what the resolver does with a
**missing** pointer, not by adding a store: an absent pointer means "provider unknown", and provider
unknown means the lookup is skipped and counted. It never means "assume the platform's own pool", which is
the current behaviour and is a category error rather than a lookup failure.

**A stored issuer is only ever a routing key.** It selects which provider to ask; it never grants
anything, and it is always filtered through the deployment's allow-list of trusted providers before use.
This matters specifically because the store is pluggable: when a deployment points the platform at its own
profile service, that service's response is not platform-controlled, so a value read back from it must not
be able to widen access. Authority continues to come from the checks described in the identity and access
model, never from this pointer.

**A pointer can be wrong as well as absent.** A person can move between providers, and a stored pointer
then names a provider that no longer asserts anything about them. Absence is handled above; staleness needs
its own answer:

- Re-verify on every credential exchange, which is the only moment a verified issuer is in hand. Refresh
  `lastSeenAt`, and refresh `iss` when the verified value differs from the stored one.
- When the verified issuer differs from the stored pointer, that is a **conflict to count**, not a silent
  overwrite. A pointer that changes repeatedly for one identity means either a genuine migration or a store
  returning inconsistent data, and the two need to be distinguishable.
- Because a pluggable store owns its own responses, the same applies to the link fields of §4: the
  platform enforces the write-once fan-in guard against what the store returns rather than trusting the
  store to have enforced it. A store that reports a different prior identity on successive reads is a
  defect, and treating its answer as authoritative would let it attach one person's context to another.

### 3. Once-per-user gate

**Every classification is in scope.** Onboarding is per-classification configuration: supplying an intake
schema for a classification enables it there, and absent a schema the path is inert and the classification
serves its normal welcome. Nothing in the mechanism is specific to one classification, and a deployment may
enable it for all of them, some, or none. A deployment that enables it for only one classification is a
configuration choice, not the platform's shape, so a reader should not infer the limit from whatever a
given deployment happens to seed.

Because the gate is per **user** and not per classification, a person onboarded through one
classification's intake is onboarded, full stop: opening a conversation at a different classification does
not re-ask them. If a deployment wants different questions per classification it is asking for
per-classification *facts*, which is a different feature from the once-per-user gate and is not defined
here.

- **On `WelcomeIntent`:** read the membership shape from the pre-creation context (§2). Onboarding applies
  only to the one-human shape. If that person's `onboardedAt` is set, skip the intake and render the normal
  welcome; otherwise start the intake.
- **On a shape with several humans or none:** do not onboard. There is either no single subject or no person
  at all, so the question does not arise. This is a decision, not a failure, and is recorded as such.
- **On intake completion:** record the flag and the collected facts, so both persist for every future
  conversation.
- **Fail open on a store error:** start the intake rather than erroring the turn. A store outage degrades to
  asking again, which is recoverable; the alternative risks never onboarding anyone.

Note what the §2 ordering buys here: because the context is written before the conversation exists, "no
participant resolved" is no longer a transient state the gate has to fail open through. An unresolved
participant now means the shape genuinely has no single human, which is a real answer. Under the previous
read-membership-live design, a convergence miss would have started the intake for a user who had already
completed it, re-onboarding them, which is the precise bug this document exists to prevent.

**What is measured.** The gate is easy to get wrong in a way that produces no error, so the flow reports:
intake started, intake completed, and the gate's decision with the reason it decided that way (already
onboarded, not onboarded, or participant unresolved). Started-minus-completed is the abandonment signal a
deployment needs to tell "the intake is too long" from "the intake is broken", and the unresolved count is
what would have surfaced a participant-resolution regression before users noticed being asked twice.

### 4. Identities with no provider, and the guest transition (design; accommodated, not built)

AgentEchelon mints no guest identities. The shape `guest_<32hex>` is reserved so the resolution rule above
is total, and so that a deployment adding a guest surface does not have to reinterpret it. A guest surface
carries its own abuse-control concerns (anonymous credential vending, per-address rate limits, a challenge)
that this document does not address.

For an identity with no provider, every attribute is self-asserted and this store is its only home. No
provider lookup is attempted, rather than attempted and failed: a guest id must never reach a provider
admin API, because it is not a username in any pool and the attempt cannot succeed.

**Guest to authenticated is a link, never a merge.** When a person who was using a guest identity creates
an account, they end up with two identities, and the earlier one is not renamed, aliased, or reused:

- Messaging identity ids are immutable, so there is no rename available even in principle.
- The guest and authenticated namespaces are deliberately disjoint, which is what makes bearer pinning
  safe. Reusing a server-minted, previously unauthenticated id as an authenticated identity would put it
  inside the resource scoping that pins a caller to their own identity.
- Two independently attributable identities are what an audit trail needs. A merge destroys the record of
  which actions were taken before the person authenticated.

The link is therefore a one-way edge recorded server-side, with the direction chosen for the question it
answers:

- `linkedFrom` on the **authenticated** record lists the prior identities whose self-asserted context may
  be carried forward. That is the only question the promotion flow asks.
- `linkedTo` on the **guest** record is **write-once**, and is the fan-in guard: a guest identity may be
  claimed by at most one authenticated identity, so a shared or leaked guest id cannot seed context into
  several accounts.

The edge must be established from proof verified in the same request, never from a client-supplied prior
id. A supplied identifier that becomes an identity is the exact failure the disjoint-namespace rule exists
to prevent.

Both halves are idempotent: adding the same edge repeatedly is one edge, and the context carry-over copies
field by field only where the authenticated record does not already hold a value, so it can never overwrite
something the person stated after signing up. What carries is self-asserted context. What does not carry is
conversation membership, message history, or credentials; the earlier conversation is left to its own
retention.

**The link itself is personal data.** A durable edge from an anonymous session to a named account
de-anonymises that session permanently, so it carries obligations the carried-over fields do not:

- It must appear in the deployment's privacy notice, alongside the rest of what the profile store holds. A
  deployment adding a guest surface owns that disclosure; the platform's obligation is to make the field
  visible and documented rather than incidental.
- It must be removed by the account's deletion path, not merely orphaned. Deleting the authenticated record
  while leaving a guest record that names it inverts the intent, because the guest record then still points
  at a person who asked to be forgotten.
- It should be visible to the operator surfaces that already inspect a profile, so its presence is auditable
  rather than only inferable from behaviour.

### 5. Record lifecycle (design)

Two lifecycle questions the once-per-user gate raises and does not answer on its own.

**A schema that grows does not re-ask.** `onboardedAt` is a single flag, so a person onboarded before a
deployment added an intake field is never asked the new question: they are onboarded, and the gate is
per-user rather than per-field. That is the correct default, because re-opening an intake on every schema
edit would re-interrogate the entire user base for one added field. The consequence to accept explicitly is
that added fields apply to new users only, and a deployment that needs an existing answer from everyone is
asking for a **targeted re-ask**, which is a different feature from the gate and is not defined here. What
this document does require is that the absence of a field is distinguishable from a field that was asked and
skipped, so a later feature can tell "never asked" from "declined".

**Deletion must reach this record, and today it does not.** User deletion removes channel memberships, the
messaging identity, and the provider account. It does **not** delete the profile row, so a deleted person's
onboarding answers survive their deletion. That is a gap in the shipped path, not only in this design, and it
is the same record §4 places disclosure obligations on:

- Deleting a person deletes their profile row, including `facts`, `preferences`, and the `identity` pointer.
- It also clears any link that names them, in both directions. Removing an authenticated record while a
  no-provider record still points at it inverts the intent of the deletion.
- Because the store is pluggable, deletion is part of the client boundary rather than an operation performed
  directly against the built-in table. A deployment pointing at its own store owns the deletion, and the
  platform's obligation is to call it.

## Non-goals

- Not the authoritative identity or account store. The built-in table is a demo stand-in; real deployments own their user data elsewhere.
- No approval/verification/guest lifecycle (that is the implementer's store's concern).
- No change to the intake FSM engine (`onboarding-intake.ts` stays the pure state machine); only the trigger gate and completion hook change.

## Test impact

A per-user gate is what keeps the intake from colliding with every other suite that opens a conversation at
a classification where onboarding is enabled. The onboarding suite completes the intake once for its user;
other suites resolve an already-onboarded profile and get direct answers instead of having their first turn
consumed as a field answer.

Two properties make that reliable rather than order-dependent, and both are asserted today:

- The onboarding suite completes the intake and then requires a second conversation for the same user to
  leave `onboardedAt` unchanged, which states the once-per-user contract as a property of the store rather
  than of what the assistant chose to say.
- Suites that need an already-onboarded user do not depend on the onboarding suite having run first; the
  precondition is arranged, so any suite can run alone.

## Implementation checklist

- [x] `UserProfileTable` (pk `userSub`) + outputs/SSM in the foundations stack; grant the
      router read/write; wire the table name (and optional `USER_PROFILE_SERVICE_ARN`) as env.
- [x] `lib/user-profile-client.ts`: the client interface, built-in DynamoDB impl, and the
      ARN-swap seam. Unit-tested (`test/lib/user-profile-client.test.ts`).
- [x] `router-agent-handler.ts`: gate the intake start on `hasOnboarded`; call `markOnboarded` on
      completion; also gate the real-turn interception so an already-onboarded user is answered
      directly.
- [x] Seed step writes an intake schema (`seed-demo.ts`); enabling further classifications is
      configuration, not code.
- [x] e2e: `onboarding-intake.spec.ts` completes the intake, asserts the PROFILE STORE carries
      `onboardedAt` plus the collected facts, and requires a second conversation for the same user
      to leave `onboardedAt` unchanged. Carries a vacuity guard so a deleted row fails the test
      instead of passing on reply prose.
- [x] Deploy the foundations + classification stacks (table, router env/IAM) to the live account.

The participant rule (§2), the resolution model (§1a), identity provenance (§2a), the no-provider case (§4)
and the record lifecycle (§5) are design. Nothing below is built:

- [ ] **PREREQUISITE: a collision-resistant channel id** on the primary creation path, matching the shape
      the drift path already uses. Must land BEFORE the ordering change: once the id keys a row written
      before the channel exists, a collision attaches one person's context to another's conversation.
- [ ] **Write participant context before `CreateChannel` (§2)**, keyed by the derived channel ARN. Record
      the membership SHAPE (one human, several, none), not a single id. Retire the retry loop; there is no
      window left to retry across.
- [ ] **Stop writing the `createdBy` copy** in `create-conversation`, matching the two creation paths
      that already refuse to. Keep reading it for legacy conversations, for attribution only, never for
      the gate.
- [ ] Read `preferences` and `facts` against the base identity, so an elevated identity does not get a
      second profile row (§1).
- [ ] One resolver every caller asks, replacing the per-source lookups, with per-attribute ownership
      as declared in §1a, including the caching rules.
- [ ] Report which source answered each attribute, and count the case where two sources answer with
      different non-empty values. Without this half, an inconsistent resolution stays invisible.
- [ ] Record the `identity` block at credential exchange (§2a), the only point where a federated
      participant's issuer and derived id exist together, and re-verify it on each exchange so a stale
      pointer is corrected and a changed issuer is counted.
- [ ] Separate `preferredName` from `displayName`, so the reserved context-source contract stops
      declaring a provider-owned attribute against this store.
- [ ] Emit the onboarding funnel counts of §3 (started, completed, gate decision with reason).
- [ ] Delete the profile row, and any link naming it, when a user is deleted (§5). The shipped deletion path
      does not touch this store today, so a deleted person's answers currently survive them.
- [ ] Measure the population with no `identity` pointer, so the un-backfillable federated set is a known
      number rather than an assumption (§2a).
