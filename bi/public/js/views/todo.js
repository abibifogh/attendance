import { h, mount, money } from '../util.js';
import { api } from '../api.js';
import { banner } from './components.js';

/**
 * The money to-do list, under Shifts.
 *
 * Cash POs Odoo has no bill for, payments that are not what their PO says,
 * and POs Odoo has no posted bill for however they were paid. Each is given to a supervisor; a supervisor sees their
 * own, an admin sees everybody's and decides the answers.
 *
 * Laid out like an inbox: a short list to scan on the left, everything about
 * the one picked on the right. The list can be grouped by supplier, by
 * supervisor, by shift or by how long the item has waited, each group folded
 * to one line until it is opened.
 */

const dayText = (day) => (day ? new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
const FROM = { drawer: 'the drawer', safe: 'the safe' };
const fail = (said) => (err) => { said.textContent = err.message; said.className = 'small form-error'; };
const KINDS = [['all', 'All'], ['unbilled', 'No posted bill'], ['differs', 'Paid ≠ PO']];
const GROUPS = [['none', 'None'], ['supplier', 'Supplier'], ['supervisor', 'Supervisor'], ['shift', 'Shift'], ['age', 'Waiting']];
const SLOT_NAME = { morning: 'morning', afternoon: 'afternoon', night: 'night' };

/** The day the item counts from: the cash leaving, or the bill's date. */
const dayOf = (t) => t.detail?.paidDay || t.detail?.orderedOn || t.detail?.day || t.day || String(t.openedAt || '').slice(0, 10);
const ageOf = (t, today) => {
  const day = dayOf(t);
  if (!day) return 0;
  return Math.max(0, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86_400_000));
};
const ageTone = (days) => (days >= 21 ? 'old' : days >= 14 ? 'aging' : '');
const AGE_BANDS = [[21, 'Over 3 weeks'], [14, '2 to 3 weeks'], [7, '1 to 2 weeks'], [0, 'Under a week']];
const supplierOf = (t) => (t.kind === 'nopo' ? t.detail?.supplier : t.detail?.vendor) || 'No supplier named';
/** The shift a cash PO came from, read from where it was written. */
function shiftOf(t) {
  const m = /(\d{4}-\d{2}-\d{2}) (morning|afternoon|night)/.exec(t.detail?.source || '');
  if (m) return { key: `${m[1]}|${m[2]}`, label: `${dayText(m[1])}, ${SLOT_NAME[m[2]]}` };
  if (t.detail?.paidFrom === 'safe') return { key: `safe|${t.detail.paidDay}`, label: `The safe, ${dayText(t.detail.paidDay)}` };
  return { key: 'nocash', label: 'Not paid from the drawer or the safe' };
}

function what(t) {
  const d = t.detail || {};
  if (t.kind === 'unbilled' && !d.paidFrom) {
    return [
      h('p', `${d.po} from ${d.vendor || 'a supplier'}, ordered ${dayText(d.orderedOn)} for ${money(d.poTotal)}, is confirmed in Odoo `
        + (d.drafts?.length ? `with a draft bill (${d.drafts.join(', ')}) that is not posted yet.` : 'with no bill.')),
      h('p.small.muted', d.drafts?.length
        ? 'Get the bill checked and posted in Odoo. This item closes by itself once it is posted.'
        : 'Get the supplier’s bill entered against this PO in Odoo (Create Bill on the PO) and posted. This item closes by itself once it is.'),
    ];
  }
  if (t.kind === 'unbilled') {
    return [
      h('p', `${money(d.paid)} paid from ${FROM[d.paidFrom] || d.paidFrom} on ${dayText(d.paidDay)}${d.source ? ` (${d.source})` : ''}. `
        + (d.drafts?.length ? `Odoo has a draft bill (${d.drafts.join(', ')}) that is not posted yet.` : 'Odoo has no bill for it yet.')),
      h('p.small.muted', d.drafts?.length
        ? 'Get the bill checked and posted in Odoo. This item closes by itself once it is posted.'
        : 'Get the bill entered and posted in Odoo against this PO. This item closes by itself once it is posted.'),
    ];
  }
  if (t.kind === 'differs') {
    const gap = d.paid - d.poTotal;
    return [
      h('p', `${money(d.paid)} left ${FROM[d.paidFrom] || d.paidFrom} on ${dayText(d.paidDay)}; the PO says ${money(d.poTotal)}: ${money(Math.abs(gap))} ${gap > 0 ? 'more' : 'less'} than the PO.`),
      h('p.small.muted', 'Have the PO corrected in Odoo. This item closes by itself once the two agree.'),
    ];
  }
  return [
    h('p', `A bill from ${d.supplier || 'a supplier'}${d.ref ? ` (their number ${d.ref})` : ''}, dated ${dayText(d.day)}, for ${money(d.total)}, with no PO behind it.`),
    h('p.small.muted', 'Have the bill linked to its PO in Odoo. This item closes by itself once it is.'),
  ];
}

export async function todoPanel(v, { admin, onChange = () => {} }) {
  // What the person has chosen, kept across every repaint and re-read.
  const view = { closed: false, who: 'all', kind: 'all', group: 'none', find: '', current: null };
  const picked = new Set();
  const openGroups = new Set();
  let d = null;

  async function load(notice = null) {
    mount(v, h('p.muted', 'Reading the to-do list…'));
    try {
      d = await api(`/todo${view.closed ? '?closed=1' : ''}`);
    } catch (err) { mount(v, banner('problem', err.message)); return; }
    draw(notice);
  }
  const re = async (message) => { onChange(); await load(message ? banner('good', message) : null); };

  function draw(notice = null) {
    // Ticking or opening something repaints; keep the list where it was scrolled to.
    const scrolled = v.querySelector('.td-list')?.scrollTop || 0;
    const today = new Date().toISOString().slice(0, 10);
    const byWho = d.items.filter((t) => view.who === 'all' || (view.who === 'none' ? !t.assignee : view.who === 'waiting' ? t.state === 'answered' : String(t.assignee?.id) === view.who));
    const counts = Object.fromEntries(KINDS.map(([k]) => [k, k === 'all' ? byWho.length : byWho.filter((t) => t.kind === k).length]));
    const needle = view.find.trim().toLowerCase();
    const items = byWho
      .filter((t) => view.kind === 'all' || t.kind === view.kind)
      .filter((t) => !needle || `${t.ref} ${supplierOf(t)} ${t.assignee?.name || ''}`.toLowerCase().includes(needle))
      .map((t) => ({ ...t, age: ageOf(t, today) }))
      .sort((a, b) => (a.state === 'answered') !== (b.state === 'answered') ? (a.state === 'answered' ? -1 : 1) : b.age - a.age);
    const shown = new Set(items.filter((t) => t.state !== 'closed').map((t) => t.id));
    for (const id of [...picked]) if (!shown.has(id)) picked.delete(id);
    if (!items.some((t) => t.id === view.current)) view.current = items[0]?.id ?? null;
    const current = items.find((t) => t.id === view.current) || null;

    // ---------------------------------------------------------- groups --
    const groupOf = (t) => {
      if (view.group === 'supplier') { const s = supplierOf(t); return { key: s.toLowerCase(), label: s }; }
      if (view.group === 'supervisor') return { key: String(t.assignee?.id ?? 'none'), label: t.assignee?.name || 'Nobody yet' };
      if (view.group === 'shift') return shiftOf(t);
      if (view.group === 'age') { const [min, label] = AGE_BANDS.find(([m]) => t.age >= m); return { key: `age${min}`, label, order: -min }; }
      return null;
    };
    const groups = [];
    if (view.group !== 'none') {
      const map = new Map();
      for (const t of items) {
        const g = groupOf(t);
        if (!map.has(g.key)) { map.set(g.key, { ...g, items: [] }); groups.push(map.get(g.key)); }
        map.get(g.key).items.push(t);
      }
      if (view.group === 'age') groups.sort((a, b) => a.order - b.order);
      else if (view.group === 'shift') groups.sort((a, b) => b.key.localeCompare(a.key));
      else groups.sort((a, b) => Math.max(...b.items.map((t) => t.age)) - Math.max(...a.items.map((t) => t.age)));
      // The group holding the item on the right is open, so it can be seen.
      const holding = current ? groupOf(current).key : null;
      if (holding) openGroups.add(`${view.group}:${holding}`);
    }

    // ------------------------------------------------------------ rows --
    const tickBox = (ids, label) => {
      const live = ids.filter((id) => shown.has(id));
      if (!admin || !live.length) return h('span');
      return h('input', {
        type: 'checkbox', 'aria-label': label,
        checked: live.every((id) => picked.has(id)),
        onclick: (e) => e.stopPropagation(),
        onchange: (e) => { for (const id of live) { if (e.target.checked) picked.add(id); else picked.delete(id); } draw(); },
      });
    };
    const row = (t) => h(`div.td-row${t.id === view.current ? '.on' : ''}${t.state === 'answered' ? '.waiting' : ''}`, {
      role: 'button', tabindex: '0', 'aria-label': `${t.kindLabel} ${t.ref}`,
      onclick: () => { view.current = t.id; draw(); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); view.current = t.id; draw(); } },
    },
    admin ? tickBox([t.id], `Select ${t.ref}`) : null,
    h('span.td-main', h('b', t.kind === 'nopo' ? 'Bill' : t.ref), ` · ${supplierOf(t)}`),
    h('span.td-amt.num', money(t.kind === 'differs' ? Math.abs(t.amount) : t.amount)),
    h('span.td-sub', [
      t.state === 'answered' ? '⏳ waiting for an admin' : { unbilled: t.detail?.drafts?.length ? 'draft bill' : 'no bill', differs: 'paid ≠ PO', nopo: 'no PO' }[t.kind],
      t.detail?.paidFrom ? (t.detail.paidFrom === 'safe' ? 'safe' : 'drawer') : (t.kind === 'unbilled' ? 'ordered' : null),
      admin ? (t.assignee?.name || 'nobody') : null,
    ].filter(Boolean).join(' · ')),
    h(`span.td-age.${ageTone(t.age)}`, `${t.age} d`));

    const list = h(`div.td-list${admin ? '' : '.nobox'}`);
    if (!items.length) mount(list, h('p.muted.td-empty', view.closed ? 'Nothing closed here.' : 'Nothing to do.'));
    else if (view.group === 'none') mount(list, items.map(row));
    else {
      mount(list, groups.map((g) => {
        const id = `${view.group}:${g.key}`;
        const open = openGroups.has(id);
        const total = g.items.reduce((a, t) => a + Math.abs(t.amount || 0), 0);
        const oldest = Math.max(...g.items.map((t) => t.age));
        return h('div.td-group',
          h(`div.td-ghead${open ? '.open' : ''}`, {
            role: 'button', tabindex: '0', 'aria-expanded': String(open),
            onclick: () => { if (open) openGroups.delete(id); else openGroups.add(id); draw(); },
            onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (open) openGroups.delete(id); else openGroups.add(id); draw(); } },
          },
          admin ? tickBox(g.items.map((t) => t.id), `Select all of ${g.label}`) : null,
          h('span.td-caret', open ? '▾' : '▸'),
          h('span.td-main', h('b', g.label), ` · ${g.items.length}`),
          h('span.td-amt.num', money(total)),
          h(`span.td-age.${ageTone(oldest)}`, `oldest ${oldest} d`)),
          open ? g.items.map(row) : null);
      }));
    }

    // ------------------------------------------------- give many at once --
    const bulk = (() => {
      if (!admin || view.closed || !shown.size || !d.supervisors.length) return null;
      const to = h('select', { 'aria-label': 'Give to' }, h('option', { value: '' }, 'Give to…'),
        d.supervisors.map((s) => h('option', { value: String(s.id) }, s.name)));
      const said = h('span.small');
      return h(`div.td-bulk${picked.size ? '.on' : ''}`,
        h('label.small', tickBox([...shown], 'Select every item shown'), ' All shown'),
        h('span.small', h('b', String(picked.size)), ' selected'),
        to,
        h('button.btn.primary', {
          type: 'button', disabled: !picked.size,
          onclick: async () => {
            if (!to.value) { said.textContent = 'Choose who to give them to.'; return; }
            said.textContent = 'Giving…';
            try {
              const out = await api('/todo/assign', { method: 'POST', body: { ids: [...picked], accountId: Number(to.value) } });
              picked.clear();
              await re(`${out.moved} item${out.moved === 1 ? '' : 's'} given to ${out.to}.`);
            } catch (err) { fail(said)(err); }
          },
        }, 'Give'),
        said);
    })();

    // ---------------------------------------------------------- detail --
    const detail = (() => {
      if (!current) return h('div.card.td-detail', h('p.muted', items.length ? 'Pick an item on the left.' : 'Nothing here.'));
      const t = current;
      const said = h('span.small');
      const back = h('input', { type: 'text', maxlength: '400', placeholder: 'Why it goes back', 'aria-label': 'Why it goes back' });
      const reason = h('input', { type: 'text', maxlength: '400', placeholder: 'Why nothing is needed', 'aria-label': 'Why nothing is needed' });
      const at = items.findIndex((x) => x.id === t.id);
      const step = (n) => { const next = items[at + n]; if (next) { view.current = next.id; draw(); } };
      const fact = (label, value, cls = '') => h('div', h('small', label), h(`span${cls}`, value));
      const d2 = t.detail || {};
      return h('div.card.td-detail',
        h('div.td-dhead',
          h('div',
            h('small.td-kind', t.kindLabel),
            h('h2', t.kind === 'nopo' ? `Bill · ${d2.supplier || ''}` : `${t.ref} · ${supplierOf(t)}`)),
          h('b.td-big.num', money(t.kind === 'differs' ? Math.abs(t.amount) : t.amount))),
        h('div.td-facts',
          t.kind === 'nopo'
            ? [fact('Bill dated', dayText(d2.day)), fact('Their number', d2.ref || '–')]
            : d2.paidFrom
              ? [fact('Paid from', FROM[d2.paidFrom] || d2.paidFrom), fact('On', dayText(d2.paidDay))]
              : [fact('Ordered', dayText(d2.orderedOn)), fact('Paid', 'not from the drawer or safe')],
          fact('Waiting', `${t.age} days`, `.td-age.${ageTone(t.age)}`),
          fact('With', t.assignee?.name || 'Nobody yet')),
        what(t),
        t.sentBack ? h('p.small.form-error', `Sent back by an admin: ${t.sentBack}`) : null,
        t.answer && t.state !== 'answered' ? h('p.small', `${t.kind === 'unbilled' ? 'Latest note' : 'Answer'}: ${t.answer} (${t.answeredBy})`) : null,
        t.state === 'answered' ? h('div.sh-waiting',
          h('span', `⏳ Waiting for an admin: ${t.answer} (${t.answeredBy})`),
          admin ? [
            h('button.btn.primary', { type: 'button', onclick: async () => { try { await api(`/todo/${t.id}/decide`, { method: 'POST', body: { approve: true } }); await re('Approved and closed.'); } catch (err) { fail(said)(err); } } }, 'Approve'),
            back,
            h('button.btn', { type: 'button', onclick: async () => { try { await api(`/todo/${t.id}/decide`, { method: 'POST', body: { approve: false, note: back.value } }); await re('Sent back.'); } catch (err) { fail(said)(err); } } }, 'Send back'),
          ] : null) : null,
        t.state === 'closed'
          ? h('div.sh-done', h('span', `✓ ${t.closedWhy || 'Closed'}${t.closedBy && t.closedBy !== 'Insight' ? ` (${t.closedBy})` : ''}`))
          : null,
        admin && t.state !== 'closed' ? h('div.td-admin',
          h('label.small', 'With ', h('select', {
            onchange: async (e) => { try { await api(`/todo/${t.id}/assign`, { method: 'POST', body: { accountId: Number(e.target.value) } }); await re('Given to somebody else.'); } catch (err) { fail(said)(err); } },
          }, !t.assignee ? h('option', { value: '', selected: true }, 'nobody yet') : null,
          d.supervisors.map((s) => h('option', { value: String(s.id), selected: t.assignee?.id === s.id }, s.name)))),
          h('span.td-dismiss', reason, h('button.btn', {
            type: 'button',
            onclick: async () => { try { await api(`/todo/${t.id}/dismiss`, { method: 'POST', body: { note: reason.value } }); await re('Closed: nothing needed.'); } catch (err) { fail(said)(err); } },
          }, 'Nothing needed'))) : null,
        h('div.td-step',
          h('button.btn', { type: 'button', disabled: at <= 0, onclick: () => step(-1) }, '‹ Previous'),
          h('span.small.muted', `${at + 1} of ${items.length}`),
          h('button.btn', { type: 'button', disabled: at >= items.length - 1, onclick: () => step(1) }, 'Next ›')),
        said);
    })();

    // ---------------------------------------------------------- the top --
    const checkSaid = h('small.muted', d.checkedAt ? `Last checked ${d.checkedAt.slice(8, 10)}/${d.checkedAt.slice(5, 7)} ${d.checkedAt.slice(11, 16)}` : 'Not checked with Odoo yet');
    const check = h('button.btn', {
      type: 'button',
      onclick: async () => {
        check.disabled = true; checkSaid.textContent = 'Asking Odoo…'; checkSaid.className = 'small';
        try {
          const r = await api('/todo/check', { method: 'POST' });
          const t = r.todos || {};
          await re(`Checked ${r.pos} cash PO${r.pos === 1 ? '' : 's'} with Odoo. ${t.closed || 0} item${t.closed === 1 ? '' : 's'} cleared, ${t.raised || 0} new.`);
        } catch (err) { fail(checkSaid)(err); check.disabled = false; }
      },
    }, 'Check Odoo now');
    // The laundry system, read now up to today, so a finished shift's laundry
    // is compared without waiting for the night.
    const laundrySaid = h('small.muted', '');
    const laundry = h('button.btn', {
      type: 'button',
      onclick: async () => {
        laundry.disabled = true; laundrySaid.textContent = 'Reading the laundry system…'; laundrySaid.className = 'small';
        try {
          const r = await api('/todo/laundry', { method: 'POST' });
          laundrySaid.textContent = `Read ${dayText(r.from)} to ${dayText(r.to)}: ${r.orders} order${r.orders === 1 ? '' : 's'}, ${r.payments} payment${r.payments === 1 ? '' : 's'}.`;
          laundrySaid.className = 'small muted';
          onChange();
        } catch (err) { fail(laundrySaid)(err); }
        laundry.disabled = false;
      },
    }, 'Check laundry now');
    const days = h('input', { type: 'number', min: '0', max: '90', value: String(d.unbilledDays), style: 'width:4.5rem', 'aria-label': 'Days a PO may go without a posted bill' });
    const back = h('input', { type: 'number', min: '7', max: '730', value: String(d.lookbackDays ?? 90), style: 'width:5rem', 'aria-label': 'How many days back to look for POs' });
    const setSaid = h('span.small');
    const find = h('input', {
      type: 'search', placeholder: 'Find a PO or supplier', 'aria-label': 'Find a PO or supplier', value: view.find,
      oninput: (e) => { view.find = e.target.value; const at = e.target.selectionStart; draw(); const again = v.querySelector('.td-find input'); if (again) { again.focus(); again.setSelectionRange(at, at); } },
    });
    const pill = (on, label, onclick) => h('button', { type: 'button', 'aria-pressed': String(on), onclick }, label);

    mount(v,
      notice,
      h('div.card.sh-todo-head',
        h('div',
          h('h2', admin ? 'Money to-do' : 'Your money to-do'),
          h('p.sub', admin
            ? 'Raised from the cash POs and Odoo’s bills, and shared out among the supervisors. Answers wait for you here.'
            : 'Given to you from the cash POs and Odoo’s bills. Each item clears by itself once Odoo is put right: press Check Odoo now to see it go.')),
        h('div.sh-todo-check', h('div.sh-todo-buttons', check, laundry), checkSaid, laundrySaid),
        h('div.sh-todo-counts',
          h('span', h('b', String(d.counts.open)), ' open'),
          h('span', h('b', String(d.counts.answered)), ' waiting for an admin'),
          admin && d.counts.unassigned ? h('span', h('b', String(d.counts.unassigned)), ' with nobody') : null)),
      h('div.td-bar',
        h('div.td-pills', KINDS.map(([k, label]) => pill(view.kind === k, `${label} · ${counts[k]}`, () => { view.kind = k; draw(); }))),
        h('label.small.td-groupby', 'Group by ', h('select', { onchange: (e) => { view.group = e.target.value; openGroups.clear(); draw(); } },
          GROUPS.filter(([g]) => admin || g !== 'supervisor').map(([g, label]) => h('option', { value: g, selected: view.group === g }, label)))),
        h('div.td-find', find),
        admin ? h('select', { 'aria-label': 'Whose items', onchange: (e) => { view.who = e.target.value; draw(); } },
          h('option', { value: 'all', selected: view.who === 'all' }, 'Everybody'),
          h('option', { value: 'waiting', selected: view.who === 'waiting' }, 'Waiting for me'),
          h('option', { value: 'none', selected: view.who === 'none' }, 'Nobody yet'),
          d.supervisors.map((s) => h('option', { value: String(s.id), selected: view.who === String(s.id) }, `${s.name} (${s.load})`))) : null,
        h('label.small', h('input', { type: 'checkbox', checked: view.closed, onchange: (e) => { view.closed = e.target.checked; picked.clear(); load(); } }), ' Show closed')),
      admin && !d.supervisors.length ? banner('warning', 'There are no supervisors in Insight, so nothing can be given out. Items stay here for you.') : null,
      h('div.td-split',
        h('div.card.td-left', bulk, list),
        detail),
      admin ? h('p.small.muted.td-days',
        'Raise a PO with no posted bill after ', days, ' days (from the day the cash left, or the day it was ordered), looking back over POs of the last ', back, ' days ',
        h('button.btn', {
          type: 'button',
          onclick: async (e) => {
            e.target.disabled = true; setSaid.textContent = 'Saving…'; setSaid.className = 'small';
            try {
              const out = await api('/todo/settings', { method: 'POST', body: { unbilledDays: days.value, lookbackDays: back.value } });
              await re(out.checked ? (out.checked.ok ? 'Saved, and Odoo asked again for the new look-back.' : `Saved. Odoo could not be asked: ${out.checked.error}`) : 'Saved.');
            } catch (err) { fail(setSaid)(err); e.target.disabled = false; }
          },
        }, 'Save'), setSaid) : null);
    list.scrollTop = scrolled;
  }

  await load();
}
