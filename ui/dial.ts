/**
 * Airflow direction dial, seen from above like the fan: drag the handle around the circle to
 * point the air at you. Angles go clockwise from the top, from 5 to 355 degrees (the gap at the
 * top is out of reach), as in the MyDyson app.
 */
import type { PublicConfig, SessionState } from '../src/shared/types.ts';
import { api } from './api.ts';
import { errorText, h, t, toast } from './dom.ts';
import { saveConfig, store } from './store.ts';

const SVG = 'http://www.w3.org/2000/svg';
const SIZE = 260;
const C = SIZE / 2;
const R = 112; // disc
const HANDLE_R = 15;
const MIN = 5;
const MAX = 355;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Point on the circle at `angle` degrees clockwise from the top. */
function point(angle: number, radius: number): [number, number] {
  const rad = (angle * Math.PI) / 180;
  return [C + radius * Math.sin(rad), C - radius * Math.cos(rad)];
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...children: SVGElement[]): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  node.append(...children);
  return node;
}

function sector(from: number, to: number, radius: number): string {
  const [x1, y1] = point(from, radius);
  const [x2, y2] = point(to, radius);
  return `M${C} ${C} L${x1} ${y1} A${radius} ${radius} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2} Z`;
}

/** Direction shown: the search in progress, the saved one, else where the fan points. */
export function currentAngle(config: PublicConfig, session: SessionState): number {
  if (session.scan) return session.scan.angle;
  if (config.airDirection === 'fixed' && config.airAngle !== null) return config.airAngle;
  const range = session.fan.angles;
  return range ? Math.round((range.lower + range.upper) / 2) : (config.airAngle ?? 180);
}

/**
 * Touching the dial during a search means taking over: the search stops where it is (without
 * going back to the previous direction) and the fan follows the hand.
 */
function takeOver(): void {
  if (store.session.scan) void api.post('air/scan/stop', { keep: false, hold: true }).catch((err) => toast(errorText(err), 'error'));
}

/** Saved for the rides to come, and applied at once while riding. */
async function aim(angle: number): Promise<void> {
  try {
    await saveConfig({ airDirection: 'fixed', airAngle: clamp(Math.round(angle), MIN, MAX) });
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

export interface DialOptions {
  /** The rider set an angle by hand (drag, keys, ‹ ›). */
  onAim?: (angle: number) => void;
}

export function airDial({ onAim }: DialOptions = {}): { root: HTMLElement; update: () => void; nudges: HTMLElement } {
  let angle = currentAngle(store.config, store.session);
  let dragging = false;

  const line = el('line', { class: 'dial-line' });
  const window = el('path', { class: 'dial-window' });
  const head = el(
    'g',
    { class: 'dial-head' },
    el('rect', { x: C - 26, y: C - 34, width: 52, height: 58, rx: 14, class: 'dial-body' }),
    el('rect', { x: C - 22, y: C - 40, width: 44, height: 10, rx: 4, class: 'dial-nozzle' }),
    el('circle', { cx: C, cy: C - 4, r: 5, class: 'dial-dot' }),
  );
  const handle = el('circle', { r: HANDLE_R, class: 'dial-handle', tabindex: 0, role: 'slider', 'aria-valuemin': MIN, 'aria-valuemax': MAX });
  const [gx1, gy1] = point(-4, R + 2);
  const [gx2, gy2] = point(4, R + 2);
  const svg = el(
    'svg',
    { viewBox: `0 0 ${SIZE} ${SIZE}`, class: 'dial-svg' },
    el('circle', { cx: C, cy: C, r: R, class: 'dial-disc' }),
    el('path', { d: `M${C} ${C} L${gx1} ${gy1} L${gx2} ${gy2} Z`, class: 'dial-gap' }),
    window,
    line,
    head,
    handle,
  );
  const value = h('output', { class: 'dial-value' });
  // One degree at a time, for the last adjustment: a finger on the dial is not that precise.
  const commit = () => {
    onAim?.(angle);
    void aim(angle);
  };
  const nudge = (delta: number) => {
    takeOver();
    angle = clamp(angle + delta, MIN, MAX);
    render();
    commit();
  };
  const left = h('button', { class: 'icon-button small', title: t('air.nudge', { degrees: -1 }), 'aria-label': t('air.nudge', { degrees: -1 }), onclick: () => nudge(-1) }, '‹');
  const right = h('button', { class: 'icon-button small', title: t('air.nudge', { degrees: 1 }), 'aria-label': t('air.nudge', { degrees: 1 }), onclick: () => nudge(1) }, '›');
  const nudges = h('div', { class: 'row dial-row' }, left, value, right);
  const root = h('div', { class: 'dial' }, svg as unknown as HTMLElement, nudges);

  function render() {
    const [hx, hy] = point(angle, R);
    handle.setAttribute('cx', String(hx));
    handle.setAttribute('cy', String(hy));
    handle.setAttribute('aria-valuenow', String(angle));
    handle.setAttribute('aria-label', t('air.title'));
    const [lx1, ly1] = point(angle, 44);
    const [lx2, ly2] = point(angle, R - HANDLE_R - 2);
    Object.entries({ x1: lx1, y1: ly1, x2: lx2, y2: ly2 }).forEach(([k, v]) => line.setAttribute(k, String(v)));
    head.setAttribute('transform', `rotate(${angle} ${C} ${C})`);
    value.textContent = `${Math.round(angle)}°`;
    const { scan } = store.session;
    window.setAttribute('d', scan ? sector(scan.center - scan.span, scan.center + scan.span, R) : '');
    root.classList.toggle('scanning', scan !== null);
    root.classList.toggle('idle', store.config.airDirection !== 'fixed' && scan === null);
  }

  /** Angle under the pointer, clockwise from the top. */
  function angleAt(event: PointerEvent): number {
    const box = svg.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * SIZE - C;
    const y = ((event.clientY - box.top) / box.height) * SIZE - C;
    return Math.round(clamp(((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360, MIN, MAX));
  }

  svg.addEventListener('pointerdown', (event) => {
    takeOver();
    dragging = true;
    svg.setPointerCapture(event.pointerId);
    angle = angleAt(event);
    render();
  });
  svg.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    angle = angleAt(event);
    render();
  });
  const release = () => {
    if (!dragging) return;
    dragging = false;
    commit();
  };
  svg.addEventListener('pointerup', release);
  svg.addEventListener('pointercancel', release);
  handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 15 : 5;
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? step : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -step : 0;
    if (!delta) return;
    event.preventDefault();
    takeOver();
    angle = clamp(angle + delta, MIN, MAX);
    render();
    commit();
  });

  render();
  return {
    root,
    nudges,
    update: () => {
      if (dragging) return;
      angle = currentAngle(store.config, store.session);
      render();
    },
  };
}
