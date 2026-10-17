import { all, first, run, getSettings, setSetting } from '../lib/db.js';
import { badRequest, HttpError, str } from '../lib/http.js';
import { todayIn } from '../lib/dates.js';
import { callLink } from '../lib/link.js';
import { readEmail, addressOf } from '../lib/mime.js';
import { poChoices, posOnDay, createDraftPo, attachToPo, noteOnPo, todoOnPo, odooUsers } from '../connectors/odoo.js';
import { odooSource } from './safebook.js';
import { closest, matchProduct, readReceipt } from './newpo.js';

/**
 * Receipts made into draft POs, with nothing to fill in: several chosen at
 * once in Insight (＋ PO › Just the receipts), or emailed to the receipts
 * address.
 *
 * Each receipt is read; the vendor and the item are matched to Odoo; a draft
 * PO is made with the receipt attached and a note of what was read. Where the
 * vendor or the item is not in Odoo, the PO uses the placeholder an admin
 * chose ("Vendor to confirm", "Item to classify"), and the accountant chosen
 * gets a To-Do on it in Odoo saying exactly what to check. Insight never
 * creates a vendor, and approving stays in Odoo.
 *
 * Nothing is lost: a receipt that cannot be read, or that Odoo refused, is
 * kept with its file for somebody to fill in by hand. The same file twice,
 * or a PO already in Odoo for the same vendor, day and amount, is said and
 * not made again.
 */

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
/** The largest file taken: about 10 MB. */
const FILE_MAX = 14_000_000;
/** What Odoo takes as an attachment, and the reader reads: about 7 MB. */
const ATTACH_MAX = 9_500_000;
/** A file is kept in pieces of this many characters, one row each. */
const PART = 1_500_000;
const TYPES = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;
const ghs = (minor) => `GH₵${(minor / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --------------------------------------------------------------- settings --

const KEYS = ['receipts_address', 'receipts_senders', 'receipts_vendor', 'receipts_product', 'receipts_todo_user'];
const readRef = (v) => { try { const r = JSON.parse(v || 'null'); return r && Number.isInteger(r.id) ? r : null; } catch { return null; } };
const senderList = (v) => [...new Set(String(v || '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))];

export async function receiptSettings(env) {
  const s = await getSettings(env.DB).catch(() => ({}));
  return {
    address: s.receipts_address || '',
    senders: senderList(s.receipts_senders),
    vendor: readRef(s.receipts_vendor),
    product: readRef(s.receipts_product),
    todoUser: readRef(s.receipts_todo_user),
  };
}

/** Odoo's vendors, items and people, for the settings' choices. */
export async function settingsChoices(env) {
  const s = await odooSource(env);
  if (!s) throw new HttpError(409, 'Odoo is not set up in Insight yet.');
  const [{ vendors, products }, users] = await Promise.all([poChoices(s), odooUsers(s).catch(() => [])]);
  return { vendors, products, users: users.map((u) => ({ id: u.id, name: u.name })) };
}

export async function saveSettings(env, body) {
  const ref = (v, what) => {
    if (v == null || v === '') return '';
    const id = Number(v.id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest(`Choose ${what} from Odoo's list.`);
    return JSON.stringify({ id, name: str(v.name, what, { max: 200 }) || `#${id}` });
  };
  const values = {
    receipts_address: body?.address === undefined ? undefined : (str(body.address, 'The address', { max: 200 }) || ''),
    receipts_senders: body?.senders === undefined ? undefined : senderList(Array.isArray(body.senders) ? body.senders.join(' ') : body.senders).join('\n'),
    receipts_vendor: body?.vendor === undefined ? undefined : ref(body.vendor, 'the placeholder vendor'),
    receipts_product: body?.product === undefined ? undefined : ref(body.product, 'the placeholder item'),
    receipts_todo_user: body?.todoUser === undefined ? undefined : ref(body.todoUser, 'who checks them'),
  };
  for (const key of KEYS) if (values[key] !== undefined) await setSetting(env.DB, key, values[key]); // eslint-disable-line no-await-in-loop
  return receiptSettings(env);
}

// ------------------------------------------------------------- the file --

async function keepFile(env, id, data) {
  for (let i = 0; i * PART < data.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, 'INSERT OR REPLACE INTO receipt_file (receipt_id, part, data) VALUES (?1, ?2, ?3)', id, i, data.slice(i * PART, (i + 1) * PART));
  }
}
const dropFile = (env, id) => run(env.DB, 'DELETE FROM receipt_file WHERE receipt_id = ?1', id);

/** A kept receipt, as a data URL: for Fill it in. */
export async function receiptFile(env, id) {
  const row = await first(env.DB, 'SELECT id, mime, name FROM receipt WHERE id = ?1', Number(id));
  if (!row) throw new HttpError(404, 'No such receipt.');
  const parts = await all(env.DB, 'SELECT data FROM receipt_file WHERE receipt_id = ?1 ORDER BY part', row.id);
  if (!parts.length) throw new HttpError(404, 'That receipt’s file is not kept here: it is attached to its PO in Odoo.');
  return { name: row.name, mime: row.mime, file: `data:${row.mime};base64,${parts.map((p) => p.data).join('')}` };
}

// --------------------------------------------------------------- reading --

/** What went wrong or needs a look, in a sentence, for the list, the note and the To-Do. */
function needsSaying({ vendorOk, itemOk, vendorText, description, unsure = null }) {
  const out = [];
  if (!vendorOk) out.push(vendorText ? `the vendor was read as “${vendorText}”, which is not in Odoo` : 'no vendor could be read');
  if (!itemOk) out.push(`the item “${description || 'bought'}” was not matched to one in Odoo`);
  else if (unsure) out.push(`the reader put “${description || 'what was bought'}” on “${unsure}”, but was not sure`);
  return out;
}

/**
 * One receipt in: read, matched, made into a draft PO, kept here with what
 * became of it. Returns the row as the list shows it.
 */
export async function addReceipt(env, { mime, data, name = '', thumb = null, came, byName, fromEmail = null, subject = null, hint = '' }, { fetchImpl } = {}) {
  const at = now();
  const today = todayIn('UTC');
  const hash = await sha256(data);
  const r = {
    hash, name: String(name || '').slice(0, 200) || null, mime, thumb, came, by_name: byName, from_email: fromEmail, subject, hint: String(hint || '').slice(0, 300) || null, at,
    status: 'unread', vendor_text: null, amount: null, day: null, description: null, vendor_name: null, product_name: null,
    vendor_ok: null, item_ok: null, item_by: null, problem: null, po_id: null, po_name: null, po_url: null, todo: 0, same_as: null,
  };
  let keep = true;
  const twin = await first(env.DB, "SELECT id, po_name, at FROM receipt WHERE hash = ?1 AND status NOT IN ('dismissed', 'duplicate') ORDER BY id LIMIT 1", hash);
  if (twin) {
    Object.assign(r, { status: 'duplicate', same_as: twin.id, po_name: twin.po_name, problem: `The same file came in on ${twin.at.slice(0, 16)}${twin.po_name ? ` and is ${twin.po_name}` : ''}. No second PO.` });
    keep = false;
  } else {
    await makePo(env, r, { data, today, fetchImpl }).catch((err) => { Object.assign(r, { status: 'failed', problem: String(err?.message || err).slice(0, 400) }); });
    keep = ['unread', 'failed'].includes(r.status) || r.attachFailed;
  }
  const row = await first(env.DB, `INSERT INTO receipt (hash, name, mime, thumb, came, by_name, from_email, subject, hint, at, status, vendor_text, amount, day, description,
      vendor_name, product_name, vendor_ok, item_ok, problem, po_id, po_name, po_url, todo, same_as, item_by)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26) RETURNING id`,
  r.hash, r.name, r.mime, r.thumb, r.came, r.by_name, r.from_email, r.subject, r.hint, r.at, r.status, r.vendor_text, r.amount, r.day, r.description,
  r.vendor_name, r.product_name, r.vendor_ok, r.item_ok, r.problem, r.po_id, r.po_name, r.po_url, r.todo, r.same_as, r.item_by);
  if (keep && data.length <= FILE_MAX) await keepFile(env, row.id, data);
  return shape({ ...r, id: row.id, has_file: keep && data.length <= FILE_MAX ? 1 : 0 });
}

/** Read it and make the PO, filling `r` in as it goes. */
async function makePo(env, r, { data, today, fetchImpl }) {
  if (/heic|heif/.test(r.mime)) { r.problem = 'An iPhone HEIC picture cannot be read: send it as a JPEG, or take a screenshot of it.'; return; }
  if (data.length > ATTACH_MAX) { r.problem = 'Too large to read: send a smaller photo, or a PDF under 7 MB.'; return; }
  if (!env.AI) { r.problem = 'The reader (Workers AI) is not available just now.'; return; }
  const got = await readReceipt(env, { mime: r.mime, data, name: r.name, hint: r.hint, today }).catch((err) => ({ read: null, said: String(err?.message || err) }));
  const read = got.read;
  if (read) Object.assign(r, { vendor_text: read.vendor || null, amount: read.amount, day: read.date, description: read.description || null });
  if (!read || read.amount == null) {
    r.problem = got.said || (read?.problem ? `Could not be read: ${read.problem}` : 'Could not be read: no total was found for certain.');
    return;
  }
  const s = await odooSource(env);
  if (!s) throw new Error('Odoo is not set up in Insight yet.');
  const opts = { ...s, ...(fetchImpl ? { fetchImpl } : {}) };
  const settings = await receiptSettings(env);
  const { vendors, products } = await poChoices(opts);
  const vendor = read.vendor ? closest(read.vendor, vendors) : null;
  // Words first; failing that, the reader picks the nearest product by meaning.
  const match = read.description ? await matchProduct(env, read.description, products, { vendor: read.vendor }) : null;
  const product = match?.product || null;
  r.vendor_ok = vendor ? 1 : 0;
  r.item_ok = product ? 1 : 0;
  r.item_by = match?.by || null;
  const useVendor = vendor || settings.vendor;
  const useProduct = product || settings.product;
  r.day = read.date || today;
  r.description = read.description || 'From a receipt';
  const missing = needsSaying({
    vendorOk: vendor, itemOk: product, vendorText: read.vendor, description: read.description,
    unsure: match?.by === 'reader' && !match.sure ? product.name : null,
  });
  if (!useVendor || !useProduct) {
    r.problem = `${missing.join(', and ')}, and no placeholder ${!useVendor ? 'vendor' : 'item'} is chosen in Money › Receipts › Settings. Choose it there, then Try again.`;
    r.problem = r.problem.charAt(0).toUpperCase() + r.problem.slice(1);
    return;
  }
  r.vendor_name = useVendor.name;
  r.product_name = useProduct.name;
  // Already in Odoo: the same vendor, the same day, within a cedi.
  if (vendor) {
    const same = (await posOnDay({ ...opts, vendorId: vendor.id, day: r.day }).catch(() => [])).find((p) => Math.abs(p.total - read.amount) <= 100);
    if (same) {
      Object.assign(r, { status: 'duplicate', po_id: same.id, po_name: same.name, problem: `${same.name} is already in Odoo for ${vendor.name}, ${ghs(same.total)}, that day. No second PO.` });
      return;
    }
  }
  const po = await createDraftPo({
    ...opts, vendorId: useVendor.id, productId: useProduct.id, amount: read.amount, day: r.day,
    // The line's label is what the receipt says was bought; with a stand-in
    // vendor, who sold it too, so the PO reads right before anybody opens it.
    description: vendor || !read.vendor ? r.description : `${r.description} (from ${read.vendor})`.slice(0, 200),
    origin: `Insight · receipt by ${r.came === 'email' ? 'email' : 'upload'} · ${r.by_name || 'Insight'}`,
  }).catch((err) => { throw new Error(`Odoo did not create the PO: ${String(err?.message || err)}`); });
  Object.assign(r, { po_id: po.id, po_name: po.name, po_url: po.url, status: missing.length ? 'check' : 'complete' });
  const ext = r.mime === 'application/pdf' ? 'pdf' : r.mime.split('/')[1].replace('jpeg', 'jpg');
  try {
    await attachToPo({ ...opts, poId: po.id, name: `Receipt ${po.name || po.id}.${ext}`, mimetype: r.mime, data });
  } catch (err) {
    r.attachFailed = true;
    r.problem = `The receipt could not be attached in Odoo (${String(err?.message || err).slice(0, 160)}); it is kept here.`;
  }
  // What was read, on the PO, for whoever opens it.
  const read_ = `Read off the receipt by Insight: vendor “${read.vendor || 'none written'}”, total ${ghs(read.amount)}, `
    + `date ${read.date || `none (today, ${today}, used)`}, “${read.description || 'nothing said'}”.`
    + (match?.by === 'reader' ? ` The item was picked by the reader as the nearest in Odoo: ${product.name}.` : '')
    + (missing.length ? ` To check: ${missing.join('; ')}.` : '') + (r.hint ? ` Sent with: “${r.hint}”.` : '');
  await noteOnPo({ ...opts, poId: po.id, text: read_ }).catch(() => null);
  if (missing.length) {
    if (!r.problem) r.problem = `To check: ${missing.join(', and ')}.`;
    if (settings.todoUser) {
      const made = await todoOnPo({
        ...opts, poId: po.id, userId: settings.todoUser.id, day: todayIn('UTC'),
        summary: 'Check this PO from a receipt', note: `<p>${esc(`${missing.join('; ')}. ${read_}`)}</p>`,
      }).then(() => true).catch(() => false);
      r.todo = made ? 1 : 0;
    }
  }
  // Made in Insight: not a shift's expense unless an admin allows it.
  await run(env.DB, `INSERT INTO po_created (odoo_id, name, vendor, product, description, amount, total, day, receipt, by_name, at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  po.id, po.name, useVendor.name, useProduct.name, r.description, read.amount, po.total, r.day, r.attachFailed ? 0 : 1, r.by_name || 'Insight', now()).catch(() => null);
}

function shape(r) {
  return {
    id: r.id, name: r.name, mime: r.mime, thumb: r.thumb || null, came: r.came, by: r.by_name, from: r.from_email, subject: r.subject, hint: r.hint, at: r.at,
    status: r.status, vendorText: r.vendor_text, amount: r.amount, day: r.day, description: r.description,
    vendorName: r.vendor_name, productName: r.product_name, vendorOk: r.vendor_ok == null ? null : Boolean(r.vendor_ok), itemOk: r.item_ok == null ? null : Boolean(r.item_ok), itemBy: r.item_by || null,
    problem: r.problem, po: r.po_name ? { id: r.po_id, name: r.po_name, url: r.po_url } : null, todo: Boolean(r.todo), sameAs: r.same_as,
    hasFile: Boolean(r.has_file), doneBy: r.done_by || null, doneAt: r.done_at || null,
  };
}

// ------------------------------------------------------------- the routes --

/** One receipt chosen in Insight: a photo (made smaller on the phone) or a PDF. */
export async function upload(env, body, account, { fetchImpl } = {}) {
  const file = String(body?.file || '');
  const m = file.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m || !TYPES.test(m[1])) throw badRequest('A photo or a PDF of the receipt.');
  if (m[2].length > FILE_MAX) throw badRequest('That file is too large: a photo, or a PDF under 7 MB.');
  const thumb = String(body?.thumb || '');
  const keepThumb = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(thumb) && thumb.length < 60_000 ? thumb : null;
  return { receipt: await addReceipt(env, { mime: m[1], data: m[2], name: body?.name, thumb: keepThumb, came: 'upload', byName: account?.name || account?.email || 'Owner', hint: str(body?.hint, 'Note', { max: 300 }) }, { fetchImpl }) };
}

/** Every receipt, newest first, the emails that came in, and the settings. */
export async function list(env) {
  const rows = await all(env.DB, `SELECT r.*, (SELECT COUNT(*) FROM receipt_file f WHERE f.receipt_id = r.id) AS has_file
    FROM receipt r ORDER BY r.id DESC LIMIT 200`).catch(() => []);
  const mails = await all(env.DB, 'SELECT * FROM receipt_mail ORDER BY id DESC LIMIT 15').catch(() => []);
  return { items: rows.map(shape), mails, settings: await receiptSettings(env) };
}

/**
 * Try again: a receipt with no PO (could not be read, no stand-in chosen,
 * Odoo refused), read and made again from the file kept here. Same row, so
 * it is still one receipt.
 */
export async function retry(env, body, account, { fetchImpl } = {}) {
  const row = await first(env.DB, 'SELECT * FROM receipt WHERE id = ?1', Number(body?.id));
  if (!row) throw new HttpError(404, 'No such receipt.');
  if (!['unread', 'failed'].includes(row.status)) throw badRequest('That one has a PO already.');
  const parts = await all(env.DB, 'SELECT data FROM receipt_file WHERE receipt_id = ?1 ORDER BY part', row.id);
  if (!parts.length) throw badRequest('Its file is not kept here any more: use Fill it in, or send it again.');
  const data = parts.map((p) => p.data).join('');
  const r = {
    ...row, status: 'unread', vendor_text: null, amount: null, day: null, description: null, vendor_name: null, product_name: null,
    vendor_ok: null, item_ok: null, item_by: null, problem: null, po_id: null, po_name: null, po_url: null, todo: 0, by_name: row.by_name || account?.name || 'Insight',
  };
  await makePo(env, r, { data, today: todayIn('UTC'), fetchImpl }).catch((err) => { Object.assign(r, { status: 'failed', problem: String(err?.message || err).slice(0, 400) }); });
  await run(env.DB, `UPDATE receipt SET status = ?2, vendor_text = ?3, amount = ?4, day = ?5, description = ?6, vendor_name = ?7, product_name = ?8,
      vendor_ok = ?9, item_ok = ?10, problem = ?11, po_id = ?12, po_name = ?13, po_url = ?14, todo = ?15, item_by = ?16 WHERE id = ?1`,
  row.id, r.status, r.vendor_text, r.amount, r.day, r.description, r.vendor_name, r.product_name, r.vendor_ok, r.item_ok, r.problem, r.po_id, r.po_name, r.po_url, r.todo, r.item_by);
  const kept = ['unread', 'failed'].includes(r.status) || r.attachFailed;
  if (!kept) await dropFile(env, row.id);
  return { receipt: shape({ ...r, id: row.id, has_file: kept ? 1 : 0 }) };
}

/** Not a receipt, or dealt with another way: off the list of ones to do. */
export async function dismiss(env, body, account) {
  const row = await first(env.DB, 'SELECT id, status FROM receipt WHERE id = ?1', Number(body?.id));
  if (!row) throw new HttpError(404, 'No such receipt.');
  if (!['unread', 'failed'].includes(row.status)) throw badRequest('Only one with no PO can be set aside.');
  await run(env.DB, "UPDATE receipt SET status = 'dismissed', done_by = ?2, done_at = ?3 WHERE id = ?1", row.id, account?.name || 'Owner', now());
  await dropFile(env, row.id);
  return { ok: true };
}

/** Filled in by hand with ＋ PO: the PO it became. Called once Create PO has made it. */
export async function filled(env, receiptId, po, account) {
  const row = await first(env.DB, 'SELECT id FROM receipt WHERE id = ?1', Number(receiptId));
  if (!row) return;
  await run(env.DB, `UPDATE receipt SET status = 'filled', po_id = ?2, po_name = ?3, po_url = ?4, vendor_name = ?5, amount = ?6, day = ?7,
    description = ?8, done_by = ?9, done_at = ?10, problem = NULL WHERE id = ?1`,
  row.id, po.id, po.name, po.url || null, po.vendor || null, po.amount ?? null, po.date || null, po.description || null, account?.name || 'Owner', now());
  await dropFile(env, row.id);
}

// ---------------------------------------------------------------- email --

/** The line written with the receipts, without what a forward or a signature adds. */
function hintOf(text) {
  const cut = String(text || '').split(/\n-{2,}\s*Forwarded|\nOn .+ wrote:|\n--\s*\n|\nSent from my /i)[0];
  return cut.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * An email to the receipts address, from Cloudflare Email Routing. Only from
 * the addresses listed; each photo or PDF in it becomes a receipt; the
 * sender gets a reply saying what became of each.
 */
export async function fromEmail(env, message, { fetchImpl } = {}) {
  const raw = message.raw instanceof ReadableStream || message.raw?.getReader ? await new Response(message.raw).arrayBuffer() : message.raw;
  const mail = readEmail(raw);
  const envelope = addressOf(message.from);
  const settings = await receiptSettings(env);
  const log = (outcome, said, from = mail.from || envelope) => run(env.DB, 'INSERT INTO receipt_mail (at, from_email, subject, outcome, said) VALUES (?1, ?2, ?3, ?4, ?5)',
    now(), from || null, mail.subject.slice(0, 200) || null, outcome, said).catch(() => null);
  const sender = [mail.from, envelope].find((a) => a && settings.senders.includes(a));
  if (!sender) { await log('ignored', 'Not on the list of who may send receipts.'); return { ok: false, why: 'sender' }; }
  // Somebody pretending to be on the list: the receiving server's own checks said no.
  const auth = mail.authentication.toLowerCase();
  if (/dmarc=fail/.test(auth) || (/spf=fail/.test(auth) && !/dkim=pass/.test(auth))) {
    await log('ignored', 'The sender checks failed (SPF, DKIM or DMARC): it may not be from that address.', sender);
    return { ok: false, why: 'checks' };
  }
  const account = await first(env.DB, 'SELECT name FROM accounts WHERE LOWER(email) = ?1 AND active = 1', sender).catch(() => null);
  const byName = account?.name || mail.fromName || sender;
  const files = mail.files.filter((f) => TYPES.test(f.type) && !(f.inline && f.size < 15_000) && f.size > 0);
  const hint = hintOf(mail.text) || (/^(fwd?|re):?\s*$/i.test(mail.subject) ? '' : mail.subject.replace(/^(fwd?|re):\s*/i, ''));
  const results = [];
  for (const f of files.slice(0, 10)) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await addReceipt(env, { mime: f.type, data: f.data, name: f.name, came: 'email', byName, fromEmail: sender, subject: mail.subject.slice(0, 200), hint }, { fetchImpl })
      .catch((err) => ({ name: f.name, status: 'failed', problem: String(err?.message || err) })));
  }
  const skipped = files.length > 10 ? files.length - 10 : 0;
  await log('read', files.length ? `${results.length} receipt${results.length === 1 ? '' : 's'} read${skipped ? `, ${skipped} left out (ten at most in one email)` : ''}.` : 'No photo or PDF in it.', sender);
  await reply(env, { to: sender, subject: mail.subject, results, skipped, settings }, { fetchImpl });
  return { ok: true, results };
}

/** One line per receipt, as the reply says it. */
export function resultLine(x) {
  const what = [x.vendorOk === false ? `“${x.vendorText || 'no vendor'}”` : x.vendorName, x.amount != null ? ghs(x.amount) : null, x.day].filter(Boolean).join(' · ');
  if (x.status === 'complete') return `✓ ${x.po.name} · ${what}`;
  if (x.status === 'check') return `⚠ ${x.po.name} · ${what} · ${x.problem}`;
  if (x.status === 'duplicate') return `= ${x.name || 'A receipt'}: ${x.problem}`;
  const why = String(x.problem || 'It could not be read').replace(/\.?\s*$/, '.');
  return `✕ ${x.name || 'A receipt'}: no PO. ${why} It is kept in Insight › Money › Receipts.`;
}

async function reply(env, { to, subject, results, skipped, settings }, { fetchImpl } = {}) {
  const lines = results.length ? results.map(resultLine) : ['No photo or PDF was attached, so nothing was made. Attach the receipts (photos or PDFs) and send again.'];
  if (skipped) lines.push(`${skipped} more were left out: ten at most in one email.`);
  const made = results.filter((x) => x.po && ['complete', 'check'].includes(x.status)).length;
  const foot = made ? `All are drafts in Odoo with the receipt attached${settings.todoUser && results.some((x) => x.todo) ? `; ${settings.todoUser.name} has a To-Do on each one to check` : ''}.` : '';
  const head = `${results.length} receipt${results.length === 1 ? '' : 's'} read:`;
  try {
    await callLink({
      binding: env.HIVE, secret: env.SSO_SECRET_ATTENDANCE, fetchImpl, path: '/api/link/mail',
      body: {
        to, kind: 'insight_receipts', senderName: 'Insight',
        subject: `Re: ${subject || 'receipts'}`.slice(0, 200),
        text: [results.length ? head : '', ...lines, '', foot].filter((l, i) => l || i > 0).join('\n'),
        html: `${results.length ? `<p>${esc(head)}</p>` : ''}<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>${foot ? `<p>${esc(foot)}</p>` : ''}`,
      },
    });
    return true;
  } catch (err) { console.error('Receipts: the reply', err); return false; }
}
