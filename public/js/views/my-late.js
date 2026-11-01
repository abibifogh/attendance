import { api } from '../api.js';
import { fmtDay, h, money, mount, toast } from '../util.js';

/**
 * The late charge on somebody's own My shifts: the rule to accept, each recent
 * charge with what it costs and where it stands, and a place to say why.
 *
 * Loads on its own, after the page, so a slow answer never holds up the week.
 */
export function myLateBlock() {
  const host = h('div.my-late');
  load(host);
  return host;
}

async function load(host) {
  const data = await api.myLateCharges().catch(() => null);
  if (!data) { mount(host); return; }
  const rule = data.rule ?? {};
  const cash = (n) => money(n, rule.currency || 'GHS');
  const redraw = () => load(host);

  const thisMonth = new Date().toISOString().slice(0, 7);
  const charges = data.charges ?? [];
  const recent = charges.filter((c) => c.status !== 'void').slice(0, 3);
  const monthly = charges.filter((c) => String(c.day).slice(0, 7) === thisMonth && ['open', 'kept'].includes(c.status));

  const accept = data.applies && !data.accepted
    ? h('div.card.my-late-accept',
      h('strong', `Late charge: ${cash(rule.amount)}`),
      h('p', `Clocking in ${rule.minutes} minutes or more after your shift starts costs ${cash(rule.amount)}. `
        + 'It comes off your pay unless a manager waives it, and you can always say why. '
        + 'Your phone tells you while you can still avoid it.'),
      h('div.btn-row',
        h('button.btn.btn-primary', {
          type: 'button',
          onclick: async () => {
            try { await api.acceptLateRule(); toast('Thank you. It is on your record.', 'good'); redraw(); } catch (err) { toast(err.message, 'bad'); }
          },
        }, 'I have read it and accept'),
        h('a.btn-sm', { href: '#/handbook' }, 'Read it in the handbook')))
    : null;

  const reasonForm = (c) => {
    const kinds = data.reasonKinds ?? [];
    let picked = c.reason?.kind ?? null;
    const chips = h('div.my-late-chips');
    const text = h('textarea', { rows: 2, maxlength: 500, placeholder: 'What happened', value: c.reason?.text ?? '' });
    const drawChips = () => mount(chips, kinds.map((k) => h('button', {
      type: 'button',
      class: picked === k.kind ? 'my-late-chip on' : 'my-late-chip',
      'aria-pressed': String(picked === k.kind),
      onclick: () => { picked = k.kind; drawChips(); },
    }, k.label)));
    drawChips();
    return h('div.my-late-why',
      h('small.my-late-label', c.reason ? 'What you told your manager' : 'Tell your manager why'),
      chips, text,
      h('button.btn.btn-primary', {
        type: 'button',
        onclick: async () => {
          try {
            await api.myLateReason({ id: c.id, kind: picked || 'other', text: text.value.trim() });
            toast('Sent to your manager. You hear back here when it is decided.', 'good');
            redraw();
          } catch (err) { toast(err.message, 'bad'); }
        },
      }, c.reason ? 'Update it' : 'Send to my manager'));
  };

  const chargeCard = (c) => {
    const state = c.status === 'waived'
      ? h('p.my-late-state.is-waived', h('strong', 'Waived'), c.decided?.note ? ` · “${c.decided.note}”` : '', c.decided?.by ? ` · ${c.decided.by}` : '')
      : c.status === 'kept'
        ? h('p.my-late-state', h('strong', 'Kept'), ` · comes off your ${monthWord(c.month)} pay`)
        : h('p.my-late-state', `Comes off your ${monthWord(c.month)} pay unless a manager waives it.`);
    return h('div', { class: `card my-late-card is-${c.status}` },
      h('div.my-late-top',
        h('strong', `${fmtDay(c.day)} · in at ${c.clockIn}, ${c.minutes} min late`),
        h('strong', { class: c.status === 'waived' ? 'my-late-amt is-waived' : 'my-late-amt' }, `− ${cash(c.amount)}`)),
      c.shift ? h('small.muted', `${c.shift.name} ${c.shift.from}–${c.shift.to}`) : null,
      state,
      ['open', 'kept'].includes(c.status) && !c.closed ? reasonForm(c) : null);
  };

  mount(host,
    accept,
    recent.length ? recent.map(chargeCard) : null,
    monthly.length
      ? h('div.my-late-tally', h('span', 'Late charges this month'),
        h('strong', `${monthly.length} · ${cash(monthly.reduce((n, c) => n + c.amount, 0))}`))
      : null);
}

function monthWord(month) {
  const m = /^(\d{4})-(\d{2})/.exec(String(month ?? ''));
  if (!m) return '';
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
}
