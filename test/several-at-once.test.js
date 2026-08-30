import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  addCandidate, addSlots, board, createRole, hire, inviteCandidates, moveCandidates,
} from '../src/routes/recruitment.js';
import { open } from '../src/routes/hiring.js';

/**
 * Doing several at once.
 *
 * Shortlisting is the one step genuinely done in a batch: somebody reads twenty
 * CVs in an evening and six of them are worth seeing. And the point of
 * shortlisting six in one press is inviting six in one press.
 *
 * Two rules run through both. A batch can do nothing a single press could not
 * — nobody reaches the books this way, an ending still needs a reason, and
 * every move lands on its own trail. And one refusal does not sink the rest:
 * somebody taken on since the screen was drawn is skipped with a reason and
 * everybody else goes through.
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
  raw.exec(`DELETE FROM att_staff; DELETE FROM users; DELETE FROM app_notices;
            DELETE FROM audit_log; DELETE FROM rec_role; DELETE FROM rec_candidate;
            DELETE FROM rec_slot; DELETE FROM rec_event; DELETE FROM rec_invite;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  return { raw, db: d1(raw) };
}

const ctx = (db, body = null) => ({
  db,
  env: {},
  url: new URL('https://x/api/rec'),
  session: { user: { id: 1, name: 'Kwame', role: 'admin' }, permissions: ['rec_view', 'rec_manage', 'att_setup'] },
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const publicCtx = (db) => ({
  db,
  env: {},
  url: new URL('https://x/api/c/x'),
  session: null,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }),
});

const body = async (res) => JSON.parse(await res.text());
const soon = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);

async function several(db, names, roleId = null) {
  const ids = [];
  for (const name of names) {
    ids.push((await body(await addCandidate(ctx(db, { name, roleId, phone: '024 000 0000' })))).id);
  }
  return ids;
}

// ---------------------------------------------------------------- moving --

test('several are shortlisted in one press, and each lands on its own trail', async () => {
  const { raw, db } = setup();
  const ids = await several(db, ['Ama Mensah', 'Kofi Boateng', 'Yaa Owusu']);

  const done = await body(await moveCandidates(ctx(db, { ids, stage: 'shortlisted' })));
  assert.equal(done.moved.length, 3);
  assert.equal(done.skipped.length, 0);

  const stages = raw.prepare('SELECT stage FROM rec_candidate').all().map((r) => r.stage);
  assert.deepEqual(stages, ['shortlisted', 'shortlisted', 'shortlisted']);

  // Three moves, not one. The trail is per person, because the question a year
  // later is about a person.
  const moves = raw.prepare(
    "SELECT candidate_id, from_stage, to_stage FROM rec_event WHERE kind = 'stage' ORDER BY candidate_id",
  ).all();
  assert.equal(moves.length, 3);
  assert.deepEqual(moves.map((m) => m.from_stage), ['applied', 'applied', 'applied']);
  assert.deepEqual(moves.map((m) => m.to_stage), ['shortlisted', 'shortlisted', 'shortlisted']);
});

test('one that cannot move does not stop the others', async () => {
  const { raw, db } = setup();
  const ids = await several(db, ['Ama Mensah', 'Kofi Boateng']);
  // Taken on since the screen was drawn.
  await hire(ctx(db, { employeeNo: 'HSK006' }), ids[0]);

  const done = await body(await moveCandidates(ctx(db, { ids, stage: 'shortlisted' })));
  assert.equal(done.moved.length, 1);
  assert.equal(done.skipped.length, 1);
  assert.equal(done.skipped[0].name, 'Ama Mensah');
  assert.match(done.skipped[0].why, /on the books now/);

  // And the one who could move, did.
  assert.equal(raw.prepare('SELECT stage FROM rec_candidate WHERE id = ?').get(ids[1]).stage,
    'shortlisted');
});

test('a batch cannot put anybody on the books', async () => {
  const { db } = setup();
  const ids = await several(db, ['Ama Mensah']);
  const done = await body(await moveCandidates(ctx(db, { ids, stage: 'hired' })));
  assert.equal(done.moved.length, 0);
  assert.match(done.skipped[0].why, /Take them on/);
});

test('an ending still insists on a reason, asked once and written on each', async () => {
  const { raw, db } = setup();
  const ids = await several(db, ['Ama Mensah', 'Kofi Boateng']);

  await assert.rejects(
    () => moveCandidates(ctx(db, { ids, stage: 'not_taken' })),
    /goes on every one of their records/,
  );

  await moveCandidates(ctx(db, { ids, stage: 'not_taken', outcome: 'No rooms experience' }));
  const outcomes = raw.prepare('SELECT outcome FROM rec_candidate').all().map((r) => r.outcome);
  assert.deepEqual(outcomes, ['No rooms experience', 'No rooms experience']);
});

test('anybody taken out of the pipeline in a batch gives their time back', async () => {
  const { raw, db } = setup();
  const role = (await body(await createRole(ctx(db, { title: 'Room attendant' })))).id;
  const ids = await several(db, ['Ama Mensah'], role);
  await addSlots(ctx(db, { roleId: role, day: soon(), from: '10:00', to: '10:30' }));
  const slot = raw.prepare('SELECT id FROM rec_slot LIMIT 1').get();
  raw.prepare("UPDATE rec_slot SET candidate_id = ?, taken_at = datetime('now') WHERE id = ?")
    .run(ids[0], slot.id);

  await moveCandidates(ctx(db, { ids, stage: 'not_taken', outcome: 'Did not turn up' }));
  assert.equal(raw.prepare('SELECT candidate_id FROM rec_slot WHERE id = ?').get(slot.id)
    .candidate_id, null);
});

test('an empty tick list and a stage that is not one are both refused', async () => {
  const { db } = setup();
  await assert.rejects(() => moveCandidates(ctx(db, { ids: [], stage: 'shortlisted' })), /Nobody was ticked/);
  await assert.rejects(() => moveCandidates(ctx(db, { ids: [1], stage: 'nonsense' })), /not a stage/);
});

// -------------------------------------------------------------- inviting --

test('a link each, all at once, and every one of them works', async () => {
  const { raw, db } = setup();
  const role = (await body(await createRole(ctx(db, { title: 'Room attendant' })))).id;
  const ids = await several(db, ['Ama Mensah', 'Kofi Boateng'], role);
  await addSlots(ctx(db, { roleId: role, day: soon(), from: '10:00', to: '11:00', minutes: 30 }));

  const made = await body(await inviteCandidates(ctx(db, {
    ids, wantsSlot: true, message: 'Please pick a time.',
  })));

  assert.equal(made.links.length, 2);
  assert.equal(made.skipped.length, 0);
  assert.equal(made.expiresInDays, 10);

  // Each one carries what the office needs to send it on: who it is for, how
  // to reach them, the link, and the words.
  for (const link of made.links) {
    assert.match(link.url, /\/c\/[0-9a-f]{48}$/);
    assert.equal(link.phone, '024 000 0000');
    assert.match(link.message, /Please open this link/);
  }
  // And two different links, not the same one twice.
  assert.notEqual(made.links[0].url, made.links[1].url);

  // Each actually opens, on the right person.
  for (const link of made.links) {
    const page = await body(await open(publicCtx(db), link.url.split('/c/')[1]));
    assert.equal(page.name, link.name);
    assert.equal(page.slots.length, 2);
  }
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM rec_invite').get().n, 2);
});

test('somebody with no times free for their vacancy is skipped, and the rest are not', async () => {
  const { db } = setup();
  const mine = (await body(await createRole(ctx(db, { title: 'Room attendant' })))).id;
  const theirs = (await body(await createRole(ctx(db, { title: 'Cook' })))).id;
  const [a] = await several(db, ['Ama Mensah'], mine);
  const [b] = await several(db, ['Kofi Boateng'], theirs);
  await addSlots(ctx(db, { roleId: mine, day: soon(), from: '10:00', to: '10:30' }));

  const made = await body(await inviteCandidates(ctx(db, { ids: [a, b], wantsSlot: true })));
  assert.equal(made.links.length, 1);
  assert.equal(made.links[0].name, 'Ama Mensah');
  assert.equal(made.skipped[0].name, 'Kofi Boateng');
  assert.match(made.skipped[0].why, /No interview times are free for their vacancy/);
});

test('somebody already out of the pipeline is not invited to anything', async () => {
  const { db } = setup();
  const ids = await several(db, ['Ama Mensah', 'Kofi Boateng']);
  await moveCandidates(ctx(db, { ids: [ids[0]], stage: 'not_taken', outcome: 'No experience' }));

  const made = await body(await inviteCandidates(ctx(db, {
    ids, wantsSlot: false, wantsDetails: true,
  })));
  assert.equal(made.links.length, 1);
  assert.equal(made.links[0].name, 'Kofi Boateng');
  assert.match(made.skipped[0].why, /Not this time/i);
});

test('a batch link never carries a code, whatever is asked for', async () => {
  const { raw, db } = setup();
  const ids = await several(db, ['Ama Mensah']);
  const made = await body(await inviteCandidates(ctx(db, {
    ids, wantsSlot: false, wantsDetails: true, pin: '1234',
  })));

  assert.equal(made.links[0].pin, null);
  assert.equal(raw.prepare('SELECT pin_hash FROM rec_invite LIMIT 1').get().pin_hash, null);
});

test('a link that asks for nothing is refused before anything is written', async () => {
  const { raw, db } = setup();
  const ids = await several(db, ['Ama Mensah']);
  await assert.rejects(
    () => inviteCandidates(ctx(db, {
      ids, wantsSlot: false, wantsDetails: false, wantsCv: false,
    })),
    /has to ask for something/,
  );
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM rec_invite').get().n, 0);
});

test('every link made is on its own trail, so the record shows what went out', async () => {
  const { raw, db } = setup();
  const ids = await several(db, ['Ama Mensah', 'Kofi Boateng']);
  await inviteCandidates(ctx(db, { ids, wantsSlot: false, wantsDetails: true }));

  const trail = raw.prepare(
    "SELECT candidate_id, detail FROM rec_event WHERE kind = 'link_created' ORDER BY candidate_id",
  ).all();
  assert.equal(trail.length, 2);
  assert.deepEqual(trail.map((t) => t.detail), ['their details', 'their details']);
});
