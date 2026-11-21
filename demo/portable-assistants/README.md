# Portable assistants: review, approve, implement

The premium classification starts with one assistant, Advisor. The demo manages Advisor, then adds a second assistant to the same classification, Ops, which reads this deployment's own Amazon CloudWatch metrics and alarms. Adding Ops is a deploy that someone reviews and approves; after that the two answer in one conversation, each as itself, and an AWS alarm opens an incident from the operations team's conversation, in a conversation of its own owned by whoever is on call.

The walkthrough is [WALKTHROUGH.md](WALKTHROUGH.md).

## What is here

| File | What it is |
|---|---|
| `ops-assistant-manifest.ts` | The Ops assistant's definition, imported when its role is added |
| `ops-workflows.ts` | The workflows Advisor gains once Ops exists: the ops conversations' welcomes, the ops conversation's opening and first look, and the incident |
| `welcomes.ts` | What Advisor and Ops each say when they join an ops conversation or the operations team's conversation |
| `templates/` | Message and report templates the walkthrough publishes during the demo |

Ops's persona, kinds of request and boundary are part of the company, in [`../stratum-company/`](../stratum-company/README.md).

## Setup

To run only the incident response, follow "Presenting it" at the top of [WALKTHROUGH.md](WALKTHROUGH.md). The full walkthrough starts from this setup. Every command runs from `backend/` in a Bash shell:

```bash
cd backend
export AWS_PROFILE=<your-profile>
```

**1. Deploy without Ops declared**: `profiles` in `deploy.config.json` absent or `["basic", "standard", "premium"]`.

```bash
npm run deploy
```

**2. Seed the company.**

```bash
npm run validate -- --only=seed
```

**3. Create the demo's people.** Their passwords are generated and stored in the `agent-interface/demo-credentials` secret, never in a file. The cast includes the on-call lead, the only member of `ops-on-call`, who owns each incident, and the account team's lead.

```bash
npm run provision-test-users -- --cast ops-demo
```

**4. Publish Advisor's two message templates.**

```bash
npm run template -- put premium ../demo/portable-assistants/templates/advisor-incident-alarm-changed.md --assistant advisor --activate
npm run template -- put premium ../demo/portable-assistants/templates/advisor-invitation-sent.md --assistant advisor --activate
```

**5. Create the demo alarm the scenes set by hand.** Any CloudWatch alarm works; this one watches a metric nothing writes, so it changes only when you set it.

```bash
aws cloudwatch put-metric-alarm --alarm-name <your demo alarm name> --namespace Demo --metric-name Probe --statistic Sum --period 60 --evaluation-periods 1 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data ignore
```

**6. Create the outage alarm**, for an incident driven by real data: a healthy baseline for the past three hours in `AgentEchelon/Demo`, and `Customer-API-availability` on the success rate (under 90% for 2 of 2 minutes), named for the service it watches and described by what that service does for its users. Attach its ARN to `incident-triage` in 3.3b.

```bash
npm run demo:outage -- setup
```

During the walkthrough, these drive the outage, read it and restore it:

```bash
npm run demo:outage -- outage --recover-on-call
npm run demo:outage -- status
npm run demo:outage -- reset
```

The walkthrough adds Ops itself in 2.3, whose version carries the ops conversations' workflows, and then puts Advisor's welcomes for those conversations on Advisor:

```bash
npm run add-assistant-role -- ops-premium
npm run ops-workflows -- add
```

### The operations team's conversation

Before scene 3.2, open the operations team's standing conversation once. It is one conversation per classification with a fixed id, led by the `ops-on-call` group's one member. This removes its assistants if it stands and has its creator complete it, so each assistant's welcome is said again:

```bash
npm run demo:team-room
```

Its channel ARN, which scene 3.2 names, is always `<app instance ARN>/channel/team-ops-team-premium`. Attaching the demo alarm to `incident-triage` in scene 3.3b opens or completes the same conversation.

## Reset

Return the classification to Advisor alone:

```bash
npm run ops-workflows -- remove
npm run add-assistant-role -- --remove
```

Retire assistants created in the console and delete the cast's conversations from the run (without `--apply`, it lists what it would change):

```bash
npm run reset-demo -- --since=<the time you started> --apply
```

Write healthy data until the outage alarm is `OK` again:

```bash
npm run demo:outage -- reset
```

Every change to an assistant is a version, and this returns to any earlier one:

```bash
npm run assistant -- rollback <assistant> --version <n>
```
