import { api } from '../api.js';
import { replaceParams } from '../app.js';
import { fmtDay, h, money, mount, toast } from '../util.js';
import { emptyState } from './components.js';
import { field, formDialog, niceMonth } from './att-shared.js';

/**
 * Money › Advances › Late charges.
 *
 * Every late charge in a payroll month, one per line: who, the shift, when
 * they clocked in and how late, what they said about it, and the charge. An
 * administrator keeps or waives each; anything not looked at comes off pay
 * unless it is waived. Whoever does the wages sees it all.
 */

const SHOW = [
  ['all', 'Everything'],
  ['open', 'Not looked at'],
  ['kept', 'Kept'],
  ['waived', 'Waived'],
];

const WAIVE_WHY = ['Transport', 'Asked to come later', 'Terminal fault', 'Clocked in late, was here', 'Other'];

const initials = (name) => String(name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

export async function renderLateCharges(params = {}) {
  const host = h('div.late-page');
  const data = await api.lateCharges(params.month ? { month: params.month } : {});
  const cash = (n) => money(n, data.rule?.currency || 'GHS');
  const rule = data.rule ?? {};
  let show = SHOW.some(([k]) => k === params.show) ? params.show : 'all';

  const reload = (next = {}) => {
    const merged = { ...params, ...next };
    replaceParams('late-charges', { month: merged.month ?? null, show: merged.show ?? null });
    renderLateCharges(merged).then((el) => host.replaceWith(el));
  };

  const decide = async (ids, action, note = null) => {
    try {
      const out = await api.decideLateCharges({ ids, action, note });
      toast(action === 'waive' ? 'Waived. They have been told, with your reason.'
        : action === 'keep' ? `Kept ${out.changed === 1 ? 'it' : `all ${out.changed}`}. They have been told.`
          : 'Back to not looked at.', 'good');
      reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const waive = async (c) => {
    const got = await formDialog({
      title: `Waive ${c.staff.name}, ${fmtDay(c.day)}`,
      submitLabel: `Waive ${cash(c.amount)}`,
      body: h('div',
        h('p.muted', { style: { marginTop: 0 } },
          `${c.shift ? `${c.shift.name} ${c.shift.from}–${c.shift.to}` : 'Their shift'} · in ${c.clockIn}, ${c.minutes} min late`),
        c.reason ? h('p', h('strong', 'They said: '), [c.reason.label, c.reason.text].filter(Boolean).join(' · ')) : null,
        field('Why', h('select', { name: 'kind' }, WAIVE_WHY.map((w) => h('option', { value: w }, w)))),
        field('Anything to add', h('textarea', { name: 'text', rows: 2, maxlength: 400, placeholder: 'Trotro broke down at Kasoa, called at 08:50' }),
          'They are told it was waived, with your reason.'),
      ),
      onSubmit: async (form) => {
        const kind = form.get('kind');
        const text = String(form.get('text') || '').trim();
        return { note: text ? `${kind}: ${text}` : kind };
      },
    });
    if (got) decide([c.id], 'waive', got.note);
  };

  const all = data.charges ?? [];
  const open = all.filter((c) => c.status === 'open' && !c.closed);
  const count = (k) => (k === 'all' ? all.length : all.filter((c) => c.status === k).length);

  const listEl = h('div.late-list');
  const chipsEl = h('div.late-chips');

  const draw = () => {
    mount(chipsEl, SHOW.map(([k, label]) => h('button', {
      type: 'button',
      class: show === k ? 'late-chip on' : 'late-chip',
      'aria-pressed': String(show === k),
      onclick: () => { show = k; replaceParams('late-charges', { month: params.month ?? null, show: k }); draw(); },
    }, label, h('span.late-chip-n', String(count(k))))));

    const rows = all.filter((c) => show === 'all' || c.status === show);
    if (!rows.length) {
      mount(listEl, emptyState(
        all.length ? 'Nothing here' : 'Nobody late enough to be charged',
        all.length ? 'Pick another filter above.' : `Clocking in ${rule.minutes ?? 15} minutes or more after a shift starts shows here.`,
      ));
      return;
    }
    mount(listEl,
      h('div.late-row.late-head',
        h('span'), h('span', 'Person'), h('span', 'Shift'), h('span', 'Clocked in'), h('span', 'Their reason'), h('span', 'Charge'), h('span')),
      rows.map((c) => {
        const waived = c.status === 'waived';
        const stateText = c.closed ? `paid in ${niceMonth(c.month)}`
          : c.status === 'open' ? 'taken unless waived' : c.status === 'kept' ? 'kept' : 'waived';
        return h('div', { class: `late-row is-${c.status}` },
          h('span.late-face', initials(c.staff.name)),
          h('div.late-who',
            h('strong', c.staff.name),
            h('small', [c.staff.department, c.countThisMonth === 1 ? 'first this month' : `${c.countThisMonth} this month`].filter(Boolean).join(' · '))),
          h('div.late-shift',
            h('span', fmtDay(c.day)),
            h('small', c.shift ? `${c.shift.name} ${c.shift.from}–${c.shift.to}` : '')),
          h('div.late-in',
            h('strong', c.clockIn ?? '—'), ' ',
            h('span.late-pill', `${c.minutes} min late`)),
          h('div', { class: c.reason ? 'late-why' : 'late-why is-none' },
            c.reason ? [c.reason.label, c.reason.text].filter(Boolean).join(' · ') : 'No reason given'),
          h('div.late-amount',
            h('strong', { class: waived ? 'is-waived' : '' }, cash(c.amount)),
            h('small', stateText)),
          h('div.late-actions',
            !data.canDecide || c.closed ? null
              : c.status === 'open'
                ? [h('button.btn-sm.late-keep', { type: 'button', onclick: () => decide([c.id], 'keep') }, 'Keep'),
                  h('button.btn-sm', { type: 'button', onclick: () => waive(c) }, 'Waive…')]
                : [h('small.late-by', c.decided
                  ? `${waived ? 'Waived' : 'Kept'} by ${c.decided.by}${c.decided.note ? ` · ${c.decided.note}` : ''}` : ''),
                h('button.btn-sm', { type: 'button', onclick: () => decide([c.id], 'reopen') }, 'Change')]));
      }));
  };
  draw();

  const tile = (big, label, cls = '') => h('div', { class: `late-tile ${cls}` }, h('strong', big), h('span', label));

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Late charges'),
        h('p.muted.late-sub',
          `${cash(rule.amount ?? 20)} for clocking in ${rule.minutes ?? 15} minutes or more after the shift starts. `,
          `Each one comes off the ${niceMonth(data.month)} payroll unless you waive it.`,
          rule.on ? null : h('strong', ' The charge is switched off in Settings.'))),
      h('div.btn-row',
        (data.months ?? []).length > 1
          ? h('select', { 'aria-label': 'Payroll month', onchange: (e) => reload({ month: e.target.value }) },
            data.months.map((m) => h('option', { value: m, selected: m === data.month }, niceMonth(m))))
          : null,
        data.canDecide && open.length
          ? h('button.btn.btn-primary', { type: 'button', onclick: () => decide(open.map((c) => c.id), 'keep') },
            `Keep the ${open.length} not looked at`)
          : null)),
    h('div.late-tiles',
      tile(String(data.totals?.count ?? 0), `late ${rule.minutes ?? 15} min or more`),
      tile(String(data.totals?.open ?? 0), 'not looked at yet · taken unless waived', 'is-open'),
      tile(cash(data.totals?.taken ?? 0), `coming off ${niceMonth(data.month)} pay`, 'is-taken'),
      tile(cash(data.totals?.waivedAmount ?? 0), `waived (${data.totals?.waived ?? 0})`, 'is-waived')),
    h('section.late-card', chipsEl, listEl),
    h('div.late-layout',
      h('div.late-side',
        h('div.late-note',
          h('strong', 'Taken off by itself'),
          h('p', 'When the clock-in is corrected to on time, or the day is excused on Today or Sign-off, the charge goes. '
            + 'A shift moved later on the rota counts from its new start.'),
          h('p', 'A charge never takes anybody’s take-home below nothing; what does not fit waits for the next payroll. '
            + 'Once a payroll is closed, new charges go to the next open month.')),
        h('div.late-note',
          h('strong', 'The rule'),
          h('p', rule.on ? `On, ${cash(rule.amount)} at ${rule.minutes} minutes, from ${fmtDay(rule.from, { withYear: true })}.` : 'Switched off.'),
          h('a', { href: '#/settings?section=pay&panel=late' }, 'Change it in Settings')))),
  );
  return host;
}

/**
 * Settings › Pay & tax › Late charges: the rule, who it does not apply to,
 * and how many have accepted it in the app.
 */
export async function renderLateRuleSetup() {
  const host = h('div.late-setup');
  const data = await api.lateRule().catch((err) => ({ error: err.message }));
  if (data.error) {
    mount(host, emptyState('Late charges', data.error));
    return host;
  }
  const redraw = async () => mount(host, ...(await renderLateRuleSetup()).childNodes);
  const rule = data.rule;
  const edit = Boolean(data.canEdit);

  const onBox = h('input', { type: 'checkbox', name: 'on', checked: rule.on, disabled: !edit });
  const notifyBox = h('input', { type: 'checkbox', name: 'notify', checked: rule.notify, disabled: !edit });
  const amount = h('input', { type: 'number', name: 'amount', min: 1, max: 1000, step: '0.5', value: rule.amount, disabled: !edit });
  const minutes = h('input', { type: 'number', name: 'minutes', min: 1, max: 240, value: rule.minutes, disabled: !edit });
  const from = h('input', { type: 'date', name: 'from', value: rule.from, disabled: !edit });

  const save = async () => {
    try {
      await api.saveLateRule({
        on: onBox.checked, notify: notifyBox.checked,
        amount: Number(amount.value), minutes: Number(minutes.value), from: from.value,
      });
      toast('Saved.', 'good');
      redraw();
    } catch (err) { toast(err.message, 'bad'); }
  };
  const setExempt = async (staffId, exempt) => {
    try { await api.lateExempt({ staffId, exempt }); redraw(); } catch (err) { toast(err.message, 'bad'); }
  };

  const others = (data.people ?? []).filter((p) => !p.exempt);
  const picker = h('select', { 'aria-label': 'Somebody it does not apply to', disabled: !edit },
    h('option', { value: '' }, 'Add somebody…'),
    others.map((p) => h('option', { value: p.id }, p.department ? `${p.name} · ${p.department}` : p.name)));
  picker.addEventListener('change', () => { if (picker.value) setExempt(Number(picker.value), true); });

  mount(host,
    h('div.late-setup-grid',
      h('label.late-switch', onBox, h('span', h('strong', 'Charge for clocking in late'),
        h('small.muted', 'Comes off salary on the next open payroll, unless an administrator waives it.'))),
      field('Amount', amount, rule.currency),
      field('When they clock in at least', minutes, 'minutes after the shift starts, by the terminal or a corrected time'),
      field('From the shifts of', from, 'Nothing before this day is charged.'),
      h('label.late-switch', notifyBox, h('span', h('strong', 'Tell staff while they can still avoid it'),
        h('small.muted', 'Five minutes into the shift with nothing recorded, and again at the charge minute.')))),
    edit ? h('div.btn-row', h('button.btn.btn-primary', { type: 'button', onclick: save }, 'Save')) : null,
    h('h3.late-setup-h', 'Not charged'),
    h('div.late-exempt',
      (data.exempt ?? []).length
        ? data.exempt.map((p) => h('span.late-exempt-chip', p.name,
          edit ? h('button', { type: 'button', 'aria-label': `Charge ${p.name} again`, onclick: () => setExempt(p.id, false) }, '✕') : null))
        : h('span.muted', 'Nobody. Everybody on the rota is charged.'),
      edit ? picker : null),
    h('h3.late-setup-h', 'The written agreement'),
    h('p.muted', `${data.accepted?.yes ?? 0} of ${data.accepted?.total ?? 0} staff have accepted the late charge in the app. `
      + 'The contract templates carry it, and the handbook draft has it under Hours and Pay: publish those two chapters '
      + 'to ask everybody to acknowledge it. Charges apply whether or not somebody has accepted it yet.'),
  );
  return host;
}
