import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { after, before, test } from 'node:test';
import { DEFAULTS } from '../src/config.ts';
import { Session } from '../src/engine.ts';
import { FakeFan, fakeDysonCloud, fakeFanFactory, SANDBOX_MACHINE } from '../src/fakes.ts';
import { type AppServer, createServer } from '../src/server.ts';
import type { Config } from '../src/shared/types.ts';
import { manualSensor } from './helpers.ts';

let server: AppServer;
let base: string;
let saved: Config[] = [];
let session: Session;
const fan = new FakeFan();
const scans: string[] = [];

function memoryStore(initial: Config) {
  let cfg = initial;
  return {
    path: '/tmp/wattpure-test.json',
    load: () => cfg,
    save: (next: Config) => {
      cfg = next;
      saved.push(next);
    },
  };
}

before(async () => {
  const createFan = fakeFanFactory(fan);
  session = new Session(DEFAULTS, { sensor: manualSensor().fn, createFan });
  server = createServer({
    session,
    store: memoryStore({ ...DEFAULTS }),
    dyson: { cloud: fakeDysonCloud([SANDBOX_MACHINE, { serialNumber: 'OLD-EU-LINK0001', type: '999', apPasswordHash: 'x'.repeat(20), name: 'Unknown model' }], 10), createFan },
    scan: async (kind) => {
      scans.push(`${kind}:${session.state.status.code}`);
      return [{ id: 'hrm', name: 'HRM-Pro', rssi: -50 }];
    },
    info: { version: 'test', mode: 'browser', demo: false, platform: 'test' },
    token: 'secret-token-for-tests',
  });
  ({ url: base } = await server.listen());
  base = base.split('#')[0]!.replace(/\/$/, '');
});

after(async () => {
  await session.stop();
  await server.close();
});

/** Response body as loosely typed JSON. */
const json = async (res: Response): Promise<any> => res.json();

const call = (path: string, init: RequestInit = {}, token = 'secret-token-for-tests') =>
  fetch(`${base}${path}`, { ...init, headers: { 'X-Wattpure-Token': token, 'Content-Type': 'application/json', ...init.headers } });
const post = (path: string, body: unknown = {}) => call(path, { method: 'POST', body: JSON.stringify(body) });

test('API calls need the token', async () => {
  assert.equal((await call('/api/state', {}, 'wrong')).status, 401);
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal((await call('/api/state')).status, 200);
});

test('foreign Host headers are refused (DNS rebinding)', async () => {
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(`${base}/api/state`, { headers: { Host: 'evil.example:80', 'X-Wattpure-Token': 'secret-token-for-tests' } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('before the setup, the state asks for it', async () => {
  const body = await json(await call('/api/state'));
  assert.equal(body.config.fan, null);
  assert.equal(body.config.source, 'hr');
  assert.equal(body.app.configPath, '/tmp/wattpure-test.json');
  assert.equal(body.session.status.code, 'unconfigured');
});

test('static files are served, other paths are not', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.match(await page.text(), /<title>WattPure<\/title>/);
  assert.equal((await fetch(`${base}/ui/style.css`)).status, 200);
  for (const path of ['/package.json', '/src/server.ts', '/ui/../package.json', '/ui/%2e%2e/package.json', '/src/shared/../config.ts']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});

test('config updates are validated and saved; the fan cannot be set through them', async () => {
  saved = [];
  const ok = await post('/api/config', { maxHr: '185', hrSpeeds: [1, 3, 5, 7, 10] });
  assert.equal(ok.status, 200);
  assert.equal((await json(ok)).config.maxHr, 185);
  assert.deepEqual(saved.at(-1)!.hrSpeeds, [1, 3, 5, 7, 10]);
  const bad = await post('/api/config', { hrSpeeds: [1, 11] });
  assert.equal(bad.status, 400);
  assert.match((await json(bad)).error, /speeds/);
  assert.equal((await post('/api/config', { fan: SANDBOX_MACHINE })).status, 400);
});

test('fan check needs a fan', async () => {
  const res = await post('/api/fan/check');
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'notConfigured');
});

test('Dyson login: code, then machines without their password', async () => {
  assert.equal((await post('/api/dyson/code', { email: 'nope' })).status, 400);
  const code = await json(await post('/api/dyson/code', { email: 'rider@example.com', country: 'FR' }));
  assert.equal(code.challengeId, 'sandbox-challenge');
  const wrong = await post('/api/dyson/login', { email: 'rider@example.com', challengeId: code.challengeId, otpCode: '12', password: 'pw' });
  assert.equal(wrong.status, 400);
  assert.equal((await json(wrong)).code, 'loginFailed');
  const res = await post('/api/dyson/login', { email: 'rider@example.com', challengeId: code.challengeId, otpCode: '123 456', password: 'pw' });
  const { machines } = await json(res);
  assert.deepEqual(
    machines.map((m: { serialNumber: string; supported: boolean }) => [m.serialNumber, m.supported]),
    [
      [SANDBOX_MACHINE.serialNumber, true],
      ['OLD-EU-LINK0001', false],
    ],
  );
  assert.doesNotMatch(JSON.stringify(machines), /password|sandbox-password/i);
});

test('picking a fan saves it with its password, never shown to the UI', async () => {
  assert.equal((await post('/api/dyson/select', { serialNumber: 'unknown' })).status, 404);
  const res = await post('/api/dyson/select', { serialNumber: SANDBOX_MACHINE.serialNumber });
  const { config } = await json(res);
  assert.equal(config.fan.serialNumber, SANDBOX_MACHINE.serialNumber);
  assert.doesNotMatch(JSON.stringify(config), /sandbox-password/);
  assert.equal(saved.at(-1)!.fan!.apPasswordHash, 'sandbox-password');
  const state = await call('/api/state');
  assert.doesNotMatch(await state.text(), /sandbox-password/);
});

test('fan check reads the fan without changing it', async () => {
  const res = await post('/api/fan/check');
  assert.equal(res.status, 200);
  const check = await json(res);
  assert.equal(check.hostType, 'local');
  assert.equal(check.fan.ok, true);
  assert.equal(check.fan.temperatureC, 19.2);
  assert.equal(fan.commands.length, 0);
  fan.refuse = true;
  const refused = await post('/api/fan/check');
  assert.equal(refused.status, 502);
  assert.equal((await json(refused)).code, 'fanUnauthorized');
  fan.refuse = false;
});

test('a fan typed by hand is validated', async () => {
  assert.equal((await post('/api/dyson/manual', { serialNumber: 'x', type: '527', apPasswordHash: 'abcdefghij' })).status, 400);
  assert.equal((await post('/api/dyson/manual', { serialNumber: 'A1B-EU-ABC1234A', type: '527', apPasswordHash: 'abcdefghij', host: 'bad host!' })).status, 400);
  const res = await post('/api/dyson/manual', { serialNumber: 'a1b-eu-abc1234a', type: '527', apPasswordHash: 'abcdefghij', host: '192.168.1.181' });
  assert.equal(res.status, 200);
  const { config } = await json(res);
  assert.equal(config.fan.serialNumber, 'A1B-EU-ABC1234A');
  assert.equal(config.fanHost, '192.168.1.181');
});

test('the session starts once set up; a scan suspends it', async () => {
  await post('/api/session/start');
  assert.equal(session.running, true);
  const res = await post('/api/sensors/scan', { kind: 'hr' });
  assert.deepEqual((await json(res)).devices, [{ id: 'hrm', name: 'HRM-Pro', rssi: -50 }]);
  assert.deepEqual(scans, ['hr:suspended']);
  assert.equal(session.running, true); // resumed
  assert.equal((await post('/api/sensors/scan', { kind: 'cadence' })).status, 400);
});

test('the event stream sends the current state first', async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events?token=secret-token-for-tests`, { signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /^event: state\ndata: \{/);
  controller.abort();
  assert.equal((await fetch(`${base}/api/events?token=nope`)).status, 401);
});
