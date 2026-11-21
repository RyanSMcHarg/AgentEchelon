/**
 * Stratum DEMO intent packs, per classification.
 *
 * Extracted from seed-demo.ts so their SIZE can be measured without running a seed. The seeder
 * invokes main() at import, so nothing could import these to check them, and the only way to learn
 * that a pack had outgrown its parameter was to run a deploy and watch the seed die part way through -
 * after basic and standard were already written, so the retry reported those as "already set" and died
 * on the same one. `test/demo-seed-budget.test.ts` measures them here instead, before any deploy.
 *
 * Same split as demo/personas.ts: demo CONTENT lives under demo/, the seeder stays the mechanism.
 */
/**
 * Stratum DOMAIN intent pack (per classification). Each pack declares the WHOLE taxonomy that assistant
 * recognizes: Stratum's own everyday questions, plus the platform intents that assistant actually does,
 * copied in by value with `fromPlatform`. The universal greeting/acknowledgment/general are added
 * implicitly by every reader.
 *
 * WHAT AN ASSISTANT OFFERS IS WHAT ITS PACK DECLARES. Basic answers EXTERNAL conversations from public
 * documentation and hands over no files, so it declares no `report_generation`, no `data_extraction`
 * and no `image_generation`. Standard adds reports and exports, scoped to the directory and internal
 * processes. Premium adds `strategic_analysis`, the financial, account and competitive intents, and the
 * account brief, a workflow whose research step requires its lookup before the task moves on.
 *
 * A PLATFORM INTENT A PACK DOES NOT DECLARE IS REFUSED, NOT ANSWERED AS SOMETHING ELSE
 * (DESIGN-CAPABILITY-REFUSAL). The classifier recognizes a report request on basic, from the platform's
 * own description, and the router refuses it and tells the person where they could get one, rather than
 * answering it inline as `general`.
 *
 * KEY DESIGN POINT (ADR-018): intent and DELIVERY are separate axes. These inline intents carry
 * `delivery: 'PLACEHOLDER_UPDATE'` (one grounded reply, answered in the turn), NOT `TASK_MULTI_STEP`.
 * So a single-fact revenue/account/product question is bucketed AND answered inline (no deferral behind
 * a task), as ADR-018 intends, and keeps its own intent rather than collapsing into `general`: the
 * per-intent delivery field is the lever. Genuinely multi-step work stays on the DEFAULT task intents
 * (report_generation / data_extraction, both TASK_MULTI_STEP), which the per-tier packs keep, so task
 * flows, e2e and taskType routing read the same intents on every tier.
 *
 * Scoped per tier to match each tier's data access (basic sees product info; standard the directory /
 * processes; premium financials / accounts / competitive intel), so a tier's classifier only offers the
 * intents that tier can actually satisfy.
 */
import { DEFAULT_INTENT_PACK, type StoredIntentPack, type StoredIntentDef, type IntentDef } from '../../backend/lambda/src/lib/intent-pack.js';
import { DEFAULT_TASK_STATE_MACHINES, type TaskStateMachine } from '../../backend/lambda/src/lib/task-state-machines.js';

/**
 * A demo intent is a full `IntentDef`, not a narrowed one.
 *
 * A narrowed shape such as `{ key, description, keywords, delivery: 'PLACEHOLDER_UPDATE' }` would pin the
 * delivery class and could not express `instructions`, `tools`, `maxTokens` or `verbosity` at all, so the
 * demo would show a taxonomy and none of the behavior an intent carries. An operator reading these as the
 * worked example would conclude an intent is a label.
 */
export type InlineIntent = StoredIntentDef;

/**
 * A PLATFORM intent, materialized into this profile's own pack, with optional per-profile overrides.
 *
 * WHY NOT `extends: 'default'`. Inheriting the platform taxonomy gives EVERY classification every
 * platform intent, including the ones it has no business recognizing. A basic assistant answering an
 * external conversation from public documentation would classify "write me a report on account health"
 * as `report_generation` and ATTEMPT it - declining well, if its instructions are good, but the
 * assistant should not recognize the request as something it does at all. An intent an assistant cannot
 * satisfy is not a capability with a caveat; it is a taxonomy entry that invites the question.
 *
 * So each pack below REPLACES the platform set (no `extends`) and lists what that assistant actually
 * does. This also makes the platform intents genuinely editable: they are IN the profile, by value,
 * where an operator can read and change them, rather than inherited from somewhere else.
 *
 * Copied by value from `DEFAULT_INTENT_PACK` rather than restated, so the platform wording stays the
 * source of truth and a profile overrides only what it means to change.
 */
export function fromPlatform(key: string, overrides: Partial<IntentDef> = {}): InlineIntent {
  const platform = DEFAULT_INTENT_PACK.intents.find((d) => d.key === key);
  if (!platform) {
    // A typo here would silently drop an intent from a profile's taxonomy, which reads at runtime as
    // "the classifier never picks that" - the least diagnosable shape of this mistake.
    throw new Error(`demo/intent-packs: '${key}' is not a platform intent; known: ${DEFAULT_INTENT_PACK.intents.map((d) => d.key).join(', ')}`);
  }
  return { ...platform, ...overrides };
}
// PLATFORM QUESTIONS, AT TWO DEPTHS. Every classification answers what AgentEchelon is.
// Basic, which serves external conversations, explains and stops: no recommendation, no configuration
// steps, no code and no architecture advice. The internal classifications answer how to build with it,
// with the specifics that takes.
//
// THE DESCRIPTION IS THE PACK'S, fuller than the platform's minimal one, because the classifier decides from
// it: "How do I customize the welcome?" read as guided troubleshooting against "about the platform itself".
const PLATFORM_QUESTION_DESCRIPTION =
  'User asks about the AgentEchelon platform itself: what it is, how it works, or how to configure, customize '
  + 'or extend it (e.g. "what is AgentEchelon?", "how do I customize the welcome message?"). Not the company, '
  + 'its products or its data, and not a problem to fix.';
const PLATFORM_QUESTION_BASIC = fromPlatform('platform_question', {
  description: PLATFORM_QUESTION_DESCRIPTION,
  summary: 'ask what AgentEchelon is and what it does',
  instructions:
    'In two or three plain sentences, say what the platform is and what it does for the person, from the '
    + 'platform information (load_platform_info). Never name internal components, functions, files, parameters, '
    + 'AWS services or settings, and never explain how to configure, customize, deploy or build anything, even '
    + 'when asked how: say in one sentence that it can be customized and that an internal conversation covers '
    + 'how. Who made it and where its source is are not build questions: answer them from the platform '
    + 'information\'s author and repository, giving the repository as a plain URL. Recommend nothing.',
  verbosity: 'tight',
  tools: ['load_platform_info'],
});
const PLATFORM_QUESTION_INTERNAL = fromPlatform('platform_question', {
  description: PLATFORM_QUESTION_DESCRIPTION,
  summary: 'ask how AgentEchelon works or how to configure and extend it, with examples',
  instructions:
    'Answer from the platform information (load_platform_info), specifically: name the components involved, '
    + 'give configuration or code examples in fenced blocks where they help, and describe the architecture '
    + 'and its trade-offs when the question is how to build, customize or extend something.',
  tools: ['load_platform_info'],
});

/** Premium's account brief: the intent, and the workflow of the same name it opens. */
export const ACCOUNT_BRIEF_INTENT = 'account_brief';

/**
 * THE ACCOUNT BRIEF WORKFLOW: research the account, then draft the brief. The research step requires the
 * company-context lookup (`requiresTool`, ADR-064 decision 3), so the task cannot reach drafting on figures
 * the person typed or the model remembered: `advance_task_state` out of `researching` is refused with
 * `required_tool_not_run` until `load_company_context` returned success since the task entered the step. The
 * lookup is the model's to make, because which document and which account it reads are judgment calls a
 * declared `action` cannot bind.
 */
export const ACCOUNT_BRIEF_WORKFLOW: TaskStateMachine = {
  initial: 'researching',
  states: {
    researching: {
      label: 'Researching the account',
      prompt:
        'Read the account in the customer accounts record with load_company_context (customer-accounts.json): '
        + 'its plan, ARR, users, renewal date, CSM and any risk noted. Once it is read, call advance_task_state with '
        + 'to_state "drafting" in this same turn. Do not write the brief in this step: it is written in drafting.',
      transitions: ['drafting'],
      tools: ['load_company_context'],
      requiresTool: ['load_company_context'],
    },
    drafting: {
      label: 'Drafting the brief',
      prompt:
        'Write the brief from the record: a one-line summary, the account facts with the renewal date, the risk '
        + 'on record, and the two or three points to raise on the call. Name anything the record does not say. '
        + 'When the brief is written, call advance_task_state with to_state "completed".',
      transitions: ['completed'],
    },
    completed: { label: 'Brief written', transitions: [], terminal: 'success' },
  },
};

export const STRATUM_INLINE_INTENTS: Record<'basic' | 'standard' | 'premium', InlineIntent[]> = {
  basic: [
    {
      key: 'product_info',
      summary:
        "ask about a Stratum product, plan or price and I will answer from our public documentation",
      description:
        'User asks about Stratum products, plans, pricing, features, integrations, or the public FAQ — '
        + 'answerable inline from the company overview (e.g. "what is in the StratumFlow Professional plan?", '
        + '"which integrations are supported?"). A single-turn answer, not a compiled report.',
      keywords: ['pricing', 'how much', 'feature', 'integration', 'stratumflow'],
      delivery: 'PLACEHOLDER_UPDATE',
      instructions:
        'Answer from the company overview and name the plan you are quoting. Give the figure or the '
        + 'feature list directly, then stop. If the question spans several plans, use a short table. '
        + 'Never quote a price you cannot find in context: say which plan you could not find and offer '
        + 'to check the FAQ.',
      // The only source this intent needs. Excluding the item tools keeps a pricing question from
      // becoming a plan the person did not ask for.
      tools: ['load_company_context'],
    },
    // THE PLATFORM INTENTS THIS ASSISTANT ACTUALLY DOES, by value.
    //
    // Basic answers EXTERNAL conversations from public documentation and hands over no files
    // (`richProcessor: false`, `imageGen: false`). It deliberately declares NO `report_generation`, NO
    // `data_extraction` and NO `image_generation`, and a request for any of them is refused with a
    // pointer to where it is served (DESIGN-CAPABILITY-REFUSAL), not answered inline.
    fromPlatform('guided_troubleshooting', {
      summary: 'tell me what is going wrong and I will work through it from the product documentation',
      instructions:
        'Troubleshoot from the public product documentation and the FAQ. Give the steps in order. If '
        + 'the fix needs internal access, an account change or a support ticket, say which one and stop '
        + 'rather than guessing at an internal process you cannot see.',
    }),
    PLATFORM_QUESTION_BASIC,
  ],
  standard: [
    {
      key: 'directory_lookup',
      summary:
        "ask who leads or owns a team and I will name them and their role",
      description:
        'User asks who someone is, who leads or owns a team, a person\'s role or manager, or how to reach a '
        + 'team — answerable inline from the employee directory (e.g. "who leads Platform Core?"). Exporting the '
        + 'whole roster as a table is data_extraction, not this.',
      keywords: ['who leads', 'who owns', 'reports to', 'contact for', 'directory'],
      delivery: 'PLACEHOLDER_UPDATE',
      instructions:
        'Give the name, the role and the team, in one or two sentences. Do not list a person\'s full '
        + 'reporting chain unless it was asked for. If the directory has no match, say so plainly and '
        + 'suggest the team alias rather than guessing at a name.',
      tools: ['load_company_context'],
      verbosity: 'tight',
    },
    {
      key: 'process_lookup',
      summary:
        "ask for a runbook, escalation path or SLA and I will give the steps in order",
      description:
        'User asks about an internal process, runbook, escalation path, response-time SLA, or operating '
        + 'procedure — answerable inline from internal processes (e.g. "what is the escalation path for a Sev-1?").',
      keywords: ['runbook', 'escalation', 'sla', 'on-call', 'policy'],
      delivery: 'PLACEHOLDER_UPDATE',
      instructions:
        'Give the steps in order, numbered, and name the owning team and the SLA where the process '
        + 'states one. Quote the process rather than paraphrasing a threshold or a timing - someone is '
        + 'likely acting on this during an incident. If the runbook is silent on what was asked, say '
        + 'which step it stops at instead of inferring the rest.',
      tools: ['load_company_context'],
    },
    // Standard is the INTERNAL assistant, so a report is a real capability here - built from the
    // directory and internal processes. Financial, account and competitive material stay out of reach,
    // which the instructions name rather than leaving the model to discover.
    fromPlatform('guided_troubleshooting'),
    fromPlatform('data_extraction', {
      instructions:
        'Export from the employee directory and internal process documentation only. Give the columns '
        + 'the person asked for and say how many rows you found. Financial, customer-account and '
        + 'competitive data are out of this assistant\'s reach - name what you could not include.',
    }),
    fromPlatform('report_generation', {
      summary: 'ask for a report and I will build it from the directory and internal process documentation',
      instructions:
        'Build the report from the company overview, the employee directory and internal process '
        + 'documentation. Structure it with headings, and name the internal source behind each section '
        + 'so a reader can check it. Financial figures, named customer accounts and competitive material '
        + 'are OUT of this assistant\'s reach: say so where the request asks for them instead of '
        + 'estimating, and point the person at the premium assistant for that material.',
    }),
    fromPlatform('image_generation'),
    // A short piece of code, answered in the message. Taken whole from the platform,
    // so its instructions and answer guidance (one fenced block, low temperature) come with it.
    fromPlatform('code_generation'),
    PLATFORM_QUESTION_INTERNAL,
  ],
  premium: [
    // A WORKFLOW WHOSE RESEARCH STEP REQUIRES ITS LOOKUP (ADR-064 decision 3). Declared before
    // `account_status`, which claims the word 'renewal' on the keyword fallback, so "an account brief for my
    // renewal call" opens the brief rather than a one-line status answer.
    {
      key: ACCOUNT_BRIEF_INTENT,
      summary:
        'ask for a brief on one customer account before a call and I will read the account record, then write it',
      description:
        'User asks for a written ACCOUNT BRIEF on ONE named customer account to prepare for a call, meeting or '
        + 'renewal (e.g. "prepare an account brief on Meridian Corp for my renewal call", "brief me on Apex before '
        + 'the QBR"). Researched from the account record, then drafted. A one-line status question about an '
        + 'account is account_status; a report across many accounts is report_generation.',
      keywords: ['account brief', 'brief me on', 'call prep', 'meeting prep'],
      delivery: 'TASK_MULTI_STEP',
      instructions:
        'Every figure in the brief comes from the account record: plan, ARR, users, renewal date, CSM and any '
        + 'risk on record. Figures the person gives are a lead to check, not the record. Where the record is '
        + 'silent, say so in the brief rather than filling the gap from the request.',
      tools: ['load_company_context'],
    },
    // ACCOUNTS BY REGION, AND THEIR TEAMS FOR A RUNNING CALL (SPEC-ASSISTANT-MEETINGS FR42). The record places each account
    // in a region and names its CSM with the CSM's person id (`csmPerson`, written by seed-demo), so the list is read from
    // the record and the teams it proposes for the call are people, never names. The proposal is a card the person who
    // asked confirms; it is offered only where the conversation's meeting is running.
    {
      key: 'impacted_accounts',
      summary: 'ask which customer accounts are in a region and I will list each with its CSM, ARR and renewal, and offer to bring their teams into a running call',
      description:
        'User asks which customer ACCOUNTS are in a REGION, or which are affected by something regional such as an outage or '
        + 'an incident (e.g. "which customers are in US East?", "which accounts are impacted in the EU?"). Answered inline '
        + "from the accounts record. One account's health or renewal is account_status; exporting accounts as a table is "
        + 'data_extraction.',
      keywords: ['which customers', 'which accounts', 'impacted accounts', 'affected accounts', 'customers are in'],
      delivery: 'PLACEHOLDER_UPDATE',
      instructions:
        'Read the accounts record (load_company_context, customer-accounts.json) and list every account the record places in '
        + 'the region asked about, by its region field: name, ARR, renewal date and CSM, one line each, then their total ARR. '
        + "Name no account the record does not place there. If propose_meeting_invites is offered (this conversation's "
        + "meeting is running), call it once, with one entry per CSM of the listed accounts: person is the account's "
        + "csmPerson exactly as the record gives it, name is its csm, accounts are that CSM's listed accounts, and brief is "
        + 'two to four sentences for that CSM: what the incident is and where it stands, from this conversation; which of '
        + 'their accounts are affected; and that they are asked to start drafting customer messaging. Leave out an account '
        + 'with no csmPerson and say so. Then end your reply by asking whether to add the account teams to the call.',
      tools: ['load_company_context', 'propose_meeting_invites'],
    },
    // THE CUSTOMER NOTICES AN INCIDENT'S CUSTOMER MESSAGING ASKS FOR (DESIGN-PROCESSES O30): the `customer-messaging` workflow asks
    // for each by this key, with the account team's template (initial, update or final) as the shape. Advisor drafts; the account
    // team adjusts and approves it on a card, so the draft is marked as one and sent to nobody.
    {
      key: 'customer_notice_draft',
      summary: 'ask me to draft a customer notice about an incident and I will write one for the account team to approve',
      description:
        'User asks for a DRAFT of the notice customers are sent about an incident or outage (e.g. "draft the customer notice", '
        + '"write the message to affected customers"). Which customers are affected is impacted_accounts.',
      keywords: ['customer notice', 'customer messaging', 'draft the notice'],
      delivery: 'PLACEHOLDER_UPDATE',
      instructions:
        'Draft one customer notice for the accounts this conversation has named as affected, from what the conversation '
        + 'says and nothing more. Where the request gives the notice\'s shape (the account team\'s template), keep that shape '
        + 'and fill each part; otherwise say what happened and since when, what customers may see, what is being done, and '
        + 'when the next update comes. Plain, calm and specific; no internal hostnames, people or causes the conversation has '
        + 'not confirmed. Head it "Draft for the account team", name the affected accounts and their CSMs, and end by saying '
        + 'the account team lead approves it with the CSMs. Send nothing: the draft is for the account team.',
      tools: ['load_company_context'],
    },
    {
      key: 'financial_metric',
      summary:
        "ask for a figure like ARR, churn or margin and I will give it with the period it covers",
      description:
        'User asks for a SINGLE financial figure or SaaS metric, stated inline — ARR, NRR / net revenue '
        + 'retention, churn rate, revenue by plan, gross margin, a specific quarter\'s number (e.g. "what was our '
        + 'Q2 ARR?", "current net revenue retention?"). Answer the figure directly in one turn. Compiling these '
        + 'into a written report is report_generation; exporting many rows is data_extraction.',
      keywords: ['arr', 'nrr', 'churn', 'gross margin', 'runway'],
      delivery: 'PLACEHOLDER_UPDATE',
      instructions:
        'State the figure, the period it covers and the source, in that order, and stop. A figure with '
        + 'no period is not an answer. If the latest period in context is older than the one asked for, '
        + 'give the figure you have and say which period it is - never extrapolate or blend two periods '
        + 'into one number. Do not open a task for a single figure.',
      tools: ['load_company_context'],
      verbosity: 'tight',
    },
    {
      key: 'account_status',
      summary:
        "ask about one customer account and I will give its health, renewal and risk",
      description:
        'User asks about ONE customer account\'s health, renewal, ARR, or churn risk, stated inline (e.g. "is '
        + 'Acme at risk?", "when does Globex renew?"). Exporting all at-risk accounts as a table is data_extraction.',
      keywords: ['at risk', 'churn risk', 'renewal', 'account health', 'upsell'],
      delivery: 'PLACEHOLDER_UPDATE',
      instructions:
        'Lead with the account\'s current status and renewal date, then the one or two factors driving '
        + 'it. Name the risk in the account record rather than inferring one from ARR alone. This is '
        + 'commercially sensitive: answer about the account that was asked for and do not volunteer '
        + 'comparisons to other named customers.',
      tools: ['load_company_context'],
    },
    {
      key: 'competitive_intel',
      summary:
        "ask how we compare to a competitor and I will answer from the competitive brief",
      description:
        'User asks how Stratum compares to a competitor, competitor positioning / pricing, or win/loss reasons — '
        + 'answerable inline from competitive intelligence (e.g. "how do we compare to Competitor X?", "why do we '
        + 'lose deals to Y?").',
      keywords: ['competitor', 'win rate', 'win/loss', 'positioning', 'differentiat'],
      delivery: 'PLACEHOLDER_UPDATE',
      instructions:
        'Answer from the competitive brief only. Give our position, their position, and the win/loss '
        + 'reason on record. Attribute every claim about a competitor to the brief, and where the brief '
        + 'has nothing, say so rather than characterizing them - an unsourced claim about a named '
        + 'competitor can leave this conversation.',
      tools: ['load_company_context'],
    },
    fromPlatform('guided_troubleshooting'),
    fromPlatform('data_extraction'),
    fromPlatform('strategic_analysis'),
    fromPlatform('image_generation'),
    fromPlatform('report_generation', {
      summary: 'ask for a report and I will draw on financials, accounts and competitive material as well as internal sources',
      instructions:
        'This assistant reaches the widest source set in the deployment: the company overview, the '
        + 'employee directory, internal processes, FINANCIAL metrics, named CUSTOMER ACCOUNTS and '
        + 'COMPETITIVE intelligence. Build the report from all of it where the request warrants, and say '
        + 'which sources each section draws on. Give every figure the period it covers. Where the '
        + 'material is commercially sensitive - account health, win/loss, margin - state it plainly for '
        + 'the people in this conversation, who are cleared for it, but do not restate it in a summary '
        + 'line that reads out of context.',
      // A report here is genuinely longer than at the other classifications, because there is more it
      // is allowed to be built from. The classification's token limit still clamps this.
      maxTokens: 6000,
      verbosity: 'long',
    }),
    PLATFORM_QUESTION_INTERNAL,
  ],
};

// ── THE `ops` ROLE'S TAXONOMY, SERVING (premium, ops) ──────────────────────────────────────────────
//
// A PACK BELONGS TO AN ASSISTANT, keyed by profile name, which is why this is its own list rather than a
// fourth entry in the per-classification record above. `ops-premium` is a second assistant inside
// `premium`, so a classification-keyed pack has nowhere to put it - and without one it had no intent of
// its own at all: every operational question reached the classifier as `general`, with no delivery class
// chosen for it and no instructions to answer it by. The owner's report of this was "no obvious intents
// to review and provide a summary of health".
//
// `deployment_health` IS DECLARED FIRST, AND THE ORDER IS LOAD-BEARING. `classifyByPackKeywords` returns
// the FIRST-listed match, and the platform's `guided_troubleshooting` claims the bare words 'error',
// 'fail' and 'fix' - so declared second, it would swallow "what is the error rate" into a multi-step
// troubleshooting task instead of a one-line reading of the metric. The same ordering reason
// `image_generation` is declared before `report_generation` in the platform pack.
export const OPS_INLINE_INTENTS: InlineIntent[] = [
  // STRATUM'S CUSTOMER API OUTAGE RUNBOOK, THE STEPS OPS RUNS (the incident room's `runbook-*` steps ask for them by these
  // keys). Ops reads and recommends; every change is the on-call's to decide and make on the cards the runbook gives them,
  // so these hold the read tool alone. One reply each, so the runbook goes on once Ops has answered.
  {
    key: 'runbook_cause',
    summary: "ask me for the runbook's mitigation reading and I will read what changed and recommend the runbook's action",
    description:
      "An incident conversation's runbook asks for its mitigation reading (step 5): find what changed and recommend the action. Asked by the "
      + "conversation's workflow, never by a person; a person asking how the deployment is doing is deployment_health.",
    keywords: ['runbook mitigation reading'],
    delivery: 'PLACEHOLDER_UPDATE',
    instructions:
      "You are running Stratum's Customer API outage runbook, step 5, mitigation: find what changed. Read the deployment's health with "
      + 'read_deployment_health: the alarm, and the customer-api metrics in the primary region beside it (success rate, p95 latency, '
      + 'packet loss, healthy hosts). Say in a few short lines when the success rate fell and how far, whether packet loss '
      + "and the healthy host count point at the network path or at the hosts, and the runbook's action with the "
      + "evidence for it: for a sudden drop with rising packet loss, the action is to shift customer-api traffic to the standby "
      + 'region. You make no change: say plainly that the on-call decides it on the card that follows. Do not guess at '
      + 'causes the data does not show.',
    tools: ['read_deployment_health'],
    verbosity: 'tight',
  },
  {
    key: 'runbook_verify',
    summary: "ask me for the runbook's verify step and I will say from the numbers whether the service is recovering",
    description:
      "An incident conversation's runbook asks for its recovery check (step 7), after the on-call's decision. Asked by the conversation's "
      + 'workflow, never by a person; a person asking how the deployment is doing is deployment_health.',
    keywords: ['runbook recovery check'],
    delivery: 'PLACEHOLDER_UPDATE',
    instructions:
      "You are running Stratum's Customer API outage runbook, step 7, recovery: verify it. Read the deployment's health with "
      + 'read_deployment_health and compare it with what you posted earlier in this conversation. Say in a few short lines whether '
      + "customer-api is recovering, holding or getting worse, from the numbers: the success rate against the alarm's 90% "
      + "threshold, packet loss and healthy hosts. If it is not recovering, recommend the runbook's escalation: page the "
      + 'secondary on-call and open a ticket with the network provider.',
    tools: ['read_deployment_health'],
    verbosity: 'tight',
  },
  // THE FIRST LOOK IS AN INTENT OPS ADVERTISES (WT118): another assistant's workflow asks for it by this key, and Ops's own
  // version runs it, on `incident_first_look`'s steps. A request names only what the owner advertises as multi-step, so an
  // intent left out of this pack is one no ops room can ask for.
  {
    key: 'incident_first_look',
    summary: "ask me for a first look at an incident and I will read the deployment's health and post what stands out in the conversation",
    description:
      'User asks for a first look at, or another read of, the incident this operations conversation is open for (e.g. "take a first '
      + 'look", "read the health again", "what changed since your last look?"). A general question about how the deployment '
      + 'is running, with no incident in view, is deployment_health.',
    keywords: ['first look', 'read the health again', 'another read'],
    delivery: 'TASK_MULTI_STEP',
    // It may publish the room's dashboard as part of the look (DESIGN-CONVERSATION-DASHBOARDS): the model chooses.
    tools: ['read_deployment_health', 'publish_dashboard'],
  },
  // A REFRESH ANOTHER ASSISTANT'S WORKFLOW REQUIRES (DESIGN-CONVERSATION-DASHBOARDS section 5): the incident watch asks for it by
  // this key on every alarm change, and Ops runs `dashboard_refresh`, whose one step publishes on entry. No model decides.
  {
    key: 'dashboard_refresh',
    summary: "ask me to refresh this conversation's dashboard and I will publish it again from the deployment's telemetry",
    description:
      "Another assistant's workflow asks for this conversation's dashboard to be refreshed after an alarm changed state. A person "
      + 'asking to see or share the dashboard is incident_dashboard.',
    keywords: ['refresh the dashboard'],
    delivery: 'TASK_MULTI_STEP',
    tools: ['publish_dashboard'],
  },
  // A RUN'S RUNBOOK DRAWN ON THIS CONVERSATION'S DASHBOARD (DESIGN-CONVERSATION-DASHBOARDS section 8.1): advertising it is Ops's
  // consent to be given the platform's quiet `dashboard_runbook` task when a labeled step of a run here moves. Its one step
  // draws each dashboard already published again, with no model call and no message.
  {
    key: 'dashboard_runbook',
    summary: "I keep the runbook section of this conversation's dashboard current as the incident's steps move",
    description:
      "The platform asks for this conversation's dashboard to show where a run's runbook stands after one of its steps moved. A "
      + 'person asking to see or share the dashboard is incident_dashboard.',
    keywords: [],
    delivery: 'TASK_MULTI_STEP',
    tools: ['publish_dashboard'],
  },
  {
    key: 'incident_dashboard',
    summary: "ask for this conversation's dashboard and I will publish one current view everyone here can open",
    description:
      'User asks to see, share, publish or refresh a dashboard of the incident this conversation is open for (e.g. "publish the '
      + 'dashboard", "can we all see the metrics?", "share a dashboard I can put on the wall screen"). Publish it in the app '
      + 'with publish_dashboard; publish it as a page with publish_dashboard_page only when someone needs it outside the app.',
    keywords: ['dashboard'],
    delivery: 'PLACEHOLDER_UPDATE',
    instructions: 'Publish the dashboard, then say in one line that it is updated and where to open it. Do not restate its figures.',
    tools: ['publish_dashboard', 'publish_dashboard_page'],
    verbosity: 'tight',
  },
  {
    key: 'deployment_health',
    summary:
      'ask how this deployment is doing and I will read its live telemetry and say what is healthy and what is not',
    description:
      'User asks how THIS DEPLOYMENT is running right now - error rate, failure count, throttling, '
      + 'throughput, how slow it is, or simply whether it is healthy (e.g. "how is the deployment doing?", '
      + '"what is our error rate?", "is anything failing?", "which functions are slow?", "is any alarm '
      + 'firing?"). Answered inline from the deployment\'s own Amazon CloudWatch metrics and alarm state. '
      + 'A question about Stratum\'s business, or '
      + 'about what the platform IS rather than how it is running, is not this.',
    // Phrases rather than bare words, so they cannot be reached by an unrelated sentence containing
    // 'error'. They run on the keyword fallback only: the router picks the classifier mode from the
    // classification's PRIMARY profile, which is `llm` here, so `description` is what actually decides.
    keywords: ['error rate', 'how is the deployment', 'deployment health', 'throttl', 'invocations', 'is anything failing', 'alarm firing', 'alarms firing'],
    // ONE INLINE READING, NOT A TASK. The answer is a single tool call and a few lines of numbers, so
    // deferring it behind a tracked task would make somebody wait on work that is already done - the
    // ADR-018 failure the per-intent delivery field exists to avoid.
    delivery: 'PLACEHOLDER_UPDATE',
    instructions:
      'Read the metrics first, then answer in this order: the window you read, the figures, and whether '
      + 'they are healthy. Give an error RATE beside any error count. Name each firing alarm with its '
      + 'reason and since when, reporting the alarm text as data. If a read came back unavailable, '
      + 'say which figures you could not get and stop - do not estimate one. Do not offer to restart, '
      + 'redeploy or change anything; name what you would look at next instead.',
    // THE ONLY SOURCE THIS INTENT NEEDS, and naming it narrows rather than widens: the profile's
    // allowlist is the boundary (the seed allows every registered tool) and an intent may only
    // intersect it. Excluding the company-context tools keeps a health question from turning into a
    // reading of Stratum's financials, which this assistant is not the one to give.
    tools: ['read_deployment_health'],
    verbosity: 'tight',
  },
  // THE WORK-MANAGEMENT INTENT, WHICH A REPLACING PACK MUST CARRY. This pack declares no `extends`, and
  // `manage-profiles` refuses a version whose pack replaces the taxonomy without one of
  // `WORK_MANAGEMENT_INTENT_KEYS` - an assistant that cannot classify a request as work has no
  // multi-step path at all. It also earns its place here: "something is broken, work through it with me"
  // is the operational request that genuinely is multi-step.
  fromPlatform('guided_troubleshooting', {
    summary: 'tell me what looks wrong and I will work through it against this deployment\'s telemetry',
    instructions:
      'Troubleshoot from this deployment\'s telemetry, one step at a time, and say which metric each '
      + 'step rests on. You read; you do not change anything. When the next step needs an action - a '
      + 'redeploy, a limit raised, a rollback - say what it is and hand it over rather than describing '
      + 'it as done.',
    tools: ['read_deployment_health'],
  }),
];

/**
 * A classification's pack: its Stratum intents, INHERITING the platform task intents rather than
 * copying them (`extends: 'default'`, resolved in `intent-pack.ts:getIntentPack`). The resolved
 * taxonomy is own intents first, then the platform ones. Universal greeting/acknowledgment/general are
 * added implicitly by the classifier.
 *
 * A copy of the platform intents would cost 3183 characters in each of three 4096-character parameters
 * before the deployment said anything of its own, and premium would not fit. What is stored is only what
 * Stratum ADDS, which is also the more honest description of what it is.
 */
export function stratumIntentPack(tier: 'basic' | 'standard' | 'premium'): StoredIntentPack {
  // NO `extends`. Each classification REPLACES the platform taxonomy with the intents that assistant
  // actually does, rather than inheriting all of them and declining the ones it cannot satisfy. See
  // `fromPlatform` above for why: an external conversation must not hold an assistant that recognizes
  // "write me a report on account health" as work it does.
  const pack: StoredIntentPack = { intents: [...STRATUM_INLINE_INTENTS[tier]] };
  return tier === 'premium'
    ? { ...pack, machines: { report_generation: PREMIUM_REPORT_WORKFLOW, [ACCOUNT_BRIEF_INTENT]: ACCOUNT_BRIEF_WORKFLOW } }
    : pack;
}

/**
 * The templates premium offers a report in (`demo/templates/`), stored by `seed-demo`. The quarterly
 * account review is used when the person names no format.
 */
export const PREMIUM_REPORT_TEMPLATES = ['quarterly-account-review', 'executive-summary'] as const;

/**
 * A PLATFORM WORKFLOW, MATERIALIZED with its delivering states offering a choice of templates. Copied by
 * value from `DEFAULT_TASK_STATE_MACHINES`, as `fromPlatform` copies an intent, so every other state and
 * every prompt stays the platform's: only the template declaration changes, from the platform's single
 * `report` to a choice the requirements step puts to the person (SPEC-DOCUMENT-TEMPLATES FR3a).
 */
export function withTemplateChoice(taskType: string, templates: readonly string[], defaultTemplate: string): TaskStateMachine {
  const platform = DEFAULT_TASK_STATE_MACHINES[taskType];
  if (!platform) throw new Error(`demo/intent-packs: '${taskType}' is not a platform workflow`);
  const states: TaskStateMachine['states'] = {};
  for (const [name, { template: _single, ...def }] of Object.entries(platform.states)) {
    states[name] = def.produces === 'document' ? { ...def, templates: [...templates], defaultTemplate } : def;
  }
  return { ...platform, states };
}

const PREMIUM_REPORT_WORKFLOW = withTemplateChoice('report_generation', PREMIUM_REPORT_TEMPLATES, PREMIUM_REPORT_TEMPLATES[0]);

/**
 * The `ops` role's pack. Keyed by nothing: there is one ops assistant and it is named by profile, so the
 * seeder passes this under `ops-premium` the same way it passes a classification's pack under that
 * classification's profile name. No `extends`, for the reason every pack here declines it.
 */
export function opsIntentPack(): StoredIntentPack {
  return { intents: [...OPS_INLINE_INTENTS] };
}
