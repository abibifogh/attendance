import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { publishRoster, saveRoster } from '../src/routes/attendance.js';

/**
 * Publishing a rota has to reach the person, not the app.
 *
 * Half the property is on a handset that will never show a web alert, so a
 * published week goes out three ways: an alert where the phone can take one,
 * an email where it cannot, and a text to anybody the first two miss. What
 * these tests pin down is that nobody is told twice and nobody is missed.
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
  raw.exec(`DELETE FROM att_roster; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  for (const [key, value] of Object.entries({
    sms_enabled: '1', sms_provider: 'arkesel', sms_sender: 'HIVE',
    site_url: 'https://staff.niceoperation.com',
    email_from: 'hive@niceoperation.com',
  })) {
    raw.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes, grace_out_minutes)
     VALUES (1, 'Morning', '06:00', '14:00', 0, 5, 5)`,
  ).run();
  return { raw, db: d1(raw) };
}

/** Somebody on the rota, with as much or as little of a way to reach them. */
function person(raw, {
  id, name, login = null, phone = null, subscribed = false,
  email = null, loginEmail = null,
}) {
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (?, ?, ?, 'Kitchen', '2020-01-01')`,
  ).run(id, String(id), name);
  if (phone || email) {
    raw.prepare(
      'INSERT INTO hr_profile (staff_id, personal_phone, personal_email) VALUES (?, ?, ?)',
    ).run(id, phone, email);
  }
  if (login) {
    raw.prepare(
      "INSERT INTO users (id, name, role, active, staff_id, email) VALUES (?, ?, 'staff', 1, ?, ?)",
    ).run(login, name, id, loginEmail);
  }
  if (subscribed) {
    raw.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES (?, ?, 'k', 'a')`,
    ).run(login, `https://push.example/${login}`);
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

const KEYED = { SMS_API_KEY: 'test-key', RESEND_API_KEY: 'test-mail' };
const WEEK = { from: '2026-06-01', to: '2026-06-07' };

function pretend() {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), body: JSON.parse(options?.body ?? '{}') });
    return new Response('{}', { status: 200 });
  };
  return { seen, stop() { globalThis.fetch = real; } };
}

async function rosterFor(db, entries) {
  await saveRoster(ctx(db, { entries }));
}

test('the one an alert cannot reach gets a text, the one it can does not', async () => {
  const { raw, db } = setup();
  person(raw, { id: 1, name: 'Kofi', login: 11, phone: '024 123 4567', subscribed: true });
  person(raw, { id: 2, name: 'Ama', login: 12, phone: '0551234567' });

  await rosterFor(db, [
    { staffId: 1, day: '2026-06-02', shiftId: 1 },
    { staffId: 2, day: '2026-06-03', shiftId: 1 },
  ]);

  const spy = pretend();
  let done;
  try {
    done = await (await publishRoster(ctx(db, WEEK, KEYED))).json();
  } finally {
    spy.stop();
  }

  assert.equal(done.told, 2, 'both had a notice raised');
  assert.equal(done.texted, 1, 'only the one with no way to be alerted was texted');
  assert.deepEqual(spy.seen[0].body.recipients, ['+233551234567'], 'and it was Ama');
});

test('a text says what the week holds, not that a rota exists', async () => {
  const { raw, db } = setup();
  person(raw, { id: 1, name: 'Kofi', login: 11, phone: '0241234567' });

  await rosterFor(db, [
    { staffId: 1, day: '2026-06-02', shiftId: 1 },
    { staffId: 1, day: '2026-06-04', shiftId: 1 },
  ]);

  const spy = pretend();
  try {
    await publishRoster(ctx(db, WEEK, KEYED));
  } finally {
    spy.stop();
  }

  const { message } = spy.seen[0].body;
  assert.match(message, /2 shifts/);
  assert.match(message, /First Tue 2 Jun 06:00/);
  assert.match(message, /staff\.niceoperation\.com/);
  assert.ok(!message.includes('https://'), 'the phone adds that itself');
  assert.ok(message.length <= 160, `one segment, not ${message.length} characters`);
});

test('somebody with no login at all is still reachable by text', async () => {
  const { raw, db } = setup();
  person(raw, { id: 1, name: 'Yaw', phone: '0241234567' });
  person(raw, { id: 2, name: 'Esi' });

  await rosterFor(db, [
    { staffId: 1, day: '2026-06-02', shiftId: 1 },
    { staffId: 2, day: '2026-06-02', shiftId: 1 },
  ]);

  const spy = pretend();
  let done;
  try {
    done = await (await publishRoster(ctx(db, WEEK, KEYED))).json();
  } finally {
    spy.stop();
  }

  assert.equal(done.told, 0, 'no logins, so no bell for either');
  assert.equal(done.noLogin, 2);
  assert.equal(done.texted, 1, 'Yaw was texted');
  assert.equal(done.silent, 1, 'and Esi could not be reached at all');
});

test('the setting can send a text to everybody, alert or no alert', async () => {
  const { raw, db } = setup();
  raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sms_reach', 'all')").run();
  person(raw, { id: 1, name: 'Kofi', login: 11, phone: '0241234567', subscribed: true });

  await rosterFor(db, [{ staffId: 1, day: '2026-06-02', shiftId: 1 }]);

  const spy = pretend();
  let done;
  try {
    done = await (await publishRoster(ctx(db, WEEK, KEYED))).json();
  } finally {
    spy.stop();
  }
  assert.equal(done.texted, 1);
});

test('a gateway that is down does not stop the rota going out', async () => {
  const { raw, db } = setup();
  person(raw, { id: 1, name: 'Kofi', login: 11, phone: '0241234567' });
  await rosterFor(db, [{ staffId: 1, day: '2026-06-02', shiftId: 1 }]);

  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('the network is on fire'); };
  let done;
  try {
    done = await (await publishRoster(ctx(db, WEEK, KEYED))).json();
  } finally {
    globalThis.fetch = real;
  }

  assert.equal(done.published, 1, 'published anyway');
  assert.equal(done.texted, 0);
  assert.equal(raw.prepare('SELECT published FROM att_roster').get().published, 1);
  assert.equal(raw.prepare('SELECT status FROM sms_log').get().status, 'failed');
});

test('publishing quietly texts nobody', async () => {
  const { raw, db } = setup();
  person(raw, { id: 1, name: 'Kofi', phone: '0241234567' });
  await rosterFor(db, [{ staffId: 1, day: '2026-06-02', shiftId: 1 }]);

  const spy = pretend();
  let done;
  try {
    done = await (await publishRoster(ctx(db, { ...WEEK, notify: 'none' }, KEYED))).json();
  } finally {
    spy.stop();
  }
  assert.equal(done.published, 1);
  assert.equal(done.texted, 0);
  assert.equal(spy.seen.length, 0);
});

test('an unset gateway is quiet rather than broken', async () => {
  const { raw, db } = setup();
  person(raw, { id: 1, name: 'Kofi', login: 11, phone: '0241234567' });
  await rosterFor(db, [{ staffId: 1, day: '2026-06-02', shiftId: 1 }]);

  const spy = pretend();
  let done;
  try {
    done = await (await publishRoster(ctx(db, WEEK, {}))).json();
  } finally {
    spy.stop();
  }
  assert.equal(done.published, 1);
  assert.equal(done.texted, 0);
  assert.equal(spy.seen.length, 0);
});

test('email fills the gap the alert leaves, and only that gap', async () => {
  const { raw, db } = setup();
  raw.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('email_from', 'hive@niceoperation.com')",
  ).run();
  person(raw, { id: 1, name: 'Kofi', login: 11, subscribed: true });
  person(raw, { id: 2, name: 'Ama', login: 12 });
  raw.prepare("UPDATE users SET email = 'kofi@niceoperation.com' WHERE id = 11").run();
  raw.prepare("UPDATE users SET email = 'ama@niceoperation.com' WHERE id = 12").run();

  await rosterFor(db, [
    { staffId: 1, day: '2026-06-02', shiftId: 1 },
    { staffId: 2, day: '2026-06-03', shiftId: 1 },
  ]);

  const spy = pretend();
  try {
    await publishRoster(ctx(db, WEEK, { ...KEYED, RESEND_API_KEY: 'r' }));
  } finally {
    spy.stop();
  }

  const posted = raw.prepare("SELECT * FROM email_log WHERE kind = 'notice'").all();
  assert.equal(posted.length, 1, 'one mail, not two');
  assert.equal(posted[0].recipients, 'ama@niceoperation.com',
    'Kofi already had a buzz; sending him the same thing again is how a mailbox stops being read');
});

test('the planner’s note rides along when it fits, and is dropped when it does not', async () => {
  const { raw, db } = setup();
  person(raw, { id: 1, name: 'Kofi', phone: '0241234567' });
  await rosterFor(db, [{ staffId: 1, day: '2026-06-02', shiftId: 1 }]);

  let spy = pretend();
  try {
    await publishRoster(ctx(db, { ...WEEK, message: 'Swap with Ama on Friday.' }, KEYED));
  } finally {
    spy.stop();
  }
  let sent = spy.seen[0].body.message;
  assert.match(sent, /Swap with Ama on Friday\./);
  assert.ok(sent.length <= 160, `still one segment, not ${sent.length}`);

  // And again with a note nobody could fit into a text.
  raw.prepare('UPDATE att_roster SET published = 0').run();
  spy = pretend();
  try {
    await publishRoster(ctx(db, { ...WEEK, message: 'x'.repeat(300) }, KEYED));
  } finally {
    spy.stop();
  }
  sent = spy.seen[0].body.message;
  assert.ok(!sent.includes('xxx'), 'a note that would double the bill is left out');
  assert.ok(sent.length <= 160);
});

// ---------------------------------------------------------------------------
// The address, and where it is found
// ---------------------------------------------------------------------------

/**
 * A login needs a PIN and nothing else, so most of them carry no address, and
 * most of this property has no login at all. Mail that only looks at the login
 * is mail that does not arrive: the address somebody typed when they joined is
 * on their personnel record, under People.
 */

/** Every address a Resend call went to, in order. */
const mailedTo = (spy) => spy.seen
  .filter((call) => call.url.includes('api.resend.com'))
  .flatMap((call) => (call.body.to ?? []).concat(
    (call.body.batch ?? []).flatMap((one) => one.to ?? []),
  ));

async function publishWith(db, people) {
  await rosterFor(db, people);
  const spy = pretend();
  try {
    return { done: await (await publishRoster(ctx(db, WEEK, KEYED))).json(), spy };
  } finally {
    spy.stop();
  }
}

test('the address on their record is used where their login has none', async () => {
  const { raw, db } = setup();
  person(raw, { id: 1, name: 'Ama', login: 11, email: 'ama@example.com' });

  const { spy } = await publishWith(db, [{ staffId: 1, day: '2026-06-02', shiftId: 1 }]);
  assert.deepEqual(mailedTo(spy), ['ama@example.com']);
});

test('the login’s own address wins where there is one', async () => {
  // It is the address somebody chose to sign in with, and the one the rest of
  // the app writes to.
  const { raw, db } = setup();
  person(raw, {
    id: 1, name: 'Ama', login: 11, loginEmail: 'ama@work.com', email: 'ama@home.com',
  });

  const { spy } = await publishWith(db, [{ staffId: 1, day: '2026-06-02', shiftId: 1 }]);
  assert.deepEqual(mailedTo(spy), ['ama@work.com']);
});

test('somebody with no login at all is still written to', async () => {
  // Most of the property. There is no bell to ring and no alert to send, and
  // it used to end there: no row, no mail, and a text only if there was a
  // number on file.
  const { raw, db } = setup();
  person(raw, { id: 1, name: 'Kwabena', email: 'kwabena@example.com' });

  const { done, spy } = await publishWith(db, [{ staffId: 1, day: '2026-06-02', shiftId: 1 }]);

  assert.deepEqual(mailedTo(spy), ['kwabena@example.com']);
  assert.equal(done.noLogin, 1, 'still counted, because there is still no bell for them');
  assert.equal(done.told, 1, 'but they heard');
  assert.equal(done.silent, 0, 'and they are not among the unreachable');
});

test('no login and no address anywhere is still nobody reached', async () => {
  const { raw, db } = setup();
  person(raw, { id: 1, name: 'Yaw' });

  const { done, spy } = await publishWith(db, [{ staffId: 1, day: '2026-06-02', shiftId: 1 }]);

  assert.deepEqual(mailedTo(spy), []);
  assert.equal(done.silent, 1, 'the planner is told to go and find them');
});

// ---------------------------------------------------------------------------
// Who gets one at all
// ---------------------------------------------------------------------------

test('a phone that buzzed is not mailed as well', async () => {
  // The default, and the reason it is the default: the same message twice is
  // how a fortnightly rota turns into a mailbox nobody opens.
  const { raw, db } = setup();
  person(raw, {
    id: 1, name: 'Kofi', login: 11, email: 'kofi@example.com', subscribed: true,
  });

  const { spy } = await publishWith(db, [{ staffId: 1, day: '2026-06-02', shiftId: 1 }]);
  assert.deepEqual(mailedTo(spy), []);
});

test('and is mailed as well where the property has asked for it', async () => {
  const { raw, db } = setup();
  raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('rota_email_always', '1')")
    .run();
  person(raw, {
    id: 1, name: 'Kofi', login: 11, email: 'kofi@example.com', subscribed: true,
  });

  const { spy } = await publishWith(db, [{ staffId: 1, day: '2026-06-02', shiftId: 1 }]);
  assert.deepEqual(mailedTo(spy), ['kofi@example.com']);
});

test('the setting starts off, so nothing changes until somebody turns it on', async () => {
  const { raw } = setup();
  const row = raw.prepare("SELECT value FROM settings WHERE key = 'rota_email_always'").get();
  assert.equal(row.value, '0');
});

test('publishing quietly mails nobody, whatever the setting says', async () => {
  const { raw, db } = setup();
  raw.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('rota_email_always', '1')")
    .run();
  person(raw, { id: 1, name: 'Ama', login: 11, email: 'ama@example.com' });

  await rosterFor(db, [{ staffId: 1, day: '2026-06-02', shiftId: 1 }]);
  const spy = pretend();
  try {
    await publishRoster(ctx(db, { ...WEEK, notify: 'none' }, KEYED));
  } finally {
    spy.stop();
  }
  assert.deepEqual(mailedTo(spy), []);
});
