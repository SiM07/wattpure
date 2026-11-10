/**
 * Default training zones and their colors.
 *
 * Power: six zones as a share of FTP:
 *   grey < 60 % | blue 60-75 % | green 76-89 % | yellow 90-104 % | orange 105-118 % | red > 118 %
 *
 * Heart rate: five zones as a share of max HR:
 *   blue 0-65 % | green 65-75 % | yellow 75-85 % | orange 85-95 % | red > 95 %
 *
 * Both can be overridden in the config (`powerZones`, `hrZones`).
 */
import type { ZoneSetting } from './shared/types.ts';

export type Rgb = readonly [number, number, number];

export interface Zone {
  number: number;
  name: string;
  fromPct: number;
  color: Rgb;
}

const GREY: Rgb = [0x7f, 0x7f, 0x7f];
const BLUE: Rgb = [0x33, 0x8c, 0xff];
const GREEN: Rgb = [0x59, 0xbf, 0x59];
const YELLOW: Rgb = [0xff, 0xcc, 0x3f];
const ORANGE: Rgb = [0xff, 0x66, 0x3a];

export const HR_ZONES: readonly Zone[] = [
  { number: 1, name: 'Endurance', fromPct: 0.0, color: BLUE },
  { number: 2, name: 'Moderate', fromPct: 0.65, color: GREEN },
  { number: 3, name: 'Tempo', fromPct: 0.75, color: YELLOW },
  { number: 4, name: 'Threshold', fromPct: 0.85, color: ORANGE },
  { number: 5, name: 'Anaerobic', fromPct: 0.95, color: [0xe9, 0x00, 0x00] },
];

export const POWER_ZONES: readonly Zone[] = [
  { number: 1, name: 'Recovery', fromPct: 0.0, color: GREY },
  { number: 2, name: 'Endurance', fromPct: 0.6, color: BLUE },
  { number: 3, name: 'Tempo', fromPct: 0.76, color: GREEN },
  { number: 4, name: 'Threshold', fromPct: 0.9, color: YELLOW },
  { number: 5, name: 'VO2max', fromPct: 1.05, color: ORANGE },
  { number: 6, name: 'Anaerobic', fromPct: 1.19, color: [0xff, 0x34, 0x0c] },
];

export function parseHex(value: string): Rgb {
  const hex = value.replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`invalid color: ${value}`);
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;
}

export function toHex([r, g, b]: Rgb): string {
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0').toUpperCase()).join('');
}

/** Builds zones from the config (`[{ name, fromPct, color: "#RRGGBB" }]`), or returns `fallback`. */
export function zonesFromConfig(raw: readonly ZoneSetting[] | null | undefined, fallback: readonly Zone[] = HR_ZONES): readonly Zone[] {
  if (!raw?.length) return fallback;
  return [...raw]
    .sort((a, b) => a.fromPct - b.fromPct)
    .map((z, i) => ({ number: i + 1, name: z.name ?? `Z${i + 1}`, fromPct: Number(z.fromPct), color: parseHex(z.color) }));
}

/**
 * Current zone with hysteresis on the way down: we move up as soon as a threshold is reached,
 * but only move down `hysteresis` units (bpm or watts) below it, so the light does not flicker
 * when riding right at a zone boundary. `reference` is the max HR or the FTP.
 */
export class ZoneTracker {
  current: Zone | null = null;
  readonly zones: readonly Zone[];
  readonly reference: number;
  readonly hysteresis: number;

  constructor(zones: readonly Zone[], reference: number, hysteresis = 3) {
    this.zones = zones;
    this.reference = reference;
    this.hysteresis = hysteresis;
  }

  threshold(zone: Zone): number {
    return zone.fromPct * this.reference;
  }

  rawZone(value: number): Zone {
    let found = this.zones[0]!;
    for (const zone of this.zones) if (value >= this.threshold(zone)) found = zone;
    return found;
  }

  update(value: number): Zone {
    const raw = this.rawZone(value);
    const cur = this.current;
    if (!cur || raw.number > cur.number) this.current = raw;
    else if (raw.number < cur.number && value < this.threshold(cur) - this.hysteresis) this.current = raw;
    return this.current!;
  }
}

/** Rolling average over a time window (raw power changes with every pedal stroke). */
export class RollingAverage {
  private samples: { value: number; at: number }[] = [];
  readonly windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  push(value: number, now = Date.now()): number {
    this.samples.push({ value, at: now });
    while (this.samples.length > 1 && now - this.samples[0]!.at > this.windowMs) this.samples.shift();
    return this.samples.reduce((sum, s) => sum + s.value, 0) / this.samples.length;
  }
}
