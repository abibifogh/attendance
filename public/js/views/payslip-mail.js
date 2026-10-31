import { api } from '../api.js';
import { h, mount, toast } from '../util.js';
import { card } from './components.js';
import { niceMonth } from './att-advances.js';

/**
 * Payroll › Payslips and returns: email the payslips.
 *
 * Each person gets their own payslip as a PDF attached to an email, at the
 * personal email on their staff record (else their sign-in address). Only a
 * closed month: a draft still moves, and an emailed payslip is kept. They go
 * a few at a time so the screen shows them going, and the list below says
 * where each one stands afterwards.
 */

const STATUS = {
  sent: ['ok', 'Sent'],
  failed: ['bad', 'Failed'],
  not_sent: ['', 'Not sent yet'],
  no_email: ['', 'No email'],
};

const stamp = (at) => (at ? new Date(`${String(at).replace(' ', 'T')}Z`).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export function payslipMailCard(month, closed) {
  const body = h('div', h('p.muted', 'Loading…'));
  const el = card('Email the payslips', { wide: true }, body);
  if (!closed) {
    mount(body, h('p.muted', { style: { margin: 0 } },
      `Close ${niceMonth(month)} first. Only a closed month can be emailed: a draft still moves, and an emailed payslip is kept.`));
    return el;
  }
  let show = 'all';
  const load = async (message = null) => {
    let data;
    try { data = await api.payslipMail(month); } catch (err) { mount(body, h('div.alert.warn', err.message)); return; }
    const people = data.people ?? [];
    const withEmail = people.filter((p) => p.email);
    const noEmail = people.filter((p) => !p.email);
    const sent = people.filter((p) => p.status === 'sent');
    const failed = people.filter((p) => p.status === 'failed');
    const changed = people.filter((p) => p.changed);
    const toSend = withEmail.filter((p) => p.status !== 'sent' || p.changed);
    const count = (k) => ({ all: people.length, sent: sent.length, failed: failed.length, none: people.length - sent.length - failed.length }[k]);
    const filters = h('div.seg.seg-wrap', { role: 'group', 'aria-label': 'Show' },
      [['all', 'Everybody'], ['sent', 'Sent'], ['failed', 'Failed'], ['none', 'Not sent']].map(([k, label]) => h('button', {
        type: 'button', class: k === show ? 'active' : '', 'aria-pressed': String(k === show),
        onclick: () => { show = k; load(); },
      }, `${label} ${count(k)}`)));
    const rows = people.filter((p) => show === 'all' || (show === 'sent' ? p.status === 'sent' : show === 'failed' ? p.status === 'failed' : !['sent', 'failed'].includes(p.status)));
    const one = (p) => {
      const [tone, label] = p.changed ? ['warn', 'Changed since sent'] : STATUS[p.status] ?? ['', p.status];
      const again = p.email ? h('button.btn-sm', { type: 'button', onclick: () => openSend([p], load) },
        p.status === 'sent' ? 'Send again' : p.status === 'failed' ? 'Try again' : 'Send') : h('a.btn-sm', { href: `#/person?id=${p.staffId}` }, 'Add email');
      return h('tr',
        h('td', h('div', p.name), p.department ? h('small.muted', p.department) : null),
        h('td', h('small', p.status === 'sent' || p.status === 'failed' ? (p.sentTo || p.email) : (p.email || h('span.muted', 'no email on record')))),
        h('td', h(`span.pill${tone ? `.${tone}` : ''}`, label), p.error ? h('small.muted', { style: { display: 'block' } }, p.error) : null),
        h('td', h('small.muted', p.at ? `${stamp(p.at)}${p.by ? ` · ${p.by}` : ''}` : '—')),
        h('td.num', again));
    };
    mount(body,
      message,
      h('p.muted', { style: { marginTop: 0 } }, 'Each person gets their own payslip as a PDF attached to an email, at the address on their staff record. Nobody sees anyone else’s, and no amounts are written in the email.'),
      h('div.grid.grid-4.pay-tiles',
        tileOf(String(withEmail.length), `have an email, of ${people.length}`),
        tileOf(String(noEmail.length), 'no email on record', noEmail.length ? 'warn' : ''),
        tileOf(String(sent.length), changed.length ? `sent · ${changed.length} changed since` : 'sent'),
        tileOf(String(failed.length), 'failed', failed.length ? 'bad' : '')),
      h('div.btn-row', { style: { margin: '.75rem 0' } },
        h('button.btn.btn-primary', { type: 'button', disabled: !toSend.length, onclick: () => openSend(toSend, load) },
          toSend.length ? `Email ${toSend.length} payslip${toSend.length === 1 ? '' : 's'}` : 'All sent')),
      people.length ? [filters, h('div.table-wrap', h('table.table',
        h('thead', h('tr', h('th', 'Name'), h('th', 'Email'), h('th', 'Where it stands'), h('th', 'When'), h('th', ''))),
        h('tbody', rows.length ? rows.map(one) : h('tr', h('td', { colspan: '5' }, h('span.muted', 'None of these.'))))))] : null);
  };
  load();
  return el;

  function tileOf(n, label, tone = '') {
    return h(`div.card.home-tile${tone ? `.is-${tone}` : ''}`, h('span.home-tile-n', n), h('span.home-tile-l', label));
  }

  /** Who, a line from the sender, a copy for them; then off they go, a few at a time. */
  function openSend(list, reload) {
    const ticks = new Map(list.map((p) => [p.staffId, true]));
    const note = h('textarea', { rows: 2, maxlength: 400, placeholder: 'Optional, for example: Any question about it, speak to payroll.' });
    const copy = h('input', { type: 'checkbox' });
    const said = h('span.small');
    const go = h('button.btn.btn-primary', { type: 'submit' });
    const label = () => { const n = [...ticks.values()].filter(Boolean).length; go.textContent = `Send ${n} payslip${n === 1 ? '' : 's'}`; go.disabled = !n; };
    const dialog = h('dialog.app-dialog.wide',
      h('form', {
        method: 'dialog',
        onsubmit: async (e) => {
          e.preventDefault();
          const ids = list.filter((p) => ticks.get(p.staffId)).map((p) => p.staffId);
          go.disabled = true;
          let sent = 0;
          let failed = 0;
          for (let i = 0; i < ids.length; i += 5) {
            said.textContent = `Sending… ${Math.min(i, ids.length)} of ${ids.length}`;
            try {
              // eslint-disable-next-line no-await-in-loop
              const out = await api.sendPayslipMail({ month, staffIds: ids.slice(i, i + 5), note: note.value.trim(), copy: copy.checked });
              for (const r of out.results ?? []) { if (r.status === 'sent') sent += 1; else failed += 1; }
            } catch (err) {
              failed += ids.slice(i, i + 5).length;
              toast(err.message, 'bad');
            }
          }
          dialog.close();
          await reload(failed
            ? h('div.alert.warn', `${sent} of ${ids.length} ${niceMonth(month)} payslips sent. ${failed} did not go: see below.`)
            : h('div.alert.good', `${sent} ${niceMonth(month)} payslip${sent === 1 ? '' : 's'} sent.`));
        },
      },
      h('div.dialog-head', h('h2', `Email ${niceMonth(month)} payslips`),
        h('button.dialog-close', { type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, '✕')),
      h('div', { style: { maxHeight: '40vh', overflow: 'auto', border: '1px solid var(--line, #e3e6eb)', borderRadius: '10px', padding: '.25rem .75rem' } },
        list.map((p) => h('label', { style: { display: 'flex', gap: '.6rem', alignItems: 'center', padding: '.35rem 0' } },
          h('input', { type: 'checkbox', checked: true, onchange: (e) => { ticks.set(p.staffId, e.target.checked); label(); } }),
          h('span', { style: { flex: 1 } }, p.name), h('small.muted', p.email)))),
      h('p.muted', { style: { fontSize: '.86rem' } }, `Subject: Your payslip for ${niceMonth(month)} · their payslip attached as a PDF.`),
      h('label.field', 'A line from you (optional)', note),
      h('label', { style: { display: 'flex', gap: '.6rem', alignItems: 'flex-start', marginTop: '.5rem' } }, copy,
        h('span', 'Send me a copy of each', h('small.muted', { style: { display: 'block' } }, 'To the email you sign in with, for your records.'))),
      h('div.btn-row', { style: { marginTop: '1rem' } }, said, h('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Cancel'), go)));
    label();
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }
}
