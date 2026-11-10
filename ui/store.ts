/** Client-side copy of the app state, kept in sync by the server events. */
import { pickLanguage } from '../src/shared/i18n.ts';
import type { AppInfo, Config, Language, PublicConfig, SessionState, StateResponse } from '../src/shared/types.ts';
import { api } from './api.ts';
import { setLanguage } from './dom.ts';

export const store = {
  app: null as unknown as AppInfo,
  config: null as unknown as PublicConfig,
  session: null as unknown as SessionState,
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function onChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function languageFor(config: PublicConfig): Language {
  return config.language ?? pickLanguage(navigator.language);
}

export function init(data: StateResponse): void {
  Object.assign(store, data);
  setLanguage(languageFor(data.config));
}

export function setSession(session: SessionState): void {
  store.session = session;
  notify();
}

export function setConfig(config: PublicConfig): void {
  store.config = config;
  setLanguage(languageFor(config));
  notify();
}

/** Saves a partial config; the server validates it and restarts what needs to be. */
export async function saveConfig(patch: Partial<Config>): Promise<PublicConfig> {
  const { config } = await api.post<{ config: PublicConfig }>('config', patch);
  setConfig(config);
  return config;
}

/** The first-run setup is needed until a fan is set up. */
export const needsSetup = (config: PublicConfig) => !config.fan;
