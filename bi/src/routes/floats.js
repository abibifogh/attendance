import { all, first, run } from '../lib/db.js';
import { badRequest, csvResponse, HttpError, str } from '../lib/http.js';
import { todayIn } from '../lib/dates.js';
import { purchaseOrders } from '../connectors/odoo.js';
import { odooSource } from './safebook.js';
import { addReceipt, markFor } from './receipts.js';

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
 */

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const ghs = (minor) => `${Number(minor) < 0 ? '−' : ''}GH₵${(Math.abs(Number(minor || 0)) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const who = (account) => account?.name || account?.email || 'Owner';
const DAY = /^\d{4}-\d\d-\d\d$/;
const SOURCES = { safe: 'The safe', bank: 'The bank (MoMo or transfer)', drawer: 'A shift’s drawer', other: 'Somewhere else' };
const TYPES = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;
const FILE_MAX = 14_000_000;
const QUIET_DAYS = 14;
const CONFIRMED = new Set(['purchase', 'done']);

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
  const waiting = rows.filter((r) => r.status === 'checking' && r.po_name);
  if (!waiting.length) return;
  try {
    const s = await odooSource(env);
    if (!s) return;
    const { orders } = await purchaseOrders({ ...s, names: waiting.map((r) => r.po_name), ...(fetchImpl ? { fetchImpl } : {}) });
    const state = new Map(orders.map((o) => [o.name.toUpperCase(), o.state]));
    for (const r of waiting) {
      const st = state.get(String(r.po_name).toUpperCase());
      if (CONFIRMED.has(st)) Object.assign(r, { status: 'accepted', decided_by: 'Odoo', decided_at: now() });
      else if (st === 'cancel') Object.assign(r, { status: 'refused', reason: `${r.po_name} was cancelled in Odoo.`, decided_by: 'Odoo', decided_at: now() });
      else continue;
      // eslint-disable-next-line no-await-in-loop
      await run(env.DB, 'UPDATE float_receipt SET status = ?2, reason = ?3, decided_by = ?4, decided_at = ?5 WHERE id = ?1', r.id, r.status, r.reason || null, r.decided_by, r.decided_at);
    }
  } catch (err) { console.error('Floats: Odoo', err); }
}

/** What a receipt counts for: its amount unless refused (none read yet counts nothing). */
const spentBy = (r) => (r.status === 'refused' ? 0 : Number(r.amount) || 0);

function totals(moves, receipts) {
  const given = moves.filter((m) => m.kind === 'given').reduce((t, m) => t + m.amount, 0);
  const back = moves.filter((m) => m.kind === 'back').reduce((t, m) => t + m.amount, 0);
  const spent = receipts.reduce((t, r) => t + spentBy(r), 0);
  return { given, back, spent, held: given - back - spent, receipts: receipts.filter((r) => r.status !== 'refused').length };
}

/** Something to look at: not read, read with something to check, or no PO. */
const toLookAt = (r) => r.status === 'checking' && (!r.po_name || ['check', 'unread', 'failed'].includes(r.read_status));

function receiptView(r) {
  return {
    id: r.id, receiptId: r.receipt_id, ref: r.ref, at: r.at, day: r.day || r.at.slice(0, 10), amount: r.amount ?? null,
    vendor: r.vendor_name || r.vendor_text || null, description: r.description || null, hint: r.hint || null,
    status: r.status, reason: r.reason || null, decidedBy: r.decided_by || null,
    read: r.read_status, problem: r.problem || null, thumb: r.thumb || null,
    po: r.po_name ? { id: r.po_id, name: r.po_name, url: r.po_url } : null, toLookAt: toLookAt(r),
  };
}

/** Everybody with a float, and the totals across them. */
export async function list(env, { fetchImpl } = {}) {
  const people = await all(env.DB, 'SELECT * FROM float_person ORDER BY active DESC, name');
  const moves = await all(env.DB, 'SELECT * FROM float_move ORDER BY day, id');
  const receipts = await receiptsOf(env, people.map((p) => p.id));
  await settleFromOdoo(env, receipts, { fetchImpl });
  const month = todayIn('UTC').slice(0, 7);
  const quietBefore = new Date(Date.now() - QUIET_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = people.map((p) => {
    const mine = receipts.filter((r) => r.person_id === p.id);
    const myMoves = moves.filter((m) => m.person_id === p.id);
    const t = totals(myMoves, mine);
    const last = [...mine.map((r) => r.at.slice(0, 10)), ...myMoves.filter((m) => m.kind === 'given').map((m) => m.day)].sort().at(-1) || null;
    const lastReceipt = mine[0]?.at?.slice(0, 10) || null;
    return {
      id: p.id, name: p.name, code: p.code, note: p.note, active: Boolean(p.active), ...t, lastReceipt,
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
  };
}

/** One person: what they were given and gave back, every receipt and its PO, newest first. */
export async function detail(env, id, { fetchImpl } = {}) {
  const p = await withSlug(env, await person(env, id));
  const moves = await all(env.DB, 'SELECT * FROM float_move WHERE person_id = ?1 ORDER BY day DESC, id DESC', p.id);
  const receipts = await receiptsOf(env, [p.id]);
  await settleFromOdoo(env, receipts, { fetchImpl });
  return {
    person: { id: p.id, name: p.name, code: p.code, note: p.note, active: Boolean(p.active), token: p.token, slug: p.slug },
    ...totals(moves, receipts),
    moves: moves.map((m) => ({ id: m.id, kind: m.kind, amount: m.amount, day: m.day, source: m.source, sourceText: SOURCES[m.source] || null, note: m.note, noteBy: m.note_by || null, noteAt: m.note_at || null, by: m.by_name })),
    receipts: receipts.map(receiptView),
    sources: SOURCES,
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
async function addFor(env, p, body, byName, { fetchImpl } = {}) {
  const file = String(body?.file || '');
  const m = file.match(/^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!m || !TYPES.test(m[1])) throw badRequest('A photo or a PDF of the receipt.');
  if (m[2].length > FILE_MAX) throw badRequest('That file is too large: a photo, or a PDF under 7 MB.');
  const thumb = String(body?.thumb || '');
  // The next number is taken before reading, so two sent at once never share one.
  const taken = await first(env.DB, 'UPDATE float_person SET next_seq = next_seq + 1 WHERE id = ?1 RETURNING next_seq - 1 AS seq', p.id);
  const ref = refOf(p.code, taken.seq);
  const given = await first(env.DB, "SELECT day, amount FROM float_move WHERE person_id = ?1 AND kind = 'given' ORDER BY day DESC, id DESC LIMIT 1", p.id);
  const receipt = await addReceipt(env, {
    mime: m[1], data: m[2], name: body?.name, came: 'float', byName,
    thumb: /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(thumb) && thumb.length < 60_000 ? thumb : null,
    hint: str(body?.hint, 'What it was for', { max: 300 }),
  }, { fetchImpl, mark: markFor({ ref, name: p.name, given }) });
  // The same picture sent twice is one receipt: the second is not counted.
  if (receipt.status === 'duplicate' && receipt.sameAs && await first(env.DB, 'SELECT id FROM float_receipt WHERE receipt_id = ?1', receipt.sameAs)) {
    return { duplicate: true, receipt };
  }
  await run(env.DB, 'INSERT INTO float_receipt (person_id, receipt_id, seq, ref, at) VALUES (?1, ?2, ?3, ?4, ?5)', p.id, receipt.id, taken.seq, ref, now());
  return { ref, receipt };
}

export async function adminAdd(env, body, account, { fetchImpl } = {}) {
  const p = await person(env, body?.personId);
  return addFor(env, p, body, `${who(account)} for ${p.name}`, { fetchImpl });
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
  await settleFromOdoo(env, receipts, { fetchImpl });
  return {
    name: p.name, ref: `FLT/${p.code}`, ...totals(moves, receipts),
    sent: receipts.slice(0, 40).map((r) => ({
      ref: r.ref, at: r.at, day: r.day || r.at.slice(0, 10), amount: r.amount ?? null, vendor: r.vendor_name || r.vendor_text || null,
      description: r.description || r.hint || null, status: r.status, reason: r.reason || null,
      unread: !r.po_name && r.amount == null,
    })),
  };
}

export async function linkSend(env, body, { fetchImpl } = {}) {
  const p = await byToken(env, body?.t, body?.s);
  const out = await addFor(env, p, body, `${p.name} (float)`, { fetchImpl });
  const r = out.receipt;
  return {
    ok: true, duplicate: Boolean(out.duplicate), ref: out.ref || null,
    said: out.duplicate ? 'You sent this receipt before: it is counted once.'
      : r.amount != null ? `Read: ${r.vendorText || r.vendorName || 'a receipt'}, ${ghs(r.amount)}. It is being checked.`
        : 'Sent. It could not be read, so the office will fill it in.',
  };
}

// ------------------------------------------------------------ statement --

/**
 * A statement for one person over a period: what they held at the start,
 * every amount given, spent and given back, and what they hold at the end.
 * As a spreadsheet (CSV) or a page to print or save as PDF.
 */
export async function statement(env, id, query) {
  const p = await person(env, id);
  const to = DAY.test(String(query?.to || '')) ? query.to : todayIn('UTC');
  const from = DAY.test(String(query?.from || '')) ? query.from : `${to.slice(0, 7)}-01`;
  if (from > to) throw badRequest('The start is after the end.');
  const moves = await all(env.DB, 'SELECT * FROM float_move WHERE person_id = ?1 ORDER BY day, id', p.id);
  const receipts = (await receiptsOf(env, [p.id])).reverse();
  const lines = [
    ...moves.map((m) => ({
      day: m.day, what: m.kind === 'given' ? `Given${m.source ? ` from ${(SOURCES[m.source] || m.source).toLowerCase()}` : ''}${m.by_name ? ` by ${m.by_name}` : ''}`
        : 'Given back',
      note: m.note || '',
      ref: '', po: '', status: '', change: m.kind === 'given' ? m.amount : -m.amount,
    })),
    ...receipts.map((r) => ({
      day: r.day || r.at.slice(0, 10),
      what: `Receipt: ${r.vendor_name || r.vendor_text || 'not read'}${r.description ? `, ${r.description}` : ''}`,
      note: r.hint || '',
      ref: r.ref, po: r.po_name || '', status: { checking: 'Being checked', accepted: 'Accepted', refused: `Refused${r.reason ? `: ${r.reason}` : ''}` }[r.status],
      change: -spentBy(r),
    })),
  ].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const opening = lines.filter((l) => l.day < from).reduce((t, l) => t + l.change, 0);
  const shown = lines.filter((l) => l.day >= from && l.day <= to);
  let held = opening;
  for (const l of shown) { held += l.change; l.held = held; }
  const sum = (f) => shown.filter(f).reduce((t, l) => t + Math.abs(l.change), 0);
  const s = {
    name: p.name, code: p.code, from, to, opening, closing: held,
    given: sum((l) => l.change > 0), spent: sum((l) => l.ref && l.change < 0), back: sum((l) => !l.ref && l.change < 0), lines: shown,
  };
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
  return new Response(statementPage(s, file), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const longDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function statementPage(s, title) {
  const row = (l) => `<tr><td>${esc(longDay(l.day))}</td><td>${esc(l.what)}${l.status ? `<div class="st">${esc(l.status)}</div>` : ''}</td><td class="note">${esc(l.note)}</td><td class="ref">${esc(l.ref)}</td><td>${esc(l.po)}</td>
    <td class="n">${l.change > 0 ? esc(ghs(l.change)) : ''}</td><td class="n">${l.change < 0 ? esc(ghs(-l.change)) : ''}</td><td class="n"><b>${esc(ghs(l.held))}</b></td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
body{font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:0;background:#fff}
main{max-width:900px;margin:0 auto;padding:28px 20px}
h1{font-size:22px;margin:0}.sub{color:#555;margin:.2rem 0 1rem}
.sum{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin:0 0 16px}
.sum div{border:1px solid #ddd;border-radius:8px;padding:8px 10px}.sum small{display:block;color:#555}.sum b{font-size:16px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e5e5e5;vertical-align:top}
th{font-size:12px;color:#555;text-transform:uppercase;letter-spacing:.03em}.n{text-align:right;white-space:nowrap}
.ref{font-family:ui-monospace,Menlo,monospace;font-size:12px;white-space:nowrap}.note{color:#333;font-style:italic;max-width:220px}.st{color:#666;font-size:12px}
.bar{display:flex;gap:8px;margin-bottom:16px}.bar button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #bbb;background:#f5f5f5;cursor:pointer}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:40px}.sign div{border-top:1px solid #999;padding-top:6px;color:#555;font-size:12px}
@media print{.bar{display:none}main{padding:0}}
</style></head><body><main>
<div class="bar"><button onclick="print()">Print or save as PDF</button></div>
<h1>Float statement · ${esc(s.name)}</h1>
<p class="sub">Reference FLT/${esc(s.code)} · ${esc(longDay(s.from))} to ${esc(longDay(s.to))}</p>
<div class="sum"><div><small>Held at the start</small><b>${esc(ghs(s.opening))}</b></div><div><small>Given</small><b>${esc(ghs(s.given))}</b></div>
<div><small>Spent (receipts)</small><b>${esc(ghs(s.spent))}</b></div><div><small>Given back</small><b>${esc(ghs(s.back))}</b></div><div><small>Held at the end</small><b>${esc(ghs(s.closing))}</b></div></div>
<table><thead><tr><th>Date</th><th>What</th><th>Note</th><th>Reference</th><th>PO</th><th class="n">In</th><th class="n">Out</th><th class="n">Still with them</th></tr></thead><tbody>
<tr><td></td><td>Held at the start</td><td></td><td></td><td></td><td></td><td></td><td class="n"><b>${esc(ghs(s.opening))}</b></td></tr>
${s.lines.map(row).join('\n') || '<tr><td colspan="8">Nothing in these dates.</td></tr>'}
</tbody></table>
<p class="st">A refused receipt does not count against them. One being checked counts until it is refused.</p>
<div class="sign"><div>Received by ${esc(s.name)}</div><div>Checked by</div></div>
</main></body></html>`;
}
