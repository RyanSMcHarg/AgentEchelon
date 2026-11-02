# AgentEchelon, Claude Code notes

> **Claude Code auto-loads this file.** The assistant guidance for this repo is vendor-neutral and lives in **[`AGENTS.md`](AGENTS.md)**, read that first: project overview, build/run/test/deploy commands, session setup, architecture map, and the must-know conventions. It is shared by every AI assistant (Claude Code, Codex, Gemini CLI) so there is a single source of truth, not three copies that drift.
>
> The authoritative, assistant-neutral documentation is `README.md`, `docs/overview/ARCHITECTURE.md`, and `docs/guides/user/TROUBLESHOOTING.md`. None of this (this file, `AGENTS.md`, or any assistant) is required to use the project.

This file adds only what is specific to Claude Code.

## Claude Code hooks (optional)

`.claude/hooks/doc-context.js` runs on every `UserPromptSubmit`. When the prompt looks planning-shaped (`plan`, `design`, `implement`, `how to`, ...) or troubleshooting-shaped (`broken`, `failing`, `error`, `fix`, ...) it greps the shareable docs (`AGENTS.md`, `CLAUDE.md`, and `docs/*.md`) and injects the top-scoring excerpts as context before the model reads the prompt. Neutral prompts get nothing; the hook never blocks.

Goal: every planning or fix turn forces a doc lookup. If the docs do not have what is needed, that gap surfaces in the assistant's normal session, exactly what an OSS user would hit. Filing the doc gap is part of the work.

Wiring is in `.claude/settings.json` (checked in, so the behavior ships to every contributor). To disable locally, override in `.claude/settings.local.json` or unset the hook.

## Serial test runs (enforced, not advised)

`.claude/hooks/serial-test-runs.js` runs on `PreToolUse` for `Bash` and `PowerShell` and **denies** four command shapes: a hand-written `--shard`, two test runs chained in one command, the whole backend suite in a single call, and anything test-shaped while a run already holds the lock.

Four Jest shards started at once hard-lock a development machine (16 ts-jest workers, each holding a full TS program), enough to lose uncommitted work. Advice in prose does not prevent it, so the rule is a refusal.

### Run it a shard at a time, and read the record rather than the scrollback

A full pass outlives the ten minutes an automated tool call gets, so it is moved to the background, and a backgrounded run is killed often enough to be assumed. So the runner is built for that rather than against it:

```
cd backend
node scripts/run-test-shards.mjs --shards=8 --only=1     # one shard, fits a foreground call
node scripts/run-test-shards.mjs --shards=8 --from=5     # resume after a kill
npm run test:report                                       # what is known so far, takes no lock
npm run test:slice -- test/lib/stop                       # a targeted slice while iterating
```

Reports accumulate in `backend/test-results/` and are **never deleted**, so a killed run still tells you which shards passed and which tests failed, and names the command that continues it. Reading the record with `--report` takes no lock, so it works while a run is in flight.

**An incomplete run exits non-zero and says the suite is NOT proven**, so a run that lost shards to a dead worker pool never ends on a green line.

The transform cache is ON and pinned to `backend/node_modules/.cache` (measured: roughly half the wall clock of every run was recompiling what the previous run had already compiled). If the partial-import flake that once justified `cache: false` reappears, set `AE_JEST_NO_CACHE=1` and record what you saw.

See the "One test run at a time" section of [`AGENTS.md`](AGENTS.md) for the mechanism, including the vendor-neutral lock that binds runs this hook cannot see (a terminal, another assistant). An assistant should not reach for the `AE_ALLOW_CONCURRENT_TESTS=1` override; it exists for the owner.

## Deploys go through the guarded scripts (enforced)

`.claude/hooks/deploy-through-the-guard.js` runs on `PreToolUse` for `Bash` and `PowerShell` and **denies** a raw `cdk deploy`. Deploy one stack with `cd backend && npm run deploy:stack -- <Stack>` (`--diff-only` to look first), or every stack with `npm run deploy`. `cdk diff`, `cdk list` and `cdk synth` pass through.

Both scripts apply `deploy.config.json`, and both refuse a deploy whose stack's recorded live commit is not an ancestor of the checkout, then record the new one (see "Rollback check" in [`docs/overview/STACKS.md`](docs/overview/STACKS.md)). A raw single-stack deploy from a checkout behind what is live removes live commits while CloudFormation reports success. The override, `AE_ALLOW_RAW_CDK_DEPLOY=1`, exists for the owner.

## Tenet review on every planning turn (optional)

`.claude/hooks/tenets.js` runs on every `UserPromptSubmit`. When a prompt is shaped like a decision a tenet already settles - anything that waits on a timer, records a fact, writes something a person reads, decides from what someone said, crosses an access boundary, or builds something new - it reads the matching tenets out of [`docs/overview/TENETS.md`](docs/overview/TENETS.md) and injects them before the model answers. Neutral prompts get nothing.

The text is read from the document rather than restated in the hook, so editing a tenet changes what the hook surfaces. A hardcoded copy is a snapshot, and snapshots rot faster than the documents they describe - the same reason `reuse-first.js` counts implementations live.

Why it exists: the tenets are the easiest thing in this repo to reason past, and not by disagreeing with them. The typical misses are a client that polls on an interval (tenet D6), a metric that counts what the ledger already counts (tenet D7), and user-facing copy written as fixed English (tenets P5 and D11), each with a comment explaining the shortcut and each caught only by a person reading the diff.

**It is advisory and cannot block.** A hook that refuses work on a keyword match trains people to route around it, and then it catches nothing. The half that binds is `backend/test/tenets-are-enforced.test.ts`, which fails CI on the specific rules that can be checked mechanically - the pairing `reuse-first.js` already uses: a hook that nudges plus a test that refuses.

Most tenets cannot be mechanically checked, and that test does not pretend otherwise. It guards the places a rule was already broken once, which is the honest place to spend a guard.
