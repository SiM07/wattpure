/** Building blocks shared by the first-run setup and the settings sheet. */
import type { DeviceRef, FanCheck, MachineOption, PublicConfig, SensorDevice, Source } from '../src/shared/types.ts';
import { api } from './api.ts';
import { errorText, getLanguage, h, icon, replace, spinner, t, toast } from './dom.ts';
import { saveConfig, setConfig, store } from './store.ts';

const MAX_SPEED = 10;

/** Country of the Dyson account, from the system language region ("fr-FR" -> "FR"). */
function accountCountry(): string {
  const region = navigator.language.split('-')[1]?.toUpperCase();
  return region && /^[A-Z]{2}$/.test(region) ? region : 'US';
}

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { text: label }), input, hint ? h('small', { class: 'muted', text: hint }) : null);
}

function textInput(props: Record<string, unknown>): HTMLInputElement {
  return h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', ...props });
}

/** Busy state of a form: disables its controls and shows a spinner in the submit button. */
async function busy<T>(form: HTMLFormElement, work: () => Promise<T>): Promise<T> {
  const controls = [...form.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')];
  const submit = form.querySelector<HTMLButtonElement>('button[type=submit]');
  const label = submit ? [...submit.childNodes] : [];
  controls.forEach((c) => (c.disabled = true));
  submit?.replaceChildren(spinner(), ...label);
  try {
    return await work();
  } finally {
    controls.forEach((c) => (c.disabled = false));
    submit?.replaceChildren(...label);
  }
}

/**
 * Dyson setup: account login (email, emailed code, password), choice of the fan, then a
 * connection check on the local network. Calls `onReady` once the fan answered.
 */
export function fanSetup(onReady: (config: PublicConfig) => void): HTMLElement {
  const root = h('div', { class: 'stack' });
  const country = accountCountry();
  let email = '';

  async function check() {
    replace(root, h('p', { class: 'muted searching' }, spinner(), t('wizard.fan.checking')));
    try {
      const result = await api.post<FanCheck>('fan/check');
      const { fan } = result;
      replace(
        root,
        h(
          'div',
          { class: 'fan-found' },
          h('div', { class: 'done-art small' }, icon('check')),
          h('h3', { text: t('wizard.fan.found') }),
          h('p', { class: 'muted', text: [store.config.fan?.name ?? t('fan.unknown'), fan.temperatureC !== null ? t('fan.temperature', { value: fan.temperatureC.toLocaleString(getLanguage(), { maximumFractionDigits: 1 }) }) : null].filter(Boolean).join(' · ') }),
        ),
      );
      toast(t('wizard.fan.found'));
      onReady(store.config);
    } catch (err) {
      replace(
        root,
        h('p', { class: 'error-text', text: errorText(err) }),
        h('div', { class: 'row' }, h('button', { class: 'secondary', onclick: () => void check() }, t('action.retry')), h('button', { class: 'ghost', onclick: () => manualForm() }, t('wizard.fan.manual'))),
      );
    }
  }

  function emailForm() {
    const input = h('input', { type: 'email', autocomplete: 'email', spellcheck: 'false', value: email, required: true, placeholder: 'you@example.com' });
    const form = h(
      'form',
      {
        class: 'stack',
        onsubmit: async (e: SubmitEvent) => {
          e.preventDefault();
          email = input.value.trim();
          try {
            const { challengeId } = await busy(form, () => api.post<{ challengeId: string | null }>('dyson/code', { email, country }));
            codeForm(challengeId);
          } catch (err) {
            toast(errorText(err), 'error');
          }
        },
      },
      field(t('wizard.fan.email'), input),
      h('button', { type: 'submit', class: 'primary' }, t('wizard.fan.sendCode')),
    );
    replace(root, form, h('button', { class: 'ghost', onclick: () => manualForm() }, icon('key'), t('wizard.fan.manual')));
    input.focus();
  }

  function codeForm(challengeId: string | null) {
    const code = textInput({ inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456', required: true });
    const password = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const form = h(
      'form',
      {
        class: 'stack',
        onsubmit: async (e: SubmitEvent) => {
          e.preventDefault();
          try {
            const { machines } = await busy(form, () =>
              api.post<{ machines: MachineOption[] }>('dyson/login', { email, country, challengeId, otpCode: code.value, password: password.value }),
            );
            password.value = '';
            pickMachine(machines);
          } catch (err) {
            toast(errorText(err), 'error');
          }
        },
      },
      challengeId ? h('p', { class: 'note' }, icon('info'), h('span', { text: t('wizard.fan.codeSent', { email }) })) : null,
      challengeId ? field(t('wizard.fan.code'), code) : null,
      field(t('wizard.fan.password'), password),
      h('small', { class: 'muted', text: t('wizard.fan.privacy') }),
      h('button', { type: 'submit', class: 'primary' }, t('wizard.fan.login')),
    );
    replace(root, form, h('button', { class: 'ghost', onclick: () => emailForm() }, t('wizard.fan.otherEmail')));
    (challengeId ? code : password).focus();
  }

  function pickMachine(machines: MachineOption[]) {
    if (!machines.length) return replace(root, h('p', { class: 'muted', text: t('wizard.fan.none') }), h('button', { class: 'ghost', onclick: () => emailForm() }, t('wizard.fan.otherEmail')));
    replace(
      root,
      h('h3', { class: 'subtitle', text: t('wizard.fan.pick') }),
      h(
        'div',
        { class: 'choices' },
        ...machines.map((m) =>
          h(
            'button',
            {
              class: 'choice',
              disabled: !m.supported,
              onclick: async () => {
                try {
                  await api.post('dyson/select', { serialNumber: m.serialNumber });
                  await refreshConfig();
                  void check();
                } catch (err) {
                  toast(errorText(err), 'error');
                }
              },
            },
            icon('fan'),
            h('span', { class: 'choice-text' }, h('strong', { text: m.name ?? m.productName ?? m.serialNumber }), h('small', { text: m.supported ? [m.productName, m.serialNumber].filter(Boolean).join(' · ') : t('wizard.fan.unsupported') })),
          ),
        ),
      ),
    );
  }

  function manualForm() {
    const serial = textInput({ placeholder: 'A1B-EU-ABC1234A', required: true, value: store.config.fan?.serialNumber ?? '' });
    const type = textInput({ placeholder: '527', required: true, value: store.config.fan?.type ?? '' });
    const password = h('input', { type: 'password', autocomplete: 'off', required: true });
    const host = textInput({ inputmode: 'decimal', placeholder: '192.168.1.50', value: store.config.fanHost ?? '' });
    const form = h(
      'form',
      {
        class: 'stack',
        onsubmit: async (e: SubmitEvent) => {
          e.preventDefault();
          try {
            await busy(form, () => api.post('dyson/manual', { serialNumber: serial.value, type: type.value, apPasswordHash: password.value, host: host.value }));
            await refreshConfig();
            void check();
          } catch (err) {
            toast(errorText(err), 'error');
          }
        },
      },
      h('p', { class: 'muted', text: t('wizard.fan.manualText') }),
      field(t('wizard.fan.serial'), serial),
      field(t('wizard.fan.type'), type, t('wizard.fan.typeHint')),
      field(t('wizard.fan.localPassword'), password),
      field(t('wizard.fan.host'), host, t('wizard.fan.hostHint')),
      h('button', { type: 'submit', class: 'primary' }, t('wizard.fan.save')),
    );
    replace(root, form, h('button', { class: 'ghost', onclick: () => emailForm() }, t('wizard.fan.useAccount')));
  }

  emailForm();
  return root;
}

/** The config changed on the server through a setup route: the event stream brings it, but the caller may need it now. */
async function refreshConfig(): Promise<void> {
  const { config } = await api.get<{ config: PublicConfig }>('state');
  setConfig(config);
}

/** Heart rate / power cards. */
export function sourcePicker(onChange: (source: Source) => void): HTMLElement {
  const root = h('div', { class: 'choices' });
  const render = () =>
    replace(
      root,
      ...(['hr', 'power'] as const).map((source) => {
        const selected = store.config.source === source;
        return h(
          'button',
          {
            class: `choice${selected ? ' selected' : ''}`,
            'aria-pressed': String(selected),
            onclick: async () => {
              try {
                await saveConfig({ source });
                render();
                onChange(source);
              } catch (err) {
                toast(errorText(err), 'error');
              }
            },
          },
          icon(source === 'power' ? 'bolt' : 'heart'),
          h('span', { class: 'choice-text' }, h('strong', { text: t(`source.${source}`) }), h('small', { text: t(`wizard.profile.${source}`) })),
        );
      }),
    );
  render();
  return root;
}

/** Number input saved when it loses focus or Enter is pressed. */
export function numberField(opts: { key: 'ftp' | 'maxHr'; label: string; hint?: string; min: number; max: number }): HTMLElement {
  const input = h('input', { type: 'number', inputmode: 'numeric', min: opts.min, max: opts.max, step: 1, value: String(store.config[opts.key]) });
  const error = h('small', { class: 'error-text' });
  const commit = async () => {
    const value = Number(input.value);
    if (value === store.config[opts.key]) return;
    try {
      await saveConfig({ [opts.key]: value });
      error.textContent = '';
      toast(t('settings.saved'));
    } catch (err) {
      error.textContent = errorText(err);
    }
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
  return h('label', { class: 'field' }, h('span', { text: opts.label }), input, opts.hint ? h('small', { class: 'muted', text: opts.hint }) : null, error);
}

function translateZone(name: string): string {
  const key = `zone.${name}`;
  const text = t(key);
  return text === key ? name : text;
}

/** One stepper per zone of the current source: 0 (off) to 10. Saved right away. */
export function speedsEditor(): HTMLElement {
  const root = h('div', { class: 'speeds' });
  const render = () => {
    const { source, zones } = store.session;
    const key = source === 'power' ? 'powerSpeeds' : 'hrSpeeds';
    const change = async (index: number, delta: number) => {
      const speeds = zones.map((z) => z.speed);
      speeds[index] = Math.max(0, Math.min(MAX_SPEED, speeds[index]! + delta));
      try {
        await saveConfig({ [key]: speeds });
      } catch (err) {
        toast(errorText(err), 'error');
      }
    };
    replace(
      root,
      ...zones.map((zone, i) =>
        h(
          'div',
          { class: 'speed-row', style: { '--c': zone.color } },
          h('i'),
          h('span', { class: 'speed-zone' }, h('strong', { text: `Z${zone.number}` }), ` ${translateZone(zone.name)}`),
          h('button', { class: 'icon-button small', title: t('settings.speedDown'), 'aria-label': t('settings.speedDown'), disabled: zone.speed <= 0, onclick: () => void change(i, -1), html: icon('minus').innerHTML }),
          h('output', { text: zone.speed ? String(zone.speed) : t('fan.off') }),
          h('button', { class: 'icon-button small', title: t('settings.speedUp'), 'aria-label': t('settings.speedUp'), disabled: zone.speed >= MAX_SPEED, onclick: () => void change(i, 1), html: icon('plus').innerHTML }),
        ),
      ),
    );
  };
  render();
  return Object.assign(root, { render });
}

const sensorKey = (kind: Source) => (kind === 'power' ? 'powerMeter' : 'hrm');

/** "Automatic" or a specific sensor, with a Bluetooth search. */
export function sensorPicker(kind: Source): HTMLElement {
  const root = h('div', { class: 'stack' });
  let found: SensorDevice[] | null = null;
  let searching: AbortController | null = null;

  const choose = async (device: DeviceRef | null) => {
    try {
      await saveConfig({ [sensorKey(kind)]: device });
      render();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  const option = (device: DeviceRef | null, label: string, detail?: string) => {
    const current = store.config[sensorKey(kind)];
    const selected = device ? current?.id === device.id : !current;
    return h(
      'button',
      { class: `choice${selected ? ' selected' : ''}`, 'aria-pressed': String(selected), onclick: () => void choose(device) },
      icon(selected ? 'check' : kind === 'power' ? 'bolt' : 'heart'),
      h('span', { class: 'choice-text' }, h('strong', { text: label }), detail ? h('small', { text: detail }) : null),
    );
  };

  async function search() {
    searching?.abort();
    const controller = (searching = new AbortController());
    render();
    try {
      ({ devices: found } = await api.post<{ devices: SensorDevice[] }>('sensors/scan', { kind }, controller.signal));
    } catch (err) {
      if ((err as Error).name !== 'AbortError') toast(errorText(err), 'error');
      found ??= [];
    } finally {
      if (searching === controller) searching = null;
      render();
    }
  }

  function render() {
    const current = store.config[sensorKey(kind)];
    const devices = [...(found ?? [])];
    if (current && !devices.some((d) => d.id === current.id)) devices.unshift({ ...current, rssi: null });
    replace(
      root,
      h(
        'div',
        { class: 'choices' },
        option(null, t('wizard.sensor.auto', { device: t('device', {}, kind) })),
        ...devices.map((d) => option(d, d.name ?? d.id, d.rssi === null ? undefined : `${d.rssi} dBm`)),
      ),
      found?.length === 0 && !searching ? h('p', { class: 'muted', text: t('wizard.sensor.none') }) : null,
      searching
        ? h('p', { class: 'muted searching' }, spinner(), t('status.suspended'))
        : h('button', { class: 'secondary', onclick: () => void search() }, icon('search'), t(found ? 'action.searchAgain' : 'action.search')),
    );
  }

  render();
  return root;
}
