/** Main screen: live value, zone, fan speed, sensor status and the heart rate / power switch. */
import { describeStatus } from '../src/shared/i18n.ts';
import type { FanInfo, PublicZone, Source, StateResponse } from '../src/shared/types.ts';
import { api, subscribe } from './api.ts';
import { errorText, getLanguage, h, icon, replace, spinner, t, toast } from './dom.ts';
import { airDial, currentAngle } from './dial.ts';
import { openSettings } from './settings.ts';
import { init, needsSetup, onChange, saveConfig, setConfig, setSession, store } from './store.ts';
import { openWizard } from './wizard.ts';

const NEUTRAL = '#4B5263';
/** "Connecting to the fan" only shows when it takes longer than this: no flash at each launch. */
const FAN_CHECKING_DELAY_MS = 1500;
const LEVEL_ICON = { info: 'info', ok: 'check', warn: 'alert', error: 'alert' } as const;

const zoneLabel = (zone: PublicZone) => `Z${zone.number} · ${translateZone(zone.name)}`;
function translateZone(name: string): string {
  const key = `zone.${name}`;
  const text = t(key);
  return text === key ? name : text;
}

function setAccent(color: string): void {
  document.documentElement.style.setProperty('--zone', color);
}

const speedLabel = (speed: number) => (speed ? t('fan.speed', { speed }) : t('fan.off'));

/** What the fan does now: speed, off, auto. */
function fanSpeedLabel(fan: FanInfo): string {
  if (fan.power === false) return t('fan.off');
  if (fan.auto) return t('fan.auto');
  return fan.speed ? t('fan.speed', { speed: fan.speed }) : t('fan.label');
}

/** Room readings reported by the fan. */
function roomLabel(fan: FanInfo): string {
  return [
    fan.temperatureC !== null ? t('fan.temperature', { value: fan.temperatureC.toLocaleString(getLanguage(), { maximumFractionDigits: 1 }) }) : null,
    fan.humidity !== null ? t('fan.humidity', { value: fan.humidity }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Builds the dashboard once; `update` then patches the moving parts on every state event. */
function dashboard(root: HTMLElement) {
  const value = h('span', { class: 'value' });
  const unit = h('span', { class: 'unit' });
  const pct = h('div', { class: 'pct' });
  const zoneName = h('div', { class: 'zone-name' });
  const gauge = h('div', { class: 'gauge' }, h('div', { class: 'gauge-ring' }, h('div', { class: 'gauge-inner' }, value, unit)), pct, zoneName);

  const fanIcon = h('span', { class: 'fan-icon', html: icon('fan').innerHTML });
  const fanSpeed = h('strong');
  const fanName = h('small');
  const fanRoom = h('span', { class: 'fan-room' });
  const fanBars = h('div', { class: 'fan-bars', 'aria-hidden': 'true' }, ...Array.from({ length: 10 }, () => h('i')));
  const swing = h('button', { class: 'icon-button swing', onclick: () => toggleAirPanel(), html: icon('swing').innerHTML });
  const fanCard = h('div', { class: 'fan-card' }, fanIcon, h('div', { class: 'status-text' }, fanSpeed, fanName), h('div', { class: 'fan-side' }, fanBars, fanRoom), swing);

  // Airflow direction, reachable from the bike: drag the dial to point the air at you.
  // Moving the dial by hand: during a search it takes over (the search stops), in the adjust
  // step it is the adjustment itself.
  const dial = airDial({
    onAim: (angle) => {
      if (adjusting !== null) adjusting = angle;
    },
  });
  const release = h('button', { class: 'ghost small', onclick: () => void releaseDirection() }, t('air.release'));
  // Finding the best direction, in three steps: search (wide, 3° at a time), refine (degree by
  // degree around the angle kept), adjust (±1° by hand, then done).
  const STEPS = ['search', 'refine', 'adjust'] as const;
  type Step = (typeof STEPS)[number];
  const stepDots = h('ol', { class: 'air-steps' }, ...STEPS.map((step, i) => h('li', { dataset: { step } }, h('b', { text: String(i + 1) }), t(`air.step.${step}`))));
  const flowTitle = h('strong', { class: 'air-title' });
  const flowText = h('p', { class: 'air-text' });
  const flowNote = h('small', { class: 'muted air-note', text: t('air.reaction') });
  const startButton = h('button', { class: 'primary wide', onclick: () => void startScan(false) }, icon('search'), t('air.start'));
  const stopButton = h('button', { class: 'primary wide stop', onclick: () => void stopScan() }, t('air.stop'));
  const cancelButton = h('button', { class: 'ghost', onclick: () => void cancelFlow() }, t('action.cancel'));
  const adjustButton = (delta: number) => h('button', { class: 'secondary adjust', onclick: () => void adjust(delta) }, `${delta > 0 ? '+' : '−'}${Math.abs(delta)}°`);
  const perfectButton = h('button', { class: 'primary', onclick: () => finish() }, icon('check'), t('air.perfect'));
  // A direction already fixed: correct it by a degree right away when reopening the panel.
  const idleDone = h('button', { class: 'primary', onclick: () => finish() }, icon('check'), t('air.perfect'));
  const idleAdjust = h('div', { class: 'row air-adjust' }, adjustButton(-1), idleDone, adjustButton(1));
  const idleActions = h('div', { class: 'stack' }, idleAdjust, startButton, release);
  const scanActions = h('div', { class: 'stack' }, stopButton, cancelButton);
  const adjustActions = h('div', { class: 'stack' }, h('div', { class: 'row air-adjust' }, adjustButton(-1), perfectButton, adjustButton(1)), cancelButton.cloneNode(true) as HTMLButtonElement);
  adjustActions.lastElementChild!.addEventListener('click', () => void cancelFlow());
  /** Step 3: the angle found, adjusted by hand until "perfect"; null outside the flow. */
  let adjusting: number | null = null;
  const airPanel = h(
    'div',
    { class: 'air-panel', hidden: true },
    h('div', { class: 'air-head' }, flowTitle, stepDots),
    flowText,
    dial.root,
    flowNote,
    idleActions,
    scanActions,
    adjustActions,
  );
  let airOpen = false;
  const toggleAirPanel = () => {
    airOpen = !airOpen;
    update();
  };

  const statusIcon = h('span', { class: 'icon' });
  const statusTitle = h('strong');
  const statusHint = h('small');
  const status = h('div', { class: 'status', role: 'status' }, statusIcon, h('div', { class: 'status-text' }, statusTitle, statusHint));
  const alertIcon = h('span', { class: 'icon' });
  const alertText = h('strong');
  const fanAlert = h('div', { class: 'status fan-alert', role: 'status', hidden: true }, alertIcon, h('div', { class: 'status-text' }, alertText));
  let checkingSince: number | null = null;
  let checkingTimer: number | undefined;

  const zones = h('div', { class: 'zones', 'aria-label': t('zones.title') });
  const sourceButtons = (['hr', 'power'] as const).map((source) =>
    h(
      'button',
      {
        role: 'radio',
        dataset: { source },
        onclick: () => switchSource(source),
      },
      icon(source === 'power' ? 'bolt' : 'heart'),
      t(`source.${source}`),
    ),
  );
  const toggle = h('button', { class: 'secondary wide', onclick: () => void toggleRunning() });

  replace(
    root,
    h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, h('img', { src: '/ui/icon.svg', alt: '' }), h('span', { text: 'WattPure' })),
      store.session.demo ? h('span', { class: 'badge', text: t('app.demo') }) : null,
      h('button', { class: 'icon-button', title: t('action.settings'), 'aria-label': t('action.settings'), onclick: () => openSettings(), html: icon('gear').innerHTML }),
    ),
    h('div', { class: 'segmented', role: 'radiogroup' }, ...sourceButtons),
    gauge,
    fanCard,
    airPanel,
    fanAlert,
    status,
    zones,
    h('footer', { class: 'actions' }, toggle),
  );

  async function switchSource(source: Source) {
    if (store.config.source === source) return;
    try {
      await saveConfig({ source });
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  /** Starts a sway around `center` (by default the angle on the dial). */
  async function startScan(fine: boolean, center = currentAngle(store.config, store.session)) {
    try {
      await api.post('air/scan/start', { center, fine });
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  /** Stop: the search hands over to the refine step, the refine step to the adjust step. */
  async function stopScan() {
    const fine = store.session.scan?.fine ?? false;
    try {
      const { angle } = await api.post<{ angle: number | null }>('air/scan/stop', { keep: true });
      if (angle === null) return;
      if (!fine) await startScan(true, angle);
      else {
        adjusting = angle;
        update();
      }
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  /** ±1°: the angle being corrected in step 3, otherwise the direction on the dial. */
  async function adjust(delta: number) {
    const angle = Math.min(355, Math.max(5, (adjusting ?? currentAngle(store.config, store.session)) + delta));
    if (adjusting !== null) adjusting = angle;
    update();
    try {
      await saveConfig({ airDirection: 'fixed', airAngle: angle });
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  /** Done: the direction is saved already; leaves the flow and closes the panel. */
  function finish() {
    if (adjusting !== null) toast(t('air.kept', { angle: adjusting }));
    adjusting = null;
    airOpen = false;
    update();
  }

  /** Leaves the flow: a sway in progress stops and the fan goes back to the direction it had. */
  async function cancelFlow() {
    adjusting = null;
    update();
    if (!store.session.scan) return;
    try {
      await api.post('air/scan/stop', { keep: false });
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  /** Hands the direction back to the fan (as set on it, or in the MyDyson app). */
  async function releaseDirection() {
    try {
      await saveConfig({ airDirection: 'keep' });
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  async function toggleRunning() {
    toggle.disabled = true;
    try {
      await api.post(store.session.running ? 'session/stop' : 'session/start');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      toggle.disabled = false;
    }
  }

  let testUntil = 0;
  function showTest(zone: PublicZone) {
    testUntil = Date.now() + 1600;
    setAccent(zone.color);
    value.textContent = '';
    unit.textContent = '';
    pct.textContent = t('action.testSpeeds');
    zoneName.textContent = `${zoneLabel(zone)} · ${speedLabel(zone.speed)}`;
    markZone(zone.number);
  }

  function markZone(number: number | null) {
    for (const el of zones.children) el.classList.toggle('active', Number((el as HTMLElement).dataset.zone) === number);
  }

  function update() {
    const { session, config } = store;
    for (const button of sourceButtons) button.setAttribute('aria-checked', String(button.dataset.source === session.source));

    // Live value and zone.
    if (Date.now() > testUntil) {
      const live = session.value !== null && session.zone !== null;
      value.textContent = live ? String(session.value) : '–';
      unit.textContent = session.unit;
      pct.textContent = live ? `${session.pct} % ${t('reference', {}, session.source)}` : `${t('reference', {}, session.source)} ${session.reference} ${session.unit}`;
      zoneName.textContent = session.zone ? zoneLabel(session.zone) : '';
      setAccent(live && session.zone ? session.zone.color : NEUTRAL);
      gauge.classList.toggle('idle', !live);
      markZone(live ? session.zone!.number : null);
    }

    // Sensor status.
    const configuredDevice = session.source === 'power' ? config.powerMeter : config.hrm;
    const { title, hint } = describeStatus(getLanguage(), session.status, session.source, session.device?.name ?? configuredDevice?.name);
    status.dataset.level = session.status.level;
    statusIcon.innerHTML = icon(LEVEL_ICON[session.status.level]).innerHTML;
    statusTitle.textContent = title;
    statusHint.textContent = hint ?? '';
    statusHint.hidden = !hint;

    // Fan: speed, room readings, connecting (after a short delay) or problem.
    const { fan } = session;
    const spinning = fan.power === true ? (fan.auto ? 5 : (fan.speed ?? 0)) : 0;
    fanCard.style.setProperty('--spin', spinning ? `${(2.6 - spinning * 0.22).toFixed(2)}s` : '0s');
    fanCard.classList.toggle('spinning', spinning > 0);
    // Cooling down after an effort: the fan is above the speed of the current zone and heads for it.
    const coolingDown = session.running && session.drive !== null && session.drive.speed > session.drive.target;
    fanSpeed.textContent = coolingDown
      ? `${t('fan.speed', { speed: t('fan.towards', session.drive!) })}`
      : fan.ok === null && fan.power === null
        ? t('fan.label')
        : fanSpeedLabel(fan);
    fanName.textContent = [coolingDown ? t('fan.coolingDown') : (session.machine?.name ?? session.machine?.productName ?? t('fan.unknown')), fan.heating ? t('fan.heating') : null]
      .filter(Boolean)
      .join(' · ');
    fanRoom.textContent = roomLabel(fan);
    [...fanBars.children].forEach((bar, i) => bar.classList.toggle('on', fan.power === true && !fan.auto && i < (fan.speed ?? 0)));
    fanCard.hidden = !session.configured;
    // Airflow direction panel.
    swing.hidden = !session.machine?.aimable || !session.configured;
    swing.setAttribute('aria-expanded', String(airOpen));
    swing.setAttribute('aria-pressed', String(airOpen));
    swing.title = t('air.title');
    swing.setAttribute('aria-label', t('air.title'));
    airPanel.hidden = !airOpen || swing.hidden;
    const scan = session.scan;
    if (!session.running) adjusting = null;
    const step: Step | null = scan ? (scan.fine ? 'refine' : 'search') : adjusting !== null ? 'adjust' : null;
    airPanel.dataset.step = step ?? 'idle';
    stepDots.hidden = step === null;
    for (const li of stepDots.children) {
      const index = STEPS.indexOf((li as HTMLElement).dataset.step as Step);
      li.classList.toggle('done', step !== null && index < STEPS.indexOf(step));
      li.classList.toggle('current', li.getAttribute('data-step') === step);
    }
    const range = scan && { from: Math.max(5, scan.center - scan.span), to: Math.min(355, scan.center + scan.span) };
    flowTitle.textContent = t(step ? `air.step.${step}.title` : 'air.title');
    flowText.textContent =
      step === 'search' || step === 'refine'
        ? t(`air.step.${step}.text`, range!)
        : step === 'adjust'
          ? t('air.step.adjust.text', { angle: adjusting })
          : config.airDirection === 'fixed'
            ? t('air.idleFixed', { angle: currentAngle(config, session) })
            : t(session.running ? 'air.idle' : 'air.idleNotRiding');
    flowNote.hidden = step !== 'search' && step !== 'refine';
    idleActions.hidden = step !== null;
    scanActions.hidden = step !== 'search' && step !== 'refine';
    adjustActions.hidden = step !== 'adjust';
    startButton.disabled = !session.running;
    const fixed = config.airDirection === 'fixed';
    idleAdjust.hidden = !fixed;
    // The search becomes the secondary action once a direction is set.
    startButton.className = fixed ? 'secondary wide' : 'primary wide';
    // The big −1° / +1° buttons replace the small ‹ › under the dial whenever they show.
    dial.nudges.querySelectorAll('button').forEach((b) => (b.hidden = step === 'adjust' || (step === null && fixed)));
    release.hidden = config.airDirection !== 'fixed';
    if (!airPanel.hidden) dial.update();

    const checking = session.running && fan.ok === null;
    if (!checking) checkingSince = null;
    else if (checkingSince === null) {
      checkingSince = Date.now();
      clearTimeout(checkingTimer);
      checkingTimer = window.setTimeout(update, FAN_CHECKING_DELAY_MS + 50);
    }
    const showChecking = checking && Date.now() - checkingSince! >= FAN_CHECKING_DELAY_MS;
    fanAlert.hidden = !(session.running && fan.problem) && !showChecking;
    if (fan.problem) {
      fanAlert.dataset.level = 'error';
      alertIcon.replaceChildren(icon('fan'));
      alertText.textContent = t(`fan.${fan.problem}`);
    } else if (showChecking) {
      fanAlert.dataset.level = 'info';
      alertIcon.replaceChildren(spinner());
      alertText.textContent = t('fan.checking');
    }

    // Zone strip.
    const key = session.zones.map((z) => `${z.number}${z.color}${z.from}${z.speed}`).join();
    if (zones.dataset.key !== key) {
      zones.dataset.key = key;
      replace(
        zones,
        ...session.zones.map((z) =>
          h(
            'div',
            {
              class: 'zone',
              dataset: { zone: String(z.number) },
              title: `${zoneLabel(z)} · ${t('zones.from', { from: z.from, unit: session.unit })} · ${speedLabel(z.speed)}`,
              style: { '--c': z.color },
            },
            h('i'),
            h('span', { text: `Z${z.number}` }),
            h('small', { text: String(z.from) }),
            h('b', { class: 'zone-speed' }, icon('fan'), z.speed ? String(z.speed) : '0'),
          ),
        ),
      );
      markZone(session.zone?.number ?? null);
    }

    toggle.replaceChildren(icon(session.running ? 'pause' : 'play'), t(session.running ? 'action.pause' : 'action.resume'));
    toggle.hidden = !session.configured;
  }

  update();
  return { update, showTest };
}

async function boot(): Promise<void> {
  const root = document.getElementById('app')!;
  try {
    init(await api.get<StateResponse>('state'));
  } catch (err) {
    replace(root, h('div', { class: 'fatal' }, icon('alert'), h('p', { text: errorText(err) })));
    return;
  }

  let view = dashboard(root);
  let language = getLanguage();
  onChange(() => {
    if (getLanguage() !== language) {
      language = getLanguage();
      view = dashboard(root); // static texts follow the new language
    } else {
      view.update();
    }
  });

  const offline = h('div', { class: 'offline', hidden: true }, icon('alert'), h('span', { text: t('error.connection') }));
  document.body.append(offline);
  subscribe({
    state: setSession,
    config: setConfig,
    test: (zone) => view.showTest(zone),
    connection: (online) => {
      offline.hidden = online || document.body.classList.contains('quitting');
    },
  });

  if (needsSetup(store.config)) openWizard(() => void api.post('session/start').catch(() => {}));
}

void boot();
