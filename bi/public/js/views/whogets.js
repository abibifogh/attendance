import { h, mount } from '../util.js';
import { api } from '../api.js';

/**
 * Settings › Who gets what › People to ask: every "this goes to a person" in
 * one table. The kitchen's store requests, POs with a stand-in vendor or item,
 * and "Which store?" for stock from Odoo are chosen here; what goes to
 * everybody in a role is said, so nobody has to look for it. The emails
 * (HIVE alerts, the management report, the prepaid summary) are the tabs
 * beside this one.
 */
export async function renderWhoGets(root) {
  const said = h('p.small.wg-said');
  mount(root, h('p.muted', 'Loading…'));
  let todo;
  let stock;
  try { [todo, stock] = await Promise.all([api('/todo'), api('/stock').catch(() => null)]); } catch (err) { mount(root, h('div.card', h('h2', 'That did not work'), h('p', err.message))); return; }
  const people = todo.placeholderPeople || stock?.people || [];
  const pick = (value, save) => h('select', {
    onchange: async (e) => {
      said.textContent = 'Saving…'; said.className = 'small wg-said';
      try { await save(e.target.value || null); said.textContent = 'Saved.'; } catch (err) { said.textContent = err.message; said.className = 'small wg-said form-error'; }
    },
  }, h('option', { value: '', selected: !value }, 'Shared out among supervisors'),
  people.map((p) => h('option', { value: String(p.id), selected: Number(value) === Number(p.id) }, `${p.name}${p.role === 'admin' ? ' (admin)' : ''}`)));
  const fixed = (text) => h('span.wg-fixed', text);
  const row = (what, sub, to, how) => h('tr', h('td', h('b', what), sub ? h('small', sub) : null), h('td', to), h('td', how));
  mount(root, h('div.card',
    h('h2', 'Who gets what'),
    h('p.small.muted', 'Every to-do and notice that goes to a person, and how they are told. Pages with their own setting (Stock from Odoo) open the same choice.'),
    h('div.wg-wrap', h('table.wg-table',
      h('thead', h('tr', h('th', 'What'), h('th', 'Goes to'), h('th', 'How'))),
      h('tbody',
        row('Kitchen store requests', 'From the breakfast app, while they wait to be issued', pick(todo.storeTo, (v) => api('/todo/settings', { method: 'POST', body: { storeTo: v ?? '' } })), 'To sort out · an email · a push every 15 minutes until issued'),
        row('POs with a stand-in vendor or item', '“Vendor to confirm” or the stand-in item, until Odoo has the real ones', pick(todo.placeholderTo, (v) => api('/todo/settings', { method: 'POST', body: { placeholderTo: v ?? '' } })), 'To sort out'),
        stock ? row('Which store? (Stock from Odoo)', 'A product neither store knows, asked once', pick(stock.settings?.askTo, (v) => api('/stock/settings', { method: 'POST', body: { askTo: v ? Number(v) : null } })), 'To sort out · a push') : null,
        row('Nice Place: a shift sent, or not sent 15 minutes after it ends', null, fixed('Admins, and supervisors who read Nice Place’s counters'), 'Notifications · a push'),
        row('The 07:00 list', 'Each person’s own to-dos and what is due', fixed('Each supervisor; admins in copy'), 'An email'),
        row('HIVE alerts, the management report, the prepaid summary', null, fixed('Chosen in the tabs beside this one'), 'Emails')))),
    said));
}
