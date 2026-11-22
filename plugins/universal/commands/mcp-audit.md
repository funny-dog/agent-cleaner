---
description: Audit cross-agent MCP configurations and terminate PPID=1 orphan stdio processes
---

Run `cleaner_mcp_audit` with `kill: false` (or fallback to `npx -y dsh-agent-cleaner mcp --json`) to inspect MCP dead links, duplicate entries across agents, cold npx/uv caches, and orphan `PPID=1` stdio MCP processes. Ask the user before running `cleaner_mcp_audit` with `kill: true` (or `npx -y dsh-agent-cleaner mcp --kill --json`).
