// DOM and formatting helpers. No framework, no build step: the app is nine
// screens, and a toolchain is a thing that breaks on a Sunday.

export function h(spec, props = null, ...children) {
  const [tag, ...classes] = String(spec).split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');

  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }

  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = `${el.className} ${value}`.trim();
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key in el && typeof value !== 'object') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }

  append(el, children);
  return el;
}

/** The same, for SVG, which needs its own namespace or nothing renders. */
export function s(spec, props = null, ...children) {
  const [tag, ...classes] = String(spec).split('.');
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (classes.length) el.setAttribute('class', classes.join(' '));
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/**
 * Append children to an element, skipping the empty ones.
 *
 * `Element.append(null)` inserts the four characters "null" into the page,
 * which is exactly what a screen built from `a, condition && b, c` produces
 * when the condition is false. Everything in this app that builds a screen
 * goes through here instead.
 */
export function add(el, ...children) {
  append(el, children);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

// ------------------------------------------------------------ formatting --

let symbol = 'GH₵';
export function setCurrency(next) { symbol = next || 'GH₵'; }

const nf = (places) => new Intl.NumberFormat('en-GB', { minimumFractionDigits: places, maximumFractionDigits: places });

/** Pesewas → 'GH₵1,234.50'. Everything on the wire is minor units. */
export function money(minor, { places = 2 } = {}) {
  if (minor == null || Number.isNaN(Number(minor))) return '—';
  const value = Number(minor) / 100;
  return `${value < 0 ? '-' : ''}${symbol}${nf(places).format(Math.abs(value))}`;
}

/**
 * Pesewas → 'GH₵12.9k'. For axis ticks and tiles, where the exact pesewa is
 * noise and the shape of the number is the point. Never used in a table.
 */
export function moneyShort(minor) {
  if (minor == null || Number.isNaN(Number(minor))) return '—';
  const value = Number(minor) / 100;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${symbol}${nf(1).format(abs / 1_000_000)}m`;
  if (abs >= 1_000) return `${sign}${symbol}${nf(abs >= 10_000 ? 0 : 1).format(abs / 1_000)}k`;
  return `${sign}${symbol}${nf(0).format(abs)}`;
}

export function num(value, places = 0) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return nf(places).format(Number(value));
}

export function percent(value, places = 1) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `${nf(places).format(Number(value))}%`;
}

export function hours(value) {
  if (value == null) return '—';
  return `${nf(value % 1 === 0 ? 0 : 1).format(Number(value))} h`;
}

/** '2026-08-14' → '14 Aug'. */
export function shortDay(day) {
  if (!day) return '';
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function dayRange(from, to) {
  return `${shortDay(from)} – ${shortDay(to)} ${new Date(`${to}T12:00:00Z`).getUTCFullYear()}`;
}

/**
 * A signed change, with the direction it should be read in.
 *
 * `goodWhen` matters: revenue rising is good and a wage bill rising is not, and
 * a dashboard that paints both green teaches people to stop reading the colour.
 */
export function delta(changePct, { goodWhen = 'up' } = {}) {
  if (changePct == null || !Number.isFinite(changePct)) {
    return { text: 'no comparison', tone: 'flat', arrow: '' };
  }
  const rounded = Math.round(changePct * 10) / 10;
  if (Math.abs(rounded) < 0.5) return { text: 'unchanged', tone: 'flat', arrow: '→' };
  const up = rounded > 0;
  const good = goodWhen === 'none' ? null : (up === (goodWhen === 'up'));
  return {
    text: `${up ? '+' : ''}${nf(1).format(rounded)}%`,
    tone: good == null ? 'flat' : good ? 'up' : 'down',
    arrow: up ? '↑' : '↓',
  };
}

export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)',
  'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)'];

/**
 * A part of the business always gets the same colour.
 *
 * Fixed by name, not by position in whatever list is on screen. Filtering a
 * chart down to three lines must not repaint them, or the reader has to relearn
 * the legend every time they touch a control.
 */
const LINE_SLOT = {
  restaurant: 0, laundry: 1, bar: 2, breakfast: 3,
  rooms: 4, housekeeping: 5, maintenance: 6, admin: 7,
};
export const lineColour = (line) => SERIES[LINE_SLOT[line] ?? 7];
