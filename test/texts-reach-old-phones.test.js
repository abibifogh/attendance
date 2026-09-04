import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  MOST_IN_ONE_GO, PROVIDERS, firstUsableNumber, ghanaNumber, sendTexts, senderId, smsSetup,
} from '../src/lib/sms.js';

/**
 * Texts exist for one reason: an iPhone 7 Plus can never show a web alert, and
 * a good half of the property is holding one. So the number has to survive
 * however it was written down, and a gateway being down must never be able to
 * stop a rota going out.
 */

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

test('a number is read however somebody wrote it down', () => {
  for (const written of [
    '0241234567', '024 123 4567', '024-123-4567', '+233241234567',
    '+233 24 123 4567', '00233241234567', '233241234567', '241234567',
  ]) {
    assert.equal(ghanaNumber(written), '+233241234567', written);
  }
});

test('the other networks are read too', () => {
  assert.equal(ghanaNumber('0551234567'), '+233551234567');
  assert.equal(ghanaNumber('0302123456'), '+233302123456');
});

test('anything that is not a number here is refused rather than guessed at', () => {
  for (const junk of ['', null, undefined, 'n/a', '0712345678', '02412345', '024123456789', '+447700900000']) {
    assert.equal(ghanaNumber(junk), null, String(junk));
  }
});

test('the first usable number wins, and none means none', () => {
  assert.equal(firstUsableNumber('n/a', '0241234567'), '+233241234567');
  assert.equal(firstUsableNumber(null, '', 'ask reception'), null);
});

test('a sender name is trimmed to what a gateway will register', () => {
  assert.equal(senderId('HIVE'), 'HIVE');
  assert.equal(senderId('Somewhere Nice Hotel'), 'Somewhere N');
  assert.equal(senderId('H!V€'), 'HV');
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

test('nothing is ready until there is a key and a sender name', () => {
  const bare = smsSetup({}, {});
  assert.equal(bare.ready, false);
  assert.deepEqual(bare.missing, ['SMS_API_KEY', 'a sender name']);

  const done = smsSetup({ sms_sender: 'HIVE' }, { SMS_API_KEY: 'k' });
  assert.equal(done.ready, true);
  assert.deepEqual(done.missing, []);
});

test('Hubtel needs its second credential and the others do not', () => {
  const hubtel = smsSetup({ sms_provider: 'hubtel', sms_sender: 'HIVE' }, { SMS_API_KEY: 'k' });
  assert.deepEqual(hubtel.missing, ['SMS_API_SECRET']);

  const arkesel = smsSetup({ sms_provider: 'arkesel', sms_sender: 'HIVE' }, { SMS_API_KEY: 'k' });
  assert.equal(arkesel.ready, true);
});

test('an unknown gateway falls back rather than being sent to', () => {
  assert.equal(smsSetup({ sms_provider: 'carrier-pigeon' }, {}).provider, 'arkesel');
  assert.ok(PROVIDERS.includes('arkesel'));
});

test('only the ones an alert cannot reach, unless somebody says otherwise', () => {
  assert.equal(smsSetup({}, {}).reach, 'gap');
  assert.equal(smsSetup({ sms_reach: 'all' }, {}).reach, 'all');
  assert.equal(smsSetup({ sms_reach: 'nonsense' }, {}).reach, 'gap');
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function d1(db) {
  const st = (sql, binds = []) => ({
    bind(...a) { return st(sql, a); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() { db.prepare(sql).run(...binds); return { success: true }; },
  });
  return { prepare: (sql) => st(sql) };
}

function setup(settings = {}) {
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  for (const [key, value] of Object.entries(settings)) {
    raw.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }
  return { raw, db: d1(raw) };
}

const ON = { sms_enabled: '1', sms_provider: 'arkesel', sms_sender: 'HIVE' };
const KEYED = { SMS_API_KEY: 'test-key' };

function pretend(handler) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), options });
    return handler(seen.length);
  };
  return { seen, stop() { globalThis.fetch = real; } };
}

const ok = () => new Response('{}', { status: 200 });

test('a switched-off gateway sends nothing and says why', async () => {
  const { db } = setup({ ...ON, sms_enabled: '0' });
  const out = await sendTexts(db, KEYED, {
    messages: [{ to: '+233241234567', text: 'hello' }], kind: 'test',
  });
  assert.equal(out.sent, 0);
  assert.equal(out.reason, 'switched off');
});

test('a gateway with no key sends nothing and names what is missing', async () => {
  const { db } = setup(ON);
  const out = await sendTexts(db, {}, {
    messages: [{ to: '+233241234567', text: 'hello' }], kind: 'test',
  });
  assert.equal(out.sent, 0);
  assert.match(out.reason, /SMS_API_KEY/);
});

test('a text goes out, and what happened is written down', async () => {
  const { raw, db } = setup(ON);
  const spy = pretend(ok);
  try {
    const out = await sendTexts(db, KEYED, {
      messages: [{ to: '+233241234567', text: 'your rota is out' }],
      kind: 'rota.published.mine',
      day: '2026-08-31',
    });
    assert.equal(out.sent, 1);
    assert.equal(spy.seen.length, 1);
    assert.match(spy.seen[0].url, /arkesel/);
    assert.equal(JSON.parse(spy.seen[0].options.body).sender, 'HIVE');
  } finally {
    spy.stop();
  }

  const logged = raw.prepare('SELECT * FROM sms_log').all();
  assert.equal(logged.length, 1);
  assert.equal(logged[0].status, 'sent');
  assert.equal(logged[0].sent, 1);
  assert.equal(logged[0].day, '2026-08-31');
});

test('a gateway that refuses is recorded, not thrown', async () => {
  const { raw, db } = setup(ON);
  const spy = pretend(() => new Response('no credit', { status: 402 }));
  try {
    const out = await sendTexts(db, KEYED, {
      messages: [{ to: '+233241234567', text: 'x' }], kind: 'rota.published.mine',
    });
    assert.equal(out.sent, 0);
    assert.equal(out.failed, 1);
  } finally {
    spy.stop();
  }

  const logged = raw.prepare('SELECT * FROM sms_log').all();
  assert.equal(logged[0].status, 'failed');
  assert.match(logged[0].detail, /402/);
});

test('one bad number out of two does not stop the other', async () => {
  const { raw, db } = setup(ON);
  const spy = pretend((n) => (n === 1 ? new Response('bad', { status: 400 }) : ok()));
  try {
    const out = await sendTexts(db, KEYED, {
      messages: [
        { to: '+233241234567', text: 'a' },
        { to: '+233551234567', text: 'b' },
      ],
      kind: 'rota.published.mine',
    });
    assert.equal(out.sent, 1);
    assert.equal(out.failed, 1);
  } finally {
    spy.stop();
  }
  assert.equal(raw.prepare('SELECT status FROM sms_log').get().status, 'part sent');
});

test('a runaway list stops at the cap rather than spending', async () => {
  const { raw, db } = setup(ON);
  const spy = pretend(ok);
  const many = Array.from({ length: MOST_IN_ONE_GO + 5 }, (_, i) => ({
    to: '+233241234567', text: `no ${i}`,
  }));
  try {
    const out = await sendTexts(db, KEYED, { messages: many, kind: 'rota.published.mine' });
    assert.equal(out.sent, MOST_IN_ONE_GO);
    assert.equal(out.skipped, 5);
  } finally {
    spy.stop();
  }
  assert.match(raw.prepare('SELECT detail FROM sms_log').get().detail, /not attempted/);
});

test('nobody to text is not an error', async () => {
  const { db } = setup(ON);
  const out = await sendTexts(db, KEYED, { messages: [], kind: 'rota.published.mine' });
  assert.equal(out.sent, 0);
  assert.equal(out.reason, 'nobody to text');
});
