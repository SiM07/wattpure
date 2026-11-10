/**
 * Standard Bluetooth LE sensors:
 *  - power: Cycling Power service (0x1818), Cycling Power Measurement characteristic (0x2A63),
 *    exposed by smart trainers such as the Tacx Neo and by power meters
 *  - heart rate: Heart Rate service (0x180D), Heart Rate Measurement characteristic (0x2A37)
 */
import type { AdapterState, Noble, Peripheral } from '@stoprocent/noble';
import type { DeviceRef, SensorDevice, Source } from './shared/types.ts';

export interface Measurement {
  value: number;
  /** Skin contact reported by the heart rate strap; null when unknown. */
  contact: boolean | null;
}

export type SensorEvent =
  | { type: 'adapter'; state: AdapterState }
  | { type: 'searching'; attempt: number }
  | { type: 'notFound'; attempt: number; retryInMs: number }
  | { type: 'connecting' | 'connected' | 'disconnected'; device: DeviceRef }
  | { type: 'error'; device: DeviceRef; message: string };

export interface SensorOptions {
  signal: AbortSignal;
  onValue: (m: Measurement) => void;
  onEvent: (e: SensorEvent) => void;
}

/** Heart Rate Measurement: bit 0 of the flags = 16-bit value. */
export function parseHr(buf: Buffer): number {
  return buf[0]! & 0x01 ? buf.readUInt16LE(1) : buf[1]!;
}

/** Full Heart Rate Measurement: bits 1-2 of the flags = skin contact. */
export function parseHrMeasurement(buf: Buffer): Measurement {
  const flags = buf[0]!;
  const contactSupported = (flags & 0x04) !== 0;
  return { value: parseHr(buf), contact: contactSupported ? (flags & 0x02) !== 0 : null };
}

/** Cycling Power Measurement: 16-bit flags, then instantaneous power (int16, watts). */
export function parsePower(buf: Buffer): number {
  return buf.readInt16LE(2);
}

export const SENSORS: Record<Source, { service: string; characteristic: string; parse: (buf: Buffer) => Measurement }> = {
  power: { service: '1818', characteristic: '2a63', parse: (buf) => ({ value: parsePower(buf), contact: null }) },
  hr: { service: '180d', characteristic: '2a37', parse: parseHrMeasurement },
};

/** Delay between two searches when the sensor cannot be found. */
export const RETRY_DELAY_MS = 5000;
const SEARCH_TIMEOUT_MS = 10000;

let noblePromise: Promise<Noble> | null = null;

/**
 * Loads noble on demand: importing it starts the Bluetooth stack, which tests and demo mode
 * do not need. On Linux, BlueZ is used over D-Bus: no root, no need to stop bluetoothd.
 */
export function getNoble(): Promise<Noble> {
  if (process.platform === 'linux') process.env.NOBLE_BINDINGS ??= 'dbus';
  noblePromise ??= import('@stoprocent/noble').then((m) => m.default as unknown as Noble);
  return noblePromise;
}

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${label}: timed out`)), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Waits for the Bluetooth adapter to be ready. Reports to `onEvent` while it is off,
 * unauthorized or missing, and checks again regularly.
 */
async function waitAdapter(noble: Noble, signal: AbortSignal | undefined, onEvent: (e: SensorEvent) => void): Promise<void> {
  let reported: AdapterState | null = null;
  while (noble.state !== 'poweredOn') {
    if (noble.state !== reported) {
      reported = noble.state;
      onEvent({ type: 'adapter', state: noble.state });
    }
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        noble.removeListener('stateChange', finish);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        finish();
        reject(abortError());
      };
      const timer = setTimeout(finish, 2000);
      noble.on('stateChange', finish);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  if (reported) onEvent({ type: 'adapter', state: 'poweredOn' });
}

/** Lists the devices advertising the sensor's service during `timeoutMs`, strongest signal first. */
export async function scan(
  kind: Source,
  { timeoutMs = 8000, signal, onEvent = () => {} }: { timeoutMs?: number; signal?: AbortSignal; onEvent?: (e: SensorEvent) => void } = {},
): Promise<SensorDevice[]> {
  const noble = await getNoble();
  const { service } = SENSORS[kind];
  await waitAdapter(noble, signal, onEvent);
  const found = new Map<string, SensorDevice>();
  const onDiscover = (p: Peripheral) =>
    found.set(p.id, { id: p.id, name: p.advertisement.localName ?? found.get(p.id)?.name ?? null, rssi: p.rssi ?? null });
  noble.on('discover', onDiscover);
  try {
    await noble.startScanningAsync([service], true);
    await sleep(timeoutMs, signal).catch(() => {});
  } finally {
    await noble.stopScanningAsync().catch(() => {});
    noble.removeListener('discover', onDiscover);
  }
  return [...found.values()].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
}

/** Finds the configured device (by id, then by name) or, without one, the first device advertising the service. */
function findPeripheral(noble: Noble, service: string, hint: DeviceRef | null, signal: AbortSignal): Promise<Peripheral | null> {
  const matches = (p: Peripheral) => !hint || p.id === hint.id || (hint.name !== null && p.advertisement.localName === hint.name);
  return new Promise((resolve) => {
    let done = false;
    const finish = async (peripheral: Peripheral | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      noble.removeListener('discover', onDiscover);
      signal.removeEventListener('abort', onAbort);
      await noble.stopScanningAsync().catch(() => {});
      resolve(peripheral);
    };
    const onDiscover = (p: Peripheral) => void (matches(p) && finish(p));
    const onAbort = () => void finish(null);
    const timer = setTimeout(() => void finish(null), SEARCH_TIMEOUT_MS);
    noble.on('discover', onDiscover);
    signal.addEventListener('abort', onAbort, { once: true });
    noble.startScanningAsync([service], false).catch(() => finish(null));
  });
}

/**
 * Connects to the sensor and calls `onValue` for each measurement.
 * Searches again every RETRY_DELAY_MS and reconnects on its own until `signal` is aborted.
 */
export async function streamSensor(kind: Source, hint: DeviceRef | null, { signal, onValue, onEvent }: SensorOptions): Promise<void> {
  const noble = await getNoble();
  const { service, characteristic, parse } = SENSORS[kind];
  let attempt = 0;
  try {
    while (!signal.aborted) {
      await waitAdapter(noble, signal, onEvent);
      attempt++;
      onEvent({ type: 'searching', attempt });
      const peripheral = await findPeripheral(noble, service, hint, signal);
      if (signal.aborted) break;
      if (!peripheral) {
        onEvent({ type: 'notFound', attempt, retryInMs: RETRY_DELAY_MS });
        await sleep(RETRY_DELAY_MS, signal);
        continue;
      }

      const device: DeviceRef = { id: peripheral.id, name: peripheral.advertisement.localName ?? null };
      let onAbort: (() => void) | undefined;
      try {
        onEvent({ type: 'connecting', device });
        const disconnected = new Promise((resolve) => peripheral.once('disconnect', resolve));
        await withTimeout(peripheral.connectAsync(), 15000, 'connection');
        const { characteristics } = await withTimeout(
          peripheral.discoverSomeServicesAndCharacteristicsAsync([service], [characteristic]),
          10000,
          'service discovery',
        );
        const char = characteristics.find((c) => c.uuid === characteristic);
        if (!char) throw new Error(`characteristic ${characteristic} missing`);
        char.on('data', (data: Buffer) => {
          let m: Measurement;
          try {
            m = parse(data);
          } catch {
            return; // truncated or corrupted frame: wait for the next one
          }
          onValue(m);
        });
        await char.subscribeAsync();
        attempt = 0;
        onEvent({ type: 'connected', device });
        const aborted = new Promise<void>((resolve) => {
          onAbort = resolve;
          signal.addEventListener('abort', onAbort, { once: true });
        });
        await Promise.race([disconnected, aborted]);
        if (!signal.aborted) onEvent({ type: 'disconnected', device });
      } catch (err) {
        if (!signal.aborted) onEvent({ type: 'error', device, message: (err as Error).message });
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
        await peripheral.disconnectAsync().catch(() => {});
      }
      if (!signal.aborted) await sleep(2000, signal);
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') throw err;
  }
}

export async function shutdownBluetooth(): Promise<void> {
  if (!noblePromise) return;
  const noble = await noblePromise;
  await noble.stopScanningAsync().catch(() => {});
  noble.stop();
}
