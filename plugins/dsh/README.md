# dsh-agent-cleaner

[English](README.md) | [简体中文](README.zh-CN.md)

DeepSeek Harness (DSH) plugin for auditing and cleaning disk caches, orphan sessions, zombie MCP processes, and broken configuration files across AI coding tools (Claude Code, OpenCode, Codex CLI, DSH, Gemini/Antigravity, Cursor, Aider, Ollama).

## Features

- **Sidebar Panel & Full View**: Inspect disk usage by agent, filter recommended vs. optional cleanup items, and preview or execute cleanups directly inside DSH.
- **Cordis Agent Tools**: Registers `agent_cleaner_scan`, `agent_cleaner_clean`, `agent_cleaner_doctor`, and `agent_cleaner_mcp` so the DSH agent can inspect and clean on command.
- **Reversible Trash**: Cleaned files are moved to `~/.agent-cleaner/trash/<batchId>/` with a manifest for one-click restoration.
- **Orphan MCP Process Radar**: Detects and terminates `PPID=1` orphaned stdio MCP processes without touching background HTTP/SSE services.
- **Comment-Preserving Config Doctor**: Repairs invalid MCP entries in JSON, JSONC, TOML, and YAML configs while keeping existing comments and formatting intact.

## Prerequisites

`dsh-agent-cleaner` delegates scanning and filesystem operations to the `agent-cleaner` (`ac`) Rust CLI binary (`~/.local/bin/agent-cleaner`, `~/.cargo/bin/agent-cleaner`, or in `$PATH`).

Build and install the CLI from the repository root:

```bash
cargo install --path crates/cleaner-cli
```

## Installation

Install via DSH CLI:

```bash
dsh plugin add dsh-agent-cleaner
```

Or install from GitHub subpath:

```bash
dsh plugin add github:funny-dog/agent-cleaner#path:/plugins/dsh
```

## Configuration

Optional settings in your DSH profile patch (`cordis.patch.yml`):

```yaml
- id: agent-cleaner
  name: dsh-agent-cleaner
  config:
    binaryPath: /Users/you/.cargo/bin/agent-cleaner
    exemptRecentHours: 24
```

## License

MIT
