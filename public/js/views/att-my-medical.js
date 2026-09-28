import { api } from '../api.js';
import { fileLink } from '../file-view.js';
import { confirmAction, fmtDay, h, money, mount, toast, todayISO } from '../util.js';
import { card, emptyState } from './components.js';
import { formDialog } from './att-shared.js';

/**
 * My medical claims.
 *
 * WHAT SOMEBODY IS HERE TO FIND OUT. How much of this year's allowance is
 * left, and what happened to the claim they sent in. Both above the fold, and
 * everything else is the working behind them.
 *
 * THE BILLS ARE THE CLAIM. Adding one is an amount, what it was for, and a
 * photograph or several — taken on the phone that is already in their hand, shrunk before
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

        h('p.muted', { style: { fontSize: '.85rem' } },
          `You started ${year} with ${cash(s.opening)}: your allowance for ${year} of `
          + `${cash(s.allowance)}`
          + (s.carriedIn > 0
            ? `, plus ${cash(s.carriedIn)} carried forward from the previous period.`
            : s.carriedIn < 0
              ? `, less ${cash(Math.abs(s.carriedIn))} already claimed before the app was `
                + 'keeping the record.'
              : '.')),

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
        ? h('div.med-receipt-files', (r.files?.length ? r.files : [{ id: null }]).map((f, i, all) => fileLink({
          href: api.medicalReceiptUrl(r.id, f.id),
          name: all.length > 1 ? `Your receipt (${i + 1} of ${all.length})` : 'Your receipt',
          label: all.length > 1 ? `Picture ${i + 1}` : 'See it',
          className: 'btn-sm',
        })))
        : h('span.muted', 'no picture')))));
}

// --------------------------------------------------------------------------
// Making one
// --------------------------------------------------------------------------

/**
 * A claim, bill by bill.
 *
 * Each bill is a small card: how much, when, what for, and its pictures, up
 * to five, because a bill often comes with a prescription or a second page.
 * The total adds itself up as bills go on, so nobody is asked to type a
 * figure the app could work out and then disagree with. Each picture is
 * shrunk here on the phone before it is sent: a four-megabyte camera
 * photograph of a pharmacy receipt is legible at a fraction of that, and
 * refusing the upload would send the whole thing back to a paper tray.
 */
async function makeClaim(data, reload, cash) {
  const FILES = data.maxFiles ?? 5;
  const rows = [];
  const list = h('div.claim-bills');
  const total = h('div.claim-total');
  const overNote = h('div.claim-over', { hidden: true });
  const addBtn = h('button.btn-sm', { type: 'button' }, '+ Add another bill');
  const left = data.standing ? data.standing.left : null;

  const retotal = () => {
    const sum = rows.reduce((n, r) => n + (Number(r.amount.value) || 0), 0);
    total.textContent = `${rows.length} bill${rows.length === 1 ? '' : 's'} · ${cash(sum)}`;
    addBtn.disabled = rows.length >= MAX;
    addBtn.textContent = rows.length >= MAX ? 'Ten bills is the most on one claim' : '+ Add another bill';
    // Said, not stopped. The office may still cover a bill past the
    // allowance, so going over is allowed and simply made plain.
    overNote.hidden = !(left != null && sum > left);
    if (left != null && sum > left) {
      overNote.textContent = `That is ${cash(sum - left)} more than you have left. You can still `
        + 'send it; the office decides.';
    }
    rows.forEach((r, i) => {
      r.title.textContent = `Bill ${i + 1}`;
      r.remove.hidden = rows.length === 1;
    });
  };

  const addRow = () => {
    if (rows.length >= MAX) return;

    const amount = h('input', {
      type: 'number', step: '0.01', min: '0.01', required: true, inputmode: 'decimal',
      placeholder: '0.00', oninput: retotal,
    });
    const spentOn = h('input', { type: 'date', value: todayISO(), max: todayISO() });
    const what = h('input', { type: 'text', maxlength: 200, placeholder: 'Pharmacy, consultation, lab test…' });
    const title = h('strong');
    const chips = h('div.claim-files');
    const count = h('small.muted');
    const status = h('small.muted.claim-file-status');
    const picker = h('input', {
      type: 'file', accept: 'image/*,application/pdf', multiple: true, style: { display: 'none' },
    });
    const pick = h('button.btn-sm.claim-add-file', { type: 'button', onclick: () => picker.click() },
      '+ Add photos or PDF');

    const row = { amount, what, spentOn, files: [], title, remove: null };

    const repaint = () => {
      mount(chips, row.files.map((f) => h('div.claim-file', { title: f.filename },
        f.preview
          ? h('img', { src: f.preview, alt: '' })
          : h('span.claim-file-pdf', 'PDF'),
        h('span.claim-file-name', f.filename),
        h('span.muted.claim-file-size', `${Math.max(1, Math.round(f.bytes / 1024))} KB`),
        h('button.claim-file-off', {
          type: 'button',
          'aria-label': `Take ${f.filename} off`,
          onclick: () => {
            row.files.splice(row.files.indexOf(f), 1);
            if (f.preview) URL.revokeObjectURL(f.preview);
            repaint();
          },
        }, '✕'))));
      count.textContent = row.files.length ? `${row.files.length} of ${FILES}` : `Up to ${FILES}`;
      pick.disabled = row.files.length >= FILES;
      pick.hidden = row.files.length >= FILES;
    };

    picker.addEventListener('change', async () => {
      const chosen = [...(picker.files ?? [])];
      picker.value = '';
      if (!chosen.length) return;
      const room = FILES - row.files.length;
      const taking = chosen.slice(0, room);
      const problems = [];
      if (chosen.length > room) {
        const over = chosen.length - room;
        problems.push(`Only ${FILES} fit on one bill, so ${over} ${over === 1 ? 'was' : 'were'} left off.`);
      }
      status.textContent = taking.length === 1 ? 'Making it smaller…' : `Making ${taking.length} pictures smaller…`;
      for (const file of taking) {
        try {
          const small = await shrink(file);
          small.preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
          row.files.push(small);
        } catch (err) {
          problems.push(`${file.name}: ${err.message}`);
        }
      }
      status.textContent = problems.join(' ');
      repaint();
    });

    row.remove = h('button.btn-ghost.btn-sm', {
      type: 'button',
      'aria-label': 'Take this bill off',
      onclick: () => {
        const at = rows.indexOf(row);
        if (at >= 0) rows.splice(at, 1);
        for (const f of row.files) if (f.preview) URL.revokeObjectURL(f.preview);
        billCard.remove();
        retotal();
      },
    }, '✕');

    const billCard = h('div.claim-bill',
      h('div.claim-bill-head', title, row.remove),
      h('div.claim-bill-grid',
        h('label.field.claim-amount', h('span', `Amount (${data.currency})`), amount),
        h('label.field', h('span', 'Date on the bill'), spentOn),
        h('label.field.claim-what', h('span', 'What for'), what)),
      h('div.claim-files-row', chips, h('div.claim-files-add', pick, count), picker),
      status);

    rows.push(row);
    list.append(billCard);
    repaint();
    retotal();
    amount.focus();
  };

  addBtn.onclick = addRow;
  addRow();

  const done = await formDialog({
    title: 'Claim for medical bills',
    submitLabel: 'Send the claim',
    help: h('div',
      h('p', 'A claim is a request. Somebody in the office decides, and you are told either way.'),
      h('p', `Put each bill on separately, up to ten on one claim. Each bill takes up to ${FILES} `
        + 'photos or PDFs: the receipt, the prescription, a second page. Photos are made smaller '
        + 'on your phone before they are sent.'),
      h('p', { style: { marginBottom: 0 } }, 'A bill with no picture can still be sent, but whoever '
        + 'decides is taking it on trust, so bring the paper one to the office.')),
    body: h('div',
      left != null
        ? h('div.claim-left',
          h('span.muted', `Left for ${data.year}`),
          h('strong', cash(left)))
        : null,
      h('label.field', h('span', 'What is the claim about?'),
        h('input', { type: 'text', name: 'what', maxlength: 300, placeholder: 'Optional, e.g. malaria treatment' })),
      list,
      h('div.claim-foot', addBtn, total),
      overNote),
    onSubmit: async (form) => {
      const receipts = rows
        .filter((r) => Number(r.amount.value) > 0)
        .map((r) => ({
          amount: Number(r.amount.value),
          what: r.what.value,
          spentOn: r.spentOn.value,
          files: r.files.map((f) => ({ base64: f.base64, mime: f.mime, filename: f.filename })),
        }));
      if (!receipts.length) throw new Error('Put an amount on at least one bill.');
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
