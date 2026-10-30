import { h, mount, money } from '../util.js';
import { api } from '../api.js';
import { state } from '../app.js';

/**
 * Prepaid stays: a month of reservations, by the month the guest arrived.
 * How much of what they were charged was paid before arrival, by bank
 * transfer or by card online, against what was paid at the desk; the six
 * months to it; every reservation; and who gets the summary on the 5th.
 */

const VIA = { bank: ['Prepaid by bank transfer', 'var(--pp-bank)'], online: ['Prepaid by card online', 'var(--pp-online)'] };
const STATUS = { full: ['Prepaid in full', 'full'], part: ['Part prepaid', 'part'], none: ['Not prepaid', 'none'] };
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1).replace(/\.0$/, '')}%`);
const monthName = (m, opts = { month: 'long', year: 'numeric' }) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
const day = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
const shift = (m, n) => {
  const [y, mo] = m.split('-').map(Number);
  const i = y * 12 + (mo - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
};
/** What the journals cover of a month, in a sentence (the same words as the server's). */
const covered = (c, name) => (!c?.within?.length ? `No journal loaded covers ${name}`
  : `The journals loaded cover ${c.within.map((r) => (r.from === r.to ? day(r.from) : `${day(r.from)} to ${day(r.to)}`)).join(', ')} only`);
const monthInHash = () => {
  const at = location.hash.indexOf('?');
  const m = at < 0 ? null : new URLSearchParams(location.hash.slice(at + 1)).get('month');
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(m || '') ? m : null;
};

/** Settings › Notifications › Prepaid summary: who gets the summary on the 5th. */
export async function renderPrepaidMail(root) {
  let mail = await api('/money/prepaid/mail');
  const box = h('section.card.pp-mail');
  mount(root, box);
  draw();
  function draw() {
    const emails = [...mail.emails];
    const typed = h('input', { type: 'email', placeholder: 'Add an email address', 'aria-label': 'Email address' });
    const said = h('span.small');
    const save = async (next) => {
      said.textContent = 'Saving…'; said.className = 'small';
      try { mail = { ...mail, ...(await api('/money/prepaid/mail', { method: 'POST', body: { emails: next } })) }; draw(); } catch (err) { said.textContent = err.message; said.className = 'small form-error'; }
    };
    const add = () => {
      const value = typed.value.trim().toLowerCase();
      if (!value) return;
      if (emails.includes(value)) { said.textContent = 'Already on the list.'; return; }
      save([...emails, value]);
    };
    mount(box,
      h('h2', 'Prepaid summary'),
      h('p.sub', 'On the 5th of every month, in the morning, the month before goes to these addresses: the figures, every prepaid reservation, and the whole list as a CSV. Any address works, not only people with an account. If the journals loaded do not cover that month whole, it is not sent: the admins are asked to load the rest and send it from Reports › Guests › Prepaid stays.'),
      h('div.pp-emails', emails.length ? emails.map((e) => h('span.pp-email', e,
        h('button', { type: 'button', 'aria-label': `Remove ${e}`, title: 'Remove', onclick: () => save(emails.filter((x) => x !== e)) }, '×')))
        : h('span.muted', 'Nobody yet: the summary is not sent until an address is added.')),
      h('div.pp-row', typed, h('button.btn', { type: 'button', onclick: add }, 'Add')),
      said);
  }
}

export async function renderPrepaid(root) {
  const isAdmin = (state.me?.account?.till?.role || (state.me?.account?.isOwner ? 'admin' : null)) === 'admin';
  const data = await api(`/money/prepaid${monthInHash() ? `?month=${monthInHash()}` : ''}`);
  const view = h('div.pp');
  mount(root, view);
  let filter = 'all';
  let flash = null;
  paint();

  function paint() {
    const { month, totals: t, months, reservations, journal } = data;
    const go = (m) => { location.hash = `#/prepaid?month=${m}`; };
    const list = reservations.filter((r) => filter === 'all' || r.status === filter);
    const desk = t.desk;
    const notPaid = Math.max(0, t.charged - t.prepaid - desk);
    const seg = (amount, colour) => (amount > 0 ? h('b', { style: `flex:${amount};background:${colour}` }) : null);
    const top = Math.max(1, ...months.map((x) => x.charged));

    mount(view,
      flash,
      isAdmin ? heldPrompt() : null,
      h('div.pp-top',
        h('div', h('h1', 'Prepaid stays'),
          h('p.muted', `Reservations by the month the guest arrived.${journal ? ` The journal loaded runs ${day(journal.from)} to ${day(journal.to)}.` : ' No journal loaded yet: load one under Shifts → Files.'}`),
          data.coverage && !data.coverage.complete ? h('p.pp-partial', `⚠ ${monthName(month)} is not complete. ${covered(data.coverage, monthName(month))}, so the figures are short until the rest is loaded under Shifts → Files.`) : null),
        h('div.pp-month',
          h('button.btn', { type: 'button', 'aria-label': 'Month before', onclick: () => go(shift(month, -1)) }, '‹'),
          h('b', monthName(month)),
          h('button.btn', { type: 'button', 'aria-label': 'Month after', onclick: () => go(shift(month, 1)) }, '›'),
          h('a.btn', { href: `/api/money/prepaid.csv?month=${month}`, download: `prepaid-stays-${month}.csv` }, '⬇ Download CSV'))),

      h('div.pp-tiles',
        tile('Reservations arriving', String(t.count), `${money(t.charged)} charged`),
        tile('Prepaid', money(t.prepaid), `${pct(t.share)} of what was charged`),
        tile('Prepaid in full', String(t.full), `and ${t.part} part prepaid · ${t.none} not prepaid`),
        tile('Still owing', money(t.owing), t.owingCount ? `${t.owingCount} reservation${t.owingCount === 1 ? '' : 's'} · see Front desk › Shifts › To sort out › Unpaid stays` : 'Nothing owed')),

      h('div.pp-grid',
        h('section.card',
          h('h2', `How ${monthName(month, { month: 'long' })}’s stays were paid`),
          h('p.sub', 'Every payment on the reservations that arrived this month.'),
          t.charged ? [
            h('div.pp-stack', seg(t.bank, 'var(--pp-bank)'), seg(t.online, 'var(--pp-online)'), seg(desk, 'var(--pp-desk)'), seg(notPaid, 'var(--pp-none)')),
            h('div.pp-key',
              key('var(--pp-bank)', 'Prepaid by bank transfer', t.bank, t.charged),
              key('var(--pp-online)', 'Prepaid by card online', t.online, t.charged),
              key('var(--pp-desk)', 'Paid at the desk', desk, t.charged),
              notPaid ? key('var(--pp-none)', 'Not paid', notPaid, null) : null),
          ] : h('p.muted', 'No reservation arrived this month, or the journal does not reach it.')),
        h('section.card',
          h('h2', 'Prepaid share, month by month'),
          h('p.sub', 'The part of each month’s stays paid before arrival.'),
          h('div.pp-months', months.map((x) => h(`button.pp-mo${x.month === month ? '.on' : ''}`, { type: 'button', onclick: () => go(x.month), title: `${monthName(x.month)}: ${money(x.prepaid)} of ${money(x.charged)}` },
            h('span.pp-col', { style: `height:${Math.max(4, (x.charged / top) * 120)}px` },
              h('b', { style: `height:${x.charged ? (x.bank / x.charged) * 100 : 0}%;background:var(--pp-bank)` }),
              h('b', { style: `height:${x.charged ? (x.online / x.charged) * 100 : 0}%;background:var(--pp-online)` })),
            h('small', `${monthName(x.month, { month: 'short' })} · ${pct(x.share)}`)))))),

      h('section.card',
        h('h2', 'The reservations'),
        h('p.sub', 'Each reservation that arrived this month. Guests are identified by ASSD’s reservation number and room: their names are taken out of the journal before it leaves the browser. A prepayment’s date is the day it was keyed in ASSD.'),
        h('div.pp-chips', [['all', `All · ${t.count}`], ['full', `Prepaid in full · ${t.full}`], ['part', `Part prepaid · ${t.part}`], ['none', `Not prepaid · ${t.none}`]]
          .map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(filter === k), onclick: () => { filter = k; paint(); } }, label))),
        list.length ? h('div.pp-table', h('table',
          h('thead', h('tr', ['Reservation', 'Room', 'Stay', 'Nights', 'Charged', 'Prepaid', 'At the desk', 'Balance', ''].map((c, i) => h(i >= 3 && i <= 7 ? 'th.num' : 'th', c)))),
          h('tbody', list.map((r) => h('tr',
            h('td', r.ref || `ASSD ${r.seq}`, h('small', `ASSD ${r.seq}${r.bookedBy ? ` · ${r.bookedBy}` : ''}`)),
            h('td', r.rooms.join(', ') || '—'),
            h('td', `${day(r.arrival)}${r.checkout ? `–${day(r.checkout)}` : ''}`),
            h('td.num', String(r.nights)),
            h('td.num', money(r.charged)),
            h('td.num', r.prepaid.total ? money(r.prepaid.total) : '—',
              r.prepaid.lines.map((l) => h('small', `${l.via === 'online' ? 'card online' : 'bank transfer'}${l.day ? ` · keyed ${day(l.day)}` : ''}`))),
            h('td.num', r.desk.total ? money(r.desk.total) : '—',
              r.desk.total ? h('small', [r.desk.cash ? 'cash' : '', r.desk.card ? 'card' : '', r.desk.other ? 'other' : ''].filter(Boolean).join(', ')) : null),
            h('td.num', money(r.balance)),
            h('td', h(`span.pp-st.${STATUS[r.status][1]}`, r.status === 'part' && r.charged ? `Part prepaid · ${Math.round((r.prepaid.total / r.charged) * 100)}%` : STATUS[r.status][0]))))),
          h('tfoot', h('tr', h('td', `${list.length} reservation${list.length === 1 ? '' : 's'}`), h('td'), h('td'),
            h('td.num', String(list.reduce((s, r) => s + r.nights, 0))),
            h('td.num', money(list.reduce((s, r) => s + r.charged, 0))),
            h('td.num', money(list.reduce((s, r) => s + r.prepaid.total, 0))),
            h('td.num', money(list.reduce((s, r) => s + r.desk.total, 0))),
            h('td.num', money(list.reduce((s, r) => s + r.balance, 0))), h('td')))))
          : h('p.muted', 'None of this kind.')),

      isAdmin ? mailCard() : null);
  }

  function tile(label, big, small) {
    return h('div.pp-tile', h('small', label), h('b', big), h('span', small));
  }
  function key(colour, label, amount, of) {
    return h('span', h('i', { style: `background:${colour}` }), `${label} `, h('b', money(amount)), of ? ` · ${pct(amount / of)}` : '');
  }

  /**
   * Send the month on screen to everyone chosen. Asks first when it went
   * already, or when the journals do not cover the month whole.
   */
  async function sendToEveryone(button, said) {
    const name = monthName(data.month);
    const last = data.mail?.lastSent;
    if (last?.month === data.month && !window.confirm(`${name} was already sent on ${new Date(last.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}. Send it again to everyone?`)) return;
    button.disabled = true; said.textContent = 'Sending…'; said.className = 'small';
    try {
      let out = await api('/money/prepaid/send', { method: 'POST', body: { month: data.month, everyone: true } });
      if (out.incomplete) {
        if (!window.confirm(`${name} is not complete. ${covered(out.coverage, name)}, so the figures are short.\n\nSend it anyway? Or cancel, load the rest under Shifts → Files, and send it then.`)) {
          said.textContent = 'Not sent.'; button.disabled = false; return;
        }
        out = await api('/money/prepaid/send', { method: 'POST', body: { month: data.month, everyone: true, anyway: true } });
      }
      if (out.sent) {
        data.mail = { ...data.mail, lastSent: { at: new Date().toISOString(), month: out.month, count: out.sent, by: 'by hand' }, held: data.mail?.held?.month === out.month ? null : data.mail?.held };
        flash = h('div.pp-flash', `Sent ${name} to ${out.sent} address${out.sent === 1 ? '' : 'es'}.${out.failed?.length ? ` Not sent to: ${out.failed.join('; ')}` : ''}`);
        paint();
        return;
      }
      said.textContent = out.failed?.[0] || out.reason || 'Not sent.'; said.className = 'small form-error';
    } catch (err) { said.textContent = err.message; said.className = 'small form-error'; }
    button.disabled = false;
  }

  /** A month the 5th held back, because its journal was not complete: say so, and offer to send it. */
  function heldPrompt() {
    const held = data.mail?.held;
    if (!held || data.mail?.lastSent?.month === held.month) return null;
    const name = monthName(held.month);
    const said = h('span.small');
    const send = h('button.btn.primary', { type: 'button', onclick: () => sendToEveryone(send, said) }, `Send ${name} to everyone`);
    return h('div.pp-held',
      h('div', h('b', `${name}’s prepaid summary was not sent on the 5th.`),
        h('span', ` ${held.words || (held.through ? `The journal reached only ${day(held.through)}` : `No journal covered ${name}`)}, so the month was not complete. Load the rest under Settings › Connections & files › Shift files, then send it, or send it as it is.`)),
      h('div.pp-row', data.month === held.month ? send : h('a.btn.primary', { href: `#/prepaid?month=${held.month}` }, `Open ${name}`), said));
  }

  /** Sending it now, to everyone or as a test; who gets it on the 5th is in Settings › Notifications. */
  function mailCard() {
    const mail = data.mail || { emails: [] };
    const emails = [...mail.emails];
    const said = h('span.small');
    const tryIt = h('button.btn', {
      type: 'button',
      onclick: async () => {
        tryIt.disabled = true; said.textContent = 'Sending…'; said.className = 'small';
        try {
          const out = await api('/money/prepaid/send', { method: 'POST', body: { month: data.month } });
          said.textContent = out.sent ? `Sent ${monthName(out.month)} to ${state.me?.account?.email}.` : (out.failed?.[0] || out.reason || 'Not sent.');
          said.className = out.sent ? 'small' : 'small form-error';
        } catch (err) { said.textContent = err.message; said.className = 'small form-error'; }
        tryIt.disabled = false;
      },
    }, 'Send a test to me');
    const everyone = h('button.btn.primary', {
      type: 'button', disabled: !emails.length, title: emails.length ? '' : 'Add an address first',
      onclick: () => sendToEveryone(everyone, said),
    }, `Send ${monthName(data.month)} to everyone`);
    const last = mail.lastSent;
    return h('section.card.pp-mail',
      h('h2', 'Monthly prepaid summary'),
      h('p.sub', `Sent by itself on the 5th to ${emails.length ? `${emails.length} address${emails.length === 1 ? '' : 'es'}` : 'nobody yet'}. `,
        h('a', { href: '#/notify-prepaid' }, 'Change who gets it')),
      h('div.pp-row', everyone, tryIt,
        h('span.small.muted', last ? `Last sent: ${new Date(last.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}, for ${monthName(last.month)}, to ${last.count} address${last.count === 1 ? '' : 'es'}${last.by ? `, ${last.by}` : ''}` : 'Not sent yet.')),
      said);
  }
}
