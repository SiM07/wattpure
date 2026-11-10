import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DysonConnectionError, DysonError } from 'dyson-control';
import { DysonFan, fanError, FanError, isSupported, oscillationKind, toControl, toFanMachine, toReadings, withDetectedCapabilities } from '../src/dyson.ts';

const FAN = { serialNumber: 'A1B-EU-ABC1234A', type: '527', apPasswordHash: 'secret-hash' };

test('dyson-control errors become fan problems', () => {
  assert.equal(fanError(new DysonError('bad credentials', 401)).problem, 'unauthorized');
  assert.equal(fanError(new DysonError('no answer', 504)).problem, 'unreachable');
  assert.equal(fanError(new DysonConnectionError('refused')).problem, 'unreachable');
  assert.equal(fanError(new Error('boom')).problem, 'unreachable');
});

test('commands: power goes last so that "off" wins, heat only for heaters', () => {
  assert.deepEqual(Object.keys(toControl({ power: false, speed: 3, night: false, heat: 'off' }, true)), ['fanSpeed', 'nightMode', 'heatMode', 'fanPower']);
  assert.deepEqual(toControl({ speed: 5, heat: 'off', power: true }, false), { fanSpeed: 5, fanPower: true });
  assert.deepEqual(toControl({ auto: true }, true), { autoMode: true });
});

test('readings are rounded, missing ones are null', () => {
  assert.deepEqual(toReadings({ temperatureInC: 19.149999, humidityInPercent: 53, pm25InUgPerM3: null } as never), { temperatureC: 19.1, humidity: 53, pm25: null });
});

test('only machines with a local password are kept, with what the client needs', () => {
  assert.equal(toFanMachine({ serialNumber: 'X', type: '527' }), null);
  assert.deepEqual(toFanMachine({ ...FAN, name: 'Office', category: 'environmentalCare', remoteBrokerType: 'awsIot', firmwareCapabilities: [] }), { ...FAN, name: 'Office' });
});

test('known fan types are supported, others are refused up front', () => {
  assert.equal(isSupported(FAN), true);
  assert.equal(isSupported({ ...FAN, type: '438K' }), true);
  assert.equal(isSupported({ ...FAN, type: '999' }), false);
  assert.throws(() => new DysonFan({ ...FAN, type: '999' }, null), (err: FanError) => err.problem === 'unsupported');
});

test('oscillation: angles need the firmware capability, which the fan state reveals', () => {
  assert.equal(oscillationKind(FAN), 'basic');
  assert.equal(oscillationKind({ ...FAN, firmwareCapabilities: ['AdvanceOscillationDay1'] }), 'advanced');
  assert.equal(oscillationKind({ ...FAN, type: '999' }), 'none');
  assert.deepEqual(withDetectedCapabilities(FAN, { oson: 'OFF', osal: '0024', osau: '0114', ancp: 'CUST' })?.firmwareCapabilities, ['AdvanceOscillationDay1']);
  assert.equal(withDetectedCapabilities(FAN, { oson: 'OFF' }), null);
  assert.equal(withDetectedCapabilities({ ...FAN, firmwareCapabilities: ['Other'] }, { osal: '0024', osau: '0114' }), null);
});

test('oscillation commands: angles only for angle fans, nothing for fans that do not oscillate', () => {
  const angles = { lower: 135, upper: 225 };
  assert.deepEqual(toControl({ oscillate: true, angles }, false, 'advanced'), { oscillationMode: 'on', oscillationAngles: { lowerInDegrees: 135, upperInDegrees: 225 } });
  assert.deepEqual(toControl({ oscillate: true, angles }, false, 'basic'), { oscillationMode: 'on' });
  assert.deepEqual(toControl({ oscillate: false }, false, 'advanced'), { oscillationMode: 'off' });
  assert.deepEqual(toControl({ oscillate: true }, false, 'none'), {});
  assert.deepEqual(toControl({ oscillate: true, angles: { lower: 120, upper: 120 } }, false, 'advanced'), {
    oscillationMode: 'on',
    oscillationAngles: { lowerInDegrees: 120, upperInDegrees: 120 },
  });
});
