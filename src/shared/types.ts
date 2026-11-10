/**
 * Types shared by the Node process and the web UI: the contract of the local HTTP API.
 * This file must not import any Node API, it is also compiled for the browser.
 */

export type Source = 'power' | 'hr';
export type Language = 'en' | 'fr';
export type Level = 'info' | 'ok' | 'warn' | 'error';
/** Airflow direction while riding: as set on the fan, or pointed at one angle. */
export type AirDirection = 'keep' | 'fixed';
/** What oscillation dyson-control drives on a fan: on/off only, or between two angles as well. */
export type OscillationKind = 'none' | 'basic' | 'advanced';
/** Range the fan reports, in degrees from 5 to 355; both equal when it points one way. */
export interface Angles {
  lower: number;
  upper: number;
}

/** How long the fan stays up after an effort: off = follows the zones directly. */
export type Cooldown = 'off' | 'short' | 'normal' | 'long';

export interface DeviceRef {
  id: string;
  name: string | null;
}

export interface ZoneSetting {
  name?: string;
  fromPct: number;
  color: string;
}

/**
 * A Dyson machine as stored in the settings file: what dyson-control needs to reach it on the
 * local network. `apPasswordHash` is the password of the machine's own MQTT broker.
 */
export interface FanMachine {
  serialNumber: string;
  type: string;
  apPasswordHash: string;
  name?: string;
  productName?: string;
  variant?: string;
  model?: string;
  mqttRootTopicLevel?: string;
  firmwareCapabilities?: string[];
}

export interface Config {
  fan: FanMachine | null;
  /** IP address or host name of the fan; null = found on the network by mDNS. */
  fanHost: string | null;
  source: Source;
  /** Fan speed for each heart rate zone: 0 = off, 1-10. */
  hrSpeeds: number[];
  /** Fan speed for each power zone: 0 = off, 1-10. */
  powerSpeeds: number[];
  /** How long the fan stays up after an effort, and how much it smooths zone changes. */
  cooldown: Cooldown;
  /** Airflow direction while riding. */
  airDirection: AirDirection;
  /** Angle the air is blown at in "fixed" mode, 5-355 degrees clockwise; null = middle of the fan's range. */
  airAngle: number | null;
  /** Turn the heater off while riding (a Hot+Cool fan would blow warm air otherwise). */
  coolOnly: boolean;
  restoreOnExit: boolean;
  language: Language | null;
  powerMeter: DeviceRef | null;
  ftp: number;
  powerSmoothingS: number;
  hysteresisW: number;
  powerZones: ZoneSetting[] | null;
  hrm: DeviceRef | null;
  maxHr: number;
  hysteresisBpm: number;
  hrZones: ZoneSetting[] | null;
}

/** What the UI may know about the fan: the local password stays in the Node process. */
export interface PublicFan {
  serialNumber: string;
  type: string;
  name: string | null;
  productName: string | null;
  /** The fan can be pointed at an angle. */
  aimable: boolean;
}

/** Config as exposed to the UI. */
export type PublicConfig = Omit<Config, 'fan'> & { fan: PublicFan | null };

/** What the engine is doing; the UI turns it into a sentence with the translation tables. */
export type StatusCode =
  | 'unconfigured'
  | 'stopped'
  | 'starting'
  | 'suspended'
  | 'bluetoothStarting'
  | 'bluetoothOff'
  | 'bluetoothUnauthorized'
  | 'bluetoothUnsupported'
  | 'bluetoothFailed'
  | 'searching'
  | 'notFound'
  | 'connecting'
  | 'waiting'
  | 'live'
  | 'disconnected'
  | 'connectError'
  | 'noData'
  | 'noContact'
  | 'idle'
  | 'idleOff';

export interface Status {
  code: StatusCode;
  level: Level;
  /** Values inserted in the message: device name, error text… */
  params: Record<string, string | number>;
}

/** Why the fan cannot be driven: wrong password, not found or not answering, unknown model. */
export type FanProblem = 'unauthorized' | 'unreachable' | 'unsupported';

/** What the fan reports, and whether it can be reached. */
export interface FanInfo {
  /** null while connecting: before the first answer, or after a failure that may be transient. */
  ok: boolean | null;
  problem: FanProblem | null;
  power: boolean | null;
  /** 1-10; null in auto mode or when unknown. */
  speed: number | null;
  auto: boolean | null;
  heating: boolean | null;
  oscillating: boolean | null;
  angles: Angles | null;
  temperatureC: number | null;
  humidity: number | null;
  pm25: number | null;
}

export interface PublicZone {
  number: number;
  name: string;
  color: string;
  /** Lower bound in watts or bpm. */
  from: number;
  /** Fan speed for this zone: 0 = off, 1-10. */
  speed: number;
}

export interface SessionState {
  running: boolean;
  demo: boolean;
  testing: boolean;
  configured: boolean;
  source: Source;
  unit: 'W' | 'bpm';
  reference: number;
  zones: PublicZone[];
  status: Status;
  device: DeviceRef | null;
  value: number | null;
  pct: number | null;
  zone: PublicZone | null;
  /** Direction search in progress (`fine`: the refine step): the fan sways around `center`, now pointing at `angle`. */
  scan: { fine: boolean; center: number; angle: number; span: number } | null;
  /** Speed asked of the fan by the cooling curve, and the speed of the current zone it heads for. */
  drive: { speed: number; target: number } | null;
  fan: FanInfo;
  machine: PublicFan | null;
}

/** A machine of the Dyson account, as offered in the setup. */
export interface MachineOption extends PublicFan {
  /** WattPure knows how to drive it. */
  supported: boolean;
}

export interface SensorDevice extends DeviceRef {
  rssi: number | null;
}

export interface FanCheck {
  /** Whether the fan answered on the local network ("local") or not at all. */
  hostType: 'local' | 'remote' | null;
  fan: FanInfo;
}

export interface AppInfo {
  version: string;
  mode: 'window' | 'browser';
  demo: boolean;
  platform: string;
  configPath: string;
}

export interface StateResponse {
  app: AppInfo;
  config: PublicConfig;
  session: SessionState;
}

/** Error codes the UI knows how to explain; other errors are shown as is. */
export type ErrorCode =
  | 'noAccount'
  | 'loginFailed'
  | 'tooManyCodes'
  | 'cloudUnreachable'
  | 'noMachine'
  | 'fanUnauthorized'
  | 'fanUnreachable'
  | 'fanUnsupported'
  | 'notConfigured'
  | 'notRiding'
  | 'invalidSettings'
  | 'bluetooth';

export interface ApiError {
  error: string;
  code?: ErrorCode;
}

/** Server-sent events on /api/events. */
export interface EventMap {
  state: SessionState;
  config: PublicConfig;
  test: PublicZone;
}
