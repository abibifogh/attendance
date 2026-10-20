import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  addCandidate, addSlots, bookSlot, createRole, inviteCandidate, removeSlot, tellAbout, updateSlot,
} from '../src/routes/recruitment.js';
import { calendar, choose, open, release } from '../src/routes/hiring.js';
import { calendarFor, watchInterviews } from '../src/lib/interview-mail.js';
import { seal, unseal } from '../src/lib/seal.js';

/**
 * The person being interviewed is told: when they book, the day before, and
 * when the time moves or is cancelled, by them or by the office. By email
 * where they gave an address, by text where they gave only a phone number.
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

const ENV = { RESEND_API_KEY: 'k', SESSION_SECRET: 'test-secret', SMS_API_KEY: 's' };

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_staff; DELETE FROM users; DELETE FROM app_notices;
            DELETE FROM rec_role; DELETE FROM rec_candidate; DELETE FROM rec_slot; DELETE FROM rec_event;`);
  const set = (k, v) => raw.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(k, v);
  set('timezone', 'UTC');
  set('email_from', 'hive@example.com');
  set('property_name', 'Somewhere Nice');
  set('property_address', '1 Example Road, Accra');
  set('sms_enabled', '1');
  set('sms_sender', 'SomewhrNice');
  const mails = [];
  const texts = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body);
    if (String(url).includes('resend')) mails.push(payload);
    else texts.push({ url: String(url), payload });
    return new Response('{"id":"x","status":"success","code":"ok","data":[{"recipient":"233240004417","id":"m"}]}', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  return { raw, db: d1(raw), mails, texts, restore: () => { globalThis.fetch = real; } };
}

const ctx = (db, body = null) => ({
  db,
  env: ENV,
  url: new URL('https://staff.example.com/api/rec'),
  session: { user: { id: 1, name: 'Kwame', role: 'admin' }, permissions: ['rec_view', 'rec_manage'] },
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  }),
});
const publicCtx = (db, payload = null) => ({ ...ctx(db, payload), session: null, url: new URL('https://staff.example.com/api/c/x') });
const body = async (res) => JSON.parse(await res.text());
const soon = (n = 2) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const icsOf = (mail) => Buffer.from(mail.attachments?.[0]?.content ?? '', 'base64').toString('utf8');

async function aCandidate(db, { email = 'ama@example.com', phone = null } = {}) {
  const role = (await body(await createRole(ctx(db, { title: 'Front desk agent', bring: 'Your Ghana Card' })))).id;
  await addSlots(ctx(db, { roleId: role, day: soon(), from: '10:00', to: '11:00', minutes: 30, place: 'Main building, ask at reception' }));
  const person = await body(await addCandidate(ctx(db, { name: 'Ama Owusu', roleId: role, email, phone })));
  const made = await body(await inviteCandidate(ctx(db, { wantsSlot: true }), person.id));
  return { role, person, token: made.url.split('/c/')[1] };
}

test('a sealed value opens with the same secret and purpose only', async () => {
  const box = await seal('abc', 'one', 'p');
  assert.equal(await unseal(box, 'one', 'p'), 'abc');
  assert.equal(await unseal(box, 'two', 'p'), null);
  assert.equal(await unseal(box, 'one', 'q'), null);
  assert.equal(await seal('abc', '', 'p'), null, 'nothing is sealed without a secret');
});

test('choosing a time emails them the details, the way there, a calendar entry and their link', async () => {
  const { raw, db, mails, restore } = setup();
  try {
    const { person, token } = await aCandidate(db);
    const page = await body(await open(publicCtx(db), token));
    const out = await body(await choose(publicCtx(db, { slotId: page.slots[0].id }), token));
    assert.equal(out.told, 'email');

    const mail = mails.find((m) => m.to?.[0] === 'ama@example.com');
    assert.ok(mail, 'the candidate was emailed');
    assert.match(mail.subject, /^Your interview is booked: /);
    assert.match(mail.html, /Your interview is booked, Ama/);
    assert.match(mail.html, /Thank you for choosing a time/);
    assert.match(mail.html, /Main building, ask at reception/);
    assert.match(mail.html, /1 Example Road, Accra/);
    assert.match(mail.html, /Get directions/);
    assert.match(mail.html, /google\.com\/maps/);
    assert.match(mail.html, /Please bring/);
    assert.match(mail.html, /Your Ghana Card/);
    assert.ok(mail.html.includes(`/c/${token}`), 'their own link, to change or cancel');
    assert.ok(mail.html.includes(`/api/c/${token}/interview.ics`), 'and to add it to a calendar');
    const ics = icsOf(mail);
    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.match(ics, new RegExp(`UID:interview-${person.id}@[\\w.-]+\\r`));
    assert.match(ics, /SUMMARY:Interview: Front desk agent at Somewhere Nice/);
    assert.match(ics, /METHOD:PUBLISH/);

    const trail = raw.prepare("SELECT detail FROM rec_event WHERE kind = 'told_booked'").get();
    assert.equal(trail.detail, 'by email to ama@example.com');
  } finally { restore(); }
});

test('changing their own time, and giving it back, are each confirmed', async () => {
  const { db, mails, restore } = setup();
  try {
    const { token } = await aCandidate(db);
    const page = await body(await open(publicCtx(db), token));
    await choose(publicCtx(db, { slotId: page.slots[0].id }), token);
    await choose(publicCtx(db, { slotId: page.slots[1].id }), token);
    const changed = mails.filter((m) => m.to?.[0] === 'ama@example.com').at(-1);
    assert.match(changed.subject, /^New time for your interview/);
    assert.match(changed.html, /You changed your interview from your link/);
    assert.match(changed.html, /Was/);

    await release(publicCtx(db), token);
    const gone = mails.filter((m) => m.to?.[0] === 'ama@example.com').at(-1);
    assert.equal(gone.subject, 'Your interview time is cancelled');
    assert.match(gone.html, /You told us you cannot make/);
    assert.match(gone.html, /Choose another time/);
    assert.match(icsOf(gone), /METHOD:CANCEL/);
    assert.match(icsOf(gone), /STATUS:CANCELLED/);
  } finally { restore(); }
});

test('the office booking, moving or cancelling their time tells them, with the link they already have', async () => {
  const { raw, db, mails, restore } = setup();
  try {
    const { person, token } = await aCandidate(db);
    const slots = raw.prepare('SELECT id FROM rec_slot ORDER BY id').all();
    const booked = await body(await bookSlot(ctx(db, { candidateId: person.id }), slots[0].id));
    assert.equal(booked.candidateTold.sent, true);
    let last = mails.at(-1);
    assert.match(last.html, /Somewhere Nice has booked your interview/);
    assert.ok(last.html.includes(`/c/${token}`), 'the link was read back from its seal');

    const moved = await body(await updateSlot(ctx(db, { at: '15:00' }), slots[0].id));
    assert.equal(moved.candidateTold.sent, true);
    last = mails.at(-1);
    assert.match(last.html, /Somewhere Nice has moved your interview/);
    assert.match(last.html, /15:00/);

    const removed = await body(await removeSlot(ctx(db), slots[0].id));
    assert.equal(removed.candidateTold.sent, true);
    last = mails.at(-1);
    assert.match(last.html, /Somewhere Nice has had to cancel your interview/);
    const panelNote = raw.prepare("SELECT body FROM app_notices WHERE kind = 'recruitment.cancelled'").get();
    assert.ok(!panelNote || /told by email/.test(panelNote.body), 'the panel is not told to ring them');
  } finally { restore(); }
});

test('somebody with only a phone number is texted instead', async () => {
  const { db, mails, texts, restore } = setup();
  try {
    const { token } = await aCandidate(db, { email: null, phone: '024 000 4417' });
    const page = await body(await open(publicCtx(db), token));
    const out = await body(await choose(publicCtx(db, { slotId: page.slots[0].id }), token));
    assert.equal(out.told, 'text');
    assert.equal(mails.filter((m) => /interview/i.test(m.subject ?? '')).length, 0);
    const sms = JSON.stringify(texts.at(-1)?.payload ?? {});
    assert.match(sms, /Somewhere Nice: your interview for Front desk agent is booked for/);
    assert.match(sms, /Main building/);
  } finally { restore(); }
});

test('the afternoon before, each booked person is reminded once; a late booking is not', async (t) => {
  const { raw, db, mails, restore } = setup();
  try {
    const { person } = await aCandidate(db);
    const day = soon(1);
    raw.prepare(`UPDATE rec_slot SET day = ? WHERE id = (SELECT MIN(id) FROM rec_slot)`).run(day);
    const slot = raw.prepare('SELECT id FROM rec_slot ORDER BY id LIMIT 1').get();
    raw.prepare("UPDATE rec_slot SET candidate_id = ?, taken_at = datetime('now', '-3 days') WHERE id = ?").run(person.id, slot.id);

    const today = new Date().toISOString().slice(0, 10);
    t.mock.timers.enable({ apis: ['Date'], now: new Date(`${today}T09:00:00Z`) });
    assert.equal((await watchInterviews(db, { timezone: 'UTC', ctx: { env: ENV } })).reminded, 0, 'not in the morning');
    t.mock.timers.setTime(new Date(`${today}T16:00:00Z`).getTime());
    assert.equal((await watchInterviews(db, { timezone: 'UTC', ctx: { env: ENV } })).reminded, 1);
    assert.equal((await watchInterviews(db, { timezone: 'UTC', ctx: { env: ENV } })).reminded, 0, 'once');
    const mail = mails.at(-1);
    assert.match(mail.subject, /^Tomorrow at 10:00: your interview at Somewhere Nice/);
    assert.match(mail.html, /See you tomorrow, Ama/);
  } finally { restore(); }
});

test('the office can send the details or a reminder by hand, and is told when it cannot', async () => {
  const { raw, db, mails, restore } = setup();
  try {
    const { person } = await aCandidate(db);
    const slot = raw.prepare('SELECT id FROM rec_slot ORDER BY id LIMIT 1').get();
    await bookSlot(ctx(db, { candidateId: person.id, tell: false }), slot.id);
    const before = mails.length;
    const sent = await body(await tellAbout(ctx(db, { kind: 'reminder' }), person.id));
    assert.equal(sent.how, 'email');
    assert.equal(mails.length, before + 1);
    assert.ok(raw.prepare('SELECT reminded_at FROM rec_slot WHERE id = ?').get(slot.id).reminded_at, 'the afternoon one will not go too');

    raw.prepare('UPDATE rec_candidate SET email = NULL, phone = NULL WHERE id = ?').run(person.id);
    await assert.rejects(tellAbout(ctx(db, { kind: 'booked' }), person.id), /no email address or mobile number/);
  } finally { restore(); }
});

test('the calendar entry opens from their link while the time is live', async () => {
  const { db, restore } = setup();
  try {
    const { token } = await aCandidate(db);
    const page = await body(await open(publicCtx(db), token));
    await choose(publicCtx(db, { slotId: page.slots[0].id }), token);
    const res = await calendar(publicCtx(db), token);
    assert.match(res.headers.get('Content-Type'), /text\/calendar/);
    const text = await res.text();
    assert.match(text, /DTSTART;TZID=UTC:\d{8}T100000/);
    assert.match(text, /DTEND;TZID=UTC:\d{8}T103000/);
    assert.match(text, /LOCATION:Main building\\, ask at reception\\, 1 Example Road\\, Accra/);
  } finally { restore(); }
});

test('a calendar entry escapes what it must', () => {
  const ics = calendarFor({
    slot: { day: '2026-10-23', starts_at: '10:00', minutes: 45 },
    candidateId: 7, title: 'A; b, c', place: 'Line\nTwo', timezone: 'Africa/Accra', host: 'h',
  });
  assert.match(ics, /SUMMARY:A\\; b\\, c/);
  assert.match(ics, /LOCATION:Line\\nTwo/);
  assert.match(ics, /DTEND;TZID=Africa\/Accra:20261023T104500/);
});
