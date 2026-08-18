import { add, h, mount } from '../util.js';
import { api } from '../api.js';
import { table, banner } from './components.js';
import { prepareNewPassword } from '../crypto.js';
import { state } from '../app.js';

/**
 * Who may sign in, and what each of them may reach.
 *
 * The grid is the screen. A row per person, a column per system, a checkbox in
 * each cell — because the question an owner actually has is "who can get into
 * the till", and that is a column, not five separate pages.
 */
export async function renderAccounts(root) {
  const data = await api('/accounts');
  const view = h('div');
  add(root, view);
  paint(data);

  function paint(data) {
    const { accounts, systems } = data;

    mount(view,
      h('div.card',
        h('h2', 'Who can sign in'),
        h('p.sub', 'A tick means that person can open that system from the hub without signing in again. No tick means no access — there is no role here that quietly carries all of them, because "manager" means five different things in five systems.'),
        h('div.table-wrap',
          h('table',
            h('thead', h('tr',
              h('th', 'Person'),
              ...systems.map((s) => h('th.num', { style: { textAlign: 'center' } }, s.label)),
              h('th', ''))),
            h('tbody', accounts.map((account) => h('tr',
              h('td',
                h('div', { style: { fontWeight: '600' } }, account.name,
                  account.isOwner ? h('span.pill', { style: { marginLeft: '.4rem' } }, 'owner') : null,
                  !account.active ? h('span.pill', { style: { marginLeft: '.4rem' } }, 'switched off') : null),
                h('div.small.muted', account.email,
                  account.hasPassword ? '' : ' · no password set yet')),
              ...systems.map((system) => h('td', { style: { textAlign: 'center' } },
                h('input', {
                  type: 'checkbox',
                  checked: account.isOwner || account.access.some((a) => a.systemId === system.id),
                  disabled: account.isOwner,
                  title: account.isOwner ? 'An owner reaches everything' : `${account.name} → ${system.label}`,
                  onchange: (event) => toggle(account, system, event.target.checked),
                }))),
              h('td',
                h('button.btn', { onclick: () => setPassword(account) }, 'Set password'),
                ' ',
                h('button.btn', { onclick: () => edit(account) }, 'Edit'))))))),
        h('button.btn.primary', { style: { marginTop: '.8rem' }, onclick: () => edit(null) }, 'Add somebody')),

      h('div.card',
        h('h2', 'Where each system lives'),
        h('p.sub', 'The sign-in address is where this app sends somebody who clicks through from the hub. The shared secret is a Worker secret and is never typed here — a secret in a web form is a secret in a browser history and a proxy log.'),
        systems.filter((s) => s.id !== 'insight').map((system) => systemRow(system))),
    );

    function systemRow(system) {
      const home = h('input', { type: 'url', value: system.homeUrl, placeholder: 'https://staff.example.com/' });
      const sso = h('input', { type: 'url', value: system.ssoUrl, placeholder: 'https://staff.example.com/sso' });
      const on = h('input', { type: 'checkbox', checked: system.ssoEnabled });
      return h('div.card', { style: { marginBottom: '.7rem' } },
        h('h3', system.label, ' ',
          system.secretSet
            ? h('span.pill.good', h('span.dot'), '✓ secret set')
            : h('span.pill.warning', h('span.dot'), `! ${system.secretName} not set`)),
        h('div.grid.two',
          h('label.field', 'Home address', home),
          h('label.field', 'Sign-in address (its /sso endpoint)', sso)),
        h('label.check', on, 'Hand people over without a second sign-in'),
        h('button.btn', {
          onclick: async (event) => {
            event.target.disabled = true;
            try {
              paint(await api(`/systems/${system.id}`, {
                method: 'POST',
                body: { homeUrl: home.value, ssoUrl: sso.value, ssoEnabled: on.checked },
              }));
            } catch (err) { alert(err.message); event.target.disabled = false; }
          },
        }, 'Save'),
        system.secretSet ? null : h('p.small.muted',
          'Set it with ', h('code', `wrangler secret put ${system.secretName}`),
          ' here, and the same value on ', system.label, '.'));
    }
  }

  async function toggle(account, system, wanted) {
    const next = account.access.filter((a) => a.systemId !== system.id);
    if (wanted) next.push({ systemId: system.id, role: '' });
    try {
      paint(await api(`/accounts/${account.id}/access`, { method: 'POST', body: { access: next } }));
    } catch (err) {
      alert(err.message);
      paint(await api('/accounts'));
    }
  }

  async function edit(account) {
    const name = prompt('Name', account?.name ?? '');
    if (name === null) return;
    const email = prompt('Email address', account?.email ?? '');
    if (email === null) return;
    try {
      paint(await api('/accounts', {
        method: 'POST',
        body: { id: account?.id, name, email, isOwner: account?.isOwner ?? false, active: account?.active ?? true },
      }));
    } catch (err) { alert(err.message); }
  }

  /**
   * Set somebody's password.
   *
   * Stretched here, in the browser, before it goes anywhere. What reaches the
   * server is a derived key, a salt and a work factor; the password itself
   * never leaves this function.
   */
  async function setPassword(account) {
    const password = prompt(`A new password for ${account.name}. At least 10 characters.`);
    if (!password) return;
    if (password.length < 10) { alert('Too short — at least 10 characters.'); return; }
    try {
      const derived = await prepareNewPassword(password);
      await api(`/accounts/${account.id}/password`, {
        method: 'POST',
        body: {
          passwordKey: derived.passwordKey,
          passwordSalt: derived.passwordSalt,
          passwordIterations: derived.passwordIterations,
        },
      });
      paint(await api('/accounts'));
      alert(`Done. ${account.name} signs in with ${account.email}.`);
    } catch (err) { alert(err.message); }
  }
}
