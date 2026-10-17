import { h, mount, money } from '../util.js';
import { api } from '../api.js';

/**
 * Create PO, from ＋ PO in the header: a draft purchase order in Odoo.
 *
 * Three details by hand (vendor, amount, what was bought; the date is today),
 * or filled in for you from a sentence ("fuel 800ghs today") or a receipt (a
 * photo or a PDF). Green is what was read; amber is for you to choose. Then
 * one last look, with a warning if a PO like it is already there, and Create.
 * The PO is a draft: it is approved in Odoo as usual.
 */

let choices = null;
let choicesAt = 0;

/** Odoo's vendors and products, kept five minutes. */
async function loadChoices() {
  if (!choices || Date.now() - choicesAt > 300_000) {
    choices = await api('/po/new');
    choicesAt = Date.now();
  }
  return choices;
}

const SKIP = new Set(['for', 'the', 'and', 'from', 'with', 'of', 'to', 'at']);
const words = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !SKIP.has(w));
/**
 * The product whose name shares at least half its words with the description
 * (as the server matches): one shared word, a place name say, is not enough.
 */
function productFor(description, products) {
  const want = words(description);
  if (!want.length) return null;
  let best = null;
  for (const p of products) {
    const have = words(p.name);
    if (!have.length) continue;
    const shared = want.filter((w) => have.some((x) => x === w || (w.length > 3 && (x.startsWith(w) || w.startsWith(x))))).length;
    const score = shared / Math.max(want.length, have.length);
    if (score >= 0.5 && (!best || score > best.score)) best = { p, score };
  }
  return best?.p || null;
}

/** A photo made at most 1600 pixels across, as a JPEG: small text stays readable. */
async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally { URL.revokeObjectURL(url); }
}
const asDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(new Error('That file could not be opened.'));
  r.readAsDataURL(file);
});

/** A small picture for the list of receipts. */
async function thumbOf(dataUrl) {
  const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = dataUrl; });
  const scale = Math.min(1, 160 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.7);
}

/** What became of a receipt, in a few words. */
export function resultWords(r) {
  if (r.status === 'complete') return `✓ ${r.po.name} · ${r.vendorName} · ${money(r.amount)}`;
  if (r.status === 'check') return `⚠ ${r.po.name} · ${money(r.amount)} · ${r.vendorOk === false ? 'vendor to confirm' : 'item to check'}`;
  if (r.status === 'duplicate') return `= Seen before${r.po?.name ? `: ${r.po.name}` : ''}`;
  if (r.status === 'filled') return `✓ ${r.po?.name || 'PO made'}`;
  return `✕ No PO: ${r.problem || 'could not be read'}`;
}

const dayText = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * `receipt`: a kept receipt to fill in by hand ({ id, file, name }), read
 * straight away; `bulk`: open on "Just the receipts". `after` runs once a PO is made.
 */
export function openNewPo({ receipt = null, bulk = false, after = null } = {}) {
  const inner = h('div.po-in', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'New purchase order' });
  const sheet = h('div.po-sheet', inner);
  const close = () => { sheet.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(sheet);

  // What the form holds, and which fields were read (green) or need a choice (amber).
  let v = blank();
  function blank() {
    return { vendor: '', amount: '', date: new Date().toISOString().slice(0, 10), description: '', product: '', drawer: false, file: null, fileName: '', receiptId: null, flags: {}, hints: {} };
  }
  let c = null;

  if (bulk) { many(); return; }
  mount(inner, h('p', 'Loading Odoo’s vendors and items…'));
  loadChoices().then((d) => {
    c = d; v.date = d.today || v.date;
    if (receipt) {
      Object.assign(v, { file: receipt.file, fileName: receipt.name || 'Receipt', receiptId: receipt.id, readNow: { file: receipt.file, name: receipt.name } });
    }
    form();
  }).catch((err) => {
    mount(inner, h('h2', 'New purchase order'), h('p.po-said.err', err.message), h('div.po-acts', h('button.btn', { type: 'button', onclick: close }, 'Close')));
  });

  const idOf = (list, name) => list.find((x) => x.name.toLowerCase() === String(name || '').trim().toLowerCase())?.id || null;

  function form(said = null) {
    const field = (key, input, label) => {
      if (v.flags[key]) input.classList.add(v.flags[key] === 'ask' ? 'po-ask' : 'po-auto');
      input.addEventListener('input', () => { input.classList.remove('po-ask', 'po-auto'); delete v.flags[key]; delete v.hints[key]; });
      return h('label.po-f', label, input, v.hints[key] ? h(`span.po-hint${v.flags[key] === 'ask' ? '.warn' : ''}`, v.hints[key]) : null);
    };
    const vendor = h('input', { value: v.vendor, placeholder: 'Start typing: vendors in Odoo', autocomplete: 'off' });
    vendor.setAttribute('list', 'po-vendors');
    const amount = h('input', { inputmode: 'decimal', value: v.amount, placeholder: '0.00', autocomplete: 'off' });
    const date = h('input', { type: 'date', value: v.date });
    const description = h('input', { value: v.description, placeholder: 'What is being bought', maxlength: '200' });
    const product = h('input', { value: v.product, placeholder: 'Matched from the description', autocomplete: 'off' });
    product.setAttribute('list', 'po-products');
    const drawerBox = h('input', { type: 'checkbox', checked: v.drawer });
    const keep = () => { Object.assign(v, { vendor: vendor.value, amount: amount.value, date: date.value, description: description.value, product: product.value, drawer: drawerBox.checked }); };
    // The item follows the description until somebody chooses one.
    let chosen = Boolean(v.product);
    product.addEventListener('input', () => { chosen = Boolean(product.value); });
    description.addEventListener('change', () => {
      if (chosen) return;
      const p = productFor(description.value, c.products);
      product.value = p ? p.name : '';
    });

    const text = h('input', { placeholder: 'e.g. fuel 800ghs today', maxlength: '600', enterkeyhint: 'go' });
    const fileIn = h('input', { type: 'file', accept: 'image/*,application/pdf', hidden: true });
    const readSaid = h('p.po-said');
    const read = async (body) => {
      keep();
      readSaid.className = 'po-said';
      readSaid.textContent = body.file ? 'Reading the receipt…' : 'Reading…';
      try {
        const out = await api('/po/read', { method: 'POST', body });
        if (!out.read) { readSaid.className = 'po-said err'; readSaid.textContent = out.said || 'Nothing could be read.'; return; }
        const r = out.read;
        const flags = {};
        const hints = {};
        const from = body.file ? 'From the receipt' : 'From the text';
        if (r.vendor) {
          v.vendor = r.vendor.name;
          if (r.vendorFrom === 'read') { flags.vendor = 'auto'; hints.vendor = 'Found in Odoo'; } else { flags.vendor = 'ask'; hints.vendor = 'Not in the text: the vendor last used for this item. Check it.'; }
        } else if (r.vendorText) {
          v.vendor = ''; flags.vendor = 'ask'; hints.vendor = `“${r.vendorText}” is not a vendor in Odoo: choose one, or add it in Odoo first.`;
        } else { flags.vendor = 'ask'; hints.vendor = 'Not in the text: choose the vendor.'; }
        if (r.amount != null) { v.amount = (r.amount / 100).toFixed(2); flags.amount = 'auto'; hints.amount = body.file ? 'The receipt’s total' : from; } else { flags.amount = 'ask'; hints.amount = 'Not read for certain: type it.'; }
        if (r.description) { v.description = r.description; flags.description = 'auto'; hints.description = from; }
        if (r.date) { v.date = r.date; flags.date = 'auto'; hints.date = r.dateFrom === 'read' ? (body.file ? 'The receipt’s date' : from) : 'Today'; }
        if (r.product) { v.product = r.product.name; flags.product = 'auto'; hints.product = 'Matched from the description'; } else { v.product = ''; flags.product = 'ask'; hints.product = 'Choose the item in Odoo.'; }
        v.flags = flags;
        v.hints = hints;
        form(out.said ? ['ok', `Read. ${out.said}`] : ['ok', '✓ Read. Check each one, then Check.']);
      } catch (err) { readSaid.className = 'po-said err'; readSaid.textContent = err.message; }
    };
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && text.value.trim()) read({ text: text.value }); });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files[0];
      if (!f) return;
      try {
        if (f.type === 'application/pdf') {
          if (f.size > 5_000_000) throw new Error('That PDF is over 5 MB.');
          v.file = await asDataUrl(f);
        } else v.file = await shrink(f);
        v.fileName = f.name;
        await read({ file: v.file, name: f.name });
      } catch (err) { readSaid.className = 'po-said err'; readSaid.textContent = err.message; }
      fileIn.value = '';
    });

    const err = h('p.po-said.err');
    const check = async () => {
      keep();
      const vendorId = idOf(c.vendors, v.vendor);
      const productId = idOf(c.products, v.product);
      const missing = [!vendorId && (v.vendor ? `“${v.vendor}” is not a vendor in Odoo: choose one from the list` : 'the vendor'),
        !(Number(String(v.amount).replace(/,/g, '')) > 0) && 'the amount', !v.description.trim() && 'the description', !productId && 'the item in Odoo'].filter(Boolean);
      if (missing.length) { err.textContent = `Still needed: ${missing.join('; ')}.`; return; }
      err.textContent = 'Checking…';
      const body = { vendorId, productId, amount: String(v.amount).replace(/,/g, ''), description: v.description.trim(), date: v.date, drawer: v.drawer };
      try { confirm(body, await api('/po/check', { method: 'POST', body })); } catch (e) { err.textContent = e.message; }
    };

    mount(inner,
      h('h2', 'New purchase order'),
      h('p.po-sub', 'A draft in Odoo, approved there as usual.',
        v.receiptId ? null : [' Several receipts? ', h('button.sh-link', { type: 'button', onclick: () => many() }, 'Just the receipts')]),
      // Who Odoo will make it as, and a warning before anything is typed when Odoo will not let that login.
      c.as?.canCreate === false ? h('div.po-warn', h('b', 'Odoo will not let Insight create POs yet. '),
        `Insight’s Odoo key signs in as ${c.as.name || 'a login'}${c.as.login ? ` (${c.as.login})` : ''} on ${c.as.db || c.as.host}, and Odoo says that login may not create purchase orders. `,
        'In Odoo, give that login Purchase: User, or make the key on the login you use for POs.') : null,
      said ? h(`p.po-said${said[0] === 'err' ? '.err' : ''}`, said[1]) : null,
      h('div.po-quick',
        h('b', 'Fill it in for me (optional)'),
        h('div.po-qrow', text,
          h('button.btn', { type: 'button', onclick: () => { if (text.value.trim()) read({ text: text.value }); } }, 'Read'),
          h('button.btn', { type: 'button', title: 'A receipt: photo or PDF', 'aria-label': 'Read a receipt: photo or PDF', onclick: () => fileIn.click() }, '📎'), fileIn),
        v.file ? h('div.po-file', v.file.startsWith('data:image') ? h('img', { src: v.file, alt: '' }) : h('span', '📄'),
          h('span', `${v.fileName || 'Receipt'}: attached to the PO in Odoo`),
          h('button.sh-link', { type: 'button', onclick: () => { keep(); v.file = null; v.fileName = ''; form(); } }, 'Remove')) : null,
        readSaid),
      field('vendor', vendor, 'Vendor'),
      h('div.po-two', field('amount', amount, 'Amount, GH₵'), field('date', date, 'Date')),
      field('description', description, 'Description'),
      field('product', product, 'Item in Odoo'),
      // An admin's own PO is not a shift's expense unless allowed: here, or when staff ask.
      h('label.po-check', drawerBox, h('span', 'Staff may pay this from a drawer ', h('small', '(put it on a shift’s expenses). Leave it off for a PO paid another way.'))),
      h('datalist', { id: 'po-vendors' }, c.vendors.map((x) => h('option', { value: x.name }))),
      h('datalist', { id: 'po-products' }, c.products.map((x) => h('option', { value: x.name }))),
      err,
      h('div.po-acts', h('button.btn', { type: 'button', onclick: close }, 'Cancel'), h('button.btn.primary', { type: 'button', onclick: check }, 'Check')),
      c.as?.name || c.as?.login ? h('p.po-said', { style: 'color:var(--ink-2);font-size:.78rem' }, `In Odoo as ${c.as.name || ''}${c.as.login ? ` (${c.as.login})` : ''} · ${c.as.db || c.as.host}`) : null);
    if (!v.vendor && !said) vendor.focus();
    // A kept receipt, opened to be filled in: read it as if just chosen.
    if (v.readNow) { const now = v.readNow; v.readNow = null; read(now); }
  }

  /**
   * Just the receipts: several photos or PDFs, each read and made into a
   * draft PO straight away, with nothing to fill in. What each became is
   * said here, and kept in Money › Receipts.
   */
  function many() {
    const files = [];
    const pick = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, hidden: true });
    const list = h('div.po-many');
    const hint = h('input', { placeholder: 'What they are, if it helps (optional), e.g. fuel for the generator', maxlength: '300' });
    const said = h('p.po-said');
    const go = h('button.btn.primary', { type: 'button', disabled: true }, 'Make the draft POs');
    const show = () => {
      mount(list, files.map((f, i) => h('div.po-mfile', f.thumb ? h('img', { src: f.thumb, alt: '' }) : h('span', '📄'),
        h('small', f.name), f.result ? h(`span.po-mres.${f.result.status}`, resultWords(f.result)) : f.busy ? h('span.po-mres', 'Reading…')
          : h('button.sh-link', { type: 'button', onclick: () => { files.splice(i, 1); show(); } }, 'Remove'))));
      const waiting = files.filter((f) => !f.result).length;
      go.disabled = !waiting;
      go.textContent = waiting ? `Make ${waiting} draft PO${waiting === 1 ? '' : 's'}` : 'Make the draft POs';
    };
    pick.addEventListener('change', async () => {
      said.className = 'po-said'; said.textContent = 'Getting them ready…';
      try {
        for (const f of pick.files) {
          // eslint-disable-next-line no-await-in-loop
          const file = f.type === 'application/pdf' ? (f.size > 7_000_000 ? null : await asDataUrl(f)) : await shrink(f);
          if (!file) { said.className = 'po-said err'; said.textContent = `${f.name} is over 7 MB: take a photo of it instead.`; continue; }
          // eslint-disable-next-line no-await-in-loop
          files.push({ name: f.name, file, thumb: f.type === 'application/pdf' ? null : await thumbOf(file) });
        }
        if (!said.classList.contains('err')) said.textContent = '';
      } catch (err) { said.className = 'po-said err'; said.textContent = err.message; }
      pick.value = '';
      show();
    });
    go.addEventListener('click', async () => {
      go.disabled = true;
      said.className = 'po-said'; said.textContent = '';
      for (const f of files.filter((x) => !x.result)) {
        f.busy = true; show();
        try {
          // eslint-disable-next-line no-await-in-loop
          f.result = (await api('/receipts/upload', { method: 'POST', body: { file: f.file, name: f.name, thumb: f.thumb, hint: hint.value } })).receipt;
        } catch (err) { f.result = { status: 'failed', problem: err.message }; }
        f.busy = false; show();
      }
      const made = files.filter((f) => f.result?.po && ['complete', 'check'].includes(f.result.status)).length;
      said.textContent = `${made} draft PO${made === 1 ? '' : 's'} made. Each is kept in Money › Receipts, with what to check.`;
      if (after) after();
    });
    mount(inner,
      h('h2', 'New purchase orders from receipts'),
      h('p.po-sub', 'Choose or take pictures, or PDFs. Each is read and made into a draft PO straight away, with the receipt attached. No form to fill.'),
      h('button.pf-add', { type: 'button', onclick: () => pick.click() }, '📷 Take pictures, or choose several photos / PDFs'), pick,
      list, hint, said,
      h('div.po-acts', h('button.btn', { type: 'button', onclick: close }, 'Close'), go),
      h('p.po-said', { style: 'color:var(--ink-2);font-size:.78rem' }, 'Prefer to check each first? ',
        h('button.sh-link', { type: 'button', onclick: () => { if (c) form(); else { mount(inner, h('p', 'Loading Odoo’s vendors and items…')); loadChoices().then((d) => { c = d; v.date = d.today || v.date; form(); }).catch((err) => { said.className = 'po-said err'; said.textContent = err.message; }); } } }, 'The one-at-a-time form')));
    show();
    pick.click();
  }

  function confirm(body, out) {
    const said = h('p.po-said.err');
    const create = async (e) => {
      e.target.disabled = true;
      said.className = 'po-said'; said.textContent = 'Creating in Odoo…';
      try {
        const res = await api('/po/create', { method: 'POST', body: { ...body, seen: out.alike.map((a) => a.name), ...(again ? { again: true } : {}), ...(v.file ? { file: v.file } : {}), ...(v.receiptId ? { receiptId: v.receiptId } : {}) } });
        if (res.already) { already(res.already); e.target.disabled = false; return; }
        done(res);
        if (after) after(res);
      } catch (er) {
        said.className = 'po-said err'; said.textContent = er.message; e.target.disabled = false;
      }
    };
    let again = false;
    // Odoo has one made from Insight for this already: most likely the last press went through.
    const already = (a) => {
      said.className = 'po-said';
      said.replaceChildren(h('div.po-warn', h('b', `${a.name} is already in Odoo for this`), `, made from Insight (${a.origin}). The last Create most likely went through. `,
        a.url ? h('a', { href: a.url, target: '_blank', rel: 'noopener' }, 'Open it in Odoo') : null, '. ',
        h('button.sh-link', { type: 'button', onclick: (ev) => { again = true; create(ev); } }, 'It is a second purchase: create another')));
    };
    const p = out.po;
    mount(inner,
      h('h2', 'Create this PO in Odoo?'),
      h('dl',
        h('dt', 'Vendor'), h('dd', p.vendor.name),
        h('dt', 'Line'), h('dd', `${p.description} · 1 × ${money(p.amount)}`),
        h('dt', 'Item in Odoo'), h('dd', p.product.name),
        h('dt', 'Total'), h('dd', h('b', money(p.amount))),
        h('dt', 'Date'), h('dd', dayText(p.date)),
        h('dt', 'In Odoo as'), h('dd', 'Draft (Request for quotation), approved in Odoo as usual'),
        h('dt', 'Receipt'), h('dd', v.file ? `${v.fileName || 'attached'}` : 'none'),
        h('dt', 'From a drawer'), h('dd', v.drawer ? 'Allowed: staff can put it on a shift’s expenses' : 'Not allowed unless you allow it later (staff who try will ask you)')),
      out.alike.length ? h('div.po-warn', '⚠ Looks like one already there: ',
        out.alike.map((a, i) => [i ? '; ' : '', h('b', a.name), ` · ${money(a.total)} · ${a.state === 'draft' ? 'draft' : a.state}${a.by ? `, by ${a.by}` : ''}`]),
        '. Create anyway only if this is a second purchase.') : null,
      said,
      h('div.po-acts', h('button.btn', { type: 'button', onclick: () => form() }, 'Back'), h('button.btn.primary', { type: 'button', onclick: create }, 'Create in Odoo')));
  }

  function done(out) {
    const p = out.po;
    mount(inner,
      h('div.po-ok',
        h('b', { style: 'font-size:1.08rem' }, `✓ ${p.name || 'The PO'} created in Odoo`),
        h('div', `${p.vendor} · ${p.description} · ${money(p.amount)} · a draft, waiting for approval in Odoo.`),
        p.total != null && p.total !== p.amount ? h('div', h('b', `Odoo’s total is ${money(p.total)}`), ': tax was added to the item in Odoo. Change it there if it should not be.') : null,
        v.file ? h('div', out.attached ? 'The receipt is attached to it.' : `The receipt could not be attached (${out.attachError || 'no reason given'}): add it in Odoo.`) : null),
      h('div.po-acts',
        p.url ? h('a.btn.primary', { href: p.url, target: '_blank', rel: 'noopener' }, 'Open in Odoo') : null,
        h('button.btn', { type: 'button', onclick: () => { v = blank(); v.date = c.today || v.date; form(); } }, 'Create another'),
        h('button.btn', { type: 'button', onclick: close }, 'Close')));
  }
}
