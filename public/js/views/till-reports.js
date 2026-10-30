import { api } from '../api.js';
import { replaceParams } from '../app.js';
import { fmtSince, h, mount, shiftDay, toast, todayISO } from '../util.js';
import { card, emptyState } from './components.js';
import { field, formDialog } from './att-shared.js';
import { historyCard } from './att-my-till.js';

/**
 * Till reports: every closing report from the front desk, and the ones owed.
 *
 * What is still owed comes first, with a Chase button each and one for
 * everybody, and when each was last chased. Under it, every reception shift in
 * the week with its report: signed when, the drawer, and the one-line summary
 * the owner gets. A shift somebody did not clock in for owes nothing and says
 * so rather than being chased.
 */

const SLOT = { morning: 'Morning', afternoon: 'Afternoon', night: 'Night' };
const STATE = {
  in: ['Submitted', 'good'],
  owed: ['Still not in', 'bad'],
  reopened: ['Reopened, not in again', 'bad'],
  not_worked: ['Not worked', ''],
  not_asked: ['Not in · before 15 Oct, not asked for', ''],
  running: ['Shift still running', 'warn'],
};

const cedis = (pesewas) => `GH₵ ${(Number(pesewas || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dayText = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const when = (row) => `${SLOT[row.slot] ?? row.slot} · ${dayText(row.day)}`;

export async function renderTillReports(params = {}) {
  const host = h('div.till-reports');
  const to = /^\d{4}-\d{2}-\d{2}$/.test(params.to) ? params.to : todayISO();
  const from = shiftDay(to, -6);

  let data;
  try {
    data = await api.tillReports(from, to);
  } catch (err) {
    mount(host, h('div.page-head', h('div', h('h1', 'Till'))),
      emptyState('Could not load the reports', err.message));
    return host;
  }

  const reload = async (next = {}) => {
    const merged = { ...params, ...next };
    replaceParams('till-reports', merged);
    mount(host, await renderTillReports(merged));
  };

  const chase = async (row, button) => {
    button.disabled = true;
    try {
      await api.chaseTill({ userId: row.userId, day: row.day, slot: row.slot });
      toast(`Chased ${row.name.split(/\s+/)[0]}.`, 'good');
      await reload();
    } catch (err) {
      button.disabled = false;
      toast(err.message, 'bad');
    }
  };

  // Every version of one report, read-only, in a dialog over the list.
  const showHistory = async (row) => {
    try {
      const { shift } = await api.tillHistory(row.userId, row.day, row.slot);
      if (!shift) { toast('No report on record for that shift.', 'bad'); return; }
      await formDialog({
        title: `${row.name} · ${when(row)}`,
        submitLabel: 'Close',
        wide: true,
        body: historyCard(shift),
        onSubmit: async () => true,
      });
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  // Let them submit it again: the report is kept, marked reopened with the
  // reason, and they are told what to put right.
  const allowAgain = async (row) => {
    const reason = h('textarea', { rows: 3, maxlength: 400, required: true, placeholder: 'e.g. The drawer was counted before the last guest paid' });
    const done = await formDialog({
      title: `Let ${row.name.split(/\s+/)[0]} submit it again`,
      submitLabel: 'Allow resubmission',
      body: h('div',
        h('p.muted', `${when(row)}. The report stays on record as it is, and the corrected one is kept beside it. `
          + 'They are told straight away, and it counts as owed until it is in again.'),
        field('What needs putting right', reason, 'They see this, word for word.')),
      onSubmit: async () => {
        if (!reason.value.trim()) throw new Error('Say what needs putting right.');
        await api.reopenTillReport(row.reportId, reason.value.trim());
        return true;
      },
    });
    if (done) {
      toast(`${row.name.split(/\s+/)[0]} can submit it again.`, 'good');
      await reload();
    }
  };

  const owed = data.rows.filter((r) => r.state === 'owed' || r.state === 'reopened')
    .sort((a, b) => `${a.day}${a.slot}`.localeCompare(`${b.day}${b.slot}`));

  const chaseAll = async (button) => {
    button.disabled = true;
    try {
      const out = await api.chaseTill({ all: true, from, to });
      toast(out.sent
        ? `Chased ${out.sent} report${out.sent === 1 ? '' : 's'}${out.skipped ? `; ${out.skipped} chased within the hour were left` : ''}.`
        : 'Everybody owed was chased within the hour already.', out.sent ? 'good' : '');
      await reload();
    } catch (err) {
      button.disabled = false;
      toast(err.message, 'bad');
    }
  };

  const tile = (n, label, tone = '') => h('div.card.home-tile', { class: tone ? `card home-tile is-${tone}` : 'card home-tile' },
    h('span.home-tile-n', String(n)), h('span.home-tile-l', label));

  const pill = (state) => {
    const [label, tone] = STATE[state] ?? [state, ''];
    return h(`span.pill${tone ? `.${tone}` : ''}`, label);
  };

  const owedRow = (row) => {
    const button = h('button.btn-sm', { type: 'button', onclick: () => chase(row, button) }, 'Chase');
    return h('div.tr-row',
      h('div.tr-main',
        h('strong', row.name),
        h('small.muted', [when(row), row.shift ? `${row.shift.name} ${row.shift.starts_at}–${row.shift.ends_at}` : null].filter(Boolean).join(' · ')),
        row.state === 'reopened' ? h('small.muted', `Reopened${row.reopenReason ? `: ${row.reopenReason}` : ''}`) : null),
      row.versions ? h('button.btn-sm.btn-ghost', { type: 'button', onclick: () => showHistory(row) }, 'History') : null,
      h('small.muted.tr-chased', row.chased ? `Chased ${fmtSince(row.chased.at)}${row.chased.times > 1 ? ` · ${row.chased.times} times` : ''}` : 'Not chased yet'),
      button);
  };

  const reportRow = (row) => h('div.tr-row',
    h('div.tr-main',
      h('strong', row.name),
      h('small.muted', [when(row), row.shift ? `${row.shift.name} ${row.shift.starts_at}–${row.shift.ends_at}` : 'Not on the rota for it'].join(' · ')),
      row.summary ? h('small.tr-summary', row.summary) : null),
    h('div.tr-side',
      pill(row.state),
      row.signedAt ? h('small.muted', `Signed ${dayText(row.signedAt.slice(0, 10))} ${row.signedAt.slice(11, 16)}`) : null,
      row.cash != null ? h('small', `Drawer ${cedis(row.cash)}`) : null,
      row.versions > 1 ? h('small.muted', `${row.versions} versions`) : null,
      row.versions
        ? h('div.btn-row.tr-actions',
          h('button.btn-sm.btn-ghost', { type: 'button', onclick: () => showHistory(row) }, 'History'),
          row.state === 'in' && row.reportId
            ? h('button.btn-sm', { type: 'button', onclick: () => allowAgain(row) }, 'Allow resubmission')
            : null)
        : null));

  const allButton = owed.length > 1
    ? h('button.btn.btn-primary', { type: 'button', onclick: () => chaseAll(allButton) }, `Chase all ${owed.length}`)
    : null;

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Till'),
        h('div.sub', `${dayText(from)} to ${dayText(to)} · every closing report from the front desk`)),
      h('div.btn-row',
        h('button.btn-sm', { type: 'button', 'aria-label': 'The week before', onclick: () => reload({ to: shiftDay(to, -7) }) }, '‹'),
        h('button.btn-sm', { type: 'button', onclick: () => reload({ to: null }) }, 'This week'),
        h('button.btn-sm', { type: 'button', 'aria-label': 'The week after', disabled: to >= todayISO(), onclick: () => reload({ to: shiftDay(to, 7) }) }, '›'))),

    h('div.home-tiles',
      tile(data.totals.in, 'Submitted', ''),
      tile(data.totals.owed, 'Still not in', data.totals.owed ? 'bad' : ''),
      tile(data.totals.notWorked, 'Not worked'),
      tile(data.totals.running, 'Shift running', data.totals.running ? 'warn' : '')),

    owed.length
      ? card('Still not in', { actions: allButton, note: 'Oldest first. A chase sends them a phone alert and an email.' },
        h('div.tr-list', owed.map(owedRow)))
      : card('Still not in', {}, h('p.muted', 'Nothing owed this week. Every shift that was worked has its report.')),

    card('Every report this week', {},
      data.rows.length
        ? h('div.tr-list', data.rows.map(reportRow))
        : h('p.muted', 'Nobody was on a reception shift this week.')),
  );
  return host;
}
