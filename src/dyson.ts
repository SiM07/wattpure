/**
 * Dyson fans, through dyson-control (https://github.com/cheziyi/dyson-control).
 *
 * - Setup, once: the Dyson account (email, emailed code, password) lists the machines with the
 *   password of their own MQTT broker. Only the machine and that password are kept.
 * - Then everything goes through the fan's broker on the local network, found by mDNS or at a
 *   fixed address: no account, no cloud.
 */
import {
  DysonError,
  type DysonMachine,
  EnvironmentalCareClient,
  type EnvironmentalCareControl,
  type EnvironmentalCareSensors,
  type EnvironmentalCareState,
  getMachines,
  login,
  requestLoginCode,
} from 'dyson-control';
import type { Angles, FanMachine, FanProblem, MachineOption, OscillationKind } from './shared/types.ts';

/** What the engine reads from the fan. */
export interface FanState {
  power: boolean;
  auto: boolean;
  /** 1-10; null in auto mode. */
  speed: number | null;
  /** null for a fan without a heater. */
  heat: 'off' | 'heat' | null;
  heating: boolean | null;
  night: boolean | null;
  /** null for a fan that does not oscillate. */
  oscillating: boolean | null;
  angles: Angles | null;
}

export interface RoomReadings {
  temperatureC: number | null;
  humidity: number | null;
  pm25: number | null;
}

/** What the engine asks the fan; only the given fields change. */
export interface FanCommand {
  power?: boolean;
  speed?: number;
  auto?: boolean;
  heat?: 'off' | 'heat';
  night?: boolean;
  /** Oscillation on or off; `angles` (when the fan takes them) also turns it on. */
  oscillate?: boolean;
  angles?: Angles;
}

/** What the engine needs from a fan; implemented by DysonFan and by test fakes. */
export interface Fan {
  /** Opens the connection, or does nothing when it is open. */
  connect(): Promise<void>;
  state(): Promise<FanState>;
  readings(): Promise<RoomReadings>;
  apply(command: FanCommand): Promise<void>;
  close(): Promise<void>;
  /**
   * The machine with the firmware capabilities its state reveals, when the stored one lacks them
   * (a fan typed by hand or imported does not carry them); null when nothing is missing.
   */
  detectMachine(): Promise<FanMachine | null>;
  /** Whether the open connection is on the local network. */
  readonly hostType: 'local' | 'remote' | null;
}

export interface FanEvents {
  /** The fan sent its state by itself (after a command, a button press on the fan…). */
  onState?: (state: FanState) => void;
}

export type FanFactory = (machine: FanMachine, host: string | null, events?: FanEvents) => Fan;

export class FanError extends Error {
  readonly problem: FanProblem;

  constructor(message: string, problem: FanProblem, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FanError';
    this.problem = problem;
  }
}

/** Turns a dyson-control error into what the UI explains: refused password, or no answer. */
export function fanError(err: unknown): FanError {
  if (err instanceof FanError) return err;
  const status = err instanceof DysonError ? err.httpStatusCode : null;
  const message = (err as Error)?.message ?? String(err);
  return new FanError(message, status === 401 ? 'unauthorized' : 'unreachable', { cause: err });
}

export function toFanState(s: EnvironmentalCareState): FanState {
  return {
    power: s.fanPower,
    auto: s.autoMode ?? false,
    speed: s.fanSpeed ?? null,
    heat: s.heatMode ?? null,
    heating: s.heatState === null || s.heatState === undefined ? null : s.heatState === 'heat',
    night: s.nightMode ?? null,
    oscillating: s.oscillationMode === null || s.oscillationMode === undefined ? null : s.oscillationMode === 'on' || s.oscillationMode === 'idleOn',
    angles: s.oscillationAngles ? { lower: s.oscillationAngles.lowerInDegrees, upper: s.oscillationAngles.upperInDegrees } : null,
  };
}

/** Firmware capability that lets a fan oscillate between two angles of its own (`osal`, `osau`). */
export const ANGLES_CAPABILITY = 'AdvanceOscillationDay1';

/** Adds the angle capability to a machine whose fan reports angles; null when nothing changes. */
export function withDetectedCapabilities(machine: FanMachine, fields: Record<string, string>): FanMachine | null {
  if (machine.firmwareCapabilities?.length) return null;
  if (!('osal' in fields && 'osau' in fields)) return null;
  const upgraded = { ...machine, firmwareCapabilities: [ANGLES_CAPABILITY] };
  return oscillationKind(upgraded) === 'advanced' ? upgraded : null;
}

/** What oscillation dyson-control drives on this machine (the constructor sends nothing). */
export function oscillationKind(machine: FanMachine): OscillationKind {
  try {
    const { oscillation, oscillationAngles } = new EnvironmentalCareClient({ ...machine }, { host: '127.0.0.1' }).capabilities;
    if (oscillation === 'basic') return 'basic';
    if (oscillation === 'advanced' && oscillationAngles) return 'advanced';
    return 'none';
  } catch {
    return 'none';
  }
}

export function toReadings(s: EnvironmentalCareSensors): RoomReadings {
  const round = (n: number | null | undefined, digits = 0) => (typeof n === 'number' && Number.isFinite(n) ? +n.toFixed(digits) : null);
  return { temperatureC: round(s.temperatureInC, 1), humidity: round(s.humidityInPercent), pm25: round(s.pm25InUgPerM3) };
}

/** Command in dyson-control terms. `fanPower` goes last: with `false`, the fan stays off. */
export function toControl(command: FanCommand, canHeat: boolean, oscillation: OscillationKind = 'basic'): EnvironmentalCareControl {
  const control: EnvironmentalCareControl = {};
  if (oscillation !== 'none' && command.oscillate !== undefined) {
    control.oscillationMode = command.oscillate ? 'on' : 'off';
    // An angle fan is only switched on beside its angles (both equal: one fixed direction).
    if (command.oscillate && oscillation === 'advanced' && command.angles) {
      control.oscillationAngles = { lowerInDegrees: command.angles.lower, upperInDegrees: command.angles.upper };
    }
  }
  if (command.auto !== undefined) control.autoMode = command.auto;
  if (command.speed !== undefined) control.fanSpeed = command.speed as EnvironmentalCareControl['fanSpeed'];
  if (command.night !== undefined) control.nightMode = command.night;
  if (command.heat !== undefined && canHeat) control.heatMode = command.heat;
  if (command.power !== undefined) control.fanPower = command.power;
  return control;
}

const asMachine = (fan: FanMachine): DysonMachine => ({ ...fan });

/** A Dyson fan reached on the local network. */
export class DysonFan implements Fan {
  private readonly client: EnvironmentalCareClient;
  private readonly canHeat: boolean;
  private readonly oscillation: OscillationKind;
  private readonly machine: FanMachine;

  constructor(machine: FanMachine, host: string | null, { onState }: FanEvents = {}) {
    this.machine = machine;
    try {
      this.client = new EnvironmentalCareClient(asMachine(machine), {
        ...(host ? { host } : {}),
        timeoutInMs: 6000,
        onState: onState && ((state) => onState(toFanState(state))),
      });
    } catch (err) {
      throw new FanError((err as Error).message, 'unsupported', { cause: err });
    }
    this.canHeat = this.client.capabilities.heatModes.length > 0;
    this.oscillation = oscillationKind(machine);
  }

  get hostType() {
    return this.client.hostType;
  }

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      throw fanError(err);
    }
  }

  connect(): Promise<void> {
    return this.call(() => this.client.connect());
  }

  state(): Promise<FanState> {
    return this.call(async () => toFanState(await this.client.getState()));
  }

  readings(): Promise<RoomReadings> {
    return this.call(async () => toReadings(await this.client.getSensors()));
  }

  apply(command: FanCommand): Promise<void> {
    return this.call(() => this.client.setState(toControl(command, this.canHeat, this.oscillation)));
  }

  detectMachine(): Promise<FanMachine | null> {
    if (this.machine.firmwareCapabilities?.length) return Promise.resolve(null);
    return this.call(async () => withDetectedCapabilities(this.machine, await this.client.getProductState()));
  }

  close(): Promise<void> {
    return this.client.disconnect().catch(() => {});
  }
}

export const createDysonFan: FanFactory = (machine, host, events) => new DysonFan(machine, host, events);

/** Whether dyson-control knows how to drive this machine (the constructor sends nothing). */
export function isSupported(machine: FanMachine): boolean {
  try {
    new EnvironmentalCareClient(asMachine(machine), { host: '127.0.0.1' });
    return true;
  } catch {
    return false;
  }
}

/** The Dyson account calls of the setup. */
export interface DysonCloud {
  /** Has Dyson email a code; resolves with the challenge to send back, or null when no code is needed. */
  requestCode(email: string, country: string): Promise<string | null>;
  /** Logs in and lists the fans of the account, with their local password. */
  machines(credentials: { email: string; password: string; country: string; challengeId: string | null; otpCode: string | null }): Promise<FanMachine[]>;
}

export const USER_AGENT = 'android client';

/** Account error codes the UI explains. */
export type CloudErrorCode = 'noAccount' | 'loginFailed' | 'tooManyCodes' | 'cloudUnreachable';

export class CloudError extends Error {
  readonly code: CloudErrorCode;

  constructor(message: string, code: CloudErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CloudError';
    this.code = code;
  }
}

function cloudError(err: unknown, step: 'code' | 'login'): CloudError {
  const status = err instanceof DysonError ? err.httpStatusCode : null;
  const message = (err as Error)?.message ?? String(err);
  if (status === 429) return new CloudError(message, 'tooManyCodes', { cause: err });
  if (status === 401 || status === 400 || status === 403) return new CloudError(message, step === 'code' ? 'noAccount' : 'loginFailed', { cause: err });
  return new CloudError(message, 'cloudUnreachable', { cause: err });
}

/** Keeps what WattPure stores about a machine of the account. */
export function toFanMachine(machine: DysonMachine): FanMachine | null {
  if (!machine.apPasswordHash) return null;
  const { serialNumber, type, apPasswordHash, name, productName, variant, model, mqttRootTopicLevel, firmwareCapabilities } = machine;
  return {
    serialNumber,
    type,
    apPasswordHash,
    ...(name && { name }),
    ...(productName && { productName }),
    ...(variant && { variant }),
    ...(model && { model }),
    ...(mqttRootTopicLevel && { mqttRootTopicLevel }),
    ...(firmwareCapabilities?.length && { firmwareCapabilities }),
  };
}

export const dysonCloud: DysonCloud = {
  async requestCode(email, country) {
    try {
      return await requestLoginCode({ email, country, userAgent: USER_AGENT });
    } catch (err) {
      throw cloudError(err, 'code');
    }
  },
  async machines({ email, password, country, challengeId, otpCode }) {
    let all: DysonMachine[];
    try {
      const account = await login(challengeId && otpCode ? { email, password, country, challengeId, otpCode, userAgent: USER_AGENT } : { email, password, country, userAgent: USER_AGENT });
      all = await getMachines(account, { userAgent: USER_AGENT });
    } catch (err) {
      throw cloudError(err, 'login');
    }
    return all.filter((m) => m.category === undefined || m.category === 'environmentalCare').map(toFanMachine).filter((m): m is FanMachine => m !== null);
  },
};

export function machineOption(machine: FanMachine, supported = isSupported(machine)): MachineOption {
  return {
    serialNumber: machine.serialNumber,
    type: machine.type,
    name: machine.name ?? null,
    productName: machine.productName ?? null,
    aimable: oscillationKind(machine) === 'advanced',
    supported,
  };
}
