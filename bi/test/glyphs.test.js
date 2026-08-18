import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Every system on the hub has a mark, and no two share one.
 *
 * The hub is five cards of similar text, and the marks are what people navigate
 * by once they have read the words. A system added to the database without one
 * gets a blank tile among four drawn ones, which reads as a broken image — and
 * nothing else in the app would fail, so it would ship.
 *
 * Read as source rather than imported: `glyphs.js` builds SVG through
 * `document.createElementNS`, and these tests run in a Worker-shaped Node with
 * no DOM. What is being checked here is the *table*, which is the part that can
 * fall out of step with the migration. The drawings themselves are checked in a
 * browser, where they can actually be looked at.
 */

const glyphs = readFileSync(new URL('../public/js/glyphs.js', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../migrations/0002_accounts_and_sso.sql', import.meta.url), 'utf8');

/** The ids the MARKS table answers to, and what each one draws. */
const marks = (() => {
  const table = /const MARKS = \{([\s\S]*?)\n\};/.exec(glyphs);
  assert.ok(table, 'the MARKS table is no longer where this test looks for it');
  const entries = new Map();
  for (const line of table[1].split('\n')) {
    const named = /^\s*([a-z_]+)\s*:\s*([a-z]+)\s*,\s*$/.exec(line);   // `pos: restaurant,`
    const shorthand = /^\s*([a-z_]+)\s*,\s*$/.exec(line);              // `insight,`
    if (named) entries.set(named[1], named[2]);
    else if (shorthand) entries.set(shorthand[1], shorthand[1]);
  }
  return entries;
})();

/** The systems the database is seeded with. */
const seeded = (() => {
  const insert = /INSERT OR IGNORE INTO systems[\s\S]*?;/.exec(migration);
  assert.ok(insert, 'the systems seed is no longer where this test looks for it');
  return [...insert[0].matchAll(/\(\s*'([a-z]+)'\s*,/g)].map((m) => m[1]);
})();

test('the fixtures this test reads are real', () => {
  assert.ok(marks.size >= 5, `only found ${marks.size} marks, so the parser is wrong`);
  assert.deepEqual(seeded.sort(), ['attendance', 'breakfast', 'insight', 'laundry', 'pos']);
});

test('every system in the database has a mark', () => {
  for (const id of seeded) {
    assert.ok(marks.has(id), `'${id}' is seeded on the hub but has no mark in glyphs.js`);
  }
});

test('no two systems share a drawing', () => {
  // Housekeeping deliberately borrows breakfast's cup — they are one codebase
  // and one card is never shown beside the other. Everything the hub seeds must
  // still be distinct, or the marks stop telling the cards apart.
  const drawn = seeded.map((id) => marks.get(id));
  assert.equal(new Set(drawn).size, drawn.length, `two seeded systems draw the same thing: ${drawn.join(', ')}`);
});

test('a system with no mark still gets a tile rather than a hole', () => {
  assert.match(glyphs, /const unknown = /, 'the fallback drawing is gone');
  assert.match(glyphs, /return draw \? draw\(\) : unknown\(/, 'systemMark no longer falls back');
});

test('each mark says what it is, for anybody not seeing it', () => {
  // Every svg() call passes a label as its first argument, and the one mark
  // built without the helper sets aria-label itself.
  const labelled = [...glyphs.matchAll(/svg\('([^']+)',/g)].map((m) => m[1]);
  assert.ok(labelled.length >= 4, `only ${labelled.length} labelled marks`);
  for (const label of labelled) assert.ok(label.trim().length > 2, `a mark is labelled "${label}"`);
  assert.match(glyphs, /'aria-label': 'Insight'/);
});

test('the marks use the app\'s categorical colours, not colours of their own', () => {
  // A mark and the band for the same part of the business in a chart have to be
  // the same claim. Hard-coded hex here is how those quietly drift apart.
  const body = glyphs.slice(glyphs.indexOf('const BOX'));
  const hex = body.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(hex, [], `hard-coded colours in the marks: ${hex.join(', ')}`);
  assert.match(glyphs, /var\(--series-1\)/);
  assert.match(glyphs, /var\(--series-2\)/);
  assert.match(glyphs, /var\(--series-3\)/);
  assert.match(glyphs, /var\(--series-4\)/);
});

test('the hub renders the mark it is given, for every card', () => {
  const hub = readFileSync(new URL('../public/js/views/hub.js', import.meta.url), 'utf8');
  assert.match(hub, /import \{ systemMark \} from '\.\.\/glyphs\.js'/);
  // One call, inside systemCard, so no card can be built without one.
  assert.equal((hub.match(/systemMark\(/g) || []).length, 1);
  assert.match(hub, /systemMark\(system\.id, system\.label\)/);
});

/**
 * The rename.
 *
 * The seed and the migration have to agree, or a fresh install and an upgraded
 * one show different names for the same system — the sort of difference nobody
 * notices until two people are looking at two screens.
 */
test('a fresh install and an upgraded one call attendance the same thing', () => {
  const rename = readFileSync(new URL('../migrations/0003_hive.sql', import.meta.url), 'utf8');

  const seedRow = /\(\s*'attendance'\s*,\s*'([^']+)'\s*,\s*'([^']+)'/.exec(migration);
  const updated = /SET\s+label\s*=\s*'([^']+)',\s*description\s*=\s*'([^']+)'/.exec(rename);
  assert.ok(seedRow, 'the attendance row is no longer in the seed');
  assert.ok(updated, 'the rename no longer sets both label and description');

  assert.equal(seedRow[1], 'HIVE');
  assert.equal(seedRow[1], updated[1], 'the seed and the rename disagree about the label');
  assert.equal(seedRow[2], updated[2], 'the seed and the rename disagree about the description');
});

test('the rename touches one row and leaves the id alone', () => {
  const file = readFileSync(new URL('../migrations/0003_hive.sql', import.meta.url), 'utf8');
  // Comments stripped first. The prose above the statement explains *why* it is
  // an UPDATE, so counting the word across the whole file counts the
  // explanation as a second statement.
  const rename = file.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  assert.match(rename, /WHERE id = 'attendance'/);
  // Bounded to the SET clause. An unbounded match runs straight past it into
  // `WHERE id = 'attendance'` and fails on the line that makes this safe.
  const setClause = /SET([\s\S]*?)WHERE/.exec(rename);
  assert.ok(setClause, 'the rename has no SET ... WHERE');
  assert.doesNotMatch(setClause[1], /\bid\s*=/, 'the id is the systemId both ends of the hand-off agree on');
  assert.equal((rename.match(/UPDATE /g) || []).length, 1);
});
