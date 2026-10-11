import { h, money } from '../util.js';
import { api } from '../api.js';
import { banner } from './components.js';

/**
 * Advances, as the Inbox shows them.
 *
 * Cash given out of a drawer before a purchase, against a PO still waiting
 * for approval, and POs whose final price is not what left the drawer. One
 * status each, in the same words HIVE uses: Approve in Odoo, Report on form,
 * Refund, Deficit, Counted.
 *
 * Whoever an admin gave "See and act" can give an advance more time (the
 * next shifts can close meanwhile) or close it with a reason.
 */

const dayText = (day) => (day ? new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
const SLOT = { morning: 'morning', afternoon: 'afternoon', night: 'night' };
export const advanceWhen = (x) => `${dayText(x.day)}${x.slot ? ` ${SLOT[x.slot] || x.slot}` : ''}`;
const today = () => new Date().toISOString().slice(0, 10);

/** Whether an advance or difference still needs somebody. */
export const advanceOpen = (x) => !['settled', 'closed'].includes(x.status);

/** The one status a line shows, and its tone (sh-chip class). */
export function advanceStatus(x) {
  const amount = x.diff ? money(Math.abs(x.diff)) : '';
  switch (x.status) {
    case 'approve': return x.overdue ? ['short', 'Approve in Odoo · overdue'] : ['over', 'Approve in Odoo'];
    case 'report': return x.overdue ? ['short', 'Report on form · overdue'] : ['over', 'Report on form'];
    case 'cancelled': return ['short', 'Cancelled'];
    case 'refund': return x.old ? ['short', `Refund ${amount} · for admins`] : ['ok', `Refund ${amount}`];
    case 'deficit': return x.old ? ['short', `Deficit ${amount} · for admins`] : ['over', `Deficit ${amount}`];
    case 'refund_not_in_assd': return ['short', 'Refund not in ASSD'];
    case 'closed': return ['none', 'Closed'];
    default: return ['ok', '✓ Counted'];
  }
}

const ASSD = { matched: '✓ in ASSD', differs: 'ASSD shows a different amount', missing: 'not in ASSD', unread: 'ASSD not loaded for that shift' };

/**
 * One advance in full: what Odoo, the form and the drawers say, and More
 * time or Close. `ctx` is { canAct, formLive, after(notice) }.
 */
export function advanceDetail(x, ctx) {
  const said = h('span.small');
  const [tone, label] = advanceStatus(x);
  const facts = [
    ['Odoo', x.state ? `${x.state}${x.total != null ? ` · ${money(x.total)}` : ''}` : 'not read'],
    ['Expense form', x.reported?.together ? 'reported on one response with other POs'
      : x.reported ? `${money(x.reported.amount)} + ${money(x.reported.tnt)} TnT = ${money(x.reported.total)}${x.amountDiffers ? ' · not the PO’s total' : ''}`
        : ctx.formLive ? 'not reported yet' : 'not connected'],
    ['From drawers', money(x.paid)],
    x.advance ? ['Due by', `${advanceWhen(x.due)}${x.overdue ? ' · overdue' : ''}`] : null,
  ].filter(Boolean);
  return h('article.card.adv-detail',
    h('div.adv-dhead', h('h2', `${x.po}${x.vendor ? ` · ${x.vendor}` : ''}`), h(`span.sh-chip.${tone}`, label)),
    h('p.sh-sub', x.advance
      ? `Advance of ${money(x.advanced)} given out${x.by ? ` by ${x.by}` : ''} on ${advanceWhen(x)}.${x.overdue ? ' It is holding up every shift until it is settled.' : ''}`
      : `${money(x.paid)} paid from the drawer${x.by ? ` by ${x.by}` : ''} on ${advanceWhen(x)}.`),
    h('dl.adv-dl', facts.flatMap(([k, val]) => [h('dt', k), h('dd', val)])),
    x.moves.length ? h('div.adv-moves', x.moves.map((m) => h('div.small',
      `${m.kind === 'change' ? 'Refund' : 'Deficit'} ${money(Math.abs(m.paid))} on ${advanceWhen(m)}${m.who ? ` (${m.who})` : ''}: `,
      h(`span.sh-chip.${m.assd === 'matched' ? 'ok' : m.assd === 'missing' ? 'short' : 'none'}`, ASSD[m.assd] || ''),
      m.variance != null && m.assd !== 'matched' ? h('span.muted', ` shift variance ${money(m.variance)}`) : null))) : null,
    x.decision ? h('p.small', x.decision.closed
      ? `Closed by ${x.decision.by || 'an admin'}: ${x.decision.reason || ''}`
      : `More time until ${dayText(x.decision.until)}, by ${x.decision.by || 'an admin'}${x.decision.reason ? `: ${x.decision.reason}` : ''}`) : null,
    ctx.canAct ? actions(x, said, ctx) : null,
    said);
}

function actions(x, said, ctx) {
  const send = async (body, button) => {
    button.disabled = true; said.textContent = 'Saving…'; said.className = 'small';
    try { await api('/advances/decide', { method: 'POST', body: { po: x.po, ...body } }); await ctx.after(banner('good', 'Saved.')); } catch (err) { said.textContent = err.message; said.className = 'small form-error'; button.disabled = false; }
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

/**
 * Form entries no drawer paid: for reference, and an admin clears each once
 * looked at. `state` keeps the ticks and the open fold across repaints;
 * `after(notice)` reads everything again.
 */
export function elsewhereCard(d, state, after, redraw) {
  const list = d.elsewhere?.list || [];
  if (!list.length) return null;
  const picked = state.picked || (state.picked = new Set());
  for (const po of [...picked]) if (!list.some((e) => e.po === po)) picked.delete(po);
  const said = h('span.small');
  const clear = async (pos, button) => {
    button.disabled = true; said.textContent = 'Clearing…'; said.className = 'small';
    try {
      await api('/advances/clear', { method: 'POST', body: { pos } });
      picked.clear();
      const undo = h('button.btn', {
        type: 'button',
        onclick: async (e) => {
          e.target.disabled = true;
          try { await api('/advances/clear', { method: 'POST', body: { pos, restore: true } }); await after(banner('good', 'Put back.')); } catch (err) { e.target.disabled = false; e.target.textContent = err.message; }
        },
      }, 'Undo');
      await after(h('div.adv-undo', banner('good', `Cleared ${pos.length} from the list.`), undo));
    } catch (err) { said.textContent = err.message; said.className = 'small form-error'; button.disabled = false; }
  };
  const more = d.elsewhere.count > list.length ? ` (showing ${list.length})` : '';
  const line = (e) => [h('b', e.po), ` ${money(e.total)}`, h('span.muted', ` · ${String(e.at || '').slice(0, 10)}`)];
  return h('details.card.adv-else', { open: Boolean(state.open), ontoggle: (e) => { state.open = e.target.open; } },
    h('summary', `On the expense form, not paid from a drawer · ${d.elsewhere.count}${more}`),
    h('p.small.muted', 'Paid some other way (the safe, a transfer, a supplier account). Listed for reference, never chased.'
      + (d.canClear ? ' Clear each once you have looked at it.' : '')),
    d.canClear ? h('div.adv-clearbar',
      h('button.btn', { type: 'button', disabled: !picked.size, onclick: (e) => clear([...picked], e.target) }, picked.size ? `Clear ${picked.size} ticked` : 'Clear ticked'),
      h('button.btn', { type: 'button', onclick: (e) => clear(list.map((x) => x.po), e.target) }, `Clear all ${list.length} listed`),
      said) : null,
    h('div.adv-elist', list.map((e) => (d.canClear
      ? h('label.adv-erow',
        h('input', { type: 'checkbox', checked: picked.has(e.po), onchange: (ev) => { if (ev.target.checked) picked.add(e.po); else picked.delete(e.po); redraw(); } }),
        h('span', ...line(e)))
      : h('div', ...line(e))))));
}
