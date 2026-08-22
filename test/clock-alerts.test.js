import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { notifyClockings } from '../src/lib/clock-alerts.js';
import { b64urlEncode } from '../src/lib/push.js';
import { ingestPunches, localStamp, recomputeTouched } from '../src/lib/attendance-ingest.js';

/**
 * Telling somebody their own clock-in landed.
 *
 * Four things could go wrong here and each of them is the kind that gets
 * notifications switched off for good: saying it twice, saying it about a
 * punch from last Tuesday because a terminal came back online, calling a
 * departure an arrival, and telling the whole property about one person's
 * morning. There is a test for each.
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

/**
 * Midday, wherever the test happens to run.
 *
 * "Did this just happen" is the whole question, so the clock cannot be faked
 * out of the way. Instead the property is put in whichever time zone makes it
 * about noon locally, and every time in the fixture is an offset from now.
 * Nothing then depends on what hour the suite is run at, and no punch has to
 * step over midnight to stay inside the day it belongs to.
 */
const AWAY = Math.max(-11, Math.min(13, 12 - new Date().getUTCHours()));
const TZ = AWAY >= 0 ? `Etc/GMT-${AWAY}` : `Etc/GMT+${-AWAY}`;

/** An instant, so many minutes from now. */
const from = (minutes) => new Date(Date.now() + minutes * 60_000);
/** And what the property's own clock reads at that instant. */
const clockAt = (minutes) => localStamp(from(minutes), TZ).slice(11, 16);

/**
 * A shift placed around now.
 *
 * `startsIn` is how far from this moment it begins: negative for one already
 * running, positive for one about to.
 */
function scene({ startsIn = -30, runsFor = 300 } = {}) {
  return {
    startsAt: clockAt(startsIn),
    endsAt: clockAt(startsIn + runsFor),
    day: localStamp(from(0), TZ).slice(0, 10),
  };
}

function setup({ subscribed = true, window: w } = {}) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;
            DELETE FROM att_patterns; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM app_notices; DELETE FROM users; DELETE FROM att_devices;`);
  raw.prepare("UPDATE settings SET value = ? WHERE key = 'timezone'").run(TZ);

  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, department)
     VALUES (1, 'Reception day', ?, ?, 0, 'Front of house')`,
  ).run(w.startsAt, w.endsAt);
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, hired_on)
     VALUES (1, '1001', 'Kofi Mensah', 'Front of house', '2020-01-01')`,
  ).run();
  raw.prepare(
    "INSERT INTO users (id, name, role, pin_hash, staff_id, active) VALUES (7, 'Kofi', 'staff', 'x', 1, 1)",
  ).run();
  raw.prepare('INSERT INTO att_roster (staff_id, day, shift_id, published) VALUES (1, ?, 1, 1)')
    .run(w.day);
  raw.prepare(
    "INSERT INTO att_devices (id, serial, name, active) VALUES (1, 'D1', 'Front door', 1)",
  ).run();

  return { raw, db: d1(raw), subscribed };
}

/**
 * A subscription that will encrypt, and a fetch that records rather than
 * sends. The push service is somebody else's problem; what this suite is about
 * is whether the right words reach the right person's endpoint, once.
 */
async function withPush(raw) {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const key = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  raw.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, label)
     VALUES (7, 'https://push.example.test/abc', ?, ?, 'Phone')`,
  ).run(b64urlEncode(key), b64urlEncode(crypto.getRandomValues(new Uint8Array(16))));

  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), init });
    return new Response('', { status: 201 });
  };
  return sent;
}

/** Everything set up, with a phone on it unless the test says otherwise. */
async function scene2(options = {}) {
  const made = setup(options);
  const sent = made.subscribed ? await withPush(made.raw) : [];
  return { ...made, sent };
}

const DEVICE = { id: 1, serial: 'D1' };

/**
 * Put punches through the real ingest, so "which of these are new" is answered
 * by the thing that will answer it in production rather than by the test.
 *
 * Each entry is [minutes from now, what the terminal called it].
 */
async function tap(db, taps) {
  const result = await ingestPunches(db, {
    device: DEVICE,
    events: taps.map(([minutes, status]) => ({
      employeeNoString: '1001',
      time: from(minutes).toISOString(),
      attendanceStatus: status,
      serialNo: `e${Math.round(minutes)}${status}`,
    })),
    timezone: TZ,
    source: 'push',
  });
  await recomputeTouched(db, result.touched);
  return result;
}

const tell = (db, result) => notifyClockings(db, { punches: result.fresh, timezone: TZ });

const noticesIn = (raw) => raw.prepare('SELECT * FROM app_notices ORDER BY id').all();

// ---------------------------------------------------------------------------

const logIn = (raw) => raw.prepare('SELECT * FROM push_log ORDER BY id').all();

test('clocking in tells the person who tapped, and nobody else', async () => {
  // The shift starts in sixteen minutes; they walked in two minutes ago.
  const { raw, db, sent } = await scene2({ window: scene({ startsIn: 16 }) });

  const out = await tell(db, await tap(db, [[-2, 'checkIn']]));

  assert.equal(out.sent, 1);
  const [said] = out.said;
  assert.equal(said.way, 'in');
  assert.equal(said.userId, 7, 'to them and to nobody else');
  assert.equal(said.title, `Clocked in at ${clockAt(-2)}`);
  assert.match(said.body, /Reception day/);
  assert.match(said.body, /18 minutes before your/, 'and says how early');
  assert.equal(said.pushed, 1, 'and it reached a phone');

  assert.equal(sent.length, 1, 'exactly one request to the push service');
  assert.equal(sent[0].url, 'https://push.example.test/abc');
  assert.equal(logIn(raw).at(-1).status, 'sent');

  // Not the bell. Two of these a day would bury everything that needs one.
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM app_notices').get().n, 0);
});

test('clocking in late says how late, in the words the app uses', async () => {
  const { db } = await scene2({ window: scene({ startsIn: -27 }) });

  const out = await tell(db, await tap(db, [[-2, 'checkIn']]));

  assert.match(out.said[0].body, /25 minutes after your/);
});

test('clocking out is a clock-out, not a second arrival', async () => {
  const { db, sent } = await scene2({ window: scene({ startsIn: -40 }) });

  await tell(db, await tap(db, [[-20, 'checkIn']]));
  const out = await tell(db, await tap(db, [[-2, 'checkOut']]));

  assert.equal(out.said[0].way, 'out');
  assert.equal(out.said[0].title, `Clocked out at ${clockAt(-2)}`);
  assert.match(out.said[0].body, /18 minutes recorded today/);
  assert.equal(sent.length, 2, 'one buzz each way and no more');
});

test('the same punch offered again says nothing a second time', async () => {
  const { db, sent } = await scene2({ window: scene({ startsIn: -20 }) });

  const first = await tap(db, [[-2, 'checkIn']]);
  await tell(db, first);

  // A poller's overlapping window re-offers the same event.
  const again = await tap(db, [[-2, 'checkIn']]);
  assert.equal(again.fresh.length, 0, 'the ingest already knows it is not new');
  await tell(db, again);

  // And handed the row directly a second time, the claim still holds.
  const twice = await tell(db, first);
  assert.equal(twice.sent, 0);

  assert.equal(sent.length, 1);
});

test('a terminal posting yesterday\u2019s backlog wakes nobody', async () => {
  const { db, sent } = await scene2({ window: scene({ startsIn: -30 }) });

  const out = await tell(db, await tap(db, [[-24 * 60 - 30, 'checkIn'], [-20 * 60, 'checkOut']]));

  assert.equal(out.sent, 0);
  assert.equal(out.reason, 'nothing recent enough');
  assert.equal(sent.length, 0);
});

test('a break punch in the middle of a shift is not worth a buzz', async () => {
  const { db, sent } = await scene2({ window: scene({ startsIn: -60 }) });

  await tell(db, await tap(db, [[-40, 'checkIn'], [-3, 'checkOut']]));
  const before = sent.length;

  // A tap between the two. It is neither the arrival nor the departure.
  const out = await tell(db, await tap(db, [[-20, 'breakOff']]));

  assert.equal(out.sent, 0);
  assert.equal(sent.length, before, 'nothing new was said');
});

test('nobody subscribed is nothing to send', async () => {
  const { db } = await scene2({ window: scene({ startsIn: -20 }), subscribed: false });

  const out = await tell(db, await tap(db, [[-2, 'checkIn']]));

  assert.equal(out.sent, 0);
  assert.equal(out.reason, 'nobody subscribed');
});

test('turned off means nothing is sent at all', async () => {
  const { raw, db, sent } = await scene2({ window: scene({ startsIn: -20 }) });
  raw.prepare("UPDATE settings SET value = '0' WHERE key = 'att_clock_push'").run();

  const out = await tell(db, await tap(db, [[-2, 'checkIn']]));

  assert.equal(out.sent, 0);
  assert.equal(out.reason, 'switched off');
  assert.equal(sent.length, 0);
});

test('a punch for somebody with no login is stored and not announced', async () => {
  const { raw, db, sent } = await scene2({ window: scene({ startsIn: -20 }) });
  raw.prepare('DELETE FROM push_subscriptions').run();
  raw.prepare('DELETE FROM users WHERE id = 7').run();

  const out = await tell(db, await tap(db, [[-2, 'checkIn']]));

  assert.equal(out.sent, 0);
  assert.equal(sent.length, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM att_punches').get().n, 1, 'the punch is kept');
});

test('the ingest says which punches were new, not just how many', async () => {
  const { db } = await scene2({ window: scene({ startsIn: -40 }) });

  const first = await tap(db, [[-20, 'checkIn']]);
  assert.equal(first.fresh.length, 1);
  assert.equal(first.fresh[0].at_local.slice(11, 16), clockAt(-20));

  // One already stored and one new in the same batch: only the new one is
  // handed back, which is what keeps a phone from buzzing twice.
  const mixed = await tap(db, [[-20, 'checkIn'], [-2, 'checkOut']]);
  assert.equal(mixed.stored, 1);
  assert.equal(mixed.fresh.length, 1);
  assert.equal(mixed.fresh[0].at_local.slice(11, 16), clockAt(-2));
});
