import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument } from 'pdf-lib';

import { getPepper, hashPin } from '../src/lib/auth.js';
import { liveTurn } from '../src/lib/correspondence.js';
import {
  createDoc, deleteDoc, getDoc, remindNow, saveDoc, sendDoc, signInHive, toSign,
} from '../src/routes/sign-prep.js';
import {
  signDecline, signDocument, signFile, signHead, signOpen, signRequestCode, signVerify,
} from '../src/routes/sign.js';

/**
 * A document prepared in three steps: who signs and in what order, boxes on
 * the pages for each of them, checks before it goes, a code before anybody
 * sees it, and the property taking its turn in the order.
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

async function setup({ mail = false } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM users;');
  raw.prepare("INSERT INTO settings (key, value) VALUES ('property_name', 'Somewhere Nice') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
  const db = d1(raw);
  const pepper = await getPepper(db);
  raw.prepare("INSERT INTO users (id, name, role, pin_hash, active) VALUES (9, 'Efua Office', 'manager', ?, 1)")
    .run(await hashPin('246810', pepper));
  raw.prepare("INSERT INTO users (id, name, role, pin_hash, active) VALUES (12, 'Yaw Staff', 'staff', ?, 1)")
    .run(await hashPin('135791', pepper));
  if (mail) {
    raw.prepare("INSERT INTO settings (key, value) VALUES ('email_from', 'hive@example.com') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
  }
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response('{"id":"x"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { raw, db, sent, restore: () => { globalThis.fetch = real; } };
}

const OFFICE = {
  user: { id: 9, name: 'Efua Office', role: 'manager' },
  permissions: ['corr_view', 'corr_write', 'corr_sign'],
};
const STAFF = { user: { id: 12, name: 'Yaw Staff', role: 'staff' }, permissions: ['att_me'] };

function ctx(db, session, body = null, { env = {}, headers = {}, method } = {}) {
  return {
    db,
    env,
    url: new URL('https://staff.example.com/api/x'),
    session,
    executionContext: null,
    request: new Request('https://staff.example.com/api/x', {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }),
  };
}
const read = (r) => r.json();
const tokenOf = (url) => String(url).split('/').pop();

async function aPdf() {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  doc.addPage([595, 842]);
  return Buffer.from(await doc.save()).toString('base64');
}

async function aDraft(db) {
  const made = await read(await createDoc(ctx(db, OFFICE, {
    title: 'Supplier agreement: laundry',
    content: await aPdf(),
    filename: 'laundry.pdf',
    mime: 'application/pdf',
    // A [sign:1] typed in the PDF, found by the browser.
    fields: [{ page: 2, x: 10, y: 60, w: 28, h: 6, signer: 1, field: 'signature' }],
  })));
  return made.id;
}

const PEOPLE = [
  { kind: 'email', name: 'Kwame Asante', email: 'info@cleanline.example', step: 1, capacity: 'Director' },
  { kind: 'text', name: 'Abena Ofori', phone: '0240004417', step: 2, capacity: 'Witness' },
  { kind: 'property', step: 3, capacity: 'General manager' },
  { kind: 'email', role: 'copy', name: 'Accounts', email: 'accounts@cleanline.example' },
];

test('whose turn: the same number signs together, and the property takes its place in the order', () => {
  const people = [
    { id: 1, seq: 1, step: 1, role: 'signer', status: 'pending' },
    { id: 2, seq: 2, step: 1, role: 'signer', status: 'pending' },
    { id: 3, seq: 3, step: 3, role: 'signer', status: 'pending' },
  ];
  const letter = { property_step: 2, signed_at: null };
  assert.deepEqual(liveTurn(people, 'order', letter).signers.map((r) => r.id), [1, 2]);
  people[0].status = 'signed';
  people[1].status = 'signed';
  const next = liveTurn(people, 'order', letter);
  assert.equal(next.property, true);
  assert.deepEqual(next.signers, [], 'the third waits for the property');
  letter.signed_at = '2026-10-19 10:00:00';
  assert.deepEqual(liveTurn(people, 'order', letter).signers.map((r) => r.id), [3]);
  // A letter from before order numbers: one at a time, as it always was.
  const old = [{ id: 7, seq: 1, role: 'signer', status: 'pending' }, { id: 8, seq: 2, role: 'signer', status: 'pending' }];
  assert.deepEqual(liveTurn(old, 'order', {}).signers.map((r) => r.id), [7]);
});

test('preparing: a marker follows its person, and the checks say what is missing', async () => {
  const { raw, db, restore } = await setup();
  try {
    const id = await aDraft(db);
    let doc = await read(await saveDoc(ctx(db, OFFICE, { signers: PEOPLE, inOrder: true }, { method: 'PUT' }), id));
    const kwame = doc.signers.find((s) => s.name === 'Kwame Asante');
    assert.equal(doc.fields[0].rid, kwame.id, 'the [sign:1] in the PDF is Kwame’s');
    assert.equal(doc.signers.find((s) => s.kind === 'property').step, 3);

    const bad = doc.checks.filter((c) => c.tone === 'bad').map((c) => c.text);
    assert.ok(bad.includes('Abena Ofori has no signature box yet.'));
    assert.ok(bad.some((t) => /Somewhere Nice has no signature box|has no signature box/.test(t)));
    assert.ok(doc.checks.some((c) => c.tone === 'warn' && /shared inbox/.test(c.text)));
    await assert.rejects(sendDoc(ctx(db, OFFICE, {}), id), /no signature box/);

    const abena = doc.signers.find((s) => s.name === 'Abena Ofori');
    doc = await read(await saveDoc(ctx(db, OFFICE, {
      fields: [
        ...doc.fields,
        { id: 'd1', page: 2, x: 50, y: 61, w: 20, h: 4, field: 'date', rid: kwame.id },
        { id: 'a1', page: 2, x: 10, y: 72, w: 28, h: 6, field: 'signature', rid: abena.id },
        { id: 'p1', page: 2, x: 10, y: 84, w: 28, h: 6, field: 'signature', rid: 'property' },
        { id: 'p2', page: 2, x: 50, y: 84, w: 30, h: 4, field: 'text', rid: 'property', ask: 'Room block' },
      ],
    }, { method: 'PUT' }), id));
    assert.equal(doc.checks.filter((c) => c.tone === 'bad').length, 0, JSON.stringify(doc.checks));
    assert.ok(doc.checks.some((c) => c.text === 'Somewhere Nice signs last, once the others have.'));

    // Kwame taken off: his boxes go, and Abena's boxes stay hers.
    doc = await read(await saveDoc(ctx(db, OFFICE, {
      signers: doc.signers.filter((s) => s.name !== 'Kwame Asante').map((s) => ({ ...s })),
      inOrder: true,
    }, { method: 'PUT' }), id));
    const mine = doc.fields.filter((f) => f.rid === abena.id);
    assert.equal(mine.length, 1);
    assert.equal(doc.fields.filter((f) => f.field === 'date').length, 0, 'his date box went with him');

    await deleteDoc(ctx(db, OFFICE, null, { method: 'DELETE' }), id);
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM corr_letter').get().n, 0);
  } finally { restore(); }
});

async function readyToSend(db) {
  const id = await aDraft(db);
  let doc = await read(await saveDoc(ctx(db, OFFICE, { signers: PEOPLE, inOrder: true }, { method: 'PUT' }), id));
  const kwame = doc.signers.find((s) => s.name === 'Kwame Asante');
  const abena = doc.signers.find((s) => s.name === 'Abena Ofori');
  doc = await read(await saveDoc(ctx(db, OFFICE, {
    fields: [
      ...doc.fields,
      { id: 'n1', page: 2, x: 50, y: 61, w: 30, h: 4, field: 'name', rid: kwame.id },
      { id: 'c1', page: 2, x: 50, y: 66, w: 3, h: 2, field: 'checkbox', rid: kwame.id, ask: 'I have read the price list', required: true },
      { id: 'a1', page: 2, x: 10, y: 72, w: 28, h: 6, field: 'signature', rid: abena.id },
      { id: 'p1', page: 2, x: 10, y: 84, w: 28, h: 6, field: 'signature', rid: 'property' },
    ],
    mailSubject: 'Somewhere Nice: please sign the laundry agreement',
    remindDays: 3,
    expireDays: 30,
  }, { method: 'PUT' }), id));
  return { id, kwame, abena };
}

const INK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('sent with no email set up: the link comes back to pass on, and signing goes in order to the property', async () => {
  const { raw, db, restore } = await setup();
  try {
    const { id } = await readyToSend(db);
    const out = await read(await sendDoc(ctx(db, OFFICE, {}), id));
    assert.equal(out.handBack.length, 1, 'only Kwame is live, and HIVE cannot email him');
    assert.equal(out.handBack[0].name, 'Kwame Asante');
    const token = tokenOf(out.handBack[0].url);

    // Before the code (none can be sent here, so agreeing is the step), nothing of the document.
    const head = await read(await signHead(ctx(db, null), token));
    assert.equal(head.flow, 'v2');
    assert.equal(head.needsCode, false);
    assert.equal(head.fields, undefined);
    await assert.rejects(signOpen(ctx(db, null, {}), token), /code first/);
    await assert.rejects(signFile(ctx(db, null), token), /code first/);

    const { grant } = await read(await signVerify(ctx(db, null, { agreed: true }), token));
    const pass = { headers: { 'X-Sign-Grant': grant } };
    const packet = await read(await signOpen(ctx(db, null, {}, pass), token));
    assert.deepEqual(packet.fields.filter((f) => f.mine).map((f) => f.field).sort(), ['checkbox', 'name', 'signature']);
    assert.equal(packet.fields.find((f) => f.id === 'a1').owner, 'Abena Ofori');
    assert.equal(packet.fields.find((f) => f.id === 'a1').mine, false);

    await assert.rejects(
      signDocument(ctx(db, null, { name: 'Kwame Asante', ink: INK, values: { n1: 'Kwame Asante' } }, pass), token),
      /I have read the price list/,
    );
    const signed = await read(await signDocument(ctx(db, null, {
      name: 'Kwame Asante', ink: INK, values: { n1: 'Kwame Asante', c1: true },
    }, pass), token));
    assert.deepEqual(signed.next, ['Abena Ofori']);

    // Abena's turn; texts are not set up, so the office passes her link on.
    const abenaRow = raw.prepare("SELECT id FROM corr_recipient WHERE name = 'Abena Ofori'").get();
    const again = await read(await remindNow(ctx(db, OFFICE, {}), abenaRow.id));
    assert.equal(again.sent, false);
    const t2 = tokenOf(again.url);
    const g2 = (await read(await signVerify(ctx(db, null, { agreed: true }), t2))).grant;
    const done2 = await read(await signDocument(ctx(db, null, { name: 'Abena Ofori', ink: INK }, { headers: { 'X-Sign-Grant': g2 } }), t2));
    assert.deepEqual(done2.next, ['Somewhere Nice']);

    // Not the staff member's to sign; the property's, with a PIN.
    await assert.rejects(toSign(ctx(db, STAFF), id), /Nothing here/);
    const mine = await read(await toSign(ctx(db, OFFICE), id));
    assert.equal(mine.you.as, 'property');
    assert.deepEqual(mine.fields.filter((f) => f.mine).map((f) => f.id), ['p1']);
    await assert.rejects(signInHive(ctx(db, OFFICE, { agreed: true, name: 'Efua Office', ink: INK, pin: '000000' }), id), /PIN is not right/);
    await signInHive(ctx(db, OFFICE, { agreed: true, name: 'Efua Office', ink: INK, pin: '246810' }), id);

    const letter = raw.prepare('SELECT * FROM corr_letter WHERE id = ?').get(id);
    assert.equal(letter.status, 'signed');
    assert.ok(letter.final_hash, 'the signed copy was made');
    const doc = await read(await getDoc(ctx(db, OFFICE), id));
    assert.ok(doc.events.some((e) => e.text === 'Completed. Everyone has signed'));
    assert.ok(doc.events.some((e) => /^Kwame Asante signed \(3 boxes\)$/.test(e.text)));
  } finally { restore(); }
});

test('with email set up: the link is emailed, the code comes before the document, and a decline stops it', async () => {
  const { raw, db, sent, restore } = await setup({ mail: true });
  const env = { RESEND_API_KEY: 'k' };
  try {
    const { id } = await readyToSend(db);
    const out = await read(await sendDoc(ctx(db, OFFICE, {}, { env }), id));
    assert.equal(out.handBack.length, 0);
    const invite = sent.find((m) => /laundry agreement/.test(m.subject));
    assert.ok(invite, 'Kwame was emailed with the subject that was set');
    assert.deepEqual(invite.to, ['info@cleanline.example']);
    const url = /https:\/\/[^"\s]+\/s\/[0-9a-f]+/.exec(invite.html)?.[0];
    const token = tokenOf(url);

    const head = await read(await signHead(ctx(db, null, null, { env }), token));
    assert.equal(head.needsCode, true);
    assert.equal(head.codeTo.how, 'email');
    await assert.rejects(signVerify(ctx(db, null, { agreed: true, code: '123456' }, { env }), token), /Ask for a code first/);

    await signRequestCode(ctx(db, null, {}, { env }), token);
    const code = /(\d{6}) is your code/.exec(sent.at(-1).subject)?.[1];
    assert.ok(code);
    await assert.rejects(signVerify(ctx(db, null, { agreed: false, code }, { env }), token), /agree/);
    const { grant } = await read(await signVerify(ctx(db, null, { agreed: true, code }, { env }), token));

    await signDecline(ctx(db, null, { note: 'The price per kilo is wrong' }, { env, headers: { 'X-Sign-Grant': grant } }), token);
    assert.equal(raw.prepare("SELECT status FROM corr_recipient WHERE name = 'Kwame Asante'").get().status, 'declined');
    const doc = await read(await getDoc(ctx(db, OFFICE), id));
    assert.ok(doc.events.some((e) => e.text === 'Kwame Asante declined: The price per kilo is wrong'));
  } finally { restore(); }
});

test('a member of staff signs from their own login, in their turn', async () => {
  const { raw, db, restore } = await setup();
  try {
    const id = await aDraft(db);
    let doc = await read(await saveDoc(ctx(db, OFFICE, {
      signers: [{ kind: 'staff', userId: 12, step: 1 }],
      inOrder: true,
    }, { method: 'PUT' }), id));
    assert.equal(doc.signers[0].name, 'Yaw Staff');
    doc = await read(await saveDoc(ctx(db, OFFICE, { fields: [{ ...doc.fields[0] }] }, { method: 'PUT' }), id));
    const out = await read(await sendDoc(ctx(db, OFFICE, {}), id));
    assert.equal(out.handBack.length, 0, 'nothing to pass on: they are told in HIVE');
    const told = raw.prepare("SELECT * FROM app_notices WHERE kind = 'corr.your_turn'").all();
    assert.equal(told.length, 1);

    const mine = await read(await toSign(ctx(db, STAFF), id));
    assert.equal(mine.you.as, 'staff');
    await signInHive(ctx(db, STAFF, { agreed: true, name: 'Yaw Staff', ink: INK }), id);
    assert.equal(raw.prepare('SELECT status FROM corr_letter WHERE id = ?').get(id).status, 'signed');
    assert.equal(raw.prepare('SELECT signer_check FROM corr_recipient').get().signer_check, 'their own HIVE login');
  } finally { restore(); }
});
