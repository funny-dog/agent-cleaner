export declare const SUPPORTED_AGENTS: readonly ["claude", "cursor", "gemini", "codex", "opencode", "dsh"];
export type SupportedAgent = (typeof SUPPORTED_AGENTS)[number];
export declare const SKILL_MD_TEMPLATE = "---\nname: agent-cleaner\ndescription: >\n  Use when the user asks to inspect, clean, or free up disk space used by AI coding\n  agents (Claude Code, OpenCode, Codex CLI, DSH, Gemini/Antigravity, Cursor, Ollama, Aider),\n  diagnose or repair broken MCP/agent configs, audit cross-agent MCP conflicts or orphan\n  processes, manage whitelist/retention settings, or restore files and config backups.\n---\n\n# Agent Cleaner Operating Protocol\n\n## Execution Channels\n\nUse **Primary (MCP Tools)** whenever the `agent-cleaner` MCP server is connected. If MCP tools are not registered in the current session, seamlessly use **Fallback (CLI `--json` via `npx`, no global CLI install required)** via shell:\n\n- **Overview**: MCP `cleaner_overview` | Fallback `npx -y dsh-agent-cleaner overview [--older-than 24h] [--lang zh|en] --json`\n- **Scan**: MCP `cleaner_scan` | Fallback `npx -y dsh-agent-cleaner scan [--progress-json] --older-than 24h --json`\n- **Clean**: MCP `cleaner_clean` | Fallback `npx -y dsh-agent-cleaner clean --yes [--only-recommended] [--dry-run] [--permanent] [--ids id1,id2] --older-than 24h --json`\n- **Doctor**: MCP `cleaner_doctor` | Fallback `npx -y dsh-agent-cleaner doctor [--fix] [--ids id1,id2] --json`\n- **MCP Audit**: MCP `cleaner_mcp_audit` | Fallback `npx -y dsh-agent-cleaner mcp [--kill] [--pid <pid>] --json`\n- **Restore & Trash**: MCP `cleaner_restore` | Fallback `npx -y dsh-agent-cleaner restore [<batchId>] [--prune] [--purge <batchId>] [--purge-all] --json`\n- **Config & Whitelist**: MCP `cleaner_config` | Fallback `npx -y dsh-agent-cleaner config [show|set|ignore|ignore-agent] --json`\n- **Config Backups**: MCP `cleaner_backups` | Fallback `npx -y dsh-agent-cleaner backups [list|restore <backupId>|delete <backupId>|prune] --json`\n\n## Safety Rules\n\n1. **Always scan before cleaning**: Never run a clean operation without first scanning and presenting the reclaimable breakdown (size, category, agent, and recommendation level) to the user.\n2. **Respect the active guard & whitelist**: Files modified within `exempt_hours` (default 24h) and paths matching `ignored_paths` in `~/.agent-cleaner/config.toml` are marked `exempt`. Do not bypass `exemptHours` / `--older-than` or pass `permanent: true` (`--permanent`) unless the user explicitly asks.\n3. **Prefer recommended items first**: When the user asks for a safe cleanup, pass `onlyRecommended: true` (`--only-recommended`) or explicitly select only `recommended` item IDs. Confirm before cleaning `optional` items (archives, backups, snapshots, undeclared `node_modules`).\n4. **Confirm destructive actions**: Before executing `cleaner_clean` (without `dryRun: true`), `cleaner_doctor` with `fix: true` / `issueIds`, `cleaner_mcp_audit` with `kill: true`, or `cleaner_restore` with `purgeBatchId` / `purgeAll` / `prune`, get explicit user approval unless they already asked for immediate execution.\n5. **Always return the rollback handle**: Every non-permanent clean moves files to `~/.agent-cleaner/trash/<batchId>/` instead of deleting permanently (works cross-platform on macOS, Linux, and Windows drives). Always surface the returned `batchId` and tell the user they can undo via `cleaner_restore` or `npx -y dsh-agent-cleaner restore <batchId>`.\n\n## Workflows\n\n### Disk Cleanup & Whitelist\n1. Scan via `cleaner_scan` (or `npx -y dsh-agent-cleaner scan --older-than 24h --json`; CLI supports `--progress-json` NDJSON on stderr).\n2. Summarize total disk usage, reclaimable bytes per agent, and group items by `recommended` vs `optional` vs `exempt`.\n3. If the user wants to protect a path or hide an agent permanently, update `~/.agent-cleaner/config.toml` via `cleaner_config` (`action: \"ignore_path\"` / `\"ignore_agent\"`) or `npx -y dsh-agent-cleaner config ignore add <pattern> --json`.\n4. Ask the user whether to proceed (or preview first with `dryRun: true` / `--dry-run`), execute `cleaner_clean`, and report freed space + `batchId`.\n\n### Config Self-Healing & Backup Rollback\n1. Run `cleaner_doctor` with `fix: false` (or `npx -y dsh-agent-cleaner doctor --json`) first.\n2. Show syntax errors and dead-link MCP entries per config file (along with each issue's `id` and `autoFixable` status).\n3. With approval, repair all fixable issues (`fix: true`) or selected issues (`issueIds: [...]` / `--fix --ids ...`). Comments are preserved and backups are saved to `~/.agent-cleaner/backups/`.\n4. To inspect or roll back a previous config repair, use `cleaner_backups` (`action: \"list\"` / `\"restore\"` / `\"prune\"`) or `npx -y dsh-agent-cleaner backups list --json`.\n\n### Orphan MCP Process & Conflict Audit\n1. Run `cleaner_mcp_audit` with `kill: false` (or `npx -y dsh-agent-cleaner mcp --json`) to inspect dead links, cross-agent `duplicates` and `conflicts` (same server name with divergent command/args/URL), cold `npm/_npx` / `uv` caches, and orphan stdio processes (Unix `PPID=1` or Windows exited-parent stdio MCP processes).\n2. With approval, run `cleaner_mcp_audit` with `kill: true` (or `npx -y dsh-agent-cleaner mcp --kill --json`) to terminate orphan processes gracefully (`SIGTERM` -> `SIGKILL` on Unix, `taskkill /T` -> `/F /T` on Windows).\n\n### Trash, Restore & Retention Pruning\n1. List available batches via `cleaner_restore` (without `batchId`) or `npx -y dsh-agent-cleaner restore --json`.\n2. With approval, restore a chosen `batchId` back to original paths, or prune expired / over-quota batches per `config.toml` (`trash_max_age_days`, `trash_max_size_mb`) via `cleaner_restore` (`prune: true`) or `npx -y dsh-agent-cleaner restore --prune --json`.\n";
export declare const COMMAND_TEMPLATES: Record<string, string>;
export interface PlatformPluginStatus {
    agent: SupportedAgent;
    displayName: string;
    detected: boolean;
    mcpInstalled: boolean;
    skillInstalled: boolean;
    commandsInstalled: boolean;
    mcpConfigPaths: string[];
    skillPaths: string[];
    commandDirs: string[];
}
export interface PluginSetupOptions {
    homeDir?: string;
    agents?: string[];
    includeUndetected?: boolean;
    uninstall?: boolean;
}
export interface PlatformSetupResult {
    agent: SupportedAgent;
    displayName: string;
    success: boolean;
    updatedFiles: string[];
    removedFiles: string[];
    backupPaths: string[];
    error?: string;
}
export interface PluginSetupReport {
    results: PlatformSetupResult[];
    statuses: PlatformPluginStatus[];
}
export declare function upsertJsoncMcpText(rawInput: string, filePath: string, opencodeSchema: boolean): {
    content: string;
    changed: boolean;
};
export declare function removeJsoncMcpText(rawInput: string, filePath: string): {
    content: string;
    changed: boolean;
};
export declare function upsertTomlMcpText(rawInput: string): {
    content: string;
    changed: boolean;
};
export declare function removeTomlMcpText(rawInput: string): {
    content: string;
    changed: boolean;
};
export declare function upsertYamlMcpText(rawInput: string): {
    content: string;
    changed: boolean;
};
export declare function removeYamlMcpText(rawInput: string): {
    content: string;
    changed: boolean;
};
export declare function detectPlatforms(homeDir?: string): PlatformPluginStatus[];
export declare function setupPlugins(options?: PluginSetupOptions): PluginSetupReport;
export declare function runSetupCli(argv: string[]): Promise<void>;
