/**
 * DeepSeek Harness (DSH) Cordis plugin for agent-cleaner.
 * Exposes headless Cordis Tools and HTTP bridge routes backed by the `agent-cleaner` binary.
 */
import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, statfsSync, writeFileSync, } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync, inflateRawSync } from 'node:zlib';
const execFileAsync = promisify(execFile);
function getDiskSpace() {
    try {
        const st = statfsSync(os.homedir());
        return { totalBytes: st.blocks * st.bsize, availableBytes: st.bavail * st.bsize };
    }
    catch {
        return null;
    }
}
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
    return '0.2.5';
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
    if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) {
        return 'agent-cleaner-win32-x64.zip';
    }
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
    for (const rawDir of pathEnv.split(path.delimiter)) {
        const dir = rawDir.trim().replace(/^"|"$/g, '');
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
class UnsupportedZipMethodError extends Error {
    constructor(method) {
        super(`Unsupported ZIP compression method: ${method}`);
    }
}
export function extractBinaryFromZip(zipBuffer, targetFileName) {
    const EOCD_SIG = 0x06054b50;
    const CD_SIG = 0x02014b50;
    const LFH_SIG = 0x04034b50;
    let eocdOffset = -1;
    const minOffset = Math.max(0, zipBuffer.length - 65557);
    for (let i = zipBuffer.length - 22; i >= minOffset; i -= 1) {
        if (zipBuffer.readUInt32LE(i) === EOCD_SIG) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset === -1) {
        throw new Error('Invalid ZIP archive: EOCD record not found');
    }
    const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
    const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
    let pos = cdOffset;
    for (let idx = 0; idx < totalEntries; idx += 1) {
        if (pos + 46 > zipBuffer.length || zipBuffer.readUInt32LE(pos) !== CD_SIG) {
            throw new Error('Invalid ZIP central directory header');
        }
        const method = zipBuffer.readUInt16LE(pos + 10);
        const compressedSize = zipBuffer.readUInt32LE(pos + 20);
        const nameLen = zipBuffer.readUInt16LE(pos + 28);
        const extraLen = zipBuffer.readUInt16LE(pos + 30);
        const commentLen = zipBuffer.readUInt16LE(pos + 32);
        const localHeaderOffset = zipBuffer.readUInt32LE(pos + 42);
        const entryName = zipBuffer.toString('utf8', pos + 46, pos + 46 + nameLen);
        pos += 46 + nameLen + extraLen + commentLen;
        if (path.posix.basename(entryName.replace(/\\/g, '/')) !== targetFileName) {
            continue;
        }
        if (localHeaderOffset + 30 > zipBuffer.length ||
            zipBuffer.readUInt32LE(localHeaderOffset) !== LFH_SIG) {
            throw new Error(`Invalid ZIP local header for ${entryName}`);
        }
        const lhNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
        const lhExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
        if (dataStart + compressedSize > zipBuffer.length) {
            throw new Error(`Truncated ZIP entry for ${entryName}`);
        }
        const compressed = zipBuffer.subarray(dataStart, dataStart + compressedSize);
        if (method === 0)
            return Buffer.from(compressed);
        if (method === 8)
            return inflateRawSync(compressed);
        throw new UnsupportedZipMethodError(method);
    }
    throw new Error(`Archive does not contain ${targetFileName}`);
}
function replaceFileSync(tmpPath, destPath) {
    try {
        renameSync(tmpPath, destPath);
    }
    catch (err) {
        if (process.platform === 'win32' &&
            existsSync(destPath) &&
            (err?.code === 'EPERM' || err?.code === 'EEXIST' || err?.code === 'EBUSY')) {
            const oldPath = `${destPath}.old-${process.pid}-${Date.now()}`;
            renameSync(destPath, oldPath);
            renameSync(tmpPath, destPath);
            try {
                rmSync(oldPath, { force: true });
            }
            catch {
                // ignore if old binary is still locked
            }
            return;
        }
        throw err;
    }
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
            try {
                const binaryBuf = extractBinaryFromZip(archiveBuffer, binaryFilename('win32'));
                writeFileSync(tmpPath, binaryBuf);
            }
            catch (zipErr) {
                if (!(zipErr instanceof UnsupportedZipMethodError)) {
                    throw zipErr;
                }
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
                    ], { windowsHide: true });
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
        }
        else {
            const binaryBuf = extractBinaryFromTarGz(archiveBuffer, binaryFilename());
            writeFileSync(tmpPath, binaryBuf);
            if (process.platform !== 'win32') {
                chmodSync(tmpPath, 0o755);
            }
        }
        replaceFileSync(tmpPath, destPath);
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
export function resolveSpawnSpec(binaryPath, args, platform = process.platform) {
    if (platform === 'win32' && /\.(?:m?js|cjs)$/i.test(binaryPath)) {
        return { command: process.execPath, args: [binaryPath, ...args] };
    }
    return { command: binaryPath, args };
}
async function runCliJson(config, args) {
    const binaryPath = await ensureBinaryPath(config);
    const spec = resolveSpawnSpec(binaryPath, [...args, '--json']);
    const { stdout } = await execFileAsync(spec.command, spec.args, {
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
    });
    return JSON.parse(stdout);
}
async function runCliJsonWithProgress(config, args, onProgress) {
    const binaryPath = await ensureBinaryPath(config);
    const spec = resolveSpawnSpec(binaryPath, [...args, '--json']);
    return new Promise((resolve, reject) => {
        const child = spawn(spec.command, spec.args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const stdoutChunks = [];
        let stdoutBytes = 0;
        let stderrTail = '';
        const stderrLines = [];
        let settled = false;
        const MAX_STDOUT = 16 * 1024 * 1024;
        const fail = (err) => {
            if (settled)
                return;
            settled = true;
            reject(err);
        };
        child.stdout.on('data', (chunk) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            stdoutBytes += buf.length;
            if (stdoutBytes > MAX_STDOUT) {
                child.kill();
                fail(new Error('CLI stdout exceeded maxBuffer'));
                return;
            }
            stdoutChunks.push(buf);
        });
        const handleStderrLine = (rawLine) => {
            const line = rawLine.trim();
            if (!line)
                return;
            stderrLines.push(line);
            if (stderrLines.length > 50)
                stderrLines.shift();
            if (!onProgress)
                return;
            try {
                const parsed = JSON.parse(line);
                if (parsed &&
                    typeof parsed === 'object' &&
                    typeof parsed.completed === 'number' &&
                    typeof parsed.total === 'number' &&
                    typeof parsed.agent === 'string') {
                    onProgress({
                        completed: parsed.completed,
                        total: parsed.total,
                        agent: parsed.agent,
                        currentBytes: typeof parsed.currentBytes === 'number' ? parsed.currentBytes : 0,
                    });
                }
            }
            catch {
                // ignore non-JSON stderr diagnostic lines
            }
        };
        child.stderr.on('data', (chunk) => {
            stderrTail += (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).toString('utf8');
            let nl = stderrTail.indexOf('\n');
            while (nl !== -1) {
                handleStderrLine(stderrTail.slice(0, nl));
                stderrTail = stderrTail.slice(nl + 1);
                nl = stderrTail.indexOf('\n');
            }
        });
        child.on('error', (err) => fail(err));
        child.on('close', (code) => {
            if (stderrTail.trim()) {
                handleStderrLine(stderrTail);
                stderrTail = '';
            }
            if (settled)
                return;
            settled = true;
            if (code !== 0) {
                const tailMsg = stderrLines.slice(-5).join(' | ');
                reject(new Error(`agent-cleaner exited with code ${code}${tailMsg ? `: ${tailMsg}` : ''}`));
                return;
            }
            try {
                const out = Buffer.concat(stdoutChunks).toString('utf8');
                resolve(JSON.parse(out));
            }
            catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    });
}
function sendJson(res, status, payload) {
    res.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(payload));
}
function buildConfigCliArgs(body) {
    const action = typeof body.action === 'string' ? body.action.trim() : '';
    if (action === 'get') {
        return ['config', 'show'];
    }
    if (action === 'ignore_path' ||
        action === 'unignore_path' ||
        action === 'ignore_agent' ||
        action === 'unignore_agent') {
        const pattern = typeof body.pattern === 'string' ? body.pattern.trim() : '';
        if (!pattern) {
            throw new Error('pattern is required');
        }
        const sub = action.endsWith('_agent') ? 'ignore-agent' : 'ignore';
        const op = action.startsWith('unignore_') ? 'remove' : 'add';
        return ['config', sub, op, pattern];
    }
    if (action && action !== 'set') {
        throw new Error(`Unsupported config action: ${action}`);
    }
    const cliArgs = ['config', 'set'];
    const exemptHours = body.exemptHours ?? body.exempt_hours;
    if (typeof exemptHours === 'number' && Number.isFinite(exemptHours) && exemptHours >= 0) {
        cliArgs.push('--exempt-hours', String(Math.floor(exemptHours)));
    }
    const coldDays = body.coldThresholdDays ?? body.cold_threshold_days ?? body.coldDays ?? body.cold_days;
    if (typeof coldDays === 'number' && Number.isFinite(coldDays) && coldDays >= 0) {
        cliArgs.push('--cold-days', String(Math.floor(coldDays)));
    }
    if (body.lang === 'zh' || body.lang === 'en') {
        cliArgs.push('--lang', body.lang);
    }
    const trashMaxAgeDays = body.trashMaxAgeDays ?? body.trash_max_age_days;
    if (typeof trashMaxAgeDays === 'number' &&
        Number.isFinite(trashMaxAgeDays) &&
        trashMaxAgeDays >= 0) {
        cliArgs.push('--trash-max-age-days', String(Math.floor(trashMaxAgeDays)));
    }
    const trashMaxSizeMb = body.trashMaxSizeMb ?? body.trash_max_size_mb;
    if (typeof trashMaxSizeMb === 'number' &&
        Number.isFinite(trashMaxSizeMb) &&
        trashMaxSizeMb >= 0) {
        cliArgs.push('--trash-max-size-mb', String(Math.floor(trashMaxSizeMb)));
    }
    const autoPruneTrash = body.autoPruneTrash ?? body.auto_prune_trash;
    if (typeof autoPruneTrash === 'boolean') {
        cliArgs.push('--auto-prune-trash', String(autoPruneTrash));
    }
    const backupMaxCount = body.backupMaxCount ?? body.backup_max_count;
    if (typeof backupMaxCount === 'number' &&
        Number.isFinite(backupMaxCount) &&
        backupMaxCount >= 0) {
        cliArgs.push('--backup-max-count', String(Math.floor(backupMaxCount)));
    }
    return cliArgs;
}
function buildDoctorCliArgs(body) {
    const ids = Array.isArray(body.issueIds)
        ? body.issueIds.map(String).filter((s) => s.trim().length > 0)
        : [];
    const shouldFix = Boolean(body.fix) || ids.length > 0;
    const cliArgs = ['doctor'];
    if (shouldFix) {
        cliArgs.push('--fix');
        if (ids.length > 0) {
            cliArgs.push('--ids', ids.join(','));
        }
    }
    return cliArgs;
}
function buildBackupsCliArgs(args) {
    const action = typeof args.action === 'string' && args.action ? args.action.trim() : 'list';
    if (action === 'list')
        return ['backups', 'list'];
    if (action === 'restore') {
        if (typeof args.backupId !== 'string' || !args.backupId.trim()) {
            throw new Error('backupId is required');
        }
        return ['backups', 'restore', args.backupId.trim()];
    }
    if (action === 'delete') {
        if (typeof args.backupId !== 'string' || !args.backupId.trim()) {
            throw new Error('backupId is required');
        }
        return ['backups', 'delete', args.backupId.trim()];
    }
    if (action === 'prune') {
        const cliArgs = ['backups', 'prune'];
        const keep = args.keepCount ?? args.keep;
        if (typeof keep === 'number' && Number.isFinite(keep) && keep >= 0) {
            cliArgs.push('--keep', String(Math.floor(keep)));
        }
        return cliArgs;
    }
    throw new Error(`Unsupported backups action: ${action}`);
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
        let scanProgress = {
            active: false,
            completed: 0,
            total: 0,
            agent: '',
            currentBytes: 0,
            updatedAt: 0,
        };
        const progressClients = new Set();
        const emitProgress = (next) => {
            scanProgress = next;
            const chunk = `data: ${JSON.stringify(next)}\n\n`;
            for (const client of progressClients) {
                try {
                    client.write(chunk);
                }
                catch {
                    progressClients.delete(client);
                }
            }
        };
        const invalidateOverviewCache = () => {
            overviewEpoch += 1;
            overviewCache = null;
        };
        const checkConnectionRejection = (req, res) => {
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
                return true;
            }
            return false;
        };
        const mount = () => {
            const route = (routePath, methods, fn) => {
                const allowed = Array.isArray(methods) ? methods : [methods];
                return webServer.register({
                    kind: 'exact',
                    path: routePath,
                    handler: async (req, res) => {
                        if (checkConnectionRejection(req, res))
                            return;
                        const reqMethod = (req.method ?? 'GET').toUpperCase();
                        if (!allowed.includes(reqMethod)) {
                            res.writeHead(405, { allow: allowed.join(', ') });
                            res.end();
                            return;
                        }
                        if (reqMethod === 'POST') {
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
                            const body = reqMethod === 'POST' ? await readJsonBody(req) : {};
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
            };
            const progressDisposer = webServer.register({
                kind: 'exact',
                path: '/agent-cleaner/api/progress',
                handler: async (req, res) => {
                    if (checkConnectionRejection(req, res))
                        return;
                    if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
                        res.writeHead(405, { allow: 'GET' });
                        res.end();
                        return;
                    }
                    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
                    const wantsSse = String(req.headers.accept ?? '').includes('text/event-stream') ||
                        url.searchParams.get('stream') === '1';
                    if (!wantsSse) {
                        sendJson(res, 200, { ok: true, data: scanProgress });
                        return;
                    }
                    res.writeHead(200, {
                        'content-type': 'text/event-stream; charset=utf-8',
                        'cache-control': 'no-store',
                        connection: 'keep-alive',
                        'x-content-type-options': 'nosniff',
                    });
                    res.write(`data: ${JSON.stringify(scanProgress)}\n\n`);
                    progressClients.add(res);
                    const cleanup = () => {
                        progressClients.delete(res);
                    };
                    req.on('close', cleanup);
                    res.on('close', cleanup);
                },
            });
            const closeSseClients = () => {
                for (const client of progressClients) {
                    try {
                        client.end();
                    }
                    catch {
                        // ignore
                    }
                }
                progressClients.clear();
            };
            return [
                progressDisposer,
                closeSseClients,
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
                        emitProgress({
                            active: true,
                            completed: 0,
                            total: 0,
                            agent: '',
                            currentBytes: 0,
                            updatedAt: Date.now(),
                        });
                        try {
                            const [agents, doctors, mcpAudit, trash] = await Promise.all([
                                runCliJsonWithProgress(config, ['scan', '--older-than', `${safeHours}h`, '--lang', lang, '--progress-json'], (prog) => {
                                    emitProgress({
                                        active: true,
                                        completed: prog.completed,
                                        total: prog.total,
                                        agent: prog.agent,
                                        currentBytes: prog.currentBytes,
                                        updatedAt: Date.now(),
                                    });
                                }),
                                runCliJson(config, ['doctor']),
                                runCliJson(config, ['mcp']),
                                runCliJson(config, ['restore']),
                            ]);
                            const payload = {
                                agents,
                                doctors,
                                mcpAudit,
                                trash,
                                disk: getDiskSpace(),
                                exemptHours: safeHours,
                                lang,
                                scannedAt: Date.now(),
                            };
                            if (overviewEpoch === epoch) {
                                overviewCache = { key, data: payload };
                            }
                            return payload;
                        }
                        finally {
                            emitProgress({
                                ...scanProgress,
                                active: false,
                                updatedAt: Date.now(),
                            });
                        }
                    })().finally(() => {
                        if (inFlightOverview.get(key) === job) {
                            inFlightOverview.delete(key);
                        }
                    });
                    inFlightOverview.set(key, job);
                    return job;
                }),
                route('/agent-cleaner/api/config', ['GET', 'POST'], async (body, req) => {
                    if ((req.method ?? 'GET').toUpperCase() === 'GET') {
                        return runCliJson(config, ['config', 'show']);
                    }
                    const cliArgs = buildConfigCliArgs(body);
                    const result = await runCliJson(config, cliArgs);
                    invalidateOverviewCache();
                    return result;
                }),
                route('/agent-cleaner/api/backups', 'GET', () => runCliJson(config, ['backups', 'list'])),
                route('/agent-cleaner/api/backup-restore', 'POST', async (body) => {
                    const cliArgs = buildBackupsCliArgs({ action: 'restore', backupId: body.backupId });
                    const result = await runCliJson(config, cliArgs);
                    invalidateOverviewCache();
                    return result;
                }),
                route('/agent-cleaner/api/backup-delete', 'POST', async (body) => {
                    const cliArgs = buildBackupsCliArgs({ action: 'delete', backupId: body.backupId });
                    const result = await runCliJson(config, cliArgs);
                    invalidateOverviewCache();
                    return result;
                }),
                route('/agent-cleaner/api/backup-prune', 'POST', async (body) => {
                    const cliArgs = buildBackupsCliArgs({
                        action: 'prune',
                        keepCount: body.keepCount,
                        keep: body.keep,
                    });
                    const result = await runCliJson(config, cliArgs);
                    invalidateOverviewCache();
                    return result;
                }),
                route('/agent-cleaner/api/trash', 'GET', () => runCliJson(config, ['restore'])),
                route('/agent-cleaner/api/trash-prune', 'POST', async () => {
                    const result = await runCliJson(config, ['restore', '--prune']);
                    invalidateOverviewCache();
                    return result;
                }),
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
                route('/agent-cleaner/api/doctor-fix', 'POST', async (body) => {
                    const cliArgs = buildDoctorCliArgs({ fix: true, issueIds: body.issueIds });
                    const result = await runCliJson(config, cliArgs);
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
        name: 'agent_cleaner_overview',
        description: 'Get an aggregated overview of disk usage, reclaimable artifacts, config doctor issues, MCP audit, and trash batches.',
        parameters: {
            type: 'object',
            properties: {
                olderThanHours: {
                    type: 'number',
                    description: `Exempt items modified within this many hours (default: ${defaultHours})`,
                },
                lang: {
                    type: 'string',
                    enum: ['zh', 'en'],
                    description: 'Optional output language (zh or en)',
                },
            },
        },
        output: buildTextOutputSpec(),
        execute: (args = {}) => {
            const cliArgs = ['overview', '--older-than', `${args.olderThanHours ?? defaultHours}h`];
            if (args.lang === 'zh' || args.lang === 'en')
                cliArgs.push('--lang', args.lang);
            return runCliJson(config, cliArgs);
        },
    });
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
                lang: {
                    type: 'string',
                    enum: ['zh', 'en'],
                    description: 'Optional output language (zh or en)',
                },
            },
        },
        output: buildTextOutputSpec(),
        execute: (args = {}) => {
            const cliArgs = ['scan', '--older-than', `${args.olderThanHours ?? defaultHours}h`];
            if (args.agent)
                cliArgs.push('--agent', args.agent);
            if (args.lang === 'zh' || args.lang === 'en')
                cliArgs.push('--lang', args.lang);
            return runCliJson(config, cliArgs);
        },
    });
    tools.register({
        name: 'agent_cleaner_clean',
        description: 'Move reclaimable agent files and caches into the reversible trash (~/.agent-cleaner/trash/), or permanently delete when permanent=true.',
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
                permanent: {
                    type: 'boolean',
                    description: 'Permanently delete selected items without moving to trash',
                },
                lang: {
                    type: 'string',
                    enum: ['zh', 'en'],
                    description: 'Optional output language (zh or en)',
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
            if (args.permanent)
                cliArgs.push('--permanent');
            if (args.lang === 'zh' || args.lang === 'en')
                cliArgs.push('--lang', args.lang);
            if (args.selectedIds?.length)
                cliArgs.push('--ids', args.selectedIds.join(','));
            return runCliJson(config, cliArgs);
        },
    });
    tools.register({
        name: 'agent_cleaner_doctor',
        description: 'Diagnose syntax and dead MCP links across AI agent configs, optionally auto-fixing all or selected issueIds while preserving comments.',
        parameters: {
            type: 'object',
            properties: {
                fix: {
                    type: 'boolean',
                    description: 'Auto-repair fixable issues after backing up original configs',
                },
                issueIds: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional specific doctor issue IDs to repair selectively',
                },
            },
        },
        output: buildTextOutputSpec(),
        execute: (args = {}) => {
            const cliArgs = buildDoctorCliArgs(args);
            return runCliJson(config, cliArgs);
        },
    });
    tools.register({
        name: 'agent_cleaner_mcp',
        description: 'Audit cross-agent MCP configurations, conflicts, cold npx/uv caches, and optionally terminate orphan stdio processes.',
        parameters: {
            type: 'object',
            properties: {
                kill: {
                    type: 'boolean',
                    description: 'Terminate detected orphan stdio MCP processes',
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
        description: 'List reversible trash batches (~/.agent-cleaner/trash/), restore a specific batch, prune expired/over-quota batches, or permanently purge trash.',
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
                prune: {
                    type: 'boolean',
                    description: 'Prune expired or over-quota trash batches per config.toml',
                },
            },
        },
        output: buildTextOutputSpec(),
        execute: (args = {}) => {
            if (args.prune)
                return runCliJson(config, ['restore', '--prune']);
            if (args.purgeAll)
                return runCliJson(config, ['restore', '--purge-all']);
            if (args.purgeBatchId)
                return runCliJson(config, ['restore', '--purge', args.purgeBatchId]);
            if (args.batchId)
                return runCliJson(config, ['restore', args.batchId]);
            return runCliJson(config, ['restore']);
        },
    });
    tools.register({
        name: 'agent_cleaner_config',
        description: 'Read or update ~/.agent-cleaner/config.toml settings and ignored path/agent whitelist.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['get', 'set', 'ignore_path', 'unignore_path', 'ignore_agent', 'unignore_agent'],
                },
                pattern: { type: 'string' },
                exemptHours: { type: 'number' },
                coldThresholdDays: { type: 'number' },
                lang: { type: 'string', enum: ['zh', 'en'] },
                trashMaxAgeDays: { type: 'number' },
                trashMaxSizeMb: { type: 'number' },
                autoPruneTrash: { type: 'boolean' },
                backupMaxCount: { type: 'number' },
            },
        },
        output: buildTextOutputSpec(),
        execute: (args = {}) => {
            const cliArgs = buildConfigCliArgs({ action: 'get', ...args });
            return runCliJson(config, cliArgs);
        },
    });
    tools.register({
        name: 'agent_cleaner_backups',
        description: 'List, restore, delete, or prune saved configuration backups (~/.agent-cleaner/backups/).',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['list', 'restore', 'delete', 'prune'],
                },
                backupId: { type: 'string' },
                keepCount: { type: 'number' },
            },
        },
        output: buildTextOutputSpec(),
        execute: (args = {}) => {
            const cliArgs = buildBackupsCliArgs(args);
            return runCliJson(config, cliArgs);
        },
    });
}
export default { name, inject, apply };
