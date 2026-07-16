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
