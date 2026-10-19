import { all, first, run } from '../lib/db.js';
import { badRequest, HttpError, str } from '../lib/http.js';
import { todayIn, isDay, addDays } from '../lib/dates.js';
import { poChoices, lastVendorFor, posOnDay, createDraftPo, attachToPo, whoAmI, findInOdoo, oneInOdoo } from '../connectors/odoo.js';
import { odooSource } from './safebook.js';
import { READ_MODEL } from './niceplace.js';

/**
 * Create PO: a draft purchase order in Odoo, from three details typed by an
 * admin (vendor, amount, what was bought), or filled in from a sentence
 * ("fuel 800ghs today") or a receipt (a photo, or a PDF).
 *
 * The reader only fills the form. Nothing goes to Odoo until the admin has
 * looked at it, been told of any PO to the same vendor for the same amount
 * that day, and pressed Create. Insight only creates drafts: approving stays
 * in Odoo. It never creates a vendor; the receipt is attached to the PO.
 */

/** The largest receipt taken: a PDF of about 5 MB, base64. */
const FILE_MAX = 7_000_000;
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const who = (account) => account?.name || account?.email || 'Owner';

async function source(env) {
  const s = await odooSource(env);
  if (!s) throw new HttpError(409, 'Odoo is not set up in Insight yet.');
  return s;
}

/** What the form needs: Odoo's vendors and products, and today. */
export async function poForm(env, { fetchImpl } = {}) {
  const s = await source(env);
  const opts = { ...s, ...(fetchImpl ? { fetchImpl } : {}) };
  const [choices, as] = await Promise.all([poChoices(opts), whoAmI(opts).catch(() => null)]);
  // Who the PO will be created as in Odoo, and whether Odoo lets that login create one.
  return { ...choices, as, today: todayIn('UTC') };
}

// ------------------------------------------------------------ matching --

const words = (text) => String(text || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ')
  .split(/\s+/).filter((w) => w.length > 1 && !['ltd', 'limited', 'company', 'co', 'enterprise', 'enterprises', 'the', 'and', 'gh', 'ghana'].includes(w));

/**
 * The closest name in a list, or null when none is close enough to trust.
 * Same words first; then one name inside the other; then most words shared.
 */
export function closest(text, list) {
  const want = words(text);
  if (!want.length || !list?.length) return null;
  const key = want.join(' ');
  let best = null;
  for (const item of list) {
    const have = words(item.name);
    if (!have.length) continue;
    const name = have.join(' ');
    let score = 0;
    if (name === key) score = 1;
    else if (name.includes(key) || key.includes(name)) score = 0.85;
    else {
      const shared = want.filter((w) => have.some((h) => h === w || (w.length > 3 && (h.startsWith(w) || w.startsWith(h))))).length;
      score = shared / Math.max(want.length, have.length);
    }
    if (!best || score > best.score || (score === best.score && item.name.length < best.item.name.length)) best = { item, score };
  }
  return best && best.score >= 0.5 ? best.item : null;
}

// ------------------------------------------------------------- reading --

/**
 * The vendor in Odoo for a name as written: among Odoo's vendors first, then
 * among every contact with a word of that name (a vendor made in Odoo just
 * now has never been used, so Odoo does not list it as one yet).
 */
export async function matchVendor(opts, text, vendors) {
  if (!text) return null;
  const known = closest(text, vendors);
  if (known) return known;
  const word = words(text).sort((a, b) => b.length - a.length)[0];
  if (!word) return null;
  const found = await findInOdoo({ ...opts, kind: 'vendor', q: word }).catch(() => []);
  return closest(text, found);
}

const PICK_SCHEMA = {
  type: 'object',
  properties: { number: { type: 'integer' }, sure: { type: 'boolean' } },
  required: ['number', 'sure'],
};

/**
 * The product in Odoo nearest what was bought.
 *
 * Words first (`closest`), which is certain when it finds one. When no name
 * shares enough words, the reader picks one by meaning: "Diesel Excellium"
 * is Fuel, "3 grooves pulley" is a spare part. It also says whether it is
 * sure, and an unsure pick is left for somebody to check rather than taken
 * as fact. Null when nothing fits, or there is no reader.
 */
export async function matchProduct(env, description, products, { vendor = '' } = {}) {
  if (!description || !products?.length) return null;
  const byWords = closest(description, products);
  if (byWords) return { product: byWords, by: 'words', sure: true };
  if (!env.AI) return null;
  const list = products.slice(0, 1500);
  const ask_ = [
    `A hotel in Ghana bought: "${String(description).slice(0, 200)}"${vendor ? ` from "${String(vendor).slice(0, 120)}"` : ''}.`,
    'Which of the products below in its accounts is it? Choose the closest by meaning, not by spelling: diesel or petrol is fuel; a pulley, belt or bearing is a spare part or maintenance; bleach is cleaning.',
    'Answer with JSON only: {"number": the product\'s number, or 0 if none of them fits, "sure": true only if it is clearly that product}.',
    '',
    ...list.map((p, i) => `${i + 1}. ${p.name}`),
  ].join('\n');
  for (const extra of [{ response_format: { type: 'json_schema', json_schema: PICK_SCHEMA } }, {}]) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await env.AI.run(READ_MODEL, { messages: [{ role: 'user', content: ask_ }], max_tokens: 60, temperature: 0, ...extra });
      let raw = out?.response ?? out;
      if (typeof raw === 'string') { const m = raw.match(/\{[\s\S]*\}/); raw = m ? JSON.parse(m[0]) : null; }
      const n = Number(raw?.number);
      if (!Number.isInteger(n)) continue;
      if (n < 1 || n > list.length) return null;
      return { product: list[n - 1], by: 'reader', sure: raw.sure === true };
    } catch { /* tried again without the schema, then nothing */ }
  }
  return null;
}

const SCHEMA = {
  type: 'object',
  properties: {
    vendor: { type: 'string' }, amount: { type: 'string' }, description: { type: 'string' }, date: { type: 'string' }, problem: { type: 'string' },
  },
  required: ['vendor', 'amount', 'description', 'date', 'problem'],
};

function prompt(kind, today) {
  return [
    kind === 'text'
      ? 'Somebody at a hotel in Ghana typed this to raise a purchase order. Pick out what to buy, from whom, for how much and on what day.'
      : 'This is a receipt (or invoice) from a purchase by a hotel in Ghana. Pick out who sold it, the total paid, what was bought and the date on it.',
    `Today is ${today}. Give the date as YYYY-MM-DD: "today" is ${today}, "yesterday" is ${addDays(today, -1)}. Empty if no date is given.`,
    'The amount is in Ghana cedis (GHS, GH₵, cedis, ghs): give it as a plain number, like 800 or 145.50, the total. Empty if there is none or you are not sure of every digit.',
    'The description is a few words of what was bought, like "Fuel" or "2 padlocks, 1 hinge". The vendor is the seller\'s name as written; empty if none is given.',
    'Never guess: leave a field empty rather than invent it. Answer with JSON only: {"vendor": "", "amount": "", "description": "", "date": "", "problem": ""}.',
    'In "problem", say in a few plain words what could not be read, or "" if nothing.',
  ].join('\n');
}

/** The reader's answer, however it comes back, as the four fields. */
export function parseAnswer(result) {
  let raw = result?.response ?? result;
  if (typeof raw === 'string') {
    const m = raw.match(/\{[\s\S]*\}/);
    try { raw = m ? JSON.parse(m[0]) : null; } catch { raw = null; }
  }
  if (!raw || typeof raw !== 'object') return null;
  const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
  const amount = Number(text(raw.amount ?? raw.total).replace(/[^0-9.]/g, ''));
  const date = text(raw.date).slice(0, 10);
  return {
    vendor: text(raw.vendor, 120),
    amount: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null,
    description: text(raw.description ?? raw.items, 200),
    date: isDay(date) ? date : null,
    problem: text(raw.problem, 300),
  };
}

/** Without the reader: the amount and the day from a sentence, the rest as typed. */
export function plainRead(text, today) {
  const t = String(text || '');
  const money = t.match(/(?:gh[s₵c]?\s*)?(\d[\d,]*(?:\.\d{1,2})?)\s*(?:k\b)?\s*(?:gh[s₵c]?|cedis?)?/i);
  const amount = money ? Math.round(Number(money[1].replace(/,/g, '')) * 100) : null;
  const date = /\byesterday\b/i.test(t) ? addDays(today, -1) : /\btoday\b/i.test(t) ? today : (t.match(/\b\d{4}-\d{2}-\d{2}\b/) || [null])[0];
  const description = t.replace(/\b(create|raise|make|a|an|po|purchase order|for|with|today[’']?s?|yesterday[’']?s?|date|of|on|dated)\b/gi, ' ')
    .replace(/(?:gh[s₵c]?\s*)?\d[\d,]*(?:\.\d{1,2})?\s*(?:gh[s₵c]?|cedis?)?/gi, ' ').replace(/[’'"]/g, '').replace(/\s+/g, ' ').trim();
  return { vendor: '', amount: amount > 0 ? amount : null, description: description ? description.charAt(0).toUpperCase() + description.slice(1) : '', date, problem: '' };
}

async function ask(env, messages) {
  const errors = [];
  for (const extra of [{ response_format: { type: 'json_schema', json_schema: SCHEMA } }, {}]) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = parseAnswer(await env.AI.run(READ_MODEL, { messages, max_tokens: 300, temperature: 0, ...extra }));
      if (out) return { out, errors };
      errors.push('Answer not understood.');
    } catch (err) { errors.push(String(err?.message || err).slice(0, 200)); }
  }
  return { out: null, errors };
}

/** A PDF's text, by Workers AI's converter. Empty for a scan with no text in it. */
async function pdfText(env, base64, name) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const res = await env.AI.toMarkdown({ name: name || 'receipt.pdf', blob: new Blob([bytes], { type: 'application/pdf' }) });
  if (!res || res.format === 'error') throw new Error(res?.error || 'The PDF could not be opened.');
  return String(res.data || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim();
}

/**
 * A receipt read: what was read (vendor as written, amount, description,
 * date, problem), or null. `hint` is a line somebody wrote with it ("fuel for
 * the generator"), to help, never to be taken over what the receipt says.
 * `noText` is a PDF with no text in it, which a photo would read.
 */
export async function readReceipt(env, { mime, data, name = null, hint = '', today = todayIn('UTC') }) {
  const ask_ = prompt('receipt', today) + (hint ? `\nWhoever sent it wrote: "${String(hint).slice(0, 300)}". Use it only to help read the receipt.` : '');
  if (mime === 'application/pdf') {
    let content = '';
    let note = '';
    try { content = await pdfText(env, data, name); } catch (err) { note = String(err?.message || err); }
    if (!content) return { read: null, noText: true, said: note || 'This PDF has no text in it (a scan). Take a photo of the receipt instead, or fill in the details by hand.' };
    const { out } = await ask(env, [{ role: 'user', content: `${ask_}\n\nThe receipt, as text:\n${content.slice(0, 6000)}` }]);
    return { read: out };
  }
  const { out } = await ask(env, [{ role: 'user', content: [{ type: 'text', text: ask_ }, { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } }] }]);
  return { read: out };
}

/**
 * Fill the form from a sentence or a receipt. Returns what was read, matched
 * to a vendor and a product in Odoo where one is close enough, and the vendor
 * the last PO for that product went to when the sentence named none.
 */
export async function readPo(env, body, { fetchImpl } = {}) {
  const today = todayIn('UTC');
  const text = str(body?.text, 'What to buy', { max: 600 });
  const file = String(body?.file || '');
  if (!text && !file) throw badRequest('Type what to buy, or choose a receipt.');
  let read = null;
  if (text) {
    if (env.AI) {
      const { out } = await ask(env, [{ role: 'user', content: `${prompt('text', today)}\n\nWhat was typed: ${text}` }]);
      read = out;
    }
    // The reader down or unsure of the number: the plain reading fills what it can.
    const plain = plainRead(text, today);
    read = read ? { ...read, amount: read.amount ?? plain.amount, date: read.date ?? plain.date, description: read.description || plain.description } : plain;
  } else {
    const m = file.match(/^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw badRequest('Choose a photo or a PDF of the receipt.');
    if (m[2].length > FILE_MAX) throw badRequest('That file is too large: a photo, or a PDF under 5 MB.');
    if (!env.AI) throw new HttpError(503, 'The reader (Workers AI) is not available. Fill in the details by hand; the receipt is still attached.');
    const got = await readReceipt(env, { mime: m[1], data: m[2], name: body?.name, today });
    if (got.noText) return { read: null, said: got.said };
    read = got.read;
    if (!read) return { read: null, said: 'The receipt could not be read just now. Fill in the details by hand; the receipt is still attached.' };
  }
  const s = await source(env);
  const opts = { ...s, ...(fetchImpl ? { fetchImpl } : {}) };
  const { vendors, products } = await poChoices(opts);
  const vendor = read.vendor ? await matchVendor(opts, read.vendor, vendors) : null;
  const match = read.description ? await matchProduct(env, read.description, products, { vendor: read.vendor }) : null;
  const product = match?.product || null;
  // No vendor said: the one the last PO for this product went to.
  let suggested = null;
  if (!vendor && product) suggested = await lastVendorFor({ ...opts, productId: product.id }).catch(() => null);
  return {
    read: {
      ...read,
      vendor: vendor || suggested || null,
      vendorText: read.vendor || '',
      vendorFrom: vendor ? 'read' : suggested ? 'last' : null,
      product: product || null,
      // Matched by its words, or picked by the reader (and whether it was sure).
      productFrom: match?.by || null,
      productSure: match ? match.sure : null,
      date: read.date || today,
      dateFrom: read.date ? 'read' : 'today',
    },
    said: read.problem || '',
  };
}

// ---------------------------------------------------- checking, creating --

/**
 * Find contacts or products in Odoo by name, for one made there just now
 * (Odoo lists a contact as a vendor only once it has been used).
 */
export async function findPo(env, query, { fetchImpl } = {}) {
  const s = await source(env);
  const kind = query?.kind === 'vendor' ? 'vendor' : 'product';
  return { kind, items: await findInOdoo({ ...s, ...(fetchImpl ? { fetchImpl } : {}), kind, q: query?.q }) };
}

/**
 * The vendor and item chosen: from the lists, or, for one found by name and
 * not in them (a contact never used as a vendor yet), as Odoo has it now.
 */
async function details(body, { vendors, products }, opts) {
  const vendorId = Number(body?.vendorId);
  const productId = Number(body?.productId);
  const vendor = vendors.find((v) => v.id === vendorId)
    || (Number.isInteger(vendorId) && vendorId > 0 ? await oneInOdoo({ ...opts, kind: 'vendor', id: vendorId }).catch(() => null) : null);
  if (!vendor) throw badRequest('Choose the vendor from Odoo’s list. A new vendor is added in Odoo first.');
  let product = products.find((p) => p.id === productId);
  if (!product && Number.isInteger(productId) && productId > 0) {
    const found = await oneInOdoo({ ...opts, kind: 'product', id: productId }).catch(() => null);
    if (found && !found.purchaseOk) throw badRequest(`“${found.name}” is not marked “Can be purchased” in Odoo: tick it there, or choose another item.`);
    product = found;
  }
  if (!product) throw badRequest('Choose the item in Odoo.');
  const amount = Math.round(Number(String(body?.amount ?? '').replace(/[,\s]/g, '')) * 100);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) throw badRequest('Amount: GH₵, more than nothing.');
  const description = str(body?.description, 'Description', { required: true, max: 200 });
  const day = String(body?.date || '');
  if (!isDay(day)) throw badRequest('Choose the date.');
  return { vendor, product, amount, description, day };
}

/** The last look before creating: the PO as it will be, and any like it already there. */
export async function checkPo(env, body, { fetchImpl } = {}) {
  const s = await source(env);
  const opts = { ...s, ...(fetchImpl ? { fetchImpl } : {}) };
  const d = await details(body, await poChoices(opts), opts);
  const same = await posOnDay({ ...opts, vendorId: d.vendor.id, day: d.day });
  return {
    po: { vendor: d.vendor, product: d.product, amount: d.amount, description: d.description, date: d.day },
    // The same vendor, the same day, within a cedi of the amount.
    alike: same.filter((p) => Math.abs(p.total - d.amount) <= 100),
  };
}

/** Create it: a draft in Odoo, the receipt attached, and a line kept here of who made it. */
export async function createPo(env, body, account, { fetchImpl, mark = null } = {}) {
  const s = await source(env);
  const opts = { ...s, ...(fetchImpl ? { fetchImpl } : {}) };
  const d = await details(body, await poChoices(opts), opts);
  const file = String(body?.file || '');
  const m = file ? file.match(/^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/) : null;
  if (file && (!m || m[2].length > FILE_MAX)) throw badRequest('That receipt cannot be attached: a photo, or a PDF under 5 MB.');
  // A PO made from Insight for this already, that was not on the last look:
  // pressed again after an answer that never came back. Said, not made twice.
  const base = String(opts.config?.base || '').replace(/\/+$/, '');
  const urlOf = (id) => (base ? `${base}/web#model=purchase.order&id=${id}&view_type=form` : null);
  const seen = new Set((Array.isArray(body?.seen) ? body.seen : []).map(String));
  const fromHere = async () => (await posOnDay({ ...opts, vendorId: d.vendor.id, day: d.day }).catch(() => []))
    .find((p) => /^(Insight|FLT\/)/.test(p.origin) && Math.abs(p.total - d.amount) <= 100 && !seen.has(p.name));
  if (!body?.again) {
    const made = await fromHere();
    if (made) return { ok: false, already: { ...made, url: urlOf(made.id) } };
  }
  let po;
  try {
    po = await createDraftPo({
      ...opts, vendorId: d.vendor.id, productId: d.product.id, amount: d.amount, day: d.day,
      // A float's receipt filled in by hand: its reference, as one read would carry.
      description: mark ? `${d.description} (${mark.label})`.slice(0, 200) : d.description,
      origin: mark ? mark.origin : `Insight · ${who(account)}`, partnerRef: mark?.ref || null,
    });
  } catch (err) {
    console.error('Create PO', err);
    // Odoo may have made it and then failed to answer: looked for once before saying it failed.
    const made = await fromHere();
    if (!made) {
      // Refused: say which login Odoo refused, so the right one is looked at.
      let who_ = '';
      if (/not allowed|did not allow/i.test(String(err?.message))) {
        const me = await whoAmI(opts).catch(() => null);
        if (me?.name || me?.login) who_ = ` Insight's Odoo key signs in as ${me.name || ''}${me.login ? ` (${me.login})` : ''} on ${me.db || me.host}.`;
      }
      throw new HttpError(502, `Odoo did not create the PO. ${String(err?.message || err)}${who_}`);
    }
    po = { id: made.id, name: made.name, total: made.total, state: made.state, url: urlOf(made.id) };
  }
  let attached = false;
  let attachError = null;
  if (m) {
    const ext = m[1] === 'application/pdf' ? 'pdf' : m[1].split('/')[1].replace('jpeg', 'jpg');
    try {
      await attachToPo({ ...opts, poId: po.id, name: `Receipt ${po.name || po.id}.${ext}`, mimetype: m[1], data: m[2] });
      attached = true;
    } catch (err) { attachError = String(err?.message || err).slice(0, 200); }
  }
  // Paid from a drawer only if allowed: ticked here, or later when staff ask.
  const drawer = body?.drawer === true;
  await run(env.DB, `INSERT INTO po_created (odoo_id, name, vendor, product, description, amount, total, day, receipt, by_name, at, drawer_ok, drawer_by, drawer_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?11)`,
  po.id, po.name, d.vendor.name, d.product.name, d.description, d.amount, po.total, d.day, attached ? 1 : 0, who(account), now(),
  drawer ? 1 : null, drawer ? who(account) : null).catch((err) => console.error('Create PO: keeping it', err));
  return { ok: true, po: { ...po, vendor: d.vendor.name, description: d.description, amount: d.amount, date: d.day }, attached, attachError };
}

/** The POs made from here lately, newest first. */
export async function recentPos(env) {
  return { items: await all(env.DB, 'SELECT * FROM po_created ORDER BY id DESC LIMIT 20').catch(() => []) };
}

// ------------------------------------------- paid from a shift's drawer --

/**
 * POs made here, as HIVE needs to know them when somebody puts one on a
 * shift: made in Insight, and whether an admin allowed it from a drawer.
 */
export async function madeHere(env, names) {
  const wanted = [...new Set((names || []).map((n) => String(n || '').trim().toUpperCase()).filter(Boolean))];
  if (!wanted.length) return new Map();
  const rows = await all(env.DB, `SELECT * FROM po_created WHERE UPPER(name) IN (${wanted.map((_, i) => `?${i + 1}`).join(', ')}) ORDER BY id`, ...wanted).catch(() => []);
  return new Map(rows.map((r) => [String(r.name).toUpperCase(), {
    by: r.by_name, at: r.at, allowed: Number(r.drawer_ok) === 1, refused: r.drawer_ok != null && Number(r.drawer_ok) === 0,
    decidedBy: r.drawer_by || null, note: r.drawer_note || null,
  }]));
}

/** A member of staff tried to put one on a shift: the admins are asked, once. */
export async function askForDrawer(env, body) {
  const name = String(body?.name || '').trim().toUpperCase();
  const by = str(body?.by, 'Who', { max: 120 }) || 'Somebody';
  if (!name) throw badRequest('Which PO?');
  await run(env.DB, 'UPDATE po_created SET asked_by = ?2, asked_at = ?3 WHERE UPPER(name) = ?1 AND drawer_ok IS NULL AND asked_at IS NULL', name, by, now());
  return { ok: true };
}

/** What is waiting for an admin: POs made here that somebody wants to pay from a drawer. */
export async function drawerAsks(env) {
  const rows = await all(env.DB, 'SELECT * FROM po_created WHERE drawer_ok IS NULL AND asked_at IS NOT NULL ORDER BY asked_at').catch(() => []);
  return { items: rows.map((r) => ({ name: r.name, vendor: r.vendor, description: r.description, amount: r.amount, total: r.total, day: r.day, madeBy: r.by_name, madeAt: r.at, askedBy: r.asked_by, askedAt: r.asked_at })) };
}

/** Allow it on a shift, or refuse with a reason (or take either back). */
export async function decideDrawer(env, body, account) {
  const name = String(body?.name || '').trim().toUpperCase();
  const row = name ? await first(env.DB, 'SELECT id FROM po_created WHERE UPPER(name) = ?1', name) : null;
  if (!row) throw new HttpError(404, 'That PO was not made in Insight.');
  if (body?.undo) {
    await run(env.DB, 'UPDATE po_created SET drawer_ok = NULL, drawer_by = NULL, drawer_at = NULL, drawer_note = NULL WHERE id = ?1', row.id);
    return { ok: true };
  }
  const allow = body?.allow === true;
  const note = str(body?.note, 'Why', { required: !allow, max: 300 });
  await run(env.DB, 'UPDATE po_created SET drawer_ok = ?2, drawer_by = ?3, drawer_at = ?4, drawer_note = ?5 WHERE id = ?1', row.id, allow ? 1 : 0, who(account), now(), note);
  return { ok: true };
}
