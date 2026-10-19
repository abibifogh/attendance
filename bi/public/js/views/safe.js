import { add, h, mount, money } from '../util.js';
import { api } from '../api.js';
import { banner } from './components.js';

/**
 * Money › Safe: the safe book. A page runs from one count of the safe to the
 * next. What comes in is read from the shifts; what goes out is written here.
 * Admins. It was a tab of Shifts; it is money, so it lives with the money.
 */

const SLOT = { morning: { label: 'Morning' }, afternoon: { label: 'Afternoon' }, night: { label: 'Night' } };
const nameOf = (user) => (user ? user.charAt(0) + user.slice(1).toLowerCase() : 'Nobody named');
const dayText = (day, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => new Date(`${day}T12:00:00Z`)
  .toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });

export async function renderSafe(root, { range }) {
  const v = h('div.sh-view');
  add(root, h('div.sh', v));
  await safeView(v, range).catch((err) => mount(v, banner('problem', err.message)));
}

async function safeView(v, range, notice = null) {
  mount(v, h('p.muted', 'Reading the safe book…'));
  const d = await api(`/safe/book?from=${range.from}&to=${range.to}`);
  const re = (msg) => safeView(v, range, msg ? banner('good', msg) : null);
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
          h('div.sh-cardhead', h('h2', 'Confirmed in Odoo, not claimed'), h('p.sh-sub', `POs ordered ${range.from === range.to ? `on ${dayText(range.from)}` : `from ${dayText(range.from)} to ${dayText(range.to)}`} that no closing report, drawer expense or the safe has claimed. Were they paid from the safe?`)),
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
