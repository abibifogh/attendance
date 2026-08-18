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

    // An installation with no owner can only be administered over the shared
    // password. That works, and it is not where anybody should stay: the shared
    // password cannot be handed over to another system, so the hub does nothing
    // for whoever is holding it.
    const noOwner = !accounts.some((a) => a.isOwner && a.active);

    mount(view,
      noOwner ? banner('problem',
        h('strong', 'Nobody here is an owner yet. '),
        'Add yourself and tick ', h('em', 'Owner'), ' — an account without it cannot reach this screen, '
        + 'and the shared password is the only other way back in.') : null,

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
                h('button.btn', { onclick: () => edit(account, systems, accounts) }, 'Edit'))))))),
        h('button.btn.primary', { style: { marginTop: '.8rem' }, onclick: () => edit(null, systems, accounts) }, 'Add somebody')),

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
        // Two of these three cannot be generated for you: the other end lives
        // in a different repository on a different platform, and a shared
        // secret only works if the same value reaches both. So this says how to
        // do it from a browser rather than from a terminal.
        system.secretSet ? null : h('div.small.muted', { style: { marginTop: '.4rem' } },
          system.id === 'attendance'
            ? h('span',
              'Generated for you. Run ', h('strong', 'Actions → Set Insight\'s secrets'),
              ' with this site\'s address in the box, and it makes one and sets it on both Workers.')
            : h('span',
              'Make any long random string, then: add it as the repository secret ',
              h('code', `INSIGHT_${system.secretName}`),
              ', run ', h('strong', 'Actions → Set Insight\'s secrets'),
              ', and set the same value on ', system.label,
              ' along with the handler from ', h('code', 'bi/docs/sso.md'), '.')));
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

  /**
   * Add or change somebody.
   *
   * A real form rather than a row of `prompt()` boxes, because two of the
   * fields are tick boxes and a prompt cannot ask a yes-or-no question — which
   * is how the owner tick came to be missing entirely, and with it any way to
   * make somebody an owner at all.
   */
  function edit(account, systems, accounts) {
    const isNew = !account;
    const name = h('input', { type: 'text', value: account?.name ?? '', required: true, autofocus: true });
    const email = h('input', { type: 'email', value: account?.email ?? '', required: true });

    // An owner reaches every system and can manage accounts. When there is not
    // one yet — a fresh installation being set up over the shared password —
    // this starts ticked, because an account created without it cannot reach
    // this screen again and whoever made it would be back to the shared
    // password to try once more.
    const noOwnerYet = !accounts.some((a) => a.isOwner && a.active);
    const owner = h('input', { type: 'checkbox', checked: account?.isOwner ?? (isNew && noOwnerYet) });
    const active = h('input', { type: 'checkbox', checked: account?.active ?? true });

    const message = h('p.small', { style: { color: 'var(--critical)', margin: '.4rem 0 0' } });

    const dialog = h('dialog', { style: { border: 0, borderRadius: 'var(--radius)', padding: 0, maxWidth: '26rem', width: '92vw' } },
      h('form', {
        method: 'dialog',
        style: { background: 'var(--surface)', color: 'var(--ink)', padding: '1.2rem 1.3rem 1.3rem' },
        onsubmit: async (event) => {
          event.preventDefault();
          message.textContent = '';
          try {
            const fresh = await api('/accounts', {
              method: 'POST',
              body: {
                id: account?.id,
                name: name.value,
                email: email.value,
                isOwner: owner.checked,
                active: active.checked,
              },
            });
            dialog.close();
            dialog.remove();
            paint(fresh);
            if (isNew) {
              alert(`Added ${name.value}.\n\nNow press "Set password" on their row — they cannot sign in until they have one.`);
            }
          } catch (err) {
            message.textContent = err.message;
          }
        },
      },
      h('h3', { style: { marginBottom: '.8rem' } }, isNew ? 'Add somebody' : `Edit ${account.name}`),
      h('label.field', 'Name', name),
      h('label.field', 'Email address', email),
      h('p.small.muted', { style: { marginTop: '-.3rem' } },
        'This is what the other systems match them on, so it has to be the address they use there too.'),

      h('label.check', owner, 'Owner'),
      h('p.small.muted', { style: { margin: '-.5rem 0 .8rem 1.55rem' } },
        'Reaches every system without being granted them one at a time, and can manage these accounts. '
        + (noOwnerYet && isNew ? 'Ticked because nobody is an owner yet — an account without it cannot open this screen.' : '')),

      isNew ? null : h('div',
        h('label.check', active, 'Can sign in'),
        h('p.small.muted', { style: { margin: '-.5rem 0 .8rem 1.55rem' } },
          'Unticking is how somebody who has left is switched off, in one place rather than five.')),

      message,
      h('div', { style: { display: 'flex', gap: '.4rem', marginTop: '1rem' } },
        h('button.btn.primary', { type: 'submit' }, isNew ? 'Add' : 'Save'),
        h('button.btn', {
          type: 'button',
          onclick: () => { dialog.close(); dialog.remove(); },
        }, 'Cancel'))));

    document.body.append(dialog);
    dialog.showModal();
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
