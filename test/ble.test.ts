import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHr, parseHrMeasurement, parsePower, SENSORS } from '../src/ble.ts';

test('heart rate on 8 and 16 bits', () => {
  assert.equal(parseHr(Buffer.from([0x00, 142])), 142);
  assert.equal(parseHr(Buffer.from([0x01, 0x2c, 0x01])), 300);
});

test('skin contact flags of the heart rate strap', () => {
  assert.deepEqual(parseHrMeasurement(Buffer.from([0x00, 120])), { value: 120, contact: null }); // not supported
  assert.deepEqual(parseHrMeasurement(Buffer.from([0x06, 120])), { value: 120, contact: true });
  assert.deepEqual(parseHrMeasurement(Buffer.from([0x04, 0])), { value: 0, contact: false });
});

test('Cycling Power: int16 after the flags', () => {
  assert.equal(parsePower(Buffer.from([0x00, 0x00, 0xf5, 0x00])), 245);
  assert.equal(parsePower(Buffer.from([0x34, 0x00, 0x20, 0x03, 0x01, 0x02])), 800);
  assert.deepEqual(SENSORS.power.parse(Buffer.from([0, 0, 100, 0])), { value: 100, contact: null });
});

test('truncated frames throw instead of returning garbage', () => {
  assert.throws(() => parsePower(Buffer.from([0x00, 0x00])));
});
