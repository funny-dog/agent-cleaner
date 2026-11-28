---
description: Audit cross-agent MCP configurations, conflicts, and orphan stdio processes
---

Run `cleaner_mcp_audit` with `kill: false` (or fallback to `npx -y dsh-agent-cleaner mcp --json`) to inspect MCP dead links, cross-agent `duplicates` and `conflicts`, cold npx/uv/pnpm/playwright caches, and orphan stdio MCP processes (Unix `PPID=1` or Windows exited-parent processes). Ask the user before running `cleaner_mcp_audit` with `kill: true` (or `npx -y dsh-agent-cleaner mcp --kill --json`).
