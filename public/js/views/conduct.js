import { api } from '../api.js';
import { replaceParams, state } from '../app.js';
import { fmtDay, h, money, mount, toast } from '../util.js';
import { emptyState } from './components.js';
import { field, formDialog, niceMonth } from './att-shared.js';

/**
 * Bonus deductions for breaking a house rule.
 *
 * A fixed amount per rule, set in Settings › Pay & tax, levied by an
 * administrator with one press. It comes off the month's bonus, and off
 * salary where there is no bonus to take it from. The person is told at once
 * and can reply on My pay.
 */

const initials = (name) => String(name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
export const canLevy = () => state.role === 'admin' && !state.viewAs;

/**
 * The quick levy: the rules as buttons with their amounts, a note, and what
 * they already have this month. Resolves true once one is levied.
 */
export async function levyDialog(staff, { onDone } = {}) {
  let data;
  try {
    data = await api.conductForStaff(staff.id);
  } catch (err) {
    toast(err.message, 'bad');
    return false;
  }
  const rules = data.rules ?? [];
  if (!rules.length) {
    toast('There are no bonus deductions set up. Add them in Settings › Pay & tax.', 'bad');
    return false;
  }
  const cash = (n) => money(n, 'GHS');
  const had = data.thisMonth ?? [];
  const twice = (r) => r.doubleRepeat && had.some((x) => x.ruleId === r.id);
  let picked = null;
  const list = h('div.conduct-pick');
  const hint = h('p.conduct-hint', 'Pick what it was for.');
  const draw = () => {
    mount(list, rules.map((r) => h('button', {
      type: 'button',
      class: picked === r.id ? 'conduct-rule on' : 'conduct-rule',
      'aria-pressed': String(picked === r.id),
      onclick: () => { picked = r.id; draw(); },
    },
    h('span.conduct-rule-name', r.name, r.note ? h('small', r.note) : null),
    h('strong', twice(r) ? cash(r.amount * 2) : cash(r.amount),
      twice(r) ? h('small.conduct-double', 'second this month, doubled') : null))));
    const r = rules.find((x) => x.id === picked);
    hint.textContent = r
      ? `${cash(twice(r) ? r.amount * 2 : r.amount)} off ${staff.name.split(' ')[0]}’s bonus this month, or off salary where there is no bonus. They are told at once.`
      : 'Pick what it was for.';
  };
  draw();
  const got = await formDialog({
    title: `Bonus deduction for ${staff.name}`,
    submitLabel: 'Levy it',
    body: h('div.conduct-dialog',
      had.length
        ? h('p.muted.conduct-had', `Already this month: ${had.map((x) => `${x.rule} ${cash(x.amount)} (${fmtDay(x.day)})`).join(', ')}.`)
        : null,
      list,
      field('What happened', h('textarea', { name: 'note', rows: 2, maxlength: 400, placeholder: 'On the phone at the bar during service' }),
        'They see this with the deduction.'),
      field('On', h('input', { type: 'date', name: 'day', value: data.today, max: data.today })),
      hint),
    onSubmit: async (form) => {
      if (!picked) throw new Error('Pick what it was for.');
      return api.levyConduct({
        staffId: staff.id, ruleId: picked, note: String(form.get('note') || '').trim(), day: form.get('day') || data.today,
      });
    },
  });
  if (!got) return false;
  const undo = h('button.toast-undo', {
    type: 'button',
    onclick: async () => {
      try {
        await api.dropConduct(got.id, { reason: 'Levied by mistake', quiet: true });
        toast('Undone.', 'good');
        onDone?.();
      } catch (err) { toast(err.message, 'bad'); }
    },
  }, 'Undo');
  toast(h('span', `${cash(got.amount)} off ${staff.name}${got.doubled ? ' (doubled)' : ''}. They have been told. `, undo), 'good');
  onDone?.();
  return true;
}

/** A small button that opens the levy, for a row or a record. Admins only. */
export function levyButton(staff, { onDone, cls = 'btn-sm', label = '− Bonus deduction' } = {}) {
  if (!canLevy()) return null;
  return h(`button.${cls}.conduct-levy-btn`, {
    type: 'button',
    title: `Bonus deduction for ${staff.name}`,
    onclick: () => levyDialog(staff, { onDone }),
  }, label);
}

/** Money › Advances › Bonus deductions. */
export async function renderConduct(params = {}) {
  const host = h('div.late-page.conduct-page');
  const data = await api.conduct(params.month ? { month: params.month } : {});
  const cash = (n) => money(n, data.currency || 'GHS');
  const reload = (next = {}) => {
    const merged = { ...params, ...next };
    replaceParams('conduct', { month: merged.month ?? null });
    renderConduct(merged).then((el) => host.replaceWith(el));
  };

  const drop = async (l) => {
    const got = await formDialog({
      title: `Drop ${l.rule.toLowerCase()} for ${l.staff.name}`,
      submitLabel: `Drop ${cash(l.amount)}`,
      body: h('div',
        l.reply ? h('p', h('strong', 'They said: '), `“${l.reply.text}”`) : null,
        field('Why', h('textarea', { name: 'reason', rows: 2, maxlength: 300, placeholder: 'A manager had said they could go' }),
          'They are told it was dropped, with this.')),
      onSubmit: async (form) => api.dropConduct(l.id, { reason: String(form.get('reason') || '').trim() }),
    });
    if (got) { toast('Dropped. They have been told.', 'good'); reload(); }
  };

  const levyOne = () => {
    const pick = h('select', { name: 'who', required: true },
      h('option', { value: '' }, 'Choose somebody…'),
      (data.people ?? []).map((p) => h('option', { value: p.id }, p.department ? `${p.name} · ${p.department}` : p.name)));
    formDialog({
      title: 'Levy a bonus deduction',
      submitLabel: 'Next',
      body: field('Who', pick),
      onSubmit: async (form) => {
        const who = (data.people ?? []).find((p) => String(p.id) === String(form.get('who')));
        if (!who) throw new Error('Choose somebody.');
        return who;
      },
    }).then((who) => { if (who) levyDialog(who, { onDone: () => reload() }); });
  };

  const levies = data.levies ?? [];
  const listEl = levies.length
    ? h('div.late-list',
      h('div.late-row.conduct-row.late-head',
        h('span'), h('span', 'Person'), h('span', 'When · by'), h('span', 'What · note · their reply'), h('span', 'Amount'), h('span')),
      levies.map((l) => {
        const dropped = l.status === 'dropped';
        return h('div', { class: `late-row conduct-row${dropped ? ' is-dropped' : ''}` },
          h('span.late-face', initials(l.staff.name)),
          h('div.late-who', h('strong', l.staff.name), h('small', l.staff.department ?? '')),
          h('div.late-shift', h('span', fmtDay(l.day)), h('small', l.leviedBy)),
          h('div.conduct-what',
            h('strong', { class: dropped ? 'is-struck' : '' }, l.rule),
            l.doubled ? h('span.late-pill.conduct-doubled', 'doubled') : null,
            l.note ? h('small', l.note) : null,
            dropped ? h('small', `Dropped by ${l.dropped.by}${l.dropped.reason ? `: ${l.dropped.reason}` : ''}`) : null,
            l.reply ? h('small.conduct-reply', h('span.conduct-replied', 'Replied'), ` “${l.reply.text}”`) : null),
          h('div.late-amount',
            h('strong', { class: dropped ? 'is-waived' : '' }, cash(l.amount)),
            h('small', l.closed ? `paid in ${niceMonth(l.month)}` : dropped ? 'dropped' : `off ${niceMonth(l.month)}`)),
          h('div.late-actions',
            data.canLevy && !dropped && !l.closed
              ? h('button.btn-sm', { type: 'button', onclick: () => drop(l) }, 'Drop it')
              : null));
      }))
    : emptyState('No bonus deductions this month',
      data.canLevy ? 'Use “− Levy one” above, or the button on Today and on a staff record.' : 'An administrator levies them.');

  const tile = (big, label, cls = '') => h('div', { class: `late-tile ${cls}` }, h('strong', big), h('span', label));
  const t = data.totals ?? {};

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Bonus deductions'),
        h('p.muted.late-sub', `${niceMonth(data.month)} · off each person’s bonus when that payroll is worked out, `
          + 'or off salary where there is no bonus to take it from.')),
      h('div.btn-row',
        (data.months ?? []).length > 1
          ? h('select', { 'aria-label': 'Payroll month', onchange: (e) => reload({ month: e.target.value }) },
            data.months.map((m) => h('option', { value: m, selected: m === data.month }, niceMonth(m))))
          : null,
        h('a.btn-sm', { href: '#/settings?section=pay&panel=conduct' }, 'The list and amounts'),
        data.canLevy ? h('button.btn.btn-primary', { type: 'button', onclick: levyOne }, '− Levy one') : null)),
    h('div.late-tiles',
      tile(String(t.count ?? 0), `levied this month · ${t.people ?? 0} ${t.people === 1 ? 'person' : 'people'}`),
      tile(cash(t.amount ?? 0), 'coming off', 'is-taken'),
      tile(String(t.replied ?? 0), 'replied to'),
      tile(String(levies.filter((l) => l.status === 'dropped').length), 'dropped', 'is-waived')),
    h('div.conduct-layout',
      h('section.late-card', listEl),
      h('div.conduct-side',
        h('div.late-note',
          h('strong', 'By rule this month'),
          (data.byRule ?? []).length
            ? h('div.conduct-byrule', data.byRule.map((b) => h('div', h('span', b.rule), h('b', `${b.count} · ${cash(b.amount)}`))))
            : h('p', 'None yet.')),
        h('div.late-note',
          h('strong', 'On the payroll'),
          h('p', 'Each one is named under the bonus on the payslip. Where the bonus is smaller, the rest comes off salary, '
            + 'never below nothing; what still does not fit waits for the next month.'),
          h('p', 'Drop one any time until that payroll is closed.')))),
  );
  return host;
}

/** Settings › Pay & tax › Bonus deductions: the list and whether to tell people. */
export async function renderConductSetup() {
  const host = h('div.late-setup.conduct-setup');
  const data = await api.conductRules().catch((err) => ({ error: err.message }));
  if (data.error) {
    mount(host, emptyState('Bonus deductions', data.error));
    return host;
  }
  const edit = Boolean(data.canEdit) && canLevy();
  const rows = (data.rules ?? []).map((r) => ({ ...r }));
  const notifyBox = h('input', { type: 'checkbox', checked: data.notify, disabled: !edit });
  const table = h('div.conduct-rules');

  const draw = () => mount(table,
    h('div.conduct-rule-row.conduct-rule-head', h('span', 'What'), h('span', 'Shown under it'), h('span', 'Amount'),
      h('span', 'Second time in a month'), h('span', 'In use')),
    rows.map((r) => h('div.conduct-rule-row',
      h('input', { value: r.name, maxlength: 80, disabled: !edit, 'aria-label': 'What', oninput: (e) => { r.name = e.target.value; } }),
      h('input', { value: r.note ?? '', maxlength: 120, disabled: !edit, placeholder: 'Shown under it', 'aria-label': 'Shown under it', oninput: (e) => { r.note = e.target.value; } }),
      h('input', { type: 'number', min: 1, max: 10000, step: '0.5', value: r.amount, disabled: !edit, 'aria-label': 'Amount', oninput: (e) => { r.amount = Number(e.target.value); } }),
      h('select', { disabled: !edit, 'aria-label': 'Second time in a month', onchange: (e) => { r.doubleRepeat = e.target.value === 'double'; } },
        h('option', { value: 'same', selected: !r.doubleRepeat }, 'The same'),
        h('option', { value: 'double', selected: r.doubleRepeat }, 'Doubled')),
      h('input', { type: 'checkbox', checked: r.active !== false, disabled: !edit, 'aria-label': 'In use', onchange: (e) => { r.active = e.target.checked; } }))));
  draw();

  const save = async () => {
    try {
      await api.saveConductRules({ rules: rows.filter((r) => String(r.name ?? '').trim()), notify: notifyBox.checked });
      toast('Saved.', 'good');
      mount(host, ...(await renderConductSetup()).childNodes);
    } catch (err) { toast(err.message, 'bad'); }
  };

  mount(host,
    h('p.muted', { style: { marginTop: 0, maxWidth: '44rem' } },
      'Fixed amounts off the month’s bonus for breaking a house rule, and off salary where there is no bonus to take them from. '
      + 'Only an administrator levies one, from Today, a staff record, or Money › Advances › Bonus deductions.'),
    table,
    edit ? h('div.btn-row',
      h('button.btn-sm', { type: 'button', onclick: () => { rows.push({ name: '', note: '', amount: 10, doubleRepeat: false, active: true }); draw(); } }, '+ Add one')) : null,
    h('p.muted', { style: { fontSize: '.82rem' } },
      'A change to an amount applies from then on; what was already levied keeps its amount. '
      + 'Switched off, a rule leaves the quick levy but stays on past records.'),
    h('label.late-switch', notifyBox, h('span', h('strong', 'Tell the person'),
      h('small.muted', 'A message with the reason and the amount the moment it is levied, and again if it is dropped.'))),
    edit ? h('div.btn-row', h('button.btn.btn-primary', { type: 'button', onclick: save }, 'Save')) : null,
  );
  return host;
}

/** The staff side: My pay › Deductions, each with a place to reply. */
export async function renderMyConduct() {
  const host = h('div.my-conduct');
  const data = await api.myConduct().catch(() => ({ levies: [] }));
  const levies = data.levies ?? [];
  const cash = (n, cur) => money(n, cur || 'GHS');
  const card = (l) => {
    const dropped = l.status === 'dropped';
    const text = h('textarea', { rows: 3, maxlength: 600, placeholder: 'Anything to say about it?' }, l.reply?.text ?? '');
    return h('div', { class: `card my-conduct-card${dropped ? ' is-dropped' : ''}` },
      h('div.my-conduct-top', h('strong', l.rule), h('b', { class: dropped ? 'is-struck' : '' }, `− ${cash(l.amount, l.currency)}`)),
      h('small.muted', [fmtDay(l.day), l.leviedBy, l.note ? `“${l.note}”` : null].filter(Boolean).join(' · ')),
      dropped
        ? h('small.my-conduct-state.is-good', `Dropped${l.dropped?.reason ? `: ${l.dropped.reason}` : ''}. Nothing comes off.`)
        : h('small.my-conduct-state', l.closed ? `Taken in ${niceMonth(l.month)}` : `Off your ${niceMonth(l.month)} bonus, or salary where there is no bonus`),
      !dropped && !l.closed
        ? h('div.my-conduct-reply',
          text,
          h('button.btn.btn-primary', {
            type: 'button',
            onclick: async () => {
              const said = String(text.value || '').trim();
              if (!said) { toast('Write something first.', 'bad'); return; }
              try { await api.replyConduct({ id: l.id, text: said }); toast('Sent. An administrator sees it beside the deduction.', 'good'); } catch (err) { toast(err.message, 'bad'); }
            },
          }, l.reply ? 'Change my reply' : 'Send my reply'))
        : (l.reply ? h('small.muted', `You said: “${l.reply.text}”`) : null));
  };
  mount(host,
    h('div.page-head', h('div', h('h1', 'Deductions'),
      h('p.muted', 'Bonus deductions for a house rule broken: what for, when, and who levied it. You can reply to each one.'))),
    levies.length
      ? h('div.my-conduct-list', levies.map(card))
      : emptyState('Nothing here', 'No bonus deductions.'),
  );
  return host;
}
