// Reading a week's rota out of the scheduling export, before anybody commits it.
//
// Everything here is pure. Given the text of a file and the property's current
// staff and shifts, it says what each line would do — and says so without
// touching anything, because an import that writes first and reports afterwards
// is an import nobody dares run twice.

/**
 * A CSV, properly.
 *
 * Hand-rolled because the alternative is a dependency, and because the two
 * things that break naive splitting are both present in this file: the dates
 * read "Aug 17, 2026" and carry a comma inside their quotes, and a note may
 * contain one too. Quotes are doubled to escape themselves, which is the rule
 * every spreadsheet writes and most quick parsers forget.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const src = String(text ?? '').replace(/^﻿/, '');

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < src.length) {
    const ch = src[i];

    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }

    if (ch === '"') { quoted = true; i += 1; continue; }
    if (ch === ',') { endField(); i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\n') { endRow(); i += 1; continue; }

    field += ch; i += 1;
  }

  // A file not ending in a newline still has a last row.
  if (field !== '' || row.length) endRow();

  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** 'Aug 17, 2026' or '2026-08-17' to 'YYYY-MM-DD'. Null on anything else. */
export function readDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const m = /^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (!m) return null;
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${String(m[2]).padStart(2, '0')}`;
}

/** 'HH:MM' from '9:00', '09:00' or '09:00:00'. Null on anything else. */
export function readTime(value) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Column headings, however they were capitalised or spaced. */
function headerIndex(header) {
  const key = (s) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const at = new Map(header.map((h, i) => [key(h), i]));
  const find = (...names) => {
    for (const n of names) if (at.has(n)) return at.get(n);
    return -1;
  };

  return {
    name: find('employeenames', 'employeename', 'employee', 'name', 'staff'),
    position: find('position', 'role', 'department'),
    startDate: find('startdate', 'date', 'day'),
    endDate: find('enddate'),
    startTime: find('starttime', 'start'),
    endTime: find('endtime', 'end'),
    title: find('title', 'shift'),
    note: find('note', 'notes', 'comment'),
  };
}

/**
 * The lines of a rota export, read but not judged.
 *
 * A row missing a name, a date or either time is returned with `problem` set
 * rather than dropped. A file that silently loses three rows is worse than one
 * that says which three: the second gets fixed, the first gets trusted.
 */
export function parseRotaCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { rows: [], problem: 'That file is empty.' };

  const idx = headerIndex(rows[0]);
  if (idx.name < 0 || idx.startDate < 0 || idx.startTime < 0 || idx.endTime < 0) {
    return {
      rows: [],
      problem: 'That does not look like a rota export — it needs at least an employee name, '
        + 'a start date, a start time and an end time.',
    };
  }

  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    const r = rows[i];
    const get = (n) => (n >= 0 ? String(r[n] ?? '').trim() : '');

    const entry = {
      line: i + 1,
      name: get(idx.name),
      position: get(idx.position),
      day: readDate(get(idx.startDate)),
      endDay: readDate(get(idx.endDate)) || null,
      startsAt: readTime(get(idx.startTime)),
      endsAt: readTime(get(idx.endTime)),
      title: get(idx.title) || null,
      note: get(idx.note) || null,
      problem: null,
    };

    if (!entry.name) entry.problem = 'No employee name on this line.';
    else if (!entry.day) entry.problem = 'The start date could not be read.';
    else if (!entry.startsAt || !entry.endsAt) entry.problem = 'The times could not be read.';
    else if (entry.startsAt === entry.endsAt) entry.problem = 'A shift cannot start and end at the same time.';

    out.push(entry);
  }

  return { rows: out, problem: null };
}

// ---------------------------------------------------------------------------
// Matching what the file says to what this property has
// ---------------------------------------------------------------------------

const words = (s) => (String(s ?? '').toLowerCase().match(/[a-z]+/g) ?? []);

/**
 * Which member of staff a name on the file refers to.
 *
 * Four passes, narrowing from certain to merely likely, and stopping rather
 * than guessing:
 *
 *   The name exactly. Then an alias somebody has already confirmed, which is
 *   how "Chichi Ayim" keeps meaning Chichi every week instead of being asked
 *   about every week.
 *
 *   Then two or more words in common, which catches a reordered or shortened
 *   name — "Angela Asare Ayima" against "Angela Ayima Asare" — without ever
 *   matching two different people, because two shared names is already more
 *   coincidence than a staff list of this size produces.
 *
 *   One shared word is deliberately not enough. "Emmanuel Twum" and "Emmanuel
 *   Ofori Bennie" share exactly one, and quietly rostering the wrong Emmanuel
 *   is the sort of mistake that is only noticed at the end of the month.
 */
export function matchStaff(name, staff, aliases = new Map()) {
  const raw = String(name ?? '').trim();
  if (!raw) return { staff: null, how: 'none' };

  const lower = raw.toLowerCase();

  const exact = staff.find((s) => String(s.name).toLowerCase() === lower);
  if (exact) return { staff: exact, how: 'exact' };

  const aliased = aliases.get(lower);
  if (aliased) {
    const person = staff.find((s) => s.id === aliased);
    if (person) return { staff: person, how: 'alias' };
  }

  const mine = new Set(words(raw));
  const scored = staff
    .map((s) => ({ s, shared: words(s.name).filter((w) => mine.has(w)).length }))
    .filter((x) => x.shared >= 2)
    .sort((a, b) => b.shared - a.shared);

  if (scored.length === 1 || (scored.length > 1 && scored[0].shared > scored[1].shared)) {
    return { staff: scored[0].s, how: 'words' };
  }
  if (scored.length > 1) return { staff: null, how: 'ambiguous' };

  return { staff: null, how: 'none' };
}

/**
 * Which shift a line means, from its times and the position it was filed under.
 *
 * Times decide it. Where several shifts share a start and an end — this
 * property has five at 08:00–17:00 — the position breaks the tie, because
 * "who is on Housekeeping main" and "who is on Laundry 1" are different
 * questions at identical hours.
 */
export function matchShift({ startsAt, endsAt, position }, shifts) {
  const same = shifts.filter((s) => s.starts_at === startsAt && s.ends_at === endsAt);
  if (!same.length) return { shift: null, how: 'none' };
  if (same.length === 1) return { shift: same[0], how: 'times' };

  const hint = words(position);
  const byName = same.find((s) => words(s.name).some((w) => hint.includes(w)));
  if (byName) return { shift: byName, how: 'position' };

  const byDept = same.find((s) => words(s.department).some((w) => hint.includes(w)));
  if (byDept) return { shift: byDept, how: 'department' };

  return { shift: same[0], how: 'times' };
}

/**
 * Existing shifts closest to a set of hours the property has no shift for.
 *
 * Offered because the honest answer is almost never "make a new one". A line
 * reading 05:30–11:30 against a property that runs 05:00–11:30 is a scheduler
 * typing half past instead of five, not a new shift — and a system that
 * silently creates one leaves two nearly identical shifts, splits the reports
 * between them, and nobody notices for a month.
 *
 * Ranked by how far the two ends are from each other in minutes, so the
 * suggestion at the top is the one somebody almost certainly meant. Ranking
 * only: what to do about it is not this function's decision, and not this
 * app's.
 */
export function nearestShifts(startsAt, endsAt, shifts, { position = '', limit = 4 } = {}) {
  const start = hhmmToMinutes(startsAt);
  const end = hhmmToMinutes(endsAt);
  if (start == null || end == null) return [];

  const hint = words(position);

  return shifts
    .map((s) => {
      const a = hhmmToMinutes(s.starts_at);
      const b = hhmmToMinutes(s.ends_at);
      if (a == null || b == null) return null;
      const distance = Math.abs(a - start) + Math.abs(b - end);
      // A shift in the right part of the property wins a tie, because two
      // shifts equally far away are told apart by whose job it is.
      const related = words(s.name).some((w) => hint.includes(w))
        || words(s.department).some((w) => hint.includes(w));
      return { shift: s, minutes: distance, related };
    })
    .filter(Boolean)
    .sort((x, y) => x.minutes - y.minutes || (y.related - x.related))
    .slice(0, limit);
}

function hhmmToMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** What a shift created for these times should be called. */
export function shiftNameFor({ position, startsAt, endsAt, title }) {
  const where = String(position ?? '').replace(/^SN\s+/i, '').trim();
  const what = String(title ?? '').trim();
  const base = what || where || 'Shift';
  return `${base} ${startsAt}–${endsAt}`.slice(0, 60);
}

/**
 * Everything one line would do, decided but not done.
 *
 * `action` is the whole answer: `roster` writes a day, `new-shift` writes one
 * after creating the shift it needs, and `skip` writes nothing and says why.
 */
export function planRow(row, { staff, shifts, aliases, rosterBy }) {
  if (row.problem) return { ...row, action: 'skip' };

  const person = matchStaff(row.name, staff, aliases);
  if (!person.staff) {
    return {
      ...row,
      action: 'skip',
      problem: person.how === 'ambiguous'
        ? `More than one person could be "${row.name}".`
        : `Nobody here is called "${row.name}".`,
    };
  }

  const found = matchShift(row, shifts);
  const existing = rosterBy?.get(`${person.staff.id}|${row.day}`) ?? null;

  return {
    ...row,
    staffId: person.staff.id,
    staffName: person.staff.name,
    matchedBy: person.how,
    shiftId: found.shift?.id ?? null,
    shiftName: found.shift?.name ?? shiftNameFor(row),
    // No shift with these hours. Deliberately a question rather than an
    // action: nothing is created by an import unless somebody says so, and
    // "make a new shift" is the answer least often right.
    action: found.shift ? 'roster' : 'needs-shift',
    replaces: existing?.shift_id ?? null,
    problem: null,
  };
}

/** The plan for a whole file, and the counts somebody needs before pressing go. */
export function planImport(rows, context) {
  const planned = rows.map((row) => planRow(row, context));

  // Two lines for one person on one day: the later wins and the earlier is
  // reported, because one of them is a mistake and silently keeping either is
  // how a rota ends up disagreeing with the file it came from.
  const seen = new Map();
  for (const row of planned) {
    if (row.action === 'skip') continue;
    const key = `${row.staffId}|${row.day}`;
    const previous = seen.get(key);
    if (previous) {
      previous.action = 'skip';
      previous.problem = `Replaced by line ${row.line}, which rosters the same person that day.`;
    }
    seen.set(key, row);
  }

  const usable = planned.filter((r) => r.action !== 'skip');
  const days = [...new Set(usable.map((r) => r.day))].sort();

  return {
    rows: planned,
    from: days[0] ?? null,
    to: days[days.length - 1] ?? null,
    counts: countsOf(planned),
  };
}

/** What a screen needs to say before anybody presses anything. */
export function countsOf(rows) {
  const usable = rows.filter((r) => r.action !== 'skip');
  const ready = rows.filter((r) => r.action === 'roster' || r.action === 'create-shift');

  return {
    lines: rows.length,
    ready: ready.length,
    // Lines held back for a decision, and the number of distinct decisions
    // they represent — twenty lines needing the same answer is one question.
    undecided: rows.filter((r) => r.action === 'needs-shift').length,
    questions: new Set(rows.filter((r) => r.action === 'needs-shift')
      .map((r) => `${r.startsAt}-${r.endsAt}`)).size,
    willCreate: new Set(rows.filter((r) => r.action === 'create-shift').map((r) => r.shiftName)).size,
    replacing: ready.filter((r) => r.replaces != null && r.replaces !== r.shiftId).length,
    skipped: rows.filter((r) => r.action === 'skip').length,
    people: new Set(usable.map((r) => r.staffId)).size,
  };
}
