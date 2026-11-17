# agent-cleaner

Disk cleanup, orphan MCP process audit, and comment-preserving config repair for local AI coding tools (Claude Code, OpenCode, Codex CLI, DeepSeek Harness, Gemini/Antigravity, Cursor, Aider, Ollama).

[English](README.md) | [简体中文](README.zh-CN.md)

## Overview

AI coding agents leave behind gigabytes of shadow Git snapshots, orphaned session logs, undeclared `node_modules`, cold `npx`/`uv` caches, and zombie `PPID=1` stdio MCP processes. `agent-cleaner` provides a shared Rust engine (`cleaner-core`) with three interfaces:

- **CLI (`ac` / `agent-cleaner`)**: Fast terminal scanner, interactive cleaner, config doctor, and built-in stdio MCP server.
- **Desktop App (`apps/desktop`)**: Tauri 2.0 menu-bar utility and dashboard with on-demand webview lifecycle.
- **Agent Plugins (`plugins/`)**:
  - `plugins/universal`: MCP server + `SKILL.md` + slash commands for Claude Code, Cursor, and Antigravity.
  - `plugins/dsh` ([`dsh-agent-cleaner`](plugins/dsh/README.md)): Cordis plugin and sidebar panel for DeepSeek Harness (DSH).

## Key Safeguards

- **Accurate Claude Code Orphan Detection**: Streams the first 30 lines of the latest `.jsonl` session file to read the real `cwd` rather than guessing from hyphenated folder names, and protects unmounted `/Volumes/*` and `/mnt/*` paths.
- **Multi-Agent Coverage**: Scans OpenCode shadow Git snapshots, Codex session logs, undeclared DSH profile packages (including `@scope/pkg`), and cold (>14d) `npm/_npx` and `uv` caches.
- **Comment-Preserving Config Doctor**: Uses CST/AST edits (`jsonc-parser`, `toml_edit`, `serde_yml`) to remove broken MCP entries without stripping comments, backing up files to `~/.agent-cleaner/backups/` beforehand.
- **Orphan MCP Process Cleanup**: Identifies `PPID=1` stdio MCP processes via `sysinfo` and terminates them (`SIGTERM` -> `1.5s` -> `SIGKILL`) without touching SSE/HTTP daemons.
- **Reversible Trash**: Exempts files modified within the last 24 hours by default. Cleaned items move to `~/.agent-cleaner/trash/<batchId>/` with cross-device (`EXDEV`) fallback and full batch restore (`ac restore <batchId>`).

## Repository Layout

```text
agent-cleaner/
├── Cargo.toml
├── crates/
│   ├── cleaner-core/       # Core scanning, trash, MCP audit, config doctor, and stdio MCP server
│   └── cleaner-cli/        # CLI binary (`ac` & `agent-cleaner`)
├── apps/
│   └── desktop/            # Tauri 2.0 desktop app (tray popover + dashboard)
└── plugins/
    ├── universal/          # Claude Code / Antigravity / Cursor plugin (MCP + Skill + commands)
    └── dsh/                # DeepSeek Harness plugin (`dsh-agent-cleaner`)
```

## Quick Start

### 1. CLI (`ac`)

```bash
cargo build --release -p cleaner-cli

./target/release/ac scan
./target/release/ac clean --dry-run
./target/release/ac clean --only-recommended
./target/release/ac doctor --fix
./target/release/ac mcp --kill
./target/release/ac restore <batchId>
```

### 2. Desktop App

```bash
npm install
npm run dev:desktop
```

### 3. Plugins

- **Claude Code / Cursor / Antigravity**: Point your client at `plugins/universal` (or add `funny-dog/agent-cleaner` via `.claude-plugin/marketplace.json`). Requires `agent-cleaner` in `$PATH`.
- **DeepSeek Harness (DSH)**: Install `dsh-agent-cleaner` (see [`plugins/dsh/README.md`](plugins/dsh/README.md)).

## Development & Tests

```bash
cargo test --workspace
npm run typecheck
npm --workspace=@agent-cleaner/desktop run build
npm --workspace=dsh-agent-cleaner run build
npm --workspace=dsh-agent-cleaner test
```

## License

[MIT](LICENSE)
