import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeStatus, format, pickLanguage, translate, translateOptional } from '../src/shared/i18n.ts';
import { en } from '../src/shared/locales/en.ts';
import { fr } from '../src/shared/locales/fr.ts';
import type { StatusCode } from '../src/shared/types.ts';

const CODES: StatusCode[] = [
  'unconfigured', 'stopped', 'starting', 'suspended', 'bluetoothStarting', 'bluetoothOff', 'bluetoothUnauthorized', 'bluetoothUnsupported',
  'bluetoothFailed', 'searching', 'notFound', 'connecting', 'waiting', 'live', 'disconnected', 'connectError', 'noData', 'noContact',
  'idle', 'idleOff',
];

test('language detection', () => {
  assert.equal(pickLanguage('fr-FR'), 'fr');
  assert.equal(pickLanguage('en-US'), 'en');
  assert.equal(pickLanguage('de'), 'en');
  assert.equal(pickLanguage(undefined), 'en');
});

test('placeholders', () => {
  assert.equal(format('{a} and {b}', { a: 1 }), '1 and {b}');
});

test('variants, fallback to English, then to the key', () => {
  assert.equal(translate('en', 'status.noData', { name: 'Neo' }, 'power'), 'Neo stopped sending data');
  assert.equal(translate('fr', 'device', {}, 'hr'), 'ceinture cardio');
  assert.equal(translate('fr', 'status.bluetoothFailed.hint', { error: 'boom' }), 'boom'); // English fallback
  assert.equal(translate('en', 'nope.key'), 'nope.key');
  assert.equal(translateOptional('en', 'status.live.hint'), null);
});

test('every status code has a title in every language, without leftover placeholders', () => {
  for (const lang of ['en', 'fr'] as const) {
    for (const source of ['power', 'hr'] as const) {
      for (const code of CODES) {
        const { title, hint } = describeStatus(lang, { code, level: 'info', params: { name: 'X', error: 'E', retrySeconds: 5, minutes: 2 } }, source);
        assert.notEqual(title, `status.${code}`, `${lang}/${source}/${code}`);
        assert.doesNotMatch(`${title} ${hint ?? ''}`, /\{\w+\}/, `${lang}/${source}/${code}`);
      }
    }
  }
});

test('the French locale only uses keys that exist in English', () => {
  for (const key of Object.keys(fr)) assert.ok(key in en, key);
});

test('generic device label when the sensor has no name', () => {
  assert.equal(describeStatus('en', { code: 'notFound', level: 'warn', params: {} }, 'power').title, 'Trainer not found');
  assert.equal(describeStatus('fr', { code: 'notFound', level: 'warn', params: {} }, 'hr', 'HRM-Pro').title, 'HRM-Pro introuvable');
});

test('every fan problem and error code has a message in every language', () => {
  const keys = [
    ...['unauthorized', 'unreachable', 'unsupported'].map((p) => `fan.${p}`),
    ...['noAccount', 'loginFailed', 'tooManyCodes', 'cloudUnreachable', 'noMachine', 'fanUnauthorized', 'fanUnreachable', 'fanUnsupported', 'notConfigured', 'bluetooth'].map((c) => `error.${c}`),
  ];
  for (const key of keys) {
    assert.ok(key in en, key);
    assert.ok(key in fr, `fr: ${key}`);
  }
});
