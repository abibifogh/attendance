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

const dayText = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function openNewPo() {
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
    return { vendor: '', amount: '', date: new Date().toISOString().slice(0, 10), description: '', product: '', file: null, fileName: '', flags: {}, hints: {} };
  }
  let c = null;

  mount(inner, h('p', 'Loading Odoo’s vendors and items…'));
  loadChoices().then((d) => { c = d; v.date = d.today || v.date; form(); }).catch((err) => {
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
    const keep = () => { Object.assign(v, { vendor: vendor.value, amount: amount.value, date: date.value, description: description.value, product: product.value }); };
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
      const body = { vendorId, productId, amount: String(v.amount).replace(/,/g, ''), description: v.description.trim(), date: v.date };
      try { confirm(body, await api('/po/check', { method: 'POST', body })); } catch (e) { err.textContent = e.message; }
    };

    mount(inner,
      h('h2', 'New purchase order'),
      h('p.po-sub', 'A draft in Odoo, approved there as usual.'),
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
      h('datalist', { id: 'po-vendors' }, c.vendors.map((x) => h('option', { value: x.name }))),
      h('datalist', { id: 'po-products' }, c.products.map((x) => h('option', { value: x.name }))),
      err,
      h('div.po-acts', h('button.btn', { type: 'button', onclick: close }, 'Cancel'), h('button.btn.primary', { type: 'button', onclick: check }, 'Check')));
    if (!v.vendor && !said) vendor.focus();
  }

  function confirm(body, out) {
    const said = h('p.po-said.err');
    const create = async (e) => {
      e.target.disabled = true;
      said.className = 'po-said'; said.textContent = 'Creating in Odoo…';
      try {
        const res = await api('/po/create', { method: 'POST', body: { ...body, seen: out.alike.map((a) => a.name), ...(again ? { again: true } : {}), ...(v.file ? { file: v.file } : {}) } });
        if (res.already) { already(res.already); e.target.disabled = false; return; }
        done(res);
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
        h('dt', 'Receipt'), h('dd', v.file ? `${v.fileName || 'attached'}` : 'none')),
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
