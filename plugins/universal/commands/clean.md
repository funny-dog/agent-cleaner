---
description: Scan AI agent caches/sessions and safely move reclaimable files to trash
---

Run `cleaner_scan` (or fallback to `npx -y dsh-agent-cleaner scan --older-than 24h --json`) first to show a breakdown of disk usage and reclaimable files across all installed AI coding agents (`recommended`, `optional`, and 24h/whitelist `exempt` items). If the user wants to exclude a path or agent, use `cleaner_config` (`ignore_path` / `ignore_agent`). Ask the user to confirm which items to clean, then run `cleaner_clean` (or `npx -y dsh-agent-cleaner clean --yes ... --json`) and report the resulting `batchId` for rollback.
