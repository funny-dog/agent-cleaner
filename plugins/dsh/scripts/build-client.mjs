import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';

const pkgDir = process.cwd();
const outFile = path.join(pkgDir, 'dist', 'client.js');

const result = await build({
  entryPoints: [path.join(pkgDir, 'src', 'client.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
});

const bundledCjs = result.outputFiles[0].text;
const wrapped = `window.__ModuleLoader__.load({ id: "dsh-agent-cleaner", factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;\n${bundledCjs}\nreturn module.exports;\n} });\n`;

await fs.mkdir(path.dirname(outFile), { recursive: true });
await fs.writeFile(outFile, wrapped, 'utf8');
console.log('Built DSH client bundle:', outFile);
