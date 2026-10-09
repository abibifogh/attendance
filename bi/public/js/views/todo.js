import { h, mount, money } from '../util.js';
import { api } from '../api.js';
import { banner } from './components.js';

/**
 * The money to-do list, under Shifts.
 *
 * Cash POs Odoo has no bill for, payments that are not what their PO says,
 * and bills with no PO. Each is given to a supervisor; a supervisor sees their
 * own, an admin sees everybody's and decides the answers.
 */

const dayText = (day) => (day ? new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
const FROM = { drawer: 'the drawer', safe: 'the safe' };
const fail = (said) => (err) => { said.textContent = err.message; said.className = 'small form-error'; };

function what(t) {
  const d = t.detail || {};
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
      h('p.small.muted', 'Say why, or have the PO corrected in Odoo. It closes by itself if the two come to agree.'),
    ];
  }
  return [
    h('p', `A bill from ${d.supplier || 'a supplier'}${d.ref ? ` (their number ${d.ref})` : ''}, dated ${dayText(d.day)}, for ${money(d.total)}, with no PO behind it.`),
    h('p.small.muted', 'Say what it was for and who agreed it, or have it linked to its PO in Odoo.'),
  ];
}

export async function todoPanel(v, { admin, onChange = () => {} }) {
  let showClosed = false;
  let who = 'all';

  async function paint(notice = null) {
    mount(v, h('p.muted', 'Reading the to-do list…'));
    let d;
    try {
      d = await api(`/todo${showClosed ? '?closed=1' : ''}`);
    } catch (err) { mount(v, banner('problem', err.message)); return; }
    const items = d.items.filter((t) => who === 'all' || (who === 'none' ? !t.assignee : who === 'waiting' ? t.state === 'answered' : String(t.assignee?.id) === who));
    const re = async (message) => { onChange(); await paint(message ? banner('good', message) : null); };

    const card = (t) => {
      const said = h('span.small');
      const box = h('input', { type: 'text', maxlength: '600', placeholder: t.kind === 'unbilled' ? 'Where it has got to' : 'What happened' });
      const send = async () => {
        said.textContent = 'Saving…';
        try {
          const out = await api(`/todo/${t.id}/answer`, { method: 'POST', body: { answer: box.value } });
          await re(out.state === 'answered' ? 'Sent to an admin to approve.' : out.state === 'closed' ? 'Closed.' : 'Noted.');
        } catch (err) { fail(said)(err); }
      };
      const reason = h('input', { type: 'text', maxlength: '400', placeholder: 'Why' });
      const adminRow = admin && t.state !== 'closed' ? h('div.sh-todo-admin',
        h('label.small', 'With ',
          h('select', {
            onchange: async (e) => {
              try { await api(`/todo/${t.id}/assign`, { method: 'POST', body: { accountId: Number(e.target.value) } }); await re('Given to somebody else.'); } catch (err) { fail(said)(err); }
            },
          }, !t.assignee ? h('option', { value: '', selected: true }, 'nobody yet') : null,
          d.supervisors.map((s) => h('option', { value: String(s.id), selected: t.assignee?.id === s.id }, s.name)))),
        h('span.sh-todo-dismiss', reason, h('button.btn', {
          type: 'button',
          onclick: async () => { try { await api(`/todo/${t.id}/dismiss`, { method: 'POST', body: { note: reason.value } }); await re('Closed: nothing needed.'); } catch (err) { fail(said)(err); } },
        }, 'Nothing needed'))) : null;

      const tone = t.state === 'closed' ? 'ok' : t.state === 'answered' ? 'warn' : t.kind === 'unbilled' ? 'info' : 'bad';
      return h(`article.sh-ex.sh-todo.${tone}${t.state === 'closed' ? '.done' : ''}`,
        h('div.hd',
          h('span.sq', t.kind === 'nopo' ? '?' : '₵'),
          h('h3', t.kindLabel, ' · ', h('b', t.kind === 'nopo' ? (t.detail?.supplier || 'Bill') : t.ref), t.kind !== 'nopo' && t.detail?.vendor ? h('span.muted', ` ${t.detail.vendor}`) : null),
          h('span.amt.num', money(t.kind === 'differs' ? Math.abs(t.amount) : t.amount))),
        h('div.sh-meta',
          h('span', `Raised ${dayText(String(t.openedAt).slice(0, 10))}`),
          h('span', t.assignee ? `With ${t.assignee.name}` : 'Not given to anybody yet')),
        what(t),
        t.sentBack ? h('p.small.form-error', `Sent back by an admin: ${t.sentBack}`) : null,
        t.answer && t.state !== 'answered' ? h('p.small', `${t.kind === 'unbilled' ? 'Note' : 'Answer'}: ${t.answer} (${t.answeredBy})`) : null,
        t.state === 'answered' ? h('div.sh-waiting',
          h('span', `⏳ Waiting for an admin: ${t.answer} (${t.answeredBy})`),
          admin ? [
            h('button.btn.primary', { type: 'button', onclick: async () => { try { await api(`/todo/${t.id}/decide`, { method: 'POST', body: { approve: true } }); await re('Approved and closed.'); } catch (err) { fail(said)(err); } } }, 'Approve'),
            h('input', { type: 'text', maxlength: '400', placeholder: 'Why it goes back', class: 'sh-todo-back' }),
            h('button.btn', {
              type: 'button',
              onclick: async (e) => {
                const why = e.target.previousSibling?.value || '';
                try { await api(`/todo/${t.id}/decide`, { method: 'POST', body: { approve: false, note: why } }); await re('Sent back.'); } catch (err) { fail(said)(err); }
              },
            }, 'Send back'),
          ] : null) : null,
        t.state === 'closed'
          ? h('div.sh-done', h('span', `✓ ${t.closedWhy || 'Closed'}${t.closedBy && t.closedBy !== 'Insight' ? ` (${t.closedBy})` : ''}`))
          : t.state === 'open' ? h('div.sh-answers', box, h('button.btn.primary', { type: 'button', onclick: send },
            t.kind === 'unbilled' ? 'Save note' : admin ? 'Close with this answer' : 'Send answer')) : null,
        adminRow, said);
    };

    const counts = d.counts;
    const days = h('input', { type: 'number', min: '0', max: '90', value: String(d.unbilledDays), style: 'width:5rem' });
    const setSaid = h('span.small');
    mount(v,
      notice,
      h('div.card.sh-todo-head',
        h('div',
          h('h2', admin ? 'Money to-do' : 'Your money to-do'),
          h('p.sub', admin
            ? 'Raised from the cash POs and Odoo’s bills each night, and shared out among the supervisors. Answers wait for you here.'
            : 'Given to you from the cash POs and Odoo’s bills. Your answers go to an admin to approve.')),
        h('div.sh-todo-counts',
          h('span', h('b', String(counts.open)), ' open'),
          h('span', h('b', String(counts.answered)), ' waiting for an admin'),
          admin && counts.unassigned ? h('span', h('b', String(counts.unassigned)), ' with nobody') : null)),
      h('div.sh-todo-bar',
        admin ? h('select', { onchange: (e) => { who = e.target.value; paint(); } },
          h('option', { value: 'all', selected: who === 'all' }, 'Everybody'),
          h('option', { value: 'waiting', selected: who === 'waiting' }, 'Waiting for me'),
          h('option', { value: 'none', selected: who === 'none' }, 'Nobody yet'),
          d.supervisors.map((s) => h('option', { value: String(s.id), selected: who === String(s.id) }, `${s.name} (${s.load})`))) : null,
        h('label.small', h('input', { type: 'checkbox', checked: showClosed, onchange: (e) => { showClosed = e.target.checked; paint(); } }), ' Show closed'),
        admin ? h('span.small.sh-todo-days', 'Raise a cash PO with no bill after ', days, ' days ',
          h('button.btn', {
            type: 'button',
            onclick: async () => { try { await api('/todo/settings', { method: 'POST', body: { unbilledDays: days.value } }); await re('Saved.'); } catch (err) { fail(setSaid)(err); } },
          }, 'Save'), setSaid) : null),
      admin && !d.supervisors.length ? banner('warning', 'There are no supervisors in Insight, so nothing can be given out. Items stay here for you.') : null,
      items.length ? h('div.sh-todo-list', items.map(card))
        : h('div.card', h('p.muted', showClosed ? 'Nothing closed yet.' : 'Nothing to do.')));
  }
  await paint();
}
