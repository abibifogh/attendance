import { h, mount, money } from '../util.js';
import { api } from '../api.js';
import { banner } from './components.js';

/**
 * The till, from this side: what staff wrote when they closed their shift in
 * HIVE, set beside ASSD; what they answered for the shifts that did not agree;
 * the corrections supervisors are waiting on; and the settings for all of it.
 *
 * Pieces of the Shifts screen: a shift's closing report in its detail, one
 * answer or correction at a time in the Inbox, each person's list on People,
 * and Settings. What a supervisor gets is what an admin chose under Settings →
 * Who sees what, and the server cuts the data to match before it is sent: a
 * hidden amount never reaches this page, it is not merely left undrawn.
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
  advances: ['Advances', 'In the Inbox: cash given out before a purchase, and POs whose final price differs. Act means give more time or close one with a reason.'],
  unpaid: ['Unpaid stays', 'Guests leaving in the next 24 hours who still owe, and guests who left owing. Act means answer them (an admin approves).'],
};
export const KIND_TONE = { drawer: 'bad', unexplained: 'bad', overclaimed: 'warn', rental: 'warn', noreport: 'info' };
export const OUTCOME = { accept: 'Accepted', recover: 'Recovered from pay', cash: 'Paid back in cash', writeoff: 'Written off', back: 'Sent back' };

const dayText = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const signed = (minor) => (minor == null ? '—' : minor === 0 ? money(0) : `${minor > 0 ? '+' : '−'}${money(Math.abs(minor))}`);
const pill = (tone, text) => h(`span.sh-chip.${tone}`, text);
const yes = (ok, good, bad) => (ok == null ? pill('none', '—') : ok ? pill('ok', `✓ ${good}`) : pill('short', `✗ ${bad}`));

/**
 * The till pieces for one period.
 *
 * `who` is `{ role, access }` from the sign-in; `period` the days on screen.
 */
export function tillViews({ who, period, onChange = () => {}, describeKey = (k) => k }) {
  const access = who?.access || {};
  const admin = who?.role === 'admin';
  let cache = null;

  // Kept for half a minute only: a report sent from HIVE while this screen is
  // open must show the next time it is opened, not after a reload.
  async function read(force = false) {
    const key = `${period().from}|${period().to}`;
    if (!force && cache?.key === key && Date.now() - cache.at < 30_000) return cache.value;
    const value = await api(`/till?from=${period().from}&to=${period().to}`);
    cache = { key, value, at: Date.now() };
    return value;
  }
  const forget = () => { cache = null; };

  const notLinked = (d) => (d.linked ? null : banner('warning',
    h('strong', 'HIVE and Insight are not linked yet. '),
    'Staff can close shifts in HIVE, but HIVE cannot check POs or show them their list until they are. '
    + 'In GitHub, run Actions → "Set Insight’s secrets" with Insight’s address in the box, then reload.'));

  // ---------------------------------------------- one shift's closing report --

  /** The closing report for one shift, HIVE beside ASSD, as a card for the shift's detail. */
  async function shiftReport(day, slot, after = () => {}) {
    if (!access.reports) return null;
    const d = await read();
    const r = (d.reports || []).find((x) => x.day === day && x.slot === slot);
    if (!r) return null;
    const rep = r.report;
    const c = r.compare || {};
    const money_ = access.money > 0;
    const amt = (x) => (money_ ? money(x) : '');
    const act = h('div.tl-act');
    const head = h('div.sh-cardhead',
      h('div', h('h2', 'Closing report'),
        h('p.sh-sub', rep ? `Signed in HIVE by ${rep.name} at ${String(rep.signedAt).slice(11, 16)}${rep.device ? ` from ${rep.device === 'pc' ? 'the desk computer' : 'a phone'}` : ''}.` : 'What staff signed in HIVE, beside what ASSD recorded.')));
    if (!rep) {
      return h('section.card', head,
        r.open ? pill('none', 'Still open') : pill('short', 'No closing report'),
        r.nearby ? h('p', `${r.nearby.name}’s report is filed under ${SLOT[r.nearby.slot]} · ${dayText(r.nearby.day)}. Wrong shift picked?`) : null,
        r.nearby && access.reopen > 1 ? h('div', act, h('button.btn', { type: 'button', onclick: (e) => move(e, r, after) }, 'Move it to this shift')) : null);
    }
    const env = rep.toSafe ? rep.envelopes.map((e) => `${e.no}${money_ ? ` · ${money(e.amount)}` : ''}`).join(', ') : 'Nothing';
    const sign = money_ ? Math.sign(c.unexplained ?? 0) : c.unexplainedSign;
    const rows = [
      ['Drawer at close', amt(rep.cash) || '✓ counted', r.inJournal ? (c.countAgrees == null ? pill('none', 'no ASSD count') : yes(c.countAgrees, 'agrees', `ASSD ${money_ ? money(c.assdClosing) : 'differs'}`)) : pill('none', 'not in the journal yet')],
      ['To the safe', env, r.inJournal ? (rep.toSafe ? yes(c.safeAgrees, 'agrees', `ASSD ${money_ ? money(c.safeLabelled) : 'differs'}`)
        : c.safeLabelled ? pill('short', `✗ ASSD moved ${money_ ? money(c.safeLabelled) : 'cash'}`) : pill('ok', '✓ none')) : ''],
      ['Out of the drawer', rep.expenses.length ? h('div', rep.expenses.map((e) => h('div',
        e.counted ? pill('ok', '✓ Counted') : pill('short', UNCOUNTED[e.state] || 'Not counted'), ' ', e.name || e.po || 'no PO',
        e.kind === 'topup' ? ' (deficit)' : e.kind === 'change' ? ' (refund)' : e.advance ? ' (advance)' : '',
        money_ && e.paid != null ? ` ${money(e.paid)}` : ''))) : 'No expenses',
      r.inJournal ? (sign == null ? '' : sign === 0 ? pill('ok', '✓ accounted for') : sign > 0 ? pill('short', `${money_ ? money(c.unexplained) : 'some'} not accounted for`)
        : pill('over', `${money_ ? money(-c.unexplained) : 'more'} claimed than moved`)) : ''],
      ...(c.rentals || []).filter((x) => x.start != null).map((x) => [x.label, `${x.start} → ${x.end}`,
        x.gap == null ? '' : x.gap === 0 ? pill('ok', '✓') : pill('short', `${x.gap > 0 ? '+' : ''}${x.gap}`)]),
      ['Opening float', rep.floatOk ? 'Correct' : `Out by ${money_ ? signed(rep.floatDiff) : ''}`, rep.floatOk ? pill('ok', '✓') : pill('over', 'look')],
      ...(rep.checks || []).map((k) => [k.label, k.ok ? 'At the desk' : (k.guest ? `With ${k.guest}` : k.why || 'Not at the desk'), k.ok ? pill('ok', '✓') : pill('short', '✗')]),
    ];
    return h('section.card', head,
      h('div.table-wrap', h('table.tl-vs',
        h('thead', h('tr', h('th', ''), h('th', 'HIVE report'), h('th', 'ASSD'))),
        h('tbody', rows.map(([label, hive, assd]) => h('tr', h('td', label), h('td', hive), h('td', assd)))))),
      rep.note ? h('p.tl-small', `“${rep.note}”`) : null,
      access.reopen > 1 ? h('div', act, h('button.btn', { type: 'button', onclick: (e) => reopen(e, rep, after) }, 'Reopen report')) : null);
  }

  async function move(event, r, after) {
    const cell = event.target.parentElement;
    const said = h('span.tl-small');
    event.target.disabled = true;
    said.textContent = 'Moving…';
    cell.append(said);
    try {
      await api('/till/move', { method: 'POST', body: { reportId: r.nearby.id, day: r.day, slot: r.slot } });
      forget();
      mount(cell, pill('ok', `Moved to ${SLOT[r.slot]} · ${dayText(r.day)}. ${r.nearby.name} has been told.`));
      onChange();
      after();
    } catch (err) { said.textContent = err.message; event.target.disabled = false; }
  }

  async function reopen(event, rep, after) {
    const cell = event.target.parentElement;
    const reason = h('input', { type: 'text', placeholder: 'Why it is being reopened', required: true });
    const said = h('span.tl-small');
    mount(cell, h('form.tl-inline', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('/till/reopen', { method: 'POST', body: { reportId: rep.id, reason: reason.value } });
          forget();
          mount(cell, pill('ok', `Reopened. ${rep.name} has been told.`));
          after();
        } catch (err) { said.textContent = err.message; }
      },
    }, reason, h('button.btn.primary', { type: 'submit' }, 'Reopen'), said));
    reason.focus();
  }

  // ----------------------------------------------------- staff answers --

  function issueCard(i, after) {
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
        await after();
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
      i.userId == null ? h('p.tl-small', 'Nobody to ask: map this ASSD login to a HIVE person under Settings → Front desk.') : null,
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


  // ------------------------------------------------------- approvals --

  /** A supervisor's answer or reconciliation, for an admin to approve. */
  function answerApprovalCard(a, after) {
    const go = (ok) => async (e) => {
      e.target.disabled = true;
      try { await api('/till/approve', { method: 'POST', body: { [a.type]: a.id, ok } }); onChange(); await after(); } catch (err) { alert(err.message); e.target.disabled = false; }
    };
    return h('div.tl-issue.warn',
      h('div.tl-issue-head', h('strong', a.by), h('span.tl-small', String(a.at).slice(0, 16))),
      h('p.tl-text', a.type === 'link' ? `Reconciled ${a.keys.length} exceptions together:` : `Answered “${a.answer}” for:`),
      h('ul.tl-keys', a.keys.map((k) => h('li', describeKey(k)))),
      a.note ? h('div.tl-said', h('b', 'Note'), a.note) : null,
      h('div.tl-actions',
        h('button.btn.primary', { type: 'button', onclick: go(true) }, 'Approve'),
        h('button.btn', { type: 'button', onclick: go(false) }, 'Reject')));
  }

  /** A supervisor's correction to a cash movement, for an admin to approve. */
  function correctionCard(a, after) {
    const what = ({
      expenses: 'was an expense', safe: 'went to the safe', split: `was split, ${money(a.expenses)} of it expenses`,
      duplicate: `is a duplicate of ASSD ${a.pair}`, reverses: `puts back ASSD ${a.pair}`,
    })[a.kind] || a.kind;
    const go = (ok) => async (e) => {
      e.target.disabled = true;
      try { await api('/till/approve', { method: 'POST', body: { seq: a.seq, ok } }); onChange(); await after(); } catch (err) { alert(err.message); e.target.disabled = false; }
    };
    return h('div.tl-issue.warn',
      h('div.tl-issue-head', h('strong', a.by), h('span.tl-amount', money(a.amount))),
      h('div.tl-small', `ASSD ${a.seq} · ${a.day ? dayText(a.day) : ''} · ${a.user || ''} · ${String(a.at).slice(0, 16)}`),
      h('p.tl-text', `Says this movement ${what}.`),
      a.note ? h('div.tl-said', h('b', 'Why'), a.note) : null,
      h('div.tl-actions',
        h('button.btn.primary', { type: 'button', onclick: go(true) }, 'Approve'),
        h('button.btn', { type: 'button', onclick: go(false) }, 'Reject')));
  }

  // ---------------------------------------------------------- people --

  /** Under People: what is still with staff, each person's month, and what was settled lately. */
  function peopleExtras(d) {
    const list = d.issues || [];
    const withStaff = list.filter((i) => i.status === 'open');
    const settled = list.filter((i) => i.status === 'settled').slice(-20).reverse();
    return [
      withStaff.length ? h('div.card',
        h('div.sh-cardhead', h('h2', `Still with staff (${withStaff.length})`), h('span.sh-sub', 'On their list in HIVE under To sort out, not answered yet.')),
        h('div.table-wrap', h('table',
          h('thead', h('tr', ['Shift', 'Who', 'What', ''].map((t) => h('th', t)))),
          h('tbody', withStaff.map((i) => h('tr',
            h('td', `${SLOT[i.slot]} · ${dayText(i.day)}`), h('td', i.name || '—'), h('td', d.kinds?.[i.kind] || i.kind),
            h('td.num', access.money && i.amount ? signed(i.amount) : '')))))))
        : null,
      d.net ? netCard(d.net) : null,
      settled.length ? h('div.card',
        h('div.sh-cardhead', h('h2', 'Settled lately')),
        h('div.table-wrap', h('table',
          h('thead', h('tr', ['Shift', 'Who', 'What', 'Decision', 'By'].map((t) => h('th', t)))),
          h('tbody', settled.map((i) => h('tr',
            h('td', `${SLOT[i.slot]} · ${dayText(i.day)}`), h('td', i.name || '—'), h('td', d.kinds?.[i.kind] || i.kind),
            h('td', OUTCOME[i.decision?.outcome] || '—', i.decision?.amount && access.money ? ` ${money(i.decision.amount)}` : ''),
            h('td', i.decision?.by || '—'))))))) : null,
    ];
  }

  function netCard(net) {
    return h('div.card',
      h('div.sh-cardhead', h('h2', 'This month, per person'), h('span.sh-sub', 'Every difference put on their list, settled or not.')),
      h('div.table-wrap', h('table',
        h('thead', h('tr', ['Who', 'Short', 'Over', 'Net', 'Times'].map((t) => h('th', t)))),
        h('tbody', net.map((p) => h('tr', h('td', p.name || `HIVE ${p.userId}`), h('td.num', money(p.short)), h('td.num', money(p.over)),
          h('td.num', signed(p.net)), h('td.num', String(p.count))))))));
  }


  // ------------------------------------------------------------ settings --

  let settingsTab = 'who';
  let customFor = null;

  /** Settings, in four parts: who sees what, who is told, the front desk, and the limits. */
  async function settings(v) {
    mount(v, h('p.muted', 'Reading the settings…'));
    const d = await read(true);
    const s = d.settings;
    const tabs = [['who', 'Who sees what'], ['told', 'Who is told'], ['desk', 'Front desk'], ['limits', 'Limits']];
    const save = async (body) => {
      try {
        await api('/till/settings', { method: 'POST', body });
        forget();
        await settings(v);
      } catch (err) { alert(err.message); }
    };
    const body = settingsTab === 'who' ? whoView(s, save)
      : settingsTab === 'told' ? notifyView(s, save)
        : settingsTab === 'desk' ? h('div.tl-stack', checksView(s, save), rentalsView(s, save), loginsView(s, save))
          : await limitsView(s, save, v);
    mount(v,
      notLinked(d),
      h('div.tl-subtabs', tabs.map(([k, l]) => h('button', { type: 'button', 'aria-selected': String(settingsTab === k), onclick: () => { settingsTab = k; settings(v); } }, l))),
      body);
  }

  /** Each supervisor: one preset, or Custom to set each part by hand. */
  function whoView(s, save) {
    const levelsFor = (id) => {
      const own = s.access.filter((r) => Number(r.account_id) === Number(id));
      const use = id && own.length ? own : s.access.filter((r) => Number(r.account_id) === 0);
      return Object.fromEntries(s.areas.map((a) => [a.key, Number(use.find((r) => r.area === a.key)?.level ?? 0)]));
    };
    const presetOf = (levels) => (s.presets || []).find((p) => s.areas.every((a) => (levels[a.key] || 0) === Math.min(a.max, p.levels[a.key] || 0)))?.key || 'custom';
    const people = [{ id: 0, name: 'New supervisors start as' }, ...s.supervisors];
    const pick = (p) => {
      const levels = levelsFor(p.id);
      const now = presetOf(levels);
      return h('select', {
        'aria-label': `What ${p.name} sees`,
        onchange: (e) => {
          if (e.target.value === 'custom') { customFor = p.id; settings(document.querySelector('.sh-view')); return; }
          customFor = null;
          save({ access: { accountId: p.id, preset: e.target.value } });
        },
      }, (s.presets || []).map((x) => h('option', { value: x.key, selected: now === x.key }, x.label)),
      h('option', { value: 'custom', selected: now === 'custom' }, 'Custom'));
    };
    const grid = (p) => {
      const levels = levelsFor(p.id);
      return h('div.tl-access', s.areas.map((a) => h('div.tl-arow',
        h('div', h('strong', AREA_TEXT[a.key]?.[0] || a.key), h('div.tl-small', AREA_TEXT[a.key]?.[1] || '')),
        h('div.tl-tri', LEVELS.filter(([n]) => n <= a.max).map(([n, label]) => h('button', {
          type: 'button', 'aria-pressed': String(levels[a.key] === n), onclick: () => { customFor = p.id; save({ access: { accountId: p.id, area: a.key, level: n } }); },
        }, label))))));
    };
    return h('div.card',
      h('div.sh-cardhead', h('h2', 'Who sees what'), h('span.sh-sub', 'A supervisor is an account given Insight with the Supervisor role under Accounts. Pick what each one gets; Custom sets each part by hand.')),
      s.supervisors.length ? null : banner('info', 'Nobody is a supervisor yet. Under Accounts, set somebody’s Insight access to Supervisor.'),
      h('div.tl-people', people.map((p) => {
        const custom = customFor === p.id || presetOf(levelsFor(p.id)) === 'custom';
        return h('div.tl-person',
          h('div.tl-personrow', h('strong', p.name), pick(p)),
          custom && customFor === p.id ? grid(p) : custom ? h('button.sh-link', { type: 'button', onclick: () => { customFor = p.id; settings(document.querySelector('.sh-view')); } }, 'Show what is set') : null);
      })),
      h('div.tl-presets', (s.presets || []).map((x) => h('div', h('strong', x.label), h('p.tl-small', x.text)))));
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
      h('div.sh-cardhead', h('h2', 'Who is told'), h('span.sh-sub', 'HIVE sends these, as a web push to their phone and an email, to the HIVE login chosen here. Things that need a decision come straight away; the rest is in the daily summary.')),
      h('div.table-wrap', h('table',
        h('thead', h('tr', ['Who', 'Web push', 'Email', 'Amounts', 'Daily summary', 'Staff answered', 'Correction to approve', ''].map((t) => h('th', t)))),
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
      h('p.tl-small', 'Daily summary: one message each morning with yesterday’s shifts and what waits for an admin. Untick Amounts for somebody who should see how the drawers came out, not by how much.'));
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

  function loginsView(s, save) {
    return h('div.card',
      h('div.sh-cardhead', h('h2', 'Whose ASSD login is whose'), h('span.sh-sub', 'A closed shift belongs to whoever closed it in HIVE. This is only for a shift nobody closed: it goes on the list of the HIVE person named here.')),
      s.people.length ? h('div.tl-list', s.people.map((p) => h('div.tl-arow',
        h('strong', p.assdUser),
        h('select', { onchange: (e) => save({ person: { assdUser: p.assdUser, hiveUserId: e.target.value || null } }) },
          h('option', { value: '' }, 'Nobody'),
          s.hiveUsers.map((u) => h('option', { value: u.id, selected: Number(p.hiveUserId) === u.id }, u.name))))))
        : h('p.muted', 'No ASSD logins in the journal loaded so far.'));
  }


  /** The numbers that decide what is raised and how far back things are read. */
  async function limitsView(s, save, v) {
    let t = null;
    try { t = await api('/todo'); } catch { t = null; }
    const amount = h('input', { type: 'number', min: '0', step: '0.01', value: (s.threshold / 100).toFixed(2), style: 'width:7rem', id: 'tl-small' });
    const checkout = h('input', { type: 'time', value: s.checkoutTime || '12:00', id: 'tl-checkout-time' });
    const days = t ? h('input', { type: 'number', min: '0', max: '90', value: String(t.unbilledDays), style: 'width:5rem', id: 'tl-unbilled' }) : null;
    const back = t ? h('input', { type: 'number', min: '7', max: '730', value: String(t.lookbackDays ?? 90), style: 'width:5rem', id: 'tl-lookback' }) : null;
    const laundry = t ? h('input', { type: 'number', min: '1', max: '60', value: String(t.laundryDays ?? 3), style: 'width:5rem', id: 'tl-laundry' }) : null;
    const said = h('span.small');
    const row = (label, help, input, unit = '') => h('div.tl-limit', h('div', h('strong', label), h('div.tl-small', help)), h('label', input, unit));
    return h('div.card',
      h('div.sh-cardhead', h('h2', 'Limits'), h('span.sh-sub', 'What is small enough to leave alone, and how far back Insight looks.')),
      h('form.tl-limits', {
        onsubmit: async (e) => {
          e.preventDefault();
          said.textContent = 'Saving…'; said.className = 'small';
          try {
            await api('/till/settings', { method: 'POST', body: { threshold: amount.value, checkoutTime: checkout.value } });
            let note = 'Saved.';
            if (t) {
              const out = await api('/todo/settings', { method: 'POST', body: { unbilledDays: days.value, lookbackDays: back.value, laundryDays: laundry.value } });
              if (out.checked) note = out.checked.ok ? 'Saved, and Odoo asked again for the new look-back.' : `Saved. Odoo could not be asked: ${out.checked.error}`;
            }
            forget();
            await settings(v);
            v.prepend(banner('good', note));
          } catch (err) { said.textContent = err.message; said.className = 'small form-error'; }
        },
      },
      row('Small differences', 'A difference this small or smaller is left off everybody’s list and off Unpaid stays, and a supervisor’s correction this small counts without waiting for an admin.', amount, ' GH₵'),
      days ? row('PO without a posted bill', 'Raise it on the Inbox after this many days, from the day the cash left or the day it was ordered.', days, ' days') : null,
      back ? row('Look for POs over the last', 'How far back the Inbox looks for cash POs and bills.', back, ' days') : null,
      laundry ? row('Refresh reads the laundry for the last', 'Refresh now reads the laundry system this far back, up to today.', laundry, ' days') : null,
      row('Guests leave by', 'Check-out time on their last day. Unpaid stays uses it to tell who leaves in the next 24 hours.', checkout),
      h('div.tl-actions', h('button.btn.primary', { type: 'submit' }, 'Save'), said)));
  }

  return {
    read, forget, notLinked, shiftReport, issueCard, peopleExtras, settings,
    ...(admin ? { answerApprovalCard, correctionCard } : {}),
  };
}

/** What a line on a closing report that did not count says. */
const UNCOUNTED = { claimed: 'Already claimed', missing: 'Not in Odoo', 'no-po': 'No PO', unchecked: 'Not checked', report: 'Report on form', cancel: 'Cancelled' };
