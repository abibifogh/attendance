import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/index.js';
import { LiveHub } from '../src/live-hub.js';
import { mayHear, topicFor, worthTelling } from '../src/lib/live.js';
import { createToken } from '../src/lib/auth.js';

/**
 * Live updates, in place of a timer.
 *
 * Three things have to hold or the channel is either useless or a leak. That a
 * change reaches the other screens at all. That it reaches only the people who
 * were already allowed to look at the thing that changed. And that it carries
 * the fact something happened rather than what happened, so no amount of
 * growth around it can turn a socket into a second way of reading the
 * database.
 */

// ---------------------------------------------------------------------------
// Which topic a path belongs to
// ---------------------------------------------------------------------------

test('a path belongs to the thing a person would say changed', () => {
  assert.equal(topicFor('/api/att/roster'), 'rota');
  assert.equal(topicFor('/api/att/roster/publish'), 'rota');
  assert.equal(topicFor('/api/att/shifts/4'), 'rota');
  assert.equal(topicFor('/api/att/patterns'), 'rota');
  assert.equal(topicFor('/api/att/leave/3/decide'), 'leave');
  assert.equal(topicFor('/api/att/day'), 'attendance');
  assert.equal(topicFor('/api/att/ingest'), 'attendance');
  assert.equal(topicFor('/api/signoff/sign'), 'attendance');
  assert.equal(topicFor('/api/hr/people/2'), 'people');
  assert.equal(topicFor('/api/payroll/close'), 'pay');
  assert.equal(topicFor('/api/advances/7/decide'), 'pay');
  assert.equal(topicFor('/api/corr/letters/9'), 'letters');
  assert.equal(topicFor('/api/lunch/order'), 'lunch');
  assert.equal(topicFor('/api/users/3'), 'admin');
});

test('the longer prefix wins, so leave is not swallowed by attendance', () => {
  // Both '/api/att/' and '/api/att/leave' match; the specific one is the
  // answer, or approving somebody's leave would read as a punch.
  assert.equal(topicFor('/api/att/leave'), 'leave');
  assert.equal(topicFor('/api/att/availability'), 'rota');
  assert.equal(topicFor('/api/att/holidays/2'), 'rota');
});

test('a path nobody has classified is still said, to everybody', () => {
  // The safe answer, and the one the old timer gave: every screen asked again
  // on every tick whatever had happened.
  assert.equal(topicFor('/api/something/new'), 'other');
  assert.equal(mayHear('other', []), true);
  assert.equal(mayHear('a topic that does not exist', []), true);
});

// ---------------------------------------------------------------------------
// What is worth telling anybody about
// ---------------------------------------------------------------------------

test('only what changed something, and never a read', () => {
  assert.equal(worthTelling('POST', '/api/att/roster'), true);
  assert.equal(worthTelling('PUT', '/api/att/shifts/2'), true);
  assert.equal(worthTelling('DELETE', '/api/users/4'), true);
  assert.equal(worthTelling('GET', '/api/att/roster'), false);
  assert.equal(worthTelling('HEAD', '/api/att/roster'), false);
});

test('signing in, testing a notification and reading your own bell are quiet', () => {
  // Real writes, every one of them, and none a reason to make two dozen
  // devices re-ask for a rota.
  assert.equal(worthTelling('POST', '/api/auth/login'), false);
  assert.equal(worthTelling('POST', '/api/auth/logout'), false);
  assert.equal(worthTelling('POST', '/api/push/subscribe'), false);
  assert.equal(worthTelling('POST', '/api/notices/seen'), false);
  assert.equal(worthTelling('POST', '/api/notifications/test'), false);
  assert.equal(worthTelling('POST', '/api/payroll/unlock'), false);
});

// ---------------------------------------------------------------------------
// Who may be told
// ---------------------------------------------------------------------------

test('a member of staff hears that the rota changed', () => {
  // The person least able to change a rota and most waiting to hear that one
  // has been published. Hearing is not writing.
  assert.equal(mayHear('rota', ['att_me']), true);
  assert.equal(mayHear('leave', ['att_me']), true);
  assert.equal(mayHear('attendance', ['att_me']), true);
});

test('a supervisor is not told the payroll moved', () => {
  assert.equal(mayHear('pay', ['att_view', 'att_rota']), false);
  assert.equal(mayHear('people', ['att_view']), false);
  assert.equal(mayHear('letters', ['att_view']), false);
  assert.equal(mayHear('admin', ['att_view', 'att_rota', 'hr_pay']), false);
});

test('the bell is for everybody', () => {
  assert.equal(mayHear('notices', []), true);
});

// ---------------------------------------------------------------------------
// The hub itself
// ---------------------------------------------------------------------------

/** A socket that remembers what it was told, and its attachment. */
function fakeSocket(attachment, { breaks = false } = {}) {
  let held = attachment;
  return {
    heard: [],
    closed: null,
    serializeAttachment(value) { held = value; },
    deserializeAttachment() { return held; },
    send(text) {
      if (breaks) throw new Error('gone');
      this.heard.push(JSON.parse(text));
    },
    close(code) { this.closed = code ?? 1000; },
  };
}

function hubOf(sockets) {
  const hub = new LiveHub({
    getWebSockets: () => sockets,
    acceptWebSocket: () => {},
    setWebSocketAutoResponse: () => {},
  });
  return hub;
}

test('a change reaches every socket entitled to hear it', () => {
  const planner = fakeSocket({ permissions: ['att_rota', 'att_view'], by: 'a' });
  const staff = fakeSocket({ permissions: ['att_me'], by: 'b' });
  const book = fakeSocket({ permissions: ['hr_pay'], by: 'c' });

  const sent = hubOf([planner, staff, book]).tell({ topic: 'rota', by: null, at: 5 });

  assert.equal(sent, 2);
  assert.deepEqual(planner.heard, [{ type: 'changed', topic: 'rota', at: 5 }]);
  assert.deepEqual(staff.heard, [{ type: 'changed', topic: 'rota', at: 5 }]);
  assert.deepEqual(book.heard, [], 'the bookkeeper was not told about a rota');
});

test('the tab that made the change is not told about it', () => {
  // It has already redrawn itself off the answer to its own save, and a second
  // redraw on top of staged edits is how somebody loses work.
  const mine = fakeSocket({ permissions: ['att_rota'], by: 'tab-1' });
  const myOtherTab = fakeSocket({ permissions: ['att_rota'], by: 'tab-2' });

  const sent = hubOf([mine, myOtherTab]).tell({ topic: 'rota', by: 'tab-1' });

  assert.equal(sent, 1);
  assert.deepEqual(mine.heard, []);
  assert.equal(myOtherTab.heard.length, 1, 'the same person’s other screen is a screen');
});

test('a socket that has gone without saying so is closed rather than retried', () => {
  const dead = fakeSocket({ permissions: ['att_rota'], by: 'x' }, { breaks: true });
  const alive = fakeSocket({ permissions: ['att_rota'], by: 'y' });

  const sent = hubOf([dead, alive]).tell({ topic: 'rota' });

  assert.equal(sent, 1);
  assert.equal(dead.closed, 1011);
  assert.equal(alive.heard.length, 1);
});

test('a socket with an unreadable attachment hears only what everybody hears', () => {
  const odd = {
    heard: [],
    deserializeAttachment() { throw new Error('corrupt'); },
    send(text) { this.heard.push(JSON.parse(text)); },
    close() {},
  };
  const hub = hubOf([odd]);

  assert.equal(hub.tell({ topic: 'pay' }), 0);
  assert.equal(hub.tell({ topic: 'notices' }), 1);
});

test('nothing but the fact of a change ever goes down the socket', () => {
  const who = fakeSocket({ permissions: ['att_rota'], by: 'a' });
  hubOf([who]).tell({ topic: 'rota', at: 99 });

  assert.deepEqual(Object.keys(who.heard[0]).sort(), ['at', 'topic', 'type']);
});

// ---------------------------------------------------------------------------
// The worker announces, exactly where it should
// ---------------------------------------------------------------------------

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

const SECRET = 'a-test-secret-that-is-long-enough';

async function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_roster; DELETE FROM att_shifts; DELETE FROM att_staff;
            DELETE FROM users;`);
  raw.exec("UPDATE settings SET value = 'UTC' WHERE key = 'timezone'");
  raw.prepare(
    `INSERT INTO att_shifts (id, name, starts_at, ends_at, break_minutes, grace_in_minutes)
     VALUES (1, 'Reception', '06:00', '14:00', 0, 5)`,
  ).run();
  raw.prepare(
    "INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (1, '1', 'Adjoa', '2020-01-01')",
  ).run();
  raw.prepare(
    "INSERT INTO users (id, name, role, active) VALUES (7, 'Kwame', 'admin', 1)",
  ).run();

  const said = [];
  const env = {
    DB: d1(raw),
    SESSION_SECRET: SECRET,
    ASSETS: { fetch: async () => new Response('asset') },
    LIVE: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (_url, init) => {
          said.push(JSON.parse(init.body));
          return new Response('{}');
        },
      }),
    },
  };

  const token = await createToken(
    { uid: 7, via: 'password', exp: Math.floor(Date.now() / 1000) + 3600 },
    SECRET,
  );
  return { env, said, token };
}

const call = (env, token, path, init = {}) => worker.fetch(
  new Request(`https://x${path}`, {
    ...init,
    headers: { Cookie: `bf_session=${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  }),
  env,
  { waitUntil: (p) => p },
);

test('saving a rota tells everybody a rota changed', async () => {
  const { env, said, token } = await setup();

  const res = await call(env, token, '/api/att/roster', {
    method: 'POST',
    body: JSON.stringify({ entries: [{ staffId: 1, day: '2026-09-07', shiftId: 1 }] }),
  });

  assert.equal(res.status, 200);
  assert.equal(said.length, 1);
  assert.equal(said[0].topic, 'rota');
  assert.equal(typeof said[0].at, 'number');
  assert.deepEqual(Object.keys(said[0]).sort(), ['at', 'by', 'topic'],
    'and nothing about what was saved travels with it');
});

test('reading tells nobody anything', async () => {
  const { env, said, token } = await setup();
  const res = await call(env, token, '/api/att/roster?from=2026-09-07&to=2026-09-13');
  assert.equal(res.status, 200);
  assert.deepEqual(said, []);
});

test('a save that was refused is not news', async () => {
  const { env, said, token } = await setup();
  const res = await call(env, token, '/api/att/roster', {
    method: 'POST',
    body: JSON.stringify({ entries: [] }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(said, []);
});

test('the tab that saved is named, so it can be left out', async () => {
  const { env, said, token } = await setup();
  await call(env, token, '/api/att/roster', {
    method: 'POST',
    headers: { 'X-Hive-Client': 'tab-9' },
    body: JSON.stringify({ entries: [{ staffId: 1, day: '2026-09-08', shiftId: 1 }] }),
  });
  assert.equal(said[0].by, 'tab-9');
});

test('a deployment with no live binding saves exactly as before', async () => {
  const { env, token } = await setup();
  delete env.LIVE;

  const res = await call(env, token, '/api/att/roster', {
    method: 'POST',
    body: JSON.stringify({ entries: [{ staffId: 1, day: '2026-09-09', shiftId: 1 }] }),
  });
  assert.equal(res.status, 200, 'a channel that is not there must never fail a save');
});

test('the live address is not a page, and says so', async () => {
  const { env, token } = await setup();
  const res = await call(env, token, '/api/live');
  assert.equal(res.status, 426);
});

test('nobody signed out gets a socket', async () => {
  const { env } = await setup();
  const res = await worker.fetch(
    new Request('https://x/api/live', { headers: { Upgrade: 'websocket' } }),
    env,
    { waitUntil: (p) => p },
  );
  assert.equal(res.status, 401);
});

test('a candidate taking a time reaches the office diary, and only recruitment', () => {
  // The one change in this app that happens with nobody here doing it. Both
  // sides of it belong to the same topic: the office publishing times and the
  // candidate taking one are the same screen changing.
  assert.equal(topicFor('/api/rec/slots'), 'recruitment');
  assert.equal(topicFor('/api/rec/candidates/1/stage'), 'recruitment');
  assert.equal(topicFor('/api/c/abc123/choose'), 'recruitment');
  assert.equal(topicFor('/api/c/abc123/release'), 'recruitment');

  // A booking made from a page with no session still announces itself.
  assert.equal(worthTelling('POST', '/api/c/abc123/choose'), true);

  // And it is heard by whoever runs the recruitment, and nobody else. A topic
  // name carries nothing, but a screen that reloads for no reason it can show
  // teaches people that the app is restless.
  assert.equal(mayHear('recruitment', ['rec_view']), true);
  assert.equal(mayHear('recruitment', ['rec_manage', 'rec_view']), true);
  assert.equal(mayHear('recruitment', ['att_rota_view']), false);
  assert.equal(mayHear('recruitment', ['att_me']), false);
});
