import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configDir, DEFAULTS, isComplete, load, publicConfig, save, validateMachine, validatePatch } from '../src/config.ts';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'wattpure-')), 'config.json');
const FAN = { serialNumber: 'A1B-EU-ABC1234A', type: '527', apPasswordHash: 'secret-hash' };

test('heart rate is the default source, with one speed per zone', () => {
  assert.equal(DEFAULTS.source, 'hr');
  assert.equal(DEFAULTS.hrSpeeds.length, 5);
  assert.equal(DEFAULTS.powerSpeeds.length, 6);
});

test('config directory per platform', () => {
  assert.equal(configDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32'), join('C:\\Users\\me\\AppData\\Roaming', 'wattpure'));
  assert.equal(configDir({ XDG_CONFIG_HOME: '/xdg' }, 'linux'), join('/xdg', 'wattpure'));
  assert.match(configDir({}, 'darwin'), /\.config[/\\]wattpure$/);
});

test('missing file gives the defaults; saved values win', () => {
  const path = tmp();
  assert.deepEqual(load(path), DEFAULTS);
  writeFileSync(path, JSON.stringify({ maxHr: 180 }));
  const cfg = load(path);
  assert.equal(cfg.maxHr, 180);
  assert.equal(cfg.source, 'hr');
});

test('save then load round-trips, readable by the user only', () => {
  const path = tmp();
  save({ ...DEFAULTS, fan: FAN }, path);
  assert.deepEqual(load(path).fan, FAN);
  assert.ok(readFileSync(path, 'utf8').endsWith('\n'));
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('settings of the earlier sweep feature are dropped, a fixed direction is kept', () => {
  const path = tmp();
  writeFileSync(path, JSON.stringify({ oscillation: 'fixed', oscillationAngles: { lower: 24, upper: 114 }, airAngle: 151 }));
  const cfg = load(path) as unknown as Record<string, unknown>;
  assert.equal(cfg.airDirection, 'fixed');
  assert.equal(cfg.airAngle, 151);
  assert.equal('oscillation' in cfg || 'oscillationAngles' in cfg, false);
  writeFileSync(path, JSON.stringify({ oscillation: 'on' }));
  assert.equal(load(path).airDirection, 'keep');
});

test('a corrupted file gives a clear error', () => {
  const path = tmp();
  writeFileSync(path, '{ nope');
  assert.throws(() => load(path), /unreadable config file/);
});

test('isComplete needs a fan with its password', () => {
  assert.equal(isComplete(DEFAULTS), false);
  assert.equal(isComplete({ ...DEFAULTS, fan: { ...FAN, apPasswordHash: '' } }), false);
  assert.equal(isComplete({ ...DEFAULTS, fan: FAN }), true);
});

test('the public config hides the fan password', () => {
  const pub = publicConfig({ ...DEFAULTS, fan: { ...FAN, name: 'Office' } });
  assert.deepEqual(pub.fan, { serialNumber: FAN.serialNumber, type: '527', name: 'Office', productName: null, aimable: false });
  assert.doesNotMatch(JSON.stringify(pub), /secret-hash/);
});

test('validatePatch coerces and bounds values', () => {
  assert.deepEqual(validatePatch({ ftp: '260', maxHr: 185.4 }), { ftp: 260, maxHr: 185 });
  assert.throws(() => validatePatch({ ftp: 20 }), /ftp must be between 50 and 2000/);
  assert.throws(() => validatePatch({ maxHr: '' }), /maxHr/);
  assert.throws(() => validatePatch({ source: 'cadence' }), /source/);
  assert.throws(() => validatePatch({ fan: FAN }), /unknown setting/);
  assert.throws(() => validatePatch([]), /invalid settings/);
  assert.deepEqual(validatePatch({ hrSpeeds: ['0', 2, 10] }), { hrSpeeds: [0, 2, 10] });
  assert.throws(() => validatePatch({ powerSpeeds: [1, 11] }), /powerSpeeds/);
  assert.throws(() => validatePatch({ powerSpeeds: [1.5] }), /powerSpeeds/);
  assert.throws(() => validatePatch({ hrSpeeds: [] }), /invalid hrSpeeds/);
  assert.deepEqual(validatePatch({ fanHost: ' 192.168.1.181 ' }), { fanHost: '192.168.1.181' });
  assert.deepEqual(validatePatch({ fanHost: '' }), { fanHost: null });
  assert.throws(() => validatePatch({ fanHost: 'http://x' }), /fan address/);
  assert.deepEqual(validatePatch({ powerMeter: { id: 'abc' }, hrm: null }), { powerMeter: { id: 'abc', name: null }, hrm: null });
  assert.deepEqual(validatePatch({ language: 'fr', restoreOnExit: 0, coolOnly: 1 }), { language: 'fr', restoreOnExit: false, coolOnly: true });
  assert.throws(() => validatePatch({ language: 'de' }), /language/);
  assert.deepEqual(validatePatch({ cooldown: 'long' }), { cooldown: 'long' });
  assert.throws(() => validatePatch({ cooldown: 'forever' }), /cooldown/);
  assert.equal(DEFAULTS.cooldown, 'normal');
  assert.equal(DEFAULTS.airDirection, 'keep');
  assert.deepEqual(validatePatch({ airDirection: 'fixed', airAngle: '120' }), { airDirection: 'fixed', airAngle: 120 });
  assert.throws(() => validatePatch({ airDirection: 'sweep' }), /airDirection/);
  assert.throws(() => validatePatch({ oscillation: 'on' }), /unknown setting/);
  assert.throws(() => validatePatch({ airAngle: 360 }), /airAngle/);
  assert.throws(() => validatePatch({ airAngle: 12.5 }), /airAngle/);
});

test('validateMachine cleans a fan typed by hand', () => {
  assert.deepEqual(validateMachine({ serialNumber: ' a1b-eu-abc1234a ', type: '527k', apPasswordHash: ' secret-hash ', name: '' }), { ...FAN, type: '527K' });
  assert.throws(() => validateMachine({ ...FAN, serialNumber: 'x' }), /serial/);
  assert.throws(() => validateMachine({ ...FAN, type: '5' }), /product type/);
  assert.throws(() => validateMachine({ ...FAN, apPasswordHash: 'short' }), /password/);
});
