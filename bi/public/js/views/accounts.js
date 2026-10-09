import { add, h, mount } from '../util.js';
import { api } from '../api.js';
import { table, banner } from './components.js';
import { prepareNewPassword } from '../crypto.js';
import { state } from '../app.js';

/** An invitation's state, in the word the owner sees. */
const STATUS = {
  sent: 'Not opened', opened: 'Opened', asked: 'Asked again', expired: 'Expired', joined: 'Joined', withdrawn: 'Withdrawn',
};
const when = (sql) => (sql ? new Date(`${String(sql).replace(' ', 'T')}Z`)
  .toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) : '');

/**
 * Who may sign in, and what each of them may reach.
 *
 * The grid is the screen. A row per person, a column per system, a checkbox in
 * each cell — because the question an owner actually has is "who can get into
 * the till", and that is a column, not five separate pages.
 */
export async function renderAccounts(root) {
  const [data, invited] = await Promise.all([api('/accounts'), api('/invitations').catch(() => ({ invitations: [] }))]);
  const view = h('div');
  add(root, view);
  let invitations = invited.invitations;
  let flash = null;
  paint(data);

  /** After any change to invitations: both lists, since an invitation makes an account. */
  async function repaint(message = null) {
    flash = message;
    const [fresh, inv] = await Promise.all([api('/accounts'), api('/invitations')]);
    invitations = inv.invitations;
    paint(fresh);
  }

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

      inviteCard(systems, accounts),
      invitationsCard(),

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
                // Insight has two ways in: everything, or Shifts as a
                // supervisor, with the parts set under Shifts → Till settings.
                system.id === 'insight' && !account.isOwner
                  ? h('select', {
                    title: `${account.name} → Insight`,
                    onchange: (event) => setInsight(account, event.target.value),
                  },
                  h('option', { value: '', selected: !account.access.some((a) => a.systemId === 'insight') }, 'No'),
                  h('option', { value: 'full', selected: account.access.some((a) => a.systemId === 'insight' && !['supervisor', 'uploader'].includes(a.role)) }, 'Everything'),
                  h('option', { value: 'supervisor', selected: account.access.some((a) => a.systemId === 'insight' && a.role === 'supervisor') }, 'Supervisor'),
                  h('option', { value: 'uploader', selected: account.access.some((a) => a.systemId === 'insight' && a.role === 'uploader') }, 'Uploads only'))
                  : h('input', {
                    type: 'checkbox',
                    checked: account.isOwner || account.access.some((a) => a.systemId === system.id),
                    disabled: account.isOwner,
                    title: account.isOwner ? 'An owner reaches everything' : `${account.name} → ${system.label}`,
                    onchange: (event) => toggle(account, system, event.target.checked),
                  }))),
              h('td',
                account.hasPassword ? null : h('button.btn', { onclick: () => inviteAgain(account) }, 'Invite'),
                account.hasPassword ? null : ' ',
                h('button.btn', { onclick: () => setPassword(account) }, 'Set password'),
                ' ',
                h('button.btn', { onclick: () => edit(account, systems, accounts) }, 'Edit'))))))),
        h('button.btn', { style: { marginTop: '.8rem' }, onclick: () => edit(null, systems, accounts) }, 'Add without an invitation')),

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

  /**
   * Invite somebody: who they are, what they may reach, and a link that lets
   * them choose their own password. The owner never knows it.
   */
  function inviteCard(systems, accounts) {
    const noOwnerYet = !accounts.some((a) => a.isOwner && a.active);
    let level = noOwnerYet ? 'owner' : 'supervisor';
    const name = h('input', { type: 'text', autocomplete: 'off', required: true });
    const email = h('input', { type: 'email', autocomplete: 'off', required: true });
    const note = h('textarea.inv-note', { rows: 2, maxLength: 400, placeholder: 'Goes in the email, under your name.' });
    const LEVELS = [
      ['owner', 'Owner', 'Everything, every system, and manages accounts'],
      ['admin', 'Admin', 'Every report and all of Shifts'],
      ['supervisor', 'Supervisor', 'Shifts only, as set in Till settings'],
      ['uploader', 'Uploads only', 'Loads the ASSD journal, bank statement and card report. Sees nothing else'],
      ['none', 'No reports', 'The hub only: a way into other systems'],
    ];
    const others = systems.filter((sys) => sys.id !== 'insight');
    const ticks = others.map((sys) => h('input', { type: 'checkbox', checked: sys.id === 'attendance' }));
    const levelButtons = LEVELS.map(([value, label, words]) => h('button', {
      type: 'button',
      class: value === level ? 'on' : '',
      onclick: () => {
        level = value;
        levelButtons.forEach((b, i) => b.classList.toggle('on', LEVELS[i][0] === value));
        ticks.forEach((t) => { t.disabled = value === 'owner'; });
      },
    }, label, h('span', words)));
    const message = h('p.small.form-error');

    const send = async (how, button) => {
      message.textContent = '';
      if (!name.value.trim() || !email.value.trim()) { message.textContent = 'A name and an email address, please.'; return; }
      button.disabled = true;
      try {
        const out = await api('/invitations', {
          method: 'POST',
          body: {
            name: name.value, email: email.value, level, note: note.value, how,
            systems: others.filter((sys, i) => ticks[i].checked).map((sys) => sys.id),
          },
        });
        await repaint(outcome(out));
      } catch (err) {
        message.textContent = err.message;
        button.disabled = false;
      }
    };
    const sendButton = h('button.btn.primary', { type: 'button', onclick: (e) => send('email', e.target) }, 'Send invitation');
    const linkButton = h('button.btn', { type: 'button', onclick: (e) => send('link', e.target) }, 'Copy the link instead');
    ticks.forEach((t) => { t.disabled = level === 'owner'; });
    // Shown once: the next repaint, for whatever reason, should not repeat it.
    const shown = flash;
    flash = null;

    return h('div.card',
      h('h2', 'Invite somebody'),
      h('p.sub', 'They get a link, choose their own password, and are in. You never handle it.'),
      h('div.grid.two',
        h('label.field', 'Name', name),
        h('label.field', 'Email address', email)),
      h('p.small', { style: { margin: '0 0 .2rem', fontWeight: '600' } }, 'Access level'),
      h('div.inv-levels', levelButtons),
      others.length ? h('div',
        h('p.small', { style: { margin: '0 0 .3rem', fontWeight: '600' } }, 'Can also open, from the hub'),
        h('div.inv-ticks', others.map((sys, i) => h('label.check', ticks[i], sys.label)))) : null,
      h('label.field', 'A note from you (optional)', note),
      message,
      h('div.inv-actions', sendButton, linkButton,
        h('span.small.muted', 'The link works once and lasts 7 days.')),
      shown ? flashBox(shown) : null);
  }

  /** What happened, in a sentence, with the link to hand on when there is one. */
  function outcome(out) {
    if (out.emailed) return { text: `Invitation sent to ${out.to}. It lasts until ${out.expires}.` };
    if (out.emailError) {
      return { warn: true, text: `Could not email ${out.to}: ${out.emailError} Send them this link yourself; it works once, until ${out.expires}.`, link: out.link };
    }
    return { text: `Here is the link for ${out.to}. Paste it into WhatsApp or a message; it works once, until ${out.expires}.`, link: out.link };
  }

  function flashBox(message) {
    const box = h(message.warn ? 'div.inv-flash.warn' : 'div.inv-flash', message.text);
    if (message.link) {
      const copy = h('button.btn', {
        type: 'button',
        onclick: async () => {
          try { await navigator.clipboard.writeText(message.link); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select the link and copy it'; }
        },
      }, 'Copy link');
      add(box, h('div', { style: { margin: '.45rem 0 .3rem' } }, h('code', message.link)), copy);
      // Straight onto the clipboard too, since that is what was asked for.
      navigator.clipboard?.writeText(message.link).then(() => { copy.textContent = 'Copied'; }).catch(() => {});
    }
    return box;
  }

  function invitationsCard() {
    if (!invitations.length) return null;
    return h('div.card',
      h('h2', 'Invitations'),
      h('p.sub', 'Resending sends a fresh link; the old one stops working. Somebody who opens an old or expired link can ask you for a new one, and it shows here as Asked again.'),
      invitations.map((inv) => {
        const history = [
          `Sent ${when(inv.createdAt)}${inv.by ? ` by ${inv.by}` : ''}${inv.via === 'link' ? ' as a link' : ''}`,
          inv.sends > 1 ? `sent ${inv.sends} times in all` : null,
          inv.openedAt && !inv.usedAt ? `opened ${when(inv.openedAt)}` : null,
          inv.askedAt ? `asked for a new link ${when(inv.askedAt)}` : null,
          inv.usedAt ? `joined ${when(inv.usedAt)}` : null,
          inv.emailError && !inv.usedAt ? `the email did not go: ${inv.emailError}` : null,
        ].filter(Boolean).join(' · ');
        const live = inv.status !== 'joined';
        return h('div.inv-row',
          h('div.inv-who',
            h('div', h('strong', inv.name), h('span.small.muted', ` · ${inv.level}`)),
            h('div.small.muted', inv.email),
            h('div.small.muted', history)),
          h(`span.inv-status.${inv.status}`, STATUS[inv.status] || inv.status),
          live ? h('div.inv-buttons',
            h('button.btn', { onclick: (e) => act(e.target, `/invitations/${inv.id}/resend`, { how: 'email' }) }, inv.status === 'withdrawn' ? 'Invite again' : 'Resend'),
            h('button.btn', { onclick: (e) => act(e.target, `/invitations/${inv.id}/resend`, { how: 'link' }) }, 'New link to copy'),
            inv.status === 'withdrawn' ? null : h('button.btn', {
              onclick: (e) => {
                if (!confirm(`Withdraw the invitation to ${inv.email}? The link stops working and their account is switched off until you invite them again.`)) return;
                act(e.target, `/invitations/${inv.id}/withdraw`, {}, `Withdrawn. The link to ${inv.email} no longer works.`);
              },
            }, 'Withdraw')) : null);
      }));
  }

  async function act(button, path, body, said = null) {
    button.disabled = true;
    try {
      const out = await api(path, { method: 'POST', body });
      await repaint(said ? { text: said } : outcome(out));
      view.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      alert(err.message);
      button.disabled = false;
    }
  }

  /** Somebody on the grid who never set a password: invite them as they are. */
  async function inviteAgain(account) {
    const level = account.isOwner ? 'owner'
      : account.access.some((a) => a.systemId === 'insight' && a.role === 'supervisor') ? 'supervisor'
        : account.access.some((a) => a.systemId === 'insight' && a.role === 'uploader') ? 'uploader'
        : account.access.some((a) => a.systemId === 'insight') ? 'admin' : 'none';
    try {
      const out = await api('/invitations', {
        method: 'POST',
        body: {
          name: account.name, email: account.email, level, how: 'email',
          systems: account.access.filter((a) => a.systemId !== 'insight').map((a) => a.systemId),
        },
      });
      await repaint(outcome(out));
      view.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) { alert(err.message); }
  }

  async function setInsight(account, how) {
    const next = account.access.filter((a) => a.systemId !== 'insight');
    if (how) next.push({ systemId: 'insight', role: ['supervisor', 'uploader'].includes(how) ? how : '' });
    try {
      paint(await api(`/accounts/${account.id}/access`, { method: 'POST', body: { access: next } }));
    } catch (err) {
      alert(err.message);
      paint(await api('/accounts'));
    }
  }

  async function toggle(account, system, wanted) {
    const next = account.access.filter((a) => a.systemId !== system.id);
    if (wanted) next.push({ systemId: system.id, role: account.access.find((a) => a.systemId === system.id)?.role || '' });
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
    const active = h('input', { type: 'checkbox', checked: account?.active ?? true });

    // The level, chosen in one place when somebody is added rather than
    // ticked in the grid afterwards. Owner and admin see everything here; a
    // supervisor sees Shifts only, with the parts set under Till settings.
    const insightGrant = account?.access?.find((a) => a.systemId === 'insight');
    const current = account?.isOwner ? 'owner'
      : insightGrant ? (['supervisor', 'uploader'].includes(insightGrant.role) ? insightGrant.role : 'admin')
        : account ? 'none' : (noOwnerYet ? 'owner' : 'supervisor');
    const LEVELS = [
      ['owner', 'Owner', 'Everything, every system, and can manage these accounts.'],
      ['admin', 'Admin', 'Every report and all of Shifts, including the till settings. Cannot manage accounts or Setup.'],
      ['supervisor', 'Supervisor', 'Shifts only, with the parts an admin chooses under Shifts → Till settings → Supervisor access.'],
      ['uploader', 'Uploads only', 'Loads the ASSD journal, the bank statement and the card terminal report. Sees none of the numbers, and nothing else in Insight.'],
      ['none', 'No reports', 'Only the hub: a way into the other systems ticked below.'],
    ];
    const level = h('select', { required: true }, LEVELS.map(([value, label]) => h('option', { value, selected: value === current }, label)));
    const levelNote = h('p.small.muted', { style: { margin: '.2rem 0 .8rem' } });
    const others = systems.filter((sys) => sys.id !== 'insight');
    const ticks = others.map((sys) => h('input', { type: 'checkbox', checked: Boolean(account?.isOwner || account?.access?.some((a) => a.systemId === sys.id)) }));
    const showLevel = () => {
      levelNote.textContent = LEVELS.find(([v]) => v === level.value)[2]
        + (level.value === 'owner' && noOwnerYet && isNew ? ' Chosen because nobody is an owner yet: an account without it cannot open this screen.' : '');
      for (const t of ticks) t.disabled = level.value === 'owner';
    };
    level.addEventListener('change', showLevel);
    showLevel();

    const message = h('p.small', { style: { color: 'var(--critical)', margin: '.4rem 0 0' } });

    const dialog = h('dialog', { style: { border: 0, borderRadius: 'var(--radius)', padding: 0, maxWidth: '26rem', width: '92vw' } },
      h('form', {
        method: 'dialog',
        style: { background: 'var(--surface)', color: 'var(--ink)', padding: '1.2rem 1.3rem 1.3rem' },
        onsubmit: async (event) => {
          event.preventDefault();
          message.textContent = '';
          try {
            let fresh = await api('/accounts', {
              method: 'POST',
              body: {
                id: account?.id,
                name: name.value,
                email: email.value,
                isOwner: level.value === 'owner',
                active: active.checked,
              },
            });
            // Then what they may reach, on the account just saved.
            const saved = fresh.accounts.find((a) => a.email.toLowerCase() === email.value.trim().toLowerCase());
            if (saved && level.value !== 'owner') {
              const access = others.filter((sys, i) => ticks[i].checked)
                .map((sys) => ({ systemId: sys.id, role: saved.access.find((a) => a.systemId === sys.id)?.role || '' }));
              if (level.value === 'admin') access.push({ systemId: 'insight', role: '' });
              if (level.value === 'supervisor') access.push({ systemId: 'insight', role: 'supervisor' });
              if (level.value === 'uploader') access.push({ systemId: 'insight', role: 'uploader' });
              fresh = await api(`/accounts/${saved.id}/access`, { method: 'POST', body: { access } });
            }
            dialog.close();
            dialog.remove();
            paint(fresh);
            if (isNew) {
              alert(`Added ${name.value}.\n\nNow press "Invite" on their row, so they choose a password, or "Set password" to choose one for them.`);
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

      h('label.field', 'Access level', level),
      levelNote,
      others.length ? h('div',
        h('p.small', { style: { margin: '0 0 .3rem', fontWeight: '600' } }, 'Can also open, from the hub'),
        others.map((sys, i) => h('label.check', ticks[i], sys.label))) : null,

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
