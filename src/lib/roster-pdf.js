// Reading a week's rota out of a printed schedule.
//
// The scheduling system exports a CSV, and a CSV is a far better thing to
// import. But the thing most people have to hand is the PDF they printed to
// show somebody, so this reads that too — and hands the result to exactly the
// same draft-and-confirm machinery, because the safety in an import is not in
// how the file was parsed.
//
// A printed schedule is a grid: people down the side, dates across the top, and
// a little block of text in each cell. Nothing in the file says so — a PDF
// records where each word was drawn and nothing about what it means — so the
// grid has to be recovered from the geometry. That is what this does, and the
// rules it uses are written down where it uses them, because every one of them
// is a judgement that could be wrong about somebody else's export.

import { readDate, readTime } from './roster-import.js';

const TIME_RANGE = /(\d{1,2}:\d{2})\s*(?:-|–|—|to)\s*(\d{1,2}:\d{2})/;
const DURATION = /^\s*\d+\s*h(?:rs?)?\s*(?:\d+\s*m(?:ins?)?)?\s*$/i;
const LEAVE_WORDS = /\b(approved|pending|declined|denied|rejected|cancelled|canceled|time off|unavailable|holiday request)\b/i;

/**
 * The lines of a printed rota, read but not judged.
 *
 * Returns the same shape `parseRotaCsv` does, so everything downstream — the
 * name matching, the shift matching, the draft, the questions, the confirm —
 * is shared. A second import path with its own idea of what a row is would be
 * a second set of bugs about the same thing.
 */
export function parseRotaPdf(pdf) {
  const pages = (pdf?.pages ?? []).map((page) => ({
    ...page,
    lines: toLines(page.items ?? []),
  }));

  if (!pages.some((p) => p.lines.length)) {
    return {
      rows: [],
      problem: 'There is no text in that PDF — only a picture of the schedule. '
        + 'Print it from a computer rather than a phone, or export it as a CSV.',
    };
  }

  const rows = [];
  let line = 0;
  let grid = null;

  for (const page of pages) {
    // Each page is read against its own row of dates where it has one. Most
    // exports print the heading once and let the grid run on over the page,
    // but a fortnight split a week to a page prints two — and reading the
    // second week under the first week's dates would be a whole week of the
    // rota written onto the wrong days.
    grid = gridOf(page) ?? (grid ? { ...grid, headerY: -Infinity } : null);
    if (!grid) continue;

    const people = findPeople(page.lines, grid);
    if (!people.length) continue;

    for (const cell of cellsOf(page.lines, grid, people)) {
      for (const block of blocksOf(cell.lines)) {
        line += 1;
        rows.push({ line, ...block, name: cell.name, day: cell.day });
      }
    }
  }

  if (!grid) {
    return {
      rows: [],
      problem: 'That PDF does not look like a schedule — no row of dates was found across the top.',
    };
  }

  if (!rows.length) {
    return {
      rows: [],
      problem: 'That PDF has dates across the top but no shifts under them.',
    };
  }

  // Read down the page, then across, which is the order somebody checking the
  // draft against the printout will read it in.
  return { rows: rows.sort((a, b) => a.name.localeCompare(b.name) || a.day.localeCompare(b.day)), problem: null };
}

// ---------------------------------------------------------------------------
// Words into lines
// ---------------------------------------------------------------------------

/**
 * Runs of text gathered back into the lines they were printed as.
 *
 * A PDF draws "Housekeeper Helper" as one run or as five, depending on how the
 * writer felt about kerning, and the only thing tying them together is that
 * they share a baseline. Same baseline, near enough, means same line.
 *
 * But only until the next big gap. Every cell across a row of a table shares
 * one baseline, so a plain baseline grouping turns a whole week into a single
 * line reading "Aug 17, 2026 Aug 18, 2026 Aug 19, 2026 …" and the table is
 * gone. A run of white space several characters wide is a column boundary; the
 * hair's breadth between two halves of a kerned word is not.
 */
function toLines(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const bands = [];

  for (const item of sorted) {
    const last = bands[bands.length - 1];
    const tolerance = Math.max(1.5, (item.size || 10) * 0.4);

    if (last && Math.abs(item.y - last.y) <= tolerance) {
      last.items.push(item);
      last.y = (last.y * (last.items.length - 1) + item.y) / last.items.length;
      continue;
    }
    bands.push({ y: item.y, items: [item] });
  }

  const lines = [];
  for (const band of bands) {
    const parts = [...band.items].sort((a, b) => a.x - b.x);
    let run = [];
    let end = null;

    const flush = () => { if (run.length) lines.push(assemble(band.y, run)); run = []; };

    for (const part of parts) {
      if (end != null && part.x - end > (part.size || 10) * 1.2) flush();
      run.push(part);
      end = part.x + (part.width || 0);
    }
    flush();
  }

  return lines.filter((line) => line.text);
}

function assemble(y, parts) {
  let text = '';
  let end = null;

  for (const part of parts) {
    // A gap wider than a quarter of the type size is a space somebody meant.
    // Anything narrower is kerning, and inserting a space there is how "Ayima"
    // becomes "Ay ima".
    if (end != null && part.x - end > (part.size || 10) * 0.25 && !/\s$/.test(text)) text += ' ';
    text += part.text;
    end = part.x + (part.width || 0);
  }

  return {
    y,
    x: parts[0].x,
    end: end ?? parts[0].x,
    size: parts[0].size || 10,
    // Icon fonts put a private-use glyph in front of the clock time and the
    // location. They carry no meaning here and read as noise in a name.
    text: text.replace(/[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}]/gu, '').replace(/\s+/g, ' ').trim(),
  };
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

/**
 * One page's dates across the top, and where each one's column begins and ends.
 *
 * Found from the widest run of same-height lines that are each nothing but a
 * date. "Schedule: Aug 17, 2026 - Aug 23, 2026" in the title is not a date, it
 * is a sentence with two in it, so it cannot be mistaken for the header.
 *
 * Null on a page that carries no heading of its own, which is most of them —
 * the grid simply continues over the page.
 */
function gridOf(page) {
  const dated = page.lines
    .map((line) => ({ line, day: readDate(line.text) }))
    .filter((x) => x.day);

  if (dated.length < 2) return null;

  // Same height, near enough, is the same row of headings.
  const bands = new Map();
  for (const { line, day } of dated) {
    const key = Math.round(line.y / 4);
    if (!bands.has(key)) bands.set(key, []);
    bands.get(key).push({ line, day });
  }

  const header = [...bands.values()].sort((a, b) => b.length - a.length)[0];
  if (!header || header.length < 2) return null;

  const columns = header
    .map(({ line, day }) => ({ day, centre: line.x + (line.end - line.x) / 2 }))
    .sort((a, b) => a.centre - b.centre);

  // Columns in a printed week are evenly spaced, so the gap between two
  // headings is the width of a column. The median gap survives a heading that
  // measured slightly wrong.
  const gaps = columns.slice(1).map((c, i) => c.centre - columns[i].centre).sort((a, b) => a - b);
  const pitch = gaps[Math.floor(gaps.length / 2)] || 100;

  // A cell's contents are set against the left of its column while the heading
  // is centred over it, so the boundary between two columns — not the distance
  // to a heading — is what decides which column a word is in.
  const edges = columns.map((c, i) => (i === 0
    ? c.centre - pitch / 2
    : (columns[i - 1].centre + c.centre) / 2));

  return { days: columns.map((c) => c.day), edges, headerY: header[0].line.y, pitch };
}

/** Which column a line sits in, or -1 for the names down the side. */
function columnAt(x, grid) {
  if (x < grid.edges[0]) return -1;
  let found = 0;
  for (let i = 1; i < grid.edges.length; i += 1) {
    if (x >= grid.edges[i]) found = i;
  }
  return found;
}

/**
 * The people down the side of the page, and where each one's row starts.
 *
 * A name too long for the column wraps, so "Destiny Hagar" and "Amankwa" are
 * one person on two lines. Lines close enough together to be a paragraph are
 * treated as one name; the gap to the next person is the height of a whole row
 * and nothing like it.
 */
function findPeople(lines, grid) {
  const column = lines
    .filter((line) => columnAt(line.x, grid) === -1 && line.y > grid.headerY - 1)
    .sort((a, b) => a.y - b.y);

  const people = [];
  for (const line of column) {
    const last = people[people.length - 1];
    const spacing = Math.max(line.size, last?.size ?? 0) * 1.9;

    if (last && line.y - last.bottom <= spacing) {
      last.name = `${last.name} ${line.text}`.replace(/\s+/g, ' ').trim();
      last.bottom = line.y;
      continue;
    }
    people.push({ name: line.text, top: line.y, bottom: line.y, size: line.size });
  }

  // A row of dates on a page that also has names would otherwise be read as a
  // person called "Aug 17, 2026".
  return people.filter((p) => !readDate(p.name) && /[A-Za-z]/.test(p.name));
}

/**
 * Every filled cell of the grid, as the lines printed inside it.
 *
 * A line belongs to the last person whose name began at or above it. Splitting
 * the page into bands at the midpoint between two names would be tidier and
 * wrong: a name sits at the top of its row and the block under it runs most of
 * the way to the next, so the midpoint falls through the middle of somebody's
 * shift.
 */
function cellsOf(lines, grid, people) {
  const cells = new Map();

  for (const line of lines) {
    const column = columnAt(line.x, grid);
    if (column < 0) continue;
    if (line.y <= grid.headerY + 1) continue; // the heading itself

    // A block may start a hair above the name beside it, so allow a little.
    let index = -1;
    for (let i = 0; i < people.length; i += 1) {
      if (people[i].top <= line.y + line.size) index = i;
    }
    if (index < 0) continue;

    const key = `${index}|${column}`;
    if (!cells.has(key)) {
      cells.set(key, { name: people[index].name, day: grid.days[column], lines: [] });
    }
    cells.get(key).lines.push(line);
  }

  for (const cell of cells.values()) cell.lines.sort((a, b) => a.y - b.y || a.x - b.x);
  return [...cells.values()];
}

// ---------------------------------------------------------------------------
// What is written in a cell
// ---------------------------------------------------------------------------

/**
 * The shifts printed in one cell.
 *
 * The export prints a block per shift, always in the same order: what it is
 * called, the hours, how long that is, where, and whose job it is. Only the
 * hours are guaranteed, so the hours are what a block is found by, and
 * everything else is read relative to them.
 *
 * A cell can hold two blocks — a split shift, or a shift and a swap — so the
 * lines are divided at the halfway point between one set of hours and the
 * next. Two shifts on one day for one person is a question this app answers
 * later, on the draft, where somebody can see both.
 */
function blocksOf(lines) {
  const blocks = [];
  const isTime = (line) => TIME_RANGE.test(line?.text ?? '');

  let title = [];
  let i = 0;

  while (i < lines.length) {
    if (!isTime(lines[i])) {
      // Anything above the hours is what the shift is called, however many
      // lines it wrapped onto.
      title.push(lines[i].text);
      i += 1;
      continue;
    }

    const timeLine = lines[i];
    const used = [timeLine];
    i += 1;

    // The length. The one line whose shape says exactly what it is, and always
    // directly under the hours — which is how a real shift is told from a
    // block of time off printed in the same grid.
    const hasDuration = DURATION.test(lines[i]?.text ?? '');
    if (hasDuration) { used.push(lines[i]); i += 1; }

    // Then where. One line, and on this property the same one in every cell.
    let where = null;
    if (i < lines.length && !isTime(lines[i])) {
      where = lines[i];
      used.push(where);
      i += 1;
    }

    // Then whose job it is, on a chip set in smaller type than the rest of the
    // block. The size is what ends it: the next thing bigger than the line
    // above is the next shift's name, not a third line of this one's
    // department. Getting that boundary wrong costs a hint and never a time.
    const position = [];
    while (i < lines.length && !isTime(lines[i]) && lines[i].size <= (where?.size ?? 0) + 0.5) {
      position.push(lines[i].text);
      used.push(lines[i]);
      i += 1;
    }

    blocks.push(read({
      title: title.join(' ').trim() || null,
      time: timeLine.text,
      hasDuration,
      where: where?.text ?? null,
      position: position.join(' ').trim() || null,
      texts: used.map((l) => l.text),
    }));
    title = [];
  }

  return blocks.filter(Boolean);
}

function read({ title, time, hasDuration, where, position, texts }) {
  const m = TIME_RANGE.exec(time);
  if (!m) return null;

  const startsAt = readTime(m[1]);
  const endsAt = readTime(m[2]);

  const base = {
    title, startsAt, endsAt, endDay: null,
    // Only ever a hint — it breaks a tie between two shifts running the same
    // clock, and this property has five at 08:00 to 17:00.
    position,
    // The location is the same in every cell of a single property's schedule,
    // so it says nothing worth writing onto a rostered day.
    note: null,
  };

  // Time off is printed in the same grid as the shifts, with hours of its own.
  // Importing "Approved 18:00 - 19:00" as an hour's work would put somebody on
  // a shift they had asked to be excused from. Reported rather than dropped,
  // because a line that vanishes is a line nobody checks.
  if (texts.some((t) => LEAVE_WORDS.test(t))) {
    return { ...base, note: texts.join(' — '), problem: 'A time-off block, not a shift.' };
  }

  if (!hasDuration && !where) {
    return {
      ...base,
      note: texts.join(' — '),
      problem: 'Hours with nothing under them — not printed like a shift.',
    };
  }

  return {
    ...base,
    problem: !startsAt || !endsAt
      ? 'The times could not be read.'
      : (startsAt === endsAt ? 'A shift cannot start and end at the same time.' : null),
  };
}
