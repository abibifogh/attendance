/**
 * A medical allowance sheet, as the office kept it before HIVE.
 *
 * One row a person: what they brought forward from last year, what they
 * claimed each month, and what that leaves. The columns are found by their
 * headings rather than their letters, because the next sheet will have a
 * column added somewhere and it should still read.
 *
 * Nothing here writes anything. It says what the sheet says and who in HIVE
 * each name looks like, and a person decides.
 */

import { round2 } from './medical.js';

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const text = (v) => (v == null ? '' : String(v).trim());
const amount = (v) => {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * The heading row and where each column is.
 *
 * The heading row is the first with a name column and at least three months
 * in it. Brought forward is B/F or "brought"; what is left is C/F, "carried"
 * or "balance" on its own after the months.
 */
function headingsOf(rows) {
  for (let r = 0; r < Math.min(rows.length, 30); r += 1) {
    const cells = (rows[r] ?? []).map((c) => text(c).toLowerCase());
    const months = MONTHS.map((m) => cells.findIndex((c) => c === m.toLowerCase()
      || c === m.slice(0, 3).toLowerCase() || c === `${m.slice(0, 3).toLowerCase()}.`));
    if (months.filter((i) => i >= 0).length < 3) continue;
    const name = cells.findIndex((c) => /\bname\b/.test(c));
    if (name < 0) continue;
    const first = Math.min(...months.filter((i) => i >= 0));
    const last = Math.max(...months);
    return {
      at: r,
      name,
      months,
      broughtForward: cells.findIndex((c, i) => i < first && /(b\s*\/\s*f|brought)/.test(c)),
      claims: cells.findIndex((c, i) => i > last && /claim/.test(c)),
      left: cells.findIndex((c, i) => i > last && /(c\s*\/\s*f|carried|balance|left)/.test(c)),
    };
  }
  return null;
}

/**
 * Everybody on the sheet, with their figures, and every row left out and why.
 *
 * `allowance` is the year's figure the sheet used, worked back from its own
 * columns: what is left, less what came forward, plus what was claimed. The
 * sheet writes it into a formula (`=1300+C4-P4`) rather than a column, and the
 * saved values are all a file carries, so this is how it is recovered. Null
 * where the sheet has no balance column to work it from.
 */
export function readMedicalSheet(rows) {
  const head = headingsOf(rows);
  if (!head) {
    throw new Error('HIVE could not find the heading row. It needs a name column and the months '
      + '(JAN, FEB …) along one row.');
  }

  const people = [];
  const left = [];
  const sums = new Array(12).fill(0);

  for (let r = head.at + 1; r < rows.length; r += 1) {
    const cells = rows[r] ?? [];
    const name = text(cells[head.name]);
    const months = head.months.map((i) => (i >= 0 ? amount(cells[i]) : 0));
    const figures = months.some((m) => m) || [head.broughtForward, head.claims, head.left]
      .some((i) => i >= 0 && amount(cells[i]));

    if (!name) {
      if (!figures) continue;
      // The totals row adds up to what is above it. Anything else with
      // figures and no name is somebody's number that has lost its person,
      // and the office needs to hear about it rather than have it vanish.
      const isTotal = months.every((m, i) => Math.abs((m ?? 0) - sums[i]) < 0.005);
      left.push({
        row: r + 1,
        why: isTotal ? 'the totals' : 'figures with no name',
        figures: isTotal ? [] : months
          .map((m, i) => (m ? `${MONTHS[i].slice(0, 3)} ${round2(m)}` : null)).filter(Boolean),
      });
      continue;
    }
    if (/^(total|sum)/i.test(name)) {
      left.push({ row: r + 1, why: 'the totals', figures: [] });
      continue;
    }
    if (months.some((m) => m === null)) {
      left.push({ row: r + 1, name, why: 'a month has something in it that is not a figure', figures: [] });
      continue;
    }

    months.forEach((m, i) => { sums[i] += m; });
    const broughtForward = head.broughtForward >= 0 ? round2(amount(cells[head.broughtForward]) ?? 0) : 0;
    const claimed = round2(months.reduce((n, m) => n + m, 0));
    const sheetLeft = head.left >= 0 ? amount(cells[head.left]) : null;
    const notes = [];
    if (head.claims >= 0) {
      const said = amount(cells[head.claims]);
      if (said != null && Math.abs(said - claimed) >= 0.005) {
        notes.push(`The claims column says ${round2(said)}; the months add up to ${claimed}.`);
      }
    }

    people.push({
      row: r + 1,
      name,
      broughtForward,
      months: months.map(round2),
      claimed,
      allowance: sheetLeft == null ? null : round2(sheetLeft - broughtForward + claimed),
      left: sheetLeft == null ? null : round2(sheetLeft),
      notes,
    });
  }

  return { people, left };
}

// ---------------------------------------------------------------------------
// Who is who
// ---------------------------------------------------------------------------

const words = (name) => String(name ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);

/** One letter apart, for the names spelt two ways: Abdulai and Abdullai, Antim and Antwim. */
function nearly(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** How many of the sheet's words turn up in a HIVE name, each HIVE word used once. */
function shared(sheet, hive) {
  const free = [...hive];
  let n = 0;
  let exact = 0;
  for (const w of sheet) {
    const at = free.findIndex((h) => nearly(w, h));
    if (at < 0) continue;
    if (free[at] === w) exact += 1;
    free.splice(at, 1);
    n += 1;
  }
  return { n, exact };
}

/**
 * Who in HIVE a name on the sheet is.
 *
 * 'same' is the same words in any order: "Mensah Akosua" is Akosua Mensah.
 * 'close' is every word of the shorter name found in the longer, allowing a
 * letter's difference: "Kwame Nii Boateng" is Kwame Boateng, "Kojo Antwim" is
 * Kojo Antim. Both are put forward as the answer.
 *
 * 'check' is a first name and nothing else, or two people equally close. A
 * first name is not an identity at a property with three Kofis, so it is
 * offered and not chosen. 'none' is nobody at all.
 */
export function matchStaff(name, staff) {
  const mine = words(name);
  const scored = staff.map((s) => {
    const theirs = words(s.name);
    const { n, exact } = shared(mine, theirs);
    const same = n === mine.length && n === theirs.length && exact === n;
    const close = n >= 2 && n === Math.min(mine.length, theirs.length);
    return { s, n, exact, level: same ? 3 : close ? 2 : n >= 1 ? 1 : 0 };
  }).filter((x) => x.level > 0)
    .sort((a, b) => b.level - a.level || b.n - a.n || b.exact - a.exact
      || Number(Boolean(b.s.active)) - Number(Boolean(a.s.active)));

  const pick = (x) => ({ id: x.s.id, name: x.s.name, active: Boolean(x.s.active) });
  const candidates = scored.slice(0, 4).map(pick);
  const [top, next] = scored;
  if (!top) return { level: 'none', staffId: null, candidates: [] };

  const tied = next && next.level === top.level && next.n === top.n && next.exact === top.exact;
  if (top.level >= 2 && !tied) {
    return { level: top.level === 3 ? 'same' : 'close', staffId: top.s.id, candidates };
  }
  return { level: 'check', staffId: null, candidates };
}
