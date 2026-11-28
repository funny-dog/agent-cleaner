# Changelog

## Unreleased

- feat(core,cli,mcp): add global config/whitelist (`~/.agent-cleaner/config.toml`), trash retention pruning (`restore --prune`), selective doctor repair (`doctor --fix --ids`), config backup list/restore/delete/prune, cross-agent MCP conflict detection (`conflicts`), `scan --progress-json` NDJSON streaming, and `overview` subcommand / `cleaner_overview` / `cleaner_config` / `cleaner_backups` MCP tools.
- feat(dsh): add `/agent-cleaner/api/config`, `/backups`, `/backup-restore`, `/backup-delete`, `/backup-prune`, `/trash-prune`, `/progress` (JSON + SSE stream), `issueIds` support on `/doctor-fix`, and register 8 Cordis tools (`agent_cleaner_overview`, `agent_cleaner_config`, `agent_cleaner_backups`, etc.).
- feat(dsh-ui): add live scan progress bar in radar overlay, Settings / Whitelist tab, ScanTab "Ignore Path" quick button, DoctorTab per-issue Fix button and Config Backup History & Rollback section, McpTab cross-agent conflicts breakdown, and TrashTab retention policy + Prune Expired Batches button.
- fix(windows): harden cross-platform Windows support across Rust core, Desktop Tauri, and DSH plugin — drive-safe trash/backup relative path sanitization, case-insensitive path/claim checks, read-only & NTFS junction removal handling, Windows exited-parent orphan MCP process detection & `taskkill /T` cleanup, `PATHEXT`/quoted command resolution, `AppData/Roaming` & `AppData/Local` scanning & MCP discovery, pure-Node ZIP extraction for `.zip` CLI auto-download, and `windows-latest` CI matrix.
- docs: synchronize `plugins/universal`, `skills/agent-cleaner`, `plugins/dsh/src/setup.ts`, and bilingual READMEs.

## 0.2.5

- feat(desktop): Claude-style UI refresh for dashboard and tray.
- feat(desktop): show free disk space (new `get_disk_space` command); warns when below 10%.
- feat(dsh): panel shows free disk space (`disk` field in `/agent-cleaner/api/overview`); removed the combined MCP/Config/Trash KPI card; highlighted Trash tab.
- test: cover `get_disk_space` and the overview `disk` field.

## 0.2.4

See git history (`v0.2.4`).
