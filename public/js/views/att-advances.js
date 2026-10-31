import { api } from '../api.js';
import { fileLink } from '../file-view.js';
import {
  confirmAction, fmtDay, h, keepPlace, money, monthOf, mount, shiftMonth, toast, todayISO,
} from '../util.js';
import { bulkUpload, card, emptyState } from './components.js';
import { advanceStatement, field, formDialog, niceMonth, showSheet } from './att-shared.js';
import { navigate, replaceParams } from '../app.js';

/**
 * Salary advances.
 *
 * A hotel lends money whether or not an app knows about it, and what goes
 * wrong is never the lending. It is that four months later nobody can say what
 * is left, because the record was a figure in a notebook and two people
 * remembering different Junes.
 *
 * THE SCREEN IS BUILT AROUND ONE HABIT. At the end of every month somebody is
 * asked, person by person, whether the deduction was actually taken. That is
 * the top of this page whenever a month is unanswered, it is one form with one
 * button, and everything else here — the balances, the requests, the
 * corrections — is arranged underneath it. A ledger that is only updated when
 * somebody remembers is worse than no ledger, because it looks authoritative.
 *
 * WHAT IS OWED IS NEVER A STORED NUMBER. Every figure on this page is the
 * difference between what was handed over and the movements underneath it, and
 * every movement can be opened, corrected and taken back off. An advance is
 * exactly the kind of figure people argue about, so the argument has to be
 * possible.
 */

/**
 * Advances already running somewhere else, brought in as a sheet.
 *
 * A property arriving with eleven of them has them on a spreadsheet, and
 * typing those into a dialog one at a time is both an afternoon and eleven
 * chances to mistype a balance.
 */
function advanceImportButton(reload) {
  return bulkUpload({
    accept: '.csv,text/csv',
    title: 'Advances as a CSV. Nothing is written until you have seen what it would do.',
    template: {
      href: '/api/advances/template',
      download: 'advances.csv',
      label: 'Download template',
    },
    onFile: async (file) => {
      try {
        const text = await file.text();
        const read = await api.advanceReadImport(text);
        await showAdvanceImport({ text, read, reload });
      } catch (err) {
        toast(err.message, 'bad');
      }
    },
  });
}

/** What the file would do, and the button that does it. */
async function showAdvanceImport({ text, read, reload }) {
  const { tally } = read;
  const cash = (n) => money(n, 'GHS');

  const line = (row) => h('div.pay-import-row',
    h('div',
      h('strong', row.name),
      h('span.muted', ` · ${row.employeeNo}`),
      h('ul.pay-import-changes',
        h('li', 'Amount: ', h('strong', cash(row.amount)),
          row.repaid ? h('span.muted', ` · ${cash(row.repaid)} already repaid`) : null),
        h('li', `${cash(row.monthly)} a month for ${row.months} `
          + `month${row.months === 1 ? '' : 's'}, from ${niceMonth(row.startMonth)}`),
        h('li', 'Left to take: ', h('strong', cash(row.outstanding)))),
      row.notes.length
        ? h('ul.pay-import-notes', row.notes.map((n) => h('li', `${n.what}: ${n.why}`)))
        : null));

  const done = await formDialog({
    title: 'Advances from a spreadsheet',
    submitLabel: tally.nothing ? 'Nothing to record' : `Record ${tally.adding}`,
    body: h('div',
      h('p.muted', { style: { fontSize: '.9rem', marginTop: 0 } },
        tally.nothing
          ? 'Nothing in that file is new. Anything already on the books to the pesewa and the '
            + 'day is left where it is.'
          : `${tally.adding} advance${tally.adding === 1 ? '' : 's'} would be recorded, `
            + `${cash(tally.money)} in all with ${cash(tally.outstanding)} still to come off. `
            + 'Nothing has been written yet.'),

      read.missingColumns.length
        ? h('div.returns-warn', `The sheet needs ${read.missingColumns.join(' and ')}.`)
        : null,

      tally.adding
        ? h('div.alert.warn',
          h('span.alert-icon', '⚠️'),
          h('div',
            h('div.alert-title', 'Nobody is told'),
            h('div.alert-detail', 'Recording an advance by hand sends the person a message, '
              + 'because money has just been agreed. These have been running since before HIVE '
              + 'saw them, so no message goes out. Tell anybody who needs to hear it yourself.')))
        : null,

      read.unknown.length
        ? h('div.returns-warn',
          h('strong', 'Columns nobody recognised, so they were left alone'),
          h('div', read.unknown.join(', ')))
        : null,

      read.skipped.length
        ? h('div.returns-warn',
          h('strong', `${read.skipped.length} line${read.skipped.length === 1 ? '' : 's'} skipped`),
          h('ul', read.skipped.map((row) => h('li',
            `Line ${row.at}: ${row.name || row.employeeNo || 'blank'} · ${row.why}`))))
        : null,

      read.lines.length ? h('div.pay-import-list.import-open', read.lines.map(line)) : null),

    onSubmit: () => (tally.nothing
      ? Promise.resolve({ added: 0, failed: [] })
      : api.advanceApplyImport(text)),
  });

  if (!done) return;
  const bits = [];
  if (done.added) bits.push(`${done.added} recorded`);
  if (done.failed?.length) bits.push(`${done.failed.length} could not be saved`);
  toast(bits.length ? `${bits.join(', ')}.` : 'Nothing recorded.',
    done.failed?.length ? 'warn' : bits.length ? 'good' : 'warn');
  await reload();
}

export async function renderAttAdvances(params) {
  const host = h('div');
  const month = /^\d{4}-\d{2}$/.test(params.month) ? params.month : monthOf(todayISO());
  const data = await api.advances(month);

  const reload = async (next = {}) => {
    const merged = { ...params, month, ...next };
    if (merged.show === 'paying') delete merged.show;
    // Called with no arguments after a save: the reader has not moved, so
    // neither should the page. Called with arguments because a control was
    // pressed, and then the top of a fresh month is where to be.
    const stayed = Object.keys(next).length === 0;
    const putBack = stayed ? keepPlace() : null;
    replaceParams('att-advances', merged);
    mount(host, await renderAttAdvances(merged));
    if (putBack) putBack();
  };

  const cash = (n) => money(n, data.currency);

  const show = ['paying', 'waiting', 'later', 'paidoff'].includes(params.show)
    ? params.show
    : (data.requests.length && !data.people.some((p) => p.totals.owed > 0) ? 'waiting' : 'paying');
  let query = '';
  const paying = data.people.filter((p) => p.totals.owed > 0);
  const paidOff = data.people.filter((p) => p.totals.owed <= 0);
  const counts = { paying: paying.length, waiting: data.requests.length, later: (data.later ?? []).length, paidoff: paidOff.length };
  const ctx = { data, reload, cash };

  const listHost = h('div');
  const drawList = () => {
    const match = (name) => !query || String(name ?? '').toLowerCase().includes(query);
    if (show === 'waiting') {
      const reqs = data.requests.filter((r) => match(r.staffName));
      mount(listHost, reqs.length ? requestsCard({ ...data, requests: reqs }, reload, cash)
        : emptyState('Nothing waiting', 'When somebody asks for an advance from their phone, it waits here for you.'));
      return;
    }
    if (show === 'later') {
      const rows = (data.later ?? []).filter((r) => match(r.staff));
      mount(listHost, rows.length
        ? h('section.card.adv-list', rows.map((r) => {
          const person = data.people.find((p) => p.staff.id === r.staffId);
          return h('button.adv-item', { type: 'button', onclick: () => person && openPanel(person, ctx) },
            h('span.adv-who', h('b', r.staff)),
            h('span.muted', `${cash(r.monthly)} a month`),
            h('span', `from ${niceMonth(r.from)}`),
            h('span.adv-chev', { 'aria-hidden': 'true' }, '›'));
        }))
        : emptyState('Nothing starting later', 'Money handed over in the last week of a month comes off from the month after; it shows here until then.'));
      return;
    }
    const people = (show === 'paidoff' ? paidOff : paying).filter((p) => match(`${p.staff.name} ${p.staff.department ?? ''}`));
    mount(listHost, people.length
      ? h('section.card.adv-list',
        h('div.adv-item.adv-item-head', { 'aria-hidden': 'true' },
          h('span', 'Name'), h('span', 'For'), h('span', 'Paid back'), h('span.num', 'Left'), h('span.num', 'A month'), h('span', 'Finishes'), h('span')),
        people.map((person) => listRow(person, ctx)))
      : show === 'paidoff'
        ? emptyState('Nobody has finished paying back yet', 'Advances paid off in full move here, with their history.')
        : emptyState('Nobody is paying anything back', 'When somebody is given an advance, they show here until it is paid off.'));
  };

  const chips = h('div.adv-chips', { role: 'group', 'aria-label': 'Show' },
    [['paying', 'Paying back'], ['waiting', 'Waiting on you'], ['later', 'Starting later'], ['paidoff', 'Paid off']]
      .filter(([k]) => k === 'paying' || k === 'waiting' || counts[k])
      .map(([k, label]) => h('button.adv-chip', {
        type: 'button',
        class: k === show ? 'adv-chip on' : 'adv-chip',
        'aria-pressed': String(k === show),
        onclick: () => reload({ show: k }),
      }, label, ' ', h('b', { class: k === 'waiting' && counts.waiting ? 'is-warn' : '' }, String(counts[k])))),
    h('button.adv-chip', { type: 'button', onclick: () => navigate('till-shortages') }, 'Till shortages ›'));

  const search = h('input.adv-search', {
    type: 'search', placeholder: 'Find a name', 'aria-label': 'Find a name',
    oninput: () => { query = search.value.trim().toLowerCase(); drawList(); },
  });
  drawList();

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Advances'),
        h('div.sub', data.totals.owed > 0
          ? [h('b', cash(data.totals.owed)), ` owed by ${data.totals.people} ${data.totals.people === 1 ? 'person' : 'people'} · `,
            h('b', cash(data.totals.monthly)), ` coming off ${niceMonth(monthOf(todayISO()))} pay`]
          : 'Nobody owes anything just now'),
      ),
      h('div.btn-row',
        h('button.btn-sm', { type: 'button', onclick: () => shiftShown(month, reload) }, 'Another month'),
        advanceImportButton(reload),
        h('button.btn-sm.btn-primary', { onclick: () => addOne(data, reload) }, 'Give an advance')),
    ),

    // The end-of-month question, as a bar while it is due; the list itself
    // opens in a window.
    monthBar(data, month, reload, cash),

    h('div.adv-tools', chips, search),
    listHost,
  );

  // A person's panel that was open before this redraw opens again on the new
  // figures, so a change made in it is seen in it.
  if (panelFor != null) {
    const person = data.people.find((p) => p.staff.id === panelFor);
    if (person) openPanel(person, ctx); else closePanel();
  }

  return host;
}

// --------------------------------------------------------------------------
// The end of the month
// --------------------------------------------------------------------------

/**
 * "Was it taken?", asked once, for everybody at once.
 *
 * Everything is ticked to start with, because the ordinary month is one where
 * every deduction went through, and a form that makes somebody tick twelve
 * boxes to say "yes, as usual" is a form they stop filling in. What it wants
 * is the exceptions.
 */
/**
 * The month's question, as one line while it is due: how many deductions are
 * waiting to be confirmed, and a button that opens the list in a window. A
 * closed month says so in a line and can be opened back up. Nothing at all the
 * rest of the time.
 */
function monthBar(data, month, reload, cash) {
  const outstanding = data.due.filter((row) => !row.recorded);
  const total = outstanding.reduce((n, row) => n + (row.expected || 0), 0);
  if (data.closed && !outstanding.length) {
    return h('p.muted.adv-month-line',
      `${niceMonth(month)} closed off${data.closed.by ? ` by ${data.closed.by}` : ''}. `,
      h('button.btn-link', { type: 'button', onclick: () => openItBackUp(month, reload) }, 'Open it back up'));
  }
  if (!outstanding.length && !data.monthEnd) return null;
  return h('div.adv-month-bar', { role: 'status' },
    h('span.adv-month-dot', { 'aria-hidden': 'true' }),
    h('span', outstanding.length
      ? [h('b', `${niceMonth(month)} is due to close. `), `${outstanding.length} deduction${outstanding.length === 1 ? '' : 's'} to confirm, ${cash(total)}.`]
      : [h('b', `${niceMonth(month)}: `), 'nothing was due to come off anybody\'s pay.']),
    h('button.btn-sm.btn-primary', { type: 'button', onclick: () => monthDialog(data, month, reload, cash) },
      outstanding.length ? `Confirm ${niceMonth(month)}` : 'Close it'));
}

/** The month's list in a window: the same ticks and amounts as ever. */
function monthDialog(data, month, reload, cash) {
  const dialog = h('dialog.app-dialog.app-dialog-wide');
  const done = async (next) => { dialog.close(); await reload(next); };
  const body = dueCard(data, month, done, cash);
  body?.classList?.add('adv-in-dialog');
  mount(dialog,
    h('div.dialog-head', h('h2', `Confirm ${niceMonth(month)}`),
      h('div.dialog-head-tools', h('button.dialog-close', { type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, '✕'))),
    body);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

function dueCard(data, month, reload, cash) {
  const outstanding = data.due.filter((row) => !row.recorded);
  const closed = Boolean(data.closed);

  if (!outstanding.length) {
    // Nothing to ask about. Worth a line where somebody is expecting the
    // question or has just answered it, and worth nothing at all otherwise.
    if (!closed && !data.monthEnd) return null;
    return card(`${niceMonth(month)}`, { wide: true, note: closed ? 'closed off' : 'nothing due' },
      h('p.muted', closed
        ? `Closed off by ${data.closed.by || 'somebody'}. Every advance running in `
          + `${niceMonth(month)} has an answer against it.`
        : `Nothing was due to come off anybody's pay in ${niceMonth(month)}.`),
      startingLater(data),
      closed
        ? h('button.btn-sm', { onclick: () => openItBackUp(month, reload) }, 'Open it back up')
        : h('button.btn-sm', {
          onclick: async () => {
            await api.advanceCloseMonth({ month, rows: [] });
            toast(`${niceMonth(month)} closed off.`, 'good');
            await reload();
          },
        }, 'Close the month anyway'));
  }

  const state = new Map(outstanding.map((row) => [row.advanceId, {
    paid: true, amount: row.expected,
  }]));

  const lines = outstanding.map((row) => {
    const mine = state.get(row.advanceId);

    const amount = h('input.adv-amount', {
      type: 'number', step: '0.01', min: '0', value: row.expected,
      'aria-label': `What came off ${row.staff}'s pay`,
      onchange: (e) => { mine.amount = Number(e.target.value) || 0; },
    });

    const tick = h('input', {
      type: 'checkbox', checked: true,
      'aria-label': `Deducted from ${row.staff}`,
      onchange: (e) => {
        mine.paid = e.target.checked;
        amount.disabled = !e.target.checked;
        line.classList.toggle('adv-skipped', !e.target.checked);
      },
    });

    const line = h('tr',
      h('td', h('label.tickline', tick, h('span', row.staff))),
      h('td.num.muted', cash(row.balance)),
      h('td.num', amount),
    );
    return line;
  });

  return card(`Close off ${niceMonth(month)}`, {
    wide: true,
    note: `${outstanding.length} to confirm`,
    actions: h('button.btn-sm', { onclick: () => shiftShown(month, reload) }, 'A different month'),
  },
  h('p.muted', { style: { marginTop: 0 } },
    'Everything is ticked as taken, which is what usually happened. Untick anybody it did not '
    + 'come off, and change the figure where it came off differently. Nothing is written until '
    + 'you press the button.'),

  // Here too, not only on a quiet month: somebody who has just recorded three
  // advances and finds one name on this list wonders where the other two went.
  startingLater(data),

  h('div.table-wrap', h('table.adv-close',
    h('thead', h('tr', h('th', 'Deducted'), h('th.num', 'Still owed'), h('th.num', 'Amount'))),
    h('tbody', lines))),

  h('div.btn-row', { style: { marginTop: '.9rem' } },
    h('button.btn.btn-primary', {
      onclick: async (e) => {
        e.target.disabled = true;
        try {
          const rows = [...state.entries()].map(([advanceId, v]) => ({
            advanceId, paid: v.paid, amount: v.amount,
          }));
          const out = await api.advanceCloseMonth({ month, rows });
          toast(`${niceMonth(month)} closed. ${out.taken} deducted, ${out.skipped} let go.`, 'good');
          await reload();
        } catch (err) {
          e.target.disabled = false;
          toast(err.message, 'bad');
        }
      },
    }, `Record ${niceMonth(month)}`),
    h('button.btn-sm', { onclick: () => addOne(data, reload) }, 'Something new was given out')));
}

/**
 * Advances that are running and simply not due yet.
 *
 * An empty month-end card is either "nobody owes anything" or "the three you
 * recorded this afternoon start next month", and those are not the same news.
 * Money handed over in the last week of a month repays from the month after,
 * which is deliberate and was invisible: whoever had just recorded them saw a
 * card saying nothing was due and concluded they had not saved.
 */
function startingLater(data) {
  const rows = data.later ?? [];
  if (!rows.length) return null;

  const byMonth = new Map();
  for (const row of rows) {
    if (!byMonth.has(row.from)) byMonth.set(row.from, []);
    byMonth.get(row.from).push(row.staff);
  }

  return h('p.muted', { style: { fontSize: '.85rem' } },
    rows.length === 1
      ? 'One advance is running that does not start yet: '
      : `${rows.length} advances are running that do not start yet: `,
    [...byMonth.entries()].map(([from, names], at) => h('span', at ? '; ' : '',
      names.join(', '), ` from ${niceMonth(from)}`)),
    '. Money handed over in the last week of a month comes off from the month after.');
}

/**
 * Take the closed-off mark back off a month.
 *
 * A month gets closed off in a hurry and somebody then finds a deduction that
 * never happened. The mark used to be permanent, so the only way on was to
 * leave a wrong figure standing.
 *
 * The dialog says what it does not do, because the reasonable expectation of a
 * button called "Open it back up" is that everything goes back to how it was,
 * and that is not what happens: the deductions already recorded stay put, and
 * a wrong one is taken off with the cross beside it.
 */
async function openItBackUp(month, reload) {
  const out = await formDialog({
    title: `Open ${niceMonth(month)} back up`,
    submitLabel: 'Open it back up',
    body: h('div',
      h('p', { style: { marginTop: 0 } },
        `${niceMonth(month)} stops being closed off, so it can be answered again and the `
        + 'end-of-month question will come round to it.'),
      h('p.muted', 'Nothing already recorded is taken back. If a deduction against this '
        + 'month is wrong, take that one off with the cross beside it on the advance itself, '
        + 'which leaves a note saying why.')),
    onSubmit: () => api.advanceReopenMonth({ month }),
  });
  if (!out) return;

  toast(out.kept
    ? `${niceMonth(month)} is open again. ${out.kept} movement${out.kept === 1 ? '' : 's'} `
      + 'against it left as they are.'
    : `${niceMonth(month)} is open again.`, 'good');
  await reload();
}

/** Look at another month, which is how a missed one gets caught up. */
async function shiftShown(month, reload) {
  const picked = await formDialog({
    title: 'Which month',
    submitLabel: 'Show it',
    body: field('Month', h('input', { type: 'month', name: 'month', value: month })),
    onSubmit: async (form) => ({ month: form.get('month') }),
  });
  if (picked?.month) await reload({ month: picked.month });
}

// --------------------------------------------------------------------------
// Requests
// --------------------------------------------------------------------------

function requestsCard(data, reload, cash) {
  return card('Waiting on you', {
    wide: true,
    note: `${data.requests.length} waiting`,
  },
  h('ul.adv-requests', data.requests.map((req) => h('li',
    h('div',
      h('div.adv-who', req.staffName),
      h('div.muted',
        req.purposeLabel ? h('span.pill', req.purposeLabel) : null,
        ` ${cash(req.amount)} over ${req.months} month${req.months === 1 ? '' : 's'}`
        + ` · asked ${fmtDay(String(req.askedAt).slice(0, 10))}`),
      req.reason ? h('div.adv-reason', req.reason) : null,
      // The bill or the agreement they attached. Deciding a request for school
      // fees without opening it is deciding it on trust.
      req.hasPaper
        ? fileLink({
          href: api.advancePaperUrl(req.id),
          name: `The paper \u2014 ${req.staffName ?? 'advance'}`,
          label: 'See the paper',
          className: 'btn-sm',
        })
        : req.purpose && req.purpose !== 'other'
          ? h('span.pill.warn', 'nothing attached')
          : null),
    h('div.btn-row',
      h('button.btn-sm.btn-primary', {
        onclick: () => decide(req, true, reload, cash),
      }, 'Approve'),
      h('button.btn-sm', {
        onclick: () => decide(req, false, reload, cash),
      }, 'Turn down'))))));
}

/**
 * Approving is also where the terms get settled.
 *
 * What somebody asks for and what the property can do are often two different
 * numbers, and the answer should be the agreement rather than a refusal
 * followed by a second form.
 */
async function decide(req, approve, reload, cash) {
  if (!approve) {
    const done = await formDialog({
      title: `Turn down ${req.staffName}'s request`,
      submitLabel: 'Turn it down',
      body: h('div',
        h('p.muted', { style: { fontSize: '.85rem' } },
          `${cash(req.amount)} over ${req.months} months. They are told, so a line here is `
          + 'worth more than none.'),
        field('Why', h('input', { type: 'text', name: 'note', maxlength: 300 }))),
      onSubmit: (form) => api.advanceDecide(req.id, { approve: false, note: form.get('note') }),
    });
    if (!done) return;
    toast('Turned down. They have been told.', 'good');
    await reload();
    return;
  }

  const amount = h('input', {
    type: 'number', name: 'amount', step: '0.01', min: '1', value: req.amount, required: true,
  });
  const months = h('input', {
    type: 'number', name: 'months', min: '1', max: '60', value: req.months, required: true,
  });
  const monthly = h('input', { type: 'number', name: 'monthly', step: '0.01', min: '1' });

  // The instalment follows the two figures above it until somebody types in
  // it, and then it is theirs.
  let touched = false;
  const recompute = () => {
    if (touched) return;
    const over = Math.max(1, Number(months.value) || 1);
    monthly.value = (Math.ceil((Number(amount.value) || 0) / over * 100) / 100).toFixed(2);
  };
  monthly.addEventListener('input', () => { touched = true; });
  amount.addEventListener('input', recompute);
  months.addEventListener('input', recompute);
  recompute();

  const done = await formDialog({
    title: `Approve ${req.staffName}'s advance`,
    submitLabel: 'Approve it',
    body: h('div',
      req.reason ? h('p.muted', { style: { fontSize: '.85rem' } }, req.reason) : null,
      h('div.field-row',
        field('Amount', amount),
        field('Over how many months', months,
          req.purposeLabel
            ? `${req.purposeLabel} is normally ${req.months}. You are the only one who can `
              + 'change it.'
            : 'You are the only one who can change this.'),
        field('A month', monthly, 'Worked out for you. Change it if you have agreed otherwise.')),
      h('div.field-row',
        field('Handed over on', h('input', { type: 'date', name: 'takenOn', value: todayISO() })),
        field('First deduction', h('input', {
          type: 'month', name: 'startMonth', value: monthOf(todayISO()),
        }), 'Usually the month after the money is handed over')),
      field('Anything to add', h('input', { type: 'text', name: 'note', maxlength: 300 }))),
    onSubmit: (form) => api.advanceDecide(req.id, {
      approve: true,
      amount: form.get('amount'),
      months: form.get('months'),
      monthly: form.get('monthly'),
      takenOn: form.get('takenOn'),
      startMonth: form.get('startMonth'),
      note: form.get('note'),
    }),
  });
  if (!done) return;
  toast(`Approved. ${req.staffName} has been told.`, 'good');
  await reload();
}

/** Record one the office has handed over, with or without anybody asking. */
async function addOne(data, reload) {
  const who = h('select', { name: 'staffId', required: true },
    h('option', { value: '' }, 'Choose somebody'),
    data.staff.map((s) => h('option', { value: s.id }, `${s.name}${s.department ? ` · ${s.department}` : ''}`)));

  const amount = h('input', { type: 'number', name: 'amount', step: '0.01', min: '1', required: true });
  const months = h('input', { type: 'number', name: 'months', min: '1', max: '60', value: 3, required: true });
  const monthly = h('input', { type: 'number', name: 'monthly', step: '0.01', min: '1' });

  let touched = false;
  const recompute = () => {
    if (touched) return;
    const over = Math.max(1, Number(months.value) || 1);
    const each = (Number(amount.value) || 0) / over;
    monthly.value = each ? (Math.ceil(each * 100) / 100).toFixed(2) : '';
  };
  monthly.addEventListener('input', () => { touched = true; });
  amount.addEventListener('input', recompute);
  months.addEventListener('input', recompute);

  const done = await formDialog({
    title: 'Record an advance',
    submitLabel: 'Record it',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        'They are told on their phone, and it shows on their own screen with the schedule. '
        + 'Money coming off a payslip nobody mentioned is how this arrangement loses people.'),
      field('Who', who),
      field('What it is for', h('select', { name: 'purpose' },
        h('option', { value: '' }, 'Not saying'),
        h('option', { value: 'school_fees' }, 'School fees'),
        h('option', { value: 'rent' }, 'Rent'),
        h('option', { value: 'other' }, 'Something else')),
      'The caps and the paperwork are rules about what staff may ask for. Recording one you '
      + 'have already handed over is not held to them.'),
      h('div.field-row',
        field('How much', amount),
        field('Over how many months', months),
        field('A month', monthly, 'Worked out for you')),
      h('div.field-row',
        field('Handed over on', h('input', { type: 'date', name: 'takenOn', value: todayISO() })),
        field('First deduction', h('input', { type: 'month', name: 'startMonth' }),
          'Left blank, the app takes the month after money handed over late in a month')),
      field('What it is for', h('input', { type: 'text', name: 'reason', maxlength: 300 }))),
    onSubmit: (form) => api.advanceAdd(Object.fromEntries(form.entries())),
  });
  if (!done) return;
  // When it starts coming off, not just that it saved. Money handed over on
  // the 31st repays from next month, and somebody who is not told that goes
  // looking for it in this month's list and concludes it did not save.
  toast(done.startMonth
    ? `Recorded, and they have been told. First deduction ${niceMonth(done.startMonth)}.`
    : 'Recorded, and they have been told.', 'good');
  await reload();
}

// --------------------------------------------------------------------------
// One person
// --------------------------------------------------------------------------

/**
 * Whose row is opened out, and whose paid-off advances are showing.
 *
 * Kept out here so a redraw does not fold everything away. Saving a figure
 * redraws this screen, and closing the person somebody was working on every
 * time they save is how a screen makes a person do their work twice.
 */
/** Which person's panel is open, kept across a redraw. */
let panelFor = null;
let panelEl = null;

function closePanel() {
  panelFor = null;
  if (panelEl) { panelEl.quiet = true; panelEl.close(); panelEl = null; }
}

/** One person on the list: what they had, how far through it, and when it ends. */
function listRow(person, ctx) {
  const { cash } = ctx;
  const running = person.advances.filter((a) => a.status === 'approved');
  const labels = [...new Set(running.map((a) => a.purposeLabel).filter(Boolean))];
  const held = running.some((a) => a.till && !a.till.checkedAt);
  const taken = person.totals.taken;
  const repaid = Math.max(0, taken - person.totals.owed);
  const pct = taken > 0 ? Math.min(100, Math.round((repaid / taken) * 100)) : 0;
  return h('button.adv-item', {
    type: 'button',
    'aria-label': `${person.staff.name}: ${cash(person.totals.owed)} left`,
    onclick: () => openPanel(person, ctx),
  },
  h('span.adv-who', h('b', person.staff.name), h('small.muted', person.staff.department || `No. ${person.staff.employeeNo ?? ''}`)),
  h('span', running.length > 1
    ? h('span.pill', `${running.length} running`)
    : labels.length ? h(`span.pill${labels[0] === 'Till shortage' ? '.warn' : ''}`, labels[0]) : h('span.muted', '—')),
  h('span.adv-prog',
    h('span.adv-bar', { role: 'img', 'aria-label': `${cash(repaid)} of ${cash(taken)} paid back` }, h('i', { style: { width: `${pct}%` } })),
    h('small.muted', `${cash(repaid)} of ${cash(taken)}`)),
  h('span.num', person.totals.owed > 0 ? h('b', cash(person.totals.owed)) : h('span.pill.good', 'clear')),
  h('span.num', person.totals.monthly ? cash(person.totals.monthly) : h('span.muted', '—')),
  h('span', held ? h('span.pill.bad', 'Held') : person.totals.finishes ? niceMonth(person.totals.finishes) : h('span.muted', '—')),
  h('span.adv-chev', { 'aria-hidden': 'true' }, '›'));
}

/**
 * One person's advances, in a panel at the side: each running advance as a
 * card, what is paid off folded away, their statement a press away. The list
 * stays where it was underneath, one screen long.
 */
function openPanel(person, ctx) {
  const { data, reload, cash } = ctx;
  if (panelEl) { panelEl.quiet = true; panelEl.close(); }
  panelFor = person.staff.id;
  const done = person.advances.filter((a) => a.status === 'settled');
  const live = person.advances.filter((a) => a.status !== 'settled');
  const paidOff = done.reduce((n, a) => n + a.amount, 0);
  const el = h('dialog.app-dialog.adv-panel', { 'aria-label': `${person.staff.name}'s advances` },
    h('div.adv-panel-head',
      h('div',
        h('h2', person.staff.name),
        h('div.muted', [
          person.staff.department,
          person.totals.owed > 0 ? `owes ${cash(person.totals.owed)}` : 'owes nothing',
          person.totals.monthly ? `${cash(person.totals.monthly)} a month` : null,
          person.totals.finishes ? `done by ${niceMonth(person.totals.finishes)}` : null,
        ].filter(Boolean).join(' · '))),
      h('div.btn-row',
        h('button.btn-sm', { type: 'button', onclick: () => showStatement(person, { data, reload, cash }) }, 'Statement'),
        h('button.btn-sm', { type: 'button', onclick: () => { closePanel(); navigate('att-staff', { id: person.staff.id }); } }, 'Record'),
        h('button.dialog-close', { type: 'button', 'aria-label': 'Close', onclick: () => closePanel() }, '✕'))),
    h('div.adv-panel-body',
      live.length
        ? live.map((advance) => advanceBlock(advance, { person, data, reload, cash }))
        : h('p.muted', 'Nothing running. Everything they have had is paid off.'),
      done.length
        ? h('details.adv-done',
          h('summary.adv-done-head', h('span', `${done.length} paid off`), h('small.muted', `${cash(paidOff)} in all`)),
          done.map((advance) => advanceBlock(advance, { person, data, reload, cash })))
        : null));
  el.addEventListener('close', () => {
    el.remove();
    if (!el.quiet) panelFor = null;
    if (panelEl === el) panelEl = null;
  });
  document.body.append(el);
  el.showModal();
  panelEl = el;
}

/** One agreement: its terms, its movements, and the ways to correct it. */
function advanceBlock(advance, { person, data, reload, cash }) {
  const badge = {
    approved: ['good', 'running'],
    settled: ['', 'paid off'],
    requested: ['warn', 'waiting'],
    declined: ['', 'turned down'],
    withdrawn: ['', 'taken back'],
  }[advance.status] ?? ['', advance.status];
  const pct = advance.amount > 0 ? Math.min(100, Math.round((advance.repaid / advance.amount) * 100)) : 0;

  // The rare ones, under ⋯: a record that is wrong, or should never have existed.
  const more = data?.canEdit
    ? h('details.adv-more',
      h('summary', { 'aria-label': 'More for this advance', title: 'Correct the record, or delete it' }, '⋯'),
      h('div.adv-more-menu',
        ['approved', 'settled'].includes(advance.status)
          ? h('button.btn-ghost.btn-sm', {
            type: 'button',
            title: 'The record is wrong: the amount, the date, what it was for',
            onclick: () => editRecord(advance, { person, data, reload, cash }),
          }, 'Correct the record')
          : null,
        h('button.btn-ghost.btn-sm.danger', {
          type: 'button',
          title: 'Take the whole record off the books',
          onclick: () => removeRecord(advance, { person, reload, cash }),
        }, 'Delete')))
    : null;

  // The last three movements, the rest one press away.
  const moves = advance.entries ?? [];
  const recent = moves.slice(-3);
  const older = moves.slice(0, -3);
  const moveRow = (entry) => h('div.adv-move',
    h('span', niceMonth(entry.month)),
    h('span.muted', [MOVEMENT[entry.kind] ?? entry.kind, entry.note].filter(Boolean).join(' · ')),
    h('span.num', entry.kind === 'skipped' ? h('span.muted', 'nothing') : cash(entry.amount)),
    h('span.adv-move-tools',
      h('button.btn-ghost.btn-sm', {
        type: 'button', title: 'Put this figure right', 'aria-label': 'Put this figure right',
        onclick: () => editMovement(advance, entry, { person, reload, cash }),
      }, '✎'),
      h('button.btn-ghost.btn-sm', {
        type: 'button', title: 'Take this off the record', 'aria-label': 'Take this off the record',
        onclick: async () => {
          if (!confirmAction('Take this movement off the record? What is owed goes back up.')) return;
          await api.advanceRemoveEntry(advance.id, entry.id);
          toast('Taken off.', 'good');
          await reload();
        },
      }, '✕')));

  return h('section.adv-card',
    h('div.adv-card-head',
      h('div.adv-card-title',
        h('strong', cash(advance.amount)),
        advance.purposeLabel ? h(`span.pill${advance.purpose === 'till' ? '.warn' : ''}`, advance.purposeLabel) : null,
        h(`span.pill${badge[0] ? `.${badge[0]}` : ''}`, badge[1])),
      more),

    advance.reason ? h('div.adv-reason', advance.reason) : null,
    // A till shortage comes off pay only while its shift is checked in Insight.
    advance.till && advance.status === 'approved'
      ? h('div.adv-reason', advance.till.checkedAt
        ? `Shift checked${advance.till.checkedBy ? ` by ${advance.till.checkedBy}` : ''} on ${fmtDay(String(advance.till.checkedAt).slice(0, 10))}.`
        : h('span', { style: { color: 'var(--bad)' } }, 'Held: its shift is not checked in Insight, so nothing comes off until it is.'))
      : null,

    h('div.adv-bar.adv-bar-lg', { role: 'img', 'aria-label': `${cash(advance.repaid)} of ${cash(advance.amount)} paid back` }, h('i', { style: { width: `${pct}%` } })),

    h('div.adv-terms',
      term('Paid back', cash(advance.repaid)),
      term('Left', cash(advance.balance)),
      term('A month', cash(advance.monthly)),
      term(advance.purpose === 'till' ? 'Recorded' : 'Handed over', advance.takenOn ? fmtDay(advance.takenOn) : '—'),
      advance.finishes ? term('Finishes', niceMonth(advance.finishes)) : null),

    // The gap between what the schedule assumes and what the books have seen.
    // Left alone it hides: the balance is right, because nothing was written,
    // while the finish date goes on counting months that were never taken.
    advance.unanswered?.length
      ? h('div.adv-gap', { role: 'alert' },
        h('span', h('b', advance.unanswered.map(niceMonth).join(', ')),
          advance.unanswered.length === 1 ? ' has nothing recorded, either way.' : ' have nothing recorded, either way.'),
        h('button.btn-sm', { type: 'button', onclick: () => catchUp(advance, { person, reload, cash }) }, 'Catch up'))
      : null,

    h('div.adv-moves-list',
      h('div.adv-moves-head', h('b', 'Payments'), older.length ? h('small.muted', `${moves.length} in all`) : null),
      moves.length
        ? [
          older.length ? h('details.adv-older', h('summary', `${older.length} earlier`), older.map(moveRow)) : null,
          recent.map(moveRow),
        ]
        : h('p.muted', { style: { fontSize: '.85rem', margin: '.2rem 0 0' } }, 'Nothing has come off yet.')),

    advance.status === 'approved'
      ? h('div.btn-row',
        h('button.btn-sm', { type: 'button', onclick: () => adjust(advance, reload, cash) }, 'Change the terms'),
        h('button.btn-sm', { type: 'button', onclick: () => addMovement(advance, { person, reload, cash }) }, 'Add a payment'))
      : null,
  );
}

const MOVEMENT = {
  repayment: 'Deducted',
  skipped: 'Let go',
  adjustment: 'Correction',
  writeoff: 'Written off',
};

const term = (label, value) => h('div.adv-term', h('small.muted', label), h('div', value));

/**
 * Their account, as they see it.
 *
 * The same statement their own screen draws, from the same figures. A manager
 * answering "why is this still running" and the person asking it should be
 * looking at one table, not at two arrangements of the same numbers that have
 * to be reconciled out loud.
 */
async function showStatement(person, { data, reload, cash }) {
  const mine = await api.advanceStaff(person.staff.id).catch(() => null);
  if (!mine) { toast('That did not load.', 'bad'); return; }

  const sheet = showSheet({
    title: `${mine.staff.name}\u2019s account`,
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        'This is the page they see on their own phone. The months behind are what was '
        + 'recorded; the ones ahead are what is expected, and they move whenever anything '
        + 'does.'),
      advanceStatement(mine.account, cash, { title: null, currency: data.currency })
        ?? h('p.muted', 'Nothing has been borrowed.'),
      // Only where there is a history to put right, and only for somebody who
      // may. Retyping what came off last April moves what a person owes.
      data?.canEdit && mine.account?.some((row) => row.done)
        ? h('div.btn-row', { style: { marginTop: '.8rem' } },
          h('button.btn-sm', {
            onclick: () => { sheet.close(); putHistoryRight(person, mine, { reload, cash }); },
          }, 'Put the old months right'))
        : null),
  });
}

/**
 * The months that have already gone, typed the way the notebook has them.
 *
 * The property was lending money long before any of this existed, and the
 * figures for last April are whatever is written in the book. Nothing else in
 * the app can put them in: the month-end close only ever asks about the month
 * it is in, and a correction against one advance cannot say that a top-up was
 * handed over in June and never recorded.
 *
 * Two columns, and only for months that have ended. What gets written is
 * ordinary records, so the closing balances and the last instalment work
 * themselves out from here rather than being typed as well and then having to
 * be kept in step.
 */
async function putHistoryRight(person, mine, { reload, cash }) {
  const past = (mine.account ?? []).filter((row) => row.done);
  if (!past.length) { toast('There is no history to put right yet.', 'warn'); return; }

  const boxes = past.map((row) => {
    const taken = h('input.adv-hist-in', {
      type: 'number', step: '0.01', min: '0', value: row.additions || '',
      placeholder: '\u2014',
    });
    const repaid = h('input.adv-hist-in', {
      type: 'number', step: '0.01', min: '0', value: row.repayment || '',
      placeholder: '\u2014',
    });
    // The closing figure, redrawn as the figures above it are typed. A grid
    // that shows what a change does to the balance is the whole reason for
    // typing into a grid rather than into four separate forms.
    const closing = h('td.num.muted', cash(row.closing));
    return { row, taken, repaid, closing };
  });

  const redraw = () => {
    let opening = past[0].opening;
    for (const box of boxes) {
      // Blank leaves a month alone, so blank reads as what is already there.
      const num = (input, fallback) => (input.value === '' ? fallback : Number(input.value) || 0);
      const added = num(box.taken, box.row.additions);
      const off = num(box.repaid, box.row.repayment);
      const close = Math.round((opening + added - off) * 100) / 100;
      box.closing.textContent = cash(close);
      box.closing.classList.toggle('bad-text', close < 0);
      opening = close;
    }
  };
  for (const box of boxes) {
    box.taken.addEventListener('input', redraw);
    box.repaid.addEventListener('input', redraw);
  }

  const running = mine.advances?.find((a) => a.status === 'approved');

  const done = await formDialog({
    title: `${person.staff.name}\u2019s months before this one`,
    submitLabel: 'Put them right',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        'Type what was actually handed over and what actually came off, month by month. A '
        + 'month left blank is left alone. The closing balance moves as you type, and when the '
        + 'last instalment falls is worked out from these once it is saved, so there is nothing '
        + 'else to put right afterwards.'),

      h('div.table-wrap', h('table.adv-statement.adv-hist',
        h('thead', h('tr',
          h('th', 'Month'),
          h('th.num', 'Taken'),
          h('th.num', 'Repaid'),
          h('th.num', 'Closed at'))),
        h('tbody', boxes.map(({ row, taken, repaid, closing }) => h('tr',
          h('td', niceMonth(row.month)),
          h('td.num', taken),
          h('td.num', repaid),
          closing))))),

      field('A month, for anything it has to record', h('input', {
        type: 'number', name: 'monthly', step: '0.01', min: '1',
        value: running?.monthly ?? '',
      }), 'A figure typed under Taken is money that was handed over and never written down, so '
        + 'it goes in as an advance of its own. This is what it comes off at'),

      h('div.alert.warn',
        h('span.alert-icon', '\u26a0\ufe0f'),
        h('div',
          h('div.alert-title', 'This moves what they owe'),
          h('div.alert-detail', 'They are told, and every line of it goes in the log with your '
            + 'name on it. A figure typed under Taken cannot go down \u2014 money that was '
            + 'handed over was handed over, and a wrong amount is put right on the advance '
            + 'itself with Correct the record.'))),

      field('Why', h('input', {
        type: 'text', name: 'note', maxlength: 300,
        placeholder: 'Typed up from the office ledger',
      }))),

    onSubmit: (form) => api.advanceHistory(person.staff.id, {
      rows: boxes.map(({ row, taken, repaid }) => ({
        month: row.month,
        taken: taken.value,
        repaid: repaid.value,
      })),
      monthly: form.get('monthly'),
      note: form.get('note'),
    }),
  });
  if (!done) return;

  const bits = [];
  if (done.corrected) bits.push(`${done.corrected} month${done.corrected === 1 ? '' : 's'} put right`);
  if (done.made?.length) bits.push(`${done.made.length} recorded as handed over`);
  toast(bits.length ? `${bits.join(', ')}.` : 'Nothing was different.', bits.length ? 'good' : 'warn');

  // What it would not write, said rather than left as an absence.
  if (done.refused?.length) {
    toast(done.refused.map((r) => `${niceMonth(r.month)}: ${r.why}`).join('. '), 'warn');
  }
  await reload();
}

/**
 * Months that went by with nobody answering for them.
 *
 * The books say a thousand came back and eight months have gone since it
 * started, at two hundred a month. Those two do not agree, and the difference
 * is months nobody was asked about. This is where somebody says which of them
 * were let go — and the ones left unticked stay outstanding, because "we did
 * not get round to answering" and "nothing was taken" are two different
 * things and only one of them moves the finish date.
 */
async function catchUp(advance, { person, reload, cash }) {
  const ticks = new Map(advance.unanswered.map((month) => [month, h('input', { type: 'checkbox' })]));
  const owed = advance.monthly * advance.unanswered.length;

  const done = await formDialog({
    title: `Months with nothing recorded for ${person.staff.name}`,
    submitLabel: 'Record them as skipped',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        `${advance.unanswered.length} month`
        + `${advance.unanswered.length === 1 ? ' has' : 's have'} gone by without an answer. At `
        + `${cash(advance.monthly)} a month, that is ${cash(owed)} the books have never seen `
        + 'either way. Tick the ones where nothing came off.'),

      h('div.adv-catchup', [...ticks].map(([month, tick]) => h('label.tickline',
        tick, h('span', niceMonth(month))))),

      h('div.alert.warn',
        h('span.alert-icon', '\u26a0\ufe0f'),
        h('div',
          h('div.alert-title', 'A month somebody actually paid in is not this'),
          h('div.alert-detail', 'Ticking a month says nothing came off it, so what is owed '
            + 'does not change. Where money did come off and was never written down, close '
            + 'this and add it as a movement with the figure on it instead \u2014 otherwise '
            + 'they are being asked for it twice.'))),

      field('Why', h('input', {
        type: 'text', name: 'note', maxlength: 300,
        placeholder: 'Nobody closed the month off at the time',
      }))),

    onSubmit: (form) => {
      const months = [...ticks].filter(([, tick]) => tick.checked).map(([month]) => month);
      if (!months.length) throw new Error('Tick at least one month, or close this.');
      return api.advanceMarkSkipped(advance.id, { months, note: form.get('note') });
    },
  });
  if (!done) return;

  toast(`${done.marked.length} month${done.marked.length === 1 ? '' : 's'} recorded as skipped.`, 'good');
  await reload();
}

/** Change what comes off each month from here on. */
async function adjust(advance, reload, cash) {
  const done = await formDialog({
    title: 'Change the terms',
    submitLabel: 'Change them',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        `${cash(advance.balance)} is still owed. Changing what comes off each month does not `
        + 'change what is owed, only how long it takes. They are told.'),
      h('div.field-row',
        field('A month', h('input', {
          type: 'number', name: 'monthly', step: '0.01', min: '1', value: advance.monthly,
        })),
        field('Over how many months', h('input', {
          type: 'number', name: 'months', min: '1', max: '60', value: advance.months,
        }))),
      field('First deduction', h('input', {
        type: 'month', name: 'startMonth', value: advance.startMonth ?? '',
      })),
      field('Why', h('input', { type: 'text', name: 'note', maxlength: 300 }))),
    onSubmit: (form) => api.advanceAdjust(advance.id, Object.fromEntries(form.entries())),
  });
  if (!done) return;
  toast('Changed.', 'good');
  await reload();
}

/**
 * The record should never have existed.
 *
 * Not the same as writing one off. Writing off leaves a settled advance on the
 * screen saying the property handed somebody money and forgave it, which is a
 * thing to have on a record and is often not what happened. This is for a
 * duplicate, or a top-up the ledger turned out to already have, or one put on
 * the wrong person after money came off so it cannot simply be moved.
 *
 * The movements go with it, which is the point, and the whole of it goes in
 * the log first so it can be read back and keyed again.
 */
async function removeRecord(advance, { person, reload, cash }) {
  const owed = advance.balance;
  const moves = advance.entries.length;

  const done = await formDialog({
    title: `Delete ${person.staff.name}\u2019s ${cash(advance.amount)} advance`,
    submitLabel: 'Delete it',
    body: h('div',
      h('div.alert.warn',
        h('span.alert-icon', '\u26a0\ufe0f'),
        h('div',
          h('div.alert-title', 'This takes the whole record off, movements and all'),
          h('div.alert-detail', moves
            ? `${moves} movement${moves === 1 ? '' : 's'} recorded against it `
              + `${moves === 1 ? 'goes' : 'go'} with it, and `
              + `${owed > 0 ? `${cash(owed)} stops being owed` : 'nothing is left owing on it'}.`
            : 'Nothing has been recorded against it yet.'))),

      h('p.muted', { style: { fontSize: '.85rem' } },
        'For a record that should never have existed \u2014 a duplicate, or one already in the '
        + 'ledger. Where the money was real and the property is letting it go, close this and '
        + 'add a movement written off instead, so the record says what happened.'),

      owed > 0
        ? h('p.muted', { style: { fontSize: '.85rem' } },
          `${person.staff.name.split(' ')[0]} is told, because ${cash(owed)} was coming off `
          + 'their pay and now is not.')
        : null,

      field('Why', h('input', {
        type: 'text', name: 'note', maxlength: 300, required: true,
        placeholder: 'Keyed twice on the same day',
      }), 'Goes in the log with the whole record, so this can be read back')),

    onSubmit: (form) => api.advanceRemove(advance.id, form.get('note')),
  });
  if (!done) return;

  toast(done.movements
    ? `Deleted, with ${done.movements} movement${done.movements === 1 ? '' : 's'}.`
    : 'Deleted.', 'good');
  await reload();
}

/**
 * The record is wrong. Put it right.
 *
 * Not the same act as changing the terms, and kept apart from it on purpose.
 * Changing the terms leaves the facts standing and moves what comes off from
 * here on; this says the facts themselves were written down wrong. Only an
 * administrator sees it, and every field is logged as it was and as it is.
 */
async function editRecord(advance, { person, data, reload, cash }) {
  const moved = advance.entries.length > 0;

  const who = h('select', { name: 'staffId', disabled: moved || undefined },
    (data.staff ?? []).map((s) => h('option', {
      value: s.id, selected: s.id === advance.staffId,
    }, `${s.name}${s.department ? ` \u00b7 ${s.department}` : ''}`)));

  // A person who has left is not in the list to pick, but the advance may
  // still be theirs, so their name has to be somewhere on the form.
  if (![...who.options].some((o) => Number(o.value) === advance.staffId)) {
    who.prepend(h('option', { value: advance.staffId, selected: true }, person.staff.name));
  }

  const done = await formDialog({
    title: `Correct ${person.staff.name}\u2019s advance`,
    submitLabel: 'Put it right',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        `${cash(advance.repaid)} has come back so far, and the movements behind it are kept `
        + 'whatever you change here. Changing the amount or what comes off each month tells '
        + 'them; correcting a date or a spelling does not.'),

      field('Whose it is', who, moved
        ? 'There are movements against this one, so it cannot be moved to somebody else'
        : 'Nothing has come off yet, so it can still be put against the right person'),

      h('div.field-row',
        field('How much', h('input', {
          type: 'number', name: 'amount', step: '0.01', min: '1', required: true,
          value: advance.amount,
        }), advance.repaid ? `Not less than the ${cash(advance.repaid)} already repaid` : null),
        field('Over how many months', h('input', {
          type: 'number', name: 'months', min: '1', max: '60', value: advance.months,
        })),
        field('A month', h('input', {
          type: 'number', name: 'monthly', step: '0.01', min: '1', value: advance.monthly,
        }))),

      h('div.field-row',
        field('Handed over on', h('input', {
          type: 'date', name: 'takenOn', value: advance.takenOn ?? '',
        })),
        field('First deduction', h('input', {
          type: 'month', name: 'startMonth', value: advance.startMonth ?? '',
        }))),

      field('What it is for', h('select', { name: 'purpose' },
        h('option', { value: '', selected: !advance.purpose }, 'Not saying'),
        h('option', { value: 'school_fees', selected: advance.purpose === 'school_fees' }, 'School fees'),
        h('option', { value: 'rent', selected: advance.purpose === 'rent' }, 'Rent'),
        h('option', { value: 'other', selected: advance.purpose === 'other' }, 'Something else'))),

      field('The note on it', h('input', {
        type: 'text', name: 'reason', maxlength: 300, value: advance.reason ?? '',
      })),

      field('Why it is being corrected', h('input', { type: 'text', name: 'note', maxlength: 300 }),
        'Goes in the log beside what changed')),

    onSubmit: (form) => api.advanceEdit(advance.id, Object.fromEntries(form.entries())),
  });
  if (!done) return;

  toast(done.changed?.length
    ? `Put right: ${done.changed.length} thing${done.changed.length === 1 ? '' : 's'} changed.`
    : 'Nothing was different.', done.changed?.length ? 'good' : 'warn');
  await reload();
}

/** A movement outside the month-end run: a correction, a lump sum, a write-off. */
/**
 * A figure already on the record, put right.
 *
 * Not the same as taking it off and adding it again. That loses the note
 * explaining it, and on a month somebody has since closed off it is two acts
 * where only one was meant. What is owed follows the figure both ways: putting
 * a payment up can pay the advance off, putting one down brings it back.
 */
async function editMovement(advance, entry, { person, reload, cash }) {
  // Everything else this person is paying back, so a movement can be put on
  // the one it belongs to.
  const others = (person.advances ?? [])
    .filter((a) => a.id !== advance.id && ['approved', 'settled'].includes(a.status));

  const done = await formDialog({
    title: `${niceMonth(entry.month)} for ${person.staff.name}`,
    submitLabel: 'Put it right',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        `${cash(advance.balance)} is owed with this figure as it stands. Change it and what is `
        + 'owed moves with it, and they are told.'),
      h('div.field-row',
        field('Month', h('input', { type: 'month', name: 'month', value: entry.month })),
        field('What happened', h('select', { name: 'kind' },
          h('option', { value: 'repayment', selected: entry.kind === 'repayment' }, 'Deducted from pay'),
          h('option', { value: 'adjustment', selected: entry.kind === 'adjustment' }, 'Paid another way, or a correction'),
          h('option', { value: 'skipped', selected: entry.kind === 'skipped' }, 'Nothing taken this month'),
          h('option', { value: 'writeoff', selected: entry.kind === 'writeoff' }, 'Written off')))),

      // Which advance it came off. One payslip deduction covers everything a
      // person is paying back, so a figure entered against the wrong one
      // leaves that one paid off twice over and the rest reading as untouched.
      others.length
        ? field('Which advance it came off', h('select', { name: 'advanceId' },
          [{ id: advance.id, ...advance }, ...others].map((one) => h('option', {
            value: one.id, selected: one.id === advance.id,
          }, `${cash(one.amount)} from ${one.takenOn ? fmtDay(one.takenOn) : 'earlier'}`
            + `${one.reason ? ` \u00b7 ${one.reason}` : ''}`
            + ` \u2014 ${cash(one.balance)} left`))),
        'Move it onto the one it really came off. What is owed follows it, and both ends '
        + 'settle or come back as they should')
        : null,
      field('Amount', h('input', {
        type: 'number', name: 'amount', step: '0.01', value: entry.amount,
      }), 'Nothing taken this month ignores whatever is in here'),
      field('Note', h('input', {
        type: 'text', name: 'note', maxlength: 300, value: entry.note ?? '',
      })),
      entry.actor
        ? h('p.muted', { style: { fontSize: '.8rem' } },
          `Put in by ${entry.actor}${entry.at ? ` on ${String(entry.at).slice(0, 10)}` : ''}.`)
        : null),
    onSubmit: (form) => api.advanceEditEntry(advance.id, entry.id, Object.fromEntries(form.entries())),
  });
  if (!done) return;

  toast(done.moved
    ? (done.settled
      ? 'Moved, and that pays it off.'
      : `Moved. ${cash(done.balance)} is left on the one it went to.`)
    : (done.settled
      ? 'Put right, and that pays it off.'
      : `Put right. ${cash(done.balance)} is left.`), 'good');
  await reload();
}

async function addMovement(advance, { person, reload, cash }) {
  const month = h('input', {
    type: 'month', name: 'month', value: monthOf(todayISO()), required: true,
  });
  const amount = h('input', {
    type: 'number', name: 'amount', step: '0.01', value: advance.monthly,
  });
  const over = h('input', { type: 'number', name: 'months', min: '1', max: '60', value: 1 });

  // What the figures in the boxes add up to, said back before anything is
  // written. Three months of seven hundred is a sentence somebody can check;
  // three rows appearing afterwards is not.
  const sum = h('div.adv-sum');
  const say = () => {
    const each = Number(amount.value) || 0;
    const n = Math.max(1, Number(over.value) || 1);
    sum.textContent = n === 1
      ? ''
      : `${cash(each)} in each of ${n} months, from ${niceMonth(month.value)}`
        + `${each > 0 ? `, up to ${cash(Math.min(each * n, advance.balance))}` : ''}.`;
  };
  for (const box of [month, amount, over]) box.addEventListener('input', say);
  say();

  const done = await formDialog({
    title: `Add a movement for ${person.staff.name}`,
    submitLabel: 'Add it',
    body: h('div',
      h('div.field-row',
        field('From which month', month),
        field('What happened', h('select', { name: 'kind' },
          h('option', { value: 'repayment' }, 'Deducted from pay'),
          h('option', { value: 'adjustment' }, 'Paid another way, or a correction'),
          h('option', { value: 'skipped' }, 'Nothing taken this month'),
          h('option', { value: 'writeoff' }, 'Written off')))),
      h('div.field-row',
        field('Amount', amount, 'For each month, not the total'),
        field('For how many months', over,
          'The same figure, month after month, starting with the one above')),
      sum,
      h('p.muted', { style: { fontSize: '.82rem' } },
        'A month that has already been answered is left as it is rather than answered twice, '
        + 'and it stops the month the advance is paid off. What it did and what it left is on '
        + 'the screen afterwards.'),
      field('Note', h('input', { type: 'text', name: 'note', maxlength: 300 }))),
    onSubmit: (form) => api.advanceEntry(advance.id, Object.fromEntries(form.entries())),
  });
  if (!done) return;

  const n = done.written?.length ?? 0;
  toast(n === 1 || !n
    ? (n ? 'Added.' : 'Nothing was added.')
    : `Added for ${n} months, ${niceMonth(done.written[0].month)} to `
      + `${niceMonth(done.written[n - 1].month)}.`, n ? 'good' : 'warn');

  // The months it would not write over, and the month it stopped at. Both are
  // absences somebody would otherwise have to notice for themselves.
  if (done.already?.length) {
    toast(`Already answered, so left alone: ${done.already.map(niceMonth).join(', ')}.`, 'warn');
  }
  if (done.cleared) {
    toast(`It was paid off by ${niceMonth(done.cleared)}, so nothing went in after that.`, 'warn');
  }
  await reload();
}

// --------------------------------------------------------------------------

const tile = (label, value, sub) => h('div.stat',
  h('div.stat-label', label),
  h('div.stat-value', value),
  h('div.stat-sub', sub));

// It lives next door now, with the statement that uses it. Passed on from here
// because two other screens have always asked this file for it.
export { niceMonth };
