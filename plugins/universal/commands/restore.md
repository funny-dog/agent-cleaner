---
description: List agent-cleaner trash batches, restore files, or prune expired trash
---

Run `cleaner_restore` without `batchId` (or fallback to `npx -y dsh-agent-cleaner restore --json`) to list available trash batches in `~/.agent-cleaner/trash/`. Show each `batchId`, item count, timestamp, and size to the user, then restore the selected batch via `cleaner_restore` (or `npx -y dsh-agent-cleaner restore <batchId> --json`), or prune expired/over-quota batches with `prune: true` (`--prune`), once confirmed.
