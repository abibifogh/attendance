import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { extractPdfText } from '../src/lib/pdf-text.js';
import { parseRotaPdf } from '../src/lib/roster-pdf.js';

/**
 * Reading a rota off a printed schedule.
 *
 * Two kinds of test here, because there are two kinds of thing that can go
 * wrong and neither finds the other's bugs.
 *
 * A real PDF, printed by a real browser, is the only way to know the extractor
 * survives what files are actually like: subset fonts that renumber every
 * glyph, compressed object streams, a table split over two pages with the
 * heading on the first. The fixture is a mock of this property's own schedule
 * printed by Chrome, and it is checked shift by shift.
 *
 * And a set of tiny PDFs built line by line in the test, because the rules for
 * turning scattered words back into a grid — which column, which person, where
 * one block ends and the next begins — are judgements, and a judgement is only
 * worth having if you can state the case it gets right.
 */

const fixture = () => new Uint8Array(readFileSync(
  fileURLToPath(new URL('./fixtures/schedule-week.pdf', import.meta.url)),
));

const rowsOf = async (bytes) => parseRotaPdf(await extractPdfText(bytes));
const find = (rows, name, day) => rows.find((r) => r.name === name && r.day === day);

// ---------------------------------------------------------------------------
// A real printed schedule
// ---------------------------------------------------------------------------

test('the words come out of a real PDF with their positions', async () => {
  const text = await extractPdfText(fixture());

  assert.equal(text.pages.length, 2);
  assert.ok(Math.round(text.pages[0].width) === 842, 'A4 landscape');

  const all = text.pages[0].items.map((i) => i.text).join(' ');
  assert.match(all, /Abdul Hamid Iddirisu/, 'a subset font renumbers its glyphs; the map undoes it');
  assert.match(all, /17:30 - 06:30/);
});

test('a printed week reads back as the week it prints', async () => {
  const { rows, problem } = await rowsOf(fixture());

  assert.equal(problem, null);
  assert.equal(new Set(rows.map((r) => r.name)).size, 10, 'everybody on the printout');

  const day = find(rows, 'Angela Asare Ayima', '2026-08-18');
  assert.equal(day.startsAt, '09:00');
  assert.equal(day.endsAt, '18:00');
  assert.equal(day.title, 'Housekeeper Helper + laundry', 'a title that wrapped onto two lines');
  assert.equal(day.position, 'SN Housekeeping');
  assert.equal(day.problem, null);
});

test('a night shift keeps the hours it was printed with', async () => {
  const { rows } = await rowsOf(fixture());
  const night = find(rows, 'Abdul Hamid Iddirisu', '2026-08-19');

  // Which date an overnight shift belongs to is settled elsewhere, and settled
  // once. Here it is only read.
  assert.equal(night.startsAt, '17:30');
  assert.equal(night.endsAt, '06:30');
});

test('a name that wrapped onto two lines is still one person', async () => {
  const { rows } = await rowsOf(fixture());
  const names = [...new Set(rows.map((r) => r.name))];

  assert.ok(names.includes('Destiny Hagar Amankwa'), names.join(' / '));
  assert.ok(!names.includes('Amankwa'), 'and not a second person called Amankwa');
});

test('the second page is read under the first page’s dates', async () => {
  // The heading is printed once and the grid runs on over the page. Reading
  // page two without it would put a whole week of rota on the wrong days — or,
  // as it did the first time, drop the first person on the page entirely.
  const { rows } = await rowsOf(fixture());

  const gifty = rows.filter((r) => r.name === 'Gifty Owusu');
  assert.ok(gifty.length, 'the first person on page two is not lost');
  assert.deepEqual(
    gifty.map((r) => r.day),
    ['2026-08-17', '2026-08-18', '2026-08-20', '2026-08-21', '2026-08-23'],
  );
});

test('two shifts in one cell are two shifts', async () => {
  const { rows } = await rowsOf(fixture());
  const double = rows.filter((r) => r.name === 'Dorcas Sarpei' && r.day === '2026-08-17');

  assert.equal(double.length, 2);
  assert.deepEqual(double.map((r) => r.startsAt).sort(), ['06:00', '16:00']);
  // Which one wins is not decided here. It is decided on the draft, where
  // somebody can see both of them.
});

test('time off printed in the grid is not imported as a shift', async () => {
  // "Approved 18:00 - 19:00" has hours like everything else on the page.
  // Rostering it would put somebody on an hour of work they had asked to be
  // excused from — so it is held back, and said out loud rather than dropped.
  const { rows } = await rowsOf(fixture());
  const off = find(rows, 'Betty Freeman', '2026-08-17');

  assert.equal(off.problem, 'A time-off block, not a shift.');
  assert.match(off.note, /Approved/);

  const shifts = rows.filter((r) => !r.problem);
  assert.ok(shifts.every((r) => r.startsAt !== '18:00'), 'and nothing else picked it up');
});

// ---------------------------------------------------------------------------
// Files that cannot be read, each said differently
// ---------------------------------------------------------------------------

test('something that is not a PDF says so', async () => {
  await assert.rejects(
    () => extractPdfText(new TextEncoder().encode('Name,Date\nAngela,2026-08-17\n')),
    /does not look like a PDF/,
  );
});

test('a PDF that is only a picture of a schedule says which fix to try', async () => {
  // The commonest failure by far, and the one where a vague message costs the
  // most: printing from a phone draws every letter as an outline, so the file
  // has no text in it at all. There is nothing to parse and everything to say.
  const { rows, problem } = await rowsOf(makePdf([], { content: '0 0 200 100 re f' }));

  assert.equal(rows.length, 0);
  assert.match(problem, /only a picture/);
  assert.match(problem, /computer|CSV/);
});

test('a PDF with words but no dates across the top says that instead', async () => {
  const { problem } = await rowsOf(makePdf([
    { x: 40, y: 560, text: 'Minutes of the management meeting' },
    { x: 40, y: 540, text: 'Present: everybody' },
  ]));

  assert.match(problem, /no row of dates/);
});

test('a schedule with dates and nothing under them says that too', async () => {
  const { problem } = await rowsOf(makePdf(header()));
  assert.match(problem, /no shifts under them/);
});

// ---------------------------------------------------------------------------
// The rules that turn scattered words back into a grid
// ---------------------------------------------------------------------------

test('a cell belongs to the column its left edge sits in', async () => {
  // Headings are centred over their columns and cell contents are set against
  // the left, so "nearest heading" is the wrong question — the boundary
  // between two columns is the right one.
  const { rows } = await rowsOf(makePdf([
    ...header(),
    { x: 30, y: 520, text: 'Angela Asare Ayima' },
    ...block(300, 520, '09:00 - 18:00', 'Housekeeper Helper'),
  ]));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].day, '2026-08-18', 'the middle column, not the one whose heading is closest');
});

test('a block starting a hair above the name beside it is still that person’s', async () => {
  // It happens: a cell with no title starts its first line a point or two
  // above the name in the column beside it. A rule that says "at or below"
  // silently gives the shift to the person above.
  const { rows } = await rowsOf(makePdf([
    ...header(),
    { x: 30, y: 520, text: 'Abdul Hamid Iddirisu' },
    ...block(200, 522, '17:30 - 06:30', null),
  ]));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Abdul Hamid Iddirisu');
});

test('a shift is not handed to the person above it', async () => {
  const { rows } = await rowsOf(makePdf([
    ...header(),
    { x: 30, y: 520, text: 'Angela Asare Ayima' },
    ...block(200, 520, '07:00 - 16:00', 'Housekeeper Helper'),
    { x: 30, y: 420, text: 'Betty Freeman' },
    ...block(200, 420, '13:45 - 22:00', 'Bistro - Shift 2'),
  ]));

  assert.equal(rows.length, 2);
  assert.equal(find(rows, 'Angela Asare Ayima', '2026-08-17').startsAt, '07:00');
  assert.equal(find(rows, 'Betty Freeman', '2026-08-17').startsAt, '13:45');
});

test('hours with nothing under them are not taken for a shift', async () => {
  // A stray time in a note is not a rota entry, and the thing that tells them
  // apart is that a real block always says how long it is and where.
  const { rows } = await rowsOf(makePdf([
    ...header(),
    { x: 30, y: 520, text: 'Angela Asare Ayima' },
    { x: 200, y: 520, text: '09:00 - 18:00' },
  ]));

  assert.equal(rows.length, 1);
  assert.match(rows[0].problem, /not printed like a shift/);
});

// ---------------------------------------------------------------------------
// A PDF, built by hand
// ---------------------------------------------------------------------------

/** The row of dates every one of these fixtures is read against. */
function header() {
  return [
    { x: 200, y: 560, text: 'Aug 17, 2026' },
    { x: 300, y: 560, text: 'Aug 18, 2026' },
    { x: 400, y: 560, text: 'Aug 19, 2026' },
  ];
}

/** One shift, printed the way the export prints them. */
function block(x, y, hours, title) {
  const lines = [];
  let at = y;
  if (title) { lines.push({ x, y: at, text: title, size: 11 }); at -= 12; }
  lines.push({ x, y: at, text: hours });
  lines.push({ x, y: at - 12, text: '9h 0m' });
  lines.push({ x, y: at - 24, text: 'Somewhere Nice' });
  lines.push({ x, y: at - 36, text: 'SN Housekeeping', size: 8 });
  return lines;
}

/**
 * A PDF with the given words at the given points, and nothing else.
 *
 * Written out by hand rather than generated, so a test that says "a cell
 * belongs to the column its left edge sits in" can put a cell at an x and mean
 * it. It also exercises the plain-font path — one byte per character, no
 * embedded glyph map — which the browser-printed fixture never takes.
 */
function makePdf(items, { content = null } = {}) {
  const escape = (s) => String(s).replace(/([\\()])/g, '\\$1');
  const body = content ?? items.map((i) =>
    `BT /F1 ${i.size ?? 10} Tf 1 0 0 1 ${i.x} ${i.y} Tm (${escape(i.text)}) Tj ET`).join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] '
      + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let out = '%PDF-1.4\n';
  objects.forEach((o, i) => { out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  // No cross-reference table: the reader scans for objects rather than trusting
  // an index, which is the whole reason a file with a broken one still opens.
  out += 'trailer\n<< /Root 1 0 R /Size 6 >>\n%%EOF\n';

  return Uint8Array.from(out, (c) => c.charCodeAt(0) & 0xff);
}
