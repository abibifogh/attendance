import { api } from '../api.js';
import { confirmAction, fmtDay, fmtNum, h, mount, toast, todayISO } from '../util.js';
import { card, emptyState, table } from './components.js';
import { field, formDialog } from './att-shared.js';
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
            h('small.muted', r.email
              // An address is what they type; a PIN is worth saying as well,
              // because it is the half somebody forgets they handed out.
              ? `${r.email}${r.role === 'admin' && r.hasPin ? ' · and a PIN' : ''}`
              : `signs in with a ${r.signsInWith}`),
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

    await payrollGrantsCard(reload),

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

/**
 * Who may open the payroll, and until when.
 *
 * The tick on somebody's login says they are the kind of person who might.
 * This says they may at the moment, it has an end date on it, and it comes
 * with a code they have to type. All three, because what people are paid is
 * the one thing in here that cannot be un-seen.
 */
async function payrollGrantsCard(reload) {
  let data;
  try {
    data = await api.payrollGrants();
  } catch {
    return null;
  }

  const rows = data.people.map((person) => {
    const a = person.access;
    return h('tr',
      h('td',
        h('strong', person.name),
        h('small.muted', ` · ${person.role}`)),
      h('td', person.admin
        ? h('span.pill.good', 'Administrator')
        : accessPill(a)),
      h('td', person.admin
        ? h('div',
          h('div', a.hasPin ? 'PIN set' : 'No PIN yet'),
          h('small.muted', 'Granted nothing: an administrator is who grants.'))
        : accessWhen(a)),
      h('td.num',
        h('div.btn-row', { style: { justifyContent: 'flex-end' } },
          person.admin
            ? null
            : h('button.btn-sm', {
              onclick: () => grantTo(person, data, reload),
            }, a.state === 'none' ? 'Grant it' : 'New code'),
          a.hasPin
            ? h('button.btn-ghost.btn-sm', {
              title: 'They choose a new one the next time they open the payroll',
              onclick: async () => {
                if (!confirmAction(`Reset ${person.name}’s payroll PIN? They choose a new `
                  + 'one the next time they open the payroll, and anything they have open now '
                  + 'is shut.')) return;
                await api.payrollResetPin(person.id);
                toast('Reset. They choose a new one.', 'good');
                await reload();
              },
            }, 'Reset PIN')
            : null,
          person.admin || a.state === 'none'
            ? null
            : h('button.btn-ghost.btn-sm', {
              title: 'Take it away now',
              onclick: async () => {
                if (!confirmAction(`Take payroll away from ${person.name}? It stops the moment `
                  + 'you press this, even if they have it open.')) return;
                await api.payrollRevoke(person.id);
                toast('Taken away.', 'good');
                await reload();
              },
            }, '✕'))));
  });

  return card('Who may open the payroll', {
    wide: true,
    note: `${data.people.filter((p) => p.admin || p.access.state !== 'none').length}`,
  },
  h('p.muted', { style: { fontSize: '.85rem', marginTop: 0 } },
    'Four locks, not one. "Pay and labour cost" on a login says somebody is the kind of person '
    + 'who might. A grant here says they may at the moment, and it runs out. A code they are '
    + 'given says the grant reached the right person. And a PIN of their own, different from '
    + 'the one they sign in with, is asked for every single time the payroll is opened. '
    + 'Administrators are granted nothing, but they set a PIN like everybody else.'),

  rows.length
    // In a wrapper, like every other table here. Four columns of names, pills
    // and dates is wider than a handset, and without one it was the table that
    // took the whole page sideways rather than scrolling on its own.
    ? h('div.table-wrap', h('table', h('thead', h('tr',
      h('th', 'Login'), h('th', 'Payroll'), h('th', 'PIN and dates'), h('th', ''))),
    h('tbody', rows)))
    : h('p.muted', 'Nobody has "Pay and labour cost" on their login yet.'));
}

function accessPill(a) {
  if (a.state === 'open') return h('span.pill.good', 'Open now');
  if (a.state === 'setup') return h('span.pill', 'Granted, no PIN yet');
  if (a.state === 'shut') return h('span.pill', 'Granted, shut');
  if (a.state === 'locked') return h('span.pill.bad', 'Locked out');
  if (a.state === 'expired') return h('span.pill.bad', 'Run out');
  return h('span.muted', 'Not granted');
}

function accessWhen(a) {
  if (a.state === 'none') return h('span.muted', '—');
  return h('div',
    h('div', when(a.expiresAt)),
    h('div', h('small.muted', a.hasPin ? 'PIN set' : 'No PIN yet')),
    a.unlockedUntil && a.state === 'open'
      ? h('div', h('small.muted', `Open until ${when(a.unlockedUntil)}`))
      : null,
    a.grantedBy ? h('div', h('small.muted', `Given by ${a.grantedBy}`)) : null);
}

function when(value) {
  if (!value) return '—';
  const t = new Date(String(value).replace(' ', 'T') + 'Z');
  if (Number.isNaN(t.getTime())) return String(value);
  return t.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Grant it, and show the code once.
 *
 * Once, because only its fingerprint is kept. A lost code is replaced with a
 * new one rather than looked up, which is how every other code in this app
 * works and the reason none of them can be read out of a backup.
 */
async function grantTo(person, data, reload) {
  const days = h('select', { name: 'days' },
    [[7, 'A week'], [30, 'A month'], [90, 'Three months'], [180, 'Six months']]
      .map(([n, label]) => h('option', { value: n, selected: n === 30 }, label)));

  const done = await formDialog({
    title: `Payroll for ${person.name}`,
    submitLabel: person.access.state === 'none' ? 'Grant it' : 'Grant it again',
    body: h('div',
      h('p.muted', { style: { fontSize: '.9rem', marginTop: 0 } },
        person.access.state === 'none'
          ? 'They will be given a code to type once, and they choose a payroll PIN of their '
            + 'own with it. The code stops working altogether when the grant below runs out.'
          : 'This replaces what they have: a new code, a new end date, and anything they have '
            + 'open now is shut. Their PIN is their own and stays as it is.'),
      field('For how long', days, 'You can take it away sooner at any time'),
      field('Why (optional)', h('input', {
        type: 'text', name: 'note', maxlength: 200, placeholder: 'Covering the month end',
      }))),
    onSubmit: (form) => api.payrollGrant({
      userId: person.id,
      days: Number(form.get('days')),
      note: form.get('note'),
    }),
  });

  if (!done) return;
  await showCode(done);
  await reload();
}

function showCode(made) {
  return new Promise((resolve) => {
    const dialog = h('dialog.app-dialog.app-dialog-narrow',
      h('div.dialog-head',
        h('h2', `${made.name}\u2019s payroll code`),
        h('button.dialog-close', {
          type: 'button', 'aria-label': 'Close', onclick: () => dialog.close(),
        }, '✕')),
      h('p.muted', { style: { fontSize: '.9rem' } },
        'Give them this. It is shown once and only its fingerprint is kept, so a lost one is '
        + 'replaced rather than looked up.'),
      h('div.pay-code-shown', made.code),
      h('p.muted', { style: { fontSize: '.85rem' } },
        'They type it once and choose a payroll PIN with it; after that the PIN is all they '
        + `type. The code stops working on ${when(made.expiresAt)}.`),
      h('div.btn-row',
        h('button.btn-sm', {
          type: 'button',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(made.code);
              toast('Copied.', 'good');
            } catch {
              toast('Copy it by hand: this browser will not let a page do it.', 'warn');
            }
          },
        }, 'Copy it'),
        h('button.btn.btn-primary', { type: 'button', onclick: () => dialog.close() }, 'Done')));

    dialog.addEventListener('close', () => { dialog.remove(); resolve(); });
    document.body.append(dialog);
    dialog.showModal();
  });
}

function roleLabel(roles, key) {
  return roles.find((r) => r.key === key)?.label ?? key;
}

/**
 * Add or edit a login.
 *
 * The credential half changes shape with the role. An administrator must have
 * an email address and a password, and may have a PIN as well for the tablet
 * in the kitchen; everybody else has a PIN and nothing else. The password is
 * stretched here, in the browser, and only the derived key is sent — see
 * crypto.js for why.
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

  // Taking an administrator's PIN away again, which is not the same as leaving
  // the box blank: blank keeps what they had.
  const dropPin = h('input', { type: 'checkbox' });
  const dropPinRow = h('label.inline-check', { style: { display: 'none' } },
    dropPin, h('span', 'Take the PIN away, so only the password signs them in'));

  const pinLabel = h('span', 'PIN');
  const pinHint = h('small.muted', { style: { display: 'none' } });
  const pinField = h('label.field', pinLabel, pin, pinHint);
  const emailField = h('label.field', h('span', 'Email address'), email);
  const passwordField = h('label.field', h('span', 'Password'), password);

  const roleHint = h('p.muted', { style: { fontSize: '.85rem' } });

  // Whether this login belongs to somebody who is also on the rota.
  //
  // Asked of every role, not only the staff one. A supervisor who works
  // shifts, a manager who covers a night and an administrator who is also on
  // the payroll all have a staff record, and pointing the login at it is what
  // gives them My shifts, My report, My advance and My claims. For the staff
  // role the question does not arise: the answer is yes and the only thing
  // left to say is which record.
  const staffSelect = h('select',
    h('option', { value: '' }, 'Choose…'),
    (data.staff ?? []).map((p) => h('option', {
      value: String(p.id), selected: String(existing?.staffId ?? '') === String(p.id),
    }, `${p.name}${p.department ? ` · ${p.department}` : ''} · No. ${p.employee_no}`)));

  const onRota = h('select',
    h('option', { value: 'no' }, 'No, this login only'),
    h('option', { value: 'yes', selected: Boolean(existing?.staffId) }, 'Yes, they work shifts here'));

  const staffNote = h('small.muted', 'Their own, and nothing else');

  const staffField = h('label.field',
    h('span', 'Which staff record'),
    staffSelect,
    staffNote);

  const rotaField = h('label.field',
    h('span', 'Are they a member of staff?'),
    onRota,
    h('small.muted', 'Somebody on the rota sees their own week as well as whatever else they do'));

  const showStaff = () => {
    const isStaffRole = roleSelect.value === 'staff';
    rotaField.style.display = isStaffRole ? 'none' : '';
    staffField.style.display = isStaffRole || onRota.value === 'yes' ? '' : 'none';
    staffNote.textContent = isStaffRole
      ? 'Their own, and nothing else'
      : 'Their own shifts, report, advances and claims, on top of what the role gives them';
  };
  onRota.addEventListener('change', showStaff);

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
    // An address is worth keeping on file for anybody; only an administrator
    // signs in with one.
    emailField.style.display = '';
    passwordField.style.display = isAdmin ? '' : 'none';

    // An administrator's PIN is theirs to have or not. Everybody else's is the
    // only way they get in, so it is not optional and there is nothing to drop.
    pinLabel.textContent = isAdmin ? 'PIN (optional)' : 'PIN';
    pinHint.style.display = isAdmin ? '' : 'none';
    pinHint.textContent = isAdmin
      ? 'A second way in for the tablet, alongside the password. The payroll asks for its own '
        + 'PIN either way.'
      : '';
    pin.placeholder = existing?.hasPin
      ? 'leave blank to keep'
      : isAdmin ? 'none set' : '4 to 10 digits';
    dropPinRow.style.display = isAdmin && existing?.hasPin ? '' : 'none';
    if (!isAdmin || !existing?.hasPin) dropPin.checked = false;
    showStaff();
  };

  roleSelect.addEventListener('change', () => { custom = null; applyRole(); });
  for (const c of checkboxes) {
    c.box.addEventListener('change', () => {
      custom = checkboxes.filter((x) => x.box.checked).map((x) => x.key);
    });
  }

  const problem = h('p.form-error', { style: { display: 'none' } });

  const dialog = h('dialog.app-dialog.app-dialog-wide',
    h('div.dialog-head',
      h('h2', existing ? `Edit ${existing.name}` : 'Add a person'),
      h('button.dialog-close', {
        'aria-label': 'Close', onclick: () => dialog.close(),
      }, '✕'),
    ),
    h('div.field-row',
      h('label.field', h('span', 'Name'), name),
      h('label.field', h('span', 'Role'), roleSelect),
      h('label.field', h('span', 'Status'), active),
      pinField,
      emailField,
      passwordField,
      rotaField,
      staffField,
    ),
    dropPinRow,
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
    h('div.btn-row',
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
      staffId: (roleSelect.value === 'staff' || onRota.value === 'yes')
        ? (staffSelect.value || null)
        : null,
    };

    if (roleSelect.value === 'staff' && !payload.staffId) {
      problem.textContent = 'Say whose shifts this login is for. Without it there is nothing '
        + 'for them to open.';
      problem.style.display = '';
      return;
    }

    if (roleSelect.value !== 'staff' && onRota.value === 'yes' && !payload.staffId) {
      problem.textContent = 'Choose which staff record is theirs, or answer No above.';
      problem.style.display = '';
      return;
    }

    try {
      if (roleSelect.value === 'admin') {
        payload.email = email.value.trim();
        if (password.value) {
          if (password.value.length < 10) throw new Error('The password must be at least 10 characters.');
          // Stretched here, in the browser. Only the derived key travels — see
          // crypto.js for why that is not merely belt and braces.
          Object.assign(payload, await prepareNewPassword(password.value));
        }
        if (pin.value) payload.pin = pin.value.trim();
        else if (dropPin.checked) payload.clearPin = true;
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

/** What each gateway calls itself, so the list is not three lowercase words. */
const GATEWAY_NAMES = { arkesel: 'Arkesel', mnotify: 'mNotify', hubtel: 'Hubtel' };

async function alertsTab(reload) {
  const data = await api.notifications();

  const recipients = h('textarea', {
    rows: 3,
    placeholder: 'one address per line',
    value: data.recipients.join('\n'),
  });
  const senderName = h('input', {
    type: 'text', maxlength: 60, value: data.senderName ?? '', placeholder: 'HIVE',
  });
  const from = h('input', { type: 'text', maxlength: 200, value: data.from, placeholder: 'HIVE <hive@niceoperation.com>' });
  const replyTo = h('input', { type: 'text', maxlength: 200, value: data.replyTo ?? '', placeholder: 'someone@niceoperation.com' });
  const siteUrl = h('input', { type: 'url', maxlength: 300, value: data.siteUrl, placeholder: 'https://staff.niceoperation.com' });
  const emailEnabled = h('input', { type: 'checkbox', checked: data.emailEnabled });
  const pushEnabled = h('input', { type: 'checkbox', checked: data.pushEnabled });
  const inAppEnabled = h('input', { type: 'checkbox', checked: data.inAppEnabled });
  const noticeEmail = h('input', { type: 'checkbox', checked: data.noticeEmail });

  const smsEnabled = h('input', { type: 'checkbox', checked: data.smsEnabled });
  const smsProvider = h('select', ...(data.smsProviders ?? []).map((name) => h('option', {
    value: name, selected: name === data.smsProvider,
  }, GATEWAY_NAMES[name] ?? name)));
  const smsSender = h('input', {
    type: 'text', maxlength: 11, value: data.smsSender ?? '', placeholder: 'HIVE',
  });
  const smsReach = h('select',
    h('option', { value: 'gap', selected: data.smsReach !== 'all' },
      'Only phones that cannot show an alert'),
    h('option', { value: 'all', selected: data.smsReach === 'all' },
      'Everybody whose week changed'));
  const testNumber = h('input', { type: 'tel', maxlength: 20, placeholder: '024 123 4567' });

  const save = async () => {
    try {
      await api.updateNotifications({
        emailEnabled: emailEnabled.checked,
        pushEnabled: pushEnabled.checked,
        inAppEnabled: inAppEnabled.checked,
        noticeEmail: noticeEmail.checked,
        recipients: recipients.value.split('\n').map((s) => s.trim()).filter(Boolean),
        from: from.value.trim(),
        senderName: senderName.value.trim(),
        replyTo: replyTo.value.trim(),
        siteUrl: siteUrl.value.trim(),
        smsEnabled: smsEnabled.checked,
        smsProvider: smsProvider.value,
        smsSender: smsSender.value.trim(),
        smsReach: smsReach.value,
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

  const textOne = async () => {
    if (!testNumber.value.trim()) {
      toast('Type a mobile number to send the test to.', 'bad');
      return;
    }
    try {
      const result = await api.testText(testNumber.value.trim());
      toast(result.ok ? 'Sent. Check the phone.' : `Not sent: ${result.reason ?? 'see the log below'}`,
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
        h('label.field', h('span', 'Sender name'), senderName,
          h('small.muted', 'The name on the mail, which is the first thing anybody reads. '
            + 'Leave it empty for HIVE')),
        h('label.field', h('span', 'From address'), from,
          h('small.muted', 'Must be at a domain your email provider has verified. A name '
            + 'written into this box wins over the one above')),
        h('label.field', h('span', 'Reply to'), replyTo,
          h('small.muted', 'Where a reply lands. Leave empty and replies go to the From address')),
        h('label.field', h('span', 'This site\'s address'), siteUrl,
          h('small.muted', 'Used for the link in the email and the alert')),
        !data.providerConfigured
          ? h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
            'Set RESEND_API_KEY as a Worker secret before email will send. Everything else here can be '
            + 'filled in now.')
          : null,
      ),
    ),

    card('Text messages', {
      note: data.smsReady ? 'Ready to send' : `Not set up yet: ${(data.smsMissing ?? []).join(', ')}`,
      wide: true,
      actions: h('button.btn-sm', { onclick: textOne }, 'Send a test'),
    },
      h('p.muted', { style: { fontSize: '.85rem', marginTop: 0 } },
        'An iPhone 7 Plus stops at iOS 15, and a home-screen app needs iOS 16.4 before it can '
        + 'show an alert at all. Those phones will never buzz, however long we wait. A text '
        + 'reaches every one of them, so a published rota goes out that way as well. Numbers '
        + 'come from each person\'s record under People.'),
      h('div.grid.grid-2',
        h('div',
          h('label.inline-check', { style: { marginBottom: '.75rem' } },
            smsEnabled, h('span', 'Text staff when a rota is published')),
          h('label.field', h('span', 'Who gets a text'), smsReach,
            h('small.muted', 'Only the ones an alert cannot reach is the cheaper answer, and '
              + 'the reason this exists')),
        ),
        h('div',
          h('label.field', h('span', 'Gateway'), smsProvider,
            h('small.muted', 'Set SMS_API_KEY as a Worker secret. Hubtel needs SMS_API_SECRET '
              + 'as well')),
          h('label.field', h('span', 'Sender name'), smsSender,
            h('small.muted', 'What the message shows it is from. Eleven characters, letters and '
              + 'digits, and it has to be registered with the gateway first')),
          h('label.field', h('span', 'Send a test to'), testNumber,
            h('small.muted', 'A real message at the usual price, so somebody can prove it works '
              + 'without publishing anything')),
        ),
      )),

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

    card('What has been sent', { note: 'Email, alerts and texts', wide: true },
      h('div.grid.grid-3',
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
        h('div',
          h('div.stat-label', { style: { marginBottom: '.4rem' } }, 'Texts'),
          table([
            { key: 'at', label: 'When', format: (v) => h('small', v.slice(0, 16)) },
            { key: 'sent', label: 'Sent', align: 'right' },
            { key: 'status', label: 'Result', format: (v) => h(`span.pill${v === 'sent' ? '.good' : v === 'part sent' ? '' : '.bad'}`, v) },
          ], (data.smsLog ?? []).slice(0, 8), { empty: 'Nothing sent yet.' }),
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
