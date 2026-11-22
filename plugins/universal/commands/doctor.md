---
description: Diagnose and repair AI agent config files while preserving comments
---

Run `cleaner_doctor` with `fix: false` (or fallback to `npx -y dsh-agent-cleaner doctor --json`) to check Claude Code, OpenCode (JSONC), Codex CLI (TOML), DSH (YAML), Cursor, and Gemini/Antigravity config files for syntax errors and dead MCP links. Present any findings to the user and ask before running `cleaner_doctor` with `fix: true` (or `npx -y dsh-agent-cleaner doctor --fix --json`).
