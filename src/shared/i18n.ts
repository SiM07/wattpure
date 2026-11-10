/** Translation lookup shared by the web UI and the CLI. No Node or DOM API here. */
import { en, type MessageKey } from './locales/en.ts';
import { fr } from './locales/fr.ts';
import type { Language, Source, Status } from './types.ts';

export type { MessageKey };

const LOCALES: Record<Language, Partial<Record<string, string>>> = { en, fr };

export type Params = Record<string, string | number | null | undefined>;

/** Picks a supported language from a BCP 47 tag such as "fr-FR"; English otherwise. */
export function pickLanguage(tag: string | null | undefined): Language {
  return tag?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

export function hasKey(key: string): boolean {
  return key in en;
}

/** Fills `{name}` placeholders; unknown placeholders are left visible to spot them. */
export function format(template: string, params: Params = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/**
 * Returns the message for `key` in `lang`, falling back to English then to the key itself.
 * With a `variant` (e.g. the source), `key.variant` is tried first.
 */
export function translate(lang: Language, key: string, params: Params = {}, variant?: string): string {
  const candidates = variant ? [`${key}.${variant}`, key] : [key];
  for (const candidate of candidates) {
    const template = LOCALES[lang][candidate] ?? LOCALES.en[candidate];
    if (template !== undefined) return format(template, params);
  }
  return key;
}

/** Like `translate`, but returns null when no message exists (optional hints). */
export function translateOptional(lang: Language, key: string, params: Params = {}, variant?: string): string | null {
  const candidates = variant ? [`${key}.${variant}`, key] : [key];
  return candidates.some((c) => c in LOCALES.en || c in LOCALES[lang]) ? translate(lang, key, params, variant) : null;
}

/**
 * Title and optional hint for an engine status. `deviceName` is the configured or connected
 * sensor; without one, a generic label ("trainer", "heart rate strap") is used.
 */
export function describeStatus(lang: Language, status: Status, source: Source, deviceName?: string | null): { title: string; hint: string | null } {
  const device = deviceName || translate(lang, 'device', {}, source);
  const Device = deviceName || translate(lang, 'Device', {}, source);
  const params: Params = { ...status.params, device, Device, name: status.params.name || Device };
  return {
    title: translate(lang, `status.${status.code}`, params, source),
    hint: translateOptional(lang, `status.${status.code}.hint`, params, source),
  };
}
