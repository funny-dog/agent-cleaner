/**
 * DeepSeek Harness (DSH) Cordis plugin for agent-cleaner.
 * Exposes headless Cordis Tools and HTTP bridge routes backed by the `agent-cleaner` Rust CLI.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DshPluginConfig {
  binaryPath?: string;
  exemptRecentHours?: number;
}

export const name = 'agent-cleaner';
export const inject = ['tools'];

function resolveBinaryPath(configured?: string): string {
  if (configured) return configured;
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'agent-cleaner'),
    path.join(home, '.cargo', 'bin', 'agent-cleaner'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'agent-cleaner';
}

function resolveService(ctx: any, serviceName: string): any {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(serviceName) : ctx?.[serviceName];
  } catch {
    return undefined;
  }
}

async function runCliJson<T = unknown>(binaryPath: string, args: string[]): Promise<T> {
  const { stdout } = await execFileAsync(binaryPath, [...args, '--json'], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > 1024 * 1024) throw new Error('Request body too large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, any>;
}

function buildTextOutputSpec() {
  return {
    schema: { type: 'object' },
    render: (_args: unknown, value: unknown) => [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function registerHttpRoutes(ctx: any, bin: string, defaultHours: number): void {
  if (typeof ctx?.inject !== 'function') return;
  ctx.inject(['webServer'], (sctx: any) => {
    const webServer = resolveService(sctx, 'webServer');
    if (!webServer || typeof webServer.register !== 'function') return;

    const mount = () => {
      const route = (
        routePath: string,
        method: 'GET' | 'POST',
        fn: (body: Record<string, any>, req: IncomingMessage) => Promise<unknown>,
      ) =>
        webServer.register({
          kind: 'exact',
          path: routePath,
          handler: async (req: IncomingMessage, res: ServerResponse) => {
            if (req.method !== method) {
              res.writeHead(405, { allow: method });
              res.end();
              return;
            }
            try {
              const body = method === 'POST' ? await readJsonBody(req) : {};
              const data = await fn(body, req);
              sendJson(res, 200, { ok: true, data });
            } catch (err) {
              sendJson(res, 500, {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          },
        });

      return [
        route('/agent-cleaner/api/overview', 'GET', async (_body, req) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1');
          const hours = Number(url.searchParams.get('hours') ?? defaultHours);
          const safeHours = Number.isFinite(hours) && hours >= 0 ? Math.floor(hours) : defaultHours;
          const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'zh';
          const [agents, doctors, mcpAudit, trash] = await Promise.all([
            runCliJson(bin, ['scan', '--older-than', `${safeHours}h`, '--lang', lang]),
            runCliJson(bin, ['doctor']),
            runCliJson(bin, ['mcp']),
            runCliJson(bin, ['restore']),
          ]);
          return { agents, doctors, mcpAudit, trash, exemptHours: safeHours, lang };
        }),
        route('/agent-cleaner/api/clean', 'POST', async (body) => {
          const hours =
            typeof body.exemptHours === 'number' && body.exemptHours >= 0
              ? Math.floor(body.exemptHours)
              : defaultHours;
          const lang = body.lang === 'en' ? 'en' : 'zh';
          const args = ['clean', '--yes', '--older-than', `${hours}h`, '--lang', lang];
          if (body.onlyRecommended) args.push('--only-recommended');
          if (body.dryRun) args.push('--dry-run');
          if (Array.isArray(body.selectedIds) && body.selectedIds.length > 0) {
            args.push('--ids', body.selectedIds.map(String).join(','));
          }
          return runCliJson(bin, args);
        }),
        route('/agent-cleaner/api/doctor-fix', 'POST', () =>
          runCliJson(bin, ['doctor', '--fix']),
        ),
        route('/agent-cleaner/api/mcp-kill', 'POST', () => runCliJson(bin, ['mcp', '--kill'])),
        route('/agent-cleaner/api/restore', 'POST', (body) => {
          if (typeof body.batchId !== 'string' || !body.batchId) {
            throw new Error('batchId is required');
          }
          return runCliJson(bin, ['restore', body.batchId]);
        }),
        route('/agent-cleaner/api/purge', 'POST', (body) => {
          if (body.all) return runCliJson(bin, ['restore', '--purge-all']);
          if (typeof body.batchId === 'string' && body.batchId) {
            return runCliJson(bin, ['restore', '--purge', body.batchId]);
          }
          throw new Error('batchId or all=true is required');
        }),
      ];
    };

    if (typeof sctx.effect === 'function') {
      sctx.effect(() => {
        const disposers = mount();
        return () => {
          for (const d of disposers) if (typeof d === 'function') d();
        };
      }, 'agent-cleaner: http routes');
    } else {
      mount();
    }
  });
}

export function apply(ctx: any, config?: DshPluginConfig): void {
  const bin = resolveBinaryPath(config?.binaryPath);
  const defaultHours = config?.exemptRecentHours ?? 24;

  registerHttpRoutes(ctx, bin, defaultHours);

  const tools = resolveService(ctx, 'tools');
  if (!tools || typeof tools.register !== 'function') return;

  tools.register({
    name: 'agent_cleaner_scan',
    description:
      'Scan disk usage, bloated cache/snapshots, orphan sessions, and MCP health across AI coding agents.',
    parameters: {
      type: 'object',
      properties: {
        olderThanHours: {
          type: 'number',
          description: `Exempt items modified within this many hours (default: ${defaultHours})`,
        },
        agent: {
          type: 'string',
          description: 'Optional agent filter (e.g. claude, opencode, codex, dsh)',
        },
      },
    },
    output: buildTextOutputSpec(),
    execute: (args: { olderThanHours?: number; agent?: string } = {}) => {
      const cliArgs = ['scan', '--older-than', `${args.olderThanHours ?? defaultHours}h`];
      if (args.agent) cliArgs.push('--agent', args.agent);
      return runCliJson(bin, cliArgs);
    },
  });

  tools.register({
    name: 'agent_cleaner_clean',
    description:
      'Move reclaimable agent files and caches into the reversible trash (~/.agent-cleaner/trash/).',
    parameters: {
      type: 'object',
      properties: {
        olderThanHours: {
          type: 'number',
          description: `Exempt files modified within N hours (default: ${defaultHours})`,
        },
        onlyRecommended: {
          type: 'boolean',
          description: 'Only clean safe recommended items',
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview cleanup without moving files',
        },
        selectedIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional specific ScanItem IDs to clean',
        },
      },
    },
    output: buildTextOutputSpec(),
    execute: (
      args: {
        olderThanHours?: number;
        onlyRecommended?: boolean;
        dryRun?: boolean;
        selectedIds?: string[];
      } = {},
    ) => {
      const cliArgs = ['clean', '--yes', '--older-than', `${args.olderThanHours ?? defaultHours}h`];
      if (args.onlyRecommended) cliArgs.push('--only-recommended');
      if (args.dryRun) cliArgs.push('--dry-run');
      if (args.selectedIds?.length) cliArgs.push('--ids', args.selectedIds.join(','));
      return runCliJson(bin, cliArgs);
    },
  });

  tools.register({
    name: 'agent_cleaner_doctor',
    description:
      'Diagnose syntax and dead MCP links across AI agent configs, optionally auto-fixing while preserving comments.',
    parameters: {
      type: 'object',
      properties: {
        fix: {
          type: 'boolean',
          description: 'Auto-repair fixable issues after backing up original configs',
        },
      },
    },
    output: buildTextOutputSpec(),
    execute: (args: { fix?: boolean } = {}) => {
      const cliArgs = ['doctor'];
      if (args.fix) cliArgs.push('--fix');
      return runCliJson(bin, cliArgs);
    },
  });

  tools.register({
    name: 'agent_cleaner_mcp',
    description:
      'Audit cross-agent MCP configurations, cold npx/uv caches, and optionally terminate PPID=1 orphan processes.',
    parameters: {
      type: 'object',
      properties: {
        kill: {
          type: 'boolean',
          description: 'Terminate detected PPID=1 orphan stdio MCP processes',
        },
      },
    },
    output: buildTextOutputSpec(),
    execute: (args: { kill?: boolean } = {}) => {
      const cliArgs = ['mcp'];
      if (args.kill) cliArgs.push('--kill');
      return runCliJson(bin, cliArgs);
    },
  });
}

export default { name, inject, apply };
