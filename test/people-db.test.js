import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  acceptSubmission, addDocument, countersignContract, createInvite,
  fileSignedContract, getContract, getDocument, getPerson, issueContract,
  listPeople, listSubmissions, loadStandardTemplates, rejectSubmission,
  revokeInvite, saveList, savePerson, saveTemplate,
} from '../src/routes/people.js';
import {
  inviteDecline, inviteDetails, inviteHead, inviteOpen, inviteSign, inviteViewed,
} from '../src/routes/invite.js';
import { hashBody } from '../src/lib/people.js';
import { createHash } from 'node:crypto';

/**
 * The whole round trip, against a real database.
 *
 * A manager makes a link, somebody opens it on a phone, sends their details
 * and signs a contract, and the office accepts what came in. Everything
 * interesting about this feature is in the seams between those steps, and none
 * of the seams can be tested without a database: the token is a hash, the
 * submission is a row nobody has looked at yet, and the signature is only
 * worth anything because of what is stored beside it.
 */

function d1(db) {
  const statement = (sql, binds = []) => ({
    sql,
    binds,
    bind(...args) { return statement(sql, args); },
    async all() { return { results: db.prepare(sql).all(...binds) }; },
    async first() { return db.prepare(sql).get(...binds) ?? null; },
    async run() {
      const result = db.prepare(sql).run(...binds);
      return { success: true, meta: { changes: Number(result.changes ?? 0) } };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  };
}

const OFFICE = {
  user: { id: 1, name: 'Ama', role: 'manager' },
  permissions: ['att_view', 'hr_view', 'hr_manage'],
};

/** Somebody who may read records but not the private numbers on them. */
const DESK = {
  user: { id: 2, name: 'Kofi', role: 'supervisor' },
  permissions: ['att_view', 'hr_view'],
};

function ctx(db, { body = null, session = OFFICE, ip = '41.66.1.9' } = {}) {
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
        'CF-Connecting-IP': ip,
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13)',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  };
}

/** No session at all — this is what a phone on the end of a link looks like. */
const phone = (db, body) => ctx(db, { body: body ?? {}, session: null, ip: '154.160.4.2' });

async function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const file of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${file}`, 'utf8'));
  }

  // The migrations seed the property's real people. These tests want two with
  // known numbers.
  raw.exec('DELETE FROM att_days; DELETE FROM att_punches; DELETE FROM att_roster;');
  raw.exec('DELETE FROM att_staff');
  raw.prepare(
    `INSERT INTO att_staff (id, employee_no, name, department, job_title, hired_on)
     VALUES (1, '1001', 'Angela Asare Ayima', 'Housekeeping', 'Housekeeper', '2026-09-01'),
            (2, '1002', 'Kofi Mensah', 'Security', 'Watchman', '2025-02-01')`,
  ).run();

  return { raw, db: d1(raw) };
}

const read = async (response) => response.json();

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

test('a record starts empty and says what it is missing', async () => {
  const { db } = await setup();
  const data = await read(await listPeople(ctx(db)));

  const angela = data.rows.find((r) => r.name === 'Angela Asare Ayima');
  assert.ok(angela.missing.includes('Emergency contacts'));
  assert.ok(angela.missing.includes('Mobile'));
  assert.equal(angela.signedContracts, 0);
});

test('the office can write a record and read it back', async () => {
  const { db } = await setup();

  await savePerson(ctx(db, { body: { personal_phone: '0241234567', town: 'Kokrobite' } }), 1);
  await saveList(ctx(db, { body: { rows: [{ kind: 'emergency', name: 'Ama', phone: '0555' }] } }), 1, 'contacts');

  const data = await read(await getPerson(ctx(db), 1));
  assert.equal(data.profile.personal_phone, '0241234567');
  assert.equal(data.lists.contacts.length, 1);
  assert.equal(data.lists.contacts[0].name, 'Ama');
});

test('a private number is masked for whoever may not read it', async () => {
  const { db } = await setup();
  await savePerson(ctx(db, { body: { account_number: '1234567890123' } }), 1);

  const asOffice = await read(await getPerson(ctx(db), 1));
  assert.equal(asOffice.profile.account_number, '1234567890123');

  const asDesk = await read(await getPerson(ctx(db, { session: DESK }), 1));
  assert.equal(asDesk.profile.account_number, '•••• 0123');
  assert.equal(asDesk.canManage, false);
});

test('saving one section leaves the others alone', async () => {
  const { db } = await setup();
  await savePerson(ctx(db, { body: { personal_phone: '024', town: 'Kokrobite' } }), 1);
  await savePerson(ctx(db, { body: { nationality: 'Ghanaian' } }), 1);

  const data = await read(await getPerson(ctx(db), 1));
  assert.equal(data.profile.town, 'Kokrobite', 'the earlier section survives');
  assert.equal(data.profile.nationality, 'Ghanaian');
});

// ---------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------

test('a scan goes in and comes back out byte for byte', async () => {
  const { db } = await setup();
  // A one-pixel PNG. Small, but a real binary with bytes that a text column
  // would mangle, which is the thing worth proving.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  await addDocument(ctx(db, {
    body: { title: 'Ghana Card', kind: 'ID document', mime: 'image/png', filename: 'card.png', content: png },
  }), 1);

  const listed = (await read(await getPerson(ctx(db), 1))).documents;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].title, 'Ghana Card');
  assert.ok(listed[0].bytes > 60);

  const response = await getDocument(ctx(db), listed[0].id);
  assert.equal(response.headers.get('Content-Type'), 'image/png');
  // Never cached: a scan of somebody's ID has no business in a shared cache.
  assert.match(response.headers.get('Cache-Control'), /no-store/);

  const out = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(out, Buffer.from(png, 'base64'));
});

test('a scanned contract too big for a single row is stored in pieces', async () => {
  // D1 holds about two megabytes to a row and a scanned five-page contract is
  // routinely more. A photograph can be shrunk in the browser; a PDF cannot,
  // and refusing it sends the contracts back to a filing cabinet.
  const { raw, db } = await setup();
  const big = Buffer.alloc(1_800_000);
  for (let i = 0; i < big.length; i += 1) big[i] = (i * 31) % 251;

  await addDocument(ctx(db, {
    body: { title: 'Old contract', kind: 'contract', mime: 'application/pdf', content: big.toString('base64') },
  }), 1);

  const row = raw.prepare('SELECT id, parts, bytes FROM hr_document').get();
  assert.equal(row.bytes, big.length);
  assert.equal(row.parts, 3, 'split across three rows');
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM hr_document_part').get().n, 2);

  // And comes back as exactly what went in.
  const out = Buffer.from(await (await getDocument(ctx(db), row.id)).arrayBuffer());
  assert.deepEqual(out, big);
});

test('a file too big even in pieces is refused with the size in the message', async () => {
  const { db } = await setup();
  const huge = Buffer.alloc(13_000_000, 7).toString('base64');

  await assert.rejects(
    () => addDocument(ctx(db, { body: { title: 'Scan', mime: 'application/pdf', content: huge } }), 1),
    /MB and the limit is/,
  );
});

// ---------------------------------------------------------------------------
// A link, and somebody on the end of it
// ---------------------------------------------------------------------------

async function makeLink(db, body = {}) {
  const made = await read(await createInvite(ctx(db, { body: { wantsDetails: true, ...body } }), 1));
  return { ...made, token: made.url.split('/i/')[1] };
}

test('a link is shown once and never stored', async () => {
  const { raw, db } = await setup();
  const link = await makeLink(db);

  assert.match(link.url, /\/i\/[0-9a-f]{48}$/);
  assert.match(link.message, /Angela/);

  // Only a fingerprint is kept, which is what makes a copy of the database
  // useless to whoever takes it.
  const row = raw.prepare('SELECT token_hash FROM hr_invite').get();
  assert.ok(row.token_hash);
  assert.ok(!row.token_hash.includes(link.token));
});

test('a link opens for the person it was made for', async () => {
  const { db } = await setup();
  const link = await makeLink(db);

  const head = await read(await inviteHead(phone(db), link.token));
  assert.equal(head.needsPin, false);

  const packet = await read(await inviteOpen(phone(db), link.token));
  assert.equal(packet.name, 'Angela Asare Ayima');
  assert.equal(packet.wantsDetails, true);
  assert.ok(packet.sections.length, 'and it carries the form the server defines');
});

test('the form on the phone never offers what a person may not set', async () => {
  const { db } = await setup();
  const link = await makeLink(db);
  const packet = await read(await inviteOpen(phone(db), link.token));

  const offered = new Set(packet.sections.flatMap((s) => s.fields.map((f) => f.key)));
  for (const key of ['job_title', 'hired_on']) assert.ok(!offered.has(key));
});

test('a wrong code does not open it, and a right one does', async () => {
  const { db } = await setup();
  const link = await makeLink(db, { pin: '4821' });

  assert.equal((await read(await inviteHead(phone(db), link.token))).needsPin, true);
  await assert.rejects(() => inviteOpen(phone(db, { pin: '0000' }), link.token), /code is not right/);

  const packet = await read(await inviteOpen(phone(db, { pin: '4821' }), link.token));
  assert.equal(packet.name, 'Angela Asare Ayima');
});

test('a made-up link says so plainly', async () => {
  const { db } = await setup();
  await assert.rejects(() => inviteHead(phone(db), 'deadbeef'.repeat(6)), /does not work/);
});

test('a cancelled link stops working immediately', async () => {
  const { db } = await setup();
  const link = await makeLink(db);
  await revokeInvite(ctx(db, { body: {} }), link.id);

  await assert.rejects(() => inviteHead(phone(db), link.token), /cancelled/);
});

test('an expired link says to ask for another', async () => {
  const { raw, db } = await setup();
  const link = await makeLink(db);
  raw.prepare("UPDATE hr_invite SET expires_at = datetime('now', '-1 day')").run();

  await assert.rejects(() => inviteHead(phone(db), link.token), /expired/);
});

// ---------------------------------------------------------------------------
// What comes back
// ---------------------------------------------------------------------------

test('what somebody sends lands as a claim, not as the record', async () => {
  const { raw, db } = await setup();
  const link = await makeLink(db);

  await inviteDetails(phone(db, {
    profile: { personal_phone: '0241234567', town: 'Kokrobite' },
    lists: { contacts: [{ kind: 'emergency', name: 'Ama', relationship: 'Sister', phone: '0555' }] },
  }), link.token);

  // The record is untouched. This is the whole point.
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM hr_profile').get().n, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM hr_contact').get().n, 0);

  const waiting = await read(await listSubmissions(ctx(db)));
  assert.equal(waiting.rows.length, 1);
  assert.equal(waiting.rows[0].name, 'Angela Asare Ayima');
  assert.deepEqual(
    waiting.rows[0].changes.map((c) => c.key).sort(),
    ['contacts', 'personal_phone', 'town'],
  );
});

test('accepting only the ticked changes writes only those', async () => {
  const { db } = await setup();
  const link = await makeLink(db);

  await inviteDetails(phone(db, {
    profile: { personal_phone: '0241234567', town: 'Kokrobite', nationality: 'Ghanaian' },
  }), link.token);

  const [waiting] = (await read(await listSubmissions(ctx(db)))).rows;
  const applied = await read(await acceptSubmission(
    ctx(db, { body: { keys: ['personal_phone', 'town'] } }), waiting.id,
  ));

  assert.equal(applied.applied, 2);
  const data = await read(await getPerson(ctx(db), 1));
  assert.equal(data.profile.personal_phone, '0241234567');
  assert.equal(data.profile.town, 'Kokrobite');
  assert.equal(data.profile.nationality, null, 'the one left unticked was not written');
});

test('a second form on the same link replaces the first', async () => {
  const { db } = await setup();
  const link = await makeLink(db);

  await inviteDetails(phone(db, { profile: { town: 'Kokrobite' } }), link.token);
  await inviteDetails(phone(db, { profile: { town: 'Kasoa' } }), link.token);

  const waiting = await read(await listSubmissions(ctx(db)));
  assert.equal(waiting.rows.length, 1, 'one thing to review, not two drafts of it');
  assert.equal(waiting.rows[0].changes[0].to, 'Kasoa');
});

test('turning a form down changes nothing and closes it', async () => {
  const { db } = await setup();
  const link = await makeLink(db);
  await inviteDetails(phone(db, { profile: { town: 'Kasoa' } }), link.token);

  const [waiting] = (await read(await listSubmissions(ctx(db)))).rows;
  await rejectSubmission(ctx(db, { body: { note: 'Rang her — wrong town' } }), waiting.id);

  assert.equal((await read(await listSubmissions(ctx(db)))).rows.length, 0);
  assert.equal((await read(await getPerson(ctx(db), 1))).profile, null);
});

test('an empty form is refused rather than stored', async () => {
  const { db } = await setup();
  const link = await makeLink(db);
  await assert.rejects(
    () => inviteDetails(phone(db, { profile: { town: '   ' } }), link.token),
    /Nothing was filled in/,
  );
});

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

async function issue(db, body = {}) {
  await saveTemplate(ctx(db, {
    body: {
      name: 'Contract of employment',
      body: '{{name}}, {{job_title}}, starting {{start_date}}. Notice: {{notice}}.',
    },
  }), null);

  return read(await issueContract(ctx(db, {
    body: { templateId: 1, values: { notice: 'One month' }, ...body },
  }), 1));
}

test('issuing a contract freezes the words against the person', async () => {
  const { raw, db } = await setup();
  const contract = await issue(db);

  const row = raw.prepare('SELECT * FROM hr_contract WHERE id = ?').get(contract.id);
  assert.equal(row.body, 'Angela Asare Ayima, Housekeeper, starting 2026-09-01. Notice: One month.');
  assert.equal(row.body_hash, await hashBody(row.body));

  // Editing the template afterwards must not reach a contract already issued.
  await saveTemplate(ctx(db, { body: { name: 'Contract of employment', body: 'Something else.' } }), 1);
  const again = raw.prepare('SELECT body FROM hr_contract WHERE id = ?').get(contract.id);
  assert.equal(again.body, row.body);
});

test('a contract is signed, and everything about the signing is kept', async () => {
  const { db } = await setup();
  const contract = await issue(db);
  const link = await makeLink(db, { wantsDetails: false, contractIds: [contract.id] });

  const packet = await read(await inviteOpen(phone(db), link.token));
  assert.equal(packet.contracts.length, 1);
  assert.match(packet.contracts[0].body, /Angela Asare Ayima/);

  await inviteSign(phone(db, {
    contractId: contract.id,
    name: 'Angela Asare Ayima',
    ink: 'data:image/png;base64,iVBORw0KGgo=',
    hash: packet.contracts[0].hash,
    agreed: true,
  }), link.token);

  const { contract: signed, events } = await read(await getContract(ctx(db), contract.id));
  assert.equal(signed.status, 'signed');
  assert.equal(signed.signer_name, 'Angela Asare Ayima');
  assert.equal(signed.signer_ip, '154.160.4.2');
  assert.match(signed.signer_agent, /Android/);
  assert.equal(signed.intact, true, 'the stored words still produce the recorded fingerprint');

  // The sequence is the evidence: sent, opened, signed, each with a time.
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes('contract_issued'));
  assert.ok(kinds.includes('link_opened'));
  assert.ok(kinds.includes('signed'));
});

test('signing without agreeing to sign electronically is refused', async () => {
  const { db } = await setup();
  const contract = await issue(db);
  const link = await makeLink(db, { wantsDetails: false, contractIds: [contract.id] });
  await inviteOpen(phone(db), link.token);

  await assert.rejects(
    () => inviteSign(phone(db, { contractId: contract.id, name: 'Angela Asare Ayima', agreed: false }), link.token),
    /Tick the box/,
  );
});

test('a contract altered after it was sent cannot be signed', async () => {
  // The failure this whole design exists to make impossible: somebody signs a
  // screen, and the stored contract says something else.
  const { raw, db } = await setup();
  const contract = await issue(db);
  const link = await makeLink(db, { wantsDetails: false, contractIds: [contract.id] });
  await inviteOpen(phone(db), link.token);

  await inviteViewed(phone(db, { contractId: contract.id }), link.token);
  raw.prepare("UPDATE hr_contract SET body = 'Notice: none.' WHERE id = ?").run(contract.id);

  await assert.rejects(
    () => inviteSign(phone(db, {
      contractId: contract.id, name: 'Angela Asare Ayima', agreed: true,
    }), link.token),
    /changed since it was sent/,
  );
  assert.equal(raw.prepare('SELECT status FROM hr_contract WHERE id = ?').get(contract.id).status, 'opened');
});

test('a link cannot be made to carry somebody else’s contract', async () => {
  const { db } = await setup();
  const contract = await issue(db); // Angela's

  // A link for Kofi, naming Angela's contract number.
  const made = await read(await createInvite(ctx(db, {
    body: { wantsDetails: false, contractIds: [contract.id] },
  }), 2));
  const packet = await read(await inviteOpen(phone(db), made.url.split('/i/')[1]));

  assert.equal(packet.name, 'Kofi Mensah');
  assert.equal(packet.contracts.length, 0);
});

test('a contract on one link cannot be signed through another', async () => {
  const { db } = await setup();
  const contract = await issue(db);
  await makeLink(db, { wantsDetails: false, contractIds: [contract.id] });
  const other = await makeLink(db, { wantsDetails: true });

  await assert.rejects(
    () => inviteSign(phone(db, { contractId: contract.id, name: 'A B', agreed: true }), other.token),
    /not part of this link/,
  );
});

test('refusing to sign is recorded rather than ignored', async () => {
  const { db } = await setup();
  const contract = await issue(db);
  const link = await makeLink(db, { wantsDetails: false, contractIds: [contract.id] });
  await inviteOpen(phone(db), link.token);

  await inviteDecline(phone(db, { contractId: contract.id, note: 'I want to read it with my brother' }), link.token);

  const { contract: refused, events } = await read(await getContract(ctx(db), contract.id));
  assert.equal(refused.status, 'declined');
  assert.match(refused.decline_note, /brother/);
  assert.ok(events.some((e) => e.kind === 'declined'));
});

test('the property countersigns after the employee, not before', async () => {
  const { db } = await setup();
  const contract = await issue(db);
  const link = await makeLink(db, { wantsDetails: false, contractIds: [contract.id] });
  const packet = await read(await inviteOpen(phone(db), link.token));

  await assert.rejects(
    () => countersignContract(ctx(db, { body: { name: 'Ama' } }), contract.id),
    /once they have signed/,
  );

  await inviteSign(phone(db, {
    contractId: contract.id, name: 'Angela Asare Ayima', agreed: true,
    hash: packet.contracts[0].hash,
  }), link.token);
  await countersignContract(ctx(db, { body: { name: 'Ama Boateng' } }), contract.id);

  const { contract: done } = await read(await getContract(ctx(db), contract.id));
  assert.equal(done.employer_name, 'Ama Boateng');
  assert.ok(done.employer_at);
});

test('a packet with nothing left in it closes itself', async () => {
  const { raw, db } = await setup();
  const contract = await issue(db);
  const link = await makeLink(db, { wantsDetails: true, contractIds: [contract.id] });
  const packet = await read(await inviteOpen(phone(db), link.token));

  await inviteDetails(phone(db, { profile: { town: 'Kokrobite' } }), link.token);
  assert.equal(raw.prepare('SELECT finished_at FROM hr_invite WHERE id = ?').get(link.id).finished_at, null,
    'still a contract to sign');

  await inviteSign(phone(db, {
    contractId: contract.id, name: 'Angela Asare Ayima', agreed: true,
    hash: packet.contracts[0].hash,
  }), link.token);

  assert.ok(raw.prepare('SELECT finished_at FROM hr_invite WHERE id = ?').get(link.id).finished_at);
});

// ---------------------------------------------------------------------------
// Contracts that were signed on paper
// ---------------------------------------------------------------------------

const SCAN = Buffer.from('%PDF-1.4\n old signed contract \n%%EOF\n', 'latin1').toString('base64');

test('a contract signed on paper is filed as a contract, not as a stray document', async () => {
  const { db } = await setup();

  await fileSignedContract(ctx(db, {
    body: {
      title: 'Contract of employment (2025)',
      signedOn: '2025-02-01',
      signerName: 'Kofi Mensah',
      employerName: 'Ama Boateng',
      filename: 'kofi-contract.pdf',
      mime: 'application/pdf',
      content: SCAN,
    },
  }), 2);

  const data = await read(await getPerson(ctx(db), 2));
  assert.equal(data.contracts.length, 1);

  const filed = data.contracts[0];
  assert.equal(filed.status, 'signed');
  assert.equal(filed.origin, 'paper');
  assert.equal(filed.signed_at, '2025-02-01');
  assert.equal(filed.signer_name, 'Kofi Mensah');
  assert.equal(filed.employer_name, 'Ama Boateng');
  assert.ok(filed.document_id, 'and the scan is attached to it');
  assert.ok(filed.filed_by, 'with a note of who filed it, which is a different fact');
});

test('the fingerprint of a filed scan is of the file itself', async () => {
  const { db } = await setup();
  await fileSignedContract(ctx(db, {
    body: { title: 'Contract', signedOn: '2025-02-01', mime: 'application/pdf', content: SCAN },
  }), 2);

  const [filed] = (await read(await getPerson(ctx(db), 2))).contracts;
  const { contract } = await read(await getContract(ctx(db), filed.id));

  const expected = createHash('sha256').update(Buffer.from(SCAN, 'base64')).digest('hex');
  assert.equal(contract.body_hash, expected, 'so a swapped scan can be told from the filed one');
});

test('a paper contract cannot be dated in the future', async () => {
  const { db } = await setup();
  await assert.rejects(
    () => fileSignedContract(ctx(db, {
      body: { title: 'Contract', signedOn: '2099-01-01', mime: 'application/pdf', content: SCAN },
    }), 2),
    /in the future/,
  );
});

test('filing a paper contract completes the file requirement it answers', async () => {
  const { db } = await setup();

  const before = (await read(await getPerson(ctx(db), 2))).fileStatus
    .find((d) => d.code === 'contract');
  assert.equal(before.state, 'missing');

  await fileSignedContract(ctx(db, {
    body: { title: 'Contract', signedOn: '2025-02-01', mime: 'application/pdf', content: SCAN },
  }), 2);

  const after = (await read(await getPerson(ctx(db), 2))).fileStatus
    .find((d) => d.code === 'contract');
  assert.equal(after.state, 'held');
});

// ---------------------------------------------------------------------------
// The standard set
// ---------------------------------------------------------------------------

test('the standard templates load once and do not duplicate', async () => {
  const { raw, db } = await setup();

  const first = await read(await loadStandardTemplates(ctx(db, { body: {} })));
  assert.ok(first.added >= 8, `only ${first.added} loaded`);
  assert.equal(first.added, first.total);

  const again = await read(await loadStandardTemplates(ctx(db, { body: {} })));
  assert.equal(again.added, 0, 'loading twice adds nothing');
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM hr_template').get().n, first.total);
});

test('a template edited into the property’s own words survives a reload', async () => {
  const { raw, db } = await setup();
  await loadStandardTemplates(ctx(db, { body: {} }));

  const row = raw.prepare("SELECT id FROM hr_template WHERE code = 'contract_permanent'").get();
  await saveTemplate(ctx(db, {
    body: { name: 'Our contract', body: 'Whatever we decided it should say.' },
  }), row.id);

  await loadStandardTemplates(ctx(db, { body: {} }));
  const after = raw.prepare('SELECT name, body FROM hr_template WHERE id = ?').get(row.id);
  assert.equal(after.name, 'Our contract');
  assert.equal(after.body, 'Whatever we decided it should say.');
});

test('a contract issued from a standard template answers its requirement when signed', async () => {
  const { raw, db } = await setup();
  await loadStandardTemplates(ctx(db, { body: {} }));

  const handbook = raw.prepare("SELECT id FROM hr_template WHERE code = 'handbook_ack'").get();
  const issued = await read(await issueContract(ctx(db, { body: { templateId: handbook.id } }), 1));

  const link = await makeLink(db, { wantsDetails: false, contractIds: [issued.id] });
  const packet = await read(await inviteOpen(phone(db), link.token));
  await inviteSign(phone(db, {
    contractId: issued.id, name: 'Angela Asare Ayima', agreed: true,
    hash: packet.contracts[0].hash,
  }), link.token);

  const status = (await read(await getPerson(ctx(db), 1))).fileStatus
    .find((d) => d.code === 'handbook');
  assert.equal(status.state, 'held');
});
