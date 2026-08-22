import { badRequest, forbidden, int, json, notFound, num, readJson, str } from '../lib/http.js';
import { createNotice } from '../lib/notices.js';
import { readFile, storeFile } from './people.js';
import {
  MAX_RECEIPTS, checkAgainst, claimTotal, round2, standingOf, yearOf,
} from '../lib/medical.js';
import { isDay, todayIn } from '../util/dates.js';

/**
 * Medical allowance claims.
 *
 * The office sets what each qualifying person gets for the year and what was
 * left when the app took over. They claim against it with the bills; somebody
 * decides; an approved claim comes off the balance.
 *
 * WHAT IS PRIVATE HERE IS MORE PRIVATE THAN PAY. A list of somebody's hospital
 * bills says things about them that no other screen in this app does. So the
 * office side sits behind hr_pay, the same permission as the wages, and the
 * staff side answers only about the person signed in — never about anybody
 * else, and never with a staff id taken off a request.
 */

const actorOf = (ctx) => `${ctx.session.user.name} (${ctx.session.user.role})`;

const audit = (ctx, action, entity, detail) => ctx.db.prepare(
  'INSERT INTO audit_log (actor, action, entity, detail) VALUES (?1, ?2, ?3, ?4)',
).bind(actorOf(ctx), action, String(entity ?? ''), JSON.stringify(detail ?? {}))
  .run().catch(() => {});

async function settingsOf(db) {
  const rows = await db.prepare(
    "SELECT key, value FROM settings WHERE key IN ('timezone','currency','medical_allowance_default')",
  ).all().catch(() => ({ results: [] }));
  const map = Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
  return {
    timezone: map.timezone || 'UTC',
    currency: map.currency || 'GHS',
    defaultAllowance: round2(map.medical_allowance_default ?? 0),
  };
}

const yearFrom = (url, timezone) => {
  const asked = Number(url.searchParams.get('year'));
  if (Number.isInteger(asked) && asked >= 2000 && asked <= 2100) return asked;
  return Number(todayIn(timezone).slice(0, 4));
};

/** Claims and their receipts for a year, indexed. */
async function claimsFor(db, { year, staffId = null }) {
  const claims = staffId
    ? await db.prepare('SELECT * FROM hr_medical_claim WHERE staff_id = ? AND year = ? ORDER BY id DESC')
      .bind(staffId, year).all()
    : await db.prepare('SELECT * FROM hr_medical_claim WHERE year = ? ORDER BY id DESC')
      .bind(year).all();

  const rows = claims.results ?? [];
  const byClaim = new Map(rows.map((c) => [c.id, []]));

  if (rows.length) {
    const ids = rows.map((c) => c.id);
    const receipts = await db.prepare(
      `SELECT r.*, d.mime, d.bytes FROM hr_medical_receipt r
         LEFT JOIN hr_document d ON d.id = r.document_id
        WHERE r.claim_id IN (${ids.map(() => '?').join(',')}) ORDER BY r.id`,
    ).bind(...ids).all();
    for (const receipt of receipts.results ?? []) byClaim.get(receipt.claim_id)?.push(receipt);
  }

  return { claims: rows, byClaim };
}

const shapeClaim = (claim, receipts) => ({
  id: claim.id,
  staffId: claim.staff_id,
  year: claim.year,
  amount: round2(claim.amount),
  approved: claim.approved == null ? null : round2(claim.approved),
  what: claim.what,
  status: claim.status,
  askedAt: claim.asked_at,
  decidedBy: claim.decided_by,
  decidedAt: claim.decided_at,
  decision: claim.decision,
  receipts: receipts.map((r) => ({
    id: r.id,
    what: r.what,
    amount: round2(r.amount),
    spentOn: r.spent_on,
    // The picture is fetched separately, so a list of claims is not a list of
    // photographs nobody asked to download.
    hasFile: Boolean(r.document_id),
    mime: r.mime ?? null,
    bytes: r.bytes ?? null,
  })),
});

// --------------------------------------------------------------------------
// The office
// --------------------------------------------------------------------------

/**
 * Everybody's year: who qualifies, what is left, and what is waiting.
 *
 * One screen rather than a person at a time, because the questions it gets
 * asked are "who has not claimed anything" and "how much of this year's
 * allowance is gone", and both are about the whole list.
 */
export async function medical(ctx) {
  const { timezone, currency, defaultAllowance } = await settingsOf(ctx.db);
  const year = yearFrom(ctx.url, timezone);

  const [staffRows, allowanceRows] = await Promise.all([
    ctx.db.prepare('SELECT id, name, department, employee_no, active FROM att_staff ORDER BY name').all(),
    ctx.db.prepare('SELECT * FROM hr_medical_allowance WHERE year = ?').bind(year).all(),
  ]);
  const { claims, byClaim } = await claimsFor(ctx.db, { year });

  const staff = staffRows.results ?? [];
  const staffById = new Map(staff.map((s) => [s.id, s]));
  const allowanceBy = new Map((allowanceRows.results ?? []).map((a) => [a.staff_id, a]));

  const claimsBy = new Map();
  for (const claim of claims) {
    if (!claimsBy.has(claim.staff_id)) claimsBy.set(claim.staff_id, []);
    claimsBy.get(claim.staff_id).push(claim);
  }

  const people = staff
    .filter((s) => allowanceBy.has(s.id) || claimsBy.has(s.id))
    .map((s) => ({
      staff: {
        id: s.id, name: s.name, department: s.department ?? null,
        employeeNo: s.employee_no ?? null, active: Boolean(s.active),
      },
      standing: standingOf(allowanceBy.get(s.id), claimsBy.get(s.id) ?? []),
      claims: (claimsBy.get(s.id) ?? []).map((c) => shapeClaim(c, byClaim.get(c.id) ?? [])),
    }));

  const waiting = claims
    .filter((c) => c.status === 'requested')
    .map((c) => ({
      ...shapeClaim(c, byClaim.get(c.id) ?? []),
      staffName: staffById.get(c.staff_id)?.name ?? 'Somebody',
      // What is left for them, so whoever decides is not asked to hold two
      // screens in their head.
      standing: standingOf(allowanceBy.get(c.staff_id), claimsBy.get(c.staff_id) ?? []),
    }))
    .sort((a, b) => String(a.askedAt).localeCompare(String(b.askedAt)));

  const totals = people.reduce((acc, p) => {
    if (!p.standing) return acc;
    return {
      allowance: round2(acc.allowance + p.standing.opening),
      spent: round2(acc.spent + p.standing.spent),
      left: round2(acc.left + p.standing.left),
    };
  }, { allowance: 0, spent: 0, left: 0 });

  return json({
    year,
    currency,
    defaultAllowance,
    people,
    waiting,
    totals: { ...totals, qualify: people.filter((p) => p.standing).length, waiting: waiting.length },
    // Everybody, for the screen that sets the year's allowances.
    staff: staff.filter((s) => s.active).map((s) => {
      const set = allowanceBy.get(s.id);
      return {
        id: s.id,
        name: s.name,
        department: s.department ?? null,
        qualifies: Boolean(set),
        allowance: set ? round2(set.allowance) : null,
        opening: set ? round2(set.opening) : null,
      };
    }),
  });
}

/**
 * Set the year's allowances, for everybody at once.
 *
 * Who qualifies and what they get, in one submission. Somebody setting this up
 * for twenty-four people should tick, type and press once — asked to save each
 * line they will do three and come back to the rest never.
 *
 * The opening balance is separate from the allowance on purpose. In the first
 * year the property has usually already paid some claims on paper, and an app
 * that insisted everybody starts the year untouched would be wrong about every
 * one of them.
 */
export async function setAllowances(ctx) {
  const body = await readJson(ctx.request);
  const { timezone } = await settingsOf(ctx.db);
  const year = Number.isInteger(body.year) ? body.year : Number(todayIn(timezone).slice(0, 4));
  if (year < 2000 || year > 2100) throw badRequest('That is not a year.');

  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw badRequest('Nothing to set.');

  let set = 0;
  let removed = 0;

  for (const line of rows) {
    const staffId = int(line.staffId, 'Who', { required: true, min: 1 });

    // Unticked: they do not qualify this year. Their claims stay — a record of
    // what was paid does not stop being true because the arrangement ended.
    if (line.qualifies === false) {
      const gone = await ctx.db.prepare(
        'DELETE FROM hr_medical_allowance WHERE staff_id = ? AND year = ?',
      ).bind(staffId, year).run();
      if (Number(gone?.meta?.changes ?? 0)) removed += 1;
      continue;
    }

    const allowance = round2(num(line.allowance, 'Allowance', {
      required: true, min: 0, max: 1_000_000,
    }));
    // A starting balance is not capped by the allowance. It can be less, where
    // part of the year has already been claimed on paper, and it can be more,
    // where something unused was carried over from last year. Both happen, and
    // an app that refused the second would be wrong about the people it was
    // meant to be generous to.
    const opening = line.opening == null || line.opening === ''
      ? allowance
      : round2(num(line.opening, 'Starting balance', { min: 0, max: 1_000_000 }));

    await ctx.db.prepare(
      `INSERT INTO hr_medical_allowance (staff_id, year, allowance, opening, note, set_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (staff_id, year) DO UPDATE
         SET allowance = ?3, opening = ?4, note = ?5, set_by = ?6, set_at = datetime('now')`,
    ).bind(staffId, year, allowance, opening, str(line.note, 'Note', { max: 300 }), actorOf(ctx))
      .run();
    set += 1;
  }

  await audit(ctx, 'medical.allowances', year, { set, removed });
  return json({ ok: true, year, set, removed });
}

/** Approve a claim, or turn it down. Either way the person is told. */
export async function decideClaim(ctx, idParam) {
  const id = int(idParam, 'Claim', { required: true, min: 1 });
  const body = await readJson(ctx.request);
  const { currency } = await settingsOf(ctx.db);

  const claim = await ctx.db.prepare('SELECT * FROM hr_medical_claim WHERE id = ?').bind(id).first();
  if (!claim) throw notFound('No such claim.');
  if (claim.status !== 'requested') throw badRequest('That claim has already been decided.');

  const person = await ctx.db.prepare(
    `SELECT s.id, s.name, u.id AS user_id
       FROM att_staff s LEFT JOIN users u ON u.staff_id = s.id AND u.active = 1
      WHERE s.id = ?`,
  ).bind(claim.staff_id).first();

  const note = str(body.note, 'Note', { max: 300 });

  if (body.approve === false) {
    await ctx.db.prepare(
      `UPDATE hr_medical_claim SET status = 'rejected', decided_by = ?2,
              decided_at = datetime('now'), decision = ?3 WHERE id = ?1`,
    ).bind(id, actorOf(ctx), note).run();
    await audit(ctx, 'medical.reject', id, { note });

    await tell(ctx, person, {
      kind: 'medical.rejected',
      title: 'Your medical claim was not approved',
      body: note || 'Speak to whoever handles the wages if you want to know why.',
    });
    return json({ ok: true, status: 'rejected' });
  }

  const amount = body.amount != null && body.amount !== ''
    ? round2(num(body.amount, 'Amount', { min: 0.01, max: 1_000_000 }))
    : round2(claim.amount);
  if (amount > round2(claim.amount)) {
    throw badRequest('You cannot approve more than was claimed.');
  }

  // What is left, worked out here rather than trusted from the screen: two
  // people approving at once should not be able to spend the same balance
  // twice between them.
  const allowance = await ctx.db.prepare(
    'SELECT * FROM hr_medical_allowance WHERE staff_id = ? AND year = ?',
  ).bind(claim.staff_id, claim.year).first();
  const theirs = await ctx.db.prepare(
    'SELECT * FROM hr_medical_claim WHERE staff_id = ? AND year = ?',
  ).bind(claim.staff_id, claim.year).all();
  const standing = standingOf(allowance, theirs.results ?? []);

  const check = checkAgainst(standing, amount);
  if (!check.ok && body.over !== true) {
    throw badRequest(check.reason
      + ' Approve a smaller amount, or tick to allow more than the balance.');
  }

  await ctx.db.prepare(
    `UPDATE hr_medical_claim SET status = 'approved', approved = ?2, decided_by = ?3,
            decided_at = datetime('now'), decision = ?4 WHERE id = ?1`,
  ).bind(id, amount, actorOf(ctx), note).run();

  await audit(ctx, 'medical.approve', id, {
    asked: round2(claim.amount), approved: amount, over: check.over || 0,
  });

  const left = standing ? round2(standing.left - amount) : null;
  const cut = amount < round2(claim.amount);
  await tell(ctx, person, {
    kind: 'medical.approved',
    title: `Your medical claim of ${money(amount, currency)} is approved`,
    body: (cut ? `You asked for ${money(claim.amount, currency)}. ` : '')
      + (left == null ? '' : `${money(left, currency)} is left in your allowance this year.`)
      + (note ? ` ${note}` : ''),
  });

  return json({ ok: true, status: 'approved', approved: amount, left });
}

/**
 * A receipt, handed back as the file it is.
 *
 * Two people may read it: whoever is deciding the claim, and the person whose
 * bill it is. Nobody else, and the check is on this row rather than on the
 * menu that led here.
 */
export async function receipt(ctx, idParam) {
  const id = int(idParam, 'Receipt', { required: true, min: 1 });

  const row = await ctx.db.prepare(
    `SELECT r.document_id, c.staff_id
       FROM hr_medical_receipt r JOIN hr_medical_claim c ON c.id = r.claim_id
      WHERE r.id = ?`,
  ).bind(id).first();
  if (!row?.document_id) throw notFound('No such receipt.');

  const mine = Number(ctx.session.user.staff_id) || 0;
  const canSeeEverybody = (ctx.session.permissions ?? []).includes('hr_pay');
  if (!canSeeEverybody && mine !== Number(row.staff_id)) {
    throw forbidden('That receipt is not yours.');
  }

  const doc = await ctx.db.prepare('SELECT * FROM hr_document WHERE id = ?')
    .bind(row.document_id).first();
  if (!doc) throw notFound('That receipt is no longer on file.');

  const content = await readFile(ctx.db, doc);
  return new Response(content, {
    headers: {
      'Content-Type': doc.mime || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${(doc.filename || 'receipt').replace(/["\\]/g, '')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

// --------------------------------------------------------------------------
// The person claiming
// --------------------------------------------------------------------------

/** My allowance, my claims, and the bills behind each one. */
export async function myMedical(ctx) {
  const staffId = Number(ctx.session.user.staff_id) || 0;
  const { timezone, currency } = await settingsOf(ctx.db);
  const year = yearFrom(ctx.url, timezone);

  if (!staffId) {
    return json({ linked: false, year, currency, standing: null, claims: [], years: [] });
  }

  const allowance = await ctx.db.prepare(
    'SELECT * FROM hr_medical_allowance WHERE staff_id = ? AND year = ?',
  ).bind(staffId, year).first();
  const { claims, byClaim } = await claimsFor(ctx.db, { year, staffId });

  // Which years they have anything at all in, so a screen can offer last year
  // without offering every year since 2000.
  const years = await ctx.db.prepare(
    `SELECT year FROM hr_medical_allowance WHERE staff_id = ?1
     UNION SELECT year FROM hr_medical_claim WHERE staff_id = ?1 ORDER BY year DESC`,
  ).bind(staffId).all().catch(() => ({ results: [] }));

  return json({
    linked: true,
    year,
    currency,
    maxReceipts: MAX_RECEIPTS,
    standing: standingOf(allowance, claims),
    claims: claims.map((c) => shapeClaim(c, byClaim.get(c.id) ?? [])),
    years: (years.results ?? []).map((r) => r.year),
  });
}

/**
 * Make a claim.
 *
 * The bills are the claim: the total is their sum rather than a figure
 * somebody typed, so what is asked for and what is evidenced cannot drift
 * apart. A bill with no picture is allowed — a phone with no camera, a receipt
 * already handed in at the office — and says so on the claim rather than being
 * refused at the door.
 */
export async function claim(ctx) {
  const staffId = Number(ctx.session.user.staff_id) || 0;
  if (!staffId) throw badRequest('This login is not linked to a staff record yet.');

  const body = await readJson(ctx.request);
  const { timezone, currency } = await settingsOf(ctx.db);

  const staff = await ctx.db.prepare('SELECT id, name FROM att_staff WHERE id = ? AND active = 1')
    .bind(staffId).first();
  if (!staff) throw notFound('The staff record this login points at is gone.');

  const receipts = Array.isArray(body.receipts) ? body.receipts : [];
  if (!receipts.length) throw badRequest('A claim needs at least one bill against it.');
  if (receipts.length > MAX_RECEIPTS) {
    throw badRequest(`Ten bills at most on one claim. Send the rest as a second claim.`);
  }

  const today = todayIn(timezone);
  const cleaned = receipts.map((r, i) => {
    const amount = round2(num(r.amount, `Bill ${i + 1}`, { required: true, min: 0.01, max: 1_000_000 }));
    const spentOn = isDay(r.spentOn) ? String(r.spentOn) : today;
    if (spentOn > today) throw badRequest(`Bill ${i + 1} is dated in the future.`);
    return {
      amount,
      spentOn,
      what: str(r.what, `What bill ${i + 1} was for`, { max: 200 }),
      file: r.file ?? null,
    };
  });

  const total = claimTotal(cleaned);
  const year = yearOf(cleaned[0].spentOn) ?? Number(today.slice(0, 4));

  // The allowance is checked but never enforced here. Somebody who has run out
  // may still have a bill the property decides to cover, and the app refusing
  // to accept the paperwork is how that conversation moves to WhatsApp.
  const allowance = await ctx.db.prepare(
    'SELECT * FROM hr_medical_allowance WHERE staff_id = ? AND year = ?',
  ).bind(staffId, year).first();
  if (!allowance) {
    throw badRequest('You have no medical allowance set for that year. Ask the office first.');
  }

  const created = await ctx.db.prepare(
    `INSERT INTO hr_medical_claim (staff_id, year, amount, what, status)
     VALUES (?1, ?2, ?3, ?4, 'requested') RETURNING id`,
  ).bind(staffId, year, total, str(body.what, 'What it is for', { max: 300 })).first();

  for (const line of cleaned) {
    let documentId = null;
    if (line.file?.base64) {
      documentId = await storeFile(ctx, staffId, {
        kind: 'medical_receipt',
        title: line.what || `Medical bill ${line.spentOn}`,
        filename: str(line.file.filename, 'File name', { max: 120 }) || 'receipt',
        mime: str(line.file.mime, 'File type', { max: 80 }) || 'image/jpeg',
        bytes: fromBase64(line.file.base64),
        expiresOn: null,
        by: `${staff.name} (staff)`,
      });
    }

    await ctx.db.prepare(
      `INSERT INTO hr_medical_receipt (claim_id, what, amount, spent_on, document_id)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(created.id, line.what, line.amount, line.spentOn, documentId).run();
  }

  await audit(ctx, 'medical.claim', created.id, { year, total, bills: cleaned.length });

  await createNotice(ctx.db, {
    kind: 'medical.claimed',
    level: 'info',
    title: `${staff.name} has claimed ${money(total, currency)} in medical bills`,
    body: `${cleaned.length} bill${cleaned.length === 1 ? '' : 's'}`
      + (body.what ? ` — ${String(body.what).slice(0, 160)}` : '')
      + '. Waiting on a decision.',
    link: '#/att-medical',
    actor: staff.name,
    audience: 'hr_pay',
  }, ctx);

  return json({ ok: true, id: created.id, amount: total, status: 'requested' });
}

/** Take back a claim nobody has decided yet. */
export async function withdrawClaim(ctx, idParam) {
  const staffId = Number(ctx.session.user.staff_id) || 0;
  const id = int(idParam, 'Claim', { required: true, min: 1 });

  const row = await ctx.db.prepare('SELECT * FROM hr_medical_claim WHERE id = ? AND staff_id = ?')
    .bind(id, staffId).first();
  if (!row) throw notFound('That is not one of yours.');
  if (row.status !== 'requested') throw badRequest('That has already been decided.');

  await ctx.db.prepare("UPDATE hr_medical_claim SET status = 'withdrawn' WHERE id = ?")
    .bind(id).run();
  await audit(ctx, 'medical.withdraw', id, {});
  return json({ ok: true });
}

// --------------------------------------------------------------------------

/** Tell the person, where there is an account to tell. */
async function tell(ctx, person, { kind, title, body }) {
  if (!person?.user_id) return;
  await createNotice(ctx.db, {
    kind,
    level: 'info',
    title,
    body,
    link: '#/att-my-medical',
    actor: 'HIVE',
    userId: person.user_id,
    push: true,
    email: false,
  }, ctx);
}

/** Bytes out of what the browser sent, data-URI prefix and all. */
function fromBase64(value) {
  const clean = String(value ?? '').replace(/^data:[^,]*,/, '').replace(/\s/g, '');
  if (!clean) return new Uint8Array(0);
  let binary;
  try {
    binary = atob(clean);
  } catch {
    throw badRequest('That file did not arrive in one piece. Try again.');
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Money, said the way the screens say it. */
const money = (amount, currency = 'GHS') => {
  const n = round2(amount);
  return `${currency} ${n.toLocaleString('en-GB', {
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
};
