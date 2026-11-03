import { h, money, mount } from '../util.js';
import { api } from '../api.js';

/**
 * The money to-do list: its items, as the Inbox shows them.
 *
 * Cash POs Odoo has no bill for, payments that are not what their PO says,
 * POs Odoo has no posted bill for however they were paid, and POs still using
 * a stand-in vendor or item. Each is given
 * to a supervisor; a supervisor sees their own, an admin sees everybody's and
 * decides the answers.
 *
 * The Inbox lists them with everything else to act on; this file says what
 * each line reads and what opens beside it.
 */

const dayText = (day) => (day ? new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
const FROM = { drawer: 'the drawer', safe: 'the safe' };
const STOCK = ['stockmatch', 'stockshort', 'stocklate', 'stockkept'];
const STORE = { breakfast: 'the breakfast store', maintenance: 'the Maintenance store' };
const qty = (n) => String(Math.round(Number(n) * 1000) / 1000);
const fail = (said) => (err) => { said.textContent = err.message; said.className = 'small form-error'; };

/** How long a store request has waited: minutes, then hours. */
const waitedSince = (at) => {
  const m = at ? Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60000)) : null;
  return m == null ? '–' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/** The day the item counts from: the cash leaving, or the bill's date. */
const dayOf = (t) => t.detail?.paidDay || t.detail?.orderedOn || t.detail?.day || t.day || String(t.openedAt || '').slice(0, 10);
export const todoAge = (t, today) => {
  const day = dayOf(t);
  if (!day) return 0;
  return Math.max(0, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86_400_000));
};
export const ageTone = (days) => (days >= 21 ? 'old' : days >= 14 ? 'aging' : '');
export const supplierOf = (t) => (t.kind === 'store' ? t.detail?.department || 'Kitchen' : ['nopo', ...STOCK].includes(t.kind) ? t.detail?.supplier : t.detail?.vendor) || 'No supplier named';
function what(t, after) {
  const d = t.detail || {};
  if (t.kind === 'stockmatch') return whichStore(t, after);
  if (t.kind === 'stockshort') {
    return [
      h('p', `${d.item}: ${qty(d.received)} of ${qty(d.expected)} ${d.unit || ''} received in ${STORE[d.app] || 'the store'}${d.by ? ` by ${d.by}` : ''}. The rest of ${d.po} did not come.`),
      h('p.small.muted', 'Ask the supplier for the rest, or have the PO corrected in Odoo. Close this when it is sorted.'),
    ];
  }
  if (t.kind === 'stocklate') {
    return [
      h('p', `${d.po} from ${d.supplier || 'a supplier'} is still on its way in ${STORE[d.app] || 'the store'}, since ${dayText(d.since)}:`),
      h('ul.td-lines', (d.lines || []).map((l) => h('li', h('b', l.item), ` ${qty(l.qty)}${l.unit ? ` ${l.unit}` : ''}`))),
      h('p.small.muted', 'Find out whether it came. Once the storekeeper says Received, or the PO is cancelled in Odoo, this closes by itself.'),
    ];
  }
  if (t.kind === 'stockkept') {
    return [
      h('p', `${d.po} was cancelled in Odoo after ${d.item} (${qty(d.qty)} ${d.unit || ''}) went into ${STORE[d.app] || 'the store'}, and the store could not take it back${d.reason ? `: ${d.reason}` : '.'}`),
      h('p.small.muted', 'Correct the count in the store, then close this.'),
    ];
  }
  if (t.kind === 'store') {
    return [
      h('p', `${d.askedBy || 'Somebody'} in ${d.department || 'the kitchen'} asked the store room for, needed ${d.neededText || 'now'}${d.follows ? ` (the rest of ${d.follows})` : ''}:`),
      h('ul.td-lines', (d.lines || []).map((l) => h('li', h('b', l.name), ` ${l.asked}${l.unit ? ` ${l.unit}` : ''}`))),
      d.note ? h('p.small', `“${d.note}”`) : null,
      h('p.small.muted', 'Issue it in the breakfast app. Whoever has this is reminded on their phone every 15 minutes until it is issued, declined or cancelled there; then this closes by itself.'),
      d.url ? h('p', h('a.btn.primary', { href: d.url, target: '_blank', rel: 'noopener' }, 'Issue it in the breakfast app')) : null,
    ];
  }
  if (t.kind === 'placeholder') {
    const needs = [d.vendorToConfirm ? 'the vendor' : null, d.itemToConfirm ? 'the item' : null].filter(Boolean);
    return [
      h('p', `${d.po}${d.ref ? ` (${d.ref})` : ''}, ${money(d.poTotal)}, ordered ${dayText(d.orderedOn)}, still has a stand-in for ${needs.join(' and ') || 'its vendor or item'}: Insight could not match the receipt it came from.`),
      d.origin ? h('p.small.muted', `Made from: ${d.origin}`) : null,
      h('p.small.muted', 'Open it in Odoo and put in the real vendor and item. This item closes by itself once Odoo is read again.'),
      d.url ? h('p', h('a.btn.primary', { href: d.url, target: '_blank', rel: 'noopener' }, `Open ${d.po} in Odoo`)) : null,
    ];
  }
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

/**
 * "Which store?": a product Odoo has that neither store knows. Choose the
 * store and its item (or a new one) and how many of the store's unit one Odoo
 * unit is; or Not stock. Asked once per product.
 */
function whichStore(t, after) {
  const d = t.detail || {};
  const said = h('span.small');
  const form = h('div.ws-form');
  const options = [['breakfast', 'Breakfast store', 'an ingredient or supply'], ['maintenance', 'Maintenance store', 'a part or material'], ['none', 'Not stock', 'leave it alone']];
  const buttons = options.map(([k, label, sub]) => h('button.ws-opt', { type: 'button', 'aria-pressed': 'false', onclick: () => choose(k) }, h('b', label), h('small', sub)));
  const send = async (body, message) => {
    said.textContent = 'Sending…'; said.className = 'small';
    try { await api('/stock/match', { method: 'POST', body: { productId: d.productId, uomId: d.uomId, ...body } }); await after(message); } catch (err) { fail(said)(err); }
  };
  async function choose(app) {
    options.forEach(([k], i) => buttons[i].setAttribute('aria-pressed', String(k === app)));
    if (app === 'none') {
      mount(form, h('button.btn.primary', { type: 'button', onclick: () => send({ app: 'none' }, 'Not stock: it will be left alone.') }, 'Leave it alone'));
      return;
    }
    mount(form, h('p.small.muted', 'Reading the store’s list…'));
    let items = [];
    try { items = (await api(`/stock/items?app=${app}`)).items || []; } catch (err) { mount(form, h('p.small.form-error', err.message)); return; }
    const pick = h('select', { 'aria-label': 'Which item' }, h('option', { value: '' }, 'Choose the item…'),
      items.map((i) => h('option', { value: String(i.id) }, `${i.name}${i.unit ? ` (${i.unit})` : ''}`)), h('option', { value: '+' }, '+ A new one'));
    const name = h('input', { type: 'text', maxlength: '120', value: d.product || '', 'aria-label': 'New item’s name' });
    const unit = h('input', { type: 'text', maxlength: '30', placeholder: 'kg, L, each', 'aria-label': 'New item’s unit' });
    const fresh = h('div.ws-new', { hidden: true }, h('label', 'Name ', name), h('label', 'Unit ', unit));
    const factor = h('input', { type: 'number', min: '0', step: 'any', value: '1', 'aria-label': 'How many of the store’s unit' });
    const unitWord = h('span', 'of the store’s unit');
    pick.onchange = () => {
      fresh.hidden = pick.value !== '+';
      const it = items.find((i) => String(i.id) === pick.value);
      unitWord.textContent = it?.unit ? it.unit : 'of the store’s unit';
    };
    mount(form,
      h('label.ws-row', 'Which item ', pick), fresh,
      h('label.ws-row', `One “${d.uom || 'unit'}” in Odoo is `, factor, ' ', unitWord),
      h('button.btn.primary', { type: 'button', onclick: () => send({
        app, factor: factor.value,
        ...(pick.value === '+' ? { newItem: { name: name.value, unit: unit.value } } : { itemId: pick.value }),
      }, `Sent to ${STORE[app]}.`) }, 'Send it there'));
  }
  return [
    h('p', `${d.product}${d.uom ? ` (${d.uom})` : ''} is on ${(d.lines || []).map((l) => `${l.po} (${qty(l.qty)})`).join(', ')} from ${d.supplier || 'a supplier'}. Neither store knows it yet.`),
    h('p.small.muted', 'Say once where it goes; every later PO with it goes there too.'),
    h('div.ws-pick', buttons), form, said,
  ];
}

/** What the Inbox's line for an item says under its title. */
export function todoSub(t, { admin } = {}) {
  return [
    t.state === 'answered' ? 'waiting for an admin' : {
      unbilled: t.detail?.drafts?.length ? 'draft bill' : 'no bill', differs: 'paid ≠ PO', nopo: 'no PO',
      placeholder: [t.detail?.vendorToConfirm ? 'vendor' : null, t.detail?.itemToConfirm ? 'item' : null].filter(Boolean).join(' + ') + ' to confirm',
      store: `${(t.detail?.lines || []).length} item${(t.detail?.lines || []).length === 1 ? '' : 's'} · needed ${t.detail?.neededText || 'now'}`,
      stockmatch: 'which store?', stockshort: 'delivered short', stocklate: 'not received', stockkept: 'cancelled, stock stayed',
    }[t.kind],
    t.detail?.paidFrom ? (t.detail.paidFrom === 'safe' ? 'safe' : 'drawer') : (t.kind === 'unbilled' ? 'ordered' : null),
    admin ? (t.assignee?.name || 'nobody yet') : null,
  ].filter(Boolean).join(' · ');
}

/** The title of an item's line. */
export const todoTitle = (t) => (t.kind === 'nopo' ? `Bill · ${supplierOf(t)}` : t.kind === 'stockmatch' ? `Which store: ${t.ref}` : `${t.ref} · ${supplierOf(t)}`);

/**
 * One money to-do item in full, with what can be done about it. `ctx` is
 * { admin, supervisors, after(message) }; `after` reads everything again.
 */
export function todoDetail(t, { admin, supervisors = [], after }) {
  const said = h('span.small');
  const back = h('input', { type: 'text', maxlength: '400', placeholder: 'Why it goes back', 'aria-label': 'Why it goes back' });
  const reason = h('input', { type: 'text', maxlength: '400', placeholder: 'Why nothing is needed', 'aria-label': 'Why nothing is needed' });
  const fact = (label, value, cls = '') => h('div', h('small', label), h(`span${cls}`, value));
  const call = (path, body, message) => async () => {
    try { await api(path, { method: 'POST', body }); await after(message); } catch (err) { fail(said)(err); }
  };
  const d2 = t.detail || {};
  return h('div.card.td-detail',
    h('div.td-dhead',
      h('div',
        h('small.td-kind', t.kindLabel),
        h('h2', todoTitle(t))),
      t.kind === 'store' ? null : h('b.td-big.num', money(t.kind === 'differs' ? Math.abs(t.amount) : t.amount))),
    h('div.td-facts',
      t.kind === 'nopo'
        ? [fact('Bill dated', dayText(d2.day)), fact('Their number', d2.ref || '–')]
        : t.kind === 'store'
          ? [fact('Asked', d2.askedAt ? new Date(d2.askedAt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '–'), fact('Needed', d2.neededText || 'now')]
        : t.kind === 'placeholder'
          ? [fact('Ordered', dayText(d2.orderedOn)), fact('To put right', [d2.vendorToConfirm ? 'Vendor' : null, d2.itemToConfirm ? 'Item' : null].filter(Boolean).join(' and ') || '–')]
        : STOCK.includes(t.kind)
          ? [fact('Confirmed', dayText(t.day)), fact('Store', t.kind === 'stockmatch' ? 'not known yet' : (STORE[d2.app] || '–').replace(/^the /, ''))]
        : d2.paidFrom
          ? [fact('Paid from', FROM[d2.paidFrom] || d2.paidFrom), fact('On', dayText(d2.paidDay))]
          : [fact('Ordered', dayText(d2.orderedOn)), fact('Paid', 'not from the drawer or safe')],
      t.kind === 'store' ? fact('Waiting', waitedSince(d2.askedAt)) : fact('Waiting', `${t.age} days`, `.td-age.${ageTone(t.age)}`),
      fact('With', t.assignee?.name || 'Nobody yet')),
    what(t, after),
    t.sentBack ? h('p.small.form-error', `Sent back by an admin: ${t.sentBack}`) : null,
    t.answer && t.state !== 'answered' ? h('p.small', `${['unbilled', 'placeholder', 'store', ...STOCK].includes(t.kind) ? 'Latest note' : 'Answer'}: ${t.answer} (${t.answeredBy})`) : null,
    t.state === 'answered' ? h('div.sh-waiting',
      h('span', `⏳ Waiting for an admin: ${t.answer} (${t.answeredBy})`),
      admin ? [
        h('button.btn.primary', { type: 'button', onclick: call(`/todo/${t.id}/decide`, { approve: true }, 'Approved and closed.') }, 'Approve'),
        back,
        h('button.btn', { type: 'button', onclick: () => call(`/todo/${t.id}/decide`, { approve: false, note: back.value }, 'Sent back.')() }, 'Send back'),
      ] : null) : null,
    t.state === 'closed'
      ? h('div.sh-done', h('span', `✓ ${t.closedWhy || 'Closed'}${t.closedBy && t.closedBy !== 'Insight' ? ` (${t.closedBy})` : ''}`))
      : null,
    admin && t.state !== 'closed' ? h('div.td-admin',
      h('label.small', 'With ', h('select', {
        onchange: (e) => call(`/todo/${t.id}/assign`, { accountId: Number(e.target.value) }, 'Given to somebody else.')(),
      }, !t.assignee ? h('option', { value: '', selected: true }, 'nobody yet') : null,
      supervisors.map((s) => h('option', { value: String(s.id), selected: t.assignee?.id === s.id }, s.name)))),
      h('span.td-dismiss', reason, h('button.btn', {
        type: 'button', onclick: () => call(`/todo/${t.id}/dismiss`, { note: reason.value }, 'Closed: nothing needed.')(),
      }, 'Nothing needed'))) : null,
    said);
}
