/** First-run setup: fan, source and reference value, sensor. Each step saves right away. */
import { fanSetup, numberField, sensorPicker, sourcePicker } from './components.ts';
import { h, icon, t } from './dom.ts';
import { store } from './store.ts';

type Step = 'welcome' | 'fan' | 'profile' | 'sensor' | 'done';
const STEPS: Step[] = ['welcome', 'fan', 'profile', 'sensor', 'done'];
const NUMBERED: Step[] = ['fan', 'profile', 'sensor'];
/** Zone colors, from easy to all out: the welcome art. */
const ZONE_COLORS = ['#338CFF', '#59BF59', '#FFCC3F', '#FF663A', '#FF340C'];

export function openWizard(onDone: () => void): void {
  document.querySelector('.wizard')?.remove();
  const overlay = h('section', { class: 'wizard', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wizard-title' });
  document.body.append(overlay);

  let index = STEPS.indexOf(store.config.fan ? 'profile' : 'welcome');

  const go = (step: Step) => {
    index = STEPS.indexOf(step);
    render();
  };
  const next = () => go(STEPS[index + 1]!);
  const back = () => go(STEPS[index - 1]!);

  function frame(opts: { title: string; text?: string; content?: Node; footer: Node[] }) {
    const step = STEPS[index]!;
    const number = NUMBERED.indexOf(step);
    overlay.replaceChildren(
      h(
        'div',
        { class: 'wizard-card' },
        number >= 0
          ? h(
              'div',
              { class: 'wizard-progress' },
              h('span', { text: t('wizard.step', { current: number + 1, total: NUMBERED.length }) }),
              h('div', { class: 'dots' }, ...NUMBERED.map((_, i) => h('i', { class: i <= number ? 'on' : '' }))),
            )
          : null,
        h('h2', { id: 'wizard-title', tabindex: '-1', text: opts.title }),
        opts.text ? h('p', { class: 'lead', text: opts.text }) : null,
        opts.content ?? null,
        h('div', { class: 'wizard-footer' }, ...opts.footer),
      ),
    );
    overlay.querySelector<HTMLElement>('h2')?.focus();
  }

  const backButton = () => h('button', { class: 'ghost', onclick: back }, t('action.back'));
  const nextButton = (enabled = true) => h('button', { class: 'primary', onclick: next, disabled: !enabled }, t('action.next'));

  function render() {
    const step = STEPS[index]!;
    switch (step) {
      case 'welcome':
        return frame({
          title: t('wizard.welcome.title'),
          text: t('wizard.welcome.text'),
          content: h('div', { class: 'welcome-art' }, ...ZONE_COLORS.map((c, i) => h('i', { style: { '--c': c, '--s': String(i + 1) } }))),
          footer: [h('button', { class: 'primary wide', onclick: next }, t('wizard.welcome.start'))],
        });
      case 'fan': {
        const footer = [backButton(), nextButton(false)];
        return frame({
          title: t('wizard.fan.title'),
          text: t('wizard.fan.text'),
          content: fanSetup(() => footer[1]!.removeAttribute('disabled')),
          footer,
        });
      }
      case 'profile': {
        const field = h('div');
        const renderField = () =>
          field.replaceChildren(
            store.config.source === 'power'
              ? numberField({ key: 'ftp', label: t('settings.ftp'), hint: t('settings.ftpHint'), min: 50, max: 2000 })
              : numberField({ key: 'maxHr', label: t('settings.maxHr'), hint: t('settings.maxHrHint'), min: 100, max: 240 }),
          );
        renderField();
        return frame({
          title: t('wizard.profile.title'),
          content: h('div', { class: 'stack' }, sourcePicker(renderField), field),
          footer: [backButton(), nextButton()],
        });
      }
      case 'sensor': {
        const kind = store.config.source;
        return frame({
          title: t('wizard.sensor.title', {}, kind),
          text: t('wizard.sensor.text', {}, kind),
          content: h('div', { class: 'stack' }, sensorPicker(kind), h('p', { class: 'note' }, icon('info'), h('span', { text: t('wizard.sensor.shared') }))),
          footer: [backButton(), nextButton()],
        });
      }
      case 'done':
        return frame({
          title: t('wizard.done.title'),
          text: t('wizard.done.text'),
          content: h('div', { class: 'done-art' }, icon('check')),
          footer: [
            h(
              'button',
              {
                class: 'primary wide',
                onclick: () => {
                  overlay.remove();
                  onDone();
                },
              },
              t('wizard.done.go'),
            ),
          ],
        });
    }
  }

  render();
}
