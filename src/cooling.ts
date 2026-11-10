/**
 * Fan speed over time: rises with the effort, stays up after it to cool you down, and does not
 * flicker when the measurement hovers on a zone boundary.
 *
 * Physiology behind it:
 * - Heart rate already lags the effort (time constant of 20-40 s, longer at high intensity), so
 *   with heart rate the fan rises almost at once; with power, which reacts instantly, a short
 *   smoothing absorbs sprints of a few seconds.
 * - After a hard effort, sweating drops within minutes while the core stays hot for a long time:
 *   that is when airflow helps most. The fan therefore holds its speed for a while (longer after a
 *   longer effort, like the delay before the heart rate starts to recover), then comes down
 *   slowly, one step at a time.
 * - The heat stored grows with intensity and duration: a slow "core" compartment keeps the fan up
 *   longer after a long effort than after a short one.
 *
 * Two first-order compartments follow the zone speed (the "target"):
 *  - skin: fast up (tauUp); on the way down, held for a share of the effort duration (holdRatio,
 *    at most holdMaxS), then slow down (tauDown);
 *  - core: slow both ways (tauCore), weighted by `coreWeight`.
 * The fan level is the larger of the two, turned into a whole speed with a margin, and lowered at
 * most one step every `minStepDownMs`.
 */
import type { Cooldown, Source } from './shared/types.ts';

export interface CoolingParams {
  /** Time constant of the rise, in seconds (0 = immediate). */
  tauUpS: number;
  /** Time constant of the fall of the fast compartment, in seconds (0 = immediate). */
  tauDownS: number;
  /** Hold before the fall, as a share of the time spent at the effort. */
  holdRatio: number;
  /** Longest hold before the fall, in seconds. */
  holdMaxS: number;
  /** Time constant of the slow compartment, in seconds (0 = none). */
  tauCoreS: number;
  /** Share of the slow compartment in the fan level. */
  coreWeight: number;
  /** Minimum time between two steps down, in ms. */
  minStepDownMs: number;
  /** Margin around the rounding, in speed steps: no back and forth around x.5. */
  margin: number;
}

/** Effort duration (s) after which the fall is as slow as `tauDownS`; shorter efforts fall faster. */
const EFFORT_FULL_S = 300;

/** Presets of the "after the effort" setting. */
export function coolingParams(cooldown: Cooldown, source: Source): CoolingParams {
  const tauUpS = source === 'hr' ? 8 : 15;
  switch (cooldown) {
    case 'off':
      return { tauUpS: 0, tauDownS: 0, holdRatio: 0, holdMaxS: 0, tauCoreS: 0, coreWeight: 0, minStepDownMs: 0, margin: 0 };
    case 'short':
      return { tauUpS, tauDownS: 45, holdRatio: 0.15, holdMaxS: 30, tauCoreS: 120, coreWeight: 0.7, minStepDownMs: 10_000, margin: 0.25 };
    case 'long':
      return { tauUpS, tauDownS: 150, holdRatio: 0.3, holdMaxS: 120, tauCoreS: 360, coreWeight: 0.9, minStepDownMs: 20_000, margin: 0.25 };
    default:
      return { tauUpS, tauDownS: 90, holdRatio: 0.2, holdMaxS: 60, tauCoreS: 240, coreWeight: 0.8, minStepDownMs: 15_000, margin: 0.25 };
  }
}

/** Moves `value` toward `target` over `dtS` seconds with time constant `tauS` (0 = jump). */
export function approach(value: number, target: number, dtS: number, tauS: number): number {
  if (tauS <= 0) return target;
  return target + (value - target) * Math.exp(-dtS / tauS);
}

export class CoolingCurve {
  private params: CoolingParams;
  private skin: number | null = null;
  private core = 0;
  private speed: number | null = null;
  private lastAt = 0;
  private lastStepDownAt = -Infinity;
  /** Seconds spent pushing (target at or above the fast compartment) since the last recovery. */
  private effortS = 0;
  /** Seconds the fall has been held so far. */
  private heldS = 0;

  constructor(params: CoolingParams) {
    this.params = params;
  }

  /** New settings keep the current level: no jump when switching preset or source. */
  setParams(params: CoolingParams): void {
    this.params = params;
  }

  /** Fan level before rounding, for display and tests. */
  get level(): number {
    return Math.max(this.skin ?? 0, this.core * this.params.coreWeight);
  }

  get current(): number | null {
    return this.speed;
  }

  /** Feeds the zone speed at time `now` (ms); returns the speed to send to the fan. */
  update(target: number, now: number): number {
    const p = this.params;
    if (this.skin === null || this.speed === null) {
      // First measurement: start at the zone speed, without a slow ramp from zero.
      this.skin = target;
      this.core = target;
      this.lastAt = now;
      this.speed = target;
      return target;
    }
    const dtS = Math.max(0, (now - this.lastAt) / 1000);
    this.lastAt = now;
    if (target >= this.skin - 0.01) {
      this.effortS += dtS;
      this.heldS = 0;
      this.skin = approach(this.skin, target, dtS, p.tauUpS);
    } else {
      // Still hot: keep the airflow for a while before easing off, then ease off faster after a
      // short effort than after a long one (less heat stored).
      const hold = Math.max(0, Math.min(p.holdMaxS, this.effortS * p.holdRatio) - this.heldS);
      const held = Math.min(dtS, hold);
      this.heldS += held;
      const tauDownS = p.tauDownS * Math.min(1, 0.4 + (0.6 * this.effortS) / EFFORT_FULL_S);
      if (dtS > held) this.skin = approach(this.skin, target, dtS - held, tauDownS);
      if (this.skin - target < 0.5) this.effortS = 0; // recovered: the next effort counts from zero
    }
    if (p.tauCoreS > 0) this.core = approach(this.core, target, dtS, p.tauCoreS);
    const level = this.level;

    if (level >= this.speed + 0.5 + p.margin || (p.margin === 0 && Math.round(level) > this.speed)) {
      this.speed = Math.min(10, Math.round(level));
    } else if (level <= this.speed - 0.5 - p.margin || (p.margin === 0 && Math.round(level) < this.speed)) {
      if (now - this.lastStepDownAt >= p.minStepDownMs) {
        // One step at a time on the way down, unless there is no smoothing at all.
        this.speed = p.margin === 0 ? Math.round(level) : this.speed - 1;
        this.lastStepDownAt = now;
      }
    }
    // A zone at 0 (off) is honored only once the level is really down.
    if (target === 0 && level < 0.5) this.speed = 0;
    return this.speed;
  }

  reset(): void {
    this.skin = null;
    this.core = 0;
    this.speed = null;
    this.lastStepDownAt = -Infinity;
    this.effortS = 0;
    this.heldS = 0;
  }
}
