import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { watchAbsences, noteNeeded } from '../src/lib/absence-watch.js';
import {
  answerQuestion, listQuestions, mySick, sayOffSick, sendSickNote,
} from '../src/routes/absence.js';
import { KINDS } from '../src/lib/notice-kinds.js';

/**
 * Off sick, absent, or here?
 *
 * Half an hour into a shift with no clock-in, HIVE asks the people who run the
 * floor, and keeps asking until one of them answers. The first answer wins.
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

const DAY = '2026-10-19';
const NEXT = '2026-10-20';
const at = (stamp) => Date.parse(`${stamp}:00Z`);

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM att_leave; DELETE FROM app_notices; DELETE FROM push_subscriptions;
            DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes)
     VALUES (1, 'AM Shift', '06:00', '14:00', 0, 5)`,
  ).run();
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1', 'Test Person', 'Front desk', '2020-01-01')`,
  ).run();
  raw.prepare(
    "INSERT INTO users (id, name, role, pin_hash, staff_id, active) VALUES (7, 'Test Person', 'staff', 'x7', 1, 1)",
  ).run();
  for (const day of [DAY, NEXT]) {
    raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)').run(day);
  }
  return { raw, db: d1(raw) };
}

const PERSON = { user: { id: 7, name: 'Test Person', role: 'staff', staff_id: 1 }, permissions: ['att_me'] };
const PLANNER = { user: { id: 3, name: 'Plan Ner', role: 'planner' }, permissions: ['att_view', 'att_rota', 'att_times'] };
const SUPERVISOR = { user: { id: 4, name: 'Super Visor', role: 'supervisor' }, permissions: ['att_view', 'att_manage', 'att_rota', 'att_times'] };
const ADMIN = { user: { id: 2, name: 'Ad Min', role: 'admin' }, permissions: ['att_setup', 'att_manage', 'att_rota', 'att_times'] };

const ctx = (db, session, body = {}) => ({
  db,
  env: {},
  url: new URL('https://x/api/x'),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
});

const questions = (raw) => raw.prepare('SELECT * FROM att_absence_q ORDER BY id').all();
const asks = (raw) => raw.prepare("SELECT * FROM app_notices WHERE kind = 'attendance.absence_question' ORDER BY id").all();

function clock(t, stamp) {
  t.mock.timers.enable({ apis: ['Date'], now: at(stamp) });
  return (next) => t.mock.timers.setTime(at(next));
}

test('half an hour after the start with no clock-in, the floor is asked', async (t) => {
  const { db, raw } = setup();
  const set = clock(t, `${DAY}T06:20`);

  // Twenty minutes in: the person has been buzzed, but nobody else is asked yet.
  await watchAbsences(db, { timezone: 'UTC' });
  assert.equal(questions(raw).length, 0);

  set(`${DAY}T06:36`);
  const out = await watchAbsences(db, { timezone: 'UTC' });
  assert.equal(out.opened, 1);
  assert.equal(out.asked, 1);
  const [notice] = asks(raw);
  assert.equal(notice.audience, 'att_rota', 'planners, supervisors and administrators');
  assert.match(notice.title, /Is Test Person off sick\?/);
  assert.equal(notice.link, '#/home');
});

test('it keeps asking until somebody answers', async (t) => {
  const { db, raw } = setup();
  const set = clock(t, `${DAY}T06:36`);
  await watchAbsences(db, { timezone: 'UTC' });

  set(`${DAY}T06:50`);
  await watchAbsences(db, { timezone: 'UTC' });
  assert.equal(asks(raw).length, 1, 'not again inside the half hour');

  set(`${DAY}T07:06`);
  await watchAbsences(db, { timezone: 'UTC' });
  assert.equal(asks(raw).length, 2, 'again after half an hour');
  assert.match(asks(raw)[1].title, /^Still to answer/);

  // After the shift: hourly in the daytime, and not at night.
  set(`${DAY}T14:30`);
  await watchAbsences(db, { timezone: 'UTC' });
  const afterShift = asks(raw).length;
  set(`${DAY}T15:00`);
  await watchAbsences(db, { timezone: 'UTC' });
  assert.equal(asks(raw).length, afterShift, 'hourly once the shift is over');
  set(`${DAY}T15:31`);
  await watchAbsences(db, { timezone: 'UTC' });
  assert.equal(asks(raw).length, afterShift + 1);

  set(`${DAY}T23:30`);
  await watchAbsences(db, { timezone: 'UTC' });
  assert.equal(asks(raw).length, afterShift + 1, 'not in the middle of the night');

  set(`${NEXT}T09:00`);
  await watchAbsences(db, { timezone: 'UTC' });
  assert.ok(asks(raw).length > afterShift + 1, 'and still the next morning');
  assert.equal(questions(raw).filter((q) => q.day === DAY)[0].answer, null);

  // Once answered, it stops.
  const [q] = questions(raw);
  await answerQuestion(ctx(db, PLANNER, { answer: 'absent' }), q.id);
  const count = asks(raw).length;
  set(`${NEXT}T13:00`);
  await watchAbsences(db, { timezone: 'UTC' });
  const forDay = asks(raw).slice(count).filter((n) => n.day === DAY);
  assert.equal(forDay.length, 0, 'an answered question is not asked again');
});

test('a clock-in that turns up closes the question', async (t) => {
  const { db, raw } = setup();
  const set = clock(t, `${DAY}T06:36`);
  await watchAbsences(db, { timezone: 'UTC' });

  raw.prepare(
    `INSERT INTO att_punches (device_serial, employee_no, staff_id, at_utc, at_local, day, direction, dedupe_key)
     VALUES ('D1', '1', 1, ?1, ?1, ?2, 'in', 'k1')`,
  ).run(`${DAY} 06:45:00`, DAY);
  set(`${DAY}T07:10`);
  const out = await watchAbsences(db, { timezone: 'UTC' });
  assert.equal(out.closed, 1);
  assert.equal(questions(raw)[0].answer, 'came_in');
  assert.equal(asks(raw).length, 1);
});

test('yes, off sick logs approved sick leave and tells the person; the first answer wins', async (t) => {
  const { db, raw } = setup();
  clock(t, `${DAY}T06:40`);
  await watchAbsences(db, { timezone: 'UTC' });
  const [q] = questions(raw);

  const out = await (await answerQuestion(ctx(db, PLANNER, { answer: 'sick', how: 'called', note: 'Fever' }), q.id)).json();
  assert.equal(out.ok, true);

  const leave = raw.prepare('SELECT * FROM att_leave').all();
  assert.equal(leave.length, 1);
  assert.equal(leave[0].reason_code, 'sick_leave');
  assert.equal(leave[0].status, 'approved', 'a planner answering yes is enough');
  assert.equal(leave[0].from_day, DAY);
  assert.equal(leave[0].to_day, DAY);
  assert.match(leave[0].decided_by, /Plan Ner/);

  const told = raw.prepare("SELECT * FROM app_notices WHERE kind = 'attendance.logged_sick'").get();
  assert.equal(told.user_id, 7);
  assert.ok(!/\b(he|she|his|her)\b/i.test(`${told.title} ${told.body}`));

  // One day: no certificate.
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM att_sick_note').get().n, 0);

  await assert.rejects(
    answerQuestion(ctx(db, SUPERVISOR, { answer: 'absent' }), q.id),
    /Plan Ner already answered: off sick/,
  );
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM att_days WHERE status = ?').get('absent').n, 0);
});

test('two days off sick asks for a certificate, and the person can photograph it', async (t) => {
  const { db, raw } = setup();
  const set = clock(t, `${DAY}T06:40`);
  await watchAbsences(db, { timezone: 'UTC' });
  const [q] = questions(raw);

  const out = await (await answerQuestion(ctx(db, PLANNER, { answer: 'sick', until: NEXT }), q.id)).json();
  assert.deepEqual(out.note, { due: '2026-10-23' });
  const note = raw.prepare('SELECT * FROM att_sick_note').get();
  assert.equal(note.status, 'owed');
  assert.equal(note.due_on, '2026-10-23');

  const mine = await (await mySick(ctx(db, PERSON))).json();
  assert.equal(mine.sick.days, 2);
  assert.equal(mine.notes.length, 1);
  assert.equal(mine.canSay, false, 'already off sick');

  // The morning after the last sick day, a reminder.
  set('2026-10-21T09:05');
  await watchAbsences(db, { timezone: 'UTC' });
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM app_notices WHERE kind = 'attendance.sick_note_owed'").get().n, 1);
  await watchAbsences(db, { timezone: 'UTC' });
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM app_notices WHERE kind = 'attendance.sick_note_owed'").get().n, 1, 'once a day');

  const sent = await (await sendSickNote(ctx(db, PERSON, {
    file: { base64: Buffer.from('a picture').toString('base64'), mime: 'image/jpeg', filename: 'note.jpg' },
  }), String(note.leave_id))).json();
  assert.ok(sent.documentId);
  assert.equal(raw.prepare('SELECT status FROM att_sick_note').get().status, 'sent');
  const doc = raw.prepare('SELECT * FROM hr_document WHERE id = ?').get(sent.documentId);
  assert.equal(doc.kind, 'sick_note');
  assert.equal(doc.staff_id, 1);
});

test('off sick yesterday: still off sick? stretches the same leave', async (t) => {
  const { db, raw } = setup();
  const set = clock(t, `${DAY}T06:40`);
  await watchAbsences(db, { timezone: 'UTC' });
  await answerQuestion(ctx(db, PLANNER, { answer: 'sick' }), questions(raw)[0].id);

  set(`${NEXT}T06:40`);
  await watchAbsences(db, { timezone: 'UTC' });
  const q = questions(raw).find((r) => r.day === NEXT);
  assert.equal(q.follow_up, 1);
  assert.match(asks(raw).at(-1).title, /still off sick/);

  await answerQuestion(ctx(db, SUPERVISOR, { answer: 'sick' }), q.id);
  const leave = raw.prepare('SELECT * FROM att_leave').all();
  assert.equal(leave.length, 1, 'stretched, not a second leave');
  assert.equal(leave[0].from_day, DAY);
  assert.equal(leave[0].to_day, NEXT);
  assert.equal(raw.prepare('SELECT due_on FROM att_sick_note').get().due_on, '2026-10-23');
});

test('no, absent settles the day as absent', async (t) => {
  const { db, raw } = setup();
  clock(t, `${DAY}T06:40`);
  await watchAbsences(db, { timezone: 'UTC' });
  await answerQuestion(ctx(db, PLANNER, { answer: 'absent', how: 'none' }), questions(raw)[0].id);

  const day = raw.prepare('SELECT * FROM att_days WHERE staff_id = 1 AND day = ?').get(DAY);
  assert.equal(day.status, 'absent');
  assert.equal(day.resolution, 'resolved');
  assert.match(day.resolved_by, /Plan Ner/);
  const told = raw.prepare("SELECT * FROM app_notices WHERE kind = 'attendance.marked_absent'").get();
  assert.equal(told.user_id, 7);
});

test('here after all: the start time goes through the usual correction', async (t) => {
  const { db, raw } = setup();
  clock(t, `${DAY}T06:40`);
  await watchAbsences(db, { timezone: 'UTC' });
  const [q] = questions(raw);

  await assert.rejects(answerQuestion(ctx(db, PLANNER, { answer: 'here', in: '06:25' }), q.id), /no clock-in/i);
  assert.equal(questions(raw)[0].answer, null, 'a refused answer leaves the question open');

  const out = await (await answerQuestion(ctx(db, PLANNER, {
    answer: 'here', in: '06:25', why: 'Forgot to clock in',
  }), q.id)).json();
  assert.equal(out.pending, true, 'a planner cannot approve times, so it waits for an administrator');
  const edit = raw.prepare('SELECT * FROM att_time_edit').get();
  assert.equal(edit.now_in, '06:25');
  assert.equal(edit.status, 'pending');
  assert.equal(questions(raw)[0].answer, 'here');
});

test('an administrator saying here puts the time right at once', async (t) => {
  const { db, raw } = setup();
  clock(t, `${DAY}T06:40`);
  await watchAbsences(db, { timezone: 'UTC' });
  const out = await (await answerQuestion(ctx(db, ADMIN, {
    answer: 'here', in: '06:25', why: 'The terminal was not working',
  }), questions(raw)[0].id)).json();
  assert.equal(out.pending, false);
  assert.equal(raw.prepare('SELECT corrected_in FROM att_days WHERE staff_id = 1 AND day = ?').get(DAY).corrected_in, '06:25');
});

test("I'm off sick today: the floor is told, and yes approves the same leave", async (t) => {
  const { db, raw } = setup();
  const set = clock(t, `${DAY}T05:40`);

  const before = await (await mySick(ctx(db, PERSON))).json();
  assert.equal(before.canSay, true);

  await sayOffSick(ctx(db, PERSON, { days: 1, note: 'Fever' }));
  const said = raw.prepare("SELECT * FROM app_notices WHERE kind = 'attendance.said_sick'").get();
  assert.equal(said.audience, 'att_rota');
  assert.equal(raw.prepare('SELECT status FROM att_leave').get().status, 'pending');

  set(`${DAY}T06:40`);
  await watchAbsences(db, { timezone: 'UTC' });
  const [q] = questions(raw);
  assert.ok(q.said_leave_id, 'the question knows what they said');
  const list = await (await listQuestions(ctx(db, PLANNER))).json();
  assert.ok(list.open[0].said);

  await answerQuestion(ctx(db, PLANNER, { answer: 'sick' }), q.id);
  const leave = raw.prepare('SELECT * FROM att_leave').all();
  assert.equal(leave.length, 1);
  assert.equal(leave[0].status, 'approved');
});

test('approved leave settles a question nobody answered', async (t) => {
  const { db, raw } = setup();
  const set = clock(t, `${DAY}T06:40`);
  await watchAbsences(db, { timezone: 'UTC' });
  raw.prepare(
    `INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status, requested_by, decided_by)
     VALUES (1, 'annual_leave', ?1, ?1, 1, 'approved', 'x', 'Some Manager (manager)')`,
  ).run(DAY);
  set(`${DAY}T07:15`);
  await watchAbsences(db, { timezone: 'UTC' });
  assert.equal(questions(raw)[0].answer, 'settled');
});

test('a certificate from two days', () => {
  assert.equal(noteNeeded({ from_day: DAY, to_day: DAY }), null);
  assert.deepEqual(noteNeeded({ from_day: DAY, to_day: NEXT }), { due: '2026-10-23', span: 2 });
});

test('every notice raised here is listed with the others', () => {
  const keys = new Set(KINDS.map((k) => k.key));
  for (const kind of ['attendance.absence_question', 'attendance.logged_sick', 'attendance.marked_absent',
    'attendance.said_sick', 'attendance.sick_note_owed', 'attendance.sick_note_late']) {
    assert.ok(keys.has(kind), kind);
  }
});
