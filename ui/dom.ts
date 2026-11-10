/** Tiny DOM helpers: enough for a few screens without a framework. */
import { type Params, translate } from '../src/shared/i18n.ts';
import type { Language } from '../src/shared/types.ts';
import { ApiFailure } from './api.ts';

type Child = Node | string | number | null | undefined | false;
type Props = {
  class?: string;
  text?: string;
  html?: string;
  dataset?: Record<string, string>;
  style?: Record<string, string>;
  [key: `on${string}`]: ((event: any) => void) | undefined;
  [key: string]: unknown;
};

/** Creates an element: h('button', { class: 'primary', onclick }, 'Label'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'html') el.innerHTML = String(value); // only used with the static icons below
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') for (const [prop, v] of Object.entries(value as Record<string, string>)) el.style.setProperty(prop, v);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value as EventListener);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  el.append(...children.filter((c): c is Node | string | number => c !== null && c !== undefined && c !== false).map((c) => (typeof c === 'number' ? String(c) : c)));
  return el;
}

export function replace(el: Element, ...children: Child[]): void {
  el.replaceChildren(...children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false && typeof c !== 'number'));
}

/** Current language, set once the config is known. */
let language: Language = 'en';
export const setLanguage = (lang: Language) => {
  language = lang;
  document.documentElement.lang = lang;
};
export const getLanguage = () => language;
export const t = (key: string, params?: Params, variant?: string) => translate(language, key, params, variant);

/** Readable message for an API failure. */
export function errorText(err: unknown): string {
  if (err instanceof ApiFailure && err.code) {
    const key = `error.${err.code}`;
    const text = t(key, { message: err.message });
    if (text !== key) return text;
  }
  return t('error.generic', { message: (err as Error)?.message ?? String(err) });
}

const svg = (body: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  bolt: svg('<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>'),
  heart: svg('<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/>'),
  fan: svg('<path d="M12 12c-3-1.5-3.5-6.5 0-8 3 1.3 2 5.5 0 8z"/><path d="M12 12c3.3-.3 6.7 3.4 4.8 6.6-3.2.4-4.8-3.6-4.8-6.6z"/><path d="M12 12c.3 3.3-4.3 5.6-7 3.2.1-3.3 4.3-3.9 7-3.2z"/><circle cx="12" cy="12" r="1.2"/>'),
  swing: svg('<path d="M5 15a7 7 0 0 1 14 0"/><path d="M2.5 12.5 5 15l2.5-2.5"/><path d="M16.5 12.5 19 15l2.5-2.5"/><circle cx="12" cy="18" r="1.5"/>'),
  thermometer: svg('<path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>'),
  droplet: svg('<path d="M12 2.69 17.66 8.35a8 8 0 1 1-11.31 0z"/>'),
  key: svg('<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  plus: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  flame: svg('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  alert: svg('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  info: svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  pause: svg('<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>'),
  play: svg('<path d="m6 3 14 9-14 9V3z"/>'),
  search: svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>'),
  palette: svg('<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 0 0 0 20c.93 0 1.5-.75 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16a6 6 0 0 0 6-6c0-4.97-4.48-9-10-9z"/>'),
} as const;

export const icon = (name: keyof typeof icons, cls = 'icon') => h('span', { class: cls, html: icons[name] });

export function spinner(): HTMLElement {
  return h('span', { class: 'spinner', role: 'progressbar', 'aria-busy': 'true' });
}

let toastTimer: number | undefined;
/** Short confirmation at the bottom of the screen. */
export function toast(message: string, level: 'ok' | 'error' = 'ok'): void {
  let el = document.querySelector<HTMLElement>('.toast');
  if (!el) {
    el = h('div', { class: 'toast', role: 'status' });
    document.body.append(el);
  }
  el.textContent = message;
  el.dataset.level = level;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('visible'), level === 'error' ? 5000 : 1600);
}
