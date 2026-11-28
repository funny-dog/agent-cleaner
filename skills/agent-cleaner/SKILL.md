---
name: agent-cleaner
description: >
  Use when the user asks to inspect, clean, or free up disk space used by AI coding
  agents (Claude Code, OpenCode, Codex CLI, DSH, Gemini/Antigravity, Cursor, Ollama, Aider),
  diagnose or repair broken MCP/agent configs, audit cross-agent MCP conflicts or orphan
  processes, manage whitelist/retention settings, or restore files and config backups.
---

# Agent Cleaner Operating Protocol

## Execution Channels

Use **Primary (MCP Tools)** whenever the `agent-cleaner` MCP server is connected. If MCP tools are not registered in the current session, seamlessly use **Fallback (CLI `--json` via `npx`, no global CLI install required)** via shell:

- **Overview**: MCP `cleaner_overview` | Fallback `npx -y dsh-agent-cleaner overview [--older-than 24h] [--lang zh|en] --json`
- **Scan**: MCP `cleaner_scan` | Fallback `npx -y dsh-agent-cleaner scan [--progress-json] --older-than 24h --json`
- **Clean**: MCP `cleaner_clean` | Fallback `npx -y dsh-agent-cleaner clean --yes [--only-recommended] [--dry-run] [--permanent] [--ids id1,id2] --older-than 24h --json`
- **Doctor**: MCP `cleaner_doctor` | Fallback `npx -y dsh-agent-cleaner doctor [--fix] [--ids id1,id2] --json`
- **MCP Audit**: MCP `cleaner_mcp_audit` | Fallback `npx -y dsh-agent-cleaner mcp [--kill] [--pid <pid>] --json`
- **Restore & Trash**: MCP `cleaner_restore` | Fallback `npx -y dsh-agent-cleaner restore [<batchId>] [--prune] [--purge <batchId>] [--purge-all] --json`
- **Config & Whitelist**: MCP `cleaner_config` | Fallback `npx -y dsh-agent-cleaner config [show|set|ignore|ignore-agent] --json`
- **Config Backups**: MCP `cleaner_backups` | Fallback `npx -y dsh-agent-cleaner backups [list|restore <backupId>|delete <backupId>|prune] --json`

## Safety Rules

1. **Always scan before cleaning**: Never run a clean operation without first scanning and presenting the reclaimable breakdown (size, category, agent, and recommendation level) to the user.
2. **Respect the active guard & whitelist**: Files modified within `exempt_hours` (default 24h) and paths matching `ignored_paths` in `~/.agent-cleaner/config.toml` are marked `exempt`. Do not bypass `exemptHours` / `--older-than` or pass `permanent: true` (`--permanent`) unless the user explicitly asks.
3. **Prefer recommended items first**: When the user asks for a safe cleanup, pass `onlyRecommended: true` (`--only-recommended`) or explicitly select only `recommended` item IDs. Confirm before cleaning `optional` items (archives, backups, snapshots, undeclared `node_modules`).
4. **Confirm destructive actions**: Before executing `cleaner_clean` (without `dryRun: true`), `cleaner_doctor` with `fix: true` / `issueIds`, `cleaner_mcp_audit` with `kill: true`, or `cleaner_restore` with `purgeBatchId` / `purgeAll` / `prune`, get explicit user approval unless they already asked for immediate execution.
5. **Always return the rollback handle**: Every non-permanent clean moves files to `~/.agent-cleaner/trash/<batchId>/` instead of deleting permanently (works cross-platform on macOS, Linux, and Windows drives). Always surface the returned `batchId` and tell the user they can undo via `cleaner_restore` or `npx -y dsh-agent-cleaner restore <batchId>`.

## Workflows

### Disk Cleanup & Whitelist
1. Scan via `cleaner_scan` (or `npx -y dsh-agent-cleaner scan --older-than 24h --json`; CLI supports `--progress-json` NDJSON on stderr).
2. Summarize total disk usage, reclaimable bytes per agent, and group items by `recommended` vs `optional` vs `exempt`.
3. If the user wants to protect a path or hide an agent permanently, update `~/.agent-cleaner/config.toml` via `cleaner_config` (`action: "ignore_path"` / `"ignore_agent"`) or `npx -y dsh-agent-cleaner config ignore add <pattern> --json`.
4. Ask the user whether to proceed (or preview first with `dryRun: true` / `--dry-run`), execute `cleaner_clean`, and report freed space + `batchId`.

### Config Self-Healing & Backup Rollback
1. Run `cleaner_doctor` with `fix: false` (or `npx -y dsh-agent-cleaner doctor --json`) first.
2. Show syntax errors and dead-link MCP entries per config file (along with each issue's `id` and `autoFixable` status).
3. With approval, repair all fixable issues (`fix: true`) or selected issues (`issueIds: [...]` / `--fix --ids ...`). Comments are preserved and backups are saved to `~/.agent-cleaner/backups/`.
4. To inspect or roll back a previous config repair, use `cleaner_backups` (`action: "list"` / `"restore"` / `"prune"`) or `npx -y dsh-agent-cleaner backups list --json`.

### Orphan MCP Process & Conflict Audit
1. Run `cleaner_mcp_audit` with `kill: false` (or `npx -y dsh-agent-cleaner mcp --json`) to inspect dead links, cross-agent `duplicates` and `conflicts` (same server name with divergent command/args/URL), cold `npm/_npx` / `uv` caches, and orphan stdio processes (Unix `PPID=1` or Windows exited-parent stdio MCP processes).
2. With approval, run `cleaner_mcp_audit` with `kill: true` (or `npx -y dsh-agent-cleaner mcp --kill --json`) to terminate orphan processes gracefully (`SIGTERM` -> `SIGKILL` on Unix, `taskkill /T` -> `/F /T` on Windows).

### Trash, Restore & Retention Pruning
1. List available batches via `cleaner_restore` (without `batchId`) or `npx -y dsh-agent-cleaner restore --json`.
2. With approval, restore a chosen `batchId` back to original paths, or prune expired / over-quota batches per `config.toml` (`trash_max_age_days`, `trash_max_size_mb`) via `cleaner_restore` (`prune: true`) or `npx -y dsh-agent-cleaner restore --prune --json`.
