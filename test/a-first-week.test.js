import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  isDone, isFor, nextForThem, ownerOf, progressOf, sourceOf, stepsFor, whoFor,
} from '../src/lib/onboarding.js';
import { DEFAULT_STEPS, STEP_CODES } from '../src/lib/onboarding-content.js';
import {
  beginFor, finishOnboarding, installStandard, landsOnOnboarding, myOnboarding,
  onboardingFor, onboardings, saveStep, startOnboarding, tickStep,
} from '../src/routes/onboarding.js';

/**
 * A first week.
 *
 * A new hire's first day at a hotel is a person being walked round by whoever
 * happens to be free, told six things they will not remember, and handed a
 * uniform. What they signed, what they were shown and what they were told is
 * afterwards a matter of whose memory you ask, which is exactly the question
 * that matters when something goes wrong in month three.
 *
 * The design worth testing is that it ORCHESTRATES rather than duplicates. A
 * step either names where its proof already lives in this app, or a person
 * ticks it. Nothing about a contract, the handbook or somebody's file is
 * written down twice, so the checklist cannot come to disagree with the thing
 * it reports on.
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

const TEAM = [
  { id: 1, name: 'Ama Mensah', department: 'Reception', tags: null },
  { id: 2, name: 'Kofi Boateng', department: 'Kitchen', tags: null },
  { id: 3, name: 'Yaa Dede', department: 'Reception', tags: JSON.stringify(['Team lead']) },
];

function setup({ on = true } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_staff; DELETE FROM users; DELETE FROM ob_step;
            DELETE FROM ob_done; DELETE FROM ob_state; DELETE FROM hr_document;
            DELETE FROM hr_contract;`);
  raw.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?2',
  ).run('onboarding_on', on ? '1' : '0');
  raw.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?2',
  ).run('ob_owner_words', 'Welcome. We are glad you are here.');
  raw.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?2',
  ).run('ob_owner_name', 'Mathias Schwender');

  for (const p of TEAM) {
    raw.prepare(
      `INSERT INTO att_staff (id, employee_no, name, department, tags, hired_on, active)
       VALUES (?, ?, ?, ?, ?, '2026-09-01', 1)`,
    ).run(p.id, String(p.id), p.name, p.department, p.tags);
    raw.prepare(
      'INSERT INTO users (id, name, role, active, staff_id) VALUES (?, ?, ?, 1, ?)',
    ).run(100 + p.id, p.name, 'staff', p.id);
  }
  return { raw, db: d1(raw) };
}

const asStaff = (id) => ({
  user: { id: 100 + id, name: TEAM.find((p) => p.id === id).name, role: 'staff', staff_id: id },
  permissions: ['att_me'],
});
const asOffice = () => ({
  user: { id: 90, name: 'Akua', role: 'manager' },
  permissions: ['hr_view', 'hr_manage'],
});

const ctx = (db, session, body = null) => ({
  db,
  env: {},
  url: new URL('https://x/api/onboarding'),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }),
});

const read = async (r) => r.json();

// ---------------------------------------------------------------------------
// Who is onboarding
// ---------------------------------------------------------------------------

test('nobody already on the payroll is dragged through a first week', async () => {
  const { db } = setup();
  // Onboarding is on and the standard steps are in, and still none of the
  // three existing people is onboarding, because none has a row saying so.
  await installStandard(ctx(db, asOffice(), {}));

  for (const id of [1, 2, 3]) {
    assert.equal(await landsOnOnboarding(db, id), false);
    const mine = await read(await myOnboarding(ctx(db, asStaff(id))));
    assert.equal(mine.onboarding, false);
  }
});

test('somebody added to the staff list while it is on gets one', async () => {
  const { raw, db } = setup();
  await beginFor(db, 2, 'Added to the staff list');
  assert.equal(await landsOnOnboarding(db, 2), true);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM ob_state').get().n, 1);
});

test('and nobody gets one while it is switched off', async () => {
  const { raw, db } = setup({ on: false });
  await beginFor(db, 2, 'Added to the staff list');
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM ob_state').get().n, 0);
  assert.equal(await landsOnOnboarding(db, 2), false);
});

test('the office can start one by hand for somebody already here', async () => {
  const { db } = setup();
  await startOnboarding(ctx(db, asOffice(), {}), 1);
  assert.equal(await landsOnOnboarding(db, 1), true);
});

test('a member of staff cannot start one for themselves or anybody else', async () => {
  const { db } = setup();
  await assert.rejects(() => startOnboarding(ctx(db, asStaff(1), {}), 1), /Not yours/);
  await assert.rejects(() => tickStep(ctx(db, asStaff(1), { staffId: 1 }), 1), /Not yours/);
});

// ---------------------------------------------------------------------------
// What the checklist does
// ---------------------------------------------------------------------------

test('the standard set installs once and does not duplicate', async () => {
  const { raw, db } = setup();
  const first = await read(await installStandard(ctx(db, asOffice(), {})));
  assert.equal(first.added, DEFAULT_STEPS.length);

  const again = await read(await installStandard(ctx(db, asOffice(), {})));
  assert.equal(again.added, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM ob_step').get().n, DEFAULT_STEPS.length);
  assert.equal(new Set(STEP_CODES).size, STEP_CODES.length, 'the codes are unique');
});

test('a step ticks off, and taking the tick back reopens the week', async () => {
  const { raw, db } = setup();
  await installStandard(ctx(db, asOffice(), {}));
  await startOnboarding(ctx(db, asOffice(), {}), 1);
  const tour = raw.prepare("SELECT id FROM ob_step WHERE code = 'tour'").get();

  await tickStep(ctx(db, asOffice(), { staffId: 1, done: true }), tour.id);
  const after = await read(await onboardingFor(ctx(db, asOffice()), 1));
  const step = after.steps.find((s) => s.title.includes('Walk the property'));
  assert.equal(step.done, true);
  assert.match(step.doneBy, /Akua/);

  // Settled in early, then a tick taken back: the week reopens rather than
  // staying closed with something visibly missing.
  await finishOnboarding(ctx(db, asOffice(), {}), 1);
  assert.equal(await landsOnOnboarding(db, 1), false);

  await tickStep(ctx(db, asOffice(), { staffId: 1, done: false }), tour.id);
  assert.equal(await landsOnOnboarding(db, 1), true);
});

test('a step that ticks itself cannot be ticked by hand', async () => {
  const { raw, db } = setup();
  await installStandard(ctx(db, asOffice(), {}));
  await startOnboarding(ctx(db, asOffice(), {}), 1);

  for (const code of ['contract', 'handbook', 'documents', 'details']) {
    const step = raw.prepare('SELECT id, title FROM ob_step WHERE code = ?').get(code);
    await assert.rejects(
      () => tickStep(ctx(db, asOffice(), { staffId: 1, done: true }), step.id),
      /ticks itself off/,
      `${code} could be ticked by hand`,
    );
  }
});

test('a signed contract ticks its own step, and an unsigned one does not', async () => {
  const { raw, db } = setup();
  await installStandard(ctx(db, asOffice(), {}));
  await startOnboarding(ctx(db, asOffice(), {}), 1);

  const contractStep = (out) => out.steps.find((s) => s.title.includes('sign your contract'));

  raw.prepare(
    `INSERT INTO hr_contract (staff_id, title, body, body_hash, status, satisfies)
     VALUES (1, 'Contract', 'words', 'h', 'sent', 'contract')`,
  ).run();
  assert.equal(contractStep(await read(await onboardingFor(ctx(db, asOffice()), 1))).done, false);

  raw.prepare("UPDATE hr_contract SET status = 'signed' WHERE staff_id = 1").run();
  assert.equal(contractStep(await read(await onboardingFor(ctx(db, asOffice()), 1))).done, true);
});

test('a step aimed at the kitchen is not on a receptionist’s list', async () => {
  const { db } = setup();
  await installStandard(ctx(db, asOffice(), {}));
  await startOnboarding(ctx(db, asOffice(), {}), 1);   // Reception
  await startOnboarding(ctx(db, asOffice(), {}), 2);   // Kitchen

  const reception = await read(await onboardingFor(ctx(db, asOffice()), 1));
  const kitchen = await read(await onboardingFor(ctx(db, asOffice()), 2));

  const food = (out) => out.steps.some((s) => s.title.includes('Food hygiene'));
  assert.equal(food(reception), false);
  assert.equal(food(kitchen), true);
  // And the denominator moves with it, or the two would read as the same week.
  assert.ok(kitchen.progress.of > reception.progress.of);
});

// ---------------------------------------------------------------------------
// What the new hire sees
// ---------------------------------------------------------------------------

test('the welcome comes with the checklist, and a blank one is not drawn', async () => {
  const { raw, db } = setup();
  await installStandard(ctx(db, asOffice(), {}));
  await startOnboarding(ctx(db, asOffice(), {}), 1);

  const mine = await read(await myOnboarding(ctx(db, asStaff(1))));
  assert.equal(mine.onboarding, true);
  assert.equal(mine.welcomes.length, 1, 'only the one that has words in it');
  assert.equal(mine.welcomes[0].name, 'Mathias Schwender');
  assert.equal(mine.welcomes[0].role, 'Owner');
  assert.ok(mine.steps.length > 0);
  assert.equal(mine.me.firstName, 'Ama');

  raw.prepare("UPDATE settings SET value = 'Glad to have you.' WHERE key = 'ob_md_words'").run();
  raw.prepare("UPDATE settings SET value = 'Kwame' WHERE key = 'ob_md_name'").run();
  const both = await read(await myOnboarding(ctx(db, asStaff(1))));
  assert.equal(both.welcomes.length, 2);
  assert.deepEqual(both.welcomes.map((w) => w.role), ['Owner', 'Managing Director']);
});

test('the next thing is theirs where there is one of theirs to do', async () => {
  const { db } = setup();
  await installStandard(ctx(db, asOffice(), {}));
  await startOnboarding(ctx(db, asOffice(), {}), 1);

  const mine = await read(await myOnboarding(ctx(db, asStaff(1))));
  // Sending their own details is the first thing on the standard list and is
  // theirs to do, so that is what the screen points at.
  assert.match(mine.next.title, /details/i);
});

test('a first week closes itself the moment the last thing is done', async () => {
  const { raw, db } = setup();
  // A checklist of one manual step, so this can be finished without inventing
  // a contract, a file and a handbook.
  await saveStep(ctx(db, asOffice(), { title: 'Walk the property', source: 'manual', order: 10 }));
  await startOnboarding(ctx(db, asOffice(), {}), 1);
  const step = raw.prepare('SELECT id FROM ob_step').get();

  let mine = await read(await myOnboarding(ctx(db, asStaff(1))));
  assert.equal(mine.progress.done, 0);
  assert.equal(await landsOnOnboarding(db, 1), true);

  await tickStep(ctx(db, asOffice(), { staffId: 1, done: true }), step.id);
  mine = await read(await myOnboarding(ctx(db, asStaff(1))));
  assert.equal(mine.progress.done, 1);
  assert.equal(mine.progress.percent, 100);
  // Reading it is what stamps it, so the app stops landing them here.
  assert.equal(await landsOnOnboarding(db, 1), false);
});

test('the office sees everybody’s, with the ones still open first', async () => {
  const { db } = setup();
  await installStandard(ctx(db, asOffice(), {}));
  await startOnboarding(ctx(db, asOffice(), {}), 1);
  await startOnboarding(ctx(db, asOffice(), {}), 2);
  await finishOnboarding(ctx(db, asOffice(), {}), 1);

  const out = await read(await onboardings(ctx(db, asOffice())));
  assert.equal(out.people.length, 2);
  assert.equal(out.people[0].finishedAt, null, 'the open one comes first');
  assert.ok(out.people[0].of > 0);
  assert.ok(Array.isArray(out.people[0].waiting));
});

test('somebody who may read personnel records may read these and not change them', async () => {
  const { db } = setup();
  const viewer = { user: { id: 91, name: 'Efua', role: 'manager' }, permissions: ['hr_view'] };
  await startOnboarding(ctx(db, asOffice(), {}), 1);

  const out = await read(await onboardings(ctx(db, viewer)));
  assert.equal(out.mayManage, false);
  await assert.rejects(() => startOnboarding(ctx(db, viewer, {}), 2), /Not yours/);
});

// ---------------------------------------------------------------------------
// The rules on their own
// ---------------------------------------------------------------------------

test('who a step is for reads the same way a handbook chapter does', () => {
  const everybody = { departments: null, tags: null };
  const kitchen = { departments: JSON.stringify(['Kitchen']) };
  const leads = { tags: JSON.stringify(['Team lead']) };

  assert.equal(isFor(everybody, TEAM[0]), true);
  assert.equal(whoFor(everybody), 'Everybody');
  assert.equal(isFor(kitchen, TEAM[0]), false);
  assert.equal(isFor(kitchen, TEAM[1]), true);
  assert.equal(isFor(leads, TEAM[2]), true);
  assert.equal(isFor(leads, TEAM[0]), false);
});

test('an unrecognised source is treated as manual, which is the harmless answer', () => {
  assert.equal(sourceOf({ source: 'nonsense' }), 'manual');
  assert.equal(sourceOf({}), 'manual');
  assert.equal(sourceOf({ source: 'handbook' }), 'handbook');
  assert.equal(ownerOf({ owner: 'nonsense' }), 'office');
  assert.equal(ownerOf({ owner: 'staff' }), 'staff');
});

test('a checklist with nothing on it is a finished week, not a crash', () => {
  const out = progressOf([], TEAM[0], {});
  assert.equal(out.of, 0);
  assert.equal(out.percent, 100);
  assert.equal(out.complete, true);
  assert.equal(nextForThem([], TEAM[0], {}), null);
});

test('a step that is off the list counts for nothing', () => {
  const steps = [
    { id: 1, title: 'On', source: 'manual', active: 1, sort_order: 1 },
    { id: 2, title: 'Off', source: 'manual', active: 0, sort_order: 2 },
  ];
  assert.deepEqual(stepsFor(steps, TEAM[0]).map((s) => s.id), [1]);
  assert.equal(progressOf(steps, TEAM[0], {}).of, 1);
});

test('a derived step reads the record and never a tick', () => {
  const step = { id: 7, source: 'contract' };
  // Even with a tick against it, which the route refuses to write anyway.
  assert.equal(isDone(step, { ticked: new Set([7]), settled: { contract: false } }), false);
  assert.equal(isDone(step, { ticked: new Set(), settled: { contract: true } }), true);
});

test('the screen and the setup switch are wired up', () => {
  const app = readFileSync('public/js/app.js', 'utf8');
  // A new hire lands here rather than on a rota with nothing on it yet.
  assert.match(app, /if \(state\.startingOut && allowed/);
  assert.match(app, /return 'onboarding';/);

  const setup = readFileSync('src/routes/attendance-setup.js', 'utf8');
  assert.match(setup, /\['onboarding_on', \(v\) => \(v === '1'/);

  // And the switch comes back with the bootstrap, or the rules screen would
  // draw the default and the next save would write it over what is really set.
  const att = readFileSync('src/routes/attendance.js', 'utf8');
  assert.match(att, /'onboarding_on',/);
  for (const key of ['ob_owner_words', 'ob_md_words']) {
    assert.ok(att.includes(`'${key}'`), `${key} is not sent with the bootstrap`);
  }

  const sql = readFileSync('migrations/0110_the_first_week.sql', 'utf8');
  assert.match(sql, /'onboarding_on', '0'/, 'it has to arrive switched off');
});
