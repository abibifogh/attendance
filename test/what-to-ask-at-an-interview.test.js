import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { MARKS, PACKS, packForDepartment, sheetRating } from '../src/lib/interview-packs.js';
import {
  addCandidate, candidate, createRole, loadStandardPacks, questionPacks, removeQuestionPack,
  saveQuestionPack, scoreCandidate, updateRole,
} from '../src/routes/recruitment.js';

/**
 * The questions, written down before the interview rather than during it.
 *
 * An interview was a mark out of five and a paragraph, which is a record of
 * somebody's impression. Six impressions taken on six afternoons by three
 * people are not comparable, and comparable is the one thing a hiring decision
 * needs them to be.
 *
 * What is pinned down here is the part that has to survive time: a set can be
 * edited, or retired outright, and a sheet somebody already marked still says
 * what they were asked and what they were given for it.
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
  raw.exec(`DELETE FROM rec_role; DELETE FROM rec_candidate; DELETE FROM rec_pack;
            DELETE FROM rec_question; DELETE FROM rec_score; DELETE FROM rec_answer;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  return { raw, db: d1(raw) };
}

const ctx = (db, body = null, permissions = ['rec_view', 'rec_manage']) => ({
  db,
  env: {},
  url: new URL('https://x/api/rec'),
  session: { user: { id: 1, name: 'Kwame', role: 'admin' }, permissions },
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const read = async (res) => JSON.parse(await res.text());

const aPack = async (db, over = {}) => read(await saveQuestionPack(ctx(db, {
  name: 'Housekeeping and rooms',
  department: 'Housekeeping',
  questions: [
    { text: 'Take me through cleaning a checkout room.', listenFor: 'An order, and a reason.' },
    { text: 'You find money in a room. What do you do?', listenFor: 'Do not move it. Tell somebody.' },
  ],
  ...over,
}), null));

// ---------------------------------------------------------------------------
// What ships with it
// ---------------------------------------------------------------------------

test('the standard sets cover the departments a hotel actually has', () => {
  const departments = PACKS.map((p) => p.department);
  for (const want of ['Front Office', 'Housekeeping', 'F&B', 'Kitchen', 'Maintenance', 'Security']) {
    assert.ok(departments.includes(want), want);
  }
  assert.ok(PACKS.some((p) => p.department === null), 'and one for anybody, whatever the job');
  for (const pack of PACKS) {
    assert.ok(pack.questions.length >= 4, `${pack.name} has enough to be an interview`);
    for (const q of pack.questions) {
      assert.ok(q.text.length > 20, q.text);
      // The listen-for is the useful half: whoever sits in the interview here
      // is the head of the department, not somebody who interviews for a living.
      assert.ok(q.listenFor && q.listenFor.length > 20, `${q.text} says what good sounds like`);
    }
  }
});

test('none of them ask anything nobody should be asked', () => {
  // Not because the law here is loud about it. None of it predicts whether
  // somebody can strip a room in twenty minutes, and asking is how a property
  // ends up with a workforce that all came from the same place.
  const said = JSON.stringify(PACKS).toLowerCase();
  for (const off of ['married', 'marital', 'children', 'pregnan', 'church', 'religion',
    'tribe', 'home town', 'hometown', 'political', 'how old are you']) {
    assert.equal(said.includes(off), false, off);
  }
});

test('the five marks mean the same thing to everybody who uses them', () => {
  assert.equal(MARKS.length, 5);
  assert.deepEqual(MARKS.map(([n]) => n), [1, 2, 3, 4, 5]);
  for (const [, label, detail] of MARKS) {
    assert.ok(label && detail, 'a bare number means whatever the person holding the pen thought');
  }
});

test('a sheet comes out at the average of what was actually marked', () => {
  assert.equal(sheetRating([{ mark: 4 }, { mark: 5 }]), 4.5);
  // An interview that ran short is not an interview that went badly, so the
  // questions nobody got to are left out rather than counted as nought.
  assert.equal(sheetRating([{ mark: 4 }, { mark: null }, { mark: 2 }]), 3);
  assert.equal(sheetRating([{ mark: null }]), null);
  assert.equal(sheetRating([]), null);
});

test('a department finds its standard set however it is capitalised', () => {
  assert.equal(packForDepartment('housekeeping')?.department, 'Housekeeping');
  assert.equal(packForDepartment('  F&B '), PACKS.find((p) => p.department === 'F&B'));
  assert.equal(packForDepartment('Laundry'), null);
  assert.equal(packForDepartment(null), null);
});

// ---------------------------------------------------------------------------
// Writing them down
// ---------------------------------------------------------------------------

test('the standard sets land once, however many times the button is pressed', async () => {
  const { db, raw } = setup();
  const first = await read(await loadStandardPacks(ctx(db)));
  assert.equal(first.added.length, PACKS.length);

  const again = await read(await loadStandardPacks(ctx(db)));
  assert.equal(again.added.length, 0);
  assert.equal(again.skipped, PACKS.length);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM rec_pack').get().n, PACKS.length);
});

test('a set with no questions in it is not a set', async () => {
  const { db } = setup();
  await assert.rejects(
    () => saveQuestionPack(ctx(db, { name: 'Empty', questions: [] }), null),
    /not a set/,
  );
});

test('editing a set takes questions off it without losing them', async () => {
  const { db, raw } = setup();
  const made = await aPack(db);
  const before = (await read(await questionPacks(ctx(db)))).packs[0];
  assert.equal(before.questions.length, 2);

  await saveQuestionPack(ctx(db, {
    name: before.name,
    questions: [{ id: before.questions[0].id, text: before.questions[0].text }],
  }), made.id);

  const after = (await read(await questionPacks(ctx(db)))).packs[0];
  assert.equal(after.questions.length, 1, 'the screen shows one');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM rec_question').get().n, 2,
    'and the other is switched off rather than deleted');
});

// ---------------------------------------------------------------------------
// Marking somebody against them
// ---------------------------------------------------------------------------

async function aCandidateFor(db, packId) {
  const roleId = (await read(await createRole(ctx(db, {
    title: 'Room attendant', department: 'Housekeeping', packId,
  })))).id;
  const id = (await read(await addCandidate(ctx(db, { name: 'Ama Mensah', roleId })))).id;
  return { roleId, id };
}

test('the questions offered are the ones on the vacancy', async () => {
  const { db } = setup();
  const pack = await aPack(db);
  const who = await aCandidateFor(db, pack.id);

  const out = await read(await candidate(ctx(db), who.id));
  assert.equal(out.pack.name, 'Housekeeping and rooms');
  assert.equal(out.pack.questions.length, 2);
  assert.equal(out.marks.length, 5);
});

test('a vacancy with no set falls back to the standard one for its department', async () => {
  // A property that loaded the standard sets and never got round to putting
  // one on a vacancy still gets the right questions in front of them.
  const { db } = setup();
  await loadStandardPacks(ctx(db));
  const who = await aCandidateFor(db, null);

  const out = await read(await candidate(ctx(db), who.id));
  assert.equal(out.pack.name, 'Housekeeping and rooms');
});

test('a candidate against nothing in particular gets no questions, and that is fine', async () => {
  const { db } = setup();
  const id = (await read(await addCandidate(ctx(db, { name: 'Kojo' })))).id;
  const out = await read(await candidate(ctx(db), id));
  assert.equal(out.pack, null, 'a casual taken on in an afternoon is a mark and a line');
});

test('marking question by question is what the sheet comes out at', async () => {
  const { db } = setup();
  const pack = await aPack(db);
  const who = await aCandidateFor(db, pack.id);
  const asked = (await read(await candidate(ctx(db), who.id))).pack.questions;

  const out = await read(await scoreCandidate(ctx(db, {
    recommend: 'yes',
    answers: [
      { questionId: asked[0].id, asked: asked[0].text, mark: 5, note: 'Strip, top down, bathroom last.' },
      { questionId: asked[1].id, asked: asked[1].text, mark: 4 },
    ],
  }), who.id));

  assert.equal(out.rating, 4.5, 'the average of what was given, not a box of its own');

  const back = await read(await candidate(ctx(db), who.id));
  assert.equal(back.scores[0].rating, 4.5);
  assert.equal(back.scores[0].packName, 'Housekeeping and rooms');
  assert.deepEqual(back.scores[0].answers.map((a) => a.mark), [5, 4]);
  assert.match(back.scores[0].answers[0].note, /top down/);
});

test('a question nobody got to does not drag the mark down', async () => {
  const { db } = setup();
  const pack = await aPack(db);
  const who = await aCandidateFor(db, pack.id);
  const asked = (await read(await candidate(ctx(db), who.id))).pack.questions;

  const out = await read(await scoreCandidate(ctx(db, {
    answers: [
      { questionId: asked[0].id, asked: asked[0].text, mark: 4 },
      { questionId: asked[1].id, asked: asked[1].text, mark: null },
    ],
  }), who.id));
  assert.equal(out.rating, 4);
});

test('a sheet keeps the words it was marked against, whatever happens to the set', async () => {
  // The whole point. A set edited in six months must not rewrite what somebody
  // was asked in March, and retiring one must not empty out the sheets.
  const { db } = setup();
  const pack = await aPack(db);
  const who = await aCandidateFor(db, pack.id);
  const asked = (await read(await candidate(ctx(db), who.id))).pack.questions;

  await scoreCandidate(ctx(db, {
    answers: [{ questionId: asked[0].id, asked: asked[0].text, mark: 5 }],
  }), who.id);

  await saveQuestionPack(ctx(db, {
    name: 'Housekeeping and rooms',
    questions: [{ text: 'Something else entirely.' }],
  }), pack.id);
  await removeQuestionPack(ctx(db), pack.id);

  const back = await read(await candidate(ctx(db), who.id));
  assert.equal(back.scores[0].answers.length, 1);
  assert.match(back.scores[0].answers[0].asked, /checkout room/);
  assert.equal(back.scores[0].answers[0].mark, 5);
  assert.equal(back.pack, null, 'and the retired set is not offered again');
});

test('retiring a set takes it off the vacancies that used it', async () => {
  const { db, raw } = setup();
  const pack = await aPack(db);
  const who = await aCandidateFor(db, pack.id);

  await removeQuestionPack(ctx(db), pack.id);
  assert.equal(raw.prepare('SELECT pack_id FROM rec_role WHERE id = ?').get(who.roleId).pack_id, null);
});

test('a vacancy can be pointed at a different set afterwards', async () => {
  const { db } = setup();
  const one = await aPack(db);
  const two = await aPack(db, { name: 'Front office', department: 'Front Office' });
  const who = await aCandidateFor(db, one.id);

  await updateRole(ctx(db, { packId: two.id }), who.roleId);
  const out = await read(await candidate(ctx(db), who.id));
  assert.equal(out.pack.name, 'Front office');
});
