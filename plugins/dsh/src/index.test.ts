import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deflateRawSync, gzipSync } from 'node:zlib';
import {
  apply,
  ensureBinaryPath,
  extractBinaryFromZip,
  findExistingBinaryPath,
  PLUGIN_VERSION,
  resolveReleaseAssetName,
} from './index.js';
import {
  COMMAND_TEMPLATES,
  detectPlatforms,
  setupPlugins,
  SKILL_MD_TEMPLATE,
} from './setup.js';

const execFileAsync = promisify(execFile);

function createTarGz(fileName: string, content: Buffer): Buffer {
  const BLOCK = 512;
  const header = Buffer.alloc(BLOCK, 0);
  header.write(fileName, 0, 100, 'utf8');
  header.write('0000755\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');

  let checksum = 0;
  for (let i = 0; i < BLOCK; i += 1) checksum += header[i]!;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');

  const paddedLen = Math.ceil(content.length / BLOCK) * BLOCK;
  const body = Buffer.alloc(paddedLen, 0);
  content.copy(body, 0);

  const trailer = Buffer.alloc(BLOCK * 2, 0);
  return gzipSync(Buffer.concat([header, body, trailer]));
}

test('DSH plugin registers all 8 headless tools and invokes binary with --json', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-test-'));
  const stubBin = path.join(tmpDir, 'mock-ac.mjs');
  await fs.writeFile(
    stubBin,
    `#!/usr/bin/env node\nconsole.log(JSON.stringify({ argv: process.argv.slice(2) }));\n`,
    { mode: 0o755 },
  );

  const registered = new Map<string, any>();
  const mockCtx = {
    get(svc: string) {
      if (svc === 'tools') {
        return {
          register(def: any) {
            registered.set(def.name, def);
          },
        };
      }
      return undefined;
    },
  };

  apply(mockCtx, { binaryPath: stubBin, exemptRecentHours: 12 });

  assert.deepEqual(
    [...registered.keys()].sort(),
    [
      'agent_cleaner_backups',
      'agent_cleaner_clean',
      'agent_cleaner_config',
      'agent_cleaner_doctor',
      'agent_cleaner_mcp',
      'agent_cleaner_overview',
      'agent_cleaner_restore',
      'agent_cleaner_scan',
    ],
  );

  const overviewRes = (await registered
    .get('agent_cleaner_overview')
    .execute({ olderThanHours: 48, lang: 'en' })) as { argv: string[] };
  assert.deepEqual(overviewRes.argv, ['overview', '--older-than', '48h', '--lang', 'en', '--json']);

  const scanRes = (await registered
    .get('agent_cleaner_scan')
    .execute({ agent: 'claude', lang: 'zh' })) as {
    argv: string[];
  };
  assert.deepEqual(scanRes.argv, [
    'scan',
    '--older-than',
    '12h',
    '--agent',
    'claude',
    '--lang',
    'zh',
    '--json',
  ]);

  const cleanRes = (await registered
    .get('agent_cleaner_clean')
    .execute({ onlyRecommended: true, dryRun: true, permanent: true, selectedIds: ['id1', 'id2'] })) as {
    argv: string[];
  };
  assert.deepEqual(cleanRes.argv, [
    'clean',
    '--yes',
    '--older-than',
    '12h',
    '--only-recommended',
    '--dry-run',
    '--permanent',
    '--ids',
    'id1,id2',
    '--json',
  ]);

  const doctorRes = (await registered.get('agent_cleaner_doctor').execute({ fix: true })) as {
    argv: string[];
  };
  assert.deepEqual(doctorRes.argv, ['doctor', '--fix', '--json']);

  const doctorSelectiveRes = (await registered
    .get('agent_cleaner_doctor')
    .execute({ issueIds: ['claude:dead_mcp:foo', 'codex:dead_mcp:bar'] })) as { argv: string[] };
  assert.deepEqual(doctorSelectiveRes.argv, [
    'doctor',
    '--fix',
    '--ids',
    'claude:dead_mcp:foo,codex:dead_mcp:bar',
    '--json',
  ]);

  const mcpRes = (await registered.get('agent_cleaner_mcp').execute({ kill: true, pid: 12345 })) as {
    argv: string[];
  };
  assert.deepEqual(mcpRes.argv, ['mcp', '--kill', '--pid', '12345', '--json']);

  const restoreListRes = (await registered.get('agent_cleaner_restore').execute({})) as {
    argv: string[];
  };
  assert.deepEqual(restoreListRes.argv, ['restore', '--json']);

  const restoreOneRes = (await registered
    .get('agent_cleaner_restore')
    .execute({ batchId: 'b1' })) as { argv: string[] };
  assert.deepEqual(restoreOneRes.argv, ['restore', 'b1', '--json']);

  const purgeOneRes = (await registered
    .get('agent_cleaner_restore')
    .execute({ purgeBatchId: 'b2' })) as { argv: string[] };
  assert.deepEqual(purgeOneRes.argv, ['restore', '--purge', 'b2', '--json']);

  const purgeAllRes = (await registered
    .get('agent_cleaner_restore')
    .execute({ purgeAll: true })) as { argv: string[] };
  assert.deepEqual(purgeAllRes.argv, ['restore', '--purge-all', '--json']);

  const pruneTrashRes = (await registered
    .get('agent_cleaner_restore')
    .execute({ prune: true })) as { argv: string[] };
  assert.deepEqual(pruneTrashRes.argv, ['restore', '--prune', '--json']);

  const configGetRes = (await registered.get('agent_cleaner_config').execute({})) as {
    argv: string[];
  };
  assert.deepEqual(configGetRes.argv, ['config', 'show', '--json']);

  const configSetRes = (await registered
    .get('agent_cleaner_config')
    .execute({ action: 'set', exemptHours: 48, coldThresholdDays: 21, autoPruneTrash: false })) as {
    argv: string[];
  };
  assert.deepEqual(configSetRes.argv, [
    'config',
    'set',
    '--exempt-hours',
    '48',
    '--cold-days',
    '21',
    '--auto-prune-trash',
    'false',
    '--json',
  ]);

  const configIgnoreRes = (await registered
    .get('agent_cleaner_config')
    .execute({ action: 'ignore_path', pattern: '~/.claude/vip' })) as { argv: string[] };
  assert.deepEqual(configIgnoreRes.argv, ['config', 'ignore', 'add', '~/.claude/vip', '--json']);

  const backupsListRes = (await registered.get('agent_cleaner_backups').execute({})) as {
    argv: string[];
  };
  assert.deepEqual(backupsListRes.argv, ['backups', 'list', '--json']);

  const backupsRestoreRes = (await registered
    .get('agent_cleaner_backups')
    .execute({ action: 'restore', backupId: 'bak-1' })) as { argv: string[] };
  assert.deepEqual(backupsRestoreRes.argv, ['backups', 'restore', 'bak-1', '--json']);

  const backupsPruneRes = (await registered
    .get('agent_cleaner_backups')
    .execute({ action: 'prune', keepCount: 10 })) as { argv: string[] };
  assert.deepEqual(backupsPruneRes.argv, ['backups', 'prune', '--keep', '10', '--json']);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('DSH plugin auto-downloads binary once on concurrent calls when missing locally', async () => {
  if (process.platform === 'win32') return;

  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-dl-'));
  const prevHome = process.env.HOME;
  const prevPath = process.env.PATH;

  const stubScript = Buffer.from(
    '#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true, argv: process.argv.slice(2) }));\n',
    'utf8',
  );
  const archive = createTarGz('agent-cleaner', stubScript);

  let downloadCount = 0;
  const server = http.createServer((_req, res) => {
    downloadCount += 1;
    res.writeHead(200, { 'content-type': 'application/gzip' });
    res.end(archive);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const downloadUrl = `http://127.0.0.1:${addr.port}/agent-cleaner.tar.gz`;

  try {
    process.env.HOME = tmpHome;
    process.env.PATH = '';

    const [p1, p2] = await Promise.all([
      ensureBinaryPath({ downloadUrl }),
      ensureBinaryPath({ downloadUrl }),
    ]);

    const expected = path.join(tmpHome, '.agent-cleaner', 'bin', 'agent-cleaner');
    assert.equal(p1, expected);
    assert.equal(p2, expected);
    assert.equal(downloadCount, 1);

    const p3 = await ensureBinaryPath({ downloadUrl });
    assert.equal(p3, expected);
    assert.equal(downloadCount, 1);

    const stat = await fs.stat(expected);
    assert.ok((stat.mode & 0o111) !== 0);

    const versionFile = `${expected}.version`;
    assert.equal((await fs.readFile(versionFile, 'utf8')).trim(), PLUGIN_VERSION);

    // Stale or missing .version triggers re-download and updates stamp
    await fs.writeFile(versionFile, '0.1.0\n', 'utf8');
    const p4 = await ensureBinaryPath({ downloadUrl });
    assert.equal(p4, expected);
    assert.equal(downloadCount, 2);
    assert.equal((await fs.readFile(versionFile, 'utf8')).trim(), PLUGIN_VERSION);

    await fs.rm(versionFile, { force: true });
    const p5 = await ensureBinaryPath({ downloadUrl });
    assert.equal(p5, expected);
    assert.equal(downloadCount, 3);
    assert.equal((await fs.readFile(versionFile, 'utf8')).trim(), PLUGIN_VERSION);
  } finally {
    process.env.HOME = prevHome;
    process.env.PATH = prevPath;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test('DSH client bundle registers sidebar.panellist and main slots via __ModuleLoader__', async () => {
  const clientJs = await fs.readFile(new URL('./client.js', import.meta.url), 'utf8');
  let loaded: { id: string; mod: any } | null = null;
  const mockReact = {
    createElement: (...args: any[]) => ({ args }),
    useState: (v: any) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useCallback: (fn: any) => fn,
  };
  const fn = new Function('window', clientJs);
  fn({
    __ModuleLoader__: {
      load({ id, factory }: { id: string; factory: (req: (m: string) => any) => any }) {
        const mod = factory((m: string) => (m === 'react' ? mockReact : {}));
        loaded = { id, mod };
      },
    },
  });

  const resolved = loaded as { id: string; mod: any } | null;
  assert.ok(resolved);
  assert.equal(resolved.id, 'dsh-agent-cleaner');
  const registeredSlots: string[] = [];
  resolved.mod.apply({
    slots: {
      register(meta: { name: string }) {
        registeredSlots.push(meta.name);
        return () => {};
      },
    },
  });
  assert.deepEqual(registeredSlots.sort(), ['main', 'sidebar.panellist']);

  assert.match(clientJs, /--ac-surface:\s*48 50% 98%/);
  assert.match(clientJs, /--ac-border:\s*hsl\(48 20% 89%\)/);
  assert.match(clientJs, /body\[data-ds-dark-theme\] \.ac-dsh-root/);
  assert.match(clientJs, /color-scheme:\s*light/);
  assert.doesNotMatch(clientJs, /--dsw-alias-bg-(?:primary|secondary|tertiary)/);
});

async function withRouteHarness(
  connectionService: Record<string, any> | undefined,
  run: (opts: {
    baseUrl: string;
    routes: Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void>;
    registeredTools: string[];
    injectedDeps: string[][];
    getExecCount: () => Promise<number>;
  }) => Promise<void>,
): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-http-'));
  const logFile = path.join(tmpDir, 'exec.log');
  const stubBin = path.join(tmpDir, 'mock-ac.mjs');
  await fs.writeFile(
    stubBin,
    [
      '#!/usr/bin/env node',
      "import fs from 'node:fs';",
      `fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      "if (process.argv.includes('--progress-json')) {",
      "  process.stderr.write(JSON.stringify({ completed: 1, total: 2, agent: 'claude', currentBytes: 1024 }) + '\\n');",
      "  process.stderr.write(JSON.stringify({ completed: 2, total: 2, agent: 'discovery', currentBytes: 2048 }) + '\\n');",
      '}',
      'console.log(JSON.stringify({ argv: process.argv.slice(2) }));',
    ].join('\n'),
    { mode: 0o755 },
  );

  const routes = new Map<
    string,
    (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void
  >();
  const registeredTools: string[] = [];
  const injectedDeps: string[][] = [];

  const services: Record<string, any> = {
    tools: {
      register(def: { name: string }) {
        registeredTools.push(def.name);
      },
    },
    webServer: {
      register(def: {
        kind: string;
        path: string;
        handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void;
      }) {
        routes.set(def.path, def.handler);
        return () => routes.delete(def.path);
      },
    },
  };
  if (connectionService !== undefined) {
    services.connection = connectionService;
  }

  const makeCtx = () => ({
    get(svc: string) {
      return services[svc];
    },
    effect(fn: () => unknown) {
      return fn();
    },
    inject(deps: string[], cb: (sctx: any) => void) {
      injectedDeps.push(deps);
      if (deps.every((d) => services[d] !== undefined)) {
        cb(makeCtx());
      }
    },
  });

  apply(makeCtx(), { binaryPath: stubBin, exemptRecentHours: 24 });

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const handler = routes.get(pathname);
    if (!handler) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    await handler(req, res);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');

  const getExecCount = async () => {
    try {
      const content = await fs.readFile(logFile, 'utf8');
      return content.trim() ? content.trim().split('\n').length : 0;
    } catch {
      return 0;
    }
  };

  try {
    await run({
      baseUrl: `http://127.0.0.1:${addr.port}`,
      routes,
      registeredTools,
      injectedDeps,
      getExecCount,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

test('DSH HTTP routes require connection.requestRejection while keeping headless tools registered', async () => {
  for (const conn of [undefined, {}]) {
    await withRouteHarness(conn, async ({ routes, registeredTools, injectedDeps }) => {
      assert.deepEqual(injectedDeps, [['webServer', 'connection']]);
      assert.equal(routes.size, 0);
      assert.deepEqual(
        registeredTools.sort(),
        [
          'agent_cleaner_backups',
          'agent_cleaner_clean',
          'agent_cleaner_config',
          'agent_cleaner_doctor',
          'agent_cleaner_mcp',
          'agent_cleaner_overview',
          'agent_cleaner_restore',
          'agent_cleaner_scan',
        ],
      );
    });
  }
});

test('DSH HTTP routes enforce connection.requestRejection before method check (401, 403, and fail-closed throw)', async () => {
  let mode: '401' | '403' | 'throw' = '401';
  await withRouteHarness(
    {
      requestRejection: () => {
        if (mode === '401') return 401;
        if (mode === '403') return 403;
        throw new Error('host auth unavailable');
      },
    },
    async ({ baseUrl, getExecCount }) => {
      // Wrong HTTP method on /clean must still return 401/403 (auth runs before 405 check)
      mode = '401';
      const r401 = await fetch(`${baseUrl}/agent-cleaner/api/clean`, { method: 'GET' });
      assert.equal(r401.status, 401);
      assert.equal(r401.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(await r401.json(), { ok: false, error: 'Unauthorized' });

      mode = '403';
      const r403 = await fetch(`${baseUrl}/agent-cleaner/api/overview`, { method: 'GET' });
      assert.equal(r403.status, 403);
      assert.equal(r403.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(await r403.json(), { ok: false, error: 'Forbidden' });

      mode = 'throw';
      const rThrow = await fetch(`${baseUrl}/agent-cleaner/api/purge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      assert.equal(rThrow.status, 403);
      assert.equal(rThrow.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(await rThrow.json(), { ok: false, error: 'Forbidden' });

      assert.equal(await getExecCount(), 0);
    },
  );
});

test('DSH HTTP routes require application/json on POST and allow authenticated requests', async () => {
  await withRouteHarness(
    { requestRejection: () => undefined },
    async ({ baseUrl, getExecCount }) => {
      const r415 = await fetch(`${baseUrl}/agent-cleaner/api/clean`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ dryRun: true }),
      });
      assert.equal(r415.status, 415);
      assert.deepEqual(await r415.json(), {
        ok: false,
        error: 'Content-Type must be application/json',
      });
      assert.equal(await getExecCount(), 0);

      const rClean = await fetch(`${baseUrl}/agent-cleaner/api/clean`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ exemptHours: 12, lang: 'en', dryRun: true }),
      });
      assert.equal(rClean.status, 200);
      assert.deepEqual(await rClean.json(), {
        ok: true,
        data: {
          argv: ['clean', '--yes', '--older-than', '12h', '--lang', 'en', '--dry-run', '--json'],
        },
      });
      assert.equal(await getExecCount(), 1);

      const rCleanPermanent = await fetch(`${baseUrl}/agent-cleaner/api/clean`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exemptHours: 24, lang: 'zh', permanent: true, selectedIds: ['id1'] }),
      });
      assert.equal(rCleanPermanent.status, 200);
      assert.deepEqual(await rCleanPermanent.json(), {
        ok: true,
        data: {
          argv: ['clean', '--yes', '--older-than', '24h', '--lang', 'zh', '--permanent', '--ids', 'id1', '--json'],
        },
      });
      assert.equal(await getExecCount(), 2);

      const rOverview = await fetch(`${baseUrl}/agent-cleaner/api/overview?hours=48&lang=en`, {
        method: 'GET',
      });
      assert.equal(rOverview.status, 200);
      const ovJson = (await rOverview.json()) as {
        ok: boolean;
        data: { exemptHours: number; lang: string; scannedAt?: number; disk?: { totalBytes: number; availableBytes: number } | null; agents: { argv: string[] } };
      };
      assert.equal(ovJson.ok, true);
      assert.equal(ovJson.data.exemptHours, 48);
      assert.equal(ovJson.data.lang, 'en');
      assert.equal(typeof ovJson.data.scannedAt, 'number');
      assert.ok(ovJson.data.disk && ovJson.data.disk.totalBytes > 0 && ovJson.data.disk.availableBytes >= 0);
      assert.deepEqual(ovJson.data.agents.argv, [
        'scan',
        '--older-than',
        '48h',
        '--lang',
        'en',
        '--progress-json',
        '--json',
      ]);
      assert.equal(await getExecCount(), 6);

      // Second identical overview request hits cache (no CLI execution)
      const rOverviewCached = await fetch(`${baseUrl}/agent-cleaner/api/overview?hours=48&lang=en`, {
        method: 'GET',
      });
      assert.equal(rOverviewCached.status, 200);
      assert.equal(await getExecCount(), 6);

      // force=1 bypasses cache (+4 CLI executions)
      const rOverviewForced = await fetch(
        `${baseUrl}/agent-cleaner/api/overview?hours=48&lang=en&force=1`,
        { method: 'GET' },
      );
      assert.equal(rOverviewForced.status, 200);
      assert.equal(await getExecCount(), 10);

      // Lightweight /api/trash only invokes `restore --json` (+1 CLI execution)
      const rTrash = await fetch(`${baseUrl}/agent-cleaner/api/trash`, { method: 'GET' });
      assert.equal(rTrash.status, 200);
      assert.deepEqual(await rTrash.json(), { ok: true, data: { argv: ['restore', '--json'] } });
      assert.equal(await getExecCount(), 11);

      const rKillOne = await fetch(`${baseUrl}/agent-cleaner/api/mcp-kill`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pid: 9999 }),
      });
      assert.equal(rKillOne.status, 200);
      assert.deepEqual(await rKillOne.json(), {
        ok: true,
        data: { argv: ['mcp', '--kill', '--pid', '9999', '--json'] },
      });
      assert.equal(await getExecCount(), 12);

      // Progress endpoint reflects latest stderr progress events after overview scan
      const rProg = await fetch(`${baseUrl}/agent-cleaner/api/progress`, { method: 'GET' });
      assert.equal(rProg.status, 200);
      const progJson = (await rProg.json()) as {
        ok: boolean;
        data: { active: boolean; completed: number; total: number; agent: string; currentBytes: number };
      };
      assert.equal(progJson.ok, true);
      assert.equal(progJson.data.active, false);
      assert.equal(progJson.data.completed, 2);
      assert.equal(progJson.data.total, 2);
      assert.equal(progJson.data.agent, 'discovery');
      assert.equal(progJson.data.currentBytes, 2048);

      // SSE progress stream delivers initial snapshot event
      const sseController = new AbortController();
      const rSse = await fetch(`${baseUrl}/agent-cleaner/api/progress?stream=1`, {
        headers: { accept: 'text/event-stream' },
        signal: sseController.signal,
      });
      assert.equal(rSse.status, 200);
      assert.match(rSse.headers.get('content-type') ?? '', /text\/event-stream/);
      const reader = rSse.body?.getReader();
      assert.ok(reader);
      const firstChunk = await reader.read();
      const firstText = Buffer.from(firstChunk.value ?? []).toString('utf8');
      assert.match(firstText, /^data:\s*\{.*"completed":2/m);
      sseController.abort();

      // Config GET/POST & cache invalidation
      const rCfgGet = await fetch(`${baseUrl}/agent-cleaner/api/config`, { method: 'GET' });
      assert.equal(rCfgGet.status, 200);
      assert.deepEqual(await rCfgGet.json(), { ok: true, data: { argv: ['config', 'show', '--json'] } });

      const rCfgSet = await fetch(`${baseUrl}/agent-cleaner/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'set',
          exempt_hours: 12,
          cold_threshold_days: 7,
          trash_max_age_days: 15,
          trash_max_size_mb: 1024,
          auto_prune_trash: false,
          backup_max_count: 10,
        }),
      });
      assert.equal(rCfgSet.status, 200);
      assert.deepEqual(await rCfgSet.json(), {
        ok: true,
        data: {
          argv: [
            'config',
            'set',
            '--exempt-hours',
            '12',
            '--cold-days',
            '7',
            '--trash-max-age-days',
            '15',
            '--trash-max-size-mb',
            '1024',
            '--auto-prune-trash',
            'false',
            '--backup-max-count',
            '10',
            '--json',
          ],
        },
      });

      const rCfgIgnore = await fetch(`${baseUrl}/agent-cleaner/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'ignore_path', pattern: '~/.claude/vip' }),
      });
      assert.equal(rCfgIgnore.status, 200);
      assert.deepEqual(await rCfgIgnore.json(), {
        ok: true,
        data: { argv: ['config', 'ignore', 'add', '~/.claude/vip', '--json'] },
      });

      const rCfgUnignoreAgent = await fetch(`${baseUrl}/agent-cleaner/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'unignore_agent', pattern: 'aider' }),
      });
      assert.equal(rCfgUnignoreAgent.status, 200);
      assert.deepEqual(await rCfgUnignoreAgent.json(), {
        ok: true,
        data: { argv: ['config', 'ignore-agent', 'remove', 'aider', '--json'] },
      });

      // Backups list / restore / delete / prune
      const rBakList = await fetch(`${baseUrl}/agent-cleaner/api/backups`, { method: 'GET' });
      assert.equal(rBakList.status, 200);
      assert.deepEqual(await rBakList.json(), { ok: true, data: { argv: ['backups', 'list', '--json'] } });

      const rBakRestore = await fetch(`${baseUrl}/agent-cleaner/api/backup-restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ backupId: 'b-id-1' }),
      });
      assert.equal(rBakRestore.status, 200);
      assert.deepEqual(await rBakRestore.json(), {
        ok: true,
        data: { argv: ['backups', 'restore', 'b-id-1', '--json'] },
      });

      const rBakDelete = await fetch(`${baseUrl}/agent-cleaner/api/backup-delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ backupId: 'b-id-2' }),
      });
      assert.equal(rBakDelete.status, 200);
      assert.deepEqual(await rBakDelete.json(), {
        ok: true,
        data: { argv: ['backups', 'delete', 'b-id-2', '--json'] },
      });

      const rBakPrune = await fetch(`${baseUrl}/agent-cleaner/api/backup-prune`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keepCount: 5 }),
      });
      assert.equal(rBakPrune.status, 200);
      assert.deepEqual(await rBakPrune.json(), {
        ok: true,
        data: { argv: ['backups', 'prune', '--keep', '5', '--json'] },
      });

      // Trash prune
      const rTrashPrune = await fetch(`${baseUrl}/agent-cleaner/api/trash-prune`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(rTrashPrune.status, 200);
      assert.deepEqual(await rTrashPrune.json(), {
        ok: true,
        data: { argv: ['restore', '--prune', '--json'] },
      });

      // Selective doctor fix
      const rDocFixSel = await fetch(`${baseUrl}/agent-cleaner/api/doctor-fix`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issueIds: ['claude:dead_mcp:foo'] }),
      });
      assert.equal(rDocFixSel.status, 200);
      assert.deepEqual(await rDocFixSel.json(), {
        ok: true,
        data: { argv: ['doctor', '--fix', '--ids', 'claude:dead_mcp:foo', '--json'] },
      });
    },
  );
});

test('DSH HTTP auth rejects unauthenticated access on config, backups, progress, and trash-prune', async () => {
  await withRouteHarness(
    { requestRejection: () => 401 },
    async ({ baseUrl, getExecCount }) => {
      for (const [urlPath, method] of [
        ['/agent-cleaner/api/config', 'GET'],
        ['/agent-cleaner/api/backups', 'GET'],
        ['/agent-cleaner/api/progress', 'GET'],
        ['/agent-cleaner/api/trash-prune', 'POST'],
        ['/agent-cleaner/api/backup-restore', 'POST'],
      ] as const) {
        const res = await fetch(`${baseUrl}${urlPath}`, {
          method,
          headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
          body: method === 'POST' ? JSON.stringify({}) : undefined,
        });
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { ok: false, error: 'Unauthorized' });
      }
      assert.equal(await getExecCount(), 0);
    },
  );
});

function createZip(fileName: string, content: Buffer, method: 0 | 8): Buffer {
  const nameBuf = Buffer.from(fileName, 'utf8');
  const payload = method === 8 ? deflateRawSync(content) : content;

  const lfh = Buffer.alloc(30 + nameBuf.length, 0);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(method, 8);
  lfh.writeUInt32LE(payload.length, 18);
  lfh.writeUInt32LE(content.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(lfh, 30);

  const cd = Buffer.alloc(46 + nameBuf.length, 0);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(method, 10);
  cd.writeUInt32LE(payload.length, 20);
  cd.writeUInt32LE(content.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(0, 42);
  nameBuf.copy(cd, 46);

  const cdOffset = lfh.length + payload.length;
  const eocd = Buffer.alloc(22, 0);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([lfh, payload, cd, eocd]);
}

test('extractBinaryFromZip and resolveReleaseAssetName handle Windows ZIP assets cross-platform', () => {
  assert.equal(resolveReleaseAssetName('win32', 'x64'), 'agent-cleaner-win32-x64.zip');
  assert.equal(resolveReleaseAssetName('win32', 'arm64'), 'agent-cleaner-win32-x64.zip');

  const sample = Buffer.from('MZ-fake-pe-binary-payload', 'utf8');
  const storedZip = createZip('bin/agent-cleaner.exe', sample, 0);
  assert.deepEqual(extractBinaryFromZip(storedZip, 'agent-cleaner.exe'), sample);

  const deflatedZip = createZip('agent-cleaner.exe', sample, 8);
  assert.deepEqual(extractBinaryFromZip(deflatedZip, 'agent-cleaner.exe'), sample);
});

test('findExistingBinaryPath skips npm CLI shims in PATH to avoid recursion', async () => {
  if (process.platform === 'win32') return;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-shim-'));
  const tmpHome = path.join(tmpDir, 'home');
  const shimDir = path.join(tmpDir, 'shim-bin');
  const realDir = path.join(tmpDir, 'real-bin');
  await fs.mkdir(tmpHome, { recursive: true });
  await fs.mkdir(shimDir, { recursive: true });
  await fs.mkdir(realDir, { recursive: true });

  const prevHome = process.env.HOME;
  const prevPath = process.env.PATH;

  try {
    const cliDistPath = fileURLToPath(new URL('./cli.js', import.meta.url));
    await fs.symlink(cliDistPath, path.join(shimDir, 'agent-cleaner'));

    const wrapperDir = path.join(tmpDir, 'wrapper-bin');
    await fs.mkdir(wrapperDir, { recursive: true });
    const wrapperPath = path.join(wrapperDir, 'agent-cleaner');
    await fs.writeFile(
      wrapperPath,
      '#!/bin/sh\nexec node "/usr/local/lib/node_modules/dsh-agent-cleaner/dist/cli.js" "$@"\n',
      { mode: 0o755 },
    );

    process.env.HOME = tmpHome;
    process.env.PATH = `${shimDir}${path.delimiter}${wrapperDir}`;
    assert.equal(findExistingBinaryPath(), null);

    const realBin = path.join(realDir, 'agent-cleaner');
    await fs.writeFile(realBin, '#!/bin/sh\necho real\n', { mode: 0o755 });
    process.env.PATH = `${shimDir}${path.delimiter}${wrapperDir}${path.delimiter}${realDir}`;
    assert.equal(findExistingBinaryPath(), realBin);
  } finally {
    process.env.HOME = prevHome;
    process.env.PATH = prevPath;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('dist/cli.js forwards arguments to managed native binary', async () => {
  if (process.platform === 'win32') return;

  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-cli-'));
  const binDir = path.join(tmpHome, '.agent-cleaner', 'bin');
  await fs.mkdir(binDir, { recursive: true });

  const managedBin = path.join(binDir, 'agent-cleaner');
  await fs.writeFile(
    managedBin,
    '#!/usr/bin/env node\nconsole.log(JSON.stringify({ argv: process.argv.slice(2) }));\n',
    { mode: 0o755 },
  );
  await fs.writeFile(`${managedBin}.version`, `${PLUGIN_VERSION}\n`, 'utf8');

  try {
    const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
    const { stdout } = await execFileAsync(
      process.execPath,
      [cliPath, 'scan', '--older-than', '48h', '--json'],
      {
        env: {
          ...process.env,
          HOME: tmpHome,
          PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
        },
      },
    );
    assert.deepEqual(JSON.parse(stdout), {
      argv: ['scan', '--older-than', '48h', '--json'],
    });
  } finally {
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test('setup templates match universal plugin and root skills files', async () => {
  const normEol = (s: string) => s.replace(/\r\n/g, '\n');
  const universalSkill = normEol(
    await fs.readFile(
      new URL('../../../plugins/universal/skills/agent-cleaner/SKILL.md', import.meta.url),
      'utf8',
    ),
  );
  const rootSkill = normEol(
    await fs.readFile(new URL('../../../skills/agent-cleaner/SKILL.md', import.meta.url), 'utf8'),
  );
  assert.equal(SKILL_MD_TEMPLATE, universalSkill);
  assert.equal(rootSkill, universalSkill);

  for (const [name, template] of Object.entries(COMMAND_TEMPLATES)) {
    const onDisk = normEol(
      await fs.readFile(
        new URL(`../../../plugins/universal/commands/${name}`, import.meta.url),
        'utf8',
      ),
    );
    assert.equal(template, onDisk, `command template ${name} drifted from plugins/universal`);
  }
});

test('setupPlugins installs npx MCP + Skill + slash commands across 6 platforms preserving comments and roundtrips uninstall', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-setup-'));

  try {
    // 1. Claude Code
    const claudeSettings = path.join(tmpHome, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(claudeSettings), { recursive: true });
    await fs.writeFile(
      claudeSettings,
      '{\n  // Claude comment\n  "mcpServers": {\n    "existing_claude": { "command": "sh" } // inline comment\n  }\n}\n',
      'utf8',
    );
    const claudeLegacy = path.join(tmpHome, '.claude.json');
    await fs.writeFile(
      claudeLegacy,
      '{\n  "mcpServers": {\n    "legacy_srv": { "command": "sh" }\n  }\n}\n',
      'utf8',
    );

    // 2. Cursor
    const cursorMcp = path.join(tmpHome, '.cursor', 'mcp.json');
    await fs.mkdir(path.dirname(cursorMcp), { recursive: true });
    await fs.writeFile(
      cursorMcp,
      '{\n  // Cursor comment\n  "mcpServers": {\n    "cursor_alive": { "command": "sh" }\n  }\n}\n',
      'utf8',
    );

    // 3. Gemini / Antigravity
    const geminiAg = path.join(tmpHome, '.gemini', 'antigravity', 'mcp_config.json');
    const geminiCli = path.join(tmpHome, '.gemini', 'settings.json');
    await fs.mkdir(path.dirname(geminiAg), { recursive: true });
    await fs.writeFile(geminiAg, '{\n  // Antigravity comment\n  "mcpServers": {}\n}\n', 'utf8');
    await fs.writeFile(geminiCli, '{\n  // Gemini CLI comment\n  "theme": "Default"\n}\n', 'utf8');

    // 4. Codex CLI (TOML)
    const codexCfg = path.join(tmpHome, '.codex', 'config.toml');
    await fs.mkdir(path.dirname(codexCfg), { recursive: true });
    await fs.writeFile(
      codexCfg,
      '# Codex top comment\nmodel = "gpt-5"\n\n[mcp_servers.keep_me]\ncommand = "sh"\n',
      'utf8',
    );

    // 5. OpenCode (JSONC native `mcp` schema)
    const opencodeCfg = path.join(tmpHome, '.config', 'opencode', 'opencode.jsonc');
    await fs.mkdir(path.dirname(opencodeCfg), { recursive: true });
    await fs.writeFile(
      opencodeCfg,
      '{\n  // OpenCode top comment\n  "mcp": {\n    "oc_alive": { "type": "local", "command": ["sh"] }\n  }\n}\n',
      'utf8',
    );

    // 6. DSH (YAML)
    const dshCfg = path.join(tmpHome, '.dsh', 'settings.yaml');
    await fs.mkdir(path.dirname(dshCfg), { recursive: true });
    await fs.writeFile(
      dshCfg,
      '# DSH header comment\nmcpServers:\n  # Keep existing DSH server\n  dsh_alive:\n    command: sh\n# Trailing DSH comment\nlogging: true\n',
      'utf8',
    );

    const installReport = setupPlugins({ homeDir: tmpHome });
    assert.equal(installReport.results.length, 6);
    assert.ok(installReport.results.every((r) => r.success));
    assert.ok(
      installReport.statuses.every(
        (s) => s.detected && s.mcpInstalled && s.skillInstalled && s.commandsInstalled,
      ),
    );

    const claudeText = await fs.readFile(claudeSettings, 'utf8');
    assert.match(claudeText, /\/\/ Claude comment/);
    assert.match(claudeText, /\/\/ inline comment/);
    assert.match(claudeText, /"command": "npx"/);
    assert.match(claudeText, /"dsh-agent-cleaner"/);
    assert.match(await fs.readFile(claudeLegacy, 'utf8'), /"agent-cleaner"/);

    const cursorText = await fs.readFile(cursorMcp, 'utf8');
    assert.match(cursorText, /\/\/ Cursor comment/);
    assert.match(cursorText, /"cursor_alive"/);
    assert.match(cursorText, /"agent-cleaner"/);

    const geminiAgText = await fs.readFile(geminiAg, 'utf8');
    assert.match(geminiAgText, /\/\/ Antigravity comment/);
    assert.match(geminiAgText, /"agent-cleaner"/);
    const geminiCliText = await fs.readFile(geminiCli, 'utf8');
    assert.match(geminiCliText, /\/\/ Gemini CLI comment/);
    assert.match(geminiCliText, /"agent-cleaner"/);

    const codexText = await fs.readFile(codexCfg, 'utf8');
    assert.match(codexText, /# Codex top comment/);
    assert.match(codexText, /\[mcp_servers\.keep_me\]/);
    assert.match(codexText, /\[mcp_servers\.agent-cleaner\]/);
    assert.match(codexText, /command = "npx"/);

    const opencodeText = await fs.readFile(opencodeCfg, 'utf8');
    assert.match(opencodeText, /\/\/ OpenCode top comment/);
    assert.match(opencodeText, /"oc_alive"/);
    assert.match(opencodeText, /"type": "local"/);
    assert.match(opencodeText, /"dsh-agent-cleaner"/);

    const dshText = await fs.readFile(dshCfg, 'utf8');
    assert.match(dshText, /# DSH header comment/);
    assert.match(dshText, /# Keep existing DSH server/);
    assert.match(dshText, /# Trailing DSH comment/);
    assert.match(dshText, /dsh_alive:/);
    assert.match(dshText, /agent-cleaner:/);
    assert.match(dshText, /command: npx/);

    for (const rel of [
      '.claude/skills/agent-cleaner/SKILL.md',
      '.claude/commands/clean.md',
      '.claude/commands/restore.md',
      '.cursor/skills/agent-cleaner/SKILL.md',
      '.cursor/commands/restore.md',
      '.gemini/config/skills/agent-cleaner/SKILL.md',
      '.gemini/skills/agent-cleaner/SKILL.md',
      '.gemini/commands/clean.md',
      '.gemini/config/commands/restore.md',
      '.codex/skills/agent-cleaner/SKILL.md',
      '.codex/prompts/clean.md',
      '.codex/commands/restore.md',
      '.config/opencode/skills/agent-cleaner/SKILL.md',
      '.config/opencode/commands/clean.md',
      '.dsh/skills/agent-cleaner/SKILL.md',
      '.dsh/commands/restore.md',
    ]) {
      const stat = await fs.stat(path.join(tmpHome, rel));
      assert.ok(stat.isFile(), `expected ${rel} to exist`);
    }

    // Backups created for modified configs
    const backups = await fs.readdir(path.join(tmpHome, '.agent-cleaner', 'backups'));
    assert.ok(backups.length >= 6);

    // Idempotent second run
    const rerun = setupPlugins({ homeDir: tmpHome });
    assert.ok(rerun.results.every((r) => r.success && r.updatedFiles.length === 0));

    // Uninstall removes everything cleanly while preserving comments & existing servers
    const uninstallReport = setupPlugins({ homeDir: tmpHome, uninstall: true });
    assert.ok(uninstallReport.results.every((r) => r.success));

    const postStatuses = detectPlatforms(tmpHome);
    assert.ok(
      postStatuses.every((s) => !s.mcpInstalled && !s.skillInstalled && !s.commandsInstalled),
    );

    const claudeAfter = await fs.readFile(claudeSettings, 'utf8');
    assert.match(claudeAfter, /\/\/ Claude comment/);
    assert.match(claudeAfter, /"existing_claude"/);
    assert.doesNotMatch(claudeAfter, /agent-cleaner/);
    assert.doesNotMatch(await fs.readFile(claudeLegacy, 'utf8'), /agent-cleaner/);

    const codexAfter = await fs.readFile(codexCfg, 'utf8');
    assert.match(codexAfter, /# Codex top comment/);
    assert.match(codexAfter, /\[mcp_servers\.keep_me\]/);
    assert.doesNotMatch(codexAfter, /agent-cleaner/);

    const opencodeAfter = await fs.readFile(opencodeCfg, 'utf8');
    assert.match(opencodeAfter, /\/\/ OpenCode top comment/);
    assert.match(opencodeAfter, /"oc_alive"/);
    assert.doesNotMatch(opencodeAfter, /agent-cleaner/);

    const dshAfter = await fs.readFile(dshCfg, 'utf8');
    assert.match(dshAfter, /# DSH header comment/);
    assert.match(dshAfter, /# Trailing DSH comment/);
    assert.match(dshAfter, /dsh_alive:/);
    assert.doesNotMatch(dshAfter, /agent-cleaner/);
  } finally {
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test('dist/cli.js setup --status --json runs without downloading binary', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-setup-cli-'));
  try {
    await fs.mkdir(path.join(tmpHome, '.cursor'), { recursive: true });
    const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
    const { stdout } = await execFileAsync(
      process.execPath,
      [cliPath, 'setup', '--status', '--json'],
      {
        env: {
          ...process.env,
          HOME: tmpHome,
          USERPROFILE: tmpHome,
          PATH: '',
        },
      },
    );
    const statuses = JSON.parse(stdout) as Array<{ agent: string; detected: boolean }>;
    assert.equal(statuses.length, 6);
    const cursor = statuses.find((s) => s.agent === 'cursor');
    assert.equal(cursor?.detected, true);
  } finally {
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});
