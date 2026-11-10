/**
 * Local server for the UI: static files, JSON API and state stream (server-sent events).
 *
 * Only listens on 127.0.0.1. Every launch draws a random token required by all /api routes,
 * so a web page opened in a browser cannot drive the app. The Host header is checked against
 * DNS rebinding.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ConfigStore, host as validHost, isComplete, publicConfig, validateMachine, validatePatch } from './config.ts';
import { CloudError, type DysonCloud, type FanFactory, fanError, FanError, machineOption } from './dyson.ts';
import { EMPTY_FAN, fanInfo, type Session } from './engine.ts';
import type { AppInfo, Config, ErrorCode, EventMap, FanCheck, FanMachine, PublicConfig, SensorDevice, Source, StateResponse } from './shared/types.ts';

/** Compiled UI: dist/ui (pages, styles, scripts) and dist/src/shared (modules imported by the UI). */
export const WEB_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC_PREFIXES = ['ui', join('src', 'shared')];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const CSP = "default-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode | undefined;

  constructor(status: number, message: string, code?: ErrorCode) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface DysonApi {
  cloud: DysonCloud;
  createFan: FanFactory;
}

export type ScanFn = (kind: Source, options: { signal: AbortSignal }) => Promise<SensorDevice[]>;

export interface ServerDeps {
  session: Session;
  store: ConfigStore;
  dyson: DysonApi;
  scan: ScanFn;
  info: Omit<AppInfo, 'configPath'>;
  onQuit?: () => void;
  /** Another launch asked this instance to show itself. */
  onFocus?: () => void;
  /** Number of connected UIs changed (used to quit when the last browser tab closes). */
  onClients?: (count: number) => void;
  token?: string;
}

const FAN_CODES = { unauthorized: 'fanUnauthorized', unreachable: 'fanUnreachable', unsupported: 'fanUnsupported' } as const;

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'request too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

/** Account country, two capital letters; the global cloud logs in any account but Chinese ones. */
function country(value: unknown): string {
  return typeof value === 'string' && /^[A-Z]{2}$/.test(value) ? value : 'US';
}

function sameToken(given: unknown, token: string): boolean {
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof CloudError) return new HttpError(err.code === 'cloudUnreachable' ? 502 : 400, err.message, err.code);
  if (err instanceof FanError) return new HttpError(502, err.message, FAN_CODES[err.problem]);
  return new HttpError(400, (err as Error)?.message ?? String(err));
}

const text = (value: unknown, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

export function createServer({
  session,
  store,
  dyson,
  scan,
  info,
  onQuit = () => {},
  onFocus = () => {},
  onClients = () => {},
  token = randomBytes(24).toString('base64url'),
}: ServerDeps) {
  let cfg = store.load();
  let port = 0;
  const clients = new Set<ServerResponse>();
  /** Machines of the Dyson account from the last login, with their local password: never sent to the UI. */
  let found = new Map<string, FanMachine>();

  const broadcast = <K extends keyof EventMap>(event: K, data: EventMap[K]) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  };
  session.on('state', (state) => broadcast('state', state));
  session.on('test', (zone) => broadcast('test', zone));
  session.on('machine', (machine) => {
    if (cfg.fan?.serialNumber === machine.serialNumber) void applyConfig({ fan: machine }).catch(() => {});
  });

  async function applyConfig(patch: Partial<Config>): Promise<PublicConfig> {
    cfg = { ...cfg, ...patch };
    store.save(cfg);
    broadcast('config', publicConfig(cfg));
    await session.configure(cfg);
    return publicConfig(cfg);
  }

  /** Aborts the work in progress when the UI gives up on the request (window closed, Cancel button). */
  const abortOnClose = (res: ServerResponse) => {
    const controller = new AbortController();
    res.on('close', () => !res.writableFinished && controller.abort());
    return controller.signal;
  };

  const routes: Record<string, Handler> = {
    'GET /api/state': (): StateResponse => ({
      app: { ...info, configPath: store.path },
      config: publicConfig(cfg),
      session: session.state,
    }),

    'POST /api/config': async (req) => ({ config: await applyConfig(validatePatch(await readJson(req))) }),

    'POST /api/session/start': async () => (await session.start(), { session: session.state }),
    'POST /api/session/stop': async () => (await session.stop(), { session: session.state }),
    'POST /api/session/test-speeds': () => {
      session.testSpeeds().catch(() => {}); // progress is reported through the event stream
      return { ok: true };
    },

    /** Setup, step 1: Dyson emails a code. */
    'POST /api/dyson/code': async (req) => {
      const body = await readJson(req);
      const email = text(body.email);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'invalid email address');
      return { challengeId: await dyson.cloud.requestCode(email, country(body.country)) };
    },

    /** Setup, step 2: logs in and lists the fans of the account. Nothing of the account is kept. */
    'POST /api/dyson/login': async (req) => {
      const body = await readJson(req);
      const machines = await dyson.cloud.machines({
        email: text(body.email),
        password: typeof body.password === 'string' ? body.password : '',
        country: country(body.country),
        challengeId: text(body.challengeId) || null,
        otpCode: text(body.otpCode, 12).replace(/\s/g, '') || null,
      });
      found = new Map(machines.map((m) => [m.serialNumber, m]));
      return { machines: machines.map((m) => machineOption(m)) };
    },

    /** Setup, step 3: keeps the chosen fan. */
    'POST /api/dyson/select': async (req) => {
      const machine = found.get(text((await readJson(req)).serialNumber));
      if (!machine) throw new HttpError(404, 'unknown machine: log in again', 'noMachine');
      return { config: await applyConfig({ fan: machine, fanHost: null }) };
    },

    /** Fan typed by hand: serial number, product type, local password (and address). */
    'POST /api/dyson/manual': async (req) => {
      const body = await readJson(req);
      const machine = validateMachine(body);
      return { config: await applyConfig({ fan: machine, fanHost: validHost(body.host ?? null) }) };
    },

    /** Direction search: the fan sways around `center` until stop. */
    'POST /api/air/scan/start': async (req) => {
      const body = await readJson(req);
      const center = Number(body.center);
      if (!Number.isFinite(center) || center < 5 || center > 355) throw new HttpError(400, 'invalid angle');
      try {
        session.startScan(center, { fine: Boolean(body.fine) });
      } catch (err) {
        throw new HttpError(409, (err as Error).message, 'notRiding');
      }
      return { session: session.state };
    },

    /** Ends the search; with `keep`, the angle felt best becomes the fixed direction. */
    'POST /api/air/scan/stop': async (req) => {
      const body = await readJson(req);
      const keep = Boolean(body.keep);
      const angle = session.stopScan(keep, { hold: Boolean(body.hold) });
      if (angle !== null) await applyConfig({ airDirection: 'fixed', airAngle: angle });
      return { angle, session: session.state };
    },

    /** Connects to the fan with the saved settings and reads it (without changing anything). */
    'POST /api/fan/check': async (): Promise<FanCheck> => {
      if (!isComplete(cfg)) throw new HttpError(409, 'no fan set up yet', 'notConfigured');
      const fan = (() => {
        try {
          return dyson.createFan(cfg.fan!, cfg.fanHost);
        } catch (err) {
          throw fanError(err);
        }
      })();
      try {
        await fan.connect();
        const upgraded = await fan.detectMachine().catch(() => null);
        if (upgraded) await applyConfig({ fan: upgraded });
        const state = await fan.state();
        const readings = await fan.readings().catch(() => null);
        return { hostType: fan.hostType, fan: fanInfo(EMPTY_FAN, state, readings, null) };
      } finally {
        await fan.close();
      }
    },

    'POST /api/sensors/scan': async (req, res) => {
      const { kind } = await readJson(req);
      if (kind !== 'power' && kind !== 'hr') throw new HttpError(400, 'invalid sensor type');
      // One Bluetooth scan at a time: reading is suspended during the scan.
      await session.suspend();
      try {
        return { devices: await scan(kind, { signal: abortOnClose(res) }) };
      } catch (err) {
        throw new HttpError(500, (err as Error).message, 'bluetooth');
      } finally {
        await session.resume();
      }
    },

    'POST /api/focus': () => {
      onFocus();
      return { ok: true };
    },

    'POST /api/quit': () => {
      setTimeout(onQuit, 50);
      return { ok: true };
    },
  };

  function events(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(session.state)}\n\n`);
    clients.add(res);
    onClients(clients.size);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
      onClients(clients.size);
    });
  }

  async function serveStatic(pathname: string, res: ServerResponse) {
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(pathname === '/' ? '/ui/index.html' : pathname)).replace(/^[/\\]+/, '');
    } catch {
      throw new HttpError(400, 'invalid path');
    }
    const allowed = PUBLIC_PREFIXES.some((prefix) => rel.startsWith(prefix + sep)) && !rel.split(sep).includes('..');
    if (!allowed || !MIME[extname(rel)]) throw new HttpError(404, 'not found');
    let body: Buffer;
    try {
      body = await readFile(join(WEB_ROOT, rel));
    } catch {
      throw new HttpError(404, 'not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(rel)]!,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': CSP,
    });
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'host not allowed');
      const url = new URL(req.url ?? '/', `http://${host}`);

      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
        return await serveStatic(url.pathname, res);
      }

      const isEvents = url.pathname === '/api/events';
      const given = isEvents ? url.searchParams.get('token') : req.headers['x-wattpure-token'];
      if (!sameToken(given, token)) throw new HttpError(401, 'invalid token');
      if (isEvents && req.method === 'GET') return events(req, res);

      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) throw new HttpError(404, 'unknown route');
      const result = await handler(req, res);
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result));
    } catch (err) {
      if (res.headersSent || res.destroyed) return;
      const { status, message, code } = toHttpError(err);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: message, code }));
    }
  });

  return {
    token,
    get config(): Config {
      return cfg;
    },
    async listen(wantedPort = 0): Promise<{ port: number; url: string }> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(wantedPort, '127.0.0.1', resolve);
      });
      port = (server.address() as { port: number }).port;
      return { port, url: `http://127.0.0.1:${port}/#${token}` };
    },
    async close(): Promise<void> {
      for (const res of clients) res.end();
      clients.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export type AppServer = ReturnType<typeof createServer>;
