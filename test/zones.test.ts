import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHex, RollingAverage, toHex, ZoneTracker, zonesFromConfig, HR_ZONES, POWER_ZONES } from '../src/zones.ts';

test('heart rate zones with a max HR of 200', () => {
  const t = new ZoneTracker(HR_ZONES, 200);
  assert.deepEqual([100, 130, 150, 170, 190].map((hr) => t.rawZone(hr).number), [1, 2, 3, 4, 5]);
});

test('power zones with an FTP of 250', () => {
  const t = new ZoneTracker(POWER_ZONES, 250);
  assert.deepEqual([100, 150, 200, 240, 270, 300].map((w) => t.rawZone(w).number), [1, 2, 3, 4, 5, 6]);
});

test('hysteresis only applies on the way down', () => {
  const t = new ZoneTracker(HR_ZONES, 200, 3);
  assert.equal(t.update(150).number, 3); // Z3 threshold = 150
  assert.equal(t.update(149).number, 3); // within the margin
  assert.equal(t.update(147).number, 3);
  assert.equal(t.update(146).number, 2); // < 150 - 3
  assert.equal(t.update(150).number, 3); // back up without margin
});

test('values below the first threshold fall in zone 1', () => {
  const t = new ZoneTracker(POWER_ZONES, 250);
  assert.equal(t.update(0).number, 1);
});

test('custom zones from the config are sorted and numbered', () => {
  const zones = zonesFromConfig([
    { name: 'High', fromPct: 0.8, color: '#FF0000' },
    { name: 'Low', fromPct: 0, color: '#0000ff' },
  ]);
  assert.deepEqual(
    zones.map((z) => [z.number, z.name, z.color]),
    [
      [1, 'Low', [0, 0, 255]],
      [2, 'High', [255, 0, 0]],
    ],
  );
  assert.equal(zonesFromConfig(null, POWER_ZONES), POWER_ZONES);
});

test('hex colors', () => {
  assert.deepEqual(parseHex('#338cff'), [0x33, 0x8c, 0xff]);
  assert.equal(toHex([0x33, 0x8c, 0xff]), '#338CFF');
  assert.throws(() => parseHex('blue'), /invalid color/);
});

test('rolling average over 3 s', () => {
  const avg = new RollingAverage(3000);
  assert.equal(avg.push(100, 0), 100);
  assert.equal(avg.push(300, 1000), 200);
  assert.equal(avg.push(200, 2000), 200);
  assert.equal(avg.push(400, 4000), 300); // the t=0 sample leaves the window
});
