---
title: "ADR-034: Addressing a message is not making it private"
status: Accepted 2026-09-11. Directed by the owner and built on all three sides. Parts have since been measured against a deployment on 2026-09-15, and each measured claim in the body carries that date; the private-address check reworked from those measurements is built and deployed to dev, NOT VERIFIED there.
date: 2026-09-11
related:
  - "../../guides/developer/MESSAGE-FLOW.md"
  - "./022-message-identity-is-established-at-the-channel-flow.md"
  - "./023-battle-round-coordination.md"
  - "./030-a-message-is-answered-by-the-assistant-whose-work-it-answers.md"
  - "./032-where-a-rule-runs.md"
  - "../../../frontend/packages/chat/src/utils/mentionParser.ts"
  - "../../../frontend/packages/chat/src/components/MessageInput.tsx"
  - "../../../frontend/packages/chat/src/services/chimeService.ts"
  - "../../../backend/lambda/src/lib/async-processor-core.ts"
tracking: |
  Exploration, not a commitment. Two capabilities want opposite halves of one field. A 1:1 exchange
  needs privacy WITHOUT leaving the conversation, so the context it is about is still there; agent
  assist needs an assistant to hand one person a drafted reply their client prepopulates rather than
  posts, which only works if the other party provably cannot see it. Everything else in a room of
  more than two people needs the opposite: naming somebody without hiding the message. Amazon Chime
  SDK spends one field, Target, on both decisions. One instance of the missing shape already ships -
  answering a shared work item - and it rests on a platform behavior nobody has measured, which is
  also the measurement that decides between the options below.
---

# ADR-034: Addressing a message is not making it private

## Status

**Amended 2026-09-17: the entry this record reasons against has changed.** The addressing grammar it decides is unchanged and still as-built: `@` sets `CHIME.mentions` and addresses in public, `.` sets `Target` and addresses privately. What changed is who starts the turn. The code provisions every assistant with `StandardMessages: NONE` and `TargetedMessages: ALL` (ADR-036 option B, ADR-041), so on a deployment carrying it Amazon Chime SDK invokes no assistant from a mention or from being the only other member, and AgentEchelon's channel flow starts every untargeted turn. **The deployed `InvokedBy` is verified 2026-10-11: every assistant on the default instance reads `NONE`/`ALL` ([ADR-036, Recorded evidence](./036-why-turns-enter-through-amazon-lex.md#recorded-evidence)).** Statements below about `AUTO` invoking on a mention alone, or invoking every message in a 1:1, are measured (2026-09-15) and describe `AUTO`, the configuration the code does not provision; the 1:1 member-count branch they describe applies only to an assistant still carrying it.

**Accepted (2026-09-11). Built on all three sides and deployed to dev.** The directions below were given by the owner, and the code now carries them: the composer resolves both tokens and sets a `Target` for `.` only, the channel flow resolves every `@` against the conversation's members and routes it, and the agent handler stands down for exactly the turns the flow claims. Both sides read one function (`flowOwnsTheTurn`), so they are complements by construction rather than by two lists agreeing.

**None of it has run against a deployed channel.** A build is not a verification, and this change moves the most visible path in the product, so what is claimed here is "written and unit-covered", not "observed working".

**Three things are directed (owner, 2026-09-11)** and the rest is written around them:

- **The private token is a dot prefix**, `.<member>`, decorated in the composer once it resolves. `@<member>` becomes addressing that notifies and broadcasts, and sets no `Target`.
- **Every `@` token bypasses Lex.** The channel flow resolves the mention and routes the turn to the destination itself, which is Option D generalized from the one token that uses it today. `@all` routes to the default assistant, which delegates onward as the work requires.
- **It ships as one declared breaking change rather than a staged migration**, because the repository is at `0.1.0` and the cost of changing what a gesture means only rises with adoption.

**The second of those closes the measurement this ADR was blocked on.** Nothing then depends on whether `AUTO` invokes an assistant from a `CHIME.mentions` attribute with no `Target`, because no assistant is reached that way: the flow reads content, content is a field it provably receives, and the routing decision stops being Amazon Chime SDK's. Options A, B and C are therefore not chosen - they are moot.

## What this is for

Two capabilities need it, and they pull in opposite directions - which is why one field serving both decisions fails.

### 1. A 1:1 exchange inside the conversation, without starting another one

Somebody needs a word with one person, or with one assistant, about the thing this conversation is already about. Today the only private channel is a DIFFERENT conversation, and moving there throws away everything that made the exchange cheap: the history, the grounding, the work in flight, the classification the room was created with. The person pays for privacy by re-explaining, and whatever they agree in the side conversation never rejoins the record the room is working from.

So a private message has to stay **in context**: same conversation, same history, same work, visible to fewer people. That is what a `Target` already does, and it is the half of today's behavior worth protecting rather than replacing.

### 2. Agent assist: an assistant hands one person something the room must not see

An assistant watching a conversation drafts a recommended reply and sends it to the ONE person who will answer. Their client does not post it - it **prepopulates their composer**, so they edit it, or ignore it, and what reaches the room is a message that person wrote and chose to send.

This is the case that makes enforcement non-negotiable. The other party to that conversation must never see the suggestion: seeing it reveals that the reply was drafted, and reveals the wording that was rejected. A message delivered to everyone and hidden by the recipient's client would put the draft on the wire to the person it is about. **Privacy here has to be enforced by the platform, and a client-side rule is not a weaker version of that - it is a disclosure.**

It also adds a requirement the addressing question does not have on its own: **the message is a payload, not prose.** Nothing should render it as something the assistant said. The conversation already has a precedent for that shape - a `<!--suggestions:-->` marker the plan widget parses into review cards instead of displaying - so what agent assist needs is that idea delivered privately to one member and declared as an instruction for the client rather than as something to read.

### What the two together require

| Requirement | From |
|---|---|
| Private stays ENFORCED, server-side | Agent assist. A client-side hide leaks the draft to the person it concerns |
| Private stays IN CONTEXT, in the same conversation | The 1:1 case. A separate conversation is what people do today and what costs them the context |
| An assistant can address ONE person privately | Agent assist. This direction is assistant to human, and it is a product capability rather than plumbing |
| A private message can carry an ACTION for the client, declared | Agent assist. "Put this in their composer" is not "display this" |
| Addressing someone does NOT make it private | Everything else in a room with more than two people |

The last row is the one this ADR is named for. The first four are why the mechanism it would replace has to survive.

## The problem

A conversation needs to express four things, and they are two independent questions:

| | Everyone can read it | Only the addressee can read it |
|---|---|---|
| **Addressed to nobody in particular** | an ordinary message | a note to oneself, which nobody has asked for |
| **Addressed to a member** | **not expressible today** | `@<member>`, which is what the product does now |

The missing cell is the ordinary case in a room with more than two people. "Sam, can you confirm the Q3 figure?" is addressed to Sam and is nobody's secret; the rest of the room is meant to see that Sam was asked. Today, naming Sam hides the message from everyone else.

The cause is not a missing feature. It is that **one platform field carries two decisions**. `SendChannelMessage.Target` routes the message *and* restricts who can read it, and a client that wants the first gets the second whether it wants it or not.

## What the platform actually gives, measured

| Fact | Evidence |
|---|---|
| `Target` restricts visibility to the sender and the target | `chimeService.sendMessage`: "the message is then visible only to the sender and that target ARN" |
| `Target` holds exactly one member | Fixed at 1 item by the AWS API. `mentionParser` enforces it client-side rather than letting the send fail, and refuses `multiple_humans` / `multiple_bots` |
| `CHIME.mentions` is a message ATTRIBUTE, separate from `Target`, and does not restrict visibility | It rides alongside as public text; attributes do not gate delivery |
| The channel flow cannot set or change a `Target` | `ChannelMessageCallback` carries `MessageId`, `Content`, `Metadata`, `MessageAttributes`, `PushNotification`, `SubChannelId` and nothing else ([ADR-023](./023-battle-round-coordination.md)) |
| The channel flow cannot READ a `Target` from its callback | The callback's `ChannelMessage` does not carry it, measured 2026-08-14. This is why the flow has no battle-continuation branch: a reply to a waiting duel side is resumed by that side's handler ([ADR-029](./029-clarification-is-public-and-answers-get-their-own-placeholder.md)). The stored message does carry it, and the flow reads it back with `GetChannelMessage` where a decision depends on it (see "A private address must carry the `Target` its text names" below) |
| `StandardMessages: AUTO` invokes an assistant on a `CHIME.mentions` attribute alone, with no `Target` | Measured 2026-09-15. In a room where `AUTO` answers only when addressed, a message carrying only the mention attribute naming the assistant invoked that assistant's Lex, while a message carrying neither invoked nothing ([MESSAGE-FLOW](../../guides/developer/MESSAGE-FLOW.md) §3.3) |

**The last row was the open question this ADR was written around, and it is now measured (2026-09-15).** It was recorded here and in the code as a question rather than a belief, because the shared-task-answer path had shipped on it. The answer is yes, so that path is correct as shipped: a work item the room can see is answered by mentioning the assistant, the assistant is invoked, and the exchange is not concealed. `frontend/packages/chat/src/services/chimeService.ts` carries the measurement in place of the question it used to carry.

## What the product does today, and the one case already split

`parseMentions` maps typed text onto the two fields:

- `@all` sets neither. The channel flow recognizes the token and broadcasts, because `@all` is not a vocabulary Amazon Chime SDK understands.
- `@<assistant>` alone sets both `Target` and `CHIME.mentions` on that assistant.
- `@<human>` sets `Target` to the human. **This is the case the problem statement is about:** naming a person makes the message private.
- `@<human> @<assistant>` sets `Target` to the human and `CHIME.mentions` to the assistant.

**One case has already been split, deliberately, and its comment is the whole of this ADR in miniature.** Answering a work item the room can see used to address the assistant with a `Target`, which concealed the exchange from the people waiting on the outcome:

> ADDRESSING IS NOT PRIVATISING, and until now this was one act. Reaching the assistant with a `targetArn` sets a Chime Target, and a Target is what makes a message unreadable to the rest of the room - so answering work the room can SEE made the exchange invisible to the people waiting on it, and the outcome changed under them with no way to know why. The convenience feature was doing the concealing, not the person.

A shared item is now answered by **mentioning** the assistant, with the task id riding as metadata; a private item keeps the `Target`, because it is nobody else's. So the missing cell is not hypothetical, it is already occupied by one shipped path - the path that rested on the row above, which is measured as of 2026-09-15 and confirms it.

## The principle that should decide the shape

**Privacy is enforced; addressing is declared.**

They are different kinds of claim and they must not be built the same way:

- **Who may READ a message is a security decision** and belongs to the platform. `Target` is enforced by Amazon Chime SDK before delivery, which is why it can be trusted. A client-rendered "private" badge over a message the server delivered to everyone is a disclosure bug, and no amount of care in the client makes it not one (tenet D3: two enforcement layers, and never one that a caller can skip). Agent assist is the sharpest version: the message on the wire is a draft reply ABOUT the other party, so a client-side rule puts it in front of exactly the person it must not reach.
- **Who a message is FOR is an addressing decision** and can be declared. If a client renders the badge wrongly, a reader sees a message meant for someone else that they were already entitled to read. The failure costs clarity, not confidentiality.

That asymmetry is what makes the split safe to build at all: the expensive half stays where it is, and only the cheap half becomes expressible.

It also settles a tempting shortcut. "Send it targeted and let the client show it to everyone" is not an option - the others never receive it. And "send it to everyone and let the client hide it from all but one" is the disclosure bug above. The two halves cannot be swapped.

## Options

### Option A - the mention attribute carries the addressing, and no `Target` is set

`CHIME.mentions` already exists, is multi-entry, is public, and does not affect visibility. A directed-public message sets it and nothing else. The client renders the badge from the attribute; the backend reads the same attribute when it needs to know who was addressed.

- **Cost: it depends on the unverified row.** If the addressee is an assistant, this shape only reaches it when AUTO invokes on the attribute alone. If that is false, a directed-public message to an assistant is never answered, which is the worst failure available here: the person addressed the assistant in front of the room and was ignored in front of the room.
- For a **human** addressee there is no invocation question at all: no assistant needs to be woken, so the attribute plus client rendering is sufficient today.
- **It is the smallest change**, and it is already the shape the shared-task-answer path uses.

### Option B - an AE-owned metadata field declares the addressing

The message carries `addressedTo` in its own `Metadata`. The client renders from it; the backend reads it; `Target` is used only when the sender asked for privacy.

- **No dependency on Amazon Chime SDK's mention semantics**, and it is expressible for humans and assistants alike.
- **It does not invoke an assistant either**, so it has Option A's problem in the same place and inherits none of Option A's chance of already working. Something still has to route the turn, which means the channel flow, which means `@all`'s bypass shape generalized (see Option D).
- Metadata is sender-writable, which is fine for addressing and would not be fine for privacy - the split above is what makes that acceptable.
- It costs budget against the 1024-character metadata cap, on every directed message ([SPEC-MESSAGE-METADATA-CODEBOOK](../../specs/communication/SPEC-MESSAGE-METADATA-CODEBOOK.md)).

### Option C - a content convention, parsed and stripped

The addressing lives in the text (`@Sam`), is parsed for rendering, and nothing is set on the message at all.

- **Zero platform dependency**, and it is what the text already looks like.
- **The archive keeps the addressing as prose**, so every consumer re-parses it and they will not agree. This is the failure the marker modules exist to prevent, arriving one layer up.
- No mechanism invokes an assistant, so it needs Option D as well.

### Option D - the `@all` bypass generalized to `@<member>`

The channel flow already recognizes a token Amazon Chime SDK does not understand (`@all`) and dispatches the turn itself. A directed-public mention could take the same path.

- **Proven shape**, and it is the only option that does not depend on an unverified platform behavior: the flow reads content, and content is a field it definitely receives.
- **It is the largest change**, and it moves traffic onto a path that currently carries only a deliberate broadcast.
- The flow cannot read `Target`, so this only ever works from the text, which couples it to Option C.

### Option E - separate the two in the composer, whatever carries them

Independent of the transport: the composer offers "address" and "private" as two controls rather than one act of typing a name. A person addressing Sam gets a public message with Sam's badge; a person who also wants it private says so.

- **This is the product half and it is required by every option above.** Today privacy is a side effect of naming somebody, which means it is never a decision the person actually made - the reason the shared-task-answer defect was invisible for so long.
- On its own it changes nothing about delivery. It has to be paired with A, B, C or D.

#### What other clients do, and which of it applies

Worth surveying rather than inventing, because people arrive already fluent in one of these and a product that means something different by the same gesture is the one that leaks.

| Pattern | Where it is familiar from | What it gets right | What it costs here |
|---|---|---|---|
| **A recipient selector**: a persistent "To:" or "Send to:" control listing Everyone and each participant | Meeting chat, where a misdirected message is the classic embarrassment. Clients that do this generally also mark a direct message distinctly, because the failure is sending the wrong thing to the wrong person | The recipient is always visible BEFORE sending, and it is a state the person set rather than a side effect of what they typed | It is a mode, and a mode that persists is a mode somebody forgets they are in. That is exactly the defect the "answering a work item" banner had to be written around |
| **A command prefix**: `/private`, or the IRC-era `/msg <nick> …` | IRC and its descendants; whisper commands in streaming chat | Per-message, no mode to forget, and composable with a mention. AE already has a slash vocabulary (`/battle`), so it needs no new grammar | Discoverability is poor - nobody finds `/private` without being told - and it is only ever typed by people who already know it exists |
| **Two tokens for the two meanings**: a leading `name:` as public address, `/msg` as private | IRC convention, which separated these decades ago | Each gesture does one thing, which is the whole point of this ADR | A bare `name:` convention is invisible to anyone who has not learned it, and it collides with ordinary prose |
| **A mention is ALWAYS public; privacy is a different surface** | The dominant convention in team chat: `@name` pings publicly and a private conversation is a separate channel or a direct message | It is what most people already expect `@` to mean, and it makes the two decisions structurally impossible to confuse | AE has one conversation as the unit, so "take it to a DM" is not available in the same room. It also means changing what `@name` does here - see the migration caution below |
| **Reply-to-message**: the address is derived from the message being answered | Ubiquitous, and inherently public | It addresses a MESSAGE rather than a person, which is closer to what a conversation with work in it actually needs, and it carries its own context | It answers "which message" and not "who should act", and the two come apart the moment somebody else is the right person to answer |
| **A per-message privacy toggle**: a lock beside the composer | Common where privacy is occasional rather than structural | One control, one decision, no mode that outlives the message | Easy to miss at a glance, which matters most on the message where it was meant to be on |

#### Which token, and why it is not a slash command

**The grammar is already declared, and it decides this.** `lib/flow-bypass.ts` states it: *"`@`-tokens address a channel member, `/battle` triggers the fan-out. Deliberately not mention syntax."* `@all` is matched UNANCHORED because it addresses somebody and may appear anywhere; `/battle` is matched ANCHORED at the start because it is a process invocation. Two vocabularies, each doing one job.

Sending privately is not a process invocation. It is a property of an address - an adverb on "to Sam", not a new verb - so it belongs to the mention vocabulary. That is also the practical answer to "slash is taken": `/battle` has not taken a character, it has taken a GRAMMAR, and putting `/private` beside it would mean `/` sometimes runs something and sometimes addresses somebody.

Candidates, against the constraints that actually bind here:

| Token | Renders safely? | Reuses the mention picker | Language-neutral | The objection |
|---|---|---|---|---|
| `@@sam` | Yes. GFM gives `@` no meaning | Partly - the picker fires on the first `@` and has to tolerate the second | Yes | Reads as a typo until learned, and `@sam` matches INSIDE `@@sam`, so the parser must try the longer token first |
| `!sam` | Yes, except `![` which needs a bracket | No | Yes | A second vocabulary to teach, and `!` reads as emphasis in prose |
| `^sam` | Yes | No | Yes | Rare enough to be unguessable; on several keyboard layouts it is a dead key |
| `.sam` | Yes | No | Yes | Carries real meaning for one audience (a leading dot hides a file on Unix) and none for everyone else. Mobile keyboards insert `. ` on their own, which is a source of the token nobody typed |
| `#sam` / `>sam` / `~sam` / `+sam` | **No** | No | Yes | Heading, blockquote, strikethrough and list markers. Messages render through `react-markdown` + `remark-gfm`, so these are taken |
| `dm @sam` / `private @sam` | Yes | Yes, fully - the `@sam` is untouched | **No** | A word is language-bound. This product answers in the person's language ([SPEC-BILINGUAL-CONVERSATIONS](../../specs/interaction/assistants/SPEC-BILINGUAL-CONVERSATIONS.md)), and an English keyword in a conversation being held in another language is the deployment speaking over the person |
| No token - a control on the chip | N/A | N/A | Yes | Discoverable and unambiguous, but there is no keyboard path, and it is a mode that outlives the message |

**`.sam` is the choice (owner, 2026-09-11), and the routing decision settles it rather than taste.**

`@@sam` read as the strongest candidate while this section was written on its own terms: it extends the vocabulary that already carries addressing instead of introducing a second one, it is one character on the key the person just pressed, and the relationship is guessable in the direction that matters. **That argument does not survive the decision made beside it.** Every `@` token now takes the flow bypass and is public - that is what `@` comes to MEAN here - so a private token beginning with `@` reintroduces ambiguity at exactly the point the prefix was made unambiguous. `@@` would be the one `@` that is not public, which is the shape of rule this ADR exists to remove.

`.sam` is then the best of what is left. A leading dot means "hidden" to anyone who has used a Unix filesystem, which makes it the most guessable option for part of the audience and merely arbitrary for the rest - and arbitrary is the floor every non-`@` candidate shares. It is also the token most likely to arrive by accident: mobile keyboards insert `. ` from a double space, and a message beginning with a fragment can start with a dot nobody chose.

**That risk is bounded by two things and neither is optional.** The token resolves only when what follows it names an actual member of THIS conversation, and it is anchored to the start of the message - which together keep ordinary prose and "call me at 5.sam" out. The decoration rule below covers the rest: a token that has not visibly become a pill has not been applied.

Two things to check before committing to any of them, both of which have bitten this codebase already:

- **The token binds tighter than prose.** `.sam` must be anchored to the start of the message and must resolve against this channel's roster, or a decimal, an ellipsis or a file extension becomes an address. Over-matching here publishes nothing, but it makes private a message somebody meant for the room, and they find out when nobody answers.
- **The picker has to fire on a second character.** The composer's mention dropdown fires on `@` today. `.` needs the same completion, or the private form is the one with no help getting the name right - which is the form where getting it wrong costs the most.

#### The token must become a DECORATION before the message can be sent

This is a requirement on the composer rather than on the token, and it holds whichever token is chosen. **A privacy token is not applied until the person can see that it was.** The moment the token completes - the member name resolves and a space follows it - the composer replaces the typed characters with a rendered pill and puts the conversation into its private state, visibly, with the chip reading in words what is about to happen.

The reason is that the two ways to get this wrong cost completely different amounts:

| Mistake | What happens | Cost |
|---|---|---|
| Meant private, the token did not parse | the message goes to the room | **A disclosure.** It cannot be taken back, and the person had no signal |
| Meant public, the token parsed | the message reaches one member | Somebody does not see something they should have. Confusing, and recoverable by sending it again |

So the composer must not leave the first case to be noticed. Decorating on completion turns a parse into something the person confirms by looking, and it is the same mechanism a mention picker already uses to say "I understood who you meant".

**And a near miss is not an address at all** (owner, 2026-09-12, reversing the position below). A dot applies a `Target` only when it is followed by the full name of an actual member; anything else is ordinary text that happens to begin with a dot, and it sends to the room as written.

*This paragraph used to say the opposite* - that a near miss must stop the send, on the argument that a dropped mention costs a notification while a dropped privacy token publishes the message. The argument was right about the asymmetry and wrong about the population. The token grammar matches far more than names: `.env is missing`, `.gitignore needs a line`, `...ok then` and `.5s is fine` all produce one, none resolve, and the refusal made everyday sentences unsendable in any room where people discuss code. The guard cost more than it protected.

**What carries the safety instead is the decoration, which is the mechanism this feature was asked for with.** The composer replaces the token with a "Private to Sam" chip the instant it resolves, so a person typing `.Carol` when Carol is not in the conversation sees no chip before they commit. Absence of the decoration is the warning. Privacy is never *inferred* from a near miss, so there is no guess here to get wrong - the only change is that not-an-address now means ordinary text rather than a refusal.

This also makes the token choice less load-bearing than it looks. With a decoration, what separates the surviving candidates is discoverability and taste; without one, every candidate on the list has the same failure and it is the expensive one.

**The chip should say it in words, not in the token.** "Private to Sam" rather than "`.sam`": the chip is the last thing a person reads before sending something they believe is unreadable to the room, and it should be in the deployment's own language rather than in its syntax. The token is how they typed it; the chip is what the product is about to do.

**What AE already has.** The composer keeps a sticky target and renders it as a chip - `@all` or `@<name>` - and shows an "Answering <work item>" banner that takes precedence over it. That is a recipient selector in substance: the person sets it, it persists, and it is visible before they send. **It has no visibility axis, which is the entire gap.** Adding one control to an existing chip is a smaller change than introducing a recipient model, and the chip is already where a reader looks to find out who a message is for.

**This is a breaking change, and who it breaks decides how to make it.** `@name` stops being private. In a product with an established user base that is a disclosure risk severe enough to dictate the order - ship the public gesture first, move the default later, loudly. **That is not the situation here (owner, 2026-09-11).** The concern is not this deployment's users; it is that this is a public repository, and a downstream deployer who upgrades would find their users' `@name` messages delivered to the room.

**Which is the argument for doing it NOW rather than for doing it carefully.** The cost of this change is proportional to how many deployments have to be told about it, and that number only goes up. The repository is at `0.1.0`, the convention is young, and the people who would have to relearn it are mostly not there yet. A semantic change to what a gesture means belongs before adoption or not at all: after enough adoption, the honest options narrow to carrying both grammars forever.

So the sequencing advice above inverts for this repository. Make it **one declared breaking change** with a stated before and after, rather than a staged migration that leaves two ways to address somebody in the product at once.

**And not behind a flag.** A switch here would mean every downstream deployment could be in either grammar, so every reader of a message - the composer, the processor, the archive, the admin console - would have to ask which one produced it. That is the same conflation this ADR is removing, moved into configuration. A breaking change that is declared is cheaper than a permanent fork in the meaning of `@`.

**The vehicle does not exist yet, and that is worth saying.** There is no CHANGELOG and no release-notes convention in this repository, so a deployer upgrading has nowhere to learn that `@` changed meaning. This ADR plus the message-flow guide are the record by default, which is thinner than a breaking change deserves. Creating that vehicle is arguably part of shipping this one.

### Rejected: re-targeting in the channel flow

Give the flow the message and let it decide visibility. It cannot: the callback can rewrite `Content`, `Metadata`, `MessageAttributes` and `PushNotification`, and `Target` is not among them ([ADR-023](./023-battle-round-coordination.md)). The flow cannot read the `Target` from its callback ([ADR-029](./029-clarification-is-public-and-answers-get-their-own-placeholder.md)); it can only read the stored message back and drop what fails a rule, which is what it does for a private address whose stored `Target` does not name the member its text does. Recorded because it is the first thing anyone proposes.

## What the routing direction settles, and what it newly costs

Sending every `@` through the channel flow replaces a platform behavior with an AE one, and that is the point: the flow reads `Content`, which it provably receives, instead of depending on how Amazon Chime SDK interprets an attribute. Two grammars, two mechanisms, and each one whole:

| Token | Who routes it | Visibility | Reaches an assistant by |
|---|---|---|---|
| `@<member>`, `@all` | the channel flow, which resolves the name and invokes the destination | public, no `Target` | AE's own dispatch |
| `.<member>` | Amazon Chime SDK, from the `Target` | private to sender and member | `TargetedMessages: ALL` |

**What it costs, stated because each item is a real edit rather than a consequence to notice later:**

- **`FLOW_BYPASS_TOKENS` stops being a list.** It is a closed set of three literals (`@all`, `/battle`, `/stop`) with a completeness guard asserting exactly that, and its own header says a further entry "must be a deliberate addition here, not a silent omission on one side of the seam". `@<member>` is not a literal - it is any `@` followed by a name that resolves to a member of THIS channel - so the module becomes a resolver over the channel roster rather than a pattern over text. Both sides of the seam still have to agree, which is the property that module exists to hold.

  **The commands are a registry, not a growing set of special cases.** `@all` stays a literal because it is mention-shaped, but `/battle` and `/stop` are entries in `CHAT_COMMANDS`, and the token list is derived from it so the two cannot drift. The rule the registry carries is one sentence: **a command not addressed to a specific assistant goes to the primary one.** Each entry declares what varies rather than restating the rule - its match shape (`prefix` takes an argument, `whole` is the entire message), whether it is size-branched, where the flow dispatches it, and its fail direction on an unreadable roster. Adding a command is that entry and nothing else; the flow, the router, and the completeness guards all read it.

  **A command sent privately reaches both entries, and the entry that can see the `Target` decides.** The flow callback carries no `Target`, so the flow dispatches a private `/stop` exactly as it dispatches a public one, and `TargetedMessages: ALL` invokes the addressed assistant's Lex as well. So the Lex entry answers an unaddressed command in a room (reaching Lex there means it was targeted), and the flow's dispatched copy reads the stored message and stands down when it carries a `Target` (`lib/private-command.ts`). An unreadable stored message is treated as public, so a public stop is never lost to a failed read. *Verified by* `backend/test/lib/a-private-command-is-answered-by-the-lex-entry.test.ts`.

  Each of those four fields exists because a command already differs on it. `/battle` is `prefix` and not size-branched, because the flow answers a duel at every size and there is no size at which the Lex entry should answer as well; it dispatches to its own handler, because a duel fans out across two assistants and is not a turn the primary runs. `/stop` is `whole`, so `/stop the report and summarize it instead` stays a redirect on the judged path; it is size-branched, so the router keeps the 1:1 path it already had; and it is the one command answered rather than stood down on an unreadable roster, because an unanswered stop is worse than a duplicated one - the rule `lib/stop-target.ts` already applies on its own path.

  **What is deliberately not a command: any leading slash.** `/foo`, `/tmp is full` and a pasted path stay ordinary text and start no turn. Treating every slash token as a command would route messages nobody addressed to an assistant, which is the same over-match the `@` prefilter and the `.` private prefix both already refuse.
- **The router's stand-down guard has to match the same shape.** In a 1:1, `AUTO` invokes the handler on every message regardless of mentions, so the flow taking the turn is not enough: the router must recognize the token on the Lex entry and decline, or the turn is answered twice. That is not a new hazard, it is the one that produced two answers when `/battle` was added and the router's guard still named only `@all`.
- **The flow now needs the channel roster to route.** Resolving `@sam` means knowing who is in this conversation, on the critical path, for every message carrying an `@`. Today the flow reads membership for `@all`'s member-count branch and for `/battle`, so the read exists; what changes is how often it happens.
- **The 1:1 member-count branch does NOT fall out, and this is the trap in the direction.** It looks like a special case that a uniform rule retires, and it is not: it is the root-cause fix for a measured incident. In a 1:1, `AUTO` invokes the handler on every message whatever the flow does, and the flow cannot prevent that without denying a person's own message. So both entries run, and they derive correlation ids by different rules - the flow declares the inbound `MessageId`, the Lex path provably has none - so the duplicate-placeholder claim sees two incomparable identities and denies nothing. Measured 2026-08-12: two placeholders 558ms apart, one stranded at "One moment..." permanently. Routing more tokens through the flow does not touch that cause; it multiplies the tokens it applies to.
  - **What would earn its removal** is making the two identities comparable rather than making the rule uniform. The router now resolves the inbound `MessageId` by content match on the handler-answered path and keys its correlation from it; doing the same on an `@` turn would make both entries derive `mention-<MessageId>`, and the existing claim would collapse them as designed. That costs a channel read on the Lex entry, which is the trade already accepted for pairing accuracy.
  - **Or it stays and is named for what it decides.** In a 1:1 there is one assistant, so `@<assistant>` names the only destination there is: the flow has no routing decision to make and defers to the entry Amazon Chime SDK invokes anyway. Read that way the branch is not "is this a group" but "is there anything to route", which is true whatever the token vocabulary becomes.
- **A mention that resolves to nobody must fail loudly.** `@sam` where Sam is not a member is a message the person expects to reach somebody. Releasing it as prose is the silent-drop failure the mention parser already refuses for a different case.
- **`@all` delegating is the existing handover, not a new mechanism.** The default assistant answering and passing the work onward is what [ADR-030](./030-a-message-is-answered-by-the-assistant-whose-work-it-answers.md) already decides; this direction routes `@all` into it rather than inventing a fan-out.

## The measurement that decides this

**Does `StandardMessages: AUTO` invoke an assistant on a `CHIME.mentions` attribute with no `Target`?**

It is asked here rather than assumed because the same question is open in two other places and one shipped path already depends on the answer. The instrument exists: Lex conversation logs are enabled on every classification's bot alias and record every invocation, so a single send with the attribute and no target settles it.

- **If yes:** Option A is the answer for both humans and assistants, it is a small change, and the shipped shared-task-answer path is already correct.
- **If no:** Option A still serves human addressees, the shipped path has a defect that presents as an assistant ignoring a person in public, and assistant addressing needs Option D.

**It is no longer a gate on this work** (owner direction, 2026-09-11): with every `@` routed by the channel flow, nothing reaches an assistant by mention attribute alone, so neither answer changes what gets built. It is still worth one message, because the belief is asserted in two modules and the shared-task-answer path shipped on it - so if the answer is "no", that path has a live defect to fix regardless of this ADR.

**Taken, and the answer is yes (2026-09-15).** The paragraphs above stay as the record of what was open. A person's message carrying only a `CHIME.mentions` attribute naming the assistant, with no `Target`, invoked that assistant's Lex in a room where `AUTO` answers only when addressed; a message carrying neither invoked nothing. So the "if yes" branch holds: the shipped shared-task-answer path is correct, and a group `@<assistant>` produces a Lex entry as well as the flow's dispatch, which is what the handler's stand-down guard exists to absorb.

## Recommendation, for the owner to accept or reject

1. **Take the measurement first.** It is one send and it unblocks the rest.
2. **Adopt the principle regardless of the outcome**: privacy is enforced by `Target` and nothing else; addressing is declared and rendered. Write it where the composer and the processor can both see it. Nothing here removes or weakens `Target` - agent assist depends on it holding, and the 1:1 case depends on it holding INSIDE the conversation rather than by moving somewhere else.
3. **Option E in the composer either way.** Privacy should be something a person chooses, not something that happens to them because they typed a name. The sticky-target chip is where it goes: it is already the control that says who a message is for. Of the surveyed patterns, a `/private` prefix is the cheapest to ship and the hardest to discover, and a toggle on the chip is the one a person can see before they send - which is the property that matters, since the cost of the mistake is paid by whoever gets to read it.
4. **Make it one declared breaking change, now, rather than a staged migration** (owner, 2026-09-11). The staged order protects an established user base and costs a period with two ways to address somebody; at `0.1.0`, before adoption, the second cost is real and the first is hypothetical. It does not get cheaper later.
5. **Option D, generalized: the channel flow routes every `@`.** Directed 2026-09-11. A, B and C are moot rather than rejected - they were ways to reach an assistant without the flow, and the flow now does it for every mention.
6. **Keep the 1:1 member-count branch through this change** (agreed 2026-09-11). It reads like a special case a uniform rule retires, and it is the root-cause fix for a measured duplicate. Removing it belongs to its own change with its own test, because the failure it prevents is silent: the last time it was absent, nothing errored and one placeholder simply never closed.

## The token grammar, and why a delimited form exists

**What follows the dot has to BE a member's name**, because the only thing done with it is resolving it to that member's id. A grammar that cannot express some names therefore cannot do its job, and the first two attempts could not.

- A **character class** (`[A-Za-z0-9._-]`) excluded every human on a deployment that names members by email address: `.someone@example.com hello` matched nothing, so the message was not private and went to the room.
- A **bare run of non-space characters** fixed that and still could not express a name containing a space: `.Ryan McHarg hello` yields the token `Ryan`, which names nobody.

So there are two forms, and the picker writes whichever the name requires:

| Form | When | Example |
|---|---|---|
| Bare | the name has no space | `.Alice are you free` |
| Delimited | anything else | `.<Ryan McHarg> are you free` |

**Angle brackets follow the convention every major client already uses** to delimit a mention target: Slack `<@U123>`, Discord `<@123>`, Google Chat `<users/123>`, and Microsoft Teams `<at>Display Name</at>` - the last of which, like this one, wraps the NAME rather than an id. There is no new idea to explain.

**They also survive our renderer, which is what ruled out the other precedent.** Zulip's `@**Full Name**` is the closest prior art for delimiting a name so it can contain spaces, and it is wrong here: bot messages render through remark-gfm, where `**` is bold and the delimiters would vanish. A private prefix only ever appears in a USER message, and those render as React-escaped plain text, so brackets reach the reader exactly as typed.

**The safety is the roster, not the grammar.** A token means something only when it equals a member's name in full, so widening what is *extracted* cannot make a message private by accident - `.env is missing` extracts `env`, names nobody, and is ordinary text. That is why the class was the wrong tool: it was doing safety work that the full-match already does.

**Which makes the display name load-bearing, and it must not be self-settable.** A `.` address resolves to a member by their display name, and the credential exchange copies Cognito's `name` into the display name every member sees, so a self-settable name would let somebody take another member's name and have private messages addressed to that person resolve to them instead. The pool clients' write list is narrowed to `email` and `custom:tier` for exactly this reason (`selfWritableAttributes`, `backend/lib/stacks/identity-stack.ts`); names are set by an administrator or by the identity provider. Anyone extending private addressing - a second token, another surface, a different resolver - inherits that dependency and must not widen the write list to restore it.

**What is still unexpressible** is a name containing `<` or `>` itself, and the picker omits exactly those members rather than offering an address it cannot honour.

## A private address must carry the `Target` its text names

**A message whose `.` prefix resolves to a real member, but whose stored `Target` does not agree with that text, is not private in the way its sender believes, and it is dropped (owner, 2026-09-15).** There are two ways to disagree and both disclose. A message with no `Target` at all goes to the whole room while its sender believes it went to one person. A message whose `Target` names a DIFFERENT member goes to one person, the wrong one: `.Alice hello` targeted at Bob puts words written for Alice in front of Bob, and Alice receives nothing. The web composer always sets the `Target` that matches a resolved dot, so either shape reaching the flow means a client did not.

The flow's callback does not carry `Target`, so the rule reads the stored message back (`enforcePrivateAddressTarget`, `backend/lambda/src/lib/private-command.ts`), and only for a message whose prefix resolved to a member other than the sender, so ordinary traffic pays no read. **A message the flow is still holding cannot be read at all** (measured 2026-09-15: `GetChannelMessage` during the callback fails for a targeted and an untargeted message alike), so there is nothing to decide before release. The message is released once, exactly as any other, and then read back, with one retry after a short pause:

- **Its `Target` names the member the text addressed.** It proceeds as sent.
- **It carries no `Target`.** It is **kept**, and the sender is told privately that the room can see it. When the address named an ASSISTANT the turn is routed to that assistant, which answers the sender privately. *(Amended 2026-09-16; this branch deleted the message until then. See "The untargeted branch was reversed" below.)*
- **It carries a `Target` naming somebody else.** It is **kept**, and the sender is told in a line of its own: the member they named received nothing, and somebody else received it.
- **It is not readable.** It proceeds as sent, and the read is logged. The rule exists to stop a disclosure, not to add a way to lose a person's words.

**Neither branch deletes any more (owner, 2026-09-16), and the reasoning is worth keeping because the deleting version looked like the cautious one.** **The delete never unsent anything:** release happens before the read, so by the time the stored `Target` comes back, whoever the message reached has already had it. The delete only shortens the window on a disclosure that already happened - while destroying the person's words, which it does permanently and they did not ask for. **And on the untargeted branch it cost them their turn** for a defect in their client: they got a notice and no answer.

This was first applied to the untargeted branch alone, on the argument that a misdirected message sits in front of exactly one member rather than the room, so deleting it takes the words back from that member. **That argument does not survive the same objection.** The wrong member has already received the message and may already have read it, so the delete no more unsends it there than it does in the room. It buys the same nothing and costs the same words. So both branches keep the message, and the choice to delete it belongs to whoever wrote it.

**What differs is only the notice, because the two disclosures are different.** No `Target`: the room can see it, and if the address named an assistant the turn is routed there and answered privately - the answer is the longer and more revealing half of the exchange, and the half that can still be kept. The wrong `Target`: one member who should not have it can see it, the person named received nothing, and re-sending is the remedy - which it is not on the other branch, where it would put the message in the room a second time.

**A consequence worth recording: this path removes nothing and needs no privileged bearer.** The app-instance admin was resolved solely to delete, so the flow no longer reads that parameter and no longer holds `chime:DeleteChannelMessage`. The withdrawn grant is the second layer: restoring the delete without re-deciding the policy fails on permissions rather than quietly working.

**The comparison is the check, and existence alone was not (2026-09-16).** Until this was fixed the read answered only "is a `Target` set", so a client could write `.Alice` and set the `Target` to Bob and the message passed as properly private. The member the text names is already resolved against the conversation's roster on this path, because the check runs only for an address that resolved, so comparing the two is a local equality test on member ARNs and needs no lookup of its own. There is nothing else that could answer it: the roster is the only thing that knows who `.Alice` means.

**A mismatch is refused rather than let through or reworded, and the three outcomes that already existed are each wrong for it.** Proceeding is a disclosure, and the quiet kind: Bob reads what was meant for Alice, Alice reads nothing, and nobody involved is told. Treating it as untargeted says the wrong thing, because `privateMessageNotPrivate` tells the sender the ROOM can see their message and on this branch the room cannot - one wrong member can. Logging it and moving on, the way an unreadable message is handled, treats a disclosure as a diagnostic. So the sender is told, in configured copy under its own key, `privateMessageWrongTarget`, resolved the way the other notices are. That line must not claim a removal, because there is none.

**A mismatch is counted on its own metric, `private_message_target_mismatch`, beside `private_message_without_target` in `AgentEchelon/ChannelFlow`**, each with a dimensionless series to alarm on. Both carry the same second dimension, `Disposition` (whether an assistant or a person was addressed), since neither message leaves the conversation and what matters is who was named and whether a turn can follow. The `Path` dimension they used to share described how the message was removed, and nothing is removed. Two client defects, two series: "the composer set no target" is a message that went to the room and "the composer set somebody else's" is a message that went to one wrong person, they want different alarms, and a single count would hide the sharper one inside the noisier one.

**Which mismatches are visible at all, stated so the check is not read as more than it is.** The comparison happens only on a message the bearer can read, and the same measurement that makes an unreadable message the expected case says which those are: a targeted message is readable by its sender and its target and by nobody else, the app-instance admin included. The flow reads as the assistant and never as the sender, so the mismatches it can see are the ones whose stored `Target` names THE ASSISTANT, which is where a misdirected private message actually lands. A message targeted at a third PERSON reads as unreadable, which is also how a correctly targeted one reads, and no bearer exists that could tell those two apart. Guessing from an unreadable read is the alternative, and it would delete correctly targeted private messages, the common case, to catch a client defect. The counter is what tells an operator the defect is happening.

**"Deleted" means removed from the conversation, not erased, and the difference is worth stating (2026-09-15).** The message was released before the read, so Amazon Chime SDK had already mirrored it to the Kinesis stream with its content intact and every consumer took it: the S3 archive is append-only and keeps the row, and in Aurora mode the projection keeps it too. The delete adds a `DELETE_CHANNEL_MESSAGE` event, which in Aurora mode is the `-DEL` sibling an admin read masks the content from (`backend/lambda/src/analytics-aurora/admin-conversations-aurora.ts`). **The Athena-mode admin read applies no `-DEL` masking**: it selects on a redaction flag alone (`backend/lambda/src/admin-conversations.ts`), so on that path the archived row is returned as stored. That last part is read from the query rather than observed against a live archive, and is recorded as not established rather than asserted either way. So this rule bounds who in the ROOM can read the message; it makes no claim about the archive, and an erasure request is the archive's own question.

**The delete's bearer is the service app-instance admin, not the assistant** (measured 2026-09-15: the assistant's `DeleteChannelMessage` on a person's message is refused with `ForbiddenException`, the admin's succeeds). The flow resolves that ARN from SSM (`${SSM_ROOT}/app-instance-admin-arn`, `ADMIN_ARN_PARAM`) only on this path, and caches it per container.

Every branch that acts sends a notice to the sender alone, a `Target` naming them, in the deployment's configured copy, with a neutral fallback: `privateMessageNotPrivate` when no `Target` was set and the address named a person, `privateMessageNotPrivateAnswering` when it named an assistant and the turn is being answered privately, and `privateMessageWrongTarget` when one named another member. There is no refused-delete case left, because nothing is deleted. Either way the flow records a potential client defect: a structured warning with the channel, the message id, whether the addressee is an assistant, and either the disposition or the path, never the content, and one count on the metric for that defect, whose dimensionless series is the one to alarm on.

**The residual recorded here on 2026-09-15 is RESOLVED on both branches, by the reversal rather than by writing the missing lines (2026-09-16).** The gap was that a refused delete told the sender nothing, so their message stayed where it had gone and they went on believing it was private - the disclosure this rule exists to prevent, arriving with no signal to the person it happens to. Neither branch deletes now, so there is no delete to refuse and no silent path: **the sender is always told, and each notice says the thing that is true.** The lines the old branches needed - one saying the message went to the room, one saying it is still with somebody else - are exactly what `privateMessageNotPrivate` and `privateMessageWrongTarget` now say. It was cheaper to stop deleting than to write notices for a delete that should not have been happening.

That covers the mismatch branch too. `privateMessageWrongTarget` no longer claims a removal - it says the person named did not receive it, somebody else did, and the message is still there - so it is true whether or not anything could have been deleted, which is what made the old line unsendable.

**The read is made as the primary assistant, not as the sender**, because the flow acts as itself, and an assistant reads a message only as its sender or its target. So for a `.` address naming a PERSON, unreadable is the expected signature of a message that genuinely carries a `Target` naming that person (measured 2026-09-15: after release, such a message is unreadable to the assistant and to the app-instance admin, while an untargeted one is readable by every member and reads as untargeted). Proceeding is correct there rather than a gap. For a `.` address naming the ASSISTANT, a targeted message reads as targeted, so unreadable is a genuine read failure; it proceeds too, and is logged as a warning.

**Not in scope.** A private message arriving from another surface (an inbound SMS or email marked private) is to be parsed into a targeted message sent on the sender's behalf; that ingress does not exist yet.

*Verified by* `backend/test/lib/a-private-address-without-a-target-is-routed.test.ts`.

## What building it changed, beyond what was designed

Three things were not visible from the design and are recorded because each is a decision somebody could otherwise reverse by accident.

**An `@` at a person notified nobody.** The composer put only an assistant's ARN in `CHIME.mentions`, so "an `@` mention notifies the member it names" was true of assistants and false for every person - a human mention was plain text that happened to start with a punctuation mark. With the flow deliberately starting no turn for it, nothing at all would have reached the person named. The attribute now carries every resolved member. A `.` message is excluded from it: a `Target` already routes that one, and adding the attribute would give a targeted assistant a second way in.

**The fail direction had to become per token.** When the roster cannot be read, the handler still stands down for `@all` - the flow's own unreadable-count path dispatches, so it answers - but it now ANSWERS any other `@`, because the flow faced the same failure, resolved nobody and dispatched nothing. One rule for both would, during an Amazon Chime SDK outage, silence every message containing an `@`, including "meet @5pm". Silence is the right direction only for a message the flow is certain to have claimed, and after widening the guard that is no longer the same set as "the guard fired".

**The roster is read once and carried.** `resolveChannelSize` already listed memberships to count them and discarded the list; it now returns it, and paginates, which it did not need to when one page settled "is this exactly two members?" but does need to for "who is in the room". Two reads moments apart can disagree, and the two sides would then resolve the same mention differently - the drift the shared seam exists to prevent, arriving through the back door.

## What this does not settle

- **Private to more than one person.** `Target` holds one member, so "just you two" is not expressible at all, and nothing above changes that. It would need N sends, which the mention parser already declines to build without a use case.
- **What the ROOM sees of a private exchange.** The task layer already answers a version of this - a private work item is room-visible as an existence with its details stripped - and a private message today is invisible entirely. Whether those should agree is a separate question.
- **The reply's visibility.** The processor decides that from the inbound message and from where the placeholder was posted. A directed-public request should get a directed-public answer, and that is a change to the same decision rather than a new one.
- **Which of two assistants answers an `@` that names one of them.** The flow resolves the named ARN and posts as it, so an addressed assistant's own name is on what appears in the room. It does not choose which assistant RUNS the turn: `handOffTurnToRouter` invokes the router for the channel's classification, and that router resolves its own bot. In a room holding two assistants of the same classification the answer still comes from whichever one that router serves. It is the same gap [ADR-030](./030-a-message-is-answered-by-the-assistant-whose-work-it-answers.md) records at `resolvePrimaryBotArn`, and closing it needs a way to say which assistant is which, not a change to the mention branch.
- **Whether an assistant can address a person PUBLICLY.** The private direction is in scope above and is on measured ground: a bot-authored targeted message was sent, reported `SENT` and invoked the channel flow ([ADR-023](./023-battle-round-coordination.md)); what that measurement leaves contested is only whether a bot-authored target reaches another BOT's Lex, which agent assist does not need because it addresses a person. An assistant addressing someone publicly is the same question this ADR asks from the other side, and inherits whichever answer it gets.
- **What a client does with a declared action it does not recognize.** "Prepopulate the composer" is one instruction; there will be others. A client that renders an unknown one as prose would display the very payload that was meant not to be displayed, so the safe default is to show nothing and say so - the same fail-closed rule the marker strippers already follow.
