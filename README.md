# agent-cleaner

Disk cleanup, orphan MCP process audit, and comment-preserving config repair for local AI coding tools (Claude Code, OpenCode, Codex CLI, DeepSeek Harness, Gemini/Antigravity, Cursor, Aider, Ollama).

[English](README.md) | [简体中文](README.zh-CN.md)

![Agent Cleaner DSH Panel](plugins/dsh/assets/preview-dark.png)

## Overview

AI coding agents leave behind gigabytes of shadow Git snapshots, orphaned session logs, undeclared `node_modules`, cold `npx`/`uv` caches, and zombie `PPID=1` stdio MCP processes. `agent-cleaner` provides a shared Rust engine (`cleaner-core`) with two interfaces:

- **CLI (`ac` / `agent-cleaner`)**: Fast terminal scanner, interactive cleaner, config doctor, and built-in stdio MCP server.
- **Agent Plugins (`plugins/`)**:
  - `plugins/universal`: MCP server + `SKILL.md` + slash commands for Claude Code, Cursor, and Antigravity.
  - `plugins/dsh` ([`dsh-agent-cleaner`](plugins/dsh/README.md)): Cordis plugin and sidebar panel for DeepSeek Harness (DSH).
- **Desktop app (`apps/desktop`)**: Tauri dashboard and tray with a Claude-style UI; shows free disk space of your home volume (highlighted when below 10%).

## Key Safeguards

- **Accurate Claude Code Orphan Detection**: Streams the first 30 lines of the latest `.jsonl` session file to read the real `cwd` rather than guessing from hyphenated folder names, and protects unmounted `/Volumes/*`, `/mnt/*`, `/run/media/*`, and Windows drive/UNC paths.
- **Multi-Agent & Windows Coverage**: Scans OpenCode shadow Git snapshots, Codex session logs, undeclared DSH profile packages (including `@scope/pkg`), cold (`>14d`) `npm/_npx` / `uv` / `pnpm` / `playwright` caches, and Windows `AppData/Roaming` & `AppData/Local` app/MCP locations.
- **Comment-Preserving Config Doctor & Backup Rollback**: Uses CST/AST edits (`jsonc-parser`, `toml_edit`, `serde_yml`) to selectively or globally remove broken MCP entries without stripping comments, backing up files to `~/.agent-cleaner/backups/` with one-click restore (`ac backups restore <id>`).
- **Orphan MCP Process & Conflict Audit**: Detects cross-agent MCP `duplicates` and `conflicts`, identifies orphan stdio MCP processes (Unix `PPID=1` and Windows exited-parent processes) via `sysinfo`, and terminates them gracefully (`SIGTERM` -> `SIGKILL` on Unix, `taskkill /T` -> `/F /T` on Windows) without touching SSE/HTTP daemons.
- **Reversible Trash & Retention Policy**: Exempts files modified within the last 24 hours and paths matching `ignored_paths` in `~/.agent-cleaner/config.toml`. Cleaned items move to `~/.agent-cleaner/trash/<batchId>/` with drive-safe relative paths, cross-device fallback, configurable age/size pruning (`ac restore --prune`), and full batch restore (`ac restore <batchId>`).

## Repository Layout

```text
agent-cleaner/
├── Cargo.toml
├── crates/
│   ├── cleaner-core/       # Core scanning, trash, MCP audit, config doctor, and stdio MCP server
│   └── cleaner-cli/        # CLI binary (`ac` & `agent-cleaner`)
└── plugins/
    ├── universal/          # Claude Code / Antigravity / Cursor plugin (MCP + Skill + commands)
    └── dsh/                # DeepSeek Harness plugin (`dsh-agent-cleaner`)
```

## Quick Start

### 1. CLI (`ac` / `agent-cleaner`)

#### Option A: One-line installer (Recommended, no Rust required)

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/funny-dog/agent-cleaner/main/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/funny-dog/agent-cleaner/main/install.ps1 | iex
```

#### Option B: Run or install via `npx` / `npm` (no Rust required)

```bash
# Run immediately without installing
npx dsh-agent-cleaner

# Or install globally to get `ac` and `agent-cleaner` in PATH
npm install -g dsh-agent-cleaner
```

#### Option C: Install from local repository clone

```bash
npm run install:cli
```

#### Usage

Run `ac` with no arguments to view the overview dashboard and enter the interactive wizard, or use subcommands directly:

```bash
ac                  # Interactive wizard menu (or overview summary in non-TTY pipes)
ac overview         # Aggregated disk, doctor, MCP, and trash overview
ac scan [--progress-json]
ac clean --dry-run
ac clean --only-recommended
ac doctor --fix [--ids <id1,id2>]
ac mcp --kill
ac restore <batchId>
ac restore --prune
ac config [show|set|ignore|ignore-agent]
ac backups [list|restore <id>|delete <id>|prune]
```

Built-in Stdio MCP Server (`ac mcp-server` / `npx -y dsh-agent-cleaner mcp-server`) exposes 8 tools: `cleaner_overview`, `cleaner_scan`, `cleaner_clean`, `cleaner_doctor`, `cleaner_mcp_audit`, `cleaner_restore`, `cleaner_config`, and `cleaner_backups`.

### 2. Plugins (No Global CLI Required)

#### Option A: One-command multi-platform plugin setup (no global CLI, no PATH changes)

Automatically detects **Claude Code, Cursor, Gemini / Antigravity, Codex CLI, OpenCode, and DSH**, preserves comments and backs up existing configs to `~/.agent-cleaner/backups/`, and installs the **MCP Server (`npx -y dsh-agent-cleaner mcp-server`) + dual-channel Skill + slash commands (`/clean`, `/doctor`, `/mcp-audit`, `/restore`)**:

```bash
# Interactive setup (or use --yes to auto-install onto all detected platforms)
npx -y dsh-agent-cleaner setup
npx -y dsh-agent-cleaner setup --yes

# Or via one-line shell script
curl -fsSL https://raw.githubusercontent.com/funny-dog/agent-cleaner/main/install-plugin.sh | sh

# Check status, target specific platforms, or uninstall cleanly
npx -y dsh-agent-cleaner setup --status
npx -y dsh-agent-cleaner setup --agent claude,cursor,gemini,codex,opencode,dsh
npx -y dsh-agent-cleaner setup --uninstall
```

#### Option B: Native platform plugin / Skill commands

- **Claude Code**:
  ```text
  /plugin marketplace add funny-dog/agent-cleaner
  /plugin install agent-cleaner
  ```
- **Universal Skills (Cursor / Codex / Gemini / Claude / OpenCode)**:
  ```bash
  npx skills add funny-dog/agent-cleaner
  ```
- **DeepSeek Harness (DSH)**:
  ```bash
  dsh plugin --profile web add dsh-agent-cleaner
  ```
  See [`plugins/dsh/README.md`](plugins/dsh/README.md) for details.

## Development & Tests

```bash
cargo build --release -p cleaner-cli
cargo test --workspace
npm run typecheck
npm --workspace=dsh-agent-cleaner run build
npm --workspace=dsh-agent-cleaner test
```

## License

[MIT](LICENSE)
