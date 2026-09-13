import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  ASK_MAP, hasDone, isFor, liveAsksOf, needsDoing, outstandingFor, whoFor, whoIsOutstanding,
  wouldBeANewVersion,
} from '../src/lib/handbook.js';
import { CHAPTER_CODES, DEFAULT_CHAPTERS } from '../src/lib/handbook-content.js';
import {
  acknowledge, installStandard, publishChapter, readHandbook, retireChapter, saveChapter,
  whoHasNot,
} from '../src/routes/handbook.js';
import { STANDARD_TEMPLATES } from '../src/lib/ghana-templates.js';
import { readAsBlocks } from '../public/js/views/handbook.js';

/**
 * The staff handbook.
 *
 * A hotel's rules live in a Word file on somebody's laptop, a printout in the
 * office that is two versions old, and whatever the supervisor on duty
 * remembers. When something goes wrong the question is always the same and
 * never answerable: was this person told, and told what exactly.
 *
 * TWO THINGS MAKE IT ANSWERABLE, and both are what this file is about.
 *
 * The draft and the published copy are separate. What an administrator is
 * writing is not what the property is reading, and Publish is the one moment
 * they meet.
 *
 * An acknowledgement is against a version and a hash of the exact words. A
 * chapter rewritten since somebody ticked it has not been ticked.
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
  raw.exec('DELETE FROM att_staff; DELETE FROM users; DELETE FROM hb_chapter; DELETE FROM hb_ack;');
  raw.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?2',
  ).run('handbook_on', on ? '1' : '0');

  for (const p of TEAM) {
    raw.prepare(
      `INSERT INTO att_staff (id, employee_no, name, department, tags, hired_on, active)
       VALUES (?, ?, ?, ?, ?, '2020-01-01', 1)`,
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
  url: new URL('https://x/api/handbook'),
  session,
  executionContext: null,
  request: new Request('https://x/', body
    ? { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
    : {}),
});

const read = async (db, session) => (await readHandbook(ctx(db, session))).json();
const save = async (db, body) => (await saveChapter(ctx(db, asOffice(), body))).json();
const publish = async (db, id, body = {}) => (
  await publishChapter(ctx(db, asOffice(), body), id)
).json();
const ack = async (db, id, staffId, body = {}) => (
  await acknowledge(ctx(db, asStaff(staffId), body), id)
).json();
const who = async (db, id) => (await whoHasNot(ctx(db, asOffice()), id)).json();

/** A chapter, straight into the table, as a draft. */
const draft = (raw, { code = 'test', title = 'A chapter', body = 'Some words.', asks = 'ack',
  departments = null, tags = null } = {}) => Number(raw.prepare(
  `INSERT INTO hb_chapter (code, title, body, asks, departments, tags, sort_order)
   VALUES (?, ?, ?, ?, ?, ?, 10) RETURNING id`,
).get(code, title, body, asks, departments && JSON.stringify(departments),
  tags && JSON.stringify(tags)).id);

// ---------------------------------------------------------------------------
// Who a chapter is for
// ---------------------------------------------------------------------------

test('a chapter with nothing named is for everybody', () => {
  const chapter = { departments: null, tags: null };
  for (const person of TEAM) assert.equal(isFor(chapter, person), true);
  assert.equal(whoFor(chapter), 'Everybody');
});

test('a department chapter is for that department', () => {
  const chapter = { departments: JSON.stringify(['Kitchen']), tags: null };
  assert.equal(isFor(chapter, TEAM[0]), false);
  assert.equal(isFor(chapter, TEAM[1]), true);
  assert.equal(whoFor(chapter), 'Kitchen');
});

test('and a tag chapter is for whoever carries the tag', () => {
  // The charter for team leads is not a department: a supervisor in reception
  // and a supervisor in the kitchen are held to the same one.
  const chapter = { departments: null, tags: JSON.stringify(['Team lead']) };
  assert.equal(isFor(chapter, TEAM[0]), false);
  assert.equal(isFor(chapter, TEAM[2]), true);
});

// ---------------------------------------------------------------------------
// Draft and published are two different things
// ---------------------------------------------------------------------------

test('writing a chapter puts nothing in front of anybody', async () => {
  const { db, raw } = setup();
  await save(db, { title: 'Code of conduct', body: 'Be honest.', asks: 'ack' });

  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM hb_chapter').get().n, 1);
  assert.deepEqual((await read(db, asStaff(1))).chapters, [], 'nothing published');

  // And the office can see it, or there would be no way to get it ready.
  const office = await read(db, asOffice());
  assert.equal(office.manage.chapters.length, 1);
  assert.equal(office.manage.chapters[0].status, 'draft');
});

test('publishing is the moment it reaches people', async () => {
  const { db, raw } = setup();
  const id = draft(raw, { title: 'Code of conduct', body: 'Be honest.' });
  await publish(db, id);

  const seen = await read(db, asStaff(1));
  assert.equal(seen.chapters.length, 1);
  assert.equal(seen.chapters[0].title, 'Code of conduct');
  assert.equal(seen.chapters[0].body, 'Be honest.');
  assert.equal(seen.chapters[0].version, 1);
});

test('editing a published chapter does not change what people are reading', async () => {
  const { db, raw } = setup();
  const id = draft(raw, { body: 'The old words.' });
  await publish(db, id);
  await save(db, { id, title: 'A chapter', body: 'The new words.', asks: 'ack' });

  const seen = await read(db, asStaff(1));
  assert.equal(seen.chapters[0].body, 'The old words.', 'until somebody publishes it');

  const office = await read(db, asOffice());
  assert.equal(office.manage.chapters[0].changed, true, 'and the office is told it has drifted');
});

test('a chapter can be taken down without losing what people signed', async () => {
  const { db, raw } = setup();
  const id = draft(raw);
  await publish(db, id);
  await ack(db, id, 1);
  await retireChapter(ctx(db, asOffice()), id);

  assert.deepEqual((await read(db, asStaff(1))).chapters, []);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM hb_ack').get().n, 1);
});

// ---------------------------------------------------------------------------
// A tick is against a version
// ---------------------------------------------------------------------------

test('a tick is recorded against the words that were on the screen', async () => {
  const { db, raw } = setup();
  const id = draft(raw, { body: 'Version one.' });
  await publish(db, id);
  await ack(db, id, 1);

  const row = raw.prepare('SELECT * FROM hb_ack').get();
  assert.equal(row.version, 1);
  assert.equal(row.asked, 'ack');
  assert.ok(row.hash, 'a fingerprint of the exact words');
  assert.equal(row.hash, raw.prepare('SELECT live_hash FROM hb_chapter WHERE id = ?').get(id).live_hash);
});

test('ticking twice is the same tick', async () => {
  const { db, raw } = setup();
  const id = draft(raw);
  await publish(db, id);
  await ack(db, id, 1);
  await ack(db, id, 1);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM hb_ack').get().n, 1);
});

test('rewriting it asks everybody again', async () => {
  const { db, raw } = setup();
  const id = draft(raw, { body: 'Version one.' });
  await publish(db, id);
  await ack(db, id, 1);
  assert.equal((await read(db, asStaff(1))).outstanding.length, 0);

  await save(db, { id, title: 'A chapter', body: 'Version two, which says something else.', asks: 'ack' });
  const out = await publish(db, id);
  assert.equal(out.version, 2);
  assert.equal(out.asked, true);

  const seen = await read(db, asStaff(1));
  assert.equal(seen.outstanding.length, 1, 'her tick was against words that have gone');
  assert.equal(seen.chapters[0].done, false);
});

test('republishing the same words asks nobody again', async () => {
  const { db, raw } = setup();
  const id = draft(raw);
  await publish(db, id);
  await ack(db, id, 1);

  const out = await publish(db, id);
  assert.equal(out.version, 1);
  assert.equal(out.asked, false);
  assert.equal((await read(db, asStaff(1))).outstanding.length, 0);
});

test('unless the property asks for it deliberately', async () => {
  const { db, raw } = setup();
  const id = draft(raw);
  await publish(db, id);
  await ack(db, id, 1);

  const out = await publish(db, id, { again: true });
  assert.equal(out.version, 2);
  assert.equal((await read(db, asStaff(1))).outstanding.length, 1);
});

test('a chapter that changed under somebody’s open page is refused', async () => {
  const { db, raw } = setup();
  const id = draft(raw);
  await publish(db, id);

  await save(db, { id, title: 'A chapter', body: 'Different words entirely.', asks: 'ack' });
  await publish(db, id);

  // Her browser still has version 1 on it.
  await assert.rejects(() => ack(db, id, 1, { version: 1 }), /changed since you opened it/);
});

// ---------------------------------------------------------------------------
// Signing one
// ---------------------------------------------------------------------------

test('a chapter that asks for a signature wants a name', async () => {
  const { db, raw } = setup();
  const id = draft(raw, { asks: 'sign' });
  await publish(db, id);

  await assert.rejects(() => ack(db, id, 1, {}), /name/i);
  await ack(db, id, 1, { name: 'Ama Mensah' });

  const row = raw.prepare('SELECT * FROM hb_ack').get();
  assert.equal(row.asked, 'sign');
  assert.equal(row.signer_name, 'Ama Mensah');
  assert.ok(row.signer_ip, 'and the circumstances, the same as a contract');
});

test('a reference page asks for nothing and cannot be signed', async () => {
  const { db, raw } = setup();
  const id = draft(raw, { asks: 'read' });
  await publish(db, id);

  assert.equal((await read(db, asStaff(1))).chapters[0].needs, false);
  await assert.rejects(() => ack(db, id, 1), /does not ask for anything/);
});

test('somebody it is not for cannot sign it', async () => {
  const { db, raw } = setup();
  const id = draft(raw, { departments: ['Kitchen'] });
  await publish(db, id);

  await assert.rejects(() => ack(db, id, 1), /not one of yours/);
  await ack(db, id, 2);
});

// ---------------------------------------------------------------------------
// What is waiting on whom
// ---------------------------------------------------------------------------

test('the reader is told what is still waiting on them, in reading order', () => {
  const chapters = [
    { id: 1, sort_order: 20, title: 'Second', status: 'published', asks: 'ack', live_asks: 'ack', version: 1 },
    { id: 2, sort_order: 10, title: 'First', status: 'published', asks: 'sign', live_asks: 'sign', version: 1 },
    { id: 3, sort_order: 5, title: 'Just to read', status: 'published', asks: 'read', live_asks: 'read', version: 1 },
    { id: 4, sort_order: 1, title: 'A draft', status: 'draft', asks: 'ack', live_asks: 'ack', version: 0 },
  ];
  const out = outstandingFor(chapters, TEAM[0], []);
  assert.deepEqual(out.map((c) => c.title), ['First', 'Second']);
});

test('and the office is told how many of the people it applies to have done it', async () => {
  const { db, raw } = setup();
  const id = draft(raw, { departments: ['Reception'] });
  await publish(db, id);
  await ack(db, id, 1);

  const out = await who(db, id);
  assert.equal(out.of, 2, 'the two in reception, not all three');
  assert.equal(out.done, 1);
  assert.deepEqual(out.waiting.map((p) => p.name), ['Yaa Dede']);
  assert.deepEqual(out.signed.map((p) => p.name), ['Ama Mensah']);
});

test('the numbers behind it are worked out from who it is for', () => {
  const chapter = { id: 7, version: 2, departments: JSON.stringify(['Reception']), tags: null };
  const acks = [
    { chapter_id: 7, staff_id: 1, version: 2 },
    { chapter_id: 7, staff_id: 3, version: 1 },   // an older version, so not done
    { chapter_id: 9, staff_id: 3, version: 2 },   // another chapter
  ];
  const out = whoIsOutstanding(chapter, TEAM.map((p) => ({ ...p, active: 1 })), acks);
  assert.equal(out.of, 2);
  assert.equal(out.done, 1);
  assert.deepEqual(out.waiting.map((p) => p.name), ['Yaa Dede']);
});

// ---------------------------------------------------------------------------
// The switch, and the standard chapters
// ---------------------------------------------------------------------------

test('staff see nothing at all until the property turns it on', async () => {
  const { db, raw } = setup({ on: false });
  const id = draft(raw);
  await publish(db, id);

  const seen = await read(db, asStaff(1));
  assert.equal(seen.on, false);
  assert.deepEqual(seen.chapters, []);
  await assert.rejects(() => ack(db, id, 1), /not published yet/);

  // And the office carries on writing it.
  assert.equal((await read(db, asOffice())).manage.chapters.length, 1);
});

test('the standard chapters arrive as drafts, never published', async () => {
  const { db, raw } = setup();
  const out = (await installStandard(ctx(db, asOffice()))).json
    ? await (await installStandard(ctx(db, asOffice()))).json()
    : null;
  void out;

  const rows = raw.prepare('SELECT code, status FROM hb_chapter').all();
  assert.equal(rows.length, DEFAULT_CHAPTERS.length);
  assert.ok(rows.every((r) => r.status === 'draft'), 'nothing goes out on its own');
  assert.deepEqual((await read(db, asStaff(1))).chapters, []);
});

test('installing twice does not tread on an edited chapter', async () => {
  const { db, raw } = setup();
  await installStandard(ctx(db, asOffice()));
  const id = raw.prepare("SELECT id FROM hb_chapter WHERE code = 'conduct'").get().id;
  await save(db, { id, title: 'Our own code', body: 'Our own words.', asks: 'sign' });

  await installStandard(ctx(db, asOffice()));
  const row = raw.prepare("SELECT title, body FROM hb_chapter WHERE code = 'conduct'").get();
  assert.equal(row.title, 'Our own code');
  assert.equal(row.body, 'Our own words.');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM hb_chapter').get().n, DEFAULT_CHAPTERS.length);
});

// ---------------------------------------------------------------------------
// What is actually in it
// ---------------------------------------------------------------------------

test('the handbook covers what a hotel has to have written down', () => {
  for (const code of ['conduct', 'equal', 'dignity', 'grievance', 'discipline', 'it', 'leave',
    'privacy', 'service', 'safety', 'food', 'security', 'social', 'hours', 'pay', 'leaving',
    'leads', 'welcome']) {
    assert.ok(CHAPTER_CODES.includes(code), `nothing covers ${code}`);
  }
});

test('the ones that carry a legal obligation ask for a signature', () => {
  const signs = new Set(DEFAULT_CHAPTERS.filter((c) => c.asks === 'sign').map((c) => c.code));
  for (const code of ['conduct', 'dignity', 'privacy', 'it', 'leads']) {
    assert.ok(signs.has(code), `${code} should be signed, not merely ticked`);
  }
});

test('every chapter is aimed, ordered and answerable', () => {
  const codes = new Set();
  for (const chapter of DEFAULT_CHAPTERS) {
    assert.ok(chapter.code && !codes.has(chapter.code), `duplicate code ${chapter.code}`);
    codes.add(chapter.code);
    assert.ok(chapter.title && chapter.summary, `${chapter.code} has no title or summary`);
    assert.ok(ASK_MAP.has(chapter.asks), `${chapter.code} asks something unknown`);
    assert.ok(Number.isInteger(chapter.sort_order), `${chapter.code} has no place`);
    assert.ok(chapter.body.length > 400, `${chapter.code} is too thin to be worth publishing`);
  }
});

test('the kitchen chapter is the kitchen’s, and the charter is the team leads’', () => {
  const food = DEFAULT_CHAPTERS.find((c) => c.code === 'food');
  assert.ok(food.departments?.length, 'food safety is a department matter');
  const leads = DEFAULT_CHAPTERS.find((c) => c.code === 'leads');
  assert.deepEqual(leads.tags, ['Team lead', 'Supervisor']);
});

test('it says what it is and is not, so nobody reads it as their contract', () => {
  const welcome = DEFAULT_CHAPTERS.find((c) => c.code === 'welcome');
  assert.match(welcome.body, /contract of employment is a separate document/i);
});

// ---------------------------------------------------------------------------
// And the contract that goes with it
// ---------------------------------------------------------------------------

test('there is a contract written for a hotel, with the handbook in it', () => {
  const contract = STANDARD_TEMPLATES.find((t) => t.code === 'contract_hotel');
  assert.ok(contract, 'no hotel contract');
  assert.equal(contract.kind, 'contract');
  assert.equal(contract.satisfies, 'contract');

  // The things a hotel contract has to settle and an office one does not.
  // Line breaks are where they fall in a document meant to be read on paper,
  // so the whitespace in these is deliberately loose.
  for (const phrase of [/weekends and public\s+holidays/i, /day off in lieu/i,
    /twelve hours between/i, /probation/i, /staff handbook/i]) {
    assert.match(contract.body, phrase);
  }
  // And it is filled in from the record rather than typed each time.
  for (const key of ['{{name}}', '{{job_title}}', '{{start_date}}', '{{salary}}',
    '{{notice}}', '{{probation}}', '{{leave_days}}']) {
    assert.ok(contract.body.includes(key), `${key} is not filled in`);
  }
});

// ---------------------------------------------------------------------------
// Where it sits
// ---------------------------------------------------------------------------

test('everybody signed in may read it, and only personnel may write it', () => {
  const index = readFileSync('src/index.js', 'utf8');
  assert.match(index, /\['GET', '\/api\/handbook', null, handbook\.readHandbook\]/);
  assert.match(index, /\['POST', '\/api\/handbook\/:id\/ack', null, handbook\.acknowledge\]/);
  assert.match(index, /\['POST', '\/api\/handbook', 'hr_manage', handbook\.saveChapter\]/);
  assert.match(index, /\['POST', '\/api\/handbook\/:id\/publish', 'hr_manage'/);
});

test('the screen never draws the draft', () => {
  const view = readFileSync('public/js/views/handbook.js', 'utf8');
  // What a reader is handed is the published copy; the route decides that and
  // the screen simply draws what it is given.
  const route = readFileSync('src/routes/handbook.js', 'utf8');
  assert.match(route, /body: chapter\.live_body \?\? ''/);
  assert.equal(/data\.chapters\[\d+\]\.draft/.test(view), false);
});

test('the switch is under Setup, and off to begin with', () => {
  const setup2 = readFileSync('src/routes/attendance-setup.js', 'utf8');
  assert.match(setup2, /\['handbook_on', \(v\) => \(v === '1'/);
  const sql = readFileSync('migrations/0109_the_handbook.sql', 'utf8');
  assert.match(sql, /'handbook_on', '0'/);
});

test('a published chapter that asks for nothing is not counted as waiting', () => {
  const chapter = { status: 'published', asks: 'read', live_asks: 'read', version: 1, id: 1 };
  assert.equal(needsDoing(chapter), false);
  assert.equal(hasDone(chapter, []), true);
  assert.equal(liveAsksOf(chapter), 'read');
  assert.equal(wouldBeANewVersion({ ...chapter, body: 'a', live_body: 'a', title: 't', live_title: 't' }), false);
});

// ---------------------------------------------------------------------------
// Setting it like a book
// ---------------------------------------------------------------------------

test('a chapter reads as headings, paragraphs and lists', () => {
  const shape = readAsBlocks([
    'A short opening.',
    '',
    'TURN UP',
    'Be at your post, in uniform, ready to work at the start of your shift, which',
    'is a line the typist wrapped and not a new paragraph.',
    '',
    '- Clock in yourself',
    '- Clock out yourself',
    '',
    '1. First',
    '2. Second',
  ].join('\n'));

  assert.deepEqual(shape.map((b) => b.kind), ['text', 'heading', 'text', 'bullets', 'numbers']);
  assert.equal(shape[1].text, 'TURN UP');
  // The typist's wrap is joined back up, so it reads as one sentence.
  assert.match(shape[2].text, /your shift, which is a line/);
  assert.deepEqual(shape[3].items, ['Clock in yourself', 'Clock out yourself']);
  assert.deepEqual(shape[4].items, ['First', 'Second']);
});

test('a heading is a line in capitals on its own, and nothing else is', () => {
  const shape = readAsBlocks('IT AND ACCEPTABLE USE\nNot a heading, because it has lower case.');
  assert.equal(shape[0].kind, 'heading');
  assert.equal(shape[1].kind, 'text');

  // A single shouted word inside a sentence does not make a heading of it.
  assert.equal(readAsBlocks('Tell your manager. ALWAYS.')[0].kind, 'text');
});

test('a chapter with nothing in it draws nothing', () => {
  assert.deepEqual(readAsBlocks(''), []);
  assert.deepEqual(readAsBlocks(null), []);
  assert.deepEqual(readAsBlocks('\n\n\n'), []);
});

test('the screen reads one chapter at a time, from the published words', () => {
  const view = readFileSync('public/js/views/handbook.js', 'utf8');
  // A contents page and a chapter page, not an accordion of everything at once.
  assert.match(view, /hb-contents/);
  assert.match(view, /hb-page-head/);
  assert.match(view, /All chapters/);
  // And the office is told when publishing reaches nobody.
  assert.match(view, /Staff cannot see any of this yet/);
  assert.match(view, /handbook_on: '1'/);
});

test('who a chapter is for is ticked from what the property has', async () => {
  const { db } = setup();
  const view = readFileSync('public/js/views/handbook.js', 'utf8');
  // Nothing typed: a typed department name is a chapter that reaches nobody.
  assert.match(view, /audiencePicker/);
  assert.equal(/placeholder: 'Kitchen, Housekeeping'/.test(view), false);

  const out = await readHandbook(ctx(db, asOffice())).then((r) => r.json());
  const names = out.manage.audience.departments.map((d) => d.name);
  assert.ok(names.includes('Kitchen'));
  assert.ok(names.includes('Housekeeping'));
  assert.equal(out.manage.audience.everybody, TEAM.length);

  const leads = out.manage.audience.tags.find((t) => t.name === 'Team lead');
  assert.ok(leads, 'a tag somebody actually carries is offered');
  assert.ok(leads.people >= 1);
});
