import { api } from '../api.js';
import { fmtDay, h, money, mount, toast, todayISO } from '../util.js';
import { card, emptyState } from './components.js';
import { field, formDialog } from './att-shared.js';
import { replaceParams } from '../app.js';

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
      ? h('a.btn-sm', {
        href: api.medicalReceiptUrl(r.id),
        target: '_blank',
        rel: 'noopener',
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
      s.carriedIn ? h('small.muted', ` of ${cash(s.allowance)}`) : null)
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
        'Tick everybody who qualifies this year and say what they get. Leave the starting '
        + 'balance blank unless they had already claimed something before the app was keeping '
        + 'the record — then put what was actually left.'),

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
          h('th', 'Qualifies'), h('th', ''), h('th.num', 'Allowance'), h('th.num', 'Starting balance'),
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

const tile = (label, value, sub) => h('div.stat',
  h('div.stat-label', label),
  h('div.stat-value', value),
  h('div.stat-sub', sub));
