/**
 * Builds portable bundles that embed a Node.js runtime: users have nothing else to install.
 *
 *   npm run package                              # current platform
 *   npm run package -- --target linux-x64,win32-x64
 *
 * Targets: darwin-arm64, darwin-x64, win32-x64, linux-x64, linux-arm64.
 * macOS bundles must be built on macOS (ad-hoc code signing). Linux targets also give a .deb
 * when dpkg-deb is available (Debian, Ubuntu, or `brew install dpkg`). Output goes to release/.
 * Run `npm run build` first (the npm script does it).
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RELEASE = join(ROOT, 'release');
const CACHE = join(RELEASE, '.cache');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64'] as const;
type Target = (typeof TARGETS)[number];

const { values } = parseArgs({
  options: {
    target: { type: 'string', default: `${process.platform}-${process.arch}` },
    // Major version of the embedded runtime: the one pinned in .nvmrc.
    node: { type: 'string', default: readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim() },
  },
});

function run(command: string, args: string[], options: SpawnSyncOptions = {}): void {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.error?.message ?? `exit ${result.status}`})`);
}

/** Latest release of the requested Node.js major version. */
async function resolveNodeVersion(major: string): Promise<string> {
  const index = (await (await fetch('https://nodejs.org/dist/index.json')).json()) as { version: string }[];
  const match = index.find((r) => r.version.startsWith(`v${major}.`));
  if (!match) throw new Error(`no Node.js ${major} release found`);
  return match.version;
}

/** Downloads (once) and verifies the official Node.js archive, then extracts the binary. */
async function nodeBinary(version: string, target: Target): Promise<string> {
  const [os, arch] = target.split('-') as [string, string];
  const platform = os === 'win32' ? 'win' : os;
  const name = `node-${version}-${platform}-${arch}`;
  const archive = `${name}.${os === 'win32' ? 'zip' : 'tar.gz'}`;
  const dir = join(CACHE, version);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, archive);

  if (!existsSync(file)) {
    console.log(`downloading ${archive}`);
    const res = await fetch(`https://nodejs.org/dist/${version}/${archive}`);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${archive}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const sums = await (await fetch(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).text();
  const expected = sums.split('\n').find((line) => line.endsWith(`  ${archive}`))?.split(' ')[0];
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (!expected || expected !== actual) {
    rmSync(file);
    throw new Error(`checksum mismatch for ${archive}`);
  }

  const inner = os === 'win32' ? `${name}/node.exe` : `${name}/bin/node`;
  // GNU tar (Linux) cannot read zip archives; bsdtar (macOS, Windows) can.
  if (archive.endsWith('.zip') && process.platform === 'linux') run('unzip', ['-o', '-q', file, inner, '-d', dir]);
  else run('tar', ['-xf', file, '-C', dir, inner]);
  return join(dir, inner);
}

/** Application files plus production dependencies for the target platform. */
function stageApp(appDir: string, target: Target): void {
  const [os, cpu] = target.split('-') as [string, string];
  mkdirSync(appDir, { recursive: true });
  for (const part of ['dist/src', 'dist/ui']) {
    cpSync(join(ROOT, part), join(appDir, part), { recursive: true, filter: (src) => !src.endsWith('.map') });
  }
  for (const file of ['package.json', 'package-lock.json', 'LICENSE']) cpSync(join(ROOT, file), join(appDir, file));
  // Native modules ship prebuilt binaries: no compiler, no install scripts. --os/--cpu pick the
  // optional platform packages (webview) of the target instead of the build machine.
  const npmCli = process.env.npm_execpath;
  const npmArgs = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--os=${os}`, `--cpu=${cpu}`];
  if (os === 'linux') npmArgs.push('--libc=glibc'); // the webview package targets glibc distributions
  if (npmCli) run(process.execPath, [npmCli, ...npmArgs], { cwd: appDir });
  else run('npm', npmArgs, { cwd: appDir, shell: process.platform === 'win32' });
  // Prebuilt binaries of other platforms are dead weight. Folders are named <os>-<cpu>[+<cpu>…]
  // (darwin-x64+arm64 is universal).
  for (const mod of ['@stoprocent/noble', '@stoprocent/bluetooth-hci-socket', 'usb', '@serialport/bindings-cpp']) {
    const dir = join(appDir, 'node_modules', mod, 'prebuilds');
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const [entryOs, cpus = ''] = entry.split('-');
      if (entryOs !== os || !cpus.split('+').includes(cpu)) rmSync(join(dir, entry), { recursive: true, force: true });
    }
  }
}

const MAC_LAUNCHER = `#!/bin/sh
# WattPure.app launcher: runs the embedded Node.js runtime.
# Started from Finder, the output goes to ~/Library/Logs; from a terminal, it stays there.
RESOURCES="$(cd "$(dirname "$0")/../Resources" && pwd)"
if [ -t 1 ]; then
  exec "$RESOURCES/node" "$RESOURCES/app/dist/src/main.js" "$@"
fi
mkdir -p "$HOME/Library/Logs"
exec "$RESOURCES/node" "$RESOURCES/app/dist/src/main.js" "$@" >>"$HOME/Library/Logs/wattpure.log" 2>&1
`;

const infoPlist = (version: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>WattPure</string>
  <key>CFBundleDisplayName</key><string>WattPure</string>
  <key>CFBundleIdentifier</key><string>io.github.sim07.wattpure</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleExecutable</key><string>wattpure</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.healthcare-fitness</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSBluetoothAlwaysUsageDescription</key><string>WattPure reads your heart rate strap, smart trainer or power meter over Bluetooth.</string>
  <key>NSLocalNetworkUsageDescription</key><string>WattPure finds and controls your Dyson fan on your local network.</string>
  <key>NSBonjourServices</key><array><string>_dyson_mqtt._tcp</string></array>
</dict>
</plist>
`;

const WINDOWS_LAUNCHER = `@echo off\r
rem Starts WattPure with the embedded Node.js runtime. The minimized console shows the logs.\r
start "WattPure" /min "%~dp0node.exe" "%~dp0app\\dist\\src\\main.js" %*\r
`;

const LINUX_LAUNCHER = `#!/bin/sh
# Starts WattPure with the embedded Node.js runtime.
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
exec "$DIR/node" "$DIR/app/dist/src/main.js" "$@"
`;

const LINUX_DESKTOP_INSTALLER = `#!/bin/sh
# Adds WattPure to the application menu of the current user.
DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/wattpure.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=WattPure
Comment=Your Dyson fan follows your training zone
Exec="$DIR/wattpure"
Icon=$DIR/icon.png
Terminal=false
Categories=Utility;Sports;
EOF
echo "WattPure added to your applications menu."
`;

/** Debian architecture names of the Linux targets. */
const DEB_ARCH = { 'linux-x64': 'amd64', 'linux-arm64': 'arm64' } as const;

const DEB_DESKTOP_ENTRY = `[Desktop Entry]
Type=Application
Name=WattPure
Comment=Your Dyson fan follows your training zone
Exec=wattpure
Icon=wattpure
Terminal=false
Categories=Utility;Sports;
`;

// The embedded Node.js needs glibc 2.28, libstdc++ and libatomic (Debian 10, Ubuntu 20.04 and later).
// WebKitGTK only gives the native window (the browser takes over without it): recommended, so a
// headless Raspberry Pi can do without it with --no-install-recommends. The prebuilt webview module
// also needs glibc 2.39 (Ubuntu 24.04, Debian 13): older systems get the browser, not a dependency error.
const debControl = (version: string, arch: string, installedSize: number) => `Package: wattpure
Version: ${version}
Architecture: ${arch}
Maintainer: ${pkg.author} <sim07@sim07.net>
Installed-Size: ${installedSize}
Depends: libc6 (>= 2.28), libstdc++6, libatomic1, bluez
Recommends: libwebkit2gtk-4.1-0, libxdo3
Section: utils
Priority: optional
Homepage: ${pkg.homepage}
Description: ${pkg.description.replace(/\.$/, '')}
 WattPure reads a Bluetooth heart rate strap, smart trainer or power meter and sets
 the speed of a Dyson fan on the local network to match your training zone.
`;

const debCopyright = () => `Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: wattpure
Source: ${pkg.homepage}

Files: *
Copyright: ${pkg.author}
License: ${pkg.license}

${readFileSync(join(ROOT, 'LICENSE'), 'utf8').trim().split('\n').map((line) => (line.trim() ? ` ${line}` : ' .')).join('\n')}
`;

function hasDpkgDeb(): boolean {
  return spawnSync('dpkg-deb', ['--version'], { stdio: 'ignore' }).status === 0;
}

/** Disk usage in KiB, as dpkg expects it in Installed-Size. */
function diskUsage(path: string): number {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return Math.ceil(stat.size / 1024);
  return readdirSync(path).reduce((sum, entry) => sum + diskUsage(join(path, entry)), 1);
}

/** Debian package of a staged Linux bundle: /opt/wattpure, a command in /usr/bin, a menu entry. */
function packageDeb(folder: string, work: string, target: 'linux-x64' | 'linux-arm64', version: string): string {
  const arch = DEB_ARCH[target];
  const root = join(work, 'deb');
  const opt = join(root, 'opt', 'wattpure');
  cpSync(folder, opt, { recursive: true });
  // The package installs the menu entry and its icon itself.
  for (const file of ['install-desktop-entry.sh', 'icon.png']) rmSync(join(opt, file));
  mkdirSync(join(root, 'usr', 'bin'), { recursive: true });
  symlinkSync('/opt/wattpure/wattpure', join(root, 'usr', 'bin', 'wattpure'));
  const share = join(root, 'usr', 'share');
  mkdirSync(join(share, 'applications'), { recursive: true });
  writeFileSync(join(share, 'applications', 'wattpure.desktop'), DEB_DESKTOP_ENTRY);
  mkdirSync(join(share, 'icons', 'hicolor', '256x256', 'apps'), { recursive: true });
  cpSync(join(ROOT, 'assets', 'icon-256.png'), join(share, 'icons', 'hicolor', '256x256', 'apps', 'wattpure.png'));
  mkdirSync(join(share, 'doc', 'wattpure'), { recursive: true });
  writeFileSync(join(share, 'doc', 'wattpure', 'copyright'), debCopyright());

  const installedSize = diskUsage(join(root, 'opt')) + diskUsage(join(root, 'usr'));
  mkdirSync(join(root, 'DEBIAN'));
  writeFileSync(join(root, 'DEBIAN', 'control'), debControl(version, arch, installedSize));

  const out = join(RELEASE, `wattpure_${version}_${arch}.deb`);
  rmSync(out, { force: true });
  // xz rather than the zstd default of Ubuntu: older dpkg (Debian 11, Raspberry Pi OS bullseye) cannot read zstd.
  run('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', root, out]);
  return out;
}

async function packageTarget(target: Target, nodeVersion: string): Promise<string[]> {
  const [os] = target.split('-');
  if (os === 'darwin' && process.platform !== 'darwin') throw new Error('macOS bundles must be built on macOS');
  const version: string = pkg.version;
  const node = await nodeBinary(nodeVersion, target);
  const work = join(RELEASE, 'stage', target);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const base = `wattpure-${version}-${target}`;

  if (os === 'darwin') {
    const contents = join(work, 'WattPure.app', 'Contents');
    mkdirSync(join(contents, 'MacOS'), { recursive: true });
    mkdirSync(join(contents, 'Resources'), { recursive: true });
    writeFileSync(join(contents, 'Info.plist'), infoPlist(version));
    writeFileSync(join(contents, 'MacOS', 'wattpure'), MAC_LAUNCHER, { mode: 0o755 });
    cpSync(join(ROOT, 'assets', 'icon.icns'), join(contents, 'Resources', 'icon.icns'));
    cpSync(node, join(contents, 'Resources', 'node'));
    chmodSync(join(contents, 'Resources', 'node'), 0o755);
    stageApp(join(contents, 'Resources', 'app'), target);
    run('codesign', ['--force', '--deep', '--sign', '-', join(work, 'WattPure.app')]);
    const out = join(RELEASE, `${base}.zip`);
    rmSync(out, { force: true });
    run('ditto', ['-c', '-k', '--keepParent', join(work, 'WattPure.app'), out]);
    return [out];
  }

  const folder = join(work, 'wattpure');
  mkdirSync(folder, { recursive: true });
  stageApp(join(folder, 'app'), target);
  if (os === 'win32') {
    cpSync(node, join(folder, 'node.exe'));
    writeFileSync(join(folder, 'wattpure.cmd'), WINDOWS_LAUNCHER);
    const out = join(RELEASE, `${base}.zip`);
    rmSync(out, { force: true });
    if (process.platform === 'win32') run('tar', ['-a', '-c', '-f', out, 'wattpure'], { cwd: work });
    else run('zip', ['-qr', out, 'wattpure'], { cwd: work });
    return [out];
  }

  cpSync(node, join(folder, 'node'));
  chmodSync(join(folder, 'node'), 0o755);
  writeFileSync(join(folder, 'wattpure'), LINUX_LAUNCHER, { mode: 0o755 });
  writeFileSync(join(folder, 'install-desktop-entry.sh'), LINUX_DESKTOP_INSTALLER, { mode: 0o755 });
  cpSync(join(ROOT, 'assets', 'icon-256.png'), join(folder, 'icon.png'));
  const out = join(RELEASE, `${base}.tar.gz`);
  run('tar', ['-czf', out, 'wattpure'], { cwd: work });
  if (!hasDpkgDeb()) {
    console.warn(`dpkg-deb not found: no .deb for ${target}`);
    return [out];
  }
  return [out, packageDeb(folder, work, target as keyof typeof DEB_ARCH, version)];
}

async function main(): Promise<void> {
  if (!existsSync(join(ROOT, 'dist', 'src', 'main.js'))) throw new Error('run `npm run build` first');
  const targets = values.target.split(',').map((t) => t.trim()) as Target[];
  for (const target of targets) if (!TARGETS.includes(target)) throw new Error(`unknown target ${target} (expected one of ${TARGETS.join(', ')})`);
  const nodeVersion = await resolveNodeVersion(values.node);
  console.log(`embedding Node.js ${nodeVersion}`);
  const outputs: string[] = [];
  for (const target of targets) outputs.push(...(await packageTarget(target, nodeVersion)));
  console.log(`\n${outputs.join('\n')}`);
}

main().catch((err: Error) => {
  console.error(`package: ${err.message}`);
  process.exit(1);
});
