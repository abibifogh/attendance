import { add, h, mount, money, num, shortDay } from '../util.js';
import { api } from '../api.js';
import { table, banner, severityPill } from './components.js';
import { readJournalPdf, readStatement, readTerminalCsv } from '../shift-files.js';

/**
 * Shifts: the control sheet, done from the source records.
 *
 * Four views of one reconciliation. **Days** is the one opened every morning:
 * yesterday's three shifts, each answering whether the cash adds up, whether
 * the card and MoMo money arrived, and whether the expenses are in Odoo.
 * **Exceptions** is every payment that does not agree, grouped by what went
 * wrong, each with a box for the answer. **Register** is the drawer from one
 * counted hand-over to the next. **People** is the month by person.
 */

const SLOT_LABEL = { morning: 'Morning', afternoon: 'Afternoon', night: 'Night' };
const SLOT_HOURS = { morning: '06:00–14:00', afternoon: '14:00–22:00', night: '22:00–06:00' };
const ANSWERS = [
  'Explained', 'Corrected in ASSD', 'Guest paid another way', 'Guest owes — chasing',
  'Deposit for a later stay', 'Refund due to the guest', 'Staff member to account for it', 'Not a problem',
];

const sectionKey = 'insight-shifts-section';
const nameOf = (user) => (user ? user.charAt(0) + user.slice(1).toLowerCase() : 'Nobody named');
const longDay = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
});
const weekday = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
const time = (at) => (at ? String(at).slice(11, 16) : '');
const when = (at, day) => (at ? `${shortDay(String(at).slice(0, 10))} ${time(at)}` : (day ? shortDay(day) : ''));
const signed = (minor) => (minor == null ? '—' : `${minor > 0 ? '+' : ''}${money(minor)}`);
const cedis = (minor) => (minor == null ? '' : String(minor / 100));

export async function renderShifts(root, { range }) {
  const view = h('div');
  add(root, view);
  let data = null;
  let section = 'days';
  try { section = sessionStorage.getItem(sectionKey) || 'days'; } catch { /* private mode */ }
  let chosenDay = null;
  let showAnswered = false;

  await load();

  async function load(notice = null) {
    data = await api(`/shifts?from=${range.from}&to=${range.to}`);
    const withShifts = data.days.filter((d) => d.shifts.length);
    if (!chosenDay || !data.days.some((d) => d.day === chosenDay)) chosenDay = withShifts[0]?.day || data.days[0]?.day || null;
    paint(notice);
  }

  function go(next) {
    section = next;
    try { sessionStorage.setItem(sectionKey, next); } catch { /* private mode */ }
    paint();
  }

  function paint(notice = null) {
    const open = data.exceptions.filter((x) => !x.answer && x.severity !== 'info').length;
    mount(view,
      notice,
      intro(),
      data.canUpload ? uploads() : coverageNote(),
      data.days.some((d) => d.shifts.length) ? [
        summaryTiles(),
        h('div.segmented', { role: 'tablist' },
          [['days', 'Days'], ['exceptions', `Exceptions${open ? ` · ${open}` : ''}`], ['register', 'Register'], ['people', 'People']]
            .map(([id, label]) => h('button.btn', {
              role: 'tab', 'aria-selected': String(section === id), class: section === id ? 'on' : '', onclick: () => go(id),
            }, label))),
        section === 'exceptions' ? exceptionsView()
          : section === 'register' ? registerView()
            : section === 'people' ? peopleView()
              : daysView(),
      ] : nothingYet());
  }

  // ------------------------------------------------------------ framing --

  function intro() {
    return h('div.card',
      h('h2', 'Shifts'),
      h('p.sub',
        'Each shift, from ASSD’s own journal: what the person holding the drawer took in cash and by card or MoMo, '
        + 'what left the drawer, and whether the card and MoMo money actually arrived. Shifts run 06–14, 14–22 and '
        + '22–06, and a night belongs to the day it starts. ASSD’s hand-over marker decides where one shift ends and '
        + 'the next begins, so an overlap of a few minutes settles itself.'),
      data.journalEndsInside ? banner('warning',
        `The journal loaded so far stops inside the ${SLOT_LABEL[data.journalEndsInside.slot].toLowerCase()} shift of `
        + `${shortDay(data.journalEndsInside.day)}, so that shift is shown as far as it goes. Export ASSD one day past the last `
        + 'shift you want to read.') : null);
  }

  function nothingYet() {
    const c = data.coverage || {};
    return h('div.card',
      h('h3', 'No shifts in these days yet'),
      h('p', c.journal
        ? `The ASSD journal loaded so far covers ${shortDay(c.journal.from)} to ${shortDay(c.journal.to)}. Choose days inside that, or load the journal for these.`
        : 'Load the ASSD detail journal for these days to begin. The bank statement and the card terminal report make the card and MoMo checks possible; the journal alone already gives the cash.'));
  }

  function coverageNote() {
    const c = data.coverage || {};
    const parts = [
      c.journal ? `ASSD journal ${shortDay(c.journal.from)}–${shortDay(c.journal.to)}` : 'no ASSD journal',
      c.terminal ? `card terminal ${shortDay(c.terminal.from)}–${shortDay(c.terminal.to)}` : 'no terminal report',
      c.bank ? `bank statement to ${shortDay(c.bank.to)}` : 'no bank statement',
    ];
    return h('p.small.muted', `Loaded so far: ${parts.join(' · ')}. An owner loads the files.`);
  }

  // ------------------------------------------------------------ uploads --

  function uploads() {
    const c = data.coverage || {};
    const last = (kind) => data.uploads.find((u) => u.kind === kind);
    const slot = (title, what, accept, kind, covered) => {
      const said = h('p.small');
      const input = h('input', { type: 'file', accept });
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        input.disabled = true;
        said.className = 'small';
        said.textContent = 'Reading the file on this computer…';
        try {
          let result;
          if (kind === 'journal') {
            const { lines, pages } = await readJournalPdf(file, (t) => { said.textContent = t; });
            said.textContent = `Read ${pages} pages. Sending the amounts to Insight…`;
            result = await api('/shifts/journal', { method: 'POST', body: { lines, name: file.name } });
          } else if (kind === 'bank') {
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
      });
      const prev = last(kind);
      return h('div.upload',
        h('h3', title),
        h('p.small.muted', what),
        h('label.field', 'Choose the file', input),
        h('p.small', covered),
        prev ? h('p.small.muted', `Last loaded ${String(prev.at).slice(0, 16)} by ${prev.by}: ${prev.note || ''}`) : null,
        said);
    };
    return h('details.card.uploads', { open: !c.journal },
      h('summary', h('strong', 'Load files'), h('span.small.muted', ' · ',
        [c.journal ? `journal to ${shortDay(c.journal.to)}` : 'no journal',
          c.terminal ? `terminal to ${shortDay(c.terminal.to)}` : 'no terminal report',
          c.bank ? `bank to ${shortDay(c.bank.to)}` : 'no bank statement'].join(' · '))),
      h('p.small.muted',
        'Files are opened on this computer. Only amounts, times and ASSD user names are sent: guests’ names and addresses are taken '
        + 'out of the journal before it leaves the page, and the statement’s salaries, suppliers and transfers are never sent. '
        + 'Loading the same file twice changes nothing; loading a newer one updates what it covers.'),
      h('div.grid.three',
        slot('ASSD detail journal', '“Detail Journal of every Transaction”, printed to PDF. Run it one day past the last shift you want.',
          '.pdf,application/pdf', 'journal',
          c.journal ? `Loaded: ${shortDay(c.journal.from)} – ${shortDay(c.journal.to)}` : 'Nothing loaded yet.'),
        slot('Card terminal report', 'The CSV from the bank’s merchant portal: every tap, approved or declined, to the second.',
          '.csv,text/csv', 'terminal',
          c.terminal ? `Loaded: ${shortDay(c.terminal.from)} – ${shortDay(c.terminal.to)}` : 'Nothing loaded yet.'),
        slot('GTBank statement', 'The statement from GTBank internet banking, as the .xls it downloads (the Finacle XLSX works too). Card settlements, MoMo and commission are read from it.',
          '.xls,.xlsx,.htm,.html', 'bank',
          c.bank ? `Loaded: ${shortDay(c.bank.from)} – ${shortDay(c.bank.to)}` : 'Nothing loaded yet.')));
  }

  // ------------------------------------------------------------- tiles --

  /** A figure with a line under it. No change arrow: there is nothing to compare a day's cash with. */
  function tile({ label, value, unit, note }) {
    const shown = value == null ? '—' : unit === 'money' ? money(value) : num(value);
    return h('div.tile', h('div.label', label), h('div.value', shown), note ? h('div.note', note) : null);
  }

  function summaryTiles() {
    const t = data.totals;
    const recorded = t.card;
    return h('div.grid.four', { style: { marginBottom: '1rem' } },
      tile({ label: 'Cash received', value: t.cash, unit: 'money', note: `${num(t.shifts)} shifts · ${money(t.drawerOut)} left the drawer` }),
      tile({ label: 'Card + MoMo in ASSD', value: recorded, unit: 'money', note: `${money(t.received)} arrived on the terminal and by MoMo` }),
      tile({ label: 'Drawer variance', value: t.counted ? t.variance : null, unit: 'money',
        note: t.counted ? `${num(t.counted)} of ${num(t.shifts)} shifts with an opening and closing count` : 'No counts in these days yet' }),
      tile({ label: 'Exceptions waiting', value: t.open, note: t.open ? 'Card and MoMo differences without an answer' : 'Every difference answered or explained' }));
  }

  // -------------------------------------------------------------- days --

  function daysView() {
    const day = data.days.find((d) => d.day === chosenDay) || data.days[0];
    return [
      h('div.daystrip', data.days.map((d) => {
        const mark = !d.shifts.length ? '·' : d.totals.critical ? '!' : d.totals.exceptions ? 'i' : '✓';
        const tone = !d.shifts.length ? 'none' : d.totals.critical ? 'critical' : d.totals.exceptions ? 'warning' : 'good';
        return h('button.daychip', {
          class: `${tone}${d.day === day.day ? ' on' : ''}`,
          onclick: () => { chosenDay = d.day; paint(); },
          title: d.shifts.length ? `${d.totals.exceptions} exceptions` : 'No shifts loaded',
        }, h('span.small', weekday(d.day)), h('strong', shortDay(d.day)), h('span.mark', mark));
      })),
      dayView(day),
    ];
  }

  function dayView(d) {
    if (!d.shifts.length) return h('div.card', h('h3', longDay(d.day)), h('p.muted', 'No shifts from the journal on this day.'));
    const diff = d.totals.received - d.totals.cardRecorded;
    return [
      h('h2.dayhead', longDay(d.day)),
      h('div.grid.three', d.shifts.map(shiftCard)),
      h('div.card',
        h('h3', 'The day against the money that arrived'),
        table([
          { label: '', get: (r) => r[0] },
          { label: 'Amount', num: true, get: (r) => r[1] },
          { label: '', get: (r) => h('span.small.muted', r[2]) },
        ], [
          ['Card + MoMo recorded in ASSD', money(d.totals.cardRecorded), `${d.shifts.length} shifts`],
          ['Approved on the terminal, and MoMo received', money(d.totals.received), 'by the shift that was open when it was paid'],
          ['Difference', signed(diff), diff === 0 ? 'every payment found' : 'see the exceptions below'],
          ['Bank commission on the day’s cards', money(d.totals.commission), 'a bank charge, never a shift’s shortfall'],
        ]),
        laundryLine(d)),
      d.shifts.map(matchCard),
      d.shifts.map(expenseCard),
      dayExceptions(d),
    ];
  }

  function laundryLine(d) {
    const l = d.laundry;
    if (!l.assd && l.system == null) return null;
    if (l.system == null) {
      return h('p.small.muted', `Laundry in ASSD: ${money(l.assd)}. The laundry system has nothing for this day in Insight, so it could not be compared.`);
    }
    const gap = l.assd - l.system;
    return h('p.small', gap === 0 ? '✓ ' : '! ',
      `Laundry: ${money(l.assd)} in ASSD, ${money(l.system)} in the laundry system`,
      gap === 0 ? ' — they agree.' : ` — ${money(Math.abs(gap))} ${gap > 0 ? 'more in ASSD' : 'more in the laundry system'}.`);
  }

  function shiftCard(s) {
    const r = s.register || {};
    const variance = r.variance;
    const checks = [];
    if (variance == null) checks.push(['info', 'i', s.open ? 'The journal ends before this shift’s closing count' : 'No closing count in ASSD for this shift']);
    else if (variance === 0) checks.push(['good', '✓', `The drawer agrees with ${r.closingFrom === 'typed' ? 'the recount' : 'ASSD’s closing count'}`]);
    else checks.push([variance < 0 ? 'critical' : 'warning', '!', `Drawer ${variance > 0 ? 'over' : 'short'} by ${money(Math.abs(variance))}`]);
    if (r.handoverGap) {
      checks.push(['warning', '!', `Opened ${money(Math.abs(r.handoverGap.amount))} ${r.handoverGap.amount < 0 ? 'below' : 'above'} ${nameOf(r.handoverGap.from)}’s closing count`]);
    }
    const lines = s.cardLines;
    if (!lines) checks.push(['info', '·', 'No card or MoMo this shift']);
    else if (s.cardFound === lines) checks.push(['good', '✓', `Card + MoMo ${money(s.card)} · ${lines} of ${lines} found`]);
    else checks.push(['warning', '!', `Card + MoMo ${money(s.card)} · ${s.cardFound} of ${lines} found`]);
    const exp = s.expense;
    if (exp?.sheetTotal != null || r.expenses) {
      const sheet = exp?.sheetTotal;
      const odoo = exp?.odooTotal;
      const agree = sheet != null && odoo != null && sheet === odoo;
      checks.push([agree ? 'good' : (sheet != null && odoo != null ? 'warning' : 'info'), agree ? '✓' : 'i',
        `Expenses ${money(sheet ?? r.expenses)}${odoo != null ? ` · Odoo ${money(odoo)}` : exp?.poNumbers ? ' · Odoo not read yet' : ' · no PO numbers yet'}`]);
    }
    if (s.laundry) checks.push(['info', 'i', `Laundry ${money(s.laundry)}${s.laundryCash ? `, ${money(s.laundryCash)} in cash` : ''}`]);
    const corrected = (s.moves || []).filter((m) => m.kind === 'corrected');
    for (const m of corrected) {
      checks.push(['info', 'i', `A movement of ${money(m.amount)} was keyed and put back by ${nameOf(m.reversedByUser)}`]);
    }
    if (s.exceptions) checks.push(['warning', '!', `${s.exceptions} exception${s.exceptions === 1 ? '' : 's'} below`]);

    const outNote = !s.drawerOut ? 'nothing moved out'
      : [r.expenses ? `${money(r.expenses)} expenses${r.expensesFrom === 'sheet' ? ' (sheet)' : ''}` : null,
        r.toSafe ? `${money(r.toSafe)} to the safe` : null,
        r.unlabelled ? `${money(r.unlabelled)} not labelled` : null].filter(Boolean).join(' · ');
    const counted = r.closingFrom === 'typed' ? `recounted by ${r.countedBy}`
      : r.closingFrom === 'assd' ? `ASSD count${r.receiptsAtClose ? `, incl. ${money(r.receiptsAtClose)} receipts` : ''}` : '';

    return h('div.card.shift',
      h('div.shifthead',
        h('div', h('strong', nameOf(s.user)), h('span.muted', ` ${SLOT_LABEL[s.slot]} · ${SLOT_HOURS[s.slot]}`)),
        s.double ? h('span.pill', 'covered two slots') : null,
        s.open ? h('span.pill.warning', 'journal ends here') : null),
      h('dl.ledger',
        row('Opening count', r.opening == null ? '—' : money(r.opening),
          r.openingFrom === 'typed' ? 'typed' : r.openingFrom === 'assd' ? 'ASSD, at hand-over' : r.openingFrom === 'carried' ? 'the last count' : ''),
        row('+ Cash taken', money(s.cash), s.laundryCash ? `includes ${money(s.laundryCash)} laundry` : ''),
        row('− Moved out of the drawer', money(s.drawerOut), outNote),
        row('= Should be in the drawer', r.expected == null ? '—' : money(r.expected)),
        row('Closing count', r.closing == null ? '—' : money(r.closing), counted),
        row('Variance', variance == null ? '—' : signed(variance), '', variance ? (variance > 0 ? 'over' : 'short') : '')),
      modesList(s),
      h('ul.checks', checks.map(([tone, mark, text]) => h(`li.${tone}`, h('span.mark', mark), text))),
      movesList(s),
      countForm(s));
  }

  /** How the shift was paid, in ASSD's own words. */
  function modesList(s) {
    const modes = Object.entries(s.modes || {}).filter(([, v]) => v);
    if (!modes.length) return null;
    const word = (label) => {
      const t = label.toUpperCase();
      if (/\bCASH\b/.test(t)) return 'Cash';
      if (/CR\.|CREDIT CARD/.test(t)) return 'Card and MoMo';
      if (/PRE-?BAN/.test(t)) return 'Prepaid by bank transfer';
      if (/PREPAID CC/.test(t)) return 'Prepaid by card online';
      return label;
    };
    return h('details.modes',
      h('summary.small', `Taken by every method: ${money(modes.reduce((t, [, v]) => t + v, 0))}`),
      h('dl.ledger.small', modes.map(([label, v]) => row(word(label), money(v), label))),
      h('p.small.muted', 'Only cash goes into the drawer. Card and MoMo are checked against the terminal and the bank; prepayments were paid before the guest arrived.'));
  }

  /** Every Cash Movement out of the drawer, and what it was. */
  function movesList(s) {
    const moves = s.moves || [];
    if (!moves.length) return null;
    const what = (m) => ({
      expenses: 'Expenses — receipts counted before it',
      safe: 'To the safe — notes counted before it',
      split: `${money(m.expenses)} expenses and ${money(m.safe)} to the safe, as counted before it`,
      part: `${money(m.expenses)} expenses as counted; ${money(m.amount - m.expenses)} not labelled`,
      unlabelled: 'Not labelled in ASSD: no count before it said what it was',
      corrected: `Keyed in error and put back by ${nameOf(m.reversedByUser)} (ASSD ${m.reversedBy})`,
      returned: 'Put back into the drawer',
    })[m.kind] || m.kind;
    return h('details.moves',
      h('summary.small', `How the cash moved: ${moves.length} movement${moves.length === 1 ? '' : 's'}`),
      h('ul.movelist', moves.map((m) => h('li',
        h('span', m.kind === 'corrected' ? h('s', money(m.amount)) : h('strong', money(m.amount))),
        h('span.small', ` ${what(m)} · ${nameOf(m.user)}, ASSD ${m.seq}`)))),
      h('p.small.muted', 'Every movement goes from the front drawer to the back office. ASSD records only the amount, so what a movement was comes from the Money Count done just before it: its notes are cash for the safe, its “Total Expenses PAID” line is the receipts. Typing the expense sheet’s total settles anything not labelled.'));
  }

  function row(label, value, note = '', tone = '') {
    return [h('dt', label, note ? h('span.small.muted', ` ${note}`) : null), h(`dd${tone ? `.${tone}` : ''}`, value)];
  }

  /**
   * A recount, typed by a person. ASSD's own closing count is used unless
   * one is typed: this is for a spot check, or for a count ASSD got wrong.
   */
  function countForm(s) {
    if (s.open) return null;
    const r = s.register || {};
    const closing = h('input', { type: 'number', step: '0.01', min: '0', inputmode: 'decimal',
      value: r.closingFrom === 'typed' ? cedis(r.closing) : '', placeholder: r.closing != null ? cedis(r.closing) : '0.00' });
    const needOpening = r.openingFrom == null || r.openingFrom === 'typed';
    const opening = h('input', { type: 'number', step: '0.01', min: '0', inputmode: 'decimal',
      value: r.openingFrom === 'typed' ? cedis(r.opening) : '', placeholder: 'only if ASSD has no opening count' });
    const note = h('input', { type: 'text', maxlength: '400', value: r.note || '', placeholder: 'optional' });
    const said = h('span.small');
    return h('details.countform',
      h('summary.small', r.closingFrom === 'typed' ? 'Change the recount' : 'Recount the drawer (optional)'),
      h('p.small.muted', 'ASSD’s own closing count is used unless a recount is typed here — for a spot check, or when ASSD’s count is wrong. Clear the box and save to go back to ASSD’s count.'),
      h('label.field', 'Recounted closing (GH₵)', closing),
      needOpening ? h('label.field', 'Opening (GH₵)', opening) : null,
      h('label.field', 'Note', note),
      h('button.btn.primary', {
        onclick: async () => {
          said.textContent = 'Saving…';
          try {
            await api('/shifts/count', { method: 'POST', body: { day: s.day, slot: s.slot, closing: closing.value, opening: needOpening ? opening.value : null, note: note.value } });
            await load();
          } catch (err) { said.textContent = err.message; }
        },
      }, 'Save the recount'), ' ', said);
  }

  function matchCard(s) {
    if (!s.lines.length) return null;
    const how = {
      exact: 'Matched', late: 'Matched · just outside the hours', together: 'Paid together with another line',
      parts: 'Paid in parts', 'by-day': 'Matched to the bank by day', regrouped: 'Same money, split differently', corrected: 'Corrected',
    };
    return h('details.card.matches',
      h('summary', h('strong', `${nameOf(s.user)} · ${SLOT_LABEL[s.slot]}`), h('span.muted', ` · ${s.lines.length} card and MoMo lines in ASSD`)),
      table([
        { label: 'ASSD no.', get: (l) => h('span.small', String(l.seq)) },
        { label: 'Keyed by', get: (l) => nameOf(l.user) },
        { label: 'Amount', num: true, get: (l) => money(l.amount) },
        { label: 'Paid', get: (l) => (l.events.length ? l.events.map((e) => h('div.small',
          `${e.kind === 'momo' ? 'MoMo' : `Card${e.last4 ? ` …${e.last4}` : ''}`} ${money(e.amount)} · ${when(e.at, e.day)}`)) : h('span.muted', '—')) },
        { label: 'Status', get: (l) => (l.exception && !l.events.length
          ? h('span.pill.critical', '! See exceptions')
          : l.exception ? h('span.pill.warning', `! ${l.how === 'regrouped' ? how.regrouped : 'See exceptions'}`)
            : l.events.length ? h('span.pill.good', `✓ ${how[l.how] || 'Matched'}`) : h('span.pill', l.how ? how[l.how] : '—')) },
      ], s.lines));
  }

  function expenseCard(s) {
    if (!s.drawerOut && !s.expense) return null;
    const exp = s.expense || {};
    const total = h('input', { type: 'number', step: '0.01', min: '0', inputmode: 'decimal', value: cedis(exp.sheetTotal), placeholder: '0.00' });
    const pos = h('input', { type: 'text', value: exp.poNumbers || '', placeholder: 'P00412, P00413' });
    const said = h('span.small');
    const save = async (pull) => {
      said.textContent = pull ? 'Saving and asking Odoo…' : 'Saving…';
      try {
        await api('/shifts/expense', { method: 'POST', body: { day: s.day, slot: s.slot, sheetTotal: total.value, poNumbers: pos.value, pull } });
        await load();
      } catch (err) { said.textContent = err.message; }
    };
    const orders = exp.odoo?.orders || [];
    const unknown = exp.odoo?.unknown || [];
    const assd = s.register?.expenses ?? s.expensesCounted;
    const sheet = exp.sheetTotal;
    const odoo = exp.odooTotal;
    const verdict = sheet == null ? null
      : odoo == null ? 'The PO numbers have not been read from Odoo yet.'
        : sheet === odoo ? `The expense sheet and Odoo agree at ${money(sheet)}.`
          : `The expense sheet says ${money(sheet)} and Odoo says ${money(odoo)}: ${money(Math.abs(sheet - odoo))} ${sheet > odoo ? 'is not in Odoo' : 'more in Odoo than on the sheet'}.`;
    return h('details.card.expenses', { open: Boolean(sheet != null && odoo != null && sheet !== odoo) },
      h('summary', h('strong', `Expenses · ${nameOf(s.user)} · ${SLOT_LABEL[s.slot]}`),
        h('span.muted', ` · ${money(s.drawerOut)} left the drawer in ASSD${sheet != null ? ` · sheet ${money(sheet)}` : ''}${odoo != null ? ` · Odoo ${money(odoo)}` : ''}`)),
      h('p.small.muted', 'Type the expense sheet’s total for this shift and the Odoo PO numbers behind it. Insight reads each order from Odoo — vendor, total, state — without changing anything there.'),
      h('div.grid.three',
        h('label.field', 'Expense-sheet total (GH₵)', total),
        h('label.field', 'Odoo PO numbers', pos),
        h('div', { style: { alignSelf: 'end' } },
          h('button.btn.primary', { onclick: () => save(true) }, 'Save and read from Odoo'), ' ',
          h('button.btn', { onclick: () => save(false) }, 'Save'), ' ', said)),
      orders.length ? table([
        { label: 'PO', get: (o) => o.name },
        { label: 'Vendor (Odoo)', get: (o) => o.vendor },
        { label: 'Total', num: true, get: (o) => money(o.total), foot: (list) => money(list.reduce((t, o) => t + o.total, 0)) },
        { label: 'State', get: (o) => `${o.state}${o.billed ? ` · ${o.billed.replace(/_/g, ' ')}` : ''}` },
        { label: 'Ordered', get: (o) => o.orderedOn || '' },
      ], orders, { footer: orders }) : null,
      unknown.length ? banner('warning', `Odoo does not know ${unknown.join(', ')}. Check the numbers.`) : null,
      verdict ? h('p', verdict) : null,
      h('p.small.muted', `Left the drawer in ASSD: ${money(s.drawerOut)}. `
        + (assd == null ? 'Until the sheet total is typed it is not split between expenses and the safe. '
          : `Of that, ${money(assd)} is counted as expenses (${s.register?.expensesFrom === 'sheet' ? 'the sheet' : 'ASSD’s hand-over count'}) and the rest as cash to the safe. `)
        + 'If an expense was paid from the drawer but never moved in ASSD, the shift will count short by exactly that amount.'),
      exp.pulledAt ? h('p.small.muted', `Read from Odoo ${String(exp.pulledAt).slice(0, 16)}.`) : null);
  }

  function dayExceptions(d) {
    const list = data.exceptions.filter((x) => x.day === d.day);
    if (!list.length) return null;
    return h('div.card',
      h('h3', `Exceptions on ${shortDay(d.day)}`),
      list.map(exceptionRow));
  }

  // -------------------------------------------------------- exceptions --

  function exceptionsView() {
    const list = data.exceptions.filter((x) => showAnswered || !x.answer);
    const answered = data.exceptions.filter((x) => x.answer).length;
    return [
      h('div.card',
        h('p.sub', 'Every card and MoMo payment that does not agree between ASSD, the card terminal and the bank, grouped by what '
          + 'went wrong. The first three groups are money that may be missing; the last is what the rules explained on their '
          + 'own, listed so the explanation can be checked rather than trusted.'),
        answered ? h('label.check', h('input', { type: 'checkbox', checked: showAnswered, onchange: (e) => { showAnswered = e.target.checked; paint(); } }),
          ` Show the ${answered} already answered`) : null),
      data.groups.map((g) => {
        const items = list.filter((x) => x.group === g.id);
        if (!items.length) return null;
        const total = items.reduce((t, x) => t + Math.abs(x.amount || 0), 0);
        return h(`div.card.exgroup.${g.severity}`,
          h('div.exhead', severityPill(g.severity), h('h3', g.title), h('span.muted', `${items.length} · ${money(total)}`)),
          h('p.small.muted', g.help),
          items.map(exceptionRow));
      }),
      list.length ? null : h('div.card', h('p', '✓ Nothing waiting. Every card and MoMo payment in these days agrees, or has an answer.')),
    ];
  }

  function exceptionRow(x) {
    const select = h('select', {},
      h('option', { value: '' }, x.answer ? '— clear the answer —' : 'Answer…'),
      ANSWERS.map((a) => h('option', { value: a, selected: x.answer?.answer === a }, a)));
    const note = h('input', { type: 'text', maxlength: '600', value: x.answer?.note || '', placeholder: 'What happened (optional)' });
    const said = h('span.small');
    return h(`div.exrow.${x.severity}${x.answer ? '.answered' : ''}`,
      h('div.exmain',
        h('div', h('strong', money(x.amount)), ' ', h('span.muted', [
          shortDay(x.day), x.slot ? SLOT_LABEL[x.slot].toLowerCase() : null, x.user ? nameOf(x.user) : null, x.seqs ? `ASSD ${x.seqs.join(', ')}` : x.seq ? `ASSD ${x.seq}` : null,
        ].filter(Boolean).join(' · '))),
        h('p', describe(x)),
        x.answer ? h('p.small.good-text', `✓ ${x.answer.answer}${x.answer.note ? ` — ${x.answer.note}` : ''} (${x.answer.by}, ${String(x.answer.at).slice(0, 10)})`) : null),
      h('div.exanswer', select, note,
        h('button.btn', {
          onclick: async () => {
            said.textContent = 'Saving…';
            try {
              await api('/shifts/answer', { method: 'POST', body: { key: x.key, answer: select.value, note: note.value } });
              await load();
            } catch (err) { said.textContent = err.message; }
          },
        }, 'Save'), said));
  }

  function describe(x) {
    const e = x.event;
    const paid = e ? `${e.kind === 'momo' ? 'MoMo' : `card${e.last4 ? ` …${e.last4}` : ''}`} ${money(e.amount)}` : '';
    switch (x.kind) {
      case 'failed': return `Declined on the terminal at ${when(e.at)} (${e.status || 'not approved'}) and never approved afterwards, yet ASSD has it as paid by card.`;
      case 'not-found': return 'ASSD has this as card or MoMo. No approved card payment, MoMo receipt or bank credit of this amount was found near the shift.';
      case 'zero': return 'A card payment of nothing: a line keyed with no amount.';
      case 'double-charge': return `The same card …${e.last4} was charged ${money(e.amount)} twice, ${x.minutesApart} minutes apart (${time(x.twin?.at)} and ${time(e.at)}). ASSD has it once.`;
      case 'transposition': return `The terminal took ${paid} at ${time(e.at)}; ASSD has ${money(x.amount)} — the same digits in another order (${signed(x.difference)}).`;
      case 'decimal': return `The terminal took ${paid} at ${time(e.at)}; ASSD has ${money(x.amount)} — out by a factor of ten.`;
      case 'keying': return `The terminal took ${paid} at ${time(e.at)}; ASSD has ${money(x.amount)} — one digit different (${signed(x.difference)}).`;
      case 'duplicate': return `Keyed twice in this shift (also ASSD ${x.pair}) and paid once.`;
      case 'not-recorded': return `${e.kind === 'momo' ? 'MoMo received' : 'Card approved on the terminal'} at ${when(e.at, e.day)}${e.last4 ? `, card …${e.last4}` : ''} — not in ASSD.`;
      case 'never-settled': return `Approved on the terminal ${when(e.at)}, card …${e.last4}, approval ${e.approval}. No bank credit for it six days on.`;
      case 'reversal': return `The bank took ${money(Math.abs(x.amount))} back from card …${e.last4} (tapped ${shortDay(e.day)}).${x.pairedWith ? ' It answers a refund keyed in ASSD.' : ' No refund of that amount is keyed in ASSD in these days.'}`;
      case 'refund': return `A card refund keyed in ASSD.${x.pairedWith ? ' The bank reversal for it is on the statement.' : ' No matching reversal on the bank statement yet.'}`;
      case 'regrouped': return `The shift’s unmatched lines (${x.lines.map((a) => money(a)).join(' + ')}) add up to exactly its unmatched payments (${x.events.map((ev) => money(ev.amount)).join(' + ')}): the same money, split differently.`;
      case 'other-shift': return `Paid ${e.kind === 'momo' ? 'by MoMo' : 'by card'} at ${when(e.at)}${x.otherShift ? `, on ${nameOf(x.otherShift.user)}’s ${SLOT_LABEL[x.otherShift.slot].toLowerCase()} shift of ${shortDay(x.otherShift.day)}` : ''}, and keyed on this one.`;
      case 'corrected': return `Keyed and then reversed in the same shift (ASSD ${x.pair}).`;
      case 'drawer-short':
      case 'drawer-over': return `Should have held ${money(x.expected)}; ${x.closingFrom === 'typed' ? 'the recount' : 'ASSD’s closing count'} found ${money(x.closing)}.`;
      case 'handover-gap': return `The first count of this shift found ${money(Math.abs(x.amount))} ${x.amount < 0 ? 'less' : 'more'} than ${nameOf(x.from)}’s closing count. Cash went missing, or was added, between the two counts.`;
      case 'movement-corrected': return `${nameOf(x.by)} moved ${money(x.amount)} out of the drawer and ${nameOf(x.reversedBy)} put it back (ASSD ${x.reversedSeq}). The net is nothing; the slip is listed so it can be seen.`;
      case 'bank-only': return `A card credit on the bank statement, card …${e.last4}, tapped ${shortDay(e.day)}, with no record on the terminal report.`;
      default: return x.kind;
    }
  }

  // ---------------------------------------------------------- register --

  function registerView() {
    const order = ['morning', 'afternoon', 'night'];
    const shifts = data.days.flatMap((d) => d.shifts)
      .sort((a, b) => (a.day === b.day ? order.indexOf(a.slot) - order.indexOf(b.slot) : a.day < b.day ? -1 : 1));
    const running = new Map();
    const rows = shifts.map((s) => {
      const v = s.register?.variance;
      if (v != null) running.set(s.user, (running.get(s.user) || 0) + v);
      return { s, r: s.register || {}, mtd: running.get(s.user) ?? null };
    });
    return h('div.card',
      h('h3', 'The drawer, from one count to the next'),
      h('p.sub', 'All from ASSD: the Money Count at each hand-over, the cash taken, and every Cash Movement out of the drawer, '
        + 'labelled as expenses or cash to the safe by the count done just before it. A difference lands on the person who was '
        + 'holding the drawer and on nobody else, and is the same figure ASSD books as a deficit or surplus. '
        + 'A closing marked * is a recount typed here.'),
      table([
        { label: 'Shift', get: ({ s }) => h('span', { style: { whiteSpace: 'nowrap' } }, `${weekday(s.day)} ${shortDay(s.day)} · ${{ morning: 'AM', afternoon: 'PM', night: 'Night' }[s.slot]}`) },
        { label: 'Person', get: ({ s }) => nameOf(s.user) },
        { label: 'Opening count', num: true, get: ({ r }) => (r.opening == null ? '—' : money(r.opening)) },
        { label: '+ Cash taken', num: true, get: ({ s }) => money(s.cash) },
        { label: '− Expenses', num: true, get: ({ r }) => (r.expenses ? money(r.expenses) : '') },
        { label: '− To the safe', num: true, get: ({ r }) => (r.toSafe ? money(r.toSafe) : '') },
        { label: '− Not labelled', num: true, get: ({ r }) => (r.unlabelled ? money(r.unlabelled) : '') },
        { label: '= Should hold', num: true, get: ({ r }) => (r.expected == null ? '—' : money(r.expected)) },
        { label: 'Closing count', num: true, get: ({ r }) => (r.closing == null ? '—' : `${money(r.closing)}${r.closingFrom === 'typed' ? ' *' : ''}`) },
        { label: 'Variance', num: true, get: ({ r }) => signed(r.variance) },
        { label: 'Person to date', num: true, get: ({ mtd }) => (mtd == null ? '' : signed(mtd)) },
      ], rows));
  }

  // ------------------------------------------------------------ people --

  function peopleView() {
    const people = data.people;
    const widest = Math.max(1, ...people.map((p) => Math.abs(p.variance)));
    return [
      h('div.card',
        h('h3', 'Drawer variance by person'),
        h('p.sub', 'Over and short against the closing counts, per person, over these days. Nothing is plugged: a shift '
          + 'without a count is not guessed.'),
        h('div.bars', people.map((p) => h('div.barrow',
          h('span.who', nameOf(p.user)),
          h('span.track', h('span.bar', {
            class: p.variance < 0 ? 'short' : 'over',
            style: { width: `${Math.round((Math.abs(p.variance) / widest) * 50)}%`, [p.variance < 0 ? 'right' : 'left']: '50%' },
          })),
          h('span.val', p.counted ? signed(p.variance) : 'not counted'))))),
      h('div.card',
        table([
          { label: 'Person', get: (p) => nameOf(p.user) },
          { label: 'Shifts', num: true, get: (p) => num(p.shifts) },
          { label: 'Cash taken', num: true, get: (p) => money(p.cash) },
          { label: 'Card + MoMo', num: true, get: (p) => money(p.card) },
          { label: 'Counted', num: true, get: (p) => `${num(p.counted)} of ${num(p.shifts)}` },
          { label: 'Over', num: true, get: (p) => money(p.over) },
          { label: 'Short', num: true, get: (p) => money(p.short) },
          { label: 'Net', num: true, get: (p) => signed(p.variance) },
          { label: 'Exceptions', num: true, get: (p) => num(p.exceptions) },
        ], people)),
    ];
  }
}
