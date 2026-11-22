---
name: agent-cleaner
description: >
  Use when the user asks to inspect, clean, or free up disk space used by AI coding
  agents (Claude Code, OpenCode, Codex CLI, DSH, Gemini/Antigravity, Cursor, Ollama, Aider),
  diagnose or repair broken MCP/agent configs, kill orphan MCP processes, or restore
  previously cleaned files from the agent-cleaner trash.
---

# Agent Cleaner Operating Protocol

## Execution Channels

Use **Primary (MCP Tools)** whenever the `agent-cleaner` MCP server is connected. If MCP tools are not registered in the current session, seamlessly use **Fallback (CLI `--json` via `npx`, no global CLI install required)** via shell:

- **Scan**: MCP `cleaner_scan` | Fallback `npx -y dsh-agent-cleaner scan --older-than 24h --json`
- **Clean**: MCP `cleaner_clean` | Fallback `npx -y dsh-agent-cleaner clean --yes [--only-recommended] [--dry-run] [--ids id1,id2] --older-than 24h --json`
- **Doctor**: MCP `cleaner_doctor` | Fallback `npx -y dsh-agent-cleaner doctor [--fix] --json`
- **MCP Audit**: MCP `cleaner_mcp_audit` | Fallback `npx -y dsh-agent-cleaner mcp [--kill] [--pid <pid>] --json`
- **Restore**: MCP `cleaner_restore` | Fallback `npx -y dsh-agent-cleaner restore [<batchId>] --json`

## Safety Rules

1. **Always scan before cleaning**: Never run a clean operation without first scanning and presenting the reclaimable breakdown (size, category, agent, and recommendation level) to the user.
2. **Respect the 24-hour active guard**: By default, files modified within the last 24 hours are marked `exempt`. Do not bypass `olderThanHours` / `--older-than` unless the user explicitly asks to clean recent files.
3. **Prefer recommended items first**: When the user asks for a safe cleanup, pass `onlyRecommended: true` (`--only-recommended`) or explicitly select only `recommended` item IDs. Confirm before cleaning `optional` items (archives, backups, snapshots, undeclared `node_modules`).
4. **Confirm destructive actions**: Before executing `cleaner_clean` (without `dryRun: true`), `cleaner_doctor` with `fix: true`, or `cleaner_mcp_audit` with `kill: true`, get explicit user approval unless they already asked for immediate execution.
5. **Always return the rollback handle**: Every non-dry-run clean moves files to `~/.agent-cleaner/trash/<batchId>/` instead of deleting permanently. Always surface the returned `batchId` and tell the user they can undo via `cleaner_restore` or `npx -y dsh-agent-cleaner restore <batchId>`.

## Workflows

### Disk Cleanup
1. Scan via `cleaner_scan` (or `npx -y dsh-agent-cleaner scan --older-than 24h --json`).
2. Summarize total disk usage, reclaimable bytes per agent, and group items by `recommended` vs `optional` vs `exempt`.
3. Ask the user whether to proceed (or preview first with `dryRun: true` / `--dry-run`).
4. Execute `cleaner_clean` (or `npx -y dsh-agent-cleaner clean --yes ... --json`) and report freed space + `batchId`.

### Config Self-Healing
1. Run `cleaner_doctor` with `fix: false` (or `npx -y dsh-agent-cleaner doctor --json`) first.
2. Show syntax errors and dead-link MCP entries per config file.
3. With approval, run `cleaner_doctor` with `fix: true` (or `npx -y dsh-agent-cleaner doctor --fix --json`) — comments are preserved and backups are saved to `~/.agent-cleaner/backups/`.

### Orphan MCP Process Audit
1. Run `cleaner_mcp_audit` with `kill: false` (or `npx -y dsh-agent-cleaner mcp --json`) to inspect dead links, duplicate cross-agent entries, cold `~/.npm/_npx` / `~/.cache/uv` caches, and `PPID=1` orphan stdio processes.
2. With approval, run `cleaner_mcp_audit` with `kill: true` (or `npx -y dsh-agent-cleaner mcp --kill --json`) to terminate orphan processes gracefully (`SIGTERM` -> `SIGKILL`).

### Trash & Restore
1. List available batches via `cleaner_restore` (without `batchId`) or `npx -y dsh-agent-cleaner restore --json`.
2. With approval for a chosen `batchId`, restore files back to their original paths via `cleaner_restore` (`batchId`) or `npx -y dsh-agent-cleaner restore <batchId> --json`.
