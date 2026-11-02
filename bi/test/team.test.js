import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { addDays, todayIn } from '../src/lib/dates.js';
import * as team from '../src/routes/team.js';

/**
 * Team: each person's work across the apps, sorted into doing, coming up,
 * overdue, done, asked for and held back; and the evaluation, its measures,
 * patterns, weights, an admin's own measures, notes, and people seeing their
 * own. HIVE is its real schema with made-up staff; Maintenance and the POS
 * are made up. Everybody is invented.
 */

const OWNER = { name: 'Test Owner', isOwner: true, access: [] };
const SUP = { id: 51, name: 'Yaw Test', email: 'yaw@example.test', isOwner: false, access: [{ systemId: 'insight', role: 'supervisor' }] };
const today = todayIn('UTC');
const dow = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();

async function setUp({ mondaysLate = true } = {}) {
  const { db, raw } = freshDb();
  const hive = freshDb('../migrations');
  const env = { DB: db, ATT_DB: hive.db, SSO_SECRET_MAINTENANCE: 'mx', MAINTENANCE_TASKS_URL: 'https://mx.example.test/functions/v1/tasks', SSO_SECRET_POS: 'pos' };
  await db.prepare(`UPDATE sources SET config = '{"base":"https://pos-fn.example.test/"}', enabled = 1 WHERE id = 'pos'`).run();
  raw.exec(`INSERT INTO accounts (id, email, name, active) VALUES (51, 'yaw@example.test', 'Yaw Test', 1);
    INSERT INTO account_access (account_id, system_id, role) VALUES (51, 'insight', 'supervisor');`);
  // Only the made-up people: HIVE's own set-up adds some of its own.
  hive.raw.exec('PRAGMA foreign_keys = OFF; DELETE FROM att_days; DELETE FROM att_roster; DELETE FROM att_staff;');
  hive.raw.exec(`INSERT INTO users (id, name, email, role, active) VALUES (801, 'Yaw Test', 'yaw@example.test', 'staff', 1), (802, 'Kojo Test', 'kojo@example.test', 'staff', 1), (803, 'Ama Test', 'ama@example.test', 'staff', 1);
    INSERT INTO att_shifts (id, name, starts_at, ends_at) VALUES (99, 'Test day', '07:00', '16:00');
    INSERT INTO att_staff (id, employee_no, name, department, job_title, user_id, active) VALUES
      (1, 'E1', 'Yaw Test', 'Maintenance', 'Artisan', 801, 1), (2, 'E2', 'Kojo Test', 'Maintenance', 'Artisan', 802, 1), (3, 'E3', 'Ama Test', 'Kitchen', 'Cook', 803, 1),
      (4, 'E4', 'Left Test', 'Kitchen', 'Cook', NULL, 0);`);
  // 120 days of day shifts, Monday to Saturday. Yaw late most Mondays; missed two.
  for (let i = 120; i >= 0; i -= 1) {
    const d = addDays(today, -i);
    if (dow(d) === 0) continue;
    for (const staff of [1, 2, 3]) {
      const missed = staff === 1 && (i === 40 || i === 41);
      const late = staff === 1 && mondaysLate && dow(d) === 1 && i < 85 ? 18 : 0;
      const inT = missed ? null : `${String(7 + (late ? 1 : 0)).padStart(2, '0')}:${late ? '18' : '00'}:00`;
      const outT = missed || i === 0 ? null : '16:00:00';
      hive.raw.prepare(`INSERT INTO att_days (staff_id, day, shift_id, scheduled, first_in, last_out, late_minutes, status) VALUES (?, ?, 99, 1, ?, ?, ?, ?)`)
        .run(staff, d, inT, outT, late, missed ? 'absent' : late ? 'late' : 'present');
    }
  }
  // The rota ahead.
  for (let i = 1; i <= 3; i += 1) if (dow(addDays(today, i)) !== 0) hive.raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id) VALUES (1, ?, 99)').run(addDays(today, i));
  // What Yaw asked for in HIVE: an advance waiting, leave approved.
  hive.raw.exec(`INSERT INTO hr_advance (staff_id, amount, months, monthly, status, asked_at) VALUES (1, 300, 3, 100, 'requested', '${addDays(today, -3)} 09:00:00');
    INSERT INTO att_leave (staff_id, reason_code, from_day, to_day, days, status, requested_at, decided_at) VALUES (1, 'annual', '${addDays(today, 12)}', '${addDays(today, 13)}', 2, 'approved', '${addDays(today, -6)} 10:00:00', '${addDays(today, -5)} 10:00:00');`);
  // An Insight to-do given to Yaw: overdue.
  raw.prepare(`INSERT INTO shift_task (key, what, for_id, for_name, due, made_by, made_at) VALUES ('k', 'Fix the fridge door seal', 51, 'Yaw Test', ?, 'Ama Test', ?)`).run(addDays(today, -2), `${addDays(today, -4)} 09:00:00`);

  // Maintenance: jobs for both artisans. Yaw's electrical jobs take three days; Kojo's one. Yaw has one waiting on parts, overdue.
  const jobs = { 'yaw@example.test': [], 'kojo@example.test': [] };
  for (let i = 1; i <= 12; i += 1) {
    const d = addDays(today, -i * 6);
    for (const [email, took] of [['yaw@example.test', 3], ['kojo@example.test', 1]]) {
      jobs[email].push({ id: `job:${email}:${i}`, app: 'maintenance', kind: 'job', title: `Electrical — R${i}`, status: 'done', category: 'Electrical', due: addDays(d, 3),
        created_at: `${d}T08:00:00Z`, started_at: `${d}T09:00:00Z`, done_at: `${addDays(d, took)}T09:00:00Z`, routine: false, reopened: email === 'yaw@example.test' && i === 2 ? 1 : 0 });
      jobs[email].push({ id: `round:${email}:${i}`, app: 'maintenance', kind: 'round', title: 'Morning round', status: 'done', routine: true, due: d, done_at: `${d}T10:00:00Z`, created_at: `${d}T07:00:00Z` });
    }
  }
  jobs['yaw@example.test'].push(
    { id: 'job:yaw:open', app: 'maintenance', kind: 'job', title: 'Plumbing — R12: shower tap drips', status: 'open', category: 'Plumbing', due: addDays(today, -3),
      created_at: `${addDays(today, -6)}T08:00:00Z`, waiting_on: 'Parts: purchase request not approved', waiting_since: `${addDays(today, -4)}T08:00:00Z`, waited_days: 4 },
    { id: 'job:yaw:doing', app: 'maintenance', kind: 'job', title: 'Generator service', status: 'doing', category: 'Service', due: today, started_at: `${today}T09:10:00Z` },
    { id: 'pr:yaw', app: 'maintenance', kind: 'purchase_request', title: 'Parts for R12 tap', status: 'open', asked: true, decision: 'waiting', created_at: `${addDays(today, -4)}T08:00:00Z`,
      waiting_on: 'A coordinator to approve the purchase', waiting_since: `${addDays(today, -4)}T08:00:00Z` },
  );
  const calls = [];
  team.io.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, signed: Boolean(init.headers['X-Till-Sig']) });
    if (String(url).startsWith('https://mx.example.test')) {
      return Response.json({ ok: true, people: Object.fromEntries(body.emails.map((e) => [e, { found: { maintenance: Boolean(jobs[e]), teamtasks: false }, items: (jobs[e] || []).filter((x) => [x.due, String(x.done_at || '').slice(0, 10), String(x.created_at || '').slice(0, 10)].some((d) => d && d >= body.from && d <= body.to) || ['open', 'doing'].includes(x.status)) }])) });
    }
    if (String(url).startsWith('https://pos-fn.example.test')) {
      return Response.json({ ok: true, people: { 'ama@example.test': { found: true, items: [
        { id: 'count:1', app: 'pos', kind: 'count', title: 'Kitchen count', status: 'open', routine: true, due: addDays(today, -1), waiting_on: 'Count held: 2 lines differ, an admin decides', waiting_since: `${addDays(today, -1)}T20:00:00Z` },
      ] } } });
    }
    return new Response('no', { status: 404 });
  };
  return { env, raw, hive, calls };
}

test('everybody in HIVE: what they are doing, have coming up, overdue, done and asked for, and what holds them back, from every app', async () => {
  const { env, calls } = await setUp();
  await assert.rejects(team.overview(env, { period: 'week' }, SUP), /for admins/);
  const out = await team.overview(env, { period: 'week', day: today }, OWNER);
  assert.deepEqual(out.rows.map((r) => r.name).sort(), ['Ama Test', 'Kojo Test', 'Yaw Test'], 'left staff are not on it');
  // One call each to Maintenance and the POS, signed, for everybody's emails.
  assert.ok(calls.some((c) => c.url.includes('mx.example') && c.body.action === 'activity' && c.signed && c.body.emails.includes('yaw@example.test')));
  assert.ok(calls.some((c) => c.url.includes('pos-fn') && c.signed));
  assert.equal(out.sources.maintenance, 'ok');
  const yaw = out.rows.find((r) => r.name === 'Yaw Test');
  assert.equal(yaw.rows, undefined);
  assert.equal(yaw.doing, 1, 'the generator service');
  assert.ok(yaw.overdue >= 2, 'the tap job and the to-do');
  assert.equal(yaw.asked, 2, 'the advance and the parts');
  assert.ok(yaw.held.some((h) => /Parts: purchase request not approved/.test(h.why)));
  assert.ok(yaw.heldCount >= 3, 'the job on parts, the advance and the purchase request');
  assert.equal(out.rows[0].name, 'Yaw Test', 'the most behind and held back first');
  assert.equal(out.rows.find((r) => r.name === 'Ama Test').held[0].why, 'Count held: 2 lines differ, an admin decides');

  const p = await team.person(env, 1, { period: 'week', day: today }, OWNER);
  assert.equal(p.person.name, 'Yaw Test');
  assert.deepEqual(p.lists.doing.map((x) => x.title), ['Generator service']);
  assert.ok(p.lists.overdue.some((x) => x.title === 'Fix the fridge door seal' && x.app === 'insight'));
  assert.ok(p.lists.due.some((x) => x.kind === 'shift'), 'his shifts ahead');
  // Asked for: what is still waiting, and what was asked or decided in the period (the leave, decided days ago, is in the month).
  assert.deepEqual(p.lists.asked.map((x) => x.title).sort(), ['Advance GH₵ 300', 'Parts for R12 tap']);
  const inMonth = await team.person(env, 1, { period: 'month', day: addDays(today, -5) }, OWNER);
  assert.ok(inMonth.lists.asked.some((x) => x.title.startsWith('Leave ') && x.decision === 'approved'));
  // Looking back at another period still says how they are today.
  const back = await team.overview(env, { period: 'week', day: addDays(today, -14) }, OWNER);
  assert.equal(back.rows.find((r) => r.name === 'Ama Test').today.state, 'on');
  const backP = await team.person(env, 1, { period: 'week', day: addDays(today, -14) }, OWNER);
  assert.equal(backP.person.today.state, dow(today) === 1 ? 'late' : 'on');
  const adv = p.lists.held.find((x) => /advance/.test(x.waitingOn));
  assert.equal(adv.days, 3);
  // A month: each day, and whether he was off.
  const month = await team.person(env, 1, { period: 'month', day: today }, OWNER);
  assert.equal(month.days.length >= 28, true);
  assert.ok(month.days.some((d) => d.off), 'Sundays off');
});

test('the evaluation: eight measures against the same role, held-back time not counted, patterns that repeat, and what to talk about', async () => {
  const { env } = await setUp();
  const e = await team.evaluation(env, 1, OWNER);
  const m = Object.fromEntries(e.measures.map((x) => [x.id, x]));
  // Turned up to all but two shifts; late on most Mondays.
  assert.ok(m.turns_up.score > 4, m.turns_up.facts);
  assert.match(m.turns_up.facts, /^\d+ of \d+ shifts worked$/);
  assert.ok(m.on_time.score < m.turns_up.score, m.on_time.facts);
  // Against Kojo, the other artisan: as much done per shift.
  assert.match(m.throughput.facts, /done a shift; others in the role/);
  // One of twelve jobs reopened.
  assert.match(m.first_time.facts, /^1 of \d+ reopened/);
  // Rounds every day: routine.
  assert.ok(m.routine.score >= 4.5, m.routine.facts);
  // No money things for an artisan: not scored, not a low mark.
  assert.equal(m.money.score, null);
  assert.equal(m.money.facts, 'too little to judge');
  assert.ok(e.score >= 1 && e.score <= 5);
  assert.equal(e.peers, 2);
  assert.ok([1, 2].includes(e.rank));
  assert.match(e.verdict, /^(Strong|Good|Solid|Needs support|Struggling), (improving|slipping|steady)$/);
  // Patterns: late on Mondays; electrical jobs take him three times as long.
  const titles = e.patterns.map((x) => x.title);
  assert.ok(titles.includes('Late on Mondays'), titles.join(' | '));
  assert.ok(titles.includes('Electrical takes them long'), titles.join(' | '));
  assert.ok(e.talk.some((t) => /^Mondays:/.test(t)));
  assert.equal(e.months.length, 6);
  // Nobody else's evaluation for a supervisor.
  await assert.rejects(team.evaluation(env, 1, SUP), /for admins/);
});

test('weights, measures of an admin’s own, notes, and people seeing their own when allowed', async () => {
  const { env } = await setUp();
  const before = (await team.evaluation(env, 1, OWNER)).score;
  // On time counted three times: his rating falls (he is late on Mondays).
  await assert.rejects(team.saveSettings(env, { weights: { on_time: 9 } }, OWNER), /0 \(not counted\) to 3/);
  await assert.rejects(team.saveSettings(env, { weights: { on_time: 3 } }, SUP), /Only an admin/);
  await team.saveSettings(env, { weights: { on_time: 3 } }, OWNER);
  const weighted = (await team.evaluation(env, 1, OWNER)).score;
  assert.ok(weighted < before, `${weighted} < ${before}`);
  // A measure of the admin's own, scored by hand.
  const s = await team.saveSettings(env, { add: { label: 'Guest complaints', what: 'complaints about their work' } }, OWNER);
  const custom = s.custom[0];
  assert.equal(custom.label, 'Guest complaints');
  let e = await team.evaluation(env, 1, OWNER);
  assert.equal(e.measures.find((x) => x.id === custom.id).score, null);
  await assert.rejects(team.scoreCustom(env, 1, { measure: custom.id, score: 7 }, OWNER), /1 to 5/);
  await team.scoreCustom(env, 1, { measure: custom.id, score: 1 }, OWNER);
  e = await team.evaluation(env, 1, OWNER);
  assert.equal(e.measures.find((x) => x.id === custom.id).score, 1);
  assert.ok(e.score < weighted, 'a low mark on it counts');
  // Notes, kept with the evaluation.
  await team.addNote(env, 1, { text: 'Talked about Mondays: agreed 07:30 start' }, OWNER);
  e = await team.evaluation(env, 1, OWNER);
  assert.equal(e.notes[0].text, 'Talked about Mondays: agreed 07:30 start');
  // Their own: not until an admin allows it; then theirs only, without the notes.
  await assert.rejects(team.own(env, SUP), /not shown to people yet/);
  await team.saveSettings(env, { showOwn: true }, OWNER);
  const mine = await team.own(env, SUP);
  assert.equal(mine.person.name, 'Yaw Test');
  assert.deepEqual(mine.notes, []);
  assert.equal(mine.settings, null);
});

test('periods: a day, the week from Monday, the month', () => {
  assert.deepEqual(team.periodOf('day', '2026-11-04'), { period: 'day', from: '2026-11-04', to: '2026-11-04' });
  assert.deepEqual(team.periodOf('week', '2026-11-04'), { period: 'week', from: '2026-11-02', to: '2026-11-08' });
  assert.deepEqual(team.periodOf('month', '2026-02-10'), { period: 'month', from: '2026-02-01', to: '2026-02-28' });
  // On time allows for days held by somebody else.
  assert.equal(team.onTime({ status: 'done', due: '2026-11-01', done_at: '2026-11-04T10:00:00Z', waited_days: 3 }), true);
  assert.equal(team.onTime({ status: 'done', due: '2026-11-01', done_at: '2026-11-04T10:00:00Z', waited_days: 1 }), false);
});
