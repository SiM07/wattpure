/** Calls to the local wattpure server. The access token comes from the URL fragment. */
import type { ApiError, ErrorCode, EventMap } from '../src/shared/types.ts';

const token = decodeURIComponent(location.hash.slice(1));

export class ApiFailure extends Error {
  readonly code: ErrorCode | 'connection' | undefined;
  readonly status: number;

  constructor(message: string, status: number, code?: ErrorCode | 'connection') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/${path}`, {
      method,
      signal,
      headers: { 'X-Wattpure-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiFailure((err as Error).message, 0, 'connection');
  }
  const data = (await res.json().catch(() => ({}))) as T & Partial<ApiError>;
  if (!res.ok) throw new ApiFailure(data.error ?? res.statusText, res.status, data.code);
  return data;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => call<T>('GET', path, undefined, signal),
  post: <T>(path: string, body: unknown = {}, signal?: AbortSignal) => call<T>('POST', path, body, signal),
};

type Handlers = { [K in keyof EventMap]?: (data: EventMap[K]) => void } & { connection?: (online: boolean) => void };

/** Subscribes to the server events; the browser reconnects on its own after a drop. */
export function subscribe(handlers: Handlers): EventSource {
  const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  for (const name of ['state', 'config', 'test'] as const) {
    source.addEventListener(name, (event) => {
      const handler = handlers[name] as ((data: unknown) => void) | undefined;
      handler?.(JSON.parse((event as MessageEvent<string>).data));
    });
  }
  source.addEventListener('open', () => handlers.connection?.(true));
  source.addEventListener('error', () => handlers.connection?.(false));
  return source;
}
