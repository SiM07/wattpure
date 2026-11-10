/** Test doubles for the engine: a sensor driven by hand and a ready-to-use config. */
import type { SensorEvent, SensorOptions } from '../src/ble.ts';
import { DEFAULTS } from '../src/config.ts';
import type { Metric, SensorFn } from '../src/engine.ts';
import type { Config } from '../src/shared/types.ts';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const configured = (patch: Partial<Config> = {}): Config => ({
  ...DEFAULTS,
  fan: { serialNumber: 'TST-EU-TEST001', type: '527', apPasswordHash: 'secret-hash', name: 'Test fan', firmwareCapabilities: ['AdvanceOscillationDay1'] },
  cooldown: 'off', // the fan follows the zones directly; the cooling curve has its own tests
  ...patch,
});

export function manualSensor() {
  let options: SensorOptions | null = null;
  const runs: Metric[] = [];
  const fn: SensorFn = (metric, o) =>
    new Promise<void>((resolve) => {
      runs.push(metric);
      options = o;
      o.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  return {
    fn,
    runs,
    event: (e: SensorEvent) => options!.onEvent(e),
    connect: (name = 'Neo') => options!.onEvent({ type: 'connected', device: { id: 'neo', name } }),
    value: (value: number, contact: boolean | null = null) => options!.onValue({ value, contact }),
    get aborted() {
      return options?.signal.aborted ?? false;
    },
  };
}

/** Waits until `predicate` holds, polling every 10 ms. */
export async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(10);
  }
}
