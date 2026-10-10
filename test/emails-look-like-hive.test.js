import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  renderMail, sayDate, sayHours, sayMonth, sayRange, sayShortDate, sayTime,
} from '../src/lib/email-design.js';
import { createNotice } from '../src/lib/notices.js';
import { ccFor, renderDigest, renderJoinInvite, sendEmail } from '../src/lib/notify.js';

/**
 * Every HIVE email in one design, and one standing copy of each.
 *
 * What is pinned down: a notice that says how it should look is laid out that
 * way, one that does not still gets the design, nothing anybody typed reaches
 * the mail as markup, the button is the gold one and goes where the notice
 * points, and the property's standing copy gets one message per notice rather
 * than one per person, and never the invitation.
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

function setup(people = 3) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM users');
  for (let i = 1; i <= people; i += 1) {
    raw.prepare('INSERT INTO users (id, name, role, email, active) VALUES (?, ?, ?, ?, 1)')
      .run(i, `Person ${i}`, 'admin', `person${i}@example.test`);
  }
  for (const [key, value] of [
    ['email_from', 'hive@niceoperation.com'],
    ['site_url', 'https://staff.niceoperation.com'],
    ['property_name', 'Somewhere Nice'],
  ]) {
    raw.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?2')
      .run(key, value);
  }
  return { raw, db: d1(raw) };
}

function catching() {
  const real = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { sent, restore: () => { globalThis.fetch = real; } };
}
const messagesIn = (call) => (Array.isArray(call.body) ? call.body : [call.body]);

// ---------------------------------------------------------------------------
// The design
// ---------------------------------------------------------------------------

test('a notice that says how it looks is laid out that way', () => {
  const { subject, html } = renderMail({
    notice: {
      title: 'Afternoon · 2026-10-10 closed · Kwame',
      link: '#/att-my-till',
      mail: {
        subject: 'Afternoon shift closed by Kwame · Sat 10 Oct',
        status: 'Closed', tone: 'good', eyebrow: 'Till',
        headline: 'Kwame Mensah closed the afternoon shift',
        sub: 'Saturday 10 October · 2 pm to 10 pm',
        facts: [['Cash in the drawer', 'GH₵ 456.00', { big: true, strong: true }], ['To the safe', 'Nothing'], ['Empty', '']],
        button: 'See the closing report',
        why: 'You get this because you follow till closings.',
      },
    },
    propertyName: 'Somewhere Nice',
    companyName: 'Sir Tobys Ghana Ltd',
    siteUrl: 'https://staff.niceoperation.com',
  });

  assert.equal(subject, 'Afternoon shift closed by Kwame · Sat 10 Oct');
  assert.match(html, /Kwame Mensah closed the afternoon shift/);
  assert.match(html, />Closed</);
  assert.match(html, />GH₵ 456\.00</);
  assert.ok(!html.includes('>Empty<'), 'a fact with nothing in it is left out');
  assert.match(html, /href="https:\/\/staff\.niceoperation\.com\/#\/att-my-till"[^>]*>See the closing report</);
  assert.match(html, /background:#f2a93b/, 'the button is the gold one');
  assert.match(html, /Sent by HIVE for Somewhere Nice · Sir Tobys Ghana Ltd/);
  assert.match(html, /You get this because you follow till closings\./);
  assert.match(html, /prefers-color-scheme: dark/, 'and it has a dark version');
  assert.ok(!/2026-10-10/.test(html.replace(/<title>[\s\S]*?<\/title>/, '')), 'no codes in the body');
});

test('a notice with no layout of its own still gets the design', () => {
  const { html } = renderMail({
    notice: { title: 'Something happened', body: 'Line one\nLine two', level: 'warn', link: '#/x' },
    propertyName: 'Somewhere Nice',
    siteUrl: 'https://staff.niceoperation.com',
  });
  assert.match(html, />Heads-up</);
  assert.match(html, /Something happened/);
  assert.match(html, /Line one<br>Line two/);
  assert.match(html, />Open in HIVE</);
});

test('nothing anybody typed reaches the mail as markup', () => {
  const { html } = renderMail({
    notice: {
      title: 'x',
      mail: { headline: '<b>x</b>', quote: { by: 'Kofi says', text: '<script>alert(1)</script>' }, note: 'a & b' },
    },
    propertyName: 'Somewhere <Nice>',
  });
  assert.ok(!html.includes('<script>alert'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a &amp; b/);
  assert.match(html, /Somewhere &lt;Nice&gt;/);
});

test('with no site address there is no button to nowhere', () => {
  const { html } = renderMail({ notice: { title: 'x', link: '#/y', mail: { button: 'Go' } }, propertyName: 'P' });
  assert.ok(!html.includes('>Go<'));
});

test('dates and times read as somebody would say them', () => {
  assert.equal(sayDate('2026-10-10'), 'Saturday 10 October');
  assert.equal(sayShortDate('2026-10-10'), 'Sat 10 Oct');
  assert.equal(sayRange('2026-10-12', '2026-10-18'), 'Monday 12 to Sunday 18 October');
  assert.equal(sayRange('2026-10-30', '2026-11-02'), 'Fri 30 Oct to Mon 2 Nov');
  assert.equal(sayTime('06:00'), '6:00 am');
  assert.equal(sayTime('14:30'), '2:30 pm');
  assert.equal(sayTime('00:15'), '12:15 am');
  assert.equal(sayHours('06:00', '14:00'), '6 am to 2 pm');
  assert.equal(sayMonth('2026-10'), 'October 2026');
});

test('the daily summary and the invitation are in the same clothes', () => {
  const digest = renderDigest({
    day: '2026-10-09', propertyName: 'Somewhere Nice', siteUrl: 'https://staff.niceoperation.com',
    open: 1, absent: 0, escalated: [], rows: [{ name: 'Esi', status: 'missing_out', resolution: 'open' }],
  });
  assert.match(digest.html, /Friday 9 October at a glance/);
  assert.match(digest.html, /background:#f2a93b/);

  const invite = renderJoinInvite({
    propertyName: 'Somewhere Nice', name: 'Ama Nyarko', url: 'https://staff.example/j/abc', days: 3,
    ways: ['pin', 'password'], siteUrl: 'https://staff.example',
  });
  assert.match(invite.html, /href="https:\/\/staff\.example\/j\/abc"/, 'an absolute link is used as it is');
  assert.ok(!invite.html.includes('#/notifications'), 'nobody being invited can change a setting');
});

// ---------------------------------------------------------------------------
// The standing copy
// ---------------------------------------------------------------------------

test('the standing copy is on the first message only, and never somebody already on it', async () => {
  const mail = catching();
  try {
    await sendEmail({
      apiKey: 'k', from: 'HIVE <h@x.test>', to: ['a@x.test', 'b@x.test', 'boss@x.test'],
      cc: ['boss@x.test', 'owner@x.test'], subject: 's', html: '<p>x</p>',
    });
  } finally { mail.restore(); }
  const each = messagesIn(mail.sent[0]);
  assert.deepEqual(each[0].cc, ['owner@x.test'], 'boss is already a recipient');
  assert.equal(each[1].cc, undefined);
  assert.equal(each[2].cc, undefined);
});

test('the property is set up to copy michael on every notification email', async () => {
  const { db, raw } = setup(3);
  assert.deepEqual(ccFor({ email_cc: raw.prepare("SELECT value FROM settings WHERE key = 'email_cc'").get().value }),
    ['michael@hostelaccra.com']);

  const mail = catching();
  try {
    await createNotice(db, {
      kind: 'test.kind', title: 'Rota published', body: 'Out now.', audience: null,
      mail: { status: 'Rota', tone: 'info', headline: 'The rota is out' },
    }, { env: { RESEND_API_KEY: 'k' } });
  } finally { mail.restore(); }

  const each = mail.sent.flatMap(messagesIn);
  assert.equal(each.length, 3, 'one message per person, as before');
  assert.deepEqual(each[0].cc, ['michael@hostelaccra.com']);
  assert.equal(each.filter((m) => m.cc).length, 1, 'and one copy, not three');
  assert.match(each[0].html, /The rota is out/);
});
