import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { PAGE, normaliseLayout, sanitiseHtml, starterLayout, textOf } from '../src/lib/paper.js';
import {
  createLetter, getLetter, listLetterheads, saveLetterhead, updateLetter,
} from '../src/routes/correspondence.js';

/**
 * A letter as a page.
 *
 * Two things here are worth more than the rest: the words are cleaned on the
 * way in, because they are shown back to somebody outside the property on a
 * signing page; and a block can never be dragged off the paper, because words
 * nobody can see are words nobody can get back.
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
  raw.exec('DELETE FROM corr_letter; DELETE FROM corr_party;');
  return { raw, db: d1(raw) };
}

const WRITER = {
  user: { id: 3, name: 'Yaa', role: 'admin' },
  permissions: ['corr_view', 'corr_write', 'corr_sign'],
};

const ctx = (db, { body = null, query = '' } = {}) => ({
  db,
  env: {},
  url: new URL(`https://x/api/corr/letters${query}`),
  session: WRITER,
  executionContext: null,
  request: new Request('https://x/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }),
});

const read = async (response) => response.json();

/** A one-pixel PNG. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

test('a letter keeps its formatting and loses everything else', () => {
  assert.equal(
    sanitiseHtml('<p>Dear <b>Sir</b>,</p><p><i>Yours</i></p>'),
    '<p>Dear <b>Sir</b>,</p><p><i>Yours</i></p>',
  );

  // A script is not formatting, and neither is what is inside it.
  assert.equal(sanitiseHtml('<p>Hello<script>alert(1)</script></p>'), '<p>Hello</p>');
  assert.equal(sanitiseHtml('<style>p{display:none}</style><p>Hi</p>'), '<p>Hi</p>');

  // Attributes go, all of them: everything about how a block looks belongs to
  // the block, so there is nothing one inside it could legitimately do.
  assert.equal(sanitiseHtml('<p onclick="steal()" style="position:fixed">Hi</p>'), '<p>Hi</p>');
  assert.equal(sanitiseHtml('<a href="javascript:alert(1)">Click</a>'), 'Click');
  assert.equal(sanitiseHtml('<img src=x onerror=alert(1)>Words'), 'Words');

  // An unknown tag loses its tags and keeps its words, which is what somebody
  // pasting out of Word actually wants.
  assert.equal(sanitiseHtml('<article><p>Kept</p></article>'), '<p>Kept</p>');
  assert.equal(sanitiseHtml('5 < 6 and 7 > 2'), '5 &lt; 6 and 7 &gt; 2');
  assert.equal(sanitiseHtml('Tom &amp; Jerry'), 'Tom &amp; Jerry');
});

test('the plain words come back out for searching and emailing', () => {
  assert.equal(textOf('<p>One</p><p>Two<br>Three</p>'), 'One\nTwo\nThree');
  assert.equal(textOf('<ul><li>A</li><li>B</li></ul>'), 'A\nB');
});

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

test('a block can never be dragged off the paper', () => {
  const out = normaliseLayout({
    blocks: [{ id: 'a', x: 300, y: -40, w: 500, size: 900, line: 9, align: 'sideways', html: 'Hi' }],
  });
  const block = out.blocks[0];

  assert.equal(block.w, 100, 'no wider than the page');
  assert.equal(block.x, 0, 'and never off the right of it');
  assert.equal(block.y, 0);
  assert.equal(block.size, 48, 'nor set in something nobody can print');
  assert.equal(block.line, 3);
  assert.equal(block.align, 'left', 'and an alignment that does not exist is the ordinary one');
});

test('a layout that is not one is refused rather than half-read', () => {
  assert.equal(normaliseLayout('not json'), null);
  assert.equal(normaliseLayout({ nope: true }), null);
  assert.equal(normaliseLayout(null), null);
  assert.equal(normaliseLayout({ blocks: [] }).blocks.length, 0);
});

test('a letter starts as a letter, not as a blank page', () => {
  const layout = starterLayout({
    reference: 'SN/ADM/2026/4',
    date: '22 August 2026',
    to: 'The Manager',
    address: 'Ecobank, Accra',
    subject: 'Standing order',
    body: 'Dear Sir,',
    signer: 'Kwame',
    title: 'General Manager',
  });

  const ids = layout.blocks.map((b) => b.id);
  assert.deepEqual(ids, ['ref', 'date', 'to', 'subject', 'body', 'sign']);

  // Down the page in the order a letter is read, and nothing overlapping.
  const ys = layout.blocks.map((b) => b.y);
  assert.deepEqual([...ys].sort((a, b) => a - b), ys);
  assert.match(layout.blocks.find((b) => b.id === 'subject').html, /Standing order/);
  assert.equal(layout.blocks.find((b) => b.id === 'date').align, 'right');
  assert.equal(layout.pages, 1);
});

test('the page is A4 at ninety-six dots to the inch', () => {
  // 210mm at 96dpi is 793.7px. Everything on a page is positioned as a
  // percentage of this, so the same numbers draw on screen and on paper.
  assert.equal(PAGE.widthPx, 794);
  assert.equal(Math.round(PAGE.heightPx / PAGE.widthPx * 100),
    Math.round(297 / 210 * 100), 'and it is the right shape');
});

// ---------------------------------------------------------------------------
// Through the routes
// ---------------------------------------------------------------------------

test('a letterhead is a picture, and its safe area is part of it', async () => {
  const { db } = setup();

  await assert.rejects(
    () => saveLetterhead(ctx(db, {
      body: { name: 'Scan', content: PIXEL, mime: 'application/pdf' },
    })),
    /has to be a picture/,
  );

  const made = await read(await saveLetterhead(ctx(db, {
    body: { name: 'Headed paper', content: PIXEL, mime: 'image/png', makeDefault: true },
  })));

  const list = await read(await listLetterheads(ctx(db)));
  assert.equal(list.letterheads.length, 1);
  assert.equal(list.defaultId, made.id, 'and new letters start on it');
  assert.deepEqual(list.letterheads[0].margins, { top: 22, right: 10, bottom: 14, left: 10 });

  await saveLetterhead(ctx(db, {
    body: { name: 'Headed paper', margins: { top: 30, right: 12, bottom: 20, left: 12 } },
  }), made.id);

  const after = await read(await listLetterheads(ctx(db)));
  assert.equal(after.letterheads[0].margins.top, 30);

  await assert.rejects(
    () => saveLetterhead(ctx(db, { body: { margins: { top: 45, bottom: 45 } } }), made.id),
    /no room for a letter/,
  );
});

test('a new letter opens laid out on the property’s paper', async () => {
  const { db } = setup();
  const head = await read(await saveLetterhead(ctx(db, {
    body: { name: 'Headed', content: PIXEL, mime: 'image/png', makeDefault: true },
  })));

  const made = await read(await createLetter(ctx(db, {
    body: {
      series: 'ADM', subject: 'Standing order', addressedTo: 'The Manager',
      body: 'Dear Sir,', signatory: 'Kwame',
    },
  })));

  const out = await read(await getLetter(ctx(db), made.id));
  assert.equal(out.letter.letterhead_id, head.id, 'the default one, without being asked');
  assert.equal(out.letter.letterhead.name, 'Headed');
  assert.equal(out.letter.layout.blocks.length, 6);
  assert.match(out.letter.layout.blocks.find((b) => b.id === 'ref').html, /SN\/ADM/);
});

test('saving a layout keeps the words and the page in step', async () => {
  const { db } = setup();
  const made = await read(await createLetter(ctx(db, {
    body: { series: 'ADM', subject: 'Invoice 4471', body: 'First draft.' },
  })));

  await updateLetter(ctx(db, {
    body: {
      layout: {
        blocks: [
          { id: 'body', role: 'body', x: 10, y: 40, w: 80, html: '<p>The <b>real</b> words.</p>' },
          { id: 'sign', role: 'signature', x: 10, y: 70, w: 40, html: '<p>Kwame</p>' },
        ],
      },
    },
  }), made.id);

  const out = await read(await getLetter(ctx(db), made.id));
  assert.match(out.letter.layout.blocks[0].html, /<b>real<\/b>/);
  // The searchable words are taken from the layout rather than trusted from
  // the screen, and the signature block is not part of them.
  assert.equal(out.letter.body, 'The real words.');
  assert.equal(out.letter.bodyIntact, true, 'and the fingerprint is retaken with them');
});

test('the layout is fixed once a letter has gone out', async () => {
  const { raw, db } = setup();
  const made = await read(await createLetter(ctx(db, {
    body: { series: 'ADM', subject: 'Invoice 4471', body: 'Words.' },
  })));
  raw.prepare("UPDATE corr_letter SET status = 'awaiting_signature' WHERE id = ?").run(made.id);

  await assert.rejects(
    () => updateLetter(ctx(db, { body: { layout: { blocks: [] } } }), made.id),
    /fixed once a letter has gone out/,
  );
});

test('anything dangerous in a letter is gone before it reaches the database', async () => {
  const { raw, db } = setup();
  const made = await read(await createLetter(ctx(db, {
    body: { series: 'ADM', subject: 'Invoice 4471', body: 'Words.' },
  })));

  await updateLetter(ctx(db, {
    body: {
      layout: {
        blocks: [{
          id: 'body', role: 'body', x: 10, y: 40, w: 80,
          html: '<p>Hello<script>fetch("//evil")</script><img src=x onerror=alert(1)></p>',
        }],
      },
    },
  }), made.id);

  const stored = raw.prepare('SELECT layout FROM corr_letter WHERE id = ?').get(made.id).layout;
  assert.ok(!/script|onerror|<img/i.test(stored), `still dangerous: ${stored}`);
  assert.match(stored, /Hello/);
});
