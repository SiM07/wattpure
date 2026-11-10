import assert from 'node:assert/strict';
import { test } from 'node:test';
import { demoSensor, metricFor, restoreCommand, scanOffsets, Session, speedFor } from '../src/engine.ts';
import { FakeFan, fakeFanFactory } from '../src/fakes.ts';
import type { SessionState } from '../src/shared/types.ts';
import { HR_ZONES } from '../src/zones.ts';
import { configured, manualSensor, sleep, until } from './helpers.ts';

const FAST_FAN = { fanTiming: { okMs: 1000, checkingMs: 10, problemMs: 10, failuresBeforeAlert: 2 }, fanIntervalMs: 5 };

function setup(patch = {}, options = {}) {
  const fan = new FakeFan();
  const sensor = manualSensor();
  const session = new Session(configured(patch), { sensor: sensor.fn, createFan: fakeFanFactory(fan), ...FAST_FAN, ...options });
  const states: SessionState[] = [];
  session.on('state', (s) => states.push(s));
  return { fan, sensor, session, states, last: () => states.at(-1)! };
}

test('heart rate is the default source', () => {
  assert.equal(metricFor(configured()).kind, 'hr');
});

test('without a fan, the session asks for the setup', async () => {
  const sensor = manualSensor();
  const session = new Session(configured({ fan: null }), { sensor: sensor.fn });
  await session.start();
  assert.equal(session.state.status.code, 'unconfigured');
  assert.equal(session.running, false);
  assert.equal(sensor.runs.length, 0);
});

test('sensor events become status codes', async () => {
  const { sensor, session, last } = setup();
  await session.start();
  sensor.event({ type: 'adapter', state: 'poweredOff' });
  assert.deepEqual(last().status, { code: 'bluetoothOff', level: 'error', params: {} });
  sensor.event({ type: 'searching', attempt: 1 });
  assert.equal(last().status.code, 'searching');
  sensor.event({ type: 'notFound', attempt: 1, retryInMs: 5000 });
  assert.deepEqual(last().status, { code: 'notFound', level: 'warn', params: { retrySeconds: 5 } });
  sensor.event({ type: 'connecting', device: { id: 'hrm', name: 'HRM' } });
  assert.equal(last().status.code, 'connecting');
  sensor.connect('HRM');
  assert.deepEqual(last().status, { code: 'waiting', level: 'ok', params: { name: 'HRM' } });
  await session.stop();
});

test('each zone has a fan speed; extra zones take the last one', () => {
  assert.deepEqual(HR_ZONES.map((z) => speedFor(z, [2, 4, 6, 8, 10])), [2, 4, 6, 8, 10]);
  assert.equal(speedFor(HR_ZONES[4]!, [1, 2]), 2);
});

test('heart rate drives the zone and the fan speed', async () => {
  const { fan, sensor, session, last } = setup({ maxHr: 200 });
  await session.start();
  sensor.connect();
  sensor.value(160); // 80 % max HR -> Z3
  assert.equal(last().status.code, 'live');
  assert.equal(last().zone?.number, 3);
  assert.equal(last().zone?.speed, 6);
  await until(() => fan.commands.length === 1);
  assert.deepEqual(fan.commands[0], { speed: 6, power: true });
  assert.equal(fan.current.speed, 6);
  await session.stop();
});

test('zero watts before the first pedal stroke leaves the fan alone', async () => {
  const { fan, sensor, session, last } = setup({ source: 'power' });
  await session.start();
  sensor.connect();
  sensor.value(0);
  sensor.value(0);
  await sleep(50);
  assert.equal(last().status.code, 'waiting');
  assert.equal(fan.commands.length, 0);
  await session.stop();
});

test('speed 0 turns the fan off in that zone', async () => {
  const { fan, sensor, session } = setup({ maxHr: 200, hrSpeeds: [0, 4, 6, 8, 10] });
  await session.start();
  sensor.connect();
  sensor.value(100);
  await until(() => fan.commands.length === 1);
  assert.deepEqual(fan.commands[0], { power: false });
  await session.stop();
});

test('the heater and night mode are turned off on the first change, and put back at the end', async () => {
  const { fan, sensor, session } = setup({ maxHr: 200 });
  fan.current = { power: true, auto: true, speed: null, heat: 'heat', heating: true, night: true, oscillating: false, angles: null };
  await session.start();
  sensor.connect();
  sensor.value(190);
  await until(() => fan.commands.length === 1);
  assert.deepEqual(fan.commands[0], { speed: 10, heat: 'off', night: false, power: true });
  sensor.value(140); // 70 % -> Z2
  await until(() => fan.commands.length === 2);
  assert.deepEqual(fan.commands[1], { speed: 4, power: true }); // later changes only touch the speed
  await session.stop();
  assert.deepEqual(fan.commands.at(-1), { auto: true, heat: 'heat', night: true, power: true });
  assert.equal(fan.current.heat, 'heat');
  assert.equal(fan.current.auto, true);
});

test('coolOnly=false leaves the heater alone', async () => {
  const { fan, sensor, session } = setup({ coolOnly: false });
  fan.current = { ...fan.current, heat: 'heat', heating: true };
  await session.start();
  sensor.connect();
  sensor.value(150);
  await until(() => fan.commands.length === 1);
  assert.equal('heat' in fan.commands[0]!, false);
  await session.stop();
});

test('stopping puts back the fan state captured before the first change', async () => {
  const { fan, sensor, session } = setup();
  const before = structuredClone(fan.current); // off, speed 3
  await session.start();
  sensor.connect();
  sensor.value(170);
  await until(() => fan.commands.length > 0);
  assert.equal(fan.current.power, true);
  await session.stop();
  assert.deepEqual(fan.current, before);
  assert.equal(session.state.status.code, 'stopped');
  assert.ok(sensor.aborted);
  assert.equal(fan.connected, false);
});

test('restore command: manual speed, auto mode, off; heat and night only when changed', () => {
  const off = { power: false, auto: false, speed: 3, heat: 'off', heating: false, night: false, oscillating: false, angles: null } as const;
  assert.deepEqual(restoreCommand(off), { speed: 3, power: false });
  assert.deepEqual(restoreCommand({ ...off, heat: 'heat', night: true }, { heat: true, night: true, oscillation: false }), { speed: 3, heat: 'heat', night: true, power: false });
  assert.deepEqual(restoreCommand({ power: true, auto: true, speed: null, heat: null, heating: null, night: null, oscillating: null, angles: null }), { auto: true, power: true });
  assert.deepEqual(restoreCommand({ ...off, oscillating: true, angles: { lower: 24, upper: 114 } }, { heat: false, night: false, oscillation: true }), {
    speed: 3,
    oscillate: true,
    angles: { lower: 24, upper: 114 },
    power: false,
  });
});

test('a fan left untouched gets no heat or night command back', async () => {
  const { fan, sensor, session } = setup();
  await session.start();
  sensor.connect();
  sensor.value(170);
  await until(() => fan.commands.length > 0);
  await session.stop();
  assert.ok(fan.commands.every((c) => !('heat' in c) && !('night' in c)));
});

test('restoreOnExit=false leaves the fan running', async () => {
  const { fan, sensor, session } = setup({ restoreOnExit: false });
  await session.start();
  sensor.connect();
  sensor.value(170);
  await until(() => fan.commands.length > 0);
  await session.stop();
  assert.equal(fan.current.power, true);
});

test('the watchdog warns when a connected sensor goes silent', async () => {
  const { sensor, session, last } = setup({}, { noDataMs: 40, watchdogMs: 10 });
  await session.start();
  sensor.connect();
  sensor.value(150);
  await until(() => last().status.code === 'noData');
  assert.equal(last().value, null);
  sensor.value(151);
  assert.equal(last().status.code, 'live');
  await session.stop();
});

test('without a measurement for a long time, the fan is put back as it was, then driven again', async () => {
  const { fan, sensor, session, last } = setup({ maxHr: 200 }, { idleStopMs: 80, noDataMs: 20, watchdogMs: 10 });
  await session.start();
  sensor.connect();
  sensor.value(170);
  await until(() => fan.current.power === true);
  sensor.event({ type: 'disconnected', device: { id: 'neo', name: 'Neo' } }); // strap taken off
  await until(() => last().status.code === 'idle');
  assert.deepEqual(last().status.params, { minutes: 0 });
  await until(() => fan.current.power === false); // back to how it was: off
  assert.equal(last().drive, null);
  sensor.event({ type: 'searching', attempt: 1 });
  assert.equal(last().status.code, 'idle'); // the sensor search does not hide it
  const sent = fan.commands.length;
  await sleep(100);
  assert.equal(fan.commands.length, sent); // let go: nothing more is sent
  sensor.connect();
  sensor.value(170); // back on the bike
  assert.equal(last().status.code, 'live');
  await until(() => fan.current.power === true);
  await session.stop();
  assert.equal(fan.current.power, false);
});

test('with restoreOnExit off, the fan is turned off after a long time without measurement', async () => {
  const { fan, sensor, session, last } = setup({ maxHr: 200, restoreOnExit: false }, { idleStopMs: 80, watchdogMs: 10 });
  fan.current = { ...fan.current, power: true, speed: 5 };
  await session.start();
  sensor.connect();
  sensor.value(190);
  await until(() => fan.current.speed === 10);
  await until(() => last().status.code === 'idleOff');
  await until(() => fan.current.power === false);
  assert.deepEqual(fan.commands.at(-1), { power: false });
  await session.stop();
});

test('values without skin contact do not keep the fan going', async () => {
  const { fan, sensor, session, last } = setup({ maxHr: 200 }, { idleStopMs: 80, watchdogMs: 10 });
  await session.start();
  sensor.connect();
  sensor.value(170);
  await until(() => fan.current.power === true);
  const timer = setInterval(() => sensor.value(0, false), 10); // strap on the handlebar
  try {
    await until(() => last().status.code === 'idle');
    await until(() => fan.current.power === false);
  } finally {
    clearInterval(timer);
    await session.stop();
  }
});

test('the fan is not let go during the speed test', async () => {
  const { fan, sensor, session } = setup({ maxHr: 200 }, { idleStopMs: 30, watchdogMs: 10 });
  await session.start();
  sensor.connect();
  sensor.value(170);
  await until(() => fan.current.power === true);
  const test = session.testSpeeds(40);
  await sleep(120); // well past idleStopMs, test still running
  assert.equal(fan.current.power, true);
  await test;
  await session.stop();
});

test('a strap without skin contact is reported and does not drive the fan', async () => {
  const { fan, sensor, session, last } = setup();
  await session.start();
  sensor.connect('HRM');
  sensor.value(0, false);
  assert.deepEqual(last().status, { code: 'noContact', level: 'warn', params: { name: 'HRM' } });
  await sleep(30);
  assert.equal(fan.commands.length, 0);
  sensor.value(150, true);
  assert.equal(last().status.code, 'live');
  await session.stop();
});

test('switching the source restarts the sensor without restoring the fan in between', async () => {
  const { fan, sensor, session } = setup();
  await session.start();
  sensor.connect();
  sensor.value(170);
  await until(() => fan.commands.length > 0);
  await session.configure({ ...session.cfg, source: 'power' });
  assert.equal(sensor.runs.length, 2);
  assert.equal(sensor.runs[1]!.kind, 'power');
  assert.equal(fan.current.power, true); // not restored
  assert.equal(session.state.source, 'power');
  await session.stop();
  assert.equal(fan.current.power, false); // restored at the end
});

test('changing the speeds applies the new speed of the current zone at once', async () => {
  const { fan, sensor, session } = setup({ maxHr: 200 });
  await session.start();
  sensor.connect();
  sensor.value(160); // Z3
  await until(() => fan.current.speed === 6);
  await session.configure({ ...session.cfg, hrSpeeds: [1, 2, 9, 9, 10] });
  await until(() => fan.current.speed === 9);
  assert.equal(session.state.zone?.speed, 9);
  await session.stop();
});

test('the fan shows as connecting until it answers, then reports its state and the room', async () => {
  const { fan, session, states } = setup();
  await session.start();
  assert.equal(states[0]!.fan.ok, null);
  await until(() => session.state.fan.ok === true);
  assert.equal(session.state.fan.temperatureC, fan.room.temperatureC);
  assert.equal(session.state.fan.speed, 3);
  assert.equal(session.state.machine?.name, 'Test fan');
  assert.equal('apPasswordHash' in session.state.machine!, false);
  await session.stop();
});

test('a single failure is not reported, repeated ones are', async () => {
  const { fan, session, states, last } = setup();
  fan.reachable = false;
  await session.start();
  await until(() => last().fan.ok === false);
  assert.equal(last().fan.problem, 'unreachable');
  assert.ok(states.every((s) => s.fan.ok !== true));
  const before = fan.reads;
  fan.reachable = true;
  await until(() => last().fan.ok === true);
  assert.ok(fan.reads > before);
  await session.stop();
});

test('a refused password is reported at once', async () => {
  const { fan, session, last } = setup();
  fan.refuse = true;
  await session.start();
  await until(() => last().fan.ok === false);
  assert.equal(last().fan.problem, 'unauthorized');
  await session.stop();
});

test('a state sent by the fan itself is shown', async () => {
  const { fan, session, last } = setup();
  await session.start();
  await until(() => session.state.fan.ok === true);
  await fan.apply({ speed: 8, power: true }); // someone used the remote
  assert.equal(last().fan.speed, 8);
  await session.stop();
});

test('suspend keeps the fan, resume restarts the sensor', async () => {
  const { fan, sensor, session } = setup();
  await session.start();
  sensor.connect();
  sensor.value(170);
  await until(() => fan.commands.length > 0);
  await session.suspend();
  assert.equal(session.state.status.code, 'suspended');
  assert.equal(fan.current.power, true);
  await session.resume();
  assert.equal(sensor.runs.length, 2);
  await session.stop();
  assert.equal(fan.current.power, false);
});

test('the speed test runs through every zone then restores the fan', async () => {
  const { fan, session } = setup();
  const shown: number[] = [];
  session.on('test', (z) => shown.push(z.speed));
  await session.testSpeeds(30);
  assert.deepEqual(shown, [2, 4, 6, 8, 10]);
  assert.ok(fan.commands.length >= 3);
  assert.equal(fan.current.power, false);
  assert.equal(fan.current.speed, 3);
  assert.equal(session.testing, false);
});

test('the demo sensor ramps between its bounds', async () => {
  const metric = metricFor(configured({ source: 'power', ftp: 200 }));
  const values: number[] = [];
  const events: string[] = [];
  const controller = new AbortController();
  const run = demoSensor(metric, { signal: controller.signal, onValue: (m) => values.push(m.value), onEvent: (e) => events.push(e.type) }, 1);
  await until(() => values.length > 100, 5000);
  controller.abort();
  await run;
  assert.deepEqual(events, ['searching', 'connecting', 'connected']);
  assert.ok(Math.min(...values) >= 80 && Math.max(...values) <= 260);
});

test('with a cooldown, the fan stays up after the zone drops and the state shows where it heads', async () => {
  let clock = 0;
  // The clock jumps 10 minutes without a measurement: no idle stop here, only the curve is tested.
  const { fan, sensor, session, last } = setup({ maxHr: 200, cooldown: 'normal' }, { now: () => clock, idleStopMs: Infinity });
  try {
    await session.start();
    sensor.connect();
    sensor.value(190); // Z5 -> 10
    await until(() => fan.current.speed === 10);
    for (let s = 0; s < 300; s++) {
      clock += 1000;
      sensor.value(190);
    }
    sensor.value(110); // Z1 -> 2
    assert.equal(last().zone?.speed, 2);
    assert.deepEqual(last().drive, { speed: 10, target: 2 });
    await sleep(30);
    assert.equal(fan.current.speed, 10); // still cooling down
    clock += 600_000; // the next tick of the watchdog moves the curve on
    await until(() => last().drive?.speed === 9);
  } finally {
    await session.stop();
  }
});

test('direction "keep" never touches it', async () => {
  const { fan, sensor, session } = setup();
  fan.current.oscillating = true;
  await session.start();
  sensor.connect();
  sensor.value(170);
  await until(() => fan.commands.length > 0);
  await session.stop();
  assert.ok(fan.commands.every((c) => !('oscillate' in c)));
  assert.equal(fan.current.oscillating, true);
});

test('a fan sweeping before the ride sweeps again after it', async () => {
  const { fan, sensor, session } = setup({ airDirection: 'fixed', airAngle: 151 });
  fan.current = { ...fan.current, oscillating: true, angles: { lower: 24, upper: 114 } };
  await session.start();
  sensor.connect();
  sensor.value(170);
  await until(() => fan.commands.length === 1);
  assert.deepEqual(fan.commands[0]!.angles, { lower: 151, upper: 151 });
  await session.stop();
  assert.deepEqual(fan.commands.at(-1), { speed: 3, oscillate: true, angles: { lower: 24, upper: 114 }, power: false });
});

test('aiming while riding applies at once; letting the fan decide puts its own direction back', async () => {
  const { fan, sensor, session } = setup();
  fan.current = { ...fan.current, angles: { lower: 151, upper: 151 } };
  await session.start();
  sensor.connect();
  sensor.value(170);
  await until(() => fan.commands.length === 1);
  await session.configure({ ...session.cfg, airDirection: 'fixed', airAngle: 69 });
  await until(() => fan.current.angles?.lower === 69);
  await session.configure({ ...session.cfg, airDirection: 'keep' });
  await until(() => fan.current.angles?.lower === 151);
  assert.deepEqual(fan.commands.at(-1), { oscillate: true, angles: { lower: 151, upper: 151 } });
  await session.stop();
});

test('capabilities revealed by the fan are reported once, to be saved', async () => {
  const { fan, session } = setup();
  const machines: string[][] = [];
  session.on('machine', (m) => machines.push(m.firmwareCapabilities ?? []));
  fan.detected = { ...session.cfg.fan!, firmwareCapabilities: ['AdvanceOscillationDay1'] };
  await session.start();
  await until(() => session.state.fan.ok === true);
  assert.deepEqual(machines, [['AdvanceOscillationDay1']]);
  assert.equal(session.state.fan.oscillating, false);
  assert.deepEqual(session.state.fan.angles, { lower: 24, upper: 114 });
  await session.stop();
});

test('fixed direction: the fan points at one angle, and is put back at the end', async () => {
  const { fan, sensor, session } = setup({ airDirection: 'fixed', airAngle: 120 });
  await session.start();
  sensor.connect();
  sensor.value(170);
  await until(() => fan.commands.length === 1);
  assert.deepEqual(fan.commands[0], { speed: 8, oscillate: true, angles: { lower: 120, upper: 120 }, power: true });
  await session.configure({ ...session.cfg, airAngle: 135 }); // aimed from the bike
  await until(() => fan.current.angles?.lower === 135);
  assert.deepEqual(fan.commands.at(-1), { oscillate: true, angles: { lower: 135, upper: 135 } });
  await session.stop();
  assert.deepEqual(fan.commands.at(-1), { speed: 3, oscillate: false, power: false });
});

test('fixed direction without a saved angle points at the middle of the fan range', async () => {
  const { fan, sensor, session } = setup({ airDirection: 'fixed' });
  await session.start();
  sensor.connect();
  sensor.value(170);
  await until(() => fan.commands.length === 1);
  assert.deepEqual(fan.commands[0]!.angles, { lower: 69, upper: 69 });
  await session.stop();
});

test('a fan pointed at a fixed angle before the ride is pointed there again at the end', async () => {
  const { fan, sensor, session } = setup({ airDirection: 'fixed', airAngle: 69 });
  fan.current = { ...fan.current, power: true, oscillating: false, angles: { lower: 151, upper: 151 } }; // set in the Dyson app
  await session.start();
  sensor.connect();
  sensor.value(170);
  await until(() => fan.commands.length === 1);
  assert.deepEqual(fan.commands[0]!.angles, { lower: 69, upper: 69 });
  await session.stop();
  assert.deepEqual(fan.commands.at(-1), { speed: 3, oscillate: true, angles: { lower: 151, upper: 151 }, power: true });
  assert.deepEqual(fan.current.angles, { lower: 151, upper: 151 });
});

test('a fan already pointed at the wanted angle gets no direction command', async () => {
  const { fan, sensor, session } = setup({ airDirection: 'fixed', airAngle: 151 });
  fan.current = { ...fan.current, oscillating: false, angles: { lower: 151, upper: 151 } };
  await session.start();
  sensor.connect();
  sensor.value(170);
  await until(() => fan.commands.length === 1);
  await session.stop();
  assert.ok(fan.commands.every((c) => !('oscillate' in c)));
});

test('search offsets: right up to the span, left down to minus the span, back to the center', () => {
  assert.deepEqual(scanOffsets(3, 1), [1, 2, 3, 2, 1, 0, -1, -2, -3, -2, -1, 0]);
});

const SCAN = { scanTiming: { spanDeg: 3, stepDeg: 1, stepMs: 20, reactionMs: 0 } };

test('the search needs a ride, sways degree by degree, and keeps the angle at stop', async () => {
  const { fan, sensor, session, last } = setup({}, SCAN);
  assert.throws(() => session.startScan(150), /start riding/);
  await session.start();
  sensor.connect();
  sensor.value(170);
  await until(() => fan.commands.length === 1);
  session.startScan(150);
  assert.deepEqual(last().scan, { fine: false, center: 150, angle: 150, span: 3 });
  await until(() => last().scan?.angle === 153);
  await until(() => fan.current.angles?.lower === 153);
  const kept = session.stopScan(true);
  assert.ok(kept !== null && kept >= 147 && kept <= 153, `kept ${kept}`);
  assert.equal(last().scan, null);
  await until(() => fan.current.angles?.lower === kept);
  const sent = fan.commands.filter((c) => c.angles).map((c) => c.angles!.lower);
  for (let i = 1; i < sent.length; i++) assert.ok(Math.abs(sent[i]! - sent[i - 1]!) <= 3, 'slow steps');
  await session.stop();
});

test('the kept angle allows for the reaction time', async () => {
  let clock = 0;
  const { fan, sensor, session } = setup({}, { now: () => clock, scanTiming: { spanDeg: 15, stepDeg: 1, stepMs: 10, reactionMs: 3000 } });
  await session.start();
  sensor.connect();
  sensor.value(170);
  await until(() => fan.commands.length === 1);
  session.startScan(150);
  for (let i = 0; i < 6; i++) {
    clock += 1000; // one degree a second
    await until(() => session.state.scan?.angle === 151 + i);
  }
  assert.equal(session.state.scan?.angle, 156);
  assert.equal(session.stopScan(true), 153); // what was felt 3 s before the press
  await session.stop();
});

test('cancelling the search goes back to the direction setting', async () => {
  const { fan, sensor, session } = setup({ airDirection: 'fixed', airAngle: 120 }, SCAN);
  await session.start();
  sensor.connect();
  sensor.value(170);
  await until(() => fan.current.angles?.lower === 120);
  session.startScan(120, { fine: true });
  await until(() => fan.current.angles?.lower !== 120);
  assert.equal(session.stopScan(false), null);
  await until(() => fan.current.angles?.lower === 120);
  await session.stop();
});

test('taking over a search by hand leaves the fan where it is until the new angle is saved', async () => {
  const { fan, sensor, session } = setup({ airDirection: 'fixed', airAngle: 120 }, SCAN);
  await session.start();
  sensor.connect();
  sensor.value(170);
  await until(() => fan.current.angles?.lower === 120);
  session.startScan(120);
  await until(() => fan.current.angles?.lower === 122);
  const commands = fan.commands.length;
  session.stopScan(false, { hold: true });
  await sleep(60);
  assert.ok(fan.commands.slice(commands).every((c) => c.angles?.lower !== 120), 'no trip back to 120');
  await session.configure({ ...session.cfg, airAngle: 140 }); // released on the dial
  await until(() => fan.current.angles?.lower === 140);
  await session.stop();
});
