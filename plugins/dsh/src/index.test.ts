import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply } from './index.js';

test('DSH plugin registers all 4 headless tools and invokes binary with --json', async () => {
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
    ['agent_cleaner_clean', 'agent_cleaner_doctor', 'agent_cleaner_mcp', 'agent_cleaner_scan'],
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

  const mcpRes = (await registered.get('agent_cleaner_mcp').execute({ kill: true })) as {
    argv: string[];
  };
  assert.deepEqual(mcpRes.argv, ['mcp', '--kill', '--json']);

  await fs.rm(tmpDir, { recursive: true, force: true });
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
