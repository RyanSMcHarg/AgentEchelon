# SPEC: User profile store and once-per-user onboarding

**Status:** Implemented (pending live deploy + e2e validation)

> "User profile" here means a durable per-END-USER record (who the person is, what
> they told us during onboarding, whether they have been onboarded). It is NOT the
> assistant capability-"profile" of SPEC-PER-PROFILE-OWNERSHIP. The two are unrelated;
> this document uses "user profile" strictly for the per-user record and "assistant
> profile" when it must refer to the capability bundle.
>
> AgentEchelon ships a minimal built-in user profile store. It is a **reference
> stand-in for an OSS implementer's own profile store**, not a system of record. A
> real deployment plugs in its own store behind the client boundary defined below,
> the same way the identity provider is pluggable (IDENTITY-PROVIDER-GUIDE.md): the
> router is a *client* of a profile store it does not own, reaching an externally owned
> profile service by ARN when one is configured. The built-in store exists so the
> platform runs end to end out of the box, not to prescribe where real user data lives.

## Problem

Onboarding intake (SPEC / `lib/onboarding-intake.ts`) is an opt-in first-conversation
questionnaire. When a deployment supplies an intake schema for a classification, the
assistant opens a new conversation by asking the schema's fields instead of the static
welcome, then drives a short FSM across the next turns to collect the answers.

Today that FSM lives entirely in Lex `sessionAttributes`, which is **per conversation**.
There is no durable per-user state, so:

- Onboarding fires on **every** new conversation for that classification, re-asking a
  user who already answered. Re-onboarding a known user is a context bug: the platform
  is meant to remember the person, not interrogate them again.
- The first real user turn of every new conversation is consumed as a field answer,
  which collides with any flow that expects "open a conversation, ask a question, get a
  direct answer" (observed against the standard-tier e2e suite).
- The answers land only in that conversation's history. Nothing carries the collected
  company/role forward to the user's next conversation.

The intended behavior is **once per user**: onboard a person the first time, remember
that they were onboarded (and what they said), and never re-onboard them.

## Two gaps this depends on

1. **Durable per-user state.** There is no per-user store to record "onboarded" or the
   collected facts. (The existing `userSub`-keyed tables hold tasks and feedback only.)
2. **Reliable creator identity at welcome time.** The intake starts on `WelcomeIntent`,
   which fires on the *bot's* channel-membership event. That event carries no sender,
   and the human creator's membership is added a beat later (the bot creates the channel,
   so the bot is necessarily the first member; the user cannot be added before it). So at
   the moment the intake would decide "has this user onboarded?", the router has no
   dependable identity to key on. `createdBy` is also not stamped in channel metadata
   today, so there is no backup either.

## Design

### 1. User profile store (pluggable stand-in)

Define a narrow client boundary the router depends on, not a concrete table:

```
getUserProfile(userSub): Promise<UserProfile | null>
markOnboarded(userSub, facts): Promise<void>
```

```
interface UserProfile {
  userSub: string;          // Cognito sub (partition key)
  onboardedAt?: string;     // ISO timestamp; presence == "already onboarded"
  facts?: Record<string,string>; // collected intake answers (e.g. company, role)
  updatedAt: string;
}
```

- **Built-in implementation:** a single DynamoDB table `UserProfileTable`
  (pk `userSub`, no TTL, PITR on) in the foundations stack. The router reads/writes it
  directly. This is the reference stand-in.
- **Swap seam:** the router selects the implementation from an env var
  (`USER_PROFILE_SERVICE_ARN`). When set, the client invokes the implementer's Lambda
  instead of the built-in table; when unset, it uses the built-in table. An implementer
  therefore points AgentEchelon at their existing profile store without a code change,
  and the built-in table is purely the default.

The interface is deliberately minimal (two calls). The stand-in does not model account
requests, approval workflow, verification, or engagement analytics; a real store may,
but the platform does not require it.

### 2. Creator identity at welcome (membership primary, metadata backup)

Resolve the human creator when the intake needs to gate, using the more durable of the
two available signals as the backstop:

1. **Membership (primary, authoritative):** list channel members, take the single
   non-bot member. This is the owner truth (consistent with deriving ownership from
   Chime membership rather than a metadata copy).
2. **`createdBy` metadata (backup, durable):** re-stamp the creator's `sub` into channel
   metadata at creation (`create-conversation/index.js`, from the JWT `callerSub`). This
   is written atomically with `CreateChannel` and is already read by the router on
   `WelcomeIntent`, so it is present with no race and no extra call. It is immutable
   (creator-at-creation never changes) and server-set (not spoofable), so it does not
   reintroduce mutable-owner-copy staleness.

At welcome, prefer membership; if the human member has not propagated yet, fall back to
`createdBy`. Both resolve to the same `sub`.

### 3. Once-per-user gate

- **On `WelcomeIntent`:** resolve the creator (above). If `getUserProfile(sub)?.onboardedAt`
  is set, skip the intake and render the normal welcome orientation. Otherwise start the
  intake as today.
- **On intake completion (`phase === 'done'`):** call `markOnboarded(sub, collectedFacts)`
  so the flag and the company/role persist for every future conversation.
- **Fail-open to the existing behavior on any store error:** if the profile lookup fails,
  fall back to the current path (start the intake) rather than erroring the turn, so a
  store outage degrades to today's behavior instead of a broken welcome.

## Non-goals

- Not the authoritative identity or account store. The built-in table is a demo stand-in;
  real deployments own their user data elsewhere.
- No approval/verification/guest lifecycle (that is the implementer's store's concern).
- No change to the intake FSM engine (`onboarding-intake.ts` stays the pure state machine);
  only the trigger gate and completion hook change.

## Test impact

Once onboarding is once-per-user, the standard-tier e2e suites stop colliding: the
onboarding e2e completes the intake once for its user, and subsequent standard
conversations (agent-intents, tier-context) resolve an already-onboarded profile and get
direct answers. The onboarding e2e should first complete the intake, then assert that a
fresh standard conversation for the same user is NOT re-onboarded.

## Implementation checklist

- [x] `UserProfileTable` (pk `userSub`) + outputs/SSM in the foundations stack; grant the
      router read/write; wire the table name (and optional `USER_PROFILE_SERVICE_ARN`) as env.
- [x] `lib/user-profile-client.ts`: the two-call interface, built-in DynamoDB impl, and the
      ARN-swap seam. Unit-tested (`test/lib/user-profile-client.test.ts`).
- [x] `create-conversation/index.js`: stamp `createdBy` (JWT `callerSub`) in channel metadata.
- [x] `router-agent-handler.ts`: resolve creator on `WelcomeIntent` (membership then
      `createdBy`); gate the intake start on `hasOnboarded`; call `markOnboarded` on `done`;
      also gate the real-turn interception so an already-onboarded user is answered directly.
- [x] Seed step already writes the standard intake schema (`seed-demo.ts`); no change needed
      there once the gate lands.
- [ ] e2e: onboarding spec completes the intake then asserts no re-onboarding; re-run the
      standard-tier suites green.
- [ ] Deploy the foundations + classification stacks (new table, router env/IAM) to the live account.
