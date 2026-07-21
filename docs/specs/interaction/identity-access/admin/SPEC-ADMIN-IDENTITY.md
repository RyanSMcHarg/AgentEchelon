# SPEC: Admin Identity

**Status:** Implemented (with a small set of tracked gaps, section 6) **Layer:** Interaction **Pillar:** Identity & Access **Plane:** admin **Summary:** A capability model that decides who may perform a privileged action, proves who performed it, and never over-grants, by splitting every operator into a membership-gated chat identity and a separate, just-in-time admin identity. **Technical designs:** [`DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md`](DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md) (how a capability becomes IAM-enforceable), [`DESIGN-ADMIN-AGENT-NOTIFICATIONS.md`](DESIGN-ADMIN-AGENT-NOTIFICATIONS.md) (how admin-facing alerts are delivered inside the admin trust boundary). **Site section(s):** Admin console, identity and access.

## 1. Business problem

A business running assistants for users at different clearance levels has to let specific operators do privileged things - read any conversation across those levels, moderate a message, delete a message, change who is a member, configure models and routing, read the durable archive - and be sure only the right people can, with every act provable. The alternative is to trust a product's single bolted-on "admin" switch, or to build your own admin identity plane (least-privilege capability model, per-action denial, just-in-time credentials, end-to-end audit) and secure it yourself. Someone has to be able to do these things, but three failures are easy and expensive.

- **Over-granting.** The blunt approach is one "admin" flag that unlocks everything. That flag cannot express "this person may moderate but may not read the archive", it makes a stolen session catastrophic, and it cannot be narrowed for a role that should see less.
- **No proof.** If a privileged action is not attributable to a specific human, and a sensitive read is not recorded, there is no accountability. A shared credential anonymizes the actor.
- **Standing power at rest.** A credential that is always live and always able to read everything is a target. The blast radius of a leak is the whole platform, for as long as the credential lives.

The problem this feature solves is: let a deployer decide precisely who may perform each privileged action, prove who did each one, and hold no more standing power than the moment needs. The core mechanism is a two-identity split. Every operator keeps an ordinary chat identity that is membership-gated exactly like any user, and receives privileged authority only through a separate admin identity whose credentials are requested, recorded, scoped, and short-lived. Elevation is a property of the identity, not of a credential that a chat session could carry.

### 1.1 Two credential planes

Privileged reads reach content through two independent planes, controlled separately, because they carry different risk:

- **Live conversations.** Reading and moderating an active conversation happens as the operator's own admin identity, with short-lived credentials scoped to a single conversation and recorded on each vend. The messaging service itself enforces the authority; de-provisioning the operator's admin identity revokes it.
- **The archive.** The durable copy of every conversation, spanning all classifications and persisting after content is redacted or deleted live, is the system of record and the more sensitive plane. It is read through separate short-lived credentials scoped to the archive, encrypted at rest with a customer-managed key, and is intended to gate behind a per-request proof-of-need before decryption. Holding admin authority over live conversations does not by itself grant archive access.

Controlling the archive separately from live administration is deliberate: the archive is where a single over-broad credential would do the most damage, so it is scoped, recorded, time-boxed, and revocable on its own.

### 1.2 Calibration

The capability set is modeled on an enterprise context where conversation messages are operational records, not personal user data, so operators archive, read across conversations, and delete as operators, subject to a recorded proof of need. This is a least-privilege starting point, not a fixed policy. Deployments serving other use cases (customer engagement, personal data, stricter data-protection regimes) must do their own evaluation and extend the model; none of this is legal advice.

## 2. Personas

See `overview/PERSONAS.md` for the canonical definitions. The access rungs `basic` / `standard` / `premium` are classification levels a conversation and a user carry, not personas; they cap what an ordinary chat identity may read. Admin authority is separate and additive (a person is typically `premium` plus an admin group).

| Persona | What they need from this feature |
|---|---|
| **End user** | To create conversations and moderate the ones they own, without any admin identity. Moderator status is a consequence of creating a channel, not a granted admin power. |
| **Admin / operator** | The break-glass, full-access level. To read, moderate, delete, manage membership, and configure the platform across every classification, always as themselves, with every action attributed and revocable. |
| **Platform developer** | Technical telemetry and the raw event structure to build and debug the platform, without customer message bodies by default (scoped, opt-in, audited). |
| **AI developer** | Quality signals (intent, evaluations, tools, model, drift, ground truth) and prompt/reply pairs, scoped to the assistants and classifications they own, with no moderation, delete, or platform-config authority. |
| **Manager** | The conversation content and the redact (moderation-level) capability for their own use-case scope, and none of the platform internals or configuration. |

The admin / operator persona is the full-access `platform-admin` role; the other three are narrower roles a deployer composes from the capability set. None of the narrower personas ship enabled by default; they are opt-in examples a deployer reviews and adapts.

### 2.1 Moderator and admin are different levels

At the conversation level, two levels of authority exist, and they are not the same thing:

- **Moderator** authority is channel-scoped. It belongs to whoever moderates a specific conversation (its creator, or a member promoted to moderator), and reaches only the channels they actually moderate. A moderator can redact a message, change membership, and update the conversation, but cannot delete a message or act on a conversation they do not moderate.
- **Admin** authority is cross-channel and classification-transcendent. An admin acts on any conversation regardless of classification, as themselves, and is the only level that can delete a message or act on a conversation it does not moderate.

| Action | Moderator (channels they moderate) | Admin (any channel) |
|---|---|---|
| Change conversation configuration (title, non-security metadata) | Yes | Yes |
| Reclassify a conversation | No (immutable) | No (immutable) |
| Add or remove members, promote a moderator | Yes | Yes |
| Join as a non-visible observer | No | Yes |
| Redact a message | Yes | Yes |
| Delete a message | No | Yes |
| Delete a conversation | Yes | Yes |

Creating a conversation is neither a moderator nor an admin action: it is a base user capability, and moderator status is a consequence of creating the channel, not a permission that authorizes it. A moderator of a channel cannot exist before the channel does.

## 3. Use cases

1. **Admin reads and moderates across classifications.** As an admin / operator, I open the console, review a conversation in a classification I am not a member of, redact an off-topic message, and delete a policy-violating one, so that I can operate the platform. I act as myself throughout; the user sees the effect, not my presence, and every step is attributed to me.

2. **A scoped persona is denied a capability.** As a manager, I can redact within my use-case channels but the console offers me no delete and no platform configuration, because my role holds `redact` but not `delete` or `manage-config`. As an AI developer, I can read quality and analytics but not the user-activity (PII) surface, because my role omits that capability. The denial is enforced, not merely hidden in the UI.

3. **A service path auto-revokes with no human.** When the membership audit finds a member whose classification exceeds a channel's, the auto-revoke runs as a dedicated non-human service identity, removes the membership, and records both the service identity and the finding, so that remediation does not require, and is never attributed to, a person.

4. **A privileged read is proven.** As an admin / operator, when I read another classification's live messages or vend a content-read credential, the vend is recorded (`admin_scoped_credential_vend`) with my identity, the requested scope, and a reason, so that "who could read this customer's conversation" is answerable after the fact.

5. **Revocation is real and fast.** As a deployer, when I remove a person from the admin group, their ability to vend new admin credentials stops immediately, their standing admin identity is de-provisioned, and any in-flight credential expires on its short lifetime, so that off-boarding is one action with a bounded blast radius.

## 4. Functional requirements

- **FR-1. Two identities per operator.** Each human operator holds an ordinary chat identity, which is never elevated and is membership-gated like any user, and a separate admin identity that carries privileged authority. Cross-identity authority cannot attach to a chat credential.
- **FR-2. Admin is graded, not binary.** Authority is a set of capabilities, not one flag. A full-access admin holds all; narrower roles (platform developer, AI developer, manager) hold defined subsets. A dedicated service identity exists only for no-human automation.
- **FR-3. Capability-level denial.** Each privileged action is a capability that a role can be denied independently. Denying one capability (for example archive read, or delete) does not require denying admin status as a whole.
- **FR-4. Fail-closed.** A principal that cannot be resolved to a definite authority is treated as the least privilege, not the most: an unrecognized role narrows to the classification floor, a missing admin registration refuses the action, and provisioning that cannot establish the exact level issues no admin credentials.
- **FR-5. Just-in-time, recorded, temporary.** Elevated access is not standing. To act, an operator makes a recorded request carrying a reason (and, for sensitive scope, an approval); access is then vended short-lived, used, and left to expire. The request, vend, use, and revoke are recorded end to end.
- **FR-6. Attribution to the acting human.** Every privileged action is attributed to the human who performed it, at the enforcement layer (the human's own identity) and in an audit event, even when execution runs through the shared service identity.
- **FR-7. No impersonation.** An operator only ever acts as themselves. There is no path for a credential to be minted or wielded as another user or another admin; a compromised backend component holds no operator authority.
- **FR-8. Cross-classification is an admin-identity property.** The ability to act across classifications belongs to the admin identity, not to any chat credential, which is why it is confined to roles that need it and always leaves an attributable record.

**Acceptance criteria:** a non-admin, and an authenticated non-admin, are denied on every admin route in each admin auth mode; a scoped role is denied a capability its persona does not hold, at the gateway and not only in the UI; an admin cannot act as another admin's or a user's identity; provisioning fails closed when the level cannot be established; removing an operator from the admin group revokes their admin authority on the next call; and every privileged content read or moderation emits an attributable vend record. These are verified by deny-tests, not review; each new admin endpoint adds a deny-test.

## 5. Non-goals

- **A full data-protection policy.** The capability set is calibrated for an enterprise context where conversation messages are operational records. Deployments where messages are personal data (GDPR and similar) must add erasure propagation to the archive, read-access logging of sensitive reads, retention bounds, and their own review; this feature is a least-privilege starting point, not a finished compliance posture.
- **Impersonation or acting as a user.** Deliberately impossible (FR-7), not a missing feature.
- **Reclassifying a conversation.** A conversation's classification is set once at creation and is immutable by design; no role can change it.
- **Legal hold and e-discovery.** Sketched as future architecture, not built and not on the initial roadmap.
- **A separate admin identity pool.** Admin authority is a claim on one pool, additive to a user's classification, not a second pool; host applications map their own admin claim in.

## 6. Tracked gaps

Most of the model ships. The known gaps are:

- The archive plane's per-request proof-of-need decrypt gate (vend archive decrypt only against a recorded, approved request) is not yet built; the customer-managed encryption key it would gate is implemented.
- Fine-grained per-resource IAM enforcement of privileged actions is built but opt-in behind a flag; the interim control is a configurable admin-group gate. See [`DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md`](DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md).
- Admin reads are attributed for content vends but cross-classification read-logging as a blanket accountability control is not complete.

## 7. Open product questions

- **Ownership as a scope axis.** The `Scoped` cells for the AI developer (by assistant) and the manager (by use case) currently reuse the classification tag. Do they need a distinct ownership concept, given the platform has no generic "who owns which channel or assistant" model?
- **Moderation-audit as its own capability.** Whether "who redacted or deleted, and when" is a separate capability or rides on the moderate capability.
- **Admin console distribution.** A separate admin application (plan item D) is a natural place to require these capabilities per persona; how the two interact is open.
- **Archive read accountability.** Whether, and how strictly, every cross-classification read (not only mutations and content vends) must be logged before the model is used where messages are personal data.
- **Default enforcement mode.** Whether per-resource IAM enforcement should become the default for all admin auth modes, or stay opt-in with the group gate as the ceiling in the default mode.

## Related

- Technical designs: [`DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md`](DESIGN-ADMIN-ACTION-IAM-ENFORCEMENT.md), [`DESIGN-ADMIN-AGENT-NOTIFICATIONS.md`](DESIGN-ADMIN-AGENT-NOTIFICATIONS.md)
- Context: [`IDENTITY-AND-ACCESS-MODEL.md`](../core/IDENTITY-AND-ACCESS-MODEL.md) (one pool, groups as authority, the three "admins"), [`SPEC-CREDENTIAL-EXCHANGE.md`](../core/SPEC-CREDENTIAL-EXCHANGE.md) (bearer-pinned credential vend), [`SPEC-ACCESS-AND-CONTROLS-AUDITING.md`](../../auditing/SPEC-ACCESS-AND-CONTROLS-AUDITING.md) (audit trail)
- Guides: `ADMIN-INTEGRATION-GUIDE.md` (the three admin auth modes), `ADMIN-GUIDE.md` (operating the console)
