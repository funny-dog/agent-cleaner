import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJsonVersion(relPath) {
  const fullPath = path.join(rootDir, relPath);
  const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  return parsed.version;
}

function readCargoVersion(relPath) {
  const fullPath = path.join(rootDir, relPath);
  const raw = fs.readFileSync(fullPath, 'utf8');
  const match = raw.match(/^\s*version\s*=\s*"([^"]+)"/m);
  return match?.[1];
}

const targets = [
  ['package.json', readJsonVersion('package.json')],
  ['plugins/dsh/package.json', readJsonVersion('plugins/dsh/package.json')],
  ['plugins/universal/plugin.json', readJsonVersion('plugins/universal/plugin.json')],
  ['plugins/universal/.claude-plugin/plugin.json', readJsonVersion('plugins/universal/.claude-plugin/plugin.json')],
  ['apps/desktop/package.json', readJsonVersion('apps/desktop/package.json')],
  ['apps/desktop/src-tauri/tauri.conf.json', readJsonVersion('apps/desktop/src-tauri/tauri.conf.json')],
  ['crates/cleaner-core/Cargo.toml', readCargoVersion('crates/cleaner-core/Cargo.toml')],
  ['crates/cleaner-cli/Cargo.toml', readCargoVersion('crates/cleaner-cli/Cargo.toml')],
  ['apps/desktop/src-tauri/Cargo.toml', readCargoVersion('apps/desktop/src-tauri/Cargo.toml')],
];

const expected = targets[0][1];
const mismatches = targets.filter(([, version]) => !version || version !== expected);

if (!expected || mismatches.length > 0) {
  console.error('Version mismatch detected across workspace manifests:');
  for (const [file, version] of targets) {
    console.error(`  - ${file}: ${version ?? '<missing>'}`);
  }
  process.exit(1);
}

console.log(`All ${targets.length} workspace manifests match version ${expected}.`);
