/**
 * Desktop launcher: starts the engine and the local server, then opens the native window
 * (or the default browser when no webview is available). Closing the window quits the app
 * and puts the fan back in its original state.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, shutdownBluetooth, streamSensor } from './ble.ts';
import { type ConfigStore, fileStore } from './config.ts';
import { demoSensor, Session, type SensorFn } from './engine.ts';
import { createDysonFan, dysonCloud } from './dyson.ts';
import { fakeDysonCloud, fakeFanFactory, fakeScan } from './fakes.ts';
import { type AppServer, createServer, type DysonApi, type ScanFn } from './server.ts';
import { VERSION } from './version.ts';
import { type ChildMessage, type ParentMessage, WEBVIEW_UNAVAILABLE } from './window-protocol.ts';

export interface LaunchOptions {
  /** Simulated sensor, real fan. */
  demo?: boolean;
  /** Everything simulated (sensor, fan, Dyson account, scan): no hardware needed. */
  sandbox?: boolean;
  /** Open the UI in the default browser instead of a native window. */
  browser?: boolean;
  store?: ConfigStore;
}

/** In browser mode, quit when no tab has been connected for this long. */
const BROWSER_IDLE_QUIT_MS = 30_000;

const log = (message: string) => console.log(`[wattpure] ${message}`);

export function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  spawn(command, args as string[], { stdio: 'ignore', detached: true, windowsHide: true })
    .on('error', () => log(`open ${url} in your browser`))
    .unref();
}

interface InstanceLock {
  pid: number;
  port: number;
  token: string;
}

/** Asks an already running instance to come to the front; returns false when there is none. */
async function focusRunningInstance(lockPath: string): Promise<boolean> {
  let lock: InstanceLock;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return false;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/api/focus`, {
      method: 'POST',
      headers: { 'X-Wattpure-Token': lock.token },
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false; // stale lock file left by a crash
  }
}

export async function launchDesktop(options: LaunchOptions = {}): Promise<void> {
  const sandbox = Boolean(options.sandbox);
  const demo = sandbox || Boolean(options.demo);
  const store = options.store ?? fileStore();
  const lockPath = join(dirname(store.path), sandbox ? 'instance-sandbox.json' : 'instance.json');

  if (await focusRunningInstance(lockPath)) {
    log('already running: showing the existing window');
    return;
  }

  const dyson: DysonApi = sandbox ? { cloud: fakeDysonCloud(), createFan: fakeFanFactory() } : { cloud: dysonCloud, createFan: createDysonFan };
  const scanSensors: ScanFn = sandbox ? fakeScan : (kind, o) => scan(kind, o);
  const sensor: SensorFn = demo ? (metric, o) => demoSensor(metric, o) : (metric, o) => streamSensor(metric.kind, metric.device, o);

  const session = new Session(store.load(), { sensor, createFan: dyson.createFan, demo });
  let mode: 'window' | 'browser' = options.browser ? 'browser' : 'window';
  let child: ChildProcess | null = null;
  let url = '';
  let idleTimer: NodeJS.Timeout | undefined;
  let shuttingDown = false;

  const shutdown = async (code = 0) => {
    if (shuttingDown) process.exit(code); // second Ctrl+C: leave right away
    shuttingDown = true;
    log('quitting: putting the fan back as it was');
    clearTimeout(idleTimer);
    const force = setTimeout(() => process.exit(code), 8000);
    try {
      await session.stop();
      await shutdownBluetooth();
      await server.close();
    } finally {
      clearTimeout(force);
      rmSync(lockPath, { force: true });
      child?.kill();
      process.exit(code);
    }
  };

  const openUi = () => {
    if (process.env.WATTPURE_NO_OPEN) return; // development: the UI is opened by hand
    if (mode === 'browser') return openInBrowser(url);
    child = spawn(process.execPath, [fileURLToPath(new URL(`./window${extname(fileURLToPath(import.meta.url))}`, import.meta.url)), url], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    child.on('message', (message: ChildMessage) => {
      if (typeof message?.open === 'string' && /^https?:\/\//.test(message.open)) openInBrowser(message.open);
    });
    child.on('exit', (code, signal) => {
      child = null;
      if (shuttingDown) return;
      if (code === 0) return void shutdown();
      log(code === WEBVIEW_UNAVAILABLE ? 'no native webview: opening the browser instead' : `window stopped (${signal ?? code}): opening the browser instead`);
      mode = 'browser';
      openInBrowser(url);
    });
  };

  const server: AppServer = createServer({
    session,
    store,
    dyson,
    scan: scanSensors,
    info: { version: VERSION, mode, demo, platform: process.platform },
    onQuit: () => void shutdown(),
    onFocus: () => (child ? child.send('focus' satisfies ParentMessage) : openInBrowser(url)),
    onClients: (count) => {
      clearTimeout(idleTimer);
      if (mode === 'browser' && count === 0) idleTimer = setTimeout(() => void shutdown(), BROWSER_IDLE_QUIT_MS);
    },
  });

  const listening = await server.listen();
  url = listening.url;
  const lock: InstanceLock = { pid: process.pid, port: listening.port, token: server.token };
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify(lock), { mode: 0o600 });
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  if (process.platform === 'win32') process.on('SIGHUP', () => void shutdown()); // console window closed

  log(`v${VERSION}${sandbox ? ' (sandbox)' : demo ? ' (demo)' : ''} - UI at ${url.split('#')[0]}`);
  openUi();
  await session.start();
}
