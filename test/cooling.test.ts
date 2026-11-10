import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approach, coolingParams, CoolingCurve } from '../src/cooling.ts';

/** Runs the curve second by second over [from, to) seconds with a constant zone speed. */
function ride(curve: CoolingCurve, target: number, from: number, to: number): number[] {
  const speeds: number[] = [];
  for (let s = from; s < to; s++) speeds.push(curve.update(target, s * 1000));
  return speeds;
}

const firstAt = (speeds: number[], predicate: (s: number) => boolean) => speeds.findIndex(predicate);

test('first-order approach', () => {
  assert.equal(approach(0, 10, 5, 0), 10);
  assert.ok(Math.abs(approach(0, 10, 10, 10) - 10 * (1 - Math.exp(-1))) < 1e-9);
});

test('off: the fan follows the zone speed at once, both ways', () => {
  const curve = new CoolingCurve(coolingParams('off', 'hr'));
  assert.deepEqual([curve.update(2, 0), curve.update(8, 1000), curve.update(3, 2000), curve.update(0, 3000)], [2, 8, 3, 0]);
});

test('heart rate: the fan rises within seconds (the heart rate already lags the effort)', () => {
  const curve = new CoolingCurve(coolingParams('normal', 'hr'));
  ride(curve, 2, 0, 300);
  const up = ride(curve, 8, 300, 360);
  assert.ok(firstAt(up, (s) => s >= 7) <= 15, `reached 7 after ${firstAt(up, (s) => s >= 7)} s`);
  assert.equal(up.at(-1), 8);
});

test('power: a 10 s sprint does not send the fan to full speed', () => {
  const curve = new CoolingCurve(coolingParams('normal', 'power'));
  ride(curve, 3, 0, 300);
  const sprint = ride(curve, 10, 300, 310);
  assert.ok(Math.max(...sprint) <= 7, `max ${Math.max(...sprint)}`);
});

test('after the peak, the fan comes down slowly, one step at a time', () => {
  const curve = new CoolingCurve(coolingParams('normal', 'hr'));
  ride(curve, 2, 0, 60);
  ride(curve, 10, 60, 360); // 5 min at full effort
  const recovery = ride(curve, 2, 360, 1200);
  // Still strong a minute after the effort, down to the zone speed within ~10 minutes.
  assert.ok(recovery[60]! >= 7, `speed after 1 min: ${recovery[60]}`);
  assert.equal(recovery.at(-1), 2);
  for (let i = 1; i < recovery.length; i++) assert.ok(recovery[i - 1]! - recovery[i]! <= 1, 'one step at a time');
});

test('a long effort keeps the fan up longer than a short one', () => {
  const after = (effortS: number) => {
    const curve = new CoolingCurve(coolingParams('normal', 'hr'));
    ride(curve, 2, 0, 60);
    ride(curve, 9, 60, 60 + effortS);
    const recovery = ride(curve, 2, 60 + effortS, 60 + effortS + 900);
    return firstAt(recovery, (s) => s <= 3);
  };
  const short = after(30);
  const long = after(1200);
  assert.ok(long > short + 60, `short ${short} s, long ${long} s`);
});

test('the cooldown presets order the recovery time', () => {
  const recoveryTime = (preset: 'short' | 'normal' | 'long') => {
    const curve = new CoolingCurve(coolingParams(preset, 'hr'));
    ride(curve, 2, 0, 60);
    ride(curve, 10, 60, 660);
    return firstAt(ride(curve, 2, 660, 2400), (s) => s <= 3);
  };
  const [short, normal, long] = [recoveryTime('short'), recoveryTime('normal'), recoveryTime('long')];
  assert.ok(short < normal && normal < long, `${short} < ${normal} < ${long}`);
});

test('a measurement hovering on a zone boundary does not make the fan hunt', () => {
  const curve = new CoolingCurve(coolingParams('normal', 'hr'));
  ride(curve, 6, 0, 300);
  const speeds: number[] = [];
  // Zone flips between 6 and 8 every 10 s for 5 minutes.
  for (let s = 300; s < 600; s++) speeds.push(curve.update(Math.floor(s / 10) % 2 ? 8 : 6, s * 1000));
  const changes = speeds.filter((v, i) => i > 0 && v !== speeds[i - 1]).length;
  assert.ok(changes <= 3, `${changes} speed changes`);
});

test('a zone at 0 turns the fan off only once the level is down', () => {
  const curve = new CoolingCurve(coolingParams('short', 'hr'));
  ride(curve, 5, 0, 300);
  const speeds = ride(curve, 0, 300, 900);
  assert.notEqual(speeds[5], 0);
  assert.equal(speeds.at(-1), 0);
});

test('new settings keep the current level', () => {
  const curve = new CoolingCurve(coolingParams('normal', 'hr'));
  ride(curve, 8, 0, 120);
  curve.setParams(coolingParams('long', 'power'));
  assert.equal(curve.update(8, 121_000), 8);
});
