import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  createInvite, decideDocument, getForm, getPerson, listWaitingDocuments, saveForm,
} from '../src/routes/people.js';
import {
  inviteDetails, inviteFile, inviteFileRemove, inviteOpen,
} from '../src/routes/invite.js';
import { askFor, formPlan, planFor, unanswered } from '../src/lib/people.js';

/**
 * Choosing what to ask for, and letting people attach the paper.
 *
 * Two features that only make sense together. A property that can decide it
 * wants a Ghana Card photograph has to have somewhere for the photograph to
 * arrive, and a photograph arriving from a phone has to obey the same rule as
 * every other thing that arrives from a phone: it is a claim until somebody
 * has looked at it.
 */

function d1(db) {
  const statement = (sql, binds = []) => ({
    bind(...a) { return statement(sql, a); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() {
      const r = db.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(r.changes ?? 0) } };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; },
  };
}

const OFFICE = {
  user: { id: 1, name: 'Ama', role: 'manager' },
  permissions: ['att_view', 'hr_view', 'hr_manage'],
};

function ctx(db, { body = null, session = OFFICE } = {}) {
  const url = new URL('https://staff.example.test/api/hr/x');
  return {
    db,
    env: {},
    url,
    session,
    executionContext: null,
    request: new Request(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        'CF-Connecting-IP': '154.160.4.2',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13)',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  };
}

const phone = (db, body) => ctx(db, { body: body ?? {}, session: null });
const read = async (response) => response.json();

async function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync('migrations').filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${f}`, 'utf8'));
  }
  raw.exec('DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;');
  raw.exec('DELETE FROM att_staff');
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, job_title, hired_on)
     VALUES (1, '1001', 'Angela Asare Ayima', 'Housekeeping', 'Housekeeper', '2026-09-01'),
            (2, '1002', 'Yaw Boateng', 'Kitchen', 'Cook', '2025-02-01')`,
  ).run();
  return { raw, db: d1(raw) };
}

/** A link, and the packet the phone sees when it opens it. */
async function link(db, staffId = 1) {
  const made = await read(await createInvite(ctx(db, { body: { wantsDetails: true } }), String(staffId)));
  const token = made.url.split('/').pop();
  return { token, packet: await read(await inviteOpen(phone(db), token)) };
}

// A one-pixel PNG, which is a real image and small enough to keep in a test.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'
  + 'YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

test('with nothing set, the form is the standard set and everything is optional', async () => {
  const { db } = await setup();
  const form = await read(await getForm(ctx(db)));

  assert.deepEqual(form.plan, { fields: {}, lists: {}, documents: {} });
  assert.ok(form.sections.length);
  assert.ok(form.sections.every((s) => s.fields.every((f) => f.ask === 'ask')));
  assert.ok(form.documents.some((d) => d.code === 'ghana_card'));
  assert.ok(!form.documents.some((d) => d.code === 'contract'),
    'the property signs a contract; nobody photographs one and sends it in');
});

test('the plan keeps only what was changed', async () => {
  const { raw, db } = await setup();

  await saveForm(ctx(db, {
    body: {
      plan: {
        fields: { momo_number: 'skip', date_of_birth: 'require', personal_phone: 'ask' },
        lists: { employment: 'skip' },
        documents: { ghana_card: 'require' },
        // Not a field, not a list, not a document.
        nonsense: { made_up: 'require' },
      },
    },
  }));

  const stored = JSON.parse(raw.prepare("SELECT value FROM settings WHERE key = 'hr_form'").get().value);
  assert.deepEqual(stored, {
    fields: { momo_number: 'skip', date_of_birth: 'require' },
    lists: { employment: 'skip' },
    documents: { ghana_card: 'require' },
  }, 'the one left at "ask" is not written down, and neither is the invention');
});

test('a field added to the code later is asked for, not silently dropped', () => {
  // The whole reason the plan is stored sparsely. A plan that listed every
  // field would freeze the form at the moment somebody pressed Save.
  const plan = planFor(JSON.stringify({ fields: { momo_number: 'skip' } }));
  assert.equal(askFor(plan, 'fields', 'momo_number'), 'skip');
  assert.equal(askFor(plan, 'fields', 'a_field_invented_next_year'), 'ask');
});

test('a plan nobody can read falls back to asking for the standard set', () => {
  assert.deepEqual(planFor('{not json'), { fields: {}, lists: {}, documents: {} });
  assert.deepEqual(planFor(null), { fields: {}, lists: {}, documents: {} });
  assert.deepEqual(planFor('{"fields":{"x":"nonsense"}}').fields, {},
    'and an answer that is not one of the three is not an answer');
});

// ---------------------------------------------------------------------------
// What the phone is shown
// ---------------------------------------------------------------------------

test('the form on the phone is the one the property asked for', async () => {
  const { db } = await setup();
  await saveForm(ctx(db, {
    body: {
      plan: {
        fields: { momo_number: 'skip', momo_network: 'skip', date_of_birth: 'require' },
        lists: { employment: 'skip' },
        documents: { reference: 'skip', ghana_card: 'require' },
      },
    },
  }));

  const { packet } = await link(db);
  const fields = packet.sections.flatMap((s) => s.fields.map((f) => f.key));

  assert.ok(!fields.includes('momo_number'), 'a field this property does not want is not shown');
  assert.ok(fields.includes('personal_phone'));
  assert.equal(fields.filter((k) => k === 'date_of_birth').length, 1);
  assert.equal(packet.sections.flatMap((s) => s.fields).find((f) => f.key === 'date_of_birth').ask, 'require');

  assert.deepEqual(packet.lists.map((l) => l.key), ['contacts', 'education']);
  assert.ok(!packet.files.some((f) => f.code === 'reference'));
  assert.equal(packet.files.find((f) => f.code === 'ghana_card').ask, 'require');
});

test('who a person is decides which paper they are asked for', async () => {
  const { db } = await setup();

  const housekeeper = await link(db, 1);
  assert.ok(!housekeeper.packet.files.some((f) => f.code === 'food_health'));

  const cook = await link(db, 2);
  assert.ok(cook.packet.files.some((f) => f.code === 'food_health'),
    'Act 851 applies to whoever handles the food, and the record already says who that is');
});

// ---------------------------------------------------------------------------
// Sending the paper in
// ---------------------------------------------------------------------------

test('a photograph sent from a phone waits rather than going on the record', async () => {
  const { raw, db } = await setup();
  const { token } = await link(db);

  const out = await read(await inviteFile(
    phone(db, { kind: 'ghana_card', filename: 'card.png', mime: 'image/png', content: PNG }),
    token,
  ));
  assert.equal(out.ok, true);

  const row = raw.prepare('SELECT * FROM hr_document WHERE id = ?').get(out.id);
  assert.equal(row.status, 'pending', 'a claim, not a record');
  assert.equal(row.source, 'self');
  assert.equal(row.kind, 'ghana_card');
  assert.equal(row.title, 'Ghana Card or passport');
  assert.ok(row.invite_id);
  assert.match(row.uploaded_by, /Angela/);

  // And it is not on the file the office reads as complete.
  const person = await read(await getPerson(ctx(db), 1));
  assert.ok(!person.documents.some((d) => d.id === out.id),
    'nothing reaches the record until somebody has looked at it');
});

test('the office accepts it onto the record, or sends it back', async () => {
  const { raw, db } = await setup();
  const { token } = await link(db);

  const first = await read(await inviteFile(
    phone(db, { kind: 'ghana_card', filename: 'card.png', mime: 'image/png', content: PNG }),
    token,
  ));
  const second = await read(await inviteFile(
    phone(db, { kind: 'education', filename: 'wassce.png', mime: 'image/png', content: PNG }),
    token,
  ));

  const waiting = await read(await listWaitingDocuments(ctx(db)));
  assert.equal(waiting.documents.length, 2);
  assert.equal(waiting.documents[0].staff_name, 'Angela Asare Ayima');

  await decideDocument(ctx(db, { body: { decision: 'accept' } }), String(first.id));
  await decideDocument(
    ctx(db, { body: { decision: 'reject', note: 'That is the back of the card — send the front' } }),
    String(second.id),
  );

  assert.equal(raw.prepare('SELECT status FROM hr_document WHERE id = ?').get(first.id).status, 'filed');
  const sent_back = raw.prepare('SELECT * FROM hr_document WHERE id = ?').get(second.id);
  assert.equal(sent_back.status, 'rejected');
  assert.match(sent_back.note, /back of the card/);
  assert.equal(sent_back.decided_by, 'Ama (manager)');

  const person = await read(await getPerson(ctx(db), 1));
  assert.ok(person.documents.some((d) => d.id === first.id), 'the accepted one is on the file');
});

test('sending it back needs a reason', async () => {
  const { db } = await setup();
  const { token } = await link(db);
  const doc = await read(await inviteFile(
    phone(db, { kind: 'photo', filename: 'me.png', mime: 'image/png', content: PNG }), token,
  ));

  await assert.rejects(
    () => decideDocument(ctx(db, { body: { decision: 'reject' } }), String(doc.id)),
    /Say why/,
  );
});

test('a second photograph of the same thing replaces the first', async () => {
  // Somebody retaking a blurred picture is not sending two cards, and leaving
  // both would have the office choosing between identical-looking files.
  const { raw, db } = await setup();
  const { token } = await link(db);

  await inviteFile(phone(db, { kind: 'photo', filename: 'a.png', mime: 'image/png', content: PNG }), token);
  await inviteFile(phone(db, { kind: 'photo', filename: 'b.png', mime: 'image/png', content: PNG }), token);

  const rows = raw.prepare("SELECT * FROM hr_document WHERE kind = 'photo'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].filename, 'b.png');
});

test('they can take one back off before anybody has looked at it, and not after', async () => {
  const { db } = await setup();
  const { token } = await link(db);
  const doc = await read(await inviteFile(
    phone(db, { kind: 'photo', filename: 'me.png', mime: 'image/png', content: PNG }), token,
  ));

  await inviteFileRemove(phone(db), token, String(doc.id));
  const gone = await read(await inviteOpen(phone(db), token));
  assert.equal(gone.files.find((f) => f.code === 'photo').attached.length, 0);

  const again = await read(await inviteFile(
    phone(db, { kind: 'photo', filename: 'me.png', mime: 'image/png', content: PNG }), token,
  ));
  await decideDocument(ctx(db, { body: { decision: 'accept' } }), String(again.id));
  await assert.rejects(
    () => inviteFileRemove(phone(db), token, String(again.id)),
    /already been looked at/,
  );
});

test('only what the link asks for can be attached to it', async () => {
  const { db } = await setup();
  await saveForm(ctx(db, { body: { plan: { documents: { photo: 'skip' } } } }));
  const { token } = await link(db);

  await assert.rejects(
    () => inviteFile(phone(db, { kind: 'photo', filename: 'x.png', mime: 'image/png', content: PNG }), token),
    /not something this link is asking for/,
  );
  await assert.rejects(
    () => inviteFile(phone(db, { kind: 'contract', filename: 'x.png', mime: 'image/png', content: PNG }), token),
    /not something this link is asking for/,
    'and a contract is the property’s own document, never a photograph from the person it binds',
  );
});

test('a spreadsheet is not a photograph or a PDF', async () => {
  const { db } = await setup();
  const { token } = await link(db);
  await assert.rejects(
    () => inviteFile(
      phone(db, { kind: 'photo', filename: 'x.xlsx', mime: 'application/vnd.ms-excel', content: PNG }),
      token,
    ),
    /photograph or a PDF/,
  );
});

// ---------------------------------------------------------------------------
// Insisting
// ---------------------------------------------------------------------------

test('a form will not send without what the property insisted on', async () => {
  const { db } = await setup();
  await saveForm(ctx(db, {
    body: { plan: { fields: { personal_phone: 'require' }, documents: { ghana_card: 'require' } } },
  }));
  const { token } = await link(db);

  await assert.rejects(
    () => inviteDetails(phone(db, { profile: { town: 'Kokrobite' } }), token),
    /Still needed: mobile, ghana card or passport/i,
  );

  await inviteFile(phone(db, { kind: 'ghana_card', filename: 'c.png', mime: 'image/png', content: PNG }), token);
  const done = await read(await inviteDetails(
    phone(db, { profile: { town: 'Kokrobite', personal_phone: '0241234567' } }), token,
  ));
  assert.equal(done.ok, true);
});

test('what the office already holds counts as answered', async () => {
  // The page never reads a record back, so a second link would otherwise make
  // somebody retype an address the office has had since their first week.
  const { raw, db } = await setup();
  raw.prepare("INSERT INTO hr_profile (staff_id, personal_phone) VALUES (1, '0241234567')").run();

  await saveForm(ctx(db, { body: { plan: { fields: { personal_phone: 'require' } } } }));
  const { token } = await link(db);

  const done = await read(await inviteDetails(phone(db, { profile: { town: 'Kokrobite' } }), token));
  assert.equal(done.ok, true);
});

test('a field the property does not ask for is refused, not filed', async () => {
  const { db } = await setup();
  await saveForm(ctx(db, { body: { plan: { fields: { medical_notes: 'skip' } } } }));
  const { token } = await link(db);

  await inviteDetails(phone(db, {
    profile: { town: 'Kokrobite', medical_notes: 'Nothing this property asked for' },
  }), token);

  const pending = await read(await getPerson(ctx(db), 1));
  const payload = JSON.parse(pending.submissions?.[0]?.payload ?? '{}');
  assert.ok(!('medical_notes' in (payload.profile ?? {})),
    'the form not showing it is a courtesy; dropping it here is the gate');
});

// ---------------------------------------------------------------------------
// The rule, on its own
// ---------------------------------------------------------------------------

test('nothing is missing that is either sent or already on file', () => {
  const plan = planFor({
    fields: { personal_phone: 'require' },
    lists: { contacts: 'require' },
    documents: { ghana_card: 'require' },
  });
  const files = [{ code: 'ghana_card', ask: 'require', attached: [] }];

  assert.deepEqual(
    unanswered(plan, { profile: {}, lists: {}, files }).map((g) => g.key),
    ['personal_phone', 'contacts', 'ghana_card'],
  );

  assert.deepEqual(
    unanswered(plan, {
      profile: { personal_phone: '024' },
      lists: { contacts: [{ name: 'Ama' }] },
      files: [{ code: 'ghana_card', ask: 'require', attached: [{ id: 1 }] }],
    }),
    [],
  );

  assert.deepEqual(
    unanswered(plan, { profile: {}, lists: {}, files }, {
      profile: { personal_phone: '024' },
      lists: { contacts: [{}] },
      documents: ['ghana_card'],
    }),
    [],
    'already on file is answered',
  );
});

test('the resolved form is the same one on both sides of the link', () => {
  // One function, so the screen an administrator sets this up on cannot drift
  // from the form somebody fills in on their phone.
  const plan = planFor({ fields: { town: 'skip' }, documents: { photo: 'require' } });
  const form = formPlan(plan, {
    documents: [
      { code: 'photo', label: 'Passport photograph', self: true },
      { code: 'contract', label: 'Signed contract', self: false },
    ],
  });

  assert.ok(!form.sections.flatMap((s) => s.fields).some((f) => f.key === 'town'));
  assert.deepEqual(form.files, [{ code: 'photo', label: 'Passport photograph', detail: null, ask: 'require' }]);
});

// ---------------------------------------------------------------------------
// Through the router, as a phone actually reaches it
// ---------------------------------------------------------------------------

test('the whole loop works through the routes, not just the handlers', async () => {
  // A route table entry naming a handler that does not exist throws at request
  // time and never at test time, so the handlers above prove the logic and
  // this proves the wiring.
  const { default: worker } = await import('../src/index.js');
  const { raw, db } = await setup();

  const env = {
    DB: db,
    SESSION_SECRET: 'x'.repeat(40),
    ASSETS: { fetch: async () => new Response('page', { status: 200 }) },
  };
  const call = (path, init) => worker.fetch(
    new Request(`https://staff.example.test${path}`, init), env, null,
  );

  const made = await read(await createInvite(ctx(db, { body: { wantsDetails: true } }), '1'));
  const token = made.url.split('/').pop();

  const opened = await (await call(`/api/i/${token}/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })).json();
  assert.ok(opened.files.some((f) => f.code === 'ghana_card'));

  const sent = await (await call(`/api/i/${token}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'ghana_card', filename: 'card.png', mime: 'image/png', content: PNG }),
  })).json();
  assert.equal(sent.ok, true);

  assert.equal(raw.prepare('SELECT status FROM hr_document WHERE id = ?').get(sent.id).status, 'pending');

  const removed = await (await call(`/api/i/${token}/files/${sent.id}/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })).json();
  assert.equal(removed.ok, true);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM hr_document').get().n, 0);
});

test('a file kept whole even when it is bigger than one row will take', async () => {
  // D1 caps a row at about two megabytes, so anything larger is stored in
  // pieces. A certificate scanned at full resolution goes straight past that,
  // and a feature that quietly truncated it would be worse than not having it.
  const { raw, db } = await setup();
  const { token } = await link(db);

  const big = Buffer.alloc(1_800_000, 7).toString('base64');
  const out = await read(await inviteFile(
    phone(db, { kind: 'education', filename: 'degree.pdf', mime: 'application/pdf', content: big }),
    token,
  ));

  const row = raw.prepare('SELECT bytes, parts FROM hr_document WHERE id = ?').get(out.id);
  assert.equal(row.bytes, 1_800_000);
  assert.ok(row.parts > 1, 'stored in pieces');
  assert.equal(
    raw.prepare('SELECT COUNT(*) n FROM hr_document_part WHERE document_id = ?').get(out.id).n,
    row.parts - 1,
  );
});
