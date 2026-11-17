---
name: agent-cleaner
description: >
  Use when the user asks to inspect, clean, or free up disk space used by AI coding
  agents (Claude Code, OpenCode, Codex CLI, DSH, Gemini/Antigravity, Cursor, Ollama, Aider),
  diagnose or repair broken MCP/agent configs, kill orphan MCP processes, or restore
  previously cleaned files from the agent-cleaner trash.
---

# Agent Cleaner Operating Protocol

You have access to the `agent-cleaner` MCP tools (`cleaner_scan`, `cleaner_clean`, `cleaner_restore`, `cleaner_doctor`, `cleaner_mcp_audit`). Follow these mandatory safety rules on every invocation:

## Safety Rules

1. **Always scan before cleaning**: Never call `cleaner_clean` without first running `cleaner_scan` and presenting the reclaimable breakdown (size, category, agent, and recommendation level) to the user.
2. **Respect the 24-hour active guard**: By default, files modified within the last 24 hours are marked `exempt`. Do not bypass `olderThanHours` unless the user explicitly asks to clean recent files.
3. **Prefer recommended items first**: When the user asks for a safe cleanup, pass `onlyRecommended: true` or explicitly select only `recommended` item IDs. Confirm before cleaning `optional` items (archives, backups, snapshots, undeclared `node_modules`).
4. **Confirm destructive actions**: Before executing `cleaner_clean` (without `dryRun: true`), `cleaner_doctor` with `fix: true`, or `cleaner_mcp_audit` with `kill: true`, get explicit user approval unless they already asked for immediate execution.
5. **Always return the rollback handle**: Every non-dry-run `cleaner_clean` moves files to `~/.agent-cleaner/trash/<batchId>/` instead of deleting permanently. Always surface the returned `batchId` and tell the user they can undo via `cleaner_restore` or `ac restore <batchId>`.

## Workflows

### Disk Cleanup
1. Call `cleaner_scan`.
2. Summarize total disk usage, reclaimable bytes per agent, and group items by `recommended` vs `optional` vs `exempt`.
3. Ask the user whether to proceed (or run `cleaner_clean` with `dryRun: true` first to preview).
4. Execute `cleaner_clean` and report freed space + `batchId`.

### Config Self-Healing
1. Call `cleaner_doctor` with `fix: false` first.
2. Show syntax errors and dead-link MCP entries per config file.
3. With approval, call `cleaner_doctor` with `fix: true` (backups are saved to `~/.agent-cleaner/backups/`).

### Orphan MCP Process Audit
1. Call `cleaner_mcp_audit` with `kill: false` to inspect dead links, duplicate cross-agent entries, cold `~/.npm/_npx` / `~/.cache/uv` caches, and `PPID=1` orphan stdio processes.
2. With approval, call `cleaner_mcp_audit` with `kill: true` to terminate orphan processes gracefully (`SIGTERM` -> `SIGKILL`).
