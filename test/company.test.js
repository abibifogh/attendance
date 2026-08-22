import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  companyLogo, removeCompanyLogo, setCompanyLogo, updateSettings,
} from '../src/routes/attendance-setup.js';

/**
 * Who the employer is, on paper.
 *
 * Everything here ends up printed on a payslip somebody carries to a bank, so
 * the parts worth testing are the ones that would put a wrong or missing
 * particular on that paper: that the settings save at all, that the logo is a
 * picture and not a PDF, that it comes back as the same bytes, and that taking
 * it off leaves nothing behind for a payslip to point at.
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
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  return { raw, db: d1(raw) };
}

const ADMIN = { user: { id: 2, name: 'Ama', role: 'admin' }, permissions: ['att_setup'] };
const ctx = (db, body = null, method = 'POST') => ({
  db,
  env: {},
  url: new URL('https://x/api/att/company/logo'),
  session: ADMIN,
  executionContext: null,
  request: new Request('https://x/', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  }),
});

const settingOf = (raw, key) => raw.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;

// Four bytes standing in for a picture. Nothing here reads the image itself.
const PICTURE = Buffer.from([1, 2, 3, 4]).toString('base64');

// ---------------------------------------------------------------------------
// The particulars
// ---------------------------------------------------------------------------

test('the company particulars are saved, and blank ones stay blank', async () => {
  const { raw, db } = setup();

  await updateSettings(ctx(db, {
    property_name: 'Somewhere Nice',
    company_legal_name: 'Somewhere Nice Hospitality Limited',
    property_address: 'No. 14 Ridge Crescent\nCantonments, Accra',
    company_phone: '+233 30 254 1180',
    company_email: 'accounts@example.test',
    company_tin: 'C0004829371',
    company_ssnit: 'EMP0092841',
  }));

  assert.equal(settingOf(raw, 'company_legal_name'), 'Somewhere Nice Hospitality Limited');
  assert.equal(settingOf(raw, 'company_tin'), 'C0004829371');
  assert.equal(settingOf(raw, 'company_ssnit'), 'EMP0092841');
  assert.match(settingOf(raw, 'property_address'), /Cantonments/);
  // Never filled in, so a payslip has nothing to print and prints nothing.
  assert.equal(settingOf(raw, 'company_website'), '');
});

test('a particular can be cleared again', async () => {
  const { raw, db } = setup();
  await updateSettings(ctx(db, { property_name: 'Somewhere Nice', company_tin: 'C0004829371' }));
  await updateSettings(ctx(db, { property_name: 'Somewhere Nice', company_tin: '' }));
  assert.equal(settingOf(raw, 'company_tin') ?? '', '');
});

// ---------------------------------------------------------------------------
// The logo
// ---------------------------------------------------------------------------

test('a logo is stored once and stamped, so a stale one is asked for again', async () => {
  const { raw, db } = setup();
  assert.equal(settingOf(raw, 'company_logo_at'), '');

  const first = await (await setCompanyLogo(ctx(db, {
    content: PICTURE, mime: 'image/png',
  }))).json();
  assert.equal(first.ok, true);
  assert.ok(first.at, 'and it says when');
  assert.equal(settingOf(raw, 'company_logo_at'), first.at);

  // Replacing it leaves one row, not two.
  await setCompanyLogo(ctx(db, { content: PICTURE, mime: 'image/jpeg' }));
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM company_logo').get().n, 1);
  assert.equal(raw.prepare('SELECT mime FROM company_logo WHERE id = 1').get().mime, 'image/jpeg');
});

test('the picture comes back as the picture that went in', async () => {
  const { db } = setup();
  await setCompanyLogo(ctx(db, { content: PICTURE, mime: 'image/png' }));

  const out = await companyLogo(ctx(db, null, 'GET'));
  assert.equal(out.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(
    Buffer.from(await out.arrayBuffer()),
    Buffer.from(PICTURE, 'base64'),
  );
});

test('a PDF is not a logo', async () => {
  const { db } = setup();
  await assert.rejects(
    setCompanyLogo(ctx(db, { content: PICTURE, mime: 'application/pdf' })),
    /picture/,
  );
});

test('nothing in the picture is nothing to store', async () => {
  const { db } = setup();
  await assert.rejects(setCompanyLogo(ctx(db, { content: '', mime: 'image/png' })), /nothing/);
});

test('a picture too big for a logo is refused with the size in it', async () => {
  const { db } = setup();
  const huge = Buffer.alloc(700_000, 7).toString('base64');
  await assert.rejects(
    setCompanyLogo(ctx(db, { content: huge, mime: 'image/png' })),
    /700 KB and the limit is 600 KB/,
  );
});

test('taking the logo off leaves nothing for a payslip to point at', async () => {
  const { raw, db } = setup();
  await setCompanyLogo(ctx(db, { content: PICTURE, mime: 'image/png' }));
  await removeCompanyLogo(ctx(db, null, 'DELETE'));

  assert.equal(settingOf(raw, 'company_logo_at'), '');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM company_logo').get().n, 0);
  await assert.rejects(companyLogo(ctx(db, null, 'GET')), /No logo/);
});
