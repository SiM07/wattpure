#!/usr/bin/env node
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { scan, shutdownBluetooth, streamSensor } from './ble.ts';
import { configDir, fileStore, isComplete, SOURCES, validatePatch } from './config.ts';
import { launchDesktop } from './desktop.ts';
import { demoSensor, Session } from './engine.ts';
import { describeStatus, pickLanguage, translate } from './shared/i18n.ts';
import type { SessionState, Source } from './shared/types.ts';
import { VERSION } from './version.ts';

const USAGE = `WattPure ${VERSION} - your Dyson fan follows your training zone

Usage:
  wattpure [options]         open the app
  wattpure run [options]     drive the fan from the terminal, without the app window
  wattpure scan [--source]   list the Bluetooth sensors in range

Options:
  --demo                 simulated sensor (the fan is real)
  --sandbox              everything simulated, with a separate settings file: no hardware needed
  --browser              open the app in the default browser instead of a window
  --source <hr|power>    heart rate (default) or power          (run, scan)
  --ftp <watts>          FTP                                     (run)
  --max-hr <bpm>         max heart rate                          (run)
  -v, --version          print the version
  -h, --help             print this help

Settings are saved in ${fileStore().path}`;

function parse() {
  return parseArgs({
    allowPositionals: true,
    options: {
      demo: { type: 'boolean' },
      sandbox: { type: 'boolean' },
      browser: { type: 'boolean' },
      source: { type: 'string' },
      ftp: { type: 'string' },
      'max-hr': { type: 'string' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

/** Headless mode: prints the status changes and the live value on one line. */
async function runHeadless(values: ReturnType<typeof parse>['values']): Promise<void> {
  const store = fileStore();
  const overrides = validatePatch({
    ...(values.source && { source: values.source }),
    ...(values.ftp && { ftp: values.ftp }),
    ...(values['max-hr'] && { maxHr: values['max-hr'] }),
  });
  const cfg = { ...store.load(), ...overrides };
  if (!isComplete(cfg)) throw new Error('not set up yet: open the app once (`wattpure`) to set up the fan');

  const lang = cfg.language ?? pickLanguage(Intl.DateTimeFormat().resolvedOptions().locale);
  const tty = process.stdout.isTTY;
  const session = new Session(cfg, {
    demo: Boolean(values.demo),
    sensor: values.demo ? (metric, o) => demoSensor(metric, o) : (metric, o) => streamSensor(metric.kind, metric.device, o),
  });

  // Capabilities revealed by the fan (angles) are saved for the next runs.
  session.on('machine', (fan) => {
    store.save({ ...store.load(), fan });
    void session.configure({ ...session.cfg, fan });
  });

  let lastStatus = '';
  let lastFan: boolean | null = null;
  const print = (line: string) => process.stdout.write(tty ? `\r\x1b[K${line}\n` : `${line}\n`);
  session.on('state', (state: SessionState) => {
    const configured = state.source === 'power' ? cfg.powerMeter?.name : cfg.hrm?.name;
    const { title, hint } = describeStatus(lang, state.status, state.source, state.device?.name ?? configured);
    const text = hint ? `${title} - ${hint}` : title;
    if (text !== lastStatus) {
      lastStatus = text;
      print(`[${new Date().toLocaleTimeString()}] ${text}`);
    }
    if (state.fan.ok !== lastFan) {
      lastFan = state.fan.ok;
      if (state.fan.problem) print(`[${new Date().toLocaleTimeString()}] ${translate(lang, `fan.${state.fan.problem}`)}`);
    }
    if (tty && state.value !== null && state.zone) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(state.zone!.color.slice(i, i + 2), 16));
      const zoneName = translate(lang, `zone.${state.zone.name}`);
      const badge = `\x1b[48;2;${r};${g};${b}m\x1b[30m Z${state.zone.number} ${zoneName} \x1b[0m`;
      const reference = translate(lang, 'reference', {}, state.source);
      const drive = state.drive ?? { speed: state.zone.speed, target: state.zone.speed };
      const shown = drive.speed > drive.target ? translate(lang, 'fan.towards', drive) : drive.speed;
      const speed = drive.speed ? translate(lang, 'fan.speed', { speed: shown }) : translate(lang, 'fan.off');
      process.stdout.write(`\r\x1b[K  ${String(state.value).padStart(4)} ${state.unit}  ${String(state.pct).padStart(3)} % ${reference}  ${badge}  ${speed}`);
    }
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    await session.stop();
    await shutdownBluetooth();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  await session.start();
}

async function scanCommand(source: Source): Promise<void> {
  console.log(`Searching for ${source === 'power' ? 'power sensors and trainers' : 'heart rate straps'} for 8 s…`);
  const devices = await scan(source, {
    onEvent: (e) => e.type === 'adapter' && !['poweredOn', 'unknown', 'resetting'].includes(e.state) && console.log(`Bluetooth: ${e.state}`),
  });
  if (!devices.length) console.log('Nothing found. Wake the sensor up (pedal, or wear the strap) and try again.');
  for (const d of devices) console.log(`${(d.name ?? 'unnamed').padEnd(28)} ${d.id}  ${d.rssi ?? ''} dBm`);
  await shutdownBluetooth();
  process.exit(0);
}

async function main(): Promise<void> {
  const { positionals, values } = parse();
  if (values.help) return void console.log(USAGE);
  if (values.version) return void console.log(VERSION);
  const source = (values.source ?? 'hr') as Source;
  if (!SOURCES.includes(source)) throw new Error('--source must be "power" or "hr"');

  switch (positionals[0]) {
    case undefined:
    case 'app':
      return launchDesktop({
        demo: values.demo,
        sandbox: values.sandbox,
        browser: values.browser,
        store: values.sandbox ? fileStore(join(configDir(), 'sandbox.json')) : undefined,
      });
    case 'run':
      return runHeadless(values);
    case 'scan':
      return scanCommand(source);
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

main().catch((err: Error) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
