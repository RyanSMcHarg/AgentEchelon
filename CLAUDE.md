# AgentEchelon, Claude Code notes

> **Claude Code auto-loads this file.** The assistant guidance for this repo is vendor-neutral
> and lives in **[`AGENTS.md`](AGENTS.md)**, read that first: project overview, build/run/test/
> deploy commands, session setup, architecture map, and the must-know conventions. It is shared
> by every AI assistant (Claude Code, Codex, Gemini CLI) so there is a single source of truth,
> not three copies that drift.
>
> The authoritative, assistant-neutral documentation is `README.md`, `docs/overview/ARCHITECTURE.md`, and
> `docs/guides/user/TROUBLESHOOTING.md`. None of this (this file, `AGENTS.md`, or any assistant) is required
> to use the project.

This file adds only what is specific to Claude Code.

## Claude Code hooks (optional)

`.claude/hooks/doc-context.js` runs on every `UserPromptSubmit`. When the prompt looks
planning-shaped (`plan`, `design`, `implement`, `how to`, ...) or troubleshooting-shaped
(`broken`, `failing`, `error`, `fix`, ...) it greps the shareable docs (`AGENTS.md`, `CLAUDE.md`,
and `docs/*.md`) and injects the top-scoring excerpts as context before the model reads the
prompt. Neutral prompts get nothing; the hook never blocks.

Goal: every planning or fix turn forces a doc lookup. If the docs do not have what is needed,
that gap surfaces in the assistant's normal session, exactly what an OSS user would hit. Filing
the doc gap is part of the work.

Wiring is in `.claude/settings.json` (checked in, so the behavior ships to every contributor).
To disable locally, override in `.claude/settings.local.json` or unset the hook.

## Serial test runs (enforced, not advised)

`.claude/hooks/serial-test-runs.js` runs on `PreToolUse` for `Bash` and `PowerShell` and **denies**
four command shapes: a hand-written `--shard`, two test runs chained in one command, the whole
backend suite in a single call, and anything test-shaped while a run already holds the lock.

Four Jest shards started at once hard-lock this machine (16 ts-jest workers, each holding a full TS
program with `cache: false`) and it has cost a session's uncommitted work. This was recorded in prose
in three separate documents and happened anyway, which is why it is now a refusal.

Run the suite with `cd backend && npm run test:shards`, in the background. See the "One test run at a
time" section of [`AGENTS.md`](AGENTS.md) for the mechanism, including the vendor-neutral lock that
binds runs this hook cannot see (a terminal, another assistant). An assistant should not reach for
the `AE_ALLOW_CONCURRENT_TESTS=1` override; it exists for the owner.
