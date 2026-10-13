import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { crc32, deflateSync } from 'node:zlib';

import { buildVoucher, claimRef } from '../src/lib/medical-voucher.js';
import { claim, decideClaim, markPaid, medical, setAllowances } from '../src/routes/medical.js';

/**
 * Paying an approved medical claim.
 *
 * Approving a claim sends whoever pays it an email with a PDF voucher and
 * every receipt, one to a page, paid in cash. Then the office marks it paid.
 * Made-up people only.
 */

function d1(db) {
  const st = (sql, binds = []) => ({
    bind(...a) { return st(sql, a); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() {
      const r = db.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(r.changes ?? 0) } };
    },
  });
  return {
    prepare: (sql) => st(sql),
    async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; },
  };
}

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM att_staff; DELETE FROM users; DELETE FROM app_notices;');
  for (const [key, value] of [
    ['timezone', 'UTC'], ['currency', 'GHS'], ['property_name', 'Test Lodge'],
    ['email_from', 'hive@example.com'], ['site_url', 'https://staff.example.com'],
  ]) {
    raw.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?2')
      .run(key, value);
  }
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Kofi Mensah', 'Kitchen', '2020-01-01')`,
  ).run();
  raw.prepare(
    "INSERT INTO users (id, name, role, pin_hash, staff_id, active) VALUES (7, 'Kofi', 'staff', 'x', 1, 1)",
  ).run();
  return { raw, db: d1(raw) };
}

const KOFI = { user: { id: 7, name: 'Kofi Mensah', role: 'staff', staff_id: 1 }, permissions: ['att_me'] };
const WAGES = { user: { id: 3, name: 'Yaa Owusu', role: 'admin' }, permissions: ['hr_pay'] };

const ctx = (db, session, { body = null, env = { RESEND_API_KEY: 'k' } } = {}) => ({
  db,
  env,
  url: new URL('https://x/api/medical'),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});
const read = async (response) => response.json();

// A real 2 by 2 photo with transparency, the kind a phone screenshot is.
function png() {
  const chunk = (name, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(name), data])));
    return Buffer.concat([len, Buffer.from(name), data, crc]);
  };
  const ihdr = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
  const rows = Buffer.from([0, 255, 0, 0, 255, 0, 0, 255, 128, 0, 0, 0, 0, 0, 255, 255, 255, 64]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const PIXEL = png().toString('base64');
const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const pic = (base64, mime, filename) => ({ base64, mime, filename });
const today = new Date().toISOString().slice(0, 10);
const YEAR = Number(today.slice(0, 4));

function catching() {
  const real = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { sent, restore: () => { globalThis.fetch = real; } };
}
const messagesIn = (call) => (Array.isArray(call.body) ? call.body : [call.body]);
const toPay = (sent) => sent.flatMap(messagesIn).filter((m) => /Please pay/.test(m.subject));

async function claimed(db) {
  await setAllowances(ctx(db, WAGES, { body: { year: YEAR, rows: [{ staffId: 1, qualifies: true, allowance: 1000 }] } }));
  const out = await read(await claim(ctx(db, KOFI, {
    body: {
      receipts: [
        { amount: 220, spentOn: today, what: 'Clinic visit', files: [pic(PIXEL, 'image/png', 'clinic.png')] },
        { amount: 120, spentOn: today, what: 'Pharmacy', files: [pic(GIF, 'image/gif', 'pharmacy.gif')] },
      ],
    },
  })));
  return out.id;
}

test('approving a claim sends finance the voucher, paid in cash, copied to michael', async () => {
  const { raw, db } = setup();
  const id = await claimed(db);

  const mail = catching();
  try {
    await decideClaim(ctx(db, WAGES, { body: { approve: true } }), id);
  } finally { mail.restore(); }

  const [m, ...more] = toPay(mail.sent);
  assert.ok(m, 'an email to pay it went out');
  assert.equal(more.length, 0, 'and only one');
  assert.deepEqual(m.to, ['info@hostelaccra.com']);
  assert.deepEqual(m.cc, ['michael@hostelaccra.com']);
  assert.match(m.subject, /Please pay Kofi Mensah GHS 340\.00 · medical claim MC-\d{4}/);
  assert.match(m.html, /Cash/);
  assert.doesNotMatch(m.html, /\b(he|she|his|her)\b/i);

  const [pdf, gif] = m.attachments;
  assert.match(pdf.filename, /^Medical claim MC-\d{4} - Kofi Mensah\.pdf$/);
  assert.equal(Buffer.from(pdf.content, 'base64').subarray(0, 5).toString(), '%PDF-');
  assert.match(gif.filename, /receipt 2 - pharmacy\.gif$/, 'a picture a PDF cannot hold goes as its own file');

  const row = raw.prepare('SELECT sent_to_pay_at, paid_at FROM hr_medical_claim WHERE id = ?').get(id);
  assert.ok(row.sent_to_pay_at);
  assert.equal(row.paid_at, null);
});

test('no email provider means no voucher, but the approval still stands', async () => {
  const { raw, db } = setup();
  const id = await claimed(db);
  const out = await read(await decideClaim(ctx(db, WAGES, { body: { approve: true }, env: {} }), id));
  assert.equal(out.status, 'approved');
  assert.equal(raw.prepare('SELECT sent_to_pay_at FROM hr_medical_claim WHERE id = ?').get(id).sent_to_pay_at, null);
});

test('an approved claim is marked paid, and that can be taken back', async () => {
  const { raw, db } = setup();
  const id = await claimed(db);
  await assert.rejects(() => markPaid(ctx(db, WAGES), id), /Only an approved claim/);

  const mail = catching();
  try { await decideClaim(ctx(db, WAGES, { body: { approve: true } }), id); } finally { mail.restore(); }

  await markPaid(ctx(db, WAGES, { body: { note: 'Paid from petty cash' } }), id);
  let row = raw.prepare('SELECT paid_at, paid_by, paid_note FROM hr_medical_claim WHERE id = ?').get(id);
  assert.ok(row.paid_at);
  assert.match(row.paid_by, /Yaa Owusu/);
  assert.equal(row.paid_note, 'Paid from petty cash');
  await assert.rejects(() => markPaid(ctx(db, WAGES), id), /already marked as paid/);

  const list = await read(await medical(ctx(db, WAGES)));
  const shown = JSON.stringify(list);
  assert.match(shown, /"paidAt":"\d{4}-/);

  await markPaid(ctx(db, WAGES, { body: { paid: false } }), id);
  row = raw.prepare('SELECT paid_at, paid_by FROM hr_medical_claim WHERE id = ?').get(id);
  assert.equal(row.paid_at, null);
  assert.equal(row.paid_by, null);
});

test('the voucher gives every receipt picture its own page', async () => {
  const png = Buffer.from(PIXEL, 'base64');
  const out = await buildVoucher({
    claim: { id: 42, amount: 340, approved: 300, decided_by: 'Yaa Owusu', decided_at: '2026-10-12 10:14:00', asked_at: '2026-10-09', year: 2026 },
    staff: { name: 'Kofi Mensah', employee_no: '1', department: 'Kitchen' },
    money: (n) => `GHS ${Number(n).toFixed(2)}`,
    property: 'Test Lodge',
    receipts: [
      { what: 'Clinic', amount: 220, spent_on: '2026-10-02', files: [{ bytes: png, mime: 'image/png', filename: 'a.png' }, { bytes: png, mime: 'image/png', filename: 'b.png' }] },
      { what: 'Pharmacy', amount: 120, spent_on: '2026-10-03', files: [{ bytes: Buffer.from('%PDF-1.4 x'), mime: 'application/pdf', filename: 'c.pdf' }] },
    ],
    allowance: { allowance: 1000, paidBefore: 0, left: 700 },
    generatedAt: '2026-10-12 10:14:00',
  });
  assert.equal(claimRef(42), 'MC-0042');
  assert.equal(out.pages, 4, 'the voucher, then three receipts');
  assert.deepEqual(out.separate.map((f) => f.filename), ['c.pdf']);
  const text = Buffer.from(out.bytes).toString('latin1');
  assert.equal((text.match(/\/Type\s*\/Page\b/g) ?? []).length, 4);
  assert.match(text, /Pay by cash/);
});
