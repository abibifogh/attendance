import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  feedbackSettings, firstMonday, nextOpening, openRound, plainThemes, readJson, submitAnswers, tally, watchFeedback,
} from '../src/lib/feedback.js';
import { answerFeedback, feedbackOverview, myFeedback } from '../src/routes/feedback.js';

/** Staff feedback every quarter. Made-up people only. */

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

const PEOPLE = [
  [1, 'Kwame Asare', 'Front office'], [2, 'Akosua Darko', 'Front office'], [3, 'Kojo Antwi', 'F&B'],
  [4, 'Yaw Boateng', 'F&B'], [5, 'Abena Mensah', 'F&B'], [6, 'Kofi Mensah', 'F&B'], [7, 'Esi Quaye', 'F&B'],
];

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM att_staff; DELETE FROM users;');
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  for (const [id, name, dept] of PEOPLE) {
    raw.prepare("INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (?, ?, ?, ?, '2024-01-01')").run(id, `F${id}`, name, dept);
  }
  // Somebody who starts the week before the January round is not asked in it.
  raw.prepare("INSERT INTO att_staff (id, employee_no, name, department, hired_on) VALUES (8, 'F8', 'Nana Adjei', 'F&B', '2026-12-28')").run();
  return { raw, db: d1(raw) };
}

const ctxFor = (db, { role = 'admin', permissions = ['att_manage', 'hr_manage'], staffId = null, url = 'https://x/api/feedback', body = null } = {}) => ({
  db,
  env: {},
  request: body
    ? new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    : new Request(url),
  session: { user: { id: 1, name: 'Test Admin', role, staff_id: staffId }, permissions },
});

test('the settings, the first Monday, and the next round', () => {
  const s = feedbackSettings({});
  assert.deepEqual([s.on, s.months, s.openDays, s.anonymous, s.minGroup], [true, [1, 4, 7, 10], 12, false, 5]);
  assert.equal(firstMonday(2027, 1), '2027-01-04');
  assert.equal(firstMonday(2026, 11), '2026-11-02');
  assert.equal(nextOpening('2026-11-02', [1, 4, 7, 10]), '2027-01-04');
  assert.equal(nextOpening('2027-01-04', [1, 4, 7, 10]), '2027-01-04');
});

test('the migration seeds eleven questions and the schedule, names kept', () => {
  const { raw } = setup();
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM fb_question').get().n, 11);
  assert.equal(raw.prepare("SELECT value FROM settings WHERE key = 'feedback_anonymous'").get().value, '0');
});

test('a round opens on the first Monday of a quarter month, asks those employed 30 days, and only once', async () => {
  const { raw, db } = setup();
  const quiet = await watchFeedback(db, { today: '2026-11-02' });
  assert.equal(quiet.opened, false, 'November is not a round month');
  const out = await watchFeedback(db, { today: '2027-01-04' });
  assert.equal(out.opened, true);
  const r = raw.prepare('SELECT * FROM fb_round').get();
  assert.deepEqual([r.label, r.opens_on, r.closes_on, r.asked, r.anonymous], ['January 2027', '2027-01-04', '2027-01-15', 7, 0]);
  const again = await watchFeedback(db, { today: '2027-01-04' });
  assert.equal(again.opened, false);
});

test('answers keep the name unless the round is anonymous, and nobody answers twice', async () => {
  const { raw, db } = setup();
  await openRound(db, { today: '2027-01-04' });
  const round = raw.prepare('SELECT * FROM fb_round').get();
  const q = JSON.parse(round.questions);
  await submitAnswers(db, { round, staff: { id: 1, department: 'Front office' }, answers: { [q[0].id]: { score: 4, comment: 'Good team' } } });
  await assert.rejects(() => submitAnswers(db, { round, staff: { id: 1, department: 'Front office' }, answers: {} }), /already answered/);
  assert.equal(raw.prepare('SELECT staff_id FROM fb_response').get().staff_id, 1, 'named');

  raw.exec("UPDATE fb_round SET status = 'closed'");
  await openRound(db, { today: '2027-04-05', anonymous: true });
  const anon = raw.prepare("SELECT * FROM fb_round WHERE status = 'open'").get();
  assert.equal(anon.anonymous, 1);
  await submitAnswers(db, { round: anon, staff: { id: 2, department: 'Front office' }, answers: { [q[0].id]: { score: 2 } } });
  assert.equal(raw.prepare('SELECT staff_id FROM fb_response WHERE round_id = ?').get(anon.id).staff_id, null, 'no name in an anonymous round');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM fb_done WHERE round_id = ?').get(anon.id).n, 1, 'but they are not reminded again');
});

test('the tally hides a department under the minimum and compares with the round before', () => {
  const questions = [{ id: 1, area: 'How it feels', text: 'Q', kind: 'scale' }, { id: 2, area: 'Recommend', text: 'R', kind: 'recommend' }];
  const responses = [
    ...['F&B', 'F&B', 'F&B', 'F&B', 'F&B'].map((d, i) => ({ department: d, staff_id: i + 3, answers: { 1: { score: 4 }, 2: { choice: 'yes' } } })),
    { department: 'Front office', staff_id: 1, answers: { 1: { score: 1, comment: 'Too hot' }, 2: { choice: 'no' } } },
  ];
  const t = tally({ questions, responses, previous: { areas: [{ area: 'How it feels', score: 3 }] }, minGroup: 5 });
  const feel = t.areas[0];
  assert.equal(feel.score, 3.5);
  assert.equal(feel.delta, 0.5);
  assert.deepEqual(feel.byDepartment.map((d) => [d.department, d.score]), [['F&B', 4], ['Front office', null]]);
  assert.deepEqual([t.recommend.yes, t.recommend.no, t.recommend.score], [5, 1, 67]);
  assert.equal(t.comments[0].text, 'Too hot');
});

test('without the AI, comments are grouped by area; a model reply is read for its JSON', () => {
  const themes = plainThemes([{ area: 'Pay', score: 1 }, { area: 'Pay', score: 2 }, { area: 'Team', score: 5 }]);
  assert.deepEqual(themes.map((t) => [t.title, t.comments.length, t.tone]), [['Pay', 2, 'negative'], ['Team', 1, 'positive']]);
  assert.deepEqual(readJson('Here you go: {"themes": []} done'), { themes: [] });
  assert.equal(readJson('nothing'), null);
});

test('closing reads it; an admin sees names, HR sees none, and an anonymous round shows none to anybody', async () => {
  const { raw, db } = setup();
  await openRound(db, { today: '2027-01-04' });
  let round = raw.prepare('SELECT * FROM fb_round').get();
  const q = JSON.parse(round.questions);
  for (const [id, , dept] of PEOPLE) {
    await submitAnswers(db, { round, staff: { id, department: dept }, answers: { [q[0].id]: { score: id % 5 + 1, comment: `Comment from ${id}` } } });
  }
  const closed = await watchFeedback(db, { today: '2027-01-16' });
  assert.equal(closed.closed, true);
  round = raw.prepare('SELECT * FROM fb_round').get();
  assert.equal(round.analysed_by, 'plain');

  const admin = await (await feedbackOverview(ctxFor(db))).json();
  assert.equal(admin.result.answered, 7);
  assert.ok(admin.result.comments.every((c) => c.name), 'an admin sees who said what');
  assert.equal(admin.result.comments.find((c) => c.name === 'Kwame Asare').department, null, 'Front office has fewer than 5');

  const hr = await (await feedbackOverview(ctxFor(db, { role: 'manager' }))).json();
  assert.ok(hr.result.comments.every((c) => c.name === null), 'HR sees no names');

  raw.exec('UPDATE fb_round SET anonymous = 1');
  const anon = await (await feedbackOverview(ctxFor(db))).json();
  assert.ok(anon.result.comments.every((c) => c.name === null), 'nobody sees names in an anonymous round');
});

test('a supervisor sees only their own department, and nothing if it is too small', async () => {
  const { raw, db } = setup();
  await openRound(db, { today: '2027-01-04' });
  const round = raw.prepare('SELECT * FROM fb_round').get();
  const q = JSON.parse(round.questions);
  for (const [id, , dept] of PEOPLE) {
    await submitAnswers(db, { round, staff: { id, department: dept }, answers: { [q[0].id]: { score: 3, comment: `From ${dept}` } } });
  }
  await watchFeedback(db, { today: '2027-01-16' });
  const fb = await (await feedbackOverview(ctxFor(db, { role: 'supervisor', permissions: ['att_manage'], staffId: 3 }))).json();
  assert.equal(fb.result.limited, true);
  assert.ok(fb.result.comments.every((c) => c.text === 'From F&B' && c.name === null));
  const fo = await (await feedbackOverview(ctxFor(db, { role: 'supervisor', permissions: ['att_manage'], staffId: 1 }))).json();
  assert.equal(fo.result.tooFew, true);
});

test('staff see the survey, say nothing of names unless anonymous, and answer once', async () => {
  const { db } = setup();
  await openRound(db, { today: '2027-01-04' });
  const me = { role: 'staff', permissions: ['att_me'], staffId: 3, url: 'https://x/api/me/feedback' };
  const got = await (await myFeedback(ctxFor(db, me))).json();
  assert.equal(got.round.anonymous, false);
  assert.equal(got.round.questions.length, 11);
  await answerFeedback(ctxFor(db, { ...me, body: { roundId: got.round.id, answers: { [got.round.questions[0].id]: { score: 5 } } } }));
  const after = await (await myFeedback(ctxFor(db, me))).json();
  assert.equal(after.round.done, true);
  await assert.rejects(() => answerFeedback(ctxFor(db, { ...me, body: { roundId: got.round.id, answers: {} } })), /already answered/);
});

test('the survey only speaks of anonymity when the round is anonymous', () => {
  const src = readFileSync('public/js/views/my-feedback.js', 'utf8');
  assert.match(src, /round\.anonymous\s*\n?\s*\? h\('div\.card\.my-fb-anon'/);
  assert.doesNotMatch(src.replace(/round\.anonymous[\s\S]*?: null/g, ''), /nobody can see who said what/i);
});

test('with the AI, themes, headlines, actions and sensitive comments come from its answer', async () => {
  const { raw, db } = setup();
  await openRound(db, { today: '2027-01-04' });
  const round = raw.prepare('SELECT * FROM fb_round').get();
  const q = JSON.parse(round.questions);
  const safety = q.find((x) => x.area === 'Safety and getting home');
  await submitAnswers(db, { round, staff: { id: 3, department: 'F&B' }, answers: { [safety.id]: { score: 1, comment: 'No car after the late shift' } } });
  await submitAnswers(db, { round, staff: { id: 4, department: 'F&B' }, answers: { [safety.id]: { score: 2, comment: 'The road home is dark' } } });
  const env = {
    AI: {
      async run(model, { messages }) {
        assert.match(messages[1].content, /No car after the late shift/);
        assert.doesNotMatch(messages[1].content, /Kojo|Yaw/, 'no names are sent');
        return { response: 'Sure. {"themes":[{"title":"Getting home at night","area":"Safety and getting home","summary":"No safe way home after late shifts.","tone":"negative","comments":[0,1]}],"areas":[{"area":"Safety and getting home","headline":"Lowest score: getting home."}],"actions":[{"title":"A night drop-off","why":"Two people walk home in the dark."}],"sensitive":[]}' };
      },
    },
  };
  const { closeRound } = await import('../src/lib/feedback.js');
  const a = await closeRound(db, round, { env });
  assert.equal(a.by, 'ai');
  assert.deepEqual([a.themes[0].title, a.themes[0].comments], ['Getting home at night', [0, 1]]);
  assert.equal(a.areas.find((x) => x.area === 'Safety and getting home').headline, 'Lowest score: getting home.');
  assert.equal(a.actions[0].title, 'A night drop-off');
});

test('a round sent to chosen people asks, reminds and shows the survey to them alone', async () => {
  const { raw, db } = setup();
  raw.prepare('INSERT INTO users (id, email, name, role, staff_id, active) VALUES (31, ?, ?, ?, 3, 1), (32, ?, ?, ?, 4, 1)')
    .run('kojo@example.test', 'Kojo Antwi', 'staff', 'yaw@example.test', 'Yaw Boateng', 'staff');
  // Kojo, and Nana who is new and would not usually be asked.
  const out = await openRound(db, { today: '2027-01-04', staffIds: [3, 8] });
  assert.equal(out.asked, 2);
  assert.deepEqual(raw.prepare('SELECT staff_id FROM fb_asked ORDER BY staff_id').all().map((r) => r.staff_id), [3, 8]);

  const asKojo = { role: 'staff', permissions: ['att_me'], staffId: 3, url: 'https://x/api/me/feedback' };
  const asYaw = { ...asKojo, staffId: 4 };
  assert.ok((await (await myFeedback(ctxFor(db, asKojo))).json()).round, 'Kojo sees it');
  assert.equal((await (await myFeedback(ctxFor(db, asYaw))).json()).round, null, 'Yaw does not');
  await assert.rejects(() => answerFeedback(ctxFor(db, { ...asYaw, body: { roundId: out.id, answers: {} } })), /not sent to you/);

  const reminded = await watchFeedback(db, { today: '2027-01-06' });
  assert.equal(reminded.reminded, 1, 'only Kojo, who has a login and was asked, is reminded');
  assert.deepEqual(raw.prepare("SELECT staff_id FROM att_nudge WHERE kind LIKE 'feedback:%'").all().map((r) => r.staff_id), [3]);
});

test('an empty choice is refused, and You said, we did reaches only those picked', async () => {
  const { raw, db } = setup();
  assert.equal((await openRound(db, { today: '2027-01-04', staffIds: [] })).opened, false);
  await openRound(db, { today: '2027-01-04' });
  raw.exec("UPDATE fb_round SET status = 'closed'");
  const id = raw.prepare('SELECT id FROM fb_round').get().id;
  raw.prepare("INSERT INTO fb_action (round_id, status, title) VALUES (?, 'doing', 'A night drop-off')").run(id);
  const { publishSaid } = await import('../src/routes/feedback.js');
  await publishSaid(ctxFor(db, { url: `https://x/api/feedback/rounds/${id}/said`, body: { staffIds: [3] } }), String(id));
  const me = (staffId) => ({ role: 'staff', permissions: ['att_me'], staffId, url: 'https://x/api/me/feedback' });
  assert.equal((await (await myFeedback(ctxFor(db, me(3)))).json()).said.actions[0].title, 'A night drop-off');
  assert.equal((await (await myFeedback(ctxFor(db, me(4)))).json()).said, null);
});
