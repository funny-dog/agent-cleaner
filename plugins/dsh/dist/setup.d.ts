export declare const SUPPORTED_AGENTS: readonly ["claude", "cursor", "gemini", "codex", "opencode", "dsh"];
export type SupportedAgent = (typeof SUPPORTED_AGENTS)[number];
export declare const SKILL_MD_TEMPLATE = "---\nname: agent-cleaner\ndescription: >\n  Use when the user asks to inspect, clean, or free up disk space used by AI coding\n  agents (Claude Code, OpenCode, Codex CLI, DSH, Gemini/Antigravity, Cursor, Ollama, Aider),\n  diagnose or repair broken MCP/agent configs, kill orphan MCP processes, or restore\n  previously cleaned files from the agent-cleaner trash.\n---\n\n# Agent Cleaner Operating Protocol\n\n## Execution Channels\n\nUse **Primary (MCP Tools)** whenever the `agent-cleaner` MCP server is connected. If MCP tools are not registered in the current session, seamlessly use **Fallback (CLI `--json` via `npx`, no global CLI install required)** via shell:\n\n- **Scan**: MCP `cleaner_scan` | Fallback `npx -y dsh-agent-cleaner scan --older-than 24h --json`\n- **Clean**: MCP `cleaner_clean` | Fallback `npx -y dsh-agent-cleaner clean --yes [--only-recommended] [--dry-run] [--ids id1,id2] --older-than 24h --json`\n- **Doctor**: MCP `cleaner_doctor` | Fallback `npx -y dsh-agent-cleaner doctor [--fix] --json`\n- **MCP Audit**: MCP `cleaner_mcp_audit` | Fallback `npx -y dsh-agent-cleaner mcp [--kill] [--pid <pid>] --json`\n- **Restore**: MCP `cleaner_restore` | Fallback `npx -y dsh-agent-cleaner restore [<batchId>] --json`\n\n## Safety Rules\n\n1. **Always scan before cleaning**: Never run a clean operation without first scanning and presenting the reclaimable breakdown (size, category, agent, and recommendation level) to the user.\n2. **Respect the 24-hour active guard**: By default, files modified within the last 24 hours are marked `exempt`. Do not bypass `olderThanHours` / `--older-than` unless the user explicitly asks to clean recent files.\n3. **Prefer recommended items first**: When the user asks for a safe cleanup, pass `onlyRecommended: true` (`--only-recommended`) or explicitly select only `recommended` item IDs. Confirm before cleaning `optional` items (archives, backups, snapshots, undeclared `node_modules`).\n4. **Confirm destructive actions**: Before executing `cleaner_clean` (without `dryRun: true`), `cleaner_doctor` with `fix: true`, or `cleaner_mcp_audit` with `kill: true`, get explicit user approval unless they already asked for immediate execution.\n5. **Always return the rollback handle**: Every non-dry-run clean moves files to `~/.agent-cleaner/trash/<batchId>/` instead of deleting permanently. Always surface the returned `batchId` and tell the user they can undo via `cleaner_restore` or `npx -y dsh-agent-cleaner restore <batchId>`.\n\n## Workflows\n\n### Disk Cleanup\n1. Scan via `cleaner_scan` (or `npx -y dsh-agent-cleaner scan --older-than 24h --json`).\n2. Summarize total disk usage, reclaimable bytes per agent, and group items by `recommended` vs `optional` vs `exempt`.\n3. Ask the user whether to proceed (or preview first with `dryRun: true` / `--dry-run`).\n4. Execute `cleaner_clean` (or `npx -y dsh-agent-cleaner clean --yes ... --json`) and report freed space + `batchId`.\n\n### Config Self-Healing\n1. Run `cleaner_doctor` with `fix: false` (or `npx -y dsh-agent-cleaner doctor --json`) first.\n2. Show syntax errors and dead-link MCP entries per config file.\n3. With approval, run `cleaner_doctor` with `fix: true` (or `npx -y dsh-agent-cleaner doctor --fix --json`) \u2014 comments are preserved and backups are saved to `~/.agent-cleaner/backups/`.\n\n### Orphan MCP Process Audit\n1. Run `cleaner_mcp_audit` with `kill: false` (or `npx -y dsh-agent-cleaner mcp --json`) to inspect dead links, duplicate cross-agent entries, cold `~/.npm/_npx` / `~/.cache/uv` caches, and `PPID=1` orphan stdio processes.\n2. With approval, run `cleaner_mcp_audit` with `kill: true` (or `npx -y dsh-agent-cleaner mcp --kill --json`) to terminate orphan processes gracefully (`SIGTERM` -> `SIGKILL`).\n\n### Trash & Restore\n1. List available batches via `cleaner_restore` (without `batchId`) or `npx -y dsh-agent-cleaner restore --json`.\n2. With approval for a chosen `batchId`, restore files back to their original paths via `cleaner_restore` (`batchId`) or `npx -y dsh-agent-cleaner restore <batchId> --json`.\n";
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
