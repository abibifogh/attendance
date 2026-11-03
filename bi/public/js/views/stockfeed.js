import { h, mount, money } from '../util.js';
import { api } from '../api.js';

/**
 * Buying › Stock from Odoo (admins): every line of every confirmed PO, and
 * which store it went to, the breakfast store or the Maintenance store; and
 * the settings: when it becomes stock, who answers "Which store?", and from
 * which day. Insight reads Odoo every 15 minutes; Read Odoo now does it at once.
 */
const STATE = {
  recorded: ['In stock', 'ok'], received: ['Received', 'ok'], expected: ['On its way', 'way'], already: ['Already there', 'ok'],
  ask: ['Which store?', 'ask'], none: ['Not stock', 'no'], waiting: ['Waiting', 'no'], new: ['Waiting', 'no'],
  cancelled: ['Cancelled', 'no'], kept: ['Cancelled, stock stayed', 'ask'],
};
const STORE = { breakfast: 'Breakfast', maintenance: 'Maintenance' };
const cedis = (ghs) => money(Math.round(Number(ghs || 0) * 100), { places: 0 });
const qty = (n) => (n == null ? '—' : String(Math.round(Number(n) * 1000) / 1000));
const dayText = (day) => (day ? new Date(`${String(day).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
const ago = (at) => {
  if (!at) return 'not read yet';
  const m = Math.max(0, Math.round((Date.now() - Date.parse(`${String(at).replace(' ', 'T')}Z`)) / 60000));
  return m < 1 ? 'read just now' : m < 60 ? `read ${m} min ago` : m < 1440 ? `read ${Math.floor(m / 60)} h ago` : `read ${Math.floor(m / 1440)} days ago`;
};

export async function renderStockFeed(root) {
  const said = h('p.small.sf-said');
  let data;

  async function load(path = '/stock', opts) {
    try { data = await api(path, opts); } catch (err) { mount(root, h('div.card', h('h2', 'That did not work'), h('p', err.message))); return; }
    paint();
  }

  const tile = (label, n, sub, tone = '') => h(`div.sf-tile${tone ? `.${tone}` : ''}`, h('small', label), h('b', String(n)), h('em', sub));

  function paint() {
    const t = data.tiles;
    const s = data.settings;
    const last = data.last || {};
    const off = Object.entries(last.said || {}).filter(([, v]) => v !== 'ok');
    mount(root, h('div.sf',
      h('div.sf-head',
        h('h1', 'Stock from Odoo'), h('span.sp'),
        h(`span.sf-chip.${last.error ? 'ask' : 'ok'}`, last.error ? 'Odoo not read' : ago(last.at)),
        h('button.btn', { type: 'button', onclick: async (e) => { e.target.disabled = true; said.textContent = 'Reading Odoo…'; await load('/stock/run', { method: 'POST', body: {} }); } }, 'Read Odoo now')),
      h('p.sf-lede', 'Every line of every confirmed PO goes to the store it belongs to: the breakfast store or the Maintenance store. Each store records its own stock; Insight never counts or changes it.'),
      last.error ? h('p.small.sf-warn', `Odoo could not be read: ${last.error}`) : null,
      off.length ? h('p.small.sf-warn', `Not read just now: ${off.map(([k, v]) => `the ${STORE[k] || k} store (${v})`).join('; ')}. Its lines are tried again in 15 minutes.`) : null,
      said,
      h('div.sf-tiles',
        tile('On its way', t.onTheWay, 'waiting for a storekeeper to say Received', 'bl'),
        tile('Into the breakfast store', t.breakfast.lines, `this week · ${cedis(t.breakfast.value)}`, 'gr'),
        tile('Into the Maintenance store', t.maintenance.lines, `this week · ${cedis(t.maintenance.value)}`, 'gr'),
        tile('Which store?', t.ask, 'new products, asked once in To sort out', t.ask ? 'am' : ''),
        tile('Not stock', t.none, 'this week: fuel, services, transport', '')),
      h('div.sf-grid',
        h('section.card.sf-lines',
          h('div.sf-row', h('h3', 'The last two weeks, line by line'), h('span.sp'),
            ['way', 'ok', 'ask', 'no'].map((k) => h(`span.sf-chip.${k}`, { way: 'On its way', ok: 'In stock', ask: 'Which store?', no: 'Not stock' }[k]))),
          data.pos.length ? h('div.sf-tablewrap', h('table.sf-table',
            h('thead', h('tr', h('th', 'Odoo line'), h('th', 'Goes to'), h('th.n', 'In Odoo'), h('th.n', 'In the store'), h('th', 'Now'))),
            h('tbody', data.pos.map((p) => [
              h('tr.sf-po', h('td', { colspan: '5' }, h('b', `${p.po} · ${p.supplier || 'a supplier'}`), h('small', ` · confirmed ${dayText(p.confirmedOn)} · ${cedis(p.total)}`))),
              p.lines.map((l) => {
                const [word, tone] = STATE[l.state] || [l.state, 'no'];
                const short = l.state === 'received' && l.received != null && l.storeQty != null && Number(l.received) < Number(l.storeQty);
                return h('tr',
                  h('td', l.product),
                  h('td', l.app && STORE[l.app] ? h('span.sf-chip.' + l.app, `${STORE[l.app]}${l.item ? ` · ${l.item}` : ''}`) : l.state === 'ask' ? h('span.sf-chip.ask', 'Which store?') : l.state === 'none' ? h('span.sf-chip.no', 'Not stock') : h('span.small.muted', '—')),
                  h('td.n', `${qty(l.qty)} ${l.uom || ''}`, h('small', `${cedis(l.price)} each`)),
                  h('td.n', l.storeQty != null ? `${qty(l.storeQty)} ${l.storeUnit || ''}` : '—', l.unitCost != null && l.storeQty != null ? h('small', `${cedis(l.unitCost)} each`) : null),
                  h('td', h(`span.sf-chip.${tone}`, word),
                    short ? h('small.sf-short', `${qty(Number(l.storeQty) - Number(l.received))} short`) : null,
                    l.receivedBy ? h('small', `${l.receivedBy}`) : null,
                    l.note && !['recorded', 'received'].includes(l.state) ? h('small', l.note) : null));
              }),
            ])))) : h('p.muted', `Nothing yet. POs confirmed in Odoo on or after ${dayText(s.from) || 'the first day'} show here.`)),
        settingsCard(s)),
    ));
  }

  function settingsCard(s) {
    const err = h('p.small.form-error');
    const save = async (body, message) => {
      err.textContent = '';
      try { await api('/stock/settings', { method: 'POST', body }); said.textContent = message; await load(); } catch (e) { err.textContent = e.message; }
    };
    const SUB = {
      confirmed: 'Stock goes up as soon as the PO is confirmed in Odoo. Nobody taps anything in the store.',
      store: 'It shows as "On its way" in the store’s Deliveries, filled in. One tap; change the number if the delivery is short.',
      odoo: 'Only if goods are received in Odoo itself: it goes in once Odoo says the line is received.',
    };
    const from = h('input', { type: 'date', value: s.from || '' });
    return h('section.card.sf-set',
      h('h3', 'When it becomes stock'),
      Object.entries(data.modes).map(([k, label]) => h(`button.sf-opt${s.mode === k ? '.on' : ''}`, {
        type: 'button', 'aria-pressed': String(s.mode === k), onclick: () => save({ mode: k }, `It becomes stock: ${label.toLowerCase()}.`),
      }, h('b', h('i'), label), h('small', SUB[k]))),
      h('label.sf-field', h('small', '“Which store?” is asked of'),
        h('select', { onchange: (e) => save({ askTo: e.target.value ? Number(e.target.value) : null }, 'Saved.') },
          h('option', { value: '', selected: !s.askTo }, 'Nobody chosen: shared out'),
          data.people.map((p) => h('option', { value: String(p.id), selected: s.askTo === p.id }, `${p.name}${p.role === 'admin' ? ' (admin)' : ''}`)))),
      h('label.sf-field', h('small', 'Start from POs confirmed on'), from),
      h('button.btn.sf-save', { type: 'button', onclick: () => save({ from: from.value }, 'Saved.') }, 'Save the day'),
      h('p.small.muted', 'Lines already brought in by hand in a store are skipped, so nothing goes on the shelf twice.'),
      err);
  }

  mount(root, h('p.muted', 'Loading…'));
  await load();
}

/** Settings › Rules › Stock: when a line becomes stock, and from which day. Who answers “Which store?” is under Who gets what. */
export async function renderStockRules(root) {
  let data;
  try { data = await api('/stock'); } catch (err) { mount(root, h('div.card', h('h2', 'That did not work'), h('p', err.message))); return; }
  const s = data.settings;
  const said = h('p.small');
  const save = async (body) => {
    said.textContent = 'Saving…'; said.className = 'small';
    try { await api('/stock/settings', { method: 'POST', body }); await renderStockRules(root); } catch (e) { said.textContent = e.message; said.className = 'small form-error'; }
  };
  const SUB = {
    confirmed: 'Stock goes up as soon as the PO is confirmed in Odoo. Nobody taps anything in the store.',
    store: 'It shows as “On its way” in the store’s Deliveries, filled in. One tap; change the number if the delivery is short.',
    odoo: 'Only if goods are received in Odoo itself: it goes in once Odoo says the line is received.',
  };
  const from = h('input', { type: 'date', value: s.from || '' });
  mount(root, h('div.card.sf-set',
    h('h2', 'Stock from Odoo'),
    h('h3', 'When it becomes stock'),
    Object.entries(data.modes).map(([k, label]) => h(`button.sf-opt${s.mode === k ? '.on' : ''}`, { type: 'button', 'aria-pressed': String(s.mode === k), onclick: () => save({ mode: k }) }, h('b', h('i'), label), h('small', SUB[k]))),
    h('label.sf-field', h('small', 'Start from POs confirmed on'), from),
    h('button.btn.sf-save', { type: 'button', onclick: () => save({ from: from.value }) }, 'Save the day'),
    h('p.small.muted', 'Who answers “Which store?”: Settings › Who gets what. What came through: Buying & stock › Stock from Odoo.'),
    said));
}

