import { h, mount, money } from '../util.js';
import { api } from '../api.js';
import { banner } from './components.js';

/**
 * The till, from this side: what staff wrote when they closed their shift in
 * HIVE, set beside ASSD; what they answered for the shifts that did not agree;
 * the corrections supervisors are waiting on; and the settings for all of it.
 *
 * Four views inside the Shifts screen. What a supervisor gets of them is what
 * an admin chose under Till settings → Supervisor access, and the server cuts
 * the data to match before it is sent: a hidden amount never reaches this
 * page, it is not merely left undrawn.
 */

const SLOT = { morning: 'Morning', afternoon: 'Afternoon', night: 'Night' };
const LEVELS = [[0, 'Hidden'], [1, 'See'], [2, 'See and act']];
const AREA_TEXT = {
  day: ['Day', 'One day’s three shifts.'],
  week: ['Week', 'Seven days at a glance.'],
  month: ['Month', 'The calendar and week-by-week totals.'],
  reports: ['Closing reports from HIVE', 'Float, drawer, safe envelopes, POs, rentals, front desk checks.'],
  money: ['Cash, card and MoMo amounts', 'Without this a supervisor sees Agrees, Short or Over, never the amount. The Shift view needs it.'],
  moves: ['Correct cash movements', 'Act means propose a correction. It counts only once an admin approves it.'],
  answers: ['Staff answers', 'Act means accept an explanation or send it back.'],
  money_out: ['Write off, recover from pay, paid in cash', 'Recovering adds a one-month advance to the person’s HIVE pay.'],
  reopen: ['Reopen a signed report', 'So its person can send it again. The reason is kept.'],
  net: ['Each person’s net for the month', 'Running short and over per person, on the People view.'],
  bank: ['Bank statement and card matching', 'The Exceptions view: card and MoMo against the terminal and the bank.'],
  odoo: ['PO details from Odoo', 'Vendor and total behind each PO.'],
  files: ['Upload journal, statement and card report', 'The Files view. Act means load files.'],
  unpaid: ['Unpaid stays', 'Guests leaving in the next 24 hours who still owe, and guests who left owing. Act means answer them (an admin approves).'],
};
const KIND_TONE = { drawer: 'bad', unexplained: 'bad', overclaimed: 'warn', rental: 'warn', noreport: 'info' };
const OUTCOME = { accept: 'Accepted', recover: 'Recovered from pay', cash: 'Paid back in cash', writeoff: 'Written off', back: 'Sent back' };

const dayText = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const signed = (minor) => (minor == null ? '—' : minor === 0 ? money(0) : `${minor > 0 ? '+' : '−'}${money(Math.abs(minor))}`);
const pill = (tone, text) => h(`span.sh-chip.${tone}`, text);
const yes = (ok, good, bad) => (ok == null ? pill('none', '—') : ok ? pill('ok', `✓ ${good}`) : pill('short', `✗ ${bad}`));

/**
 * The till views for one period.
 *
 * `who` is `{ role, access }` from the sign-in; `period` the days on screen.
 */
export function tillViews({ who, period, onChange = () => {}, describeKey = (k) => k }) {
  const access = who?.access || {};
  const admin = who?.role === 'admin';
  let cache = null;

  // Kept for half a minute only: a report sent from HIVE while this screen is
  // open must show the next time the tab is opened, not after a reload.
  async function data(force = false) {
    const key = `${period().from}|${period().to}`;
    if (!force && cache?.key === key && Date.now() - cache.at < 30_000) return cache.value;
    const value = await api(`/till?from=${period().from}&to=${period().to}`);
    cache = { key, value, at: Date.now() };
    return value;
  }

  async function reload(v, draw) {
    cache = null;
    await draw(v);
    onChange();
  }

  const notLinked = (d) => (d.linked ? null : banner('warning',
    h('strong', 'HIVE and Insight are not linked yet. '),
    'Staff can close shifts in HIVE, but HIVE cannot check POs or show them their list until they are. '
    + 'In GitHub, run Actions → "Set Insight’s secrets" with Insight’s address in the box, then reload.'));

  // ---------------------------------------------------- closing reports --

  async function closing(v) {
    mount(v, h('p.muted', 'Reading the closing reports…'));
    const d = await data();
    const money_ = access.money > 0;
    const rows = d.reports;
    const sent = rows.filter((r) => r.report).length;
    const safeOff = rows.filter((r) => r.compare?.safeAgrees === false).length;
    const away = rows.flatMap((r) => (r.report?.checks || []).filter((c) => !c.ok).map((c) => ({ ...c, day: r.day, slot: r.slot })));
    const noPo = rows.filter((r) => (r.report?.expenses || []).some((e) => !e.counted)).length;

    mount(v,
      notLinked(d),
      h('div.sh-kpis',
        kpi('Closing reports', `${sent} of ${rows.length}`, rows.length - sent ? `${rows.length - sent} shift${rows.length - sent === 1 ? '' : 's'} with no report` : 'Every shift closed'),
        kpi('Safe against ASSD', safeOff ? `${safeOff} differ` : 'All agree', 'Envelope totals beside what ASSD labelled safe', safeOff ? 'var(--sh-bad-ink)' : null),
        kpi('Not at the desk', String(away.length), away.length ? away.slice(0, 2).map((c) => `${c.label}${c.guest ? `: ${c.guest}` : ''}`).join(' · ') : 'Every check said yes'),
        kpi('Expenses with no PO', String(noPo), noPo ? 'Reports with an expense not counted' : 'Every expense had a confirmed PO')),
      h('div.card',
        h('div.sh-cardhead', h('h2', 'Closing reports'), h('span.sh-sub', 'What staff signed in HIVE, beside what ASSD recorded.')),
        rows.length ? h('div.table-wrap', h('table.tl-table',
          h('thead', h('tr', ['Shift', 'Drawer', 'Safe', 'Out of the drawer', 'Expenses', 'Rentals', 'Checks', ''].map((t) => h('th', t)))),
          h('tbody', rows.map((r) => reportRow(r, money_)))))
          : h('p.muted', 'No shifts in these days.'),
        h('p.sh-sub', 'Drawer: what they counted, beside ASSD’s own closing count. Safe: their envelopes, beside what ASSD labelled safe. '
          + 'Out of the drawer: everything ASSD moved out has to be in an envelope or covered by a confirmed PO.')));
  }

  function kpi(label, value, note, colour = null) {
    return h('div.sh-kpi.tl-kpi', h('span.l', label), h('span.v.num', { style: colour ? `color:${colour}` : '' }, value), h('span.n', note));
  }

  function reportRow(r, money_) {
    const rep = r.report;
    const c = r.compare || {};
    const amt = (x) => (money_ ? money(x) : '');
    const shift = h('td',
      h('strong', `${SLOT[r.slot]} · ${dayText(r.day)}`),
      h('div.tl-small', rep ? `${rep.name} · ${String(rep.signedAt).slice(11, 16)}${rep.device ? ` · ${rep.device === 'pc' ? 'desk PC' : 'phone'}` : ''}` : (r.assdUser ? `ASSD: ${r.assdUser}` : '')),
      !r.inJournal ? h('div.tl-small', 'Not in the journal yet') : null,
      r.belongs ? h('div.tl-small.tl-warn', `ASSD has ${r.belongs.assdUser} on ${SLOT[r.belongs.slot]} · ${dayText(r.belongs.day)} with no report`) : null,
      rep && !rep.floatOk ? h('div', pill('over', `float out ${money_ ? signed(rep.floatDiff) : ''}`)) : null);
    if (!rep) {
      // Their report is on the shift beside this one, where ASSD has nobody.
      const near = r.nearby ? h('div.tl-near',
        h('span', `${r.nearby.name}’s report is filed under ${SLOT[r.nearby.slot]} · ${dayText(r.nearby.day)}`
          + `${r.nearby.signedAt ? ` (signed ${String(r.nearby.signedAt).slice(11, 16)})` : ''}. Wrong shift picked?`),
        access.reopen > 1 ? h('button.btn', { type: 'button', onclick: (e) => move(e, r) }, 'Move it to this shift') : null) : null;
      return h('tr.tl-missing', shift, h('td', { colspan: 7 },
        r.open ? pill('none', 'still open') : pill('short', 'No closing report'), near));
    }
    const env = rep.toSafe ? rep.envelopes.map((e) => `${e.no}${money_ ? ` ${money(e.amount)}` : ''}`).join(', ') : 'nothing';
    const drawer = h('td.num', amt(rep.cash),
      r.inJournal ? h('div', c.countAgrees == null ? pill('none', 'no ASSD count') : yes(c.countAgrees, 'ASSD count', `ASSD ${money_ ? money(c.assdClosing) : 'differs'}`)) : null);
    const safe = h('td', h('div', env),
      r.inJournal && rep.toSafe ? h('div', yes(c.safeAgrees, 'ASSD safe', `ASSD ${money_ ? money(c.safeLabelled) : 'differs'}`)) : null,
      r.inJournal && !rep.toSafe && c.safeLabelled ? h('div', pill('short', `✗ ASSD moved ${money_ ? money(c.safeLabelled) : 'cash'}`)) : null);
    const sign = money_ ? Math.sign(c.unexplained ?? 0) : c.unexplainedSign;
    const out = h('td.num', r.inJournal ? amt(c.out) : '',
      r.inJournal ? h('div', sign == null ? null : sign === 0 ? pill('ok', '✓ accounted for')
        : sign > 0 ? pill('short', `${money_ ? money(c.unexplained) : 'some'} not accounted for`)
          : pill('over', `${money_ ? money(-c.unexplained) : 'more'} claimed than moved`)) : null);
    const exp = h('td', rep.expenses.length ? rep.expenses.map((e) => h('div',
      e.counted ? pill('ok', '✓') : pill('short', '✗'), ' ', e.name || e.po || 'no PO', money_ && e.paid != null ? ` ${money(e.paid)}` : '',
      e.vendor ? h('span.tl-small', ` · ${e.vendor}`) : null,
      !e.counted ? h('span.tl-small', ` · ${{ claimed: 'claimed already', missing: 'not in Odoo', 'no-po': 'no PO', unchecked: 'not checked' }[e.state] || e.state}`) : null))
      : h('span.muted', 'none'));
    const rentals = h('td', (c.rentals || []).filter((x) => x.start != null).map((x) => h('div',
      `${x.label}: ${x.start} → ${x.end}`,
      x.gap == null ? null : x.gap === 0 ? pill('ok', '✓') : pill('short', `${x.gap > 0 ? '+' : ''}${x.gap}`),
      h('div.tl-small', [x.rented ? `${x.rented} rented` : null, x.returned ? `${x.returned} returned` : null, x.assdStock != null ? `ASSD counted ${x.assdStock}` : null].filter(Boolean).join(' · ') || 'none rented in ASSD'))));
    const checks = h('td', (rep.checks || []).map((k) => h('div', k.ok ? pill('ok', `✓ ${k.label}`) : pill('short', `✗ ${k.label}`),
      !k.ok ? h('div.tl-small', k.guest ? `With ${k.guest}` : k.why) : null)),
    rep.note ? h('div.tl-small', `“${rep.note}”`) : null);
    const act = h('td', access.reopen > 1 ? h('button.btn', { type: 'button', onclick: (e) => reopen(e, rep) }, 'Reopen') : null);
    return h('tr', shift, drawer, safe, out, exp, rentals, checks, act);
  }

  async function move(event, r) {
    const cell = event.target.closest('td');
    const said = h('span.tl-small');
    event.target.disabled = true;
    said.textContent = 'Moving…';
    cell.append(said);
    try {
      await api('/till/move', { method: 'POST', body: { reportId: r.nearby.id, day: r.day, slot: r.slot } });
      cache = null;
      mount(cell, pill('ok', `Moved to ${SLOT[r.slot]} · ${dayText(r.day)}. ${r.nearby.name} has been told.`));
      onChange();
    } catch (err) { said.textContent = err.message; event.target.disabled = false; }
  }

  async function reopen(event, rep) {
    const cell = event.target.closest('td');
    const reason = h('input', { type: 'text', placeholder: 'Why it is being reopened', required: true });
    mount(cell, h('form.tl-inline', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('/till/reopen', { method: 'POST', body: { reportId: rep.id, reason: reason.value } });
          cache = null;
          mount(cell, pill('ok', `Reopened. ${rep.name} has been told.`));
        } catch (err) { alert(err.message); }
      },
    }, reason, h('button.btn.primary', { type: 'submit' }, 'Reopen')));
    reason.focus();
  }

  // ------------------------------------------------------------- answers --

  async function answers(v) {
    mount(v, h('p.muted', 'Reading what staff answered…'));
    const d = await data();
    const list = d.issues || [];
    const waiting = list.filter((i) => i.status === 'answered');
    const withStaff = list.filter((i) => i.status === 'open');
    const settled = list.filter((i) => i.status === 'settled').slice(-20).reverse();
    const draw = (x) => reload(x, answers);
    mount(v,
      notLinked(d),
      h('div.card',
        h('div.sh-cardhead', h('h2', `Waiting for a decision (${waiting.length})`), h('span.sh-sub', 'Settling one takes it off that person’s list in HIVE, and they are told.')),
        waiting.length ? h('div.tl-cards', waiting.map((i) => issueCard(i, v, draw))) : h('p.muted', 'Nothing waiting. What staff answer under To sort out in HIVE arrives here.')),
      h('div.card',
        h('div.sh-cardhead', h('h2', `Still with staff (${withStaff.length})`), h('span.sh-sub', 'On their list in HIVE, not answered yet.')),
        withStaff.length ? h('div.tl-cards', withStaff.map((i) => issueCard(i, v, draw))) : h('p.muted', 'Nobody has anything outstanding.')),
      d.net ? netCard(d.net) : null,
      settled.length ? h('div.card',
        h('div.sh-cardhead', h('h2', 'Settled lately')),
        h('div.table-wrap', h('table',
          h('thead', h('tr', ['Shift', 'Who', 'What', 'Decision', 'By'].map((t) => h('th', t)))),
          h('tbody', settled.map((i) => h('tr',
            h('td', `${SLOT[i.slot]} · ${dayText(i.day)}`), h('td', i.name || '—'), h('td', d.kinds[i.kind] || i.kind),
            h('td', OUTCOME[i.decision?.outcome] || '—', i.decision?.amount && access.money ? ` ${money(i.decision.amount)}` : ''),
            h('td', i.decision?.by || '—'))))))) : null);
  }

  function netCard(net) {
    return h('div.card',
      h('div.sh-cardhead', h('h2', 'This month, per person'), h('span.sh-sub', 'Every difference put on their list, settled or not.')),
      h('div.table-wrap', h('table',
        h('thead', h('tr', ['Who', 'Short', 'Over', 'Net', 'Times'].map((t) => h('th', t)))),
        h('tbody', net.map((p) => h('tr', h('td', p.name || `HIVE ${p.userId}`), h('td.num', money(p.short)), h('td.num', money(p.over)),
          h('td.num', signed(p.net)), h('td.num', String(p.count))))))));
  }

  function issueCard(i, v, draw) {
    const actAnswers = access.answers > 1;
    const actMoney = access.money_out > 1;
    const amount = i.kind === 'rental' ? `${Math.abs(i.qty)} ${i.rental}${Math.abs(i.qty) === 1 ? '' : 's'} ${i.qty < 0 ? 'missing' : 'extra'}`
      : access.money ? (i.amount ? signed(i.amount) : '') : (i.amount < 0 ? 'Short' : i.amount > 0 ? 'Over' : '');
    const note = h('textarea', { rows: 2, placeholder: 'A note for them (optional; needed to send it back)' });
    const decide = (outcome) => async (e) => {
      if (outcome === 'back' && !note.value.trim()) { note.focus(); note.placeholder = 'Say what more you need from them'; return; }
      e.target.disabled = true;
      try {
        await api('/till/resolve', { method: 'POST', body: { key: i.key, userId: i.userId, outcome, note: note.value } });
        await draw(v);
      } catch (err) { alert(err.message); e.target.disabled = false; }
    };
    // A shortage of money or of a rental's deposit: either can be paid back.
    const short = i.amount < 0;
    return h(`div.tl-issue.${KIND_TONE[i.kind] || 'info'}`,
      h('div.tl-issue-head', h('strong', i.name || (i.assdUser ? `ASSD ${i.assdUser}` : 'Nobody named')), h('span.tl-amount', amount)),
      h('div.tl-small', `${SLOT[i.slot]} · ${dayText(i.day)} · ${i.kind ? ({ drawer: 'drawer', unexplained: 'cash out, no envelope or PO', overclaimed: 'more claimed than moved', rental: 'rental count', noreport: 'no closing report' })[i.kind] : ''}`),
      h('p.tl-text', i.text),
      i.answer ? h('div.tl-said', h('b', i.answer.how === 'repay' ? 'Will pay it back' : i.answer.how === 'po' ? 'Added a PO' : 'Their explanation'), i.answer.text) : null,
      i.decision?.outcome === 'back' ? h('div.tl-small', `Sent back by ${i.decision.by}: ${i.decision.note || ''}`) : null,
      i.userId == null ? h('p.tl-small', 'Nobody to ask: map this ASSD login to a HIVE person under Till settings → People.') : null,
      i.userId != null && (actAnswers || actMoney) ? h('div',
        note,
        h('div.tl-actions',
          actAnswers ? h('button.btn.primary', { type: 'button', onclick: decide('accept') }, 'Accept') : null,
          actMoney && short && i.answer?.how === 'repay' ? h('button.btn', { type: 'button', onclick: decide('recover'), title: 'A one-month advance in HIVE, off the next payslip' }, 'Recover from pay') : null,
          actMoney && short ? h('button.btn', { type: 'button', onclick: decide('cash') }, 'Paid in cash') : null,
          actMoney ? h('button.btn', { type: 'button', onclick: decide('writeoff') }, 'Write off') : null,
          actAnswers && i.status === 'answered' ? h('button.btn', { type: 'button', onclick: decide('back') }, 'Send back') : null),
        actMoney && short && i.answer?.how !== 'repay' ? h('p.tl-small', 'Recover from pay appears once they have agreed to pay it back.') : null) : null);
  }

  // ----------------------------------------------------------- approvals --

  async function approvals(v) {
    mount(v, h('p.muted', 'Reading the corrections…'));
    const d = await data(true);
    const list = d.approvals || [];
    const what = (a) => ({
      expenses: 'was an expense', safe: 'went to the safe', split: `was split, ${money(a.expenses)} of it expenses`,
      duplicate: `is a duplicate of ASSD ${a.pair}`, reverses: `puts back ASSD ${a.pair}`,
    })[a.kind] || a.kind;
    const answers = d.answerApprovals || [];
    mount(v,
      h('div.card',
        h('div.sh-cardhead', h('h2', `Exceptions answered by a supervisor (${answers.length})`),
          h('span.sh-sub', 'Nothing a supervisor answers or reconciles is cleared until you approve it. Reject puts it back on the list.')),
        answers.length ? h('div.tl-cards', answers.map((a) => h('div.tl-issue.warn',
          h('div.tl-issue-head', h('strong', a.by), h('span.tl-small', String(a.at).slice(0, 16))),
          h('p.tl-text', a.type === 'link' ? `Reconciled ${a.keys.length} exceptions together:` : `Answered “${a.answer}” for:`),
          h('ul.tl-keys', a.keys.map((k) => h('li', describeKey(k)))),
          a.note ? h('div.tl-said', h('b', 'Note'), a.note) : null,
          h('div.tl-actions',
            h('button.btn.primary', { type: 'button', onclick: decideAnswer(a, true) }, 'Approve'),
            h('button.btn', { type: 'button', onclick: decideAnswer(a, false) }, 'Reject')))))
          : h('p.muted', 'Nothing waiting.')),
      h('div.card',
      h('div.sh-cardhead', h('h2', `Supervisor corrections (${list.length})`), h('span.sh-sub', 'Nothing a supervisor corrects counts until you approve it.')),
      list.length ? h('div.tl-cards', list.map((a) => h('div.tl-issue.warn',
        h('div.tl-issue-head', h('strong', a.by), h('span.tl-amount', money(a.amount))),
        h('div.tl-small', `ASSD ${a.seq} · ${a.day ? dayText(a.day) : ''} · ${a.user || ''} · ${String(a.at).slice(0, 16)}`),
        h('p.tl-text', `Says this movement ${what(a)}.`),
        a.note ? h('div.tl-said', h('b', 'Why'), a.note) : null,
        h('div.tl-actions',
          h('button.btn.primary', { type: 'button', onclick: decide(a, true) }, 'Approve'),
          h('button.btn', { type: 'button', onclick: decide(a, false) }, 'Reject')))))
        : h('p.muted', 'Nothing waiting.')));
    function decideAnswer(a, ok) {
      return async (e) => {
        e.target.disabled = true;
        try {
          await api('/till/approve', { method: 'POST', body: { [a.type]: a.id, ok } });
          onChange();
          await reload(v, approvals);
        } catch (err) { alert(err.message); e.target.disabled = false; }
      };
    }
    function decide(a, ok) {
      return async (e) => {
        e.target.disabled = true;
        try {
          await api('/till/approve', { method: 'POST', body: { seq: a.seq, ok } });
          await reload(v, approvals);
        } catch (err) { alert(err.message); e.target.disabled = false; }
      };
    }
  }

  // ------------------------------------------------------------ settings --

  let settingsTab = 'access';
  let accessFor = 0;

  async function settings(v) {
    mount(v, h('p.muted', 'Reading the settings…'));
    const d = await data(true);
    const s = d.settings;
    const tabs = [['access', 'Supervisor access'], ['checks', 'Front desk checks'], ['rentals', 'Rentals'], ['notify', 'Who is told'], ['people', 'People'], ['small', 'Small differences and check-out']];
    const save = async (body) => {
      try {
        await api('/till/settings', { method: 'POST', body });
        await reload(v, settings);
      } catch (err) { alert(err.message); }
    };
    const body = { access: accessView, checks: checksView, rentals: rentalsView, notify: notifyView, people: peopleView, small: smallView }[settingsTab](s, save);
    mount(v,
      notLinked(d),
      h('div.tl-subtabs', tabs.map(([k, l]) => h('button', { type: 'button', 'aria-selected': String(settingsTab === k), onclick: () => { settingsTab = k; settings(v); } }, l))),
      body);
  }

  function accessView(s, save) {
    const level = (area) => {
      const own = s.access.filter((r) => Number(r.account_id) === Number(accessFor));
      const use = accessFor && own.length ? own : s.access.filter((r) => Number(r.account_id) === 0);
      return Number(use.find((r) => r.area === area)?.level ?? 0);
    };
    const hasOwn = (id) => s.access.some((r) => Number(r.account_id) === Number(id));
    let group = '';
    const groups = { day: 'Views', reports: 'Shifts', answers: 'Staff answers', bank: 'Money sources' };
    return h('div.card',
      h('div.sh-cardhead', h('h2', 'What supervisors see'), h('span.sh-sub', 'A supervisor is an account given Insight with the Supervisor role under Accounts. They see the Shifts tab and nothing else.')),
      s.supervisors.length ? null : banner('info', 'Nobody is a supervisor yet. Under Accounts, set somebody’s Insight access to Supervisor.'),
      h('div.tl-who',
        h('button', { type: 'button', 'aria-selected': String(!accessFor), onclick: () => { accessFor = 0; rerender(); } }, 'Every supervisor'),
        s.supervisors.map((p) => h('button', { type: 'button', 'aria-selected': String(accessFor === p.id), onclick: () => { accessFor = p.id; rerender(); } },
          p.name, hasOwn(p.id) ? ' ·' : ''))),
      accessFor ? h('p.sh-sub', hasOwn(accessFor)
        ? h('span', 'This person has their own settings. ', h('button.btn', { type: 'button', onclick: () => save({ access: { accountId: accessFor, reset: true } }) }, 'Use everybody’s instead'))
        : 'Showing everybody’s settings. Change one and this person gets their own copy.') : null,
      h('div.tl-access', s.areas.map((a) => {
        const head = groups[a.key] && groups[a.key] !== group ? h('div.tl-group', (group = groups[a.key])) : null;
        const now = level(a.key);
        return [head, h('div.tl-arow',
          h('div', h('strong', AREA_TEXT[a.key]?.[0] || a.key), h('div.tl-small', AREA_TEXT[a.key]?.[1] || '')),
          h('div.tl-tri', LEVELS.filter(([n]) => n <= a.max).map(([n, label]) => h('button', {
            type: 'button', 'aria-pressed': String(now === n), onclick: () => save({ access: { accountId: accessFor, area: a.key, level: n } }),
          }, label))))];
      })));
    function rerender() { const v = document.querySelector('.sh-view'); if (v) settings(v); }
  }

  function checksView(s, save) {
    const label = h('input', { type: 'text', placeholder: 'Iron, umbrella, spare key…', maxlength: 60 });
    return h('div.card',
      h('div.sh-cardhead', h('h2', 'Front desk checks'), h('span.sh-sub', 'Staff look for each at the end of their shift. A No needs the guest who has it, or an explanation, before they can sign.')),
      h('div.tl-list', s.checks.map((c) => h('div.tl-arow',
        h('div', h('strong', c.label), h('div.tl-small', `"Is the ${c.label.toLowerCase()} at the front desk now?"`)),
        h('label.check', h('input', { type: 'checkbox', checked: Boolean(c.active), onchange: (e) => save({ check: { id: c.id, active: e.target.checked } }) }), c.active ? 'Asked' : 'Not asked')))),
      h('form.tl-inline', { onsubmit: (e) => { e.preventDefault(); if (label.value.trim()) save({ check: { label: label.value.trim() } }); } },
        label, h('button.btn.primary', { type: 'submit' }, 'Add')),
      h('p.tl-small', 'A switched-off item stops being asked from the next report. Past answers are kept.'));
  }

  function rentalsView(s, save) {
    return h('div.card',
      h('div.sh-cardhead', h('h2', 'Rentals at reception'), h('span.sh-sub', 'Counted by staff at the start and end of a shift. Fewer means one was rented, so ASSD should have a deposit; more means one came back, so ASSD should have a refund.')),
      h('div.tl-cards', s.rentals.map((r) => {
        const article = h('input', { type: 'text', value: r.article, inputmode: 'numeric', maxlength: 3, style: 'width:5rem' });
        const deposit = h('input', { type: 'number', step: '0.01', min: '0', value: (r.deposit / 100).toFixed(2), style: 'width:7rem' });
        const refund = h('input', { type: 'number', step: '0.01', min: '0', value: (r.refund / 100).toFixed(2), style: 'width:7rem' });
        return h(`div.tl-issue.${r.active ? 'good' : 'info'}`,
          h('div.tl-issue-head', h('strong', r.label), r.active ? pill('ok', 'Counted on every report') : pill('none', 'Set up, not counted yet')),
          h('div.tl-fields',
            h('label', 'ASSD article', article), h('label', 'Guest pays (GH₵)', deposit), h('label', 'Guest gets back (GH₵)', refund)),
          h('p.tl-small', `Kept by the property: ${money(r.deposit - r.refund)} each.${r.id === 'towel' ? ' ASSD books the towel as article 400 (the GH₵ 30 deposit) plus 551 (the GH₵ 10 rental); towels are counted by 400.' : ''}`),
          h('div.tl-actions',
            h('button.btn', { type: 'button', onclick: () => save({ rental: { id: r.id, article: article.value, deposit: deposit.value, refund: refund.value } }) }, 'Save'),
            h('button.btn.primary', { type: 'button', onclick: () => save({ rental: { id: r.id, active: !r.active } }) }, r.active ? 'Stop counting' : 'Start counting')));
      })));
  }

  function notifyView(s, save) {
    const chosen = new Set(s.notify.map((n) => n.hive_user_id));
    const pick = h('select', h('option', { value: '' }, 'Add somebody from HIVE…'),
      s.hiveUsers.filter((u) => !chosen.has(u.id)).map((u) => h('option', { value: u.id }, `${u.name}${u.hasEmail ? '' : ' (no email in HIVE)'}`)));
    const flag = (n, key, field) => h('td.num', h('input', {
      type: 'checkbox', checked: Boolean(n[field]), 'aria-label': `${n.name} ${key}`,
      onchange: (e) => save({ notify: { hiveUserId: n.hive_user_id, name: n.name, [key]: e.target.checked } }),
    }));
    return h('div.card',
      h('div.sh-cardhead', h('h2', 'Who is told'), h('span.sh-sub', 'HIVE sends these, as a web push to their phone and an email, to the HIVE login chosen here.')),
      h('div.table-wrap', h('table',
        h('thead', h('tr', ['Who', 'Web push', 'Email', 'Amounts', 'Shift closed', 'Staff answered', 'Correction to approve', ''].map((t) => h('th', t)))),
        h('tbody', s.notify.length ? s.notify.map((n) => h('tr',
          h('td', h('strong', n.name)),
          flag(n, 'push', 'push'), flag(n, 'email', 'email'), flag(n, 'amounts', 'amounts'),
          flag(n, 'onClosed', 'on_closed'), flag(n, 'onAnswer', 'on_answer'), flag(n, 'onApproval', 'on_approval'),
          h('td', h('button.btn', { type: 'button', onclick: () => save({ notify: { hiveUserId: n.hive_user_id, remove: true } }) }, 'Remove'))))
          : h('tr', h('td', { colspan: 8 }, h('span.muted', 'Nobody yet. Add yourself and the supervisors.')))))),
      h('form.tl-inline', {
        onsubmit: (e) => {
          e.preventDefault();
          const id = Number(pick.value);
          const u = s.hiveUsers.find((x) => x.id === id);
          if (u) save({ notify: { hiveUserId: id, name: u.name, push: true, email: true, amounts: true, onClosed: true, onAnswer: true, onApproval: false } });
        },
      }, pick, h('button.btn.primary', { type: 'submit' }, 'Add')),
      h('p.tl-small', 'Untick Amounts for somebody who should hear that a shift closed but not what was in the drawer.'));
  }

  function peopleView(s, save) {
    return h('div.card',
      h('div.sh-cardhead', h('h2', 'Whose ASSD login is whose'), h('span.sh-sub', 'A closed shift belongs to whoever closed it in HIVE. This is only for a shift nobody closed: it goes on the list of the HIVE person named here.')),
      s.people.length ? h('div.tl-list', s.people.map((p) => h('div.tl-arow',
        h('strong', p.assdUser),
        h('select', { onchange: (e) => save({ person: { assdUser: p.assdUser, hiveUserId: e.target.value || null } }) },
          h('option', { value: '' }, 'Nobody'),
          s.hiveUsers.map((u) => h('option', { value: u.id, selected: Number(p.hiveUserId) === u.id }, u.name))))))
        : h('p.muted', 'No ASSD logins in the journal loaded so far.'));
  }

  function smallView(s, save) {
    const amount = h('input', { type: 'number', min: '0', step: '0.01', value: (s.threshold / 100).toFixed(2), style: 'width:8rem' });
    const checkout = h('input', { type: 'time', value: s.checkoutTime || '12:00', id: 'tl-checkout-time' });
    return h('div',
      h('div.card',
        h('div.sh-cardhead', h('h2', 'Small differences'), h('span.sh-sub', 'A difference this small or smaller is left off everybody’s list, and off Unpaid stays. Zero puts every pesewa on it.')),
        h('form.tl-inline', { onsubmit: (e) => { e.preventDefault(); save({ threshold: amount.value }); } },
          h('label', 'Ignore up to GH₵ ', amount), h('button.btn.primary', { type: 'submit' }, 'Save'))),
      h('div.card',
        h('div.sh-cardhead', h('h2', 'Check-out time'), h('span.sh-sub', 'When a guest leaves on their last day. Unpaid stays uses it to tell who leaves in the next 24 hours and who has gone.')),
        h('form.tl-inline', { onsubmit: (e) => { e.preventDefault(); save({ checkoutTime: checkout.value }); } },
          h('label', 'Check-out at ', checkout), h('button.btn.primary', { type: 'submit' }, 'Save'))));
  }

  return {
    closing, answers, settings,
    ...(admin ? { approvals } : {}),
  };
}
