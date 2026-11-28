---
description: Diagnose and selectively repair AI agent config files while preserving comments
---

Run `cleaner_doctor` with `fix: false` (or fallback to `npx -y dsh-agent-cleaner doctor --json`) to check Claude Code, OpenCode (JSONC), Codex CLI (TOML), DSH (YAML), Cursor, and Gemini/Antigravity config files for syntax errors and dead MCP links. Present any findings to the user and ask before running `cleaner_doctor` with `fix: true` or selective `issueIds` (or `npx -y dsh-agent-cleaner doctor --fix [--ids ...] --json`). Remind the user they can inspect or roll back backups via `cleaner_backups`.
