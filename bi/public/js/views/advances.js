import { h, mount, money } from '../util.js';
import { api } from '../api.js';
import { banner } from './components.js';

/**
 * Advances, under To-do.
 *
 * Cash given out of a drawer before a purchase, against a PO still waiting
 * for approval, and POs whose final price is not what left the drawer. One
 * line each, with one status: what it is waiting for, or what it came to.
 *
 * Whoever an admin gave "See and act" can give an advance more time (the
 * next shifts can close meanwhile) or close it with a reason.
 */

const dayText = (day) => (day ? new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
const SLOT = { morning: 'morning', afternoon: 'afternoon', night: 'night' };
const when = (x) => `${dayText(x.day)}${x.slot ? ` ${SLOT[x.slot] || x.slot}` : ''}`;
const today = () => new Date().toISOString().slice(0, 10);

/** The one status a line shows, and its tone. */
function statusOf(x) {
  const amount = x.diff ? money(Math.abs(x.diff)) : '';
  switch (x.status) {
    case 'approve': return x.overdue ? ['short', 'Approve in Odoo · overdue'] : ['over', 'Approve in Odoo'];
    case 'report': return x.overdue ? ['short', 'Report on form · overdue'] : ['over', 'Report on form'];
    case 'cancelled': return ['short', 'Cancelled in Odoo'];
    case 'refund': return x.old ? ['short', `Refund ${amount} · for admins`] : ['over', `Refund ${amount}`];
    case 'deficit': return x.old ? ['short', `Deficit ${amount} · for admins`] : ['over', `Deficit ${amount}`];
    case 'refund_not_in_assd': return ['short', 'Refund not in ASSD'];
    case 'closed': return ['none', 'Closed'];
    default: return ['ok', '✓ Settled'];
  }
}

const ASSD = { matched: '✓ in ASSD', differs: 'ASSD shows a different amount', missing: 'not in ASSD', unread: 'ASSD not loaded for that shift' };

export async function advancesPanel(v) {
  let d = null;
  let showAll = false;
  let open = null;

  async function load(notice = null) {
    mount(v, h('p.muted', 'Reading advances…'));
    try { d = await api('/advances'); } catch (err) { mount(v, banner('problem', err.message)); return; }
    draw(notice);
  }

  function draw(notice = null) {
    const live = d.items.filter((x) => !['settled', 'closed'].includes(x.status));
    const items = showAll ? d.items : live;
    mount(v,
      notice,
      h('div.card.sh-todo-head',
        h('div',
          h('h2', 'Advances'),
          h('p.sub', 'Cash given out before a purchase, and POs whose final price differs from what the drawer paid. '
            + 'An advance holds up the next shift until it is approved in Odoo and reported on the expense form.')),
        h('div.sh-todo-counts',
          h('span', h('b', String(live.length)), ' open'),
          h('span', h('b', money(d.outstanding || 0)), ' still out'),
          d.needsYou ? h('span', h('b', String(d.needsYou)), ' need you') : null)),
      d.formLive ? null : banner('warning', 'The expense form is not connected yet, so nothing waits for it: an approved PO counts as reported. See the Advances guide to connect it.'),
      d.odoo === false ? banner('warning', 'Odoo could not be read just now, so statuses may be out of date.') : null,
      h('div.td-bar',
        h('label.small', h('input', { type: 'checkbox', checked: showAll, onchange: (e) => { showAll = e.target.checked; draw(); } }), ' Show settled and closed')),
      h('div.card.adv-list',
        items.length ? items.map(row) : h('p.muted.td-empty', showAll ? 'No advances or price differences in the last two months.' : 'Nothing open. Every advance is settled.')),
      d.elsewhere?.length ? h('details.card.adv-else',
        h('summary', `On the expense form, not paid from a drawer · ${d.elsewhere.length}`),
        h('p.small.muted', 'Paid some other way (the safe, a transfer, a supplier account). Listed for reference, never chased.'),
        h('div.adv-elist', d.elsewhere.map((e) => h('div', h('b', e.po), ` ${money(e.total)}`, h('span.muted', ` · ${String(e.at || '').slice(0, 10)}`))))) : null);
  }

  function row(x) {
    const [tone, label] = statusOf(x);
    const isOpen = open === x.po;
    return h('div.adv-row', { dataset: { po: x.po } },
      h('button.adv-line', { type: 'button', 'aria-expanded': String(isOpen), onclick: () => { open = isOpen ? null : x.po; draw(); } },
        h('span.adv-po', h('b', x.po), h('span.muted', ` ${x.vendor || ''}`)),
        h('span.adv-amt', money(x.advance ? x.advanced : x.paid)),
        h('span.adv-who.small', `${x.advance ? 'Advanced' : 'Paid'} ${when(x)}${x.by ? ` · ${x.by}` : ''}`),
        h(`span.sh-chip.${tone}`, label)),
      isOpen ? detail(x) : null);
  }

  function detail(x) {
    const said = h('span.small');
    const facts = [
      ['Odoo', x.state ? `${x.state}${x.total != null ? ` · ${money(x.total)}` : ''}` : 'not read'],
      ['Expense form', x.reported?.together ? 'reported on one response with other POs' : x.reported ? `${money(x.reported.amount)} + ${money(x.reported.tnt)} TnT = ${money(x.reported.total)}${x.amountDiffers ? ' · not the PO’s total' : ''}` : d.formLive ? 'not reported yet' : 'not connected'],
      ['From drawers', money(x.paid)],
      x.advance ? ['Next shift', `${when(x.due)}${x.overdue ? ' · overdue' : ''}`] : null,
    ].filter(Boolean);
    return h('div.adv-detail',
      h('dl.adv-dl', facts.flatMap(([k, val]) => [h('dt', k), h('dd', val)])),
      x.moves.length ? h('div.adv-moves', x.moves.map((m) => h('div.small',
        `${m.kind === 'change' ? 'Refund' : 'Top-up'} ${money(Math.abs(m.paid))} on ${when(m)}${m.who ? ` (${m.who})` : ''}: `,
        h(`span.sh-chip.${m.assd === 'matched' ? 'ok' : m.assd === 'missing' ? 'short' : 'none'}`, ASSD[m.assd] || ''),
        m.variance != null && m.assd !== 'matched' ? h('span.muted', ` shift variance ${money(m.variance)}`) : null))) : null,
      x.decision ? h('p.small', x.decision.closed ? `Closed by ${x.decision.by || 'an admin'}: ${x.decision.reason || ''}` : `More time until ${dayText(x.decision.until)}, by ${x.decision.by || 'an admin'}${x.decision.reason ? `: ${x.decision.reason}` : ''}`) : null,
      d.canAct ? actions(x, said) : null,
      said);
  }

  function actions(x, said) {
    const send = async (body, button) => {
      button.disabled = true; said.textContent = 'Saving…'; said.className = 'small';
      try { await api('/advances/decide', { method: 'POST', body: { po: x.po, ...body } }); await load(banner('good', 'Saved.')); }
      catch (err) { said.textContent = err.message; said.className = 'small form-error'; button.disabled = false; }
    };
    if (x.decision?.closed) {
      return h('div.adv-act', h('button.btn', { type: 'button', onclick: (e) => send({ action: 'reopen' }, e.target) }, 'Reopen'));
    }
    const until = h('input', { type: 'date', min: today(), 'aria-label': 'More time until' });
    const reason = h('input', { type: 'text', maxlength: 300, placeholder: 'Reason', 'aria-label': 'Reason' });
    return h('div.adv-act',
      x.advance && !x.settled ? h('span.adv-group', until,
        h('button.btn', { type: 'button', onclick: (e) => send({ action: 'more', until: until.value, reason: reason.value }, e.target) }, 'More time')) : null,
      h('span.adv-group', reason,
        h('button.btn', { type: 'button', onclick: (e) => send({ action: 'close', reason: reason.value }, e.target) }, 'Close')));
  }

  await load();
}
