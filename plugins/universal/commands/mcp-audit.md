---
description: Audit cross-agent MCP configurations and terminate PPID=1 orphan stdio processes
---

Run `cleaner_mcp_audit` with `kill: false` to inspect MCP dead links, duplicate entries across agents, cold npx/uv caches, and orphan `PPID=1` stdio MCP processes. Ask the user before running `cleaner_mcp_audit` with `kill: true`.
