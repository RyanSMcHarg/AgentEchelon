# Federated Participants - bring external people in, safely, from any identity provider

**Status:** Design (a wired, opt-in seam; not the shipped experience)


Opt-in via `-c federatedUserPoolId`. Extends **Identity & Access** (`docs/specs/identity-access/SPEC-CREDENTIAL-EXCHANGE.md`) to humans who don't have an account in this deployment. Part of the interaction-layer set (`docs/specs/conversation-messaging/SPEC-INTERACTION-LAYER.md`).

**Related:** `docs/specs/identity-access/SPEC-CREDENTIAL-EXCHANGE.md` (the credential substrate this builds on) · `docs/specs/conversation-messaging/SPEC-CONVERSATION-TYPES.md` §6 (a connector resolves the external person) · `docs/guides/user/IDENTITY-PROVIDER-GUIDE.md` · `docs/specs/identity-access/SPEC-CONVERSATION-SECURITY.md` · AWS blog *"Integrate your Identity Provider with Amazon Chime SDK Messaging"* (June 2021).

---

## 1. Why

The valuable experiences connect a customer to a **person inside the business** - a routed support agent, an on-call engineer, a dispatched technician - who authenticates against the *business's* identity provider and may not have an account in this deployment at all. The platform must bring that person into a conversation **at exactly the right trust level, only as themselves, in the one conversation they're invited to**, without migrating them in. Because access is IAM-enforced (Identity & Access pillar), this can be a credential decision, not a trust-the-client decision.

## 2. Who benefits

- **The business** routes its own staff into customer conversations using its existing SSO - no user migration, no per-integration access code.
- **External participants** get scoped, time-bound access to exactly the conversation they were brought into.
- **Customers** reach a real person inside the same experience, with full context, without leaving it.

## 3. Experiences enabled

A routed **support agent** joins a case for its duration; an **on-call engineer** is dialed into a triage room; a **field technician** talks to a customer over a masked channel. Each is an external human, resolved by a connector, admitted at a capped classification, scoped to one conversation, and revoked when done.

## 4. The model - full stack, capped and pinned

An external human crosses four layers; each is handled so a gap in any one can't escalate:

- **L0 - IdP auth:** the person authenticates with the business's SSO; its **group/role claim** is the input to their access ceiling.
- **L1 - credentials + ceiling:** the **Credential Exchange** (Identity & Access pillar) validates the IdP token and `sts:AssumeRole`s a capped, bearer-pinned role. The ceiling = `min(idpGroup→classification, channel.classification)` - a connector or IdP can only ever grant *less*, never more.
- **L2 - identity:** the person gets an `AppInstanceUser` (created on first SSO, or pre-provisioned by the connector with a stable id so a later login binds to the same identity). Stored by id, not PII.
- **L3 - messaging:** a privileged path (the assistant/connector) admits them to **the routed channel only** (membership is the per-channel scope; admission is backend, never self-service); their own bearer-pinned credentials then let them send/receive there, gated by the channel's classification; revoke on close removes the membership.

**The classification guard** (the IAM enforcement column of the capability model): a lookup from the IdP group to an **existing** classification is the *ceiling*; effective = `min(ceiling, channel)`; membership pins them to the routed channel; unmapped → the lowest classification (fail-closed); the table never adds a classification.

## 5. Two modes - prefer embedding our experience; proxy only as fallback

- **Mode A - direct (preferred):** where we can put the AgentEchelon surface in front of the person, they SSO-federate, assume the capped role, and act *in our experience* (our context, targeting, assistant). The credential exchange + the bearer pin are the guard.
- **Mode B - connector-proxy (fallback):** where we can't embed, the connector relays the person's messages and bears the conversation itself; the person holds no credentials here and is attribution-only metadata. The guard is on the connector's (classification-bounded) identity. Mode is chosen per use case, biased to A.

## 6. How it composes

- **→ Identity & Access:** federated participants are an *additive* path on the credential exchange (verify an external token + apply the ceiling) - not a new substrate.
- **← Conversation Configuration:** the conversation type's `classification` is the cap; its `participants` policy + a `connectors[]` `resolveParticipant` decide who may be pulled in and how.
- **← Connectors:** `resolveParticipant` turns "bring in a support agent" into a concrete external identity to admit; comms (`provideComms`) carry voice/SMS/meeting for that person.

## 7. Security

- **Bearer-pinned** via the credential exchange's session tag (the person can only act as themselves).
- **Admission is backend + classification-capped** - a connector feeds admission; it never bypasses it; an external is admitted only to the routed channel and only at ≤ the channel's classification.
- **Current namespaces** for the identity/messaging calls: `chime-sdk-identity` (AppInstanceUser) + `chime-sdk-messaging` (channels/sessions); the `chime:` IAM prefix is retained.
- **The external-role → classification mapping and escalation guard** (a connector can never admit above the channel): §4 defines the enforcement; the mapping is per-connector config.

## 8. Implementation

Built on the Credential Exchange (`SPEC-CREDENTIAL-EXCHANGE.md` §9) as the additive external-token + ceiling step on top of it. The federated path is gated on `-c federatedUserPoolId` and split across two stacks: `federated-credential-exchange.ts` is wired in `cognito-auth-stack.ts` and verifies the external IdP token and vends a capped, bearer-pinned credential; `federated-create-conversation.ts` / `federated-add-member.ts` / `federated-remove-member.ts` are wired in `foundations-stack.ts` and handle AppInstanceUser provisioning and membership admission/revocation; `lib/federated-identity.ts` derives the stable federated id. The per-connector classification map + connector-driven `resolveParticipant` (Mode B connector-proxy) belong to the connector pillar.
