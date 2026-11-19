import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { apply, ensureBinaryPath, PLUGIN_VERSION } from './index.js';

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

test('DSH plugin registers all 5 headless tools and invokes binary with --json', async () => {
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
      'agent_cleaner_clean',
      'agent_cleaner_doctor',
      'agent_cleaner_mcp',
      'agent_cleaner_restore',
      'agent_cleaner_scan',
    ],
  );

  const scanRes = (await registered.get('agent_cleaner_scan').execute({ agent: 'claude' })) as {
    argv: string[];
  };
  assert.deepEqual(scanRes.argv, ['scan', '--older-than', '12h', '--agent', 'claude', '--json']);

  const cleanRes = (await registered
    .get('agent_cleaner_clean')
    .execute({ onlyRecommended: true, dryRun: true, selectedIds: ['id1', 'id2'] })) as {
    argv: string[];
  };
  assert.deepEqual(cleanRes.argv, [
    'clean',
    '--yes',
    '--older-than',
    '12h',
    '--only-recommended',
    '--dry-run',
    '--ids',
    'id1,id2',
    '--json',
  ]);

  const doctorRes = (await registered.get('agent_cleaner_doctor').execute({ fix: true })) as {
    argv: string[];
  };
  assert.deepEqual(doctorRes.argv, ['doctor', '--fix', '--json']);

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

  assert.match(clientJs, /--dsw-alias-card-fill/);
  assert.match(clientJs, /--dsw-alias-border-l2/);
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
          'agent_cleaner_clean',
          'agent_cleaner_doctor',
          'agent_cleaner_mcp',
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

      const rOverview = await fetch(`${baseUrl}/agent-cleaner/api/overview?hours=48&lang=en`, {
        method: 'GET',
      });
      assert.equal(rOverview.status, 200);
      const ovJson = (await rOverview.json()) as {
        ok: boolean;
        data: { exemptHours: number; lang: string; agents: { argv: string[] } };
      };
      assert.equal(ovJson.ok, true);
      assert.equal(ovJson.data.exemptHours, 48);
      assert.equal(ovJson.data.lang, 'en');
      assert.deepEqual(ovJson.data.agents.argv, ['scan', '--older-than', '48h', '--lang', 'en', '--json']);
      assert.equal(await getExecCount(), 5);

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
      assert.equal(await getExecCount(), 6);
    },
  );
});
