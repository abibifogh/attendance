import { add, h, mount, money, num, shortDay, s as svg } from '../util.js';
import { api } from '../api.js';
import { table, banner } from './components.js';
import { filesPanel } from './files.js';
import { tillViews } from './till.js';
import { todoDetail, todoSub, todoTitle, todoAge } from './todo.js';
import { advanceDetail, advanceStatus, advanceOpen, advanceWhen, elsewhereCard } from './advances.js';
import { state } from '../app.js';
import { npReviewBox } from './np-review.js';
import { proofBox, sendCard } from './proof.js';
import { COLUMNS as DIFF_COLUMNS, monthLines, byPerson, toCsv, columnOf, signedAmount } from '../difftable.js';
import { LAYOUTS as RECON_LAYOUTS, reportHtml, fileName as reconFile } from '../recon.js';

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
 * - **Closing reports**: every report from HIVE and the shift it is on, the
 *   ones that look misplaced picked out, each movable to another shift.
 * - **Files** and **Settings**. The safe book is under Money › Safe.
 *
 * Every state is shown as a word or an icon as well as a colour.
 */

const SLOTS = ['morning', 'afternoon', 'night'];
const SLOT = {
  morning: { label: 'Morning', hours: '06:00–14:00', start: 6 },
  afternoon: { label: 'Afternoon', hours: '14:00–22:00', start: 14 },
  night: { label: 'Night', hours: '22:00–06:00', start: 22 },
};
// For one payment seen twice: the laundry's card payment on the hotel's terminal.
const PAIR_ANSWERS = ['Keyed in ASSD now', 'Staff reminded', 'Explained', 'Not the same payment'];
/** A guest who paid more: owed back, kept for later, keyed short, or two payments after all. */
const REFUND_DUE = 'Refund due to the guest';
const PAID_MORE_ANSWERS = [REFUND_DUE, 'Deposit for a later stay', 'Keyed short in ASSD', 'Not the same payment'];
/** A guest who paid less: owes the rest, paid it another way, ASSD keyed too high, or two payments after all. */
const PAID_LESS_ANSWERS = ['Guest owes, chasing', 'Rest paid another way', 'Keyed too high in ASSD', 'Not the same payment'];
/** Quick reasons for putting a difference on somebody's account; the box takes the rest. */
const MOVE_REASONS = ['Both held the drawer', 'Handed over without counting', 'Covered this shift', 'Agreed with them'];
const MOVABLE = new Set(['drawer-short', 'drawer-over', 'handover-gap']);
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
  'keyed-no-cash': ['Keyed as cash, but the drawer did not move', '≡'],
  'expense-no-po': ['Expenses with no PO', '#'],
  'receipts-swapped': ['Receipts swapped for cash', '✓'],
  'receipts-unclear': ['Receipts handed in: all, or only some?', '?'],
  'laundry-card': ['Laundry paid by card, not in ASSD', 'L'],
  'paid-more': ['The guest paid more than ASSD shows', '+'],
  'paid-less': ['The guest paid less than ASSD shows', '−'],
  'receipts-carried': ['Receipts still in the count after a movement: stayed, or new?', '?'],
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
const TABS = [['shifts', 'Shifts'], ['inbox', 'Inbox'], ['people', 'People'], ['reports', 'Closing reports'], ['files', 'Files'], ['settings', 'Settings']];
/** Where a tab of the old screen now lives, for a saved choice from before. */
const MOVED = {
  day: 'shifts', week: 'shifts', month: 'shifts', shift: 'shifts', closing: 'shifts',
  exceptions: 'inbox', stays: 'inbox', todo: 'inbox', answers: 'inbox', approvals: 'inbox',
  // The safe book is under Money now.
  safe: 'shifts',
};
const PERIODS = ['day', 'week', 'month'];
/** The Inbox's kinds, in the order the chips show them. */
const INBOX_KINDS = [['drawer', 'Drawer'], ['bank', 'Card & bank'], ['po', 'POs'], ['advance', 'Advances'], ['stay', 'Unpaid stays'], ['admin', 'Waiting for admin'],
  ['task', 'To-do'], ['np', 'Nice Place'], ['proof', 'Proof asked'], ['odoo', 'Odoo'], ['mine', '✓ Mine in Odoo']];
/** What Odoo calls the records activities sit on, in words. */
const ODOO_MODELS = { 'purchase.order': 'Purchase order', 'account.move': 'Bill or invoice', 'res.partner': 'Contact', 'stock.picking': 'Transfer', 'hr.employee': 'Employee', 'crm.lead': 'Lead' };
const odooWhat = (a) => `${ODOO_MODELS[a.model] || a.model}${a.resName ? ` ${a.resName}` : ''}`;
const odooTitle = (a) => a.summary || `${a.type || 'Activity'}${a.resName ? ` ${a.resName}` : ''}`;
const odooWhen = (a) => (a.state === 'overdue' ? `${a.late} day${a.late === 1 ? '' : 's'} late` : a.state === 'today' ? 'Today' : 'Planned');
/** Exception groups about the drawer; the rest are card, MoMo and the bank. */
const DRAWER_GROUPS = new Set(['drawer', 'unlabelled', 'laundry']);

/** Day arithmetic on `YYYY-MM-DD`, at noon UTC so no clock change moves it. */
const plusDays = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekdayOf = (day) => (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
const monthStart = (day) => `${day.slice(0, 7)}-01`;
const monthEnd = (day) => { const d = new Date(`${monthStart(day)}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1, 0); return d.toISOString().slice(0, 10); };
const plusMonths = (day, n) => { const d = new Date(`${monthStart(day)}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

/** The days a period covers, and what to call it. Weeks run Monday to Sunday, as the rota does. */
function periodOf(mode, anchor, dates = null) {
  if (mode === 'dates' && dates) {
    return { from: dates.from, to: dates.to, label: `${shortDay(dates.from)} to ${shortDay(dates.to)} ${dates.to.slice(0, 4)}` };
  }
  if (mode === 'day') {
    return { from: anchor, to: anchor, label: new Date(`${anchor}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) };
  }
  if (mode === 'month' || mode === 'table') {
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
/** Stretches of still counts, joined where one ends at the count the next starts from: "571 from ASSD 217106 to 217138". */
function stillRuns(spans) {
  const runs = [];
  for (const p of spans) {
    const last = runs[runs.length - 1];
    if (last && last.to === p.from) { last.to = p.to; last.notes.add(p.notesAfter); } else runs.push({ from: p.from, to: p.to, notes: new Set([p.notesBefore, p.notesAfter]) });
  }
  return runs.map((r) => `${[...r.notes].map((n) => money(n)).join(' / ')} from ASSD ${r.from} to ${r.to}`);
}
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

/**
 * Which parts of Shifts somebody may open: an admin, all of them; a
 * supervisor, what an admin gave them under Settings. Insight's menu asks
 * this too, so it only offers the parts a person will get.
 */
export function shiftsParts(till) {
  const who = till || { role: 'admin', access: {} };
  const admin = who.role === 'admin';
  const may = (area, level = 1) => admin || (who.access?.[area] || 0) >= level;
  const can = inboxSources(who);
  return {
    shifts: PERIODS.some((p) => may(p)) || may('money'),
    inbox: Object.values(can).some(Boolean),
    people: may('net') || may('answers'), reports: may('reports'), files: may('files'), settings: admin,
  };
}

/** What each source of the Inbox needs. */
function inboxSources(who) {
  const admin = who.role === 'admin';
  const may = (area, level = 1) => admin || (who.access?.[area] || 0) >= level;
  return {
    exceptions: may('bank') || may('moves'), stays: may('unpaid'), todo: admin || who.role === 'supervisor',
    answers: may('answers'), advances: may('advances'), approvals: admin, niceplace: may('niceplace'),
  };
}

/**
 * `section` opens one part, the rest reached from Insight's menu rather than
 * tabs here; `onSection` is told when a click moves to another part (a shift
 * opened from the Inbox), so the menu and the address follow.
 */
export async function renderShifts(root, { range, section: only = null, onSection = null, settingsParts = null }) {
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
  // The drawer's own exceptions follow "Correct cash movements" as well as the
  // bank; card and bank lines follow the bank alone.
  const CASH_GROUPS = new Set(['drawer', 'unlabelled', 'nopo', 'laundry', 'explained']);
  const seesEx = (x) => may('bank') || (may('moves') && CASH_GROUPS.has(x.group));
  const actsOn = (x) => may('bank', 2) || (may('moves', 2) && CASH_GROUPS.has(x.group));
  const periods = PERIODS.filter((p) => may(p));
  const can = inboxSources(who);
  const allowed = shiftsParts(who);
  const views = TABS.filter(([id]) => allowed[id]);
  let section = only || store.get('section', 'shifts');
  section = MOVED[section] || section;
  if (!views.some(([id]) => id === section)) section = views[0]?.[0] || 'shifts';
  // Day, week or month, and the day it is anchored on. The anchor follows the
  // window chosen at the top of Insight until somebody moves it here.
  // Or any days somebody chooses, From and To: as many as a month for whoever
  // may see a month, a week for whoever may see a week.
  const longest = may('month') ? 62 : may('week') ? 7 : 0;
  // Table: the month's differences as a table, beside the calendar, for whoever may see a month.
  const choices = [...(longest ? [...periods, 'dates'] : periods), ...(may('month') ? ['table'] : [])];
  let mode = store.get('mode', 'week');
  if (!choices.includes(mode)) mode = periods.includes('week') ? 'week' : periods[0] || 'week';
  let anchor = store.get('anchorFor', '') === range.to ? store.get('anchor', range.to) : range.to;
  let dates = (() => {
    const [from, to] = String(store.get('dates', '')).split('|');
    return /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to ? { from, to } : { from: plusDays(anchor, -6), to: anchor };
  })();
  const periodNow = () => periodOf(mode, anchor, dates);
  const spanOf = (d) => Math.round((Date.parse(`${d.to}T12:00:00Z`) - Date.parse(`${d.from}T12:00:00Z`)) / 86400000) + 1;
  let period = periodNow();
  let jumped = false;
  let currentId = store.get('shift', null);
  // A shift opened from the period: its story fills the Shifts tab until Back.
  let detail = false;
  // Stepping past the first or last shift on screen: the next days are read, and their first (1) or last (-1) shift opened.
  let edge = 0;
  // Exceptions ticked to reconcile together, kept as they were when ticked,
  // so a tick on another day or week stays while the next one is found
  // (a supervisor may only open one day at a time).
  const picked = new Set();
  // The difference whose "Put on a staff account" panel is open, and HIVE's people, read once.
  let moving = null;
  let staff = null;
  const pickedAs = new Map();
  // What is being typed and not yet saved, per shift: a recount.
  const drafts = {};

  const till = tillViews({ who, period: () => period, describeKey });

  // The Inbox: which kind is shown, which item is open, whether done ones show.
  const inbox = { kind: 'all', open: null, at: 0, showDone: false, ticked: new Set(), elsewhere: {} };
  // Opened from a to-do's email: that to-do, once the to-dos are read; or
  // why it is not here (another account's, or done).
  // Kept until used: the screen is drawn twice on arriving by a link.
  let wantTodo = store.get('opentodo', '') || null;
  let todoMissing = null;
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
  const sources = { todo: null, tasks: null, advances: null, till: null, refunds: null, odoo: null, np: null, proof: null, drawerPos: null };
  let askOdoo = false;
  function readStays() {
    if (!can.stays) return Promise.resolve(null);
    return api('/stays').then((d) => { stays = d; return d; });
  }
  async function readInbox(force = false) {
    const quiet = (p) => p.catch(() => null);
    await Promise.all([
      can.stays ? quiet(readStays()) : null,
      can.todo ? quiet(api(`/todo${inbox.showDone ? '?closed=1' : ''}`).then((d) => { sources.todo = d; })) : null,
      can.todo ? quiet(api(`/shifts/tasks${inbox.showDone ? '?done=1' : ''}`).then((d) => { sources.tasks = d; })) : null,
      can.advances ? quiet(api('/advances').then((d) => { sources.advances = d; })) : null,
      can.answers || can.approvals ? quiet(till.read(force).then((d) => { sources.till = d; })) : null,
      may('bank') ? quiet(api('/shifts/refunds').then((d) => { sources.refunds = d; })) : null,
      can.niceplace ? quiet(api('/np/pending').then((d) => { sources.np = d; })) : null,
      // POs made in Insight that staff want to pay from a drawer: for an admin to allow.
      admin ? quiet(api('/po/drawer').then((d) => { sources.drawerPos = d; })) : null,
      // Proof an admin asked of this person, for an answer they gave.
      quiet(api('/proof/mine').then((d) => { sources.proof = d; })),
      // Odoo's activities: everyone's for an admin, one's own once linked, and those on POs with Odoo shared.
      // Odoo itself is asked again only on Refresh now; otherwise at most every ten minutes.
      quiet(api(`/odoo/activities${askOdoo ? '?force=1' : ''}`).then((d) => { sources.odoo = d; askOdoo = false; })),
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
      mode === 'dates' ? null : periodOf(mode, mode === 'day' ? plusDays(anchor, -1) : mode === 'week' ? plusDays(anchor, -7) : plusMonths(anchor, -1))].filter(Boolean);
    setTimeout(() => { for (const p of others) fetchPeriod(p).catch(() => {}); }, 400);
  }

  /**
   * Show the period. `cached` for moving around, where a period already read
   * is shown as it was; without it, everything is read again, because
   * something has just changed.
   */
  async function load(notice = null, { cached = false, inboxRead = false } = {}) {
    period = periodNow();
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
    if (edge) {
      currentId = (edge > 0 ? shifts[0] : shifts[shifts.length - 1])?.id || null;
      edge = 0;
    }
    if (!byId.has(currentId)) {
      // The latest shift with something to answer, else the latest shift.
      const flagged = [...shifts].reverse().find((s) => tone(s) === 'bad');
      currentId = (flagged || shifts[shifts.length - 1])?.id || null;
    }
    paint(notice);
    readAhead();
    // Something changed: the Inbox's own lists too (what waits for an admin,
    // to-dos, staff answers), so what was just decided leaves them at once.
    if (!cached && !inboxRead && data) {
      const counted = () => inboxItems().filter((x) => x.counts).length;
      const before = counted();
      readInbox(true).then(() => { if (view.isConnected && (section === 'inbox' || counted() !== before)) paint(notice); }).catch(() => {});
    }
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
    if (PERIODS.includes(next) || next === 'dates' || next === 'table') {
      section = 'shifts';
      detail = false;
      store.set('section', section);
      if (choices.includes(next) && (next !== mode || (day && day !== anchor))) {
        mode = next;
        if (day) anchor = day;
        if (mode === 'dates') anchor = dates.to;
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

  /** Open one shift, reading its days first when they are not on screen. */
  function openShift(day, slot) {
    const id = `${day}|${slot}`;
    if (byId.has(id)) return go('shift', id);
    currentId = id;
    store.set('shift', id);
    section = 'shifts';
    detail = true;
    store.set('section', section);
    anchor = day;
    remember();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return load(null, { cached: true });
  }

  /**
   * Open the shift something waiting for an admin is about: an exception by
   * its key, or an ASSD line (`seq:N`). Keys that name their day and shift
   * open it directly; one that names only a line is found by the shift whose
   * ASSD numbers run around it.
   */
  async function openWhere(key, button = null, dayHint = null) {
    const fail = (text) => { if (button) { button.textContent = text; button.disabled = true; } };
    try {
      const p = await placeOf(key, dayHint);
      if (p.error) return fail(p.error);
      if (p.slot) return openShift(p.day, p.slot);
      mode = 'day';
      return moveTo(p.day);
    } catch (err) { return fail(err.message); }
  }

  /**
   * Where an exception is: its day and shift, from the days on screen, its
   * key, or (a line, or money with no line) asked of the server. A bank line
   * with no time has a day but no shift. `{ error }` when it cannot be placed.
   */
  async function placeOf(key, dayHint = null) {
    const k = String(key);
    const known = data?.exceptions?.find((x) => x.key === k && x.day && x.slot);
    if (known) return { day: known.day, slot: known.slot };
    const named = /^[a-z-]+:(\d{4}-\d{2}-\d{2}):(morning|afternoon|night)\b/.exec(k);
    if (named) return { day: named[1], slot: named[2] };
    // Money with no ASSD line: a terminal card (t:) or a bank line (b:), placed by its time.
    if (/(?:^|:)[tb]:[^:]+$/.test(k)) {
      const w = await api(`/shifts/where?key=${encodeURIComponent(k)}`);
      return w.day ? { day: w.day, slot: w.slot || null } : { error: 'Not in the files loaded' };
    }
    const line = /^(?:seq|[a-z-]+):(\d+)(?::\d+)?$/.exec(k);
    if (!line) return { error: 'Shift not known' };
    const seq = Number(line[1]);
    const day = dayHint || (await api(`/shifts/where?seq=${seq}`)).day;
    if (!day) return { error: 'Not in the journal' };
    // A night's lines after midnight carry the next day's date.
    const d = await fetchPeriod({ from: plusDays(day, -1), to: day });
    const s = d.days.flatMap((x) => x.shifts).find((x) => x.startSeq <= seq && seq <= x.endSeq);
    return s ? { day: s.day, slot: s.slot } : { error: 'Shift not found' };
  }

  /**
   * The shift an answer is about, in brief, beside the answer: who was on and
   * when, what does not agree and why it was raised, and how the drawer, card
   * and MoMo stand. Read in the background; Open the shift stays for the rest.
   */
  function shiftBrief(key, dayHint = null) {
    const box = h('div.sh-brief', h('span.small', 'Reading the shift…'));
    (async () => {
      const p = await placeOf(key, dayHint);
      if (p.error) { mount(box, h('span.small', `${p.error}: open the shift to look.`)); return; }
      const d = await fetchPeriod({ from: p.day, to: p.day });
      const s = p.slot ? d.days.flatMap((x) => x.shifts).find((x) => x.day === p.day && x.slot === p.slot) : null;
      const x = d.exceptions.find((o) => o.key === String(key)) || data?.exceptions?.find((o) => o.key === String(key)) || null;
      const r = s?.register || {};
      const fig = (label, value) => h('span.sh-brief-fig', h('small', label), h('b.num', value));
      mount(box,
        h('div.sh-brief-hd',
          s ? [avatar(s.user), h('b', nameOf(s.user))] : null,
          h('span', `${dayText(p.day)}${p.slot ? ` · ${SLOT[p.slot].label} ${SLOT[p.slot].hours}` : ' · no time given'}`),
          s?.open ? h('span.sh-chip.none', 'ends here') : null),
        x ? h('div.sh-brief-what',
          h('b', `${(KIND[x.kind] || [x.kind])[0]}${x.amount != null ? ` · ${money(Math.abs(x.amount))}` : ''}`),
          h('p', describe(x)),
          evidence(x)) : null,
        s ? h('div.sh-brief-figs',
          fig('Cash in ASSD', whole(s.cash)),
          h('span.sh-brief-fig', h('small', 'Drawer'), chip(r.variance ?? r.varianceSign, s.open, Boolean(drawerSettled(s)))),
          s.cardLines ? fig('Card and MoMo', `${s.cardFound + (s.cardAnswered || 0)} of ${s.cardLines} found`) : fig('Card and MoMo', 'none'),
          r.expenses != null ? fig('Expenses', whole(r.expenses)) : null,
          fig('Still to answer', String(exceptionsOf2(d, s).length))) : null);
    })().catch((err) => mount(box, h('span.small', err.message)));
    return box;
  }
  /** Unanswered exceptions on a shift, in a period read for it. */
  const exceptionsOf2 = (d, s) => d.exceptions.filter((x) => x.day === s.day && x.slot === s.slot && !x.answer && x.severity !== 'info');

  function remember() {
    store.set('mode', mode);
    store.set('anchor', anchor);
    store.set('anchorFor', range.to);
    store.set('dates', `${dates.from}|${dates.to}`);
  }

  /** Day, week, month or chosen dates, staying on the tab somebody is on. */
  function setMode(next) {
    if (next === mode || !choices.includes(next)) return undefined;
    mode = next;
    if (mode === 'dates') anchor = dates.to;
    remember();
    return load(null, { cached: true });
  }

  /** Move the period: a day, a week or a month at a time, or to a given day. */
  function moveTo(day, notice = null, { cached = true } = {}) {
    anchor = day;
    remember();
    return load(notice, { cached });
  }
  const step = (n) => {
    if (mode === 'dates') {
      const by = spanOf(dates) * n;
      dates = { from: plusDays(dates.from, by), to: plusDays(dates.to, by) };
      return moveTo(dates.to);
    }
    return moveTo(mode === 'day' ? plusDays(anchor, n) : mode === 'week' ? plusDays(anchor, 7 * n) : plusMonths(anchor, n));
  };

  // ------------------------------------------------------------- facts --

  const exceptionsOf = (s) => data.exceptions.filter((x) => x.day === s.day && x.slot === s.slot);
  /** "7 of 9 card and MoMo found", with those whose difference was answered. */
  const cardText = (s, word = '') => `${s.cardFound} of ${s.cardLines} card and MoMo${word} found${s.cardAnswered ? `, ${s.cardAnswered} answered` : ''}`;
  // A locked day's differences can no longer be answered: not in the Inbox.
  const waiting = () => data.exceptions.filter((x) => x.severity !== 'info' && !x.answer && !x.locked);

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
    // Expenses with no PO the big safe paid are not the drawer's.
    const expenses = s.expensesMoved + fromSheet - (r.fromSafe || 0);
    const toSafe = s.safeMoved + (sheet != null ? s.unlabelledMoved - fromSheet : 0);
    const unlabelled = sheet != null ? 0 : s.unlabelledMoved;
    const sheetGap = sheet != null && sheet !== expenses ? sheet - expenses : null;
    const variance = r.expected != null && closing != null ? closing - r.expected : null;
    const recounted = d.recount !== undefined ? d.recount != null : r.closingFrom === 'typed';
    return { ...r, closing, expenses, toSafe, unlabelled, variance, recounted, sheetTyped: sheet != null, sheet, sheetGap };
  }

  /** The drawer's own difference, once answered or reconciled with others: settled, whatever its size. */
  const drawerSettled = (s) => exceptionsOf(s).find((x) => x.key === `drawer:${s.day}:${s.slot}`)?.answer || null;
  const settledWords = (a) => (a.link ? 'reconciled with others' : `answered: ${a.answer}`);

  function tone(s) {
    if (s.open) return 'open';
    // What the rules explained needs nobody, whatever the drawer says.
    const open = exceptionsOf(s).filter((x) => !x.answer && x.severity !== 'info');
    const v = s.register?.variance ?? s.register?.varianceSign;
    if (open.some((x) => x.severity === 'critical')) return 'bad';
    if (v != null && v < 0 && open.length) return 'bad';
    if (open.some((x) => x.severity === 'warning') || (v && open.length)) return 'warn';
    return 'good';
  }

  /**
   * Checked or not, on the tiles, cards and calendar bars of a view, once the
   * checks are read: a checked shift is locked, so it says 🔒.
   */
  function fillChecks(root) {
    till.checks().then((map) => {
      for (const el of root.querySelectorAll('.sh-ck[data-k]')) {
        const st = map.get(el.dataset.k);
        if (!st) continue;
        el.className = `sh-ck ${st}`;
        el.textContent = { ok: '🔒 Checked', changed: '🔒 Changed since checked', wait: 'Not checked' }[st];
        el.title = st === 'wait' ? '' : 'Checked, so locked: undo the check on the shift to change anything on it.';
      }
      for (const el of root.querySelectorAll('.sh-mslot[data-k]')) {
        const st = map.get(el.dataset.k);
        if ((st === 'ok' || st === 'changed') && !el.classList.contains('locked')) { el.classList.add('locked'); el.textContent += ' 🔒'; el.title += ' · checked and locked'; }
      }
    }).catch(() => {});
  }

  const avatar = (user, large = false) => h(`span.sh-av${large ? '.lg' : ''}`, { style: `--pc:${colours[user] || 'var(--sh-info)'}` }, (user || '?')[0]);
  const chip = (v, open, settled = false) => (open ? h('span.sh-chip.none', 'ends here')
    : v == null ? h('span.sh-chip.none', 'no count')
      : v === 0 ? h('span.sh-chip.ok', '✓ agrees')
        : settled ? h('span.sh-chip.ok', { title: 'Answered or reconciled' }, data.redacted ? '✓ settled' : `✓ ${v > 0 ? '+' : '−'}${whole(Math.abs(v))}`)
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

  let said = only;
  function paint(notice = null) {
    if (onSection && section !== said) { said = section; onSection(section); }
    const has = shifts.length > 0;
    const v = h('div.sh-view');
    const people = new Set(shifts.map((s) => s.user)).size;
    mount(view,
      notice,
      // The title, tabs and period on a dark band of their own, so they read
      // apart from Insight's top bar above them.
      // Settings and files on a page of their own need no title, count or period.
      only && ['settings', 'files'].includes(section) ? null : h('div.sh-band',
      h('div.sh-head',
        // A part on its own page has its title over it, from Insight's menu.
        only ? null : h('h1', 'Shifts'),
        h('span.sh-count', has ? `${shifts.length} shift${shifts.length === 1 ? '' : 's'} · ${people} ${people === 1 ? 'person' : 'people'}` : 'No shifts loaded for these days')),
      h('div.sh-nav',
        views.length > 1 && !only ? h('div.sh-groups', { role: 'tablist', 'aria-label': 'Parts of Shifts' }, views.map(([id, label]) => h('button', {
          type: 'button', role: 'tab', 'aria-selected': String(section === id), dataset: { tab: id }, onclick: () => go(id),
        }, label, badgeOf(id) ? h('span.sh-badge', String(badgeOf(id))) : null))) : null,
        h('span.sh-rule', { 'aria-hidden': 'true' }),
        ((section === 'shifts' && !detail) || section === 'inbox' || section === 'reports') && choices.length > 1 ? h('div.sh-span', { role: 'group', 'aria-label': 'Day, week, month or dates' },
          choices.map((m) => h('button', {
            type: 'button', 'aria-pressed': String(mode === m), onclick: () => (section === 'shifts' ? go(m) : setMode(m)),
          }, m[0].toUpperCase() + m.slice(1)))) : null,
        ['settings', 'files'].includes(section) || (section === 'shifts' && detail) ? null : periodBar(),
        data.journalEndsInside ? h('details.sh-jnote',
          h('summary', `Journal ends inside ${shortDay(data.journalEndsInside.day)} ${SLOT[data.journalEndsInside.slot].label.toLowerCase()}`),
          h('p', `The journal loaded so far stops inside the ${SLOT[data.journalEndsInside.slot].label.toLowerCase()} shift of `
            + `${shortDay(data.journalEndsInside.day)}, so that shift is shown as far as it goes. Export ASSD one day past the last shift you want to read.`)) : null)),
      // Never for a supervisor: the totals are the owner's view of the business.
      has && admin && data.totals && section === 'shifts' && !detail ? kpis() : null,
      v);
    if (section === 'settings') {
      Promise.resolve(till.settings(v, settingsParts)).catch((err) => mount(v, banner('problem', err.message)));
      return undefined;
    }
    if (section === 'inbox') return inboxView(v);
    if (section === 'files') return filesView(v);
    if (section === 'reports') {
      till.reportList(v, { open: openShift }).catch((err) => mount(v, banner('problem', err.message)));
      return undefined;
    }
    if (!has) return mount(v, nothingYet());
    if (section === 'people') return peopleView(v);
    // Whatever goes wrong drawing a shift or a period is said on screen, with
    // a way back, rather than a click that does nothing.
    const failed = (err) => {
      console.error(err);
      mount(v, banner('problem', h('strong', 'This could not be shown. '), `${err?.message || err}. Reload the page; if it stays, send this message.`),
        detail ? h('p', h('button.btn', { type: 'button', onclick: () => go('shifts') }, '‹ Back to the shifts')) : null);
    };
    try {
      if (detail) return shiftView(v);
      // Chosen dates: side by side up to ten days, as a calendar beyond.
      const out = ({ day: dayView, week, month: monthView, table: tableView, dates: spanOf(dates) <= 10 ? week : monthView })[mode](v);
      // Checked, so locked: the padlocks, once the checks are read. What is still to sort out is on each shift.
      const marks = () => fillChecks(v);
      if (out?.then) out.then(marks, failed); else marks();
    } catch (err) { failed(err); }
    return undefined;
  }

  /** ‹ the period › and a way back to the newest shifts loaded. */
  function periodBar() {
    const latest = data.coverage?.journal?.to || null;
    const away = latest && (latest < period.from || latest > period.to);
    if (mode === 'dates') return datesBar();
    return h('div.sh-period',
      h('button.sh-arrow', { type: 'button', 'aria-label': `Previous ${mode === 'table' ? 'month' : mode}`, onclick: () => step(-1) }, '‹'),
      h('strong.sh-plabel', period.label),
      h('button.sh-arrow', { type: 'button', 'aria-label': `Next ${mode === 'table' ? 'month' : mode}`, onclick: () => step(1) }, '›'),
      away ? h('button.btn', { type: 'button', onclick: () => moveTo(latest) }, `Latest: ${shortDay(latest)}`) : null);
  }

  /** From and To, for days that are not one day, week or month. */
  function datesBar() {
    const from = h('input', { type: 'date', value: dates.from, 'aria-label': 'From' });
    const to = h('input', { type: 'date', value: dates.to, 'aria-label': 'To' });
    const said = h('small.sh-dsaid');
    const show = () => {
      if (!from.value || !to.value) { said.textContent = 'Both dates, please.'; return undefined; }
      // Backwards is a slip: turned round, not refused.
      let next = from.value <= to.value ? { from: from.value, to: to.value } : { from: to.value, to: from.value };
      let note = null;
      if (spanOf(next) > longest) {
        next = { from: plusDays(next.to, -(longest - 1)), to: next.to };
        note = banner('warning', `${longest} days at most at a time: showing ${shortDay(next.from)} to ${shortDay(next.to)}.`);
      }
      dates = next;
      return moveTo(dates.to, note);
    };
    return h('div.sh-period.sh-dates',
      h('button.sh-arrow', { type: 'button', 'aria-label': 'Earlier days', onclick: () => step(-1) }, '‹'),
      h('label', 'From', from), h('label', 'To', to),
      h('button.btn', { type: 'button', onclick: show }, 'Show'),
      h('button.sh-arrow', { type: 'button', 'aria-label': 'Later days', onclick: () => step(1) }, '›'),
      said);
  }

  function nothingYet() {
    const c = data.coverage || {};
    return h('div.card',
      h('h2', mode === 'dates' ? 'No shifts on these days yet' : `No shifts in this ${mode === 'table' ? 'month' : mode} yet`),
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
        h('span.sh-who', avatar(s.user), h('b', { dataset: { k: `${s.day}|${s.slot}` } }, nameOf(s.user))),
        h('span.sh-fig', h('span.num', `Cash ${whole(s.cash)}`), chip(s.register?.variance ?? s.register?.varianceSign, s.open, Boolean(drawerSettled(s)))),
        mixBar(s),
        h('span.sh-fig',
          h('span', s.cardLines ? `${s.cardFound + (s.cardAnswered || 0)}/${s.cardLines} card` : 'no card'),
          toAnswer ? h('span.sh-chip.short', `${toAnswer} to answer`) : null),
        // Checked or not: filled in once the closing reports are read.
        h('span.sh-ck', { dataset: { k: `${s.day}|${s.slot}` } })));
      }
    }
    // The name that holds: chosen, or a question where ASSD and HIVE differ.
    till.names().then((map) => {
      for (const el of grid.querySelectorAll('.sh-who b[data-k]')) {
        const n = map.get(el.dataset.k);
        if (n?.chosen) el.textContent = n.name;
        else if (n?.differs) { el.textContent = `${el.textContent} / ${n.closedBy}`; el.title = 'ASSD login / closed in HIVE by: not the same person'; }
      }
    }).catch(() => {});
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
      dayChecklist(d, exs),
      // Ticked to reconcile together: the bar to do it, as on a shift and in the Inbox.
      pickedBar());
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
      h('span.sh-ck', { dataset: { k: `${s.day}|${s.slot}` } }),
      h('span.sh-open', 'Open the shift →'));
  }

  /** The day's differences, every shift's, as one checklist: open first, each answered where it opens. */
  function dayChecklist(d, exs) {
    const xs = exs.filter((x) => seesEx(x));
    const items = xs.filter((x) => x.severity !== 'info').map(itemOf);
    const list = diffChecklist(xs, { who: true });
    if (!list) return null;
    const done = items.filter((i) => i.done).length;
    return h('section.card.sh-todopane',
      h('div.sh-cardhead', h('h2', `To sort out on ${shortDay(d.day)}`), items.length ? h(`span.sh-chip.${done === items.length ? 'ok' : 'none'}`, `${done} of ${items.length} answered`) : null),
      items.length ? h('div.sh-outbar', h('i', { style: `width:${(done / items.length) * 100}%` })) : null,
      list);
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
            type: 'button', style: `background:${TONE[tone(s)]}`, title: `${nameOf(s.user)} · ${SLOT[SLOTS[i]].label}`, dataset: { k: `${s.day}|${s.slot}` },
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
            h('span', h('i', { style: 'background:var(--sh-info)' }), 'Journal ends'),
            h('span', '🔒 Checked and locked'))),
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

  // ------------------------------------------------------------- table --

  /**
   * The month's differences as a table: a row per day with its three shifts
   * across, or a row per shift with a column per kind. Plus is money in that
   * ASSD does not show, minus is money ASSD shows that is not there. A click
   * opens the shift.
   */
  const tableOpts = { layout: store.get('tablelayout', 'days'), show: 'all', person: '' };
  async function tableView(v) {
    const [names, checks] = await Promise.all([till.names().catch(() => new Map()), till.checks().catch(() => new Map())]);
    const who = (l) => names.get(`${l.day}|${l.slot}`)?.name || nameOf(l.user);
    // Checked shifts are locked: said on each row.
    const checkOf = (l) => checks.get(`${l.day}|${l.slot}`) || 'wait';
    const isLocked = (l) => ['ok', 'changed'].includes(checkOf(l));
    const lockMark = (l) => (isLocked(l) ? h('span.sh-tlock', { title: checkOf(l) === 'changed' ? 'Checked and locked; changed since it was checked' : 'Checked and locked' }, '🔒') : null);
    const days = monthLines(shifts, data.exceptions, period.from, period.to);
    const all = days.flatMap((d) => d.slots.filter(Boolean));
    const hide = Boolean(data.redacted);
    const passes = (l) => Boolean(l) && (tableOpts.show === 'diff' ? l.count > 0 : tableOpts.show === 'open' ? l.open + l.waiting > 0 : true)
      && (!tableOpts.person || who(l) === tableOpts.person);
    const fig = (v_) => (v_ == null || hide ? '' : v_ === 0 ? '·' : `${v_ > 0 ? '+' : '−'}${(Math.abs(v_) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    // A total of nothing says so; a single shift's nothing is a dot.
    const total = (v_) => (v_ === 0 && !hide ? '0.00' : fig(v_));
    const tone_ = (v_) => (hide || !v_ ? '' : v_ < 0 ? '.neg' : '.pos');
    const chip = (l) => (!l ? h('span.sh-chip.none', '—')
      : { agrees: () => h('span.sh-chip.ok', '✓ agrees'), answered: () => h('span.sh-chip.none', '✓ answered'), waiting: () => h('span.sh-chip.over', '⏳ waiting'),
        open: () => h('span.sh-chip.short', `${l.open} open`), journal: () => h('span.sh-chip.none', 'journal ends') }[l.status]());
    const sum = (ls, f) => ls.reduce((t, l) => t + (f(l) || 0), 0);
    const opener = (l) => ({ role: 'button', tabindex: '0', title: `Open ${who(l)}, ${dayText(l.day)} ${SLOT[l.slot].label.toLowerCase()}`, onclick: () => go('shift', `${l.day}|${l.slot}`),
      onkeydown: (e) => { if (e.key === 'Enter') go('shift', `${l.day}|${l.slot}`); } });
    const redraw = () => tableView(v);

    const pick = (key, value, label) => h('button', { type: 'button', 'aria-pressed': String(tableOpts[key] === value), onclick: () => { tableOpts[key] = value; if (key === 'layout') store.set('tablelayout', value); redraw(); } }, label);
    const people = [...new Set(all.map(who))].sort();
    const person = h('select', { 'aria-label': 'Person', onchange: (e) => { tableOpts.person = e.target.value; redraw(); } },
      h('option', { value: '' }, 'Everyone'), people.map((p) => h('option', { value: p, selected: p === tableOpts.person }, p)));
    const csv = () => {
      const blob = new Blob([toCsv(all.filter(passes), who)], { type: 'text/csv' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `shift-differences-${period.from.slice(0, 7)}.csv` });
      document.body.append(a); a.click(); a.remove();
    };
    const bar = h('div.sh-tbar',
      h('div.sh-span', { role: 'group', 'aria-label': 'Layout' }, pick('layout', 'days', 'A row per day'), pick('layout', 'shifts', 'A row per shift')),
      h('div.sh-span', { role: 'group', 'aria-label': 'Which shifts' }, pick('show', 'all', 'All shifts'), pick('show', 'diff', 'With differences'), pick('show', 'open', 'Still open')),
      person,
      h('span.sh-tgap'),
      h('button.btn', { type: 'button', onclick: csv }, '⬇ CSV'),
      h('button.btn', { type: 'button', onclick: () => window.print() }, '🖨 Print'));

    let body;
    if (tableOpts.layout === 'days') {
      const shown = days.filter((d) => d.slots.some(passes));
      const cells = (l) => (!l ? [h('td.sh-tsl', h('span.muted', '—')), h('td.n')]
        : [h(`td.sh-tsl${passes(l) ? '' : '.faint'}`, opener(l), h('div.sh-tcell', h('b', who(l), lockMark(l)), chip(l))),
          h(`td.n${tone_(l.net)}${passes(l) ? '' : '.faint'}`, fig(l.net))]);
      body = h('table.sh-mtable',
        h('thead',
          h('tr.grp', h('th'), SLOT_NAMES.map((n) => h('th.sh-tsl', { colspan: '2' }, n)), hide ? null : h('th.sh-tsl')),
          h('tr', h('th', 'Day'), SLOT_NAMES.map(() => [h('th.sh-tsl', 'Who'), h('th.n', hide ? '' : 'Net')]), hide ? null : h('th.n.sh-tsl', 'Day'))),
        h('tbody', shown.map((d) => {
          const net = d.slots.some((l) => l?.hidden) ? null : sum(d.slots.filter(Boolean), (l) => l.net);
          return h(`tr${weekdayOf(d.day) === 6 ? '.wk' : ''}`, h('td', h('b', dayText(d.day, { weekday: 'short', day: 'numeric' }))),
            d.slots.map(cells), hide ? null : h(`td.n.sh-tsl${tone_(net)}`, h('b', fig(net))));
        })),
        hide ? null : h('tfoot', h('tr', h('td', period.label),
          SLOT_ORDER_.map((sl) => { const t = sum(all.filter((l) => l.slot === sl && passes(l)), (l) => l.net); return [h('td.sh-tsl'), h(`td.n${tone_(t)}`, total(t))]; }),
          (() => { const t = sum(all.filter(passes), (l) => l.net); return h(`td.n.sh-tsl${tone_(t)}`, total(t)); })())));
      if (!shown.length) body = h('p.sh-sub', 'No shifts like that this month.');
    } else {
      const rows = all.filter(passes);
      body = rows.length ? h('table.sh-mtable',
        h('thead', h('tr', h('th', 'Day'), h('th', 'Shift'), h('th', 'Who'), hide ? null : DIFF_COLUMNS.map(([, l]) => h('th.n', l)), hide ? null : h('th.n', 'Net'),
          h('th.n', 'Open'), h('th.n', 'Waiting'), h('th.n', 'Answered'), h('th', 'Status'), h('th', 'Checked'))),
        h('tbody', rows.map((l, i) => h(`tr.sh-trow${rows[i + 1]?.day !== l.day ? '.wk' : ''}`, opener(l),
          h('td', rows[i - 1]?.day === l.day ? '' : h('b', dayText(l.day, { weekday: 'short', day: 'numeric' }))), h('td', SLOT[l.slot].label), h('td', who(l)),
          hide ? null : DIFF_COLUMNS.map(([k]) => h(`td.n${tone_(l.kinds[k])}`, l.hidden ? '' : fig(l.kinds[k]))),
          hide ? null : h(`td.n${tone_(l.net)}`, h('b', fig(l.net))),
          h('td.n', l.open || '·'), h('td.n', l.waiting || '·'), h('td.n', l.answered || '·'), h('td', chip(l)),
          h('td', { title: isLocked(l) ? 'Locked: undo the check on the shift to change it' : '' }, { ok: '🔒 Checked', changed: '🔒 Changed since checked', wait: h('span.muted', 'Not checked') }[checkOf(l)])))),
        h('tfoot', h('tr', h('td', { colspan: '3' }, `${period.label} · ${rows.length} shift${rows.length === 1 ? '' : 's'}`),
          hide ? null : DIFF_COLUMNS.map(([k]) => { const t = sum(rows, (l) => l.kinds[k]); return h(`td.n${tone_(t)}`, total(t)); }),
          hide ? null : (() => { const t = sum(rows, (l) => l.net); return h(`td.n${tone_(t)}`, total(t)); })(),
          h('td.n', String(sum(rows, (l) => l.open))), h('td.n', String(sum(rows, (l) => l.waiting))), h('td.n', String(sum(rows, (l) => l.answered))), h('td'),
          h('td', `🔒 ${rows.filter(isLocked).length} of ${rows.length}`))))
        : h('p.sh-sub', 'No shifts like that this month.');
    }

    const ppl = byPerson(all, who);
    mount(v,
      h('section.card.sh-tablecard',
        h('div.sh-cardhead', h('div', h('h2', `${period.label}: what does not agree, shift by shift`),
          h('p.sh-sub', hide ? 'Where each shift stands. Amounts are not shown to you.'
            : 'Plus is money in that ASSD does not show; minus is money ASSD shows that is not there. Every difference counts, answered or not; the rules’ own explanations do not. A click opens the shift.'))),
        bar,
        h('div.sh-tscroll', body)),
      ppl.length ? h('section.card',
        h('div.sh-cardhead', h('h2', 'The month by person')),
        h('div.sh-tscroll', h('table.sh-mtable',
          h('thead', h('tr', h('th', 'Who'), h('th.n', 'Shifts'), h('th.n', 'With differences'), hide ? null : h('th.n', 'Drawer'), hide ? null : h('th.n', 'Net, all kinds'), h('th.n', 'Still open'), h('th.n', 'Waiting'))),
          h('tbody', ppl.map((p) => h('tr', h('td', h('b', p.who)), h('td.n', String(p.shifts)), h('td.n', String(p.withDiff)),
            hide ? null : h(`td.n${tone_(p.drawer)}`, fig(p.drawer)), hide ? null : h(`td.n${tone_(p.net)}`, h('b', fig(p.net))),
            h('td.n', p.open || '·'), h('td.n', p.waiting || '·'))))))) : null);
  }
  const SLOT_ORDER_ = ['morning', 'afternoon', 'night'];
  const SLOT_NAMES = SLOT_ORDER_.map((sl) => SLOT[sl].label);

  // ------------------------------------------------------------- shift --

  function shiftView(v) {
    const s = byId.get(currentId) || shifts[shifts.length - 1];
    const i = shifts.indexOf(s);
    // The closing report from HIVE, read on its own so the drawer shows at once.
    const report = h('div');
    till.shiftReport(s.day, s.slot, (words) => load(words ? banner('good', words) : null)).then((card) => mount(report, card)).catch(() => {});
    // Checked or not yet: what its people see depends on it.
    const checked = h('div');
    till.shiftCheck(s.day, s.slot, (words) => load(banner('good', words))).then((card) => mount(checked, card)).catch(() => {});
    // Both names when ASSD and HIVE differ, and whose shift it was.
    const whose = h('div');
    const title = h('h2', nameOf(s.user));
    till.whoseShift(s.day, s.slot, { title, after: (words) => load(words ? banner('good', words) : null) }).then((card) => mount(whose, card)).catch(() => {});
    const back = h('button.sh-back', { type: 'button', onclick: () => go(mode) }, `‹ Back to ${period.label}`);
    // Past the first or last shift on screen, the arrows go on into the days either side, as far as the journal goes.
    const journal = data.coverage?.journal || {};
    const earlier = !journal.from || journal.from < period.from;
    const later = !journal.to || journal.to > period.to;
    const across = (dir) => { edge = dir; detail = true; window.scrollTo({ top: 0, behavior: 'smooth' }); return step(dir); };
    const head = h('section.card',
      h('div.sh-shifthead',
        h('button.sh-arrow', { type: 'button', disabled: i <= 0 && !earlier, 'aria-label': i > 0 ? 'Previous shift' : 'Last shift of the day before', title: i > 0 ? 'Previous shift' : 'Last shift of the day before', onclick: () => (i > 0 ? go('shift', shifts[i - 1].id) : across(-1)) }, '‹'),
        h('div.t', avatar(s.user, true),
          h('div', title,
            h('div.m', glyph(s.slot), `${SLOT[s.slot].label} · ${SLOT[s.slot].hours} · ${dayText(s.day, { weekday: 'long', day: 'numeric', month: 'long' })}`,
              s.double ? h('span.sh-chip.none', 'covered two slots') : null,
              s.sessions ? h('span.sh-chip.none', { title: 'ASSD hand-overs inside this shift, in order. Their counts, sales and movements add up as one shift.' },
                `${s.sessions.length} ASSD sessions: ${s.sessions.map((x) => nameOf(x.user)).join(' → ')}`) : null))),
        h(`span.sh-status.${tone(s)}`, { good: '✓ All agrees', warn: '! Have a look', bad: '! Needs an answer', open: 'Journal ends here' }[tone(s)]),
        lockChip(s),
        shiftMenu(s),
        h('button.sh-arrow', { type: 'button', disabled: i >= shifts.length - 1 && !later, 'aria-label': i < shifts.length - 1 ? 'Next shift' : 'First shift of the next day', title: i < shifts.length - 1 ? 'Next shift' : 'First shift of the next day', onclick: () => (i < shifts.length - 1 ? go('shift', shifts[i + 1].id) : across(1)) }, '›')));
    // Without the amounts, the drawer's story is nothing but blanks: the
    // closing report and what does not agree are what there is to see.
    // A locked day: say so at the top; every change on it is refused.
    const lockNote = data.lock && s.day <= data.lock.through
      ? banner('info', `🔒 This day is locked: days up to ${shortDay(data.lock.through)} were locked by ${data.lock.by || 'an admin'}. Nothing on this shift can be changed until an admin moves the lock back (Settings › Locked dates).`)
      : null;
    if (!may('money')) {
      const tabs = detailTabs(s, { report, history: true });
      mount(v, back, head, lockNote, moveBox(s), whose, shiftStrip(s, null),
        h('div.sh-cols', todoPane(s, checked), tabs.el));
      tabs.show();
      return;
    }
    const status = h('span');
    const fall = h('div.sh-fall');
    const fallOpen = new Set();
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
    // Each check under the tab it is about; what waits for an answer is in To sort out already.
    const drawerChecks = h('ul.sh-checks');
    const cashChecks = h('ul.sh-checks');
    const strip = h('div');
    const tabs = detailTabs(s, {
      drawer: h('div',
        h('p.sh-sub', 'Notes and coins, from ASSD’s count at hand-over to its count at the end. Receipts in the counts are expenses, not cash. Type a recount and the picture moves; Save keeps it.'),
        fall, vbox, drawerChecks,
        h('div.sh-inputs',
          h('label.field', { for: 'sh-recount' }, 'Recount the notes and coins (optional)', recount),
          opening ? h('label.field', { for: 'sh-opening' }, 'Opening count', opening) : null),
        h('div.sh-save', h('button.btn.primary', { type: 'button', onclick: save, disabled: s.open || Boolean(lockNote) }, 'Save'), unsaved, said)),
      payments: h('div',
        h('p.sh-sub', 'Every payment in the shift, by the method ASSD recorded. Only cash goes in the drawer.'),
        modesBlock(s), checksList,
        h('h3.sh-tabh', 'Card and MoMo, on the clock'),
        h('p.sh-sub', 'Each dot is a payment that arrived, at the time the terminal or MoMo took it. The shaded band is the shift’s hours; ninety minutes either side still counts. Tap a dot for the details.'),
        h('div.sh-legend',
          h('span', h('i', { style: 'background:var(--sh-card);border-radius:50%' }), 'Card'),
          h('span', h('i', { style: 'background:var(--sh-safe);border-radius:50%' }), 'MoMo'),
          h('span', h('i', { style: 'background:var(--surface);border:2px dashed var(--sh-bad);border-radius:50%' }), 'Declined'),
          h('span', h('i', { style: 'background:var(--surface);box-shadow:0 0 0 2px var(--sh-bad);border-radius:50%' }), 'Needs an answer')),
        timeline(s)),
      cash: h('div',
        h('p.sh-sub', 'Each Cash Movement out of the front drawer, labelled by the Money Count done just before it, and the expenses against their POs in Odoo.'),
        cashChecks, movesBlock(s), odooBlock(s)),
      stock: goodsCard(s),
      report,
      history: true,
    });
    mount(v, back, head, lockNote, moveBox(s), whose, strip,
      h('div.sh-cols', todoPane(s, checked), tabs.el));
    tabs.show();
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
      steps.push({ lab: '+ Cash taken', sm: s.laundryCash ? `incl. ${money(s.laundryCash)} laundry` : '', from: r.opening ?? 0, to: at, c: 'var(--sh-cash)', amt: money(s.cash), detail: () => cashDetail(s) });
      if (r.putBack) { steps.push({ lab: '+ Put back', sm: 'a movement the other way', from: at, to: at + r.putBack, c: 'var(--sh-cash)', amt: money(r.putBack) }); at += r.putBack; }
      if (rc.reconciled?.amount) {
        steps.push({
          lab: '+ Cash for receipts', sm: `receipts swapped for cash, reconciled${rc.reconciled.by ? ` by ${rc.reconciled.by}` : ''}`,
          from: at, to: at + rc.reconciled.amount, c: 'var(--sh-cash)', amt: money(rc.reconciled.amount), detail: () => swapWhy(s),
        });
        at += rc.reconciled.amount;
      }
      // Shown while anything was marked paid from the safe, even at nothing, so it can be undone.
      if (n.expenses || r.fromSafe) {
        const words = [rc.in ? 'new receipts in the counts' : '', rc.direct ? 'paid straight out' : '', r.fromSheet ? 'from the closing report' : ''].filter(Boolean).join(', ');
        steps.push({ lab: '− Expenses', sm: words || 'receipts in the counts', from: at - n.expenses, to: at, c: 'var(--sh-expense)', amt: money(n.expenses), detail: () => expenseDetail(s, n) }); at -= n.expenses;
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
      // Cash taken and the expenses open to what they are made of, line by line.
      mount(fall, steps.map((x) => [h(`div.sh-frow${x.total ? '.total' : ''}`,
        h('span.lab', x.lab, x.sm ? h('small', x.sm) : null,
          x.detail ? h('button.sh-link.sh-fmore', {
            type: 'button', 'aria-expanded': String(fallOpen.has(x.lab)),
            onclick: () => { if (fallOpen.has(x.lab)) fallOpen.delete(x.lab); else fallOpen.add(x.lab); redraw(); },
          }, fallOpen.has(x.lab) ? 'Hide details ▴' : 'Details ▾') : null),
        h('span.sh-track',
          low < 0 ? h('i.sh-zero', { style: `left:${pos(0)}%`, title: 'Nothing' }) : null,
          h(`b.sh-seg${x.hatch ? '.hatch' : ''}`, {
            style: `left:${pos(Math.min(x.from, x.to))}%;width:${(Math.abs(x.to - x.from) / span) * 100}%;background:${x.c}`,
          })),
        h('span.amt.num', x.amt)),
      x.detail && fallOpen.has(x.lab) ? h('div.sh-fdetail', x.detail()) : null]));

      // Answered or reconciled: still the size it was, no longer anything to do.
      const settled = n.variance && !n.recounted ? drawerSettled(s) : null;
      const cls = n.variance == null ? 'none' : n.variance === 0 || settled ? 'ok' : n.variance > 0 ? 'over' : 'short';
      mount(vbox, h(`div.sh-vbox.${cls}`,
        h('div.big.num', n.variance == null ? 'No closing count' : n.variance === 0 ? '✓ The drawer agrees' : `${n.variance > 0 ? 'Over' : 'Short'} ${money(Math.abs(n.variance))}`),
        h('p', n.variance == null
          ? (s.open ? 'The journal stops inside this shift. Load a journal that runs a day past it.' : 'ASSD has no closing count for this shift. Type a recount to check it.')
          : n.variance === 0 ? 'What should be in the drawer is exactly what was counted.'
            : `It should have held ${money(r.expected)}; ${n.recounted ? 'the recount' : 'ASSD counted'} ${money(n.closing)}.${!n.recounted && r.assdVariance === n.variance ? ' ASSD booked the same difference itself.' : ''}`),
        settled ? h('p', h('b', `✓ ${settledWords(settled).charAt(0).toUpperCase()}${settledWords(settled).slice(1)}`), settled.note ? `: ${settled.note}` : '', settled.by ? ` (${settled.by})` : '') : null,
        r.corrected && r.assdVariance !== n.variance ? h('p', `ASSD booked ${signed(r.assdVariance)} before the corrections to its cash movements.`) : null,
        r.handoverGap ? h('p', `This shift’s first count was ${money(Math.abs(r.handoverGap.amount))} ${r.handoverGap.amount < 0 ? 'less' : 'more'} than ${nameOf(r.handoverGap.from)}’s closing count.`) : null),
        receiptsPanel(r, s));

      const line = ([cls_, mark, text, detail]) => (detail
        ? h('li.sh-hasdetail', h('details',
          h('summary', h(`span.sh-ic.${cls_}`, String(mark)), h('span', text), h('span.sh-more', 'Details')),
          detail))
        : h('li', h(`span.sh-ic.${cls_}`, String(mark)), h('span', text)));
      // The drawer's lines, the cash's and the expenses', and the payments'; what waits for an answer is in To sort out.
      const all_ = checks(s, n).filter(([, , text]) => !/waiting for an answer/.test(String(text)));
      const isDrawer = (text) => /^(The drawer|Drawer|No closing count)/.test(String(text));
      const isCash = (text) => /^(Expenses|The closing report says|The expense sheet|ASSD \d+ (matched|labelled)|.*receipts)/i.test(String(text));
      mount(drawerChecks, all_.filter(([, , text]) => isDrawer(text)).map(line));
      mount(cashChecks, all_.filter(([, , text]) => !isDrawer(text) && isCash(text)).map(line));
      mount(checksList, all_.filter(([, , text]) => !isDrawer(text) && !isCash(text)).map(line));
      mount(strip, shiftStrip(s, n));
      tabs.dots(n);
    }
  }

  /** The receipts in the counts: at hand-over, at the end, out, and what is new. */
  function receiptsPanel(r, s) {
    const rc = r.receipts || {};
    if (!rc.open && !rc.close && !rc.in && !rc.out) return null;
    const seqs = (list) => (list.length ? ` (ASSD ${list.join(', ')})` : '');
    const row = (label, value, strong = false) => h(`div.sh-rrow${strong ? '.strong' : ''}`, h('span', label), h('b.num', money(value)));
    const carriedOut = (s.moves || []).filter((m) => m.receipts > 0).map((m) => m.seq);
    return h('div.sh-receipts',
      row(`Receipts in the drawer at hand-over${s.opening?.seq ? ` (count ASSD ${s.opening.seq})` : ''}`, rc.open ?? 0),
      row(`Receipts in the drawer at the end${s.closing?.seq ? ` (count ASSD ${s.closing.seq})` : ''}`, rc.close ?? 0),
      rc.moved ? row(`Receipts taken out with a cash movement${seqs(carriedOut)}`, rc.moved) : null,
      rc.swapped > 0 ? row('Receipts taken out with no cash movement', rc.swapped) : null,
      row(`New receipts: this shift’s expenses${seqs((rc.list || []).map((x) => x.seq))}`, rc.in ?? 0, true),
      (rc.list || []).filter((x) => x.leg).map((x) => h('div.sh-rhow', receiptsSum(x, s))),
      leftWords(rc.trail).map((x) => h(`div.sh-rleft.${x.tone}`, h('span', x.mark), h('span', x.text))));
  }

  /** How new receipts were worked out: this count's receipts less the count before's, with both ASSD numbers. */
  function receiptsSum(x, s) {
    const l = x.leg;
    const before = l.prev === s.opening?.seq ? `count ASSD ${l.prev}, the hand-over count` : `count ASSD ${l.prev}, the count before`;
    return `${money(l.receiptsAfter)} of receipts in count ASSD ${x.seq} − ${money(l.receiptsBefore)} in ${before} = ${money(x.amount)} new.`;
  }

  /** Why a movement counts as expenses: how much carried receipts out, how much was cash, and why. */
  function moveSum(m, s) {
    const rec = s.register?.receipts?.reconciled;
    return [
      `Cash Movement ASSD ${m.seq} took ${money(m.amount)} out of the drawer.`,
      m.receipts > 0 ? ` ${money(m.receipts)} of it carried receipts out: those are counted where they first appeared in a count, not again here.` : '',
      m.direct > 0 ? ` ${money(m.direct)} of it was cash paid straight out${m.manual ? `, labelled expenses by hand${m.manual.by ? ` by ${m.manual.by}` : ''}` : ''}.` : '',
      m.direct > 0 && rec?.amount ? ` The receipts before it were reconciled as swapped for cash${rec.by ? ` (${rec.by})` : ''}, so it took cash, not receipts.` : '',
    ].join('');
  }

  /** Receipts swapped for cash, reconciled: what it means for the drawer, and who said so. */
  function swapWhy(s) {
    const rec = s.register?.receipts?.reconciled || {};
    return h('div.sh-detail', h('p.small',
      `${money(rec.amount)} of receipts left the drawer with no cash movement, and ${money(rec.amount)} of cash was put in for them. `,
      'So the drawer should hold that much more cash, and a movement that later took it out counts as cash paid straight out. ',
      `Reconciled${rec.by ? ` by ${rec.by}` : ''}${rec.at ? `, ${String(rec.at).slice(0, 16)}` : ''}${rec.note ? `: “${rec.note}”` : ''}. `,
      'If that is not what happened, undo it under “Matched and explained” below.'));
  }

  /**
   * Receipts swapped for cash, reconciled: whose they were (each earlier
   * shift a link), where they left the drawer with no movement, the cash put
   * in for them, and who reconciled it and why.
   */
  function swapDetail(s, n) {
    const rc = s.register?.receipts || {};
    const rec = rc.reconciled || {};
    const swaps = rc.trail?.swaps || [];
    const shiftOf = (o) => `${dayText(o.day)}, ${SLOT[o.slot]?.label.toLowerCase() || o.slot}`;
    const link = (o) => (o.here ? 'this shift' : o.earlier ? 'before these days' : h('button.sh-link', { type: 'button', onclick: () => openShift(o.day, o.slot) }, shiftOf(o)));
    const rows = swaps.flatMap((w) => w.origins.map((o) => ({ ...o, gone: w.seq, goneLeg: w.leg })));
    const first = rows[0];
    const earlier = rows.filter((o) => !o.here);
    const step = (title, ...lines) => h('div.st', h('b', title), h('small', ...lines));
    const gone = [...new Set(rows.map((o) => o.gone))];
    const owners = [...new Set(earlier.filter((o) => o.user).map((o) => `${nameOf(o.user)}’s`))];
    return h('div.sh-swap',
      first ? h('div.sh-flow',
        step('Spent', first.here ? 'on this shift' : link(first), first.user && !first.here ? ` · ${nameOf(first.user)}` : '', h('br'),
          first.seqs?.length ? `first in count ASSD ${first.seqs.join(', ')}` : ''),
        earlier.length ? [h('span.ar', '→'), step('Handed over', `in the drawer at ${nameOf(s.user)}’s first count${s.opening?.seq ? `, ASSD ${s.opening.seq}` : ''}`)] : null,
        h('span.ar', '→'),
        step('Gone, no cash movement', `count ASSD ${gone.join(', ')} · notes up by ${money(rec.amount)}`)) : null,
      h('table.sh-otable',
        h('thead', h('tr', h('th', 'Receipts'), h('th', 'Spent on'), h('th', 'By'), h('th', 'Left the drawer'), h('th.n', 'Amount'))),
        h('tbody',
          rows.map((o) => h('tr', h('td', `${money(o.amount)} of receipts`), h('td', link(o)), h('td', o.user ? nameOf(o.user) : '—'), h('td', `count ASSD ${o.gone}`), h('td.n.num', money(o.amount)))),
          h('tr', h('td', 'Cash put in for them'), h('td', 'this shift'), h('td', nameOf(s.user)), h('td', 'notes went up by as much'), h('td.n.num', `+${money(rec.amount)}`))),
        h('tfoot', h('tr', h('td', 'Drawer after reconciling'), h('td'), h('td'), h('td'),
          h('td.n', n.variance == null ? '—' : n.variance === 0 ? 'agrees' : `${n.variance > 0 ? 'over' : 'short'} ${money(Math.abs(n.variance))}`)))),
      h('div.sh-why', h('b', 'Why: '), rec.note ? `“${rec.note}”` : 'no note given', ` · Reconciled by ${rec.by || 'somebody'}${rec.at ? `, ${dayText(String(rec.at).slice(0, 10))} ${String(rec.at).slice(11, 16)}` : ''}`,
        may('moves', 2) ? [' · ', h('button.sh-link', {
          type: 'button',
          onclick: async () => {
            try { await api('/shifts/receipts', { method: 'POST', body: { day: s.day, slot: s.slot, amount: '' } }); await load(banner('good', 'Undone. The drawer is worked out again.')); } catch (err) { window.alert(err.message); }
          },
        }, 'Undo')] : null),
      legsBlock(rows),
      h('p.small', earlier.length
        ? `They are still ${owners.join(' and ') || 'the earlier'} shift${owners.length > 1 ? 's’' : '’s'} expenses, with their PO there. On ${owners.length > 1 ? 'those shifts' : 'that shift'} the same receipts say: taken out with no cash movement on ${nameOf(s.user)}’s shift, and reconciled here.`
        : 'They are this shift’s expenses, with their PO here.'));
  }

  /**
   * The receipts a shift handed over, as one check: who took them out, and
   * when, with each later shift to open. Taking them out settles the
   * drawer, not their PO: they stay this shift's expenses.
   */
  function handedOver(tr, n) {
    const shiftOf = (c) => `${dayText(c.day)}, ${SLOT[c.slot]?.label.toLowerCase() || c.slot}`;
    const gone = tr.cleared.filter((c) => c.how !== 'handover');
    const missing = tr.cleared.filter((c) => c.how === 'handover').reduce((t, c) => t + c.amount, 0);
    const swapped = tr.cleared.find((c) => c.how === 'swapped' && !c.reconciled);
    const people = [...new Set(gone.map((c) => `${c.day}|${c.slot}`))];
    const who = people.length === 1 ? `${nameOf(gone[0].user)}, ${shiftOf(gone[0])}` : `${people.length} later shifts`;
    const head = `Receipts handed over ${money(tr.left)}`;
    const [tone, mark, text] = tr.still ? ['info', 'i', `${head} · ${money(tr.still)} still in the drawer`]
      : missing ? ['warn', '!', `${head} · ${money(missing)} not in the next count`]
        : swapped ? ['warn', '!', `${head} · left with no cash movement: reconcile on ${nameOf(swapped.user)}’s shift`]
          : ['good', '✓', `${head} · taken out by ${who}`];
    const what = (c) => ({
      moved: `To the back office, ASSD ${c.seq}`,
      swapped: `No cash movement (count ASSD ${c.seq})${c.reconciled ? ', reconciled' : ', not reconciled yet'}`,
      handover: `Not in the first count, ASSD ${c.seq}`,
    })[c.how] || c.how;
    const detail = h('div.sh-handed',
      h('table.sh-otable',
        h('thead', h('tr', h('th', 'Shift'), h('th', 'By'), h('th', 'What happened'), h('th.n', 'Receipts'))),
        h('tbody',
          tr.cleared.map((c) => h('tr',
            h('td', h('button.sh-link', { type: 'button', onclick: () => openShift(c.day, c.slot) }, shiftOf(c))),
            h('td', nameOf(c.user)), h('td', what(c)), h('td.n.num', money(c.amount)))),
          tr.still ? h('tr', h('td', 'Still in the drawer'), h('td'), h('td', 'Not taken out yet'), h('td.n.num', money(tr.still))) : null)),
      h('p.small', `They are still this shift’s expenses${n.expenses ? ` (part of its ${money(n.expenses)})` : ''}: their PO is linked here, not on the shift that took them out.`));
    return [tone, mark, text, detail];
  }

  /**
   * What became of the receipts a shift left in the drawer: which later
   * shift took them out, or that they are still there.
   */
  function leftWords(t) {
    if (!t?.left) return [];
    const shiftWords = (c) => `${nameOf(c.user)}’s ${SLOT[c.slot]?.label.toLowerCase() || ''} shift of ${dayText(c.day)}`;
    const how = {
      moved: (c) => `were carried to the back office on ${shiftWords(c)} (ASSD ${c.seq})`,
      swapped: (c) => `were taken out with no cash movement on ${shiftWords(c)} (count ASSD ${c.seq})${c.reconciled ? ', and reconciled there' : ': reconcile it on that shift'}`,
      handover: (c) => `were not in ${nameOf(c.user)}’s first count (ASSD ${c.seq}), on ${dayText(c.day)}`,
    };
    const open = (c) => c.how === 'handover' || (c.how === 'swapped' && !c.reconciled);
    const out = t.cleared.map((c) => ({
      tone: open(c) ? 'warn' : 'good', mark: open(c) ? '!' : '✓',
      text: `${money(c.amount)} of the receipts left in the drawer ${how[c.how]?.(c) || ''}.`,
    }));
    if (t.still) out.push({ tone: 'info', mark: 'i', text: `${money(t.still)} of them still in the drawer: handed over, not taken out yet.` });
    return out;
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
    else if (drawerSettled(s) && !n.recounted) out.push(['good', '✓', `Drawer ${n.variance > 0 ? 'over' : 'short'} by ${money(Math.abs(n.variance))}, ${settledWords(drawerSettled(s))}`, drawerDetail(s, n)]);
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
    if (rcp?.reconciled?.amount) out.push(['good', '✓', `${money(rcp.reconciled.amount)} of receipts swapped for cash, reconciled${rcp.reconciled.by ? ` (${rcp.reconciled.by})` : ''}`, swapDetail(s, n)]);
    // Receipts this shift left in the drawer: settled once a later shift took them out.
    const tr = rcp?.trail;
    if (tr?.left) out.push(handedOver(tr, n));
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
    const extra = exceptionsOf(s).filter((x) => ['not-recorded', 'bank-only', 'double-charge', 'laundry-card'].includes(x.kind) && x.event);
    for (const x of extra) rows.push({ state: 'bad', cells: ['Not in ASSD', '—', h('span', h('div', `${event(x.event)} · ${money(x.event.amount)}`), h('small', (KIND[x.kind] || [x.kind])[0]))] });
    return h('div.sh-detail', lineTable([{ label: 'ASSD line' }, { label: 'ASSD', num: true }, { label: 'Matched to' }], rows));
  }

  /**
   * What is counted at the desk (water, padlocks): ASSD's Items Count at the
   * start, what went out and came back on the shift, what should be left
   * against what was counted at the end, and the money. Each opens to its
   * lines.
   */
  const goodsOpen = new Set();
  function goodsCard(s) {
    const start = s.stockStart || {};
    const end = s.stockEndSeq && s.stockEndSeq !== s.stockStartSeq ? s.stockEnd || {} : {};
    // Whatever the desk counts (on any shift on screen, and the usual two),
    // counted on this shift or only sold or given back on it.
    const counted = new Set(['405', '718', ...shifts.flatMap((o) => [...Object.keys(o.stockStart || {}), ...Object.keys(o.stockEnd || {})])]);
    const codes = [...new Set([...Object.keys(start), ...Object.keys(s.stockEnd || {}), ...Object.keys(s.goods || {}).filter((c) => counted.has(c))])].sort();
    if (!codes.length) return null;
    const hide = Boolean(data.redacted);
    // Journals loaded before names were kept have none: the usual two by number.
    const nameOf_ = (code) => s.stockNames?.[code] || s.goods?.[code]?.name || { 405: 'Padlocks', 718: 'Water' }[code] || `Article ${code}`;
    const body = h('div');
    const draw = () => mount(body, h('div.sh-dtable', h('table',
      h('thead', h('tr', h('th', 'Item'),
        h('th.num', `At the start${s.stockStartSeq ? ` (count ASSD ${s.stockStartSeq})` : ''}`),
        h('th.num', 'Sold or out'), h('th.num', 'Back'), h('th.num', 'Should be left'),
        h('th.num', `Counted at the end${s.stockEndSeq && s.stockEndSeq !== s.stockStartSeq ? ` (count ASSD ${s.stockEndSeq})` : ''}`),
        h('th.num', 'Difference'), hide ? null : h('th.num', 'Money'))),
      h('tbody', codes.flatMap((code) => {
        const g = s.goods?.[code] || { out: 0, back: 0, amount: 0, lines: [] };
        const at = start[code];
        const should = at == null ? null : at - g.out + g.back;
        const atEnd = end[code];
        const diff = should == null || atEnd == null ? null : atEnd - should;
        const open = goodsOpen.has(code);
        return [
          h(`tr.${diff == null ? 'none' : diff === 0 ? 'ok' : 'bad'}`,
            h('td', h('b', nameOf_(code)), h('small', `ASSD article ${code}`),
              g.lines.length ? h('button.sh-link', { type: 'button', onclick: () => { if (open) goodsOpen.delete(code); else goodsOpen.add(code); draw(); } }, open ? 'Hide lines ▴' : `${g.lines.length} line${g.lines.length === 1 ? '' : 's'} ▾`) : null),
            h('td.num', at ?? '—'), h('td.num', g.out || '·'), h('td.num', g.back || '·'),
            h('td.num', should ?? '—'), h('td.num', atEnd ?? (s.stockStartSeq && s.stockEndSeq === s.stockStartSeq ? 'one count only' : '—')),
            h('td.num', diff == null ? '—' : diff === 0 ? '✓ 0' : `${diff > 0 ? '+' : '−'}${Math.abs(diff)}`),
            hide ? null : h('td.num', money(g.amount))),
          open ? h('tr', h('td', { colspan: hide ? '7' : '8' }, h('div.sh-dtable', h('table',
            h('thead', h('tr', h('th', 'ASSD line'), h('th', 'What'), h('th', 'Keyed by'), h('th.num', 'Quantity'), hide ? null : h('th.num', 'Amount'))),
            h('tbody', g.lines.map((l) => h('tr', h('td', `ASSD ${l.seq}`), h('td', l.kind, l.qty < 0 ? h('small', 'given back') : null), h('td', nameOf(l.user)),
              h('td.num', l.qty), hide ? null : h('td.num', l.amount == null ? '—' : money(l.amount))))))))) : null,
        ];
      })))));
    draw();
    // Beside ASSD, what the closing report in HIVE says for each rental (padlocks).
    const fromHive = h('div');
    till.read().then((d) => {
      const row = (d.reports || []).find((x) => x.day === s.day && x.slot === s.slot);
      const rentals = (row?.compare?.rentals || []).filter((x) => x.article && codes.includes(String(x.article)));
      if (!row?.report) { mount(fromHive, h('p.small.muted', 'No closing report in HIVE for this shift, so nothing to set the padlocks against.')); return; }
      mount(fromHive, rentals.map((x) => rentalCheck(s, x)));
    }).catch(() => {});
    return h('section.card',
      h('div.sh-cardhead', h('div', h('h2', 'Water and padlocks'),
        h('p.sh-sub', 'What ASSD counted at the desk at the start, what went out and came back on this shift, and what should be left against the count at the end. Padlocks out are deposits taken; back are deposits given back.'))),
      body, fromHive);
  }

  /** A rental (padlocks) as the closing report in HIVE has it, against ASSD: at the start, at the end, and how many went out net. */
  function rentalCheck(s, x) {
    const code = String(x.article);
    const g = s.goods?.[code] || { out: 0, back: 0 };
    const assdStart = s.stockStart?.[code] ?? null;
    const assdEnd = s.stockEndSeq && s.stockEndSeq !== s.stockStartSeq ? s.stockEnd?.[code] ?? null : null;
    const hiveNet = x.start == null || x.end == null ? null : x.start - x.end;
    const assdNet = g.out - g.back;
    const line = (label, hive, assd, note = '') => {
      const agree = hive == null || assd == null ? null : hive === assd;
      return h(`tr.${agree == null ? 'none' : agree ? 'ok' : 'bad'}`, h('td', mark(agree == null ? 'none' : agree ? 'ok' : 'bad')), h('td', label, note ? h('small', note) : null),
        h('td.num', hive ?? '—'), h('td.num', assd ?? '—'),
        h('td.num', agree == null ? '—' : agree ? '✓' : `${hive - assd > 0 ? '+' : '−'}${Math.abs(hive - assd)}`));
    };
    return h('div.sh-rentcheck',
      h('h3', `${x.label}: the closing report against ASSD`),
      h('div.sh-dtable', h('table',
        h('thead', h('tr', h('th', ''), h('th', ''), h('th.num', 'Closing report (HIVE)'), h('th.num', 'ASSD'), h('th.num', 'Difference'))),
        h('tbody',
          line('At the start', x.start ?? null, assdStart, assdStart != null && s.stockStartSeq ? `ASSD: count ${s.stockStartSeq}` : ''),
          line('At the end', x.end ?? null, assdEnd, assdEnd != null && s.stockEndSeq ? `ASSD: count ${s.stockEndSeq}` : ''),
          line(`${x.label || 'Items'} out, net`, hiveNet, assdNet, `HIVE: start less end. ASSD: ${g.out} deposit${g.out === 1 ? '' : 's'} taken, ${g.back} given back`)))),
      x.gap != null && x.gap !== 0 ? h('p.small', `By the closing report's own count, ${Math.abs(x.gap)} ${x.unit || 'item'}${Math.abs(x.gap) === 1 ? '' : 's'} ${x.gap > 0 ? 'more' : 'fewer'} at the end than its start less the deposits in ASSD.`) : null);
  }

  // ------------------------------------------------ reconciliation report --

  /**
   * The shift's figures for its reconciliation report (see recon.js): the
   * same numbers this screen shows, the drawer, card and MoMo, expenses, the
   * desk's stock, the laundry, and every difference with where it stands.
   */
  function reconOf(s) {
    const r = s.register || {};
    const n = numbers(s);
    const xs = exceptionsOf(s);
    const stateOf = (x) => (x.proposed || x.pending ? 'approve' : x.answer ? 'done' : x.severity === 'info' ? 'info' : 'answer');
    const saidOf = (x) => (x.proposed ? `Waiting for an admin: “${x.proposed.answer}${x.proposed.note ? `: ${x.proposed.note}` : ''}” (${x.proposed.by})`
      : x.answer ? `${x.answer.link ? 'Reconciled with others' : x.answer.answer}${x.answer.note ? `: ${x.answer.note}` : ''}${x.answer.by ? ` (${x.answer.by})` : ''}` : '');
    const text = (x) => { const t = describe(x); return typeof t === 'string' ? t : (t?.textContent || ''); };
    const ref = (seq) => (seq ? `ASSD ${seq}` : '');
    const shown = xs.filter((x) => x.severity !== 'info' || x.kind === 'keyed-no-cash');
    const diffs = shown.map((x) => ({
      kind: x.kind, title: (KIND[x.kind] || [x.kind])[0], amount: x.amount ?? null, ref: ref(x.seq), text: text(x), state: stateOf(x), said: saidOf(x),
    }));

    // The drawer, step by step, as it is drawn above.
    let drawer = null;
    if (r.expected != null || r.opening != null) {
      const kinds = {};
      for (const c of s.cashLines || []) {
        const k = { Reservation: 'Stays (rooms and beds)', 'Cash Register': 'At the till (water, items, services)', 'Items Correction': 'Item corrections' }[c.kind] || c.kind;
        kinds[k] = (kinds[k] || 0) + c.amount;
      }
      const rc = r.receipts || {};
      const steps = [{ kind: 'start', label: 'Opening count', amount: r.opening ?? 0, ref: r.openingFrom === 'typed' ? 'typed' : r.openingFrom === 'carried' ? 'last shift’s closing' : ref(s.opening?.seq) }];
      steps.push({ kind: 'in', label: 'Cash taken, as ASSD has it', amount: s.cash, ref: `${(s.cashLines || []).length} lines`, parts: Object.keys(kinds).length > 1 ? Object.entries(kinds).map(([label, amount]) => ({ label, amount })) : [] });
      if (r.putBack) steps.push({ kind: 'in', label: 'Put back', amount: r.putBack, ref: 'a movement the other way' });
      if (rc.reconciled?.amount) steps.push({ kind: 'in', label: 'Cash for receipts swapped', amount: rc.reconciled.amount, ref: rc.reconciled.by ? `by ${rc.reconciled.by}` : '' });
      if (n.expenses) steps.push({ kind: 'out', label: 'Expenses', amount: n.expenses, ref: (s.moves || []).filter((m) => m.direct > 0).map((m) => ref(m.seq)).join(', ') || 'receipts in the counts' });
      if (n.toSafe) steps.push({ kind: 'out', label: 'Cash to the safe', amount: n.toSafe });
      if (n.unlabelled) steps.push({ kind: 'out', label: 'Moved out with no label', amount: n.unlabelled });
      const settled = n.variance && !n.recounted ? drawerSettled(s) : null;
      const still = xs.find((x) => x.kind === 'keyed-no-cash');
      const gap = r.handoverGap;
      drawer = {
        steps, expected: r.expected ?? null, counted: n.closing ?? null, countedRef: n.recounted ? 'a recount' : ref(s.closing?.seq), recounted: n.recounted,
        variance: n.variance, settled: settled ? settledWords(settled).replace(/^./, (c) => c.toUpperCase()) : null,
        handover: r.opening != null && previousOf(s) ? { from: nameOf(gap?.from || previousOf(s).user), before: gap ? (r.opening - gap.amount) : r.opening, first: r.opening, gap: gap ? gap.amount : 0 } : null,
        notes: [
          rc.open || rc.close ? `Receipts in the counts: ${money(rc.open || 0)} at the start, ${money(rc.close || 0)} at the end. They are expenses, not cash.` : '',
          still ? `${money(Math.abs(still.amount))} of the cash taken was keyed while the drawer’s counts did not move: see “${KIND['keyed-no-cash'][0]}” below.` : '',
          r.corrected && r.assdVariance !== n.variance ? `ASSD booked ${signed(r.assdVariance)} before the corrections to its cash movements.` : '',
        ].filter(Boolean),
      };
    }

    // Card and MoMo: ASSD's lines against what was taken.
    let card = null;
    const lines = s.lines || [];
    if (lines.length || xs.some((x) => ['card', 'bank'].includes(columnOf(x)) && x.severity !== 'info')) {
      const seen = new Set();
      let found = 0;
      let foundCount = 0;
      const take = (e) => { if (!e || seen.has(e.id || `${e.at}|${e.amount}`)) return; seen.add(e.id || `${e.at}|${e.amount}`); found += e.amount; foundCount += 1; };
      for (const l of lines) for (const e of l.events || []) take(e);
      for (const x of xs.filter((o) => ['not-recorded', 'double-charge', 'laundry-card'].includes(o.kind))) take(x.event);
      const matched = lines.filter((l) => (l.events || []).length && !l.exception);
      const items = shown.filter((x) => ['card', 'bank'].includes(columnOf(x))).map((x) => {
        const v = signedAmount(x) ?? 0;
        const sides = x.paid != null && x.assd != null ? [x.assd, x.paid] : v > 0 ? [x.amount < 0 ? x.amount : 0, x.amount < 0 ? 0 : Math.abs(x.amount)] : [Math.abs(x.amount ?? 0), 0];
        return { label: (KIND[x.kind] || [x.kind])[0], ref: ref(x.seq), amount: v, assd: sides[0], found: sides[1], state: stateOf(x), text: text(x), said: saidOf(x) };
      });
      const assd = lines.reduce((t, l) => t + (l.amount || 0), 0);
      card = { assd, assdLines: lines.length, found, foundCount, difference: found - assd, items, matched: matched.length, matchedAmount: matched.reduce((t, l) => t + l.amount, 0) };
    }

    // Expenses against their POs.
    const exp = s.expense || {};
    const orders = (exp.odoo?.orders || []).map((o) => ({ name: o.name, vendor: o.vendor || '', total: o.total, ok: o.state === 'purchase' || o.state === 'done' }));
    const expenses = n.expenses || orders.length ? {
      amount: n.expenses || 0, ref: (s.moves || []).filter((m) => m.direct > 0).map((m) => ref(m.seq)).join(', '),
      orders, poTotal: exp.odooTotal ?? null, difference: exp.odooTotal == null ? null : exp.odooTotal - (n.expenses || 0),
    } : null;

    // What the desk counts: water, padlocks.
    const start = s.stockStart || {};
    const end = s.stockEndSeq && s.stockEndSeq !== s.stockStartSeq ? s.stockEnd || {} : {};
    const counted = new Set(['405', '718', ...shifts.flatMap((o) => [...Object.keys(o.stockStart || {}), ...Object.keys(o.stockEnd || {})])]);
    const codes = [...new Set([...Object.keys(start), ...Object.keys(s.stockEnd || {}), ...Object.keys(s.goods || {}).filter((c) => counted.has(c))])].sort();
    const goods = codes.map((code) => {
      const g = s.goods?.[code] || { out: 0, back: 0 };
      const should = start[code] == null ? null : start[code] - g.out + g.back;
      const atEnd = end[code] ?? null;
      return { name: s.stockNames?.[code] || s.goods?.[code]?.name || { 405: 'Padlocks', 718: 'Water' }[code] || `Article ${code}`,
        start: start[code] ?? null, out: g.out, back: g.back, should, end: atEnd, diff: should == null || atEnd == null ? null : atEnd - should };
    });
    const laundry = s.laundry || s.laundrySystem ? {
      assd: s.laundry || 0, system: s.laundrySystem ? s.laundrySystem.collected : null, difference: s.laundrySystem ? s.laundrySystem.collected - (s.laundry || 0) : null,
    } : null;

    const now = new Date();
    return {
      who: nameOf(s.user), day: s.day, when: dayText(s.day, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
      slot: SLOT[s.slot].label, hours: SLOT[s.slot].hours, seqs: s.startSeq ? `ASSD ${s.startSeq} to ${s.endSeq}` : '', open: Boolean(s.open),
      made: `${now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}, ${now.toTimeString().slice(0, 5)}`,
      drawer, card, expenses, goods, laundry, diffs,
    };
  }

  /** The shift before this one on screen: whose closing count this one's first is held against. */
  const previousOf = (s) => { const i = shifts.indexOf(s); return i > 0 ? shifts[i - 1] : null; };

  /** Choose a layout, see it, and print it (or save it as a PDF) or download it. */
  function openRecon(s) {
    const m = reconOf(s);
    let layout = (() => { try { return localStorage.getItem('reconLayout') || 'statement'; } catch { return 'statement'; } })();
    if (!RECON_LAYOUTS.some((x) => x.id === layout)) layout = 'statement';
    const inner = h('div.po-in.rc-dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Reconciliation report' });
    const sheet = h('div.po-sheet', inner);
    const close = () => { sheet.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(sheet);
    const frame = h('iframe.rc-preview', { title: 'The report', sandbox: 'allow-same-origin allow-modals' });
    const said = h('p.small');
    const picks = h('div.rc-layouts', { role: 'radiogroup', 'aria-label': 'Layout' });
    const draw = () => {
      frame.srcdoc = reportHtml(m, layout);
      mount(picks, RECON_LAYOUTS.map((x) => h(`button.rc-layout${x.id === layout ? '.on' : ''}`, {
        type: 'button', role: 'radio', 'aria-checked': String(x.id === layout),
        onclick: () => { layout = x.id; try { localStorage.setItem('reconLayout', layout); } catch { /* not kept */ } draw(); },
      }, h('b', x.name), h('small', x.about))));
    };
    const print = () => {
      // In a window of its own, so it prints as the page it is (and "Save as PDF" makes the file).
      const w = window.open('', '_blank');
      if (!w) { frame.contentWindow?.print(); return; }
      w.document.open(); w.document.write(reportHtml(m, layout)); w.document.close();
      w.addEventListener('load', () => { w.focus(); w.print(); });
      setTimeout(() => { try { w.focus(); w.print(); } catch { /* already printing */ } }, 600);
    };
    const download = () => {
      const url = URL.createObjectURL(new Blob([reportHtml(m, layout)], { type: 'text/html' }));
      const a = h('a', { href: url, download: reconFile(m, layout) });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      said.textContent = `Downloaded as ${reconFile(m, layout)}.`;
    };
    mount(inner,
      h('h2', 'Reconciliation report'),
      h('p.sh-sub', `${nameOf(s.user)} · ${SLOT[s.slot].label} · ${dayText(s.day, { weekday: 'long', day: 'numeric', month: 'long' })}. Choose a layout; the report below changes with it.`),
      picks, frame,
      h('div.po-acts',
        h('button.btn', { type: 'button', onclick: close }, 'Close'),
        h('button.btn', { type: 'button', onclick: download }, 'Download (.html)'),
        h('button.btn.primary', { type: 'button', onclick: print }, 'Print or save as PDF')),
      said);
    draw();
  }

  /** What makes "Cash taken": every cash payment ASSD has on the shift, money given back as minus. */
  function cashDetail(s) {
    const lines = s.cashLines || [];
    if (!lines.length) return h('p.small.muted', 'No cash payments in ASSD on this shift.');
    const rows = lines.map((c) => ({
      state: c.amount < 0 ? 'none' : 'ok',
      cells: [`ASSD ${c.seq}`, h('span', c.kind, c.amount < 0 ? h('small', 'money given back') : null), nameOf(c.user), money(c.amount)],
    }));
    const laundry = s.laundryCash ? `incl. ${money(s.laundryCash)} laundry` : '';
    return h('div.sh-detail', lineTable([{ label: 'ASSD line' }, { label: 'What' }, { label: 'Keyed by' }, { label: 'Cash', num: true }], rows,
      ['Total', `${lines.length} payment${lines.length === 1 ? '' : 's'}`, laundry, money(lines.reduce((t, c) => t + c.amount, 0))]));
  }

  function expenseDetail(s, n) {
    const exp = s.expense || {};
    // A movement another was matched to as its duplicate says so, so the one left is not taken for a stray.
    const twinOf = (seq) => (s.moves || []).find((x) => x.kind === 'excluded' && x.reason === 'duplicate' && x.pair === seq);
    // The expenses: receipts as they appeared in the counts, and cash a
    // movement paid straight out.
    const moves = [
      ...((s.register?.receipts?.list) || []).map((x) => ({
        label: h('span', `New receipts in count ASSD ${x.seq}`, x.leg ? h('small', receiptsSum(x, s)) : null), amount: x.amount,
      })),
      ...(s.moves || []).filter((m) => m.direct > 0).map((m) => ({
        label: h('span', `ASSD ${m.seq}, cash paid straight out`, h('small', moveSum(m, s)),
          twinOf(m.seq) ? h('small', `✓ ASSD ${twinOf(m.seq).seq} matched as its duplicate, left out`) : null),
        amount: m.direct,
      })),
    ];
    // Expenses with no PO the big safe paid: off the drawer's.
    for (const x of (exp.fromSafe || []).filter((y) => y.noPo)) {
      moves.push({ label: h('span', `Paid from the big safe, not the drawer: ${x.what || 'an expense with no PO'}`, h('small', `${x.by || 'An admin'}: “${x.why || ''}”`)), amount: -x.amount });
    }
    // What the typed expense sheet settled on top of what the counts labelled.
    const fromSheet = (n.expenses || 0) - moves.reduce((t, m) => t + m.amount, 0);
    if (fromSheet > 0) {
      moves.push({
        label: h('span', exp.sheetFrom === 'report' ? 'From the closing report (unlabelled cash)' : 'From the expense sheet (unlabelled cash)',
          h('small', `Cash moved out with no label: the ${exp.sheetFrom === 'report' ? 'closing report' : 'expense sheet'} says ${money(exp.sheetTotal)} was spent, ${money(fromSheet)} more than the counts and movements above show.`)),
        amount: fromSheet,
      });
    }
    const confirmed = (o) => o.state === 'purchase' || o.state === 'done';
    const formWord = (o) => (o.kind || !data.formLive ? '' : o.reported ? ' · on the form ✓' : ' · not on the form');
    const po = (o) => `${o.name}${o.kind === 'topup' ? ' (deficit)' : o.kind === 'change' ? ' (refund)' : o.advance ? ' (advance)' : ''} · ${o.vendor || ''} · ${confirmed(o) ? 'approved' : o.state}${formWord(o)}${o.fromSafe ? ` · ${money(o.fromSafe)} of it paid from the big safe; this is the drawer’s part` : ''}`;
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
      safeBox(s, orders),
      n.expenses > 0 ? poLinker(s) : null);
  }

  /**
   * A PO the closing report says the drawer paid that the big safe paid,
   * whole or part (an admin's call): that much comes off what the drawer
   * accounts for, and goes in the safe book as a PO paid from the safe.
   */
  function safeBox(s, orders) {
    const done = s.expense?.fromSafe || [];
    if (!admin && !done.length) return null;
    const said = h('span.small');
    const post = async (body, msg) => {
      said.textContent = 'Saving…';
      try { await api('/shifts/po-safe', { method: 'POST', body: { day: s.day, slot: s.slot, ...body } }); await load(banner('good', msg)); } catch (err) { said.textContent = err.message; }
    };
    const list = done.map((x) => h('div.sh-safepo',
      h('span', h('b', x.noPo ? x.what || 'An expense with no PO' : x.po), ` · ${money(x.amount)} paid from the big safe, not the drawer`,
        h('small', `${x.by || 'An admin'}${x.at ? `, ${String(x.at).slice(0, 16)}` : ''}: “${x.why || ''}” · in the safe book${x.noPo ? ', waiting for its PO' : ''}`)),
      admin ? h('button.sh-link', { type: 'button', onclick: () => post({ po: x.po, back: true }, `${x.noPo ? x.what || 'That expense' : x.po} is the drawer’s again, and its line is off the safe book.`) }, 'Undo') : null));
    const choices = orders.filter((o) => o.name && !done.some((x) => x.po === String(o.name).toUpperCase()));
    // One form: a PO on this shift, or an expense with no PO; then how much and why.
    let form = null;
    if (admin) {
      let mode = choices.length ? 'po' : 'nopo';
      const pick = h('select.sf-in', { 'aria-label': 'PO' }, choices.map((o) => h('option', { value: o.name }, `${o.name} · ${o.vendor || ''} · ${money(o.total)}`)));
      const what = h('input.sf-in', { type: 'text', maxlength: '200', placeholder: 'e.g. gas refill', 'aria-label': 'What it was for' });
      const amount = h('input.sf-in.sf-amt', { type: 'number', step: '0.01', min: '0', placeholder: '0.00', 'aria-label': 'Amount paid from the safe' });
      const why = h('input.sf-in', { type: 'text', maxlength: '300', placeholder: 'e.g. the manager paid it from the big safe', 'aria-label': 'Why' });
      const fill = () => { const o = choices.find((c) => c.name === pick.value); amount.value = o ? (o.total / 100).toFixed(2) : ''; };
      pick.addEventListener('change', fill);
      const field = (label, ...input) => h('label.sf-field', h('span', label), ...input);
      const poField = field('PO', pick);
      const whatField = field('What it was for', what);
      const tabs = h('div.sh-span.sf-tabs', { role: 'group', 'aria-label': 'What the safe paid' });
      const show = () => {
        poField.hidden = mode !== 'po'; whatField.hidden = mode !== 'nopo';
        mount(tabs,
          choices.length ? h('button', { type: 'button', 'aria-pressed': String(mode === 'po'), onclick: () => { mode = 'po'; fill(); show(); } }, 'A PO on this shift') : null,
          h('button', { type: 'button', 'aria-pressed': String(mode === 'nopo'), onclick: () => { mode = 'nopo'; amount.value = ''; show(); } }, 'An expense with no PO'));
      };
      if (choices.length) fill();
      show();
      form = h('div.sf-form', tabs, poField, whatField,
        field('Amount the safe paid', h('span.sf-cur', 'GH₵', amount)),
        field('Why', why),
        h('div.sf-go',
          h('button.btn.primary', {
            type: 'button',
            onclick: () => {
              if (!(Number(amount.value) > 0)) { said.textContent = 'How much did the safe pay?'; amount.focus(); return; }
              if (mode === 'nopo' && !what.value.trim()) { said.textContent = 'Say what it was for.'; what.focus(); return; }
              if (!why.value.trim()) { said.textContent = 'Say why.'; why.focus(); return; }
              if (mode === 'po') {
                post({ po: pick.value, amount: amount.value, why: why.value, vendor: choices.find((c) => c.name === pick.value)?.vendor || '' },
                  `${pick.value}: GH₵${amount.value} put on the safe book and taken off this drawer.`);
              } else {
                post({ noPo: true, amount: amount.value, what: what.value, why: why.value }, `GH₵${amount.value} for ${what.value}: taken off this drawer and put on the safe book, waiting for its PO.`);
              }
            },
          }, 'Paid from the big safe'),
          said));
    }
    return h('div.sh-safepos',
      h('b', 'Paid from the big safe'),
      h('p.small.muted', 'Money this drawer is shown paying that the big safe paid, all or part. It comes off this drawer and goes in the safe book.'),
      list, form, admin ? null : said);
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
    // Receipts a movement carried: those earlier shifts left in the drawer
    // (their expenses), oldest first, then this shift's own.
    const earlierOf = (m) => (m.origins || []).filter((o) => !o.here);
    const whose = (m) => (earlierOf(m).length ? ', some left in the drawer by earlier shifts (below)' : '');
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
      const rec = m.receipts ? `${money(m.receipts)} of receipts to the back office${whose(m)}` : '';
      const base = {
        expenses: m.manual ? [rec, `${money(m.direct)} expenses paid straight out, as corrected`].filter(Boolean).join('; ') + '.'
          : earlierOf(m).length ? `${money(m.receipts)} of receipts went to the back office. No cash.`
            : `${rec}. They are expenses of the shift whose count they first appeared on, not cash.`,
        safe: m.manual ? [rec, `${money(m.safe)} of notes to the safe, as corrected`].filter(Boolean).join('; ') + '.' : 'Notes to the safe, as the count before it.',
        split: m.manual ? [rec, `${money(m.direct)} expenses and ${money(m.safe)} to the safe, as corrected`].filter(Boolean).join('; ') + '.'
          : `${rec} and ${money(m.safe)} of notes to the safe, as counted just before.`,
        part: `${rec}, as counted; the other ${money(m.cash)} has no count to say what it was.`,
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
          // A movement that carried nothing but receipts says so, rather than "Expenses".
          h('span.tag', { style: `background:${tag[m.kind]?.[1] || 'var(--muted)'}` },
            m.kind === 'expenses' && !m.manual && m.receipts >= m.amount ? 'Receipts' : tag[m.kind]?.[0] || m.kind),
          h('span',
            h('small', `${said(m)} · ${nameOf(m.user)}, ASSD ${m.seq}`),
            m.byPos ? h('small.sh-manual', ` It is exactly the shift’s POs ${m.byPos.join(' + ')}: read as cash paid for them.${m.wasReceipts ? ` The ${money(m.wasReceipts)} of receipts the counts lost around it left with no cash movement.` : ''}`) : null,
            m.stayed ? h('small.sh-manual', ` The counts after it still show ${money(m.stayed)} of the receipts from the count before it: read as staying in the drawer, so that much of it was cash.`) : null,
            m.manual ? h('small.sh-manual', ` Corrected by ${m.manual.by || 'somebody'}${m.manual.note ? `: ${m.manual.note}` : ''}${m.auto ? ` (ASSD's count said ${tag[m.auto]?.[0].toLowerCase() || m.auto})` : ''}.`) : null,
            m.pending ? h('small.sh-manual', ` Waiting for an admin: ${m.pending.by || 'a supervisor'} says ${({ expenses: 'it was expenses', safe: 'it went to the safe', split: 'it was split', duplicate: `it duplicates ASSD ${m.pending.pair}`, reverses: `it pairs with ASSD ${m.pending.pair}` })[m.pending.kind] || m.pending.kind}.`) : null),
          h('span.sh-moveend',
            h('span.amt.num', ['corrected', 'excluded'].includes(m.kind) ? h('s', money(Math.abs(m.amount))) : m.amount < 0 ? `+${money(-m.amount)}` : money(m.amount)),
            m.kind === 'corrected' || !canFix || (!admin && m.manual) ? null : h('button.sh-link', { type: 'button', onclick: open }, m.pending ? 'Change' : 'Correct'))),
        earlierOf(m).length ? originsBlock(m) : null,
        fix);
    }));
  }

  /**
   * Whose receipts a movement carried, shift by shift: a bar, and a table
   * with each earlier shift to open. Only this shift's part is its spending.
   */
  function originsBlock(m) {
    const list = m.origins || [];
    const browns = ['#c9b8a6', '#a8917b', '#8f7a66', '#b6a48f'];
    let b = 0;
    const colourOf = list.map((o) => (o.here ? 'var(--sh-expense)' : browns[b++ % browns.length]));
    const when = (o) => `${dayText(o.day)}, ${SLOT[o.slot]?.label.toLowerCase() || o.slot}`;
    const own = list.filter((o) => o.here).reduce((t, o) => t + (o.amount || 0), 0);
    const others = list.filter((o) => !o.here);
    const people = [...new Set(others.filter((o) => o.user).map((o) => `${nameOf(o.user)}’s`))];
    const named = people.length > 1 ? `${people.slice(0, -1).join(', ')} and ${people[people.length - 1]}` : people[0] || 'earlier';
    return h('div.sh-origins',
      data.redacted ? null : h('div.sh-obar', list.map((o, i) => h('b', { style: `flex:${o.amount || 1};background:${colourOf[i]}`, title: `${o.here ? 'This shift' : o.user ? nameOf(o.user) : 'Before these days'} ${money(o.amount)}` },
        o.here ? `${whole(o.amount)} · this shift` : whole(o.amount)))),
      h('table.sh-otable',
        h('thead', h('tr', h('th', 'Spent on'), h('th', 'By'), h('th', 'First in the count'), h('th.n', 'Receipts'))),
        h('tbody', list.map((o, i) => h(`tr${o.here ? '.here' : ''}`,
          h('td', h('i.sh-odot', { style: `background:${colourOf[i]}` }),
            o.here ? `This shift · ${when(o)}`
              : o.earlier ? 'Before these days'
                : h('button.sh-link', { type: 'button', onclick: () => openShift(o.day, o.slot) }, when(o))),
          h('td', o.user ? nameOf(o.user) : '—'),
          h('td', o.seqs?.length ? o.seqs.map((x) => `ASSD ${x}`).join(', ') : o.here ? 'not yet in a count' : '—'),
          h('td.n.num', money(o.amount))))),
        h('tfoot', h('tr', h('td', 'Total moved out'), h('td'), h('td'), h('td.n.num', money(m.receipts))))),
      h('p.sh-sub', own
        ? `Only ${money(own)} is this shift’s spending: that is the expense on its card, and the PO it needs. The ${money(m.receipts - own)} is on ${named} shift${people.length > 1 ? 's' : ''}, with ${people.length > 1 ? 'their' : 'its'} POs.`
        : `None of it is this shift’s spending: the receipts are on ${named} shift${people.length > 1 ? 's' : ''}, with ${people.length > 1 ? 'their' : 'its'} POs.`));
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
    const dup = pick('A duplicate of', twins, 'duplicate');
    const back = pick('Put back by', elsewhere(-m.amount), 'reverses');
    if (m.receipts && cashPart <= 0) {
      // Nothing but receipts: no cash to label; only a duplicate or a reversal is left to say.
      return h('div.sh-fixbox',
        h('p.sh-sub', `All ${money(m.receipts)} of it was receipts, read from the counts: there is no cash in it to label. The receipts are expenses of the shift whose count they first appeared on.`),
        dup, back, dup || back ? h('div.sh-fixrow', note, said) : null);
    }
    return h('div.sh-fixbox',
      h('p.sh-sub', m.receipts
        ? `${money(m.receipts)} of it was receipts, from the count before it: expenses already, not cash. What was the other ${money(cashPart)}?`
        : 'What did this movement really take out of the drawer?'),
      cashPart > 0 ? h('div.sh-fixrow', choice('Expenses paid straight out', { kind: 'expenses' }, m.kind !== 'expenses'), choice('Cash to the safe', { kind: 'safe' }, m.kind !== 'safe'),
        h('span', 'or split:'), split, h('button.btn', { type: 'button', onclick: () => send({ kind: 'split', expenses: split.value }) }, 'Split')) : null,
      cashPart > 0 ? h('div.sh-fixrow', h('span', 'Expenses for'), pos) : null,
      dup,
      back,
      h('div.sh-fixrow', note, said));
  }

  /**
   * The POs behind this shift's expenses, as the closing report in HIVE gave
   * them: Odoo's state and whether each is on the expense form. Nothing to
   * type here; a PO is added in HIVE, where the shift is closed.
   */
  /** Open Odoo activities on these POs, by PO name. */
  function waitingOn(orders) {
    const names = new Set(orders.map((o) => String(o.name).toUpperCase()));
    const out = new Map();
    for (const a of sources.odoo?.activities || []) {
      if (a.model !== 'purchase.order' || !names.has(String(a.resName).toUpperCase())) continue;
      const key = String(a.resName).toUpperCase();
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(a);
    }
    return out;
  }
  const waitingCell = (list) => (list?.length ? list.map((a) => h('div',
    h('b', a.summary || a.type || 'Activity'), ` · ${a.account || a.userName || 'nobody'}`,
    a.state !== 'planned' ? h('div', h(`span.${a.state === 'overdue' ? 'sh-late' : 'sh-due'}`, odooWhen(a).toLowerCase())) : h('div.small', `due ${dayText(a.deadline)}`)))
    : h('span', { style: 'color:var(--ink-2)' }, '—'));

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
        ...(waitingOn(orders).size ? [{ label: 'Waiting on', get: (o) => waitingCell(waitingOn(orders).get(String(o.name).toUpperCase())) }] : []),
      ], orders, { footer: orders }),
      (exp.odoo?.unknown || []).length ? banner('warning', `Odoo does not know ${exp.odoo.unknown.join(', ')}.`) : null,
      s.register?.expenses > 0 ? poLinker(s) : null);
  }

  // -------------------------------------------------------- exceptions --

  function describe(x) {
    const e = x.event || {};
    const paid = `${e.kind === 'momo' ? 'MoMo' : `card${e.last4 ? ` …${e.last4}` : ''}`} ${money(e.amount)}`;
    switch (x.kind) {
      case 'failed': return [`The terminal declined it at ${when(e.at)} (${e.status || 'not approved'}) and never approved it afterwards. ASSD has it as paid by card.`, ...othersSay(x)].join(' ');
      case 'not-found': return ['ASSD says card or MoMo. Nothing of this amount was approved, received or credited near the shift.', ...othersSay(x)].join(' ');
      case 'zero': return 'A card payment keyed with no amount.';
      case 'double-charge': return `Card …${e.last4} was charged ${money(e.amount)} twice, ${x.minutesApart} minutes apart (${time(x.twin?.at)} and ${time(e.at)}). ASSD has it once.`;
      case 'transposition': return `The terminal took ${paid} at ${time(e.at)}. ASSD has ${money(x.amount)}: the same digits in another order.`;
      case 'decimal': return `The terminal took ${paid} at ${time(e.at)}. ASSD has ${money(x.amount)}: out by a factor of ten.`;
      case 'keying': return `The terminal took ${paid} at ${time(e.at)}. ASSD has ${money(x.amount)}: one digit different.`;
      case 'paid-less': return `ASSD has ${money(x.assd)} by card or MoMo (ASSD ${x.seq}); only ${paid} was ${e.kind === 'momo' ? 'received' : 'approved'}, at ${time(e.at)}. ${money(x.amount)} ASSD counts as taken never arrived: the guest owes it, paid it another way, or ASSD was keyed too high.`;
      case 'paid-more': return `ASSD has ${money(x.assd)} by card or MoMo (ASSD ${x.seq}); ${paid} was ${e.kind === 'momo' ? 'received' : 'approved'} at ${time(e.at)}. The guest paid ${money(x.amount)} more than ASSD shows: owed back, a deposit for later, or keyed short.`;
      case 'duplicate': return [`Keyed twice in this shift (also ASSD ${x.pair}) and paid once on the terminal.`, ...othersSay(x)].join(' ');
      case 'not-recorded': return `${e.kind === 'momo' ? 'MoMo received' : 'Approved on the terminal'} at ${when(e.at, e.day)}${e.last4 ? `, card …${e.last4}` : ''}. ASSD has no payment of this amount.`;
      case 'never-settled': return `Approved on the terminal ${when(e.at)}, card …${e.last4}, approval ${e.approval}. No bank credit six days on.`;
      case 'reversal': return `The bank took ${money(Math.abs(x.amount))} back from card …${e.last4} (tapped ${shortDay(e.day)}).${x.pairedWith ? ' It answers a refund keyed in ASSD.' : ' No refund of that amount is keyed in ASSD in these days.'}`;
      case 'refund': return x.pairedWith ? 'A card refund keyed in ASSD. The bank reversal for it is on the statement.'
        : x.unbacked ? `A card refund of ${money(Math.abs(x.amount))} keyed in ASSD (ASSD ${x.seq}), and no reversal on the bank statement six days on. If no money went back to a guest’s card, ASSD shows ${money(Math.abs(x.amount))} less card money than was taken: say why it was keyed.`
          : 'A card refund keyed in ASSD. No matching reversal on the bank statement yet.';
      case 'regrouped': return `The shift’s unmatched lines (${(x.lines || []).map((a) => money(a)).join(' + ')}) add up exactly to its unmatched payments (${(x.events || []).map((ev) => money(ev.amount)).join(' + ')}).`;
      case 'other-shift': return `Paid at ${when(e.at)}${x.otherShift ? ` on ${nameOf(x.otherShift.user)}’s ${SLOT[x.otherShift.slot]?.label.toLowerCase() || ''} shift of ${shortDay(x.otherShift.day)}` : ''}, and keyed on this one.`;
      case 'corrected': return `Keyed and reversed in the same shift (ASSD ${x.pair}). Nothing is owed.`;
      case 'drawer-short':
      case 'drawer-over': return `It should have held ${money(x.expected)}. ${x.closingFrom === 'typed' ? 'The recount' : 'ASSD’s closing count'} found ${money(x.closing)}.`
        + (x.still ? ` ${money(Math.abs(x.still))} of the cash ASSD ${x.still > 0 ? 'counts as taken' : 'counts as paid out'} was keyed while the drawer’s counts did not move: see “Keyed as cash, but the drawer did not move”.` : '');
      case 'keyed-no-cash': return `The counts held ${stillRuns(x.spans || []).join('; ')}. Yet ASSD has cash keyed in between: `
        + `${(x.spans || []).flatMap((p) => p.lines).map((l) => `ASSD ${l.seq} ${signed(l.amount)}`).join(', ')}, ${signed(x.amount)} in all.`
        + ` By the drawer’s own counts that money ${x.amount > 0 ? 'never came in' : 'never went out'}: stock put right through the till, or counts copied from the last one. Say which.`;
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
      case 'receipts-unclear': {
        const said = { report: 'the closing report’s expenses fit it', drawer: 'it is the reading under which the drawer agrees', person: `${x.by || 'somebody'} said so` }[x.why];
        return `The receipts went from ${money(x.prev)} to ${money(x.now)} at ASSD ${x.seq}, with no cash movement. Either only ${money(x.left)} of them were handed in and nothing new was spent, or all ${money(x.prev)} were handed in and the ${money(x.now)} now counted is new spending.`
          + (x.reading ? ` Read as: ${x.reading === 'all' ? `all handed in, ${money(x.now)} new` : `only ${money(x.left)} handed in`}, because ${said}.` : ' Neither the closing report nor the drawer settles it: say which.');
      }
      case 'receipts-carried': {
        const said = { pos: `the shift’s POs add up to the ${money(x.move)} movement, so it was cash paid for them`, person: `${x.by || 'somebody'} said so` }[x.why];
        return `The count before the ${money(x.move)} movement (ASSD ${x.seq}) showed receipts, so the movement looked like it took ${money(x.amount)} of them out. But the counts after it still show them. Either they stayed in the drawer and the movement was ${money(x.amount)} of cash, or they went and ${money(x.amount)} of new receipts came in. The drawer agrees either way; what changes is the expenses.`
          + (x.reading ? ` Read as: ${x.reading === 'stayed' ? 'they stayed; the movement was cash' : 'they went; new receipts came'}, because ${said}.` : ' Counted once (as stayed) until you say which.');
      }
      case 'receipts-swapped': return `${money(x.amount)} of receipts went out of the drawer with no cash movement, and cash was put in for them: the notes went up by as much. Here they are not cash; they stay expenses of the shift they were spent on, below.`;
      case 'expense-no-po': return `${money(x.amount)} left the drawer as expenses${x.seqs?.length ? ` (ASSD ${x.seqs.join(', ')})` : ''} with no PO: none on the closing report in HIVE and none linked here. Link the PO, or answer why there is none.`;
      case 'expense-po-gap': return `${money(x.expenses)} left the drawer as expenses${x.seqs?.length ? ` (ASSD ${x.seqs.join(', ')})` : ''}, but the POs (${(x.pos || []).join(', ')}) come to ${money(x.poTotal)} in Odoo: ${money(Math.abs(x.amount))} ${x.amount > 0 ? 'more' : 'less'} was paid than the POs say. Link the missing PO, unlink a wrong one, or answer why.`;
      case 'movement-unlabelled': return `${money(x.amount)} ${x.part ? `of the ${money(x.whole)} moved out` : 'moved out of the drawer'} (ASSD ${x.seq}) and no count says whether it went to the safe or on expenses.`
        + `${x.pending ? ` ${x.pending.by} has proposed: ${x.pending.kind}. Waiting for an admin.` : ' Say which.'}`;
      case 'laundry-mismatch': return `ASSD has ${money(x.assd)} of laundry on this shift; the laundry system took ${money(x.system)} in the same hours`
        + `${x.payments ? ` (${x.payments} payment${x.payments === 1 ? '' : 's'})` : ''}${x.charged ? `, and accepted ${money(x.charged)} of new orders` : ''}.`
        + ` ${x.amount > 0 ? 'Laundry was charged at the desk that the laundry system has not taken.' : 'The laundry took money that ASSD does not show.'}`
        + (x.paired ? ` ${money(x.paired)} of it was paid by card on the hotel's terminal and is shown on its own; this is what is left.` : '');
      case 'laundry-card': return `The guest paid the laundry by card on the hotel terminal, and it was not keyed in ASSD. The money arrived; ASSD’s laundry for this shift is ${money(x.amount)} short.`;
      case 'bank-only': return `A card credit on the bank statement, card …${e.last4}, tapped ${shortDay(e.day)}, with no record on the terminal report.`;
      default: return '';
    }
  }

  /** What the terminal's declined tries and the laundry system say about a line keyed twice or not paid. */
  function othersSay(x) {
    const out = [];
    const hm = (at) => String(at || '').slice(11, 16);
    const amount = money(x.amount);
    for (const d of x.declined || []) out.push(`The terminal declined ${amount} at ${hm(d.at)}${d.last4 ? ` (card …${d.last4})` : ''}: a failed try, keyed as well${x.kind === 'duplicate' ? '.' : ', or the guest paid another way.'}`);
    const l = x.laundry;
    if (!l) return out;
    if (!l.read) { out.push('It is laundry; the laundry system has not been read for this shift yet, so it cannot say how many were paid.'); return out; }
    const n = l.same.length;
    const list = l.same.map((t) => `${t.method || 'paid'} ${hm(t.at)}${t.ref ? `, ${t.ref}` : ''}`).join('; ');
    if (x.kind === 'duplicate') {
      out.push(n === 1 ? `The laundry system took ${amount} once (${list}): one laundry payment, keyed twice. Reverse the second line in ASSD.`
        : n > 1 ? `The laundry system took ${amount} ${n} times (${list}): both were real. Only one reached the terminal; the other was paid another way, or is owed.`
          : `The laundry system has no payment of ${amount} on this shift.`);
    } else if (x.kind === 'failed') {
      out.push(n ? `It is laundry, and the laundry system has it paid (${list}): the guest paid after all, another way or on a later try.`
        : `It is laundry, and the laundry system has no payment of ${amount} on this shift either: it may still be owed.`);
    } else {
      out.push(n ? `The laundry system took ${amount} (${list}).${l.same.some((t) => t.method === 'cash') ? ' In cash there: ASSD may have the wrong way of paying.' : ''}`
        : `The laundry system has no payment of ${amount} on this shift either.`);
    }
    return out;
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
    if (x.kind === 'paid-more' || x.kind === 'paid-less') {
      const e = x.event || {};
      const less = x.kind === 'paid-less';
      return h('div',
        h(`div.sh-sides.sh-paidmore${less ? '.less' : ''}`,
          h('div', h('small', h('i', { style: 'background:var(--sh-info)' }), 'ASSD'), h('b.num', money(x.assd)), h('span', `Card or MoMo · ASSD ${x.seq}`)),
          h('span.eq', `${less ? '−' : '+'}${whole(x.amount)}`, h('small', less ? 'less' : 'more')),
          h('div', h('small', h('i', { style: `background:${e.kind === 'momo' ? 'var(--sh-warn)' : '#3f78d3'}` }), e.kind === 'momo' ? 'MoMo' : 'Card terminal'), h('b.num', money(x.paid)),
            h('span', `${e.kind === 'momo' ? 'Received' : 'Approved'} ${time(e.at)}${e.last4 ? ` · card …${e.last4}` : ''}`))),
        h(`p.sh-paired.sh-paidmore${less ? '.less' : ''}`, `Same shift, close to the payments keyed around it, and no other payment that could be either one: one payment, ${money(x.amount)} ${less ? 'less' : 'more'} than ASSD shows.`));
    }
    if (x.kind === 'laundry-card') {
      const hm = (at) => String(at || '').slice(11, 16);
      return h('div',
        h('div.sh-sides',
          h('div', h('small', h('i', { style: 'background:#3f78d3' }), 'Card terminal'), h('b.num', money(x.event?.amount)),
            h('span', `Approved ${hm(x.event?.at)}${x.event?.last4 ? ` · card …${x.event.last4}` : ''}`)),
          h('span.eq', '='),
          h('div', h('small', h('i', { style: 'background:#d8812f' }), 'Laundry system'), h('b.num', money(x.laundry?.amount)),
            h('span', `Paid by card ${hm(x.laundry?.at)}${x.laundry?.ref ? ` · ${x.laundry.ref}` : ''}`))),
        h('p.sh-paired', `✓ Same amount, both by card, ${x.minutesApart === 0 ? 'the same minute' : `${x.minutesApart} minute${x.minutesApart === 1 ? '' : 's'} apart`}, on this shift: one payment, seen twice.`));
    }
    if (['duplicate', 'not-found'].includes(x.kind) && (x.laundry || x.declined?.length)) {
      const cell = (label, value, sub) => h('div', h('small', label), h('b', value), sub ? h('span.small', sub) : null);
      const lines = x.kind === 'duplicate' ? 2 : 1;
      const paid = x.kind === 'duplicate' ? 1 : 0;
      const same = x.laundry?.same?.length;
      return h('div.sh-evidence.sh-three',
        cell('ASSD', `${lines} × ${whole(x.amount)}`, 'card or MoMo'),
        cell('Terminal', `${paid} paid`, x.declined?.length ? `${x.declined.length} declined` : 'none declined'),
        x.laundry ? cell('Laundry system', x.laundry.read ? `${same} × ${whole(x.amount)}` : 'not read', x.laundry.read ? 'payments' : 'yet') : null);
    }
    if (x.kind === 'laundry-mismatch') return box(['ASSD', h('b', whole(x.assd))], 'vs', [x.paired ? 'Laundry system, the rest' : 'Laundry system', h('b', whole(x.system - (x.paired || 0)))]);
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
    if (['not-recorded', 'bank-only', 'double-charge', 'paid-more', 'refund'].includes(x.kind)) return a;
    if (['not-found', 'failed', 'zero', 'never-settled', 'reversal', 'duplicate', 'paid-less'].includes(x.kind)) return -a;
    // ASSD less the other side: a laundry that took money ASSD does not show is below nothing.
    if (['drawer-over', 'drawer-short', 'handover-gap', 'laundry-mismatch'].includes(x.kind)) return x.amount;
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
    const words = (KIND[kind] || [kind])[0];
    return /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? `${words}, ${dayText(day)}${slot && SLOT[slot] ? ` ${SLOT[slot].label.toLowerCase()}` : ''}` : words;
  }

  /** Unanswered exceptions elsewhere of the same amount, pulling the other way. */
  function relatedTo(x) {
    const f = flowOf(x);
    if (f == null || !f || x.answer) return [];
    const near = (d) => !x.day || !d || Math.abs((Date.parse(d) - Date.parse(x.day)) / 86400000) <= 7;
    return data.exceptions.filter((o) => o !== x && !o.answer && (!o.proposed || admin) && o.severity !== 'info' && flowOf(o) === -f && near(o.day)).slice(0, 3);
  }

  async function reconcile(keys, note) {
    const out = await api('/shifts/link', { method: 'POST', body: { keys, note } });
    picked.clear(); pickedAs.clear();
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
    const from = x.swapFrom || [];
    const gone = [...new Set(from.map((o) => o.gone))];
    return h('div.sh-suggest',
      x.swapped
        ? [h('span', h('b', 'The extra cash matches receipts that went missing. '),
          `${money(x.swapped)} of receipts were in the drawer, then gone at count ASSD ${gone.join(', ') || '?'}, with no cash movement to take them out. At the same time the notes went up by ${money(x.swapped)}. Most likely someone took the receipts out and put cash in their place.`),
        from.length ? swapFromBlock(from) : null,
        h('span', h('button.btn.primary', { type: 'button', onclick: () => send((x.swapped / 100).toFixed(2)) }, `Reconcile: ${money(x.swapped)} of receipts swapped for cash`))]
        : h('span', 'Receipts from an earlier shift swapped for cash? Type how much and reconcile it.'),
      x.swapped ? null : h('div.sh-fixrow', amount, h('button.btn', { type: 'button', onclick: () => send(amount.value) }, 'Reconcile')));
  }

  /**
   * Whose receipts left the drawer with no movement: each shift they were
   * spent on (a link), by whom, the count they first appeared in, and the
   * count where they went. Their PO belongs to that shift.
   */
  function swapFromBlock(from) {
    const when = (o) => `${dayText(o.day)}, ${SLOT[o.slot]?.label.toLowerCase() || o.slot}`;
    const others = from.filter((o) => !o.here && !o.earlier);
    return h('div.sh-swapfrom',
      h('b', 'Where the receipts were spent'),
      from.map((o) => h('div.sh-swaprow',
        h('span', o.here ? `This shift, ${when(o)}` : o.earlier ? 'Before the days Insight has read'
          : h('button.sh-link', { type: 'button', onclick: () => openShift(o.day, o.slot) }, when(o)),
        o.user ? ` · ${nameOf(o.user)}` : '',
        o.seqs?.length ? ` · first in count ASSD ${o.seqs.join(', ')}` : ''),
        h('b.num', money(o.amount)))),
      h('small', others.length
        ? `They are that shift’s expenses: their PO belongs there, not here.`
        : 'They are this shift’s expenses: their PO belongs here.'),
      legsBlock(from));
  }

  /**
   * Both sides of a swap: the count where the receipts appeared (spent from
   * the drawer) and the count where they went with no movement, each with
   * the receipts and the notes and coins either side of it.
   */
  function legsBlock(from) {
    const when = (o) => `${dayText(o.day)}, ${SLOT[o.slot]?.label.toLowerCase() || o.slot}`;
    const span = (a, b) => `${whole(a)} → ${whole(b)}`;
    const diff = (a, b) => { const d = b - a; return d ? `${d > 0 ? '+' : '−'}${whole(Math.abs(d))}` : 'no change'; };
    const cells = (l) => [
      h('td.n.num', span(l.receiptsBefore, l.receiptsAfter), h('small', diff(l.receiptsBefore, l.receiptsAfter))),
      h('td.n.num', span(l.notesBefore, l.notesAfter), h('small', diff(l.notesBefore, l.notesAfter)))];
    const rows = [];
    for (const o of from.filter((x) => x.leg)) {
      rows.push(h('tr',
        h('td', h('b', 'Spent'),
          h('small', o.here ? 'this shift' : h('button.sh-link', { type: 'button', onclick: () => openShift(o.day, o.slot) }, when(o))),
          h('small', `ASSD ${o.leg.prev} → ${o.seqs?.[0] ?? ''}`)),
        ...cells(o.leg)));
    }
    const gone = [...new Map(from.filter((x) => x.goneLeg).map((x) => [x.gone, x.goneLeg])).entries()];
    for (const [seq, l] of gone) {
      rows.push(h('tr',
        h('td', h('b', 'Taken out, no cash movement'), h('small', 'this shift'), h('small', `ASSD ${l.prev} → ${seq}`)),
        ...cells(l)));
    }
    if (!rows.length) return null;
    const [seq, l] = gone[0] || [];
    const out = l ? l.receiptsBefore - l.receiptsAfter : 0;
    const up = l ? l.notesAfter - l.notesBefore : 0;
    return h('div.sh-legs',
      h('b', 'Both sides of the swap'),
      h('table.sh-otable',
        h('thead', h('tr', h('th', 'What'), h('th.n', 'Receipts'), h('th.n', 'Notes and coins'))),
        h('tbody', rows)),
      l ? h('small', up === out
        ? `Between the count before and ASSD ${seq}, the receipts went down by ${money(out)} and the notes and coins went up by exactly as much: the cash came back for the receipts.`
        : `Between the count before and ASSD ${seq}, the receipts went down by ${money(out)} and the notes and coins went ${up >= 0 ? 'up' : 'down'} by ${money(Math.abs(up))}; anything taken or paid between the two counts is in that too.`) : null);
  }

  /** Answered, or explained by the rules: nothing left to do. */
  const settled = (x) => Boolean(x.answer) || x.severity === 'info';

  // ------------------------------------------------------ the shift page --
  // At the top, four numbers; on the left, what is still to sort out, each
  // difference answered in the list; on the right, the details in tabs.

  /** What was open on the left, and the tab on the right, kept while moving from shift to shift. */
  const opened = new Set();
  let shTab = null;

  /** Beside the status: 🔒 when the shift is checked, so locked. */
  function lockChip(s) {
    const el = h('span');
    till.checks().then((map) => {
      const st = map.get(`${s.day}|${s.slot}`);
      if (st === 'ok' || st === 'changed') {
        mount(el, h(`span.sh-chip.${st === 'ok' ? 'ok' : 'over'}.sh-lockchip`, { title: 'Checked, so locked: nothing on it can be changed until the check is undone (below, in To sort out).' },
          st === 'ok' ? '🔒 Checked · locked' : '🔒 Locked · changed since checked'));
      }
    }).catch(() => {});
    return el;
  }

  /** ⋯ beside the status: the reconciliation report, moving the shift, its history. */
  function shiftMenu(s) {
    const pop = h('div.sh-pop', { hidden: true },
      may('money') ? h('button', { type: 'button', onclick: () => { pop.hidden = true; openRecon(s); } }, '⤓ Reconciliation report') : null,
      admin && !s.open ? h('button', { type: 'button', onclick: () => {
        pop.hidden = true;
        const link = document.querySelector('.sh-movebox > .sh-link');
        if (link) { link.click(); link.scrollIntoView?.({ block: 'center' }); }
      } }, '↪ Wrong day or slot? Move this shift') : null,
      h('button', { type: 'button', onclick: () => { pop.hidden = true; document.querySelector('[data-shtab="history"]')?.click(); } }, '📝 Notes and history'));
    const wrap = h('div.sh-menu', h('button.btn', { type: 'button', 'aria-label': 'More', onclick: (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; } }, '⋯'), pop);
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) pop.hidden = true; });
    return wrap;
  }

  /** The shift at a glance: what was taken, the drawer, card and MoMo, what is left to sort out. Each opens its detail. */
  function shiftStrip(s, n) {
    const hide = Boolean(data.redacted) || !may('money');
    const m = modesOf(s);
    const total = MODES.reduce((sum, [k]) => sum + Math.max(0, m[k] || 0), 0);
    const items = todoOf(s);
    const open = items.filter((i) => !i.done && !i.waiting).length;
    const waiting = items.filter((i) => i.waiting).length;
    const v = n ? n.variance : (s.register?.variance ?? s.register?.varianceSign);
    const settledDrawer = Boolean(drawerSettled(s)) && !(n?.recounted);
    const tile = (tab, label, value, sub, cls = '') => h('button.sh-tile2', { type: 'button', onclick: () => (tab === 'todo' ? document.querySelector('.sh-todopane')?.scrollIntoView({ behavior: 'smooth' }) : document.querySelector(`[data-shtab="${tab}"]`)?.click()) },
      h('small', label), h(`b${cls ? `.${cls}` : ''}`, value), sub ? h('span', sub) : null);
    const allCard = s.cardFound + (s.cardAnswered || 0) === s.cardLines;
    return h('div.sh-glance',
      hide ? null : tile('payments', 'Taken', money(total),
        h('span.sh-glancemix', mixBar(s), MODES.filter(([k]) => m[k] > 0).map(([k, label]) => `${label === 'Card and MoMo' ? 'Card' : label.replace('Prepaid by ', 'Prepaid ')} ${whole(m[k])}`).join(' · '))),
      tile('drawer', 'The drawer',
        s.open ? 'Ends here' : v == null ? 'No count' : v === 0 ? '✓ Agrees' : settledDrawer ? `✓ ${v > 0 ? 'Over' : 'Short'}, settled` : `${v > 0 ? 'Over' : 'Short'}${hide ? '' : ` ${money(Math.abs(v))}`}`,
        s.open ? 'the journal ends inside it' : v === 0 ? (hide ? 'what was counted is what it should hold' : `${money(n?.closing ?? s.register?.closing)} counted, as it should hold`) : settledDrawer ? settledWords(drawerSettled(s)) : v == null ? '' : 'see To sort out',
        s.open || v == null ? '' : v === 0 || settledDrawer ? 'ok' : v < 0 ? 'bad' : 'warn'),
      tile('payments', 'Card and MoMo', s.cardLines ? `${s.cardFound + (s.cardAnswered || 0)} of ${s.cardLines} found` : 'None',
        s.cardLines ? (allCard ? 'every one arrived' : `${s.cardLines - s.cardFound - (s.cardAnswered || 0)} not found`) : 'no card or MoMo this shift', !s.cardLines || allCard ? 'ok' : 'bad'),
      tile('todo', 'To sort out', open ? `${open} open` : waiting ? `${waiting} waiting` : '✓ All answered',
        `${items.filter((i) => i.done).length} answered${waiting && open ? ` · ${waiting} waiting for an admin` : ''}`, open ? 'bad' : waiting ? 'warn' : 'ok'));
  }

  /**
   * On the left: the shift's differences as one list. An open one opens on
   * its card, answered right there; an answered one says how, and opens on
   * its card (with Undo). Those explained by the rules fold into one line.
   * The check is the last step.
   */
  function todoPane(s, checked) {
    const all = exceptionsOf(s).filter((x) => seesEx(x));
    const items = todoOf(s);
    const byKey = new Map(items.map((i) => [i.key, i]));
    const done = items.filter((i) => i.done).length;
    // The first open one starts open, so its answers are there at once.
    const first = items.find((i) => !i.done && !i.waiting);
    if (first && ![...opened].some((k) => byKey.has(k))) opened.add(first.key);
    const total = items.length + 1;
    const list = diffChecklist(all);
    return h('section.card.sh-todopane',
      h('div.sh-cardhead', h('h2', 'To sort out'), h(`span.sh-chip.${done === items.length ? 'ok' : 'none'}`, `${done} of ${items.length} answered`)),
      h('div.sh-outbar', h('i', { style: `width:${total > 1 ? (done / items.length) * 100 : 100}%` })),
      seenTwice(s).map(seenTwiceCard),
      list || h('p.small.muted', 'Nothing on this shift needs an answer.'),
      h('div.sh-checkstep', checked),
      pickedBar());
  }
  /**
   * Differences as a checklist: open first, then waiting for an admin, then
   * answered; each line opens on its card, answered there. Those the rules
   * explained fold into one line. `who` adds whose shift each is (a day's).
   */
  function diffChecklist(xs, { who = false } = {}) {
    const shown = xs.filter((x) => x.severity !== 'info');
    const rules = xs.filter((x) => x.severity === 'info');
    if (!shown.length && !rules.length) return null;
    const card = (x) => { const c = exceptionCard(x); c.id = `ex-${x.key}`; c.append(taskBox(x), notesBox(x)); fillNoteCounts(c); return c; };
    const whose = (x) => (who && (x.user || x.slot) ? `${x.user ? nameOf(x.user) : ''}${x.slot ? `${x.user ? ', ' : ''}${SLOT[x.slot].label.toLowerCase()}` : ''} · ` : '');
    const row = (x, i) => {
      const box = h('div');
      const isOpen = opened.has(x.key);
      const wrap = h(`div.sh-item${i.done ? '.done' : i.waiting ? '.wait' : '.open'}${isOpen ? '.expanded' : ''}`);
      const more = h('small.sh-more2', isOpen ? 'Close ▴' : i.done ? 'Open ▾' : 'Answer ▾');
      const head = h('button.sh-itemrow', { type: 'button', 'aria-expanded': String(isOpen), onclick: () => {
        if (opened.has(x.key)) opened.delete(x.key); else opened.add(x.key);
        wrap.classList.toggle('expanded');
        head.setAttribute('aria-expanded', String(opened.has(x.key)));
        mount(box, opened.has(x.key) ? card(x) : null);
        mount(more, opened.has(x.key) ? 'Close ▴' : i.done ? 'Open ▾' : 'Answer ▾');
      } },
      h('span.box', i.done ? '✓' : i.waiting ? '…' : ''),
      h('span.t', h('b', (KIND[x.kind] || [x.kind])[0]), h('small', whose(x), i.sub || describeShort(x))),
      h('span.amt.num', x.amount == null ? '' : flowText(flowOf(x)) || money(Math.abs(x.amount)), more));
      if (isOpen) mount(box, card(x));
      wrap.append(head, box);
      return wrap;
    };
    const order = (i) => (i.done ? 2 : i.waiting ? 1 : 0);
    const list = shown.map((x) => [x, itemOf(x)]).sort((a, b) => order(a[1]) - order(b[1]));
    const rulesBox = h('div.sh-rulesbox');
    let rulesOpen = false;
    const drawRules = () => mount(rulesBox,
      h('button.sh-link.sh-rulesbtn', { type: 'button', onclick: () => { rulesOpen = !rulesOpen; drawRules(); } }, `✓ ${rules.length} matched or explained by the rules ${rulesOpen ? '▾' : '▸'}`),
      rulesOpen ? h('div.sh-ruleslist', rules.map((x) => row(x, { done: true, sub: describeShort(x) }))) : null);
    if (rules.length) drawRules();
    return h('div', list.length ? h('div.sh-items', list.map(([x, i]) => row(x, i))) : null, rules.length ? rulesBox : null);
  }
  /** One line for a difference the rules explained. */
  const describeShort = (x) => { const d = String(describe(x) || ''); return d.length > 110 ? `${d.slice(0, 108)}…` : d; };

  /**
   * On the right: the details, one tab at a time. A dot marks a tab with
   * something open. History gathers the notes and events of every
   * difference on the shift.
   */
  function detailTabs(s, panels) {
    const NAMES = [['drawer', 'Drawer'], ['payments', 'Payments'], ['cash', 'Cash out & expenses'], ['stock', 'Stock'], ['report', 'Closing report'], ['history', 'History']];
    const have = NAMES.filter(([k]) => panels[k]);
    if (!shTab || !have.some(([k]) => k === shTab)) shTab = have[0][0];
    const bar = h('div.sh-dtabs', { role: 'tablist' });
    const body = h('div.sh-tabbody');
    const built = {};
    const dot = {};
    const open = exceptionsOf(s).filter((x) => seesEx(x) && !x.answer && !x.link && x.severity !== 'info');
    const CARD = new Set(['not-found', 'failed', 'zero', 'double-charge', 'not-recorded', 'bank-only', 'paid-more', 'paid-less', 'never-settled', 'reversal', 'duplicate', 'laundry-card']);
    dot.payments = open.some((x) => CARD.has(x.kind) || x.group === 'laundry');
    dot.cash = open.some((x) => ['nopo', 'unlabelled'].includes(x.group) || String(x.kind).startsWith('movement'));
    const paint = () => {
      mount(bar, have.map(([k, label]) => h(`button${shTab === k ? '.on' : ''}`, { type: 'button', role: 'tab', 'aria-selected': String(shTab === k), dataset: { shtab: k }, onclick: () => { shTab = k; paint(); } },
        label, dot[k] ? h('span.sh-tdot', { 'aria-label': 'something open' }) : null)));
      if (!built[shTab]) built[shTab] = shTab === 'history' ? historyBox(s) : panels[shTab];
      mount(body, built[shTab]);
    };
    // A closing report that is not there is something to see to.
    if (panels.report) {
      new MutationObserver(() => { const missing = /No closing report/.test(panels.report.textContent); if (missing !== Boolean(dot.report)) { dot.report = missing; paint(); } })
        .observe(panels.report, { childList: true, subtree: true });
    }
    return {
      el: h('section.card.sh-detailpane', bar, body),
      show: paint,
      // The drawer's dot moves with a recount being typed.
      dots: (n) => { const d = n.variance != null && n.variance !== 0 && !(drawerSettled(s) && !n.recounted); if (d !== Boolean(dot.drawer)) { dot.drawer = d; paint(); } },
    };
  }

  /** Every note and event on the shift's differences, and on the shift itself, newest first. */
  function historyBox(s) {
    const box = h('div.sh-history', h('p.small.muted', 'Reading…'));
    const xs = exceptionsOf(s).filter((x) => seesEx(x)).slice(0, 40);
    const keys = [...xs.map((x) => [x.key, (KIND[x.kind] || [x.kind])[0]]), [`shift:${s.day}:${s.slot}`, 'The shift']];
    Promise.all(keys.map(([key, about]) => api(`/shifts/notes?key=${encodeURIComponent(key)}`).then((d) => d.items.map((it) => ({ ...it, about }))).catch(() => [])))
      .then((lists) => {
        const items = lists.flat().sort((a, b) => (String(a.at) < String(b.at) ? 1 : -1));
        mount(box, items.length ? h('ul.sh-hist', items.map((it) => h(`li${it.type === 'note' ? '.note' : ''}`,
          h('span.small.muted', `${it.about} · `),
          it.type === 'note' ? [h('b', it.by), ' (note) ', h('div.txt', it.text)] : [it.text, it.by ? h('span.small.muted', ` · ${it.by}`) : null],
          h('small', String(it.at).slice(0, 16).replace('T', ' ')))))
          : h('p.small.muted', 'Nothing yet. Answers, approvals, moves and notes on this shift are kept here.'),
        h('p.small.muted', 'To add a note, open a difference on the left: Notes and history.'));
      });
    return box;
  }

  // ------------------------------------------------------ moving a shift --

  /**
   * A whole shift on the wrong day or slot (a night whose opening ASSD dated
   * the next morning): an admin moves it, at most two days either way, saying
   * why. Its counts, answers and notes go with it; Put it back undoes it.
   */
  function moveBox(s) {
    const seqs = (s.sessions || []).map((x) => x.startSeq).filter((n) => n != null);
    const startSeqs = seqs.length ? seqs : [s.startSeq];
    const where = (day, slot) => `the ${SLOT[slot]?.label.toLowerCase() || slot} of ${dayText(day)}`;
    // Read again from the server, and open the shift where it now is.
    const reopen = (day, slot, words) => {
      currentId = `${day}|${slot}`;
      store.set('shift', currentId);
      section = 'shifts';
      detail = true;
      anchor = day;
      remember();
      return load(banner('good', words));
    };
    if (s.moved) {
      return h('div.sh-movednote', `↪ Moved here from ${where(s.moved.fromDay, s.moved.fromSlot)} by ${s.moved.by || 'an admin'}: “${s.moved.why}”. `,
        admin ? h('button.sh-link', { type: 'button', onclick: async () => {
          if (!confirm(`Put this shift back on ${where(s.moved.fromDay, s.moved.fromSlot)}, where the journal puts it? Its counts and answers go back with it.`)) return;
          try {
            await api('/shifts/place', { method: 'POST', body: { startSeqs, back: true } });
            reopen(s.moved.fromDay, s.moved.fromSlot, `Put back on ${where(s.moved.fromDay, s.moved.fromSlot)}.`);
          } catch (err) { alert(err.message); }
        } }, 'Put it back') : null);
    }
    if (!admin || s.open || !s.startSeq) return null;
    const box = h('div.sh-movebox');
    const open = () => {
      const choices = [];
      for (let d = -2; d <= 2; d += 1) {
        const day = plusDays(s.day, d);
        for (const sl of SLOTS) {
          if (day === s.day && sl === s.slot) continue;
          const taken = byId.get(`${day}|${sl}`);
          choices.push(h('option', { value: `${day}|${sl}` }, `${dayText(day)} · ${SLOT[sl].label} ${SLOT[sl].hours}${taken ? ` (has ${nameOf(taken.user)}’s shift)` : ''}`));
        }
      }
      const to = h('select', choices);
      // The usual mistake: a night dated the next morning. Offered first.
      const night = SLOTS.indexOf(s.slot) === 0 ? `${plusDays(s.day, -1)}|night` : null;
      if (night) to.value = night;
      // A shift made of two ASSD sessions (one person's shift joined to the next one's): one of them can be taken out on its own.
      const parts = (s.sessions || []).filter((x) => x.startSeq != null);
      const which = parts.length > 1 ? h('select',
        h('option', { value: 'all' }, `All of it (${parts.map((x) => nameOf(x.user)).join(' and ')})`),
        parts.map((x, k) => h('option', { value: String(k) }, `Only ${nameOf(x.user)}’s session`))) : null;
      which?.addEventListener('change', () => {
        if (which.value === 'all') return;
        // The first session most likely belongs to the slot before, the last to the slot after.
        const k = Number(which.value);
        const i = SLOTS.indexOf(s.slot);
        const before = i > 0 ? `${s.day}|${SLOTS[i - 1]}` : `${plusDays(s.day, -1)}|night`;
        const after = i < 2 ? `${s.day}|${SLOTS[i + 1]}` : `${plusDays(s.day, 1)}|morning`;
        to.value = k === 0 ? before : after;
      });
      const why = h('input', { type: 'text', maxlength: '300', placeholder: 'e.g. The night shift of the 30th; ASSD dated its opening the next morning' });
      const said = h('span.small');
      const go = h('button.btn.primary', { type: 'button', onclick: async () => {
        if (!why.value.trim()) { said.textContent = 'Say why it belongs there.'; why.focus(); return; }
        const [day, slot] = to.value.split('|');
        go.disabled = true; said.textContent = 'Moving…';
        try {
          const one = which && which.value !== 'all' ? parts[Number(which.value)] : null;
          await api('/shifts/place', { method: 'POST', body: { startSeqs: one ? [one.startSeq] : startSeqs, carry: !one, day, slot, fromDay: s.day, fromSlot: s.slot, why: why.value } });
          reopen(day, slot, `Moved to ${where(day, slot)}. Its counts and answers came with it.`);
        } catch (err) { said.textContent = err.message; go.disabled = false; }
      } }, 'Move it');
      mount(box, h('div.sh-moveform',
        h('strong', `Move ${nameOf(s.user)}’s shift`),
        h('p.small', 'For a shift the journal put on the wrong day or slot. Its counts, answers, notes and check go with it, and Put it back undoes it. Its closing report in HIVE is moved on its own card, below.'),
        which ? h('label.field', 'What to move', which) : null,
        h('label.field', 'It belongs on', to), h('label.field', 'Why', why),
        h('div.sh-save', go, h('button.btn', { type: 'button', onclick: () => mount(box, opener) }, 'Cancel'), said)));
    };
    const opener = h('button.sh-link', { type: 'button', onclick: open }, 'Wrong day or slot? Move this shift');
    mount(box, opener);
    return box;
  }

  // ---------------------------------------------------------- checklist --

  /**
   * What a shift has to sort out, as a checklist: each difference, ticked
   * once it is answered, reconciled with others or explained, and the check
   * itself, ticked once an admin marks the shift checked.
   */
  function todoOf(s) {
    return exceptionsOf(s).filter((x) => x.severity !== 'info' && seesEx(x)).map(itemOf);
  }
  /** A difference as a line of a checklist: done, waiting for an admin, or open, and how it was settled. */
  function itemOf(x) {
    const done = Boolean(x.answer) || Boolean(x.link && !x.proposed);
    return {
      key: x.key, done, waiting: !done && Boolean(x.proposed), bad: x.severity === 'critical',
      text: `${(KIND[x.kind] || [x.kind])[0]}${x.amount != null && !data.redacted ? ` · ${money(Math.abs(x.amount))}` : ''}`,
      sub: x.answer ? `${x.answer.answer}${x.answer.note ? `: ${x.answer.note}` : ''}${x.answer.by ? ` (${x.answer.by})` : ''}`
        : x.link ? 'Reconciled with others' : x.proposed ? 'Answered, waiting for an admin' : null,
    };
  }

  /**
   * A payment ASSD does not show is on the shift its time falls in. One taken
   * just after a hand-over belongs to the shift before: an admin moves it,
   * saying why, and can put it back.
   */
  function paymentHome(x) {
    if (!x.event?.id || !['not-recorded', 'double-charge'].includes(x.kind) || !x.day || !x.slot) return null;
    const box = h('div.sh-payhome');
    const back = async () => {
      try {
        await api('/shifts/payment-home', { method: 'POST', body: { eventId: x.event.id, back: true, key: x.key } });
        await load(banner('good', 'Put back on the shift its time falls in.'));
      } catch (err) { alert(err.message); }
    };
    // `home`: moved here by an admin (`moved` is a difference put on staff accounts).
    if (x.home) {
      return h('p.small.sh-payhome', `Moved here from the ${SLOT[x.home.fromSlot]?.label.toLowerCase() || 'other shift'}${x.home.fromDay ? ` of ${dayText(x.home.fromDay)}` : ''} by ${x.home.by}: “${x.home.why}”. `,
        admin ? h('button.sh-link', { type: 'button', onclick: back }, 'Put it back') : null);
    }
    if (!admin) return null;
    const i = SLOTS.indexOf(x.slot);
    const before = i > 0 ? { day: x.day, slot: SLOTS[i - 1] } : { day: plusDays(x.day, -1), slot: 'night' };
    const after = i < 2 ? { day: x.day, slot: SLOTS[i + 1] } : { day: plusDays(x.day, 1), slot: 'morning' };
    const open = () => {
      const why = h('input', { type: 'text', maxlength: '300', placeholder: 'Taken just after the hand-over, for an afternoon guest' });
      const said = h('span.small');
      const move = (to) => async () => {
        if (!why.value.trim()) { said.textContent = 'Say why it belongs to that shift.'; why.focus(); return; }
        said.textContent = 'Moving…';
        try {
          await api('/shifts/payment-home', { method: 'POST', body: { eventId: x.event.id, key: x.key, day: to.day, slot: to.slot, why: why.value, fromDay: x.day, fromSlot: x.slot } });
          await load(banner('good', `Moved to the ${SLOT[to.slot].label.toLowerCase()} of ${dayText(to.day)}. Its person answers it now.`));
        } catch (err) { said.textContent = err.message; }
      };
      mount(box, h('div.sh-payform',
        h('b', 'Which shift took it?'),
        h('label.field', 'Why', why),
        h('div.sh-safeinline',
          h('button.btn', { type: 'button', onclick: move(before) }, `‹ The ${SLOT[before.slot].label.toLowerCase()}, ${dayText(before.day)}`),
          h('button.btn', { type: 'button', onclick: move(after) }, `The ${SLOT[after.slot].label.toLowerCase()}, ${dayText(after.day)} ›`),
          h('button.sh-link', { type: 'button', onclick: () => mount(box, link()) }, 'Cancel')),
        said));
    };
    const link = () => h('button.sh-link', { type: 'button', onclick: open }, 'Wrong shift? Move it');
    mount(box, link());
    return box;
  }

  /**
   * Notes and history on a difference: what happened to it, with who and
   * when, and notes by admins and supervisors, tagging whoever should read
   * them (they are emailed). Read when opened; the count is filled in for the
   * cards on screen at once.
   */
  const notesOpen = new Set();
  let notePeople = null;
  function notesBox(x) {
    const toggle = h('button.sh-link.sh-notes-tog', { type: 'button', dataset: { notesKey: x.key } }, 'Notes and history');
    const body = h('div.sh-notes');
    const draw = async () => {
      mount(body, h('p.small.muted', 'Reading…'));
      let d;
      try { d = await api(`/shifts/notes?key=${encodeURIComponent(x.key)}`); } catch (err) { mount(body, h('p.small', err.message)); return; }
      if (!notePeople) notePeople = (await api('/shifts/notes/people').catch(() => ({ people: [] }))).people;
      toggle.textContent = `▾ Notes and history${d.items.length ? ` · ${d.items.length}` : ''}`;
      const text = h('textarea', { rows: 2, maxlength: 1000, placeholder: 'Add a note (seen by admins and supervisors)' });
      const tagged = new Set();
      const tags = h('div.sh-tags', h('span.small.muted', 'Tag:'), notePeople.map((p) => h('button.sh-tag', {
        type: 'button', 'aria-pressed': 'false',
        onclick: (e) => { if (tagged.has(p.id)) tagged.delete(p.id); else tagged.add(p.id); e.target.setAttribute('aria-pressed', String(tagged.has(p.id))); },
      }, p.name)));
      const said = h('span.small');
      const add = h('button.btn.primary', {
        type: 'button',
        onclick: async () => {
          if (!text.value.trim()) { said.textContent = 'Write the note first.'; return; }
          add.disabled = true; said.textContent = 'Saving…';
          const about = `${(KIND[x.kind] || [x.kind])[0].toLowerCase()}${x.day ? `, ${dayText(x.day)}` : ''}${x.slot ? ` ${SLOT[x.slot].label.toLowerCase()}` : ''}`;
          try {
            const out = await api('/shifts/notes', { method: 'POST', body: { key: x.key, text: text.value, tags: [...tagged], about } });
            await draw();
            if (out.told) mount(body.querySelector('.sh-notesaid') || body, h('span.small', `Emailed ${out.told} tagged.`));
          } catch (err) { said.textContent = err.message; add.disabled = false; }
        },
      }, 'Add note');
      mount(body,
        d.items.length ? h('ul.sh-hist', d.items.map((it) => h(`li${it.type === 'note' ? '.note' : ''}`,
          it.type === 'note'
            ? [h('b', it.by), ' (note)', it.tags?.length ? h('span.small.muted', ` · tagged ${it.tags.map((t) => t.name).join(', ')}`) : null, h('div.txt', it.text)]
            : [it.text, it.by ? h('span.small.muted', ` · ${it.by}`) : null],
          h('small', String(it.at).slice(0, 16).replace('T', ' ')))))
          : h('p.small.muted', 'Nothing yet. Answers, approvals, proof and moves are kept here from now on.'),
        h('div.sh-noteform', text, tags, h('div.sh-safeinline', add, said, h('span.sh-notesaid'))),
        h('p.small.muted', 'Notes never change the answer, and whoever answered is not told.'));
    };
    toggle.addEventListener('click', () => {
      if (notesOpen.has(x.key)) { notesOpen.delete(x.key); body.hidden = true; toggle.textContent = toggle.textContent.replace('▾', '▸'); return; }
      notesOpen.add(x.key); body.hidden = false; draw();
    });
    body.hidden = !notesOpen.has(x.key);
    if (notesOpen.has(x.key)) draw();
    return h('div.sh-notesbox', toggle, body);
  }

  /** The counts on the notes toggles on screen, and the open to-dos on each card, in one ask each. */
  function fillNoteCounts(root) {
    const boxes = [...root.querySelectorAll('.sh-taskbox[data-task-key]')];
    if (boxes.length) {
      api('/shifts/tasks/for-keys', { method: 'POST', body: { keys: boxes.map((b) => b.dataset.taskKey) } }).then((d) => {
        for (const b of boxes) b.fill?.(d.tasks?.[b.dataset.taskKey] || []);
      }).catch(() => {});
    }
    const els = [...root.querySelectorAll('.sh-notes-tog[data-notes-key]')];
    if (!els.length) return;
    api('/shifts/notes/counts', { method: 'POST', body: { keys: els.map((e) => e.dataset.notesKey) } }).then((d) => {
      for (const e of els) {
        const n = d.counts?.[e.dataset.notesKey] || 0;
        if (!notesOpen.has(e.dataset.notesKey)) e.textContent = `▸ Notes and history${n ? ` · ${n}` : ''}`;
      }
    }).catch(() => {});
  }

  /**
   * To-dos made from a difference, for an Insight user, due on a day; the
   * person is emailed when it is made and each morning until it is done.
   * Separate from the difference: answering one does not close the other.
   */
  const loadPeople = async () => {
    if (!notePeople) notePeople = (await api('/shifts/notes/people').catch(() => ({ people: [] }))).people;
    return notePeople;
  };
  const aboutOf = (x) => `${(KIND[x.kind] || [x.kind])[0].toLowerCase()}${x.day ? `, ${dayText(x.day)}` : ''}${x.slot ? ` ${SLOT[x.slot].label.toLowerCase()}` : ''}`;
  const today = () => new Date().toISOString().slice(0, 10);
  const dueText = (t) => (t.due < today() ? `Overdue · was due ${dayText(t.due)}` : t.due === today() ? 'Due today' : `Due ${dayText(t.due)}`);

  /** What to do, for whom, by when: making one, or changing it. */
  async function taskForm({ task = null, onSave, onCancel }) {
    const people = await loadPeople();
    const what = h('textarea', { rows: 2, maxlength: 300, placeholder: 'What to do, e.g. count the night envelopes and find the difference' }, task?.what || '');
    const forWho = h('select', { 'aria-label': 'For' }, h('option', { value: '' }, 'For…'),
      people.map((p) => h('option', { value: p.id, selected: task ? p.id === task.forId : false }, p.me ? `${p.name} (me)` : p.name)));
    const due = h('input', { type: 'date', value: task?.due || plusDays(today(), 2), 'aria-label': 'Due' });
    const said = h('span.small');
    const save = h('button.btn.primary', {
      type: 'button',
      onclick: async () => {
        if (!what.value.trim()) { said.textContent = 'Say what to do.'; what.focus(); return; }
        if (!forWho.value) { said.textContent = 'Say who it is for.'; forWho.focus(); return; }
        save.disabled = true; said.textContent = 'Saving…';
        try { await onSave({ what: what.value, forId: Number(forWho.value), due: due.value }); } catch (err) { said.textContent = err.message; save.disabled = false; }
      },
    }, task ? 'Save' : 'Make the to-do');
    return h('div.sh-taskform',
      h('label', h('span.small.muted', 'What to do'), what),
      h('div.sh-taskrow', h('label', h('span.small.muted', 'For'), forWho), h('label', h('span.small.muted', 'Due'), due)),
      h('p.small.muted', 'Emailed to them now, and each morning until it is done.'),
      h('div.sh-safeinline', save, h('button.btn', { type: 'button', onclick: onCancel }, 'Cancel'), said));
  }

  /** On a difference's card: its open to-dos, and ＋ To-do. */
  function taskBox(x) {
    const box = h('div.sh-taskbox', { dataset: { taskKey: x.key } });
    const lines = h('div.sh-tasklines');
    const formSlot = h('div');
    let shown = [];
    const add = h('button.sh-link', {
      type: 'button',
      onclick: async () => {
        add.hidden = true;
        mount(formSlot, await taskForm({
          onSave: async (v) => {
            const out = await api('/shifts/tasks', { method: 'POST', body: { ...v, key: x.key, about: aboutOf(x), day: x.day, slot: x.slot } });
            mount(formSlot); add.hidden = false;
            box.fill([...shown, out.task]);
            mount(formSlot, h('p.small', `To-do made for ${out.task.forName}${out.told ? ', and emailed' : ''}.`));
            readInbox(true).catch(() => {});
          },
          onCancel: () => { mount(formSlot); add.hidden = false; },
        }));
      },
    }, '＋ To-do');
    box.fill = (tasks) => {
      shown = tasks;
      mount(lines, tasks.map((t) => h(`p.sh-taskline${t.due < today() ? '.late' : ''}`,
        h('b', 'To-do'), ` for ${t.forName}, ${t.due < today() ? `overdue (was due ${dayText(t.due)})` : t.due === today() ? 'due today' : `due ${dayText(t.due)}`}: `, h('span', t.what))));
    };
    mount(box, lines, add, formSlot);
    return box;
  }

  /** A to-do in the Inbox: Done, Change, Remove; and the shift it came from. */
  function taskCard(t, after) {
    const said = h('span.small');
    const slot = h('div');
    const late = t.state === 'open' && t.due < today();
    const act = (path, body, msg) => async (e) => {
      e.target.disabled = true;
      try { await api(path, { method: 'POST', body }); await after(msg); } catch (err) { said.textContent = err.message; e.target.disabled = false; }
    };
    const row = (label, ...value) => h('tr', h('td', { style: 'width:7rem;color:var(--ink-2)' }, label), h('td', ...value));
    return h(`article.sh-ex.${t.state === 'done' ? 'ok' : late ? 'bad' : 'warn'}`,
      h('div.hd', h('span.sq', t.state === 'done' ? '✓' : '☐'), h('h3', t.what), h('span.amt', t.state === 'done' ? 'Done' : dueText(t))),
      h('table.sh-otable', h('tbody',
        row('From', t.about || 'a difference', t.day && t.slot ? [' · ', h('button.sh-link', { type: 'button', onclick: () => openShift(t.day, t.slot) }, 'Open the shift')] : null),
        row('For', h('b', t.forName), t.mine ? ' (you)' : ''),
        row('Made by', `${t.madeBy}, ${dayText(String(t.madeAt).slice(0, 10))}`),
        t.state === 'done' ? row('Done', `${t.doneBy}, ${dayText(String(t.doneAt).slice(0, 10))}`) : row('Reminded', t.reminders ? `${t.reminders} time${t.reminders === 1 ? '' : 's'}, each morning until done` : 'Each morning from tomorrow, until done'))),
      t.state === 'open' ? h('div.sh-labels',
        t.canDone ? h('button.btn.primary', { type: 'button', onclick: act(`/shifts/tasks/${t.id}/done`, {}, 'To-do done.') }, '✓ Done') : null,
        t.canChange ? h('button.btn', {
          type: 'button',
          onclick: async () => mount(slot, await taskForm({
            task: t,
            onSave: async (v) => { await api(`/shifts/tasks/${t.id}`, { method: 'POST', body: v }); await after('To-do changed.'); },
            onCancel: () => mount(slot),
          })),
        }, 'Change') : null,
        t.canChange ? h('button.btn', { type: 'button', onclick: act(`/shifts/tasks/${t.id}`, { remove: true }, 'To-do removed.') }, 'Remove') : null,
        said) : null,
      slot,
      h('p.small.muted', 'Done here does not answer the difference, and answering the difference does not close this.'));
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
        // A refund owed goes on, or comes off, the list of them.
        await load();
      } catch (err) { said.textContent = err.message; }
    };
    // An admin may reconcile it even with a supervisor's answer waiting: that sets the answer aside.
    const canLink = actsOn(x) && !x.locked && !x.answer && (!x.proposed || admin) && x.severity !== 'info' && !['receipts-unclear', 'receipts-carried'].includes(x.kind);
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
      // With its sign where it has one: two that cancel out read as + and −.
      h('div.hd', h('span.sq', mark), h('h3', title), h('span.amt.num', flowText(flowOf(x)) || money(Math.abs(x.amount ?? 0))),
        canLink ? h('label.sh-pick', { title: 'Tick to reconcile with others' },
          h('input', { type: 'checkbox', checked: picked.has(x.key), onchange: (e) => { if (e.target.checked) { picked.add(x.key); pickedAs.set(x.key, x); } else { picked.delete(x.key); pickedAs.delete(x.key); } paint(); } }),
          h('span', 'Reconcile with others'), x.proposed ? h('small', `sets aside ${x.proposed.by ? `${x.proposed.by}’s` : 'the waiting'} answer`) : null) : null),
      h('div.sh-meta',
        x.user ? [avatar(x.user), h('b', nameOf(x.user))] : null,
        x.day ? h('span', dayText(x.day)) : null,
        x.slot ? h('span', SLOT[x.slot].label.toLowerCase()) : null,
        x.seqs ? h('span', `ASSD ${x.seqs.join(', ')}`) : x.seq ? h('span', `ASSD ${x.seq}`) : null),
      evidence(x),
      h('p', describe(x)),
      paymentHome(x),
      x.split ? h('p.small', x.split.what === 'paid-more' || x.split.what === 'paid-less'
        ? `Said not to be the same payment as the ${x.split.what === 'paid-more' ? 'larger' : 'smaller'} one that arrived on this shift (${x.split.by || 'somebody'}). `
        : `Said not to be the laundry’s card payment of the same amount (${x.split.by || 'somebody'}). `,
        h('button.sh-link', {
          type: 'button',
          onclick: async () => {
            try { await api('/shifts/answer', { method: 'POST', body: { key: x.split.key, answer: '' } }); await load(banner('good', 'Paired with the laundry payment again.')); } catch (err) { said.textContent = err.message; }
          },
        }, 'Undo')) : null,
      ['expense-no-po', 'expense-po-gap'].includes(x.kind) && !x.answer && byId.has(`${x.day}|${x.slot}`) ? poLinker(byId.get(`${x.day}|${x.slot}`)) : null,
      x.kind === 'paid-more' && x.answer?.answer === REFUND_DUE ? h('p.small', x.refund?.paidBack
        ? `✓ Paid back to the guest (${x.refund.paidBack.by}, ${String(x.refund.paidBack.at).slice(0, 16)}).`
        : 'On “Refunds owed to guests” in the Inbox until somebody says it was paid back.') : null,
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
      x.kind === 'receipts-unclear' && may('moves', 2) ? h('div.sh-labels',
        [['all', `All ${money(x.prev)} handed in; ${money(x.now)} is new`], ['some', `Only ${money(x.left)} handed in; nothing new`]].map(([reading, words]) => h(`button.btn${x.reading === reading ? '.primary' : ''}`, {
          type: 'button', 'aria-pressed': String(x.reading === reading),
          onclick: async () => {
            said.textContent = 'Saving…';
            try {
              await api('/shifts/receipts-read', { method: 'POST', body: { seq: x.seq, reading } });
              await load(banner('good', 'Saved. The drawer and its expenses are worked out again.'));
            } catch (err) { said.textContent = err.message; }
          },
        }, words)),
        x.why === 'person' ? h('button.sh-link', {
          type: 'button',
          onclick: async () => {
            try { await api('/shifts/receipts-read', { method: 'POST', body: { seq: x.seq, reading: '' } }); await load(banner('good', 'Back to what the evidence says.')); } catch (err) { said.textContent = err.message; }
          },
        }, 'Undo') : null) : null,
      x.kind === 'receipts-carried' && may('moves', 2) ? h('div.sh-labels',
        [['stayed', `They stayed; the movement was ${money(x.amount)} of cash`], ['new', `They went; ${money(x.amount)} of new receipts came`]].map(([reading, words]) => h(`button.btn${x.reading === reading ? '.primary' : ''}`, {
          type: 'button', 'aria-pressed': String(x.reading === reading),
          onclick: async () => {
            said.textContent = 'Saving…';
            try {
              await api('/shifts/receipts-read', { method: 'POST', body: { seq: x.seq, reading } });
              await load(banner('good', 'Saved. The drawer and its expenses are worked out again.'));
            } catch (err) { said.textContent = err.message; }
          },
        }, words)),
        x.why === 'person' ? h('button.sh-link', {
          type: 'button',
          onclick: async () => {
            try { await api('/shifts/receipts-read', { method: 'POST', body: { seq: x.seq, reading: '' } }); await load(banner('good', 'Back to what the evidence says.')); } catch (err) { said.textContent = err.message; }
          },
        }, 'Undo') : null) : null,
      x.kind === 'receipts-swapped' && x.swapFrom?.length ? swapFromBlock(x.swapFrom) : null,
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
      // A locked day: where it stood when it was locked, and nothing to press.
      x.locked ? h('div.sh-done.sh-lockednote',
        h('span', `🔒 Locked${x.answer ? `. ${x.answer.link ? 'Reconciled with others' : `Answered: ${x.answer.answer}`}${x.answer.note ? `: ${x.answer.note}` : ''}${x.answer.by ? ` (${x.answer.by})` : ''}`
          : x.proposed ? `. Still waiting for an admin: ${x.proposed.answer} (${x.proposed.by})` : x.moved ? '. Put on staff accounts' : x.link ? '. Reconciled with others' : ' with no answer'}. Days up to ${shortDay(data.lock.through)} were locked by ${data.lock.by || 'an admin'}.`))
      // A supervisor's answer or reconciliation: shown, and waiting for an admin.
      : x.proposed ? h('div.sh-waiting',
        h('span', `⏳ Waiting for an admin: ${x.proposed.answer}${x.proposed.note ? `: ${x.proposed.note}` : ''} (${x.proposed.by})`),
        admin ? [
          h('button.btn.primary', { type: 'button', onclick: () => decide(true) }, 'Approve'),
          h('button.btn', { type: 'button', onclick: () => decide(false) }, 'Reject'),
          // Or, instead of the answer, put it on somebody's account.
          movable(x) ? h('button.btn', { type: 'button', 'aria-expanded': String(moving === x.key), onclick: () => { moving = moving === x.key ? null : x.key; paint(); } }, 'Put on a staff account') : null,
          // Proof asked of whoever gave the answer, and what they sent.
          proofBox(x.proposed.link ? `link:${x.proposed.link}` : `answer:${x.key}`, { who: x.proposed.by }),
          movable(x) && moving === x.key ? movePanel(x) : null,
        ] : x.proposed.by === state.me?.account?.name ? h('button.sh-link', {
          type: 'button',
          onclick: async () => {
            try {
              if (x.proposed.link) await api('/shifts/unlink', { method: 'POST', body: { id: x.proposed.link } });
              else await api('/shifts/answer', { method: 'POST', body: { key: x.key, answer: '' } });
              await load(banner('good', 'Taken back.'));
            } catch (err) { said.textContent = err.message; }
          },
        }, 'Take it back') : null,
        // Somebody an admin allowed to ask for proof (or the one it was asked of) sees it here too.
        !admin && (may('proof') || x.proposed.by === state.me?.account?.name) ? proofBox(x.proposed.link ? `link:${x.proposed.link}` : `answer:${x.key}`, { who: x.proposed.by }) : null,
        said)
      : x.link ? h('div.sh-done',
        h('span', `✓ Reconciled together with ${others.length} other${others.length === 1 ? '' : 's'}: `,
          // Each one a link: it opens on its shift, on its card, wherever it is.
          others.map((k, i) => {
            const o = data.exceptions.find((e) => e.key === k);
            const go = h('button.sh-link', { type: 'button', title: 'Open it on its shift', onclick: () => { opened.add(k); openWhere(k, go); } },
              o ? `${label(o)}${o.amount != null ? `, ${flowText(flowOf(o)) || money(Math.abs(o.amount))}` : ''}` : describeKey(k));
            return [i ? '; ' : '', go];
          }),
          x.link.note ? ` · ${x.link.note}` : '', ` (${x.link.by})`),
        may('bank', 2) || may('moves', 2) ? h('button.sh-link', {
          type: 'button',
          onclick: async () => {
            try { await api('/shifts/unlink', { method: 'POST', body: { id: x.link.id } }); await load(banner('good', 'Undone. Those exceptions are open again.')); } catch (err) { said.textContent = err.message; }
          },
        }, 'Undo') : null)
      : x.moved ? h('div.sh-done',
        h('span', `✓ Put on ${x.moved.shares.length === 1 ? 'the account of' : 'staff accounts:'} `,
          x.moved.shares.map((y) => `${y.name}${y.amount == null ? '' : ` ${money(Math.abs(y.amount))}`}`).join(', '),
          `. Reason: ${x.moved.reason}`,
          h('small', { style: 'display:block;font-weight:400' }, `${x.moved.by || 'An admin'}${x.moved.at ? `, ${String(x.moved.at).slice(0, 16)}` : ''} · told in HIVE`)),
        admin ? h('button.sh-link', {
          type: 'button',
          onclick: async () => {
            said.textContent = 'Undoing…';
            try { await api('/till/charge/undo', { method: 'POST', body: { id: x.moved.id } }); till.forget(); await load(banner('good', 'Taken off their accounts and back on the shift. They have been told.')); } catch (err) { said.textContent = err.message; }
          },
        }, 'Undo') : null, said)
      : x.severity === 'info' && !x.answer && !['receipts-swapped', 'receipts-unclear', 'receipts-carried'].includes(x.kind) ? h('div.sh-done', h('span', { style: 'color:var(--ink-2)' }, 'Explained by the rules; no answer needed'))
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
          // Its own two buttons are the answer to a count read two ways.
          : ['receipts-unclear', 'receipts-carried'].includes(x.kind) ? said
            : [h('div.sh-answers', note, (x.kind === 'laundry-card' ? PAIR_ANSWERS : x.kind === 'paid-more' ? PAID_MORE_ANSWERS : x.kind === 'paid-less' ? PAID_LESS_ANSWERS : ANSWERS).map((a) => h('button', { type: 'button', onclick: () => answer(a) }, a)),
              movable(x) ? h('button.sh-movebtn', { type: 'button', 'aria-expanded': String(moving === x.key), onclick: () => { moving = moving === x.key ? null : x.key; paint(); } }, 'Put on a staff account') : null,
              said,
              x.kind === 'laundry-card' ? h('p.small', { style: 'flex-basis:100%;margin:.2rem 0 0' }, 'Answered here, both are settled. “Not the same payment” splits them back into two.') : null),
            movable(x) && moving === x.key ? movePanel(x) : null]);
  }

  /**
   * A difference an admin may put on staff accounts: any with an amount, on
   * one shift, not answered yet. One waiting for approval too: moving it
   * decides it instead of the answer.
   */
  const movable = (x) => admin && !x.locked && Boolean(x.amount) && Boolean(x.day && x.slot) && !x.answer && !x.link && !x.moved && x.severity !== 'info';

  /** Who carries a difference, how much each, and why: all of it placed, the reason required. */
  function movePanel(x) {
    const whole = Math.abs(x.amount);
    // The drawer says which way its difference goes; anything else, the admin says.
    const own = MOVABLE.has(x.kind);
    let direction = null;
    const word = () => (own ? (x.amount < 0 ? 'short' : 'over') : direction || 'difference');
    const sideBtns = [['deficit', 'Deficit: they owe it'], ['surplus', 'Surplus: owed to them']].map(([key, text]) => h('button.sh-mvchip', {
      type: 'button', 'aria-pressed': 'false',
      onclick: (e) => {
        direction = key;
        for (const b of sideBtns) b.setAttribute('aria-pressed', String(b === e.currentTarget));
        intro.textContent = `Who carries the ${money(whole)} ${word()}, and how much each. All of it is placed.`;
        e.preventDefault();
      },
    }, text));
    const intro = h('p.small', `Who carries the ${money(whole)} ${word()}, and how much each. All of it is placed.`);
    const rows = [];
    const list = h('div.sh-mvrows');
    const left = h('b.num');
    const said = h('span.small');
    const why = h('textarea', { rows: 2, maxlength: '500', placeholder: 'What happened, in a sentence (required unless a reason above says it)' });
    let chip = null;
    const chips = MOVE_REASONS.map((text) => h('button.sh-mvchip', {
      type: 'button',
      onclick: (e) => {
        chip = chip === text ? null : text;
        for (const b of chips) b.setAttribute('aria-pressed', String(b.textContent === chip));
        e.preventDefault();
      },
    }, text));
    const options = (sel) => {
      const group = (label, people) => (people.length ? h('optgroup', { label }, people.map((u) => h('option', { value: String(u.id) }, u.name))) : null);
      sel.replaceChildren(h('option', { value: '' }, 'Choose somebody'), group('Front desk', staff?.frontDesk || []), group('Everyone else', staff?.others || []));
    };
    const placed = () => rows.reduce((t, r) => t + (typedMinor(r.amount.value) || 0), 0);
    const recount = () => {
      const rest = whole - placed();
      left.textContent = rest === 0 ? money(0) : `${rest < 0 ? '−' : ''}${money(Math.abs(rest))}`;
      left.style.color = rest === 0 ? 'var(--sh-good-ink)' : 'var(--sh-bad-ink)';
    };
    const addRow = (amount) => {
      const sel = h('select', { 'aria-label': 'Who' });
      options(sel);
      const box = h('input', { type: 'text', inputmode: 'decimal', value: cedis(amount), 'aria-label': 'How much', oninput: recount });
      const row = { sel, amount: box };
      const el = h('div.sh-mvrow', sel, box, h('button.sh-mvx', {
        type: 'button', 'aria-label': 'Remove', onclick: () => { if (rows.length < 2) return; rows.splice(rows.indexOf(row), 1); el.remove(); recount(); },
      }, '×'));
      rows.push(row);
      list.append(el);
      recount();
    };
    addRow(whole);
    if (!staff) {
      api('/till/staff').then((d) => { staff = d; for (const r of rows) options(r.sel); }).catch((err) => { said.textContent = err.message; });
    }
    const go_ = async (e) => {
      const shares = rows.map((r) => ({ userId: Number(r.sel.value), amount: typedMinor(r.amount.value) }));
      if (shares.some((y) => !y.userId)) { said.textContent = 'Choose who, on every line.'; return; }
      if (shares.some((y) => !(y.amount > 0))) { said.textContent = 'Type how much, on every line.'; return; }
      if (!own && !direction) { said.textContent = 'Say whether it is a deficit (they owe it) or a surplus (owed to them).'; return; }
      if (placed() !== whole) { said.textContent = `Place all ${money(whole)}: put the rest on somebody, or add the shift’s own person.`; return; }
      const reason = [chip, why.value.trim()].filter(Boolean).join('. ');
      if (!reason) { said.textContent = 'Say why: pick a reason or write one.'; why.focus(); return; }
      e.target.disabled = true;
      said.textContent = 'Moving…';
      try {
        const out = await api('/till/charge', { method: 'POST', body: { key: x.key, day: x.day, shares, reason, ...(own ? {} : { direction }) } });
        moving = null;
        till.forget();
        await load(banner('good', `Put on ${shares.length === 1 ? 'a staff account' : `${shares.length} staff accounts`}. ${out.told ? `${out.told} told in HIVE.` : 'HIVE could not be reached to tell them; it is on their list all the same.'}`));
      } catch (err) { said.textContent = err.message; e.target.disabled = false; }
    };
    recount();
    return h('div.sh-mvpanel',
      h('h4', 'Put on a staff account'),
      own ? null : [h('div.sh-mvlab', 'On their account as (required)'), h('div.sh-mvchips', sideBtns)],
      intro,
      x.proposed ? h('p.small', `This decides it instead of ${x.proposed.by}’s answer waiting for approval, which is set aside.`) : null,
      list,
      h('button.sh-link', { type: 'button', onclick: () => addRow(0) }, '+ Another person'),
      h('div.sh-mvleft', h('span', 'Still to place'), left),
      h('div.sh-mvlab', 'Reason (required)'),
      h('div.sh-mvchips', chips),
      why,
      h('p.sh-mvtell', 'Each of them gets a message in HIVE with the amount, the shift and this reason, and it goes on their To sort out list. If it leaves the shift’s own person altogether, they are told too.'),
      h('div.sh-labels',
        h('button.btn.primary', { type: 'button', onclick: go_ }, `Move ${money(whole)}`),
        h('button.btn', { type: 'button', onclick: () => { moving = null; paint(); } }, 'Cancel'),
        said));
  }

  /**
   * Pairs that are probably the same money: one ASSD shows and never arrived,
   * one arrived that ASSD does not show, same amount, within a week. Each
   * exception is in one pair at most.
   */
  function likelyPairs() {
    if (!may('bank', 2) && !may('moves', 2)) return [];
    const used = new Set();
    const out = [];
    for (const x of data.exceptions) {
      if (x.answer || x.proposed || x.severity === 'info' || used.has(x.key) || !actsOn(x)) continue;
      const o = relatedTo(x).find((r) => !used.has(r.key) && actsOn(r));
      if (!o) continue;
      used.add(x.key); used.add(o.key);
      // The money that never arrived on the left, what arrived on the right.
      out.push(flowOf(x) < 0 ? [x, o] : [o, x]);
    }
    return out;
  }
  /**
   * The same money seen twice, by two checks that do not net against each
   * other: laundry ASSD does not show, and on the same shift a drawer over
   * or a card payment ASSD does not show, of the same amount. Suggested, not
   * assumed; a person reconciles them together or says they are not related.
   */
  function seenTwice(only = null) {
    if (!may('bank', 2) && !may('moves', 2)) return [];
    const open = (x) => !x.answer && !x.proposed && !x.link && x.severity !== 'info';
    const no = new Set(data.notPairs || []);
    const used = new Set();
    const out = [];
    for (const a of data.exceptions.filter((x) => x.kind === 'laundry-mismatch' && x.amount < 0 && open(x))) {
      if (only && (a.day !== only.day || a.slot !== only.slot)) continue;
      const b = data.exceptions.find((x) => !used.has(x.key) && open(x) && x.day === a.day && x.slot === a.slot
        && ((x.kind === 'drawer-over' && x.amount === -a.amount) || (x.kind === 'not-recorded' && x.amount === -a.amount))
        && !no.has(`notpair:${a.key}|${x.key}`) && actsOn(x));
      if (!b) continue;
      used.add(b.key);
      out.push([b, a]);
    }
    return out;
  }

  /** One suggestion: the two side by side, Reconcile together or Not related. */
  function seenTwiceCard([b, a]) {
    const said = h('span.small');
    const amount = money(Math.abs(a.amount));
    const why = b.kind === 'drawer-over'
      ? 'A laundry payment in cash that was not keyed in ASSD: the notes went up and ASSD shows no laundry.'
      : 'A laundry payment on the hotel terminal that was not keyed in ASSD; the times alone did not settle it.';
    const line = (x, what, value) => h('tr', h('td', (KIND[x.kind] || [x.kind])[0]), h('td', what), h('td.n.num', value));
    return h('article.sh-ex.warn.sh-seen',
      h('div.hd', h('span.sq', '?'), h('h3', `These look like the same ${amount}`), h('span.amt.num', amount)),
      h('div.sh-meta', a.user ? [avatar(a.user), h('b', nameOf(a.user))] : null, h('span', dayText(a.day)), h('span', SLOT[a.slot]?.label.toLowerCase() || ''), h('span', 'Suggested')),
      h('table.sh-otable', h('tbody',
        b.kind === 'drawer-over' ? line(b, `notes ${amount} more than expected`, `+${amount}`)
          : line(b, `approved ${String(b.event?.at || '').slice(11, 16)}${b.event?.last4 ? `, card …${b.event.last4}` : ''}`, amount),
        line(a, `the laundry system took ${amount} ASSD does not show${a.paired ? ' (besides the card payment shown on its own)' : ''}`, amount))),
      h('p', why),
      h('div.sh-labels',
        h('button.btn.primary', {
          type: 'button',
          onclick: async (e) => {
            e.target.disabled = true; said.textContent = 'Reconciling…';
            try { await reconcile([b.key, a.key], `Same ${amount}: ${(KIND[b.kind] || [b.kind])[0].toLowerCase()} and the laundry. One laundry payment, not keyed in ASSD.`); } catch (err) { said.textContent = err.message; e.target.disabled = false; }
          },
        }, 'Reconcile together'),
        h('button.btn', {
          type: 'button',
          onclick: async (e) => {
            e.target.disabled = true;
            try { await api('/shifts/answer', { method: 'POST', body: { key: `notpair:${a.key}|${b.key}`, answer: 'Not related' } }); await load(banner('good', 'Not suggested again.')); } catch (err) { said.textContent = err.message; e.target.disabled = false; }
          },
        }, 'Not related'),
        said));
  }

  const exLabel = (o) => `${o.user ? `${nameOf(o.user)}, ` : ''}${o.day ? dayText(o.day) : ''}${o.slot ? ` ${SLOT[o.slot].label.toLowerCase()}` : ''}`;

  // -------------------------------------------------------------- inbox --

  /** Pairs that are probably the same money, each reconciled with one click. */
  /**
   * A PO made in Insight that a member of staff tried to put on a shift: an
   * admin's own PO is not a drawer's expense unless allowed.
   */
  function drawerPoCard(p, after) {
    const note = h('input', { type: 'text', maxlength: '300', placeholder: 'Why not (needed to refuse), e.g. paid by MoMo from the office' });
    const said = h('span.small');
    const decide = (allow) => async (e) => {
      if (!allow && !note.value.trim()) { said.textContent = 'Say why it is not paid from a drawer.'; note.focus(); return; }
      e.target.disabled = true;
      try { await api('/po/drawer', { method: 'POST', body: { name: p.name, allow, note: note.value } }); await after(allow ? `${p.name} can go on a shift now.` : `${p.name} stays off the shifts.`); } catch (err) { said.textContent = err.message; e.target.disabled = false; }
    };
    return h('article.sh-ex.warn',
      h('div.hd', h('span.sq', 'PO'), h('h3', `${p.name} · ${p.vendor || ''}`), h('span.amt.num', money(p.total ?? p.amount))),
      h('p', `${p.askedBy || 'Somebody'} tried to put it on a shift’s expenses ${p.askedAt ? `(${String(p.askedAt).slice(0, 16)})` : ''}. It was made in Insight by ${p.madeBy || 'an admin'}${p.madeAt ? ` on ${dayText(String(p.madeAt).slice(0, 10))}` : ''}: “${p.description || ''}”.`),
      h('p.small', 'Allow it if the cash for it came out of a drawer. Refuse it if it was paid another way (the office, MoMo, the bank): then it can never cover cash missing from a drawer.'),
      note,
      h('div.sh-labels', h('button.btn.primary', { type: 'button', onclick: decide(true) }, 'Allow on a shift'), h('button.btn', { type: 'button', onclick: decide(false) }, 'Refuse'), said));
  }

  /** One Odoo activity: what it is on, whose it is, when it was due; done in Odoo, not here. */
  function odooCard(a) {
    const row = (label, ...value) => h('tr', h('td', { style: 'width:9rem;color:var(--ink-2)' }, label), h('td', ...value));
    return h(`article.sh-ex.${a.state === 'overdue' ? 'bad' : 'warn'}.sh-odooact`,
      h('div.hd', h('span.sq', 'O'), h('h3', odooTitle(a)), h('span.amt', odooWhen(a))),
      h('div.sh-meta', h('span', `${a.type || 'Activity'} · in Odoo`)),
      h('table.sh-otable', h('tbody',
        row('On', `${odooWhat(a)}${a.partner ? ` · ${a.partner}` : ''}${a.amount != null ? ` · ${money(a.amount)}` : ''}`),
        row('Waiting on', a.userName ? h('b', a.userName) : 'nobody', a.account && a.account !== a.userName ? ` (${a.account} in Insight)` : ''),
        row('Due', a.deadline ? dayText(a.deadline) : '—', a.state === 'overdue' ? h('span.sh-late', ` · ${odooWhen(a)}`) : a.state === 'today' ? ' · today' : ''),
        a.note ? row('Note', a.note) : null,
        a.shift ? row('Shift', `Paid from the drawer on ${dayText(a.shift.day)} ${SLOT[a.shift.slot]?.label.toLowerCase() || ''}${a.shift.name ? ` (${a.shift.name})` : ''} · `,
          h('button.sh-link', { type: 'button', onclick: () => openShift(a.shift.day, a.shift.slot) }, 'Open the shift')) : null)),
      h('div.sh-labels', a.url ? h('a.btn.primary', { href: a.url, target: '_blank', rel: 'noopener' }, 'Open in Odoo') : null),
      h('p.small', 'Done in Odoo, not here: Insight only reads. It leaves this list at the next read after it is marked done.'));
  }

  /** Refunds owed to guests who paid more than ASSD shows, whatever days are on screen, until paid back. */
  function refundsCard() {
    const owed = sources.refunds?.owed || [];
    if (!owed.length) return null;
    const said = h('span.small');
    const paidBy = (r) => (r.method === 'momo' ? 'MoMo' : `card${r.last4 ? ` …${r.last4}` : ''}`);
    return h('section.card.sh-refunds',
      h('div.sh-cardhead', h('div', h('h2', `Refunds owed to guests · ${owed.length}`),
        h('p.sh-sub', 'Guests who paid more by card or MoMo than ASSD shows, answered “Refund due to the guest”. Each stays here until it is paid back.'))),
      owed.map((r) => h('div.sh-refund',
        h('div',
          h('b.num', `${money(r.amount)} · ${paidBy(r)}`),
          h('small', `${dayText(r.day)} ${SLOT[r.slot]?.label.toLowerCase() || ''}${r.user ? ` · ${nameOf(r.user)}` : ''} · ${daysAgo(r.day)} day${daysAgo(r.day) === 1 ? '' : 's'}${r.note ? ` · ${r.note}` : ''}`)),
        may('bank', 2) ? h('button.btn', {
          type: 'button',
          onclick: async (e) => {
            e.target.disabled = true;
            try { await api('/shifts/refunds/paid', { method: 'POST', body: { key: r.key } }); await refreshInbox(`${money(r.amount)} paid back.`); } catch (err) { said.textContent = err.message; e.target.disabled = false; }
          },
        }, 'Paid back') : null)),
      said);
  }

  function pairsCard() {
    const pairs = likelyPairs();
    const inPairs = new Set(pairs.flat().map((x) => x.key));
    // The same money seen twice on a shift, each as its own suggestion.
    const seen = seenTwice().filter(([b, a]) => !inPairs.has(b.key) && !inPairs.has(a.key));
    const seenBlock = seen.length ? h('div.sh-exgrid', seen.map(seenTwiceCard)) : null;
    if (!pairs.length) {
      return seen.length ? h('section.card.sh-pairs', h('div.sh-cardhead', h('div', h('h2', `Probably the same money · ${seen.length}`),
        h('p.sh-sub', 'The same amount seen twice on a shift. Reconciling answers both.'))), seenBlock) : null;
    }
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
      seenBlock,
      said);
  }

  /** Read every source of the Inbox again, then the period, and show `notice`. */
  async function refreshInbox(notice = null) {
    await readInbox(true);
    await load(typeof notice === 'string' ? banner('good', notice) : notice, { inboxRead: true });
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
        if (x.severity === 'info' || !seesEx(x)) continue;
        const waitingAdmin = Boolean(x.proposed);
        if (admin && waitingAdmin) continue;
        const done = Boolean(x.answer) || Boolean(x.link && !x.proposed);
        if (done && !inbox.showDone) continue;
        const sev = x.severity === 'critical' ? 'short' : 'over';
        out.push({
          id: `ex:${x.key}`, kind: waitingAdmin ? 'admin' : x.group === 'nopo' ? 'po' : DRAWER_GROUPS.has(x.group) ? 'drawer' : 'bank',
          title: (KIND[x.kind] || [x.kind])[0], sub: exLabel(x), amount: x.amount == null ? '' : money(Math.abs(x.amount)),
          chip: done ? ['ok', 'Answered'] : waitingAdmin ? ['none', 'Waiting for admin'] : null, tone: sev, done,
          age: daysAgo(x.day), counts: !done && !waitingAdmin,
          render: () => { const c = exceptionCard(x); c.append(taskBox(x), notesBox(x)); fillNoteCounts(c); return c; },
          bulk: !done && !waitingAdmin && actsOn(x) ? { type: 'answer', key: x.key } : null,
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
    // A PO made in Insight that somebody wants to put on a shift: allowed or refused here.
    for (const p of sources.drawerPos?.items || []) {
      out.push({
        id: `pd:${p.name}`, kind: 'admin', title: `${p.askedBy || 'Somebody'} wants to pay ${p.name} from a drawer`,
        sub: `${p.vendor || ''} · made in Insight by ${p.madeBy || 'an admin'}`, amount: money(p.total ?? p.amount),
        chip: ['none', 'Allow?'], tone: 'none', age: daysAgo(p.askedAt), counts: true,
        render: () => drawerPoCard(p, after),
      });
    }
    // Proof asked of this person for an answer they gave: pictures or a PDF, sent from here.
    for (const r of sources.proof?.requests || []) {
      out.push({
        id: `pf:${r.id}`, kind: 'proof', title: `${r.askedBy} asks for proof`, sub: `Of “${String(r.about || '').slice(0, 60)}”`, amount: '',
        chip: ['short', 'Send proof'], tone: 'short', age: daysAgo(r.askedAt), counts: true,
        render: () => sendCard(r, after),
      });
    }
    // Nice Place pictures with a counter the reader could not read: read off the picture here.
    if (can.niceplace && sources.np) {
      for (const p of sources.np.items || []) {
        out.push({
          id: `np:${p.key}`, kind: 'np', title: `Read ${p.pending.map((c) => c.toUpperCase()).join(', ')} off the picture`,
          sub: `${dayText(p.day)} ${p.shift}${p.name ? ` · sent by ${p.name}` : ''}`, amount: '',
          chip: ['over', 'To read'], tone: 'over', age: daysAgo(p.day), counts: may('niceplace', 2),
          render: () => h('article.sh-ex.warn', h('div.hd', h('span.sq', 'N'), h('h3', `Nice Place counters · ${dayText(p.day)} ${p.shift}`)),
            npReviewBox(p, { after, canAct: may('niceplace', 2) })),
        });
      }
    }
    // Odoo activities overdue or due today: everybody's for an admin, and one's own.
    for (const a of (sources.odoo?.activities || []).filter((x) => x.state !== 'planned')) {
      const item = (kind) => ({
        id: `${kind}:${a.id}`, kind, title: odooTitle(a), sub: `${odooWhat(a)}${a.partner ? ` · ${a.partner}` : ''}${kind === 'odoo' ? ` · ${a.account || a.userName || 'nobody'}` : ''}`,
        amount: '', chip: [a.state === 'overdue' ? 'short' : 'over', odooWhen(a)], tone: a.state === 'overdue' ? 'short' : 'over',
        age: a.late, counts: kind === 'mine' ? !admin : true, render: () => odooCard(a),
      });
      if (admin) out.push(item('odoo'));
      if (a.mine) out.push(item('mine'));
    }
    // What waits for an admin: supervisors' answers and corrections.
    if (can.approvals && sources.till) {
      for (const a of sources.till.answerApprovals || []) {
        out.push({
          id: `aa:${a.type}:${a.id}`, kind: 'admin', title: a.type === 'link' ? `Reconciled ${a.keys.length} together` : `Answered “${a.answer}”`,
          sub: `by ${a.by}`, amount: '', chip: ['none', 'Approve'], tone: 'none', age: daysAgo(a.at), counts: true,
          render: () => till.answerApprovalCard(a, () => after('Done.'), { open: openWhere, brief: shiftBrief }),
        });
      }
      for (const a of sources.till.approvals || []) {
        out.push({
          id: `co:${a.seq}`, kind: 'admin', title: `Correction · ASSD ${a.seq}`, sub: `by ${a.by}${a.day ? ` · ${dayText(a.day)}` : ''}`,
          amount: money(a.amount), chip: ['none', 'Approve'], tone: 'none', age: daysAgo(a.at), counts: true,
          render: () => till.correctionCard(a, () => after('Done.'), { open: openWhere, brief: shiftBrief }),
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
    // To-dos made from a difference: one's own count; an admin sees them all.
    for (const t of sources.tasks?.tasks || []) {
      const done = t.state !== 'open';
      if (done && !inbox.showDone) continue;
      out.push({
        id: `tk:${t.id}`, kind: 'task', title: t.what, sub: `${t.about ? `From ${t.about} · ` : ''}for ${t.mine ? 'you' : t.forName}`, amount: '',
        chip: done ? ['ok', 'Done'] : t.due < today() ? ['short', 'Overdue'] : ['over', t.due === today() ? 'Due today' : `Due ${dayText(t.due)}`],
        tone: t.due < today() ? 'short' : 'over', done, age: daysAgo(t.madeAt), counts: !done && t.mine,
        render: () => taskCard(t, after),
      });
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
          chip: [tone, label], tone, done, age: daysAgo(x.day), counts: !done && !x.decision?.given,
          render: () => advanceDetail(x, { canAct: sources.advances.canAct, formLive: sources.advances.formLive, staff: sources.advances.staff, after }),
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
    if (wantTodo && sources.tasks) {
      if (all.some((x) => x.id === `tk:${wantTodo}`)) { inbox.kind = 'task'; inbox.open = `tk:${wantTodo}`; inbox.showDone = false; } else todoMissing = wantTodo;
      wantTodo = null;
      store.set('opentodo', '');
    }
    // POs is always there for an admin: it holds the expense form's matching too.
    const kinds = INBOX_KINDS.filter(([k]) => all.some((x) => x.kind === k) || (k === 'po' && admin));
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
          askOdoo = true;
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

    const missing = todoMissing ? banner('warning', h('strong', 'That to-do is not on your list. '),
      `You are signed in as ${state.me?.account?.name || ''}${state.me?.account?.email ? ` (${state.me.account.email})` : ''}. It may be for another account, or done already: tick Show done to see done ones.`) : null;
    todoMissing = null;
    mount(v,
      missing,
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
      inbox.kind === 'all' || inbox.kind === 'bank' ? refundsCard() : null,
      // Odoo did not answer: the last read is what is shown, and why is said.
      sources.odoo?.error && ['odoo', 'mine'].includes(inbox.kind) ? banner('warning', `${sources.odoo.error} Showing what was read${sources.odoo.readAt ? ` at ${String(sources.odoo.readAt).slice(0, 16)}` : ' last'}.`) : null,
      inbox.kind === 'po' && admin ? formMatchCard() : null,
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

  /**
   * The expense form against a month of shifts: POs that clearly belong to a
   * shift's expenses, ticked to link at once; the rest listed with the POs
   * that could be theirs. For catching up on a backlog.
   */
  const formMatch = { month: new Date().toISOString().slice(0, 7), out: null, open: false };
  function formMatchCard() {
    const body = h('div');
    const month = h('input', { type: 'month', value: formMatch.month, 'aria-label': 'Month' });
    const said = h('span.small');
    const when = (x) => `${dayText(x.day)}, ${SLOT[x.slot]?.label.toLowerCase() || x.slot}`;
    const poText = (p) => `${p.po} (${money(p.value)}${p.days?.length ? `, dated ${p.days.map((d) => dayText(d)).join(' and ')}` : `, sent ${String(p.submitted).slice(5, 16)}`}${p.by?.length ? `, ${p.by.join(', ')}` : ''})`;
    const show = () => {
      const out = formMatch.out;
      if (!out) return mount(body);
      const ticks = out.clear.map(() => h('input', { type: 'checkbox', checked: true }));
      const go = h('button.btn.primary', { type: 'button', disabled: !out.clear.length }, `Link the ticked POs`);
      const progress = h('span.small');
      go.onclick = async () => {
        const items = out.clear.filter((_, i) => ticks[i].checked).map((c) => ({ day: c.day, slot: c.slot, pos: c.pos.map((p) => p.po) }));
        if (!items.length) { progress.textContent = 'Tick at least one.'; return; }
        go.disabled = true;
        const failed = [];
        let linked = 0;
        for (let i = 0; i < items.length; i += 5) {
          progress.textContent = `Linking ${Math.min(i + 5, items.length)} of ${items.length}…`;
          try {
            // eslint-disable-next-line no-await-in-loop
            const r = await api('/shifts/form-match/apply', { method: 'POST', body: { items: items.slice(i, i + 5) } });
            for (const d of r.done) if (d.ok) linked += 1; else failed.push(`${when(d)}: ${d.error}`);
          } catch (err) { failed.push(err.message); }
        }
        formMatch.out = null;
        await refreshInbox(`POs linked on ${linked} shift${linked === 1 ? '' : 's'} from the expense form.${failed.length ? ` Not linked: ${failed.join(' · ')}` : ''}`);
      };
      mount(body,
        h('p', h('b', `${out.clear.length} shift${out.clear.length === 1 ? '' : 's'} clearly matched`), ` · ${out.unsure.length} not sure · ${out.leftOver} PO${out.leftOver === 1 ? '' : 's'} on the form not tied to a shift (paid from the safe left out: ${out.form.safe}).`),
        out.form.undated ? h('p.small', `${out.form.undated} of the form’s ${out.form.responses} responses have no date of the expense in Insight, so they are matched by when they were sent. Update the script on the expense form and run sendAllPast in it again for surer matches.`) : null,
        out.clear.length ? h('div.fm-list', out.clear.map((c, i) => h('label.fm-row',
          ticks[i],
          h('span',
            h('b', `${when(c)} · ${nameOf(c.user)}`), ` — ${c.part ? `${money(c.pos.reduce((t, p) => t + p.value, 0))} of the ${money(c.target)} with no PO` : `the ${money(c.target)} with no PO`}`,
            h('br'), h('span.small', `${c.pos.map(poText).join(' + ')}. It ${c.why}.`))))) : null,
        out.clear.length ? h('div.sh-labels', go, progress) : null,
        out.unsure.length ? h('details.fm-unsure', h('summary', `Not sure: ${out.unsure.length} shift${out.unsure.length === 1 ? '' : 's'} for a person to decide`),
          out.unsure.map((u) => h('div.fm-row',
            h('span', h('b', `${when(u)} · ${nameOf(u.user)}`), ` — ${money(u.target)} with no PO`, h('br'),
              h('span.small', u.could.length ? `Could be: ${u.could.map(poText).join('; ')}.` : 'Nothing on the form for that day.')),
            h('button.sh-link', { type: 'button', onclick: () => openShift(u.day, u.slot) }, 'Open the shift')))) : null);
    };
    const find = h('button.btn', {
      type: 'button',
      onclick: async () => {
        formMatch.month = month.value || formMatch.month;
        find.disabled = true; said.textContent = 'Reading the month’s shifts and the form…';
        try { formMatch.out = await api(`/shifts/form-match?month=${formMatch.month}`); said.textContent = ''; show(); } catch (err) { said.textContent = err.message; }
        find.disabled = false;
      },
    }, 'Find matches');
    show();
    return h('details.card.fm-card', { open: formMatch.open, ontoggle: (e) => { formMatch.open = e.target.open; } },
      h('summary', h('b', 'Link POs from the expense form'), h('span.small', ' · for a month of backlog')),
      h('p.small', 'Matches the POs on the expense form (paid from the cash register) to the shifts whose expenses have none, by amount, the date of the expense, when it was sent and who sent it. Only what clearly belongs to one shift is ticked; nothing is linked until you press Link.'),
      h('div.sh-labels', month, find, said),
      body);
  }

  /** The bar that appears once exceptions are ticked: what they net to, and Reconcile together. */
  function pickedBar() {
    const chosen = [...picked].map((k) => data.exceptions.find((x) => x.key === k) || pickedAs.get(k)).filter(Boolean);
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
      h('button.btn', { type: 'button', onclick: () => { picked.clear(); pickedAs.clear(); paint(); } }, 'Clear'),
      said);
  }

  // ------------------------------------------------------------ people --

  /** Each person's Odoo activities this month: open by when due, and done, late or not. Tap a name for the list. */
  function odooPeople() {
    const people = sources.odoo?.people;
    if (!admin || !people?.length) return null;
    const body = h('tbody');
    let open = null;
    const draw = () => body.replaceChildren(...people.flatMap((p) => {
      const mine = (sources.odoo.activities || []).filter((a) => Number(a.userId) === p.userId);
      const total = Math.max(1, p.overdue + p.today + p.planned);
      return [
        h(`tr.tl-acctrow${open === p.userId ? '.on' : ''}`,
          h('td', h('button.sh-link', { type: 'button', 'aria-expanded': String(open === p.userId), onclick: () => { open = open === p.userId ? null : p.userId; draw(); } },
            `${open === p.userId ? '▾' : '▸'} ${p.name}`), p.linked ? null : h('small', { style: 'color:var(--ink-2)' }, ' (Odoo only)')),
          h('td.num', { style: p.overdue ? 'color:var(--sh-bad-ink);font-weight:700' : '' }, String(p.overdue)),
          h('td.num', String(p.today)), h('td.num', String(p.planned)), h('td.num', String(p.done)), h('td.num', String(p.doneLate)),
          h('td', h('div.sh-actbar',
            h('i', { style: `width:${(p.overdue / total) * 100}%;background:var(--sh-bad)` }),
            h('i', { style: `width:${(p.today / total) * 100}%;background:var(--sh-warn)` }),
            h('i', { style: `width:${(p.planned / total) * 100}%;background:var(--series-1)` })))),
        open === p.userId ? h('tr.tl-account', h('td', { colspan: '7' },
          mine.length ? h('table', h('tbody', mine.map((a) => h('tr',
            h('td', h('b', odooTitle(a)), h('small', { style: 'display:block' }, `${odooWhat(a)}${a.partner ? ` · ${a.partner}` : ''}`)),
            h('td', a.deadline ? dayText(a.deadline) : '—'),
            h('td', h(`span.${a.state === 'overdue' ? 'sh-late' : a.state === 'today' ? 'sh-due' : 'sh-planned'}`, odooWhen(a))),
            h('td', a.url ? h('a', { href: a.url, target: '_blank', rel: 'noopener' }, 'Open in Odoo') : null)))))
            : h('p.small', 'Nothing open in Odoo.'))) : null,
      ].filter(Boolean);
    }));
    draw();
    return h('section.card',
      h('div.sh-cardhead', h('div', h('h2', 'Odoo activities'),
        h('p.sh-sub', `Everyone with activities in Odoo: open ones by when they are due, and this month's done, and how many of those late. Read from Odoo${sources.odoo.readAt ? ` at ${String(sources.odoo.readAt).slice(11, 16)}` : ''}; never changed there.`))),
      h('div.table-wrap', h('table',
        h('thead', h('tr', ['Who', 'Overdue', 'Today', 'Planned', 'Done this month', 'Done late', ''].map((t, i) => h(i && i < 6 ? 'th.num' : 'th', t)))),
        body)));
  }

  function peopleView(v) {
    // Each person's list from HIVE, read on its own, under their drawers.
    const extras = h('div.sh-peoplelists');
    if (may('answers')) till.read().then((d) => mount(extras, till.peopleExtras(d))).catch(() => {});
    const odooCard = odooPeople();
    if (!may('net')) { mount(v, extras, odooCard); return; }
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
          h('div.sh-glance', p.mine.map((s) => h('button', {
            type: 'button', title: `${dayText(s.day)} · ${SLOT[s.slot].label}`, style: `background:${TONE[tone(s)]}`, onclick: () => go('shift', s.id),
          }, dayText(s.day, { day: 'numeric' })))));
      }))), extras, odooCard);
  }

  // ------------------------------------------------------------- files --

  function filesView(v) {
    filesPanel(v, {
      coverage: data.coverage, uploads: data.uploads, canUpload: data.canUpload, end: range.to,
      onLoaded: (file, result) => load(banner('good', h('strong', `${file.name} loaded. `), result.note || '')),
    });
  }

  // Last, once every helper above exists: the first read and paint.
  await load(null, { inboxRead: true });
}
