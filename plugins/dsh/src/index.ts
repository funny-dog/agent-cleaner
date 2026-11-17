/**
 * DeepSeek Harness (DSH) Cordis plugin for agent-cleaner.
 * Exposes headless Cordis Tools and HTTP bridge routes backed by the `agent-cleaner` binary.
 */
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

const execFileAsync = promisify(execFile);

const REPO_RELEASE_BASE =
  'https://github.com/funny-dog/agent-cleaner/releases/latest/download';
const DOWNLOAD_TIMEOUT_MS = 120_000;

export interface DshPluginConfig {
  binaryPath?: string;
  exemptRecentHours?: number;
  downloadUrl?: string;
}

export const name = 'agent-cleaner';
export const inject = ['tools'];

const inFlightDownloads = new Map<string, Promise<string>>();

function binaryFilename(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'agent-cleaner.exe' : 'agent-cleaner';
}

export function resolveReleaseAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === 'darwin' && arch === 'arm64') return 'agent-cleaner-darwin-arm64.tar.gz';
  if (platform === 'darwin' && arch === 'x64') return 'agent-cleaner-darwin-x64.tar.gz';
  if (platform === 'linux' && arch === 'x64') return 'agent-cleaner-linux-x64.tar.gz';
  if (platform === 'linux' && arch === 'arm64') return 'agent-cleaner-linux-arm64.tar.gz';
  if (platform === 'win32' && arch === 'x64') return 'agent-cleaner-win32-x64.zip';
  throw new Error(
    `Unsupported platform for auto-downloading agent-cleaner: ${platform}/${arch}. Install manually or configure binaryPath.`,
  );
}

function isExistingFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findInPath(binName: string): string | null {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binName);
    if (isExistingFile(candidate)) return candidate;
  }
  return null;
}

function managedBinaryPath(platform: NodeJS.Platform = process.platform): string {
  return path.join(os.homedir(), '.agent-cleaner', 'bin', binaryFilename(platform));
}

export function findExistingBinaryPath(configured?: string): string | null {
  if (configured) return configured;
  const binName = binaryFilename();
  const home = os.homedir();
  const candidates = [
    managedBinaryPath(),
    path.join(home, '.local', 'bin', binName),
    path.join(home, '.cargo', 'bin', binName),
  ];
  for (const candidate of candidates) {
    if (isExistingFile(candidate)) return candidate;
  }
  return findInPath(binName);
}

export function extractBinaryFromTarGz(gzBuffer: Buffer, targetFileName: string): Buffer {
  const tar = gunzipSync(gzBuffer);
  const BLOCK = 512;
  let offset = 0;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    const entryName = header.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    if (!entryName) break;

    const rawSize = header.toString('ascii', 124, 136).replace(/\0.*$/s, '').trim();
    const size = rawSize ? Number.parseInt(rawSize, 8) : 0;
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Invalid tar entry size for ${entryName}`);
    }

    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/s, '');
    const fullPath = prefix ? `${prefix}/${entryName}` : entryName;

    offset += BLOCK;
    if ((typeFlag === '0' || typeFlag === '\0') && path.posix.basename(fullPath) === targetFileName) {
      if (offset + size > tar.length) {
        throw new Error(`Truncated tar entry for ${fullPath}`);
      }
      return tar.subarray(offset, offset + size);
    }
    offset += Math.ceil(size / BLOCK) * BLOCK;
  }

  throw new Error(`Archive does not contain ${targetFileName}`);
}

function buildDownloadCandidates(config?: DshPluginConfig): {
  assetName: string;
  urls: string[];
} {
  const explicitUrl = config?.downloadUrl ?? process.env.AGENT_CLEANER_BINARY_URL;
  if (explicitUrl) {
    const inferredAsset = explicitUrl.endsWith('.zip') ? 'agent-cleaner.zip' : 'agent-cleaner.tar.gz';
    return { assetName: inferredAsset, urls: [explicitUrl] };
  }

  const assetName = resolveReleaseAssetName();
  const canonicalUrl = `${REPO_RELEASE_BASE}/${assetName}`;
  const proxy = process.env.DSHM_GITHUB_PROXY?.trim().replace(/\/+$/, '');
  const urls = proxy ? [`${proxy}/${canonicalUrl}`, canonicalUrl] : [canonicalUrl];
  return { assetName, urls };
}

async function downloadAndInstallBinary(
  destPath: string,
  config?: DshPluginConfig,
): Promise<string> {
  const { assetName, urls } = buildDownloadCandidates(config);
  const destDir = path.dirname(destPath);
  mkdirSync(destDir, { recursive: true });

  const errors: string[] = [];
  let archiveBuffer: Buffer | null = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
      }
      archiveBuffer = Buffer.from(await res.arrayBuffer());
      break;
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!archiveBuffer) {
    throw new Error(
      `Failed to download agent-cleaner binary automatically (${errors.join('; ')}). ` +
        `Set plugin config "binaryPath" or install agent-cleaner into PATH.`,
    );
  }

  const tmpPath = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    if (assetName.endsWith('.zip')) {
      const tmpZip = `${destPath}.download-${process.pid}-${Date.now()}.zip`;
      const extractDir = `${destPath}.extract-${process.pid}-${Date.now()}`;
      writeFileSync(tmpZip, archiveBuffer);
      try {
        mkdirSync(extractDir, { recursive: true });
        await execFileAsync('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -Path '${tmpZip.replaceAll("'", "''")}' -DestinationPath '${extractDir.replaceAll("'", "''")}' -Force`,
        ]);
        const extractedExe = path.join(extractDir, binaryFilename('win32'));
        if (!isExistingFile(extractedExe)) {
          throw new Error(`Archive does not contain ${binaryFilename('win32')}`);
        }
        renameSync(extractedExe, tmpPath);
      } finally {
        rmSync(tmpZip, { force: true });
        rmSync(extractDir, { recursive: true, force: true });
      }
    } else {
      const binaryBuf = extractBinaryFromTarGz(archiveBuffer, binaryFilename());
      writeFileSync(tmpPath, binaryBuf);
      if (process.platform !== 'win32') {
        chmodSync(tmpPath, 0o755);
      }
    }

    renameSync(tmpPath, destPath);
    return destPath;
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

export async function ensureBinaryPath(config?: DshPluginConfig): Promise<string> {
  const existing = findExistingBinaryPath(config?.binaryPath);
  if (existing) return existing;

  const destPath = managedBinaryPath();
  const pending = inFlightDownloads.get(destPath);
  if (pending) return pending;

  const job = downloadAndInstallBinary(destPath, config).finally(() => {
    inFlightDownloads.delete(destPath);
  });
  inFlightDownloads.set(destPath, job);
  return job;
}

function resolveService(ctx: any, serviceName: string): any {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(serviceName) : ctx?.[serviceName];
  } catch {
    return undefined;
  }
}

async function runCliJson<T = unknown>(
  config: DshPluginConfig | undefined,
  args: string[],
): Promise<T> {
  const binaryPath = await ensureBinaryPath(config);
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

function registerHttpRoutes(
  ctx: any,
  config: DshPluginConfig | undefined,
  defaultHours: number,
): void {
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
          await ensureBinaryPath(config);
          const [agents, doctors, mcpAudit, trash] = await Promise.all([
            runCliJson(config, ['scan', '--older-than', `${safeHours}h`, '--lang', lang]),
            runCliJson(config, ['doctor']),
            runCliJson(config, ['mcp']),
            runCliJson(config, ['restore']),
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
          return runCliJson(config, args);
        }),
        route('/agent-cleaner/api/doctor-fix', 'POST', () =>
          runCliJson(config, ['doctor', '--fix']),
        ),
        route('/agent-cleaner/api/mcp-kill', 'POST', () =>
          runCliJson(config, ['mcp', '--kill']),
        ),
        route('/agent-cleaner/api/restore', 'POST', (body) => {
          if (typeof body.batchId !== 'string' || !body.batchId) {
            throw new Error('batchId is required');
          }
          return runCliJson(config, ['restore', body.batchId]);
        }),
        route('/agent-cleaner/api/purge', 'POST', (body) => {
          if (body.all) return runCliJson(config, ['restore', '--purge-all']);
          if (typeof body.batchId === 'string' && body.batchId) {
            return runCliJson(config, ['restore', '--purge', body.batchId]);
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
  const defaultHours = config?.exemptRecentHours ?? 24;

  registerHttpRoutes(ctx, config, defaultHours);

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
      return runCliJson(config, cliArgs);
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
      return runCliJson(config, cliArgs);
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
      return runCliJson(config, cliArgs);
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
      return runCliJson(config, cliArgs);
    },
  });
}

export default { name, inject, apply };
