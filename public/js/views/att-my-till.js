import { api } from '../api.js';
import { h, mount, toast } from '../util.js';
import { card, emptyState } from './components.js';
import { field, formDialog } from './att-shared.js';

/**
 * My till: closing a front-desk shift, and answering for the ones that did
 * not agree.
 *
 * This replaces the Google Form. It asks only what nobody else can say; ASSD's
 * figures, the card machine report and the laundry are read by Insight from
 * the files it already has. Works the same on the desk PC and on a phone:
 * one column of cards, wide enough to type in on either.
 *
 * Nothing is sent until "Sign and send", and the PIN is asked for there, the
 * way a letter is signed. Until then a half-finished report survives a reload
 * in this browser tab, so a phone that locked mid-count loses nothing.
 */

const SLOT = { morning: 'Morning', afternoon: 'Afternoon', night: 'Night' };
const cedis = (minor) => (minor == null ? '—' : `GH₵ ${(Math.abs(minor) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const signed = (minor) => (minor > 0 ? '+' : minor < 0 ? '−' : '') + cedis(minor);
const toMinor = (text) => {
  const n = Number(String(text ?? '').replace(/,/g, '').trim());
  return String(text ?? '').trim() === '' || !Number.isFinite(n) ? null : Math.round(n * 100);
};
const dayText = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const device = () => (window.matchMedia?.('(pointer: coarse)').matches ? 'phone' : 'pc');

const store = {
  get(key) { try { return JSON.parse(sessionStorage.getItem(`hive-till-${key}`) || 'null'); } catch { return null; } },
  set(key, value) { try { sessionStorage.setItem(`hive-till-${key}`, JSON.stringify(value)); } catch { /* private mode */ } },
  drop(key) { try { sessionStorage.removeItem(`hive-till-${key}`); } catch { /* private mode */ } },
};

/** Yes or No, as two buttons. */
function yesNo(value, onChange, { yes = 'Yes', no = 'No' } = {}) {
  const pick = (v) => h(`button.btn${value === v ? '.btn-primary' : ''}`, {
    type: 'button', 'aria-pressed': String(value === v), onclick: () => onChange(v),
  }, v ? yes : no);
  return h('div.till-yn', pick(true), pick(false));
}

// =================================================================== close --

export async function renderAttMyTill() {
  const host = h('div.till');
  const data = await api.myTill();

  const firstOpen = data.choices.find((c) => !c.done) || data.choices[0];
  let which = store.get('which') || { day: firstOpen.day, slot: firstOpen.slot };
  if (!data.choices.some((c) => c.day === which.day && c.slot === which.slot)) which = { day: firstOpen.day, slot: firstOpen.slot };

  const blank = () => ({
    floatOk: null, floatDiff: '', floatNote: '', cash: '',
    toSafe: null, envelopes: [{ no: '', amount: '' }],
    expenses: [{ po: '', look: null }],
    rentals: Object.fromEntries(data.setup.rentals.map((r) => [r.id, {
      start: data.handedOver?.rentals?.[r.id]?.end != null ? String(data.handedOver.rentals[r.id].end) : '', end: '',
    }])),
    checks: Object.fromEntries(data.setup.checks.map((c) => [c.id, { ok: null, guest: '', why: '' }])),
    note: '',
  });
  const draftKey = () => `draft-${which.day}-${which.slot}`;
  let f = store.get(draftKey()) || blank();
  const save = () => { store.set(draftKey(), f); store.set('which', which); };

  paint();
  return host;

  function paint() {
    const done = data.reports.find((r) => r.day === which.day && r.slot === which.slot);
    mount(host,
      h('div.page-head', h('div',
        h('h1', 'Close shift'),
        h('div.sub', 'Signed with your PIN. Insight checks it against ASSD, the card machine and the bank.'))),
      data.linked ? null : h('div.alert.warn', 'Insight cannot be reached just now, so PO numbers cannot be checked. You can still close the shift; '
        + 'any expense that could not be checked will be on your list under To sort out, to add again later.'),
      card('Which shift', {},
        h('select.till-shift', {
          'aria-label': 'Which shift',
          onchange: (e) => {
            const [day, slot] = e.target.value.split('|');
            save();
            which = { day, slot };
            f = store.get(draftKey()) || blank();
            store.set('which', which);
            paint();
          },
        }, data.choices.map((c) => h('option', { value: `${c.day}|${c.slot}`, selected: c.day === which.day && c.slot === which.slot },
          `${SLOT[c.slot]} · ${dayText(c.day)}${c.done ? ' · closed' : ''}`))),
        h('p.till-hint', 'Your name, the day and the shift go in for you from your sign-in.')),
      done ? closedCard(done) : form());
  }

  function closedCard(r) {
    const envelopes = r.toSafe ? r.envelopes.map((e) => `${e.no} (${cedis(e.amount)})`).join(', ') : 'nothing to the safe';
    return card('Closed', { note: `signed ${String(r.signedAt).slice(11, 16)}` },
      h('dl.till-dl',
        h('dt', 'Drawer'), h('dd', cedis(r.cash)),
        h('dt', 'Safe'), h('dd', envelopes),
        h('dt', 'Expenses'), h('dd', r.expenses.length ? r.expenses.map((e) => `${e.name || e.po || 'no PO'} ${cedis(e.paid)}${e.counted ? '' : ' (not counted)'}`).join(', ') : 'none'),
        h('dt', 'Opening float'), h('dd', r.floatOk ? 'Correct' : `Out by ${signed(r.floatDiff)}`)),
      h('p.till-hint', 'If something in it was wrong, ask a supervisor to reopen it. Anything that does not agree will appear under To sort out.'));
  }

  function form() {
    const missing = stillNeeded();
    const counted = f.expenses.filter((e) => e.look?.counted).reduce((t, e) => t + (e.look.total || 0), 0);
    const uncounted = f.expenses.filter((e) => e.look && !e.look.counted).reduce((t, e) => t + (e.look.total || 0), 0);
    const safeTotal = f.envelopes.reduce((t, e) => t + (toMinor(e.amount) || 0), 0);
    const set = (patch) => { Object.assign(f, patch); save(); paint(); };
    const input = (value, onInput, attrs = {}) => h('input', {
      value: value ?? '', ...attrs,
      oninput: (e) => { onInput(e.target.value); save(); refreshNeed(); },
    });

    return h('div.till-form',
      card('Opening float', {},
        h('p.till-q', 'Was your opening float correct?'),
        yesNo(f.floatOk, (v) => set({ floatOk: v })),
        f.floatOk === false ? h('div.till-more',
          field('How much was it out by? (GH₵, minus if short)', input(f.floatDiff, (v) => { f.floatDiff = v; }, { inputmode: 'decimal', placeholder: '-20.00', id: 'till-float-diff' })),
          field('Can you explain it?', h('textarea', { rows: 2, oninput: (e) => { f.floatNote = e.target.value; save(); } }, f.floatNote))) : null),

      card('Cash in the drawer now', {},
        field('One total for everything in the drawer, after any cash went to the safe (GH₵)',
          input(f.cash, (v) => { f.cash = v; }, { inputmode: 'decimal', placeholder: '0.00', class: 'till-big', id: 'till-cash' }))),

      card('The safe', {},
        h('p.till-q', 'Did you move cash to the safe on this shift?'),
        yesNo(f.toSafe, (v) => set({ toSafe: v })),
        f.toSafe ? h('div.till-more',
          f.envelopes.map((e, i) => h('div.till-row',
            field('Envelope number', input(e.no, (v) => { e.no = v.replace(/\D/g, ''); }, { inputmode: 'numeric', placeholder: '417', id: `till-env-${i}` })),
            field('Amount in it (GH₵)', input(e.amount, (v) => { e.amount = v; }, { inputmode: 'decimal', placeholder: '0.00', id: `till-env-amt-${i}` })),
            f.envelopes.length > 1 ? h('button.btn-sm.till-x', { type: 'button', 'aria-label': 'Remove envelope', onclick: () => { f.envelopes.splice(i, 1); set({}); } }, '✕') : null)),
          h('button.btn-sm', { type: 'button', onclick: () => { f.envelopes.push({ no: '', amount: '' }); set({}); } }, '+ Another envelope'),
          h('p.till-hint', `To the safe: ${cedis(safeTotal)}. Numbers only, as written on the envelope. Each one is checked against ASSD's cash movements.`)) : null),

      card('Expenses paid from the drawer', { note: 'each needs a PO' },
        h('p.till-hint', 'Type the PO number and tap Find in Odoo. An expense counts only when Odoo has a confirmed PO for it, and its amount is the PO’s total.'),
        severalAtOnce(),
        f.expenses.map((e, i) => expenseRow(e, i)),
        h('button.btn-sm', { type: 'button', onclick: () => { f.expenses.push({ po: '', look: null }); set({}); } }, '+ Another expense'),
        h('dl.till-dl',
          h('dt', 'Counted'), h('dd', cedis(counted)),
          h('dt', 'Not counted yet'), h('dd', { class: uncounted ? 'till-bad' : '' }, cedis(uncounted)))),

      data.setup.rentals.length ? card('Rentals', {},
        data.setup.rentals.map((r) => {
          const v = f.rentals[r.id] || (f.rentals[r.id] = { start: '', end: '' });
          const left = data.handedOver?.rentals?.[r.id]?.end;
          return h('div.till-rental',
            h('p.till-q', `${r.label} at the front desk`),
            h('div.till-row',
              field('At the start', input(v.start, (x) => { v.start = x; }, { inputmode: 'numeric', id: `till-${r.id}-start` })),
              field('At the end', input(v.end, (x) => { v.end = x; }, { inputmode: 'numeric', id: `till-${r.id}-end` }))),
            h('p.till-hint', left != null ? `${data.handedOver.name} left ${left}. ` : '',
              `Fewer at the end means one was rented: ASSD should show a ${r.unit} deposit. More means one came back: ASSD should show a refund.`));
        })) : null,

      data.setup.checks.length ? card('Front desk checks', { note: 'look before you answer' },
        data.setup.checks.map((c) => {
          const v = f.checks[c.id] || (f.checks[c.id] = { ok: null, guest: '', why: '' });
          return h('div.till-check',
            h('p.till-q', `Is the ${c.label.toLowerCase()} at the front desk now?`),
            yesNo(v.ok, (x) => { v.ok = x; set({}); }, { yes: 'Yes, I can see it', no: 'No' }),
            v.ok === false ? h('div.till-more',
              field('Which guest has it? (name or room)', input(v.guest, (x) => { v.guest = x; }, { id: `till-check-${c.id}-guest` })),
              h('p.till-or', 'or'),
              field('Explain where it is', h('textarea', { rows: 2, id: `till-check-${c.id}-why`, oninput: (e) => { v.why = e.target.value; save(); refreshNeed(); } }, v.why))) : null);
        })) : null,

      card('Anything else?', {},
        field('Anything the supervisor should know (optional)', h('textarea', { rows: 2, oninput: (e) => { f.note = e.target.value; save(); } }, f.note))),

      h('div.till-send',
        h('p.till-need', { hidden: !missing.length }, 'Still needed: ', h('strong', missing.join(', '))),
        h('button.btn.btn-primary.till-sign', { type: 'button', disabled: missing.length > 0, onclick: sign }, 'Sign and send')));
  }

  /** Several PO numbers typed or pasted at once: each gets a row and is looked up. */
  function severalAtOnce() {
    const box = h('input', {
      id: 'till-po-many', placeholder: 'e.g. P00412, P00415, 420', autocapitalize: 'characters',
      'aria-label': 'Several PO numbers at once',
    });
    const add = async (ev) => {
      const typed = [...new Set(box.value.split(/[\s,;]+/).map((p) => p.trim()).filter(Boolean))];
      if (!typed.length) { toast('Type the PO numbers first, separated by commas or spaces.', 'bad'); return; }
      const have = new Set(f.expenses.map((e) => String(e.po).trim().toUpperCase()).filter(Boolean));
      const fresh = typed.filter((p) => !have.has(p.toUpperCase()));
      if (!fresh.length) { toast('Those are already on the list.'); return; }
      ev.target.disabled = true;
      try {
        const { found } = await api.tillPo({ pos: fresh });
        // Fill the empty rows first, then add more.
        for (const one of found) {
          const empty = f.expenses.find((e) => !String(e.po).trim());
          const look = { ...one };
          delete look.po;
          if (empty) { empty.po = one.po; empty.look = look; } else f.expenses.push({ po: one.po, look });
        }
        box.value = '';
        toast(`${found.length} PO${found.length === 1 ? '' : 's'} added. ${found.filter((x) => x.counted).length} confirmed in Odoo.`);
      } catch (err) { toast(err.message, 'bad'); }
      ev.target.disabled = false;
      save();
      paint();
    };
    return h('div.till-many',
      field('Several POs at once', box),
      h('button.btn-sm', { type: 'button', onclick: add }, 'Add and find all'));
  }

  function expenseRow(e, i) {
    let result = null;
    const L = e.look;
    if (L) {
      if (L.counted) {
        result = h('div.till-po.ok', h('strong', `${L.name} · ${L.vendor || ''}`), ' · confirmed',
          h('div', `Counted: ${cedis(L.total)}`));
      } else if (L.state === 'claimed') {
        result = h('div.till-po.bad', h('strong', 'Already claimed'), ` on ${SLOT[L.claimed?.slot] || ''} ${L.claimed?.day ? dayText(L.claimed.day) : ''}${L.claimed?.by ? ` by ${L.claimed.by}` : ''}. A PO is paid from the drawer once. Not counted.`);
      } else if (L.state === 'missing') {
        result = h('div.till-po.bad', h('strong', e.po), ' is not in Odoo. Check the number. Not counted.');
      } else {
        result = h('div.till-po.warn', h('strong', `${L.name} · ${L.vendor || ''}`), ` is ${L.state} in Odoo, not confirmed. It counts once it is confirmed.`);
      }
    }
    return h('div.till-expense',
      h('div.till-row',
        field('PO number', h('input', {
          value: e.po, placeholder: 'P00412', id: `till-po-${i}`, autocapitalize: 'characters',
          oninput: (ev) => { e.po = ev.target.value; e.look = null; save(); refreshNeed(); },
        })),
        // The amount is the PO's, from Odoo, and cannot be typed over.
        field('Amount (from Odoo)', h('input', {
          value: L?.total != null ? (L.total / 100).toFixed(2) : '', placeholder: 'Find the PO first', id: `till-paid-${i}`,
          readonly: true, tabindex: -1, class: 'till-locked', 'aria-readonly': 'true',
        }))),
      h('div.till-actions',
        h('button.btn-sm', {
          type: 'button',
          onclick: async (ev) => {
            if (!e.po.trim()) { toast('Type the PO number first.', 'bad'); return; }
            ev.target.disabled = true;
            try {
              e.look = await api.tillPo({ po: e.po.trim() });
            } catch (err) { toast(err.message, 'bad'); }
            save();
            paint();
          },
        }, 'Find in Odoo'),
        f.expenses.length > 1 ? h('button.btn-sm', { type: 'button', onclick: () => { f.expenses.splice(i, 1); save(); paint(); } }, 'Remove') : null),
      result);
  }

  function stillNeeded() {
    const out = [];
    if (f.floatOk === null) out.push('the opening float');
    else if (f.floatOk === false && toMinor(f.floatDiff) == null) out.push('how much the float was out');
    if (toMinor(f.cash) == null) out.push('the cash in the drawer');
    if (f.toSafe === null) out.push('whether cash went to the safe');
    else if (f.toSafe && f.envelopes.some((e) => !/^\d+$/.test(e.no) || !(toMinor(e.amount) > 0))) out.push('each envelope number and amount');
    if (f.expenses.some((e) => String(e.po).trim() && !e.look)) out.push('"Find in Odoo" on each PO');
    for (const r of data.setup.rentals) {
      const v = f.rentals[r.id] || {};
      if (!/^\d+$/.test(String(v.start ?? '').trim()) || !/^\d+$/.test(String(v.end ?? '').trim())) out.push(`the ${r.label.toLowerCase()} count`);
    }
    for (const c of data.setup.checks) {
      const v = f.checks[c.id] || {};
      if (v.ok == null) out.push(`the ${c.label.toLowerCase()}`);
      else if (v.ok === false && !v.guest.trim() && !v.why.trim()) out.push(`who has the ${c.label.toLowerCase()}, or where it is`);
    }
    return out;
  }

  function refreshNeed() {
    const missing = stillNeeded();
    const need = host.querySelector('.till-need');
    const button = host.querySelector('.till-sign');
    if (need) {
      need.hidden = !missing.length;
      need.lastChild.textContent = missing.join(', ');
    }
    if (button) button.disabled = missing.length > 0;
  }

  async function sign() {
    const pin = h('input', { type: 'password', name: 'pin', inputmode: 'numeric', autocomplete: 'current-password', required: true, autofocus: true });
    const body = {
      day: which.day,
      slot: which.slot,
      floatOk: f.floatOk,
      floatDiff: f.floatOk ? null : f.floatDiff,
      floatNote: f.floatOk ? null : f.floatNote,
      cash: f.cash,
      toSafe: f.toSafe,
      envelopes: f.toSafe ? f.envelopes : [],
      expenses: f.expenses.filter((e) => String(e.po).trim()).map((e) => ({ po: e.po })),
      rentals: f.rentals,
      checks: data.setup.checks.map((c) => ({ id: c.id, ...f.checks[c.id] })),
      note: f.note,
      device: device(),
    };
    const sent = await formDialog({
      title: 'Sign your closing report',
      submitLabel: 'Sign and send',
      body: h('div',
        h('p', `${SLOT[which.slot]} · ${dayText(which.day)}. Once it is signed only a supervisor can reopen it.`),
        field('Your PIN', pin)),
      onSubmit: async (form) => api.closeTill({ ...body, pin: String(form.get('pin') || '') }),
    });
    if (!sent) return;
    store.drop(draftKey());
    toast('Signed and sent. Thank you.');
    data.reports.unshift({ ...sent.report, signedAt: new Date().toISOString().replace('T', ' '), floatDiff: sent.report.floatDiff });
    data.choices = data.choices.map((c) => (c.day === which.day && c.slot === which.slot ? { ...c, done: true } : c));
    paint();
  }
}

// ============================================================= to sort out --

export async function renderAttMyTillIssues() {
  const host = h('div.till');
  let data;
  try {
    data = await api.tillIssues();
  } catch (err) {
    mount(host,
      h('div.page-head', h('div', h('h1', 'To sort out'))),
      emptyState('Your list cannot be read just now', err.message));
    return host;
  }
  const open = new Map();
  paint();
  return host;

  function paint() {
    mount(host,
      h('div.page-head', h('div',
        h('h1', 'To sort out'),
        h('div.sub', data.issues.length
          ? `${data.issues.length} shift${data.issues.length === 1 ? '' : 's'} need${data.issues.length === 1 ? 's' : ''} you`
          : 'Nothing needs you'))),
      data.issues.length
        ? data.issues.map(issueCard)
        : emptyState('Nothing to sort out', 'Every one of your shifts agrees. A shift only shows here when it is short, over, missing a PO or missing a rental.'),
      h('p.till-hint.till-cleared', `${data.cleared} settled this month. Settled shifts leave this list.`));
  }

  function issueCard(issue) {
    const kind = issue.kind;
    const amount = kind === 'rental'
      ? `${Math.abs(issue.qty)} ${issue.rental}${Math.abs(issue.qty) === 1 ? '' : 's'} ${issue.qty < 0 ? 'missing' : 'extra'}`
      : (issue.amount ? signed(issue.amount) : '');
    const tone = issue.amount > 0 ? 'over' : kind === 'noreport' ? 'info' : 'short';
    const state = open.get(issue.key) || null;
    let action;
    if (issue.status === 'answered') {
      action = h('div.till-said', h('strong', 'You said: '), issue.answer?.text || '',
        h('div.till-hint', 'With the supervisor. It leaves this list once it is settled.'));
    } else if (state?.mode === 'po') {
      action = h('form.till-answer', {
        onsubmit: async (ev) => {
          ev.preventDefault();
          const po = ev.target.elements.po.value.trim();
          if (!po) return;
          try {
            await api.tillAnswer({ key: issue.key, how: 'po', po });
            toast('PO found. That is covered now.');
            data = await api.tillIssues();
            open.delete(issue.key);
            paint();
          } catch (err) { toast(err.message, 'bad'); }
        },
      },
      h('div.till-row', field('PO number', h('input', { name: 'po', placeholder: 'P00412', required: true }))),
      h('div.till-hint', 'The amount is taken from the PO in Odoo.'),
      h('div.till-actions', h('button.btn.btn-primary', { type: 'submit' }, 'Find in Odoo and add'),
        h('button.btn-sm', { type: 'button', onclick: () => { open.delete(issue.key); paint(); } }, 'Cancel')));
    } else if (state?.mode === 'explain') {
      const money = issue.amount < 0 && kind !== 'noreport';
      action = h('form.till-answer', {
        onsubmit: async (ev) => {
          ev.preventDefault();
          const text = ev.target.elements.text.value.trim();
          if (!text) { toast('Write a few words first.', 'bad'); return; }
          try {
            await api.tillAnswer({ key: issue.key, how: state.how || 'explain', text });
            toast('Sent to the supervisor.');
            data = await api.tillIssues();
            open.delete(issue.key);
            paint();
          } catch (err) { toast(err.message, 'bad'); }
        },
      },
      money ? h('div.till-yn',
        h(`button.btn${state.how !== 'repay' ? '.btn-primary' : ''}`, { type: 'button', onclick: () => { open.set(issue.key, { ...state, how: 'explain' }); paint(); } }, 'Explain'),
        h(`button.btn${state.how === 'repay' ? '.btn-primary' : ''}`, { type: 'button', onclick: () => { open.set(issue.key, { ...state, how: 'repay' }); paint(); } }, 'I’ll pay it back')) : null,
      h('textarea', { name: 'text', rows: 3, placeholder: state.how === 'repay' ? 'Cash to the supervisor, or from my pay' : 'What happened?' }),
      state.how === 'repay' ? h('p.till-hint', 'This is your agreement. If it is taken from your pay, it shows under My pay → My advance.') : null,
      h('div.till-actions', h('button.btn.btn-primary', { type: 'submit' }, 'Send'),
        h('button.btn-sm', { type: 'button', onclick: () => { open.delete(issue.key); paint(); } }, 'Cancel')));
    } else {
      action = h('div.till-actions',
        kind === 'unexplained' ? h('button.btn.btn-primary', { type: 'button', onclick: () => { open.set(issue.key, { mode: 'po' }); paint(); } }, 'Add the PO number') : null,
        h(`button.btn${kind === 'unexplained' ? '' : '.btn-primary'}`, { type: 'button', onclick: () => { open.set(issue.key, { mode: 'explain', how: 'explain' }); paint(); } },
          kind === 'unexplained' ? 'Explain instead' : issue.amount < 0 ? 'Explain or pay back' : 'Explain'));
    }
    return card(`${SLOT[issue.slot]} · ${dayText(issue.day)}`, {
      cls: `till-issue till-${tone}`,
      note: issue.status === 'answered' ? 'with the supervisor' : 'needs your answer',
    },
    h('div.till-amount', h('strong', amount), h('span.till-kind', issue.label)),
    issue.sentBack ? h('div.alert.warn', `Sent back${issue.sentBack.by ? ` by ${issue.sentBack.by}` : ''}: ${issue.sentBack.note || 'more is needed.'}`) : null,
    h('p', issue.text),
    action);
  }
}
