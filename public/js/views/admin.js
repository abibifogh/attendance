import { api } from '../api.js';
import { fmtDay, fmtNum, h, mount, toast, todayISO } from '../util.js';
import { card, emptyState, table } from './components.js';
import { prepareNewPassword } from '../crypto.js';

/**
 * Users and data.
 *
 * Three things with one audience: who can sign in, who gets told when something
 * needs doing, and the one screen that deletes records. Tabbed rather than one
 * long page, because the middle one is opened often and the last one should
 * take a deliberate act to reach.
 */

const TABS = [
  ['people', 'People'],
  ['alerts', 'Notifications'],
  ['data', 'Data'],
  ['audit', 'Audit trail'],
];

export async function renderAdmin(params = {}) {
  const host = h('div');
  const tab = TABS.some(([key]) => key === params.tab) ? params.tab : 'people';

  const reload = async (next = tab) => {
    history.replaceState(null, '', `#/admin?tab=${next}`);
    mount(host, await renderAdmin({ tab: next }));
  };

  const body = await {
    people: peopleTab,
    alerts: alertsTab,
    data: dataTab,
    audit: auditTab,
  }[tab](reload);

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Users & data'),
        h('div.sub', 'Who can sign in, who gets told, and what is stored'),
      ),
    ),
    h('div.toolbar',
      h('div.seg.seg-wrap', TABS.map(([key, label]) =>
        h('button', { class: tab === key ? 'active' : '', onclick: () => reload(key) }, label))),
    ),
    body,
  );

  return host;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

async function peopleTab(reload) {
  const data = await api.users();

  const edit = (existing) => openUserDialog({ existing, data, reload });

  const remove = async (row) => {
    if (!window.confirm(
      `Remove ${row.name}'s login?\n\n`
      + 'Their attendance record, if they have one, is not touched — a login and a member of staff '
      + 'are different things here.',
    )) return;
    try {
      await api.deleteUser(row.id);
      toast('Removed.');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const recovery = data.recovery ?? {};

  return h('div',
    recovery.conflictsWith
      ? h('div.alert.high',
        h('span.alert-icon', '⛔'),
        h('div',
          h('div.alert-title', 'The emergency recovery PIN is being shadowed'),
          h('div.alert-detail',
            `${recovery.conflictsWith} has the same PIN as the server's recovery PIN, so the recovery `
            + 'PIN no longer works. Change one of them — otherwise nobody finds out until the day it '
            + 'is needed.'),
        ))
      : null,

    card('People who can sign in', {
      note: `${data.users.filter((u) => u.active).length} active`,
      actions: h('button.btn.btn-primary', { onclick: () => edit(null) }, '+ Add somebody'),
      wide: true,
    },
      table([
        {
          key: 'name',
          label: 'Name',
          format: (v, r) => h('div',
            h('div', v, r.active ? null : h('span.pill', { style: { marginLeft: '.4rem' } }, 'inactive')),
            h('small.muted', r.email || `signs in with a ${r.signsInWith}`),
          ),
        },
        { key: 'role', label: 'Role', format: (v) => h('span.pill', roleLabel(data.roles, v)) },
        {
          key: 'permissions',
          label: 'Can open',
          format: (v, r) => h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '.25rem' } },
            v.map((p) => h('span.pill', { style: { fontSize: '.72rem' } },
              data.permissions.find((x) => x.key === p)?.label ?? p)),
            r.customPermissions ? h('small.muted', ' (set by hand)') : null),
        },
        { key: 'last_login_at', label: 'Last signed in', format: (v) => (v ? h('small', v.slice(0, 16)) : h('span.muted', 'never')) },
        {
          key: 'actions',
          label: '',
          format: (v, r) => h('div.btn-row',
            h('button.btn-sm', { onclick: () => edit(r) }, 'Edit'),
            h('button.btn-sm', { onclick: () => remove(r) }, 'Remove'),
          ),
        },
      ], data.users, {
        rowClass: (r) => (r.active ? '' : 'row-muted'),
        empty: 'Nobody yet.',
      })),

    card('The roles', { note: 'Starting points — any person can be adjusted individually', wide: true },
      table([
        { key: 'label', label: 'Role' },
        { key: 'detail', label: 'What it is for' },
        {
          key: 'defaults',
          label: 'Opens',
          format: (v) => h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '.25rem' } },
            v.map((p) => h('span.pill', { style: { fontSize: '.72rem' } },
              data.permissions.find((x) => x.key === p)?.label ?? p))),
        },
      ], data.roles)),
  );
}

function roleLabel(roles, key) {
  return roles.find((r) => r.key === key)?.label ?? key;
}

/**
 * Add or edit a login.
 *
 * The credential half changes shape with the role, because administrators sign
 * in with an email address and a password and everybody else uses a PIN. The
 * password is stretched here, in the browser, and only the derived key is sent
 * — see crypto.js for why.
 */
function openUserDialog({ existing, data, reload }) {
  const name = h('input', { type: 'text', maxlength: 80, value: existing?.name ?? '' });
  const note = h('input', { type: 'text', maxlength: 300, value: existing?.note ?? '' });
  const active = h('select',
    h('option', { value: 'true', selected: existing ? existing.active : true }, 'Active'),
    h('option', { value: 'false', selected: existing ? !existing.active : false }, 'Not active'));

  const roleSelect = h('select', data.roles.map((r) =>
    h('option', { value: r.key, selected: (existing?.role ?? 'supervisor') === r.key }, r.label)));

  const pin = h('input', { type: 'text', inputmode: 'numeric', maxlength: 10, placeholder: existing ? 'leave blank to keep' : '4 to 10 digits' });
  const email = h('input', { type: 'email', maxlength: 200, value: existing?.email ?? '' });
  const password = h('input', { type: 'password', maxlength: 200, placeholder: existing?.hasPassword ? 'leave blank to keep' : 'at least 10 characters' });

  const pinField = h('label.field', h('span', 'PIN'), pin);
  const emailField = h('label.field', h('span', 'Email address'), email);
  const passwordField = h('label.field', h('span', 'Password'), password);

  const roleHint = h('p.muted', { style: { fontSize: '.85rem' } });

  // Permissions default to the role's, and only become a stored override once
  // somebody actually ticks something different.
  let custom = existing?.customPermissions ?? null;
  const checkboxes = data.permissions.map((p) => {
    const box = h('input', { type: 'checkbox', value: p.key });
    return { key: p.key, box, el: h('label.inline-check', box, h('span', p.label), h('small.muted', ` — ${p.detail}`)) };
  });
  const permissionList = h('div', { style: { display: 'grid', gap: '.3rem' } }, checkboxes.map((c) => c.el));

  const applyRole = () => {
    const role = data.roles.find((r) => r.key === roleSelect.value);
    roleHint.textContent = role?.detail ?? '';
    const list = custom ?? role?.defaults ?? [];
    for (const c of checkboxes) c.box.checked = list.includes(c.key);

    const isAdmin = roleSelect.value === 'admin';
    pinField.style.display = isAdmin ? 'none' : '';
    emailField.style.display = isAdmin ? '' : '';
    passwordField.style.display = isAdmin ? '' : 'none';
  };

  roleSelect.addEventListener('change', () => { custom = null; applyRole(); });
  for (const c of checkboxes) {
    c.box.addEventListener('change', () => {
      custom = checkboxes.filter((x) => x.box.checked).map((x) => x.key);
    });
  }

  const problem = h('p.form-error', { style: { display: 'none' } });

  const dialog = h('dialog', {
    style: {
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      background: 'var(--surface)',
      color: 'var(--text)',
      maxWidth: '620px',
      width: '92vw',
      padding: '1.2rem',
    },
  },
    h('div.card-head',
      h('h2', existing ? `Edit ${existing.name}` : 'Add a person'),
      h('button.btn-sm.btn-ghost', { onclick: () => dialog.close() }, '✕'),
    ),
    h('div.field-row',
      h('label.field', h('span', 'Name'), name),
      h('label.field', h('span', 'Role'), roleSelect),
      h('label.field', h('span', 'Status'), active),
      pinField,
      emailField,
      passwordField,
    ),
    roleHint,
    h('label.field', h('span', 'Note (optional)'), note),
    h('div', { style: { marginTop: '.4rem' } },
      h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'Sections this person can open'),
      permissionList,
      h('div', { style: { marginTop: '.5rem' } },
        h('button.btn-sm', {
          onclick: () => { custom = null; applyRole(); },
        }, 'Reset to the role\'s defaults')),
    ),
    problem,
    h('div.btn-row', { style: { marginTop: '1rem', justifyContent: 'flex-end' } },
      h('button', { onclick: () => dialog.close() }, 'Cancel'),
      h('button.btn-primary', { onclick: save }, existing ? 'Save changes' : 'Add person'),
    ),
  );

  async function save() {
    problem.style.display = 'none';
    const payload = {
      name: name.value.trim(),
      role: roleSelect.value,
      active: active.value === 'true',
      note: note.value.trim() || null,
      permissions: custom,
    };

    try {
      if (roleSelect.value === 'admin') {
        payload.email = email.value.trim();
        if (password.value) {
          if (password.value.length < 10) throw new Error('The password must be at least 10 characters.');
          // Stretched here, in the browser. Only the derived key travels — see
          // crypto.js for why that is not merely belt and braces.
          Object.assign(payload, await prepareNewPassword(password.value));
        }
      } else {
        payload.email = email.value.trim() || null;
        if (pin.value) payload.pin = pin.value.trim();
      }

      if (existing) await api.updateUser(existing.id, payload);
      else await api.createUser(payload);

      dialog.close();
      toast('Saved.', 'good');
      await reload();
    } catch (err) {
      problem.textContent = err.message || 'That did not work.';
      problem.style.display = '';
    }
  }

  applyRole();
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

async function alertsTab(reload) {
  const data = await api.notifications();

  const recipients = h('textarea', {
    rows: 3,
    placeholder: 'one address per line',
    value: data.recipients.join('\n'),
  });
  const from = h('input', { type: 'text', maxlength: 200, value: data.from, placeholder: 'HIVE <hive@niceoperation.com>' });
  const siteUrl = h('input', { type: 'url', maxlength: 300, value: data.siteUrl, placeholder: 'https://staff.niceoperation.com' });
  const emailEnabled = h('input', { type: 'checkbox', checked: data.emailEnabled });
  const pushEnabled = h('input', { type: 'checkbox', checked: data.pushEnabled });
  const inAppEnabled = h('input', { type: 'checkbox', checked: data.inAppEnabled });
  const noticeEmail = h('input', { type: 'checkbox', checked: data.noticeEmail });

  const save = async () => {
    try {
      await api.updateNotifications({
        emailEnabled: emailEnabled.checked,
        pushEnabled: pushEnabled.checked,
        inAppEnabled: inAppEnabled.checked,
        noticeEmail: noticeEmail.checked,
        recipients: recipients.value.split('\n').map((s) => s.trim()).filter(Boolean),
        from: from.value.trim(),
        siteUrl: siteUrl.value.trim(),
      });
      toast('Saved.', 'good');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const test = async () => {
    try {
      const result = await api.testNotification();
      toast(result.ok ? 'Sent — check the inbox.' : `Not sent: ${result.result?.detail ?? 'see the log below'}`,
        result.ok ? 'good' : 'bad');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  return h('div',
    h('div.grid.grid-2',
      card('What gets sent', { note: 'One message a morning, and only when there is something to do' },
        h('label.inline-check', inAppEnabled, h('span', 'The bell inside the app')),
        h('label.inline-check', pushEnabled, h('span', 'Phone and desktop alerts')),
        h('label.inline-check', emailEnabled, h('span', 'The morning email digest')),
        h('label.inline-check', noticeEmail,
          h('span', 'Email every notice as well as ringing the bell')),
        h('p.muted', { style: { fontSize: '.85rem' } },
          'A notice goes only to whoever it names — the person it is addressed to, or whoever holds '
          + 'the permission it is for, worked out when it is sent rather than from a list somebody '
          + 'has to keep up to date. Somebody who is not in the app all day is exactly who it is for.'),
        h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
          'The morning digest is different: one message, and only when there is something to do '
          + 'about it. Only two things qualify — days that cannot be settled without somebody '
          + 'deciding, and an absence that has run long enough to stop being an oversight. An alert '
          + 'for every late arrival would be a dozen a morning, and everybody would learn to swipe '
          + 'them away.'),
      ),

      card('Email', {
        note: data.providerConfigured ? 'Provider key is set' : 'No provider key — email cannot send',
        actions: h('button.btn-sm', { onclick: test }, 'Send one now'),
      },
        h('label.field', h('span', 'Send to'), recipients),
        h('label.field', h('span', 'From address'), from),
        h('label.field', h('span', 'This site\'s address'), siteUrl,
          h('small.muted', 'Used for the link in the email and the alert')),
        !data.providerConfigured
          ? h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
            'Set RESEND_API_KEY as a Worker secret before email will send. Everything else here can be '
            + 'filled in now.')
          : null,
      ),
    ),

    h('div.btn-row', { style: { margin: '0 0 1rem' } },
      h('button.btn.btn-primary', { onclick: save }, 'Save notification settings')),

    card('Devices set up for alerts', { note: `${data.devices.length}`, wide: true },
      table([
        { key: 'label', label: 'Device', format: (v) => v || h('span.muted', 'unnamed') },
        { key: 'name', label: 'Belongs to', format: (v) => v || h('span.muted', 'the recovery sign-in') },
        { key: 'created_at', label: 'Turned on', format: (v) => (v ? v.slice(0, 16) : '—') },
        {
          key: 'actions',
          label: '',
          format: (v, r) => h('button.btn-sm', {
            onclick: async () => {
              if (!window.confirm('Stop alerting this device?')) return;
              await api.removePushDevice(r.id);
              toast('Removed.');
              await reload();
            },
          }, 'Remove'),
        },
      ], data.devices, {
        empty: 'None yet. Anybody can turn alerts on for their own device under "My account".',
      })),

    card('What has been sent', { note: 'Email on the left, alerts on the right', wide: true },
      h('div.grid.grid-2',
        h('div',
          h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'Email'),
          table([
            { key: 'at', label: 'When', format: (v) => h('small', v.slice(0, 16)) },
            { key: 'status', label: 'Result', format: (v) => h(`span.pill${v === 'sent' ? '.good' : '.bad'}`, v) },
            { key: 'detail', label: '', format: (v) => (v ? h('small.muted', v) : '') },
          ], data.log.slice(0, 8), { empty: 'Nothing sent yet.' }),
        ),
        h('div',
          h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'Alerts'),
          table([
            { key: 'at', label: 'When', format: (v) => h('small', v.slice(0, 16)) },
            { key: 'sent', label: 'Devices', align: 'right' },
            { key: 'status', label: 'Result', format: (v) => h(`span.pill${v === 'sent' ? '.good' : v === 'skipped' ? '' : '.bad'}`, v) },
          ], data.pushLog.slice(0, 8), { empty: 'Nothing sent yet.' }),
        ),
      )),
  );
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function dataTab(reload) {
  const from = h('input', { type: 'date' });
  const to = h('input', { type: 'date', value: todayISO() });
  const confirm = h('input', { type: 'text', placeholder: 'type ERASE' });
  const preview = h('div.erase-preview');

  const summarise = async () => {
    try {
      const data = await api.dataSummary(from.value || null, to.value || null);
      const bounded = data.from && data.to;
      mount(preview, h('div.alert', { class: 'warn' },
        h('span.alert-icon', '⚠️'),
        h('div',
          h('div.alert-title', bounded
            ? `${fmtDay(data.from)} to ${fmtDay(data.to)}`
            : 'Everything ever recorded'),
          h('div.alert-detail',
            `${fmtNum(data.willDelete.punches, 0)} punches, ${fmtNum(data.willDelete.days, 0)} days and `
            + `${fmtNum(data.willDelete.leave, 0)} leave records would be deleted. `
            + `${fmtNum(data.willKeep.staff, 0)} staff, ${fmtNum(data.willKeep.shifts, 0)} shifts, `
            + `${fmtNum(data.willKeep.holidays, 0)} holidays and ${fmtNum(data.willKeep.users, 0)} logins are kept.`),
        )));
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const erase = async () => {
    if (confirm.value.trim() !== 'ERASE') {
      toast('Type ERASE in the box to confirm.', 'bad');
      return;
    }
    if (!window.confirm('This cannot be undone. Go ahead?')) return;
    try {
      await api.eraseData({
        confirm: confirm.value.trim(),
        from: from.value || null,
        to: to.value || null,
      });
      toast('Erased.', 'good');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  from.addEventListener('change', summarise);
  to.addEventListener('change', summarise);
  await summarise();

  return h('div',
    card('Erase recorded attendance', {
      note: 'For clearing a trial run before going live',
      wide: true,
    },
      h('p.muted',
        'Deletes punches, computed days, leave and the rota inside the dates. People, shifts, absence '
        + 'reasons, public holidays, terminals and logins are never touched — erasing is for the records, '
        + 'not for starting the property again.'),
      h('div.field-row',
        h('label.field', h('span', 'From (blank means the beginning)'), from),
        h('label.field', h('span', 'To'), to),
      ),
      preview,
      h('div.field-row', { style: { marginTop: '.8rem' } },
        h('label.field', h('span', 'Type ERASE to confirm'), confirm),
      ),
      h('button.btn.btn-danger', { onclick: erase }, 'Erase these records'),
    ),
  );
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

async function auditTab() {
  const data = await api.audit(200);

  return h('div',
    card('Every decision, and who made it', {
      note: 'Newest first',
      wide: true,
    },
      table([
        { key: 'at', label: 'When', format: (v) => h('small', v.slice(0, 16)) },
        { key: 'actor', label: 'Who' },
        { key: 'action', label: 'What', format: (v) => h('code', { style: { fontSize: '.78rem' } }, v) },
        { key: 'entity', label: 'Which', format: (v) => (v ? h('small.muted', v) : '') },
        {
          key: 'detail',
          label: 'Detail',
          format: (v) => (v ? h('small.muted', { style: { wordBreak: 'break-word' } }, v.slice(0, 160)) : ''),
        },
      ], data.entries, { empty: 'Nothing recorded yet.' })),

    !data.entries.length
      ? emptyState('Nothing yet', 'Confirmations, rota changes and leave decisions all land here.')
      : null,
  );
}
