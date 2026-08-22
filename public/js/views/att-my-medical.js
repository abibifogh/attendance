import { api } from '../api.js';
import { confirmAction, fmtDay, h, money, mount, toast, todayISO } from '../util.js';
import { card, emptyState } from './components.js';
import { field, formDialog } from './att-shared.js';

/**
 * My medical claims.
 *
 * WHAT SOMEBODY IS HERE TO FIND OUT. How much of this year's allowance is
 * left, and what happened to the claim they sent in. Both above the fold, and
 * everything else is the working behind them.
 *
 * THE BILLS ARE THE CLAIM. Adding one is an amount, what it was for, and a
 * photograph — taken on the phone that is already in their hand, shrunk before
 * it is sent, because a claim that has to be emailed to somebody is a claim
 * that gets made three weeks late. Ten bills is the ceiling; the form says so
 * before somebody hits it rather than after.
 *
 * NOTHING HERE IS A DECISION. A claim is a request until somebody says
 * otherwise, and the screen never shows money as spent before it has been
 * agreed.
 */

const MAX = 10;

export async function renderAttMyMedical(params) {
  const host = h('div');
  const year = Number(params.year) || Number(todayISO().slice(0, 4));
  const data = await api.myMedical(year);
  const cash = (n) => money(n, data.currency);
  const reload = async (next = {}) => mount(host, await renderAttMyMedical({ ...params, year, ...next }));

  if (!data.linked) {
    mount(host,
      h('div.page-head', h('div', h('h1', 'My claims'))),
      emptyState('This login is not linked to your staff record',
        'Ask whoever set it up to point it at you under Users, and this will fill in.'));
    return host;
  }

  const s = data.standing;
  const waiting = data.claims.filter((c) => c.status === 'requested');

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'My claims'),
        h('div.sub', `Medical bills you have claimed for in ${year}`),
      ),
      s
        ? h('button.btn-sm.btn-primary', {
          onclick: () => makeClaim(data, reload, cash),
        }, 'Make a claim')
        : null,
    ),

    s
      ? card('This year', { note: String(year) },
        h('div.adv-mine',
          h('div.adv-mine-figure',
            h('div.adv-mine-label', 'Left to claim'),
            h('div.adv-mine-value', cash(s.left)),
            h('div.muted', `of ${cash(s.opening)}`)),
          h('div.adv-mine-bar',
            h('div.adv-mine-track',
              h('div.adv-mine-fill', {
                class: s.left <= 0 ? 'med-fill-out' : '',
                style: { width: `${s.opening > 0 ? Math.round((s.spent / s.opening) * 100) : 0}%` },
              })),
            h('div.adv-mine-ends',
              h('span', `${cash(s.spent)} claimed and approved`),
              s.waiting ? h('span', `${cash(s.waiting)} waiting`) : h('span', '')))),

        s.carriedIn
          ? h('p.muted', { style: { fontSize: '.85rem' } },
            `Your allowance for ${year} is ${cash(s.allowance)}, and you started the year with `
            + `${cash(s.opening)}. `
            + (s.carriedIn > 0
              ? `The extra ${cash(s.carriedIn)} was carried over from last year.`
              : `${cash(Math.abs(s.carriedIn))} of it had already been claimed before the app `
                + 'was keeping the record.'))
          : null,

        s.ifAllApproved < 0
          ? h('div.alert.warn',
            h('span.alert-icon', '⚠️'),
            h('div',
              h('div.alert-title', 'You have claimed more than is left'),
              h('div.alert-detail',
                `${cash(s.waiting)} is waiting on a decision and ${cash(s.left)} is left. `
                + 'Some of it may not be approved.')))
          : null)
      : emptyState('No medical allowance set for you this year',
        'If you think you should have one, ask whoever handles the wages.'),

    data.claims.length
      ? card(waiting.length ? `Your claims — ${waiting.length} waiting` : 'Your claims',
        { note: `${data.claims.length} in ${year}` },
        data.claims.map((claim) => claimBlock(claim, { cash, reload })))
      : null,
  );

  return host;
}

function claimBlock(claim, { cash, reload }) {
  const tone = { approved: 'good', requested: 'warn', rejected: '', withdrawn: '' }[claim.status];
  const label = {
    approved: 'approved', requested: 'waiting', rejected: 'not approved', withdrawn: 'taken back',
  }[claim.status] ?? claim.status;

  return h('div.adv-block',
    h('div.adv-block-head',
      h('div',
        h('strong', cash(claim.approved ?? claim.amount)),
        claim.approved != null && claim.approved !== claim.amount
          ? h('span.muted', ` of the ${cash(claim.amount)} you claimed`)
          : null,
        h(`span.pill${tone ? `.${tone}` : ''}`, { style: { marginLeft: '.4rem' } }, label)),
      claim.status === 'requested'
        ? h('button.btn-sm', {
          onclick: async () => {
            if (!confirmAction('Take this claim back?')) return;
            await api.myWithdrawClaim(claim.id);
            toast('Taken back.', 'good');
            await reload();
          },
        }, 'Take it back')
        : null),

    h('div.muted', { style: { fontSize: '.85rem' } },
      `Sent ${fmtDay(String(claim.askedAt).slice(0, 10))}`
      + (claim.decidedAt ? ` · decided ${fmtDay(String(claim.decidedAt).slice(0, 10))}` : '')),

    claim.what ? h('div.adv-reason', claim.what) : null,
    claim.decision ? h('div.adv-reason', `“${claim.decision}”`) : null,

    h('ul.med-receipts', claim.receipts.map((r) => h('li',
      h('div',
        h('strong', cash(r.amount)),
        r.what ? h('span.muted', ` · ${r.what}`) : null,
        r.spentOn ? h('span.muted', ` · ${fmtDay(r.spentOn)}`) : null),
      r.hasFile
        ? h('a.btn-sm', {
          href: api.medicalReceiptUrl(r.id), target: '_blank', rel: 'noopener',
        }, 'See it')
        : h('span.muted', 'no picture')))));
}

// --------------------------------------------------------------------------
// Making one
// --------------------------------------------------------------------------

/**
 * A claim, bill by bill.
 *
 * Rows are added one at a time and the total adds itself up as they go, so
 * nobody is asked to type a figure that the app could work out and then
 * disagree with. Each picture is shrunk here on the phone before it is sent:
 * a four-megabyte camera photograph of a pharmacy receipt is legible at a
 * fraction of that, and refusing the upload would send the whole thing back to
 * a paper tray.
 */
async function makeClaim(data, reload, cash) {
  const rows = [];
  const list = h('div.med-lines');
  const total = h('div.med-total');
  const addBtn = h('button.btn-sm', { type: 'button' }, 'Add another bill');

  const retotal = () => {
    const sum = rows.reduce((n, r) => n + (Number(r.amount.value) || 0), 0);
    total.textContent = `${rows.length} bill${rows.length === 1 ? '' : 's'} · ${cash(sum)}`;
    addBtn.disabled = rows.length >= MAX;
    addBtn.textContent = rows.length >= MAX ? 'Ten bills is the most on one claim' : 'Add another bill';
  };

  const addRow = () => {
    if (rows.length >= MAX) return;

    const amount = h('input', {
      type: 'number', step: '0.01', min: '0.01', required: true,
      'aria-label': 'How much', placeholder: '0.00', oninput: retotal,
    });
    const what = h('input', { type: 'text', maxlength: 200, placeholder: 'Pharmacy, consultation…', 'aria-label': 'What for' });
    const spentOn = h('input', { type: 'date', value: todayISO(), max: todayISO(), 'aria-label': 'When' });
    const status = h('small.muted');
    const picker = h('input', { type: 'file', accept: 'image/*,application/pdf', style: { display: 'none' } });

    const row = { amount, what, spentOn, file: null };

    const pick = h('button.btn-sm', { type: 'button', onclick: () => picker.click() }, 'Photograph the bill');
    picker.addEventListener('change', async () => {
      const file = picker.files?.[0];
      if (!file) return;
      status.textContent = 'Making it smaller…';
      try {
        row.file = await shrink(file);
        status.textContent = `${file.name.slice(0, 28)} · ${Math.round(row.file.bytes / 1024)} KB`;
        pick.textContent = 'Use a different picture';
      } catch (err) {
        row.file = null;
        status.textContent = err.message;
      }
    });

    const line = h('div.med-line',
      h('div.med-line-main', amount, what, spentOn),
      h('div.med-line-file', pick, picker, status,
        h('button.btn-ghost.btn-sm', {
          type: 'button',
          'aria-label': 'Take this bill off',
          onclick: () => {
            const at = rows.indexOf(row);
            if (at >= 0) rows.splice(at, 1);
            line.remove();
            retotal();
          },
        }, '✕')));

    rows.push(row);
    list.append(line);
    retotal();
    amount.focus();
  };

  addBtn.onclick = addRow;
  addRow();

  const done = await formDialog({
    title: 'Claim for medical bills',
    submitLabel: 'Send the claim',
    body: h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        data.standing
          ? `${cash(data.standing.left)} is left of your allowance this year. A claim is a `
            + 'request — somebody decides, and you are told either way.'
          : 'A claim is a request. Somebody decides, and you are told either way.'),
      field('What the claim is about', h('input', {
        type: 'text', name: 'what', maxlength: 300, placeholder: 'Optional',
      })),
      list,
      h('div.med-line-foot', addBtn, total),
      h('p.muted', { style: { fontSize: '.8rem', marginBottom: 0 } },
        'Ten bills at most on one claim. A bill with no picture can still be sent, but whoever '
        + 'decides is taking it on trust — bring the paper one to the office.')),
    onSubmit: async (form) => {
      const receipts = rows
        .filter((r) => Number(r.amount.value) > 0)
        .map((r) => ({
          amount: Number(r.amount.value),
          what: r.what.value,
          spentOn: r.spentOn.value,
          file: r.file
            ? { base64: r.file.base64, mime: r.file.mime, filename: r.file.filename }
            : null,
        }));
      if (!receipts.length) throw new Error('Put at least one bill on the claim.');
      return api.myMedicalClaim({ what: form.get('what'), receipts });
    },
  });

  if (!done) return;
  toast('Sent. You will be told when it is decided.', 'good');
  await reload();
}

/**
 * A photograph, made small enough to keep.
 *
 * The same ladder the personnel records use: a phone camera produces four
 * megabytes and a legible pharmacy receipt needs a fraction of that. Stopping
 * at 0.5 quality because below it the figures on a receipt stop being readable,
 * and an unreadable receipt is worse than none since it still looks like
 * evidence.
 */
async function shrink(file) {
  const LIMIT = 1_300_000;
  const raw = new Uint8Array(await file.arrayBuffer());

  if (!file.type.startsWith('image/')) {
    if (raw.length > LIMIT) {
      throw new Error(`That file is ${Math.round(raw.length / 1024)} KB and the limit is `
        + `${Math.round(LIMIT / 1024)} KB. Photograph it instead — pictures are shrunk to fit.`);
    }
    return {
      base64: toBase64(raw), mime: file.type || 'application/pdf', bytes: raw.length,
      filename: file.name,
    };
  }

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  for (const quality of [0.82, 0.7, 0.6, 0.5]) {
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const bytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
    if (bytes <= LIMIT) {
      return {
        base64: dataUrl.split(',')[1], mime: 'image/jpeg', bytes,
        filename: (file.name || 'receipt').replace(/\.[^.]+$/, '') + '.jpg',
      };
    }
  }
  throw new Error('That picture is too large even after shrinking. Try photographing it closer.');
}

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
