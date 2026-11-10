/** Settings sheet: every change is saved right away. */
import type { AirDirection, Cooldown, Language, Source } from '../src/shared/types.ts';
import { api } from './api.ts';
import { fanSetup, numberField, sensorPicker, speedsEditor } from './components.ts';
import { airDial } from './dial.ts';
import { errorText, h, icon, replace, t, toast } from './dom.ts';
import { onChange, saveConfig, store } from './store.ts';

const REPO_URL = 'https://github.com/SiM07/wattpure';

/** A line showing the current value, with a "Change" button revealing the editor. */
function expandable(summary: () => string, editor: (close: () => void) => HTMLElement): HTMLElement {
  const root = h('div', { class: 'expandable' });
  const collapse = () =>
    replace(
      root,
      h('div', { class: 'row spread' }, h('span', { class: 'value', text: summary() }), h('button', { class: 'ghost small', onclick: expand }, t('action.change'))),
    );
  const expand = () => replace(root, editor(collapse));
  collapse();
  return root;
}

function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return h('section', { class: 'settings-section' }, h('h3', { text: title }), ...children);
}

function sensorSummary(kind: Source): string {
  const device = store.config[kind === 'power' ? 'powerMeter' : 'hrm'];
  return `${t('source', {}, kind)} · ${device ? (device.name ?? device.id) : t('settings.sensorAuto')}`;
}

function fanSummary(): string {
  const fan = store.config.fan;
  return fan ? (fan.name ?? fan.productName ?? fan.serialNumber) : '-';
}

const saved = (promise: Promise<unknown>) => promise.then(() => toast(t('settings.saved'))).catch((err) => toast(errorText(err), 'error'));

/** Airflow direction: as set on the fan, or a fixed angle chosen on the dial. */
function airDirectionSettings(): HTMLElement | null {
  if (!store.config.fan?.aimable) return null;
  const mode = h(
    'select',
    { 'aria-label': t('settings.airDirection') },
    ...(['keep', 'fixed'] as const).map((value) => h('option', { value, selected: store.config.airDirection === value, text: t(`settings.airDirection.${value}`) })),
  );
  mode.addEventListener('change', () => saved(saveConfig({ airDirection: mode.value as AirDirection })));
  const dial = airDial();
  const unsubscribe = onChange(() => {
    if (!mode.isConnected) return unsubscribe();
    mode.value = store.config.airDirection;
    dial.update();
  });
  return h(
    'div',
    { class: 'field' },
    h('span', { text: t('settings.airDirection') }),
    mode,
    dial.root,
    h('small', { class: 'muted', text: t('settings.airDirectionHint') }),
  );
}

export function openSettings(onClose: () => void = () => {}): void {
  document.querySelector('.sheet-backdrop')?.remove();
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    unsubscribe();
    onClose();
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);

  const speeds = speedsEditor() as HTMLElement & { render: () => void };
  const speedsTitle = h('span');
  const renderSpeedsTitle = () => (speedsTitle.textContent = t(`source.${store.session.source}`));
  renderSpeedsTitle();

  const cooldown = h(
    'select',
    { 'aria-label': t('settings.cooldown') },
    ...(['off', 'short', 'normal', 'long'] as const).map((value) => h('option', { value, selected: store.config.cooldown === value, text: t(`settings.cooldown.${value}`) })),
  );
  cooldown.addEventListener('change', () => saved(saveConfig({ cooldown: cooldown.value as Cooldown })));

  const airDirection = airDirectionSettings();

  const coolOnly = h('input', { type: 'checkbox', checked: store.config.coolOnly });
  coolOnly.addEventListener('change', () => saved(saveConfig({ coolOnly: coolOnly.checked })));

  const restore = h('input', { type: 'checkbox', checked: store.config.restoreOnExit });
  restore.addEventListener('change', () => saved(saveConfig({ restoreOnExit: restore.checked })));

  const address = h('input', {
    type: 'text',
    inputmode: 'decimal',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: t('settings.fanAddressAuto'),
    value: store.config.fanHost ?? '',
    'aria-label': t('settings.fanAddress'),
  });
  address.addEventListener('change', () => saved(saveConfig({ fanHost: address.value.trim() || null })));
  address.addEventListener('keydown', (e) => e.key === 'Enter' && address.blur());

  const language = h(
    'select',
    { 'aria-label': t('settings.language') },
    h('option', { value: '', selected: store.config.language === null, text: t('settings.languageAuto') }),
    h('option', { value: 'en', selected: store.config.language === 'en', text: 'English' }),
    h('option', { value: 'fr', selected: store.config.language === 'fr', text: 'Français' }),
  );
  language.addEventListener('change', async () => {
    try {
      await saveConfig({ language: (language.value || null) as Language | null });
      close();
      openSettings(onClose); // rebuilt in the new language
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });

  const testButton = h('button', { class: 'secondary' }, icon('fan'), t('action.testSpeeds'));
  testButton.addEventListener('click', () => api.post('session/test-speeds').catch((err) => toast(errorText(err), 'error')));

  const unsubscribe = onChange(() => {
    speeds.render();
    renderSpeedsTitle();
    testButton.disabled = store.session.testing;
  });
  testButton.disabled = store.session.testing;

  const sheet = h(
    'div',
    { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'settings-title' },
    h(
      'header',
      { class: 'sheet-header' },
      h('h2', { id: 'settings-title', text: t('settings.title') }),
      h('button', { class: 'icon-button', title: t('action.close'), 'aria-label': t('action.close'), onclick: close, html: icon('close').innerHTML }),
    ),
    h(
      'div',
      { class: 'sheet-body' },
      section(
        t('settings.profile'),
        numberField({ key: 'maxHr', label: t('settings.maxHr'), hint: t('settings.maxHrHint'), min: 100, max: 240 }),
        numberField({ key: 'ftp', label: t('settings.ftp'), hint: t('settings.ftpHint'), min: 50, max: 2000 }),
      ),
      section(
        t('settings.speeds'),
        h('div', { class: 'field' }, speedsTitle, speeds, h('small', { class: 'muted', text: t('settings.speedsHint') })),
        h('label', { class: 'field' }, h('span', { text: t('settings.cooldown') }), cooldown, h('small', { class: 'muted', text: t('settings.cooldownHint') })),
        testButton,
      ),
      section(
        t('settings.fan'),
        expandable(fanSummary, (done) => fanSetup(() => setTimeout(done, 1200))),
        h('label', { class: 'field' }, h('span', { text: t('settings.fanAddress') }), address, h('small', { class: 'muted', text: t('settings.fanAddressHint') })),
        airDirection,
        h('label', { class: 'check' }, coolOnly, h('span', { text: t('settings.coolOnly') })),
        h('label', { class: 'check' }, restore, h('span', { text: t('settings.restore') })),
      ),
      section(
        t('settings.sensors'),
        expandable(() => sensorSummary('hr'), () => sensorPicker('hr')),
        expandable(() => sensorSummary('power'), () => sensorPicker('power')),
      ),
      section(t('settings.language'), language),
      section(
        t('settings.about'),
        h('p', { class: 'muted' }, t('settings.version', { version: store.app.version }), ' · ', h('a', { href: REPO_URL, target: '_blank', rel: 'noreferrer', text: 'GitHub' })),
        h('p', { class: 'muted small-print', text: t('settings.configPath', { path: store.app.configPath }) }),
        h(
          'button',
          {
            class: 'ghost danger',
            onclick: () => api.post('quit').then(() => document.body.classList.add('quitting')),
          },
          t('action.quit'),
        ),
      ),
    ),
  );

  const backdrop = h('div', { class: 'sheet-backdrop', onclick: (e: MouseEvent) => e.target === backdrop && close() }, sheet);
  document.body.append(backdrop);
  sheet.querySelector<HTMLElement>('button')?.focus();
}
