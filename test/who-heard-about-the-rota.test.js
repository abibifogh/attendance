import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  publishAgain, publishHistory, publishRoster, publishTold, saveRoster,
} from '../src/routes/attendance.js';

/**
 * Who heard that the rota went out, and sending it again to whoever did not.
 *
 * Publishing told everybody at once and then forgot what it had done. What
 * came back was three numbers, and the question that arrives a day later is
 * not a number: it is "Doreen says she never got hers". Answering that meant
 * publishing the whole fortnight again and buzzing twenty-one people who had
 * already read it.
 *
 * What is pinned down here is that each person's outcome is written down, that
 * the reason nothing landed is said plainly enough to act on, and that Send
 * again goes to the named few and to nobody else.
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

async function setup() {
  KEYS = KEYS ?? await realKeys();
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_roster; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  for (const [key, value] of Object.entries({
    sms_enabled: '1', sms_provider: 'arkesel', sms_sender: 'HIVE',
    site_url: 'https://staff.niceoperation.com',
  })) {
    raw.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes)
     VALUES (1, 'Morning', '06:00', '14:00', 0, 5)`,
  ).run();
  return { raw, db: d1(raw) };
}

/**
 * A subscription a browser would really have handed over.
 *
 * The keys have to be a genuine P-256 point and a real sixteen-byte secret, or
 * the encryption refuses them and every push in the file reads as failed for
 * the wrong reason.
 */
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
async function realKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  return { p256dh: b64(new Uint8Array(raw)), auth: b64(crypto.getRandomValues(new Uint8Array(16))) };
}
let KEYS = null;

function person(raw, { id, name, login = null, phone = null, subscribed = false }) {
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (?, ?, ?, 'Kitchen', '2020-01-01')`,
  ).run(id, String(id), name);
  if (phone) {
    raw.prepare('INSERT INTO hr_profile (staff_id, personal_phone) VALUES (?, ?)').run(id, phone);
  }
  if (login) {
    raw.prepare(
      "INSERT INTO users (id, name, role, active, staff_id) VALUES (?, ?, 'staff', 1, ?)",
    ).run(login, name, id);
  }
  if (subscribed) {
    raw.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES (?, ?, ?, ?)`,
    ).run(login, `https://push.example/${login}`, KEYS.p256dh, KEYS.auth);
  }
}

const PLANNER = { user: { id: 99, name: 'Yaa', role: 'planner' }, permissions: ['att_rota'] };
const ctx = (db, body = null, env = {}) => ({
  db,
  env,
  url: new URL('https://x/api/att/x'),
  session: PLANNER,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const KEYED = { SMS_API_KEY: 'test-key' };
const WEEK = { from: '2026-06-01', to: '2026-06-07' };
const read = async (r) => r.json();

/** Every outbound call, and what it was told to say. */
function pretend({ textsFail = false } = {}) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options) => {
    // A push body is encrypted bytes rather than JSON, and a fake that tries
    // to read it as JSON throws inside the send and looks exactly like the
    // push failing.
    const body = typeof options?.body === 'string' ? JSON.parse(options.body) : null;
    seen.push({ url: String(url), body });
    return textsFail && String(url).includes('arkesel')
      ? new Response('no credit', { status: 402 })
      : new Response('{}', { status: 200 });
  };
  return { seen, stop() { globalThis.fetch = real; } };
}

const publish = async (db, body = WEEK) => {
  const spy = pretend();
  try { return await read(await publishRoster(ctx(db, body, KEYED))); } finally { spy.stop(); }
};

const rosterFor = (db, entries) => saveRoster(ctx(db, { entries }));

const byName = (people, name) => people.find((p) => p.name === name);

// ---------------------------------------------------------------------------
// What gets written down
// ---------------------------------------------------------------------------

test('each person gets a line saying what became of theirs', async () => {
  const { raw, db } = await setup();
  person(raw, { id: 1, name: 'Kofi', login: 11, subscribed: true });
  person(raw, { id: 2, name: 'Ama', login: 12, phone: '0551234567' });
  person(raw, { id: 3, name: 'Esi' });

  await rosterFor(db, [
    { staffId: 1, day: '2026-06-02', shiftId: 1 },
    { staffId: 2, day: '2026-06-03', shiftId: 1 },
    { staffId: 3, day: '2026-06-04', shiftId: 1 },
  ]);

  const done = await publish(db);
  assert.ok(done.publishId, 'the publish says which one it was');

  const out = await read(await publishTold(ctx(db), done.publishId));
  assert.equal(out.people.length, 3);

  assert.equal(byName(out.people, 'Kofi').buzzed, 1, 'a device that took the alert');
  assert.equal(byName(out.people, 'Ama').texted, 1, 'no device, so a text went');
  assert.equal(byName(out.people, 'Esi').reached, false, 'no login and no number');
  assert.equal(out.reached, 2);
  assert.equal(out.missed, 1);
});

test('the reason nothing landed is said plainly enough to act on', async () => {
  const { raw, db } = await setup();
  person(raw, { id: 1, name: 'Esi' });
  person(raw, { id: 2, name: 'Yaw', login: 12 });

  await rosterFor(db, [
    { staffId: 1, day: '2026-06-02', shiftId: 1 },
    { staffId: 2, day: '2026-06-02', shiftId: 1 },
  ]);
  const done = await publish(db);
  const out = await read(await publishTold(ctx(db), done.publishId));

  assert.match(byName(out.people, 'Esi').why, /No login and no mobile number/);
  assert.match(byName(out.people, 'Yaw').why, /no alerts turned on/);
  // And the two are not the same sentence, because the fix is not the same.
  assert.notEqual(byName(out.people, 'Esi').why, byName(out.people, 'Yaw').why);
});

test('a day off is a line too, said as days rather than shifts', async () => {
  const { raw, db } = await setup();
  person(raw, { id: 1, name: 'Kofi', login: 11, subscribed: true });

  await rosterFor(db, [{ staffId: 1, day: '2026-06-02', shiftId: null }]);
  const done = await publish(db);
  const out = await read(await publishTold(ctx(db), done.publishId));

  assert.equal(out.people[0].shifts, 0);
  assert.equal(out.people[0].offDays, 1);
});

test('a quiet publish tells nobody and records nobody', async () => {
  const { raw, db } = await setup();
  person(raw, { id: 1, name: 'Kofi', login: 11, subscribed: true });
  await rosterFor(db, [{ staffId: 1, day: '2026-06-02', shiftId: 1 }]);

  const done = await publish(db, { ...WEEK, notify: 'none' });
  const out = await read(await publishTold(ctx(db), done.publishId));
  assert.deepEqual(out.people, []);
  assert.equal(out.publish.notify, 'none');
});

test('a text the gateway refuses is recorded as refused, not as sent', async () => {
  const { raw, db } = await setup();
  person(raw, { id: 1, name: 'Ama', login: 12, phone: '0551234567' });
  await rosterFor(db, [{ staffId: 1, day: '2026-06-02', shiftId: 1 }]);

  const spy = pretend({ textsFail: true });
  let done;
  try { done = await read(await publishRoster(ctx(db, WEEK, KEYED))); } finally { spy.stop(); }

  const out = await read(await publishTold(ctx(db), done.publishId));
  assert.equal(out.people[0].texted, -1);
  assert.equal(out.people[0].reached, false);
});

// ---------------------------------------------------------------------------
// The list of publishes
// ---------------------------------------------------------------------------

test('the history counts who was reached and who was not', async () => {
  const { raw, db } = await setup();
  person(raw, { id: 1, name: 'Kofi', login: 11, subscribed: true });
  person(raw, { id: 2, name: 'Esi' });
  await rosterFor(db, [
    { staffId: 1, day: '2026-06-02', shiftId: 1 },
    { staffId: 2, day: '2026-06-02', shiftId: 1 },
  ]);
  await publish(db);

  const out = await read(await publishHistory(ctx(db)));
  assert.equal(out.publishes.length, 1);
  assert.equal(out.publishes[0].people, 2);
  assert.equal(out.publishes[0].reached, 1);
  assert.equal(out.publishes[0].missed, 1);
});

// ---------------------------------------------------------------------------
// Sending it again
// ---------------------------------------------------------------------------

test('it goes to the named few and to nobody else', async () => {
  const { raw, db } = await setup();
  person(raw, { id: 1, name: 'Kofi', login: 11, subscribed: true });
  person(raw, { id: 2, name: 'Ama', login: 12, phone: '0551234567' });
  await rosterFor(db, [
    { staffId: 1, day: '2026-06-02', shiftId: 1 },
    { staffId: 2, day: '2026-06-03', shiftId: 1 },
  ]);
  const done = await publish(db);

  const spy = pretend();
  let again;
  try {
    again = await read(await publishAgain(ctx(db, { staffIds: [2] }, KEYED), done.publishId));
  } finally {
    spy.stop();
  }

  assert.equal(again.asked, 1);
  // One text, to Ama, and Kofi's phone was left alone.
  const texts = spy.seen.filter((call) => call.url.includes('arkesel'));
  assert.equal(texts.length, 1);
  assert.deepEqual(texts[0].body.recipients, ['+233551234567']);
});

test('sending again adds to the line rather than making a second one', async () => {
  const { raw, db } = await setup();
  person(raw, { id: 1, name: 'Ama', login: 12, phone: '0551234567' });
  await rosterFor(db, [{ staffId: 1, day: '2026-06-02', shiftId: 1 }]);
  const done = await publish(db);

  const spy = pretend();
  try {
    await publishAgain(ctx(db, { staffIds: [1] }, KEYED), done.publishId);
  } finally {
    spy.stop();
  }

  const out = await read(await publishTold(ctx(db), done.publishId));
  assert.equal(out.people.length, 1, 'one person, one line');
  assert.equal(out.people[0].sends, 2);
});

test('the second message reads off the rota as it stands now', async () => {
  const { raw, db } = await setup();
  person(raw, { id: 1, name: 'Ama', login: 12, phone: '0551234567' });
  await rosterFor(db, [{ staffId: 1, day: '2026-06-02', shiftId: 1 }]);
  await publish(db);

  // Her week grows, and the new day is published in its own right.
  await rosterFor(db, [{ staffId: 1, day: '2026-06-04', shiftId: 1 }]);
  const second = await publish(db);

  const spy = pretend();
  try {
    await publishAgain(ctx(db, { staffIds: [1] }, KEYED), second.publishId);
  } finally {
    spy.stop();
  }

  const texts = spy.seen.filter((call) => call.url.includes('arkesel'));
  assert.match(texts[0].body.message, /2 shifts/,
    'both of her days, not the one that went the first time');
});

test('nobody named is refused, and so is somebody who was never on it', async () => {
  const { raw, db } = await setup();
  person(raw, { id: 1, name: 'Ama', login: 12, phone: '0551234567' });
  person(raw, { id: 2, name: 'Nobody', login: 13 });
  await rosterFor(db, [{ staffId: 1, day: '2026-06-02', shiftId: 1 }]);
  const done = await publish(db);

  await assert.rejects(
    () => publishAgain(ctx(db, { staffIds: [] }, KEYED), done.publishId),
    /Say who to send it to again/,
  );
  await assert.rejects(
    () => publishAgain(ctx(db, { staffIds: [2] }, KEYED), done.publishId),
    /None of those people were on this rota/,
  );
});

test('a publish nobody has heard of is not on record', async () => {
  const { db } = await setup();
  await assert.rejects(() => publishTold(ctx(db), 404), /not on record/);
  await assert.rejects(
    () => publishAgain(ctx(db, { staffIds: [1] }), 404),
    /not on record/,
  );
});

test('tried and refused reads differently from never tried', async () => {
  const { raw, db } = await setup();
  person(raw, { id: 1, name: 'Ama', login: 12, phone: '0551234567' });
  await rosterFor(db, [{ staffId: 1, day: '2026-06-02', shiftId: 1 }]);

  const spy = pretend({ textsFail: true });
  let done;
  try { done = await read(await publishRoster(ctx(db, WEEK, KEYED))); } finally { spy.stop(); }

  const out = await read(await publishTold(ctx(db), done.publishId));
  assert.match(out.people[0].why, /none of them landed/);
});
