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
/** An advance from an earlier shift, not settled yet: what it is waiting for. */
const ADV_CHIP = { approve: 'Approve in Odoo', report: 'Report on form', cancel: 'Cancelled' };
const ADV_TEXT = {
  approve: 'Waiting for approval in Odoo. Once approved, it has to be reported on the expense form.',
  report: 'Approved in Odoo. Now it has to be reported on the expense form.',
  cancel: 'Cancelled in Odoo. Ask an admin to close it.',
};
/** An amount that can go below nothing: change coming back is − GH₵ 20.00. */
const signedCedis = (minor) => (minor != null && minor < 0 ? `− ${cedis(minor)}` : cedis(minor));
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

const STEPS = ['Shift and float', 'Cash in the drawer', 'The safe', 'Expenses', 'Checks, then sign'];

export async function renderAttMyTill() {
  const host = h('div.till');
  const data = await api.myTill();

  // A report still owed from an earlier shift comes first: the screen opens
  // on it, and nothing after it can be closed until it is in.
  const owedFirst = () => (data.owed ?? [])[0] ?? null;
  const usable = (c) => c && !c.blocked;
  const firstOpen = owedFirst() ?? data.choices.find((c) => !c.done && !c.blocked) ?? data.choices[0];
  let which = store.get('which') || { day: firstOpen.day, slot: firstOpen.slot };
  // Which of the five steps is on screen, kept with the draft so a phone that
  // locks halfway through comes back to the same step.
  let step = Number(store.get('step')) || 0;
  if (!usable(data.choices.find((c) => c.day === which.day && c.slot === which.slot))) {
    which = { day: firstOpen.day, slot: firstOpen.slot };
    step = 0;
  }

  const blank = () => ({
    floatOk: null, floatDiff: '', floatNote: '', cash: '',
    toSafe: null, envelopes: [{ no: '', amount: '' }],
    expenses: [],
    rentals: Object.fromEntries(data.setup.rentals.map((r) => [r.id, {
      start: data.handedOver?.rentals?.[r.id]?.end != null ? String(data.handedOver.rentals[r.id].end) : '', end: '',
    }])),
    checks: Object.fromEntries(data.setup.checks.map((c) => [c.id, { ok: null, guest: '', why: '' }])),
    note: '',
  });
  const draftKey = () => `draft-${which.day}-${which.slot}`;
  let f = store.get(draftKey()) || blank();
  // Drafts from before the one-list form kept an empty row to type in.
  f.expenses = (f.expenses || []).filter((e) => String(e.po ?? '').trim());
  const save = () => { store.set(draftKey(), f); store.set('which', which); };

  // What earlier shifts left for this one: advances not settled yet, and
  // refunds or deficits on POs whose final price differs from what was paid.
  // Asked afresh when the form opens and when the shift changes, never from
  // HIVE's ten-minute memory of Odoo: an admin's "more time" or "close" in
  // Insight, or a PO just approved or reported, has to show at once, or the
  // Sign button stays locked on an answer that is no longer true.
  let earlier = { advances: [], changes: [] };
  let earlierFor = null;
  let earlierAt = 0;
  function loadEarlier(fresh = false) {
    const key = `${which.day}|${which.slot}`;
    earlierFor = key;
    earlierAt = Date.now();
    return api.tillPoChanges({ day: which.day, slot: which.slot, fresh }).then((d) => {
      if (earlierFor !== key) return;
      const next = { advances: d.advances || [], changes: d.changes || [] };
      // Painted again only when something changed, so nobody loses what they are typing.
      if (JSON.stringify(next) === JSON.stringify(earlier)) return;
      earlier = next;
      paint();
    }).catch(() => {});
  }
  loadEarlier(true);

  // Kept up to date while the screen stays open: an advance given to somebody
  // else, more time, or a PO approved or reported meanwhile shows without
  // "check again". Asked again every two minutes, and on coming back to the
  // screen, at most every half minute; stopped once the screen is left.
  const EARLIER_EVERY = 120_000;
  let onScreen = false;
  const keepEarlier = () => {
    if (!host.isConnected) { if (onScreen) stopEarlier(); return; }
    onScreen = true;
    if (document.visibilityState !== 'visible' || Date.now() - earlierAt < 30_000) return;
    loadEarlier(true);
  };
  const earlierTimer = setInterval(keepEarlier, EARLIER_EVERY);
  document.addEventListener('visibilitychange', keepEarlier);
  window.addEventListener('focus', keepEarlier);
  function stopEarlier() {
    clearInterval(earlierTimer);
    document.removeEventListener('visibilitychange', keepEarlier);
    window.removeEventListener('focus', keepEarlier);
  }

  paint();
  return host;

  function paint() {
    const done = data.reports.find((r) => r.day === which.day && r.slot === which.slot);
    mount(host,
      h('div.page-head', h('div',
        h('h1', 'Close your till'),
        h('div.sub', 'Five short steps, signed with your PIN at the end.'))),
      data.linked ? null : h('div.alert.warn', 'Insight cannot be reached just now, so PO numbers cannot be checked. You can still close the shift; '
        + 'any expense that could not be checked will be on your list under To sort out, to add again later.'),
      owedFirst() ? h('div.alert.warn.till-owed', h('span',
        h('strong', `Your closing report for the ${SLOT[owedFirst().slot].toLowerCase()} shift on ${dayText(owedFirst().day)} is still not in.`),
        ' ', (data.owed.length > 1 ? `${data.owed.length} reports are missing. ` : ''),
        'Submit it first: closing reports go in order, and later shifts open once it is in.')) : null,
      done || step === 0 ? card('Which shift', {},
        h('select.till-shift', {
          'aria-label': 'Which shift',
          onchange: (e) => {
            const [day, slot] = e.target.value.split('|');
            save();
            which = { day, slot };
            step = 0;
            f = store.get(draftKey()) || blank();
            store.set('which', which);
            earlier = { advances: [], changes: [] };
            loadEarlier(true);
            paint();
          },
        }, data.choices.map((c) => h('option', {
          value: `${c.day}|${c.slot}`,
          selected: c.day === which.day && c.slot === which.slot,
          disabled: Boolean(c.blocked),
        }, `${SLOT[c.slot]} · ${dayText(c.day)}${c.done ? ' · closed' : c.blocked ? ' · after the one still owed' : ''}`))),
        h('p.till-hint', 'Your name, the day and the shift go in for you from your sign-in.')) : null,
      done ? closedCard(done) : form());
  }

  function closedCard(r) {
    const envelopes = r.toSafe ? r.envelopes.map((e) => `${e.no} (${cedis(e.amount)})`).join(', ') : 'nothing to the safe';
    return card('Closed', { note: `signed ${String(r.signedAt).slice(11, 16)}` },
      h('dl.till-dl',
        h('dt', 'Drawer'), h('dd', cedis(r.cash)),
        h('dt', 'Safe'), h('dd', envelopes),
        h('dt', 'Expenses'), h('dd', r.expenses.length ? r.expenses.map((e) => `${e.name || e.po || 'no PO'}${e.kind === 'topup' ? ' deficit' : e.kind === 'change' ? ' refund' : e.advance ? ' advance' : ''} ${signedCedis(e.paid)}${e.counted ? '' : ' (not counted)'}`).join(', ') : 'none'),
        h('dt', 'Opening float'), h('dd', r.floatOk ? 'Correct' : `Out by ${signed(r.floatDiff)}`)),
      h('p.till-hint', 'If something in it was wrong, ask a supervisor to reopen it. Anything that does not agree will appear under To sort out.'));
  }

  function form() {
    const missing = stillNeeded();
    const amount = (L) => (L.amount != null ? L.amount : L.total || 0);
    const counted = f.expenses.filter((e) => e.look?.counted).reduce((t, e) => t + amount(e.look), 0);
    const uncounted = f.expenses.filter((e) => e.look && !e.look.counted).reduce((t, e) => t + amount(e.look), 0);
    const safeTotal = f.envelopes.reduce((t, e) => t + (toMinor(e.amount) || 0), 0);
    const set = (patch) => { Object.assign(f, patch); save(); paint(); };
    const input = (value, onInput, attrs = {}) => h('input', {
      value: value ?? '', ...attrs,
      oninput: (e) => { onInput(e.target.value); save(); refreshNeed(); },
    });

    const cards = [];
    cards.push([0, card('Opening float', {},
        h('p.till-q', 'Was your opening float correct?'),
        yesNo(f.floatOk, (v) => set({ floatOk: v })),
        f.floatOk === false ? h('div.till-more',
          field('How much was it out by? (GH₵, minus if short)', input(f.floatDiff, (v) => { f.floatDiff = v; }, { inputmode: 'decimal', placeholder: '-20.00', id: 'till-float-diff' })),
          field('Can you explain it?', h('textarea', { rows: 2, oninput: (e) => { f.floatNote = e.target.value; save(); } }, f.floatNote))) : null)]);

    cards.push([1, card('Cash in the drawer now', {},
        field('One total for everything in the drawer, after any cash went to the safe (GH₵)',
          input(f.cash, (v) => { f.cash = v; }, { inputmode: 'decimal', placeholder: '0.00', class: 'till-big', id: 'till-cash' })))]);

    cards.push([2, card('The safe', {},
        h('p.till-q', 'Did you move cash to the safe on this shift?'),
        yesNo(f.toSafe, (v) => set({ toSafe: v })),
        f.toSafe ? h('div.till-more',
          f.envelopes.map((e, i) => h('div.till-row',
            field('Envelope number', input(e.no, (v) => { e.no = v.replace(/\D/g, ''); }, { inputmode: 'numeric', placeholder: '417', id: `till-env-${i}` })),
            field('Amount in it (GH₵)', input(e.amount, (v) => { e.amount = v; }, { inputmode: 'decimal', placeholder: '0.00', id: `till-env-amt-${i}` })),
            f.envelopes.length > 1 ? h('button.btn-sm.till-x', { type: 'button', 'aria-label': 'Remove envelope', onclick: () => { f.envelopes.splice(i, 1); set({}); } }, '✕') : null)),
          h('button.btn-sm', { type: 'button', onclick: () => { f.envelopes.push({ no: '', amount: '' }); set({}); } }, '+ Another envelope'),
          h('p.till-hint', `To the safe: ${cedis(safeTotal)}. Numbers only, as written on the envelope. Each one is checked against ASSD's cash movements.`)) : null)]);

    cards.push([3, card('Expenses paid from the drawer', { note: 'each needs a PO' },
        fromLastShift(),
        h('h4.till-group', 'This shift'),
        h('p.till-hint', 'Type one PO number or several, then Add. Each is checked in Odoo straight away; its amount is the PO’s total. '
          + 'A PO still waiting for approval goes in as an advance.'),
        addPos(),
        f.expenses.length ? h('div.till-polist', f.expenses.map((e, i) => expenseRow(e, i))) : null,
        f.expenses.length ? h('div.till-pototals',
          h('span', 'Counted ', h('b', signedCedis(counted))),
          h('span', 'Not counted ', h('b', { class: uncounted ? 'till-bad' : '' }, cedis(uncounted)))) : null)]);

    cards.push([3, data.setup.rentals.length ? card('Rentals', {},
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
        })) : null]);

    cards.push([4, data.setup.checks.length ? card('Front desk checks', { note: 'look before you answer' },
        data.setup.checks.map((c) => {
          const v = f.checks[c.id] || (f.checks[c.id] = { ok: null, guest: '', why: '' });
          return h('div.till-check',
            h('p.till-q', `Is the ${c.label.toLowerCase()} at the front desk now?`),
            yesNo(v.ok, (x) => { v.ok = x; set({}); }, { yes: 'Yes, I can see it', no: 'No' }),
            v.ok === false ? h('div.till-more',
              field('Which guest has it? (name or room)', input(v.guest, (x) => { v.guest = x; }, { id: `till-check-${c.id}-guest` })),
              h('p.till-or', 'or'),
              field('Explain where it is', h('textarea', { rows: 2, id: `till-check-${c.id}-why`, oninput: (e) => { v.why = e.target.value; save(); refreshNeed(); } }, v.why))) : null);
        })) : null]);

    cards.push([4, card('Anything else?', {},
      field('Anything the supervisor should know (optional)', h('textarea', { rows: 2, oninput: (e) => { f.note = e.target.value; save(); } }, f.note)))]);

    // One step at a time: five short pages rather than one long form, each
    // ticked off as it is finished, and the PIN at the end of the last.
    const open = new Set(needs().map((n) => n.step));
    const go = (i) => { step = Math.max(0, Math.min(STEPS.length - 1, i)); store.set('step', step); paint(); window.scrollTo(0, 0); };
    const last = step === STEPS.length - 1;

    return h('div.till-form',
      h('ol.till-steps', { 'aria-label': `Step ${step + 1} of ${STEPS.length}` },
        STEPS.map((label, i) => h('li', h('button.till-step', {
          type: 'button',
          class: i === step ? 'till-step now' : !open.has(i) ? 'till-step done' : 'till-step',
          'aria-current': i === step ? 'step' : null,
          onclick: () => go(i),
        }, h('i', i !== step && !open.has(i) ? '✓' : String(i + 1)), h('span', label))))),
      h('div.till-step-head',
        h('small', `Step ${step + 1} of ${STEPS.length}`),
        h('h2', STEPS[step])),
      cards.filter(([i, el]) => i === step && el).map(([, el]) => el),
      last
        ? h('div.till-send',
          h('p.till-need', { hidden: !missing.length }, 'To close: ', h('strong', missing.join(', '))),
          h('div.till-nav',
            h('button.btn', { type: 'button', onclick: () => go(step - 1) }, 'Back'),
            h('button.btn.btn-primary.till-sign', { type: 'button', disabled: missing.length > 0, onclick: sign }, 'Sign and send')))
        : h('div.till-nav',
          step > 0 ? h('button.btn', { type: 'button', onclick: () => go(step - 1) }, 'Back') : h('span'),
          h('button.btn.btn-primary', { type: 'button', onclick: () => go(step + 1) }, 'Next')));
  }

  /** Refunds and deficits not yet put on this shift, or put aside as not on it. */
  function openChanges() {
    const onList = new Set(f.expenses.filter((e) => e.look?.counted && ['topup', 'change'].includes(e.look.state)).map((e) => e.look.name));
    return earlier.changes.filter((c) => !onList.has(c.name) && !(c.amount > 0 && (f.notMine || []).includes(c.name)));
  }

  /** What earlier shifts left: each has to be sorted before this one is signed. */
  function fromLastShift() {
    const changes = openChanges();
    if (!earlier.advances.length && !changes.length) return null;
    const when = (x) => `${x.day ? dayText(x.day) : ''}${x.slot ? `, ${(SLOT[x.slot] || x.slot).toLowerCase()}` : ''}${x.by ? ` (${x.by})` : ''}`;
    const again = h('button.till-link', {
      type: 'button',
      onclick: async (ev) => { ev.target.disabled = true; ev.target.textContent = 'checking…'; await loadEarlier(true); },
    }, 'check again');
    const advanceRow = (a) => h('div.till-change', { dataset: { po: a.name } },
      h('div.till-change-text',
        h('div', h('b', a.name), ` ${a.vendor ? `${a.vendor} · ` : ''}advance of ${cedis(a.paid)}`),
        h('div.till-change-sub', `Given out on ${when(a.first)}. `, h('b', ADV_TEXT[a.status] || ''))),
      h('div.till-change-act', h(`span.till-chip.${a.status === 'report' ? 'warn' : 'bad'}`, ADV_CHIP[a.status] || 'Waiting')));
    // Given to this person to report: theirs alone, whatever shift they are on.
    const mine = earlier.advances.filter((a) => a.given);
    const rest = earlier.advances.filter((a) => !a.given);
    const givenBy = [...new Set(mine.map((a) => a.given.by).filter(Boolean))];
    const others = rest.length || changes.length;
    return h('div.till-changes',
      mine.length ? [
        h('h4', 'Given to you to report'),
        h('p', `${givenBy.length ? `${givenBy.join(' and ')} gave you ${mine.length === 1 ? 'this' : 'these'}. ` : ''}Your shift cannot be signed until ${mine.length === 1 ? 'it is' : 'they are'} on the expense form. `, others ? null : again),
        mine.map(advanceRow),
      ] : null,
      others ? [h('h4', 'From the last shift'), h('p', 'Each of these has to be sorted before this shift can be signed. ', again)] : null,
      rest.map(advanceRow),
      changes.map((c) => h('div.till-change', { dataset: { po: c.name } },
        h('div.till-change-text',
          h('div', h('b', c.name), ` ${c.vendor ? `${c.vendor} · ` : ''}bought for ${cedis(c.total)}, ${cedis(c.paidSoFar)} paid from the drawer`),
          h('div.till-change-sub', `${c.advance ? 'Advanced' : 'Paid'} on ${when(c.first)}. `,
            h('b', { class: c.amount > 0 ? 'till-up' : 'till-down' },
              c.amount < 0 ? `Put ${cedis(c.amount)} in the drawer.` : `${cedis(c.amount)} more paid from the drawer.`))),
        h('div.till-change-act',
          h(`span.till-chip.${c.amount < 0 ? 'ok' : 'warn'}`, c.amount < 0 ? 'Refund' : 'Deficit'),
          h('button.btn.btn-primary', {
            type: 'button',
            onclick: () => {
              f.expenses.push({ po: c.name, look: { name: c.name, vendor: c.vendor, total: c.total, state: c.state, counted: true, confirmed: true, amount: c.amount, paidSoFar: c.paidSoFar, claimed: c.first } });
              save(); paint();
            },
          }, 'Done'),
          c.amount > 0 ? h('button.btn', {
            type: 'button',
            onclick: () => { f.notMine = [...(f.notMine || []), c.name]; save(); paint(); },
          }, 'Not on my shift') : null))));
  }

  /** One box for one PO number or several: each is looked up and joins the list. */
  function addPos() {
    const box = h('input', {
      id: 'till-po-add', placeholder: 'P00412, 415, 420', autocapitalize: 'characters', enterkeyhint: 'done',
      'aria-label': 'PO numbers paid from the drawer',
      onkeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } },
    });
    const button = h('button.btn.btn-primary', { type: 'button', onclick: () => add() }, 'Add');
    async function add() {
      const typed = [...new Set(box.value.split(/[\s,;]+/).map((p) => p.trim()).filter(Boolean))];
      if (!typed.length) { toast('Type a PO number first. Several can go in at once, with commas or spaces.', 'bad'); box.focus(); return; }
      const have = new Set(f.expenses.map((e) => String(e.look?.name || e.po).trim().toUpperCase()));
      const fresh = typed.filter((p) => !have.has(p.toUpperCase()));
      if (!fresh.length) { toast(typed.length === 1 ? 'That PO is already on the list.' : 'Those are already on the list.'); return; }
      button.disabled = true; box.disabled = true;
      try {
        const { found } = await api.tillPo({ pos: fresh });
        for (const one of found) {
          const look = { ...one };
          delete look.po;
          // The same PO typed two ways ("412" and "P00412") is one line.
          if (look.name && f.expenses.some((e) => e.look?.name === look.name)) continue;
          f.expenses.push({ po: one.po, look });
        }
        box.value = '';
        const notYet = found.filter((x) => unapproved(x));
        if (notYet.length && notYet.every((x) => x.state === 'report')) toast(`${notYet.length === 1 ? 'It is' : 'They are'} approved in Odoo: report ${notYet.length === 1 ? 'it' : 'them'} on the expense form first.`, 'bad');
        else if (notYet.length) toast(`${notYet.length} cannot go on the report: see the list.`, 'bad');
      } catch (err) { toast(err.message, 'bad'); }
      save();
      paint();
      host.querySelector('#till-po-add')?.focus();
    }
    return h('div',
      h('div.till-poadd', box, button),
      h('p.till-hint', f.expenses.length ? 'Separate several with commas or spaces. Enter works too.' : 'No expenses on this shift? Leave it empty.'));
  }

  /** Why a PO found in Odoo stops the report being signed, or null when it does not. */
  function unapproved(L) {
    if (!L?.name || L.counted || ['claimed', 'missing', 'unchecked', 'confirmed'].includes(L.state)) return null;
    return ({ report: 'not on the expense form yet', cancel: 'cancelled in Odoo', held: 'made in Insight: an admin has to allow it on a shift first', refused: 'made in Insight: an admin said it is not paid from a drawer' })[L.state] || 'not approved in Odoo';
  }

  /** One PO on the list: what Odoo says about it, and whether it counts. */
  function expenseRow(e, i) {
    const L = e.look;
    const recheck = h('button.till-link', {
      type: 'button',
      onclick: async (ev) => {
        ev.target.disabled = true;
        try { e.look = await api.tillPo({ po: e.po.trim() }); } catch (err) { toast(err.message, 'bad'); }
        save();
        paint();
      },
    }, L ? 'check again' : 'check it now');
    let chip;
    let who = L?.vendor || '';
    let why = null;
    if (!L) {
      chip = h('span.till-chip.warn', 'Not checked');
      why = h('span.till-why.warn', 'Not checked in Odoo yet: ', recheck, '.');
    } else if (L.counted && (L.state === 'topup' || L.state === 'change')) {
      chip = h('span.till-chip.ok', '✓ Counted');
      who = L.state === 'topup' ? `Price went up from ${cedis(L.paidSoFar)} to ${cedis(L.total)}` : `Price went down from ${cedis(L.paidSoFar)} to ${cedis(L.total)}`;
    } else if (L.counted && L.state === 'advance') {
      chip = h('span.till-chip.warn', 'Advance');
      why = h('span.till-why.warn', 'Still waiting for approval in Odoo, so it goes in as an advance in your name. '
        + 'Once bought, get it approved and report it on the expense form: the next shift cannot close until then.');
    } else if (L.counted) {
      chip = h('span.till-chip.ok', '✓ Counted');
    } else if (L.state === 'claimed') {
      chip = h('span.till-chip.bad', L.claimed?.by === 'the safe' ? 'Paid from the safe' : 'Already claimed');
      why = h('span.till-why.bad', L.claimed?.by === 'the safe'
        ? `Paid from the safe on ${L.claimed.day ? dayText(L.claimed.day) : 'another day'}, not from the drawer. Not counted.`
        : `Claimed on the ${(SLOT[L.claimed?.slot] || '').toLowerCase()} shift of ${L.claimed?.day ? dayText(L.claimed.day) : ''}${L.claimed?.by ? ` by ${L.claimed.by}` : ''}. A PO is paid from the drawer once. Not counted.`);
    } else if (L.state === 'missing') {
      chip = h('span.till-chip.warn', 'Not found');
      who = 'Not in Odoo';
      why = h('span.till-why.warn', 'Check the number, or remove it.');
    } else if (L.state === 'report') {
      chip = h('span.till-chip.bad', 'Report on form');
      why = h('span.till-why.bad', 'Approved in Odoo. ', h('strong', 'Report it on the expense form first'), ', then ', recheck,
        '. You cannot close your shift with it until then.');
    } else if (L.state === 'held') {
      chip = h('span.till-chip.warn', 'Waiting for an admin');
      why = h('span.till-why.warn', `Made in Insight${L.madeInInsight?.by ? ` by ${L.madeInInsight.by}` : ''}. An admin has to allow it to be paid from a drawer: they have been asked. `, recheck,
        ' once they have. Until then, remove it to close your shift.');
    } else if (L.state === 'refused') {
      chip = h('span.till-chip.bad', 'Not from a drawer');
      why = h('span.till-why.bad', `Made in Insight. ${L.madeInInsight?.decidedBy || 'An admin'} said it is not paid from a drawer${L.madeInInsight?.note ? `: ${L.madeInInsight.note}` : ''}. Remove it from the report.`);
    } else if (unapproved(L)) {
      chip = h('span.till-chip.bad', L.state === 'cancel' ? 'Cancelled' : 'Not approved');
      why = h('span.till-why.bad', `${unapproved(L).replace(/^./, (c) => c.toUpperCase())}. Remove it from the report.`);
    } else if (L.state === 'unchecked') {
      chip = h('span.till-chip.warn', 'Not checked');
      why = h('span.till-why.warn', 'Odoo could not be reached: ', recheck, '.');
    } else {
      chip = h('span.till-chip.warn', 'Approve in Odoo');
      why = h('span.till-why.warn', `It is ${L.state} in Odoo. It counts once it is approved: `, recheck, '.');
    }
    return h('div.till-poline', { dataset: { po: L?.name || e.po } },
      h('b.till-poname', L?.name || e.po,
        L?.state === 'topup' ? h('span.till-potag', 'Deficit') : L?.state === 'change' ? h('span.till-potag', 'Refund') : null),
      h('span.till-povendor', who),
      h('b.till-poamt', L?.amount != null ? signedCedis(L.amount) : L?.total != null ? cedis(L.total) : '—'),
      h('span.till-postate', chip,
        h('button.till-x', { type: 'button', 'aria-label': `Remove ${L?.name || e.po}`, onclick: () => { f.expenses.splice(i, 1); save(); paint(); } }, '×')),
      why);
  }

  /** What is still missing, each against the step it belongs to. */
  function needs() {
    const out = [];
    const need = (step, text) => out.push({ step, text });
    if (f.floatOk === null) need(0, 'the opening float');
    else if (f.floatOk === false && toMinor(f.floatDiff) == null) need(0, 'how much the float was out');
    if (toMinor(f.cash) == null) need(1, 'the cash in the drawer');
    if (f.toSafe === null) need(2, 'whether cash went to the safe');
    else if (f.toSafe && f.envelopes.some((e) => !/^\d+$/.test(e.no) || !(toMinor(e.amount) > 0))) need(2, 'each envelope number and amount');
    if (f.expenses.some((e) => String(e.po).trim() && !e.look)) need(3, 'each PO checked in Odoo');
    for (const e of f.expenses.filter((x) => String(x.po).trim() && unapproved(x.look))) {
      need(3, e.look.state === 'report' ? `${e.look.name} reported on the expense form` : `${e.look.name} removed (${unapproved(e.look)})`);
    }
    for (const a of earlier.advances) need(3, `${a.name} ${a.status === 'approve' ? 'approved in Odoo' : a.status === 'report' ? 'reported on the expense form' : 'closed by an admin'}`);
    for (const c of openChanges()) need(3, c.amount < 0 ? `${c.name} refund in the drawer (Done)` : `${c.name} deficit: Done or Not on my shift`);
    for (const r of data.setup.rentals) {
      const v = f.rentals[r.id] || {};
      if (!/^\d+$/.test(String(v.start ?? '').trim()) || !/^\d+$/.test(String(v.end ?? '').trim())) need(3, `the ${r.label.toLowerCase()} count`);
    }
    for (const c of data.setup.checks) {
      const v = f.checks[c.id] || {};
      if (v.ok == null) need(4, `the ${c.label.toLowerCase()}`);
      else if (v.ok === false && !v.guest.trim() && !v.why.trim()) need(4, `who has the ${c.label.toLowerCase()}, or where it is`);
    }
    return out;
  }

  function stillNeeded() {
    return needs().map((n) => n.text);
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
    const open = new Set(needs().map((n) => n.step));
    host.querySelectorAll('.till-step').forEach((el, i) => {
      el.classList.toggle('done', !open.has(i) && i !== step);
      el.querySelector('i').textContent = !open.has(i) && i !== step ? '✓' : String(i + 1);
    });
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
      notMine: f.notMine || [],
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
    step = 0;
    store.set('step', 0);
    toast('Signed and sent. Thank you.');
    data.reports.unshift({ ...sent.report, signedAt: new Date().toISOString().replace('T', ' '), floatDiff: sent.report.floatDiff });
    data.choices = data.choices.map((c) => (c.day === which.day && c.slot === which.slot ? { ...c, done: true } : c));
    // One fewer owed: the next oldest is what everything after waits on now,
    // and the screen moves on to it.
    if (data.owed?.length) {
      data.owed = data.owed.filter((o) => !(o.day === which.day && o.slot === which.slot));
      const next = data.owed[0];
      const key = (c) => `${c.day}|${['morning', 'afternoon', 'night'].indexOf(c.slot)}`;
      data.choices = data.choices.map((c) => ({ ...c, blocked: Boolean(next) && key(c) > key(next) }));
      if (next) {
        which = { day: next.day, slot: next.slot };
        store.set('which', which);
        f = store.get(draftKey()) || blank();
      }
    }
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

  /** Proof an admin asked for: pictures (made smaller here) or a PDF, a note, Send; or why not. */
  function proofAsk(issue) {
    const p = issue.proof;
    const st = open.get(`proof:${issue.key}`) || { files: [], cannot: false };
    open.set(`proof:${issue.key}`, st);
    const pick = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, hidden: true });
    pick.addEventListener('change', async () => {
      try {
        for (const f of pick.files) st.files.push(await asProofFile(f)); // eslint-disable-line no-await-in-loop
      } catch (err) { toast(err.message, 'bad'); }
      pick.value = '';
      paint();
    });
    const note = h('textarea', { rows: 2, placeholder: st.cannot ? 'Why it cannot be had' : 'A note (optional)' });
    const send = async (ev) => {
      if (st.cannot ? !note.value.trim() : !st.files.length) { toast(st.cannot ? 'Say why first.' : 'Add a picture or a PDF first.', 'bad'); return; }
      ev.target.disabled = true;
      try {
        await api.tillProof({ id: p.id, note: note.value, ...(st.cannot ? { cannot: true } : { files: st.files }) });
        toast(st.cannot ? 'Sent.' : 'Proof sent to the supervisor.');
        open.delete(`proof:${issue.key}`);
        data = await api.tillIssues();
        paint();
      } catch (err) { toast(err.message, 'bad'); ev.target.disabled = false; }
    };
    return h('div.till-proof',
      h('strong', `${p.by} asks for proof`),
      h('div', `${p.kinds.join(', ')}${p.note ? `: “${p.note}”` : ''}`),
      st.cannot ? null : [
        h('button.till-proof-add', { type: 'button', onclick: () => pick.click() }, '📷 Take a picture, or choose pictures / a PDF'), pick,
        st.files.length ? h('div.till-proof-files', st.files.map((f, i) => h('div.till-proof-file',
          f.data.startsWith('data:image') ? h('img', { src: f.data, alt: f.name }) : h('span', '📄'),
          h('button.till-link', { type: 'button', onclick: () => { st.files.splice(i, 1); paint(); } }, 'Remove')))) : null],
      note,
      h('div.till-actions', h('button.btn.btn-primary', { type: 'button', onclick: send }, st.cannot ? 'Send why' : 'Send the proof'),
        h('button.till-link', { type: 'button', onclick: () => { st.cannot = !st.cannot; paint(); } }, st.cannot ? 'I can send it after all' : 'Can’t get it? Say why instead')));
  }

  function issueCard(issue) {
    const kind = issue.kind;
    const amount = kind === 'rental'
      ? `${Math.abs(issue.qty)} ${issue.rental}${Math.abs(issue.qty) === 1 ? '' : 's'} ${issue.qty < 0 ? 'missing' : 'extra'}`
      : (issue.amount ? signed(issue.amount) : '');
    const tone = issue.amount > 0 ? 'over' : kind === 'noreport' ? 'info' : 'short';
    const state = open.get(issue.key) || null;
    let action;
    if (issue.status === 'answered' && issue.proof) {
      action = [h('div.till-said', h('strong', 'You said: '), issue.answer?.text || ''), proofAsk(issue)];
    } else if (issue.status === 'answered') {
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
      state.how === 'repay' ? h('p.till-hint', 'This is your agreement. If it is taken from your pay, it shows under Pay → Advance.') : null,
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
    // Put on this person's account by an admin, from somebody's shift: why, and by whom.
    issue.moved ? h('div.till-moved', h('strong', 'Why: '), issue.moved.reason || '',
      h('div.till-hint', `Put on your account by ${issue.moved.by || 'an admin'}${issue.moved.from ? `, from ${issue.moved.from}’s shift` : ''}.`)) : null,
    issue.sentBack ? h('div.alert.warn', `Sent back${issue.sentBack.by ? ` by ${issue.sentBack.by}` : ''}: ${issue.sentBack.note || 'more is needed.'}`) : null,
    h('p', issue.text),
    action);
  }
}

/** A picture made at most 1600 pixels across, as a JPEG; a PDF as it is, up to 1.4 MB. */
async function asProofFile(file) {
  if (file.type === 'application/pdf') {
    if (file.size > 1_400_000) throw new Error(`${file.name} is over 1.4 MB: take a photo of it instead.`);
    return { name: file.name, data: await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(file); }) };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error(`${file.name} could not be opened.`)); i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return { name: file.name.replace(/\.\w+$/, '.jpg'), data: canvas.toDataURL('image/jpeg', 0.82) };
  } finally { URL.revokeObjectURL(url); }
}

// ============================================================== my reports --

const stampText = (at) => (at ? `${dayText(String(at).slice(0, 10))} ${String(at).slice(11, 16)}` : '');

/**
 * One shift's report and every version of it, oldest first.
 *
 * Read-only. Each version says when it was signed and what changed from the
 * one before; a version that was reopened says who opened it and why. Shared
 * with Till reports, so the receptionist and the manager read the same record.
 */
export function historyCard(shift, { actions = null, who = null } = {}) {
  const live = [...shift.versions].reverse().find((v) => !v.reopenedAt) ?? null;
  const pill = shift.state === 'in'
    ? h('span.pill.good', shift.versions.length > 1 ? `Submitted · ${shift.versions.length} versions` : 'Submitted')
    : h('span.pill.bad', 'Reopened · to submit again');
  return card(`${who ? `${who} · ` : ''}${SLOT[shift.slot]} · ${dayText(shift.day)}`, { note: pill, actions },
    live ? h('p.till-history-now', live.summary || `Drawer ${cedis(live.cash)}`) : h('p.muted', 'Opened again to be put right. It is under Close till until it is submitted again.'),
    h('ol.till-history', shift.versions.map((v) => h('li', { class: v.reopenedAt ? 'is-old' : '' },
      h('div.till-history-head',
        h('strong', `Version ${v.version}`),
        h('span.muted', ` · signed ${stampText(v.signedAt)}${v.device ? ` · ${v.device === 'phone' ? 'from a phone' : 'from the desk'}` : ''}`)),
      v.changes.length ? h('ul.till-history-changes', v.changes.map((c) => h('li', c))) : null,
      v.version > 1 && !v.changes.length ? h('small.muted', 'Submitted again with the same figures.') : null,
      v.version === 1 || v.reopenedAt ? h('small.till-history-sum', v.summary || '') : null,
      v.reopenedAt
        ? h('div.till-history-reopened',
          `Reopened ${stampText(v.reopenedAt)} by ${v.reopenedBy || 'a manager'}`,
          v.reopenReason ? h('q', v.reopenReason) : null)
        : null))));
}

export async function renderMyTillReports() {
  const host = h('div.till');
  let data;
  try {
    data = await api.myTillHistory();
  } catch (err) {
    mount(host, h('div.page-head', h('div', h('h1', 'My closing reports'))),
      emptyState('Your reports cannot be read just now', err.message));
    return host;
  }
  mount(host,
    h('div.page-head', h('div',
      h('h1', 'My closing reports'),
      h('div.sub', 'Every report you have submitted, read-only. If one needs correcting, ask a manager to open it again.'))),
    data.shifts.length
      ? h('div.till-history-list', data.shifts.map((s) => historyCard(s)))
      : emptyState('Nothing submitted yet', 'Your closing reports appear here once you have submitted one.'));
  return host;
}
