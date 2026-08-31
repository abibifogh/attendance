import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  addCandidate, addSlots, board, bookSlot, createRole, importCvs, inviteCandidate,
  moveCandidate, readCvs, removeSlot, updateDay, updateSlot,
} from '../src/routes/recruitment.js';
import { choose, open, release } from '../src/routes/hiring.js';
import {
  findEmail, findPhone, looksLikeName, nameFromFilename, readCv,
} from '../src/lib/cv-read.js';

/**
 * The diary after it is published, and who gets told.
 *
 * A diary is written a week ahead and the week moves: the panel changes, the
 * room changes, an interview slides half an hour. Before this the only answer
 * was to cancel and republish, which loses the time a candidate had taken and
 * tells them nothing.
 *
 * And the reason the interviewer is a person rather than a line of text: a
 * candidate takes a time at eleven at night, nobody here is looking at a
 * screen, and "Kwame" is not somebody the app can tell.
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
            DELETE FROM rec_slot; DELETE FROM rec_event; DELETE FROM rec_file;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");

  /** Somebody on the books, with or without a way of being reached. */
  const staff = (id, name, { login = true } = {}) => {
    raw.prepare(
      "INSERT INTO att_staff (id, employee_no, name, department) VALUES (?, ?, ?, 'Admin')",
    ).run(id, `E${id}`, name);
    if (login) {
      raw.prepare(
        "INSERT INTO users (id, name, role, pin_hash, staff_id, active) VALUES (?, ?, 'manager', ?, ?, 1)",
      ).run(100 + id, name, `pin${id}`, id);
    }
    return id;
  };
  return { raw, db: d1(raw), staff };
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

const publicCtx = (db, payload = null) => ({
  db,
  env: {},
  url: new URL('https://x/api/c/x'),
  session: null,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  }),
});

const body = async (res) => JSON.parse(await res.text());
const soon = (n = 1) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

/** What landed on one person's own bell, and nobody else's. */
const bellOf = (raw, userId) => raw.prepare(
  'SELECT kind, title, body FROM app_notices WHERE user_id = ? ORDER BY id',
).all(userId);

/** Who is on a slot's panel, as ids. */
const panelOf = (raw, slotId) => raw.prepare(
  'SELECT staff_id FROM rec_slot_panel WHERE slot_id = ? ORDER BY rowid',
).all(slotId).map((r) => Number(r.staff_id));

async function aDiary(db, { roleId = null, staffId = null, day = soon() } = {}) {
  await addSlots(ctx(db, {
    roleId, day, from: '10:00', to: '12:00', minutes: 30,
    place: 'The office', interviewerStaffId: staffId,
  }));
  return day;
}

// ------------------------------------------------------- who is on a panel --

test('the interviewer can be a member of staff, and the name is kept beside them', async () => {
  const { raw, db, staff } = setup();
  const yaa = staff(1, 'Yaa Asantewaa');
  await aDiary(db, { staffId: yaa });

  const slot = raw.prepare('SELECT * FROM rec_slot ORDER BY id LIMIT 1').get();
  assert.deepEqual(panelOf(raw, slot.id), [yaa]);
  assert.equal(slot.interviewer, 'Yaa Asantewaa', 'the printed name is stored too');

  const shown = (await body(await board(ctx(db)))).diary[0];
  assert.deepEqual(shown.panel, [yaa]);
  assert.equal(shown.interviewer, 'Yaa Asantewaa');
});

test('a panel is as many people as sit on one, and reads as a sentence', async () => {
  const { raw, db, staff } = setup();
  const yaa = staff(1, 'Yaa Asantewaa');
  const kofi = staff(2, 'Kofi Mensah');
  const ama = staff(3, 'Ama Owusu');

  await addSlots(ctx(db, {
    day: soon(), from: '10:00', to: '10:30',
    interviewerStaffIds: [yaa, kofi, ama],
  }));

  const slot = raw.prepare('SELECT * FROM rec_slot LIMIT 1').get();
  assert.deepEqual(panelOf(raw, slot.id), [yaa, kofi, ama], 'in the order they were picked');
  // The printed name is the list written out the way a person would say it.
  assert.equal(slot.interviewer, 'Yaa Asantewaa, Kofi Mensah and Ama Owusu');
});

test('a panel bigger than a panel is refused, and one that is gone is too', async () => {
  const { db, staff } = setup();
  for (let i = 1; i <= 9; i += 1) staff(i, `Somebody ${i}`);

  await assert.rejects(
    () => addSlots(ctx(db, {
      day: soon(), from: '10:00', to: '10:30',
      interviewerStaffIds: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    })),
    /more people than sit on a panel/,
  );
  await assert.rejects(
    () => addSlots(ctx(db, {
      day: soon(), from: '10:00', to: '10:30', interviewerStaffIds: [1, 999],
    })),
    /no longer on the books/,
  );
});

test('somebody who is not on the books is still a perfectly good interviewer', async () => {
  const { raw, db } = setup();
  await addSlots(ctx(db, {
    day: soon(), from: '10:00', to: '10:30', interviewer: 'The owner',
  }));
  const slot = raw.prepare('SELECT * FROM rec_slot LIMIT 1').get();
  assert.equal(slot.interviewer, 'The owner');
  assert.deepEqual(panelOf(raw, slot.id), [], 'nobody to notify, which is fine');
});

test('the screen is told who can actually be reached', async () => {
  const { db, staff } = setup();
  staff(1, 'Yaa Asantewaa');
  staff(2, 'Nobody Online', { login: false });

  const panel = (await body(await board(ctx(db)))).panel;
  assert.deepEqual(panel.map((p) => [p.name, p.canBeTold]), [
    ['Nobody Online', false],
    ['Yaa Asantewaa', true],
  ]);
});

test('a staff member who has left the books is refused rather than stored as an id', async () => {
  const { db } = setup();
  await assert.rejects(
    () => addSlots(ctx(db, {
      day: soon(), from: '10:00', to: '10:30', interviewerStaffId: 999,
    })),
    /no longer on the books/,
  );
});

// -------------------------------------------------------------- the telling --

test('the panel is told when a candidate takes a time on their own phone', async () => {
  const { raw, db, staff } = setup();
  const yaa = staff(1, 'Yaa Asantewaa');
  const role = (await body(await createRole(ctx(db, { title: 'Room attendant' })))).id;
  await aDiary(db, { roleId: role, staffId: yaa });

  const person = await body(await addCandidate(ctx(db, { name: 'Ama Mensah', roleId: role })));
  const made = await body(await inviteCandidate(ctx(db, { wantsSlot: true }), person.id));
  const token = made.url.split('/c/')[1];

  const page = await body(await open(publicCtx(db), token));
  await choose(publicCtx(db, { slotId: page.slots[0].id }), token);

  const bell = bellOf(raw, 101);
  assert.ok(bell.some((n) => n.kind === 'recruitment.booked'), 'the panel heard');
  const told = bell.find((n) => n.kind === 'recruitment.booked');
  assert.match(told.title, /You are interviewing Ama Mensah/);
  assert.match(told.body, /They chose it themselves/);
});

test('the panel is told when the office books one for somebody', async () => {
  const { raw, db, staff } = setup();
  const yaa = staff(1, 'Yaa Asantewaa');
  await aDiary(db, { staffId: yaa });

  const person = await body(await addCandidate(ctx(db, { name: 'Kofi Boateng' })));
  const slot = raw.prepare('SELECT id FROM rec_slot ORDER BY id LIMIT 1').get();
  const done = await body(await bookSlot(ctx(db, { candidateId: person.id }), slot.id));

  assert.equal(done.interviewerTold, 1, 'the screen can say how many heard');
  assert.ok(bellOf(raw, 101).some((n) => /You are interviewing Kofi Boateng/.test(n.title)));
});

test('every one of them is told, not just the first', async () => {
  const { raw, db, staff } = setup();
  const yaa = staff(1, 'Yaa Asantewaa');
  const kofi = staff(2, 'Kofi Mensah');
  await addSlots(ctx(db, {
    day: soon(), from: '10:00', to: '10:30', interviewerStaffIds: [yaa, kofi],
  }));

  const person = await body(await addCandidate(ctx(db, { name: 'Ama Mensah' })));
  const slot = raw.prepare('SELECT id FROM rec_slot LIMIT 1').get();
  const done = await body(await bookSlot(ctx(db, { candidateId: person.id }), slot.id));

  // Telling one of the two is how the other fails to turn up.
  assert.equal(done.interviewerTold, 2);
  assert.ok(bellOf(raw, 101).some((n) => n.kind === 'recruitment.booked'));
  assert.ok(bellOf(raw, 102).some((n) => n.kind === 'recruitment.booked'));
});

test('the one with a login hears and the one without does not, and the count says so', async () => {
  const { raw, db, staff } = setup();
  const yaa = staff(1, 'Yaa Asantewaa');
  const nobody = staff(2, 'Nobody Online', { login: false });
  await addSlots(ctx(db, {
    day: soon(), from: '10:00', to: '10:30', interviewerStaffIds: [yaa, nobody],
  }));

  const person = await body(await addCandidate(ctx(db, { name: 'Ama Mensah' })));
  const slot = raw.prepare('SELECT id FROM rec_slot LIMIT 1').get();
  const done = await body(await bookSlot(ctx(db, { candidateId: person.id }), slot.id));

  assert.equal(done.interviewerTold, 1, 'so the screen can say to tell the other one');
  assert.equal(bellOf(raw, 101).length, 1);
});

test('an interviewer with no login is simply not told, and the screen is told that', async () => {
  const { raw, db, staff } = setup();
  const nobody = staff(1, 'Nobody Online', { login: false });
  await aDiary(db, { staffId: nobody });

  const person = await body(await addCandidate(ctx(db, { name: 'Kofi Boateng' })));
  const slot = raw.prepare('SELECT id FROM rec_slot ORDER BY id LIMIT 1').get();
  const done = await body(await bookSlot(ctx(db, { candidateId: person.id }), slot.id));

  // Not an error. Plenty of people who sit on a panel have no reason to open
  // this app; what matters is that the screen can say "tell them yourself".
  assert.equal(done.interviewerTold, 0);
});

test('the panel is told when somebody gives their time back', async () => {
  const { raw, db, staff } = setup();
  const yaa = staff(1, 'Yaa Asantewaa');
  const role = (await body(await createRole(ctx(db, { title: 'Room attendant' })))).id;
  await aDiary(db, { roleId: role, staffId: yaa });

  const person = await body(await addCandidate(ctx(db, { name: 'Ama Mensah', roleId: role })));
  const made = await body(await inviteCandidate(ctx(db, { wantsSlot: true }), person.id));
  const token = made.url.split('/c/')[1];
  const page = await body(await open(publicCtx(db), token));
  await choose(publicCtx(db, { slotId: page.slots[0].id }), token);
  await release(publicCtx(db), token);

  assert.ok(bellOf(raw, 101).some((n) => n.kind === 'recruitment.released'),
    'the chair is not left sat waiting');
});

test('the panel is told when the property cancels a booked interview', async () => {
  const { raw, db, staff } = setup();
  const yaa = staff(1, 'Yaa Asantewaa');
  await aDiary(db, { staffId: yaa });
  const person = await body(await addCandidate(ctx(db, { name: 'Ama Mensah' })));
  const slot = raw.prepare('SELECT id FROM rec_slot ORDER BY id LIMIT 1').get();
  await bookSlot(ctx(db, { candidateId: person.id }), slot.id);

  await removeSlot(ctx(db), slot.id);
  const bell = bellOf(raw, 101);
  const off = bell.find((n) => n.kind === 'recruitment.cancelled');
  assert.ok(off, 'they are told it is off');
  assert.match(off.body, /somebody has to ring them/);
});

// --------------------------------------------------------------- editing --

test('an existing time can be moved, and the trail says so', async () => {
  const { raw, db } = setup();
  const day = await aDiary(db);
  const slot = raw.prepare('SELECT * FROM rec_slot ORDER BY id LIMIT 1').get();

  const done = await body(await updateSlot(ctx(db, { at: '14:00' }), slot.id));
  assert.equal(done.moved, true);
  assert.equal(raw.prepare('SELECT starts_at FROM rec_slot WHERE id = ?').get(slot.id).starts_at,
    '14:00');
  assert.equal(raw.prepare('SELECT day FROM rec_slot WHERE id = ?').get(slot.id).day, day);
});

test('a time cannot be moved on top of another one', async () => {
  const { raw, db } = setup();
  await aDiary(db);
  const [first, second] = raw.prepare('SELECT * FROM rec_slot ORDER BY starts_at').all();

  await assert.rejects(
    () => updateSlot(ctx(db, { at: second.starts_at }), first.id),
    /already an interview at/,
  );
  // And the one it clashed with is untouched.
  assert.equal(raw.prepare('SELECT starts_at FROM rec_slot WHERE id = ?').get(first.id).starts_at,
    first.starts_at);
});

test('a booked time can still be moved, and both the panel and the trail hear', async () => {
  const { raw, db, staff } = setup();
  const yaa = staff(1, 'Yaa Asantewaa');
  await aDiary(db, { staffId: yaa });
  const person = await body(await addCandidate(ctx(db, { name: 'Ama Mensah' })));
  const slot = raw.prepare('SELECT * FROM rec_slot ORDER BY id LIMIT 1').get();
  await bookSlot(ctx(db, { candidateId: person.id }), slot.id);

  const done = await body(await updateSlot(ctx(db, { at: '15:30' }), slot.id));
  assert.equal(done.moved, true);
  assert.equal(done.booked, true, 'so the screen can say to ring them');

  assert.ok(bellOf(raw, 101).some((n) => n.kind === 'recruitment.moved'));
  const trail = raw.prepare("SELECT * FROM rec_event WHERE kind = 'slot_moved'").get();
  assert.match(trail.detail, /Moved from .* to .* at 15:30/);
});

test('changing who is on a panel tells the one coming off as well as the one going on', async () => {
  const { raw, db, staff } = setup();
  const yaa = staff(1, 'Yaa Asantewaa');
  const kofi = staff(2, 'Kofi Mensah');
  await aDiary(db, { staffId: yaa });
  const person = await body(await addCandidate(ctx(db, { name: 'Ama Mensah' })));
  const slot = raw.prepare('SELECT * FROM rec_slot ORDER BY id LIMIT 1').get();
  await bookSlot(ctx(db, { candidateId: person.id }), slot.id);

  await updateSlot(ctx(db, { interviewerStaffId: kofi }), slot.id);

  // Being quietly taken off a panel is how somebody fails to turn up to an
  // interview that is theirs.
  assert.ok(bellOf(raw, 101).some((n) => n.kind === 'recruitment.off_panel'));
  assert.ok(bellOf(raw, 102).some((n) => n.kind === 'recruitment.changed'));
});

test('a whole day changes at once, and leaves the booked ones alone by default', async () => {
  const { raw, db, staff } = setup();
  const yaa = staff(1, 'Yaa Asantewaa');
  const kofi = staff(2, 'Kofi Mensah');
  const day = await aDiary(db, { staffId: yaa });

  const person = await body(await addCandidate(ctx(db, { name: 'Ama Mensah' })));
  const first = raw.prepare('SELECT id FROM rec_slot ORDER BY starts_at LIMIT 1').get();
  await bookSlot(ctx(db, { candidateId: person.id }), first.id);

  const done = await body(await updateDay(ctx(db, {
    day, interviewerStaffId: kofi, place: 'The small office',
  })));
  assert.equal(done.changed, 3, 'the three free ones');
  assert.equal(done.left, 1, 'and the booked one is not touched');

  const booked = raw.prepare('SELECT * FROM rec_slot WHERE id = ?').get(first.id);
  assert.deepEqual(panelOf(raw, first.id), [yaa], 'an appointment already given is left alone');
  assert.equal(booked.place, 'The office');

  const free = raw.prepare('SELECT * FROM rec_slot WHERE candidate_id IS NULL LIMIT 1').get();
  assert.deepEqual(panelOf(raw, free.id), [kofi]);
  assert.equal(free.place, 'The small office');
});

test('the booked ones come too when the box is ticked', async () => {
  const { raw, db, staff } = setup();
  const yaa = staff(1, 'Yaa Asantewaa');
  const kofi = staff(2, 'Kofi Mensah');
  const day = await aDiary(db, { staffId: yaa });
  const person = await body(await addCandidate(ctx(db, { name: 'Ama Mensah' })));
  const first = raw.prepare('SELECT id FROM rec_slot ORDER BY starts_at LIMIT 1').get();
  await bookSlot(ctx(db, { candidateId: person.id }), first.id);

  const done = await body(await updateDay(ctx(db, {
    day, interviewerStaffId: kofi, includeBooked: true,
  })));
  assert.equal(done.changed, 4);
  assert.deepEqual(panelOf(raw, first.id), [kofi]);
});

test('a day edit that changes nothing is refused rather than reported as done', async () => {
  const { db } = setup();
  const day = await aDiary(db);
  await assert.rejects(() => updateDay(ctx(db, { day })), /Nothing was changed/);
  await assert.rejects(() => updateDay(ctx(db, { day: soon(9) })), /nothing published on that day/);
});

test('a cancelled time is not something to edit', async () => {
  const { raw, db } = setup();
  await aDiary(db);
  const slot = raw.prepare('SELECT id FROM rec_slot ORDER BY id LIMIT 1').get();
  await removeSlot(ctx(db), slot.id);
  await assert.rejects(() => updateSlot(ctx(db, { at: '14:00' }), slot.id), /taken out of the diary/);
});

// ------------------------------------------------------------ reading a CV --

test('an email and a phone number are read, and a year is not mistaken for one', () => {
  assert.equal(findEmail('Reach me at Ama.Mensah@example.com, thanks.'), 'ama.mensah@example.com');
  assert.equal(findEmail('no address here'), null);

  assert.equal(findPhone('Tel: 024 111 2222'), '024 111 2222');
  assert.equal(findPhone('+233 24 111 2222'), '+233 24 111 2222');
  // The two that do real damage on a CV.
  assert.equal(findPhone('Worked there 2019 to 2024'), null);
  assert.equal(findPhone('Ghana Card GHA-123456789-0123456789'), null);
});

test('a name is only a name where it looks like one', () => {
  assert.equal(looksLikeName('AMA MENSAH'), 'Ama Mensah');
  assert.equal(looksLikeName('Kofi Boateng Jnr'), 'Kofi Boateng Jnr');
  assert.equal(looksLikeName('CURRICULUM VITAE'), null);
  assert.equal(looksLikeName('Personal Details'), null);
  assert.equal(looksLikeName('Ama'), null, 'one word is not a name');
  assert.equal(looksLikeName('ama@example.com'), null);
});

test('a file name is worth reading, and "cv final 2" is not', () => {
  assert.equal(nameFromFilename('ama-mensah-cv.pdf'), 'Ama Mensah');
  assert.equal(nameFromFilename('Kofi_Boateng_Resume_2026.pdf'), 'Kofi Boateng');
  assert.equal(nameFromFilename('cv final 2.pdf'), null);
  assert.equal(nameFromFilename('scan0001.jpg'), null);
});

test('the heading wins over the first line, and says where it came from', () => {
  const cv = readCv({
    filename: 'application.pdf',
    pages: [{
      items: [
        { text: 'AMA MENSAH', x: 50, y: 40, size: 22 },
        { text: 'Housekeeping supervisor', x: 50, y: 70, size: 11 },
        { text: 'Tel: 024 111 2222', x: 50, y: 90, size: 11 },
        { text: 'ama@example.com', x: 50, y: 105, size: 11 },
      ],
    }],
  });
  assert.equal(cv.name, 'Ama Mensah');
  assert.equal(cv.nameFrom, 'the heading');
  assert.equal(cv.phone, '024 111 2222');
  assert.equal(cv.email, 'ama@example.com');
  assert.equal(cv.readable, true);
});

test('a photograph has nothing to read, and falls back to the file name', () => {
  const cv = readCv({ filename: 'yaa-owusu-cv.jpg', pages: null });
  assert.equal(cv.readable, false);
  assert.equal(cv.name, 'Yaa Owusu');
  assert.equal(cv.nameFrom, 'the file name');
  assert.equal(cv.phone, null);
});

// ------------------------------------------------------- the stack of CVs --

/** A PDF with one line of text in it, which is enough for the reader. */
const A_CV_PDF = () => {
  const content = 'BT /F1 20 Tf 50 700 Td (AMA MENSAH) Tj ET\n'
    + 'BT /F1 10 Tf 50 680 Td (Tel: 024 111 2222) Tj ET\n'
    + 'BT /F1 10 Tf 50 665 Td (ama@example.com) Tj ET';
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
      + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj',
    `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
  ];
  const pdf = `%PDF-1.4\n${objects.join('\n')}\ntrailer << /Root 1 0 R >>\n%%EOF`;
  return Buffer.from(pdf, 'latin1').toString('base64');
};

test('a stack of CVs is read and shown, and nothing is written by reading it', async () => {
  const { raw, db } = setup();
  const read = await body(await readCvs(ctx(db, {
    files: [
      { filename: 'ama-mensah-cv.pdf', mime: 'application/pdf', content: A_CV_PDF() },
      { filename: 'yaa-owusu-cv.jpg', mime: 'image/jpeg', content: Buffer.from('a photo').toString('base64') },
    ],
  })));

  assert.equal(read.rows.length, 2);
  assert.equal(read.rows[0].name, 'Ama Mensah');
  assert.equal(read.rows[0].phone, '024 111 2222');
  assert.equal(read.rows[0].email, 'ama@example.com');

  // A photograph says so rather than being reported as an empty CV.
  assert.equal(read.rows[1].name, 'Yaa Owusu', 'from the file name');
  assert.match(read.rows[1].note, /photograph/);

  assert.equal(raw.prepare('SELECT COUNT(*) n FROM rec_candidate').get().n, 0);
});

test('a file that is not a CV at all is refused by name rather than silently dropped', async () => {
  const { db } = setup();
  const read = await body(await readCvs(ctx(db, {
    files: [{ filename: 'accounts.zip', mime: 'application/zip', content: Buffer.from('x').toString('base64') }],
  })));
  assert.equal(read.rows.length, 1);
  assert.match(read.rows[0].problem, /photograph, a PDF or a Word document/);
});

test('somebody already in the pipeline is flagged rather than added twice', async () => {
  const { db } = setup();
  await addCandidate(ctx(db, { name: 'Ama Mensah' }));

  const read = await body(await readCvs(ctx(db, {
    files: [{ filename: 'ama-mensah-cv.pdf', mime: 'application/pdf', content: A_CV_PDF() }],
  })));
  assert.ok(read.rows[0].already, 'the screen unticks them');
  assert.equal(read.rows[0].already.label, 'Applied');
});

test('the second press adds the people and puts each CV on the right one', async () => {
  const { raw, db } = setup();
  const role = (await body(await createRole(ctx(db, { title: 'Room attendant' })))).id;

  const done = await body(await importCvs(ctx(db, {
    roleId: role,
    source: 'walk_in',
    rows: [
      {
        name: 'Ama Mensah', phone: '024 111 2222', email: 'ama@example.com',
        filename: 'ama-mensah-cv.pdf', mime: 'application/pdf', content: A_CV_PDF(),
      },
      { name: 'Yaa Owusu', filename: 'yaa.jpg', mime: 'image/jpeg', content: Buffer.from('a photo').toString('base64') },
    ],
  })));

  assert.equal(done.added, 2);
  const people = raw.prepare('SELECT * FROM rec_candidate ORDER BY id').all();
  assert.deepEqual(people.map((p) => p.name), ['Ama Mensah', 'Yaa Owusu']);
  assert.equal(people[0].role_id, role);
  assert.equal(people[0].source, 'walk_in');
  assert.equal(people[0].phone, '024 111 2222');

  // Each CV on the person it came from, not in a pile.
  const files = raw.prepare('SELECT candidate_id, filename FROM rec_file ORDER BY id').all()
    .map((f) => ({ candidate_id: f.candidate_id, filename: f.filename }));
  assert.deepEqual(files, [
    { candidate_id: people[0].id, filename: 'ama-mensah-cv.pdf' },
    { candidate_id: people[1].id, filename: 'yaa.jpg' },
  ]);

  // And the trail says where each of them came from.
  const trail = raw.prepare("SELECT detail FROM rec_event WHERE kind = 'added' ORDER BY id").all();
  assert.match(trail[0].detail, /From ama-mensah-cv\.pdf/);
});

test('a row with no name is skipped rather than creating somebody called nothing', async () => {
  const { raw, db } = setup();
  const done = await body(await importCvs(ctx(db, {
    rows: [{ name: '   ', filename: 'scan0001.jpg' }],
  })));
  assert.equal(done.added, 0);
  assert.equal(done.refused.length, 1);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM rec_candidate').get().n, 0);
});

test('taking somebody out of the pipeline still frees their time and tells the panel', async () => {
  const { raw, db, staff } = setup();
  const yaa = staff(1, 'Yaa Asantewaa');
  await aDiary(db, { staffId: yaa });
  const person = await body(await addCandidate(ctx(db, { name: 'Ama Mensah' })));
  const slot = raw.prepare('SELECT id FROM rec_slot ORDER BY id LIMIT 1').get();
  await bookSlot(ctx(db, { candidateId: person.id }), slot.id);

  await moveCandidate(ctx(db, { stage: 'not_taken', outcome: 'Did not turn up' }), person.id);
  assert.equal(raw.prepare('SELECT candidate_id FROM rec_slot WHERE id = ?').get(slot.id)
    .candidate_id, null);
});

test('a candidate choosing a time on their own phone tells the whole panel', async () => {
  const { raw, db, staff } = setup();
  const yaa = staff(1, 'Yaa Asantewaa');
  const kofi = staff(2, 'Kofi Mensah');
  const role = (await body(await createRole(ctx(db, { title: 'Room attendant' })))).id;
  await addSlots(ctx(db, {
    roleId: role, day: soon(), from: '10:00', to: '10:30',
    place: 'The office', interviewerStaffIds: [yaa, kofi],
  }));

  const person = await body(await addCandidate(ctx(db, { name: 'Ama Mensah', roleId: role })));
  const made = await body(await inviteCandidate(ctx(db, { wantsSlot: true }), person.id));
  const token = made.url.split('/c/')[1];
  const page = await body(await open(publicCtx(db), token));
  await choose(publicCtx(db, { slotId: page.slots[0].id }), token);

  // The one thing in this pipeline that happens with nobody here doing it, so
  // everybody who has to be in the room hears about it.
  for (const userId of [101, 102]) {
    const told = bellOf(raw, userId).find((n) => n.kind === 'recruitment.booked');
    assert.ok(told, `user ${userId} heard`);
    assert.match(told.title, /You are interviewing Ama Mensah/);
    assert.match(told.body, /They chose it themselves/);
  }
});

test('changing a panel tells everybody joining and everybody leaving', async () => {
  const { raw, db, staff } = setup();
  const yaa = staff(1, 'Yaa Asantewaa');
  const kofi = staff(2, 'Kofi Mensah');
  const ama = staff(3, 'Ama Owusu');
  await addSlots(ctx(db, {
    day: soon(), from: '10:00', to: '10:30', interviewerStaffIds: [yaa, kofi],
  }));
  const person = await body(await addCandidate(ctx(db, { name: 'Somebody Else' })));
  const slot = raw.prepare('SELECT id FROM rec_slot LIMIT 1').get();
  await bookSlot(ctx(db, { candidateId: person.id }), slot.id);

  // Yaa stays, Kofi comes off, Ama goes on.
  await updateSlot(ctx(db, { interviewerStaffIds: [yaa, ama] }), slot.id);
  assert.deepEqual(panelOf(raw, slot.id), [yaa, ama]);

  assert.ok(bellOf(raw, 102).some((n) => n.kind === 'recruitment.off_panel'),
    'the one taken off is told, or they fail to turn up to nothing');
  assert.ok(bellOf(raw, 103).some((n) => n.kind === 'recruitment.changed'),
    'and the one put on is told');
  // Whoever stayed is told it changed too, and not told they are off it.
  assert.ok(bellOf(raw, 101).some((n) => n.kind === 'recruitment.changed'));
  assert.ok(!bellOf(raw, 101).some((n) => n.kind === 'recruitment.off_panel'));
});

test('moving a time leaves the panel alone, and tells all of them it moved', async () => {
  const { raw, db, staff } = setup();
  const yaa = staff(1, 'Yaa Asantewaa');
  const kofi = staff(2, 'Kofi Mensah');
  await addSlots(ctx(db, {
    day: soon(), from: '10:00', to: '10:30', interviewerStaffIds: [yaa, kofi],
  }));
  const person = await body(await addCandidate(ctx(db, { name: 'Ama Mensah' })));
  const slot = raw.prepare('SELECT id FROM rec_slot LIMIT 1').get();
  await bookSlot(ctx(db, { candidateId: person.id }), slot.id);

  await updateSlot(ctx(db, { at: '15:30' }), slot.id);

  // The bug this had once: an edit that says nothing about the panel used to
  // clear it, and nothing looked wrong until nobody turned up.
  assert.deepEqual(panelOf(raw, slot.id), [yaa, kofi]);
  assert.ok(bellOf(raw, 101).some((n) => n.kind === 'recruitment.moved'));
  assert.ok(bellOf(raw, 102).some((n) => n.kind === 'recruitment.moved'));
});

test('a diary published before panels existed keeps its interviewer', () => {
  // The migration carries the single interviewer across, so a diary published
  // last week keeps getting told. Checked by running the migrations against a
  // slot that predates the change.
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const files = readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort();
  const before = files.filter((f) => f < '0088');

  for (const f of before) raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  // The migrations seed a few staff of their own, so let the database pick the
  // id rather than choosing one that turns out to be taken.
  const her = Number(raw.prepare("INSERT INTO att_staff (employee_no, name) VALUES ('E7', 'Yaa Asantewaa')")
    .run().lastInsertRowid);
  raw.prepare(`INSERT INTO rec_slot (id, day, starts_at, interviewer, interviewer_staff_id)
               VALUES (1, '2026-09-01', '10:00', 'Yaa Asantewaa', ?)`).run(her);

  for (const f of files.filter((x) => x >= '0088')) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }

  assert.deepEqual(
    raw.prepare('SELECT staff_id FROM rec_slot_panel WHERE slot_id = 1').all()
      .map((r) => Number(r.staff_id)),
    [her],
  );
  // And the column is gone, so there is no second place for the two to
  // disagree.
  assert.ok(!raw.prepare('PRAGMA table_info(rec_slot)').all()
    .some((c) => c.name === 'interviewer_staff_id'));
});
