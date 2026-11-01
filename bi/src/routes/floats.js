import { all, first, run } from '../lib/db.js';
import { badRequest, csvResponse, HttpError, str } from '../lib/http.js';
import { todayIn } from '../lib/dates.js';
import { pdf, wrap, widthOf, A4 } from '../lib/pdf.js';
import { purchaseOrders, cancelDraftPo } from '../connectors/odoo.js';
import { odooSource } from './safebook.js';
import { addReceipt, markFor, makeInOdoo, keptData, readAgain, typedIn } from './receipts.js';
import { pos } from './approvals.js';

/**
 * Floats: money given to people to spend.
 *
 * An admin gives somebody money (from the safe, the bank, a drawer). They
 * send a picture of each receipt from their own link; each is read and made
 * into a draft PO in Odoo carrying their reference (FLT/KOFI/005) as Vendor
 * Reference and Source Document, and comes off what they hold at once, as
 * "being checked". Confirmed in Odoo, it is accepted; refused (here, or
 * cancelled in Odoo), it goes back on what they hold. What they give back
 * comes off too. A statement of any period downloads as a spreadsheet or a
 * page to print.
 *
 * Where a receipt goes. Some people buy for the bistro, the bar or the craft
 * shop, whose stock lives in the POS. An admin ticks where each person's
 * receipts may go (Odoo, and any of the three): one tick, they always go
 * there; several, the person says for each receipt; none, they wait here for
 * somebody to choose. One for the POS is read and made into a draft purchase
 * order there for that side, not in Odoo; received in the POS, it is
 * accepted, and cancelled there, refused. While it is still a draft, either
 * way, an admin can send it to the other instead.
 */

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const ghs = (minor) => `${Number(minor) < 0 ? '−' : ''}GH₵${(Math.abs(Number(minor || 0)) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const who = (account) => account?.name || account?.email || 'Owner';
const DAY = /^\d{4}-\d\d-\d\d$/;
const SOURCES = { safe: 'The safe', bank: 'The bank (MoMo or transfer)', drawer: 'A shift’s drawer', other: 'Somewhere else' };
const TYPES = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;
const FILE_MAX = 14_000_000;
const QUIET_DAYS = 14;
/** A PO changed in Odoo within this many days of the receipt being sent asks the person too; after, only an admin. */
const ASK_HOLDER_DAYS = 30;
const CONFIRMED = new Set(['purchase', 'done']);

/** Where a float's receipts may go: Odoo, or one side of the POS (its own module names). */
export const DESTS = { odoo: 'The hotel (Odoo)', kitchen: 'Bistro', bar: 'Bar', craft: 'Craft' };
const POS_SIDES = new Set(['kitchen', 'bar', 'craft']);
/** A receipt file sent to the POS with its order: under about 4 MB. */
const POS_FILE_MAX = 5_500_000;
/** Received in the POS (all, or some): accepted. Cancelled or refused there: refused. */
const POS_DONE = new Set(['received', 'part']);
const POS_GONE = new Set(['cancelled', 'refused']);

/** Where this person's receipts may go. Never set: Odoo only. An empty list: nowhere, they wait. */
export function destsOf(p) {
  if (p?.dests == null) return ['odoo'];
  try {
    const list = JSON.parse(p.dests);
    return Array.isArray(list) ? Object.keys(DESTS).filter((k) => list.includes(k)) : ['odoo'];
  } catch { return ['odoo']; }
}
const destWords = (d) => (d === 'wait' ? 'Waiting: where it goes' : POS_SIDES.has(d) ? `POS · ${DESTS[d]}` : 'Odoo');

const newToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const same = (a, b) => {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i += 1) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return d === 0;
};
const money = (v, what) => {
  const n = Math.round(Number(String(v ?? '').replace(/[^\d.]/g, '')) * 100);
  if (!Number.isFinite(n) || n <= 0) throw badRequest(`${what}: an amount above nothing.`);
  return n;
};
const codeFrom = (name) => String(name || '').trim().split(/\s+/)[0].toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'FLOAT';
export const refOf = (code, seq) => `FLT/${code}/${String(seq).padStart(3, '0')}`;

// ------------------------------------------------------------ reading --

async function person(env, id) {
  const p = await first(env.DB, 'SELECT * FROM float_person WHERE id = ?1', Number(id));
  if (!p) throw new HttpError(404, 'No such person.');
  return p;
}

// ------------------------------------------------------------ short links --
// Their link is /float/<slug>: the first four letters of their name (igna for
// Ignacio), with a number when that is taken, unless an admin changes it.

const SLUG = /^[a-z0-9-]{2,30}$/;

/** The first four letters of a name, as plain letters: igna. */
export function slugFrom(name, code = '') {
  const letters = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  return (letters.length >= 2 ? letters : String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'float').slice(0, 4);
}

/** A slug nobody else has: igna, then igna2, igna3… */
async function freeSlug(env, base, exceptId = -1) {
  for (let n = 1; n < 100; n += 1) {
    const slug = n === 1 ? base : `${base}${n}`;
    // eslint-disable-next-line no-await-in-loop
    if (!(await first(env.DB, 'SELECT id FROM float_person WHERE slug = ?1 AND id <> ?2', slug, exceptId))) return slug;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Give a slug to anybody who has none yet (people added before short links). */
async function withSlug(env, p) {
  if (p.slug) return p;
  const slug = await freeSlug(env, slugFrom(p.name, p.code), p.id);
  await run(env.DB, 'UPDATE float_person SET slug = ?2 WHERE id = ?1', p.id, slug);
  return { ...p, slug };
}

/** Their receipts, each with what was read and its PO. */
async function receiptsOf(env, personIds) {
  if (!personIds.length) return [];
  return all(env.DB, `SELECT f.*, r.amount, r.day, r.vendor_name, r.vendor_text, r.description, r.status AS read_status, r.problem,
      r.po_id, r.po_name, r.po_url, r.thumb, r.hint
    FROM float_receipt f JOIN receipt r ON r.id = f.receipt_id
    WHERE f.person_id IN (${personIds.map((_, i) => `?${i + 1}`).join(', ')}) ORDER BY f.id DESC`, ...personIds);
}

/**
 * Receipts still being checked whose PO Odoo has confirmed (accepted) or
 * cancelled (refused). Never throws: Odoo not answering leaves them as they are.
 */
async function settleFromOdoo(env, rows, { fetchImpl } = {}) {
  // Being checked: accepted or refused by its PO. Any not refused: its PO's total, if changed in Odoo.
  const waiting = rows.filter((r) => r.status !== 'refused' && r.po_name);
  if (!waiting.length) return;
  try {
    const s = await odooSource(env);
    if (!s) return;
    const { orders } = await purchaseOrders({ ...s, names: waiting.map((r) => r.po_name), ...(fetchImpl ? { fetchImpl } : {}) });
    const state = new Map(orders.map((o) => [o.name.toUpperCase(), o.state]));
    const totals = new Map(orders.map((o) => [o.name.toUpperCase(), o.total]));
    for (const r of waiting) {
      // The PO's total changed in Odoo: kept, and the person and an admin asked. Changed back: nothing to ask.
      const total = totals.get(String(r.po_name).toUpperCase());
      const changed = total != null && r.amount != null && total !== Number(r.amount) ? total : null;
      if (total != null && changed !== (r.po_total ?? null)) {
        const seen = changed == null ? null : now();
        Object.assign(r, { po_total: changed, po_changed_at: seen, holder_answer: null, holder_at: null, holder_note: null, admin_answer: null, admin_by: null, admin_at: null });
        // eslint-disable-next-line no-await-in-loop
        await run(env.DB, 'UPDATE float_receipt SET po_total = ?2, po_changed_at = ?3, holder_answer = NULL, holder_at = NULL, holder_note = NULL, admin_answer = NULL, admin_by = NULL, admin_at = NULL WHERE id = ?1', r.id, changed, seen);
      }
      if (r.status !== 'checking') continue;
      const st = state.get(String(r.po_name).toUpperCase());
      if (CONFIRMED.has(st)) Object.assign(r, { status: 'accepted', decided_by: 'Odoo', decided_at: now() });
      else if (st === 'cancel') Object.assign(r, { status: 'refused', reason: `${r.po_name} was cancelled in Odoo.`, decided_by: 'Odoo', decided_at: now() });
      else continue;
      // eslint-disable-next-line no-await-in-loop
      await run(env.DB, 'UPDATE float_receipt SET status = ?2, reason = ?3, decided_by = ?4, decided_at = ?5 WHERE id = ?1', r.id, r.status, r.reason || null, r.decided_by, r.decided_at);
    }
  } catch (err) { console.error('Floats: Odoo', err); }
}

/**
 * Receipts made into orders in the POS: where each stands there. Received
 * (all or some) is accepted; cancelled or refused there is refused. Never
 * throws: the POS not answering leaves them as they are.
 */
async function settleFromPos(env, rows, { fetchImpl } = {}) {
  const there = rows.filter((r) => r.pos_id && r.status !== 'refused');
  if (!there.length) return;
  try {
    const out = await pos(env, '/floats/po/status', { ids: there.map((r) => r.pos_id).slice(0, 100) }, fetchImpl ? { fetchImpl } : {});
    const byId = new Map((out.orders || []).map((o) => [String(o.id), o]));
    for (const r of there) {
      const o = byId.get(String(r.pos_id));
      if (!o) continue;
      const changes = {};
      if (o.status && o.status !== r.pos_status) changes.pos_status = o.status;
      if (o.poNo && o.poNo !== r.pos_no) changes.pos_no = o.poNo;
      if (r.status === 'checking' && POS_DONE.has(o.status)) Object.assign(changes, { status: 'accepted', decided_by: 'POS', decided_at: now() });
      else if (r.status === 'checking' && POS_GONE.has(o.status)) {
        Object.assign(changes, { status: 'refused', reason: `${o.poNo || r.pos_no || 'Its order'} was ${o.status} in the POS.`, decided_by: 'POS', decided_at: now() });
      }
      if (!Object.keys(changes).length) continue;
      Object.assign(r, changes);
      const keys = Object.keys(changes);
      // eslint-disable-next-line no-await-in-loop
      await run(env.DB, `UPDATE float_receipt SET ${keys.map((k, i) => `${k} = ?${i + 2}`).join(', ')} WHERE id = ?1`, r.id, ...keys.map((k) => changes[k]));
    }
  } catch (err) { console.error('Floats: the POS', err); }
}

const settle = async (env, rows, opts) => { await settleFromOdoo(env, rows, opts); await settleFromPos(env, rows, opts); };

/**
 * The amount a receipt counts for: the receipt's own, or its PO's new total
 * in Odoo once accepted (by an admin, or by the person when no admin has
 * said otherwise).
 */
const amountOf = (r) => (r.po_total != null && (r.admin_answer === 'accept' || (!r.admin_answer && asksHolder(r) && r.holder_answer === 'accept')) ? r.po_total : r.amount);
/** Changed within 30 days of the receipt being sent: the person is asked too. */
function asksHolder(r) {
  const sent = Date.parse(`${String(r.at || '').replace(' ', 'T').slice(0, 19)}Z`);
  const seen = r.po_changed_at ? Date.parse(`${String(r.po_changed_at).replace(' ', 'T').slice(0, 19)}Z`) : Date.now();
  return Number.isFinite(sent) && seen - sent <= ASK_HOLDER_DAYS * 86_400_000;
}
/** What a receipt counts for: its amount unless refused (none read yet counts nothing). */
const spentBy = (r) => (r.status === 'refused' ? 0 : Number(amountOf(r)) || 0);
/** A PO changed in Odoo to another total, and what was said to it. */
const changeOf = (r) => (r.po_total != null && r.status !== 'refused' ? {
  was: r.amount, now: r.po_total, counts: amountOf(r), asksHolder: asksHolder(r),
  holder: r.holder_answer || null, holderNote: r.holder_note || null, admin: r.admin_answer || null, adminBy: r.admin_by || null,
} : null);

function totals(moves, receipts) {
  const given = moves.filter((m) => m.kind === 'given').reduce((t, m) => t + m.amount, 0);
  const back = moves.filter((m) => m.kind === 'back').reduce((t, m) => t + m.amount, 0);
  const spent = receipts.reduce((t, r) => t + spentBy(r), 0);
  return { given, back, spent, held: given - back - spent, receipts: receipts.filter((r) => r.status !== 'refused').length };
}

/** Where a receipt went: Odoo for one from before anybody chose. */
const destOf = (r) => r.dest || 'odoo';
/** Made somewhere: a PO in Odoo, or an order in the POS. */
const placed = (r) => Boolean(destOf(r) === 'odoo' ? r.po_name : r.pos_id);

/**
 * Something to look at: not read, read with something to check, no PO, or
 * waiting to be placed. Something to check on its PO (an item not matched)
 * is looked at once an admin has answered the PO's new total: somebody
 * changed that PO in Odoo, and an admin has seen it.
 */
const toLookAt = (r) => Boolean((r.status === 'checking' && (destOf(r) === 'wait' || !placed(r) || ['unread', 'failed'].includes(r.read_status)
  || (r.read_status === 'check' && !(changeOf(r) && r.admin_answer))))
  || (changeOf(r) && !r.admin_answer));

/**
 * Where an admin can send it now, instead: the places this person's receipts
 * may go (any, when none is ticked), while it is not decided and its PO or
 * order is still a draft.
 */
function movesOf(r, allowed) {
  if (r.status !== 'checking') return [];
  const d = destOf(r);
  if (POS_SIDES.has(d) && r.pos_id && r.pos_status && r.pos_status !== 'draft') return [];
  const may = allowed.length ? allowed : Object.keys(DESTS);
  return may.filter((k) => k !== d || !placed(r));
}

function receiptView(r, allowed = ['odoo']) {
  const d = destOf(r);
  return {
    id: r.id, receiptId: r.receipt_id, ref: r.ref, at: r.at, day: r.day || r.at.slice(0, 10), amount: amountOf(r) ?? null, change: changeOf(r),
    vendor: r.vendor_name || r.vendor_text || null, description: r.description || null, hint: r.hint || null,
    status: r.status, reason: r.reason || null, decidedBy: r.decided_by || null,
    read: r.read_status, problem: r.problem || null, thumb: r.thumb || null,
    po: d === 'odoo' && r.po_name ? { id: r.po_id, name: r.po_name, url: r.po_url } : null, toLookAt: toLookAt(r),
    dest: d, where: destWords(d),
    pos: r.pos_id ? { id: r.pos_id, no: r.pos_no || null, status: r.pos_status || null, url: r.pos_url || null } : null,
    posProblem: r.pos_problem || null,
    moves: movesOf(r, allowed).map((k) => ({ key: k, label: DESTS[k] })),
  };
}

/** Everybody with a float, and the totals across them. */
export async function list(env, { fetchImpl } = {}) {
  const people = await all(env.DB, 'SELECT * FROM float_person ORDER BY active DESC, name');
  const moves = await all(env.DB, 'SELECT * FROM float_move ORDER BY day, id');
  const receipts = await receiptsOf(env, people.map((p) => p.id));
  await settle(env, receipts, { fetchImpl });
  const month = todayIn('UTC').slice(0, 7);
  const quietBefore = new Date(Date.now() - QUIET_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = people.map((p) => {
    const mine = receipts.filter((r) => r.person_id === p.id);
    const myMoves = moves.filter((m) => m.person_id === p.id);
    const t = totals(myMoves, mine);
    const last = [...mine.map((r) => r.at.slice(0, 10)), ...myMoves.filter((m) => m.kind === 'given').map((m) => m.day)].sort().at(-1) || null;
    const lastReceipt = mine[0]?.at?.slice(0, 10) || null;
    return {
      id: p.id, name: p.name, code: p.code, note: p.note, active: Boolean(p.active), ...t, lastReceipt, dests: destsOf(p),
      toLookAt: mine.filter(toLookAt).length,
      quiet: t.held > 0 && last && last < quietBefore ? Math.floor((Date.now() - Date.parse(`${last}T12:00:00Z`)) / 86_400_000) : 0,
    };
  });
  return {
    people: rows,
    tiles: {
      held: rows.reduce((t, r) => t + Math.max(0, r.held), 0),
      spentThisMonth: receipts.filter((r) => String(r.day || r.at).startsWith(month)).reduce((t, r) => t + spentBy(r), 0),
      toLookAt: rows.reduce((t, r) => t + r.toLookAt, 0),
      quiet: rows.filter((r) => r.quiet).length,
    },
    sources: SOURCES,
    places: DESTS,
  };
}

/** One person: what they were given and gave back, every receipt and its PO, newest first. */
export async function detail(env, id, { fetchImpl } = {}) {
  const p = await withSlug(env, await person(env, id));
  const moves = await all(env.DB, 'SELECT * FROM float_move WHERE person_id = ?1 ORDER BY day DESC, id DESC', p.id);
  const receipts = await receiptsOf(env, [p.id]);
  await settle(env, receipts, { fetchImpl });
  const allowed = destsOf(p);
  return {
    person: { id: p.id, name: p.name, code: p.code, note: p.note, active: Boolean(p.active), token: p.token, slug: p.slug, dests: allowed },
    ...totals(moves, receipts),
    moves: moves.map((m) => ({ id: m.id, kind: m.kind, amount: m.amount, day: m.day, source: m.source, sourceText: SOURCES[m.source] || null, note: m.note, noteBy: m.note_by || null, noteAt: m.note_at || null, by: m.by_name })),
    receipts: receipts.map((r) => receiptView(r, allowed)),
    sources: SOURCES,
    places: DESTS,
  };
}

// ------------------------------------------------------------ changing --

/** Give money: to somebody already here, or to somebody new (who gets a reference and a link). */
export async function give(env, body, account) {
  const amount = money(body?.amount, 'How much');
  const day = DAY.test(String(body?.day || '')) ? body.day : todayIn('UTC');
  const source = SOURCES[body?.source] ? body.source : 'other';
  const note = str(body?.note, 'What it is for', { max: 200 });
  // A note on this money: shown on their page and statement. Somebody new's
  // "what it is for" is the note when none is given for the money itself.
  const moveNote = str(body?.moveNote, 'Note', { max: 300 });
  let p;
  if (body?.personId) {
    p = await person(env, body.personId);
    if (!p.active) await run(env.DB, 'UPDATE float_person SET active = 1 WHERE id = ?1', p.id);
  } else {
    const name = str(body?.name, 'Who', { required: true, max: 80 });
    const code = String(body?.code || codeFrom(name)).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    if (!code) throw badRequest('Their reference: letters or numbers, like KOFI.');
    if (await first(env.DB, 'SELECT id FROM float_person WHERE code = ?1', code)) throw badRequest(`FLT/${code} is somebody else’s already: choose another reference.`);
    p = await first(env.DB, `INSERT INTO float_person (name, code, note, token, slug, created_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING *`,
      name, code, note, newToken(), await freeSlug(env, slugFrom(name, code)), now(), who(account));
  }
  const said = moveNote || (body?.personId ? null : note);
  await run(env.DB, `INSERT INTO float_move (person_id, kind, amount, day, source, note, by_name, at, note_by, note_at) VALUES (?1, 'given', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    p.id, amount, day, source, said, who(account), now(), said ? who(account) : null, said ? now() : null);
  return { ok: true, personId: p.id, token: p.token, slug: p.slug || null };
}

/** Money given back: off what they hold. */
export async function giveBack(env, body, account) {
  const p = await person(env, body?.personId);
  const amount = money(body?.amount, 'How much');
  const day = DAY.test(String(body?.day || '')) ? body.day : todayIn('UTC');
  await run(env.DB, `INSERT INTO float_move (person_id, kind, amount, day, source, note, by_name, at) VALUES (?1, 'back', ?2, ?3, ?4, ?5, ?6, ?7)`,
    p.id, amount, day, SOURCES[body?.source] ? body.source : 'safe', str(body?.note, 'Note', { max: 200 }), who(account), now());
  return { ok: true };
}

/** A note on money given or given back, added or changed by an admin; empty takes it off. */
export async function noteMove(env, body, account) {
  const m = await first(env.DB, 'SELECT id FROM float_move WHERE id = ?1', Number(body?.id));
  if (!m) throw new HttpError(404, 'No such entry.');
  const note = str(body?.note, 'Note', { max: 300 }) || null;
  await run(env.DB, 'UPDATE float_move SET note = ?2, note_by = ?3, note_at = ?4 WHERE id = ?1', m.id, note, note ? who(account) : null, note ? now() : null);
  return { ok: true, note };
}

/** Take back a mistake: money given or given back, typed wrong. */
export async function undoMove(env, body) {
  const m = await first(env.DB, 'SELECT id FROM float_move WHERE id = ?1', Number(body?.id));
  if (!m) throw new HttpError(404, 'No such entry.');
  await run(env.DB, 'DELETE FROM float_move WHERE id = ?1', m.id);
  return { ok: true };
}

/** A receipt refused: it does not count against them, and why is said to them. Or taken back. */
export async function decide(env, body, account) {
  const r = await first(env.DB, 'SELECT * FROM float_receipt WHERE id = ?1', Number(body?.id));
  if (!r) throw new HttpError(404, 'No such receipt.');
  if (body?.refuse) {
    const reason = str(body?.reason, 'Why', { required: true, max: 300 });
    await run(env.DB, "UPDATE float_receipt SET status = 'refused', reason = ?2, decided_by = ?3, decided_at = ?4 WHERE id = ?1", r.id, reason, who(account), now());
  } else {
    await run(env.DB, "UPDATE float_receipt SET status = 'checking', reason = NULL, decided_by = NULL, decided_at = NULL WHERE id = ?1", r.id);
  }
  return { ok: true };
}

/**
 * Their link: switched off (no more receipts) or on again, or changed. A
 * change takes the ending an admin typed (or a new one from their name) and
 * a new long link, so every link they had before stops working.
 */
export async function setLink(env, body) {
  const p = await person(env, body?.personId);
  if (body?.active === false) { await run(env.DB, 'UPDATE float_person SET active = 0 WHERE id = ?1', p.id); return { ok: true }; }
  if (body?.active === true) { await run(env.DB, 'UPDATE float_person SET active = 1 WHERE id = ?1', p.id); return { ok: true }; }
  let slug;
  if (body?.slug != null && String(body.slug).trim()) {
    slug = String(body.slug).trim().toLowerCase().replace(/\s+/g, '-');
    if (!SLUG.test(slug)) throw badRequest('The link’s ending: 2 to 30 letters, numbers or dashes, like igna.');
    if (await first(env.DB, 'SELECT id FROM float_person WHERE slug = ?1 AND id <> ?2', slug, p.id)) throw badRequest(`/float/${slug} is somebody else’s already: choose another ending.`);
  } else {
    slug = await freeSlug(env, slugFrom(p.name, p.code), p.id);
  }
  const token = newToken();
  await run(env.DB, 'UPDATE float_person SET token = ?2, slug = ?3 WHERE id = ?1', p.id, token, slug);
  return { ok: true, token, slug };
}

/**
 * One receipt, for one person: given its next reference, read, and made into
 * a draft PO carrying it. From their link, or added by an admin for them.
 */
async function addFor(env, p, body, byName, { fetchImpl, admin = false } = {}) {
  const file = String(body?.file || '');
  const m = file.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m || !TYPES.test(m[1])) throw badRequest('A photo or a PDF of the receipt.');
  if (m[2].length > FILE_MAX) throw badRequest('That file is too large: a photo, or a PDF under 7 MB.');
  const dest = destFor(p, body?.dest, { admin });
  const thumb = String(body?.thumb || '');
  // The next number is taken before reading, so two sent at once never share one.
  const taken = await first(env.DB, 'UPDATE float_person SET next_seq = next_seq + 1 WHERE id = ?1 RETURNING next_seq - 1 AS seq', p.id);
  const ref = refOf(p.code, taken.seq);
  const given = await first(env.DB, "SELECT day, amount FROM float_move WHERE person_id = ?1 AND kind = 'given' ORDER BY day DESC, id DESC LIMIT 1", p.id);
  const receipt = await addReceipt(env, {
    mime: m[1], data: m[2], name: body?.name, came: 'float', byName,
    thumb: /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(thumb) && thumb.length < 60_000 ? thumb : null,
    hint: str(body?.hint, 'What it was for', { max: 300 }),
    // Only read, with no PO in Odoo, when it goes to the POS or waits.
  }, { fetchImpl, mark: markFor({ ref, name: p.name, given }), readOnly: dest !== 'odoo' });
  // The same picture sent twice is one receipt: the second is not counted.
  if (receipt.status === 'duplicate' && receipt.sameAs && await first(env.DB, 'SELECT id FROM float_receipt WHERE receipt_id = ?1', receipt.sameAs)) {
    return { duplicate: true, receipt };
  }
  const row = await first(env.DB, 'INSERT INTO float_receipt (person_id, receipt_id, seq, ref, at, dest, lines) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING *',
    p.id, receipt.id, taken.seq, ref, now(), dest, receipt.lines?.length ? JSON.stringify(receipt.lines) : null);
  const placedIn = POS_SIDES.has(dest) ? await toPos(env, row, dest, { fetchImpl, by: byName }) : null;
  return { ref, receipt, dest, pos: placedIn };
}

/**
 * Where a new receipt goes: what the person chose, when it is one of their
 * places; their one place, when they have one; waiting, when they have none.
 * An admin adding one for somebody with nothing ticked may choose anywhere.
 */
export function destFor(p, asked, { admin = false } = {}) {
  const allowed = destsOf(p);
  const may = allowed.length ? allowed : admin ? Object.keys(DESTS) : [];
  if (asked && asked !== 'wait') {
    if (!may.includes(asked)) throw badRequest(may.length ? `That receipt can go to ${may.map((k) => DESTS[k]).join(' or ')}.` : 'The office says where these receipts go: send it without choosing.');
    return asked;
  }
  if (may.length === 1) return may[0];
  if (!may.length || (admin && !allowed.length)) return 'wait';
  throw badRequest(`Say what it was for: ${may.map((k) => DESTS[k]).join(', ')}.`);
}

/**
 * One receipt made into a draft purchase order in the POS, for one side.
 * What was read goes with it (who sold it, the total, the day, each thing
 * bought, the picture). The POS not taking it is said on the receipt, to try
 * again; it is not lost.
 */
async function toPos(env, fr, side, { fetchImpl, by } = {}) {
  const r = await first(env.DB, 'SELECT * FROM receipt WHERE id = ?1', fr.receipt_id);
  const p = await person(env, fr.person_id);
  const say = async (problem) => {
    await run(env.DB, 'UPDATE float_receipt SET dest = ?2, pos_problem = ?3 WHERE id = ?1', fr.id, side, problem);
    return { problem };
  };
  if (!r || r.amount == null) return say('It could not be read: try reading it again, or type in what it says.');
  let lines = [];
  try { lines = JSON.parse(fr.lines || '[]'); } catch { lines = []; }
  if (!Array.isArray(lines) || !lines.length) lines = [{ name: r.description || 'From a receipt', qty: 1, amount: r.amount }];
  const data = await keptData(env, r.id).catch(() => null);
  try {
    const out = await pos(env, '/floats/po', {
      key: `insight-float:${fr.id}`, module: side, ref: fr.ref, holder: p.name,
      supplier: r.vendor_name || r.vendor_text || '', day: r.day || String(fr.at).slice(0, 10), total: r.amount,
      description: r.description || '', lines, hint: r.hint || '', by: by || 'Insight',
      ...(data && data.length <= POS_FILE_MAX ? { receipt: { mime: r.mime, data } } : {}),
    }, fetchImpl ? { fetchImpl } : {});
    await run(env.DB, 'UPDATE float_receipt SET dest = ?2, pos_id = ?3, pos_no = ?4, pos_status = ?5, pos_url = ?6, pos_problem = NULL WHERE id = ?1',
      fr.id, side, String(out.id), out.poNo || null, out.status || 'draft', out.url || null);
    return { id: String(out.id), no: out.poNo || null, status: out.status || 'draft', url: out.url || null };
  } catch (err) {
    return say(`The POS did not take it: ${String(err?.message || err).slice(0, 300)}`);
  }
}

export async function adminAdd(env, body, account, { fetchImpl } = {}) {
  const p = await person(env, body?.personId);
  return addFor(env, p, body, `${who(account)} for ${p.name}`, { fetchImpl, admin: true });
}

/** Where each person's receipts may go, as an admin ticked them: [{ id, dests: [odoo, kitchen, bar, craft] }]. */
export async function saveDests(env, body) {
  const people = Array.isArray(body?.people) ? body.people : [];
  if (!people.length) throw badRequest('Whose places?');
  let changed = 0;
  for (const x of people.slice(0, 200)) {
    // eslint-disable-next-line no-await-in-loop
    const p = await person(env, x?.id);
    const list = Array.isArray(x?.dests) ? Object.keys(DESTS).filter((k) => x.dests.includes(k)) : null;
    if (!list) throw badRequest(`${p.name}: tick where their receipts may go, or none.`);
    if (JSON.stringify(destsOf(p)) === JSON.stringify(list)) continue;
    // eslint-disable-next-line no-await-in-loop
    await run(env.DB, 'UPDATE float_person SET dests = ?2 WHERE id = ?1', p.id, JSON.stringify(list));
    changed += 1;
  }
  return { ok: true, changed };
}

/**
 * Send a receipt somewhere else, or place one that is waiting: out of where
 * it is (its draft PO cancelled in Odoo, or its draft order cancelled in the
 * POS), then made where it now goes. With `typed`, what a receipt that could
 * not be read says, typed in; with `again`, read again first.
 */
export async function moveReceipt(env, body, account, { fetchImpl } = {}) {
  const fr = await first(env.DB, `SELECT f.*, r.status AS read_status, r.po_id, r.po_name, r.amount FROM float_receipt f JOIN receipt r ON r.id = f.receipt_id WHERE f.id = ?1`, Number(body?.id));
  if (!fr) throw new HttpError(404, 'No such receipt.');
  const p = await person(env, fr.person_id);
  const to = String(body?.dest || destOf(fr));
  // Waiting, and only read again (or typed in): it stays waiting.
  const stay = to === 'wait' && destOf(fr) === 'wait' && (body?.again || body?.typed);
  if (!DESTS[to] && !stay) throw badRequest('Where to: Odoo, the bistro, the bar or craft.');
  if (fr.status === 'refused') throw badRequest(`${fr.ref} is refused: take the refusal off first.`);
  if (fr.status === 'accepted') throw badRequest(`${fr.ref} is already accepted where it went.`);
  const allowed = destsOf(p);
  const from = destOf(fr);
  if (to === from && placed(fr)) throw badRequest(`${fr.ref} is already there.`);
  if (!stay && !movesOf({ ...fr, status: 'checking' }, allowed).includes(to)) {
    throw badRequest(POS_SIDES.has(from) && fr.pos_status && fr.pos_status !== 'draft'
      ? `${fr.pos_no || 'Its order'} is no longer a draft in the POS: it stays there.`
      : `${p.name}’s receipts may go to ${(allowed.length ? allowed : Object.keys(DESTS)).map((k) => DESTS[k]).join(' or ')}: tick more in Where receipts go.`);
  }
  // What it says: typed in, or read again, before it goes anywhere.
  if (body?.typed) {
    const t = body.typed;
    const amount = money(t.amount, 'The total');
    const day = DAY.test(String(t.day || '')) ? t.day : null;
    await typedIn(env, fr.receipt_id, { vendor: str(t.vendor, 'Who sold it', { max: 120 }), amount, description: str(t.description, 'What was bought', { max: 200 }), day });
    await run(env.DB, 'UPDATE float_receipt SET lines = NULL WHERE id = ?1', fr.id);
    fr.lines = null;
  } else if (body?.again) {
    const read = await readAgain(env, fr.receipt_id);
    fr.lines = read.lines?.length ? JSON.stringify(read.lines) : null;
    await run(env.DB, 'UPDATE float_receipt SET lines = ?2 WHERE id = ?1', fr.id, fr.lines);
  }
  if (stay) {
    const r = await first(env.DB, 'SELECT amount, problem FROM receipt WHERE id = ?1', fr.receipt_id);
    return { ok: true, dest: 'wait', problem: r?.amount == null ? (r?.problem || 'It still could not be read: type in what it says.') : null };
  }
  // Out of where it is.
  if (fr.pos_id) {
    await pos(env, '/floats/po/cancel', { id: fr.pos_id, by: who(account), note: `Going to ${DESTS[to]} instead, from Insight.` }, fetchImpl ? { fetchImpl } : {});
    await run(env.DB, 'UPDATE float_receipt SET pos_id = NULL, pos_no = NULL, pos_status = NULL, pos_url = NULL, pos_problem = NULL WHERE id = ?1', fr.id);
  } else if (from === 'odoo' && fr.po_id) {
    const s = await odooSource(env);
    if (!s) throw new HttpError(409, 'Odoo is not set up in Insight yet.');
    await cancelDraftPo({ ...s, poId: fr.po_id, ...(fetchImpl ? { fetchImpl } : {}) });
    await run(env.DB, "UPDATE receipt SET status = 'read', po_id = NULL, po_name = NULL, po_url = NULL, problem = NULL WHERE id = ?1", fr.receipt_id);
  }
  // Into where it goes now.
  if (to === 'odoo') {
    const receipt = await makeInOdoo(env, fr.receipt_id, { fetchImpl });
    await run(env.DB, "UPDATE float_receipt SET dest = 'odoo', pos_problem = NULL WHERE id = ?1", fr.id);
    return { ok: true, dest: to, po: receipt.po, problem: receipt.po ? null : receipt.problem };
  }
  const placedIn = await toPos(env, { ...fr }, to, { fetchImpl, by: who(account) });
  return { ok: true, dest: to, pos: placedIn.problem ? null : placedIn, problem: placedIn.problem || null };
}

// ------------------------------------------------------------ their link --

/** Whose link this is: by its short ending (s) or its long key (t). */
async function byToken(env, t, s) {
  const slug = String(s || '').toLowerCase();
  if (slug) {
    const p = SLUG.test(slug) ? await first(env.DB, 'SELECT * FROM float_person WHERE slug = ?1', slug) : null;
    if (!p || !p.active) throw new HttpError(404, 'This link is no longer in use. Ask for the new one.');
    return p;
  }
  const token = String(t || '');
  const p = token ? await first(env.DB, 'SELECT * FROM float_person WHERE token = ?1', token) : null;
  if (!p || !same(token, p.token) || !p.active) throw new HttpError(404, 'This link is no longer in use. Ask for the new one.');
  return p;
}

/** Their page: what they hold, and what they sent and where each stands. */
export async function linkView(env, query, { fetchImpl } = {}) {
  const p = await byToken(env, query?.t, query?.s);
  const moves = await all(env.DB, 'SELECT * FROM float_move WHERE person_id = ?1', p.id);
  const receipts = await receiptsOf(env, [p.id]);
  await settle(env, receipts, { fetchImpl });
  return {
    name: p.name, ref: `FLT/${p.code}`, ...totals(moves, receipts),
    // Where their receipts may go: more than one, they say for each. None, the office says.
    places: destsOf(p).map((k) => ({ key: k, label: k === 'odoo' ? 'The hotel' : DESTS[k] })),
    // The money given them (and given back), newest first, each with its note.
    moves: moves.slice().sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.id - a.id)).slice(0, 40).map((m) => ({
      kind: m.kind, amount: m.amount, day: m.day, source: SOURCES[m.source] || null, note: m.note || null, by: m.by_name || null,
    })),
    sent: receipts.slice(0, 40).map((r) => ({
      id: r.id, ref: r.ref, at: r.at, day: r.day || r.at.slice(0, 10), amount: amountOf(r) ?? null, change: changeOf(r), vendor: r.vendor_name || r.vendor_text || null,
      description: r.description || r.hint || null, status: r.status, reason: r.reason || null, decidedAt: r.decided_at || null,
      unread: !r.po_name && r.amount == null,
      where: destOf(r) === 'wait' ? 'The office will say where it goes' : POS_SIDES.has(destOf(r)) ? `${DESTS[destOf(r)]}, in the POS${r.pos_no ? ` · ${r.pos_no}` : ''}` : null,
    })),
  };
}

export async function linkSend(env, body, { fetchImpl } = {}) {
  const p = await byToken(env, body?.t, body?.s);
  const out = await addFor(env, p, body, `${p.name} (float)`, { fetchImpl });
  const r = out.receipt;
  const where = out.dest === 'wait' ? ' The office will say where it goes.'
    : POS_SIDES.has(out.dest) ? ` It goes to the ${DESTS[out.dest].toLowerCase()}, in the POS.` : '';
  return {
    ok: true, duplicate: Boolean(out.duplicate), ref: out.ref || null,
    said: out.duplicate ? 'You sent this receipt before: it is counted once.'
      : r.amount != null ? `Read: ${r.vendorText || r.vendorName || 'a receipt'}, ${ghs(r.amount)}. It is being checked.${where}`
        : 'Sent. It could not be read, so the office will fill it in.',
  };
}

/** The person holding the float, on their link: the PO's new total is right, or it is not. */
export async function linkAmount(env, body) {
  const p = await byToken(env, body?.t, body?.s);
  const r = await first(env.DB, 'SELECT * FROM float_receipt WHERE id = ?1 AND person_id = ?2', Number(body?.id), p.id);
  if (!r || r.po_total == null) throw badRequest('That receipt has no new amount to answer.');
  if (!asksHolder(r)) throw badRequest('It was changed more than 30 days after you sent it: the office decides this one.');
  const answer = { accept: 'accept', dispute: 'dispute' }[body?.answer];
  if (!answer) throw badRequest('Accept the new amount, or say it is not right.');
  // Accepting it, they say why it changed.
  const note = str(body?.note, 'Why it changed', { max: 300 }) || null;
  if (answer === 'accept' && (!note || note.length < 3)) throw badRequest('Say why the amount changed.');
  await run(env.DB, 'UPDATE float_receipt SET holder_answer = ?2, holder_at = ?3, holder_note = ?4 WHERE id = ?1', r.id, answer, now(), note);
  return { ok: true, answer };
}

/** An admin: the PO's new total counts, or the receipt's own amount stays. Empty takes the answer off. */
export async function decideAmount(env, body, account) {
  const r = await first(env.DB, 'SELECT * FROM float_receipt WHERE id = ?1', Number(body?.id));
  if (!r || r.po_total == null) throw badRequest('That receipt has no new amount to answer.');
  const answer = { accept: 'accept', keep: 'keep', '': null }[body?.answer ?? ''];
  if (answer === undefined) throw badRequest('Accept the new amount, or keep the receipt’s.');
  await run(env.DB, 'UPDATE float_receipt SET admin_answer = ?2, admin_by = ?3, admin_at = ?4 WHERE id = ?1', r.id, answer, answer ? who(account) : null, answer ? now() : null);
  return { ok: true, answer };
}

// ------------------------------------------------------------ statement --

/**
 * A statement for one person over a period: what they held at the start,
 * every amount given, spent and given back, and what they hold at the end.
 * As a spreadsheet (CSV) or a page to print or save as PDF.
 */
export async function statement(env, id, query) {
  return statementOf(env, await person(env, id), query);
}

/** Their own statement, from their link. */
export async function linkStatement(env, query) {
  return statementOf(env, await byToken(env, query?.t, query?.s), query);
}

async function statementOf(env, p, query) {
  const to = DAY.test(String(query?.to || '')) ? query.to : todayIn('UTC');
  let from = DAY.test(String(query?.from || '')) ? query.from : `${to.slice(0, 7)}-01`;
  if (from > to) throw badRequest('The start is after the end.');
  const moves = await all(env.DB, 'SELECT * FROM float_move WHERE person_id = ?1 ORDER BY day, id', p.id);
  const receipts = (await receiptsOf(env, [p.id])).reverse();
  const lines = [
    ...moves.map((m) => ({
      day: m.day, what: m.kind === 'given' ? `Given${m.source ? ` from ${(SOURCES[m.source] || m.source).toLowerCase()}` : ''}${m.by_name ? ` by ${m.by_name}` : ''}`
        : 'Given back',
      note: m.note || '',
      title: m.kind === 'given' ? 'Given' : 'Given back',
      detail: m.kind === 'given' ? [m.source ? `from ${(SOURCES[m.source] || m.source).replace(/^The /, 'the ')}` : '', m.by_name ? `by ${m.by_name}` : ''].filter(Boolean).join(' ')
        : m.source ? `into ${(SOURCES[m.source] || m.source).replace(/^The /, 'the ')}` : '',
      ref: '', po: '', status: '', change: m.kind === 'given' ? m.amount : -m.amount,
    })),
    ...receipts.map((r) => ({
      day: r.day || r.at.slice(0, 10),
      what: `Receipt: ${r.vendor_name || r.vendor_text || 'not read'}${r.description ? `, ${r.description}` : ''}`,
      note: r.hint || '',
      title: r.vendor_name || r.vendor_text || 'Receipt, not read', detail: r.description || '', state: r.status,
      ref: r.ref, po: r.po_name || (r.pos_no ? `${r.pos_no} (POS ${DESTS[r.dest] || ''})`.replace(' )', ')') : ''), status: { checking: 'Being checked', accepted: 'Accepted', refused: `Refused${r.reason ? `: ${r.reason}` : ''}` }[r.status],
      change: -spentBy(r),
    })),
  ].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  // "start": from the first day anything was given or sent.
  if (query?.from === 'start') from = lines[0]?.day && lines[0].day < to ? lines[0].day : to;
  const opening = lines.filter((l) => l.day < from).reduce((t, l) => t + l.change, 0);
  const shown = lines.filter((l) => l.day >= from && l.day <= to);
  let held = opening;
  for (const l of shown) { held += l.change; l.held = held; }
  const sum = (f) => shown.filter(f).reduce((t, l) => t + Math.abs(l.change), 0);
  const s = {
    name: p.name, code: p.code, from, to, opening, closing: held,
    given: sum((l) => l.change > 0), spent: sum((l) => l.ref && l.change < 0), back: sum((l) => !l.ref && l.change < 0), lines: shown,
  };
  // Just the totals: what their page shows before they open the statement.
  if (query?.format === 'json') {
    return { from, to, opening: s.opening, given: s.given, spent: s.spent, back: s.back, closing: s.closing, lines: shown.length };
  }
  const file = `Float statement ${p.code} ${from} to ${to}`;
  if (query?.format === 'csv') {
    const cedis = (minor) => (minor / 100).toFixed(2);
    return csvResponse(`${file}.csv`, [
      [`Float statement: ${p.name} (FLT/${p.code})`], [`From ${from} to ${to}`], [],
      ['Date', 'What', 'Note', 'Reference', 'PO', 'Status', 'In (GH₵)', 'Out (GH₵)', 'Still with them (GH₵)'],
      ['', 'Held at the start', '', '', '', '', '', '', cedis(opening)],
      ...shown.map((l) => [l.day, l.what, l.note, l.ref, l.po, l.status, l.change > 0 ? cedis(l.change) : '', l.change < 0 ? cedis(-l.change) : '', cedis(l.held)]),
      ['', 'Held at the end', '', '', '', '', cedis(s.given), cedis(s.spent + s.back), cedis(held)],
    ]);
  }
  const link = (format) => `?${new URLSearchParams({ ...Object.fromEntries(Object.entries(query || {}).filter(([k]) => ['t', 's'].includes(k))), from, to, format })}`;
  if (query?.format === 'pdf') {
    // Inline: a phone opens it in its own viewer, which shares, saves and prints it.
    return new Response(statementPdf(s, file), {
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${file.replace(/[^\w .-]/g, '')}.pdf"`, 'Cache-Control': 'no-store' },
    });
  }
  s.csv = link('csv');
  s.pdf = link('pdf');
  // Where Back goes when there is no page to go back to: their own page, or Insight's floats.
  s.home = query?.t ? `/float.html?${new URLSearchParams(Object.fromEntries(Object.entries(query).filter(([k]) => ['t', 's'].includes(k))))}` : '/#/floats';
  return new Response(statementPage(s, file), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const longDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * The statement as a PDF: the same heading, totals and lines as the page, set
 * on A4 with the column heads again on each page and page numbers at the foot.
 */
export function statementPdf(s, title) {
  const amount = (minor) => (Math.abs(minor) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const monthOf = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const shortDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const INK = [0.08, 0.09, 0.1];
  const DIM = [0.42, 0.45, 0.5];
  const LINE = [0.86, 0.88, 0.91];
  const SOFT = [0.95, 0.95, 0.97];
  const M = 40;
  const W = A4.w - 2 * M;
  const BOTTOM = A4.h - 56;
  // Date, What, Reference, In, Out, Balance: What takes what is left.
  const COL = { date: M, what: M + 52, ref: M + W - 270, inR: M + W - 150, outR: M + W - 85, balR: M + W };
  const WHAT_W = COL.ref - COL.what - 10;
  const doc = pdf({ title });
  let top = 0;

  const heads = () => {
    doc.box(M, top, W, 20, { fill: SOFT });
    const t = top + 13.5;
    doc.text(COL.date + 4, t, 'DATE', { size: 7.5, bold: true, color: DIM })
      .text(COL.what, t, 'WHAT', { size: 7.5, bold: true, color: DIM })
      .text(COL.ref, t, 'REFERENCE', { size: 7.5, bold: true, color: DIM })
      .text(COL.inR, t, 'IN', { size: 7.5, bold: true, color: DIM, align: 'right' })
      .text(COL.outR, t, 'OUT', { size: 7.5, bold: true, color: DIM, align: 'right' })
      .text(COL.balR - 4, t, 'BALANCE', { size: 7.5, bold: true, color: DIM, align: 'right' });
    top += 24;
  };
  const newPage = (withHeads = true) => {
    doc.page();
    top = M;
    if (doc.pages.length > 1) {
      doc.text(M, top + 10, `Float statement · ${s.name} · FLT/${s.code}`, { size: 9, bold: true })
        .text(M + W, top + 10, `${longDay(s.from)} to ${longDay(s.to)}`, { size: 9, color: DIM, align: 'right' });
      top += 22;
    }
    if (withHeads) heads();
  };
  const room = (h) => { if (top + h > BOTTOM) newPage(); };

  // The heading.
  newPage(false);
  doc.text(M, top + 22, 'Float statement', { size: 22, bold: true })
    .text(M + W, top + 14, 'Insight', { size: 12, bold: true, align: 'right' })
    .text(M + W, top + 28, `Printed ${longDay(todayIn('UTC'))}`, { size: 9, color: DIM, align: 'right' })
    .text(M, top + 42, `${s.name} · FLT/${s.code}`, { size: 11, color: DIM })
    .text(M, top + 58, `${longDay(s.from)} to ${longDay(s.to)}`, { size: 11, color: DIM });
  top += 68;
  doc.line(M, top, M + W, top, { width: 1.5, color: INK });
  top += 14;

  // The totals.
  const boxes = [['At the start', s.opening], ['Given', s.given], ['Spent (receipts)', s.spent], ['Given back', s.back], ['Still with them', s.closing]];
  const gap = 8;
  const bw = (W - gap * 4) / 5;
  boxes.forEach(([label, v], i) => {
    const x = M + i * (bw + gap);
    const last = i === boxes.length - 1;
    doc.box(x, top, bw, 44, last ? { fill: INK } : { stroke: LINE, width: 0.8 });
    const figure = `GHS ${amount(v)}${last && v < 0 ? ' over' : ''}`;
    // A long figure is set smaller, to stay inside its box.
    let size = 10.5;
    while (size > 6 && widthOf(figure, size, true) > bw - 14) size -= 0.5;
    doc.text(x + 8, top + 15, label, { size: 8, color: last ? [0.8, 0.81, 0.84] : DIM })
      .text(x + 7, top + 33, figure, { size, bold: true, color: last ? [1, 1, 1] : INK });
  });
  top += 58;

  // The lines, month by month.
  heads();
  let month = '';
  if (!s.lines.length) { doc.text(M + 4, top + 12, 'Nothing in these dates.', { size: 9.5, color: DIM }); top += 22; }
  for (const l of s.lines) {
    if (monthOf(l.day) !== month) {
      month = monthOf(l.day);
      room(22 + 30);
      doc.text(M + 4, top + 12, month, { size: 9, bold: true, color: DIM });
      top += 18;
    }
    const status = l.state === 'accepted' ? `Accepted${l.po ? ` · PO ${l.po}` : ''}`
      : l.state === 'refused' ? `${l.status} (does not count)` : l.state ? `Being checked${l.po ? ` · PO ${l.po}` : ''}` : '';
    const what = [
      ...wrap(l.title, 9.5, WHAT_W, true).map((t) => [t, 9.5, true, INK]),
      ...(l.detail ? wrap(l.detail, 8.5, WHAT_W).map((t) => [t, 8.5, false, DIM]) : []),
      ...(l.note ? wrap(`"${l.note}"`, 8.5, WHAT_W).map((t) => [t, 8.5, false, DIM]) : []),
      ...(status ? wrap(status, 8, WHAT_W).map((t) => [t, 8, false, l.state === 'refused' ? [0.72, 0.11, 0.11] : l.state === 'accepted' ? [0.08, 0.5, 0.24] : DIM]) : []),
    ];
    const h = Math.max(1, what.length) * 11.5 + 9;
    room(h);
    const base = top + 13;
    doc.text(COL.date + 4, base, shortDay(l.day), { size: 9.5 });
    what.forEach(([t, size, bold, color], i) => doc.text(COL.what, base + i * 11.5, t, { size, bold, color }));
    if (l.ref) doc.text(COL.ref, base, l.ref, { size: 8.5, color: DIM });
    if (l.change > 0) doc.text(COL.inR, base, amount(l.change), { size: 9.5, align: 'right' });
    if (l.change < 0) doc.text(COL.outR, base, amount(l.change), { size: 9.5, align: 'right' });
    else if (l.state === 'refused') doc.text(COL.outR, base, '-', { size: 9.5, color: DIM, align: 'right' });
    doc.text(COL.balR - 4, base, `${amount(l.held)}${l.held < 0 ? ' over' : ''}`, { size: 9.5, bold: true, align: 'right' });
    top += h;
    doc.line(M, top, M + W, top, { color: LINE });
  }

  // The note and the signatures, kept together.
  room(90);
  top += 16;
  doc.text(M, top, 'Amounts in GHS. A refused receipt does not count against them; one being checked counts until it is refused.', { size: 8, color: DIM });
  top += 54;
  const half = (W - 40) / 2;
  doc.line(M, top, M + half, top, { color: [0.6, 0.6, 0.6] }).line(M + half + 40, top, M + W, top, { color: [0.6, 0.6, 0.6] });
  doc.text(M, top + 12, `Received by ${s.name}`, { size: 8.5, color: DIM }).text(M + half + 40, top + 12, 'Checked by', { size: 8.5, color: DIM });

  // Page numbers, now the count is known.
  const n = doc.pages.length;
  doc.pages.forEach((ops, i) => {
    ops.push(`BT ${DIM.join(' ')} rg /F1 8 Tf ${(A4.w / 2 - 20).toFixed(2)} 28 Td (Page ${i + 1} of ${n}) Tj ET`);
  });
  return doc.bytes();
}

function statementPage(s, title) {
  const amount = (minor) => (Math.abs(minor) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const monthOf = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const shortDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const statusOf = (l) => (l.state === 'accepted' ? `✓ Accepted${l.po ? ` · PO ${l.po}` : ''}`
    : l.state === 'refused' ? `✕ ${l.status} (does not count)`
      : l.state ? `Being checked${l.po ? ` · PO ${l.po}` : ''}` : '');
  let month = '';
  const rows = s.lines.map((l) => {
    const head = monthOf(l.day) !== month ? `<tr class="month"><td colspan="6">${esc((month = monthOf(l.day)))}</td></tr>` : '';
    const out = l.change < 0 ? amount(l.change) : l.state === 'refused' ? '<span class="none">—</span>' : '';
    return `${head}<tr><td class="d">${esc(shortDay(l.day))}</td>
      <td class="w"><b>${esc(l.title)}</b>${l.detail ? ` · ${esc(l.detail)}` : ''}${l.note ? `<div class="note">${esc(l.note)}</div>` : ''}${statusOf(l) ? `<div class="st ${l.state || ''}">${esc(statusOf(l))}</div>` : ''}</td>
      <td class="ref">${esc(l.ref)}</td><td class="n i" data-l="In">${l.change > 0 ? amount(l.change) : ''}</td><td class="n o" data-l="Out">${out}</td><td class="n b" data-l="Balance"><b>${esc(amount(l.held))}</b>${l.held < 0 ? ' over' : ''}</td></tr>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--ink:#14161a;--ink-2:#4b515c;--muted:#8a909b;--line:#e3e6eb;--soft:#f1f2f6;--accent:#4f46e5}
*{box-sizing:border-box}
body{font:14px/1.5 Inter,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:var(--ink);margin:0;background:#f4f5f8;-webkit-font-smoothing:antialiased}
main{max-width:900px;margin:0 auto;padding:20px 16px 40px}
.bar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.bar button,.bar a{font:inherit;font-weight:700;padding:10px 16px;border-radius:12px;border:1px solid var(--line);background:#fff;color:var(--ink);cursor:pointer;text-decoration:none}
.bar .pri{background:var(--accent);border-color:var(--accent);color:#fff}.bar .back{margin-right:auto}.bar [hidden]{display:none}
.paper{background:#fff;border-radius:16px;box-shadow:0 1px 2px rgba(16,24,40,.05),0 4px 14px rgba(16,24,40,.06);padding:28px}
.ph{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:flex-start;border-bottom:2px solid var(--ink);padding-bottom:14px}
h1{font-size:24px;margin:0;letter-spacing:-.01em}.ph p{margin:2px 0 0;color:var(--ink-2)}
.brand{text-align:right;font-size:13px;color:var(--muted)}.brand b{display:block;color:var(--ink);font-size:15px}
.mono,.ref{font:12px ui-monospace,Menlo,monospace;color:var(--ink-2);white-space:nowrap}
.sum{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:18px 0}
.sum div{border:1px solid var(--line);border-radius:12px;padding:10px 12px}.sum small{display:block;color:var(--muted);font-size:12px}.sum b{font-size:17px;font-variant-numeric:tabular-nums}
.sum .end{background:var(--ink);border-color:var(--ink);color:#fff}.sum .end small{color:#c9ccd4}
.wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
tr.month td{background:var(--soft);font-weight:700;font-size:13px;color:var(--ink-2)}
.note{font-style:italic;color:var(--ink-2);font-size:13px}.st{color:var(--muted);font-size:12px}.st.accepted{color:#15803d}.st.refused{color:#b91c1c}.none{color:var(--muted)}
.foot{color:var(--muted);font-size:12px;margin-top:10px}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:48px;margin-top:44px}.sign div{border-top:1px solid #999;padding-top:6px;color:var(--muted);font-size:12px}
@media (max-width:700px){.sum{grid-template-columns:repeat(2,minmax(0,1fr))}.paper{padding:18px}
/* On a phone each line is a small card: date and reference, what it was, then the money. */
.wrap{overflow:visible}table,tbody{display:block}thead{display:none}
tbody tr{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;padding:10px 0;border-bottom:1px solid var(--line)}
tbody td{border:0;padding:0}tbody td.d{font-weight:600}tbody td.ref{text-align:right;overflow:hidden;text-overflow:ellipsis}
tbody td.w{grid-column:1/-1}tbody td.n{grid-column:1/-1;display:flex;justify-content:space-between;text-align:right}
tbody td.n:empty{display:none}tbody td.n::before{content:attr(data-l);color:var(--muted);font-size:12px}
tbody tr.month{display:block;padding:0;border:0}tbody tr.month td{display:block;padding:6px 8px;border-radius:8px;margin-top:8px}
tbody tr:has(td[colspan]):not(.month) td{grid-column:1/-1}}
@media print{body{background:#fff}.bar{display:none}main{padding:0}.paper{box-shadow:none;padding:0}}
</style></head><body><main>
<div class="bar"><a class="back" href="${esc(s.home || '/')}" onclick="if (1 < history.length) { history.back(); return false; }">← Back</a><a class="pri" href="${esc(s.pdf || '')}">Download PDF</a><button type="button" class="print" onclick="print()">Print</button><a href="${esc(s.csv || '')}">Spreadsheet</a></div>
<script>
// A phone that opened Insight from its home screen cannot print a web page: the PDF is the way there.
if (navigator.standalone || matchMedia('(display-mode: standalone)').matches) document.querySelector('.bar .print').hidden = true;
</script>
<div class="paper">
<div class="ph"><div><h1>Float statement</h1><p>${esc(s.name)} · <span class="mono">FLT/${esc(s.code)}</span></p><p>${esc(longDay(s.from))} to ${esc(longDay(s.to))}</p></div>
<div class="brand"><b>Insight</b>Printed ${esc(longDay(todayIn('UTC')))}</div></div>
<div class="sum"><div><small>At the start</small><b>GH₵${esc(amount(s.opening))}</b></div><div><small>Given</small><b>GH₵${esc(amount(s.given))}</b></div>
<div><small>Spent (receipts)</small><b>GH₵${esc(amount(s.spent))}</b></div><div><small>Given back</small><b>GH₵${esc(amount(s.back))}</b></div><div class="end"><small>Still with them</small><b>${esc(ghs(s.closing))}</b></div></div>
<div class="wrap"><table><thead><tr><th>Date</th><th>What</th><th>Reference</th><th class="n">In</th><th class="n">Out</th><th class="n">Balance</th></tr></thead><tbody>
${rows || '<tr><td colspan="6">Nothing in these dates.</td></tr>'}
</tbody></table></div>
<p class="foot">Amounts in GH₵. A refused receipt does not count against them; one being checked counts until it is refused.</p>
<div class="sign"><div>Received by ${esc(s.name)}</div><div>Checked by</div></div>
</div></main></body></html>`;
}
