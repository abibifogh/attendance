import { api } from '../api.js';
import { fileLink } from '../file-view.js';
import { fmtDay, h, money, mount, toast, todayISO } from '../util.js';
import { card, emptyState } from './components.js';
import { field, formDialog } from './att-shared.js';
import { replaceParams } from '../app.js';
import { readXlsx } from '../xlsx-read.js';

/**
 * The medical allowance, and the claims against it.
 *
 * WHAT THE SCREEN IS FOR, IN ORDER. Deciding what is waiting, then seeing how
 * much of the year is gone. Claims first, therefore, and the list of everybody
 * underneath — a screen that opens on a table of balances makes somebody hunt
 * for the thing that is actually asking them a question.
 *
 * WHOEVER DECIDES SEES WHAT IS LEFT. A claim shown on its own is a number to
 * say yes to. Beside the balance it came out of, it is a decision. So every
 * waiting claim carries the person's year with it, and approving for less than
 * was asked is a first-class thing to do rather than a refusal followed by a
 * second conversation.
 *
 * THE BILLS ARE THE CLAIM. Each receipt opens in its own tab, and the total is
 * their sum rather than a figure somebody typed. Nothing here can be approved
 * without the evidence being one press away.
 */

export async function renderAttMedical(params) {
  const host = h('div');
  const year = Number(params.year) || Number(todayISO().slice(0, 4));
  const data = await api.medical(year);
  const cash = (n) => money(n, data.currency);

  const reload = async (next = {}) => {
    const merged = { ...params, year, ...next };
    replaceParams('att-medical', merged);
    mount(host, await renderAttMedical(merged));
  };

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Medical claims'),
        h('div.sub', `What each person is allowed this year, and what they have claimed`),
      ),
      h('div.btn-row',
        h('button.btn-sm', {
          onclick: () => reload({ year: year - 1 }),
          'aria-label': 'The year before',
        }, `‹ ${year - 1}`),
        h('button.btn-sm', {
          onclick: () => reload({ year: year + 1 }),
          'aria-label': 'The year after',
        }, `${year + 1} ›`),
        sheetButton(data, reload),
        h('button.btn-sm.btn-primary', {
          onclick: () => setAllowances(data, reload),
        }, 'Set the year’s allowances')),
    ),

    data.waiting.length ? waitingCard(data, reload, cash) : null,

    h('div.grid.grid-4.med-tiles',
      tile('Allowed this year', cash(data.totals.allowance),
        `${data.totals.qualify} ${data.totals.qualify === 1 ? 'person qualifies' : 'people qualify'}`),
      tile('Claimed and approved', cash(data.totals.spent),
        data.totals.allowance
          ? `${Math.round((data.totals.spent / data.totals.allowance) * 100)}% of the year`
          : 'nothing yet'),
      tile('Still available', cash(data.totals.left), 'across everybody'),
      tile('Waiting on you', String(data.totals.waiting),
        data.totals.waiting ? 'claims to decide' : 'nothing to decide'),
    ),

    data.people.length
      ? card(`Everybody, ${year}`, { wide: true, note: `${data.people.length}` },
        h('div.table-wrap', h('table.med-table',
          h('thead', h('tr',
            h('th', 'Name'),
            h('th.num', 'Available'),
            h('th.num', 'Used'),
            h('th.num', 'Left'),
            h('th', 'How much is gone'),
            h('th.num', 'Claims'),
          )),
          h('tbody', data.people.map((person) => personRows(person, { cash, reload })).flat()))))
      : emptyState('Nobody has a medical allowance for this year',
        'Set the year’s allowances and staff can start claiming against them.'),
  );

  return host;
}

// --------------------------------------------------------------------------
// Deciding
// --------------------------------------------------------------------------

function waitingCard(data, reload, cash) {
  return card('Waiting on a decision', { wide: true, note: `${data.waiting.length}` },
    data.waiting.map((claim) => h('div.med-claim',
      h('div.med-claim-head',
        h('div',
          h('div.adv-who', claim.staffName),
          h('div.muted',
            `${cash(claim.amount)} · ${claim.receipts.length} bill`
            + `${claim.receipts.length === 1 ? '' : 's'} · asked `
            + fmtDay(String(claim.askedAt).slice(0, 10))),
          claim.what ? h('div.adv-reason', claim.what) : null),
        h('div.btn-row',
          h('button.btn-sm.btn-primary', { onclick: () => decide(claim, true, reload, cash) }, 'Approve'),
          h('button.btn-sm', { onclick: () => decide(claim, false, reload, cash) }, 'Turn down'))),

      // The state of their year, so this is a decision rather than a number.
      claim.standing
        ? h('div.med-standing',
          h('span', h('strong', cash(claim.standing.left)), ' left of ',
            cash(claim.standing.opening)),
          claim.standing.ifAllApproved < 0
            ? h('span.pill.warn', 'more waiting than is left')
            : null)
        : h('div.med-standing', h('span.pill.warn', 'no allowance set for this year')),

      receiptList(claim, cash))));
}

/** The bills, each one a press away. */
function receiptList(claim, cash) {
  if (!claim.receipts.length) return null;
  return h('ul.med-receipts', claim.receipts.map((r) => h('li',
    h('div',
      h('strong', cash(r.amount)),
      r.what ? h('span.muted', ` · ${r.what}`) : null,
      r.spentOn ? h('span.muted', ` · ${fmtDay(r.spentOn)}`) : null),
    r.hasFile
      ? fileLink({
        href: api.medicalReceiptUrl(r.id),
        name: `Receipt \u2014 ${r.staffName ?? 'claim'}`,
        className: 'btn-sm',
      }, 'See the bill')
      // Said rather than left blank. A bill with no picture is a decision
      // somebody made, and whoever is approving should know they are taking
      // it on trust.
      : h('span.pill.warn', 'no picture'))));
}

async function decide(claim, approve, reload, cash) {
  if (!approve) {
    const done = await formDialog({
      title: `Turn down ${claim.staffName}’s claim`,
      submitLabel: 'Turn it down',
      body: h('div',
        h('p.muted', { style: { fontSize: '.85rem' } },
          `${cash(claim.amount)} across ${claim.receipts.length} bill`
          + `${claim.receipts.length === 1 ? '' : 's'}. They are told, so a line here is worth `
          + 'more than none.'),
        field('Why', h('input', { type: 'text', name: 'note', maxlength: 300 }))),
      onSubmit: (form) => api.medicalDecide(claim.id, { approve: false, note: form.get('note') }),
    });
    if (!done) return;
    toast('Turned down. They have been told.', 'good');
    await reload();
    return;
  }

  const left = claim.standing?.left ?? 0;
  const over = claim.amount > left;

  const done = await formDialog({
    title: `Approve ${claim.staffName}’s claim`,
    submitLabel: 'Approve it',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        claim.standing
          ? `${cash(left)} is left of their ${cash(claim.standing.opening)} for the year.`
          : 'They have no allowance set for this year, so there is nothing to take it from.'),
      field('Approve how much', h('input', {
        type: 'number', name: 'amount', step: '0.01', min: '0.01',
        max: claim.amount, value: claim.amount, required: true,
      }), `They asked for ${cash(claim.amount)}. Approve less where part of it is not covered.`),
      over
        ? h('label.tickline',
          h('input', { type: 'checkbox', name: 'over' }),
          h('span', `Allow more than the ${cash(left)} left in their allowance`))
        : null,
      field('Anything to add', h('input', { type: 'text', name: 'note', maxlength: 300 }))),
    onSubmit: (form) => api.medicalDecide(claim.id, {
      approve: true,
      amount: form.get('amount'),
      over: form.get('over') === 'on',
      note: form.get('note'),
    }),
  });
  if (!done) return;
  toast(`Approved. ${claim.staffName} has been told.`, 'good');
  await reload();
}

// --------------------------------------------------------------------------
// Everybody
// --------------------------------------------------------------------------

function personRows(person, { cash, reload }) {
  const s = person.standing;
  const share = s && s.opening > 0 ? Math.min(1, s.spent / s.opening) : 0;

  const detail = h('tr.adv-detail', { style: { display: 'none' } },
    h('td', { colspan: 6 },
      person.claims.length
        ? person.claims.map((claim) => h('div.adv-block',
          h('div.adv-block-head',
            h('div',
              h('strong', cash(claim.approved ?? claim.amount)),
              claim.approved != null && claim.approved !== claim.amount
                ? h('span.muted', ` of ${cash(claim.amount)} claimed`)
                : null,
              h('span.pill' + (STATUS_TONE[claim.status] ? `.${STATUS_TONE[claim.status]}` : ''),
                { style: { marginLeft: '.4rem' } }, STATUS[claim.status] ?? claim.status)),
            h('span.muted', fmtDay(String(claim.askedAt).slice(0, 10)))),
          claim.what ? h('div.adv-reason', claim.what) : null,
          claim.decision ? h('div.adv-reason', `“${claim.decision}”`) : null,
          receiptList(claim, cash)))
        : h('p.muted', { style: { fontSize: '.85rem' } }, 'No claims this year.')));

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
  // The opening balance rather than the whole allowance, so the three money
  // columns add up across the row. Where they differ, the year's figure is
  // said underneath rather than left to contradict this one.
  h('td.num', s
    ? h('div',
      cash(s.opening),
      // Where the two differ, the year's own figure sits under it: one of them
      // is what they may spend and the other is what they were given, and a
      // column showing only one of them invites the wrong question.
      s.carriedIn
        ? h('small.muted', s.carriedIn > 0
          ? ` ${cash(s.allowance)} + ${cash(s.carriedIn)} carried forward`
          : ` of ${cash(s.allowance)}`)
        : null)
    : h('span.muted', 'none set')),
  h('td.num', s ? cash(s.spent) : h('span.muted', '—')),
  h('td.num', s ? h('strong', cash(s.left)) : h('span.muted', '—')),
  h('td',
    // A meter rather than a percentage: the question is how much of one
    // allowance is gone, which is a ratio against a limit and reads as a bar
    // faster than it reads as a number.
    s
      ? h('div.med-meter', { title: `${cash(s.spent)} of ${cash(s.opening)}` },
        h('div.med-track', h('div.med-fill', {
          class: share >= 1 ? 'med-fill-out' : share > 0.8 ? 'med-fill-low' : '',
          style: { width: `${Math.round(share * 100)}%` },
        })),
        s.waiting ? h('small.muted', `${cash(s.waiting)} waiting`) : null)
      : h('span.muted', '—')),
  h('td.num', person.claims.length
    ? String(person.claims.length)
    : h('span.muted', '·')));

  return [main, detail];
}

const STATUS = {
  requested: 'waiting', approved: 'approved', rejected: 'turned down', withdrawn: 'taken back',
};
const STATUS_TONE = { approved: 'good', rejected: '', requested: 'warn' };

// --------------------------------------------------------------------------
// Setting the year
// --------------------------------------------------------------------------

/**
 * Who qualifies and what they get, for everybody at once.
 *
 * One form, one button. The starting balance is separate from the allowance
 * because in the first year the property has usually already paid some claims
 * on paper, and an app insisting everybody starts untouched would be wrong
 * about every one of them.
 */
async function setAllowances(data, reload) {
  const state = new Map(data.staff.map((s) => [s.id, {
    qualifies: s.qualifies,
    allowance: s.allowance ?? data.defaultAllowance ?? 0,
    opening: s.opening ?? null,
  }]));

  const everyone = h('input', {
    type: 'number', step: '0.01', min: '0', placeholder: 'e.g. 1000',
    'aria-label': 'The same allowance for everybody ticked',
  });

  const rows = data.staff.map((s) => {
    const mine = state.get(s.id);

    const allowance = h('input.med-amount', {
      type: 'number', step: '0.01', min: '0', value: mine.allowance || '',
      'aria-label': `${s.name}'s allowance`,
      onchange: (e) => { mine.allowance = Number(e.target.value) || 0; },
    });
    const opening = h('input.med-amount', {
      type: 'number', step: '0.01', min: '0', value: mine.opening ?? '',
      placeholder: 'all of it',
      'aria-label': `${s.name}'s starting balance`,
      onchange: (e) => { mine.opening = e.target.value === '' ? null : Number(e.target.value); },
    });

    const tick = h('input', {
      type: 'checkbox', checked: mine.qualifies,
      'aria-label': `${s.name} qualifies`,
      onchange: (e) => {
        mine.qualifies = e.target.checked;
        allowance.disabled = !e.target.checked;
        opening.disabled = !e.target.checked;
        line.classList.toggle('adv-skipped', !e.target.checked);
      },
    });

    allowance.disabled = !mine.qualifies;
    opening.disabled = !mine.qualifies;

    const line = h(`tr${mine.qualifies ? '' : '.adv-skipped'}`,
      h('td', h('label.tickline', tick, h('span', s.name))),
      h('td.muted', s.department || ''),
      h('td.num', allowance),
      h('td.num', opening));
    return line;
  });

  await formDialog({
    title: `Medical allowances for ${data.year}`,
    submitLabel: 'Save them',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        `Tick everybody who qualifies and say what their allowance for ${data.year} is. The `
        + 'starting balance is that allowance plus anything carried forward from the previous '
        + 'period. Leave it blank where there is nothing to carry, and fill it in where there '
        + 'is, or where part of the year has already been claimed on paper.'),

      h('div.med-everyone',
        field('Give everybody ticked the same', everyone),
        h('button.btn-sm', {
          type: 'button',
          onclick: () => {
            const value = Number(everyone.value) || 0;
            if (!value) return;
            for (const [staffId, mine] of state.entries()) {
              if (!mine.qualifies) continue;
              mine.allowance = value;
              const input = rows[data.staff.findIndex((s) => s.id === staffId)]
                ?.querySelector('.med-amount');
              if (input) input.value = value;
            }
          },
        }, 'Apply to everybody ticked')),

      h('div.table-wrap.med-set-wrap', h('table.med-set',
        h('thead', h('tr',
          h('th', 'Qualifies'), h('th', ''),
          h('th.num', `${data.year} allowance`), h('th.num', 'Starting balance'),
        )),
        h('tbody', rows)))),
    onSubmit: async () => {
      const out = [...state.entries()].map(([staffId, v]) => ({
        staffId,
        qualifies: v.qualifies,
        allowance: v.allowance,
        opening: v.opening,
      }));
      return api.medicalSetAllowances({ year: data.year, rows: out });
    },
  }).then(async (done) => {
    if (!done) return;
    toast(`Saved. ${done.set} ${done.set === 1 ? 'person' : 'people'} on the list for ${data.year}.`, 'good');
    await reload();
  });
}

// --------------------------------------------------------------------------
// From the office's sheet
// --------------------------------------------------------------------------

/** The button, and the file picker behind it. */
function sheetButton(data, reload) {
  const picker = h('input', {
    type: 'file',
    accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    style: { display: 'none' },
    onchange: async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      try {
        const sheets = await readXlsx(await file.arrayBuffer());
        // The sheet named for the year, where there is one, else the first.
        const sheet = sheets.find((s) => s.name.trim() === String(data.year)) ?? sheets[0];
        if (!sheet) throw new Error('There is nothing in that file.');
        const read = await api.medicalSheetCheck({ year: data.year, rows: sheet.rows });
        await showSheet(read, sheet.name, reload);
      } catch (err) {
        toast(err.message, 'bad');
      }
    },
  });
  return h('span', picker, h('button.btn-sm', {
    title: 'Read the office’s medical sheet and match it to people in HIVE. Nothing is saved '
      + 'until you say so.',
    onclick: () => picker.click(),
  }, 'From a sheet'));
}

const MATCH = {
  same: ['Same name', 'good'],
  close: ['Close match', 'good'],
  check: ['Check', 'warn'],
  none: ['Not found', 'bad'],
};

/** What the sheet says, who each name is, and the button that brings it in. */
async function showSheet(read, sheetName, reload) {
  const cash = (n) => money(n, read.currency);
  // Figures in the table without the currency on each, so all seven columns
  // fit; the headings say what it is in.
  const fig = (n) => Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const byId = new Map(read.staff.map((s) => [s.id, s]));
  const chosen = read.people.map((p) => ({
    ...p,
    staffId: p.match.staffId,
    allowance: p.allowance ?? read.defaultAllowance ?? 0,
  }));

  const counts = h('span.muted.pay-set-count');
  const warnings = h('div');
  const recount = () => {
    const matched = chosen.filter((p) => p.staffId).length;
    counts.textContent = `${chosen.length} on the sheet · ${matched} matched · `
      + `${chosen.length - matched} left out`;
    const twice = new Map();
    for (const p of chosen) if (p.staffId) twice.set(p.staffId, (twice.get(p.staffId) ?? 0) + 1);
    const doubled = [...twice.entries()].filter(([, n]) => n > 1).map(([id]) => byId.get(id)?.name);
    mount(warnings, doubled.length
      ? h('div.alert.warn', `${doubled.join(', ')} ${doubled.length === 1 ? 'is' : 'are'} matched to `
        + 'two rows of the sheet. Pick the right row for each.')
      : null);
  };

  // Everybody in HIVE, the people who have left at the end and marked, so a
  // name on a sheet kept since January can still be matched to them.
  const options = [...read.staff].sort((a, b) => Number(b.active) - Number(a.active)
    || a.name.localeCompare(b.name));

  const already = (staffId) => {
    const held = staffId ? read.held[staffId] : null;
    if (!held) return h('span.muted', staffId ? 'nothing yet' : '');
    const bits = [];
    if (held.opening != null) bits.push(`starts on ${cash(held.opening)}`);
    if (held.claims) bits.push(`${held.claims} claim${held.claims === 1 ? '' : 's'} made in HIVE (${cash(held.approved + held.waiting)})`);
    if (held.fromSheet) bits.push('brought in before');
    // Claims made in HIVE stay put. If the same bill is on the sheet it would
    // be counted twice, and only the office can tell.
    return h(held.claims ? 'span.med-sheet-warn' : 'span.muted', bits.join(' · ') || 'nothing yet');
  };

  const rows = chosen.map((p) => {
    const [label, tone] = MATCH[p.match.level];
    const pill = h(`span.pill.${tone}`, label);
    const held = h('td.med-sheet-held', already(p.staffId));
    const pickOne = h('select', {
      'aria-label': `Who ${p.name} is in HIVE`,
      onchange: (e) => {
        p.staffId = Number(e.target.value) || null;
        mount(held, already(p.staffId));
        line.classList.toggle('adv-skipped', !p.staffId);
        recount();
      },
    },
    h('option', { value: '' }, 'Leave out'),
    // The likely ones first, where HIVE had to guess.
    p.match.level === 'check' && p.match.candidates.length
      ? h('optgroup', { label: 'Could be' }, p.match.candidates.map((c) => h('option', { value: c.id },
        `${c.name}${c.active ? '' : ' (left)'}`)))
      : null,
    h('optgroup', { label: 'Everybody in HIVE' }, options.map((s) => h('option', {
      value: s.id, selected: s.id === p.staffId,
    }, `${s.name}${s.active ? '' : ' (left)'}`))));

    const left = round2(p.allowance + p.broughtForward - p.claimed);
    const line = h(`tr${p.staffId ? '' : '.adv-skipped'}`,
      h('td', h('strong', p.name), p.notes.length ? h('div.muted.med-sheet-note', p.notes.join(' ')) : null),
      h('td', h('div.med-sheet-who', pickOne, pill)),
      h('td.num', fig(p.broughtForward)),
      h('td.num', fig(p.allowance + p.broughtForward)),
      h('td.num', fig(p.claimed)),
      h(`td.num${left < 0 ? '.med-sheet-over' : ''}`, fig(left)),
      held);
    return line;
  });
  recount();

  const balance = h('input', { type: 'radio', name: 'med-sheet-mode', value: 'balance', checked: true });
  const history = h('input', { type: 'radio', name: 'med-sheet-mode', value: 'history' });

  const over = chosen.filter((p) => p.allowance + p.broughtForward - p.claimed < 0);
  const skipped = read.left.map((l) => `row ${l.row}, ${l.why}${l.figures.length ? ` (${l.figures.join(', ')})` : ''}`);

  const done = await formDialog({
    title: `Medical allowances for ${read.year}, from a sheet`,
    submitLabel: 'Bring them in',
    wide: 'xl',
    help: h('dl.pay-set-help',
      h('dt', 'Matching'),
      h('dd', 'Every name is looked for among everybody in HIVE, including people who have '
        + 'left. Same name and Close match are chosen for you. Check means HIVE found only a '
        + 'first name, or two people equally close, so pick the right one. Anybody left out '
        + 'is not touched.'),
      h('dt', 'Left today'),
      h('dd', 'What the year was worth, plus what they brought forward, less what they have '
        + 'claimed on the sheet. In red where they claimed more than they had.'),
      h('dt', 'Already in HIVE'),
      h('dd', 'What HIVE holds for them this year. A claim made in HIVE is kept as it is. If '
        + 'the same bill is also on the sheet it will be counted twice, so check those.'),
      h('dt', 'Starting point'),
      h('dd', 'What is left today starts them on the sheet’s balance, and HIVE takes it '
        + 'from there. Nobody can start below nothing, so somebody who went over starts on '
        + 'nothing and the note says by how much. Brought forward and each month writes '
        + 'every month’s paper claims into HIVE as approved claims, so they can see their '
        + 'whole year. Bringing the sheet in again replaces what it wrote before.')),
    body: h('div',
      String(sheetName).trim() && String(sheetName).trim() !== String(read.year)
        && /^\d{4}$/.test(String(sheetName).trim())
        ? h('div.alert.warn', `This sheet is called ${sheetName}, and it is going into ${read.year}.`)
        : null,
      h('div.pay-set-bar', counts),
      warnings,
      h('div.med-sheet-mode',
        h('label.tickline', balance, h('span', 'Start from what is left today')),
        h('label.tickline', history, h('span', 'Start from what they brought forward, and record each month’s paper claims'))),
      h('div.table-wrap.med-set-wrap.pay-set-wrap', h('table.med-set.pay-set.med-sheet',
        h('thead', h('tr',
          h('th', 'On the sheet'), h('th', 'In HIVE'),
          h('th.num', `B/F (${read.currency})`), h('th.num', `${read.year} total`),
          h('th.num', 'Claimed'), h('th.num', 'Left today'), h('th', 'Already in HIVE'))),
        h('tbody', rows))),
      over.length
        ? h('p.muted.med-sheet-foot', `Claimed more than they had: ${over.map((p) => `${p.name} `
          + `(${cash(round2(p.allowance + p.broughtForward - p.claimed))})`).join(', ')}.`)
        : null,
      skipped.length
        ? h('p.muted.med-sheet-foot', `Not brought in from the sheet: ${skipped.join('; ')}.`)
        : null),
    onSubmit: async () => {
      const picked = chosen.filter((p) => p.staffId);
      if (!picked.length) throw new Error('Nobody is matched. Pick who each name is first.');
      return api.medicalSheetImport({
        year: read.year,
        mode: history.checked ? 'history' : 'balance',
        rows: picked.map((p) => ({
          staffId: p.staffId,
          allowance: p.allowance,
          broughtForward: p.broughtForward,
          months: p.months,
        })),
      });
    },
  });
  if (!done) return;
  toast(`Brought in ${done.people} ${done.people === 1 ? 'person' : 'people'} for ${done.year}`
    + (done.claims ? `, with ${done.claims} paper claims.` : '.'), 'good');
  await reload();
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const tile = (label, value, sub) => h('div.stat',
  h('div.stat-label', label),
  h('div.stat-value', value),
  h('div.stat-sub', sub));
