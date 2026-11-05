import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument } from 'pdf-lib';

import {
  RICH, cleanColor, isRich, plainToRich, richBlocks, richToPlain, sanitizeRich,
} from '../src/lib/rich-text.js';
import { issueContract, listTemplates, saveTemplate } from '../src/routes/people.js';
import { renderTemplate, hashBody } from '../src/lib/people.js';
import { contractPdf } from '../src/lib/signed-pdf.js';
import { PERMANENT_CONTRACT } from '../src/lib/contract-texts.js';

/** Contract templates written with formatting. Made-up people only. */

function d1(db) {
  const st = (sql, binds = []) => ({
    bind(...a) { return st(sql, a); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() {
      const r = db.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
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
  raw.exec('DELETE FROM att_staff; DELETE FROM hr_template;');
  raw.prepare(`INSERT INTO att_staff (id, employee_no, name, department, job_title, hired_on)
               VALUES (1, 'T01', 'Kwame Asare', 'Front office', 'Front office agent', '2026-12-02')`).run();
  return { raw, db: d1(raw) };
}

const ctx = (db, body = null, perms = ['hr_view', 'hr_manage']) => ({
  db,
  env: {},
  url: new URL('https://staff.example.com/api/hr'),
  session: { user: { id: 1, name: 'Office', role: 'manager' }, permissions: perms },
  request: new Request('https://x/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
});
const read = async (res) => res.json();

test('only the allowed tags and styles survive; scripts and handlers never do', () => {
  const out = sanitizeRich(`<div style="color: rgb(124, 45, 18); position: fixed">Hi <b onclick="steal()">there</b>
    <script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:x">link</a>
    <font color="#00f" face="Courier New">mono</font><span style="font-size: 16px; font-weight: 700">big</span></div><hr>`);
  assert.ok(out.startsWith(RICH));
  assert.doesNotMatch(out, /script|onerror|onclick|javascript|position|<img|<a /i);
  assert.match(out, /<p style="color: #7c2d12">Hi <strong>there<\/strong>/);
  assert.match(out, /font-family: 'Courier New'/);
  assert.match(out, /font-size: 12pt; font-weight: bold/);
  assert.match(out, /<hr class="page-break">/);
  assert.match(out, /link/, 'the words of a dropped tag are kept');
  assert.equal(sanitizeRich(out), out, 'cleaning twice changes nothing');
});

test('a colour code is accepted in any of the usual forms', () => {
  assert.equal(cleanColor('#1E3A8A'), '#1e3a8a');
  assert.equal(cleanColor('#abc'), '#aabbcc');
  assert.equal(cleanColor('rgb(30, 58, 138)'), '#1e3a8a');
  assert.equal(cleanColor('blue; background:url(x)'), null);
});

test('today’s plain contract is laid out: a title, headings, bold leading words, indented sub-clauses', () => {
  const rich = plainToRich(PERMANENT_CONTRACT);
  assert.match(rich, /^<!--rich--><h1 style="text-align: center">CONTRACT OF EMPLOYMENT<\/h1>/);
  assert.match(rich, /<h2>5\. REMUNERATION, BONUS AND DEDUCTIONS<\/h2>/);
  assert.match(rich, /<p><strong>WHEREAS,<\/strong> the Employer carries on/);
  assert.match(rich, /<p style="text-align: center"><strong>BETWEEN<\/strong><\/p>/);
  // A hard-wrapped clause is one paragraph again, and (a) to (d) sit in.
  assert.match(rich, /<p>5\.1 In consideration of the services rendered hereunder, the Employer shall pay the Employee/);
  assert.match(rich, /<p style="margin-left: 2em">\(c\) the late arrival charge set out in the Handbook/);
  // Not a word lost.
  const words = (s) => s.replace(/[─]+/g, ' ').split(/\s+/).filter(Boolean);
  assert.deepEqual(words(richToPlain(rich)), words(PERMANENT_CONTRACT));
});

test('values are written in as text, never as markup', () => {
  const body = sanitizeRich('<p>Pay: {{salary}}</p>');
  const out = renderTemplate(body, { salary: 'GHS 2,400 <script>x</script> & more' });
  assert.match(out, /Pay: GHS 2,400 &lt;script&gt;x&lt;\/script&gt; &amp; more/);
  assert.equal(renderTemplate('Pay: {{salary}}', { salary: 'A & B' }), 'Pay: A & B', 'plain words are left plain');
});

test('listing converts contracts once, leaves letter templates plain, and saving cleans and counts versions', async () => {
  const { raw, db } = setup();
  raw.exec(`INSERT INTO hr_template (id, name, kind, body) VALUES
    (1, 'Contract of employment', 'contract', 'CONTRACT OF EMPLOYMENT\n\n1. TERM\n\n1.1 {{name}} starts on {{start_date}}.'),
    (2, 'General letter', 'correspondence', 'Dear {{name}},\n\nThank you.')`);
  const listed = await read(await listTemplates(ctx(db)));
  const c = listed.rows.find((t) => t.id === 1);
  const l = listed.rows.find((t) => t.id === 2);
  assert.equal(c.rich, true);
  assert.equal(c.version, 2);
  assert.match(c.body, /<h2>1\. TERM<\/h2>/);
  assert.equal(l.rich, false, 'a letter template is left as it is');
  assert.equal((await read(await listTemplates(ctx(db)))).rows.find((t) => t.id === 1).version, 2, 'once');

  // Read-only office: nothing is changed by looking.
  raw.exec("INSERT INTO hr_template (id, name, kind, body) VALUES (3, 'Policy', 'policy', 'A RULE')");
  await listTemplates(ctx(db, null, ['hr_view']));
  assert.equal(isRich(raw.prepare('SELECT body FROM hr_template WHERE id = 3').get().body), false);

  await saveTemplate(ctx(db, { name: 'Contract of employment', kind: 'contract', body: `${RICH}<h2 style="color: #1E3A8A" onclick="x()">1. TERM</h2><p>{{name}} starts on {{start_date}}.</p><script>bad()</script>` }), 1);
  const saved = raw.prepare('SELECT body, version FROM hr_template WHERE id = 1').get();
  assert.equal(saved.version, 3);
  assert.equal(saved.body, `${RICH}<h2 style="color: #1e3a8a">1. TERM</h2><p>{{name}} starts on {{start_date}}.</p>`);
  await saveTemplate(ctx(db, { name: 'Contract of employment', kind: 'contract', body: saved.body }), 1);
  assert.equal(raw.prepare('SELECT version FROM hr_template WHERE id = 1').get().version, 3, 'saving the same words is not a new version');

  // A letter template given formatting keeps only its words.
  await saveTemplate(ctx(db, { name: 'General letter', kind: 'correspondence', body: `${RICH}<p><strong>Dear</strong> {{name}},</p>` }), 2);
  assert.equal(raw.prepare('SELECT body FROM hr_template WHERE id = 2').get().body, 'Dear {{name}},');

  // Issued: the formatting is in the frozen, fingerprinted words.
  const out = await read(await issueContract(ctx(db, { templateId: 1 }), 1));
  const row = raw.prepare('SELECT body, body_hash FROM hr_contract WHERE id = ?').get(out.id);
  assert.equal(row.body, `${RICH}<h2 style="color: #1e3a8a">1. TERM</h2><p>Kwame Asare starts on 2026-12-02.</p>`);
  assert.equal(row.body_hash, await hashBody(row.body));
});

test('the signed PDF draws formatted words, page breaks and all', async () => {
  const body = sanitizeRich(`<h1 style="text-align: center">CONTRACT</h1><p style="text-align: justify">${'Words that go on and on. '.repeat(40)}</p>
    <p><span style="color: #9f1239; font-family: Arial; font-size: 12pt"><u>Underlined in red</u></span> and <em>italic</em>.</p>
    <hr><h2>2. AFTER THE BREAK</h2><ol><li>One</li><li>Two</li></ol>`);
  const blocks = richBlocks(body);
  assert.deepEqual(blocks.map((b) => b.tag), ['h1', 'p', 'p', 'hr', 'h2', 'li', 'li']);
  assert.deepEqual(blocks.slice(-2).map((b) => b.marker), ['1.', '2.']);
  assert.deepEqual(blocks[2].runs[0], { text: 'Underlined in red', color: '#9f1239', font: 'sans', size: 12, underline: true });
  const bytes = await contractPdf({
    contract: { title: 'Contract', staff_name: 'Kwame Asare', body, body_hash: 'ab'.repeat(32), signer_name: 'Kwame Asare', signed_at: '2026-11-04 10:00:00' },
    events: [], property: 'Somewhere Nice', reference: 'HR-C-00001', verifyUrl: 'https://x/verify',
  });
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() >= 3, 'the words, then the page break onto a second page, then the certificate');
});

test('a contract names the ID document by its kind and its number', async () => {
  const { raw, db } = setup();
  raw.prepare(`INSERT INTO hr_profile (staff_id, id_type, id_number, address_line, town)
               VALUES (1, 'Ghana Card', 'GHA-000000000-0', '1 Test Street', 'Accra')`).run();
  raw.exec("INSERT INTO hr_template (id, name, kind, body) VALUES (1, 'Contract', 'contract', '{{name}} of {{address}}, holder of {{id_type}} number {{id_number}}.')");
  const out = await read(await issueContract(ctx(db, { templateId: 1 }), 1));
  const body = raw.prepare('SELECT body FROM hr_contract WHERE id = ?').get(out.id).body;
  assert.equal(body, 'Kwame Asare of 1 Test Street, Accra, holder of Ghana Card number GHA-000000000-0.');
});
