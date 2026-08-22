import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  addEnclosure, closeLetter, createLetter, dispatchLetter, getFile, getLetter,
  letterheadImage, listLetterheads, listLetters, listStamps, removeLetterhead,
  revokeRecipient, saveLetterhead, saveMySignature, saveParty,
  saveStamp, sendForSignature, signChallenge, signLetter, updateLetter, voidLetter,
} from '../src/routes/correspondence.js';
import {
  signDecline, signDocument, signHead, signLetterhead, signOpen,
} from '../src/routes/sign.js';
import { verifyChain } from '../src/lib/correspondence.js';
import { getPepper, hashPin } from '../src/lib/auth.js';

/**
 * A letter, all the way out and back, against a real database.
 *
 * The interesting parts of this feature are all in the seams: the reference
 * that must never be handed out twice, the link that is only a hash, the order
 * signers must go in, the re-authentication before a stored signature can be
 * applied, and the chain that has to break when somebody edits the log. None
 * of those can be tested without a database.
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
  user: { id: 1, name: 'Ama Boateng', role: 'manager' },
  permissions: ['corr_view', 'corr_write', 'corr_sign'],
};

/** Somebody who may read the register but not sign for the property. */
const CLERK = {
  user: { id: 2, name: 'Kofi', role: 'supervisor' },
  permissions: ['corr_view', 'corr_write'],
};

function ctx(db, { body = null, session = OFFICE, query = '', ip = '41.66.1.9', env = {} } = {}) {
  const url = new URL(`https://staff.example.test/api/corr/x${query}`);
  return {
    db,
    env,
    url,
    session,
    executionContext: null,
    request: new Request(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        'CF-Connecting-IP': ip,
        'User-Agent': 'Mozilla/5.0 (Macintosh)',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  };
}

/** No session at all — a supplier on the end of a link. */
const outside = (db, body) => ctx(db, { body: body ?? {}, session: null, ip: '197.251.7.4' });

const read = async (response) => response.json();

async function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const file of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(`migrations/${file}`, 'utf8'));
  }

  const db = d1(raw);
  const pepper = await getPepper(db);

  // Two logins, one of which has a PIN to re-authenticate with.
  raw.exec('DELETE FROM users');
  raw.prepare("INSERT INTO users (id, name, role, active) VALUES (1, 'Ama Boateng', 'manager', 1), (2, 'Kofi', 'supervisor', 1)").run();
  raw.prepare('UPDATE users SET pin_hash = ? WHERE id = 1').run(await hashPin('4821', pepper));

  raw.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('property_name', 'Somewhere Nice')");
  return { raw, db };
}

const PIN = { pin: '4821' };

async function draft(db, extra = {}) {
  return read(await createLetter(ctx(db, {
    body: {
      series: 'FIN',
      subject: 'Outstanding invoice 4471',
      body: 'Dear Sir or Madam,\n\nWe write about invoice 4471.\n\nYours faithfully,',
      addressedTo: 'Accra Brewery Limited',
      ...extra,
    },
  })));
}

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

test('a letter is given a reference the moment it exists', async () => {
  const { db } = await setup();
  const first = await draft(db);
  const second = await draft(db);

  const year = new Date().getFullYear();
  assert.equal(first.reference, `SN/FIN/${year}/0001`);
  assert.equal(second.reference, `SN/FIN/${year}/0002`, 'and never the same one twice');
});

test('each series counts on its own', async () => {
  const { db } = await setup();
  const fin = await draft(db, { series: 'FIN' });
  const hr = await draft(db, { series: 'HR' });

  const year = new Date().getFullYear();
  assert.equal(fin.reference, `SN/FIN/${year}/0001`);
  assert.equal(hr.reference, `SN/HR/${year}/0001`);
});

test('a reference is not reused after a letter is withdrawn', async () => {
  // A gap in the register is a question worth asking. A reused number is a
  // filing system that quietly disagrees with itself.
  const { db } = await setup();
  const first = await draft(db);
  await voidLetter(ctx(db, { body: { note: 'Wrong supplier' } }), first.id);
  const second = await draft(db);

  assert.notEqual(first.reference, second.reference);
});

test('the register can be read back and searched', async () => {
  const { db } = await setup();
  await draft(db);
  await draft(db, { subject: 'Renewal of the laundry contract', series: 'ADM' });

  const all = await read(await listLetters(ctx(db)));
  assert.equal(all.rows.length, 2);

  const found = await read(await listLetters(ctx(db, { query: '?q=laundry' })));
  assert.equal(found.rows.length, 1);
  assert.match(found.rows[0].subject, /laundry/);
});

test('an address book entry carries through to the letter', async () => {
  const { db } = await setup();
  const party = await read(await saveParty(ctx(db, {
    body: {
      name: 'Kwame Mensah', kind: 'supplier', organisation: 'Accra Brewery Limited',
      email: 'kwame@example.test', address: 'Graphic Road, Accra',
    },
  }), null));

  const letter = await draft(db, { partyId: party.id });
  const { letter: got } = await read(await getLetter(ctx(db), letter.id));

  assert.equal(got.addressed_to, 'Kwame Mensah');
  assert.equal(got.address, 'Graphic Road, Accra');
  assert.equal(got.organisation, 'Accra Brewery Limited');
});

test('a letter written elsewhere is filed with its file', async () => {
  const { db } = await setup();
  const pdf = Buffer.from('%PDF-1.4\n a letter written in Word \n%%EOF\n', 'latin1');

  const letter = await read(await createLetter(ctx(db, {
    body: {
      series: 'ADM', subject: 'Notice to the landlord',
      filename: 'notice.pdf', mime: 'application/pdf', content: pdf.toString('base64'),
    },
  })));

  const { letter: got } = await read(await getLetter(ctx(db), letter.id));
  assert.equal(got.source, 'uploaded');
  assert.ok(got.file_id);

  const out = Buffer.from(await (await getFile(ctx(db), got.file_id)).arrayBuffer());
  assert.deepEqual(out, pdf);
});

// ---------------------------------------------------------------------------
// Signing for the property
// ---------------------------------------------------------------------------

test('a stored signature cannot be applied without proving who you are', async () => {
  // The threat is an unlocked phone on a desk in a hotel office, and it is a
  // real one. A stored signature anybody with the session could stamp onto a
  // letter would be worse than having none at all.
  const { db } = await setup();
  await saveMySignature(ctx(db, {
    body: { ...PIN, displayName: 'Ama Boateng', jobTitle: 'General Manager', ink: 'data:image/png;base64,AAA' },
  }));
  const letter = await draft(db);

  await assert.rejects(
    () => signLetter(ctx(db, { body: {} }), letter.id),
    /Confirm it is you/,
  );
  await assert.rejects(
    () => signLetter(ctx(db, { body: { pin: '0000' } }), letter.id),
    /PIN is not right/,
  );

  await signLetter(ctx(db, { body: PIN }), letter.id);
  const { letter: signed } = await read(await getLetter(ctx(db), letter.id));
  assert.equal(signed.signed_by, 'Ama Boateng');
  assert.equal(signed.signed_title, 'General Manager');
  assert.equal(signed.status, 'signed');
});

test('one person cannot apply another person’s stored signature', async () => {
  const { db } = await setup();
  await saveMySignature(ctx(db, {
    body: { ...PIN, displayName: 'Ama Boateng', ink: 'data:image/png;base64,AMA' },
  }));

  const letter = await draft(db);

  // Kofi has no stored signature of his own and no PIN. There is no route by
  // which he reaches Ama's.
  await assert.rejects(
    () => signLetter(ctx(db, { session: CLERK, body: { pin: '4821' } }), letter.id),
    /Confirm it is you|not right/,
  );

  const { letter: still } = await read(await getLetter(ctx(db), letter.id));
  assert.equal(still.signed_at, null);
});

test('signing with the stamp records that it was stamped', async () => {
  const { db } = await setup();
  const stamp = await read(await saveStamp(ctx(db, {
    body: { label: 'Company seal', image: 'data:image/png;base64,SEAL' },
  })));
  await saveMySignature(ctx(db, { body: { ...PIN, displayName: 'Ama Boateng', ink: 'data:image/png;base64,AAA' } }));

  const letter = await draft(db);
  await signLetter(ctx(db, { body: { ...PIN, stampId: stamp.id } }), letter.id);

  const { letter: signed, stamp: applied, events } = await read(await getLetter(ctx(db), letter.id));
  assert.ok(signed.stamped_at);
  assert.equal(applied.label, 'Company seal');
  assert.match(events.find((e) => e.kind === 'signed_internally').detail, /stamped/);
});

test('a signature is never handed back to somebody who did not save it', async () => {
  const { db } = await setup();
  await saveMySignature(ctx(db, { body: { ...PIN, displayName: 'Ama Boateng', ink: 'data:image/png;base64,SECRET' } }));

  const listed = await read(await listStamps(ctx(db, { session: CLERK })));
  const ama = listed.signatories.find((s) => s.display_name === 'Ama Boateng');

  assert.equal(ama.has_signature, 1, 'that she has one is useful to know');
  assert.equal(ama.signature_ink, undefined, 'what it looks like is not');
});

test('the challenge tells the browser how to prove it, and never the secret', async () => {
  const { db } = await setup();
  const out = await read(await signChallenge(ctx(db)));
  assert.equal(out.method, 'pin');
  assert.equal(out.signatory, null);
  assert.ok(!JSON.stringify(out).includes('4821'));
});

// ---------------------------------------------------------------------------
// Out for signature
// ---------------------------------------------------------------------------

async function sendOut(db, letterId, recipients, extra = {}) {
  return read(await sendForSignature(
    ctx(db, { body: { recipients, ...extra } }), letterId,
  ));
}

const tokenOf = (made) => made.url.split('/s/')[1];

test('a signing link is shown once and stored only as a hash', async () => {
  const { raw, db } = await setup();
  const letter = await draft(db);
  const out = await sendOut(db, letter.id, [{ name: 'Kwame Mensah', email: 'k@example.test' }]);

  const made = out.recipients[0];
  assert.match(made.url, /\/s\/[0-9a-f]{48}$/);
  assert.match(made.code, /^[A-Z0-9]{6}$/);

  const row = raw.prepare('SELECT token_hash, code_hash FROM corr_recipient').get();
  assert.ok(!row.token_hash.includes(tokenOf(made)));
  assert.ok(!row.code_hash.includes(made.code));

  // And it is never handed back afterwards, by any route.
  const detail = await read(await getLetter(ctx(db), letter.id));
  assert.ok(!JSON.stringify(detail).includes(tokenOf(made)));
});

test('the access code is asked for before the document opens at all', async () => {
  const { db } = await setup();
  const letter = await draft(db);
  const out = await sendOut(db, letter.id, [{ name: 'Kwame Mensah' }]);
  const token = tokenOf(out.recipients[0]);

  const head = await read(await signHead(outside(db), token));
  assert.equal(head.needsCode, true);
  assert.equal(head.subject, null, 'and the subject is not leaked before the code');

  await assert.rejects(() => signOpen(outside(db, { code: 'WRONG1' }), token), /code is not right/);

  const opened = await read(await signOpen(outside(db, { code: out.recipients[0].code }), token));
  assert.equal(opened.letter.subject, 'Outstanding invoice 4471');
});

test('signing goes in order and says who is being waited on', async () => {
  const { db } = await setup();
  const letter = await draft(db);
  const out = await sendOut(db, letter.id, [
    { name: 'First Signer', code: false },
    { name: 'Second Signer', code: false },
  ]);
  const [first, second] = out.recipients;

  await assert.rejects(
    () => signOpen(outside(db, {}), tokenOf(second)),
    /not your turn yet — this is with First Signer/,
  );

  const opened = await read(await signOpen(outside(db, {}), tokenOf(first)));
  await signDocument(outside(db, {
    contractId: null, name: 'First Signer', agreed: true, hash: opened.letter.hash,
    ink: 'data:image/png;base64,SIG',
  }), tokenOf(first));

  // Now the second one's link works.
  const now = await read(await signOpen(outside(db, {}), tokenOf(second)));
  assert.equal(now.you.name, 'Second Signer');
});

test('the letter completes only when the last signer has signed', async () => {
  const { db } = await setup();
  const letter = await draft(db);
  const out = await sendOut(db, letter.id, [
    { name: 'First Signer', code: false },
    { name: 'Second Signer', code: false },
  ]);

  for (const made of out.recipients) {
    const opened = await read(await signOpen(outside(db, {}), tokenOf(made)));
    const mid = await read(await getLetter(ctx(db), letter.id));
    if (made.seq === 1) assert.equal(mid.letter.status, 'awaiting_signature');

    await signDocument(outside(db, {
      name: made.name, agreed: true, hash: opened.letter.hash, ink: 'data:image/png;base64,S',
    }), tokenOf(made));
  }

  const done = await read(await getLetter(ctx(db), letter.id));
  assert.equal(done.letter.status, 'signed');
  assert.equal(done.progress.complete, true);
  assert.ok(done.events.some((e) => e.kind === 'fully_signed'));
});

test('somebody copied in is not asked to sign and gets no link', async () => {
  const { db } = await setup();
  const letter = await draft(db);
  const out = await sendOut(db, letter.id, [
    { name: 'For information', role: 'copy' },
    { name: 'The signer', code: false },
  ]);

  assert.equal(out.recipients[0].url, null);
  // And the signer's link works straight away, rather than waiting on a copy.
  const opened = await read(await signOpen(outside(db, {}), tokenOf(out.recipients[1])));
  assert.equal(opened.you.name, 'The signer');
});

test('signing without agreeing to sign electronically is refused', async () => {
  const { db } = await setup();
  const letter = await draft(db);
  const out = await sendOut(db, letter.id, [{ name: 'Kwame Mensah', code: false }]);
  await signOpen(outside(db, {}), tokenOf(out.recipients[0]));

  await assert.rejects(
    () => signDocument(outside(db, { name: 'Kwame Mensah', agreed: false }), tokenOf(out.recipients[0])),
    /Tick the box/,
  );
});

test('a letter altered after it went out cannot be signed', async () => {
  // The failure the whole arrangement exists to prevent: somebody signs a
  // screen, and the stored letter says something else.
  const { raw, db } = await setup();
  const letter = await draft(db);
  const out = await sendOut(db, letter.id, [{ name: 'Kwame Mensah', code: false }]);
  const opened = await read(await signOpen(outside(db, {}), tokenOf(out.recipients[0])));

  raw.prepare("UPDATE corr_letter SET body = 'You now owe us twice as much.' WHERE id = ?")
    .run(letter.id);

  await assert.rejects(
    () => signDocument(outside(db, {
      name: 'Kwame Mensah', agreed: true, hash: opened.letter.hash, ink: 'data:image/png;base64,S',
    }), tokenOf(out.recipients[0])),
    /changed since it was sent/,
  );
});

test('the words are fixed once a letter has gone out', async () => {
  const { db } = await setup();
  const letter = await draft(db);
  await sendOut(db, letter.id, [{ name: 'Kwame Mensah', code: false }]);

  await assert.rejects(
    () => updateLetter(ctx(db, { body: { body: 'Something else entirely.' } }), letter.id),
    /fixed once a letter has gone out/,
  );
});

test('a cancelled link stops working immediately', async () => {
  const { db } = await setup();
  const letter = await draft(db);
  const out = await sendOut(db, letter.id, [{ name: 'Kwame Mensah', code: false }]);

  await revokeRecipient(ctx(db, { body: {} }), out.recipients[0].id);
  await assert.rejects(() => signHead(outside(db), tokenOf(out.recipients[0])), /cancelled/);
});

test('an expired link says to ask for another', async () => {
  const { raw, db } = await setup();
  const letter = await draft(db);
  const out = await sendOut(db, letter.id, [{ name: 'Kwame Mensah', code: false }]);
  raw.prepare("UPDATE corr_recipient SET expires_at = datetime('now', '-1 day')").run();

  await assert.rejects(() => signHead(outside(db), tokenOf(out.recipients[0])), /expired/);
});

test('refusing to sign is recorded rather than ignored', async () => {
  const { db } = await setup();
  const letter = await draft(db);
  const out = await sendOut(db, letter.id, [{ name: 'Kwame Mensah', code: false }]);
  await signOpen(outside(db, {}), tokenOf(out.recipients[0]));

  await signDecline(outside(db, { note: 'The amount is wrong' }), tokenOf(out.recipients[0]));

  const detail = await read(await getLetter(ctx(db), letter.id));
  assert.equal(detail.recipients[0].status, 'declined');
  assert.equal(detail.progress.declined, 'Kwame Mensah');
  assert.ok(detail.events.some((e) => e.kind === 'declined' && /amount is wrong/.test(e.detail)));
});

test('a signed letter cannot be quietly withdrawn', async () => {
  const { db } = await setup();
  const letter = await draft(db);
  const out = await sendOut(db, letter.id, [{ name: 'Kwame Mensah', code: false }]);
  const opened = await read(await signOpen(outside(db, {}), tokenOf(out.recipients[0])));
  await signDocument(outside(db, {
    name: 'Kwame Mensah', agreed: true, hash: opened.letter.hash, ink: 'data:image/png;base64,S',
  }), tokenOf(out.recipients[0]));

  await assert.rejects(
    () => voidLetter(ctx(db, { body: { note: 'changed our mind' } }), letter.id),
    /already signed/,
  );
});

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

test('the whole life of a letter is in the chain, and the chain holds', async () => {
  const { db } = await setup();
  await saveMySignature(ctx(db, { body: { ...PIN, displayName: 'Ama Boateng', ink: 'data:image/png;base64,A' } }));

  const letter = await draft(db);
  await signLetter(ctx(db, { body: PIN }), letter.id);
  const out = await sendOut(db, letter.id, [{ name: 'Kwame Mensah', code: false }]);
  const opened = await read(await signOpen(outside(db, {}), tokenOf(out.recipients[0])));
  await signDocument(outside(db, {
    name: 'Kwame Mensah', agreed: true, hash: opened.letter.hash, ink: 'data:image/png;base64,S',
  }), tokenOf(out.recipients[0]));
  await dispatchLetter(ctx(db, { body: { via: 'email' } }), letter.id);
  await closeLetter(ctx(db, { body: { note: 'Paid' } }), letter.id);

  const detail = await read(await getLetter(ctx(db), letter.id));
  assert.equal(detail.chain.intact, true);
  assert.deepEqual(detail.events.map((e) => e.kind), [
    'created', 'signed_internally', 'sent_for_signature', 'opened_by_recipient',
    'signed', 'fully_signed', 'dispatched', 'closed',
  ]);
  // The recipient's own address, recorded against their signature.
  assert.equal(detail.recipients[0].signerIp, '197.251.7.4');
});

test('editing the log afterwards makes the letter say so', async () => {
  const { raw, db } = await setup();
  const letter = await draft(db);
  const out = await sendOut(db, letter.id, [{ name: 'Kwame Mensah', code: false }]);
  const opened = await read(await signOpen(outside(db, {}), tokenOf(out.recipients[0])));
  await signDocument(outside(db, {
    name: 'Kwame Mensah', agreed: true, hash: opened.letter.hash, ink: 'data:image/png;base64,S',
  }), tokenOf(out.recipients[0]));

  // Somebody with the database rewrites what an event said.
  raw.prepare("UPDATE corr_event SET detail = 'signed under duress' WHERE kind = 'signed'").run();

  const detail = await read(await getLetter(ctx(db), letter.id));
  assert.equal(detail.chain.intact, false);
  assert.ok(detail.chain.brokenAt >= 1);
});

test('deleting an inconvenient event breaks it too', async () => {
  const { raw, db } = await setup();
  const letter = await draft(db);
  await sendOut(db, letter.id, [{ name: 'Kwame Mensah', code: false }]);
  await dispatchLetter(ctx(db, { body: { via: 'post' } }), letter.id);

  raw.prepare("DELETE FROM corr_event WHERE kind = 'sent_for_signature'").run();

  const { chain } = await read(await getLetter(ctx(db), letter.id));
  assert.equal(chain.intact, false);
});

// ---------------------------------------------------------------------------
// Enclosures and dispatch
// ---------------------------------------------------------------------------

test('an enclosure is stored with the letter and comes back whole', async () => {
  const { db } = await setup();
  const letter = await draft(db);
  const sheet = Buffer.from('invoice,amount\n4471,1200\n');

  await addEnclosure(ctx(db, {
    body: { title: 'Statement of account', filename: 'statement.csv', mime: 'text/csv', content: sheet.toString('base64') },
  }), letter.id);

  const detail = await read(await getLetter(ctx(db), letter.id));
  assert.equal(detail.enclosures.length, 1);
  assert.equal(detail.enclosures[0].title, 'Statement of account');

  const out = Buffer.from(await (await getFile(ctx(db), detail.enclosures[0].id)).arrayBuffer());
  assert.deepEqual(out, sheet);
});

test('dispatch records how it went and when', async () => {
  const { db } = await setup();
  const letter = await draft(db);
  await dispatchLetter(ctx(db, { body: { via: 'courier', note: 'Left with reception' } }), letter.id);

  const { letter: sent, events } = await read(await getLetter(ctx(db), letter.id));
  assert.equal(sent.status, 'sent');
  assert.equal(sent.sent_via, 'courier');
  assert.ok(sent.sent_at);
  assert.match(events.find((e) => e.kind === 'dispatched').detail, /courier/);
});

// ---------------------------------------------------------------------------
// The letterhead and the layout
// ---------------------------------------------------------------------------

/** A one-pixel PNG, which is all the routes care about. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function addHead(db, extra = {}) {
  return read(await saveLetterhead(ctx(db, {
    body: {
      name: 'Somewhere Nice headed',
      content: PIXEL,
      mime: 'image/png',
      filename: 'head.png',
      makeDefault: true,
      ...extra,
    },
  })));
}

test('a letterhead is a picture, and new letters start on the default one', async () => {
  const { db } = await setup();
  const added = await addHead(db);
  assert.ok(added.id);

  const { letterheads, defaultId } = await read(await listLetterheads(ctx(db)));
  assert.equal(letterheads.length, 1);
  assert.equal(defaultId, added.id);
  assert.deepEqual(letterheads[0].margins, { top: 22, right: 10, bottom: 14, left: 10 });

  const letter = await draft(db);
  const { letter: full } = await read(await getLetter(ctx(db), letter.id));
  assert.equal(full.letterhead.id, added.id, 'picked up without anybody choosing it');
  assert.ok(full.layout.blocks.length, 'and opened with something to edit rather than blank');

  const image = await letterheadImage(ctx(db), added.id);
  assert.equal(image.headers.get('Content-Type'), 'image/png');
});

test('a PDF is refused, because the composer draws the page itself', async () => {
  const { db } = await setup();
  await assert.rejects(
    saveLetterhead(ctx(db, {
      body: { name: 'Scanned', content: PIXEL, mime: 'application/pdf', filename: 'head.pdf' },
    })),
    /picture/,
  );
});

test('margins that meet in the middle leave nowhere to write', async () => {
  const { db } = await setup();
  await assert.rejects(
    saveLetterhead(ctx(db, {
      body: {
        name: 'All margin', content: PIXEL, mime: 'image/png',
        margins: { top: 45, bottom: 45, left: 5, right: 5 },
      },
    })),
    /no room/,
  );

  // Right up to the line is allowed: 40 and 40 still leaves a fifth of the page.
  const fine = await read(await saveLetterhead(ctx(db, {
    body: {
      name: 'Tight', content: PIXEL, mime: 'image/png',
      margins: { top: 40, bottom: 40, left: 5, right: 5 },
    },
  })));
  assert.ok(fine.id);
});

test('the safe area can be moved later without touching the picture', async () => {
  const { db } = await setup();
  const added = await addHead(db);
  await saveLetterhead(ctx(db, {
    body: { name: 'Somewhere Nice headed', margins: { top: 30, right: 12, bottom: 18, left: 12 } },
  }), added.id);

  const { letterheads } = await read(await listLetterheads(ctx(db)));
  assert.deepEqual(letterheads[0].margins, { top: 30, right: 12, bottom: 18, left: 12 });
});

test('a letterhead taken out of use stops being offered', async () => {
  const { db } = await setup();
  const added = await addHead(db);
  await removeLetterhead(ctx(db), added.id);
  const { letterheads } = await read(await listLetterheads(ctx(db)));
  assert.equal(letterheads.length, 0);
});

test('the layout is saved, and the words are read back out of it', async () => {
  const { db } = await setup();
  await addHead(db);
  const letter = await draft(db);

  await updateLetter(ctx(db, {
    body: {
      subject: 'Outstanding invoice 4471',
      layout: {
        blocks: [
          { id: 'a', role: 'body', page: 1, x: 10, y: 45, w: 80, html: '<p>We write again about invoice 4471.</p>' },
          { id: 'b', role: 'sign', page: 1, x: 10, y: 78, w: 40, html: '<p>Yours faithfully</p>' },
        ],
      },
    },
  }), letter.id);

  const { letter: full } = await read(await getLetter(ctx(db), letter.id));
  assert.equal(full.layout.blocks.length, 2);
  assert.match(full.body, /invoice 4471/);
  assert.doesNotMatch(full.body, /<p>/, 'stored as words, not as markup');
});

test('the layout is fixed once the letter has left draft', async () => {
  const { db } = await setup();
  await saveMySignature(ctx(db, {
    body: { ...PIN, displayName: 'Ama Boateng', jobTitle: 'Manager', ink: 'data:image/png;base64,AAA' },
  }));
  const letter = await draft(db);
  await signLetter(ctx(db, { body: PIN }), letter.id);

  await assert.rejects(
    updateLetter(ctx(db, {
      body: { subject: 'Outstanding invoice 4471', layout: { blocks: [] } },
    }), letter.id),
    /fixed/,
  );
});

test('whoever signs sees the same page the property laid out', async () => {
  const { db } = await setup();
  await addHead(db);
  const letter = await draft(db);
  const out = await sendOut(db, letter.id, [{ name: 'Kwame Mensah', code: false }]);
  const token = tokenOf(out.recipients[0]);

  const opened = await read(await signOpen(outside(db, {}), token));
  assert.ok(opened.letter.layout.blocks.length, 'the blocks, not a wall of plain text');
  assert.equal(opened.letter.letterhead.image, `/api/s/${token}/letterhead`);
  assert.deepEqual(opened.letter.letterhead.margins, { top: 22, right: 10, bottom: 14, left: 10 });

  const paper = await signLetterhead(outside(db, {}), token);
  assert.equal(paper.headers.get('Content-Type'), 'image/png');
  assert.ok((await paper.arrayBuffer()).byteLength > 0, 'and the paper itself comes back');
});

test('a letter on no letterhead has none to fetch', async () => {
  const { db } = await setup();
  const letter = await draft(db);
  const out = await sendOut(db, letter.id, [{ name: 'Kwame Mensah', code: false }]);
  const token = tokenOf(out.recipients[0]);

  const opened = await read(await signOpen(outside(db, {}), token));
  assert.equal(opened.letter.letterhead, null);
  await assert.rejects(signLetterhead(outside(db, {}), token), /no letterhead/);
});

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

test('an access code is the default, and can be turned off for one person', async () => {
  const { raw, db } = await setup();
  const letter = await draft(db);

  const out = await sendOut(db, letter.id, [
    { name: 'Needs one' },
    { name: 'Does not', code: false },
    { name: 'For information', role: 'copy' },
  ]);

  assert.ok(out.recipients[0].code, 'silence means yes, because that is the safe half');
  assert.equal(out.recipients[1].code, null);
  assert.equal(out.recipients[2].url, null, 'and somebody copied in has no link to protect');

  // Stored as a hash or not at all, never as the code.
  const rows = raw.prepare('SELECT name, code_hash FROM corr_recipient ORDER BY seq').all();
  assert.ok(rows[0].code_hash);
  assert.equal(rows[1].code_hash, null);
});

test('a link with no code opens on the link alone', async () => {
  const { db } = await setup();
  const letter = await draft(db);
  const out = await sendOut(db, letter.id, [{ name: 'Kwame Mensah', code: false }]);
  const token = tokenOf(out.recipients[0]);

  const head = await read(await signHead(outside(db), token));
  assert.equal(head.needsCode, false);

  const opened = await read(await signOpen(outside(db, {}), token));
  assert.equal(opened.letter.subject, 'Outstanding invoice 4471');
});

test('in order, the second link stays shut until the first is done', async () => {
  const { db } = await setup();
  const letter = await draft(db);
  const out = await sendOut(db, letter.id, [
    { name: 'First Signer', code: false },
    { name: 'Second Signer', code: false },
  ]);
  const [first, second] = out.recipients;
  assert.equal(out.routing, 'order', 'which is what it has always done');

  await assert.rejects(
    () => signOpen(outside(db, {}), tokenOf(second)),
    /not your turn yet/,
  );

  const opened = await read(await signOpen(outside(db, {}), tokenOf(first)));
  await signDocument(outside(db, {
    contractId: null, name: 'First Signer', agreed: true, hash: opened.letter.hash,
    ink: 'data:image/png;base64,SIG',
  }), tokenOf(first));

  // And now it does.
  const now = await read(await signOpen(outside(db, {}), tokenOf(second)));
  assert.equal(now.you.name, 'Second Signer');
});

test('all at once opens every link the day it is made', async () => {
  const { db } = await setup();
  const letter = await draft(db);
  const out = await sendOut(db, letter.id, [
    { name: 'First Signer', code: false },
    { name: 'Second Signer', code: false },
  ], { routing: 'all' });

  assert.equal(out.routing, 'all');

  // The second party goes first, which is the whole point of asking.
  const opened = await read(await signOpen(outside(db, {}), tokenOf(out.recipients[1])));
  assert.equal(opened.you.name, 'Second Signer');
  await signDocument(outside(db, {
    contractId: null, name: 'Second Signer', agreed: true, hash: opened.letter.hash,
    ink: 'data:image/png;base64,SIG',
  }), tokenOf(out.recipients[1]));

  const other = await read(await signOpen(outside(db, {}), tokenOf(out.recipients[0])));
  assert.equal(other.you.name, 'First Signer');
});

test('whoever is signing is told which places on the page are theirs', async () => {
  const { db } = await setup();
  const letter = await draft(db);

  await updateLetter(ctx(db, {
    body: {
      subject: 'Outstanding invoice 4471',
      layout: {
        blocks: [
          { id: 'a', role: 'body', page: 1, x: 10, y: 45, w: 80, html: '<p>Please sign.</p>' },
          { id: 'us', role: 'field', page: 1, x: 10, y: 78, w: 33, h: 8, signer: 0, field: 'signature' },
          { id: 'them', role: 'field', page: 1, x: 55, y: 78, w: 33, h: 8, signer: 1, field: 'signature' },
        ],
      },
    },
  }), letter.id);

  const out = await sendOut(db, letter.id, [{ name: 'Accra Brewery Limited', code: false }]);
  const opened = await read(await signOpen(outside(db, {}), tokenOf(out.recipients[0])));

  assert.equal(opened.you.seq, 1, 'which signer they are, so the page can light their box up');
  assert.equal(opened.letter.layout.blocks.filter((b) => b.role === 'field').length, 2);
  assert.equal(opened.recipients.length, 1);
  assert.equal(opened.recipients[0].name, 'Accra Brewery Limited');
  assert.equal(opened.recipients[0].status, 'opened');
  // Names and status, never an address: one supplier must not be handed
  // another's contact details by the page they were sent to sign.
  assert.equal(opened.recipients[0].email, undefined);
});

test('a signature lands against the signer it was asked of', async () => {
  const { db } = await setup();
  const letter = await draft(db);
  const out = await sendOut(db, letter.id, [
    { name: 'First Signer', code: false },
    { name: 'Second Signer', code: false },
  ], { routing: 'all' });

  const opened = await read(await signOpen(outside(db, {}), tokenOf(out.recipients[1])));
  await signDocument(outside(db, {
    contractId: null, name: 'Second Signer', agreed: true, hash: opened.letter.hash,
    ink: 'data:image/png;base64,TWO',
  }), tokenOf(out.recipients[1]));

  const { recipients } = await read(await getLetter(ctx(db), letter.id));
  // In seq order, so the block that says "signer 2" draws the second row.
  assert.deepEqual(recipients.map((r) => r.seq), [1, 2]);
  assert.equal(recipients[0].status, 'pending');
  assert.equal(recipients[1].status, 'signed');
  assert.equal(recipients[1].signatureInk, 'data:image/png;base64,TWO');
});
