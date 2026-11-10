/**
 * Build: compiles the Node code (src -> dist/src) and the UI (ui -> dist/ui), then copies
 * the static UI files. Run with `npm run build`.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, readdirSync, rmSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const STATIC = new Set(['.html', '.css', '.svg', '.png', '.ico']);

rmSync(join(root, 'dist'), { recursive: true, force: true });
for (const project of ['tsconfig.build.json', 'tsconfig.ui.json']) {
  const result = spawnSync(process.execPath, [tsc, '-p', join(root, project)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const file of readdirSync(join(root, 'ui'))) {
  if (STATIC.has(extname(file))) cpSync(join(root, 'ui', file), join(root, 'dist', 'ui', file));
}
console.log('built into dist/');
