import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';

export const SUPPORTED_AGENTS = [
  'claude',
  'cursor',
  'gemini',
  'codex',
  'opencode',
  'dsh',
] as const;

export type SupportedAgent = (typeof SUPPORTED_AGENTS)[number];

const SERVER_KEY = 'agent-cleaner';
const NPX_COMMAND = 'npx';
const NPX_ARGS = ['-y', 'dsh-agent-cleaner', 'mcp-server'];

export const SKILL_MD_TEMPLATE = `---
name: agent-cleaner
description: >
  Use when the user asks to inspect, clean, or free up disk space used by AI coding
  agents (Claude Code, OpenCode, Codex CLI, DSH, Gemini/Antigravity, Cursor, Ollama, Aider),
  diagnose or repair broken MCP/agent configs, kill orphan MCP processes, or restore
  previously cleaned files from the agent-cleaner trash.
---

# Agent Cleaner Operating Protocol

## Execution Channels

Use **Primary (MCP Tools)** whenever the \`agent-cleaner\` MCP server is connected. If MCP tools are not registered in the current session, seamlessly use **Fallback (CLI \`--json\` via \`npx\`, no global CLI install required)** via shell:

- **Scan**: MCP \`cleaner_scan\` | Fallback \`npx -y dsh-agent-cleaner scan --older-than 24h --json\`
- **Clean**: MCP \`cleaner_clean\` | Fallback \`npx -y dsh-agent-cleaner clean --yes [--only-recommended] [--dry-run] [--ids id1,id2] --older-than 24h --json\`
- **Doctor**: MCP \`cleaner_doctor\` | Fallback \`npx -y dsh-agent-cleaner doctor [--fix] --json\`
- **MCP Audit**: MCP \`cleaner_mcp_audit\` | Fallback \`npx -y dsh-agent-cleaner mcp [--kill] [--pid <pid>] --json\`
- **Restore**: MCP \`cleaner_restore\` | Fallback \`npx -y dsh-agent-cleaner restore [<batchId>] --json\`

## Safety Rules

1. **Always scan before cleaning**: Never run a clean operation without first scanning and presenting the reclaimable breakdown (size, category, agent, and recommendation level) to the user.
2. **Respect the 24-hour active guard**: By default, files modified within the last 24 hours are marked \`exempt\`. Do not bypass \`olderThanHours\` / \`--older-than\` unless the user explicitly asks to clean recent files.
3. **Prefer recommended items first**: When the user asks for a safe cleanup, pass \`onlyRecommended: true\` (\`--only-recommended\`) or explicitly select only \`recommended\` item IDs. Confirm before cleaning \`optional\` items (archives, backups, snapshots, undeclared \`node_modules\`).
4. **Confirm destructive actions**: Before executing \`cleaner_clean\` (without \`dryRun: true\`), \`cleaner_doctor\` with \`fix: true\`, or \`cleaner_mcp_audit\` with \`kill: true\`, get explicit user approval unless they already asked for immediate execution.
5. **Always return the rollback handle**: Every non-dry-run clean moves files to \`~/.agent-cleaner/trash/<batchId>/\` instead of deleting permanently. Always surface the returned \`batchId\` and tell the user they can undo via \`cleaner_restore\` or \`npx -y dsh-agent-cleaner restore <batchId>\`.

## Workflows

### Disk Cleanup
1. Scan via \`cleaner_scan\` (or \`npx -y dsh-agent-cleaner scan --older-than 24h --json\`).
2. Summarize total disk usage, reclaimable bytes per agent, and group items by \`recommended\` vs \`optional\` vs \`exempt\`.
3. Ask the user whether to proceed (or preview first with \`dryRun: true\` / \`--dry-run\`).
4. Execute \`cleaner_clean\` (or \`npx -y dsh-agent-cleaner clean --yes ... --json\`) and report freed space + \`batchId\`.

### Config Self-Healing
1. Run \`cleaner_doctor\` with \`fix: false\` (or \`npx -y dsh-agent-cleaner doctor --json\`) first.
2. Show syntax errors and dead-link MCP entries per config file.
3. With approval, run \`cleaner_doctor\` with \`fix: true\` (or \`npx -y dsh-agent-cleaner doctor --fix --json\`) — comments are preserved and backups are saved to \`~/.agent-cleaner/backups/\`.

### Orphan MCP Process Audit
1. Run \`cleaner_mcp_audit\` with \`kill: false\` (or \`npx -y dsh-agent-cleaner mcp --json\`) to inspect dead links, duplicate cross-agent entries, cold \`~/.npm/_npx\` / \`~/.cache/uv\` caches, and \`PPID=1\` orphan stdio processes.
2. With approval, run \`cleaner_mcp_audit\` with \`kill: true\` (or \`npx -y dsh-agent-cleaner mcp --kill --json\`) to terminate orphan processes gracefully (\`SIGTERM\` -> \`SIGKILL\`).

### Trash & Restore
1. List available batches via \`cleaner_restore\` (without \`batchId\`) or \`npx -y dsh-agent-cleaner restore --json\`.
2. With approval for a chosen \`batchId\`, restore files back to their original paths via \`cleaner_restore\` (\`batchId\`) or \`npx -y dsh-agent-cleaner restore <batchId> --json\`.
`;

export const COMMAND_TEMPLATES: Record<string, string> = {
  'clean.md': `---
description: Scan AI agent caches/sessions and safely move reclaimable files to trash
---

Run \`cleaner_scan\` (or fallback to \`npx -y dsh-agent-cleaner scan --older-than 24h --json\`) first to show a breakdown of disk usage and reclaimable files across all installed AI coding agents (\`recommended\`, \`optional\`, and 24h \`exempt\` items). Ask the user to confirm which items to clean, then run \`cleaner_clean\` (or \`npx -y dsh-agent-cleaner clean --yes ... --json\`) and report the resulting \`batchId\` for rollback.
`,
  'doctor.md': `---
description: Diagnose and repair AI agent config files while preserving comments
---

Run \`cleaner_doctor\` with \`fix: false\` (or fallback to \`npx -y dsh-agent-cleaner doctor --json\`) to check Claude Code, OpenCode (JSONC), Codex CLI (TOML), DSH (YAML), Cursor, and Gemini/Antigravity config files for syntax errors and dead MCP links. Present any findings to the user and ask before running \`cleaner_doctor\` with \`fix: true\` (or \`npx -y dsh-agent-cleaner doctor --fix --json\`).
`,
  'mcp-audit.md': `---
description: Audit cross-agent MCP configurations and terminate PPID=1 orphan stdio processes
---

Run \`cleaner_mcp_audit\` with \`kill: false\` (or fallback to \`npx -y dsh-agent-cleaner mcp --json\`) to inspect MCP dead links, duplicate entries across agents, cold npx/uv caches, and orphan \`PPID=1\` stdio MCP processes. Ask the user before running \`cleaner_mcp_audit\` with \`kill: true\` (or \`npx -y dsh-agent-cleaner mcp --kill --json\`).
`,
  'restore.md': `---
description: List agent-cleaner trash batches and restore previously cleaned files
---

Run \`cleaner_restore\` without \`batchId\` (or fallback to \`npx -y dsh-agent-cleaner restore --json\`) to list available trash batches in \`~/.agent-cleaner/trash/\`. Show each \`batchId\`, item count, timestamp, and size to the user, then restore the selected batch via \`cleaner_restore\` (or \`npx -y dsh-agent-cleaner restore <batchId> --json\`) once confirmed.
`,
};

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

type ConfigFormat = 'jsonc-standard' | 'jsonc-opencode' | 'toml-codex' | 'yaml-dsh';

interface PlatformSpec {
  agent: SupportedAgent;
  displayName: string;
  format: ConfigFormat;
  isDetected: (home: string) => boolean;
  mcpConfigPaths: (home: string, includeExistingVariants: boolean) => string[];
  skillPaths: (home: string) => string[];
  commandDirs: (home: string) => string[];
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

const PLATFORM_SPECS: PlatformSpec[] = [
  {
    agent: 'claude',
    displayName: 'Claude Code',
    format: 'jsonc-standard',
    isDetected: (home) => existsSync(path.join(home, '.claude')) || existsSync(path.join(home, '.claude.json')),
    mcpConfigPaths: (home) => {
      const paths = [path.join(home, '.claude', 'settings.json')];
      const legacy = path.join(home, '.claude.json');
      if (isFile(legacy)) paths.push(legacy);
      return paths;
    },
    skillPaths: (home) => [path.join(home, '.claude', 'skills', 'agent-cleaner', 'SKILL.md')],
    commandDirs: (home) => [path.join(home, '.claude', 'commands')],
  },
  {
    agent: 'cursor',
    displayName: 'Cursor',
    format: 'jsonc-standard',
    isDetected: (home) => existsSync(path.join(home, '.cursor')),
    mcpConfigPaths: (home) => [path.join(home, '.cursor', 'mcp.json')],
    skillPaths: (home) => [path.join(home, '.cursor', 'skills', 'agent-cleaner', 'SKILL.md')],
    commandDirs: (home) => [path.join(home, '.cursor', 'commands')],
  },
  {
    agent: 'gemini',
    displayName: 'Gemini / Antigravity',
    format: 'jsonc-standard',
    isDetected: (home) => existsSync(path.join(home, '.gemini')),
    mcpConfigPaths: (home) => [
      path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
      path.join(home, '.gemini', 'settings.json'),
    ],
    skillPaths: (home) => [
      path.join(home, '.gemini', 'config', 'skills', 'agent-cleaner', 'SKILL.md'),
      path.join(home, '.gemini', 'skills', 'agent-cleaner', 'SKILL.md'),
    ],
    commandDirs: (home) => [
      path.join(home, '.gemini', 'commands'),
      path.join(home, '.gemini', 'config', 'commands'),
    ],
  },
  {
    agent: 'codex',
    displayName: 'Codex CLI',
    format: 'toml-codex',
    isDetected: (home) => existsSync(path.join(home, '.codex')),
    mcpConfigPaths: (home) => [path.join(home, '.codex', 'config.toml')],
    skillPaths: (home) => [path.join(home, '.codex', 'skills', 'agent-cleaner', 'SKILL.md')],
    commandDirs: (home) => [
      path.join(home, '.codex', 'prompts'),
      path.join(home, '.codex', 'commands'),
    ],
  },
  {
    agent: 'opencode',
    displayName: 'OpenCode',
    format: 'jsonc-opencode',
    isDetected: (home) =>
      existsSync(path.join(home, '.config', 'opencode')) ||
      existsSync(path.join(home, '.local', 'share', 'opencode')),
    mcpConfigPaths: (home, includeVariants) => {
      const jsonc = path.join(home, '.config', 'opencode', 'opencode.jsonc');
      const json = path.join(home, '.config', 'opencode', 'opencode.json');
      if (includeVariants) {
        const list = [jsonc, json].filter(isFile);
        return list.length > 0 ? list : [jsonc];
      }
      if (isFile(jsonc)) return [jsonc];
      if (isFile(json)) return [json];
      return [jsonc];
    },
    skillPaths: (home) => [
      path.join(home, '.config', 'opencode', 'skills', 'agent-cleaner', 'SKILL.md'),
    ],
    commandDirs: (home) => [path.join(home, '.config', 'opencode', 'commands')],
  },
  {
    agent: 'dsh',
    displayName: 'DeepSeek Harness (DSH)',
    format: 'yaml-dsh',
    isDetected: (home) => existsSync(path.join(home, '.dsh')),
    mcpConfigPaths: (home, includeVariants) => {
      const yaml = path.join(home, '.dsh', 'settings.yaml');
      const yml = path.join(home, '.dsh', 'settings.yml');
      if (includeVariants) {
        const list = [yaml, yml].filter(isFile);
        return list.length > 0 ? list : [yaml];
      }
      if (isFile(yaml)) return [yaml];
      if (isFile(yml)) return [yml];
      return [yaml];
    },
    skillPaths: (home) => [path.join(home, '.dsh', 'skills', 'agent-cleaner', 'SKILL.md')],
    commandDirs: (home) => [path.join(home, '.dsh', 'commands')],
  },
];

// --- JSON / JSONC comment-preserving scanner & editor ---

interface JsoncProp {
  key: string;
  keyStart: number;
  colonIdx: number;
  valStart: number;
  valEnd: number;
}

interface JsoncObjectSpan {
  openBrace: number;
  closeBrace: number;
  props: JsoncProp[];
}

function skipTrivia(text: string, idx: number): number {
  let i = idx;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) return text.length;
      i = close + 2;
      continue;
    }
    break;
  }
  return i;
}

function readJsonString(text: string, start: number): { value: string; end: number } {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') {
      const raw = text.slice(start, i + 1);
      return { value: JSON.parse(raw) as string, end: i + 1 };
    }
    i += 1;
  }
  throw new Error('Unterminated JSON string literal');
}

function skipJsonValue(text: string, start: number): number {
  const ch = text[start];
  if (ch === '"') {
    return readJsonString(text, start).end;
  }
  if (ch === '{' || ch === '[') {
    const closeChar = ch === '{' ? '}' : ']';
    let depth = 1;
    let i = start + 1;
    while (i < text.length && depth > 0) {
      i = skipTrivia(text, i);
      if (i >= text.length) break;
      const cur = text[i]!;
      if (cur === '"') {
        i = readJsonString(text, i).end;
      } else if (cur === '{' || cur === '[') {
        depth += 1;
        i += 1;
      } else if (cur === '}' || cur === ']') {
        depth -= 1;
        i += 1;
      } else {
        i += 1;
      }
    }
    if (depth !== 0 || text[i - 1] !== closeChar) {
      throw new Error(`Unclosed ${ch} in JSON/JSONC`);
    }
    return i;
  }
  let i = start;
  while (i < text.length) {
    const c = text[i]!;
    if (
      c === ',' ||
      c === '}' ||
      c === ']' ||
      c === ' ' ||
      c === '\t' ||
      c === '\n' ||
      c === '\r' ||
      (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*'))
    ) {
      break;
    }
    i += 1;
  }
  if (i === start) throw new Error(`Unexpected token at offset ${start}`);
  return i;
}

function stripJsoncToJson(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      const { end } = readJsonString(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) throw new Error('Unterminated block comment');
      i = close + 2;
      continue;
    }
    if (ch === ',') {
      const next = skipTrivia(text, i + 1);
      if (text[next] === '}' || text[next] === ']') {
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

function parseJsoncSafely(text: string, filePath: string): Record<string, unknown> {
  const stripped = stripJsoncToJson(text).trim();
  if (!stripped) return {};
  const parsed: unknown = JSON.parse(stripped);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${filePath} root value is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseJsoncObjectSpan(text: string, openBrace: number): JsoncObjectSpan {
  if (text[openBrace] !== '{') {
    throw new Error(`Expected '{' at offset ${openBrace}`);
  }
  const props: JsoncProp[] = [];
  let i = skipTrivia(text, openBrace + 1);
  while (i < text.length && text[i] !== '}') {
    if (text[i] === ',') {
      i = skipTrivia(text, i + 1);
      continue;
    }
    if (text[i] !== '"') {
      throw new Error(`Expected property name at offset ${i}`);
    }
    const keyStart = i;
    const { value: key, end: keyEnd } = readJsonString(text, i);
    const colonIdx = skipTrivia(text, keyEnd);
    if (text[colonIdx] !== ':') {
      throw new Error(`Expected ':' after key "${key}"`);
    }
    const valStart = skipTrivia(text, colonIdx + 1);
    const valEnd = skipJsonValue(text, valStart);
    props.push({ key, keyStart, colonIdx, valStart, valEnd });
    i = skipTrivia(text, valEnd);
    if (text[i] === ',') {
      i = skipTrivia(text, i + 1);
    }
  }
  if (text[i] !== '}') {
    throw new Error('Unclosed JSON object');
  }
  return { openBrace, closeBrace: i, props };
}

function lineIndentAt(text: string, pos: number): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const slice = text.slice(lineStart, pos);
  const match = /^[ \t]*/.exec(slice);
  return match ? match[0] : '';
}

function indentJsonBlock(value: unknown, baseIndent: string, unitIndent = '  '): string {
  const pretty = JSON.stringify(value, null, unitIndent);
  return pretty
    .split('\n')
    .map((line, idx) => (idx === 0 ? line : `${baseIndent}${line}`))
    .join('\n');
}

function hasCommentsBetween(text: string, start: number, end: number): boolean {
  const segment = text.slice(start, end);
  return segment.includes('//') || segment.includes('/*');
}

function insertPropertyIntoJsoncObject(
  text: string,
  span: JsoncObjectSpan,
  propKey: string,
  propValue: unknown,
): string {
  const objIndent = lineIndentAt(text, span.openBrace);
  const childIndent = `${objIndent}  `;
  const formattedVal = indentJsonBlock(propValue, childIndent);
  const entryText = `${childIndent}${JSON.stringify(propKey)}: ${formattedVal}`;

  if (span.props.length === 0) {
    if (!hasCommentsBetween(text, span.openBrace + 1, span.closeBrace)) {
      return (
        text.slice(0, span.openBrace + 1) +
        `\n${entryText}\n${objIndent}` +
        text.slice(span.closeBrace)
      );
    }
    const insertAt = span.closeBrace;
    const prefix = text[insertAt - 1] === '\n' ? '' : '\n';
    return text.slice(0, insertAt) + `${prefix}${entryText}\n${objIndent}` + text.slice(insertAt);
  }

  const lastProp = span.props[span.props.length - 1]!;
  const afterLast = skipTrivia(text, lastProp.valEnd);
  const hasTrailingComma = text[afterLast] === ',';

  let updated = text;
  let closeOffset = span.closeBrace;

  if (!hasTrailingComma) {
    updated = updated.slice(0, lastProp.valEnd) + ',' + updated.slice(lastProp.valEnd);
    closeOffset += 1;
  }

  const lineBeforeClose = updated.lastIndexOf('\n', closeOffset - 1);
  const insertPos =
    lineBeforeClose > span.openBrace &&
    updated.slice(lineBeforeClose + 1, closeOffset).trim() === ''
      ? lineBeforeClose + 1
      : closeOffset;
  const prefix = insertPos === 0 || updated[insertPos - 1] === '\n' ? '' : '\n';
  const suffix = insertPos === closeOffset ? objIndent : '';

  return (
    updated.slice(0, insertPos) + `${prefix}${entryText}\n${suffix}` + updated.slice(insertPos)
  );
}

function removePropertyFromJsoncObject(
  text: string,
  span: JsoncObjectSpan,
  targetKey: string,
): { text: string; removed: boolean } {
  const idx = span.props.findIndex((p) => p.key === targetKey);
  if (idx === -1) return { text, removed: false };

  const prop = span.props[idx]!;
  const afterVal = skipTrivia(text, prop.valEnd);
  const hasCommaAfter = text[afterVal] === ',';

  // Expand left to beginning of line if only whitespace precedes the key on its line
  const prevNewline = text.lastIndexOf('\n', prop.keyStart - 1);
  const lineStart = prevNewline === -1 ? 0 : prevNewline + 1;
  const start =
    text.slice(lineStart, prop.keyStart).trim() === '' ? lineStart : prop.keyStart;

  let end = hasCommaAfter ? afterVal + 1 : prop.valEnd;
  // Consume trailing spaces/tabs and a single newline if nothing else is on the ending line
  let tail = end;
  while (tail < text.length && (text[tail] === ' ' || text[tail] === '\t')) tail += 1;
  if (text[tail] === '\r' && text[tail + 1] === '\n') {
    end = tail + 2;
  } else if (text[tail] === '\n') {
    end = tail + 1;
  }

  let updated = text.slice(0, start) + text.slice(end);

  // If we removed the last property (which had no comma after it) and a preceding property had a trailing comma before `}`, keep or normalize cleanly (JSONC allows trailing commas, but removing the comma when it wasn't trailing originally keeps strict JSON valid too)
  if (!hasCommaAfter && idx > 0) {
    const prevProp = span.props[idx - 1]!;
    const afterPrev = skipTrivia(text, prevProp.valEnd);
    if (text[afterPrev] === ',') {
      updated = updated.slice(0, afterPrev) + updated.slice(afterPrev + 1);
    }
  }

  return { text: updated, removed: true };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function upsertJsoncMcpText(
  rawInput: string,
  filePath: string,
  opencodeSchema: boolean,
): { content: string; changed: boolean } {
  const existed = rawInput.length > 0;
  const source = rawInput.trim().length === 0 ? '{}\n' : rawInput;
  const parsedRoot = parseJsoncSafely(source, filePath);

  const rootOpen = skipTrivia(source, 0);
  if (source[rootOpen] !== '{') {
    throw new Error(`${filePath} root value is not a JSON object`);
  }
  const rootSpan = parseJsoncObjectSpan(source, rootOpen);

  const useOpencodeNative =
    opencodeSchema && !('mcpServers' in parsedRoot && !('mcp' in parsedRoot));

  const containerKey = useOpencodeNative ? 'mcp' : 'mcpServers';
  const expectedEntry = useOpencodeNative
    ? { type: 'local', command: [NPX_COMMAND, ...NPX_ARGS] }
    : { command: NPX_COMMAND, args: NPX_ARGS };

  const containerRecord = parsedRoot[containerKey];
  if (
    containerRecord &&
    typeof containerRecord === 'object' &&
    !Array.isArray(containerRecord) &&
    deepEqual((containerRecord as Record<string, unknown>)[SERVER_KEY], expectedEntry)
  ) {
    return { content: rawInput, changed: false };
  }

  const containerProp = rootSpan.props.find((p) => p.key === containerKey);
  let out: string;

  if (!containerProp) {
    out = insertPropertyIntoJsoncObject(source, rootSpan, containerKey, {
      [SERVER_KEY]: expectedEntry,
    });
  } else {
    if (source[containerProp.valStart] !== '{') {
      throw new Error(`${filePath} property "${containerKey}" is not an object`);
    }
    const containerSpan = parseJsoncObjectSpan(source, containerProp.valStart);
    const existingProp = containerSpan.props.find((p) => p.key === SERVER_KEY);
    if (existingProp) {
      const childIndent = lineIndentAt(source, existingProp.keyStart);
      const formattedVal = indentJsonBlock(expectedEntry, childIndent);
      out =
        source.slice(0, existingProp.valStart) +
        formattedVal +
        source.slice(existingProp.valEnd);
    } else {
      out = insertPropertyIntoJsoncObject(source, containerSpan, SERVER_KEY, expectedEntry);
    }
  }

  if (!out.endsWith('\n')) out += '\n';
  parseJsoncSafely(out, filePath);
  return { content: out, changed: !existed || out !== rawInput };
}

export function removeJsoncMcpText(
  rawInput: string,
  filePath: string,
): { content: string; changed: boolean } {
  if (!rawInput.trim()) return { content: rawInput, changed: false };
  parseJsoncSafely(rawInput, filePath);

  let current = rawInput;
  let anyRemoved = false;

  for (const containerKey of ['mcpServers', 'mcp']) {
    const rootOpen = skipTrivia(current, 0);
    if (current[rootOpen] !== '{') continue;
    const rootSpan = parseJsoncObjectSpan(current, rootOpen);
    const containerProp = rootSpan.props.find((p) => p.key === containerKey);
    if (!containerProp || current[containerProp.valStart] !== '{') continue;
    const containerSpan = parseJsoncObjectSpan(current, containerProp.valStart);
    const { text: nextText, removed } = removePropertyFromJsoncObject(
      current,
      containerSpan,
      SERVER_KEY,
    );
    if (removed) {
      current = nextText;
      anyRemoved = true;
    }
  }

  if (!anyRemoved) return { content: rawInput, changed: false };
  parseJsoncSafely(current, filePath);
  return { content: current, changed: true };
}

// --- TOML comment-preserving editor (Codex CLI) ---

function isTomlHeaderLine(trimmed: string): string | null {
  if (!trimmed.startsWith('[')) return null;
  // Ignore array literals like `args = [...]`, only match `[table]` or `[[array]]`
  const withoutComment = trimmed.replace(/\s+#.*$/, '').trim();
  if (withoutComment.startsWith('[[') && withoutComment.endsWith(']]')) {
    return withoutComment.slice(2, -2).trim();
  }
  if (withoutComment.startsWith('[') && withoutComment.endsWith(']')) {
    return withoutComment.slice(1, -1).trim();
  }
  return null;
}

function isTargetCodexHeader(headerName: string): boolean {
  const normalized = headerName.replace(/\s+/g, '');
  return (
    normalized === `mcp_servers.${SERVER_KEY}` ||
    normalized === `mcp_servers."${SERVER_KEY}"` ||
    normalized === `mcp_servers.'${SERVER_KEY}'` ||
    normalized === `mcp.servers.${SERVER_KEY}` ||
    normalized === `mcp.servers."${SERVER_KEY}"`
  );
}

function removeTomlSectionLines(lines: string[]): { lines: string[]; removed: boolean } {
  const out: string[] = [];
  let i = 0;
  let removed = false;
  let currentHeader = '';

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const header = isTomlHeaderLine(trimmed);

    if (header !== null) {
      if (isTargetCodexHeader(header)) {
        removed = true;
        i += 1;
        while (i < lines.length) {
          const nextTrimmed = lines[i]!.trim();
          if (isTomlHeaderLine(nextTrimmed) !== null) {
            break;
          }
          // Preserve trailing comments/blank lines that likely belong to a following section
          if (nextTrimmed.startsWith('#') || nextTrimmed === '') {
            let lookahead = i;
            while (
              lookahead < lines.length &&
              (lines[lookahead]!.trim() === '' || lines[lookahead]!.trim().startsWith('#'))
            ) {
              lookahead += 1;
            }
            if (lookahead < lines.length && isTomlHeaderLine(lines[lookahead]!.trim()) !== null) {
              break;
            }
          }
          i += 1;
        }
        continue;
      }
      currentHeader = header.replace(/\s+/g, '');
      out.push(line);
      i += 1;
      continue;
    }

    // Handle inline `agent-cleaner = { ... }` inside `[mcp_servers]`
    if (
      (currentHeader === 'mcp_servers' || currentHeader === 'mcp.servers') &&
      /^(?:"agent-cleaner"|'agent-cleaner'|agent-cleaner)\s*=/.test(trimmed)
    ) {
      removed = true;
      let bracketBalance = 0;
      for (const ch of trimmed) {
        if (ch === '[' || ch === '{') bracketBalance += 1;
        else if (ch === ']' || ch === '}') bracketBalance -= 1;
      }
      i += 1;
      while (bracketBalance > 0 && i < lines.length) {
        for (const ch of lines[i]!) {
          if (ch === '[' || ch === '{') bracketBalance += 1;
          else if (ch === ']' || ch === '}') bracketBalance -= 1;
        }
        i += 1;
      }
      continue;
    }

    out.push(line);
    i += 1;
  }

  return { lines: out, removed };
}

function tomlSectionMatchesNpx(raw: string): boolean {
  const lines = raw.split(/\r?\n/);
  let inTarget = false;
  let foundCmd = false;
  let foundArgs = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const header = isTomlHeaderLine(trimmed);
    if (header !== null) {
      inTarget = header.replace(/\s+/g, '') === `mcp_servers.${SERVER_KEY}` ||
        header.replace(/\s+/g, '') === `mcp_servers."${SERVER_KEY}"`;
      continue;
    }
    if (!inTarget || trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).replace(/\s+#.*$/, '').trim();
    if (key === 'command' && (val === `"${NPX_COMMAND}"` || val === `'${NPX_COMMAND}'`)) {
      foundCmd = true;
    }
    if (key === 'args') {
      try {
        const parsed = JSON.parse(val.replace(/'/g, '"'));
        if (deepEqual(parsed, NPX_ARGS)) foundArgs = true;
      } catch {
        // ignore parse fallback
      }
    }
  }

  return foundCmd && foundArgs;
}

export function upsertTomlMcpText(rawInput: string): { content: string; changed: boolean } {
  const existed = rawInput.length > 0;
  if (existed && tomlSectionMatchesNpx(rawInput)) {
    return { content: rawInput, changed: false };
  }

  const lines = rawInput ? rawInput.split(/\r?\n/) : [];
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const { lines: cleaned } = removeTomlSectionLines(lines);
  while (cleaned.length > 0 && cleaned[cleaned.length - 1] === '') {
    cleaned.pop();
  }

  if (cleaned.length > 0) {
    cleaned.push('');
  }
  cleaned.push(`[mcp_servers.${SERVER_KEY}]`);
  cleaned.push(`command = ${JSON.stringify(NPX_COMMAND)}`);
  cleaned.push(`args = ${JSON.stringify(NPX_ARGS)}`);

  const out = `${cleaned.join('\n')}\n`;
  return { content: out, changed: !existed || out !== rawInput };
}

export function removeTomlMcpText(rawInput: string): { content: string; changed: boolean } {
  if (!rawInput.trim()) return { content: rawInput, changed: false };
  const lines = rawInput.split(/\r?\n/);
  const hasTrailingNewline = rawInput.endsWith('\n');
  if (hasTrailingNewline && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const { lines: cleaned, removed } = removeTomlSectionLines(lines);
  if (!removed) return { content: rawInput, changed: false };

  while (cleaned.length > 0 && cleaned[cleaned.length - 1] === '') {
    cleaned.pop();
  }
  const out = cleaned.length > 0 ? `${cleaned.join('\n')}\n` : '';
  return { content: out, changed: true };
}

// --- YAML comment-preserving editor (DSH) ---

function removeYamlMcpKeyText(raw: string, targetKey: string): { text: string; removed: boolean } {
  const lines = raw ? raw.split(/\r?\n/) : [];
  if (raw.endsWith('\n') && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const out: string[] = [];
  let i = 0;
  let inMcpServers = false;
  let mcpIndent: number | null = null;
  let entryIndent: number | null = null;
  let removed = false;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    if (trimmed !== '' && !trimmed.startsWith('#') && mcpIndent !== null && indent <= mcpIndent) {
      inMcpServers = false;
      mcpIndent = null;
      entryIndent = null;
    }

    if (!inMcpServers) {
      if (trimmed === 'mcpServers:' || trimmed.startsWith('mcpServers:')) {
        inMcpServers = true;
        mcpIndent = indent;
      }
      out.push(line);
      i += 1;
      continue;
    }

    if (trimmed !== '' && !trimmed.startsWith('#')) {
      if (entryIndent === null) entryIndent = indent;
      if (indent === entryIndent) {
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx !== -1) {
          const keyClean = trimmed
            .slice(0, colonIdx)
            .trim()
            .replace(/^["']|["']$/g, '');
          if (keyClean === targetKey) {
            removed = true;
            i += 1;
            while (i < lines.length) {
              const next = lines[i]!;
              const nextTrimmed = next.trim();
              const nextIndent = next.length - next.trimStart().length;
              if (nextTrimmed === '' || nextTrimmed.startsWith('#')) {
                if (nextIndent > entryIndent) {
                  i += 1;
                  continue;
                }
                break;
              }
              if (nextIndent > entryIndent) {
                i += 1;
              } else {
                break;
              }
            }
            continue;
          }
        }
      }
    }

    out.push(line);
    i += 1;
  }

  if (!removed) return { text: raw, removed: false };
  const updated = out.join('\n') + (raw.endsWith('\n') && out.length > 0 ? '\n' : '');
  return { text: updated, removed: true };
}

function yamlEntryMatchesNpx(raw: string): boolean {
  const lines = raw.split(/\r?\n/);
  let inMcpServers = false;
  let inTarget = false;
  let mcpIndent = 0;
  let targetIndent = 0;
  let cmd: string | null = null;
  const args: string[] = [];
  let inArgs = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;

    if (!inMcpServers) {
      if (indent === 0 && (trimmed === 'mcpServers:' || trimmed.startsWith('mcpServers:'))) {
        inMcpServers = true;
        mcpIndent = indent;
      }
      continue;
    }

    if (indent <= mcpIndent) break;

    if (!inTarget) {
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx !== -1) {
        const key = trimmed.slice(0, colonIdx).trim().replace(/^["']|["']$/g, '');
        if (key === SERVER_KEY) {
          inTarget = true;
          targetIndent = indent;
        }
      }
      continue;
    }

    if (indent <= targetIndent) break;

    if (inArgs && trimmed.startsWith('- ')) {
      args.push(trimmed.slice(2).trim().replace(/^["']|["']$/g, ''));
      continue;
    }
    inArgs = false;

    if (trimmed.startsWith('command:')) {
      cmd = trimmed.slice('command:'.length).trim().replace(/^["']|["']$/g, '');
    } else if (trimmed === 'args:' || trimmed.startsWith('args:')) {
      inArgs = true;
    }
  }

  return inTarget && cmd === NPX_COMMAND && deepEqual(args, NPX_ARGS);
}

export function upsertYamlMcpText(rawInput: string): { content: string; changed: boolean } {
  const existed = rawInput.length > 0;
  if (existed && yamlEntryMatchesNpx(rawInput)) {
    return { content: rawInput, changed: false };
  }

  const { text: cleaned } = removeYamlMcpKeyText(rawInput, SERVER_KEY);
  const lines = cleaned ? cleaned.split(/\r?\n/) : [];
  if (cleaned.endsWith('\n') && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const mcpIdx = lines.findIndex((line) => {
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    return indent === 0 && (trimmed === 'mcpServers:' || trimmed.startsWith('mcpServers:'));
  });

  if (mcpIdx !== -1) {
    const headerLine = lines[mcpIdx]!;
    const rest = headerLine.trim().slice('mcpServers:'.length).trimStart();
    if (rest.startsWith('{}')) {
      const comment = rest.slice(2).trim();
      lines[mcpIdx] = comment.startsWith('#') ? `mcpServers: ${comment}` : 'mcpServers:';
    }

    let childIndent: number | null = null;
    let insertIdx = mcpIdx + 1;
    for (let j = mcpIdx + 1; j < lines.length; j += 1) {
      const line = lines[j]!;
      const trimmed = line.trim();
      const indent = line.length - line.trimStart().length;
      if (trimmed !== '' && !trimmed.startsWith('#')) {
        if (indent === 0) break;
        if (childIndent === null) childIndent = indent;
        insertIdx = j + 1;
      }
    }

    const ind = ' '.repeat(childIndent ?? 2);
    const entryLines = [
      `${ind}${SERVER_KEY}:`,
      `${ind}  command: ${NPX_COMMAND}`,
      `${ind}  args:`,
      ...NPX_ARGS.map((a) => `${ind}    - ${a}`),
    ];
    lines.splice(insertIdx, 0, ...entryLines);
  } else {
    if (lines.length > 0 && lines[lines.length - 1]!.trim() !== '') {
      lines.push('');
    }
    lines.push('mcpServers:');
    lines.push(`  ${SERVER_KEY}:`);
    lines.push(`    command: ${NPX_COMMAND}`);
    lines.push('    args:');
    for (const a of NPX_ARGS) {
      lines.push(`      - ${a}`);
    }
  }

  const out = `${lines.join('\n')}\n`;
  return { content: out, changed: !existed || out !== rawInput };
}

export function removeYamlMcpText(rawInput: string): { content: string; changed: boolean } {
  if (!rawInput.trim()) return { content: rawInput, changed: false };
  const { text: updated, removed } = removeYamlMcpKeyText(rawInput, SERVER_KEY);
  if (!removed) return { content: rawInput, changed: false };

  const lines = updated.split(/\r?\n/);
  if (updated.endsWith('\n') && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const mcpIdx = lines.findIndex((line) => {
    const indent = line.length - line.trimStart().length;
    return indent === 0 && line.trim() === 'mcpServers:';
  });
  if (mcpIdx !== -1) {
    let hasChildren = false;
    for (let j = mcpIdx + 1; j < lines.length; j += 1) {
      const trimmed = lines[j]!.trim();
      const indent = lines[j]!.length - lines[j]!.trimStart().length;
      if (trimmed !== '' && !trimmed.startsWith('#')) {
        if (indent > 0) hasChildren = true;
        break;
      }
    }
    if (!hasChildren) {
      lines[mcpIdx] = 'mcpServers: {}';
    }
  }

  const out = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  return { content: out, changed: true };
}

// --- Platform Detection & Installation ---

function pathHasMcpEntry(filePath: string, format: ConfigFormat): boolean {
  if (!isFile(filePath)) return false;
  try {
    const raw = readFileSync(filePath, 'utf8');
    if (format === 'jsonc-standard' || format === 'jsonc-opencode') {
      const parsed = parseJsoncSafely(raw, filePath);
      const mcpServers = parsed.mcpServers;
      const mcp = parsed.mcp;
      if (
        mcpServers &&
        typeof mcpServers === 'object' &&
        !Array.isArray(mcpServers) &&
        SERVER_KEY in (mcpServers as Record<string, unknown>)
      ) {
        return true;
      }
      if (
        mcp &&
        typeof mcp === 'object' &&
        !Array.isArray(mcp) &&
        SERVER_KEY in (mcp as Record<string, unknown>)
      ) {
        return true;
      }
      return false;
    }
    if (format === 'toml-codex') {
      const lines = raw.split(/\r?\n/);
      let inMcpServers = false;
      for (const line of lines) {
        const trimmed = line.trim();
        const header = isTomlHeaderLine(trimmed);
        if (header !== null) {
          if (isTargetCodexHeader(header)) return true;
          inMcpServers = header.replace(/\s+/g, '') === 'mcp_servers';
          continue;
        }
        if (
          inMcpServers &&
          /^(?:"agent-cleaner"|'agent-cleaner'|agent-cleaner)\s*=/.test(trimmed)
        ) {
          return true;
        }
      }
      return false;
    }
    if (format === 'yaml-dsh') {
      const { removed } = removeYamlMcpKeyText(raw, SERVER_KEY);
      return removed;
    }
  } catch {
    return false;
  }
  return false;
}

export function detectPlatforms(homeDir: string = os.homedir()): PlatformPluginStatus[] {
  return PLATFORM_SPECS.map((spec) => {
    const mcpPaths = spec.mcpConfigPaths(homeDir, true);
    const skillPaths = spec.skillPaths(homeDir);
    const commandDirs = spec.commandDirs(homeDir);

    const mcpInstalled = mcpPaths.some((p) => pathHasMcpEntry(p, spec.format));
    const skillInstalled = skillPaths.length > 0 && skillPaths.every(isFile);
    const commandsInstalled =
      commandDirs.length > 0 &&
      commandDirs.every((dir) =>
        Object.keys(COMMAND_TEMPLATES).every((name) => isFile(path.join(dir, name))),
      );

    return {
      agent: spec.agent,
      displayName: spec.displayName,
      detected: spec.isDetected(homeDir),
      mcpInstalled,
      skillInstalled,
      commandsInstalled,
      mcpConfigPaths: mcpPaths,
      skillPaths,
      commandDirs,
    };
  });
}

function backupFile(homeDir: string, filePath: string): string {
  const backupsDir = path.join(homeDir, '.agent-cleaner', 'backups');
  mkdirSync(backupsDir, { recursive: true });
  const name = path.basename(filePath);
  const backupPath = path.join(backupsDir, `${Date.now()}_${name}`);
  copyFileSync(filePath, backupPath);
  return backupPath;
}

function writeTextIfChanged(filePath: string, content: string): boolean {
  if (isFile(filePath)) {
    try {
      if (readFileSync(filePath, 'utf8') === content) return false;
    } catch {
      // proceed to overwrite
    }
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
  return true;
}

function removeFileAndPruneEmptyDir(filePath: string, stopAt: string): boolean {
  if (!isFile(filePath)) return false;
  rmSync(filePath, { force: true });
  let dir = path.dirname(filePath);
  while (dir !== stopAt && dir.startsWith(stopAt)) {
    try {
      if (readdirSync(dir).length > 0) break;
      rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
  return true;
}

function resolveTargetSpecs(homeDir: string, options: PluginSetupOptions): PlatformSpec[] {
  if (options.agents && options.agents.length > 0) {
    const seen = new Set<string>();
    const out: PlatformSpec[] = [];
    for (const rawName of options.agents) {
      const normalized = rawName.trim().toLowerCase();
      if (!normalized) continue;
      const spec = PLATFORM_SPECS.find((s) => s.agent === normalized);
      if (!spec) {
        throw new Error(
          `Unsupported platform "${rawName}" (supported: ${SUPPORTED_AGENTS.join(', ')})`,
        );
      }
      if (!seen.has(spec.agent)) {
        seen.add(spec.agent);
        out.push(spec);
      }
    }
    return out;
  }

  if (options.includeUndetected) {
    return [...PLATFORM_SPECS];
  }

  const statuses = detectPlatforms(homeDir);
  const out: PlatformSpec[] = [];
  for (const status of statuses) {
    const active =
      status.detected ||
      (Boolean(options.uninstall) &&
        (status.mcpInstalled || status.skillInstalled || status.commandsInstalled));
    if (active) {
      const spec = PLATFORM_SPECS.find((s) => s.agent === status.agent);
      if (spec) out.push(spec);
    }
  }
  return out;
}

export function setupPlugins(options: PluginSetupOptions = {}): PluginSetupReport {
  const homeDir = options.homeDir ?? os.homedir();
  const targetSpecs = resolveTargetSpecs(homeDir, options);
  const uninstall = Boolean(options.uninstall);
  const results: PlatformSetupResult[] = [];

  for (const spec of targetSpecs) {
    const res: PlatformSetupResult = {
      agent: spec.agent,
      displayName: spec.displayName,
      success: true,
      updatedFiles: [],
      removedFiles: [],
      backupPaths: [],
    };

    try {
      const mcpPaths = spec.mcpConfigPaths(homeDir, uninstall);
      const skillPaths = spec.skillPaths(homeDir);
      const commandDirs = spec.commandDirs(homeDir);

      if (uninstall) {
        for (const cfgPath of mcpPaths) {
          if (!isFile(cfgPath)) continue;
          const raw = readFileSync(cfgPath, 'utf8');
          const outcome =
            spec.format === 'jsonc-standard' || spec.format === 'jsonc-opencode'
              ? removeJsoncMcpText(raw, cfgPath)
              : spec.format === 'toml-codex'
                ? removeTomlMcpText(raw)
                : removeYamlMcpText(raw);
          if (outcome.changed) {
            res.backupPaths.push(backupFile(homeDir, cfgPath));
            writeFileSync(cfgPath, outcome.content, 'utf8');
            res.updatedFiles.push(cfgPath);
          }
        }

        for (const skillPath of skillPaths) {
          const stopAt = path.dirname(path.dirname(skillPath));
          if (removeFileAndPruneEmptyDir(skillPath, stopAt)) {
            res.removedFiles.push(skillPath);
          }
        }

        for (const dir of commandDirs) {
          const stopAt = path.dirname(dir);
          for (const filename of Object.keys(COMMAND_TEMPLATES)) {
            const cmdPath = path.join(dir, filename);
            if (removeFileAndPruneEmptyDir(cmdPath, stopAt)) {
              res.removedFiles.push(cmdPath);
            }
          }
        }
      } else {
        for (const cfgPath of mcpPaths) {
          const existed = isFile(cfgPath);
          const raw = existed ? readFileSync(cfgPath, 'utf8') : '';
          const outcome =
            spec.format === 'jsonc-standard'
              ? upsertJsoncMcpText(raw, cfgPath, false)
              : spec.format === 'jsonc-opencode'
                ? upsertJsoncMcpText(raw, cfgPath, true)
                : spec.format === 'toml-codex'
                  ? upsertTomlMcpText(raw)
                  : upsertYamlMcpText(raw);
          if (outcome.changed) {
            if (existed) {
              res.backupPaths.push(backupFile(homeDir, cfgPath));
            }
            mkdirSync(path.dirname(cfgPath), { recursive: true });
            writeFileSync(cfgPath, outcome.content, 'utf8');
            res.updatedFiles.push(cfgPath);
          }
        }

        for (const skillPath of skillPaths) {
          if (writeTextIfChanged(skillPath, SKILL_MD_TEMPLATE)) {
            res.updatedFiles.push(skillPath);
          }
        }

        for (const dir of commandDirs) {
          for (const [filename, content] of Object.entries(COMMAND_TEMPLATES)) {
            const cmdPath = path.join(dir, filename);
            if (writeTextIfChanged(cmdPath, content)) {
              res.updatedFiles.push(cmdPath);
            }
          }
        }
      }
    } catch (err) {
      res.success = false;
      res.error = err instanceof Error ? err.message : String(err);
    }

    results.push(res);
  }

  return {
    results,
    statuses: detectPlatforms(homeDir),
  };
}

function formatStatusTable(statuses: PlatformPluginStatus[]): string {
  const headers = ['Platform', 'ID', 'Detected', 'MCP', 'Skill', 'Commands'];
  const rows = statuses.map((s) => [
    s.displayName,
    s.agent,
    s.detected ? 'Yes' : 'No',
    s.mcpInstalled ? 'Installed' : '-',
    s.skillInstalled ? 'Installed' : '-',
    s.commandsInstalled ? 'Installed' : '-',
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]!.length)),
  );
  const sep = widths.map((w) => '-'.repeat(w)).join(' | ');
  const formatRow = (cols: string[]) =>
    cols.map((c, i) => c.padEnd(widths[i]!)).join(' | ');
  return [formatRow(headers), sep, ...rows.map(formatRow)].join('\n');
}

function printSetupHelp(): void {
  process.stdout.write(`Install Agent Cleaner plugins (MCP + Skill + slash commands) without installing a global CLI.

Usage:
  npx -y dsh-agent-cleaner setup [options]

Options:
  --status              Show detected platforms and current plugin status
  --yes, -y             Skip confirmation and apply to detected (or specified) platforms
  --all                 Include all supported platforms even if not detected locally
  --agent <list>        Comma-separated platforms (${SUPPORTED_AGENTS.join(',')})
  --uninstall           Remove MCP config, Skill, and slash commands
  --json                Output machine-readable JSON
  -h, --help            Show this help message
`);
}

export async function runSetupCli(argv: string[]): Promise<void> {
  let statusOnly = false;
  let yes = false;
  let all = false;
  let uninstall = false;
  let json = false;
  let agents: string[] | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') {
      printSetupHelp();
      return;
    } else if (arg === '--status') {
      statusOnly = true;
    } else if (arg === '--yes' || arg === '-y') {
      yes = true;
    } else if (arg === '--all') {
      all = true;
    } else if (arg === '--uninstall') {
      uninstall = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--agent') {
      const next = argv[i + 1];
      if (!next) throw new Error('--agent requires a comma-separated value');
      i += 1;
      agents = next
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--agent=')) {
      agents = arg
        .slice('--agent='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      throw new Error(`Unknown setup option: ${arg}`);
    }
  }

  const homeDir = os.homedir();
  if (statusOnly) {
    const statuses = detectPlatforms(homeDir);
    if (json) {
      process.stdout.write(`${JSON.stringify(statuses, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatStatusTable(statuses)}\n`);
    }
    return;
  }

  if (!yes && !all && !agents && !json && process.stdin.isTTY && process.stdout.isTTY) {
    const statuses = detectPlatforms(homeDir);
    process.stdout.write(`${formatStatusTable(statuses)}\n\n`);

    const detectedIds = statuses.filter((s) => s.detected).map((s) => s.agent);
    const installedIds = statuses
      .filter((s) => s.mcpInstalled || s.skillInstalled || s.commandsInstalled)
      .map((s) => s.agent);
    const defaultIds = uninstall ? installedIds : detectedIds;

    if (uninstall && defaultIds.length === 0) {
      process.stdout.write('No installed agent-cleaner plugins detected.\n');
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const actionLabel = uninstall ? 'uninstall from' : 'install plugins (MCP + Skill + commands) onto';
      const defaultHint =
        defaultIds.length > 0 ? defaultIds.join(', ') : 'none detected — enter IDs or "all"';
      const answer = (
        await rl.question(
          `Proceed to ${actionLabel} [${defaultHint}]? (Y/n or comma-separated IDs): `,
        )
      ).trim();

      if (answer.toLowerCase() === 'n' || answer.toLowerCase() === 'no') {
        process.stdout.write('Cancelled.\n');
        return;
      }
      if (answer.toLowerCase() === 'all') {
        all = true;
      } else if (answer !== '' && answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
        agents = answer
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    } finally {
      rl.close();
    }
  }

  const report = setupPlugins({
    homeDir,
    agents,
    includeUndetected: all,
    uninstall,
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (report.results.length === 0) {
    process.stdout.write(
      'No target AI coding platforms detected locally. Re-run with `--all` or `--agent claude,cursor,...`.\n',
    );
  } else {
    for (const r of report.results) {
      if (r.success) {
        const tag = uninstall ? '[UNINSTALLED]' : '[INSTALLED]';
        process.stdout.write(
          `${tag} ${r.displayName} (${r.agent}) — updated: ${r.updatedFiles.length}, removed: ${r.removedFiles.length}, backups: ${r.backupPaths.length}\n`,
        );
        for (const p of r.updatedFiles) process.stdout.write(`  + ${p}\n`);
        for (const p of r.removedFiles) process.stdout.write(`  - ${p}\n`);
      } else {
        process.stderr.write(`[FAILED] ${r.displayName} (${r.agent}): ${r.error ?? 'unknown error'}\n`);
      }
    }
    if (!uninstall) {
      process.stdout.write(
        '\nDone! Restart your IDE/CLI agent if running, then try `/clean`, `/doctor`, `/mcp-audit`, or `/restore`.\n',
      );
    }
  }

  if (report.results.some((r) => !r.success)) {
    process.exitCode = 1;
  }
}
