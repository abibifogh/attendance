import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { DEFAULT_FAQ, LINK_PATHS, TOPIC_KEYS } from '../src/lib/hr-faq-content.js';
import {
  answerQuestion, ask, installStandard, publishEntry, readFaq, removeEntry, retireEntry,
  saveEntry, tellStaff,
} from '../src/routes/hr-faq.js';
import { readAsBlocks } from '../public/js/views/handbook.js';

/**
 * The HR FAQ.
 *
 * Staff read the published answers. HR writes drafts that nobody reads until
 * Publish, answers what the FAQ did not cover, and can turn an answer into a
 * new question. The shipped set arrives published, so it is on from the day
 * the migration runs.
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
  raw.exec('DELETE FROM att_staff; DELETE FROM users; DELETE FROM app_notices;');
  raw.exec(`INSERT INTO att_staff (id, employee_no, name, department, hired_on, active)
            VALUES (1, '1', 'Ama Mensah', 'Reception', '2020-01-01', 1)`);
  raw.exec("INSERT INTO users (id, name, role, active, staff_id) VALUES (101, 'Ama Mensah', 'staff', 1, 1)");
  raw.exec("INSERT INTO users (id, name, role, active) VALUES (90, 'Akua', 'manager', 1)");
  return { raw, db: d1(raw) };
}

const AMA = { user: { id: 101, name: 'Ama Mensah', role: 'staff', staff_id: 1 }, permissions: ['att_me'] };
const HR = { user: { id: 90, name: 'Akua', role: 'manager' }, permissions: ['hr_view', 'hr_manage'] };

const ctx = (db, session, body = null) => ({
  db,
  env: {},
  url: new URL('https://x/api/hr-faq'),
  session,
  executionContext: null,
  request: new Request('https://x/', body
    ? { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
    : {}),
});
const read = async (db, session) => (await readFaq(ctx(db, session))).json();
const save = async (db, body) => (await saveEntry(ctx(db, HR, body))).json();

test('the shipped set is published on arrival, and every link points at a screen HIVE has', async () => {
  const { db } = setup();
  const out = await read(db, AMA);
  assert.equal(out.entries.length, DEFAULT_FAQ.length);
  assert.equal(out.manage, null, 'a member of staff does not see the editing side');
  for (const e of out.entries) {
    assert.ok(TOPIC_KEYS.includes(e.topic), e.code);
    assert.ok(e.answer.length > 20, e.code);
    for (const l of e.links) assert.ok(LINK_PATHS.includes(l.path), `${e.code} links to ${l.path}`);
  }
  const phone = out.entries.find((e) => e.code === 'duty_phone');
  assert.match(phone.answer, /ask your supervisor for permission/);
  const late = out.entries.find((e) => e.code === 'clock_late');
  assert.match(late.answer, /Call your supervisor or manager/);
  assert.equal(late.links.length, 0, 'late is a phone call, not a button');
});

test('every shipped answer reads as paragraphs, steps or lists, never one wall', () => {
  for (const f of DEFAULT_FAQ) {
    const blocks = readAsBlocks(f.answer);
    assert.ok(blocks.length >= 1, f.code);
    assert.ok(blocks.every((b) => ['text', 'bullets', 'numbers'].includes(b.kind)), f.code);
  }
  assert.equal(readAsBlocks(DEFAULT_FAQ.find((f) => f.code === 'sick_cant_come_in').answer)[0].kind, 'numbers');
  assert.equal(readAsBlocks(DEFAULT_FAQ.find((f) => f.code === 'duty_never').answer)[0].kind, 'bullets');
});

test('a draft is HR’s alone until it is published, and an edit does not move the live copy', async () => {
  const { db } = setup();
  const made = await save(db, {
    topic: 'leave', question: 'Can I carry leave into next year?', answer: 'Up to five days, if HR agrees before December.',
    links: [{ path: 'att-me', label: 'My leave' }], order: 50,
  });
  assert.ok(made.id);
  let staff = await read(db, AMA);
  assert.ok(!staff.entries.some((e) => e.id === made.id), 'a draft is not on the screen');
  const hr = await read(db, HR);
  assert.equal(hr.manage.entries.find((e) => e.id === made.id).status, 'draft');

  await publishEntry(ctx(db, HR, {}), made.id);
  staff = await read(db, AMA);
  const live = staff.entries.find((e) => e.id === made.id);
  assert.equal(live.answer, 'Up to five days, if HR agrees before December.');
  assert.deepEqual(live.links, [{ path: 'att-me', label: 'My leave' }]);

  await save(db, { id: made.id, topic: 'leave', question: 'Can I carry leave into next year?', answer: 'No.', links: [], order: 50 });
  staff = await read(db, AMA);
  assert.equal(staff.entries.find((e) => e.id === made.id).answer, 'Up to five days, if HR agrees before December.',
    'staff still read the published words');
  const edited = (await read(db, HR)).manage.entries.find((e) => e.id === made.id);
  assert.equal(edited.changed, true, 'and HR is shown that it has moved');

  await retireEntry(ctx(db, HR, {}), made.id);
  staff = await read(db, AMA);
  assert.ok(!staff.entries.some((e) => e.id === made.id), 'retired is off the screen');
  await removeEntry(ctx(db, HR), made.id);
  assert.ok(!(await read(db, HR)).manage.entries.some((e) => e.id === made.id));
});

test('an answer can only send somebody to a screen HIVE has, and needs words before it is published', async () => {
  const { db } = setup();
  await assert.rejects(save(db, { topic: 'leave', question: 'Q', answer: 'A', links: [{ path: 'https://evil.example', label: 'x' }] }),
    /only link to a screen/);
  await assert.rejects(save(db, { topic: 'nope', question: 'Q', answer: 'A' }), /not one of the topics/);
  const empty = await save(db, { topic: 'leave', question: 'Q', answer: '' });
  await assert.rejects(publishEntry(ctx(db, HR, {}), empty.id), /Write the answer/);
  await assert.rejects(removeEntry(ctx(db, HR), (await read(db, HR)).manage.entries.find((e) => e.status === 'published').id),
    /Retire it first/);
});

test('installing the standard set only ever adds what is missing', async () => {
  const { raw, db } = setup();
  raw.prepare("UPDATE hr_faq SET answer = 'Edited by the property' WHERE code = 'duty_phone'").run();
  raw.prepare("DELETE FROM hr_faq WHERE code = 'app_lunch'").run();
  const done = await (await installStandard(ctx(db, HR, {}))).json();
  assert.equal(done.added, 1);
  assert.equal(raw.prepare("SELECT answer FROM hr_faq WHERE code = 'duty_phone'").get().answer, 'Edited by the property');
  assert.equal(raw.prepare("SELECT status FROM hr_faq WHERE code = 'app_lunch'").get().status, 'draft', 'comes back as a draft');
});

test('asking HR: one open question at a time, HR is told, the answer comes back and can join the FAQ', async () => {
  const { raw, db } = setup();
  const sent = await (await ask(ctx(db, AMA, { question: 'Can I swap my rest day with a colleague?' }))).json();
  assert.ok(sent.id);
  await assert.rejects(ask(ctx(db, AMA, { question: 'Again?' })), /already have a question waiting/);

  const told = raw.prepare("SELECT audience, title FROM app_notices WHERE kind = 'hr_faq.asked'").get();
  assert.equal(told.audience, 'hr_manage');
  assert.match(told.title, /Ama Mensah has a question/);

  const hr = await read(db, HR);
  assert.equal(hr.manage.open.length, 1);
  assert.equal(hr.manage.open[0].name, 'Ama Mensah');

  const done = await (await answerQuestion(ctx(db, HR, {
    answer: 'Yes, through Swaps, if your supervisor approves.', addToFaq: true, topic: 'clock', question: 'Can I swap a rest day?',
  }), sent.id)).json();
  assert.ok(done.faqId, 'added to the FAQ');
  assert.equal(raw.prepare('SELECT status FROM hr_faq WHERE id = ?').get(done.faqId).status, 'draft', 'as a draft, for HR to publish');

  const mine = await read(db, AMA);
  assert.equal(mine.asked[0].status, 'answered');
  assert.match(mine.asked[0].answer, /through Swaps/);
  const back = raw.prepare("SELECT user_id FROM app_notices WHERE kind = 'hr_faq.answered'").get();
  assert.equal(back.user_id, 101, 'the person who asked is told, and nobody else');

  await assert.rejects(answerQuestion(ctx(db, HR, { answer: 'x' }), sent.id), /has been answered/);
  assert.equal((await read(db, HR)).manage.open.length, 0);
});

test('a login with no staff record cannot ask, and telling staff reaches everybody', async () => {
  const { raw, db } = setup();
  await assert.rejects(ask(ctx(db, HR, { question: 'Who am I?' })), /not linked to a staff record/);
  await tellStaff(ctx(db, HR, { about: 'New answer on sick days' }));
  const notice = raw.prepare("SELECT audience, user_id, body FROM app_notices WHERE kind = 'hr_faq.changed'").get();
  assert.equal(notice.audience, null);
  assert.equal(notice.user_id, null);
  assert.equal(notice.body, 'New answer on sick days');
});
