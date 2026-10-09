import { h, mount, money, num, dayRange } from '../util.js';
import { api } from '../api.js';
import { table, banner } from './components.js';

/**
 * The Money page's three cards from what the shifts know: how the spending
 * was paid, what to chase, and the revenue read from the ASSD journal.
 */

const dayText = (day) => (day ? new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
const FROM = { drawer: 'Drawer', safe: 'Safe' };
const PAID = [
  ['drawer', 'From the drawer', 'var(--series-1)'],
  ['safe', 'From the safe', 'var(--series-3)'],
  ['other', 'By bank or on credit', 'var(--series-2)'],
];

/** Shifts → To-do, from anywhere. */
function openTodo() {
  try { sessionStorage.setItem('insight-shifts-section', 'todo'); } catch { /* private mode */ }
  window.location.hash = '#/shifts';
}

function paidBar(split) {
  const whole = PAID.reduce((t, [k]) => t + Math.max(0, split[k] || 0), 0);
  if (!whole) return h('p.muted', 'Nothing spent in these days that Insight can see.');
  return h('div.mc-paid',
    h('div.mc-bar', { role: 'img', 'aria-label': PAID.map(([k, label]) => `${label} ${money(split[k])}`).join(', ') },
      PAID.filter(([k]) => split[k] > 0).map(([k, label, c]) => h('b', {
        style: `flex:${split[k]} 1 0;background:${c}`, title: `${label}: ${money(split[k])} (${Math.round((split[k] / whole) * 100)}%)`,
      }))),
    h('div.mc-legend', PAID.map(([k, label, c]) => h('span',
      h('i', { style: `background:${c}` }), label, h('b.num', money(split[k] || 0)),
      h('small', whole ? `${Math.round(((split[k] || 0) / whole) * 100)}%` : '')))));
}

async function paidCard(range, onData) {
  const card = h('div.card.mc-card', h('h2', 'How the spending was paid'), h('p.muted', 'Reading…'));
  const draw = async (notice = null) => {
    let d;
    try { d = await api(`/money/cash?from=${range.from}&to=${range.to}`); } catch (err) { mount(card, h('h2', 'How the spending was paid'), banner('problem', err.message)); return; }
    const said = h('span.small');
    const check = h('button.btn', {
      type: 'button',
      onclick: async () => {
        check.disabled = true; said.textContent = 'Asking Odoo…';
        try {
          const r = await api('/money/cash/refresh', { method: 'POST' });
          await draw(banner('good', `Checked ${r.pos} cash PO${r.pos === 1 ? '' : 's'} with Odoo: ${r.billed} billed, ${r.unbilled} not yet.`));
        } catch (err) { said.textContent = err.message; said.className = 'small form-error'; check.disabled = false; }
      },
    }, 'Check Odoo now');
    const s = d.split;
    mount(card,
      notice,
      h('div.mc-head',
        h('div', h('h2', 'How the spending was paid'),
          h('p.sub', `${dayRange(range.from, range.to)}. Odoo’s bills by their date, and cash paid against a PO on the day it left the drawer or the safe.`)),
        h('div.mc-check', check, h('small.muted', d.checkedAt ? `Last checked ${dayText(d.checkedAt.slice(0, 10))} ${d.checkedAt.slice(11, 16)}` : 'Not checked with Odoo yet'), said)),
      paidBar(s),
      s.unbilled ? h('p.small', `${money(s.unbilled)} of it was paid in cash against a PO Odoo has no bill for yet. It is counted in Purchases above, on the day the cash left, until the bill is posted.`) : null,
      h('h3.mc-sub', 'By supplier'),
      table([
        { label: 'Supplier', get: (r) => r.supplier },
        { label: 'Drawer', num: true, get: (r) => (r.drawer ? money(r.drawer) : '–') },
        { label: 'Safe', num: true, get: (r) => (r.safe ? money(r.safe) : '–') },
        { label: 'Bank or credit', num: true, get: (r) => (r.other ? money(r.other) : '–') },
        { label: 'Total', num: true, get: (r) => money(r.total) },
        { label: 'No bill yet', num: true, get: (r) => (r.unbilled ? h('span.mc-warn', money(r.unbilled)) : '') },
      ], d.suppliers),
      d.lines.length ? [h('h3.mc-sub', 'By part of the business'),
        table([
          { label: 'Part of the business', get: (r) => r.label },
          { label: 'Billed in Odoo', num: true, get: (r) => money(r.billed) },
          { label: 'Cash, no bill yet', num: true, get: (r) => (r.unbilled ? money(r.unbilled) : '–') },
          { label: 'Total', num: true, get: (r) => money(r.total) },
        ], d.lines)] : null);
    // The chase card is drawn from the same reading.
    onData(d);
  };
  await draw();
  return card;
}

function chaseCard(d) {
  const t = d.todo;
  const list = (rows, line) => (rows.length ? h('ul.mc-list', rows.slice(0, 8).map((r) => h('li', line(r))),
    rows.length > 8 ? h('li.muted', `and ${rows.length - 8} more`) : null) : h('p.small.muted', 'None.'));
  return h('div.card.mc-card',
    h('div.mc-head',
      h('div', h('h2', 'To chase'),
        h('p.sub', 'From these days. Each is on the to-do list under Shifts, given to a supervisor; their answers come to you.')),
      h('div.mc-check',
        h('button.btn.primary', { type: 'button', onclick: openTodo }, 'Open the to-do list'),
        h('small.muted', `${t.open} open · ${t.answered} waiting for you${t.unassigned ? ` · ${t.unassigned} with nobody` : ''}`))),
    h('div.mc-chase',
      h('section',
        h('h3', 'Paid in cash, no posted bill', h('b.num', money(d.unbilled.reduce((a, r) => a + r.paid, 0)))),
        list(d.unbilled, (r) => [h('b', r.po), ` ${r.vendor || ''} · ${money(r.paid)} from the ${r.paidFrom} on ${dayText(r.paidDay)}${r.draft ? ' · draft bill' : ''}`])),
      h('section',
        h('h3', 'Paid is not what the PO says', h('b.num', String(d.differs.length))),
        list(d.differs, (r) => [h('b', r.po), ` paid ${money(r.paid)}, PO ${money(r.poTotal)} · ${FROM[r.paidFrom] || r.paidFrom}, ${dayText(r.paidDay)}`])),
      h('section',
        h('h3', 'Bills with no PO', h('b.num', money(d.noPo.reduce((a, r) => a + r.total, 0)))),
        list(d.noPo, (r) => [h('b', r.supplier || 'A supplier'), ` ${money(r.total)} · ${dayText(r.day)}`]))),
    d.notInOdoo.length ? banner('warning', `${d.notInOdoo.length} PO${d.notInOdoo.length === 1 ? '' : 's'} paid in cash ${d.notInOdoo.length === 1 ? 'is' : 'are'} not in Odoo at all: `,
      d.notInOdoo.map((r) => `${r.po} (${FROM[r.paidFrom] || r.paidFrom}, ${dayText(r.paidDay)})`).join(', '), '. A typing mistake, or a PO deleted in Odoo.') : null);
}

async function revenueCard(range) {
  const card = h('div.card.mc-card', h('h2', 'Revenue from the ASSD journal'), h('p.muted', 'Reading…'));
  const draw = async (notice = null) => {
    let d;
    try { d = await api(`/money/articles?from=${range.from}&to=${range.to}`); } catch (err) { mount(card, h('h2', 'Revenue from the ASSD journal'), banner('problem', err.message)); return; }
    const said = h('span.small');
    const choice = (a) => h('select', {
      'aria-label': `What ${a.name || a.code} is`,
      onchange: async (e) => {
        said.textContent = 'Saving, and reading the journal again…'; said.className = 'small';
        try {
          await api('/money/articles', { method: 'POST', body: { code: a.code, line: e.target.value } });
          await draw(banner('good', `Article ${a.code} saved. The revenue above changes when the page is opened again.`));
        } catch (err) { said.textContent = err.message; said.className = 'small form-error'; }
      },
    },
    a.line === null ? h('option', { value: '', selected: true }, 'Not decided: not counted') : null,
    d.lines.map((l) => h('option', { value: l.id, selected: a.line === l.id }, `Revenue of ${l.label}`)),
    h('option', { value: 'elsewhere', selected: a.line === 'elsewhere' }, 'Counted by another system'),
    h('option', { value: 'none', selected: a.line === 'none' }, 'Not revenue (a deposit, a tax)'));
    const seen = d.articles.filter((a) => a.charges || a.line === null);
    mount(card,
      notice,
      h('h2', 'Revenue from the ASSD journal'),
      h('p.sub', `${dayRange(range.from, range.to)}. What each reservation was charged, on the day it was charged for. Nights (articles 100 to 289) are always the rooms; say once what every other article is.`),
      h('div.mc-nights',
        h('div', h('small', 'Rooms, from the nights'), h('b.num', money(d.nights.amount))),
        h('div', h('small', 'Room-nights'), h('b.num', num(d.nights.count))),
        d.undecided.count ? h('div.mc-warn', h('small', `${d.undecided.count} article${d.undecided.count === 1 ? '' : 's'} not decided`), h('b.num', money(d.undecided.amount))) : null),
      d.undecided.count ? banner('warning', `${money(d.undecided.amount)} charged on articles nobody has placed yet is not counted anywhere. Choose what each one is below.`) : null,
      seen.length ? table([
        { label: 'Article', get: (a) => a.code },
        { label: 'Name in ASSD', get: (a) => a.name || '–' },
        { label: 'Charged in these days', num: true, get: (a) => money(a.amount) },
        { label: 'Counts as', get: (a) => choice(a) },
      ], seen) : h('p.small.muted', 'No other articles charged in these days.'),
      said);
  };
  await draw();
  return card;
}

/** The three cards, filled in as each reading comes back. */
export function moneyFromShifts(range) {
  const paid = h('div');
  const chase = h('div');
  const takings = h('div');
  paidCard(range, (d) => mount(chase, chaseCard(d))).then((card) => mount(paid, card)).catch((err) => mount(paid, banner('problem', err.message)));
  revenueCard(range).then((card) => mount(takings, card)).catch((err) => mount(takings, banner('problem', err.message)));
  return h('div.mc', paid, chase, takings);
}
