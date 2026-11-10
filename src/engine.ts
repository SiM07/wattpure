/**
 * Core of the app: measurement (heart rate or power) -> zone -> fan speed.
 *
 * `Session` knows nothing about the UI or the terminal: it publishes its full state
 * (`state` event) with status codes that the web UI and the CLI turn into sentences.
 */
import { EventEmitter } from 'node:events';
import type { Measurement, SensorEvent, SensorOptions } from './ble.ts';
import { isComplete, publicFan } from './config.ts';
import { coolingParams, CoolingCurve } from './cooling.ts';
import { createDysonFan, type Fan, type FanCommand, type FanFactory, type FanState, fanError, type RoomReadings } from './dyson.ts';
import type { Angles, Config, DeviceRef, FanInfo, FanMachine, PublicZone, SessionState, Source, Status } from './shared/types.ts';
import { HR_ZONES, POWER_ZONES, RollingAverage, toHex, type Zone, ZoneTracker, zonesFromConfig } from './zones.ts';

export const NO_DATA_TIMEOUT_MS = 8000; // connected but no measurement for…
/** No usable measurement for this long (strap off, trainer stopped or out of range): the fan is let go. */
export const IDLE_STOP_MS = 120_000;

/**
 * Fan checks. A network hiccup should not raise an alarm: the fan shows as "connecting" and is
 * checked again quickly, and only repeated failures are reported. A refused password is
 * reported at once.
 */
export interface FanTiming {
  /** Delay between checks while everything works (they also refresh the room readings). */
  okMs: number;
  /** Delay between checks while connecting or reconnecting. */
  checkingMs: number;
  /** Delay between checks once a problem is reported. */
  problemMs: number;
  /** Consecutive failures before the fan is reported unreachable. */
  failuresBeforeAlert: number;
}

export const FAN_TIMING: FanTiming = { okMs: 30_000, checkingMs: 3_000, problemMs: 10_000, failuresBeforeAlert: 2 };
/** The fan takes about a second to act on a command: no point in sending them faster. */
export const FAN_MIN_INTERVAL_MS = 1500;
const ERROR_BACKOFF_MS = 5000;

/** Direction search: the fan sways slowly around the chosen angle until the rider says stop. */
export interface ScanTiming {
  /** Degrees on each side of the starting angle. */
  spanDeg: number;
  /** Degrees per step. */
  stepDeg: number;
  /** Time between two steps: the head turns and the rider feels the change. */
  stepMs: number;
  /**
   * Time between feeling the best airflow and pressing Stop (head lag, air travel, reaction):
   * the angle kept is the one aimed at that long before the press.
   */
  reactionMs: number;
}

/**
 * Search: ±20° around the angle set by hand, 3° at a time (about 40 s for a full sway).
 * Then refine (FINE_SCAN) degree by degree around the angle kept, then adjust by hand.
 */
export const SCAN_TIMING: ScanTiming = { spanDeg: 20, stepDeg: 3, stepMs: 1500, reactionMs: 2500 };
/** Refine: ±3° around the angle kept by the search, degree by degree (about 20 s for a full sway). */
export const FINE_SCAN = { spanDeg: 3, stepDeg: 1 };

/** Offsets of one sway: right up to the span, left down to minus the span, back to the center. */
export function scanOffsets(spanDeg: number, stepDeg: number): number[] {
  const offsets: number[] = [];
  for (let o = stepDeg; o <= spanDeg; o += stepDeg) offsets.push(o);
  for (let o = spanDeg - stepDeg; o >= -spanDeg; o -= stepDeg) offsets.push(o);
  for (let o = -spanDeg + stepDeg; o <= 0; o += stepDeg) offsets.push(o);
  return offsets;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What differs between power and heart rate. */
export interface Metric {
  kind: Source;
  unit: 'W' | 'bpm';
  reference: number;
  hysteresis: number;
  zones: readonly Zone[];
  speeds: readonly number[];
  device: DeviceRef | null;
  smooth: (value: number) => number | null;
  demoRange: readonly [number, number];
}

export type SensorFn = (metric: Metric, options: SensorOptions) => Promise<void>;

export function metricFor(cfg: Config): Metric {
  if (cfg.source === 'hr') {
    return {
      kind: 'hr',
      unit: 'bpm',
      reference: Number(cfg.maxHr),
      hysteresis: Number(cfg.hysteresisBpm),
      zones: zonesFromConfig(cfg.hrZones, HR_ZONES),
      speeds: cfg.hrSpeeds,
      device: cfg.hrm,
      smooth: (bpm) => (bpm > 0 ? bpm : null),
      demoRange: [0.5, 1.0],
    };
  }
  const avg = new RollingAverage(Number(cfg.powerSmoothingS) * 1000);
  return {
    kind: 'power',
    unit: 'W',
    reference: Number(cfg.ftp),
    hysteresis: Number(cfg.hysteresisW),
    zones: zonesFromConfig(cfg.powerZones, POWER_ZONES),
    speeds: cfg.powerSpeeds,
    device: cfg.powerMeter,
    smooth: (w) => (w >= 0 ? avg.push(w) : null),
    demoRange: [0.4, 1.3],
  };
}

/** Fan speed of a zone; zones beyond the list take the last speed. */
export function speedFor(zone: Zone, speeds: readonly number[]): number {
  return speeds[zone.number - 1] ?? speeds.at(-1) ?? 0;
}

export function publicZone(zone: Zone, metric: Pick<Metric, 'reference' | 'speeds'>): PublicZone {
  return {
    number: zone.number,
    name: zone.name,
    color: toHex(zone.color),
    from: Math.round(zone.fromPct * metric.reference),
    speed: speedFor(zone, metric.speeds),
  };
}

/** What the driver changed besides the speed and the power, so that only that is put back. */
export interface Touched {
  heat: boolean;
  night: boolean;
  oscillation: boolean;
}

const sameAngles = (a: Angles | null, b: Angles | null) => a?.lower === b?.lower && a?.upper === b?.upper;

/**
 * A fan pointed at one direction reports both angles equal and its oscillation off (once the head
 * has stopped): it is put there again by sending the oscillation on with those angles.
 */
const isFixed = (state: Pick<FanState, 'angles'>) => state.angles !== null && state.angles.lower === state.angles.upper;

/** Command that puts the fan back in a previously captured state. */
export function restoreCommand(before: FanState, touched: Touched = { heat: false, night: false, oscillation: false }): FanCommand {
  const command: FanCommand = before.auto ? { auto: true } : before.speed ? { speed: before.speed } : {};
  if (touched.heat && before.heat !== null) command.heat = before.heat;
  if (touched.night && before.night !== null) command.night = before.night;
  if (touched.oscillation && before.oscillating !== null) {
    const restoreAngles = before.angles !== null && (before.oscillating || isFixed(before));
    command.oscillate = before.oscillating || restoreAngles;
    if (restoreAngles) command.angles = before.angles!;
  }
  command.power = before.power;
  return command;
}

/**
 * Sends the last requested speed to the fan, at the pace it can follow.
 * Captures the fan state right before the first change so it can be restored at the end.
 */
export class FanDriver {
  private readonly fan: Fan;
  private readonly getCfg: () => Config;
  private readonly onResult: (err: Error | null) => void;
  private readonly interval: number;
  private wanted: number | null = null;
  private applied: number | null = null;
  private before: FanState | null = null;
  private touched: Touched = { heat: false, night: false, oscillation: false };
  /** Oscillation last sent (JSON), and whether the setting changed since. */
  private oscillationSent: string | null = null;
  private oscillationDirty = false;
  private aim: number | null = null;
  private pumping: Promise<void> | null = null;
  private closed = false;

  constructor(fan: Fan, getCfg: () => Config, onResult: (err: Error | null) => void = () => {}, interval = FAN_MIN_INTERVAL_MS) {
    this.fan = fan;
    this.getCfg = getCfg;
    this.onResult = onResult;
    this.interval = interval;
  }

  /** 0 = off, 1-10. */
  request(speed: number): void {
    if (this.closed) return;
    this.wanted = speed;
    this.kick();
  }

  /** Temporary direction (search in progress) taking over the setting; null = back to the setting. */
  aimAt(angle: number | null): void {
    this.aim = angle;
    this.refreshOscillation();
  }

  /** The airflow direction changed: applied at once once the fan is being driven. */
  refreshOscillation(): void {
    if (this.closed) return;
    this.oscillationDirty = true;
    this.kick();
  }

  private kick(): void {
    this.pumping ??= this.pump().finally(() => (this.pumping = null));
  }

  /** What the airflow direction should be now, or null to leave it alone. */
  private oscillationCommand(): FanCommand | null {
    const cfg = this.getCfg();
    const before = this.before!;
    if (before.oscillating === null) return null; // this fan does not turn
    let want: { on: boolean; angles: Angles | null } | null;
    if (this.aim !== null) {
      want = { on: true, angles: { lower: this.aim, upper: this.aim } };
    } else if (cfg.airDirection === 'fixed') {
      // A range of width 0: the fan turns to that angle and stays there.
      const angle = cfg.airAngle ?? (before.angles ? Math.round((before.angles.lower + before.angles.upper) / 2) : null);
      want = angle === null ? null : { on: true, angles: { lower: angle, upper: angle } };
    } else {
      // Back to the fan's own setting after a change during the ride.
      const restore = restoreCommand(before, { heat: false, night: false, oscillation: true });
      want = this.touched.oscillation ? { on: restore.oscillate ?? false, angles: restore.angles ?? null } : null;
    }
    if (!want) return null;
    const key = JSON.stringify(want);
    if (key === this.oscillationSent) return null;
    // Already pointed there before WattPure touched anything: nothing to send, nothing to restore.
    if (!this.touched.oscillation && want.angles && isFixed(before) && sameAngles(before.angles, want.angles)) {
      this.oscillationSent = key;
      return null;
    }
    this.oscillationSent = key;
    return { oscillate: want.on, ...(want.on && want.angles ? { angles: want.angles } : {}) };
  }

  private command(speed: number): FanCommand {
    const before = this.before!;
    if (speed === 0) return { power: false };
    const command: FanCommand = { speed };
    // First change only: cool air at full strength (night mode caps the speed).
    if (this.applied === null) {
      if (this.getCfg().coolOnly && before.heat === 'heat') command.heat = 'off';
      if (before.night) command.night = false;
    }
    command.power = true;
    return command;
  }

  private async pump(): Promise<void> {
    while (!this.closed) {
      const speedPending = this.wanted !== null && this.wanted !== this.applied;
      // The oscillation is only touched once the fan is being driven.
      const oscillationPending = this.oscillationDirty && (speedPending || this.applied !== null);
      if (!speedPending && !oscillationPending) break;
      const speed = this.wanted!;
      let pause = this.interval;
      const sentBefore = this.oscillationSent;
      try {
        await this.fan.connect();
        this.before ??= await this.fan.state();
        this.oscillationDirty = false;
        const command = speedPending ? this.command(speed) : {};
        const oscillation = this.oscillationCommand();
        if (oscillation) Object.assign(command, oscillation);
        if (Object.keys(command).length) await this.fan.apply(command);
        if (command.heat !== undefined) this.touched.heat = true;
        if (command.night !== undefined) this.touched.night = true;
        if (command.oscillate !== undefined) this.touched.oscillation = true;
        if (speedPending) this.applied = speed;
        this.onResult(null);
      } catch (err) {
        this.oscillationSent = sentBefore;
        this.oscillationDirty = true;
        this.onResult(err as Error);
        pause = ERROR_BACKOFF_MS;
      }
      await sleep(pause);
    }
  }

  async close({ restore = true } = {}): Promise<void> {
    this.closed = true;
    await this.pumping;
    if (restore && this.before && this.applied !== null) await this.fan.apply(restoreCommand(this.before, this.touched)).catch(() => {});
    this.before = null;
  }
}

/** Simulated sensor: ramps up and down forever, to try the app without hardware. */
export async function demoSensor(metric: Metric, { signal, onValue, onEvent }: SensorOptions, stepMs = 250): Promise<void> {
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
    });
  const device = { id: 'demo', name: metric.kind === 'power' ? 'Demo trainer' : 'Demo HR strap' };
  onEvent({ type: 'searching', attempt: 1 });
  await wait(800);
  if (signal.aborted) return;
  onEvent({ type: 'connecting', device });
  await wait(600);
  if (signal.aborted) return;
  onEvent({ type: 'connected', device });
  const [low, high] = metric.demoRange.map((f) => Math.round(f * metric.reference)) as [number, number];
  const step = Math.max(1, Math.round((high - low) / 80));
  while (!signal.aborted) {
    for (let v = low; v < high && !signal.aborted; v += step) {
      onValue({ value: v, contact: null });
      await wait(stepMs);
    }
    for (let v = high; v > low && !signal.aborted; v -= step) {
      onValue({ value: v, contact: null });
      await wait(stepMs);
    }
  }
}

const status = (code: Status['code'], level: Status['level'], params: Status['params'] = {}): Status => ({ code, level, params });

const deviceName = (device: DeviceRef | null | undefined) => device?.name ?? device?.id ?? '';

/** Status matching a sensor event; null when the current one should stay. */
export function statusForSensorEvent(event: SensorEvent): Status | null {
  switch (event.type) {
    case 'adapter':
      switch (event.state) {
        case 'poweredOn':
          return status('searching', 'info');
        case 'poweredOff':
          return status('bluetoothOff', 'error');
        case 'unauthorized':
          return status('bluetoothUnauthorized', 'error');
        case 'unsupported':
          return status('bluetoothUnsupported', 'error');
        default:
          return status('bluetoothStarting', 'info');
      }
    case 'searching':
      return event.attempt > 1 ? null : status('searching', 'info');
    case 'notFound':
      return status('notFound', 'warn', { retrySeconds: Math.round(event.retryInMs / 1000) });
    case 'connecting':
      return status('connecting', 'info', { name: deviceName(event.device) });
    case 'connected':
      return status('waiting', 'ok', { name: deviceName(event.device) });
    case 'disconnected':
      return status('disconnected', 'warn', { name: deviceName(event.device) });
    case 'error':
      return status('connectError', 'warn', { name: deviceName(event.device), error: event.message });
  }
}

export const EMPTY_FAN: FanInfo = {
  ok: null,
  problem: null,
  power: null,
  speed: null,
  auto: null,
  heating: null,
  oscillating: null,
  angles: null,
  temperatureC: null,
  humidity: null,
  pm25: null,
};

export function fanInfo(previous: FanInfo, state: FanState | null, readings: RoomReadings | null, err: Error | null): FanInfo {
  const next: FanInfo = { ...previous, ...(readings ?? {}) };
  if (state) {
    Object.assign(next, {
      power: state.power,
      speed: state.auto ? null : state.speed,
      auto: state.auto,
      heating: state.heating ?? (state.heat === null ? null : state.heat === 'heat'),
      oscillating: state.oscillating,
      angles: state.angles,
    });
  }
  if (err) Object.assign(next, { ok: false, problem: fanError(err).problem });
  else Object.assign(next, { ok: true, problem: null });
  return next;
}

const SENSOR_KEYS = ['source', 'ftp', 'maxHr', 'powerMeter', 'hrm', 'hysteresisW', 'hysteresisBpm', 'powerSmoothingS', 'powerZones', 'hrZones'] as const;

export interface SessionOptions {
  sensor: SensorFn;
  createFan?: FanFactory;
  now?: () => number;
  noDataMs?: number;
  /** No usable measurement for this long: the fan is put back as it was (or turned off). */
  idleStopMs?: number;
  /** How often the no-data watchdog runs. */
  watchdogMs?: number;
  fanTiming?: FanTiming;
  fanIntervalMs?: number;
  scanTiming?: ScanTiming;
  demo?: boolean;
}

export interface SessionEvents {
  state: [SessionState];
  test: [PublicZone];
  /** The fan revealed capabilities the stored machine lacks: save it. */
  machine: [FanMachine];
}

export class Session extends EventEmitter<SessionEvents> {
  cfg: Config;
  private readonly sensor: SensorFn;
  private readonly createFan: FanFactory;
  private readonly now: () => number;
  private readonly noDataMs: number;
  private readonly idleStopMs: number;
  private readonly watchdogMs: number;
  private readonly fanTiming: FanTiming;
  private readonly fanIntervalMs: number;
  private readonly scanTiming: ScanTiming;
  private readonly demo: boolean;
  private scan: { fine: boolean; span: number; center: number; angle: number; step: number; timer: NodeJS.Timeout; history: { at: number; angle: number }[] } | null = null;

  running = false;
  testing = false;
  private suspended = false;
  private driver: FanDriver | null = null;
  private fan: { key: string; instance: Fan } | null = null;
  private fanStatus: FanInfo = EMPTY_FAN;
  private fanFailures = 0;
  private machineChecked = false;
  private status: Status;

  private metric!: Metric;
  private tracker!: ZoneTracker;
  private value: number | null = null;
  private zone: Zone | null = null;
  private device: DeviceRef | null = null;
  private connected = false;
  private started = false; // first useful measurement received
  private lastValueAt = 0;
  /** Last measurement that could drive the fan (not one without skin contact). */
  private lastMeasureAt = 0;
  /** The fan was let go after a long time without measurement; the next one takes it again. */
  private idle = false;
  /** Fan being put back after `idle`: nothing is sent to it meanwhile. */
  private releasing: Promise<void> | null = null;
  private curve = new CoolingCurve(coolingParams('normal', 'hr'));
  /** Speed of the current zone, which the cooling curve heads for. */
  private target: number | null = null;

  private abort: AbortController | null = null;
  private sensorTask: Promise<void> = Promise.resolve();
  private fanTimer: NodeJS.Timeout | undefined;
  private watchdog: NodeJS.Timeout | undefined;

  constructor(
    cfg: Config,
    {
      sensor,
      createFan = createDysonFan,
      now = Date.now,
      noDataMs = NO_DATA_TIMEOUT_MS,
      idleStopMs = IDLE_STOP_MS,
      watchdogMs = 1000,
      fanTiming = FAN_TIMING,
      fanIntervalMs = FAN_MIN_INTERVAL_MS,
      scanTiming = SCAN_TIMING,
      demo = false,
    }: SessionOptions,
  ) {
    super();
    this.cfg = cfg;
    this.sensor = sensor;
    this.createFan = createFan;
    this.now = now;
    this.noDataMs = noDataMs;
    this.idleStopMs = idleStopMs;
    this.watchdogMs = watchdogMs;
    this.fanTiming = fanTiming;
    this.fanIntervalMs = fanIntervalMs;
    this.scanTiming = scanTiming;
    this.demo = demo;
    this.reset();
    this.status = this.idleStatus();
  }

  private reset(): void {
    this.metric = metricFor(this.cfg);
    this.tracker = new ZoneTracker(this.metric.zones, this.metric.reference, this.metric.hysteresis);
    this.value = null;
    this.zone = null;
    this.device = null;
    this.connected = false;
    this.started = false;
    this.lastValueAt = 0;
    this.lastMeasureAt = 0;
    this.idle = false;
    this.curve = new CoolingCurve(coolingParams(this.cfg.cooldown, this.cfg.source));
    this.target = null;
  }

  private idleStatus(): Status {
    return isComplete(this.cfg) ? status('stopped', 'info') : status('unconfigured', 'info');
  }

  get state(): SessionState {
    const { metric } = this;
    return {
      running: this.running,
      demo: this.demo,
      testing: this.testing,
      configured: isComplete(this.cfg),
      source: metric.kind,
      unit: metric.unit,
      reference: metric.reference,
      zones: metric.zones.map((z) => publicZone(z, metric)),
      status: this.status,
      device: this.device,
      value: this.value === null ? null : Math.round(this.value),
      pct: this.value === null ? null : Math.round((this.value / metric.reference) * 100),
      zone: this.zone && publicZone(this.zone, metric),
      scan: this.scan && { fine: this.scan.fine, center: this.scan.center, angle: this.scan.angle, span: this.scan.span },
      drive: this.target === null || this.curve.current === null ? null : { speed: this.curve.current, target: this.target },
      fan: this.fanStatus,
      machine: this.cfg.fan && publicFan(this.cfg.fan),
    };
  }

  private publish(): void {
    this.emit('state', this.state);
  }

  private setStatus(next: Status): void {
    this.status = next;
  }

  /** The fan connection, kept while the session runs. */
  private fanInstance(): Fan {
    const { fan, fanHost } = this.cfg;
    const key = `${fan!.serialNumber}|${fan!.apPasswordHash}|${fanHost ?? ''}`;
    if (this.fan?.key !== key) {
      void this.fan?.instance.close();
      this.fan = { key, instance: this.createFan(fan!, fanHost, { onState: (state) => this.onFanState(state) }) };
    }
    return this.fan.instance;
  }

  private async closeFan(): Promise<void> {
    const fan = this.fan;
    this.fan = null;
    await fan?.instance.close();
  }

  private ensureDriver(): FanDriver {
    this.driver ??= new FanDriver(this.fanInstance(), () => this.cfg, (err) => this.onFanResult(err), this.fanIntervalMs);
    return this.driver;
  }

  private onFanState(state: FanState): void {
    this.fanStatus = fanInfo(this.fanStatus, state, null, null);
    this.fanFailures = 0;
    this.publish();
  }

  private onFanResult(err: Error | null, state: FanState | null = null, readings: RoomReadings | null = null): void {
    let next = fanInfo(this.fanStatus, state, readings, err);
    this.fanFailures = err ? this.fanFailures + 1 : 0;
    // Transient failure: keep showing "connecting" until it happens several times in a row.
    if (next.problem === 'unreachable' && this.fanFailures < this.fanTiming.failuresBeforeAlert) next = { ...next, ok: null, problem: null };
    const changed = JSON.stringify(next) !== JSON.stringify(this.fanStatus);
    const paceChanged = next.ok !== this.fanStatus.ok;
    this.fanStatus = next;
    if (changed) this.publish();
    if (paceChanged && this.running) this.scheduleFanCheck(); // the pace depends on the new state
  }

  private async checkFan(): Promise<void> {
    try {
      const fan = this.fanInstance();
      await fan.connect();
      if (!this.machineChecked) {
        this.machineChecked = true;
        const upgraded = await fan.detectMachine().catch(() => null);
        if (upgraded) this.emit('machine', upgraded);
      }
      const state = await fan.state();
      const readings = await fan.readings().catch(() => null);
      this.onFanResult(null, state, readings);
    } catch (err) {
      this.onFanResult(err as Error);
    } finally {
      if (this.running) this.scheduleFanCheck();
    }
  }

  private scheduleFanCheck(): void {
    clearTimeout(this.fanTimer);
    const { okMs, checkingMs, problemMs } = this.fanTiming;
    const delay = this.fanStatus.ok === true ? okMs : this.fanStatus.ok === null ? checkingMs : problemMs;
    this.fanTimer = setTimeout(() => void this.checkFan(), delay);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.suspended = false;
    if (!isComplete(this.cfg)) {
      this.setStatus(status('unconfigured', 'info'));
      return this.publish();
    }
    this.reset();
    this.running = true;
    this.setStatus(status('starting', 'info'));
    const abort = (this.abort = new AbortController());
    void this.checkFan();
    this.watchdog = setInterval(() => this.watch(), this.watchdogMs);
    this.sensorTask = Promise.resolve()
      .then(() =>
        this.sensor(this.metric, {
          signal: abort.signal,
          onValue: (m) => !abort.signal.aborted && this.onValue(m),
          onEvent: (e) => !abort.signal.aborted && this.onSensorEvent(e),
        }),
      )
      .catch((err: Error) => {
        if (abort.signal.aborted) return;
        this.setStatus(status('bluetoothFailed', 'error', { error: err.message }));
        this.publish();
      });
    this.publish();
  }

  /** Stops reading; puts the fan back in its original state when `restoreOnExit` is set. */
  async stop({ restore = true } = {}): Promise<void> {
    const active = this.running || this.suspended;
    this.suspended = false;
    if (!active) return;
    if (this.running) await this.halt();
    await this.closeDriver(restore);
    if (!this.testing) await this.closeFan();
    this.fanStatus = { ...this.fanStatus, ok: null, problem: null };
    this.setStatus(this.idleStatus());
    this.publish();
  }

  /** Pauses the sensor (to run a Bluetooth scan) while keeping the fan as it is. */
  async suspend(): Promise<void> {
    if (!this.running) return;
    await this.halt();
    this.suspended = true;
    this.setStatus(status('suspended', 'info'));
    this.publish();
  }

  async resume(): Promise<void> {
    if (this.suspended) await this.start();
  }

  private async halt(): Promise<void> {
    this.endScan();
    this.running = false;
    this.abort?.abort();
    clearTimeout(this.fanTimer);
    clearInterval(this.watchdog);
    await this.sensorTask;
    this.reset();
  }

  private async closeDriver(restore: boolean): Promise<void> {
    const driver = this.driver;
    this.driver = null;
    await driver?.close({ restore: restore && this.cfg.restoreOnExit });
  }

  /**
   * Starts the direction search from `center`: the fan sways slowly a few degrees to each side
   * until `stopScan`. Only while riding: the airflow has to be felt.
   */
  startScan(center: number, { fine = false } = {}): void {
    if (!this.running || this.driver === null || this.curve.current === null) throw new Error('start riding first: the fan has to blow to find the best direction');
    if (!this.cfg.fan || this.state.machine?.aimable === false) throw new Error('this fan cannot be pointed');
    this.endScan();
    const { stepMs } = this.scanTiming;
    const { spanDeg, stepDeg } = fine ? { spanDeg: Math.min(FINE_SCAN.spanDeg, this.scanTiming.spanDeg), stepDeg: Math.min(FINE_SCAN.stepDeg, this.scanTiming.stepDeg) } : this.scanTiming;
    const c = Math.min(355 - spanDeg, Math.max(5 + spanDeg, Math.round(center)));
    const offsets = scanOffsets(spanDeg, stepDeg);
    const scan = {
      fine,
      span: spanDeg,
      center: c,
      angle: c,
      step: 0,
      history: [{ at: this.now(), angle: c }],
      timer: setInterval(() => {
        scan.angle = c + offsets[scan.step % offsets.length]!;
        scan.step++;
        scan.history.push({ at: this.now(), angle: scan.angle });
        if (scan.history.length > 200) scan.history.shift();
        this.driver?.aimAt(scan.angle);
        this.publish();
      }, stepMs),
    };
    this.scan = scan;
    this.driver.aimAt(c);
    this.publish();
  }

  /**
   * Ends the search. With `keep`, returns the angle aimed at `reactionMs` before now (what the
   * rider felt when deciding to stop); otherwise returns null and the fan goes back to its setting.
   */
  stopScan(keep: boolean, { hold = false } = {}): number | null {
    const scan = this.scan;
    if (!scan) return null;
    // `hold`: the rider takes over by hand, the fan stays where it is until the new angle is saved.
    this.endScan(keep || hold);
    if (!keep) {
      this.publish();
      return null;
    }
    const felt = this.now() - this.scanTiming.reactionMs;
    const kept = [...scan.history].reverse().find((h) => h.at <= felt) ?? scan.history[0]!;
    this.driver?.aimAt(kept.angle); // held until the setting with this angle is saved
    this.publish();
    return kept.angle;
  }

  private endScan(keepAim = false): void {
    if (!this.scan) return;
    clearInterval(this.scan.timer);
    this.scan = null;
    if (!keepAim) this.driver?.aimAt(null);
  }

  /** Applies a new config; restarts reading if it was running. */
  async configure(cfg: Config): Promise<void> {
    const prev = this.cfg;
    const wasRunning = this.running || this.suspended;
    const fanChanged = JSON.stringify(prev.fan) !== JSON.stringify(cfg.fan) || prev.fanHost !== cfg.fanHost;
    const sensorChanged = SENSOR_KEYS.some((k) => JSON.stringify(prev[k]) !== JSON.stringify(cfg[k]));
    const speedsChanged = JSON.stringify(prev.hrSpeeds) !== JSON.stringify(cfg.hrSpeeds) || JSON.stringify(prev.powerSpeeds) !== JSON.stringify(cfg.powerSpeeds);

    if (fanChanged) {
      if (this.running) await this.halt();
      await this.closeDriver(true);
      await this.closeFan();
      this.cfg = cfg;
      this.fanStatus = EMPTY_FAN;
      this.fanFailures = 0;
      this.machineChecked = false;
      if (wasRunning) return this.start();
    } else if (sensorChanged && this.running) {
      // The driver (and its capture of the fan state) is kept: no stop and go of the fan,
      // and the cooling curve keeps its level: switching source does not cut the airflow.
      const curve = this.curve;
      await this.halt();
      this.cfg = cfg;
      curve.setParams(coolingParams(cfg.cooldown, cfg.source));
      await this.start();
      this.curve = curve;
      return;
    } else {
      this.cfg = cfg;
      if (!this.running) this.reset();
      else {
        if (prev.cooldown !== cfg.cooldown) this.curve.setParams(coolingParams(cfg.cooldown, cfg.source));
        if (prev.airDirection !== cfg.airDirection || prev.airAngle !== cfg.airAngle) {
          if (!this.scan) this.driver?.aimAt(null); // the kept angle is now the setting
          this.driver?.refreshOscillation();
        }
        if (speedsChanged) {
          this.metric = { ...this.metric, speeds: metricFor(cfg).speeds };
          if (this.zone) this.target = speedFor(this.zone, this.metric.speeds);
        }
        this.drive();
      }
    }
    if (!this.running && !this.suspended) this.setStatus(this.idleStatus());
    this.publish();
  }

  /** Runs the fan through the speed of every zone, then goes back to the previous state. */
  async testSpeeds(stepMs = 4000): Promise<void> {
    if (this.testing) return;
    if (!isComplete(this.cfg)) throw new Error('set up the fan first');
    this.testing = true;
    this.publish();
    const driver = this.ensureDriver();
    const metric = metricFor(this.cfg);
    try {
      for (const zone of metric.zones) {
        driver.request(speedFor(zone, metric.speeds));
        this.emit('test', publicZone(zone, metric));
        await sleep(stepMs);
      }
    } finally {
      this.testing = false;
      if (this.running && this.curve.current !== null) driver.request(this.curve.current);
      else if (driver === this.driver) {
        await this.closeDriver(true);
        if (!this.running) await this.closeFan();
      }
      this.publish();
    }
  }

  private onSensorEvent(event: SensorEvent): void {
    if (event.type === 'connected') {
      this.connected = true;
      this.device = event.device;
      this.lastValueAt = this.now();
    } else if (event.type !== 'adapter' && event.type !== 'connecting') {
      this.connected = false;
    }
    if (event.type === 'disconnected' || event.type === 'error') {
      this.value = null;
      this.started = false;
    }
    const next = statusForSensorEvent(event);
    // Once the fan is let go, the rider is gone: that stays on screen until the next measurement.
    if (next && !this.idle) {
      this.setStatus(next);
      this.publish();
    }
  }

  private onValue({ value, contact }: Measurement): void {
    this.lastValueAt = this.now();
    const name = deviceName(this.device);
    if (contact === false) {
      this.value = null;
      if (!this.idle && this.status.code !== 'noContact') {
        this.setStatus(status('noContact', 'warn', { name }));
        this.publish();
      }
      return;
    }
    this.lastMeasureAt = this.now();
    this.idle = false;
    const smoothed = this.metric.smooth(value);
    if (smoothed === null) return;
    if (!this.started && smoothed <= 0) {
      // Trainer on but not pedaling yet: leave the fan alone.
      if (this.status.code !== 'waiting') {
        this.setStatus(status('waiting', 'ok', { name }));
        this.publish();
      }
      return;
    }
    this.started = true;
    this.value = smoothed;
    this.zone = this.tracker.update(smoothed);
    this.target = speedFor(this.zone, this.metric.speeds);
    if (this.status.code !== 'live') this.setStatus(status('live', 'ok', { name }));
    this.drive(false);
    this.publish();
  }

  /**
   * Moves the cooling curve toward the speed of the current zone and sends the result to the fan.
   * Called with each measurement and every second, so the fan keeps slowing down after an effort
   * even when the sensor goes quiet.
   */
  private drive(publish = true): void {
    if (!this.running || this.target === null || this.releasing) return;
    const before = this.curve.current;
    const speed = this.curve.update(this.target, this.now());
    if (!this.testing) this.ensureDriver().request(speed);
    if (publish && speed !== before) this.publish();
  }

  private watch(): void {
    if (this.idleDue()) return void this.letGo();
    this.drive();
    if (!this.running || !this.connected || this.idle || this.status.code === 'noData') return;
    if (this.now() - this.lastValueAt < this.noDataMs) return;
    this.value = null;
    this.setStatus(status('noData', 'warn', { name: deviceName(this.device) }));
    this.publish();
  }

  private idleDue(): boolean {
    if (!this.running || this.idle || this.testing || this.scan || this.target === null) return false;
    return this.now() - this.lastMeasureAt >= this.idleStopMs;
  }

  /**
   * No measurement for a long time: the rider is gone. The fan is put back as it was, as on a
   * pause, or turned off when the fan is not to be restored. The sensor keeps searching, and the
   * next measurement drives the fan again from its current state.
   */
  private async letGo(): Promise<void> {
    this.idle = true;
    this.value = null;
    this.zone = null;
    this.target = null;
    this.curve.reset();
    const restore = this.cfg.restoreOnExit;
    this.setStatus(status(restore ? 'idle' : 'idleOff', 'info', { minutes: Math.round(this.idleStopMs / 60_000) }));
    this.publish();
    const releasing = (this.releasing = (async () => {
      await this.closeDriver(true);
      if (!restore) await this.fanInstance().apply({ power: false }).catch((err: Error) => this.onFanResult(err));
    })());
    try {
      await releasing;
    } finally {
      this.releasing = null;
    }
  }
}
