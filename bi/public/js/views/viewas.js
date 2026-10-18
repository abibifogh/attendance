import { h, mount } from '../util.js';
import { api } from '../api.js';

/**
 * View as: an admin sees Insight exactly as somebody else does (their menus,
 * their Inbox, only the areas and amounts they are given), to know what they
 * see. Look only: the server refuses every change until "Stop viewing".
 * Starting, switching and stopping reload the app, since everything on
 * screen depends on who is looking.
 */

const again = () => window.location.reload();

/** Choose whom to look as. */
export async function openViewAs() {
  const close = () => { shade.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const list = h('div.va-list', h('p.small.muted', 'Reading the accounts…'));
  const search = h('input', { type: 'search', placeholder: 'Type a name', 'aria-label': 'Find a person' });
  const said = h('p.small.form-error', { role: 'status' });
  const card = h('div.va-card', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'va-title' },
    h('div.va-head', h('h2', { id: 'va-title' }, '👁 View as somebody else'), h('button.btn', { type: 'button', 'aria-label': 'Close', onclick: close }, '✕')),
    h('p.va-lede', 'You see Insight exactly as they do: their menus, their Inbox, only the areas and amounts they are given. It is look only: nothing can be changed until you stop. Owners can see each time under Admin › Accounts.'),
    search, list, said);
  const shade = h('div.va-shade', { onclick: (e) => { if (e.target === shade) close(); } }, card);
  document.body.append(shade);
  document.addEventListener('keydown', esc);
  search.focus();

  let people = [];
  try {
    people = (await api('/view-as')).accounts;
  } catch (err) {
    mount(list, h('p.form-error', err.message));
    return;
  }
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const shown = people.filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.email || '').toLowerCase().includes(q));
    mount(list, shown.length ? shown.map((p) => h('div.va-row',
      h('span.va-av', (p.name || '?').trim().charAt(0).toUpperCase()),
      h('span.va-t', h('b', p.name), h('small', p.role)),
      h('button.btn', { type: 'button', onclick: (e) => start(p, e.target) }, 'View as')))
      : h('p.small.muted', people.length ? 'Nobody by that name.' : 'There is nobody else to view as.'));
  };
  search.addEventListener('input', paint);
  paint();

  async function start(p, button) {
    button.disabled = true;
    said.textContent = '';
    try {
      await api('/view-as', { method: 'POST', body: { accountId: p.id } });
      again();
    } catch (err) { said.textContent = err.message; button.disabled = false; }
  }
}

/** The bar on top while looking as somebody: who, switch to another, stop. */
export function viewAsBar(account) {
  document.documentElement.classList.add('viewing-as');
  const said = h('span.va-err', { role: 'alert' });
  const pick = h('select', { 'aria-label': 'View as somebody else', onchange: async (e) => {
    if (!e.target.value) return;
    e.target.disabled = true;
    try { await api('/view-as', { method: 'POST', body: { accountId: Number(e.target.value) } }); again(); } catch (err) { said.textContent = err.message; e.target.disabled = false; }
  } }, h('option', { value: '' }, 'Someone else…'));
  // The others, to switch to without stopping first.
  api('/view-as').then(({ accounts }) => {
    pick.append(...accounts.filter((p) => p.id !== account.id).map((p) => h('option', { value: String(p.id) }, `${p.name} · ${p.role.split(':')[0]}`)));
  }).catch(() => { pick.hidden = true; });
  return h('div.va-bar', { role: 'status' },
    h('span.va-say', '👁 Viewing as ', h('b', account.name), ` · what they see. Look only, nothing can be changed. You are ${account.viewedBy.name}.`),
    h('span.va-acts', pick,
      h('button.va-stop', { type: 'button', onclick: async (e) => {
        e.target.disabled = true;
        await api('/view-as/stop', { method: 'POST' }).catch(() => {});
        again();
      } }, 'Stop viewing')),
    said);
}
