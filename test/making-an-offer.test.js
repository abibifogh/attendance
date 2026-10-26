import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { getPepper, hashPin } from '../src/lib/auth.js';
import { addCandidate, candidate, createRole, hire } from '../src/routes/recruitment.js';
import {
  makeOffer, offerAccept, offerCode, offerDecline, offerHead, offerOpen, offerSetup, previewOffer, readOffer,
  resendOffer, watchOffers, withdrawOffer,
} from '../src/routes/offers.js';

/**
 * A job offer with the contract to read and sign, before anybody is on the
 * books: made by the office, read and signed (or declined) on the candidate's
 * phone, and carried onto their staff record when they are taken on.
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

const ENV = { RESEND_API_KEY: 'k', SESSION_SECRET: 'test-secret' };
const INK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const TEMPLATE = `CONTRACT OF EMPLOYMENT
Between {{company_legal_name}} and {{name}} of {{address}}, employee number {{employee_no}}.
1. You are employed as {{job_title}} in {{department}} from {{start_date}}.
2. Probation: {{probation}}. Notice: {{notice}}.
3. Remuneration: {{salary}}.`;

async function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec(`DELETE FROM att_staff; DELETE FROM users; DELETE FROM app_notices;
            DELETE FROM rec_role; DELETE FROM rec_candidate; DELETE FROM rec_event; DELETE FROM hr_template;`);
  const set = (k, v) => raw.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(k, v);
  set('timezone', 'UTC');
  set('email_from', 'hive@example.com');
  set('property_name', 'Somewhere Nice');
  set('company_legal_name', 'Example Hotels Ltd');
  raw.prepare("INSERT INTO hr_template (id, name, kind, body, active, satisfies) VALUES (7, 'Contract of employment', 'contract', ?, 1, 'contract')").run(TEMPLATE);
  const db = d1(raw);
  raw.prepare("INSERT INTO users (id, name, role, pin_hash, active) VALUES (1, 'Efua', 'admin', ?, 1)")
    .run(await hashPin('246810', await getPepper(db)));
  const mails = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('resend')) mails.push(JSON.parse(init.body));
    return new Response('{"id":"x"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { raw, db, mails, restore: () => { globalThis.fetch = real; } };
}

const OFFICE = { user: { id: 1, name: 'Efua', role: 'admin' }, permissions: ['rec_view', 'rec_manage', 'att_setup', 'hr_manage'] };
const ctx = (db, body = null, session = OFFICE) => ({
  db,
  env: ENV,
  url: new URL('https://staff.example.com/api/rec'),
  session,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '5.6.7.8', 'User-Agent': 'Phone' },
    body: JSON.stringify(body ?? {}),
  }),
});
const pub = (db, body = null) => ({ ...ctx(db, body), session: null });
const body = async (res) => JSON.parse(await res.text());
const later = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const TERMS = {
  templateId: 7, jobTitle: 'Front desk agent', department: 'Front office', startDate: later(14),
  values: { salary: 'GH₵ [test amount] a month', probation: 'three months', notice: 'one month' },
  message: 'We would love you to join the front office team.', days: 7, sendBy: 'email',
};

async function aCandidate(db, { email = 'ama@example.com', phone = null } = {}) {
  const role = (await body(await createRole(ctx(db, { title: 'Front desk agent', department: 'Front office' })))).id;
  return body(await addCandidate(ctx(db, { name: 'Ama Owusu', roleId: role, email, phone })));
}

async function offered(t, extra = {}) {
  const person = await aCandidate(t.db, extra.who);
  const out = await body(await makeOffer(ctx(t.db, { ...TERMS, ...extra.terms }), person.id));
  const offer = t.raw.prepare('SELECT * FROM rec_offer WHERE id = ?').get(out.id);
  const mail = t.mails.find((m) => /job offer/i.test(m.subject));
  const token = (mail?.html.match(/\/o\/([0-9a-f]{48})/) ?? [])[1] ?? (out.url ?? '').split('/o/')[1];
  return { person, out, offer, token };
}

async function signWithCode(t, token, name = 'Ama Owusu') {
  await offerOpen(pub(t.db), token);
  await offerCode(pub(t.db), token);
  const codeMail = t.mails.at(-1);
  const code = codeMail.subject.slice(0, 6);
  return offerAccept(pub(t.db, { agreed: true, name, ink: INK, otp: code }), token);
}

test('the offer form knows the templates, what each asks for, and how the candidate can be reached', async () => {
  const t = await setup();
  try {
    const person = await aCandidate(t.db);
    const setupOut = await body(await offerSetup(ctx(t.db), person.id));
    assert.equal(setupOut.templates.length, 1);
    assert.ok(setupOut.templates[0].uses.includes('salary'));
    assert.ok(setupOut.templates[0].uses.includes('address'));
    assert.equal(setupOut.defaults.jobTitle, 'Front desk agent');
    assert.equal(setupOut.defaults.sendBy, 'email');
    assert.equal(setupOut.reach.email, true);

    const preview = await body(await previewOffer(ctx(t.db, TERMS), person.id));
    assert.match(preview.body, /Between Example Hotels Ltd and Ama Owusu of the address given on joining/);
    assert.match(preview.body, /employee number to be given on joining/);
    assert.match(preview.body, /employed as Front desk agent in Front office/);
    assert.match(preview.body, /Probation: three months/);
    assert.equal(t.raw.prepare('SELECT COUNT(*) n FROM rec_offer').get().n, 0, 'a preview sends nothing');
  } finally { t.restore(); }
});

test('making an offer fixes the words, moves them to Offered and emails them their own link', async () => {
  const t = await setup();
  try {
    const { person, offer, token, out } = await offered(t);
    assert.equal(out.delivered.sent, true);
    assert.equal(offer.status, 'sent');
    assert.match(offer.body, /Remuneration: GH₵ \[test amount\] a month/);
    assert.equal(offer.body_hash.length, 64);
    assert.ok(offer.token_box, 'the link is kept sealed for reminders');
    assert.ok(token, 'the email carries the link');
    assert.equal(t.raw.prepare('SELECT stage FROM rec_candidate WHERE id = ?').get(person.id).stage, 'offer');

    const mail = t.mails.find((m) => /job offer/i.test(m.subject));
    assert.deepEqual(mail.to, ['ama@example.com']);
    assert.match(mail.subject, /A job offer from Somewhere Nice: Front desk agent/);
    assert.match(mail.html, /We would like to offer you the job, Ama/);
    assert.match(mail.html, /We would love you to join the front office team/);
    assert.match(mail.html, /Read the offer and contract/);
    assert.doesNotMatch(mail.html, /\b(he|she|his|her)\b/i);

    const page = await body(await candidate(ctx(t.db), person.id));
    assert.equal(page.offers.length, 1);
    assert.equal(page.offers[0].state, 'sent');
  } finally { t.restore(); }
});

test('without email set up, the office is handed the link and a message to send', async () => {
  const t = await setup();
  try {
    t.raw.prepare("DELETE FROM settings WHERE key = 'email_from'").run();
    const { out } = await offered(t);
    assert.equal(out.delivered.sent, false);
    assert.match(out.url, /^https:\/\/[\w.-]+\/o\/[0-9a-f]{48}$/);
    assert.match(out.message, /^Hello Ama, Somewhere Nice would like to offer you the job of Front desk agent/);
  } finally { t.restore(); }
});

test('the candidate reads the offer and the contract, and nothing else about themselves', async () => {
  const t = await setup();
  try {
    const { token, person } = await offered(t);
    const head = await body(await offerHead(pub(t.db), token));
    assert.deepEqual(head, { property: 'Somewhere Nice', state: 'sent' });
    const page = await body(await offerOpen(pub(t.db), token));
    assert.equal(page.jobTitle, 'Front desk agent');
    assert.equal(page.from, 'Efua', 'the role is not shown');
    assert.ok(page.terms.some(([k, v]) => k === 'Pay' && /test amount/.test(v)));
    assert.match(page.body, /CONTRACT OF EMPLOYMENT/);
    assert.equal(page.signCode.required, true);
    assert.match(page.signCode.hint, /^a•+@example\.com$/);
    assert.equal(page.scores, undefined);
    assert.equal(page.note, undefined);
    const opened = t.raw.prepare("SELECT * FROM rec_event WHERE kind = 'offer_opened' AND candidate_id = ?").get(person.id);
    assert.ok(opened, 'opening it is on the trail');
    assert.equal(opened.ip, '5.6.7.8');
  } finally { t.restore(); }
});

test('accepting is signing: a code first, then the signature against the fixed words', async () => {
  const t = await setup();
  try {
    const { token, person } = await offered(t);
    await assert.rejects(
      offerAccept(pub(t.db, { agreed: true, name: 'Ama Owusu', ink: INK }), token),
      /six-digit code/,
    );
    await offerCode(pub(t.db), token);
    const codeMail = t.mails.at(-1);
    assert.match(codeMail.subject, /^\d{6} is your code to sign$/);
    assert.equal(codeMail.cc, undefined, 'a signing code is never copied to anybody');
    await assert.rejects(
      offerAccept(pub(t.db, { agreed: true, name: 'Ama Owusu', ink: INK, otp: '000000' === codeMail.subject.slice(0, 6) ? '111111' : '000000' }), token),
      /not right/,
    );
    await assert.rejects(
      offerAccept(pub(t.db, { agreed: true, name: 'Ama Owusu', ink: INK, otp: codeMail.subject.slice(0, 6), hash: 'f'.repeat(64) }), token),
      /changed since it was sent/,
    );
    const ok = await body(await offerAccept(pub(t.db, { agreed: true, name: 'Ama Owusu', ink: INK, otp: codeMail.subject.slice(0, 6) }), token));
    assert.equal(ok.ok, true);

    const offer = t.raw.prepare('SELECT * FROM rec_offer').get();
    assert.equal(offer.status, 'accepted');
    assert.equal(offer.signer_check, 'email code');
    assert.equal(offer.signature_ink, INK);
    assert.equal(offer.signer_ip, '5.6.7.8');
    assert.equal(t.raw.prepare('SELECT staff_id FROM rec_candidate WHERE id = ?').get(person.id).staff_id, null,
      'nobody is on the books yet');

    const told = t.raw.prepare("SELECT * FROM app_notices WHERE kind = 'recruitment.offer_answer'").get();
    assert.match(told.title, /Ama Owusu accepted the offer/);
    assert.equal(told.audience, 'rec_manage');

    await assert.rejects(signWithCode(t, token), /already accepted/);
    const page = await body(await offerOpen(pub(t.db), token));
    assert.equal(page.state, 'accepted', 'the link keeps working to read it again');
  } finally { t.restore(); }
});

test('declining records the reason, moves them to "They said no" and tells the office', async () => {
  const t = await setup();
  try {
    const { token, person } = await offered(t);
    await offerDecline(pub(t.db, { reason: 'other_job', note: 'Thank you for the chance.' }), token);
    const offer = t.raw.prepare('SELECT * FROM rec_offer').get();
    assert.equal(offer.status, 'declined');
    assert.equal(offer.decline_reason, 'other_job');
    const row = t.raw.prepare('SELECT stage, outcome FROM rec_candidate WHERE id = ?').get(person.id);
    assert.equal(row.stage, 'declined');
    assert.match(row.outcome, /I have taken another job: Thank you for the chance\./);
    const told = t.raw.prepare("SELECT * FROM app_notices WHERE kind = 'recruitment.offer_answer'").get();
    assert.match(told.title, /declined the offer/);
    assert.equal((await body(await offerHead(pub(t.db), token))).state, 'declined');
    await assert.rejects(signWithCode(t, token), /already declined/);
  } finally { t.restore(); }
});

test('a withdrawn offer stops working, and a new offer withdraws the one still waiting', async () => {
  const t = await setup();
  try {
    const { token, offer, person } = await offered(t);
    const second = await body(await makeOffer(ctx(t.db, { ...TERMS, values: { ...TERMS.values, salary: 'GH₵ [another amount]' } }), person.id));
    assert.equal(t.raw.prepare('SELECT status FROM rec_offer WHERE id = ?').get(offer.id).status, 'withdrawn');
    await assert.rejects(offerOpen(pub(t.db), token), /no longer open/);
    await withdrawOffer(ctx(t.db, { note: 'Role filled' }), second.id);
    assert.equal(t.raw.prepare('SELECT status FROM rec_offer WHERE id = ?').get(second.id).status, 'withdrawn');
    await assert.rejects(withdrawOffer(ctx(t.db), second.id), /still waiting/);
  } finally { t.restore(); }
});

test('an offer past its date cannot be accepted, and sending it again opens it for more days', async () => {
  const t = await setup();
  try {
    const { token, offer } = await offered(t);
    t.raw.prepare("UPDATE rec_offer SET expires_at = datetime('now', '-1 hour') WHERE id = ?").run(offer.id);
    await assert.rejects(offerCode(pub(t.db), token), /was open until/);
    const page = await body(await offerOpen(pub(t.db), token));
    assert.equal(page.state, 'expired');

    const again = await body(await resendOffer(ctx(t.db, { days: 3, sendBy: 'email' }), offer.id));
    assert.equal(again.delivered.sent, true);
    assert.match(t.mails.at(-1).subject, /is open until/);
    assert.equal((await body(await offerHead(pub(t.db), token))).state, 'sent');
  } finally { t.restore(); }
});

test('two days before it runs out, the candidate is reminded once', async () => {
  const t = await setup();
  try {
    const { offer } = await offered(t);
    t.raw.prepare("UPDATE rec_offer SET created_at = datetime('now', '-5 days'), expires_at = datetime('now', '+1 day') WHERE id = ?").run(offer.id);
    const sent = t.mails.length;
    // Nine in the morning to eight at night only; run it at whichever hour the test runs in a zone where it is midday.
    const zone = ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Tokyo', 'America/New_York', 'Europe/Berlin', 'Asia/Kolkata', 'America/Los_Angeles']
      .find((z) => { const hr = Number(new Intl.DateTimeFormat('en-GB', { timeZone: z, hour: '2-digit', hour12: false }).format(new Date())); return hr >= 9 && hr < 20; });
    const first = await watchOffers(t.db, { timezone: zone, ctx: { env: ENV } });
    assert.equal(first.reminded, 1);
    assert.equal(t.mails.length, sent + 1);
    assert.match(t.mails.at(-1).subject, /Your job offer from Somewhere Nice is open until/);
    const second = await watchOffers(t.db, { timezone: zone, ctx: { env: ENV } });
    assert.equal(second.reminded, 0);
  } finally { t.restore(); }
});

test('taking them on carries the signed contract across, countersigns it with a PIN and emails their copy', async () => {
  const t = await setup();
  try {
    const { token, person, offer } = await offered(t);
    await signWithCode(t, token);

    await assert.rejects(
      hire(ctx(t.db, { employeeNo: 'T100', countersign: true, signAs: 'Efua', pin: '000000', sendLink: false, login: false }), person.id),
      /PIN is not right/,
    );
    assert.equal(t.raw.prepare('SELECT COUNT(*) n FROM att_staff').get().n, 0, 'a wrong PIN puts nobody on the books');

    const out = await body(await hire(ctx(t.db, {
      employeeNo: 'T100', countersign: true, signAs: 'Efua', ink: INK, pin: '246810', sendLink: false, login: false,
    }), person.id));
    assert.equal(out.contract.countersigned, true);
    assert.equal(out.contract.copySent, true);
    assert.equal(out.hiredOn, offer.start_date, 'the start date comes from the offer');

    const staff = t.raw.prepare('SELECT * FROM att_staff WHERE id = ?').get(out.staffId);
    assert.equal(staff.job_title, 'Front desk agent');
    assert.equal(staff.department, 'Front office');

    const contract = t.raw.prepare('SELECT * FROM hr_contract WHERE id = ?').get(out.contract.contractId);
    assert.equal(contract.staff_id, out.staffId);
    assert.equal(contract.status, 'signed');
    assert.equal(contract.body, offer.body);
    assert.equal(contract.body_hash, offer.body_hash);
    assert.equal(contract.signer_check, 'email code');
    assert.equal(contract.employer_name, 'Efua');
    assert.ok(contract.final_hash, 'the signed PDF is made');
    assert.equal(t.raw.prepare('SELECT contract_id FROM rec_offer WHERE id = ?').get(offer.id).contract_id, contract.id);

    const kinds = t.raw.prepare('SELECT kind FROM hr_event WHERE contract_id = ? ORDER BY id').all(contract.id).map((e) => e.kind);
    for (const k of ['offer_made', 'offer_sent', 'offer_opened', 'code_sent', 'signed', 'countersigned']) {
      assert.ok(kinds.includes(k), `${k} is on the contract's trail`);
    }

    const copy = t.mails.find((m) => /Your signed contract with Somewhere Nice/.test(m.subject));
    assert.ok(copy, 'their copy was emailed');
    assert.match(copy.attachments[0].filename, /\.pdf$/);
  } finally { t.restore(); }
});

test('taking them on without countersigning leaves the signed contract waiting for the property', async () => {
  const t = await setup();
  try {
    const { token, person } = await offered(t);
    await signWithCode(t, token);
    const out = await body(await hire(ctx(t.db, { employeeNo: 'T101', sendLink: false, login: false }), person.id));
    const contract = t.raw.prepare('SELECT * FROM hr_contract WHERE id = ?').get(out.contract.contractId);
    assert.equal(contract.status, 'signed');
    assert.equal(contract.employer_at, null);
    await assert.rejects(
      makeOffer(ctx(t.db, TERMS), person.id),
      /already on the books/,
    );
  } finally { t.restore(); }
});

test('the office reads the offer back with its trail', async () => {
  const t = await setup();
  try {
    const { offer, token } = await offered(t);
    await signWithCode(t, token);
    const read = await body(await readOffer(ctx(t.db), offer.id));
    assert.equal(read.offer.intact, true);
    assert.equal(read.offer.signerName, 'Ama Owusu');
    assert.deepEqual(read.events.map((e) => e.kind), ['offer_made', 'offer_sent', 'offer_opened', 'offer_code', 'offer_accepted']);
  } finally { t.restore(); }
});

test('an offer on one company’s template names that company and takes them on to its books', async () => {
  const t = await setup();
  try {
    t.raw.prepare("INSERT INTO company (id, main, legal_name) VALUES (5, 0, 'Second Example Ltd') ON CONFLICT (id) DO UPDATE SET legal_name = excluded.legal_name").run();
    t.raw.prepare('UPDATE hr_template SET company_id = 5 WHERE id = 7').run();
    const setupOut = await body(await offerSetup(ctx(t.db), (await aCandidate(t.db)).id));
    assert.equal(setupOut.templates[0].companyId, 5);
    const { token, person, offer } = await offered(t);
    assert.match(offer.body, /^CONTRACT OF EMPLOYMENT\nBetween Second Example Ltd and Ama Owusu/);
    assert.equal(offer.company_id, 5);
    await signWithCode(t, token);
    const out = await body(await hire(ctx(t.db, { employeeNo: 'T200', sendLink: false, login: false }), person.id));
    assert.equal(t.raw.prepare('SELECT company_id FROM att_staff WHERE id = ?').get(out.staffId).company_id, 5);
  } finally { t.restore(); }
});

test('the offer page carries the contract’s cover, from the company making the offer', async () => {
  const t = await setup();
  try {
    const { token } = await offered(t);
    const page = await body(await offerOpen(pub(t.db), token));
    assert.equal(page.cover.companyName, 'Example Hotels Ltd');
    assert.match(page.cover.sentence, /^made between Example Hotels Ltd and Ama Owusu, who would be employed as Front desk agent in the Front office department from /);
    assert.equal(page.cover.logoUrl, null);
    const { offerLogo } = await import('../src/routes/offers.js');
    await assert.rejects(offerLogo(pub(t.db), token), /No logo/);
  } finally { t.restore(); }
});
