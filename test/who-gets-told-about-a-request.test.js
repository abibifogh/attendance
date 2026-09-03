import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { noticeRecipients } from '../src/lib/notify.js';
import { defaultPermissions, effectivePermissions } from '../src/lib/permissions.js';

/**
 * Who hears about a request, and who hears about it in their inbox.
 *
 * These are two different questions and were being answered with one number.
 * A day somebody cannot work is exactly what a rota planner is working
 * around, so they should see it on the screen they build the week on. It is
 * not theirs to answer, so it has no business in their inbox on a Sunday
 * night: an email nobody can act on is how somebody learns to filter the
 * sender, and then the one that mattered goes unread too.
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
  return { prepare: (sql) => st(sql), async batch(l) { const o = []; for (const s of l) o.push(await s.run()); return o; } };
}

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM users;');
  for (const [id, name, role] of [
    [1, 'Yaa the planner', 'planner'],
    [2, 'Kofi the supervisor', 'supervisor'],
    [3, 'Ama the manager', 'manager'],
    [4, 'Kwame the administrator', 'admin'],
    [5, 'Efua reports only', 'viewer'],
  ]) {
    raw.prepare(
      'INSERT INTO users (id, name, role, email, active) VALUES (?, ?, ?, ?, 1)',
    ).run(id, name, role, `${role}@example.com`);
  }
  return { raw, db: d1(raw) };
}

const named = (people) => people.map((p) => p.name).sort();

test('a rota planner can build the rota and cannot answer a request', () => {
  const planner = { role: 'planner', permissions: null };
  const held = effectivePermissions(planner);
  assert.ok(held.includes('att_rota'), 'they build the week');
  assert.ok(!held.includes('att_manage'), 'and they do not decide leave or availability');
  assert.deepEqual(defaultPermissions('planner'), ['att_view', 'att_rota', 'att_times']);
});

test('an availability request is seen by the planner and mailed only to whoever answers it', async () => {
  const { db } = setup();

  // What the bell reaches: everybody who works on the rota.
  const onScreen = await noticeRecipients(db, { audience: 'att_rota' });
  assert.ok(named(onScreen).includes('Yaa the planner'));

  // What the inbox reaches: only the people who can answer it.
  const byEmail = await noticeRecipients(db, { audience: 'att_manage' });
  assert.ok(!named(byEmail).includes('Yaa the planner'), 'not the planner');
  assert.deepEqual(named(byEmail), [
    'Ama the manager', 'Kofi the supervisor', 'Kwame the administrator',
  ]);
});

test('a leave request never reached the planner and still does not', async () => {
  const { db } = setup();
  const byEmail = await noticeRecipients(db, { audience: 'att_manage' });
  assert.ok(!named(byEmail).includes('Yaa the planner'));
  assert.ok(!named(byEmail).includes('Efua reports only'), 'nor whoever only reads reports');
});

test('the narrower audience is used only where a notice asks for one', async () => {
  const { db } = setup();
  const { emailNotice } = await import('../src/lib/notify.js');

  // No mail is actually sent without a key and a from address, but the
  // recipient list is worked out before that, so the reason tells us which
  // audience was consulted: "nobody to send to" means the filter ran and
  // found none, "not configured" means it never got that far.
  const wide = await noticeRecipients(db, { audience: 'att_rota' });
  assert.ok(wide.length > 3, 'att_rota is the wider of the two');

  // A notice with no emailAudience mails whoever sees it, as it always did.
  assert.deepEqual(
    named(await noticeRecipients(db, { audience: 'att_reports' })),
    named(await noticeRecipients(db, { audience: 'att_reports', emailAudience: undefined })),
  );
  assert.equal(typeof emailNotice, 'function');
});

test('a notice addressed to one person goes to them whatever the audiences say', async () => {
  const { db } = setup();
  const one = await noticeRecipients(db, { audience: 'att_manage', userId: 1 });
  assert.deepEqual(named(one), ['Yaa the planner'],
    'a named person is the whole audience, which is what makes a decision somebody owns');
});

// ---------------------------------------------------------------------------
// The wiring, driven for real
// ---------------------------------------------------------------------------

test('asking about a day rings the planner and mails only the people who answer', async () => {
  const { raw, db } = setup();
  const { setMyAvailability } = await import('../src/routes/me.js');

  // A member of staff with a login, and a property set up to send mail.
  raw.prepare("INSERT INTO att_staff (id, employee_no, name, hired_on) VALUES (77, '77', 'Adjoa', '2020-01-01')")
    .run();
  raw.prepare("INSERT INTO users (id, name, role, staff_id, active) VALUES (9, 'Adjoa', 'staff', 77, 1)").run();
  for (const [key, value] of [['email_from', 'hive@example.com'], ['site_url', 'https://staff.example.com']]) {
    raw.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?2')
      .run(key, value);
  }

  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const tomorrow = new Date(Date.now() + 36e5 * 30).toISOString().slice(0, 10);
  try {
    await setMyAvailability({
      db,
      env: { RESEND_API_KEY: 'test-key' },
      url: new URL('https://x/api/me/availability'),
      session: { user: { id: 9, name: 'Adjoa', role: 'staff', staff_id: 77 } },
      executionContext: null,
      request: new Request('https://x/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: [tomorrow], status: 'unavailable', note: 'A funeral' }),
      }),
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  // The bell reaches everybody who builds the rota, the planner included.
  const notice = raw.prepare("SELECT audience, title FROM app_notices WHERE kind = 'attendance.availability_asked'").get();
  assert.ok(notice, 'the notice was written');
  assert.equal(notice.audience, 'att_rota');

  // The inbox does not.
  assert.equal(sent.length, 1, 'one mail went out');
  const to = sent[0].to;
  assert.ok(!to.includes('planner@example.com'), `the planner was mailed: ${to.join(', ')}`);
  assert.ok(to.includes('manager@example.com'));
  assert.ok(to.includes('supervisor@example.com'));
  assert.ok(to.includes('admin@example.com'));

  const logged = raw.prepare("SELECT recipients FROM email_log WHERE kind = 'notice'").get();
  assert.ok(!String(logged.recipients).includes('planner@'));
});
