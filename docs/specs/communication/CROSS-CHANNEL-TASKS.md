# Cross-Channel Task Continuity

**Status:** Implemented.

**Problem and who it's for:** When people carry on work across several conversations, each multi-step task should stay pinned to the conversation where it lives - never accidentally resumed in another - while the assistant still knows the user has work open elsewhere. This is for the end user (whose tasks stay where they belong) and the platform developer, who would otherwise hand-roll cross-conversation task scoping on top of the messaging layer. It scopes task resume to a matching `channelArn` while surfacing out-of-channel tasks to the assistant only as a prompt hint, never an auto-resume.

**Site section:** Communication layer (task continuity across conversations; placement - owner call).


**Audience:** Anyone working on agent behavior, task tracking, or the asynchronous-fulfillment pipeline.

## How it works

Tasks (`guided_troubleshooting`, `data_extraction`, `report_generation`, `place_item`, `action_item`) are resumed only when the active row's `channelArn` matches the current channel. Tasks active in OTHER channels are surfaced to the agent via a brief prompt hint, never auto-resumed. This keeps a task that lives in Channel A from being accidentally picked up in Channel B, while still giving the agent awareness that the user has work open elsewhere.

## The two paths

### Resume - channel-scoped, deterministic

`getActiveTask(userSub, taskType, { channelArn })` queries the `userSub-taskType-index` GSI and adds `channelArn = :channelArn` to the filter. Same-channel tasks resume normally. Tasks in other channels are invisible to this path.

Called from the single agent handler:
- `router-agent-handler.ts` (the shared router / Lex fulfillment Lambda that serves every classification and profile; `backend/lambda/src/router-agent-handler.ts` ~line 796)

The handler iterates the task-type list (`guided_troubleshooting`, `data_extraction`, `report_generation`), looks up each scoped by `channelArn`, and stops at the first match. If no task is active in the current channel, the resume path returns null and the handler proceeds with a fresh classification.

GREETING and ACKNOWLEDGMENT intents short-circuit *before* the active-task lookup runs (the resume path is intent-gated). A user typing "hi" never triggers a task lookup, which is intentional - saves a DDB roundtrip on trivial messages.

### Awareness - prompt-only, never auto-resumes

`getActiveTasksForUser(userSub, opts?)` queries the `UserTasksTable` by PK (`userSub = :userSub`) - no GSI, no Scan. Returns every active task for the user across all channels, sorted by `updatedAt` desc, capped at `opts.limit` (default 10, hard ceiling 25).

`buildCrossChannelTasksHint(currentChannelArn, allActive)` filters out tasks in the current channel and produces a system-prompt fragment:

```
## OTHER ACTIVE WORK

The user has 2 active tasks in other conversations (1 report_generation, 1 data_extraction).

Do NOT interrupt the current conversation to handle them. Only acknowledge them if the user's message references one (e.g. "what was I working on?"), in which case offer to pick the thread up there.
```

The hint is intentionally terse - no other channels' ARNs, no task content, no message excerpts. The agent gets COUNT + TYPE only. Two reasons:

1. **Privacy.** Other-channel ARNs in the prompt would let the agent reveal channel identifiers the user didn't ask about. The hint is metadata, not data.
2. **Performance.** Looking up other channels' names (e.g. for "in your Q3 sales conversation") would require an Amazon Chime SDK `DescribeChannel` per other-channel task. That cost would land on every turn for users with multiple active tasks. Worth it only if user testing proves the richer hint moves the needle.

Called from the shared async processor at prompt-build time:
- `assistant-async-processor.ts` (every profile with `richProcessor`; the shared processor gates the hint on task support; `backend/lambda/src/assistant-async-processor.ts` ~line 525)

Best-effort: a failure of the cross-channel lookup logs and proceeds. The agent still replies; it just doesn't know about other-channel work for that turn.

## Schema

The pattern uses the existing two-table layout (no DDB migrations):

| Table | Key | Purpose |
|---|---|---|
| `AgentTasksTable` | PK=`taskId`, SK=`channelArn` | Full task record (state, details, status) |
| `UserTasksTable` | PK=`userSub`, SK=`taskId` | Active-task lookup; lightweight row |
| `userSub-taskType-index` (GSI on UserTasksTable) | PK=`userSub`, SK=`taskType` | "Active task of type T for user U" lookup |

Both tables are defined in `backend/lib/stacks/foundations-stack.ts` (grep `AgentTasksTable` and `UserTasksTable`); the GSI definition lives alongside the UserTasksTable construct.

`getActiveTasksForUser` is a constant-cost PK query on `UserTasksTable`, not a Scan. With the 24h TTL the existing code sets on UserTasksTable rows (`backend/lambda/src/lib/task-tracking.ts` ~line 155), the cardinality stays bounded - a user who hasn't been active in a day has no UserTasksTable rows at all.

## What is deliberately out of scope

- **Cross-channel resume.** A user saying "continue the report" in Channel B does not auto-resume the Channel A task. The hint tells the agent the task exists; if the user explicitly asks, the agent can offer to navigate them to the other channel (using the existing `NAVIGATE_CHANNEL` marker the frontend already handles). Auto-resuming would be a meaningful UX change and is out of scope.
- **Channel name in the hint.** As above: an extra Amazon Chime SDK call per turn for marginal value, so it is out of scope.
- **Cross-channel battle tasks.** Battle tasks intentionally do NOT write to `UserTasksTable` (per-bot ownership, see SPEC-BATTLE.md). They do not appear in the cross-channel hint, which is correct: a battle's tasks are channel-local by design.

## Privacy boundary

The hint exposes COUNTS + TASK-TYPE LABELS, not channel ARNs or content. This is by design - task counts are metadata, conversation content is not. There is one nuance worth flagging:

A task created in a **private 1:1 channel** between the user and the bot will surface in the cross-channel hint when the same user later sends a message in a **multi-member channel** with co-workers. The hint there says e.g. "1 active task in another conversation (data_extraction)" - visible to the bot, NOT directly to the co-workers (the bot reasons about it but doesn't emit it as text by default). The agent prompt does instruct the model NOT to interrupt the current conversation with these references.

Failure mode: if a deployer treats task TYPE itself as confidential (e.g. an internal taxonomy where seeing "data_extraction" reveals business intent), the hint may leak that signal. Two mitigations:

1. **Disable the hint** by skipping the `buildCrossChannelTasksHint` call in the async processor. Quick and total.
2. **Redact task types** by passing only counts (not type breakdown)
 - a small change to `buildCrossChannelTasksHint`.

For most deployments the default behavior is correct. The note is here so deployers with a stricter privacy posture see the consideration before they hit it in user testing.

## Operational notes

**Failure isolation.** The cross-channel lookup wraps in try/catch and logs to CloudWatch on failure. Grep format:

- `[AssistantAsyncProcessor] cross-channel task hint failed (non-fatal): <error>`

The reply proceeds without the hint when this happens - the agent loses cross-channel awareness for that turn only. A chronic occurrence points at a UserTasksTable / IAM problem worth investigating.

**Cost.** One additional `Query` per turn against `UserTasksTable` under PK. PAY_PER_REQUEST (default in this project) charges per read-request-unit; expected ~$0.000000125 per turn at current AWS pricing. No additional cost for the hint emission itself (no DDB writes, no Amazon Chime SDK calls, just a string concat into the prompt).

**Latency.** Expected p50 in the 5-15ms range based on DynamoDB PK query semantics. No measurements taken on this specific call site; if turn latency becomes a concern, this is a clean instrumentation candidate (wrap the call site in `emitDriftTiming`-style EMF emit).

**Observability.** Every async-processor invocation emits `activeTaskInfo` to the analytics pipeline when a same-channel task resumes; cross-channel hint emission is **silent** (no EMF, no analytics). Because that path emits no telemetry, a chronic `UserTasksTable` issue (IAM regression, hot partition, accidental TTL miss) is invisible until a user reports the agent forgetting about other-channel work.

**Test coverage.** `backend/test/lib/task-tracking-cross-channel.test.ts` pins the 14 cases that matter:
- Back-compat: `getActiveTask` without `opts.channelArn` works as before.
- Scoping: `opts.channelArn` adds the filter.
- Cross-channel: `getActiveTasksForUser` PK-queries the right table, respects `opts.limit` with sensible clamping.
- Prompt-hint: never emits other-channel ARNs; aggregates same-type tasks; handles the missing-`taskType` case.

**ARN-leak coverage.** The ARN-leak test checks that specific channel ARNs (`CHANNEL_A`) don't appear in the rendered hint. It does not assert the hint contains no `arn:aws:chime:` substring at all, so a future-form ARN leak (e.g. someone adding a `task.channelArn` interpolation thinking they're enriching the hint) is not caught by it.

## Related

- `backend/lambda/src/lib/task-tracking.ts` - implementation
- `backend/test/lib/task-tracking-cross-channel.test.ts` - tests
- `docs/specs/capabilities/SPEC-BATTLE.md` - battle tasks (excluded from this pattern)
