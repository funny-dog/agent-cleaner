/**
 * DeepSeek Harness (DSH) Cordis plugin for agent-cleaner.
 * Exposes headless Cordis Tools and HTTP bridge routes backed by the `agent-cleaner` binary.
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
const execFileAsync = promisify(execFile);
const REPO_DOWNLOAD_BASE = 'https://github.com/funny-dog/agent-cleaner/releases/download';
const REPO_RELEASE_BASE = 'https://github.com/funny-dog/agent-cleaner/releases/latest/download';
const DOWNLOAD_TIMEOUT_MS = 120_000;
function readPluginVersion() {
    try {
        const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.version === 'string' && parsed.version.trim()) {
            return parsed.version.trim();
        }
    }
    catch {
        // ignore and fallback
    }
    return '0.2.4';
}
export const PLUGIN_VERSION = readPluginVersion();
export const name = 'agent-cleaner';
export const inject = ['tools'];
const inFlightDownloads = new Map();
function binaryFilename(platform = process.platform) {
    return platform === 'win32' ? 'agent-cleaner.exe' : 'agent-cleaner';
}
export function resolveReleaseAssetName(platform = process.platform, arch = process.arch) {
    if (platform === 'darwin' && arch === 'arm64')
        return 'agent-cleaner-darwin-arm64.tar.gz';
    if (platform === 'darwin' && arch === 'x64')
        return 'agent-cleaner-darwin-x64.tar.gz';
    if (platform === 'linux' && arch === 'x64')
        return 'agent-cleaner-linux-x64.tar.gz';
    if (platform === 'linux' && arch === 'arm64')
        return 'agent-cleaner-linux-arm64.tar.gz';
    if (platform === 'win32' && arch === 'x64')
        return 'agent-cleaner-win32-x64.zip';
    throw new Error(`Unsupported platform for auto-downloading agent-cleaner: ${platform}/${arch}. Install manually or configure binaryPath.`);
}
const WRAPPER_EXTENSIONS = ['.js', '.mjs', '.cjs', '.cmd', '.ps1', '.bat'];
const SELF_CLI_PATHS = (() => {
    const paths = new Set();
    try {
        const localPath = fileURLToPath(new URL('./cli.js', import.meta.url));
        paths.add(localPath);
        if (existsSync(localPath)) {
            paths.add(realpathSync(localPath));
        }
    }
    catch {
        // ignore in non-file URL environments
    }
    return paths;
})();
function isExistingFile(filePath) {
    try {
        return existsSync(filePath) && statSync(filePath).isFile();
    }
    catch {
        return false;
    }
}
export function isNativeBinaryCandidate(filePath) {
    if (!isExistingFile(filePath))
        return false;
    let resolved = filePath;
    try {
        resolved = realpathSync(filePath);
    }
    catch {
        // keep original path if realpath fails
    }
    if (SELF_CLI_PATHS.has(resolved) || SELF_CLI_PATHS.has(filePath)) {
        return false;
    }
    const lower = resolved.toLowerCase();
    if (WRAPPER_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
        return false;
    }
    try {
        const st = statSync(resolved);
        if (st.size < 32 * 1024) {
            const snippet = readFileSync(resolved, 'utf8');
            if (snippet.includes('dsh-agent-cleaner') ||
                snippet.includes('dist/cli.js') ||
                snippet.includes('dist\\cli.js')) {
                return false;
            }
        }
    }
    catch {
        return false;
    }
    return true;
}
function findInPath(binName) {
    const pathEnv = process.env.PATH ?? '';
    for (const dir of pathEnv.split(path.delimiter)) {
        if (!dir)
            continue;
        const candidate = path.join(dir, binName);
        if (isNativeBinaryCandidate(candidate))
            return candidate;
    }
    return null;
}
function managedBinaryPath(platform = process.platform) {
    return path.join(os.homedir(), '.agent-cleaner', 'bin', binaryFilename(platform));
}
function managedBinaryVersionPath(platform = process.platform) {
    return `${managedBinaryPath(platform)}.version`;
}
function readManagedBinaryVersion(platform = process.platform) {
    try {
        return readFileSync(managedBinaryVersionPath(platform), 'utf8').trim() || null;
    }
    catch {
        return null;
    }
}
export function findExistingBinaryPath(configured) {
    if (configured)
        return configured;
    const binName = binaryFilename();
    const home = os.homedir();
    const managed = managedBinaryPath();
    if (isNativeBinaryCandidate(managed)) {
        if (readManagedBinaryVersion() === PLUGIN_VERSION) {
            return managed;
        }
        return null;
    }
    const candidates = [
        path.join(home, '.local', 'bin', binName),
        path.join(home, '.cargo', 'bin', binName),
    ];
    for (const candidate of candidates) {
        if (isNativeBinaryCandidate(candidate))
            return candidate;
    }
    return findInPath(binName);
}
export function extractBinaryFromTarGz(gzBuffer, targetFileName) {
    const tar = gunzipSync(gzBuffer);
    const BLOCK = 512;
    let offset = 0;
    while (offset + BLOCK <= tar.length) {
        const header = tar.subarray(offset, offset + BLOCK);
        const entryName = header.toString('utf8', 0, 100).replace(/\0.*$/s, '');
        if (!entryName)
            break;
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
function buildDownloadCandidates(config) {
    const explicitUrl = config?.downloadUrl ?? process.env.AGENT_CLEANER_BINARY_URL;
    if (explicitUrl) {
        const inferredAsset = explicitUrl.endsWith('.zip') ? 'agent-cleaner.zip' : 'agent-cleaner.tar.gz';
        return { assetName: inferredAsset, urls: [explicitUrl] };
    }
    const assetName = resolveReleaseAssetName();
    const versionedUrl = `${REPO_DOWNLOAD_BASE}/v${PLUGIN_VERSION}/${assetName}`;
    const latestUrl = `${REPO_RELEASE_BASE}/${assetName}`;
    const proxy = process.env.DSHM_GITHUB_PROXY?.trim().replace(/\/+$/, '');
    const urls = proxy
        ? [`${proxy}/${versionedUrl}`, versionedUrl, `${proxy}/${latestUrl}`, latestUrl]
        : [versionedUrl, latestUrl];
    return { assetName, urls };
}
async function downloadAndInstallBinary(destPath, config) {
    const { assetName, urls } = buildDownloadCandidates(config);
    const destDir = path.dirname(destPath);
    mkdirSync(destDir, { recursive: true });
    const errors = [];
    let archiveBuffer = null;
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
        }
        catch (err) {
            errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    if (!archiveBuffer) {
        throw new Error(`Failed to download agent-cleaner binary automatically (${errors.join('; ')}). ` +
            `Set plugin config "binaryPath" or install agent-cleaner into PATH.`);
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
            }
            finally {
                rmSync(tmpZip, { force: true });
                rmSync(extractDir, { recursive: true, force: true });
            }
        }
        else {
            const binaryBuf = extractBinaryFromTarGz(archiveBuffer, binaryFilename());
            writeFileSync(tmpPath, binaryBuf);
            if (process.platform !== 'win32') {
                chmodSync(tmpPath, 0o755);
            }
        }
        renameSync(tmpPath, destPath);
        if (destPath === managedBinaryPath()) {
            writeFileSync(managedBinaryVersionPath(), `${PLUGIN_VERSION}\n`, 'utf8');
        }
        return destPath;
    }
    catch (err) {
        rmSync(tmpPath, { force: true });
        throw err;
    }
}
export async function ensureBinaryPath(config) {
    const existing = findExistingBinaryPath(config?.binaryPath);
    if (existing)
        return existing;
    const destPath = managedBinaryPath();
    const pending = inFlightDownloads.get(destPath);
    if (pending)
        return pending;
    const job = downloadAndInstallBinary(destPath, config).finally(() => {
        inFlightDownloads.delete(destPath);
    });
    inFlightDownloads.set(destPath, job);
    return job;
}
function resolveService(ctx, serviceName) {
    try {
        return typeof ctx?.get === 'function' ? ctx.get(serviceName) : ctx?.[serviceName];
    }
    catch {
        return undefined;
    }
}
async function runCliJson(config, args) {
    const binaryPath = await ensureBinaryPath(config);
    const { stdout } = await execFileAsync(binaryPath, [...args, '--json'], {
        maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout);
}
function sendJson(res, status, payload) {
    res.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(payload));
}
async function readJsonBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > 1024 * 1024)
            throw new Error('Request body too large');
        chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw)
        return {};
    return JSON.parse(raw);
}
function buildTextOutputSpec() {
    return {
        schema: { type: 'object' },
        render: (_args, value) => [
            {
                type: 'text',
                text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
            },
        ],
    };
}
function registerHttpRoutes(ctx, config, defaultHours) {
    if (typeof ctx?.inject !== 'function')
        return;
    ctx.inject(['webServer', 'connection'], (sctx) => {
        const webServer = resolveService(sctx, 'webServer');
        const connection = resolveService(sctx, 'connection');
        if (!webServer ||
            typeof webServer.register !== 'function' ||
            !connection ||
            typeof connection.requestRejection !== 'function') {
            return;
        }
        let overviewCache = null;
        let overviewEpoch = 0;
        const inFlightOverview = new Map();
        const invalidateOverviewCache = () => {
            overviewEpoch += 1;
            overviewCache = null;
        };
        const mount = () => {
            const route = (routePath, method, fn) => webServer.register({
                kind: 'exact',
                path: routePath,
                handler: async (req, res) => {
                    let refused;
                    try {
                        refused = connection.requestRejection(req);
                    }
                    catch {
                        refused = 403;
                    }
                    if (refused !== undefined) {
                        if (typeof req.resume === 'function')
                            req.resume();
                        sendJson(res, refused, {
                            ok: false,
                            error: refused === 401 ? 'Unauthorized' : 'Forbidden',
                        });
                        return;
                    }
                    if (req.method !== method) {
                        res.writeHead(405, { allow: method });
                        res.end();
                        return;
                    }
                    if (method === 'POST') {
                        const mediaType = String(req.headers['content-type'] ?? '')
                            .split(';')[0]
                            ?.trim()
                            .toLowerCase();
                        if (mediaType !== 'application/json') {
                            if (typeof req.resume === 'function')
                                req.resume();
                            sendJson(res, 415, {
                                ok: false,
                                error: 'Content-Type must be application/json',
                            });
                            return;
                        }
                    }
                    try {
                        const body = method === 'POST' ? await readJsonBody(req) : {};
                        const data = await fn(body, req);
                        sendJson(res, 200, { ok: true, data });
                    }
                    catch (err) {
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
                    const force = url.searchParams.get('force') === '1';
                    const key = `${safeHours}:${lang}`;
                    if (!force && overviewCache?.key === key) {
                        return overviewCache.data;
                    }
                    if (!force) {
                        const pending = inFlightOverview.get(key);
                        if (pending)
                            return pending;
                    }
                    const epoch = overviewEpoch;
                    const job = (async () => {
                        await ensureBinaryPath(config);
                        const [agents, doctors, mcpAudit, trash] = await Promise.all([
                            runCliJson(config, ['scan', '--older-than', `${safeHours}h`, '--lang', lang]),
                            runCliJson(config, ['doctor']),
                            runCliJson(config, ['mcp']),
                            runCliJson(config, ['restore']),
                        ]);
                        const payload = {
                            agents,
                            doctors,
                            mcpAudit,
                            trash,
                            exemptHours: safeHours,
                            lang,
                            scannedAt: Date.now(),
                        };
                        if (overviewEpoch === epoch) {
                            overviewCache = { key, data: payload };
                        }
                        return payload;
                    })().finally(() => {
                        if (inFlightOverview.get(key) === job) {
                            inFlightOverview.delete(key);
                        }
                    });
                    inFlightOverview.set(key, job);
                    return job;
                }),
                route('/agent-cleaner/api/trash', 'GET', () => runCliJson(config, ['restore'])),
                route('/agent-cleaner/api/clean', 'POST', async (body) => {
                    const hours = typeof body.exemptHours === 'number' && body.exemptHours >= 0
                        ? Math.floor(body.exemptHours)
                        : defaultHours;
                    const lang = body.lang === 'en' ? 'en' : 'zh';
                    const args = ['clean', '--yes', '--older-than', `${hours}h`, '--lang', lang];
                    if (body.onlyRecommended)
                        args.push('--only-recommended');
                    if (body.dryRun)
                        args.push('--dry-run');
                    if (body.permanent)
                        args.push('--permanent');
                    if (Array.isArray(body.selectedIds) && body.selectedIds.length > 0) {
                        args.push('--ids', body.selectedIds.map(String).join(','));
                    }
                    const result = await runCliJson(config, args);
                    if (!body.dryRun)
                        invalidateOverviewCache();
                    return result;
                }),
                route('/agent-cleaner/api/doctor-fix', 'POST', async () => {
                    const result = await runCliJson(config, ['doctor', '--fix']);
                    invalidateOverviewCache();
                    return result;
                }),
                route('/agent-cleaner/api/mcp-kill', 'POST', async (body) => {
                    const result = typeof body.pid === 'number' && Number.isInteger(body.pid) && body.pid > 0
                        ? await runCliJson(config, ['mcp', '--kill', '--pid', String(body.pid)])
                        : await runCliJson(config, ['mcp', '--kill']);
                    invalidateOverviewCache();
                    return result;
                }),
                route('/agent-cleaner/api/restore', 'POST', async (body) => {
                    if (typeof body.batchId !== 'string' || !body.batchId) {
                        throw new Error('batchId is required');
                    }
                    const result = await runCliJson(config, ['restore', body.batchId]);
                    invalidateOverviewCache();
                    return result;
                }),
                route('/agent-cleaner/api/purge', 'POST', async (body) => {
                    const result = body.all
                        ? await runCliJson(config, ['restore', '--purge-all'])
                        : typeof body.batchId === 'string' && body.batchId
                            ? await runCliJson(config, ['restore', '--purge', body.batchId])
                            : (() => {
                                throw new Error('batchId or all=true is required');
                            })();
                    invalidateOverviewCache();
                    return result;
                }),
            ];
        };
        if (typeof sctx.effect === 'function') {
            sctx.effect(() => {
                const disposers = mount();
                return () => {
                    for (const d of disposers)
                        if (typeof d === 'function')
                            d();
                };
            }, 'agent-cleaner: http routes');
        }
        else {
            mount();
        }
    });
}
export function apply(ctx, config) {
    const defaultHours = config?.exemptRecentHours ?? 24;
    registerHttpRoutes(ctx, config, defaultHours);
    const tools = resolveService(ctx, 'tools');
    if (!tools || typeof tools.register !== 'function')
        return;
    tools.register({
        name: 'agent_cleaner_scan',
        description: 'Scan disk usage, bloated cache/snapshots, orphan sessions, and MCP health across AI coding agents.',
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
        execute: (args = {}) => {
            const cliArgs = ['scan', '--older-than', `${args.olderThanHours ?? defaultHours}h`];
            if (args.agent)
                cliArgs.push('--agent', args.agent);
            return runCliJson(config, cliArgs);
        },
    });
    tools.register({
        name: 'agent_cleaner_clean',
        description: 'Move reclaimable agent files and caches into the reversible trash (~/.agent-cleaner/trash/).',
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
        execute: (args = {}) => {
            const cliArgs = ['clean', '--yes', '--older-than', `${args.olderThanHours ?? defaultHours}h`];
            if (args.onlyRecommended)
                cliArgs.push('--only-recommended');
            if (args.dryRun)
                cliArgs.push('--dry-run');
            if (args.selectedIds?.length)
                cliArgs.push('--ids', args.selectedIds.join(','));
            return runCliJson(config, cliArgs);
        },
    });
    tools.register({
        name: 'agent_cleaner_doctor',
        description: 'Diagnose syntax and dead MCP links across AI agent configs, optionally auto-fixing while preserving comments.',
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
        execute: (args = {}) => {
            const cliArgs = ['doctor'];
            if (args.fix)
                cliArgs.push('--fix');
            return runCliJson(config, cliArgs);
        },
    });
    tools.register({
        name: 'agent_cleaner_mcp',
        description: 'Audit cross-agent MCP configurations, cold npx/uv caches, and optionally terminate PPID=1 orphan processes.',
        parameters: {
            type: 'object',
            properties: {
                kill: {
                    type: 'boolean',
                    description: 'Terminate detected PPID=1 orphan stdio MCP processes',
                },
                pid: {
                    type: 'number',
                    description: 'Optional specific orphan process PID to terminate',
                },
            },
        },
        output: buildTextOutputSpec(),
        execute: (args = {}) => {
            const cliArgs = ['mcp'];
            if (args.kill)
                cliArgs.push('--kill');
            if (typeof args.pid === 'number' && Number.isInteger(args.pid) && args.pid > 0) {
                cliArgs.push('--pid', String(args.pid));
            }
            return runCliJson(config, cliArgs);
        },
    });
    tools.register({
        name: 'agent_cleaner_restore',
        description: 'List reversible trash batches (~/.agent-cleaner/trash/), restore a specific batch back to original paths, or permanently purge trash.',
        parameters: {
            type: 'object',
            properties: {
                batchId: {
                    type: 'string',
                    description: 'Trash batch UUID to restore; omit to list available trash batches',
                },
                purgeBatchId: {
                    type: 'string',
                    description: 'Optional trash batch UUID to permanently delete',
                },
                purgeAll: {
                    type: 'boolean',
                    description: 'Set true to permanently purge ALL trash batches',
                },
            },
        },
        output: buildTextOutputSpec(),
        execute: (args = {}) => {
            if (args.purgeAll)
                return runCliJson(config, ['restore', '--purge-all']);
            if (args.purgeBatchId)
                return runCliJson(config, ['restore', '--purge', args.purgeBatchId]);
            if (args.batchId)
                return runCliJson(config, ['restore', args.batchId]);
            return runCliJson(config, ['restore']);
        },
    });
}
export default { name, inject, apply };
