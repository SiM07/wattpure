import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { oscillationKind } from './dyson.ts';
import type { AirDirection, Config, Cooldown, DeviceRef, FanMachine, Language, PublicConfig, Source } from './shared/types.ts';

/** Config directory: %APPDATA% on Windows, $XDG_CONFIG_HOME or ~/.config elsewhere. */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'wattpure');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'wattpure');
}

export const CONFIG_PATH = process.env.WATTPURE_CONFIG ?? join(configDir(), 'config.json');

export const SOURCES: readonly Source[] = ['power', 'hr'];
export const LANGUAGES: readonly Language[] = ['en', 'fr'];
export const COOLDOWNS: readonly Cooldown[] = ['off', 'short', 'normal', 'long'];
export const AIR_DIRECTIONS: readonly AirDirection[] = ['keep', 'fixed'];
export const MAX_SPEED = 10;

export const DEFAULTS: Config = {
  fan: null,
  fanHost: null, // null = found on the network
  source: 'hr',
  hrSpeeds: [2, 4, 6, 8, 10],
  powerSpeeds: [2, 3, 5, 7, 9, 10],
  cooldown: 'normal',
  airDirection: 'keep',
  airAngle: null,
  coolOnly: true,
  restoreOnExit: true,
  language: null, // null = follow the system language

  powerMeter: null, // null = first power sensor found
  ftp: 250,
  powerSmoothingS: 3, // rolling average, the usual 3 s power
  hysteresisW: 5,
  powerZones: null, // null = default zones (zones.ts)

  hrm: null, // null = first heart rate strap found
  maxHr: 190,
  hysteresisBpm: 3,
  hrZones: null,
};

/** Bounds of the numeric settings editable from the UI. */
const RANGES = {
  ftp: [50, 2000],
  maxHr: [100, 240],
  powerSmoothingS: [1, 30],
  hysteresisW: [0, 100],
  hysteresisBpm: [0, 20],
} as const satisfies Partial<Record<keyof Config, readonly [number, number]>>;

export interface ConfigStore {
  readonly path: string;
  load(): Config;
  save(cfg: Config): void;
}

export function load(path = CONFIG_PATH): Config {
  let saved: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      saved = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`unreadable config file (${path}): ${(err as Error).message}`, { cause: err });
    }
  }
  // Earlier development versions also swept the air: only the fixed direction remains.
  if ('oscillation' in saved) {
    saved.airDirection ??= saved.oscillation === 'fixed' ? 'fixed' : 'keep';
    delete saved.oscillation;
  }
  delete saved.oscillationAngles;
  return { ...DEFAULTS, ...saved } as Config;
}

/** Atomic write, readable by the user only (it holds the fan's local password). */
export function save(cfg: Config, path = CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

export function fileStore(path = CONFIG_PATH): ConfigStore {
  return { path, load: () => load(path), save: (cfg) => save(cfg, path) };
}

/** A fan with its local password is set: it can be driven. */
export function isComplete(cfg: Config): boolean {
  return Boolean(cfg.fan?.serialNumber && cfg.fan.type && cfg.fan.apPasswordHash);
}

/** What the UI may know about the config: the fan's password stays in the Node process. */
export function publicConfig(cfg: Config): PublicConfig {
  const { fan, ...rest } = cfg;
  return { ...rest, fan: fan && publicFan(fan) };
}

export function publicFan(fan: FanMachine) {
  return { serialNumber: fan.serialNumber, type: fan.type, name: fan.name ?? null, productName: fan.productName ?? null, aimable: oscillationKind(fan) === 'advanced' };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function device(value: unknown, key: string): DeviceRef | null {
  if (value === null) return null;
  if (!isObject(value) || typeof value.id !== 'string') throw new Error(`invalid ${key}`);
  return { id: value.id, name: typeof value.name === 'string' ? value.name : null };
}

function speeds(value: unknown, key: string): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) throw new Error(`invalid ${key}`);
  return value.map((v) => {
    const n = Number(v);
    if (v === null || v === '' || !Number.isInteger(n) || n < 0 || n > MAX_SPEED) throw new Error(`${key}: speeds go from 0 (off) to ${MAX_SPEED}`);
    return n;
  });
}

/** IPv4 address or host name, as typed in the settings. */
export function host(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(value.trim())) throw new Error('invalid fan address');
  return value.trim();
}

/**
 * Validates a partial update coming from the UI.
 * Returns the cleaned patch (numbers coerced) or throws a readable error.
 * The fan itself is not accepted here: it is set by the setup routes.
 */
export function validatePatch(patch: unknown): Partial<Config> {
  if (!isObject(patch)) throw new Error('invalid settings');
  const clean: Partial<Config> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key in RANGES) {
      const [min, max] = RANGES[key as keyof typeof RANGES];
      const n = Number(value);
      if (value === null || value === '' || !Number.isFinite(n) || n < min || n > max) {
        throw new Error(`${key} must be between ${min} and ${max}`);
      }
      clean[key as keyof typeof RANGES] = Math.round(n);
    } else if (key === 'source') {
      if (!SOURCES.includes(value as Source)) throw new Error('source must be "power" or "hr"');
      clean.source = value as Source;
    } else if (key === 'language') {
      if (value !== null && !LANGUAGES.includes(value as Language)) throw new Error(`language must be one of ${LANGUAGES.join(', ')}`);
      clean.language = value as Language | null;
    } else if (key === 'cooldown') {
      if (!COOLDOWNS.includes(value as Cooldown)) throw new Error(`cooldown must be one of ${COOLDOWNS.join(', ')}`);
      clean.cooldown = value as Cooldown;
    } else if (key === 'airDirection') {
      if (!AIR_DIRECTIONS.includes(value as AirDirection)) throw new Error(`airDirection must be one of ${AIR_DIRECTIONS.join(', ')}`);
      clean.airDirection = value as AirDirection;
    } else if (key === 'airAngle') {
      const n = Number(value);
      if (value !== null && (value === '' || !Number.isInteger(n) || n < 5 || n > 355)) throw new Error('airAngle goes from 5 to 355 degrees');
      clean.airAngle = value === null ? null : n;
    } else if (key === 'restoreOnExit' || key === 'coolOnly') {
      clean[key] = Boolean(value);
    } else if (key === 'hrSpeeds' || key === 'powerSpeeds') {
      clean[key] = speeds(value, key);
    } else if (key === 'fanHost') {
      clean.fanHost = host(value);
    } else if (key === 'powerMeter' || key === 'hrm') {
      clean[key] = device(value, key);
    } else {
      throw new Error(`unknown setting: ${key}`);
    }
  }
  return clean;
}

/** Checks a machine typed by hand (or imported) before it is saved. */
export function validateMachine(value: unknown): FanMachine {
  if (!isObject(value)) throw new Error('invalid fan');
  const serialNumber = String(value.serialNumber ?? '').trim();
  const type = String(value.type ?? '').trim().toUpperCase();
  const apPasswordHash = String(value.apPasswordHash ?? '').trim();
  if (!/^[A-Z0-9-]{6,40}$/i.test(serialNumber)) throw new Error('invalid serial number');
  if (!/^[0-9A-Z]{3,6}$/.test(type)) throw new Error('invalid product type');
  if (apPasswordHash.length < 8 || apPasswordHash.length > 200) throw new Error('invalid fan password');
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : undefined;
  return { serialNumber: serialNumber.toUpperCase(), type, apPasswordHash, ...(name && { name }) };
}
