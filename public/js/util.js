// Tiny DOM + formatting helpers. No framework: the whole app is a handful of
// views, and staying dependency-free means nothing to build and nothing to
// break in CI.

/** Build an element. `h('div.card', {onclick}, child, child)` */
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
    else if (key === 'style' && typeof value === 'object') setStyle(el, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key in el && key !== 'list' && typeof value !== 'object') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }

  append(el, children);
  return el;
}

/**
 * Styles, including custom properties.
 *
 * Object.assign onto a style declaration silently drops anything beginning
 * with two dashes, which is exactly how every shift swatch in the app came to
 * be grey: the rule read var(--shift) and nothing ever set it.
 */
function setStyle(el, styles) {
  for (const [key, value] of Object.entries(styles)) {
    if (value == null) continue;
    if (key.startsWith('--')) el.style.setProperty(key, String(value));
    else el.style[key] = value;
  }
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
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

/**
 * Money as somebody would write it down.
 *
 * Kept here rather than imported from the costing library: that one runs on
 * the server and has no business being shipped to a browser, and a copy of it
 * in `public/` is a copy that drifts. This is the one line of it a screen
 * needs.
 */
export function money(amount, currency = 'GHS') {
  const n = Number(amount) || 0;
  return `${currency} ${n.toLocaleString('en-GB', {
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

// Built once and reused. Whole numbers are the commonest case by far — every
// count in every table goes through this — and constructing a formatter per
// cell is the kind of waste that only shows up on the longest report.
const intFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

export function fmtNum(value, places = 2) {
  if (value == null || value === '' || Number.isNaN(Number(value))) return '—';
  if (places === 0) return intFmt.format(Number(value));
  return new Intl.NumberFormat('en-GB', { maximumFractionDigits: places }).format(Number(value));
}

export function fmtPct(value, places = 1) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `${Number(value) > 0 ? '+' : ''}${fmtNum(value, places)}%`;
}

/** 'Mon 12 Aug' */
export function fmtDay(day, { withYear = false } = {}) {
  if (!day) return '—';
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
}

/**
 * "12 minutes ago" beats a timestamp for anything from the last day or so.
 *
 * Past a week it goes back to a date, because "forty-one days ago" is a number
 * somebody has to do arithmetic on and "14 Jun" is not.
 */
export function fmtSince(at) {
  if (!at) return '';
  const stamp = new Date(`${String(at).replace(' ', 'T')}Z`);
  if (Number.isNaN(stamp.getTime())) return String(at);

  const seconds = Math.max(0, Math.round((Date.now() - stamp.getTime()) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return stamp.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** The same moment written out in full, for a tooltip beside the short form. */
export function fmtStamp(at) {
  if (!at) return '';
  const stamp = new Date(`${String(at).replace(' ', 'T')}Z`);
  if (Number.isNaN(stamp.getTime())) return String(at);
  return stamp.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function fmtDayShort(day) {
  if (!day) return '';
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function shiftDay(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from one date to another. Negative if they are the wrong way round. */
export function daysApart(from, to) {
  return Math.round(
    (new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86400000,
  );
}

export function monthOf(day) { return String(day).slice(0, 7); }

export function shiftMonth(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * A signed change, coloured by whether the movement is good news.
 * Lateness going up is bad; days worked going up is good — hence
 * `higherIsBetter`.
 */
export function deltaBadge(value, { higherIsBetter = false, suffix = '%', places = 1 } = {}) {
  if (value == null || Number.isNaN(Number(value))) {
    return h('span.delta.flat', '—');
  }
  const n = Number(value);
  const flat = Math.abs(n) < 0.05;
  const good = higherIsBetter ? n > 0 : n < 0;
  const cls = flat ? 'flat' : good ? 'down' : 'up';
  const arrow = flat ? '→' : n > 0 ? '↑' : '↓';
  return h(`span.delta.${cls}`, `${arrow} ${fmtNum(Math.abs(n), places)}${suffix}`);
}

/**
 * Whether anything on a form has been changed since it was drawn.
 *
 * A snapshot of every value rather than a listener on every field, because a
 * field can be changed by the screen as well as by a person — a band added, a
 * figure worked out — and what matters is only whether what is on the form now
 * is what was on it when it opened.
 */
export function watchForm(form) {
  const snapshot = () => [...form.querySelectorAll('input, select, textarea')]
    .map((el) => (el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : el.value))
    .join('\u0000');

  let was = snapshot();
  return {
    changed: () => snapshot() !== was,
    // Called once whatever was on it has been written down, so leaving is no
    // longer losing anything.
    saved: () => { was = snapshot(); },
  };
}

/**
 * Hold the reader's place across a redraw.
 *
 * A screen that redraws itself after a save throws the reader back to the top
 * of it. On a page of thirty people that means finding your way back to the
 * one you were working on, every single time, and the longer the screen the
 * worse it gets — so a save on the last row is punished hardest.
 *
 * Called before the redraw; the function it hands back puts the page back
 * where it was. Two frames, because the first one is the browser laying the
 * new content out and the height it will scroll within does not exist yet.
 */
export function keepPlace() {
  const top = window.scrollY;
  return () => requestAnimationFrame(() => requestAnimationFrame(() => {
    // Not where a redraw made the page shorter than where we were.
    const most = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: Math.min(top, most) });
  }));
}

export const PALETTE = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'];
export function paletteColor(index) {
  return `var(${PALETTE[index % PALETTE.length]})`;
}

export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function toast(message, kind = '') {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = h(`div.toast${kind ? `.${kind}` : ''}`, message);
  host.append(el);

  // A modal <dialog> lives in the browser's top layer, above any z-index.
  // Promoting the toast host to a popover puts it in that same layer, so a
  // message can never end up hidden behind an open form.
  try {
    if (host.showPopover && !host.matches(':popover-open')) host.showPopover();
  } catch { /* older browser: the toast still shows, just below a modal */ }
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => {
      el.remove();
      if (!host.children.length) {
        try { host.hidePopover?.(); } catch { /* nothing open to hide */ }
      }
    }, 250);
  }, kind === 'bad' ? 5000 : 2600);
}

export function confirmAction(message) {
  return window.confirm(message);
}

/**
 * Where a scrolling box was, put back after the thing inside it is redrawn.
 *
 * A grid that scrolls inside its own box loses its place whenever the view
 * around it is rebuilt, because what comes back is a different element that
 * has never been scrolled. Pressing Save on a rota and being returned to the
 * top of it is the same twenty names to scroll past again, every time, and it
 * is the change further down the screen that somebody was working on.
 *
 * Call before the redraw, and call what it returns after. Restoring is done
 * twice — once at once and once on the next frame — because a table that has
 * not finished laying out has nothing to scroll yet, and setting scrollTop on
 * a box shorter than its old position silently lands at the bottom instead.
 */
export function keepScroll(selector) {
  const box = document.querySelector(selector);
  const top = box?.scrollTop ?? 0;
  const left = box?.scrollLeft ?? 0;

  return () => {
    if (!top && !left) return;
    const put = () => {
      const again = document.querySelector(selector);
      if (!again) return;
      if (top) again.scrollTop = top;
      if (left) again.scrollLeft = left;
    };
    put();
    requestAnimationFrame(put);
  };
}


/**
 * How tall the screen really is, right now, in pixels.
 *
 * `100vh` is not it. On iOS Safari a vh is a hundredth of the viewport with
 * the browser's own bars *hidden*, so a dialog capped at 92vh on an iPhone
 * with the address bar and the toolbar showing is taller than the part of the
 * screen anybody can see. It does not overflow, so it never becomes
 * scrollable; it simply runs off the bottom under the toolbar, and whatever is
 * down there — the notifications switch, a Save button — cannot be reached at
 * all. `dvh` was meant to answer this and only arrived in Safari 15.4, which
 * is later than a good many phones still in pockets here.
 *
 * `window.innerHeight` is the honest number on every browser going back years:
 * the visible height as it stands, bars and all. It is published as `--vh` and
 * kept up to date, and the stylesheet uses it as the last word on how tall
 * anything full-height may be. The on-screen keyboard does not move it, which
 * is what we want: a dialog that resized itself while somebody typed into it
 * would be its own kind of unusable.
 */
export function watchScreenHeight() {
  const set = () => {
    const px = Math.round(window.innerHeight || 0);
    if (px > 0) document.documentElement.style.setProperty('--vh', `${px}px`);
  };
  set();
  window.addEventListener('resize', set);
  window.addEventListener('orientationchange', () => setTimeout(set, 250));
  // Safari shrinks and grows its bars as the page scrolls, and the number
  // changes with them.
  window.addEventListener('pageshow', set);
}

/**
 * Hold the page still while a dialog is open.
 *
 * A phone that scrolls the page behind a modal instead of the modal is a phone
 * whose owner concludes the dialog does not scroll. Marked on the document
 * rather than handled in each of the five places a dialog is opened, because
 * the one that gets forgotten is the one somebody is stuck in.
 */
export function holdBehindDialogs() {
  const sync = () => {
    const open = Boolean(document.querySelector('dialog[open]'));
    document.documentElement.classList.toggle('has-modal', open);
  };
  new MutationObserver(sync).observe(document.documentElement, {
    childList: true, subtree: true, attributeFilter: ['open'],
  });
  sync();
}
