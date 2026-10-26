import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { issueContract, previewTemplate } from '../src/routes/people.js';
import { PLACEHOLDERS, placeholdersIn } from '../src/lib/people.js';
import { flowParagraphs } from '../public/js/contract-flow.js';

/**
 * The cook's contract for Abibifo crafts and More: added by a migration,
 * belonging to that company, and filled in with its name and address.
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
  return { prepare: (sql) => st(sql), async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; } };
}

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM att_staff');
  const abibifo = raw.prepare("SELECT id FROM company WHERE legal_name LIKE 'Abibifo%'").get().id;
  raw.prepare("UPDATE company SET address = '2 Example Lane, Accra' WHERE id = ?").run(abibifo);
  raw.prepare(`INSERT INTO att_staff (id, employee_no, name, department, job_title, hired_on, company_id)
               VALUES (1, 'AB01', 'Kojo Example', 'Kitchen', 'Cook', '2026-11-02', ?),
                      (2, 'SN01', 'Esi Example', 'Front office', 'Receptionist', '2026-11-02', NULL)`).run(abibifo);
  return { raw, db: d1(raw), abibifo };
}

const ctx = (db, body = null) => ({
  db,
  env: {},
  url: new URL('https://staff.example.com/api/hr'),
  session: { user: { id: 1, name: 'Office', role: 'admin' }, permissions: ['hr_view', 'hr_manage'] },
  request: new Request('https://x/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
});

test('the cook’s contract is there, for Abibifo crafts and More only', () => {
  const { raw, abibifo } = setup();
  const t = raw.prepare("SELECT * FROM hr_template WHERE code = 'contract_cook_abibifo'").get();
  assert.ok(t, 'the migration added it');
  assert.equal(t.name, "Cook's contract of employment");
  assert.equal(t.kind, 'contract');
  assert.equal(t.satisfies, 'contract');
  assert.equal(t.company_id, abibifo);
  assert.equal(t.active, 1);
});

test('every placeholder in it is one HIVE knows, and it reads without he or she', () => {
  const { raw } = setup();
  const t = raw.prepare("SELECT body FROM hr_template WHERE code = 'contract_cook_abibifo'").get();
  const used = [...t.body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]);
  const known = new Set(PLACEHOLDERS.map((p) => p.key));
  for (const key of used) assert.ok(known.has(key), `{{${key}}} is a known placeholder`);
  assert.ok(placeholdersIn(t.body).some((p) => p.key === 'company_address'));
  assert.doesNotMatch(t.body, /\b(he|she|his|her|him|hers)\b/i);
  const words = (s) => s.split(/\s+/).filter(Boolean);
  assert.deepEqual(words(flowParagraphs(t.body).join('\n')), words(t.body), 'it reflows without losing a word');
});

test('issued to their cook it names Abibifo crafts and More and its address; the hotel’s staff cannot be given it', async () => {
  const { raw, db } = setup();
  const t = raw.prepare("SELECT id FROM hr_template WHERE code = 'contract_cook_abibifo'").get();
  const out = await (await issueContract(ctx(db, { templateId: t.id, values: { salary: 'GH₵ [test amount] a month' } }), 1)).json();
  const body = raw.prepare('SELECT body FROM hr_contract WHERE id = ?').get(out.id).body;
  assert.match(body, /employment of Kojo Example of .*employee number AB01/s);
  assert.match(body, /by Abibifo crafts and More, a\s+company/);
  assert.match(body, /place of business at 2 Example Lane, Accra/);
  assert.match(body, /as a cook, with the job title\s+Cook, in the Kitchen department/);
  assert.match(body, /GH₵ \[test amount\] a month/);
  await assert.rejects(issueContract(ctx(db, { templateId: t.id }), 2), /is for Abibifo crafts and More/);

  const preview = await (await previewTemplate(ctx(db, { templateId: t.id }))).json();
  assert.match(preview.body, /by Abibifo crafts and More/);
  assert.match(preview.body, /\[Remuneration: typed in when it is issued\]/);
});
