/**
 * In-memory stand-ins for the Dyson fan, the Dyson account and the Bluetooth scan.
 * Used by the tests and by `--sandbox`, which runs the whole app without any hardware.
 */
import { CloudError, type DysonCloud, type Fan, type FanCommand, FanError, type FanEvents, type FanFactory, type FanState, type RoomReadings } from './dyson.ts';
import type { ScanFn } from './server.ts';
import type { FanMachine, SensorDevice } from './shared/types.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const SANDBOX_MACHINE: FanMachine = {
  serialNumber: 'SBX-EU-SANDBOX1',
  type: '527',
  apPasswordHash: 'sandbox-password',
  name: 'Pain cave fan',
  productName: 'Dyson Purifier Hot+Cool',
  firmwareCapabilities: ['AdvanceOscillationDay1'],
};

export class FakeFan implements Fan {
  current: FanState = { power: false, auto: false, speed: 3, heat: 'off', heating: false, night: false, oscillating: false, angles: { lower: 24, upper: 114 } };
  /** What `detectMachine` resolves with. */
  detected: FanMachine | null = null;
  room: RoomReadings = { temperatureC: 19.2, humidity: 51, pm25: 9 };
  /** Every command, for assertions. */
  readonly commands: FanCommand[] = [];
  reachable = true;
  /** Simulates a wrong local password. */
  refuse = false;
  /** Number of upcoming calls that fail with a network error. */
  failNext = 0;
  /** Number of state reads. */
  reads = 0;
  connected = false;
  hostType: 'local' | null = null;
  private events: FanEvents = {};

  listen(events: FanEvents = {}): this {
    this.events = events;
    return this;
  }

  private guard(): void {
    if (this.refuse) throw new FanError('bad username or password', 'unauthorized');
    if (this.failNext > 0) {
      this.failNext--;
      throw new FanError('connection reset', 'unreachable');
    }
    if (!this.reachable) throw new FanError('the machine answered no search', 'unreachable');
  }

  async connect(): Promise<void> {
    this.guard();
    this.connected = true;
    this.hostType = 'local';
  }

  async state(): Promise<FanState> {
    this.reads++;
    this.guard();
    return structuredClone(this.current);
  }

  async readings(): Promise<RoomReadings> {
    this.guard();
    return { ...this.room };
  }

  async apply(command: FanCommand): Promise<void> {
    this.guard();
    this.commands.push(command);
    const next = { ...this.current };
    if (command.speed !== undefined) Object.assign(next, { speed: command.speed, auto: false, power: true });
    if (command.auto !== undefined) Object.assign(next, { auto: command.auto, power: true });
    if (command.heat !== undefined) Object.assign(next, { heat: command.heat, heating: command.heat === 'heat' });
    if (command.night !== undefined) next.night = command.night;
    if (command.oscillate !== undefined) next.oscillating = command.oscillate;
    if (command.angles !== undefined) Object.assign(next, { angles: command.angles, oscillating: true });
    if (command.power !== undefined) next.power = command.power;
    this.current = next;
    this.events.onState?.(structuredClone(next));
  }

  async detectMachine(): Promise<FanMachine | null> {
    this.guard();
    return this.detected;
  }

  async close(): Promise<void> {
    this.connected = false;
    this.hostType = null;
  }
}

/** Factory always returning the same fake fan. */
export function fakeFanFactory(fan = new FakeFan()): FanFactory {
  return (_machine, _host, events) => fan.listen(events);
}

/** Fake Dyson account: a code is "emailed", any 6-digit code and non-empty password log in. */
export function fakeDysonCloud(machines: FanMachine[] = [SANDBOX_MACHINE], delayMs = 600): DysonCloud {
  return {
    requestCode: async () => (await sleep(delayMs), 'sandbox-challenge'),
    machines: async ({ otpCode, password }) => {
      await sleep(delayMs);
      if (!/^\d{6}$/.test(otpCode ?? '') || !password) throw new CloudError('wrong code or password', 'loginFailed');
      return machines;
    },
  };
}

export const fakeScan: ScanFn = async (kind) => {
  await sleep(1500);
  const devices: SensorDevice[] =
    kind === 'power'
      ? [
          { id: 'sandbox-neo', name: 'Tacx Neo 2T 12345', rssi: -48 },
          { id: 'sandbox-pm', name: 'Assioma 0042', rssi: -71 },
        ]
      : [{ id: 'sandbox-hrm', name: 'HRM-Pro+:123456', rssi: -55 }];
  return devices;
};
