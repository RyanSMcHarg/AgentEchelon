# Walkthrough: manage an assistant, add a new one, and put assistants to work together

Setup (deploying, seeding the demo company, creating the demo users and the demo alarm) is in [README.md](README.md) in this folder. This walkthrough starts once that is done.

## Presenting it: the incident first

Open with a short intro, run the incident response live, then explain how it works. Everything in "Before the demo" is done before the audience arrives, so the live part starts with the outage.

1. **Intro, one minute.** AgentEchelon runs in your own AWS account, every person, assistant and conversation is an AWS resource acting as itself, and access is an IAM decision on the conversation's classification. Then: "Here is an outage."
2. **Run the incident**, the steps under "Run it" below.
3. **Explain how it works**, from what the audience just saw:
   - It was one process, measured end to end: **Performance**, **Processes**, **Incident response** (3.3d), then the same process in the wizard and its flow view.
   - Each assistant acted as itself: Ops read CloudWatch on its own session and Advisor could not (3.3, 2.4); the dashboard is readable by exactly the conversation's members (3.3c).
   - The people came from a group and the assistants from the conversation type; nobody was copied in (3.2).
   - The workflows, templates and process are the team's data, changed and rolled back without a deploy (1.5, 1.6, 1.10, 3.4), while Ops's new reach was a reviewed deploy (Act 2).
   - Customer messaging ran beside the incident and never held it up (3.3b-2).

Every command below runs from `backend/` in a Bash shell, with your AWS profile set once:

```bash
cd backend
export AWS_PROFILE=<your-profile>
```

### Before the demo, once

**1. Deploy and seed the company.**

```bash
npm run deploy
npm run validate -- --only=seed
```

**2. Create the demo's people.** Jordan Reyes is the on-call and owns each incident. The seed (step 1) creates the account team's CSMs; Maria Santos leads it and approves the customer notices. Passwords are in the `agent-interface/demo-credentials` secret.

```bash
npm run provision-test-users -- --cast ops-demo
```

**3. Add Ops, with the incident's workflows and its process.**

```bash
npm run add-assistant-role
npm run ops-workflows -- add
```

**4. Publish Advisor's two templates.**

```bash
npm run template -- put premium ../demo/portable-assistants/templates/advisor-incident-alarm-changed.md --assistant advisor --activate
npm run template -- put premium ../demo/portable-assistants/templates/advisor-invitation-sent.md --assistant advisor --activate
```

**5. Create the outage alarm**, `Customer-API-availability`, with a healthy baseline. It is named for the service it watches, so the incident it opens is too, and its description says what the Customer API does for its users, which the incident and Ops's first look read. It prints the alarm's ARN.

```bash
npm run demo:outage -- setup
```

**6. In the console:** **Users**, **Manage users**, and under **Groups** tick **ops** for Jordan Reyes, Priya Raman and Marcus Lee.

**7. In the console:** **Assistants**, Ops, **Workflows**, open `incident-triage`. Under **What starts this workflow**, choose **A resource's ARN (an alarm)**, paste the ARN step 5 printed, and choose **Attach**. This also opens the operations team's conversation.

### Before the demo, every time

**8. Clear earlier runs.** Put the time of the last run in `--since`. The first command lists what goes; the second deletes it.

```bash
npm run reset-demo -- --since=2026-11-18T00:00:00Z
npm run reset-demo -- --since=2026-11-18T00:00:00Z --apply
```

If an e2e run has used this deployment, delete its conversations first:

```bash
export VITE_USER_POOL_ID=$(grep '^VITE_USER_POOL_ID=' ../frontend/packages/chat/.env | cut -d= -f2)
node scripts/delete-conversations.mjs --created-since=2026-11-18T00:00:00Z --only-test-people --apply
```

**9. Reset the outage data**, so the alarm is `OK`.

```bash
npm run demo:outage -- reset
```

**10. Re-add the assistants to the operations team's conversation**, so their welcomes are said again.

```bash
npm run demo:team-room
```

### Run it

**1. Start the outage.** The alarm fires within about two minutes, and the data recovers a minute after the incident conversation's call starts.

```bash
npm run demo:outage -- outage --recover-on-call
```

2. Sign in to the chat client as Jordan Reyes. When the alarm fires, the incident conversation opens at once, and Ops tells everyone in Ops Team Main why, mentioning Jordan, with a link to it.
3. Open the incident conversation from that link. Work the incident owner task, read Ops's first look, and start the call. On the **Customers impacted?** card, choose **Customers impacted** to start customer messaging, then follow the runbook.
4. As Maria Santos, approve the initial customer notice in the customer messaging conversation within 15 minutes.
5. As Jordan Reyes, choose **Resolve** on the incident card, mark the root-cause investigation complete, then complete the post-incident review Ops drafts.
6. In the console, **Performance**, **Processes**, **Incident response**: the incident as one process, with each stage's time and cost.

What each step shows is in 3.2 to 3.3d. To run it again, repeat steps 8 to 10.

## What this demo shows

AgentEchelon is a self-hosted agent control plane that runs in your own AWS account. Every person, assistant and conversation is an AWS resource with an ARN, every actor holds its own identity rather than a shared backend credential, and access is an IAM decision keyed on the conversation's immutable classification tag, evaluated before a request runs and failing closed.

The demo follows one assistant end to end, then adds a second one, and draws one line throughout:

- **Behavior is data.** A persona, models, intents, welcomes, workflows and message templates are changed by the assistant's team, with no deploy, and rolled back in one click.
- **Reach is infrastructure.** A new assistant role, a new tool or a new context source changes IAM or code, so it is reviewed and deployed.
- **New assistants are runtime operations.** An assistant created in an assistant role that already exists reaches exactly what that role reaches, so there is nothing new to review.

The demo company is Stratum Technologies, a fictional enterprise SaaS company. Three assistants appear on the `premium` classification:

| Assistant | Assistant role | Reaches |
|---|---|---|
| `advisor` (Advisor) | `primary` | premium's company context |
| `ops-premium` (Ops), added in Act 2 | `ops` | basic and standard company context, plus this deployment's own CloudWatch metrics and alarms |
| `sentinel` (Sentinel), created in Act 3 | `ops` | exactly what the `ops` role reaches |

Same classification, different assistant role. An **assistant role** (`primary`, `ops`) is the job an assistant does in a classification. It is not an IAM role of its own: each classification has one IAM role, and every turn assumes it on a fresh session tagged with the assistant, its assistant role and its identity. IAM statements are conditioned on those tags, and the session is then narrowed to what the assistant's approved definition selects, so a definition can only narrow.

Every conversation has exactly one **primary** assistant, recorded on the conversation as its `primaryAssistant` tag. When `@all` asks the conversation, the primary answers and decides whether another assistant should take the work. Every other assistant speaks only when named, when handed the work, or for work it already owns. In a group conversation, a message that names nobody is people talking to each other, and no assistant answers it.

## Act 1. One assistant, end to end

This act shows a person's experience first, then the configuration that produced it.

### 1.0 Two clients, one identity

The **chat client** is what people use: conversations with people and assistants. The **admin console** is what operators use: assistants and their configuration, people and their access, conversations and analytics.

Both clients sign in against the same user pool with the same account; each keeps its own session. Being in the `admins` group lets that identity into the console, and even then it holds no standing admin power:

- Opening the console vends a short-lived console session (an hour by default, fifteen minutes for a team member), audited when issued.
- A critical action (reading a conversation's messages, redacting, changing membership, opening an attachment) vends its own credential: it asks for a reason, is scoped to one conversation, expires in thirty minutes, and is written to the access log before it is returned. If the log write fails, no credential is issued.
- The console acts as a separate `-admin` identity, so nothing done there can be mistaken for something the person said in a conversation.

**Do:** sign in to both clients as the administrator. Optionally, sign in to the console as a premium user who is not an administrator: the console refuses, while the chat client works for them as usual.

Step-up authentication for critical actions is **NOT BUILT** (MFA is optional on the pool).

### 1.1 A new conversation

**Do:** in the chat client, **New conversation**, choose **Premium**, then **Create Conversation**.

**Notice:** there is no type picker. This is a conversation of the ordinary type, `general`, at the classification just chosen. A type decides who is added, how long the conversation lasts and whether it can split when the subject changes; this one adds only the classification's primary assistant, Advisor. Nobody added Advisor by hand.

A **classification** names what an assistant may reach, enforced by IAM: premium reaches financials, customer accounts, the board summary and competitive intelligence, as well as the directory, internal processes and the roadmap. An **assistant** is configured for a job on top of that. Neither is an org chart.

### 1.2 The welcome

**Notice:** Advisor's welcome is posted the moment it joins, and it is assembled with no model call from context the deployment provides for the classification: the company, what this classification can reach, three example questions, a note that it also knows the platform it runs on, and the conversation's topic when it has one. It does not use the person's name.

A welcome is chosen per assistant, per conversation, most specific first:

1. The assistant's own welcome for this conversation type. The welcome is a workflow on the assistant's versioned profile, started when the assistant joins (`assistant-joined`). Its first step is the **opening**, said with no model call; a prompt turn may follow it.
2. The assistant's own welcome for every other conversation, when it sets one.
3. The platform's welcome, which for the classification's primary is the classification's orientation. A second assistant in the same classification never borrows it.

Opening text can name fields the conversation itself supplies: `{{topic}}`, `{{priorSubject}}` and `{{priorMessage}}` for a conversation spun off another, `{{eventSummary}}` when an event opened it, `{{visitSummary}}` when a visit carried over, plus `{{role}}`. A line whose field is empty is left out.

A team cannot put per-conversation facts into its profile, because a profile applies to every conversation. Host-supplied fields in the welcome (for example, a landing page greeting a visitor by name and the role they applied for) are **NOT BUILT**.

### 1.3 Two questions, two paths

**Do:** ask `What is AgentEchelon?`

**Notice:** the turn is classified as a platform question and answered with the `load_platform_info` tool, which reads a curated summary of this project's documentation. How deep it goes is set per classification.

**Do:** ask `What's our current net revenue retention?`

**Notice:** Advisor offers to start a separate conversation, because a revenue figure is a new subject. Keeping one subject per conversation is what makes its history, summary and analytics mean something. The person decides.

**Do:** reply `no`.

**Notice:** the figure, stated exactly, with its period. The turn was classified as a financial metric and answered with a different tool, `load_company_context`, reading premium's company context. The model that answers is chosen per intent from a routing table on the assistant's version; an intent with no route uses the default model. The conversation record shows "New subject flagged · kept in this conversation" where it happened.

### 1.4 How it is configured, and how it got that answer

**Do:** admin console, **Assistants**, `advisor`.

**Notice:** the active version, one section at a time. The header shows the classification and assistant role, **Active vN**, the version's `configId`, and links to **Effectiveness for vN** and **Conversations**. The left menu lists **Behavioral**, **Workflows**, **Purview**, **Tools and context**, **Variables** and **Versions**.

- **Behavioral:** the display name and persona, and **Classification and role**, fixed for the assistant's life.
- **Purview**, in the order a message meets them: the **Classifier model**, the **Base model**, **Intent classification**, **Routing rules**, then one card per intent with its **Model** and **Fallback**. Image generation is the same table: an intent routed to an image model generates an image. A fallback is tried only when the primary fails on the model side, never when it refuses on content grounds.
- **Tools and context:** the tools it may call, the guardrail, the context rows, limits, and the AWS resources that serve it. **Company documents** reads "Included on every turn": the titles and summaries of the documents the role may read sit in the cached part of the prompt, and `load_company_context` fetches a document only when a question needs it. **Additional context sources** lists `user-profile`, which finds no record for a person who was never onboarded and is skipped, not failed.

Company knowledge, assistant configuration and what people put into conversations live in separate buckets with separate owners, so no grant written for one can reach another.

**Do:** **Versions**, **Export manifest**. Open the file and look at `intentPack`, `contextSources` and `eventWorkflows`. The manifest is the whole version in one file. It moves between AgentEchelon deployments, and the receiving deployment checks it against its classification, refusing a model it does not allow or a source it does not publish.

**Do:** **Oversight**, **Conversations**, find the conversation from 1.1 and open its messages.

**Notice:** the console asks "Why are you opening this?". This is the per-action credential from 1.0: one conversation, thirty minutes, logged before it is issued.

**Do:** open the revenue reply's inspector (**Info** on the message).

**Notice:** the intent and model as badges, then `inputTokens`, `latencyMs`, `routerSteps`, `guardrailFindings` and `configId`. The `configId` matches the version on the profile page: the link between how the assistant is configured and what it did. These are raw fields, not a laid-out explanation, and which company context a turn loaded is not recorded per turn (**NOT BUILT**).

### 1.4a The assistant's page, section by section

**Do:** walk Advisor's menu top to bottom.

1. **Behavioral.** The name and persona are what a team writes in its own words. Classification and role are reach, and reach is Act 2.
2. **Workflows.** Advisor has none of its own yet. **Show shipped workflows** adds the platform's welcomes and event workflows to the lists, each marked **Shipped**, with its trigger and whether it **Runs by default** or runs only once copied into a version. Advisor's own workflows ride its version: drafted, validated, activated and rolled back with it. The shipped ones are read-only; a draft copies one in to vary it.

   Under **Task workflows**, open `report_generation` with **View steps**: its steps in order (`collecting_requirements`, `drafting_outline`, `generating`, `revising`, `completed`), which ones wait on the requester, what each needs before moving on, and the document templates its delivering step offers. The model can only ask to move between steps, and code decides.
3. **Purview.** Each intent is a card: **Single turn** or **Multi-step**, a **Performance** link, its purpose, an **Instructions** expander, and its **Model** and **Fallback**. On `financial_metric`, **Instructions** says to state the figure, its period and its source, and stop: that is why 1.3's answer was one exact figure. The instructions come from the classification's intent pack; the model is Advisor's choice.

   **Do:** **Performance** on `financial_metric`. The console opens **Effectiveness** filtered to Advisor and that intent, with 1.3's turn among what it counts. The link is a real URL, so it can be shared.
4. **The draft.** **Edit** in the header. The toggle reads **Draft (0 changed)** and a banner says the active version keeps serving until the draft is activated, with **Discard draft**, **Validate** and **Activate draft as vM**. There is no separate editor: each section holds its editable area, each area saves on its own, and a dot appears beside a section once its edit lands.

An area's unsaved edits are dropped when you switch sections or flip the toggle, and saving any area reloads the draft, so save one area at a time.

### 1.5 Change the persona

**Do:** in the draft, **Behavioral**, change the **Persona** to something unmistakable:

> Thou art an advisor of the premium tier. Speak always in Early Modern English - "thee", "thou", "hast", "verily". Answer the question plainly beneath the olde speech; never let the manner obscure the matter.

**Save draft edits**, then **Validate** and **Activate draft as vM** in the banner.

**Notice:** before activating, **What the draft changes, field by field** lists `persona` as changed.

**Do:** in the conversation from 1.1, ask `How does that compare with last quarter?`

**Notice:** within about 30 seconds the answer is in Early Modern English and still grounded in the same figures. No deploy and no restart: each turn resolves the version the `active` label points at. The reply's inspector shows the new version's `configId`.

### 1.6 Roll it back

**Do:** **Versions**, **Roll back to vN** on the version from before 1.5.

**Notice:** within about 30 seconds Advisor speaks normally again. Activation is a pointer move over immutable versions, so rollback is the same operation reversed. That is what makes editing a live assistant safe, and why Act 2's gate is about reach rather than behavior.

### 1.7 The same question, on basic

**Do:** in a separate browser profile, sign in to the chat client as the basic user, start a new conversation, and ask `What's our current net revenue retention?`

**Notice:** basic's primary, Concierge, joins with a welcome built the same way from basic's context ("public access: products, pricing, and support information"), and it declines the question, pointing to a company contact rather than guessing. Two layers stand behind that:

- **Configuration.** Concierge has no intent that answers a financial question, and its persona tells it to say plainly when something is internal.
- **IAM.** Even if Concierge were configured to try, its session acts for the basic classification, and IAM denies a basic session premium's company context. A configuration mistake cannot widen reach. `tests/e2e/assistant-classification-boundary.spec.ts` proves that denial against the deployed policies.

### 1.8 Rewrite the welcome

**Do:** back as the administrator, Advisor, **Workflows**, **Edit**. Above the **Event workflows** builder, **Copy the built-in welcome in to edit it**. **Edit as a list**, pick `welcome`, and in its opening step write under **Opening text**:

```
Welcome to Stratum's premium workspace. I can pull financials, team metrics, customer accounts and the board summary.

Try one of these:
- Compile a report on our Q2 ARR performance for the leadership team
- Extract the enterprise accounts flagged as churn risk as a table
- What's our current net revenue retention?

This conversation is about {{topic}}.
```

Under **Preview**, step through the sample conversations.

**Notice:** the last line appears only for **Started with a topic**, and is left out for the others. The preview renders through the same functions the router uses, so what it shows is what the conversation gets.

**Do:** **Save draft edits**, **Validate**, **Activate draft as vM**, then start a new premium conversation.

**Notice:** the new opening within about 30 seconds, with no topic line. The welcome is part of the version, so it changed the way the persona did, and rolls back the same way. Roll it back now (**Versions**).

### 1.9 The assistant's own words, in the reader's language

Every other line Advisor posts for a platform event (a private welcome, an ops conversation's opening, an alarm announcement, a reminder) is a **message template**.

**Do:** Advisor, **Messages**. Press **Edit** on `workflow-subject-welcome`.

**Notice:** **In use: the shipped template**, then the shipped text, the classification's (none), and **This assistant's own**.

**Do:** under **This assistant's own**, reword the chat section in Advisor's voice:

```
# chat
Welcome[[, {{name}}]]. I'm Advisor. Ask me for a figure, an account or a report, and I will say where it came from.
```

Under **Languages**, add a Simplified Chinese variant:

```
# chat@zh
欢迎[[，{{name}}]]。我是 Advisor。您可以向我询问数据、客户或报告，我会说明出处。
```

**Preview** each language, then **Save and use**.

**Notice:**

- **The words are the assistant's.** A message is said from the assistant's own template, else its classification's, else the shipped one. A line naming a field with no value is left out (the `[[ ]]` brackets).
- **The language comes from records.** A message one person reads is in that person's chosen language, then the conversation's, then the deployment's; a message the conversation reads uses the conversation's. Only languages the deployment declares are candidates, and nothing anyone typed chooses one.
- **It is in use at once.** A template is an immutable body behind a pointer, with **Return to the previous version** as its rollback. It is the template store's, not part of the version, so nothing here adds a dot to the draft.

### 1.10 The workflows an event starts

**Do:** in the same draft, **Copy the built-in welcome in to edit it** again and pick `welcome`. A welcome's first step is the opening (instant, no model call); a **Welcome prompt turn** may follow it, taking one metered turn with only the read tools the version allows, and if it is late, fails or is over budget the opening stands alone. **Reset** the area so nothing is left unsaved.

**Do:** scroll to the **Event workflows** builder: the workflow picker and **Add an empty workflow** along the top, the palette of steps (**Say**, **Do**, **Decide**, **Finish**) on the left, the canvas in the middle with the triggering event at the top, and **Step settings** on the right.

**Do:** create `greet-joiner`: **Runs on** `person-joined`, **Conversation types** `general`. On its `opening` step, **To** "The person who joined, privately", **Message template** `workflow-subject-welcome`, and mention the person the event names in the `name` field. Do not save yet.

**Notice:** a value's trust decides what it may do. Platform, operator and closed-list values are inserted and may decide; text a person or an outside system wrote is inserted, stripped and capped, and never decides. A fact about one person reaches only a message addressed to that person; the conversation reads a member's name only as a mention.

Naming a version variable has no console control (**NOT BUILT**): it is JSON in a draft patch, `npm run assistant -- draft advisor --patch <file.json>`.

### 1.10a Build a workflow on the canvas

This workflow tells the inviter privately that an invitation is out, then gives the inviter a task with a deadline. Scene 1.11 runs it.

**Do:**

1. Create `invite-sent`, **Runs on** `invitation-sent`, no conversation types.
2. Select `opening`. Rename it `tell-inviter`; **To** "The member who sent the invitation, privately"; **Message template** `advisor-invitation-sent` (a message template of Advisor's own, saved as in 1.9; any template the step accepts works).
3. With `tell-inviter` selected, palette, **Do**, **Start a task**. Name it `confirm-link`; **Task machine** `acknowledgement`; set both **For** and **Done by** to "The member who sent the invitation, privately" (a new task step starts out for the person the event names, who here is the invitee); **Priority** High; ends after `60` minutes if nobody finishes it.
4. Under `confirm-link`, click the **If the deadline passes** port, then click `done`. An amber **Deadline** edge joins them.
5. Drag the steps so the edges read clearly, or move them with Tab and the arrow keys. Where a step sits is saved with the draft and changes nothing the assistant does.
6. **Edit as a list** shows the same workflow as a numbered list; both views make the same edits.
7. **Preview run**, once with **It succeeds** and once with **Its deadline passes**. The walk runs through the runtime's own runner on the server, with sample people, and sends and writes nothing.
8. Create `invite-reminder`: **Runs on** `invitation-unredeemed`, firing `5` minutes after the invitation was sent, sending `invitation-unredeemed-reminder` to the inviter privately.

**Notice:** the builder's status line reads "Meets the server's rules": the same check the draft, activation and import apply. A step that breaks a rule is marked on the canvas.

**Do:** **Save draft edits** at the foot of **Event workflows**, **Validate**, **Activate draft as vM**.

**Notice:** a task step hands work to someone and waits. It names who the task is for and who does it: a person the event names, a participant role with one holder, or an assistant role such as `ops`. Every task step has a deadline, and the run continues by **Then**, **If it fails** or **If the deadline passes**. A person is told privately and by email and answers on a card or by replying. Pressing a card's button is checked by the task service: only the person the task is waiting on, only in the state the card was drawn for.

### 1.10b Layout rides the version (optional)

**Do:** **Edit**, open `invite-sent`, drag `confirm-link` somewhere new, **Save draft edits**.

**Notice:** no dot, **Draft (0 changed)**, and "Nothing differs from the active version". Layout is stored beside the version, outside the `configId`, and no turn reads it. Activate it, roll back, and reopen the draft: the layout returns with the rolled-to version. **Discard draft** then throws the draft away with nothing serving touched.

### 1.11 Someone arrives: a share and an invitation

**Do (premium user's browser):** **Account settings**, **Language**, **Messages to me**: Simplified Chinese.

**Do (administrator's browser):** open the conversation from 1.1, **Share**, and enter the premium user's email.

**Notice (premium user's browser):** two messages only they read: Advisor's welcome from 1.9, in Chinese, naming them; then a catch-up on what was said before they arrived. The share named `person-joined` to the router, which read the live roster and ran `greet-joiner` for that person alone. The catch-up is the platform's join recap, which reads what people said with private messages left out.

**Do (administrator):** **Share**, **Invite someone new**, a name, no email, **By signing in or creating an account**, **Invite**.

**Notice:** "Invitation for ... is ready. Pass the link on yourself.", then, visible only to the administrator, the two steps of `invite-sent`: Advisor's private line, then a task card with an **Acknowledge** button and a deadline an hour out. The same task is in the administrator's open-work list, and a "A task is waiting for you" email is sent.

**Do:** **Acknowledge**.

**Notice:** the card reads done and the task leaves the open-work list. The router also created one one-shot schedule for the reminder, five minutes out: a schedule, never a poll. A few minutes later the reminder appears privately; **Withdraw** the invitation and its schedule is deleted, and one that fired anyway would find it withdrawn and run nothing.

## Act 2. New reach is reviewed; new assistants are not

Three kinds of change take three paths:

- **Behavior is data**, changed by the assistant's team with no deploy (Act 1).
- **Assistants are created at runtime** by whoever holds the `manage-assistants` capability. An admin creates in any classification; a team member creates only for their own team. Retiring an assistant is an admin's alone.
- **New reach is infrastructure**, reviewed and deployed by the platform team.

This act walks the third path once, adding the `ops` assistant role so an assistant can read this deployment's telemetry.

### 2.1 What is reviewed

The whole of what approving the `ops` role adds to IAM is in `backend/lib/stacks/agent-classification-common.ts` (`observabilityRoles`, `AssistantObservabilityRead`, `BoundaryTelemetryOnlyForObservabilityRoles`).

**Notice:**

- **Four CloudWatch read actions and no writes.** Three metric reads, granted only to a session tagged `role=ops`, and `DescribeAlarms`, granted on this deployment's alarm ARNs only. There is no CloudWatch Logs read, no dashboard write and no alarm mutation.
- **`Resource: '*'` on the metric reads, stated rather than hidden.** The metric APIs name no resource type, so what narrows them is the role condition, the boundary's Deny, and the reach being read-only telemetry about the deployment itself.
- **An Allow that names the role, and a Deny that refuses everyone else.** The boundary's Deny is keyed on a negated condition, so a session whose role is not `ops`, or that carries no role tag at all, is denied. A Deny written as "match `role=primary`" would let an untagged session past.
- **No new IAM role.** `ops` is one more assistant-role tag the classification's IAM role accepts, and its trust admits only the vend, only with a role tag this deploy declares.

### 2.2 What approval buys

**Do:** from `backend/`, preview the change:

```
npm run deploy:stack -- AgentEchelonAssistants-premium --diff-only -c profiles=basic,standard,premium,ops-premium
```

**Notice:** the declared-assistants seed now names `ops-premium` in the `ops` role; the acting role's trust admits `role=ops`; the acting role's policy adds `ops` to the basic and standard context statements (premium's stays primary-only); the boundary's telemetry Deny exempts `ops`; and the `AssistantObservabilityRead` policy is added, with one alarm-read policy per declared capability that has alarms. No assistant identity or Amazon Lex bot appears in the diff: those are data the provisioner builds when the deploy runs.

Runtime code holds no `iam:CreateRole` and no IAM write at all, so which roles an assistant may act in, and what each role reaches, is outside runtime code's reach entirely. That is why this step is a deploy.

### 2.3 The deploy

**Do:** from `backend/`:

```
npm run add-assistant-role -- --dry-run
npm run add-assistant-role
node scripts/show-ops-rollout.mjs premium ops
npm run ops-workflows -- add
```

**Notice:** `add-assistant-role` writes `ops-premium` into `profiles` in `deploy.config.json`, deploys exactly the one stack the diff showed, and imports Ops's first version from its shipped manifest (`demo/portable-assistants/ops-assistant-manifest.ts`) through the same draft, validate and activate path a team uses. The manifest names no ARN, account or region. `show-ops-rollout.mjs` reads the result back from AWS. `ops-workflows -- add` writes a new Advisor version carrying its welcomes for the ops conversations, and is refused while the role is not deployed. The ops conversations' own workflows (the opening and the incident) are Ops's, on its imported version: Ops is those conversations' primary and owns their workflows.

The deploy takes several minutes. While it runs, return to the invitation from 1.11 for its reminder, then withdraw it.

### 2.3a The ops conversations' workflows

**Do:** Ops, **Workflows**.

**Notice:** under **Welcome**, `welcome-ops` and `welcome-ops-team`; under **Event workflows**, `ops-room` (on `conversation-opened`, in `ops` conversations) and `incident-triage` (on an AWS event, in `ops-team` conversations). They ride Ops's version: Ops is the primary of both kinds of conversation and owns their workflows (`primaryRole` and `workflowOwner` on the types), so their events run Ops's workflows and speak as Ops. Advisor, a member of both conversations, carries one welcome for each, on its version only while the role is deployed. The platform opens no `ops` conversation without its ops assistant: the creator refuses a type whose assistant is not live.

**Do:** **Edit**, pick `ops-room` in the builder.

**Notice:** four steps: an opening to the conversation naming the lead, a private welcome to the lead, a **first look** (an assistant step taken by the conversation's `ops` assistant, reading deployment health), and the end. The first look is the ops assistant's, because reading telemetry is the `ops` role's grant alone.

**Do:** copy the shipped `incident-watch` under the name `watch`. It runs on `alarm-state-changed` in `ops` conversations: `announce` sends `incident-alarm-changed` to the conversation, and `recheck` is an assistant step for the ops assistant. On `recheck`, **Run this step only when**, **Add a condition on a variable**.

**Notice:** the picker lists each value with its **Type**, **Trust** and **May decide**. `event:alarmState` is platform trust, because the router reads the alarm's state back from CloudWatch before anything runs, so it may decide. Member text such as a display name is not offered. Choose `event:alarmState` **is** `ALARM`, then **Save draft edits**, **Validate**, **Activate draft as vM**.

### 2.4 The approval is checked, not trusted

**Do:** from `tests/`:

```
npx playwright test e2e/an-ops-role-reaches-only-its-own-classification.spec.ts
```

**Notice:** an ops session is allowed the telemetry reads, and a primary or untagged session is not; an ops session acts only as its own identity; it cannot act in another classification's conversations; and ops is refused premium context while the primary keeps it. The positive control sits beside the denials because a wrong condition key denies everyone, including ops, and an absent condition grants everyone. "The ops assistant answered" is not evidence that the primary could not have.

## Act 3. The assistant is live, then tuned

### 3.1 Read back from the deployment

**Do:**

```bash
node scripts/show-ops-rollout.mjs premium ops
```

**Notice:** the classification's IAM role and the role tags its trust admits (`primary, ops`), the statements conditioned on `ops`, the identity and Amazon Lex bot, the active profile version, and what this role reaches that the primary does not. The first sections are read from AWS rather than echoed from config, and the rollback is printed beside them.

### 3.2 An event opens a conversation

The `ops` group is the one list of people. It fills the operations team's standing conversation (an `ops-team` conversation) and, when an event concerning that conversation opens an `ops` conversation, it fills that one too. The type names the assistants; the group names the people.

**Do:** in the console, **Users**, **Manage users**, open **Details** on the on-call engineer and the two platform engineers, and tick **ops** under **Groups**. Leave the engineering manager out. A group places people in conversations; it grants nothing and requires premium, so ticking it for a standard user is refused. Then open the standing team conversation as the README describes.

**Do:** from `backend/`, send the event an alerting tool would:

```
npm run send-ops-event -- --concerns <team conversation channel ARN> --title "Report latency" --summary "Report generation is running slow." --alarm <your demo alarm name>
```

**Notice:**

1. A new conversation, *Report latency*, within seconds: the on-call engineer as lead and moderator, the `ops` group's members, Advisor and Ops. The people came from the group and the assistants from the type; nobody was copied from the team conversation.
2. Nothing new in the team conversation. What an incident conversation holds is not that conversation's audience's to read.
3. Advisor's one line, then Ops's `ops-room` run: the opening naming the lead, the lead's private welcome, and Ops's first look, its own task on its own session, which alone holds the CloudWatch grant. Ops is the conversation's primary and owns its workflows, so the run is Ops's from start to end.
4. An email to each person the conversation was opened for, with a link into the conversation.
5. **Share** disabled in the conversation, because people come from the group.

**Do:** put the two conversations side by side. In the console, untick **ops** for one platform engineer.

**Notice:** within about a minute they leave both conversations; tick it again and they return to both. Nobody touched either conversation. Lower an ops member's clearance to standard, and they leave the group and the conversations on their own.

What this shows:

- **The conversation is its type, not its classification.** Both conversations are premium; *Report latency* has drift off and expires after thirty idle days because `ops` declares those, while the team conversation keeps drift on and lasts longer.
- **People and assistants fail differently.** A person the classification refuses is not added; an assistant that cannot be added fails the creation.
- **A group never raises clearance**, and neither the classification nor the type could have been chosen by the event.

### 3.3 Each assistant answers as itself

**Do:** in *Report latency*, ask `@Ops how many invocations in the last hour?`, and optionally `@Ops which alarms are firing?`

**Notice:** answers from live CloudWatch, attributed to Ops. The tool runs on Ops's own session, tagged `role=ops` and narrowed to Ops's definition. Each assistant's prompt also carries a "Who is here" section (the people by display name, each other assistant with its role and what it handles), sanitized and capped because members choose their names.

**Do:** ask `@all what should we look at first?`

**Notice:** Ops answers once, and Advisor does not. `@all` asks the conversation, and the conversation's primary, Ops in an ops conversation, answers or hands the work on.

**Do:** ask `@Advisor are there any lambda throttles in the last hour?`

**Notice:** Advisor says the question is Ops's and that it has passed it along, then Ops answers. Advisor read what the other assistant advertises and posted a handover message targeted at Ops; Ops read it back and verified it before answering. Neither assistant invoked the other.

**Do:** ask `@Advisor what is our current ARR?`

**Notice:** Advisor answers directly. The handover is routing, not deflection. Advisor's `role=primary` session is denied CloudWatch, which 2.4 proved: two assistants, one classification, one conversation, different reach.

### 3.3a The conversation watches its alarm

*Report latency* was opened about an alarm, so it watches it.

**Do:**

```bash
aws cloudwatch set-alarm-state --alarm-name <your demo alarm name> --state-value ALARM --state-reason "demo"
```

**Notice:** Ops announces the new state, then posts a re-read, both from its own version's `watch` workflow, because Ops owns the conversation's workflows: what changed since its first look, and whether it looks to be recovering or spreading. One rule matches only this deployment's alarms; before anything runs, the router checks that the alarm's watch record and the conversation agree, that the conversation is not archived, and reads the alarm back from CloudWatch. One run per state the alarm enters, so a redelivered change starts nothing twice. No person and no poll started it.

**Do:**

```bash
aws cloudwatch set-alarm-state --alarm-name <your demo alarm name> --state-value OK --state-reason "demo"
```

**Notice:** the announcement and nothing from Ops. The `recheck` step's condition does not hold, so the step posts nothing.

### 3.3b The team conversation opens the incident conversation

Here the work starts where the people already are: an alarm attached to the team conversation opens the incident conversation itself.

**Do:** in the console, Ops, **Workflows**, open `incident-triage` (a workflow whose trigger is an AWS event). In its **What starts this workflow** panel, choose **A resource's ARN (an alarm)**, paste the demo alarm's ARN, and **Attach**. Attaching is an admin action, separate from saving the version: it creates one EventBridge rule whose one target is the classification's relay to its router, and tags the team conversation. The conversation's lead is the on-call, the single member of the `ops-on-call` group. A new rule can take a short time to apply, so wait a moment before the next step.

**Do:** set the alarm to `ALARM`. If *Report latency* still watches the same alarm, it announces the change too.

**Notice:**

1. A new `ops` conversation opens at once, as a child of the team conversation, led by the on-call; nobody is asked first. Its members are the `ops` type's (the `ops` group plus its assistants), never a copy of the team conversation's.
2. The child's own `ops-room` workflow runs: the opening, the lead's **incident owner** task, Ops's first look (which reads the alarm that opened the conversation), the call offer, triage (the affected accounts, then the lead's **Customers impacted?** card) and the runbook, from the mitigation to the recovery reading.
3. Ops tells everyone in the team conversation, mentioning the on-call, that the incident conversation opened and why: the alarm, its metric, threshold and latest value (read back from CloudWatch, never taken from the event), since when and in which AWS Region, and a link to it. Triage, customer impact included, happens in the incident conversation. Nothing from the child is posted there but that announcement, "resolved" at the resolve, and its outcome where it ends otherwise.
4. The on-call resolves the incident on its card in the child. While the runbook still has steps open, Ops first asks the on-call alone to confirm, naming the steps still open, with **Resolve** and **Keep open** on the card. Confirmed, the incident is resolved: its open runbook tasks are cancelled with the run's end as their reason, the conversation is told, the team conversation is told once that the incident is resolved (Ops posts it there as itself, as a member of the team conversation), and the root-cause investigation stays open. Once the investigation is marked complete, Ops drafts the post-incident review in the child from its timeline and the investigation's findings, and the on-call completes it on its card; the child's run then ends, and the team conversation is told nothing more. Kept open, the runbook goes on and Ops hands the on-call the card again. Once the runbook has reached its end, **Resolve** resolves it at once. Archiving the child before then settles the task as archived, and the team conversation is told the same.
5. The incident is a thread of the team conversation: ask Advisor in the team conversation how it is going, and it answers from the incident's latest summary, because every person in the team conversation is also in the incident. A summary never reaches a conversation that holds someone the other conversation does not.

**Do:** while the incident is open, set the alarm to `OK` and back to `ALARM`.

**Notice:** no second conversation. One rule gives at most one run per 15 minutes, and an open incident for the same resource takes a repeat of its event, telling the team conversation, and opens nothing. The child is always the team conversation's classification, so no boundary is crossed, and a child opens no further child but one of a leaf type, the customer messaging conversation, which opens nothing itself. What an event may do at all (allowed event types, caps on triggers and open incidents, a switch that turns every trigger off) is the deployment's event policy, edited in the console by an admin and checked on attach and on every event.

**For a real use case:** the demo's alarm event names the alarm and the state it entered, with the reason you set (`demo`); the incident's run takes only the alarm's ARN and name from it, and Ops reads the alarm back from CloudWatch with its own role. Review the structure of every event a real deployment attaches: keep sensitive data (a ticket's text, a customer's details) in the approved system that holds it, and have the event carry a reference, such as a ticket id, that each side reads with its own identity. See [Designing an event for a use case](../../docs/guides/admin/WORKFLOW-STEP-REFERENCE.md#designing-an-event-for-a-use-case).

Still **NOT BUILT**: the parent link a child's workflows read (so the first look reads the alarm, not what was said in the team conversation); judging whether a different event belongs to an open incident; and resolving the on-call through a connector rather than the `ops-on-call` group.

### 3.3b-2 Customer messaging starts as soon as customers are impacted

The account team starts customer messaging as soon as customers are known to be impacted, because an account with a short SLA needs at least a "we are looking into it" within minutes. It runs beside the incident in its own conversation and never holds the incident up.

**Before you start:** the seed makes the CSM Maria Santos the account team's lead, in the `account-team-lead` group beside the `account-management` group (the CSMs' group).

**Do:** run 3.3b again. In the incident conversation, once Advisor has listed the affected accounts, press **Customers impacted** on the lead's **Customers impacted?** card.

**Notice:**

1. The incident conversation says customer messaging has started, with a link, and goes on with its runbook without waiting.
2. The customer messaging conversation opens for the account team, with Advisor and Ops. Advisor lists the affected accounts and their CSMs, then drafts the initial notice in the account team's shape: what is affected, since when, what is being done, and when the next update comes, marked a draft.
3. The account team lead gets an approval card. Adjust the draft with the CSMs, then **Approve**: the incident conversation is told a notice was approved. Leave the card for 15 minutes instead, and the lead is told privately that the notice is late and gets the card again; the miss is recorded.
4. Resolve the incident (3.3b, step 4). The customer messaging conversation is told it resolved. The lead presses **Draft final notice** on their card, and Advisor drafts the final notice: when it was resolved, what customers saw, and that a follow-up review comes. Approve it, and the incident is told.
5. Nothing is sent to a customer: the account team sends each approved notice through its own tools.
6. In the console, the account team words its notices by saving its own **customer-notice-initial**, **customer-notice-update** and **customer-notice-final** message templates; Advisor fills the saved shape from then on.

### 3.3c Everyone in the incident sees one dashboard

**Do:** in the incident conversation, ask Ops to publish the dashboard, or let the alarm change again: the incident watch refreshes it on every state change.

**Notice:**

1. One dashboard message appears in the conversation. Open it: the alarm's state with its icon and label, the watched metric against its threshold, and the deployment's invocations, errors, throttles and average duration over three hours, in light or dark as the reader's theme is set.
2. Set the alarm to `OK`. The same message updates in place, and every member's open dashboard redraws. Nobody refreshes and nothing polls.
3. Sign in as someone outside the conversation and try the dashboard's address. It does not open.

**Why it takes no sharing step.** Every person in the conversation is an Amazon Chime SDK AppInstanceUser and Ops is an AppInstanceBot, and each acts only as itself. That one fact does the work a shared dashboard usually needs a separate access list for:

- **Who may see it is who is in the conversation.** There is no share list to keep in step. Add someone to the incident and they can open the dashboard at once; remove them and their next read is refused. Membership, read from Amazon Chime SDK, is the access.
- **Each read is the reader's own.** The chat app reads the dashboard with the member's own vended credential, scoped to this one conversation after a membership check, and IAM evaluates it, classification included. No server reads it on anyone's behalf, and a member of another classification is refused whatever they ask for.
- **The assistant publishes as itself.** Ops writes the dashboard with its own session, and only because its version declares the dashboard tool: an assistant without the tool holds no write grant at all. It can write its own conversation's dashboard and no other.
- **It is live because it lives in the conversation.** The dashboard's message is an ordinary message in the conversation, so when Ops updates it, Amazon Chime SDK delivers the update to every member's open client, the same way it delivers a reply.

For a dashboard opened outside the chat app, from an email or a wall screen, Ops can publish it as a page instead (`publish_dashboard_page`). Only a member is given a link, and the link expires after five minutes; the page itself is bounded by that link rather than by the viewer's credential, which is the trade the in-app view does not make.

### 3.3d The incident is one process

The incident's workflows, `incident-triage` in the team conversation, `ops-room` in the incident conversation and `customer-messaging` beside it, are linked by one process id, so the incident is measured end to end. The process is its own artifact: it travels as a process manifest (`opsIncidentProcessManifest` in `ops-assistant-manifest.ts`), separate from Ops's assistant manifest, and carries what it requires of a deployment: the `ops-team`, `ops` and `customer-messaging` conversation types, the on-call, the incident's lead and the account team lead, the primary assistant (Advisor) asked for `impacted_accounts` and `customer_notice_draft`, Ops asked for its first look, dashboard and runbook readings, and the templates and task machines its steps use. `npm run ops-assistant -- import` imports Ops's manifest as a draft, then the process manifest into that draft, then validates and activates it. A deployment that lacks any of those refuses the process, naming each missing type, role, assistant, intent, template or machine, and nothing is activated; activation checks the same again, so an assistant or role removed after the import is caught before the version serves.

**Do:** in the console, **Assistants**, Ops, **Draft**, then **Processes**. Choose **Export** on Incident response to download its process manifest. Under **Import process**, choose that file (or paste its JSON) and choose **Import into the draft**.

**Notice:** the process lands in the draft, never the active version, and the console says so. On a deployment that lacks something the process needs, each refusal is listed in words, such as the primary assistant's active version not offering `customer_notice_draft`, and the draft is unchanged.

**Do:** in the console, **Assistants**, Ops, **Edit** (or **Draft** while one exists), then **Processes**, the section beside **Workflows**. Choose **Edit** on Incident response. The wizard opens on **Phases and hand-offs**, its phases numbered in the order they run:

- **Phase 1**, `incident-triage`, started when an AWS event reaches the team conversation, with no stage of its own: it opens the incident conversation at once and tells the team where it is.
- **Hand-off to ops-room**: a new `ops` conversation in this classification, opened by its `open` step, led by the on-call; the team conversation waits until it ends.
- **Phases 2 to 3, in parallel**: phase 2, `ops-room`, with its stages, who answers each and their deadlines, and the metric Resolved within 4 hours; and beside it phase 3, `customer-messaging`, marked "Runs alongside ops-room; ops-room does not wait for it.", with the metric Initial customer notice missed its deadline.
- **Hand-off to customer-messaging**: a new `customer-messaging` conversation in this classification, opened when triage recorded customers as impacted or a card ends as impacted, led by the account team lead; nothing waits, and the messages told each way are listed by what each says.

**Do:** under **Show the phases as**, choose **Flow**. (On the version's page outside the wizard, **View flow** on a listed process opens the same view.)

**Notice:** the phases run top to bottom, phases 2 and 3 side by side under one header. Each phase is a card with its stages down it, each stage naming who answers it (the on-call, the incident lead, the account team lead, Ops, Advisor or the platform) and its deadline. Select a stage, such as Initial notice approval, to see what it is for, who answers it, its deadline and where it runs, and **Edit its step in Workflows** to open the workflow that declares it. **Hand-offs, in order** lists each hand-off beneath.

A phase may also wait on parallel work: a workflow step that waits for several parts (`wait: { join: ... }`, all of them or any one) shows as a join, "<stage> waits for all of: <parts>", on its phase in the wizard and the flow view. The incident response declares none, so the demo does not show one; a join is declared in the workflow's JSON (see [WORKFLOW-STEP-REFERENCE](../../docs/guides/admin/WORKFLOW-STEP-REFERENCE.md)).

**Starting workflow**, **Name and owner** and **Metrics and review** are the wizard's other steps; **Add process** starts at **Starting workflow**, which lists the version's workflows under what starts each, request-started workflows under **Started by a request** (3.3e). Choose **Cancel** to leave the process as it is.

**Do:** run 3.3b again, and open the incident conversation from the team conversation's announcement. Work it there; the root-cause investigation stays open beside it. Resolve, then mark the investigation complete, then complete the post-incident review on its card. Then open **Performance**, **Processes**, and choose Incident response.

**Notice:**

1. A process is refused as it is written, in the console's words: an empty **Label**, or a metric whose workflow the process no longer links, holds **Done** back on the review step and says why. **Validate** says the same for a process that links a workflow the version does not declare, in the banner and in the **Processes** section.
2. The incident appears as one process: the team conversation's run started it, and the incident conversation's run inherited its id through the `open` step. The tab lists the processes first; Incident response opens on its key figures (processes started, succeeded, open now, median end to end, cost per process), then its stages, each with who answers it, how many runs reached it, its time and its cost, then where each run spent its time, the time waiting on each team, the declared metrics and, where runs ran on more than one version, the versions compared.
3. With customers impacted (3.3b-2), the customer messaging run is under the same process id, and its stages, Affected accounts, Initial notice, Initial notice approval, Updates, Final notice and Final notice approval, are timed beside the incident's: the Initial notice stages are the time to first notice, and the declared metric counts the incidents whose first notice missed its deadline. The process completes only once both the incident and its customer messaging have ended.
4. Resolving closes the runbook's open steps and tells the conversation; the post-incident review starts in the incident conversation only once the investigation is complete, drafted by Ops and completed by the on-call on its card, and the incident's run ends after it.
5. Nothing was added to any message's metadata: the process rides each run message's analytics record and the run's end record, and each run names the team that owns its assistant, read from the assistant's `owner-team` tag.
6. From a process, open a run's workflow in its assistant's editor, or its conversation: choose one run of the flow, or open a process id, and each of its runs (triage in the team conversation, the incident conversation, customer messaging) names its workflow and offers **Open conversation**, which opens in Conversations under that tab's own access.

### 3.3e A request starts its own process

A process may start from a person's request as well as an event: it links a request-started workflow, the intent's workflow a version declares in **Intent workflows** (3.5b). Advisor's `account-briefs` process links its `account_brief` workflow, so each account brief a person asks for is one process, measured from the request to the brief written. It ships as a process manifest beside the incident's (`advisorBriefProcessManifest` in `advisor-processes.ts`), requiring that Advisor answers `account_brief` and declares its workflow, and `npm run demo-processes -- import` imports it into Advisor's draft, validates and activates it. The incident response is unchanged.

**Do:**

```bash
npm run demo-processes -- import
```

Or, in the console, Advisor, **Draft**, **Processes**, **Add process**, and choose `account_brief` under **Started by a request**. As a premium user, ask: "Prepare an account brief on Coastal Health Systems for my renewal call tomorrow." When the brief is written, open **Performance**, **Processes**, and choose Account briefs.

**Notice:**

1. The request's task carries the intent's run and its process id, and the brief's process reads ended and succeeded once the task completes, with one run, the request's.
2. **Stages** shows one stage, **Brief**: the import labels the workflow's one step on Advisor's version, since a stage's label is the version's own. Its time runs from the request's first message to the brief written, and the run shows what the brief cost.
3. A run another process asked for joins the asking process rather than starting its own: an account brief an incident step asked Advisor for would be a run of the incident. So does a request a person makes in a conversation a process opened, such as the incident conversation.

### 3.4 Tuning needs no further approval

**Do:** `ops-premium`, **Edit**, change its name or persona on **Behavioral**, **Save draft edits**, **Validate**, **Activate draft as vM**.

**Notice:** live within about 30 seconds, with no deploy and no review. A version carries selections, never references, so there is no field through which scope could travel. A version also freezes its tool list: a tool registered later reaches no existing version until a version names it.

### 3.5 The intents are a file its team owns

**Do:**

1. `ops-premium`, **Versions**, **Export manifest**.
2. In the file, under `intentPack`, append to the `deployment_health` intent's `instructions`: `End every answer with one line that starts "Watch next:" and names the single metric you would watch over the next hour.`
3. **Import a version**, pick the file, **Import as draft**. Then open the draft, **Validate**, **Activate draft as vM**.
4. In *Report latency*: `@Ops how is the deployment doing?`

**Notice:** the import lands as a draft, never as active, and is validated against the classification. Within about 30 seconds Ops's answer ends with a "Watch next:" line. Roll back afterwards. The intent pack and onboarding have no console controls and are edited as JSON this way (**NOT BUILT** as controls). The **Instructions** expander reads the classification's catalog, not the version's pack, so the evidence is the answer itself.

A new tool is code, not a prompt: its handler, its entry in `TOOL_REGISTRY` (`tool-registry.ts`) and its IAM grant are reviewed and deployed like Act 2, then each team allows it per version. `read_deployment_health` is a deterministic result: the model decides to call it, but code computes the answer (bounded CloudWatch reads on the assistant's own session) and the model only phrases it.

Two controls keep Advisor from using Ops's tool. **What the model is offered** is per assistant: only the tools the speaking assistant's version allows, narrowed by the intent. **What a tool can reach** is per role: if Advisor's turn called the metrics read, IAM would deny its `role=primary` session. Company context is bounded the same way: Ops reads basic and standard context, and IAM refuses it premium's financials.

### 3.5a The report is a template the deployment owns

On premium, `report_generation` offers two document templates the deployment owns, `quarterly-account-review` (the default) and `executive-summary`. Each template's sections carry the guidance the model writes to.

**Do:** list the templates, then publish a version of `quarterly-account-review` with one more section (for example **Open questions**):

```bash
npm run template -- list premium
npm run template -- put premium <your-template-file.md> --activate
```

**Do:** in a premium conversation, ask `Compile a quarterly account review of our largest enterprise account for the leadership team`, answer what it asks, and let it deliver.

**Notice:** the delivered review includes the new section. The body is stored once under its content hash, the pointer names the version in use, and premium's turns read only premium's templates. Roll back with `npm run template -- rollback premium quarterly-account-review`.

### 3.5b What a request runs is the intent's workflow

**Do:** Advisor, **Workflows**, **Edit**, then **Intent workflows**.

**Notice:** each intent shows **opens a task** or **answered in one turn**, with the task its workflow assigns and its states. **Edit** opens the workflow on the same canvas as 1.10a; **Restore its starting steps** puts the standard one back.

**Do:** open `report_generation`'s workflow, add a send after its task step that tells the requester the report was delivered, then **Save draft edits**, **Validate**, **Activate draft as vM**. Ask 3.5a's request again.

**Notice:** the added step runs once the task ends. The task's own steps are still the machine's; the workflow decides what comes before and after it. Roll back afterwards.

### 3.5c Each step runs on the model it needs

Advisor's base model is Sonnet, and so is its `report_generation` route. The two steps that write the report, `generating` and `revising`, name Opus as a model of their own, so the larger model is paid for only where the report is written.

**Do:** Advisor, **Purview**, the `report_generation` card, then **Workflows**, **Edit**, open `report_generation`'s workflow and select `generating`.

**Notice:** each step names the model it runs on and the rule that chose it: "Claude Sonnet 4.6, the intent's model" on the steps that take the brief and put the outline, and "Claude Opus 4.6, its own model" on `generating` and `revising`. The step inspector's **Model** is the same setting as the step on the card, so a change in either place shows in both.

**Do:** run 3.5a's request to delivery, then **Performance**, open `report_generation` in the flow, and **Open turn** on its turns.

**Notice:** beside the model, **Chosen by** and **Step**. A turn in `collecting_requirements` or `drafting_outline` that only moves the task runs on Sonnet, chosen by a route; the turn that writes the report runs on Opus, chosen by its step, and reads `drafting_outline to generating` when the task moved into the step during the turn.

### 3.6 An assistant created at runtime

Act 2 reviewed a role. Once `ops` is approved, another assistant in it needs no review and no deploy.

**Do:**

1. **Assistants**, **Create an assistant**. The wizard has six steps (**Who it is**, **What it can do**, **How it greets**, **What it says**, **Events**, **Review and activate**).
2. **Who it is:** classification `premium`, role `ops`, identifier `sentinel`, name **Sentinel**, owning team **Ops team**.
3. **What it can do:** **Copy an existing assistant**, **Ops**, and choose its models. **Create assistant**.
4. Wait about half a minute and **Check the build**. Nothing polls: the wizard continues when a load finds the draft.
5. Step through the copied welcomes, templates and workflows, then **Validate** and **Activate draft**. Sentinel's page opens on **Active v1**.
6. Add Sentinel to *Report latency*. There is no console control for this (**NOT BUILT**): it is one `aws chime-sdk-messaging create-channel-membership` call under the app-instance admin bearer, with Sentinel's identity ARN from its assistant directory entry.
7. Ask `@Sentinel how many invocations in the last hour?`
8. Retire it: **Assistants**, **Retire** in its row, with a reason.

**Notice:** Sentinel answers in its own name from live CloudWatch, on a session tagged `role=ops`: the same reach as Ops, because it is the same role. A runtime assistant mints no IAM; the provisioner can touch only identities and Amazon Lex bots it created. On retire, its identity and Amazon Lex bot are deleted, and creating `sentinel` again is refused, because a name that answered is never reused.

With Sentinel in the conversation, two roommates advertise the same operations intents, so `@Advisor are there any lambda throttles?` asks which one should take it rather than picking. A runtime assistant in the `primary` role is never the classification's primary: new conversations still get Advisor.

### 3.6a No ops assistant in the conversation

**Do:** remove Ops from *Report latency* (the `delete-channel-membership` counterpart of 3.6, step 6), then set the alarm to `ALARM`.

**Notice:** Advisor announces the state, then says no ops assistant is in the conversation, so nobody has read the deployment's health. The router looks for the `ops` role's assistant among the members; with none, it dispatches no turn and calls no tool. Advisor does not try the read itself: IAM refuses its session telemetry. Set the alarm back to `OK` afterwards.

### 3.7 Assistants in front, agents behind

Each assistant in the conversation belongs to a team that manages its whole experience: persona, context, tools, models, versions, rollout and measurement. That does not replace agent swarms: an assistant is the accountable identity people talk to, and behind it a team can run as many agents as the work needs.

Today a swarm sits behind an assistant as a tool: the platform team adds a tool whose handler calls the team's swarm (on Amazon Bedrock AgentCore, Strands, or any framework), running on the assistant's own session, so it reaches nothing the assistant cannot, and its result comes back through the assistant's guardrails. No swarm runs behind any assistant in this demo. The platform's own fan-out, with sub-agents on a narrowed copy of the assistant's access and a per-sub-agent cost record, is **NOT BUILT**.

### 3.8 The golden-set gate

**Do:** Advisor, **Edit**, change the persona slightly, **Save draft edits**, **Validate**. In the **Golden set** panel, **Run golden set**, then **Check again** until it finishes.

**Notice:** each regression entry is answered three times, beside the active version, posting nothing. A failure the platform checks without a judge (an error, an empty answer, a guardrail block, a rule breach) blocks activation; judged quality is reported as a paired difference with its interval and never blocks on its own. Activating before the run is refused. An administrator may activate past the gate, recorded on the version with the reason. Roll back afterwards.

The gate needs at least one regression entry for Advisor; the [measure-and-promote walkthrough](../measure-and-promote/WALKTHROUGH.md) shows how to nominate one.

## What is not built

- Step-up authentication for critical admin actions. **NOT BUILT**
- Host-supplied fields (a visitor's name, company or role) in a welcome or template. **NOT BUILT**
- Recording which company context sources a turn loaded. **NOT BUILT**
- An in-product approval workflow: Act 2's review is a pull request and a deploy. **NOT BUILT**
- Console controls for the intent pack, onboarding and version variables, which are edited as JSON. **NOT BUILT**
- A console control to add an assistant to, or remove one from, an existing conversation. **NOT BUILT**
- Retiring an assistant by a team member: it is admin-only. **NOT BUILT**
- Changing a conversation's primary assistant, and a notice when a conversation gains a second assistant. **NOT BUILT**
- A change to a conversation type reaching existing conversations, and a record of which configuration an archived conversation used. **NOT BUILT**
- Revocation of a group change made outside the console, refusal of a disabled user at the edge, and vending from live groups: removal is immediate, other changes take effect within a stated window. **NOT BUILT**
- Verdicts attributed per assistant instance, and a side-by-side comparison of assistants in analytics. **NOT BUILT**
- Per-assistant narrowing of guardrails and of context sources other than company documents. **NOT BUILT**
- Re-checking the tool allowlist at dispatch (IAM is the second layer for tools that call AWS). **NOT BUILT**
- Retrying a handover the router could not start. **NOT BUILT**
- A sweep behind idle task pickup. **NOT BUILT**
- Localizing an email's wrapper, the stand-alone emails and a welcome's opening text; a model-voiced message where no variant is written exists only for the two targeted welcomes. **NOT BUILT**
- A value an assistant shares back with the assistant that asked it, instructions written for the person holding a step, and a step declaring who may respond. **NOT BUILT**
- The incident parent link, related-event judgment and on-call connector described in 3.3b. **NOT BUILT**
- A hand-off between teams and classifications (the Stratum customer request), designed in SPEC-PROCESSES P4 to P7. **NOT BUILT**
- The platform's own agent fan-out. **NOT BUILT**
