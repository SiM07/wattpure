/**
 * Renders ui/icon.svg into the bundle icons: assets/icon.png (1024 px), assets/icon-256.png
 * (Linux) and assets/icon.icns (macOS). Run with `npm run icons` after changing the SVG.
 *
 * macOS only: rendering goes through headless Google Chrome (set CHROME to another Chromium
 * binary if needed), resizing through `sips` and the .icns through `iconutil`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ASSETS = join(ROOT, 'assets');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: ['ignore', 'ignore', 'inherit'] });
  if (result.status !== 0) throw new Error(`${command} failed (${result.error?.message ?? `exit ${result.status}`})`);
}

if (process.platform !== 'darwin') throw new Error('icons are generated on macOS (sips, iconutil)');
if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}: set CHROME`);

const work = mkdtempSync(join(tmpdir(), 'wattpure-icons-'));
try {
  // A page showing the SVG edge to edge on a transparent background.
  const svg = readFileSync(join(ROOT, 'ui', 'icon.svg'), 'utf8').replace('<svg ', '<svg width="1024" height="1024" ');
  writeFileSync(join(work, 'icon.html'), `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`);
  const master = join(work, 'icon-1024.png');
  run(CHROME, ['--headless', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000', `--screenshot=${master}`, '--window-size=1024,1024', `file://${join(work, 'icon.html')}`]);

  mkdirSync(ASSETS, { recursive: true });
  run('cp', [master, join(ASSETS, 'icon.png')]);
  run('sips', ['-z', '256', '256', master, '--out', join(ASSETS, 'icon-256.png')]);

  const iconset = join(work, 'icon.iconset');
  mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    run('sips', ['-z', String(size), String(size), master, '--out', join(iconset, `icon_${size}x${size}.png`)]);
    run('sips', ['-z', String(size * 2), String(size * 2), master, '--out', join(iconset, `icon_${size}x${size}@2x.png`)]);
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', join(ASSETS, 'icon.icns')]);
  console.log('assets/icon.png, assets/icon-256.png, assets/icon.icns');
} finally {
  rmSync(work, { recursive: true, force: true });
}
