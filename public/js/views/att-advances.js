import { api } from '../api.js';
import {
  confirmAction, fmtDay, h, money, monthOf, mount, shiftMonth, toast, todayISO,
} from '../util.js';
import { bulkUpload, card, emptyState } from './components.js';
import { field, formDialog } from './att-shared.js';
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
    replaceParams('att-advances', merged);
    mount(host, await renderAttAdvances(merged));
  };

  const cash = (n) => money(n, data.currency);

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Salary advances'),
        h('div.sub', 'What was lent, what has come back, and what is left'),
      ),
      h('div.btn-row',
        advanceImportButton(reload),
        h('button.btn-sm.btn-primary', { onclick: () => addOne(data, reload) }, 'Give an advance')),
    ),

    data.requests.length ? requestsCard(data, reload, cash) : null,

    // The end-of-month question, whenever it is due. Above everything else on
    // the days it matters, and gone the rest of the time.
    dueCard(data, month, reload, cash),

    h('div.grid.grid-3.adv-tiles',
      tile('Owed to the property', cash(data.totals.owed),
        `${data.totals.people} ${data.totals.people === 1 ? 'person' : 'people'} paying back`),
      tile('Coming off this month', cash(data.totals.monthly), 'if every deduction is taken'),
      tile('Waiting on you', String(data.requests.length),
        data.requests.length ? 'asked for and not decided' : 'nothing to decide'),
    ),

    data.people.length
      ? card('Everybody with an advance', { wide: true, note: `${data.people.length} in all` },
        h('div.table-wrap', h('table.adv-table',
          h('thead', h('tr',
            h('th', 'Name'),
            h('th.num', 'Taken'),
            h('th.num', 'Paid back'),
            h('th.num', 'Left'),
            h('th.num', 'A month'),
            h('th', 'Finishes'),
            h('th', ''),
          )),
          h('tbody', data.people.map((person) => personRows(person, { data, reload, cash })).flat()))))
      : emptyState('Nobody has taken an advance',
        'When somebody does, record it here and the repayments look after themselves.'),
  );

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
      closed ? null : h('button.btn-sm', {
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
  return card('Asked for and not decided', {
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
        ? h('a.btn-sm', {
          href: api.advancePaperUrl(req.id), target: '_blank', rel: 'noopener',
        }, 'See the paper')
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
  toast('Recorded, and they have been told.', 'good');
  await reload();
}

// --------------------------------------------------------------------------
// One person
// --------------------------------------------------------------------------

function personRows(person, { data, reload, cash }) {
  const open = person.advances.filter((a) => a.status === 'approved');
  const detail = h('tr.adv-detail', { style: { display: 'none' } },
    h('td', { colspan: 7 },
      person.advances.map((advance) => advanceBlock(advance, { person, reload, cash }))));

  const toggle = () => {
    const showing = detail.style.display !== 'none';
    detail.style.display = showing ? 'none' : '';
    main.setAttribute('aria-expanded', String(!showing));
  };

  const main = h('tr.adv-row', {
    tabindex: 0,
    role: 'button',
    'aria-expanded': 'false',
    onclick: toggle,
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    },
  },
  h('td',
    h('div.adv-who', person.staff.name),
    h('small.muted', person.staff.department || `No. ${person.staff.employeeNo ?? ''}`)),
  h('td.num', cash(person.totals.taken)),
  h('td.num', cash(person.totals.taken - person.totals.owed)),
  h('td.num', person.totals.owed > 0
    ? h('strong', cash(person.totals.owed))
    : h('span.pill.good', 'clear')),
  h('td.num', person.totals.monthly ? cash(person.totals.monthly) : h('span.muted', '—')),
  h('td', person.totals.finishes
    ? niceMonth(person.totals.finishes)
    : h('span.muted', '—')),
  h('td.num', open.length > 1 ? h('span.pill.warn', `${open.length} running`) : ''));

  return [main, detail];
}

/** One agreement: its terms, its movements, and the ways to correct it. */
function advanceBlock(advance, { person, reload, cash }) {
  const badge = {
    approved: ['', 'running'],
    settled: ['good', 'paid off'],
    requested: ['warn', 'waiting'],
    declined: ['', 'turned down'],
    withdrawn: ['', 'taken back'],
  }[advance.status] ?? ['', advance.status];

  return h('div.adv-block',
    h('div.adv-block-head',
      h('div',
        h('strong', cash(advance.amount)),
        advance.purposeLabel ? h('span.muted', ` for ${advance.purposeLabel.toLowerCase()}`) : null,
        h('span.muted', ` handed over ${advance.takenOn ? fmtDay(advance.takenOn) : 'at some point'}`),
        h('span.pill' + (badge[0] ? `.${badge[0]}` : ''), { style: { marginLeft: '.4rem' } }, badge[1])),
      advance.status === 'approved'
        ? h('div.btn-row',
          h('button.btn-sm', { onclick: () => adjust(advance, reload, cash) }, 'Change the terms'),
          h('button.btn-sm', { onclick: () => addMovement(advance, reload) }, 'Add a movement'))
        : null),

    advance.reason ? h('div.adv-reason', advance.reason) : null,

    h('div.adv-terms',
      term('A month', cash(advance.monthly)),
      term('Over', `${advance.months} month${advance.months === 1 ? '' : 's'}`),
      term('Paid back', cash(advance.repaid)),
      term('Left', cash(advance.balance)),
      advance.finishes ? term('Finishes', niceMonth(advance.finishes)) : null),

    advance.entries.length
      ? h('table.adv-moves',
        h('tbody', advance.entries.map((entry) => h('tr',
          h('td', niceMonth(entry.month)),
          h('td', MOVEMENT[entry.kind] ?? entry.kind),
          h('td.num', entry.kind === 'skipped' ? h('span.muted', 'nothing') : cash(entry.amount)),
          h('td.muted', entry.note || ''),
          h('td.num', h('button.btn-ghost.btn-sm', {
            title: 'Take this off the record',
            onclick: async () => {
              if (!confirmAction('Take this movement off the record? What is owed goes back up.')) return;
              await api.advanceRemoveEntry(advance.id, entry.id);
              toast('Taken off.', 'good');
              await reload();
            },
          }, '✕')))))) 
      : h('p.muted', { style: { fontSize: '.85rem' } }, 'Nothing has come off yet.'),

    h('button.btn-ghost.btn-sm', {
      onclick: () => navigate('att-staff', { id: person.staff.id }),
    }, `Open ${person.staff.name.split(' ')[0]}’s record`),
  );
}

const MOVEMENT = {
  repayment: 'Deducted',
  skipped: 'Let go',
  adjustment: 'Correction',
  writeoff: 'Written off',
};

const term = (label, value) => h('div.adv-term', h('small.muted', label), h('div', value));

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

/** A movement outside the month-end run: a correction, a lump sum, a write-off. */
async function addMovement(advance, reload) {
  const done = await formDialog({
    title: 'Add a movement',
    submitLabel: 'Add it',
    body: h('div',
      h('div.field-row',
        field('Month', h('input', {
          type: 'month', name: 'month', value: monthOf(todayISO()), required: true,
        })),
        field('What happened', h('select', { name: 'kind' },
          h('option', { value: 'repayment' }, 'Deducted from pay'),
          h('option', { value: 'adjustment' }, 'Paid another way, or a correction'),
          h('option', { value: 'skipped' }, 'Nothing taken this month'),
          h('option', { value: 'writeoff' }, 'Written off')))),
      field('Amount', h('input', { type: 'number', name: 'amount', step: '0.01', value: advance.monthly })),
      field('Note', h('input', { type: 'text', name: 'note', maxlength: 300 }))),
    onSubmit: (form) => api.advanceEntry(advance.id, Object.fromEntries(form.entries())),
  });
  if (!done) return;
  toast('Added.', 'good');
  await reload();
}

// --------------------------------------------------------------------------

const tile = (label, value, sub) => h('div.stat',
  h('div.stat-label', label),
  h('div.stat-value', value),
  h('div.stat-sub', sub));

/** 'August 2026' from '2026-08'. */
export function niceMonth(month) {
  const text = String(month ?? '');
  if (!/^\d{4}-\d{2}$/.test(text)) return text;
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' })
    .format(new Date(`${text}-01T12:00:00Z`));
}
