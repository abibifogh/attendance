import { add, h, mount, money, num, shortDay, s as svg } from '../util.js';
import { api } from '../api.js';
import { table, banner } from './components.js';
import { readJournalPdf, readStatement, readTerminalCsv } from '../shift-files.js';

/**
 * Shifts: the front desk's control sheet, done from the source records.
 *
 * Five views of one reconciliation:
 * - **Week**: every shift in the window as a coloured tile (green agrees,
 *   amber needs a look, red needs an answer), and card and MoMo recorded
 *   against what arrived, day by day.
 * - **Shift**: one shift's story. The drawer as a waterfall from the opening
 *   count to the closing count, how the shift was paid, card and MoMo placed
 *   on the clock, and where the cash went. A recount or the expense sheet's
 *   total previews as it is typed and is saved with one button.
 * - **Exceptions**: everything that does not agree, grouped by what went
 *   wrong, each answered with one tap.
 * - **People**: each person's shifts and how their drawer came out.
 * - **Files**: the three uploads, and which days each one covers.
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
  'movement-twice': ['Moved out of the drawer twice', '2'],
  'movement-reversal': ['Put back on a different shift', '↺'],
  'bank-only': ['In the bank, not on the terminal', '?'],
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
const VIEWS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['shift', 'Shift'], ['exceptions', 'Exceptions'], ['people', 'People'], ['files', 'Files']];
const PERIODS = ['day', 'week', 'month'];

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
  let section = store.get('section', 'week');
  if (!VIEWS.some(([id]) => id === section)) section = 'week';
  // Day, week or month, and the day it is anchored on. The anchor follows the
  // window chosen at the top of Insight until somebody moves it here.
  let mode = store.get('mode', PERIODS.includes(section) ? section : 'week');
  if (!PERIODS.includes(mode)) mode = 'week';
  let anchor = store.get('anchorFor', '') === range.to ? store.get('anchor', range.to) : range.to;
  let period = periodOf(mode, anchor);
  let jumped = false;
  let currentId = store.get('shift', null);
  let filter = 'all';
  let showAnswered = false;
  // What is being typed and not yet saved, per shift: a recount, a sheet total.
  const drafts = {};

  async function load(notice = null) {
    period = periodOf(mode, anchor);
    data = await api(`/shifts?from=${period.from}&to=${period.to}`);
    // A first visit on days the journal does not reach goes to the newest
    // days it does, once, rather than opening on an empty page.
    if (!jumped && !data.days.some((d) => d.shifts.length) && data.coverage?.journal?.to && data.coverage.journal.to < period.from) {
      jumped = true;
      return moveTo(data.coverage.journal.to, notice);
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
  }

  async function go(next, shiftId = null, day = null) {
    section = next;
    if (shiftId) currentId = shiftId;
    store.set('section', section);
    if (currentId) store.set('shift', currentId);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (PERIODS.includes(next) && (next !== mode || (day && day !== anchor))) {
      mode = next;
      if (day) anchor = day;
      remember();
      return load();
    }
    paint();
  }

  function remember() {
    store.set('mode', mode);
    store.set('anchor', anchor);
    store.set('anchorFor', range.to);
  }

  /** Move the period: a day, a week or a month at a time, or to a given day. */
  function moveTo(day, notice = null) {
    anchor = day;
    remember();
    return load(notice);
  }
  const step = (n) => moveTo(mode === 'day' ? plusDays(anchor, n) : mode === 'week' ? plusDays(anchor, 7 * n) : plusMonths(anchor, n));

  // ------------------------------------------------------------- facts --

  const exceptionsOf = (s) => data.exceptions.filter((x) => x.day === s.day && x.slot === s.slot);
  const waiting = () => data.exceptions.filter((x) => x.severity !== 'info' && !x.answer);

  /** The register with what is being typed applied, so the screen moves as somebody types. */
  function numbers(s) {
    const r = s.register || {};
    const d = drafts[s.id] || {};
    // A recount being typed wins; a cleared box falls back to ASSD's own count.
    const closing = d.recount !== undefined ? (d.recount ?? s.closing?.total ?? null) : r.closing;
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
    const v = s.register?.variance;
    if (open.some((x) => x.severity === 'critical')) return 'bad';
    if (v != null && v < 0 && open.length) return 'bad';
    if (open.some((x) => x.severity === 'warning') || (v && open.length)) return 'warn';
    return 'good';
  }

  const avatar = (user, large = false) => h(`span.sh-av${large ? '.lg' : ''}`, { style: `--pc:${colours[user] || 'var(--sh-info)'}` }, (user || '?')[0]);
  const chip = (v, open) => (open ? h('span.sh-chip.none', 'ends here')
    : v == null ? h('span.sh-chip.none', 'no count')
      : v === 0 ? h('span.sh-chip.ok', '✓ agrees')
        : h(`span.sh-chip.${v > 0 ? 'over' : 'short'}`, `${v > 0 ? '+' : '−'}${whole(Math.abs(v))}`));
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

  function paint(notice = null) {
    const open = waiting().length;
    const has = shifts.length > 0;
    const v = h('div.sh-view');
    mount(view,
      notice,
      h('div.sh-head',
        h('h1', 'Shifts'),
        h('span', has ? `${shifts.length} shift${shifts.length === 1 ? '' : 's'} · ${new Set(shifts.map((s) => s.user)).size} ${new Set(shifts.map((s) => s.user)).size === 1 ? 'person' : 'people'}` : 'No shifts loaded for these days')),
      periodBar(),
      data.journalEndsInside ? banner('warning',
        `The journal loaded so far stops inside the ${SLOT[data.journalEndsInside.slot].label.toLowerCase()} shift of `
        + `${shortDay(data.journalEndsInside.day)}, so that shift is shown as far as it goes. Export ASSD one day past the last shift you want to read.`) : null,
      has ? kpis() : null,
      h('div.sh-tabs', { role: 'tablist' }, VIEWS.map(([id, label]) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(section === id), onclick: () => go(id),
      }, label, id === 'exceptions' && open ? h('span.sh-badge', String(open)) : null))),
      v);
    if (!has && section !== 'files') return mount(v, nothingYet());
    ({ day: dayView, week, month: monthView, shift: shiftView, exceptions: exceptionsView, people: peopleView, files: filesView })[section](v);
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
      tile('exceptions', 'var(--sh-bad)', 'Waiting for an answer', String(open),
        open ? 'Differences somebody has to explain' : 'Everything answered or explained', null, open ? 'var(--sh-bad-ink)' : 'var(--sh-good-ink)'));
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
        const cardLines = s.lines.filter((l) => l.amount > 0);
        add(grid, h(`button.sh-tile.${t}${s.id === currentId ? '.sel' : ''}`, {
          type: 'button', title: `${nameOf(s.user)} · ${SLOT[sl].label} · ${dayText(s.day)}`, onclick: () => go('shift', s.id),
        },
        h('span.sh-who', avatar(s.user), h('b', nameOf(s.user))),
        h('span.sh-fig', h('span.num', `Cash ${whole(s.cash)}`), chip(s.register?.variance, s.open)),
        mixBar(s),
        h('span.sh-fig',
          h('span', cardLines.length ? `${s.cardFound}/${cardLines.length} card` : 'no card'),
          toAnswer ? h('span.sh-chip.short', `${toAnswer} to answer`) : null)));
      }
    }
    const wrap = h('div.sh-weekwrap', grid);

    mount(v,
      h('section.card',
        h('div.sh-cardhead',
          h('div', h('h2', 'Every shift, at a glance'),
            h('p.sh-sub', 'Each tile is one person holding the drawer. Green agrees, amber needs a look, red needs an answer. Open any tile for the whole story.')),
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
          h('b', { style: `height:${(d.totals.cardRecorded / max) * 100}%;background:var(--sh-card)` }),
          h('b', { style: `height:${(d.totals.received / max) * 100}%;background:var(--series-3)` })),
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
      h('span', label), h('span.sh-track', h('b.sh-seg', { style: `left:0;width:${(amount / top) * 100}%;background:${colour}` })), h('b.num', money(amount)));
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
    const cardLines = s.lines.filter((l) => l.amount > 0);
    const v = r.variance;
    return h(`button.sh-daycard.${t}`, { type: 'button', onclick: () => go('shift', s.id) },
      h('div.top', glyph(s.slot), h('span', `${SLOT[s.slot].label} · ${SLOT[s.slot].hours}`),
        h(`span.sh-status.${t}`, { good: '✓ Agrees', warn: '! Look at it', bad: '! Answer needed', open: 'Journal ends here' }[t])),
      h('div.sh-who', avatar(s.user, true), h('b', { style: 'font-size:1.1rem' }, nameOf(s.user))),
      h('dl.sh-mini',
        h('dt', 'Opening count'), h('dd.num', money(r.opening)),
        h('dt', '+ Cash taken'), h('dd.num', money(s.cash)),
        h('dt', '− Moved out'), h('dd.num', money(s.drawerOut)),
        h('dt', 'Closing count'), h('dd.num', money(r.closing))),
      h('div.sh-dayvar', v == null ? h('span.sh-chip.none', s.open ? 'journal ends here' : 'no closing count')
        : v === 0 ? h('span.sh-chip.ok', '✓ The drawer agrees')
          : h(`span.sh-chip.${v > 0 ? 'over' : 'short'}`, `${v > 0 ? 'Over' : 'Short'} ${money(Math.abs(v))}`)),
      mixBar(s),
      h('div.sh-mixkey', MODES.filter(([k]) => m[k] > 0).map(([k, label, c]) => h('span', h('i', { style: `background:${c}` }), `${label === 'Card and MoMo' ? 'Card' : label.replace('Prepaid by ', 'Prepaid ')} ${whole(m[k])}`))),
      h('div.sh-fig',
        h('span', cardLines.length ? `${s.cardFound} of ${cardLines.length} card and MoMo found` : 'No card or MoMo'),
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
          h('div', h('h2', `${period.label}, day by day`),
            h('p.sh-sub', 'Each day shows its morning, afternoon and night as coloured bars with the initial of whoever held the drawer. Tap a bar for that shift, or the day for all three.')),
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
    const sheet = h('input', {
      id: 'sh-sheet', type: 'number', inputmode: 'decimal', step: '0.01', min: '0', disabled: !s.drawerOut && s.expense?.sheetTotal == null,
      placeholder: s.drawerOut ? 'labels the movements' : 'nothing moved out',
      value: draft.sheet !== undefined ? cedis(draft.sheet) : cedis(s.expense?.sheetTotal),
    });
    const needOpening = r.openingFrom == null || r.openingFrom === 'typed';
    const opening = needOpening ? h('input', {
      id: 'sh-opening', type: 'number', inputmode: 'decimal', step: '0.01', min: '0', placeholder: 'only if ASSD has none',
      value: r.openingFrom === 'typed' ? cedis(r.opening) : '',
    }) : null;
    recount.addEventListener('input', () => { draft.recount = typedMinor(recount.value); redraw(); });
    sheet.addEventListener('input', () => { draft.sheet = typedMinor(sheet.value); redraw(); });

    async function save() {
      said.textContent = 'Saving…';
      try {
        await api('/shifts/count', { method: 'POST', body: { day: s.day, slot: s.slot, closing: recount.value, opening: opening ? opening.value : null, note: r.note || '' } });
        if (s.drawerOut || s.expense) {
          await api('/shifts/expense', { method: 'POST', body: { day: s.day, slot: s.slot, sheetTotal: sheet.value, poNumbers: s.expense?.poNumbers || '' } });
        }
        delete drafts[s.id];
        await load(banner('good', `Saved for ${nameOf(s.user)}’s ${SLOT[s.slot].label.toLowerCase()} shift of ${shortDay(s.day)}.`));
      } catch (err) { said.textContent = err.message; }
    }

    mount(v,
      h('section.card',
        h('div.sh-shifthead',
          h('button.sh-arrow', { type: 'button', disabled: i <= 0, 'aria-label': 'Previous shift', onclick: () => go('shift', shifts[i - 1].id) }, '‹'),
          h('div.t', avatar(s.user, true),
            h('div', h('h2', nameOf(s.user)),
              h('div.m', glyph(s.slot), `${SLOT[s.slot].label} · ${SLOT[s.slot].hours} · ${dayText(s.day, { weekday: 'long', day: 'numeric', month: 'long' })}`,
                s.double ? h('span.sh-chip.none', 'covered two slots') : null))),
          status,
          h('button.sh-arrow', { type: 'button', disabled: i >= shifts.length - 1, 'aria-label': 'Next shift', onclick: () => go('shift', shifts[i + 1].id) }, '›'))),
      h('div.sh-two',
        h('section.card',
          h('div.sh-cardhead', h('div', h('h2', 'The drawer'),
            h('p.sh-sub', 'From ASSD’s count at hand-over to its count at the end. Type a recount or the expense sheet’s total and the picture moves; Save keeps it.'))),
          fall, vbox,
          h('div.sh-inputs',
            h('label.field', { for: 'sh-recount' }, 'Recount the drawer (optional)', recount),
            h('label.field', { for: 'sh-sheet' }, 'Expense sheet total', sheet),
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
      exceptionsOf(s).length ? h('section.card',
        h('div.sh-cardhead', h('h2', 'What does not agree on this shift')),
        h('div.sh-exgrid', exceptionsOf(s).map(exceptionCard))) : null);
    redraw();

    function redraw() {
      const n = numbers(s);
      const dirty = (draft.recount !== undefined && draft.recount !== (r.closingFrom === 'typed' ? r.closing : null))
        || (draft.sheet !== undefined && draft.sheet !== (s.expense?.sheetTotal ?? null));
      unsaved.textContent = dirty ? 'Not saved yet' : '';
      const t = tone(s);
      mount(status, h(`span.sh-status.${t}`, { good: '✓ All agrees', warn: '! Have a look', bad: '! Needs an answer', open: 'Journal ends here' }[t]));

      const steps = [{ lab: 'Opening count', sm: r.openingFrom === 'typed' ? 'typed' : 'ASSD, at hand-over', from: 0, to: r.opening ?? 0, c: 'var(--muted)', amt: money(r.opening) }];
      let at = (r.opening ?? 0) + s.cash;
      steps.push({ lab: '+ Cash taken', sm: s.laundryCash ? `incl. ${money(s.laundryCash)} laundry` : '', from: r.opening ?? 0, to: at, c: 'var(--sh-cash)', amt: money(s.cash) });
      if (n.expenses) { steps.push({ lab: '− Expenses', sm: s.corrected ? 'counted and corrected' : n.sheetTyped && n.expenses !== s.expensesMoved ? 'counted, rest from the sheet' : 'receipts counted', from: at - n.expenses, to: at, c: 'var(--sh-expense)', amt: money(n.expenses) }); at -= n.expenses; }
      if (n.toSafe) { steps.push({ lab: '− To the safe', sm: s.corrected ? 'counted and corrected' : 'notes counted', from: at - n.toSafe, to: at, c: 'var(--sh-safe)', amt: money(n.toSafe) }); at -= n.toSafe; }
      if (n.unlabelled) { steps.push({ lab: '− Not labelled', sm: 'type the sheet total', from: at - n.unlabelled, to: at, c: 'var(--muted)', hatch: true, amt: money(n.unlabelled) }); at -= n.unlabelled; }
      steps.push({ lab: '= Should hold', from: 0, to: r.expected ?? 0, c: 'var(--ink-2)', amt: money(r.expected), total: true });
      steps.push({
        lab: 'Closing count',
        sm: n.recounted ? 'your recount' : n.closing == null ? 'not in the journal' : `ASSD, at the end${r.receiptsAtClose ? `, incl. ${money(r.receiptsAtClose)} receipts` : ''}`,
        from: 0, to: n.closing ?? 0, total: true, amt: money(n.closing),
        c: n.variance == null ? 'var(--muted)' : n.variance === 0 ? 'var(--sh-good)' : n.variance > 0 ? 'var(--sh-warn)' : 'var(--sh-bad)',
      });
      const top = Math.max(1, ...steps.map((x) => Math.max(x.from, x.to)));
      mount(fall, steps.map((x) => h(`div.sh-frow${x.total ? '.total' : ''}`,
        h('span.lab', x.lab, x.sm ? h('small', x.sm) : null),
        h('span.sh-track', h(`b.sh-seg${x.hatch ? '.hatch' : ''}`, {
          style: `left:${(Math.min(x.from, x.to) / top) * 100}%;width:${(Math.abs(x.to - x.from) / top) * 100}%;background:${x.c}`,
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
        r.handoverGap ? h('p', `This shift’s first count was ${money(Math.abs(r.handoverGap.amount))} ${r.handoverGap.amount < 0 ? 'less' : 'more'} than ${nameOf(r.handoverGap.from)}’s closing count.`) : null));

      mount(checksList, checks(s, n).map(([cls_, mark, text]) => h('li', h(`span.sh-ic.${cls_}`, String(mark)), h('span', text))));
    }
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
    else if (n.variance === 0) out.push(['good', '✓', 'The drawer agrees with the closing count']);
    else out.push([n.variance < 0 ? 'bad' : 'warn', '!', `Drawer ${n.variance > 0 ? 'over' : 'short'} by ${money(Math.abs(n.variance))}`]);
    const lines = s.lines.filter((l) => l.amount > 0);
    if (!lines.length) out.push(['info', '·', 'No card or MoMo this shift']);
    else out.push([s.cardFound === lines.length ? 'good' : 'bad', s.cardFound === lines.length ? '✓' : '!', `${s.cardFound} of ${lines.length} card and MoMo payments found`]);
    const exp = s.expense;
    if (exp?.sheetTotal != null || n.expenses) {
      const agree = exp?.sheetTotal != null && exp?.odooTotal != null && exp.sheetTotal === exp.odooTotal;
      out.push([agree ? 'good' : exp?.odooTotal != null ? 'warn' : 'info', agree ? '✓' : 'i',
        `Expenses ${money(exp?.sheetTotal ?? n.expenses)}${exp?.odooTotal != null ? ` · Odoo ${money(exp.odooTotal)}` : exp?.poNumbers ? ' · Odoo not read yet' : ' · no PO numbers yet'}`]);
    }
    if (n.sheetGap) {
      out.push(['warn', '!', `The expense sheet says ${money(n.sheet)}; the movements labelled ${money(n.expenses)} as expenses. Correct a movement below, or check the sheet.`]);
    }
    if (s.corrected) out.push(['info', 'i', 'A cash movement on this shift was corrected by hand']);
    if (s.laundry) out.push(['info', 'i', `Laundry ${money(s.laundry)}${s.laundryCash ? `, ${money(s.laundryCash)} of it in cash` : ''}`]);
    const l = s.dayLaundry;
    if (l && l.system != null && (l.assd || l.system)) {
      out.push([l.assd === l.system ? 'good' : 'warn', l.assd === l.system ? '✓' : '!',
        `Laundry for ${shortDay(s.day)}: ${money(l.assd)} in ASSD, ${money(l.system)} in the laundry system`]);
    }
    for (const m of (s.moves || []).filter((x) => x.kind === 'corrected')) {
      out.push(['info', 'i', `${money(m.amount)} moved out by mistake and put back by ${nameOf(m.reversedByUser)}`]);
    }
    const open = exceptionsOf(s).filter((x) => !x.answer && x.severity !== 'info').length;
    if (open) out.push(['bad', open, `${open} difference${open === 1 ? '' : 's'} waiting for an answer`]);
    return out;
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
      expenses: ['Expenses', 'var(--sh-expense)'], safe: ['To the safe', 'var(--sh-safe)'], split: ['Expenses + safe', 'var(--series-7)'],
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
      const base = {
        expenses: m.manual ? 'Expenses, as corrected.' : 'The receipts on the count before it.',
        safe: m.manual ? 'Cash to the safe, as corrected.' : 'The notes on the count before it.',
        split: `${money(m.expenses)} expenses and ${money(m.safe)} to the safe${m.manual ? ', as corrected' : ', as counted just before'}.`,
        part: `${money(m.expenses)} in receipts as counted; the rest has no count before it.`,
        unlabelled: 'No count before it said what it was. Correct it here, or the expense sheet total settles it.',
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
            m.manual ? h('small.sh-manual', ` Corrected by ${m.manual.by || 'somebody'}${m.manual.note ? `: ${m.manual.note}` : ''}${m.auto ? ` (ASSD's count said ${tag[m.auto]?.[0].toLowerCase() || m.auto})` : ''}.`) : null),
          h('span.sh-moveend',
            h('span.amt.num', ['corrected', 'excluded'].includes(m.kind) ? h('s', money(Math.abs(m.amount))) : m.amount < 0 ? `+${money(-m.amount)}` : money(m.amount)),
            m.kind === 'corrected' ? null : h('button.sh-link', { type: 'button', onclick: open }, 'Correct'))),
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
    const send = async (body) => {
      said.textContent = 'Saving…';
      try {
        await api('/shifts/movement', { method: 'POST', body: { seq: m.seq, note: note.value, ...body } });
        await load(banner('good', 'Movement corrected. The drawer and its exceptions are worked out again.'));
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
    return h('div.sh-fixbox',
      h('p.sh-sub', 'What did this movement really take out of the drawer?'),
      h('div.sh-fixrow', choice('Expenses', { kind: 'expenses' }, m.kind !== 'expenses'), choice('Cash to the safe', { kind: 'safe' }, m.kind !== 'safe'),
        h('span', 'or split:'), split, h('button.btn', { type: 'button', onclick: () => send({ kind: 'split', expenses: split.value }) }, 'Split')),
      pick('A duplicate of', twins, 'duplicate'),
      pick('Put back by', elsewhere(-m.amount), 'reverses'),
      h('div.sh-fixrow', note, said));
  }

  function odooBlock(s) {
    if (!s.drawerOut && !s.expense) return null;
    const exp = s.expense || {};
    const pos = h('input', { id: 'sh-pos', type: 'text', value: exp.poNumbers || '', placeholder: 'P00412, P00413' });
    const said = h('span.small');
    const orders = exp.odoo?.orders || [];
    const unknown = exp.odoo?.unknown || [];
    const sheet = exp.sheetTotal;
    const odoo = exp.odooTotal;
    const verdict = sheet == null || odoo == null ? null
      : sheet === odoo ? `The expense sheet and Odoo agree at ${money(sheet)}.`
        : `The expense sheet says ${money(sheet)} and Odoo says ${money(odoo)}: ${money(Math.abs(sheet - odoo))} ${sheet > odoo ? 'is not in Odoo' : 'more in Odoo than on the sheet'}.`;
    return h('div.sh-odoo',
      h('p.sh-sub', 'The Odoo purchase orders behind this shift’s expenses. Insight reads each order (vendor, total, state) without changing anything in Odoo.'),
      h('div.sh-inputs',
        h('label.field', { for: 'sh-pos' }, 'Odoo PO numbers', pos),
        h('div', h('button.btn.primary', {
          type: 'button',
          onclick: async () => {
            said.textContent = 'Saving and asking Odoo…';
            const draftSheet = drafts[s.id]?.sheet;
            try {
              await api('/shifts/expense', {
                method: 'POST',
                body: { day: s.day, slot: s.slot, sheetTotal: cedis(draftSheet !== undefined ? draftSheet : sheet), poNumbers: pos.value, pull: true },
              });
              await load();
            } catch (err) { said.textContent = err.message; }
          },
        }, 'Save and read from Odoo'), ' ', said)),
      orders.length ? table([
        { label: 'PO', get: (o) => o.name },
        { label: 'Vendor (Odoo)', get: (o) => o.vendor },
        { label: 'Total', num: true, get: (o) => money(o.total), foot: (list) => money(list.reduce((t, o) => t + o.total, 0)) },
        { label: 'State', get: (o) => `${o.state}${o.billed ? ` · ${o.billed.replace(/_/g, ' ')}` : ''}` },
        { label: 'Ordered', get: (o) => o.orderedOn || '' },
      ], orders, { footer: orders }) : null,
      unknown.length ? banner('warning', `Odoo does not know ${unknown.join(', ')}. Check the numbers.`) : null,
      verdict ? h('p', verdict) : null,
      exp.pulledAt ? h('p.small.muted', `Read from Odoo ${String(exp.pulledAt).slice(0, 16)}.`) : null);
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
      case 'movement-corrected': return `${nameOf(x.by)} moved ${money(x.amount)} out and ${nameOf(x.reversedBy)} put it back (ASSD ${x.reversedSeq}). It nets to nothing.`;
      case 'movement-twice': return `${money(x.amount)} was moved out of the drawer twice (ASSD ${x.pair} and ${x.seq}), and the drawer counted over. If the second never moved any cash, match it as a duplicate.`;
      case 'movement-reversal': return `${money(x.amount)} was put back into the drawer (ASSD ${x.seq}). It matches ASSD ${x.pair}, moved out on ${nameOf(x.pairShift?.user)}’s ${SLOT[x.pairShift?.slot]?.label.toLowerCase() || ''} shift of ${shortDay(x.pairShift?.day)}. If one undoes the other, match them: both are left out.`;
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
    if (x.kind === 'failed') return box(['Terminal', h('b', { style: 'color:var(--sh-bad-ink)' }, 'Declined')], 'vs', ['ASSD', h('b', 'Paid')]);
    if (x.kind === 'movement-corrected') return box(['Keyed', h('b', h('s', whole(x.amount)))], '→', ['Put back by', h('b', nameOf(x.reversedBy))]);
    return null;
  }

  function exceptionCard(x) {
    const sev = x.severity === 'critical' ? 'bad' : x.severity === 'warning' ? 'warn' : 'info';
    const [title, mark] = KIND[x.kind] || [x.kind, '!'];
    const note = h('input', { type: 'text', maxlength: '600', placeholder: 'What happened (optional)', value: x.answer?.note || '' });
    const said = h('span.small');
    const answer = async (value) => {
      said.textContent = 'Saving…';
      try {
        await api('/shifts/answer', { method: 'POST', body: { key: x.key, answer: value, note: value ? note.value : '' } });
        await load();
      } catch (err) { said.textContent = err.message; }
    };
    return h(`article.sh-ex.${sev}${x.answer ? '.done' : ''}`,
      h('div.hd', h('span.sq', mark), h('h3', title), h('span.amt.num', money(Math.abs(x.amount ?? 0)))),
      h('div.sh-meta',
        x.user ? [avatar(x.user), h('b', nameOf(x.user))] : null,
        x.day ? h('span', dayText(x.day)) : null,
        x.slot ? h('span', SLOT[x.slot].label.toLowerCase()) : null,
        x.seqs ? h('span', `ASSD ${x.seqs.join(', ')}`) : x.seq ? h('span', `ASSD ${x.seq}`) : null),
      evidence(x),
      h('p', describe(x)),
      x.slot && byId.has(`${x.day}|${x.slot}`) && section !== 'shift'
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
      x.severity === 'info' && !x.answer ? h('div.sh-done', h('span', { style: 'color:var(--ink-2)' }, 'Explained by the rules; no answer needed'))
        : x.answer ? h('div.sh-done',
          h('span', `✓ ${x.answer.answer}${x.answer.note ? `: ${x.answer.note}` : ''} (${x.answer.by})`),
          h('button.sh-link', { type: 'button', onclick: () => answer('') }, 'Change'))
          : h('div.sh-answers', note, ANSWERS.map((a) => h('button', { type: 'button', onclick: () => answer(a) }, a)), said));
  }

  function exceptionsView(v) {
    const all = data.exceptions;
    const need = all.filter((x) => x.severity !== 'info');
    const done = need.filter((x) => x.answer).length;
    const frac = need.length ? done / need.length : 1;
    const groups = data.groups.filter((g) => all.some((x) => x.group === g.id));
    const shown = all
      .filter((x) => filter === 'all' || x.group === filter)
      .filter((x) => showAnswered || !x.answer || x.severity === 'info')
      .sort((a, b) => (Boolean(a.answer) - Boolean(b.answer))
        || ['critical', 'warning', 'info'].indexOf(a.severity) - ['critical', 'warning', 'info'].indexOf(b.severity)
        || (a.day < b.day ? 1 : -1));
    const ring = svg('svg.sh-ring', { viewBox: '0 0 64 64', 'aria-hidden': 'true' },
      svg('circle', { cx: 32, cy: 32, r: 26, stroke: 'var(--surface-2)' }),
      svg('circle', { cx: 32, cy: 32, r: 26, stroke: 'var(--sh-good)', 'stroke-linecap': 'round', 'stroke-dasharray': `${163.4 * frac} 163.4`, transform: 'rotate(-90 32 32)' }));
    mount(v,
      h('section.card',
        h('div.sh-progress', ring,
          h('div', { style: 'flex:1;min-width:220px' },
            h('h2', { style: 'margin:0' }, `${done} of ${need.length} answered`),
            h('p.sh-sub', 'Everything that does not agree, grouped by what went wrong. Grey ones the rules explained by themselves: look them over, no answer needed.')),
          done ? h('label.check', h('input', { type: 'checkbox', checked: showAnswered, onchange: (e) => { showAnswered = e.target.checked; paint(); } }), ` Show the ${done} answered`) : null),
        h('div.sh-filters',
          h('button', { type: 'button', 'aria-pressed': String(filter === 'all'), onclick: () => { filter = 'all'; paint(); } }, 'All ', h('b', String(all.length))),
          groups.map((g) => h('button', { type: 'button', 'aria-pressed': String(filter === g.id), onclick: () => { filter = g.id; paint(); } },
            h('i', { style: `background:${SEVERITY_COLOUR[g.severity]}` }), g.title.split(/[:—]/)[0].trim(), ' ', h('b', String(all.filter((x) => x.group === g.id).length)))))),
      shown.length ? h('div.sh-exgrid', shown.map(exceptionCard))
        : h('section.card', h('p', '✓ Nothing waiting here. Every card and MoMo payment and every drawer count in these days agrees, or has an answer.')));
  }

  // ------------------------------------------------------------ people --

  function peopleView(v) {
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
      }))));
  }

  // ------------------------------------------------------------- files --

  function filesView(v) {
    const c = data.coverage || {};
    const last = (kind) => data.uploads.find((u) => u.kind === kind);
    const FILES = [
      { kind: 'journal', title: 'ASSD detail journal', ext: 'PDF', colour: 'var(--series-8)', accept: '.pdf,application/pdf', cover: c.journal,
        what: '“Detail Journal of every Transaction”, printed to PDF. Run it one day past the last shift you want. Guest names and addresses are removed on this computer before anything is sent.' },
      { kind: 'terminal', title: 'Card terminal report', ext: 'CSV', colour: 'var(--series-1)', accept: '.csv,text/csv', cover: c.terminal,
        what: 'The CSV from the bank’s card portal: every tap, approved or declined, to the second.' },
      { kind: 'bank', title: 'GTBank statement', ext: 'XLS', colour: 'var(--series-6)', accept: '.xls,.xlsx,.htm,.html', cover: c.bank,
        what: 'The .xls from internet banking (the Finacle XLSX works too). Card settlements, MoMo and commission are read; salaries and suppliers stay on this computer.' },
    ];

    const drop = (f) => {
      const said = h('p.small');
      const input = h('input', { type: 'file', accept: f.accept });
      const card = h('div.sh-drop', { style: `--fc:${f.colour}` },
        h('span.fi', f.ext), h('h3', f.title), h('p', f.what),
        h('p', { style: 'color:var(--muted)' }, f.cover ? `Loaded: ${shortDay(f.cover.from)} to ${shortDay(f.cover.to)}` : 'Nothing loaded yet.'),
        last(f.kind) ? h('p', { style: 'color:var(--muted)' }, `Last: ${last(f.kind).name || 'a file'}, ${String(last(f.kind).at).slice(0, 16)} by ${last(f.kind).by}. ${last(f.kind).note || ''}`) : null,
        data.canUpload ? h('label.go', input, 'Choose the file') : h('p', { style: 'color:var(--muted)' }, 'An owner loads this file.'),
        said);
      const run = async (file) => {
        if (!file || !data.canUpload) return;
        input.disabled = true;
        said.className = 'small';
        said.textContent = 'Reading the file on this computer…';
        try {
          let result;
          if (f.kind === 'journal') {
            const { lines, pages } = await readJournalPdf(file, (t) => { said.textContent = t; });
            said.textContent = `Read ${pages} pages. Sending the amounts to Insight…`;
            result = await api('/shifts/journal', { method: 'POST', body: { lines, name: file.name } });
          } else if (f.kind === 'bank') {
            const { rows, leftOut } = await readStatement(file);
            said.textContent = `Sending ${num(rows.length - 1)} card and MoMo rows to Insight…`;
            result = await api('/shifts/bank', { method: 'POST', body: { rows, leftOut, name: file.name } });
          } else {
            const { text } = await readTerminalCsv(file);
            result = await api('/shifts/terminal', { method: 'POST', body: { text, name: file.name } });
          }
          await load(banner('good', h('strong', `${file.name} loaded. `), result.note || ''));
        } catch (err) {
          said.className = 'small form-error';
          said.textContent = err.message;
          input.disabled = false;
        }
      };
      input.addEventListener('change', () => run(input.files?.[0]));
      if (data.canUpload) {
        card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('over'); });
        card.addEventListener('dragleave', () => card.classList.remove('over'));
        card.addEventListener('drop', (e) => { e.preventDefault(); card.classList.remove('over'); run(e.dataTransfer?.files?.[0]); });
      }
      return card;
    };

    // Coverage over the month the window ends in.
    const end = range.to;
    const y = Number(end.slice(0, 4));
    const m = Number(end.slice(5, 7));
    const length = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const monthDays = Array.from({ length }, (_, k) => `${end.slice(0, 7)}-${String(k + 1).padStart(2, '0')}`);
    const inCover = (cover, d) => cover && d >= cover.from && d <= cover.to;
    const cover = h('div.sh-cover', { style: `grid-template-columns: 8rem repeat(${length}, minmax(0, 1fr))` },
      h('span'), monthDays.map((d) => h('span.h', String(Number(d.slice(8))))),
      FILES.map((f) => [h('span', f.title.replace('ASSD detail ', 'ASSD ').replace('Card terminal report', 'Terminal')),
        monthDays.map((d) => h('span.d', { title: shortDay(d), style: inCover(f.cover, d) ? `background:${f.colour}` : '' }))]));

    mount(v,
      h('p.sh-sub', 'Files are opened on this computer. Only amounts, times and ASSD user names are sent. Loading the same file twice changes nothing; a newer one updates the days it covers. You can also drop a file on its box.'),
      h('div.sh-files', FILES.map(drop)),
      h('section.card',
        h('div.sh-cardhead', h('div', h('h2', `What ${dayText(end, { month: 'long', year: 'numeric' })} has so far`),
          h('p.sh-sub', 'Which days each file covers. A shift is fully checked only where all three overlap.'))),
        h('div', { style: 'overflow-x:auto' }, cover)));
  }

  // Last, once every helper above exists: the first read and paint.
  await load();
}
