import { add, h, mount, money, num, shortDay, s as svg } from '../util.js';
import { api } from '../api.js';
import { table, banner } from './components.js';
import { filesPanel } from './files.js';
import { tillViews } from './till.js';
import { todoDetail, todoSub, todoTitle, todoAge } from './todo.js';
import { advanceDetail, advanceStatus, advanceOpen, advanceWhen, elsewhereCard } from './advances.js';
import { state } from '../app.js';

/**
 * Shifts: the front desk's control sheet, done from the source records.
 *
 * Six tabs:
 * - **Shifts**: the day, week or month, every shift as a coloured tile
 *   (green agrees, amber needs a look, red needs an answer). Tap one for its
 *   story: the closing report from HIVE beside ASSD, the drawer as a
 *   waterfall, how it was paid, card and MoMo on the clock, where the cash went.
 * - **Inbox**: everything somebody has to act on, in one list: what does not
 *   agree, staff answers, POs, advances, unpaid stays, and what waits for an
 *   admin. Kind chips filter it; the one picked opens beside the list.
 * - **People**: each person's shifts, how their drawer came out, and their list.
 * - **Safe**, **Files** and **Settings**.
 *
 * Every state is shown as a word or an icon as well as a colour.
 */

const SLOTS = ['morning', 'afternoon', 'night'];
const SLOT = {
  morning: { label: 'Morning', hours: '06:00–14:00', start: 6 },
  afternoon: { label: 'Afternoon', hours: '14:00–22:00', start: 14 },
  night: { label: 'Night', hours: '22:00–06:00', start: 22 },
};
const ANSWERS = [
  'Explained', 'Corrected in ASSD', 'Guest paid another way', 'Guest owes, chasing',
  'Deposit for a later stay', 'Refund due to the guest', 'Staff to account for it', 'Not a problem',
];
const KIND = {
  failed: ['Paid by card, but the card was declined', '×'],
  'not-found': ['Recorded as card or MoMo, no payment arrived', '?'],
  zero: ['A card payment of nothing', '0'],
  'double-charge': ['The same card charged twice', '2'],
  'drawer-short': ['The drawer was short', '−'],
  'drawer-over': ['The drawer was over', '+'],
  'handover-gap': ['The hand-over count did not match', '≠'],
  transposition: ['Digits swapped', '⇄'],
  decimal: ['A decimal in the wrong place', '.'],
  keying: ['A keying slip', '#'],
  duplicate: ['Keyed twice in ASSD', '2'],
  'not-recorded': ['Paid, but not in ASSD', '!'],
  'never-settled': ['Never reached the bank', '⌛'],
  reversal: ['The bank took it back', '↺'],
  refund: ['A refund keyed in ASSD', '↺'],
  regrouped: ['The same money, split differently', '='],
  'other-shift': ['Paid on one shift, keyed on another', '→'],
  corrected: ['A mistake and its correction', '✓'],
  'movement-corrected': ['A cash movement keyed wrong and put back', '✓'],
  'movement-matched': ['Cash movement matched', '='],
  'movement-labelled': ['Cash movement labelled by hand', '✓'],
  'movement-twice': ['Moved out of the drawer twice', '2'],
  'movement-reversal': ['Put back on a different shift', '↺'],
  'bank-only': ['In the bank, not on the terminal', '?'],
  'laundry-mismatch': ['The laundry did not agree', 'L'],
  'movement-unlabelled': ['Cash moved out with no label', '?'],
  'expense-no-po': ['Expenses with no PO', '#'],
  'receipts-swapped': ['Receipts swapped for cash', '✓'],
  'expense-po-gap': ['PO total does not match the expenses', '#'],
};
const MODES = [
  ['cash', 'Cash', 'var(--sh-cash)'],
  ['card', 'Card and MoMo', 'var(--sh-card)'],
  ['bank', 'Prepaid by bank transfer', 'var(--sh-bank)'],
  ['online', 'Prepaid by card online', 'var(--sh-online)'],
  ['other', 'Other', 'var(--sh-info)'],
];
const TONE = { good: 'var(--sh-good)', warn: 'var(--sh-warn)', bad: 'var(--sh-bad)', open: 'var(--sh-info)' };
const SEVERITY_COLOUR = { critical: 'var(--sh-bad)', warning: 'var(--sh-warn)', info: 'var(--sh-info)' };
const TABS = [['shifts', 'Shifts'], ['inbox', 'Inbox'], ['people', 'People'], ['safe', 'Safe'], ['files', 'Files'], ['settings', 'Settings']];
/** Where a tab of the old screen now lives, for a saved choice from before. */
const MOVED = {
  day: 'shifts', week: 'shifts', month: 'shifts', shift: 'shifts', closing: 'shifts',
  exceptions: 'inbox', stays: 'inbox', todo: 'inbox', answers: 'inbox', approvals: 'inbox',
};
const PERIODS = ['day', 'week', 'month'];
/** The Inbox's kinds, in the order the chips show them. */
const INBOX_KINDS = [['drawer', 'Drawer'], ['bank', 'Card & bank'], ['po', 'POs'], ['advance', 'Advances'], ['stay', 'Unpaid stays'], ['admin', 'Waiting for admin']];
/** Exception groups about the drawer; the rest are card, MoMo and the bank. */
const DRAWER_GROUPS = new Set(['drawer', 'unlabelled', 'laundry']);

/** Day arithmetic on `YYYY-MM-DD`, at noon UTC so no clock change moves it. */
const plusDays = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekdayOf = (day) => (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
const monthStart = (day) => `${day.slice(0, 7)}-01`;
const monthEnd = (day) => { const d = new Date(`${monthStart(day)}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1, 0); return d.toISOString().slice(0, 10); };
const plusMonths = (day, n) => { const d = new Date(`${monthStart(day)}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

/** The days a period covers, and what to call it. Weeks run Monday to Sunday, as the rota does. */
function periodOf(mode, anchor) {
  if (mode === 'day') {
    return { from: anchor, to: anchor, label: new Date(`${anchor}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) };
  }
  if (mode === 'month') {
    return { from: monthStart(anchor), to: monthEnd(anchor), label: new Date(`${anchor}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) };
  }
  const from = plusDays(anchor, -weekdayOf(anchor));
  const to = plusDays(from, 6);
  return { from, to, label: `Week of ${shortDay(from)} to ${shortDay(to)} ${to.slice(0, 4)}` };
}

const nameOf = (user) => (user ? user.charAt(0) + user.slice(1).toLowerCase() : 'Nobody named');
const dayText = (day, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => new Date(`${day}T12:00:00Z`)
  .toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
const time = (at) => (at ? String(at).slice(11, 16) : '');
const when = (at, day) => (at ? `${shortDay(String(at).slice(0, 10))} ${time(at)}` : (day ? shortDay(day) : ''));
const signed = (minor) => (minor == null ? '—' : minor === 0 ? money(0) : `${minor > 0 ? '+' : '−'}${money(Math.abs(minor))}`);
const whole = (minor) => (minor == null ? '—' : `${minor < 0 ? '−' : ''}${num(Math.abs(minor) / 100)}`);
const cedis = (minor) => (minor == null ? '' : (minor / 100).toFixed(2));
const typedMinor = (value) => (value === '' || value == null ? null : Math.round(Number(value) * 100));
/** A share of a bar, kept inside it whatever the numbers do. */
const pct = (part, whole) => Math.max(0, Math.min(100, (part / whole) * 100));
const store = {
  get(key, fallback) { try { return sessionStorage.getItem(`insight-shifts-${key}`) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { sessionStorage.setItem(`insight-shifts-${key}`, value); } catch { /* private mode */ } },
};

/** The way ASSD wrote a payment method → one of five words. */
function modeOf(label) {
  const t = String(label).toUpperCase();
  if (/\bCASH\b/.test(t)) return 'cash';
  if (/CR\.|CREDIT CARD/.test(t)) return 'card';
  if (/PRE-?BAN/.test(t)) return 'bank';
  if (/PREPAID CC/.test(t)) return 'online';
  return 'other';
}

/** One colour per person, from Insight's fixed series, by the order they first appear. */
function paletteFor(users) {
  const slots = ['--series-1', '--series-2', '--series-3', '--series-5', '--series-6', '--series-7', '--series-4', '--series-8'];
  const out = {};
  [...new Set(users)].sort().forEach((u, i) => { out[u] = `var(${slots[i % slots.length]})`; });
  return out;
}

const GLYPHS = {
  morning: '<svg class="sh-glyph" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="5" fill="var(--series-4)"/><g stroke="var(--series-4)" stroke-width="2" stroke-linecap="round"><path d="M12 3v3M4.5 6.5l2 2M19.5 6.5l-2 2M2 13h3M19 13h3"/></g><path d="M3 20h18" stroke="var(--muted)" stroke-width="2" stroke-linecap="round"/></svg>',
  afternoon: '<svg class="sh-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 17a7 7 0 0 1 14 0z" fill="var(--series-2)"/><path d="M3 20h18" stroke="var(--muted)" stroke-width="2" stroke-linecap="round"/><g stroke="var(--series-2)" stroke-width="2" stroke-linecap="round"><path d="M12 4v3M5.5 8l1.8 1.8M18.5 8l-1.8 1.8"/></g></svg>',
  night: '<svg class="sh-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 3.5A8.5 8.5 0 1 0 20.5 15 7 7 0 0 1 15.5 3.5z" fill="var(--series-7)"/><circle cx="19" cy="5" r="1.2" fill="var(--series-4)"/></svg>',
};
const glyph = (slot) => h('span', { html: GLYPHS[slot], style: 'display:inline-flex' });

export async function renderShifts(root, { range }) {
  const view = h('div.sh');
  add(root, view);

  let data = null;
  let shifts = [];
  let byId = new Map();
  let colours = {};
  // What this person may open. An admin, everything; a supervisor, what an
  // admin gave them under Settings. The server cuts the data to match.
  const who = state.me?.account?.till || { role: 'admin', access: {} };
  const admin = who.role === 'admin';
  const may = (area, level = 1) => admin || (who.access?.[area] || 0) >= level;
  const canShifts = admin || ['day', 'week', 'month', 'money', 'bank', 'net', 'files', 'moves'].some((k) => may(k));
  const canFix = may('moves', 2) && may('money');
  const periods = PERIODS.filter((p) => may(p));
  // What each source of the Inbox needs.
  const can = {
    exceptions: may('bank'), stays: may('unpaid'), todo: admin || who.role === 'supervisor',
    answers: may('answers'), advances: may('advances'), approvals: admin,
  };
  const allowed = {
    shifts: periods.length > 0 || may('money'),
    inbox: Object.values(can).some(Boolean),
    people: may('net') || may('answers'), safe: admin, files: may('files'), settings: admin,
  };
  const views = TABS.filter(([id]) => allowed[id]);
  let section = store.get('section', 'shifts');
  section = MOVED[section] || section;
  if (!views.some(([id]) => id === section)) section = views[0]?.[0] || 'shifts';
  // Day, week or month, and the day it is anchored on. The anchor follows the
  // window chosen at the top of Insight until somebody moves it here.
  let mode = store.get('mode', 'week');
  if (!PERIODS.includes(mode) || (periods.length && !periods.includes(mode))) mode = periods.includes('week') ? 'week' : periods[0] || 'week';
  let anchor = store.get('anchorFor', '') === range.to ? store.get('anchor', range.to) : range.to;
  let period = periodOf(mode, anchor);
  let jumped = false;
  let currentId = store.get('shift', null);
  // A shift opened from the period: its story fills the Shifts tab until Back.
  let detail = false;
  // Exceptions ticked to reconcile together.
  const picked = new Set();
  // What is being typed and not yet saved, per shift: a recount.
  const drafts = {};

  const till = tillViews({ who, period: () => period, describeKey });

  // The Inbox: which kind is shown, which item is open, whether done ones show.
  const inbox = { kind: 'all', open: null, at: 0, showDone: false, ticked: new Set(), elsewhere: {} };
  // The Inbox by keyboard: J and K move, 1 to 8 answer an exception that is open.
  document.addEventListener('keydown', (e) => {
    if (section !== 'inbox' || !view.isConnected || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
    const box = view.querySelector('.ib-detail');
    if (!box) return;
    if (/^[1-8]$/.test(e.key)) {
      const b = box.querySelectorAll('.sh-answers button')[Number(e.key) - 1];
      if (b) { e.preventDefault(); b.click(); }
    } else if (e.key === 'j' || e.key === 'k') {
      const b = box.querySelectorAll('.ib-step .btn')[e.key === 'j' ? 1 : 0];
      if (b && !b.disabled) { e.preventDefault(); b.click(); }
    }
  });

  // What the Inbox reads besides the period's own exceptions: stays not
  // fully paid, the money to-do, advances, and the till's answers and
  // approvals. Read in the background on opening, so the tab shows its count,
  // and again after anything in it is answered.
  let stays = null;
  const sources = { todo: null, advances: null, till: null };
  function readStays() {
    if (!can.stays) return Promise.resolve(null);
    return api('/stays').then((d) => { stays = d; return d; });
  }
  async function readInbox(force = false) {
    const quiet = (p) => p.catch(() => null);
    await Promise.all([
      can.stays ? quiet(readStays()) : null,
      can.todo ? quiet(api(`/todo${inbox.showDone ? '?closed=1' : ''}`).then((d) => { sources.todo = d; })) : null,
      can.advances ? quiet(api('/advances').then((d) => { sources.advances = d; })) : null,
      can.answers || can.approvals ? quiet(till.read(force).then((d) => { sources.till = d; })) : null,
    ].filter(Boolean));
  }
  readInbox().then(() => { if (view.isConnected && data) paint(); }).catch(() => {});

  // Each period's data, once read, kept for as long as the screen is open, so
  // going back to a day, week or month already seen is instant. Anything that
  // changes the numbers (a save, an answer, an upload) empties it.
  const cache = new Map();
  const keyOf = (p) => `${p.from}|${p.to}`;
  function fetchPeriod(p) {
    const key = keyOf(p);
    if (!cache.has(key)) {
      cache.set(key, api(`/shifts?from=${p.from}&to=${p.to}`).catch((err) => { cache.delete(key); throw err; }));
    }
    return cache.get(key);
  }
  /** Read the other views of the same days ahead, quietly, so switching to them waits for nothing. */
  function readAhead() {
    if (!canShifts) return;
    const others = [...periods.filter((m) => m !== mode).map((m) => periodOf(m, anchor)),
      periodOf(mode, mode === 'day' ? plusDays(anchor, -1) : mode === 'week' ? plusDays(anchor, -7) : plusMonths(anchor, -1))];
    setTimeout(() => { for (const p of others) fetchPeriod(p).catch(() => {}); }, 400);
  }

  /**
   * Show the period. `cached` for moving around, where a period already read
   * is shown as it was; without it, everything is read again, because
   * something has just changed.
   */
  async function load(notice = null, { cached = false } = {}) {
    period = periodOf(mode, anchor);
    if (!cached) cache.clear();
    const waitingFor = canShifts && !cache.has(keyOf(period));
    if (waitingFor && view.firstChild) view.classList.add('sh-loading');
    try {
      data = canShifts ? await fetchPeriod(period)
        : { days: [], exceptions: [], people: [], totals: {}, coverage: {}, uploads: [], canUpload: false, groups: [] };
    } finally {
      view.classList.remove('sh-loading');
    }
    // A first visit on days the journal does not reach goes to the newest
    // days it does, once, rather than opening on an empty page.
    if (!jumped && !data.days.some((d) => d.shifts.length) && data.coverage?.journal?.to && data.coverage.journal.to < period.from) {
      jumped = true;
      return moveTo(data.coverage.journal.to, notice, { cached: true });
    }
    jumped = true;
    shifts = [];
    for (const d of [...data.days].sort((a, b) => (a.day < b.day ? -1 : 1))) {
      for (const s of d.shifts) shifts.push({ ...s, id: `${s.day}|${s.slot}`, dayTotals: d.totals, dayLaundry: d.laundry });
    }
    byId = new Map(shifts.map((s) => [s.id, s]));
    colours = paletteFor(shifts.map((s) => s.user));
    if (!byId.has(currentId)) {
      // The latest shift with something to answer, else the latest shift.
      const flagged = [...shifts].reverse().find((s) => tone(s) === 'bad');
      currentId = (flagged || shifts[shifts.length - 1])?.id || null;
    }
    paint(notice);
    readAhead();
  }

  /**
   * Go somewhere on the screen: a tab, a period ('day', 'week', 'month', with
   * the day to anchor it on), or 'shift' with the one to open.
   */
  async function go(next, shiftId = null, day = null) {
    if (shiftId) currentId = shiftId;
    if (currentId) store.set('shift', currentId);
    if (next === 'shift') {
      section = 'shifts';
      detail = true;
      store.set('section', section);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return paint();
    }
    if (PERIODS.includes(next)) {
      section = 'shifts';
      detail = false;
      store.set('section', section);
      if (periods.includes(next) && (next !== mode || (day && day !== anchor))) {
        mode = next;
        if (day) anchor = day;
        remember();
        return load(null, { cached: true });
      }
      return paint();
    }
    section = next;
    if (next === 'shifts') detail = false;
    store.set('section', section);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return paint();
  }

  function remember() {
    store.set('mode', mode);
    store.set('anchor', anchor);
    store.set('anchorFor', range.to);
  }

  /** Move the period: a day, a week or a month at a time, or to a given day. */
  function moveTo(day, notice = null, { cached = true } = {}) {
    anchor = day;
    remember();
    return load(notice, { cached });
  }
  const step = (n) => moveTo(mode === 'day' ? plusDays(anchor, n) : mode === 'week' ? plusDays(anchor, 7 * n) : plusMonths(anchor, n));

  // ------------------------------------------------------------- facts --

  const exceptionsOf = (s) => data.exceptions.filter((x) => x.day === s.day && x.slot === s.slot);
  /** "7 of 9 card and MoMo found", with those whose difference was answered. */
  const cardText = (s, word = '') => `${s.cardFound} of ${s.cardLines} card and MoMo${word} found${s.cardAnswered ? `, ${s.cardAnswered} answered` : ''}`;
  const waiting = () => data.exceptions.filter((x) => x.severity !== 'info' && !x.answer);

  /** The register with what is being typed applied, so the screen moves as somebody types. */
  function numbers(s) {
    const r = s.register || {};
    const d = drafts[s.id] || {};
    // A recount being typed wins; a cleared box falls back to ASSD's own count.
    const closing = d.recount !== undefined ? (d.recount ?? s.closing?.notes ?? null) : r.closing;
    const sheet = d.sheet !== undefined ? d.sheet : (s.expense?.sheetTotal ?? null);
    // The same rule as the server: labelled movements decide; the sheet only
    // settles what nothing labelled, and a disagreement is shown, not hidden.
    const fromSheet = sheet != null ? Math.min(s.unlabelledMoved, Math.max(0, sheet - s.expensesMoved)) : 0;
    const expenses = s.expensesMoved + fromSheet;
    const toSafe = s.safeMoved + (sheet != null ? s.unlabelledMoved - fromSheet : 0);
    const unlabelled = sheet != null ? 0 : s.unlabelledMoved;
    const sheetGap = sheet != null && sheet !== expenses ? sheet - expenses : null;
    const variance = r.expected != null && closing != null ? closing - r.expected : null;
    const recounted = d.recount !== undefined ? d.recount != null : r.closingFrom === 'typed';
    return { ...r, closing, expenses, toSafe, unlabelled, variance, recounted, sheetTyped: sheet != null, sheet, sheetGap };
  }

  function tone(s) {
    if (s.open) return 'open';
    const open = exceptionsOf(s).filter((x) => !x.answer);
    const v = s.register?.variance ?? s.register?.varianceSign;
    if (open.some((x) => x.severity === 'critical')) return 'bad';
    if (v != null && v < 0 && open.length) return 'bad';
    if (open.some((x) => x.severity === 'warning') || (v && open.length)) return 'warn';
    return 'good';
  }

  const avatar = (user, large = false) => h(`span.sh-av${large ? '.lg' : ''}`, { style: `--pc:${colours[user] || 'var(--sh-info)'}` }, (user || '?')[0]);
  const chip = (v, open) => (open ? h('span.sh-chip.none', 'ends here')
    : v == null ? h('span.sh-chip.none', 'no count')
      : v === 0 ? h('span.sh-chip.ok', '✓ agrees')
        : h(`span.sh-chip.${v > 0 ? 'over' : 'short'}`, data.redacted ? (v > 0 ? 'over' : 'short') : `${v > 0 ? '+' : '−'}${whole(Math.abs(v))}`));
  const modesOf = (s) => {
    const out = {};
    for (const [label, amount] of Object.entries(s.modes || {})) out[modeOf(label)] = (out[modeOf(label)] || 0) + amount;
    return out;
  };
  const mixBar = (s) => {
    const m = modesOf(s);
    const total = MODES.reduce((t, [k]) => t + Math.max(0, m[k] || 0), 0);
    return h('div.sh-mix', total ? MODES.filter(([k]) => m[k] > 0)
      .map(([k, , c]) => h('b', { style: `width:${(m[k] / total) * 100}%;background:${c}` })) : null);
  };

  // ------------------------------------------------------------- frame --

  /** The number on a tab: what waits in it. */
  const badgeOf = (id) => (id === 'inbox' ? inboxItems().filter((x) => x.counts).length : 0);

  function paint(notice = null) {
    const has = shifts.length > 0;
    const v = h('div.sh-view');
    const people = new Set(shifts.map((s) => s.user)).size;
    mount(view,
      notice,
      // The title, tabs and period on a dark band of their own, so they read
      // apart from Insight's top bar above them.
      h('div.sh-band',
      h('div.sh-head',
        h('h1', 'Shifts'),
        h('span.sh-count', has ? `${shifts.length} shift${shifts.length === 1 ? '' : 's'} · ${people} ${people === 1 ? 'person' : 'people'}` : 'No shifts loaded for these days')),
      h('div.sh-nav',
        views.length > 1 ? h('div.sh-groups', { role: 'tablist', 'aria-label': 'Parts of Shifts' }, views.map(([id, label]) => h('button', {
          type: 'button', role: 'tab', 'aria-selected': String(section === id), dataset: { tab: id }, onclick: () => go(id),
        }, label, badgeOf(id) ? h('span.sh-badge', String(badgeOf(id))) : null))) : null,
        h('span.sh-rule', { 'aria-hidden': 'true' }),
        section === 'shifts' && !detail && periods.length > 1 ? h('div.sh-span', { role: 'group', 'aria-label': 'Day, week or month' },
          periods.map((m) => h('button', { type: 'button', 'aria-pressed': String(mode === m), onclick: () => go(m) }, m[0].toUpperCase() + m.slice(1)))) : null,
        ['settings', 'files'].includes(section) || (section === 'shifts' && detail) ? null : periodBar(),
        data.journalEndsInside ? h('details.sh-jnote',
          h('summary', `Journal ends inside ${shortDay(data.journalEndsInside.day)} ${SLOT[data.journalEndsInside.slot].label.toLowerCase()}`),
          h('p', `The journal loaded so far stops inside the ${SLOT[data.journalEndsInside.slot].label.toLowerCase()} shift of `
            + `${shortDay(data.journalEndsInside.day)}, so that shift is shown as far as it goes. Export ASSD one day past the last shift you want to read.`)) : null)),
      // Never for a supervisor: the totals are the owner's view of the business.
      has && admin && data.totals && section === 'shifts' && !detail ? kpis() : null,
      v);
    if (section === 'settings') {
      Promise.resolve(till.settings(v)).catch((err) => mount(v, banner('problem', err.message)));
      return undefined;
    }
    if (section === 'inbox') return inboxView(v);
    if (section === 'safe') {
      safeView(v).catch((err) => mount(v, banner('problem', err.message)));
      return undefined;
    }
    if (section === 'files') return filesView(v);
    if (!has) return mount(v, nothingYet());
    if (section === 'people') return peopleView(v);
    if (detail) return shiftView(v);
    ({ day: dayView, week, month: monthView })[mode](v);
    return undefined;
  }

  /** ‹ the period › and a way back to the newest shifts loaded. */
  function periodBar() {
    const latest = data.coverage?.journal?.to || null;
    const away = latest && (latest < period.from || latest > period.to);
    return h('div.sh-period',
      h('button.sh-arrow', { type: 'button', 'aria-label': `Previous ${mode}`, onclick: () => step(-1) }, '‹'),
      h('strong.sh-plabel', period.label),
      h('button.sh-arrow', { type: 'button', 'aria-label': `Next ${mode}`, onclick: () => step(1) }, '›'),
      away ? h('button.btn', { type: 'button', onclick: () => moveTo(latest) }, `Latest: ${shortDay(latest)}`) : null);
  }

  function nothingYet() {
    const c = data.coverage || {};
    return h('div.card',
      h('h2', `No shifts in this ${mode} yet`),
      h('p.sh-sub', c.journal
        ? `The ASSD journal loaded so far covers ${shortDay(c.journal.from)} to ${shortDay(c.journal.to)}. Choose days inside that, or load the journal for these.`
        : 'Load the ASSD detail journal to begin. The bank statement and the card terminal report make the card and MoMo checks possible; the journal alone already gives the cash.'),
      data.canUpload ? h('p', h('button.btn.primary', { onclick: () => go('files') }, 'Load the files')) : null);
  }

  function kpis() {
    const t = data.totals;
    const open = waiting().length;
    const tile = (go_, colour, label, value, note, extra = null, valueColour = null) => h('button.sh-kpi', { type: 'button', onclick: () => go(go_) },
      h('span.l', h('i', { style: `background:${colour}` }), label),
      h('span.v.num', { style: valueColour ? `color:${valueColour}` : '' }, value),
      extra,
      h('span.n', note));
    return h('div.sh-kpis',
      tile('week', 'var(--sh-cash)', 'Cash taken', money(t.cash), `${money(t.drawerOut)} moved out to expenses and the safe`),
      tile('week', 'var(--sh-card)', 'Card and MoMo', money(t.card), `${money(t.received)} arrived on the terminal and by MoMo`,
        h('span.sh-meter', h('b', { style: `width:${t.received ? Math.min(100, (t.card / Math.max(t.card, t.received)) * 100) : 0}%;background:var(--sh-card)` }))),
      tile('people', 'var(--sh-warn)', 'Drawer variance', t.counted ? signed(t.variance) : '—',
        t.counted ? `${t.counted} of ${t.shifts} shifts with an opening and closing count` : 'No counts in these days yet'),
      tile('inbox', 'var(--sh-bad)', 'Waiting for an answer', String(open),
        open ? 'Differences somebody has to explain' : 'Everything answered or explained', null, open ? 'var(--sh-bad-ink)' : 'var(--sh-good-ink)'));
  }

  // ------------------------------------------------------- unpaid stays --

  const STAY_ANSWERS = ['Paid, not in the journal yet', 'Guest is paying now', 'Company or agent pays', 'Guest owes, chasing', 'Written off', 'Not a problem'];

  /**
   * One stay not fully paid: a guest leaving in the next 24 hours who still
   * owes, or one who left owing. Answered here; a supervisor's answer waits
   * for an admin.
   */
  function stayCard(x, after) {
    const d = stays || {};
    const tone = x.unsure ? 'info' : x.left ? 'bad' : 'warn';
    const nights = `${x.nights} night${x.nights === 1 ? '' : 's'}, ${dayText(x.firstNight)} to ${dayText(x.checkout)}`;
    const methods = Object.entries(x.byMethod || {}).filter(([, a]) => a).map(([m, a]) => `${({ cash: 'cash', card: 'card', prepaid: 'prepaid', other: 'other' })[m] || m} ${money(a)}`).join(' · ');
    const note = h('input', { type: 'text', maxlength: '600', placeholder: 'What happened (optional)', value: x.answer?.note || '' });
    const said = h('span.small');
    const answer = async (value) => {
      said.textContent = 'Saving…';
      try {
        const out = await api('/shifts/answer', { method: 'POST', body: { key: x.key, answer: value, note: value ? note.value : '' } });
        await after(out?.pending ? 'Sent to an admin to approve.' : 'Saved.');
      } catch (err) { said.textContent = err.message; }
    };
    const decide = (ok) => async () => {
      try { await api('/till/approve', { method: 'POST', body: { answer: x.key, ok } }); await after(ok ? 'Approved.' : 'Rejected.'); } catch (err) { said.textContent = err.message; }
    };
    return h(`article.sh-ex.${tone}${x.answer ? '.done' : ''}`,
      h('div.hd', h('span.sq', '₵'), h('h3', `Reservation ${x.ref || x.seq}`), h('span.amt.num', d.redacted ? 'owes' : money(x.balance))),
      h('div.sh-meta',
        h('span', x.rooms.join(', ') || 'Room'),
        h('span', nights),
        h('span', `check-out ${dayText(x.checkout)} ${x.checkoutAt.slice(11)}`),
        x.bookedBy ? h('span', `booked by ${nameOf(x.bookedBy)}`) : null),
      h('p.small', x.left ? 'Checked out, still owing.' : 'Leaving in the next 24 hours, not fully paid. Collect before they go.'),
      d.redacted ? null : h('div.sh-staymoney',
        h('div', h('small', 'Charged'), h('b', whole(x.charged))),
        h('div', h('small', 'Paid'), h('b', whole(x.paid))),
        h('div.owes', h('small', 'Owes'), h('b', whole(x.balance)))),
      methods ? h('p.small', `Paid so far: ${methods}`) : h('p.small', 'No payment in the journal loaded.'),
      x.unsure ? h('p.small.muted', `Booked ${dayText(x.bookedOn)}, before the first day of journal loaded (${dayText(d.journal?.from)}). A payment taken then would not show: check ASSD.`) : null,
      x.proposed ? h('div.sh-waiting',
        h('span', `⏳ Waiting for an admin: ${x.proposed.answer}${x.proposed.note ? `: ${x.proposed.note}` : ''} (${x.proposed.by})`),
        admin ? [
          h('button.btn.primary', { type: 'button', onclick: decide(true) }, 'Approve'),
          h('button.btn', { type: 'button', onclick: decide(false) }, 'Reject'),
        ] : null, said)
        : x.answer ? h('div.sh-done',
          h('span', `✓ ${x.answer.answer}${x.answer.note ? `: ${x.answer.note}` : ''} (${x.answer.by})`),
          may('unpaid', 2) ? h('button.sh-link', { type: 'button', onclick: () => answer('') }, 'Change') : null, said)
          : may('unpaid', 2) ? h('div.sh-answers', note, STAY_ANSWERS.map((a) => h('button', { type: 'button', onclick: () => answer(a) }, a)), said) : null);
  }

  // -------------------------------------------------------------- safe --

  /**
   * The safe book: cash in from the shifts, cash out as written (a PO, cash
   * banked, a payment waiting for its PO), the balance the safe should hold,
   * and a count to close the page. Beside it, the confirmed Odoo POs nobody
   * has claimed, offered one by one.
   */
  async function safeView(v, notice = null) {
    mount(v, h('p.muted', 'Reading the safe book…'));
    const d = await api(`/safe/book?from=${period.from}&to=${period.to}`);
    const re = (msg) => safeView(v, msg ? banner('good', msg) : null);
    const fail = (said) => (err) => { said.textContent = err.message; said.className = 'small form-error'; };
    const todayIso = new Date().toISOString().slice(0, 10);
    const dateBox = (id) => h('input', { type: 'date', value: todayIso, id });
    const amountBox = (id, ph = '0.00') => h('input', { type: 'text', inputmode: 'decimal', placeholder: ph, id });

    // ----- the book
    const outLabel = (l) => (l.kind === 'po' ? `${l.po} · ${l.vendor || ''}` : l.kind === 'banked' ? `Banked or handed over · ${l.ref}` : `Waiting for a PO · ${l.description}`);
    const outDetail = (l) => [
      l.kind === 'po' ? (l.settledBy ? 'Paid first, its PO added later' : 'Paid from the safe · confirmed in Odoo') : null,
      l.differs ? `the PO says ${money(l.poTotal)}` : null,
      l.note, l.by ? `by ${l.by}` : null,
      l.settledBy && l.settledBy !== l.by ? `PO added by ${l.settledBy}` : null,
    ].filter(Boolean).join(' · ');
    const settleBox = (l) => {
      const po = h('input', { type: 'text', placeholder: 'P00440', 'aria-label': 'Its PO number', style: 'width:8rem' });
      const said = h('span.small');
      return h('div.sh-safeinline', po, h('button.btn', {
        type: 'button',
        onclick: async () => {
          said.textContent = 'Asking Odoo…';
          try {
            const out = await api(`/safe/entry/${l.id}/po`, { method: 'POST', body: { po: po.value } });
            await re(`${out.po} added.${out.differs ? ` The PO says ${money(out.poTotal)}; ${money(out.amount)} left the safe.` : ''}`);
          } catch (err) { fail(said)(err); }
        },
      }, 'Add its PO'), said);
    };
    const removeBtn = (l) => h('button.sh-link', {
      type: 'button',
      onclick: async () => {
        try { await api(`/safe/entry/${l.id}/remove`, { method: 'POST', body: {} }); await re('Taken out of the book.'); } catch (err) { alert(err.message); }
      },
    }, 'Remove');
    const rows = [
      d.start ? h('tr.start', h('td', dayText(d.start.day)), h('td', h('b', 'Counted'), h('small', d.start.with ? `with ${d.start.with}` : 'the start of this page')), h('td.num', ''), h('td.num', ''), h('td.num', h('b', money(d.start.counted))))
        : null,
      ...d.lines.map((l) => (l.type === 'in'
        ? h('tr', h('td', dayText(l.day)),
          h('td', h('b', `Envelopes · ${nameOf(l.user)}, ${SLOT[l.slot].label.toLowerCase()}`),
            h('small', l.list?.length ? `${l.list.map((e) => `No. ${e.no}`).join(', ')} · ${l.agrees ? 'ASSD agrees' : `the envelopes say ${money(l.envelopes)}`}` : 'from ASSD; no closing report')),
          h('td.num.in', money(l.amount)), h('td.num', ''), h('td.num', money(l.balance)))
        : h(`tr${l.kind === 'pending' ? '.pending' : ''}`, h('td', dayText(l.day)),
          h('td', h('b', outLabel(l)), h('small', outDetail(l)), l.kind === 'pending' ? settleBox(l) : null, removeBtn(l)),
          h('td.num', ''), h('td.num.out', money(l.amount)), h('td.num', money(l.balance))))),
    ];

    // ----- writing something that left the safe
    const forms = h('div');
    const form = (title, fields, send) => {
      const said = h('span.small');
      mount(forms, h('div.sh-safeform-card', h('b', title), h('div.sh-safeform', fields),
        h('div.sh-safeinline',
          h('button.btn.primary', { type: 'button', onclick: async (e) => { e.target.disabled = true; said.textContent = 'Saving…'; try { await send(); } catch (err) { fail(said)(err); e.target.disabled = false; } } }, 'Add to the book'),
          h('button.btn', { type: 'button', onclick: () => mount(forms) }, 'Cancel'), said)));
    };
    const addPo = () => {
      const po = h('input', { type: 'text', placeholder: 'P00440', id: 'sf-po' });
      const day = dateBox('sf-po-day');
      form('A PO paid from the safe', [h('label.field', 'PO number', po), h('label.field', 'Day paid', day)], async () => {
        const out = await api('/safe/entry', { method: 'POST', body: { kind: 'po', po: po.value, day: day.value } });
        await re(`${out.po} (${money(out.amount)}) written out of the safe.`);
      });
    };
    const addBanked = () => {
      const amount = amountBox('sf-bank-amt');
      const ref = h('input', { type: 'text', placeholder: 'GTBank slip 0048812, or who received it', id: 'sf-bank-ref' });
      const day = dateBox('sf-bank-day');
      form('Banked or handed over', [h('label.field', 'Amount (GH₵)', amount), h('label.field', 'Where it went', ref), h('label.field', 'Day', day)], async () => {
        await api('/safe/entry', { method: 'POST', body: { kind: 'banked', amount: amount.value, ref: ref.value, day: day.value } });
        await re('Written out of the safe.');
      });
    };
    const addPending = () => {
      const amount = amountBox('sf-pend-amt');
      const what = h('input', { type: 'text', placeholder: 'Water delivery, plumber…', id: 'sf-pend-what' });
      const day = dateBox('sf-pend-day');
      form('Paid from the safe, PO to follow', [h('label.field', 'Amount (GH₵)', amount), h('label.field', 'What it paid for', what), h('label.field', 'Day', day)], async () => {
        await api('/safe/entry', { method: 'POST', body: { kind: 'pending', amount: amount.value, description: what.value, day: day.value } });
        await re('Written out of the safe, waiting for its PO.');
      });
    };

    // ----- the count
    const counted = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0.00', id: 'sf-count' });
    const countDay = dateBox('sf-count-day');
    const withName = h('input', { type: 'text', placeholder: 'The supervisor', id: 'sf-count-with' });
    const countNote = h('input', { type: 'text', placeholder: 'Optional', id: 'sf-count-note' });
    const verdict = h('div.sh-safeverdict');
    const sugBox = h('div');
    const countSaid = h('span.small');
    const subset = (list, target) => {
      const pool = list.slice(0, 14);
      for (let mask = 1; mask < (1 << pool.length); mask += 1) {
        let sum = 0;
        for (let i = 0; i < pool.length; i += 1) if (mask & (1 << i)) sum += pool[i].amount;
        if (sum === target) return pool.filter((_, i) => mask & (1 << i)).map((x) => x.name);
      }
      return [];
    };
    const typedCount = () => { const n = Number(String(counted.value).replace(/[,\s]/g, '')); return counted.value.trim() && Number.isFinite(n) ? Math.round(n * 100) : null; };
    const paintSuggestions = () => {
      const c = typedCount();
      const diff = c == null || !d.started ? null : d.balance - c;
      const hinted = diff > 0 ? subset(d.suggestions, diff) : [];
      mount(verdict, c == null || !d.started ? null : diff === 0
        ? h('div.ok', h('b', '✓ The count agrees with the book'))
        : h('div.warn', h('b', diff > 0 ? `${money(diff)} less than the book` : `${money(-diff)} more than the book`),
          h('span', diff > 0
            ? (hinted.length ? `${hinted.join(' + ')} add up to exactly that. Were they paid from the safe?` : `Something left the safe that is not in the book${d.pending ? `, or a payment waiting for its PO was a different amount` : ''}. Add it, or close with the difference recorded.`)
            : 'More cash than the book says. Check the envelopes against ASSD.')));
      mount(sugBox, d.odooError ? h('p.small.muted', d.odooError)
        : d.suggestions.length ? d.suggestions.map((p) => {
          const said = h('span.small');
          return h(`div.sh-safesug${hinted.includes(p.name) ? '.hint' : ''}`,
            h('div.top', h('div', h('b', `${p.name} · ${p.vendor}`), h('small', p.orderedOn ? `ordered ${dayText(p.orderedOn)}` : '')), h('b.num', money(p.amount))),
            hinted.includes(p.name) ? h('small.why', 'Part of the count’s difference') : null,
            p.pending ? h('small.why', 'Same amount as a payment waiting for its PO') : null,
            h('div.sh-safeinline',
              p.pending
                ? h('button.btn.primary', { type: 'button', onclick: async () => { try { await api(`/safe/entry/${p.pending}/po`, { method: 'POST', body: { po: p.name } }); await re(`${p.name} given to the waiting payment.`); } catch (err) { fail(said)(err); } } }, 'It is the waiting payment')
                : null,
              h(p.pending ? 'button.btn' : 'button.btn.primary', { type: 'button', onclick: async () => { try { await api('/safe/entry', { method: 'POST', body: { kind: 'po', po: p.name, day: p.orderedOn || todayIso } }); await re(`${p.name} written out of the safe.`); } catch (err) { fail(said)(err); } } }, 'Paid from the safe'),
              h('button.btn', { type: 'button', onclick: async () => { try { await api('/safe/dismiss', { method: 'POST', body: { po: p.name } }); await re(`${p.name} will not be offered again.`); } catch (err) { fail(said)(err); } } }, 'Not from the safe'),
              said));
        }) : h('p.small.muted', 'Nothing waiting: every confirmed PO since the last count is accounted for.'));
    };
    counted.addEventListener('input', paintSuggestions);
    const doCount = async (e) => {
      e.target.disabled = true;
      countSaid.textContent = 'Saving…';
      try {
        const out = await api('/safe/count', { method: 'POST', body: { counted: counted.value, closedOn: countDay.value, with: withName.value, note: countNote.value } });
        await re(out.started ? `The book starts here, at ${money(out.counted)}.`
          : out.difference === 0 ? `Counted ${money(out.counted)}. The safe agrees with the book.`
            : `Counted ${money(out.counted)}, ${money(Math.abs(out.difference))} ${out.difference < 0 ? 'less' : 'more'} than the book. Recorded.`);
      } catch (err) { fail(countSaid)(err); e.target.disabled = false; }
    };

    mount(v,
      notice,
      h('div.sh-safebook',
        h('section.card.sh-safemain',
          h('div.sh-cardhead', h('h2', 'The safe book'), h('p.sh-sub', 'Every cedi in and out since the last count. What comes in is read from the shifts.')),
          d.started ? h('div.sh-safebal', h('span', 'By the book, the safe holds'), h('b.num', money(d.balance)),
            d.pending ? h('span.sh-chip.short', `${d.pending} waiting for a PO`) : null)
            : banner('warning', 'Count the safe once to start the book. What you count is where it begins.'),
          h('div.sh-dtable', h('table',
            h('thead', h('tr', h('th', 'Day'), h('th', 'What'), h('th.num', 'In'), h('th.num', 'Out'), h('th.num', 'Balance'))),
            h('tbody', rows))),
          h('div.sh-safeinline',
            h('button.btn', { type: 'button', onclick: addPo }, '+ A PO paid from the safe'),
            h('button.btn', { type: 'button', onclick: addPending }, '+ Paid, PO to follow'),
            h('button.btn', { type: 'button', onclick: addBanked }, '+ Banked or handed over')),
          forms),
        h('div.sh-safeside',
          h('section.card',
            h('div.sh-cardhead', h('h2', 'Confirmed in Odoo, not claimed'), h('p.sh-sub', `POs ordered ${period.from === period.to ? `on ${dayText(period.from)}` : `from ${dayText(period.from)} to ${dayText(period.to)}`} that no closing report, drawer expense or the safe has claimed. Were they paid from the safe?`)),
            sugBox),
          h('section.card.sh-safecount',
            h('h2', d.started ? 'Count the safe' : 'Start the book'),
            h('div.sh-safeform',
              h('label.field', 'Counted now (GH₵)', counted),
              h('label.field', 'Day', countDay),
              h('label.field', 'Counted with', withName),
              h('label.field', 'Note', countNote)),
            verdict,
            h('div.sh-safeinline', h('button.btn.primary', { type: 'button', onclick: doCount }, d.started ? 'Count and close this page' : 'Start the book'), countSaid),
            h('p.small.muted', d.started ? 'The count starts the next page. Envelopes and payments up to that day go on this page.' : 'Envelopes before that day are taken as in the safe already.')))),
      d.closures.length ? h('section.card',
        h('div.sh-cardhead', h('h2', 'Counts'), h('p.sh-sub', 'Each time the safe was counted, against what the book said.')),
        h('div.sh-dtable', h('table',
          h('thead', h('tr', h('th', 'Day'), h('th', 'With'), h('th.num', 'Counted'), h('th.num', 'The book'), h('th.num', 'Difference'), h('th', ''))),
          h('tbody', d.closures.map((c) => h('tr',
            h('td', dayText(c.closedOn)), h('td', c.with || '—'),
            h('td.num', c.counted == null ? (c.taken != null ? `taken out ${money(c.taken)}` : '—') : money(c.counted)),
            h('td.num', c.book == null ? '—' : money(c.book)),
            h('td.num', c.difference == null ? '—' : c.difference === 0 ? '✓ agrees' : `${c.difference > 0 ? '+' : '−'}${money(Math.abs(c.difference))}`),
            h('td', h('button.sh-link', {
              type: 'button',
              onclick: async () => {
                if (!confirm(`Undo the count of ${dayText(c.closedOn)}? Its envelopes and payments go back on the open page.`)) return;
                try { await api(`/safe/${c.id}/undo`, { method: 'POST', body: {} }); await re('Undone.'); } catch (err) { alert(err.message); }
              },
            }, 'Undo')))))))) : null);
    paintSuggestions();
  }

  // -------------------------------------------------------------- week --

  function week(v) {
    const days = [...data.days].sort((a, b) => (a.day < b.day ? -1 : 1));
    const grid = h('div.sh-week', { style: `grid-template-columns: 6.6rem repeat(${days.length}, minmax(118px, 1fr)); min-width: ${110 + days.length * 126}px` });
    add(grid, h('div'));
    for (const d of days) {
      const ss = SLOTS.map((sl) => byId.get(`${d.day}|${sl}`)).filter(Boolean);
      add(grid, h('div.sh-col',
        h('b', dayText(d.day, { weekday: 'short' })),
        h('small', dayText(d.day, { day: 'numeric', month: 'short' })),
        h('div.dots', ss.map((s) => h('i', { style: `background:${TONE[tone(s)]}` })))));
    }
    for (const sl of SLOTS) {
      add(grid, h('div.sh-row', h('b', glyph(sl), SLOT[sl].label), h('small', SLOT[sl].hours)));
      for (const d of days) {
        const s = byId.get(`${d.day}|${sl}`);
        if (!s) { add(grid, h('div.sh-tile.empty', 'Not in the journal yet')); continue; }
        const t = tone(s);
        const toAnswer = exceptionsOf(s).filter((x) => !x.answer && x.severity !== 'info').length;
        add(grid, h(`button.sh-tile.${t}${s.id === currentId ? '.sel' : ''}`, {
          type: 'button', title: `${nameOf(s.user)} · ${SLOT[sl].label} · ${dayText(s.day)}`, onclick: () => go('shift', s.id),
        },
        h('span.sh-who', avatar(s.user), h('b', nameOf(s.user))),
        h('span.sh-fig', h('span.num', `Cash ${whole(s.cash)}`), chip(s.register?.variance ?? s.register?.varianceSign, s.open)),
        mixBar(s),
        h('span.sh-fig',
          h('span', s.cardLines ? `${s.cardFound + (s.cardAnswered || 0)}/${s.cardLines} card` : 'no card'),
          toAnswer ? h('span.sh-chip.short', `${toAnswer} to answer`) : null)));
      }
    }
    const wrap = h('div.sh-weekwrap', grid);

    mount(v,
      h('section.card',
        h('div.sh-cardhead',
          h('div', h('h2', 'Every shift, at a glance')),
          h('div.sh-legend',
            h('span', h('i', { style: 'background:var(--sh-good)' }), 'Agrees'),
            h('span', h('i', { style: 'background:var(--sh-warn)' }), 'Look at it'),
            h('span', h('i', { style: 'background:var(--sh-bad)' }), 'Answer needed'),
            MODES.slice(0, 3).map(([, label, c]) => h('span', h('i', { style: `background:${c}` }), label === 'Prepaid by bank transfer' ? 'Prepaid' : label)))),
        wrap),
      cardBars(days));
    // The newest days are the ones looked at; start the grid there.
    requestAnimationFrame(() => { wrap.scrollLeft = wrap.scrollWidth; });
  }

  /** Card and MoMo recorded in ASSD against what arrived, a pair of bars a day. Tap a day to open it. */
  function cardBars(days) {
    const max = Math.max(1, ...days.map((d) => Math.max(d.totals.cardRecorded, d.totals.received)));
    const bars = h('div.sh-bars', { style: `grid-template-columns: repeat(${days.length}, minmax(${days.length > 14 ? 28 : 44}px, 1fr)); min-width: ${days.length * (days.length > 14 ? 32 : 50)}px` },
      days.map((d) => {
        const gap = d.totals.received - d.totals.cardRecorded;
        const has = SLOTS.some((sl) => byId.has(`${d.day}|${sl}`));
        return h('button.sh-bar', {
          type: 'button',
          title: `${dayText(d.day)}: recorded ${money(d.totals.cardRecorded)}, arrived ${money(d.totals.received)} (${signed(d.totals.received - d.totals.cardRecorded)}), bank commission ${money(d.totals.commission)}`,
          onclick: () => has && go('day', null, d.day),
        },
        h('div.pair',
          h('b', { style: `height:${pct(d.totals.cardRecorded, max)}%;background:var(--sh-card)` }),
          h('b', { style: `height:${pct(d.totals.received, max)}%;background:var(--series-3)` })),
        h('small', dayText(d.day, { weekday: days.length > 14 ? undefined : 'short', day: 'numeric' }),
          // A month has no room for figures under every day: a mark there, the figure on hover.
          has ? h('em', { style: `color:${gap === 0 ? 'var(--sh-good-ink)' : Math.abs(gap) < 10000 ? 'var(--sh-warn-ink)' : 'var(--sh-bad-ink)'}` },
            gap === 0 ? '✓' : days.length > 14 ? '!' : `${gap > 0 ? '+' : '−'}${whole(Math.abs(gap))}`) : h('em', '·')));
      }));
    return h('section.card',
      h('div.sh-cardhead',
        h('div', h('h2', 'Card and MoMo: recorded against arrived'),
          h('p.sh-sub', 'What ASSD says was paid by card or MoMo each day, beside what the terminal approved and MoMo received for the same shifts. Tap a day to open it.')),
        h('div.sh-legend',
          h('span', h('i', { style: 'background:var(--sh-card)' }), 'Recorded in ASSD'),
          h('span', h('i', { style: 'background:var(--series-3)' }), 'Arrived'))),
      h('div', { style: 'overflow-x:auto' }, bars));
  }

  // --------------------------------------------------------------- day --

  /** One day: its three shifts side by side, the day against the money that arrived, and what does not agree. */
  function dayView(v) {
    const d = data.days.find((x) => x.day === anchor) || data.days[data.days.length - 1];
    const mine = SLOTS.map((sl) => byId.get(`${d.day}|${sl}`)).filter(Boolean);
    const cash = mine.reduce((t, s) => t + s.cash, 0);
    const out = mine.reduce((t, s) => t + s.drawerOut, 0);
    const gap = d.totals.received - d.totals.cardRecorded;
    const top = Math.max(1, d.totals.cardRecorded, d.totals.received);
    const hbar = (label, amount, colour) => h('div.sh-hbar',
      h('span', label), h('span.sh-track', h('b.sh-seg', { style: `left:0;width:${pct(amount, top)}%;background:${colour}` })), h('b.num', money(amount)));
    const l = d.laundry;
    const exs = data.exceptions.filter((x) => x.day === d.day);
    mount(v,
      h('div.sh-days', SLOTS.map((sl) => {
        const s = byId.get(`${d.day}|${sl}`);
        return s ? dayCard(s) : h('div.sh-daycard.empty',
          h('div.top', glyph(sl), h('span', `${SLOT[sl].label} · ${SLOT[sl].hours}`)),
          h('p', 'Not in the journal yet.'));
      })),
      h('section.card',
        h('div.sh-cardhead', h('div', h('h2', 'The day against the money that arrived'),
          h('p.sh-sub', 'All three shifts together: the cash taken and moved out, and card and MoMo recorded in ASSD beside what the terminal approved and MoMo received.'))),
        h('div.sh-daysum',
          h('div', h('small', 'Cash taken'), h('b.num', money(cash))),
          h('div', h('small', 'Moved out of the drawer'), h('b.num', money(out))),
          h('div', h('small', 'Bank commission on the cards'), h('b.num', money(d.totals.commission)))),
        hbar('Recorded in ASSD', d.totals.cardRecorded, 'var(--sh-card)'),
        hbar('Arrived', d.totals.received, 'var(--series-3)'),
        h('p', { style: `font-weight:600;color:${gap === 0 ? 'var(--sh-good-ink)' : 'var(--sh-bad-ink)'}` },
          gap === 0 ? '✓ Every card and MoMo payment found' : `${signed(gap)} between what arrived and what ASSD recorded. See the exceptions below.`),
        l && (l.assd || l.system != null) ? h('p.sh-sub', l.system == null
          ? `Laundry in ASSD: ${money(l.assd)}. The laundry system has nothing for this day in Insight yet.`
          : `Laundry: ${money(l.assd)} in ASSD, ${money(l.system)} in the laundry system${l.assd === l.system ? ', they agree.' : '.'}`) : null),
      exs.length ? h('section.card',
        h('div.sh-cardhead', h('h2', `What does not agree on ${shortDay(d.day)}`)),
        h('div.sh-exgrid', exs.map(exceptionCard))) : null);
  }

  /** A shift as a large card on the Day view: the drawer in four lines, how it was paid, and what is open. */
  function dayCard(s) {
    const r = s.register || {};
    const t = tone(s);
    const m = modesOf(s);
    const toAnswer = exceptionsOf(s).filter((x) => !x.answer && x.severity !== 'info').length;
    const v = r.variance ?? r.varianceSign;
    return h(`button.sh-daycard.${t}`, { type: 'button', onclick: () => go('shift', s.id) },
      h('div.top', glyph(s.slot), h('span', `${SLOT[s.slot].label} · ${SLOT[s.slot].hours}`),
        h(`span.sh-status.${t}`, { good: '✓ Agrees', warn: '! Look at it', bad: '! Answer needed', open: 'Journal ends here' }[t])),
      h('div.sh-who', avatar(s.user, true), h('b', { style: 'font-size:1.1rem' }, nameOf(s.user))),
      h('dl.sh-mini',
        h('dt', 'Opening notes'), h('dd.num', money(r.opening)),
        h('dt', '+ Cash taken'), h('dd.num', money(s.cash)),
        h('dt', '− Spent and moved out'), h('dd.num', money(r.opening != null && r.expected != null ? r.opening + s.cash - r.expected : null)),
        h('dt', 'Closing notes'), h('dd.num', money(r.closing))),
      h('div.sh-dayvar', v == null ? h('span.sh-chip.none', s.open ? 'journal ends here' : 'no closing count')
        : v === 0 ? h('span.sh-chip.ok', '✓ The drawer agrees')
          : h(`span.sh-chip.${v > 0 ? 'over' : 'short'}`, `${v > 0 ? 'Over' : 'Short'}${data.redacted ? '' : ` ${money(Math.abs(v))}`}`)),
      mixBar(s),
      h('div.sh-mixkey', MODES.filter(([k]) => m[k] > 0).map(([k, label, c]) => h('span', h('i', { style: `background:${c}` }), `${label === 'Card and MoMo' ? 'Card' : label.replace('Prepaid by ', 'Prepaid ')} ${whole(m[k])}`))),
      h('div.sh-fig',
        h('span', s.cardLines ? cardText(s) : 'No card or MoMo'),
        toAnswer ? h('span.sh-chip.short', `${toAnswer} to answer`) : null),
      h('span.sh-open', 'Open the shift →'));
  }

  // ------------------------------------------------------------- month --

  /** The month as a calendar: each day with its three shifts as coloured bars, and the month's numbers by week. */
  function monthView(v) {
    const first = period.from;
    const last = period.to;
    const start = plusDays(first, -weekdayOf(first));
    const end = plusDays(last, 6 - weekdayOf(last));
    const cells = [];
    for (let d = start; d <= end; d = plusDays(d, 1)) cells.push(d);
    const dayOf_ = new Map(data.days.map((d) => [d.day, d]));
    const cal = h('div.sh-month',
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => h('div.sh-mhead', w)),
      cells.map((day) => {
        if (day < first || day > last) return h('div.sh-mcell.out', h('span.n', String(Number(day.slice(8)))));
        const ss = SLOTS.map((sl) => byId.get(`${day}|${sl}`));
        const any = ss.some(Boolean);
        const open = data.exceptions.filter((x) => x.day === day && !x.answer && x.severity !== 'info').length;
        const d = dayOf_.get(day);
        const cell = h(`div.sh-mcell${any ? '' : '.none'}${day === anchor ? '.sel' : ''}`, {
          role: any ? 'button' : null, tabindex: any ? '0' : null, title: any ? `Open ${dayText(day)}` : 'Not in the journal',
        },
        h('div.sh-mtop', h('span.n', String(Number(day.slice(8)))), open ? h('span.sh-chip.short', String(open)) : null),
        h('div.sh-mslots', ss.map((s, i) => (s
          ? h('button.sh-mslot', {
            type: 'button', style: `background:${TONE[tone(s)]}`, title: `${nameOf(s.user)} · ${SLOT[SLOTS[i]].label}`,
            onclick: (e) => { e.stopPropagation(); go('shift', s.id); },
          }, (s.user || '?')[0])
          : h('span.sh-mslot.empty')))),
        any && d ? h('small.num', `Cash ${whole(ss.reduce((t, s) => t + (s?.cash || 0), 0))}`) : null);
        if (any) {
          const open_ = () => go('day', null, day);
          cell.addEventListener('click', open_);
          cell.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open_(); } });
        }
        return cell;
      }));

    // Week by week, Monday to Sunday, within the month.
    const weeks = [];
    for (let w = start; w <= last; w = plusDays(w, 7)) {
      const from = w < first ? first : w;
      const to = plusDays(w, 6) > last ? last : plusDays(w, 6);
      const ss = shifts.filter((s) => s.day >= from && s.day <= to);
      if (!ss.length) continue;
      weeks.push({
        from, to, count: ss.length,
        cash: ss.reduce((t, s) => t + s.cash, 0),
        card: ss.reduce((t, s) => t + s.card, 0),
        variance: ss.reduce((t, s) => t + (s.register?.variance || 0), 0),
        open: data.exceptions.filter((x) => x.day >= from && x.day <= to && !x.answer && x.severity !== 'info').length,
      });
    }
    mount(v,
      h('section.card',
        h('div.sh-cardhead',
          h('div', h('h2', `${period.label}, day by day`)),
          h('div.sh-legend',
            h('span', h('i', { style: 'background:var(--sh-good)' }), 'Agrees'),
            h('span', h('i', { style: 'background:var(--sh-warn)' }), 'Look at it'),
            h('span', h('i', { style: 'background:var(--sh-bad)' }), 'Answer needed'),
            h('span', h('i', { style: 'background:var(--sh-info)' }), 'Journal ends'))),
        h('div', { style: 'overflow-x:auto' }, cal)),
      weeks.length ? h('section.card',
        h('div.sh-cardhead', h('h2', 'Week by week')),
        table([
          { label: 'Week', get: (w) => h('button.sh-link', { type: 'button', onclick: () => go('week', null, w.from) }, `${shortDay(w.from)} to ${shortDay(w.to)}`) },
          { label: 'Shifts', num: true, get: (w) => num(w.count) },
          { label: 'Cash taken', num: true, get: (w) => money(w.cash) },
          { label: 'Card and MoMo', num: true, get: (w) => money(w.card) },
          { label: 'Drawer variance', num: true, get: (w) => signed(w.variance) },
          { label: 'To answer', num: true, get: (w) => (w.open ? h('span.sh-chip.short', String(w.open)) : h('span.sh-chip.ok', '✓')) },
        ], weeks)) : null,
      cardBars([...data.days].sort((a, b) => (a.day < b.day ? -1 : 1))));
  }

  // ------------------------------------------------------------- shift --

  function shiftView(v) {
    const s = byId.get(currentId) || shifts[shifts.length - 1];
    const i = shifts.indexOf(s);
    // The closing report from HIVE, read on its own so the drawer shows at once.
    const report = h('div');
    till.shiftReport(s.day, s.slot, () => load()).then((card) => mount(report, card)).catch(() => {});
    const back = h('button.sh-back', { type: 'button', onclick: () => go(mode) }, `‹ Back to ${period.label}`);
    const head = h('section.card',
      h('div.sh-shifthead',
        h('button.sh-arrow', { type: 'button', disabled: i <= 0, 'aria-label': 'Previous shift', onclick: () => go('shift', shifts[i - 1].id) }, '‹'),
        h('div.t', avatar(s.user, true),
          h('div', h('h2', nameOf(s.user)),
            h('div.m', glyph(s.slot), `${SLOT[s.slot].label} · ${SLOT[s.slot].hours} · ${dayText(s.day, { weekday: 'long', day: 'numeric', month: 'long' })}`,
              s.double ? h('span.sh-chip.none', 'covered two slots') : null))),
        h(`span.sh-status.${tone(s)}`, { good: '✓ All agrees', warn: '! Have a look', bad: '! Needs an answer', open: 'Journal ends here' }[tone(s)]),
        h('button.sh-arrow', { type: 'button', disabled: i >= shifts.length - 1, 'aria-label': 'Next shift', onclick: () => go('shift', shifts[i + 1].id) }, '›')));
    // Without the amounts, the drawer's story is nothing but blanks: the
    // closing report and what does not agree are what there is to see.
    if (!may('money')) {
      mount(v, back, head, report,
        exceptionsBlock(s));
      return;
    }
    const status = h('span');
    const fall = h('div.sh-fall');
    const vbox = h('div');
    const checksList = h('ul.sh-checks');
    const unsaved = h('span.sh-unsaved');
    const said = h('span.small');
    const r = s.register || {};
    const draft = drafts[s.id] || (drafts[s.id] = {});

    const recount = h('input', {
      id: 'sh-recount', type: 'number', inputmode: 'decimal', step: '0.01', min: '0', disabled: s.open,
      placeholder: s.closing?.total != null ? cedis(s.closing.total) : '0.00',
      value: draft.recount !== undefined ? cedis(draft.recount) : (r.closingFrom === 'typed' ? cedis(r.closing) : ''),
    });
    const needOpening = r.openingFrom == null || r.openingFrom === 'typed';
    const opening = needOpening ? h('input', {
      id: 'sh-opening', type: 'number', inputmode: 'decimal', step: '0.01', min: '0', placeholder: 'only if ASSD has none',
      value: r.openingFrom === 'typed' ? cedis(r.opening) : '',
    }) : null;
    recount.addEventListener('input', () => { draft.recount = typedMinor(recount.value); redraw(); });

    async function save() {
      said.textContent = 'Saving…';
      try {
        await api('/shifts/count', { method: 'POST', body: { day: s.day, slot: s.slot, closing: recount.value, opening: opening ? opening.value : null, note: r.note || '' } });
        delete drafts[s.id];
        await load(banner('good', `Saved for ${nameOf(s.user)}’s ${SLOT[s.slot].label.toLowerCase()} shift of ${shortDay(s.day)}.`));
      } catch (err) { said.textContent = err.message; }
    }

    // Here the status moves as a recount is typed.
    head.querySelector('.sh-status').replaceWith(status);
    mount(v,
      back,
      head,
      report,
      h('div.sh-two',
        h('section.card',
          h('div.sh-cardhead', h('div', h('h2', 'The drawer'),
            h('p.sh-sub', 'Notes and coins, from ASSD’s count at hand-over to its count at the end. Receipts in the counts are expenses, not cash. Type a recount of the notes and coins and the picture moves; Save keeps it.'))),
          fall, vbox,
          h('div.sh-inputs',
            h('label.field', { for: 'sh-recount' }, 'Recount the notes and coins (optional)', recount),
            opening ? h('label.field', { for: 'sh-opening' }, 'Opening count', opening) : null),
          h('div.sh-save', h('button.btn.primary', { type: 'button', onclick: save, disabled: s.open }, 'Save'), unsaved, said)),
        h('section.card',
          h('div.sh-cardhead', h('div', h('h2', 'How it was paid'),
            h('p.sh-sub', 'Every payment in the shift, by the method ASSD recorded. Only cash goes in the drawer.'))),
          modesBlock(s),
          checksList)),
      h('section.card',
        h('div.sh-cardhead',
          h('div', h('h2', 'Card and MoMo, on the clock'),
            h('p.sh-sub', 'Each dot is a payment that arrived, at the time the terminal or MoMo took it. The shaded band is the shift’s hours; ninety minutes either side still counts. Tap a dot for the details.')),
          h('div.sh-legend',
            h('span', h('i', { style: 'background:var(--sh-card);border-radius:50%' }), 'Card'),
            h('span', h('i', { style: 'background:var(--sh-safe);border-radius:50%' }), 'MoMo'),
            h('span', h('i', { style: 'background:var(--surface);border:2px dashed var(--sh-bad);border-radius:50%' }), 'Declined'),
            h('span', h('i', { style: 'background:var(--surface);box-shadow:0 0 0 2px var(--sh-bad);border-radius:50%' }), 'Needs an answer'))),
        timeline(s)),
      h('section.card',
        h('div.sh-cardhead', h('div', h('h2', 'Where the cash went'),
          h('p.sh-sub', 'Each Cash Movement out of the front drawer, labelled by the Money Count done just before it.'))),
        movesBlock(s),
        odooBlock(s)),
      exceptionsBlock(s));
    redraw();

    function redraw() {
      const n = numbers(s);
      const dirty = draft.recount !== undefined && draft.recount !== (r.closingFrom === 'typed' ? r.closing : null);
      unsaved.textContent = dirty ? 'Not saved yet' : '';
      const t = tone(s);
      mount(status, h(`span.sh-status.${t}`, { good: '✓ All agrees', warn: '! Have a look', bad: '! Needs an answer', open: 'Journal ends here' }[t]));

      // Notes and coins only: receipts in a count are not cash. Those that
      // appeared on this shift are its expenses.
      const rc = r.receipts || {};
      const steps = [{ lab: 'Opening notes and coins', sm: r.openingFrom === 'typed' ? 'typed' : r.openingFrom === 'carried' ? 'last shift’s closing' : 'ASSD, at hand-over', from: 0, to: r.opening ?? 0, c: 'var(--muted)', amt: money(r.opening) }];
      let at = (r.opening ?? 0) + s.cash;
      steps.push({ lab: '+ Cash taken', sm: s.laundryCash ? `incl. ${money(s.laundryCash)} laundry` : '', from: r.opening ?? 0, to: at, c: 'var(--sh-cash)', amt: money(s.cash) });
      if (r.putBack) { steps.push({ lab: '+ Put back', sm: 'a movement the other way', from: at, to: at + r.putBack, c: 'var(--sh-cash)', amt: money(r.putBack) }); at += r.putBack; }
      if (rc.reconciled?.amount) { steps.push({ lab: '+ Cash for receipts', sm: 'receipts swapped for cash, reconciled', from: at, to: at + rc.reconciled.amount, c: 'var(--sh-cash)', amt: money(rc.reconciled.amount) }); at += rc.reconciled.amount; }
      if (n.expenses) {
        const words = [rc.in ? 'new receipts in the counts' : '', rc.direct ? 'paid straight out' : '', r.fromSheet ? 'from the closing report' : ''].filter(Boolean).join(', ');
        steps.push({ lab: '− Expenses', sm: words || 'receipts in the counts', from: at - n.expenses, to: at, c: 'var(--sh-expense)', amt: money(n.expenses) }); at -= n.expenses;
      }
      if (n.toSafe) { steps.push({ lab: '− Cash to the safe', sm: s.corrected ? 'notes, as corrected' : 'notes only', from: at - n.toSafe, to: at, c: 'var(--sh-safe)', amt: money(n.toSafe) }); at -= n.toSafe; }
      if (n.unlabelled) { steps.push({ lab: '− Not labelled', sm: 'say what it was below', from: at - n.unlabelled, to: at, c: 'var(--muted)', hatch: true, amt: money(n.unlabelled) }); at -= n.unlabelled; }
      steps.push({ lab: '= Should hold', from: 0, to: r.expected ?? 0, c: 'var(--ink-2)', amt: money(r.expected), total: true });
      steps.push({
        lab: 'Closing notes and coins',
        sm: n.recounted ? 'your recount' : n.closing == null ? 'not in the journal' : 'ASSD, at the end',
        from: 0, to: n.closing ?? 0, total: true, amt: money(n.closing),
        c: n.variance == null ? 'var(--muted)' : n.variance === 0 ? 'var(--sh-good)' : n.variance > 0 ? 'var(--sh-warn)' : 'var(--sh-bad)',
      });
      // One scale for every bar, from the lowest point to the highest. The
      // lowest is below nothing when more left the drawer than was in it:
      // then nought sits part-way along, marked, and the bars stay inside
      // their track rather than running out over the labels.
      const top = Math.max(1, ...steps.map((x) => Math.max(x.from, x.to)));
      const low = Math.min(0, ...steps.map((x) => Math.min(x.from, x.to)));
      const span = top - low;
      const pos = (value) => ((value - low) / span) * 100;
      mount(fall, steps.map((x) => h(`div.sh-frow${x.total ? '.total' : ''}`,
        h('span.lab', x.lab, x.sm ? h('small', x.sm) : null),
        h('span.sh-track',
          low < 0 ? h('i.sh-zero', { style: `left:${pos(0)}%`, title: 'Nothing' }) : null,
          h(`b.sh-seg${x.hatch ? '.hatch' : ''}`, {
            style: `left:${pos(Math.min(x.from, x.to))}%;width:${(Math.abs(x.to - x.from) / span) * 100}%;background:${x.c}`,
          })),
        h('span.amt.num', x.amt))));

      const cls = n.variance == null ? 'none' : n.variance === 0 ? 'ok' : n.variance > 0 ? 'over' : 'short';
      mount(vbox, h(`div.sh-vbox.${cls}`,
        h('div.big.num', n.variance == null ? 'No closing count' : n.variance === 0 ? '✓ The drawer agrees' : `${n.variance > 0 ? 'Over' : 'Short'} ${money(Math.abs(n.variance))}`),
        h('p', n.variance == null
          ? (s.open ? 'The journal stops inside this shift. Load a journal that runs a day past it.' : 'ASSD has no closing count for this shift. Type a recount to check it.')
          : n.variance === 0 ? 'What should be in the drawer is exactly what was counted.'
            : `It should have held ${money(r.expected)}; ${n.recounted ? 'the recount' : 'ASSD counted'} ${money(n.closing)}.${!n.recounted && r.assdVariance === n.variance ? ' ASSD booked the same difference itself.' : ''}`),
        r.corrected && r.assdVariance !== n.variance ? h('p', `ASSD booked ${signed(r.assdVariance)} before the corrections to its cash movements.`) : null,
        r.handoverGap ? h('p', `This shift’s first count was ${money(Math.abs(r.handoverGap.amount))} ${r.handoverGap.amount < 0 ? 'less' : 'more'} than ${nameOf(r.handoverGap.from)}’s closing count.`) : null),
        receiptsPanel(r));

      mount(checksList, checks(s, n).map(([cls_, mark, text, detail]) => (detail
        ? h('li.sh-hasdetail', h('details',
          h('summary', h(`span.sh-ic.${cls_}`, String(mark)), h('span', text), h('span.sh-more', 'Details')),
          detail))
        : h('li', h(`span.sh-ic.${cls_}`, String(mark)), h('span', text)))));
    }
  }

  /** The receipts in the counts: at hand-over, at the end, out, and what is new. */
  function receiptsPanel(r) {
    const rc = r.receipts || {};
    if (!rc.open && !rc.close && !rc.in && !rc.out) return null;
    const row = (label, value, strong = false) => h(`div.sh-rrow${strong ? '.strong' : ''}`, h('span', label), h('b.num', money(value)));
    return h('div.sh-receipts',
      row('Receipts in the drawer at hand-over', rc.open ?? 0),
      row('Receipts in the drawer at the end', rc.close ?? 0),
      rc.moved ? row('Receipts taken out with a cash movement', rc.moved) : null,
      rc.swapped > 0 ? row('Receipts taken out with no movement (swapped for cash)', rc.swapped) : null,
      row('New receipts: this shift’s expenses', rc.in ?? 0, true));
  }

  function modesBlock(s) {
    const m = modesOf(s);
    const items = MODES.filter(([k]) => m[k] > 0);
    const total = items.reduce((t, [k]) => t + m[k], 0);
    if (!total) return h('p.sh-sub', 'Nothing was taken on this shift.');
    return [
      h('div.sh-stack', items.map(([k, label, c]) => h('b', { style: `flex-grow:${m[k]};background:${c}`, title: `${label} ${money(m[k])}` }))),
      h('div.sh-modes',
        items.map(([k, label, c]) => h('div.sh-mode', h('i', { style: `background:${c}` }),
          h('span', label, ' ', h('small', `${Math.round((m[k] / total) * 100)}%`)), h('b.num', money(m[k])))),
        h('div.sh-mode', { style: 'border-top:1px solid var(--border);padding-top:.35rem' }, h('i'), h('b', 'Everything taken'), h('b.num', money(total)))),
    ];
  }

  function checks(s, n) {
    const out = [];
    if (n.variance == null) out.push(['info', 'i', s.open ? 'No closing count yet: the journal ends inside this shift' : 'No closing count in ASSD']);
    else if (n.variance === 0) out.push(['good', '✓', 'The drawer agrees with the closing count', drawerDetail(s, n)]);
    else out.push([n.variance < 0 ? 'bad' : 'warn', '!', `Drawer ${n.variance > 0 ? 'over' : 'short'} by ${money(Math.abs(n.variance))}`, drawerDetail(s, n)]);
    const allCard = s.cardFound + (s.cardAnswered || 0) === s.cardLines;
    if (!s.cardLines) out.push(['info', '·', 'No card or MoMo this shift', s.lines.some((l) => l.how === 'corrected') ? cardDetail(s) : null]);
    else out.push([allCard ? 'good' : 'bad', allCard ? '✓' : '!', cardText(s, ' payments'), cardDetail(s)]);
    const exp = s.expense;
    if (exp?.sheetTotal != null || n.expenses) {
      // Agrees when what left the drawer is what Odoo approved, and every PO
      // is on the expense form (once the form is connected).
      // The expenses as ASSD's counts show them, held against the POs.
      const paid = n.expenses ?? exp?.sheetTotal;
      const orders = (exp?.odoo?.orders || []).filter((o) => !o.kind);
      const onForm = orders.filter((o) => o.reported).length;
      const sameAmount = exp?.odooTotal != null && Math.round(paid) === Math.round(exp.odooTotal);
      const approved = orders.every((o) => o.state === 'purchase' || o.state === 'done');
      const allOnForm = !data.formLive || onForm === orders.length;
      const agree = orders.length > 0 && sameAmount && approved && allOnForm;
      const form = data.formLive && orders.length ? ` · ${onForm} of ${orders.length} on the expense form` : '';
      // Expenses with no PO at all are flagged, never left grey.
      const noPo = !orders.length && !exp?.poNumbers;
      out.push([agree ? 'good' : exp?.odooTotal != null || noPo ? 'warn' : 'info', agree ? '✓' : exp?.odooTotal != null || noPo ? '!' : 'i',
        `Expenses ${money(paid)}${exp?.odooTotal != null ? ` · Odoo ${money(exp.odooTotal)}` : exp?.poNumbers ? ' · Odoo not read yet' : ' · no PO numbers yet'}${form}`,
        expenseDetail(s, n)]);
    }
    if (n.sheetGap) {
      out.push(['warn', '!', `The ${exp?.sheetFrom === 'report' ? 'closing report' : 'expense sheet'} says ${money(n.sheet)} was spent; ASSD’s counts show ${money(n.expenses)} of expenses. Link the missing PO, or check the counts.`]);
    }
    const rcp = s.register?.receipts;
    if (rcp?.reconciled?.amount) out.push(['good', '✓', `${money(rcp.reconciled.amount)} of receipts swapped for cash, reconciled${rcp.reconciled.by ? ` (${rcp.reconciled.by})` : ''}`]);
    // Movements somebody matched or labelled: settled, so said plainly and green.
    for (const m of (s.moves || []).filter((x) => x.manual)) {
      const by = m.manual.by ? ` (${m.manual.by})` : '';
      const text = m.kind === 'excluded'
        ? { duplicate: `ASSD ${m.seq} matched as a duplicate of ASSD ${m.pair}: left out of the drawer`,
          reverses: `ASSD ${m.seq} matched with ASSD ${m.pair}: one puts the other back, both left out`,
          'reversed-by': `ASSD ${m.seq} matched with ASSD ${m.pair}: one puts the other back, both left out` }[m.reason] || `ASSD ${m.seq} matched and left out of the drawer`
        : `ASSD ${m.seq} labelled by hand: ${{ expenses: 'expenses', safe: 'cash to the safe', split: `${money(m.expenses)} expenses, ${money(m.safe)} to the safe` }[m.kind] || m.kind}`;
      out.push(['good', '✓', `${text}${by}`]);
    }
    // The laundry, against the laundry system in this shift's hours.
    const ls = s.laundrySystem;
    if (ls) {
      if (s.laundry || ls.collected || ls.charged) {
        const agree = s.laundry === ls.collected;
        out.push([agree ? 'good' : 'warn', agree ? '✓' : '!',
          `Laundry: ${money(s.laundry)} in ASSD, ${money(ls.collected)} taken in the laundry system`
          + `${ls.charged ? ` (${money(ls.charged)} of new orders)` : ''}${agree ? '' : '. See the exceptions.'}`, laundryDetail(s)]);
      }
    } else if (s.laundry) {
      out.push(['info', 'i', `Laundry ${money(s.laundry)}${s.laundryCash ? `, ${money(s.laundryCash)} of it in cash` : ''}. The laundry system has not been read for this shift yet.`, laundryDetail(s)]);
    }
    for (const m of (s.moves || []).filter((x) => x.kind === 'corrected')) {
      out.push(['info', 'i', `${money(m.amount)} moved out by mistake and put back by ${nameOf(m.reversedByUser)}`]);
    }
    const open = exceptionsOf(s).filter((x) => !x.answer && x.severity !== 'info').length;
    if (open) out.push(['bad', open, `${open} difference${open === 1 ? '' : 's'} waiting for an answer`]);
    return out;
  }

  // ------------------------------------------- what each note was made of --

  /** A ✓ / ✗ / · mark for a line that agrees, does not, or has nothing to agree with. */
  const mark = (state) => h(`span.sh-lm.${state}`, { title: { ok: 'Agrees', bad: 'Does not agree', none: 'Nothing to match' }[state] },
    { ok: '✓', bad: '✗', none: '·' }[state]);
  const clock = (at) => (at ? String(at).slice(11, 16) : '');

  /** A table of lines: [mark, cells…]. */
  function lineTable(head, rows, foot = null) {
    return h('div.sh-dtable', h('table',
      h('thead', h('tr', h('th', ''), head.map((c) => h(c.num ? 'th.num' : 'th', c.label ?? c)))),
      h('tbody', rows.map((r) => h(`tr.${r.state}`, h('td', mark(r.state)), r.cells.map((c, i) => h(head[i]?.num ? 'td.num' : 'td', c))))),
      foot ? h('tfoot', h('tr', h('td', ''), foot.map((c, i) => h(head[i]?.num ? 'td.num' : 'td', c)))) : null));
  }

  /**
   * Pair two lists of amounts: equal amount to equal amount first, then one
   * line on the left against several on the right that add up to it (three
   * POs paid in one movement). What is left over on either side is what does
   * not agree.
   */
  function pairUp(left, right) {
    const used = new Set();
    const pairs = left.map((l) => {
      const i = right.findIndex((r, k) => !used.has(k) && r.amount === l.amount);
      if (i >= 0) used.add(i);
      return { l, r: i >= 0 ? [right[i]] : [] };
    });
    for (const p of pairs.filter((x) => !x.r.length)) {
      const free = right.map((r, k) => ({ r, k })).filter((x) => !used.has(x.k)).slice(0, 12);
      for (let mask = 1; mask < (1 << free.length); mask += 1) {
        const pick = free.filter((_, b) => mask & (1 << b));
        if (pick.length > 1 && pick.reduce((t, x) => t + x.r.amount, 0) === p.l.amount) {
          for (const x of pick) used.add(x.k);
          p.r = pick.map((x) => x.r);
          break;
        }
      }
    }
    return { pairs, spare: right.filter((_, k) => !used.has(k)) };
  }

  function drawerDetail(s, n) {
    const r = s.register || {};
    const moveText = (m) => {
      const parts = [m.receipts ? `${money(m.receipts)} receipts` : '', m.direct ? `${money(m.direct)} expenses` : '', m.safe ? `${money(m.safe)} to the safe` : ''].filter(Boolean);
      if (m.kind === 'part' || m.kind === 'unlabelled') parts.push(`${money(m.cash)} not labelled`);
      return ({ corrected: 'keyed by mistake, put back', returned: 'put back into the drawer', excluded: 'left out (matched)' })[m.kind] || parts.join(', ') || m.kind;
    };
    const rc = r.receipts || {};
    const rows = [
      { state: r.opening == null ? 'bad' : 'ok', cells: ['Opening notes and coins', r.openingFrom === 'typed' ? 'typed here' : r.openingFrom === 'carried' ? 'last shift’s closing' : `ASSD ${s.opening?.seq ?? ''}${s.opening?.receipts ? ` (and ${money(s.opening.receipts)} of receipts, not cash)` : ''}`, money(r.opening)] },
      ...(s.cashLines || []).map((c) => ({ state: 'ok', cells: [`+ ${c.kind}`, `ASSD ${c.seq} · ${nameOf(c.user)} · ${c.label}`, money(c.amount)] })),
      ...(rc.list || []).map((x) => ({ state: 'ok', cells: ['− New receipts', `in the count ASSD ${x.seq}: expenses`, money(-x.amount)] })),
      ...(s.moves || []).filter((m) => m.kind !== 'corrected' && m.kind !== 'excluded').map((m) => ({
        state: ['unlabelled', 'part'].includes(m.kind) ? 'bad' : 'ok',
        cells: ['− Cash movement', `ASSD ${m.seq} · ${moveText(m)}${m.receipts ? ' (receipts are not cash)' : ''}${m.manual ? ' (corrected by hand)' : ''}`, money(-(m.amount - (m.receipts || 0)))],
      })),
      rc.reconciled?.amount ? { state: 'ok', cells: ['+ Cash for receipts', `receipts swapped for cash, reconciled by ${rc.reconciled.by || 'somebody'}`, money(rc.reconciled.amount)] } : null,
      ...(s.moves || []).filter((m) => m.kind === 'corrected' || m.kind === 'excluded').map((m) => ({
        state: 'none', cells: ['Not counted', `ASSD ${m.seq} · ${moveText(m)}`, money(-m.amount)],
      })),
      { state: 'none', cells: [h('b', '= Should hold'), '', h('b', money(r.expected))] },
      { state: n.variance == null ? 'bad' : n.variance === 0 ? 'ok' : 'bad', cells: [h('b', 'Closing notes and coins'), n.recounted ? 'your recount' : `ASSD ${s.closing?.seq ?? ''}${s.closing?.receipts ? ` (and ${money(s.closing.receipts)} of receipts, not cash)` : ''}`, h('b', money(n.closing))] },
    ].filter(Boolean);
    return h('div.sh-detail',
      lineTable([{ label: 'Line' }, { label: 'From' }, { label: 'Amount', num: true }], rows),
      h('p.small', n.variance == null ? 'No closing count to hold it against.' : n.variance === 0 ? '✓ The count matches what should be there.'
        : `✗ ${n.variance > 0 ? 'Over' : 'Short'} by ${money(Math.abs(n.variance))}. ${(s.moves || []).some((m) => ['unlabelled', 'part'].includes(m.kind)) ? 'The lines marked ✗ are movements nobody labelled.' : ''}`));
  }

  function cardDetail(s) {
    const howText = { exact: 'same amount, in the shift', late: 'same amount, just outside the shift', together: 'one payment for several ASSD lines', parts: 'paid in parts', corrected: 'keyed and reversed', regrouped: 'same money, split differently' };
    const event = (e) => `${e.kind === 'momo' ? 'MoMo' : `Card${e.last4 ? ` …${e.last4}` : ''}`} · ${e.at ? clock(e.at) : shortDay(e.day)}${e.approval ? ` · appr. ${e.approval}` : ''} · ${e.source === 'bank' ? 'bank' : 'terminal'}`;
    const rows = s.lines.filter((l) => l.amount > 0 || (data.redacted && l.amount == null)).map((l) => {
      if (l.how === 'corrected') {
        const back = exceptionsOf(s).find((o) => o.kind === 'corrected' && o.pair === l.seq);
        return { state: 'none', cells: [`ASSD ${l.seq}`, money(l.amount), h('span.muted', `Keyed and reversed${back ? ` (ASSD ${back.seq})` : ''}. Nothing taken, not counted.`)] };
      }
      const found = l.events || [];
      const got = found.reduce((t, e) => t + e.amount, 0);
      const x = exceptionsOf(s).find((o) => o.seq === l.seq && o.amount === l.amount && o.event);
      const said = !found.length && exceptionsOf(s).find((o) => o.seq === l.seq && o.amount === l.amount && o.answer);
      const state = found.length ? (got === l.amount || l.how === 'together' || l.how === 'regrouped' ? 'ok' : 'bad') : said ? 'ok' : 'bad';
      return {
        state,
        cells: [
          `ASSD ${l.seq}`,
          money(l.amount),
          found.length ? h('span', found.map((e) => h('div', `${event(e)} · ${money(e.amount)}`)), h('small', howText[l.how] || l.how || ''))
            : h('span',
              x ? h('div', `Nearest: ${event(x.event)} · ${money(x.event.amount)}`) : h('div.muted', 'Nothing found near the shift'),
              said ? h('small', `Answered: ${said.answer.answer}${said.answer.by ? ` (${said.answer.by})` : ''}`) : x ? h('small', (KIND[x.kind] || [x.kind])[0]) : null),
        ],
      };
    });
    const extra = exceptionsOf(s).filter((x) => ['not-recorded', 'bank-only', 'double-charge'].includes(x.kind) && x.event);
    for (const x of extra) rows.push({ state: 'bad', cells: ['Not in ASSD', '—', h('span', h('div', `${event(x.event)} · ${money(x.event.amount)}`), h('small', (KIND[x.kind] || [x.kind])[0]))] });
    return h('div.sh-detail', lineTable([{ label: 'ASSD line' }, { label: 'ASSD', num: true }, { label: 'Matched to' }], rows));
  }

  function expenseDetail(s, n) {
    const exp = s.expense || {};
    // A movement another was matched to as its duplicate says so, so the one left is not taken for a stray.
    const twinOf = (seq) => (s.moves || []).find((x) => x.kind === 'excluded' && x.reason === 'duplicate' && x.pair === seq);
    // The expenses: receipts as they appeared in the counts, and cash a
    // movement paid straight out.
    const moves = [
      ...((s.register?.receipts?.list) || []).map((x) => ({ label: h('span', `New receipts in the count ASSD ${x.seq}`), amount: x.amount })),
      ...(s.moves || []).filter((m) => m.direct > 0).map((m) => ({
        label: h('span', `ASSD ${m.seq}, paid straight out`,
          twinOf(m.seq) ? h('small', `✓ ASSD ${twinOf(m.seq).seq} matched as its duplicate, left out`) : null),
        amount: m.direct,
      })),
    ];
    // What the typed expense sheet settled on top of what the counts labelled.
    const fromSheet = (n.expenses || 0) - moves.reduce((t, m) => t + m.amount, 0);
    if (fromSheet > 0) moves.push({ label: exp.sheetFrom === 'report' ? 'From the closing report (unlabelled cash)' : 'From the expense sheet (unlabelled cash)', amount: fromSheet });
    const confirmed = (o) => o.state === 'purchase' || o.state === 'done';
    const formWord = (o) => (o.kind || !data.formLive ? '' : o.reported ? ' · on the form ✓' : ' · not on the form');
    const po = (o) => `${o.name}${o.kind === 'topup' ? ' (deficit)' : o.kind === 'change' ? ' (refund)' : o.advance ? ' (advance)' : ''} · ${o.vendor || ''} · ${confirmed(o) ? 'approved' : o.state}${formWord(o)}`;
    const orders = (exp.odoo?.orders || []).map((o) => ({ ...o, amount: o.total }));
    const { pairs, spare } = pairUp(moves, orders);
    const rows = [
      ...pairs.map(({ l, r }) => ({
        state: r.length ? (r.every(confirmed) ? 'ok' : 'bad') : (orders.length ? 'bad' : 'none'),
        cells: [l.label, money(l.amount),
          r.length ? h('span', r.map((o) => h('div', po(o))), r.length > 1 ? h('small', 'several POs, one payment') : null, r.some((o) => !confirmed(o)) ? h('small', 'not approved in Odoo, so not counted') : null)
            : (orders.length ? 'No PO of this amount' : 'No PO numbers yet'),
          r.length ? money(r.reduce((t, o) => t + o.total, 0)) : '—'],
      })),
      ...spare.map((o) => ({ state: 'bad', cells: ['No payment of this amount', '—', h('span', po(o), !confirmed(o) ? h('small', 'not approved in Odoo') : null), money(o.total)] })),
    ];
    const unknown = exp.odoo?.unknown || [];
    return h('div.sh-detail',
      lineTable([{ label: 'Expenses' }, { label: 'Amount', num: true }, { label: 'Odoo PO' }, { label: 'PO total', num: true }], rows,
        ['Total', money(n.expenses), exp.sheetTotal != null ? `${exp.sheetFrom === 'report' ? 'Closing report' : 'Expense sheet'} ${money(exp.sheetTotal)}` : '', exp.odooTotal != null ? money(exp.odooTotal) : '—']),
      unknown.length ? h('p.small', `✗ Not in Odoo: ${unknown.join(', ')}`) : null,
      n.expenses > 0 ? poLinker(s) : null);
  }

  /**
   * Link POs to this shift's expenses, for cash no closing report gave a PO
   * for: typed the way staff write them (4123, P04123), read from Odoo at
   * once and paired with the movements by amount. Each linked one can be
   * unlinked.
   */
  function poLinker(s) {
    if (!canFix) return null;
    const exp = s.expense || {};
    const fromReport = new Set((exp.fromReport || []).map((x) => String(x).toUpperCase()));
    const linked = String(exp.poNumbers || '').split(/[\s,;]+/).filter(Boolean).filter((x) => !fromReport.has(x.toUpperCase()));
    const typed = h('input', { type: 'text', maxlength: '200', placeholder: 'PO numbers, e.g. 4123, 4124', 'aria-label': 'PO numbers to link' });
    const said = h('span.small');
    const send = async (body, button) => {
      if (button) button.disabled = true;
      said.textContent = 'Reading Odoo…'; said.className = 'small';
      try {
        const out = await api('/shifts/expense/link', { method: 'POST', body: { day: s.day, slot: s.slot, ...body } });
        await load(banner(out.warning ? 'warning' : 'good', out.warning ? `Linked. Odoo could not be read just now: ${out.warning}`
          : out.unknown?.length ? `Linked. Odoo does not know ${out.unknown.join(', ')}.` : body.remove ? `Unlinked ${body.remove}.` : 'Linked and read from Odoo.'));
      } catch (err) { said.textContent = err.message; said.className = 'small form-error'; if (button) button.disabled = false; }
    };
    return h('div.sh-polink',
      h('b', 'Link POs to these expenses'),
      linked.length ? h('div.sh-polinked', linked.map((po) => h('span.sh-chip.none', po,
        h('button.sh-link', { type: 'button', 'aria-label': `Unlink ${po}`, title: 'Unlink', onclick: (e) => send({ remove: po }, e.target) }, '×')))) : null,
      h('div.sh-fixrow', typed, h('button.btn', { type: 'button', onclick: (e) => send({ add: typed.value }, e.target) }, 'Link'), said),
      h('small.muted', 'For expenses no closing report gave a PO for. Each is matched to the expense payments by amount.'));
  }

  function laundryDetail(s) {
    const ls = s.laundrySystem;
    const assd = (s.laundryLines || []).map((l) => ({ ...l }));
    const pays = (ls?.list || []).filter((t) => t.kind === 'payment').sort((a, b) => (a.at < b.at ? -1 : 1));
    if (!ls) {
      return h('div.sh-detail', lineTable([{ label: 'ASSD line' }, { label: 'Paid' }, { label: 'Amount', num: true }],
        assd.map((l) => ({ state: 'none', cells: [`ASSD ${l.seq} · ${nameOf(l.user)}`, l.paid, money(l.amount)] }))),
      h('p.small.muted', 'Nothing to hold these against until the laundry system has been read for the whole shift.'));
    }
    const { pairs, spare } = pairUp(assd, pays);
    const rows = [
      ...pairs.map(({ l, r }) => ({
        state: r.length ? 'ok' : 'bad',
        cells: [`ASSD ${l.seq} · ${l.paid}`, money(l.amount),
          r.length ? h('span', r.map((t) => h('div', `Order ${t.ref} · ${clock(t.at)} · ${t.method || ''} · ${money(t.amount)}`))) : 'No laundry payment of this amount',
          r.length ? money(r.reduce((t, x) => t + x.amount, 0)) : '—'],
      })),
      ...spare.map((r) => ({ state: 'bad', cells: ['Not in ASSD', '—', `Order ${r.ref} · ${clock(r.at)} · ${r.method || ''}`, money(r.amount)] })),
    ];
    return h('div.sh-detail',
      lineTable([{ label: 'ASSD' }, { label: 'Amount', num: true }, { label: 'Laundry system payment' }, { label: 'Amount', num: true }], rows,
        ['Total', money(s.laundry), `${ls.payments} payment${ls.payments === 1 ? '' : 's'}`, money(ls.collected)]),
      ls.orders ? h('p.small.muted', `The laundry system also accepted ${ls.orders} order${ls.orders === 1 ? '' : 's'} worth ${money(ls.charged)} in these hours.`) : null);
  }

  function timeline(s) {
    const start = SLOT[s.slot].start;
    const base = Date.parse(`${s.day}T00:00:00Z`) + (start * 60 - 120) * 60000;
    const span = 12 * 60 * 60000;
    const pos = (at) => ((Date.parse(`${String(at).replace(' ', 'T')}Z`) - base) / span) * 100;
    const dots = [];
    for (const l of s.lines) for (const e of l.events) dots.push({ ...e, seq: l.seq, how: l.how, flagged: Boolean(l.exception) });
    for (const x of exceptionsOf(s)) {
      if (x.event?.at && !dots.some((d) => d.at === x.event.at && d.amount === x.event.amount)) {
        dots.push({ ...x.event, seq: x.seq, flagged: true, declined: x.kind === 'failed' });
      }
    }
    const placed = dots.filter((d) => d.at).map((d) => ({ ...d, p: pos(d.at) })).sort((a, b) => a.p - b.p);
    // Dots closer than a dot's width go up or down a level, so none hides another.
    const lastAt = [-10, -10, -10];
    for (const d of placed) {
      const level = [0, 1, 2].find((lv) => d.p - lastAt[lv] >= 3.2) ?? 0;
      d.level = level;
      lastAt[level] = d.p;
    }
    const inside = placed.filter((d) => d.p >= -2 && d.p <= 102);
    const outside = placed.filter((d) => d.p < -2 || d.p > 102);
    const unmatched = s.lines.filter((l) => l.amount > 0 && !l.events.length);
    const tip = h('div.sh-tip', { hidden: true });
    const track = h('div.sh-tl',
      h('div.band'),
      h('div.core', { style: `left:${(120 / 720) * 100}%;width:${(480 / 720) * 100}%` }),
      Array.from({ length: 7 }, (_, k) => h('span.tick', { style: `left:${(k / 6) * 100}%` },
        `${String((start - 2 + k * 2 + 24) % 24).padStart(2, '0')}:00`)),
      inside.map((d) => {
        const text = `${d.declined ? 'Declined' : d.kind === 'momo' ? 'MoMo' : 'Card'} ${money(d.amount)} at ${time(d.at)}`
          + `${d.last4 ? ` · card …${d.last4}` : ''}${d.seq ? ` · ASSD ${d.seq}` : ''}`
          + `${d.how && d.how !== 'exact' ? ` · ${{ late: 'just outside the hours', together: 'paid together', parts: 'paid in parts', regrouped: 'split differently', 'by-day': 'by day' }[d.how] || d.how}` : ''}`
          + `${d.flagged ? ' · see below' : ''}`;
        const left = Math.max(1, Math.min(99, d.p));
        const dot = h(`button.sh-dot.${d.declined ? 'decl' : d.kind === 'momo' ? 'momo' : 'card'}${d.flagged && !d.declined ? '.flag' : ''}${d.level ? `.l${d.level}` : ''}`, {
          type: 'button', style: `left:${left}%`, 'aria-label': text,
        }, d.declined ? '×' : '');
        const show = () => { tip.textContent = text; tip.style.left = `${left}%`; tip.style.top = `${[34, 6, 62][d.level] - 6}px`; tip.hidden = false; };
        const hide = () => { tip.hidden = true; };
        dot.addEventListener('mouseenter', show);
        dot.addEventListener('focus', show);
        dot.addEventListener('click', show);
        dot.addEventListener('mouseleave', hide);
        dot.addEventListener('blur', hide);
        return dot;
      }),
      tip);
    return [
      h('div', { style: 'overflow-x:auto' }, h('div', { style: 'min-width:520px;padding:0 22px' }, track)),
      h('div.sh-pills',
        unmatched.map((l) => h('span.sh-pill.bad', `No payment found · ${money(l.amount)} · ASSD ${l.seq}`)),
        outside.map((d) => h('span.sh-pill', `${d.declined ? 'Declined' : 'Paid'} ${money(d.amount)} on ${when(d.at)} · outside this shift`)),
        !unmatched.length && !outside.length && placed.length ? h('span.sh-pill.good', '✓ Every card and MoMo payment is on the clock') : null,
        !placed.length && !unmatched.length ? h('span.sh-pill', 'No card or MoMo on this shift') : null),
    ];
  }

  function movesBlock(s) {
    const moves = s.moves || [];
    if (!moves.length) return h('p.sh-sub', 'Nothing was moved out of the drawer on this shift.');
    const tag = {
      expenses: ['Expenses', 'var(--sh-expense)'], safe: ['To the safe', 'var(--sh-safe)'], split: ['Receipts + safe', 'var(--series-7)'],
      part: ['Part labelled', 'var(--muted)'], unlabelled: ['Not labelled', 'var(--muted)'], corrected: ['Put back', 'var(--sh-bad)'],
      returned: ['Put back', 'var(--sh-good)'], excluded: ['Matched', 'var(--ink-2)'],
    };
    const where = (p) => (p ? ` on ${nameOf(p.user)}’s ${SLOT[p.slot]?.label.toLowerCase() || ''} shift of ${shortDay(p.day)}` : ' outside these days');
    const said = (m) => {
      if (m.kind === 'excluded') {
        return {
          duplicate: `A duplicate of ASSD ${m.pair}: it never moved any cash, so it is left out of the drawer.`,
          reverses: `Puts back ASSD ${m.pair}${where(m.pairShift)}. Neither moved cash, so both are left out.`,
          'reversed-by': `Put back by ASSD ${m.pair}${where(m.pairShift)}. Neither moved cash, so both are left out.`,
        }[m.reason] || 'Left out of the drawer.';
      }
      // Receipts carried out are not cash: they were expenses when they
      // appeared in a count. A correction says what the cash part was.
      const rec = m.receipts ? `${money(m.receipts)} of receipts to the back office` : '';
      const base = {
        expenses: m.manual ? [rec, `${money(m.direct)} expenses paid straight out, as corrected`].filter(Boolean).join('; ') + '.'
          : 'Receipts to the back office: expenses already, when they appeared in the count. No cash.',
        safe: m.manual ? [rec, `${money(m.safe)} of notes to the safe, as corrected`].filter(Boolean).join('; ') + '.' : 'Notes to the safe, as the count before it.',
        split: m.manual ? [rec, `${money(m.direct)} expenses and ${money(m.safe)} to the safe, as corrected`].filter(Boolean).join('; ') + '.'
          : `${money(m.receipts)} of receipts to the back office and ${money(m.safe)} of notes to the safe, as counted just before.`,
        part: `${money(m.receipts)} of receipts as counted; the other ${money(m.cash)} has no count to say what it was.`,
        unlabelled: 'No count before it said what it was. Say what it was here, or the closing report settles it.',
        corrected: `Keyed by mistake and put back by ${nameOf(m.reversedByUser)} (ASSD ${m.reversedBy}) on the same shift. It nets to nothing.`,
        returned: 'Money put back into the drawer. If it undoes a movement on another shift, match them.',
      }[m.kind] || '';
      return base;
    };
    return h('div.sh-moves', moves.map((m) => {
      const fix = h('div.sh-fix', { hidden: true });
      const open = () => { fix.hidden = !fix.hidden; if (!fix.hidden && !fix.firstChild) mount(fix, fixer(s, m)); };
      return h('div',
        h('div.sh-move',
          h('span.tag', { style: `background:${tag[m.kind]?.[1] || 'var(--muted)'}` }, tag[m.kind]?.[0] || m.kind),
          h('span',
            h('small', `${said(m)} · ${nameOf(m.user)}, ASSD ${m.seq}`),
            m.manual ? h('small.sh-manual', ` Corrected by ${m.manual.by || 'somebody'}${m.manual.note ? `: ${m.manual.note}` : ''}${m.auto ? ` (ASSD's count said ${tag[m.auto]?.[0].toLowerCase() || m.auto})` : ''}.`) : null,
            m.pending ? h('small.sh-manual', ` Waiting for an admin: ${m.pending.by || 'a supervisor'} says ${({ expenses: 'it was expenses', safe: 'it went to the safe', split: 'it was split', duplicate: `it duplicates ASSD ${m.pending.pair}`, reverses: `it pairs with ASSD ${m.pending.pair}` })[m.pending.kind] || m.pending.kind}.`) : null),
          h('span.sh-moveend',
            h('span.amt.num', ['corrected', 'excluded'].includes(m.kind) ? h('s', money(Math.abs(m.amount))) : m.amount < 0 ? `+${money(-m.amount)}` : money(m.amount)),
            m.kind === 'corrected' || !canFix || (!admin && m.manual) ? null : h('button.sh-link', { type: 'button', onclick: open }, m.pending ? 'Change' : 'Correct'))),
        fix);
    }));
  }

  /**
   * The ways a movement can be put right, for the one movement chosen.
   *
   * Out of the drawer: what it really was (expenses, safe, or a split), a
   * duplicate of another on the same shift, or put back on another shift.
   * Into the drawer: the movement on another shift it puts back. A movement
   * already corrected can be put back to how ASSD had it.
   */
  function fixer(s, m) {
    const note = h('input', { type: 'text', maxlength: '400', placeholder: 'Why (optional)', value: m.manual?.note || '' });
    const said = h('span.small');
    const pos = h('input', { type: 'text', maxlength: '200', placeholder: 'PO numbers (optional)', 'aria-label': 'PO numbers for these expenses' });
    const send = async (body) => {
      said.textContent = 'Saving…';
      try {
        const out = await api('/shifts/movement', { method: 'POST', body: { seq: m.seq, note: note.value, ...body } });
        // POs typed with Expenses are linked to the shift's expenses.
        if (['expenses', 'split'].includes(body.kind) && pos.value.trim()) {
          await api('/shifts/expense/link', { method: 'POST', body: { day: s.day, slot: s.slot, add: pos.value } });
        }
        await load(banner('good', out?.pending
          ? 'Sent to an admin. It counts once they approve it, and they have been told.'
          : 'Movement corrected. The drawer and its exceptions are worked out again.'));
      } catch (err) { said.textContent = err.message; }
    };
    const choice = (label, body, primary = false) => h(`button.btn${primary ? '.primary' : ''}`, { type: 'button', onclick: () => send(body) }, label);
    const pick = (label, options, kind) => {
      if (!options.length) return null;
      const select = h('select', options.map(([value, text]) => h('option', { value }, text)));
      return h('div.sh-fixrow', h('span', label), select, h('button.btn', { type: 'button', onclick: () => send({ kind, pair: Number(select.value) }) }, 'Match'));
    };
    const elsewhere = (wanted) => shifts.filter((o) => o.id !== s.id).flatMap((o) => (o.moves || [])
      .filter((x) => !['corrected', 'excluded'].includes(x.kind) && x.amount === wanted)
      .map((x) => [x.seq, `ASSD ${x.seq} · ${money(Math.abs(x.amount))} · ${nameOf(o.user)}, ${SLOT[o.slot].label.toLowerCase()} ${shortDay(o.day)}`]));

    if (m.manual || m.kind === 'excluded') {
      return h('div.sh-fixbox', h('p.sh-sub', 'Put this movement back to how ASSD and its counts have it.'),
        h('div.sh-fixrow', choice('Undo the correction', { kind: 'clear' }, true), said));
    }
    if (m.amount < 0) {
      return h('div.sh-fixbox',
        h('p.sh-sub', 'Money put back into the drawer that was never really there: it undoes a movement out on another shift. Match them and both are left out, which clears the surplus on one and the deficit on the other.'),
        pick('It puts back', elsewhere(-m.amount), 'reverses') || h('p.sh-sub', `No movement of ${money(-m.amount)} out of the drawer on another shift in these days. Widen the days to find it.`),
        h('div.sh-fixrow', note, said));
    }
    const split = h('input', { type: 'number', inputmode: 'decimal', step: '0.01', min: '0', placeholder: 'expenses part' });
    const twins = (s.moves || []).filter((x) => x.seq !== m.seq && x.amount === m.amount && !['corrected', 'excluded'].includes(x.kind))
      .map((x) => [x.seq, `ASSD ${x.seq} · ${money(x.amount)} · ${nameOf(x.user)}`]);
    // The receipts part comes from the counts and is not cash; only the
    // cash part is said here.
    const cashPart = m.cash ?? m.amount;
    return h('div.sh-fixbox',
      h('p.sh-sub', m.receipts
        ? `${money(m.receipts)} of it was receipts, from the count before it: expenses already, not cash. What was the other ${money(cashPart)}?`
        : 'What did this movement really take out of the drawer?'),
      cashPart > 0 ? h('div.sh-fixrow', choice('Expenses paid straight out', { kind: 'expenses' }, m.kind !== 'expenses'), choice('Cash to the safe', { kind: 'safe' }, m.kind !== 'safe'),
        h('span', 'or split:'), split, h('button.btn', { type: 'button', onclick: () => send({ kind: 'split', expenses: split.value }) }, 'Split')) : null,
      cashPart > 0 ? h('div.sh-fixrow', h('span', 'Expenses for'), pos) : null,
      pick('A duplicate of', twins, 'duplicate'),
      pick('Put back by', elsewhere(-m.amount), 'reverses'),
      h('div.sh-fixrow', note, said));
  }

  /**
   * The POs behind this shift's expenses, as the closing report in HIVE gave
   * them: Odoo's state and whether each is on the expense form. Nothing to
   * type here; a PO is added in HIVE, where the shift is closed.
   */
  function odooBlock(s) {
    const exp = s.expense || {};
    const orders = exp.odoo?.orders || [];
    if (!orders.length) {
      return s.drawerOut ? [h('p.sh-sub', 'No POs on a closing report for this shift. They are added in HIVE when the shift is closed, or linked here.'),
        s.register?.expenses > 0 ? poLinker(s) : null] : null;
    }
    const approved = (o) => o.state === 'purchase' || o.state === 'done';
    const formChip = (o) => (o.kind ? h('span.sh-chip.none', '—')
      : o.reported ? h('span.sh-chip.ok', 'Reported')
        : data.formLive ? h('span.sh-chip.short', 'Report on form') : h('span.sh-chip.none', 'Form not connected'));
    return h('div.sh-odoo',
      h('p.sh-sub', 'The POs on this shift’s closing report in HIVE, with what Odoo and the expense form say about each.'),
      table([
        { label: 'PO', get: (o) => `${o.name}${o.kind === 'topup' ? ' (deficit)' : o.kind === 'change' ? ' (refund)' : o.advance ? ' (advance)' : ''}` },
        { label: 'Vendor', get: (o) => o.vendor || '' },
        { label: 'Paid', num: true, get: (o) => money(o.total), foot: (list) => money(list.reduce((t, o) => t + o.total, 0)) },
        { label: 'Odoo', get: (o) => (approved(o) ? h('span.sh-chip.ok', 'Approved') : o.advance ? h('span.sh-chip.over', 'Approve in Odoo') : h('span.sh-chip.none', o.state)) },
        { label: 'Expense form', get: formChip },
      ], orders, { footer: orders }),
      (exp.odoo?.unknown || []).length ? banner('warning', `Odoo does not know ${exp.odoo.unknown.join(', ')}.`) : null,
      s.register?.expenses > 0 ? poLinker(s) : null);
  }

  // -------------------------------------------------------- exceptions --

  function describe(x) {
    const e = x.event || {};
    const paid = `${e.kind === 'momo' ? 'MoMo' : `card${e.last4 ? ` …${e.last4}` : ''}`} ${money(e.amount)}`;
    switch (x.kind) {
      case 'failed': return `The terminal declined it at ${when(e.at)} (${e.status || 'not approved'}) and never approved it afterwards. ASSD has it as paid by card.`;
      case 'not-found': return 'ASSD says card or MoMo. Nothing of this amount was approved, received or credited near the shift.';
      case 'zero': return 'A card payment keyed with no amount.';
      case 'double-charge': return `Card …${e.last4} was charged ${money(e.amount)} twice, ${x.minutesApart} minutes apart (${time(x.twin?.at)} and ${time(e.at)}). ASSD has it once.`;
      case 'transposition': return `The terminal took ${paid} at ${time(e.at)}. ASSD has ${money(x.amount)}: the same digits in another order.`;
      case 'decimal': return `The terminal took ${paid} at ${time(e.at)}. ASSD has ${money(x.amount)}: out by a factor of ten.`;
      case 'keying': return `The terminal took ${paid} at ${time(e.at)}. ASSD has ${money(x.amount)}: one digit different.`;
      case 'duplicate': return `Keyed twice in this shift (also ASSD ${x.pair}) and paid once.`;
      case 'not-recorded': return `${e.kind === 'momo' ? 'MoMo received' : 'Approved on the terminal'} at ${when(e.at, e.day)}${e.last4 ? `, card …${e.last4}` : ''}. ASSD has no payment of this amount.`;
      case 'never-settled': return `Approved on the terminal ${when(e.at)}, card …${e.last4}, approval ${e.approval}. No bank credit six days on.`;
      case 'reversal': return `The bank took ${money(Math.abs(x.amount))} back from card …${e.last4} (tapped ${shortDay(e.day)}).${x.pairedWith ? ' It answers a refund keyed in ASSD.' : ' No refund of that amount is keyed in ASSD in these days.'}`;
      case 'refund': return `A card refund keyed in ASSD.${x.pairedWith ? ' The bank reversal for it is on the statement.' : ' No matching reversal on the bank statement yet.'}`;
      case 'regrouped': return `The shift’s unmatched lines (${(x.lines || []).map((a) => money(a)).join(' + ')}) add up exactly to its unmatched payments (${(x.events || []).map((ev) => money(ev.amount)).join(' + ')}).`;
      case 'other-shift': return `Paid at ${when(e.at)}${x.otherShift ? ` on ${nameOf(x.otherShift.user)}’s ${SLOT[x.otherShift.slot]?.label.toLowerCase() || ''} shift of ${shortDay(x.otherShift.day)}` : ''}, and keyed on this one.`;
      case 'corrected': return `Keyed and reversed in the same shift (ASSD ${x.pair}). Nothing is owed.`;
      case 'drawer-short':
      case 'drawer-over': return `It should have held ${money(x.expected)}. ${x.closingFrom === 'typed' ? 'The recount' : 'ASSD’s closing count'} found ${money(x.closing)}.`;
      case 'handover-gap': return `The first count of this shift found ${money(Math.abs(x.amount))} ${x.amount < 0 ? 'less' : 'more'} than ${nameOf(x.from)}’s closing count.`;
      case 'movement-matched': return `${x.reason === 'duplicate'
        ? `ASSD ${x.seq} (${money(x.amount)}) was matched as a duplicate of ASSD ${x.pair} and is left out of the drawer.`
        : `ASSD ${x.seq} and ASSD ${x.pair} were matched: one puts the other back, and both are left out of the drawer.`}`
        + ` ${x.drawerNow == null ? '' : x.drawerNow === 0 ? 'The drawer for this shift now agrees.' : `The drawer for this shift is now ${x.drawerNow > 0 ? 'over' : 'short'} by ${money(Math.abs(x.drawerNow))}.`}`;
      case 'movement-labelled': return `${money(x.amount)} moved out (ASSD ${x.seq}) was labelled by hand: ${x.label}.`
        + ` ${x.drawerNow == null ? '' : x.drawerNow === 0 ? 'The drawer for this shift agrees.' : `The drawer for this shift is ${x.drawerNow > 0 ? 'over' : 'short'} by ${money(Math.abs(x.drawerNow))}.`}`;
      case 'movement-corrected': return `${nameOf(x.by)} moved ${money(x.amount)} out and ${nameOf(x.reversedBy)} put it back (ASSD ${x.reversedSeq}). It nets to nothing.`;
      case 'movement-twice': return `${money(x.amount)} was moved out of the drawer twice (ASSD ${x.pair} and ${x.seq}), and the drawer counted over. If the second never moved any cash, match it as a duplicate.`;
      case 'movement-reversal': return `${money(x.amount)} was put back into the drawer (ASSD ${x.seq}). It matches ASSD ${x.pair}, moved out on ${nameOf(x.pairShift?.user)}’s ${SLOT[x.pairShift?.slot]?.label.toLowerCase() || ''} shift of ${shortDay(x.pairShift?.day)}. If one undoes the other, match them: both are left out.`;
      case 'receipts-swapped': return `${money(x.amount)} of receipts${x.receiptsFrom ? ` left in the drawer by ${nameOf(x.receiptsFrom)}’s shift` : ''} left with no cash movement and were swapped for cash put into the drawer. They are expenses where they first appeared, with their PO; here they are not cash.`;
      case 'expense-no-po': return `${money(x.amount)} left the drawer as expenses${x.seqs?.length ? ` (ASSD ${x.seqs.join(', ')})` : ''} with no PO: none on the closing report in HIVE and none linked here. Link the PO, or answer why there is none.`;
      case 'expense-po-gap': return `${money(x.expenses)} left the drawer as expenses${x.seqs?.length ? ` (ASSD ${x.seqs.join(', ')})` : ''}, but the POs (${(x.pos || []).join(', ')}) come to ${money(x.poTotal)} in Odoo: ${money(Math.abs(x.amount))} ${x.amount > 0 ? 'more' : 'less'} was paid than the POs say. Link the missing PO, unlink a wrong one, or answer why.`;
      case 'movement-unlabelled': return `${money(x.amount)} ${x.part ? `of the ${money(x.whole)} moved out` : 'moved out of the drawer'} (ASSD ${x.seq}) and no count says whether it went to the safe or on expenses.`
        + `${x.pending ? ` ${x.pending.by} has proposed: ${x.pending.kind}. Waiting for an admin.` : ' Say which.'}`;
      case 'laundry-mismatch': return `ASSD has ${money(x.assd)} of laundry on this shift; the laundry system took ${money(x.system)} in the same hours`
        + `${x.payments ? ` (${x.payments} payment${x.payments === 1 ? '' : 's'})` : ''}${x.charged ? `, and accepted ${money(x.charged)} of new orders` : ''}.`
        + ` ${x.amount > 0 ? 'Laundry was charged at the desk that the laundry system has not taken.' : 'The laundry took money that ASSD does not show.'}`;
      case 'bank-only': return `A card credit on the bank statement, card …${e.last4}, tapped ${shortDay(e.day)}, with no record on the terminal report.`;
      default: return '';
    }
  }

  function evidence(x) {
    const box = (a, mid, b) => h('div.sh-evidence', h('div', h('small', a[0]), a[1]), h('span.vs', mid), h('div', h('small', b[0]), b[1]));
    if (['keying', 'transposition', 'decimal'].includes(x.kind) && x.event) {
      const a = (x.amount / 100).toFixed(2);
      const b = (x.event.amount / 100).toFixed(2);
      const marked = (str, other) => h('b', [...str].map((c, i) => (c !== other[i] ? h('mark', c) : c)));
      return box(['ASSD', marked(a, b)], 'vs', [x.event.kind === 'momo' ? 'MoMo' : 'Terminal', marked(b, a)]);
    }
    if (x.kind === 'drawer-short' || x.kind === 'drawer-over') return box(['Should hold', h('b', whole(x.expected))], '→', ['Counted', h('b', whole(x.closing))]);
    if (x.kind === 'laundry-mismatch') return box(['ASSD', h('b', whole(x.assd))], 'vs', ['Laundry system', h('b', whole(x.system))]);
    if (x.kind === 'failed') return box(['Terminal', h('b', { style: 'color:var(--sh-bad-ink)' }, 'Declined')], 'vs', ['ASSD', h('b', 'Paid')]);
    if (x.kind === 'movement-corrected') return box(['Keyed', h('b', h('s', whole(x.amount)))], '→', ['Put back by', h('b', nameOf(x.reversedBy))]);
    return null;
  }

  /**
   * Which way an exception moves money, so a set of them can be seen to net
   * out: money that arrived and ASSD does not show is +, money ASSD shows and
   * never arrived is −. Null where the kind has no direction of its own.
   */
  function flowOf(x) {
    const a = Math.abs(x.amount ?? 0);
    if (x.amount == null) return null;
    if (['not-recorded', 'bank-only', 'double-charge'].includes(x.kind)) return a;
    if (['not-found', 'failed', 'zero', 'never-settled', 'reversal', 'duplicate'].includes(x.kind)) return -a;
    if (['drawer-over', 'drawer-short', 'handover-gap'].includes(x.kind)) return x.amount;
    if (x.kind === 'movement-twice') return a;
    return null;
  }
  const flowText = (f) => (f == null ? '' : f > 0 ? `+${money(f)}` : `−${money(-f)}`);

  /** An exception by its key, in words, for the Approvals view. */
  function describeKey(key) {
    if (String(key).startsWith('stay:')) {
      const x = stays && [...stays.leaving, ...stays.left].find((o) => o.key === key);
      return `Unpaid stay, reservation ${String(key).slice(5)}${x ? `, leaving ${dayText(x.checkout)}, owes ${money(x.balance)}` : ''}`;
    }
    const x = data?.exceptions?.find((o) => o.key === key);
    if (x) {
      return `${(KIND[x.kind] || [x.kind])[0]}, ${x.day ? dayText(x.day) : ''}${x.slot ? ` ${SLOT[x.slot].label.toLowerCase()}` : ''}`
        + `${x.user ? `, ${nameOf(x.user)}` : ''}${x.amount != null ? `, ${money(Math.abs(x.amount))}` : ''}`;
    }
    const [kind, day, slot] = String(key).split(':');
    return /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? `${kind}, ${dayText(day)}${slot && SLOT[slot] ? ` ${SLOT[slot].label.toLowerCase()}` : ''} (outside the days on screen)` : `${key} (outside the days on screen)`;
  }

  /** Unanswered exceptions elsewhere of the same amount, pulling the other way. */
  function relatedTo(x) {
    const f = flowOf(x);
    if (f == null || !f || x.answer) return [];
    const near = (d) => !x.day || !d || Math.abs((Date.parse(d) - Date.parse(x.day)) / 86400000) <= 7;
    return data.exceptions.filter((o) => o !== x && !o.answer && !o.proposed && o.severity !== 'info' && flowOf(o) === -f && near(o.day)).slice(0, 3);
  }

  async function reconcile(keys, note) {
    const out = await api('/shifts/link', { method: 'POST', body: { keys, note } });
    picked.clear();
    await load(banner('good', out.pending
      ? `${keys.length} exceptions reconciled together and sent to an admin. They clear once approved.`
      : `${keys.length} exceptions reconciled together. They count as answered.`));
  }

  /**
   * On a drawer that counted over: receipts taken out of the drawer with no
   * movement were swapped for cash put in. When the counts show it, Insight
   * says so and one tap reconciles it; otherwise the amount can be typed.
   */
  function receiptsSwapBox(x, said) {
    const amount = h('input', { type: 'number', inputmode: 'decimal', step: '0.01', min: '0', value: x.swapped ? (x.swapped / 100).toFixed(2) : '', 'aria-label': 'Receipts swapped for cash', placeholder: 'amount' });
    const send = async (value) => {
      said.textContent = 'Saving…';
      try {
        await api('/shifts/receipts', { method: 'POST', body: { day: x.day, slot: x.slot, amount: value } });
        await load(banner('good', 'Reconciled. The drawer is worked out again.'));
      } catch (err) { said.textContent = err.message; }
    };
    return h('div.sh-suggest',
      x.swapped
        ? [h('span', h('b', 'It matches receipts that left the drawer. '),
          `${money(x.swapped)} of receipts${x.receiptsFrom ? `, in the drawer at hand-over from ${nameOf(x.receiptsFrom)}’s shift,` : ''} left with no cash movement, and the notes went up by as much: they were swapped for cash. They are expenses where they first appeared, with their PO.`),
        h('span', h('button.btn.primary', { type: 'button', onclick: () => send((x.swapped / 100).toFixed(2)) }, `Reconcile: ${money(x.swapped)} of receipts swapped for cash`))]
        : h('span', 'Receipts from an earlier shift swapped for cash? Type how much and reconcile it.'),
      x.swapped ? null : h('div.sh-fixrow', amount, h('button.btn', { type: 'button', onclick: () => send(amount.value) }, 'Reconcile')));
  }

  /** Answered, or explained by the rules: nothing left to do. */
  const settled = (x) => Boolean(x.answer) || x.severity === 'info';

  /**
   * A shift's differences: what still needs somebody first, then what was
   * matched or explained, in green, so a settled one does not read as a
   * problem.
   */
  function exceptionsBlock(s) {
    const all = exceptionsOf(s);
    const open = all.filter((x) => !settled(x));
    const done = all.filter(settled);
    return [
      open.length ? h('section.card',
        h('div.sh-cardhead', h('h2', 'What does not agree on this shift')),
        h('div.sh-exgrid', open.map(exceptionCard))) : null,
      done.length ? h('section.card.sh-settled',
        h('div.sh-cardhead', h('div', h('h2', `✓ Matched and explained · ${done.length}`),
          h('p.sh-sub', 'Differences already answered, matched or explained by the rules. Nothing to do; Undo is still there.'))),
        h('div.sh-exgrid', done.map(exceptionCard))) : null,
    ];
  }

  function exceptionCard(x) {
    const sev = settled(x) ? 'ok' : x.severity === 'critical' ? 'bad' : x.severity === 'warning' ? 'warn' : 'info';
    const [title, kindMark] = KIND[x.kind] || [x.kind, '!'];
    const mark = settled(x) ? '✓' : kindMark;
    const note = h('input', { type: 'text', maxlength: '600', placeholder: 'What happened (optional)', value: x.answer?.note || '' });
    const said = h('span.small');
    const answer = async (value) => {
      said.textContent = 'Saving…';
      try {
        await api('/shifts/answer', { method: 'POST', body: { key: x.key, answer: value, note: value ? note.value : '' } });
        await load();
      } catch (err) { said.textContent = err.message; }
    };
    const canLink = may('bank', 2) && !x.answer && !x.proposed && x.severity !== 'info';
    const decide = async (ok) => {
      said.textContent = 'Saving…';
      try {
        await api('/till/approve', { method: 'POST', body: x.proposed.link ? { link: x.proposed.link, ok } : { answer: x.key, ok } });
        await load(banner('good', ok ? 'Approved. It is cleared.' : 'Rejected. It is back on the list.'));
      } catch (err) { said.textContent = err.message; }
    };
    const related = canLink ? relatedTo(x) : [];
    const others = x.link ? x.link.keys.filter((k) => k !== x.key) : [];
    const label = (o) => `${(KIND[o.kind] || [o.kind])[0]}, ${o.day ? dayText(o.day) : ''}${o.slot ? ` ${SLOT[o.slot].label.toLowerCase()}` : ''}`;
    return h(`article.sh-ex.${sev}${x.answer ? '.done' : ''}${picked.has(x.key) ? '.picked' : ''}`,
      h('div.hd', h('span.sq', mark), h('h3', title), h('span.amt.num', money(Math.abs(x.amount ?? 0))),
        canLink ? h('label.sh-pick', { title: 'Tick to reconcile with others' },
          h('input', { type: 'checkbox', checked: picked.has(x.key), onchange: (e) => { if (e.target.checked) picked.add(x.key); else picked.delete(x.key); paint(); } }),
          h('span', 'Reconcile with others')) : null),
      h('div.sh-meta',
        x.user ? [avatar(x.user), h('b', nameOf(x.user))] : null,
        x.day ? h('span', dayText(x.day)) : null,
        x.slot ? h('span', SLOT[x.slot].label.toLowerCase()) : null,
        x.seqs ? h('span', `ASSD ${x.seqs.join(', ')}`) : x.seq ? h('span', `ASSD ${x.seq}`) : null),
      evidence(x),
      h('p', describe(x)),
      ['expense-no-po', 'expense-po-gap'].includes(x.kind) && !x.answer && byId.has(`${x.day}|${x.slot}`) ? poLinker(byId.get(`${x.day}|${x.slot}`)) : null,
      x.slot && byId.has(`${x.day}|${x.slot}`) && !(section === 'shifts' && detail)
        ? h('div', h('button.sh-link', { type: 'button', onclick: () => go('shift', `${x.day}|${x.slot}`) }, 'Open the shift')) : null,
      x.action && !x.answer ? h('div', h('button.btn.primary', {
        type: 'button',
        onclick: async () => {
          said.textContent = 'Matching…';
          try {
            await api('/shifts/movement', { method: 'POST', body: { ...x.action, note: note.value } });
            await load(banner('good', 'Matched. The drawers are worked out again.'));
          } catch (err) { said.textContent = err.message; }
        },
      }, x.kind === 'movement-twice' ? 'Match as a duplicate' : 'Match them')) : null,
      // A surplus that receipts swapped for cash explain: reconcile it.
      x.kind === 'drawer-over' && !x.answer && !x.proposed && may('moves', 2) ? receiptsSwapBox(x, said) : null,
      x.kind === 'receipts-swapped' ? h('div.sh-done', h('span', `✓ Reconciled (${x.by || 'somebody'}${x.at ? `, ${String(x.at).slice(0, 16)}` : ''})${x.note ? ` · ${x.note}` : ''}`),
        may('moves', 2) ? h('button.sh-link', {
          type: 'button',
          onclick: async () => {
            try { await api('/shifts/receipts', { method: 'POST', body: { day: x.day, slot: x.slot, amount: '' } }); await load(banner('good', 'Undone. The drawer is worked out again.')); } catch (err) { said.textContent = err.message; }
          },
        }, 'Undo') : null) : null,
      x.labels && !x.answer && !x.proposed && !x.pending && may('moves', 2) ? h('div.sh-labels',
        [['safe', 'It went to the safe'], ['expenses', 'It was expenses']].map(([kind, words]) => h('button.btn', {
          type: 'button',
          onclick: async () => {
            said.textContent = 'Saving…';
            try {
              const out = await api('/shifts/movement', { method: 'POST', body: { seq: x.seq, kind, note: note.value } });
              await load(banner('good', out.pending ? 'Sent to an admin to approve.' : 'Labelled. The drawer is worked out again.'));
            } catch (err) { said.textContent = err.message; }
          },
        }, words))) : null,
      related.length ? h('div.sh-related',
        h('span', 'Possibly the same money: '),
        related.map((o) => h('button.sh-link', {
          type: 'button',
          onclick: async (e) => {
            e.target.disabled = true;
            try { await reconcile([x.key, o.key], `Same ${money(Math.abs(o.amount))}: ${label(x)} and ${label(o)}`); } catch (err) { said.textContent = err.message; e.target.disabled = false; }
          },
        }, `${label(o)} (${flowText(flowOf(o))}) · reconcile with it`))) : null,
      // A supervisor's answer or reconciliation: shown, and waiting for an admin.
      x.proposed ? h('div.sh-waiting',
        h('span', `⏳ Waiting for an admin: ${x.proposed.answer}${x.proposed.note ? `: ${x.proposed.note}` : ''} (${x.proposed.by})`),
        admin ? [
          h('button.btn.primary', { type: 'button', onclick: () => decide(true) }, 'Approve'),
          h('button.btn', { type: 'button', onclick: () => decide(false) }, 'Reject'),
        ] : x.proposed.by === state.me?.account?.name ? h('button.sh-link', {
          type: 'button',
          onclick: async () => {
            try {
              if (x.proposed.link) await api('/shifts/unlink', { method: 'POST', body: { id: x.proposed.link } });
              else await api('/shifts/answer', { method: 'POST', body: { key: x.key, answer: '' } });
              await load(banner('good', 'Taken back.'));
            } catch (err) { said.textContent = err.message; }
          },
        }, 'Take it back') : null, said)
      : x.link ? h('div.sh-done',
        h('span', `✓ Reconciled together with ${others.length} other${others.length === 1 ? '' : 's'}: `,
          others.map((k) => data.exceptions.find((o) => o.key === k)).map((o, i) => (o ? label(o) : 'one outside these days')).join('; '),
          x.link.note ? ` · ${x.link.note}` : '', ` (${x.link.by})`),
        may('bank', 2) ? h('button.sh-link', {
          type: 'button',
          onclick: async () => {
            try { await api('/shifts/unlink', { method: 'POST', body: { id: x.link.id } }); await load(banner('good', 'Undone. Those exceptions are open again.')); } catch (err) { said.textContent = err.message; }
          },
        }, 'Undo') : null)
      : x.severity === 'info' && !x.answer && x.kind !== 'receipts-swapped' ? h('div.sh-done', h('span', { style: 'color:var(--ink-2)' }, 'Explained by the rules; no answer needed'))
        : x.answer ? h('div.sh-done',
          h('span', `✓ ${x.answer.answer}${x.answer.note ? `: ${x.answer.note}` : ''}${x.answer.by ? ` (${x.answer.by}${x.answer.at ? `, ${String(x.answer.at).slice(0, 16)}` : ''})` : ''}`),
          // A correction to a movement is undone, not re-answered: the
          // differences it settled come back as they were.
          x.undo ? (may('moves', 2) ? h('button.sh-link', {
            type: 'button',
            onclick: async () => {
              said.textContent = 'Undoing…';
              try {
                await api('/shifts/movement', { method: 'POST', body: { seq: x.undo.seq, kind: 'clear' } });
                await load(banner('good', 'Undone. The drawer is worked out again from ASSD as it was.'));
              } catch (err) { said.textContent = err.message; }
            },
          }, 'Undo') : null)
            : h('button.sh-link', { type: 'button', onclick: () => answer('') }, 'Change'), said)
          : h('div.sh-answers', note, ANSWERS.map((a) => h('button', { type: 'button', onclick: () => answer(a) }, a)), said));
  }

  /**
   * Pairs that are probably the same money: one ASSD shows and never arrived,
   * one arrived that ASSD does not show, same amount, within a week. Each
   * exception is in one pair at most.
   */
  function likelyPairs() {
    if (!may('bank', 2)) return [];
    const used = new Set();
    const out = [];
    for (const x of data.exceptions) {
      if (x.answer || x.proposed || x.severity === 'info' || used.has(x.key)) continue;
      const o = relatedTo(x).find((r) => !used.has(r.key));
      if (!o) continue;
      used.add(x.key); used.add(o.key);
      // The money that never arrived on the left, what arrived on the right.
      out.push(flowOf(x) < 0 ? [x, o] : [o, x]);
    }
    return out;
  }
  const exLabel = (o) => `${o.user ? `${nameOf(o.user)}, ` : ''}${o.day ? dayText(o.day) : ''}${o.slot ? ` ${SLOT[o.slot].label.toLowerCase()}` : ''}`;

  // -------------------------------------------------------------- inbox --

  /** Pairs that are probably the same money, each reconciled with one click. */
  function pairsCard() {
    const pairs = likelyPairs();
    if (!pairs.length) return null;
    const said = h('span.small');
    return h('section.card.sh-pairs',
      h('div.sh-cardhead',
        h('div', h('h2', `Probably the same money · ${pairs.length}`),
          h('p.sh-sub', 'The same amount one way and the other, within a week. Reconciling answers both.')),
        pairs.length > 1 ? h('button.btn', {
          type: 'button',
          onclick: async (e) => {
            e.target.disabled = true;
            said.textContent = 'Reconciling…';
            try {
              for (const [a, b] of pairs) {
                // eslint-disable-next-line no-await-in-loop
                await api('/shifts/link', { method: 'POST', body: { keys: [a.key, b.key], note: `Same ${money(Math.abs(a.amount))}: ${exLabel(a)} and ${exLabel(b)}` } });
              }
              await refreshInbox(`${pairs.length} pairs reconciled.`);
            } catch (err) { said.textContent = err.message; e.target.disabled = false; }
          },
        }, `Reconcile all ${pairs.length}`) : null),
      pairs.map(([a, b]) => h('div.sh-pair',
        h('div', h('b.num', money(Math.abs(a.amount))), h('span', ` · ${(KIND[a.kind] || [a.kind])[0]} · ${exLabel(a)}`)),
        h('span.sh-pairarrow', { 'aria-hidden': 'true' }, '↔'),
        h('div', h('b.num', money(Math.abs(b.amount))), h('span', ` · ${(KIND[b.kind] || [b.kind])[0]} · ${exLabel(b)}`)),
        h('button.btn.primary', {
          type: 'button',
          onclick: async (e) => {
            e.target.disabled = true;
            try { await reconcile([a.key, b.key], `Same ${money(Math.abs(a.amount))}: ${exLabel(a)} and ${exLabel(b)}`); } catch (err) { said.textContent = err.message; e.target.disabled = false; }
          },
        }, 'Reconcile'))),
      said);
  }

  /** Read every source of the Inbox again, then the period, and show `notice`. */
  async function refreshInbox(notice = null) {
    await readInbox(true);
    await load(typeof notice === 'string' ? banner('good', notice) : notice);
  }

  const daysAgo = (day) => {
    if (!day) return 0;
    const today = new Date().toISOString().slice(0, 10);
    return Math.max(0, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${String(day).slice(0, 10)}T12:00:00Z`)) / 86_400_000));
  };

  /**
   * Everything to act on, from every source, as one kind of line: what it
   * is, whose, how much, how long it has waited, and what opens beside it.
   * `counts` marks what goes on the tab's number.
   */
  function inboxItems() {
    const out = [];
    const after = (m) => refreshInbox(m);
    // What does not agree, in the days on screen. An admin sees a
    // supervisor's proposed answer under Waiting for admin, from the approvals.
    if (can.exceptions && data) {
      for (const x of data.exceptions) {
        if (x.severity === 'info') continue;
        const waitingAdmin = Boolean(x.proposed);
        if (admin && waitingAdmin) continue;
        const done = Boolean(x.answer) || Boolean(x.link && !x.proposed);
        if (done && !inbox.showDone) continue;
        const sev = x.severity === 'critical' ? 'short' : 'over';
        out.push({
          id: `ex:${x.key}`, kind: waitingAdmin ? 'admin' : x.group === 'nopo' ? 'po' : DRAWER_GROUPS.has(x.group) ? 'drawer' : 'bank',
          title: (KIND[x.kind] || [x.kind])[0], sub: exLabel(x), amount: x.amount == null ? '' : money(Math.abs(x.amount)),
          chip: done ? ['ok', 'Answered'] : waitingAdmin ? ['none', 'Waiting for admin'] : null, tone: sev, done,
          age: daysAgo(x.day), counts: !done && !waitingAdmin, render: () => exceptionCard(x),
          bulk: !done && !waitingAdmin && may('bank', 2) ? { type: 'answer', key: x.key } : null,
        });
      }
    }
    // Staff answers from HIVE, waiting for a decision.
    if (can.answers && sources.till) {
      for (const i of sources.till.issues || []) {
        if (i.status !== 'answered') continue;
        out.push({
          id: `is:${i.key}`, kind: 'drawer', title: `${i.name || 'Somebody'} answered`,
          sub: `${sources.till.kinds?.[i.kind] || i.kind} · ${dayText(i.day)} ${SLOT[i.slot]?.label.toLowerCase() || ''}`,
          amount: may('money') && i.amount ? money(Math.abs(i.amount)) : '', chip: ['over', 'Answered'], tone: 'over',
          age: daysAgo(i.answer?.at || i.day), counts: true, render: () => till.issueCard(i, () => after('Done.')),
        });
      }
    }
    // What waits for an admin: supervisors' answers and corrections.
    if (can.approvals && sources.till) {
      for (const a of sources.till.answerApprovals || []) {
        out.push({
          id: `aa:${a.type}:${a.id}`, kind: 'admin', title: a.type === 'link' ? `Reconciled ${a.keys.length} together` : `Answered “${a.answer}”`,
          sub: `by ${a.by}`, amount: '', chip: ['none', 'Approve'], tone: 'none', age: daysAgo(a.at), counts: true,
          render: () => till.answerApprovalCard(a, () => after('Done.')),
        });
      }
      for (const a of sources.till.approvals || []) {
        out.push({
          id: `co:${a.seq}`, kind: 'admin', title: `Correction · ASSD ${a.seq}`, sub: `by ${a.by}${a.day ? ` · ${dayText(a.day)}` : ''}`,
          amount: money(a.amount), chip: ['none', 'Approve'], tone: 'none', age: daysAgo(a.at), counts: true,
          render: () => till.correctionCard(a, () => after('Done.')),
        });
      }
    }
    // Stays not fully paid.
    if (can.stays && stays) {
      for (const [list, left] of [[stays.leaving || [], false], [stays.left || [], true]]) {
        for (const x0 of list) {
          const x = { ...x0, left };
          if (admin && x.proposed) continue;
          const done = Boolean(x.answer);
          if (done && !inbox.showDone) continue;
          out.push({
            id: `st:${x.key}`, kind: x.proposed ? 'admin' : 'stay', title: `${x.rooms.join(', ') || 'Room'} · ${left ? 'left owing' : 'leaving, owes'}`,
            sub: `Reservation ${x.ref || x.seq} · check-out ${dayText(x.checkout)}`, amount: stays.redacted ? '' : money(x.balance),
            chip: done ? ['ok', 'Answered'] : x.unsure ? ['none', 'Check in ASSD'] : x.proposed ? ['none', 'Waiting for admin'] : null,
            tone: left ? 'short' : 'over', done, age: daysAgo(x.checkout), counts: !done && !x.unsure && !x.proposed,
            render: () => stayCard(x, after),
            bulk: !done && !x.proposed && may('unpaid', 2) ? { type: 'answer', key: x.key, stay: true } : null,
          });
        }
      }
    }
    // The money to-do: cash POs with no bill, paid ≠ PO, bills with no PO.
    if (can.todo && sources.todo) {
      const today = new Date().toISOString().slice(0, 10);
      for (const t0 of sources.todo.items || []) {
        const t = { ...t0, age: todoAge(t0, today) };
        const done = t.state === 'closed';
        if (done && !inbox.showDone) continue;
        const waitingAdmin = t.state === 'answered';
        out.push({
          id: `td:${t.id}`, kind: waitingAdmin ? 'admin' : 'po', title: todoTitle(t), sub: todoSub(t, { admin }),
          amount: money(t.kind === 'differs' ? Math.abs(t.amount) : t.amount), chip: done ? ['ok', 'Closed'] : waitingAdmin ? ['none', admin ? 'Approve' : 'Waiting for admin'] : null,
          tone: 'over', done, age: t.age, counts: !done && (admin ? waitingAdmin : !waitingAdmin), todo: t,
          bulk: t.state === 'open' ? { type: 'todo', id: t.id } : null,
          render: () => todoDetail(t, { admin, supervisors: sources.todo.supervisors || [], after }),
        });
      }
    }
    // Advances, and POs whose final price differs from what was paid.
    if (can.advances && sources.advances) {
      for (const x of sources.advances.items || []) {
        const done = !advanceOpen(x);
        if (done && !inbox.showDone) continue;
        const [tone, label] = advanceStatus(x);
        out.push({
          id: `ad:${x.po}`, kind: 'advance', title: `${x.po}${x.vendor ? ` · ${x.vendor}` : ''}`,
          sub: `${x.advance ? 'Advanced' : 'Paid'} ${advanceWhen(x)}${x.by ? ` · ${x.by}` : ''}`, amount: money(x.advance ? x.advanced : x.paid),
          chip: [tone, label], tone, done, age: daysAgo(x.day), counts: !done,
          render: () => advanceDetail(x, { canAct: sources.advances.canAct, formLive: sources.advances.formLive, after }),
        });
      }
    }
    return out.sort((a, b) => Number(a.done) - Number(b.done) || b.age - a.age);
  }

  /**
   * The Inbox: one list of everything to act on, kind chips across the top,
   * the one picked in full beside it.
   */
  /**
   * One answer for everything ticked: exceptions and unpaid stays take the
   * chosen answer (a supervisor's wait for an admin, as one by one); money
   * to-dos take the note, or the answer when there is no note, and an admin's
   * answer closes them.
   */
  function bulkActions(items, redraw) {
    const answers = items.some((x) => x.bulk.stay) && items.every((x) => x.bulk.stay || x.bulk.type === 'todo')
      ? STAY_ANSWERS : items.some((x) => x.bulk.stay) ? [...new Set([...ANSWERS, ...STAY_ANSWERS])] : ANSWERS;
    const pick = h('select', { 'aria-label': 'Answer' }, h('option', { value: '' }, 'Answer…'), answers.map((a) => h('option', { value: a }, a)));
    const note = h('input', { type: 'text', maxlength: '400', placeholder: 'Note (optional; what happened, for to-dos)', 'aria-label': 'Note' });
    const said = h('span.small');
    const go = h('button.btn.primary', {
      type: 'button',
      onclick: async () => {
        const answer = pick.value;
        const keys = items.filter((x) => x.bulk.type === 'answer').map((x) => x.bulk.key);
        const todos = items.filter((x) => x.bulk.type === 'todo');
        if (!answer && (keys.length || !note.value.trim())) { said.textContent = 'Choose the answer.'; return; }
        go.disabled = true; said.textContent = 'Saving…'; said.className = 'small';
        try {
          let done = 0; const skipped = [];
          if (keys.length) {
            const out = await api('/shifts/answer-many', { method: 'POST', body: { keys, answer, note: note.value } });
            done += out.saved; skipped.push(...out.skipped);
          }
          for (const x of todos) {
            try {
              // eslint-disable-next-line no-await-in-loop
              await api(`/todo/${x.bulk.id}/answer`, { method: 'POST', body: { answer: note.value.trim() || answer } });
              done += 1;
            } catch (err) { skipped.push({ key: x.title, why: err.message }); }
          }
          inbox.ticked.clear();
          await refreshInbox(`Answered ${done}${skipped.length ? `; ${skipped.length} skipped (${skipped[0].why})` : ''}.${!admin ? ' An admin approves them.' : ''}`);
        } catch (err) { said.textContent = err.message; said.className = 'small form-error'; go.disabled = false; }
      },
    }, `Answer ${items.length} ticked`);
    return h('div.ib-bulkbar',
      h('span.small', h('b', String(items.length)), ' ticked'),
      pick, note, go,
      h('button.sh-link', { type: 'button', onclick: () => { inbox.ticked.clear(); redraw(); } }, 'Clear'),
      said);
  }

  function inboxView(v) {
    const all = inboxItems();
    const kinds = INBOX_KINDS.filter(([k]) => all.some((x) => x.kind === k));
    if (inbox.kind !== 'all' && !kinds.some(([k]) => k === inbox.kind)) inbox.kind = 'all';
    const shown = all.filter((x) => inbox.kind === 'all' || x.kind === inbox.kind);
    let at = shown.findIndex((x) => x.id === inbox.open);
    if (at < 0) at = Math.min(inbox.at, shown.length - 1);
    const current = shown[at] || null;
    inbox.open = current?.id || null;
    inbox.at = Math.max(0, at);
    const open = (i) => {
      inbox.at = i; inbox.open = shown[i]?.id || null;
      const list = v.querySelector('.ib-list');
      const keep = list ? list.scrollTop : 0;
      inboxView(v);
      const again = v.querySelector('.ib-list');
      if (again) again.scrollTop = keep;
      again?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
      if (window.matchMedia('(max-width: 760px)').matches) v.querySelector('.ib-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const said = h('span.small');
    const refresh = h('button.btn', {
      type: 'button',
      title: 'Ask Odoo about the cash POs and bills, and read the laundry system, now',
      onclick: async () => {
        refresh.disabled = true; said.textContent = 'Asking Odoo and the laundry system…'; said.className = 'small';
        const parts = [];
        try {
          if (can.todo) {
            const r = await api('/todo/check', { method: 'POST' });
            const t = r.todos || {};
            parts.push(`Odoo: ${r.pos} cash PO${r.pos === 1 ? '' : 's'} checked, ${t.closed || 0} cleared, ${t.raised || 0} new`);
          }
          const l = await api('/todo/laundry', { method: 'POST' }).catch((err) => ({ error: err.message }));
          parts.push(l.error ? `Laundry: ${l.error}` : `Laundry: ${dayText(l.from)} to ${dayText(l.to)} read`);
          await refreshInbox(`${parts.join('. ')}.`);
        } catch (err) { said.textContent = err.message; said.className = 'small form-error'; refresh.disabled = false; }
      },
    }, '↻ Refresh now');
    const count = (k) => all.filter((x) => (k === 'all' || x.kind === k) && !x.done).length;
    // Ticked: what can be acted on together. Select all ticks every one shown.
    const tickable = shown.filter((x) => x.bulk);
    for (const id of [...inbox.ticked]) if (!tickable.some((x) => x.id === id)) inbox.ticked.delete(id);
    const tickedItems = tickable.filter((x) => inbox.ticked.has(x.id));
    const ticked = tickedItems.filter((x) => x.todo).map((x) => x.id);
    const selectAll = tickable.length ? h('label.ib-all', h('input', {
      type: 'checkbox', checked: tickedItems.length > 0 && tickedItems.length === tickable.length,
      indeterminate: tickedItems.length > 0 && tickedItems.length < tickable.length,
      onchange: (e) => { inbox.ticked.clear(); if (e.target.checked) for (const x of tickable) inbox.ticked.add(x.id); inboxView(v); },
    }), ` Select all · ${tickable.length}`) : null;
    const bulkBar = tickedItems.length ? bulkActions(tickedItems, () => inboxView(v)) : null;
    const giveTo = admin && sources.todo?.supervisors?.length && ticked.length ? (() => {
      const to = h('select', { 'aria-label': 'Give to' }, h('option', { value: '' }, 'Give to…'),
        sources.todo.supervisors.map((p) => h('option', { value: String(p.id) }, p.name)));
      const gave = h('span.small');
      return h('div.ib-give',
        h('span.small', h('b', String(ticked.length)), ' PO item', ticked.length === 1 ? '' : 's', ' ticked'),
        to,
        h('button.btn', {
          type: 'button', disabled: !ticked.length,
          onclick: async () => {
            if (!to.value) { gave.textContent = 'Choose who to give them to.'; return; }
            try {
              const out = await api('/todo/assign', { method: 'POST', body: { ids: ticked.map((id) => Number(id.slice(3))), accountId: Number(to.value) } });
              inbox.ticked.clear();
              await refreshInbox(`${out.moved} item${out.moved === 1 ? '' : 's'} given to ${out.to}.`);
            } catch (err) { gave.textContent = err.message; }
          },
        }, 'Give'), gave);
    })() : null;

    mount(v,
      h('div.ib-bar',
        h('div.td-pills', { role: 'group', 'aria-label': 'Kinds' },
          [['all', 'All'], ...kinds].map(([k, label]) => h('button', {
            type: 'button', 'aria-pressed': String(inbox.kind === k), onclick: () => { inbox.kind = k; inbox.at = 0; inbox.open = null; inboxView(v); },
          }, `${label} · ${count(k)}`))),
        h('label.small', h('input', {
          type: 'checkbox', checked: inbox.showDone,
          onchange: async (e) => { inbox.showDone = e.target.checked; await readInbox(); inboxView(v); },
        }), ' Show done'),
        h('div.ib-refresh', refresh, said)),
      inbox.kind === 'all' || inbox.kind === 'bank' ? pairsCard() : null,
      selectAll || bulkBar ? h('div.ib-bulk', selectAll, bulkBar, giveTo) : null,
      shown.length ? h('div.ib-split',
        h('div.card.ib-list', { role: 'listbox', 'aria-label': 'To act on' },
          shown.map((x, i) => h(`div.ib-row${i === at ? '.on' : ''}${x.done ? '.done' : ''}`, {
            role: 'option', tabindex: '0', 'aria-current': String(i === at), 'aria-selected': String(i === at),
            onclick: () => open(i),
            onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(i); } },
          },
          x.bulk ? h('input', {
            type: 'checkbox', 'aria-label': `Tick ${x.title}`, checked: inbox.ticked.has(x.id),
            onclick: (e) => e.stopPropagation(),
            onchange: (e) => { if (e.target.checked) inbox.ticked.add(x.id); else inbox.ticked.delete(x.id); inboxView(v); },
          }) : h('i.ib-dot', { class: x.tone }),
          h('span.ib-t', h('b', x.title), h('small', `${INBOX_KINDS.find(([k]) => k === x.kind)?.[1] || ''} · ${x.sub}`)),
          h('span.ib-r', x.amount ? h('b.num', x.amount) : null,
            x.chip ? h(`span.sh-chip.${x.chip[0]}`, x.chip[1]) : h('small.muted', x.age ? `${x.age} d` : 'today'))))),
        h('div.ib-detail',
          h('div.ib-step',
            h('span.small', `${at + 1} of ${shown.length}`),
            h('button.btn', { type: 'button', disabled: at <= 0, onclick: () => open(at - 1) }, '‹ Previous'),
            h('button.btn', { type: 'button', disabled: at >= shown.length - 1, onclick: () => open(at + 1) }, 'Next ›')),
          current ? current.render() : null,
          current?.kind === 'drawer' || current?.kind === 'bank' ? h('p.small.muted', 'J and K move down and up; 1 to 8 give an exception’s answers in order.') : null))
        : h('section.card', h('p', inbox.kind === 'all' ? '✓ Nothing waiting. Everything in these days agrees, or has an answer.' : '✓ Nothing of this kind waiting.')),
      inbox.kind === 'advance' && sources.advances ? elsewhereCard(sources.advances, inbox.elsewhere, refreshInbox, () => inboxView(v)) : null,
      pickedBar());
  }

  /** The bar that appears once exceptions are ticked: what they net to, and Reconcile together. */
  function pickedBar() {
    const chosen = [...picked].map((k) => data.exceptions.find((x) => x.key === k)).filter(Boolean);
    if (!chosen.length) return null;
    const flows = chosen.map(flowOf);
    const known = flows.every((f) => f != null);
    const net = flows.reduce((t, f) => t + (f || 0), 0);
    const note = h('input', { type: 'text', maxlength: '600', placeholder: net === 0 && known ? 'What happened (optional)' : 'What happened (needed: they do not net to nothing)' });
    const said = h('span.small');
    return h('div.sh-pickbar',
      h('div', h('strong', `${chosen.length} ticked`),
        h('span', known ? ` · net ${net === 0 ? money(0) : flowText(net)}` : ' · net not worked out for every kind'),
        h('div.small', chosen.map((x) => `${(KIND[x.kind] || [x.kind])[0]} ${flowText(flowOf(x)) || money(Math.abs(x.amount ?? 0))}`).join(' · '))),
      note,
      h('button.btn.primary', {
        type: 'button',
        disabled: chosen.length < 2,
        onclick: async (e) => {
          if ((!known || net !== 0) && !note.value.trim()) { note.focus(); said.textContent = 'Say what happened: these do not net to nothing.'; return; }
          e.target.disabled = true;
          try { await reconcile(chosen.map((x) => x.key), note.value.trim()); } catch (err) { said.textContent = err.message; e.target.disabled = false; }
        },
      }, chosen.length < 2 ? 'Tick at least two' : 'Reconcile together'),
      h('button.btn', { type: 'button', onclick: () => { picked.clear(); paint(); } }, 'Clear'),
      said);
  }

  // ------------------------------------------------------------ people --

  function peopleView(v) {
    // Each person's list from HIVE, read on its own, under their drawers.
    const extras = h('div.sh-peoplelists');
    if (may('answers')) till.read().then((d) => mount(extras, till.peopleExtras(d))).catch(() => {});
    if (!may('net')) { mount(v, extras); return; }
    const rows = data.people.map((p) => ({ ...p, mine: shifts.filter((s) => s.user === p.user) })).filter((p) => p.mine.length);
    const widest = Math.max(1, ...rows.map((p) => Math.abs(p.variance)));
    mount(v, h('section.card',
      h('div.sh-cardhead', h('div', h('h2', 'Who held the drawer'),
        h('p.sh-sub', 'Each person’s shifts, the cash and cards they took, and how their drawer counts came out. Every square is a shift: tap one to open it.'))),
      h('div.sh-people', rows.map((p) => {
        const open = data.exceptions.filter((x) => x.user === p.user && x.severity !== 'info' && !x.answer).length;
        return h('div.sh-person',
          h('div.top', avatar(p.user, true),
            h('div', h('b', nameOf(p.user)), h('small', `${p.shifts} shift${p.shifts === 1 ? '' : 's'}`)),
            h('span', { style: 'margin-left:auto' }, chip(p.counted ? p.variance : null, false))),
          h('div.sh-diverge', { title: `Net drawer variance ${signed(p.variance)}` },
            h('b', { style: `${p.variance < 0 ? 'right:50%;background:var(--sh-bad)' : 'left:50%;background:var(--sh-warn)'};width:${(Math.abs(p.variance) / widest) * 50}%` })),
          h('div.sh-pstats',
            h('span', 'Cash', h('b.num', whole(p.cash))),
            h('span', 'Card + MoMo', h('b.num', whole(p.card))),
            h('span', 'To answer', h('b', { style: `color:${open ? 'var(--sh-bad-ink)' : 'var(--sh-good-ink)'}` }, String(open)))),
          h('div.sh-strip', p.mine.map((s) => h('button', {
            type: 'button', title: `${dayText(s.day)} · ${SLOT[s.slot].label}`, style: `background:${TONE[tone(s)]}`, onclick: () => go('shift', s.id),
          }, dayText(s.day, { day: 'numeric' })))));
      }))), extras);
  }

  // ------------------------------------------------------------- files --

  function filesView(v) {
    filesPanel(v, {
      coverage: data.coverage, uploads: data.uploads, canUpload: data.canUpload, end: range.to,
      onLoaded: (file, result) => load(banner('good', h('strong', `${file.name} loaded. `), result.note || '')),
    });
  }

  // Last, once every helper above exists: the first read and paint.
  await load();
}
