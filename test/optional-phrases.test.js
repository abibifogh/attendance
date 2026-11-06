import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate } from '../src/lib/people.js';

/** Details not known yet leave their phrase out whole. Made-up people only. */

const PARTY = '{{name}} of {{address}}, holder of {{id_type}} number {{id_number}}, employee number {{employee_no}} (hereinafter referred to as the "Employee") of the other part.';
const ALL = { name: 'Kwame Asare', address: '1 Test Street', id_type: 'Ghana Card', id_number: 'GHA-000000000-0', employee_no: 'T01' };

test('with everything known, the sentence is exactly as written', () => {
  assert.equal(renderTemplate(PARTY, ALL),
    'Kwame Asare of 1 Test Street, holder of Ghana Card number GHA-000000000-0, employee number T01 (hereinafter referred to as the "Employee") of the other part.');
});

test('a missing ID, address or employee number takes its whole phrase with it, and the sentence still reads', () => {
  assert.equal(renderTemplate(PARTY, { ...ALL, id_type: '', id_number: '' }),
    'Kwame Asare of 1 Test Street, employee number T01 (hereinafter referred to as the "Employee") of the other part.');
  assert.equal(renderTemplate(PARTY, { ...ALL, id_number: '' }),
    'Kwame Asare of 1 Test Street, employee number T01 (hereinafter referred to as the "Employee") of the other part.',
    'a type without its number is not half a phrase');
  assert.equal(renderTemplate(PARTY, { ...ALL, address: '' }),
    'Kwame Asare, holder of Ghana Card number GHA-000000000-0, employee number T01 (hereinafter referred to as the "Employee") of the other part.');
  assert.equal(renderTemplate(PARTY, { name: 'Kwame Asare' }),
    'Kwame Asare (hereinafter referred to as the "Employee") of the other part.');
  assert.doesNotMatch(renderTemplate(PARTY, { name: 'Kwame Asare' }), /to be given|⟨|,\s*,|\s,/);
});

test('a comma the template put before "(hereinafter" does not dangle once what stood before it goes', () => {
  const t = '{{name}} of {{address}}, holder of {{id_type}} number {{id_number}}, (hereinafter "Employee").';
  assert.equal(renderTemplate(t, { name: 'Kwame Asare', address: '1 Test Street' }), 'Kwame Asare of 1 Test Street (hereinafter "Employee").');
  assert.equal(renderTemplate(t, ALL), 'Kwame Asare of 1 Test Street, holder of Ghana Card number GHA-000000000-0, (hereinafter "Employee").', 'as written when known');
});

test('[[ ]] marks any other optional words; formatted text stays formatted and escaped', () => {
  assert.equal(renderTemplate('Paid monthly[[, with an allowance of {{allowance}}]].', {}), 'Paid monthly.');
  assert.equal(renderTemplate('Paid monthly[[, with an allowance of {{allowance}}]].', { allowance: 'GHS 50' }), 'Paid monthly, with an allowance of GHS 50.');
  assert.equal(
    renderTemplate('<!--rich--><p><strong>{{name}}</strong> of {{address}}, holder of {{id_type}} number {{id_number}}.</p>', { name: 'A & B', address: 'X' }),
    '<!--rich--><p><strong>A &amp; B</strong> of X.</p>');
  assert.equal(renderTemplate('<!--rich--><p>[[Open {{x}}</p><p>never closed</p>', {}), '<!--rich--><p>[[Open ⟨x⟩</p><p>never closed</p>'.replace('⟨x⟩', '{{x}}'), 'an unclosed [[ eats nothing');
});

// ---------------------------------------------------------------------------
// Template versions: kept, and a save over a newer one refused.
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { restoreTemplateVersion, saveTemplate, templateVersions } from '../src/routes/people.js';

function d1(db) {
  const st = (sql, binds = []) => ({
    bind(...a) { return st(sql, a); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() { const r = db.prepare(sql).run(...binds); return { success: true, meta: { changes: Number(r.changes ?? 0) } }; },
  });
  return { prepare: (sql) => st(sql), async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; } };
}
const ctxFor = (db, body) => ({
  db, env: {}, url: new URL('https://x/'),
  session: { user: { id: 1, name: 'Office', role: 'admin' }, permissions: ['hr_manage'] },
  request: new Request('https://x/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
});

test('every save is kept; a save made over a newer version is refused; an old one can be put back', async () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  raw.exec("DELETE FROM hr_template; INSERT INTO hr_template (id, name, kind, body, version) VALUES (9, 'Letter', 'correspondence', 'Dear {{name}}', 1)");
  const db = d1(raw);
  await saveTemplate(ctxFor(db, { name: 'Letter', kind: 'correspondence', body: 'Dear {{name}}, welcome.', version: 1 }), 9);
  // A second tab, still on version 1, tries to save its older words.
  await assert.rejects(saveTemplate(ctxFor(db, { name: 'Letter', kind: 'correspondence', body: 'Dear {{name}}, hello.', version: 1 }), 9),
    /saved again after you opened it \(now version 2, by Office/);
  assert.equal(raw.prepare('SELECT body FROM hr_template WHERE id = 9').get().body, 'Dear {{name}}, welcome.');
  const { rows } = await (await templateVersions(ctxFor(db), 9)).json();
  assert.deepEqual(rows.map((r) => r.version), [2]);
  // And the first one put back.
  raw.exec("INSERT INTO hr_template_rev (template_id, version, name, body, saved_by) VALUES (9, 1, 'Letter', 'Dear {{name}}', 'As it stood')");
  const first = raw.prepare("SELECT id FROM hr_template_rev WHERE version = 1").get().id;
  const out = await (await restoreTemplateVersion(ctxFor(db), 9, first)).json();
  assert.equal(out.version, 3);
  assert.equal(raw.prepare('SELECT body FROM hr_template WHERE id = 9').get().body, 'Dear {{name}}');
});
