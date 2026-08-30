import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  cutIntoSlots, howItIsGoing, movesFrom, offerable, readCandidateList, staffDocumentKind,
  whyNot,
} from '../src/lib/recruitment.js';
import {
  addSlots, addFile, board, bookSlot, candidate, hire, inviteCandidate, moveCandidate,
  addCandidate, createRole, scoreCandidate, applyCandidates, readCandidates,
} from '../src/routes/recruitment.js';
import { choose, open, release } from '../src/routes/hiring.js';

/**
 * Recruitment, from an application to a contract.
 *
 * Four things are worth pinning down, and each of them is a thing that would
 * be expensive to get wrong on a real morning.
 *
 * NOTHING BUT `hire` PUTS ANYBODY ON THE BOOKS, and `hire` needs the setup
 * permission on top of running the recruitment.
 *
 * TWO CANDIDATES CANNOT TAKE THE SAME HALF HOUR, whichever door they come
 * through — their own phone or the office booking it for them.
 *
 * A LINK SHOWS ONLY WHAT IT SHOULD: times for that person's vacancy, still
 * free, still in the future, and nothing about anybody else.
 *
 * AND NOTHING IS EVER DELETED. Somebody turned down in March is somebody to
 * ring in June.
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
  raw.exec(`DELETE FROM att_staff; DELETE FROM hr_profile; DELETE FROM app_notices;
            DELETE FROM audit_log; DELETE FROM rec_role; DELETE FROM rec_candidate;
            DELETE FROM rec_slot; DELETE FROM rec_event;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  return { raw, db: d1(raw) };
}

const ADMIN = ['rec_view', 'rec_manage', 'att_setup'];
const MANAGER = ['rec_view', 'rec_manage'];

const ctx = (db, body = null, permissions = ADMIN, name = 'Kwame') => ({
  db,
  env: {},
  url: new URL('https://x/api/rec'),
  session: { user: { id: 1, name, role: 'admin' }, permissions },
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const body = async (res) => JSON.parse(await res.text());

/** Tomorrow and the day after, so a published diary is never in the past. */
const soon = (days = 1) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

async function aRole(db, over = {}) {
  return (await body(await createRole(ctx(db, {
    title: 'Room attendant', department: 'Housekeeping', headcount: 1, ...over,
  })))).id;
}

async function aCandidate(db, roleId, name = 'Ama Mensah', over = {}) {
  return (await body(await addCandidate(ctx(db, {
    name, roleId, phone: '024 111 2222', ...over,
  })))).id;
}

// ------------------------------------------------------------------ pure --

test('the pipeline will not let somebody be marked as staff by hand', () => {
  assert.match(whyNot('offer', 'hired'), /Take them on/);
  // Unless a record actually exists, which is what `hire` sets up before it
  // moves them.
  assert.equal(whyNot('offer', 'hired', { hasStaffRecord: true }), null);
  assert.match(whyNot('hired', 'applied'), /on the books now/);
  assert.match(whyNot('applied', 'applied'), /already there/);
  assert.match(whyNot('applied', 'nonsense'), /not a stage/);
});

test('the moves offered lead forward first, then out, then back', () => {
  const keys = movesFrom('shortlisted').map((s) => s.key);
  assert.equal(keys[0], 'interview', 'forward is first');
  assert.deepEqual(keys.slice(1, 3), ['not_taken', 'declined']);
  assert.ok(keys.includes('applied'), 'and back, for a mistake');
  assert.ok(!keys.includes('hired'), 'never straight to the books');
});

test('a morning is cut into interviews, and the last one has to fit', () => {
  const slots = cutIntoSlots({ day: '2026-09-01', from: '10:00', to: '13:00', minutes: 30 });
  assert.equal(slots.length, 6);
  assert.equal(slots[0].startsAt, '10:00');
  assert.equal(slots[5].startsAt, '12:30');

  // 10:00 to 13:00 at 45 minutes is four, not four and a stub.
  assert.deepEqual(
    cutIntoSlots({ day: '2026-09-01', from: '10:00', to: '13:00', minutes: 45 })
      .map((s) => s.startsAt),
    ['10:00', '10:45', '11:30', '12:15'],
  );
  assert.deepEqual(cutIntoSlots({ day: '2026-09-01', from: '13:00', to: '10:00' }), []);
  assert.deepEqual(cutIntoSlots({ day: '2026-09-01', from: 'not a time', to: '10:00' }), []);
});

test('a time in the past is never offered, however free it is', () => {
  const slots = [
    { day: '2026-08-30', starts_at: '09:00', candidate_id: null, cancelled_at: null },
    { day: '2026-08-30', starts_at: '15:00', candidate_id: null, cancelled_at: null },
    { day: '2026-08-30', starts_at: '16:00', candidate_id: 4, cancelled_at: null },
    { day: '2026-08-30', starts_at: '17:00', candidate_id: null, cancelled_at: '2026-08-01' },
  ];
  const free = offerable(slots, { now: '2026-08-30T12:00' });
  assert.deepEqual(free.map((s) => s.starts_at), ['15:00']);

  // Their own time still shows, because that is the one they can move off.
  const mine = offerable(slots, { now: '2026-08-30T12:00', forCandidate: 4 });
  assert.deepEqual(mine.map((s) => s.starts_at), ['15:00', '16:00']);
});

test('a pasted list reads names and numbers, and skips what is not one', () => {
  const rows = readCandidateList(`
    Ama Mensah, 024 111 2222
    1. Kofi Boateng\t020 333 4444\tkofi@example.com
    Yaa Owusu
    0244 000 111
    Ama Mensah, 024 999 9999
  `);
  assert.deepEqual(rows.map((r) => r.name), ['Ama Mensah', 'Kofi Boateng', 'Yaa Owusu']);
  assert.equal(rows[0].phone, '024 111 2222');
  assert.equal(rows[1].email, 'kofi@example.com');
  assert.equal(rows[1].name, 'Kofi Boateng', 'the numbering is not part of the name');
  assert.equal(rows[2].phone, null);
});

test('a vacancy with nobody left in it says so rather than showing a zero', () => {
  const role = { headcount: 2, status: 'open' };
  assert.match(howItIsGoing(role, []).text, /Nobody has applied/);
  assert.equal(howItIsGoing(role, [{ stage: 'hired' }]).tone, 'bad');
  assert.match(howItIsGoing(role, [{ stage: 'hired' }]).text, /1 still to find and nobody left/);
  assert.equal(howItIsGoing(role, [{ stage: 'hired' }, { stage: 'hired' }]).tone, 'good');
  assert.match(howItIsGoing(role, [{ stage: 'hired' }, { stage: 'offer' }]).text, /1 in the pipeline/);
});

// ------------------------------------------------------------- the board --

test('the board carries the vacancies, the pipeline and the diary at once', async () => {
  const { db } = setup();
  const roleId = await aRole(db);
  await aCandidate(db, roleId);
  await addSlots(ctx(db, { roleId, day: soon(), from: '10:00', to: '11:00', minutes: 30 }));

  const data = await body(await board(ctx(db)));
  assert.equal(data.roles.length, 1);
  assert.equal(data.candidates.length, 1);
  assert.equal(data.diary.length, 2);
  assert.equal(data.canManage, true);
  assert.equal(data.canHire, true);
});

test('running the recruitment does not include putting somebody on the books', async () => {
  const { db } = setup();
  const data = await body(await board(ctx(db, null, MANAGER)));
  assert.equal(data.canManage, true);
  assert.equal(data.canHire, false, 'the screen is told, so it can say so');
});

// --------------------------------------------------------------- moving --

test('an ending has to say why, and a move forward does not', async () => {
  const { db } = setup();
  const id = await aCandidate(db, await aRole(db));

  await moveCandidate(ctx(db, { stage: 'shortlisted' }, ADMIN), id);
  await assert.rejects(
    () => moveCandidate(ctx(db, { stage: 'not_taken' }, ADMIN), id),
    /Say why/,
  );
  await moveCandidate(ctx(db, { stage: 'not_taken', outcome: 'No experience' }, ADMIN), id);

  const data = await body(await candidate(ctx(db), id));
  assert.equal(data.candidate.stage, 'not_taken');
  assert.equal(data.candidate.outcome, 'No experience');
  // And the whole history is there, in order.
  const kinds = data.events.map((e) => e.kind);
  assert.deepEqual(kinds, ['stage', 'stage', 'added']);
});

test('nobody can be marked as staff without a record being made', async () => {
  const { db } = setup();
  const id = await aCandidate(db, await aRole(db));
  await assert.rejects(
    () => moveCandidate(ctx(db, { stage: 'hired' }, ADMIN), id),
    /Take them on/,
  );
});

// ----------------------------------------------------------- the diary --

test('publishing the same morning twice does not double the diary', async () => {
  const { db } = setup();
  const roleId = await aRole(db);
  const day = soon();

  const first = await body(await addSlots(ctx(db, { roleId, day, from: '10:00', to: '12:00', minutes: 30 })));
  assert.equal(first.added, 4);

  const again = await body(await addSlots(ctx(db, { roleId, day, from: '10:00', to: '13:00', minutes: 30 })));
  assert.equal(again.added, 2, 'only the two that were missing');
  assert.equal(again.skipped, 4);
});

test('a morning that fits nothing is refused rather than published empty', async () => {
  const { db } = setup();
  await assert.rejects(
    () => addSlots(ctx(db, { day: soon(), from: '10:00', to: '10:20', minutes: 30 })),
    /Nothing fits/,
  );
});

// ------------------------------------------------- the candidate's link --

async function linkFor(db, candidateId, over = {}) {
  const made = await body(await inviteCandidate(ctx(db, {
    wantsSlot: true, wantsDetails: true, ...over,
  }), candidateId));
  return made.url.split('/c/')[1];
}

const publicCtx = (db, body_ = null) => ({
  db,
  env: {},
  url: new URL('https://x/api/c/x'),
  session: null,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body_ ?? {}),
  }),
});

test('a link that offers times is refused when there are none to offer', async () => {
  const { db } = setup();
  const id = await aCandidate(db, await aRole(db));
  await assert.rejects(
    () => inviteCandidate(ctx(db, { wantsSlot: true }), id),
    /no interview times free/,
  );
});

test('the candidate sees the times for their own vacancy and nobody else', async () => {
  const { db } = setup();
  const mine = await aRole(db, { title: 'Room attendant' });
  const theirs = await aRole(db, { title: 'Cook' });
  const id = await aCandidate(db, mine);

  await addSlots(ctx(db, { roleId: mine, day: soon(), from: '10:00', to: '11:00', minutes: 30 }));
  await addSlots(ctx(db, { roleId: theirs, day: soon(2), from: '10:00', to: '11:00', minutes: 30 }));

  const token = await linkFor(db, id);
  const page = await body(await open(publicCtx(db), token));

  assert.equal(page.job, 'Room attendant');
  assert.equal(page.slots.length, 2, 'only the two published for their own vacancy');
  assert.ok(page.slots.every((s) => s.day === soon()));
  // Nothing about the property's own arrangements.
  assert.equal(page.slots[0].interviewer, undefined);
});

test('two candidates cannot take the same half hour', async () => {
  const { db } = setup();
  const roleId = await aRole(db, { headcount: 2 });
  const one = await aCandidate(db, roleId, 'Ama Mensah');
  const two = await aCandidate(db, roleId, 'Kofi Boateng');
  await addSlots(ctx(db, { roleId, day: soon(), from: '10:00', to: '10:30', minutes: 30 }));

  const tokenOne = await linkFor(db, one);
  const tokenTwo = await linkFor(db, two);

  const pageOne = await body(await open(publicCtx(db), tokenOne));
  const pageTwo = await body(await open(publicCtx(db), tokenTwo));
  const slotId = pageOne.slots[0].id;
  assert.equal(pageTwo.slots[0].id, slotId, 'both were offered it');

  await choose(publicCtx(db, { slotId }), tokenOne);
  await assert.rejects(
    () => choose(publicCtx(db, { slotId }), tokenTwo),
    /just been taken/,
  );
});

test('the office booking one and a candidate choosing one cannot collide', async () => {
  const { db } = setup();
  const roleId = await aRole(db, { headcount: 2 });
  const one = await aCandidate(db, roleId, 'Ama Mensah');
  const two = await aCandidate(db, roleId, 'Kofi Boateng');
  await addSlots(ctx(db, { roleId, day: soon(), from: '10:00', to: '10:30', minutes: 30 }));

  const token = await linkFor(db, one);
  const page = await body(await open(publicCtx(db), token));
  const slotId = page.slots[0].id;

  await bookSlot(ctx(db, { candidateId: two }), slotId);
  await assert.rejects(() => choose(publicCtx(db, { slotId }), token), /just been taken/);
});

test('taking a time moves them to interview by itself', async () => {
  const { db } = setup();
  const roleId = await aRole(db);
  const id = await aCandidate(db, roleId);
  await addSlots(ctx(db, { roleId, day: soon(), from: '10:00', to: '10:30', minutes: 30 }));

  const token = await linkFor(db, id);
  const page = await body(await open(publicCtx(db), token));
  await choose(publicCtx(db, { slotId: page.slots[0].id }), token);

  const data = await body(await candidate(ctx(db), id));
  assert.equal(data.candidate.stage, 'interview');
  assert.equal(data.candidate.interview.at, '10:00');
  assert.equal(data.candidate.interview.takenBy, 'them');
});

test('changing their mind frees the first time rather than holding two', async () => {
  const { db } = setup();
  const roleId = await aRole(db);
  const id = await aCandidate(db, roleId);
  await addSlots(ctx(db, { roleId, day: soon(), from: '10:00', to: '11:00', minutes: 30 }));

  const token = await linkFor(db, id);
  const page = await body(await open(publicCtx(db), token));
  await choose(publicCtx(db, { slotId: page.slots[0].id }), token);

  const again = await body(await open(publicCtx(db), token));
  const other = again.slots.find((s) => !s.mine);
  const done = await body(await choose(publicCtx(db, { slotId: other.id }), token));

  assert.equal(done.changed, true);
  const data = await body(await candidate(ctx(db), id));
  assert.equal(data.candidate.interview.at, other.at);

  const held = await db.prepare(
    'SELECT COUNT(*) n FROM rec_slot WHERE candidate_id = ? AND cancelled_at IS NULL',
  ).bind(id).first();
  assert.equal(Number(held.n), 1, 'one time, not two');
});

test('a candidate who cannot make it gives the time back', async () => {
  const { db } = setup();
  const roleId = await aRole(db);
  const id = await aCandidate(db, roleId);
  await addSlots(ctx(db, { roleId, day: soon(), from: '10:00', to: '10:30', minutes: 30 }));

  const token = await linkFor(db, id);
  const page = await body(await open(publicCtx(db), token));
  await choose(publicCtx(db, { slotId: page.slots[0].id }), token);

  const given = await body(await release(publicCtx(db), token));
  assert.equal(given.chosen, null);

  const after = await body(await open(publicCtx(db), token));
  assert.equal(after.chosen, null);
  assert.equal(after.slots.length, 1, 'and it is free again');
});

test('somebody taken out of the pipeline releases their time', async () => {
  const { db } = setup();
  const roleId = await aRole(db);
  const id = await aCandidate(db, roleId);
  await addSlots(ctx(db, { roleId, day: soon(), from: '10:00', to: '10:30', minutes: 30 }));

  const token = await linkFor(db, id);
  const page = await body(await open(publicCtx(db), token));
  await choose(publicCtx(db, { slotId: page.slots[0].id }), token);

  await moveCandidate(ctx(db, { stage: 'not_taken', outcome: 'Did not turn up' }), id);

  const free = await db.prepare(
    'SELECT candidate_id FROM rec_slot WHERE id = ?',
  ).bind(page.slots[0].id).first();
  assert.equal(free.candidate_id, null);
});

// --------------------------------------------------------- taking them on --

test('taking somebody on needs the setup permission, not just recruitment', async () => {
  const { db } = setup();
  const id = await aCandidate(db, await aRole(db));
  await moveCandidate(ctx(db, { stage: 'shortlisted' }), id);

  await assert.rejects(
    () => hire(ctx(db, { employeeNo: 'HSK006' }, MANAGER), id),
    /attendance setup permission/,
  );
});

test('taking somebody on makes the record and carries their things across', async () => {
  const { raw, db } = setup();
  const roleId = await aRole(db);
  const id = await aCandidate(db, roleId, 'Ama Mensah', { email: 'ama@example.com' });

  raw.prepare(
    "INSERT INTO rec_file (candidate_id, kind, title, filename, mime, bytes, content) VALUES (?, 'cv', 'CV', 'ama.pdf', 'application/pdf', 4, X'01020304')",
  ).run(id);

  const done = await body(await hire(ctx(db, {
    employeeNo: 'HSK006', hiredOn: '2026-09-01',
  }), id));

  const staff = raw.prepare('SELECT * FROM att_staff WHERE id = ?').get(done.staffId);
  assert.equal(staff.employee_no, 'HSK006');
  assert.equal(staff.name, 'Ama Mensah');
  assert.equal(staff.department, 'Housekeeping', 'from the vacancy');
  assert.equal(staff.job_title, 'Room attendant');
  assert.equal(staff.hired_on, '2026-09-01');

  const profile = raw.prepare('SELECT * FROM hr_profile WHERE staff_id = ?').get(done.staffId);
  assert.equal(profile.personal_phone, '024 111 2222');
  assert.equal(profile.personal_email, 'ama@example.com');

  const doc = raw.prepare('SELECT * FROM hr_document WHERE staff_id = ?').get(done.staffId);
  assert.equal(doc.filename, 'ama.pdf');
  assert.equal(done.filesMoved, 1);

  const after = raw.prepare('SELECT * FROM rec_candidate WHERE id = ?').get(id);
  assert.equal(after.stage, 'hired');
  assert.equal(after.staff_id, done.staffId);

  // And the vacancy closes itself, because that was the one person wanted.
  assert.equal(raw.prepare('SELECT status FROM rec_role WHERE id = ?').get(roleId).status, 'filled');
});

test('an employee number already in use is refused in the words that help', async () => {
  const { raw, db } = setup();
  raw.prepare(
    "INSERT INTO att_staff (employee_no, name) VALUES ('HSK006', 'Somebody Else')",
  ).run();
  const id = await aCandidate(db, await aRole(db));

  await assert.rejects(
    () => hire(ctx(db, { employeeNo: 'HSK006' }), id),
    /already belongs to somebody else/,
  );
  // And nothing was half-created.
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_staff').get().n, 1);
  assert.equal(raw.prepare('SELECT stage FROM rec_candidate WHERE id = ?').get(id).stage, 'applied');
});

test('somebody already on the books is not taken on twice', async () => {
  const { db } = setup();
  const id = await aCandidate(db, await aRole(db));
  await hire(ctx(db, { employeeNo: 'HSK006' }), id);
  await assert.rejects(() => hire(ctx(db, { employeeNo: 'HSK007' }), id), /already on the books/);
});

test('punches waiting under that number become theirs on the day they start', async () => {
  const { raw, db } = setup();
  raw.prepare(
    `INSERT INTO att_punches (device_serial, employee_no, at_local, at_utc, day, direction, dedupe_key)
     VALUES ('T1', 'HSK006', '2026-08-28T08:00:00', '2026-08-28T08:00:00Z', '2026-08-28', 'in', 'k1')`,
  ).run();

  const id = await aCandidate(db, await aRole(db));
  const done = await body(await hire(ctx(db, { employeeNo: 'HSK006' }), id));

  assert.equal(done.claimedPunches, 1);
  const punch = raw.prepare("SELECT staff_id FROM att_punches WHERE dedupe_key = 'k1'").get();
  assert.equal(punch.staff_id, done.staffId);
});

// -------------------------------------------------------------- the rest --

test('a pasted list is read before anything is written, and flags who is known', async () => {
  const { raw, db } = setup();
  const roleId = await aRole(db);
  await aCandidate(db, roleId, 'Ama Mensah');

  const read = await body(await readCandidates(ctx(db, {
    text: 'Ama Mensah, 024 111 2222\nKofi Boateng, 020 333 4444',
  })));
  assert.equal(read.rows.length, 2);
  assert.ok(read.rows[0].already, 'already in the pipeline');
  assert.equal(read.rows[1].already, null);
  // Nothing written by reading it.
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM rec_candidate').get().n, 1);

  const done = await body(await applyCandidates(ctx(db, {
    roleId, rows: [read.rows[1]],
  })));
  assert.equal(done.added, 1);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM rec_candidate').get().n, 2);
  // And still nobody on the books.
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM att_staff').get().n, 0);
});

test('a score with nothing in it is refused, and one with a mark is kept', async () => {
  const { db } = setup();
  const id = await aCandidate(db, await aRole(db));

  await assert.rejects(() => scoreCandidate(ctx(db, {}), id), /Put something in/);
  await scoreCandidate(ctx(db, { rating: 4, recommend: 'yes', note: 'Confident, good English' }), id);

  const data = await body(await candidate(ctx(db), id));
  assert.equal(data.scores.length, 1);
  assert.equal(data.scores[0].rating, 4);
  assert.equal(data.scores[0].recommend, 'yes');
  assert.equal(data.candidate.bestRating, 4, 'and the summary agrees with the list');
});

test('the link message names the property and carries the address, and nothing is emailed', async () => {
  const { db } = setup();
  const roleId = await aRole(db);
  const id = await aCandidate(db, roleId);
  await addSlots(ctx(db, { roleId, day: soon(), from: '10:00', to: '10:30' }));

  const made = await body(await inviteCandidate(ctx(db, { wantsSlot: true }), id));
  assert.match(made.url, /\/c\/[0-9a-f]{48}$/);
  assert.match(made.message, /choose an interview time/);
  assert.match(made.message, /\/c\//);
  assert.equal(made.expiresInDays, 10);
});

// ----------------------------------------------------- what they sent in --

/** A one-pixel PNG, which is a real file as far as everything here cares. */
const A_FILE = (over = {}) => ({
  filename: 'ama-cv.pdf',
  mime: 'application/pdf',
  content: Buffer.from('a cv').toString('base64'),
  ...over,
});

test('a CV goes on at the moment somebody is added', async () => {
  const { raw, db } = setup();
  const id = await aCandidate(db, await aRole(db));
  await addFile(ctx(db, A_FILE()), id);

  const data = await body(await candidate(ctx(db), id));
  assert.equal(data.files.length, 1);
  assert.equal(data.files[0].filename, 'ama-cv.pdf');
  assert.equal(data.files[0].kind, 'cv');
  assert.equal(data.files[0].kindLabel, 'CV');
  // The board counts it, so the pipeline shows who has paper behind them.
  const seen = (await body(await board(ctx(db)))).candidates.find((c) => c.id === id);
  assert.equal(seen.files, 1);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM rec_file').get().n, 1);
});

test('a kind that is not one of the four is refused', async () => {
  const { db } = setup();
  const id = await aCandidate(db, await aRole(db));
  await assert.rejects(
    () => addFile(ctx(db, A_FILE({ kind: 'passport' })), id),
    /not a kind of document/,
  );
  // Free text would have filed a school certificate where nobody looks.
  await addFile(ctx(db, A_FILE({ kind: 'certificate' })), id);
  const data = await body(await candidate(ctx(db), id));
  assert.equal(data.files[0].kind, 'certificate');
});

test('a file with no title takes its own name rather than being called CV', async () => {
  const { db } = setup();
  const id = await aCandidate(db, await aRole(db));
  await addFile(ctx(db, A_FILE({ filename: 'wassce-results.jpg', mime: 'image/jpeg', kind: 'certificate' })), id);

  const data = await body(await candidate(ctx(db), id));
  assert.equal(data.files[0].title, 'wassce-results.jpg');
});

test('anything but a photograph, a PDF or a Word file is refused', async () => {
  const { db } = setup();
  const id = await aCandidate(db, await aRole(db));
  await assert.rejects(
    () => addFile(ctx(db, A_FILE({ mime: 'application/zip' })), id),
    /photograph, a PDF or a Word document/,
  );
  await assert.rejects(() => addFile(ctx(db, A_FILE({ content: '' })), id), /nothing in that file/);
});

test('what they sent lands under the staff record\'s own name for it', async () => {
  const { raw, db } = setup();
  const id = await aCandidate(db, await aRole(db));
  await addFile(ctx(db, A_FILE({ filename: 'cv.pdf' })), id);
  await addFile(ctx(db, A_FILE({ filename: 'wassce.pdf', kind: 'certificate' })), id);
  await addFile(ctx(db, A_FILE({ filename: 'ref.pdf', kind: 'reference' })), id);

  const done = await body(await hire(ctx(db, { employeeNo: 'HSK006' }), id));
  assert.equal(done.filesMoved, 3);

  const kinds = Object.fromEntries(raw.prepare(
    'SELECT filename, kind FROM hr_document WHERE staff_id = ?',
  ).all(done.staffId).map((r) => [r.filename, r.kind]));

  // A certificate filed as a CV is a certificate nobody finds afterwards.
  assert.deepEqual(kinds, { 'cv.pdf': 'cv', 'wassce.pdf': 'education', 'ref.pdf': 'reference' });
  assert.equal(staffDocumentKind('other'), 'other');
});

test('the screens are told the kinds rather than guessing them', async () => {
  const { db } = setup();
  const id = await aCandidate(db, await aRole(db));
  const kinds = (await body(await board(ctx(db)))).fileKinds.map(([k]) => k);
  assert.deepEqual(kinds, ['cv', 'certificate', 'reference', 'other']);
  assert.deepEqual((await body(await candidate(ctx(db), id))).fileKinds, (await body(await board(ctx(db)))).fileKinds);
});

test('the trail says what was attached, and what kind it was', async () => {
  const { db } = setup();
  const id = await aCandidate(db, await aRole(db));
  await addFile(ctx(db, A_FILE({ filename: 'wassce.pdf', kind: 'certificate' })), id);

  const data = await body(await candidate(ctx(db), id));
  const filed = data.events.find((e) => e.kind === 'file');
  assert.equal(filed.detail, 'Certificate or qualification: wassce.pdf');
});
