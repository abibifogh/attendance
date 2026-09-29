/**
 * pdf.js text items → lines of text laid out the way the page reads.
 *
 * ASSD prints its journal in columns, and the journal reader depends on a
 * column gap being visibly wider than the space between two words. pdf.js
 * hands back runs of text with their positions; this rebuilds each printed
 * line by its baseline, orders the runs left to right, and puts three spaces
 * where the page had a gap wider than a character or two, one where it had a
 * word space.
 *
 * Pure: no pdf.js in here, so it is tested in node against the same items the
 * browser sees.
 */
export function itemsToLines(items, { tolerance = 2 } = {}) {
  const rows = [];
  for (const it of items) {
    const text = String(it.str ?? '');
    if (!text.trim()) continue;
    const [, , , , x, y] = it.transform;
    const width = Number(it.width) || text.length * 4;
    let row = rows.find((r) => Math.abs(r.y - y) <= tolerance);
    if (!row) { row = { y, parts: [] }; rows.push(row); }
    row.parts.push({ x, end: x + width, text, charWidth: width / Math.max(1, text.length) });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((row) => {
    row.parts.sort((a, b) => a.x - b.x);
    let out = '';
    let prev = null;
    for (const p of row.parts) {
      if (prev) {
        const gap = p.x - prev.end;
        const unit = Math.max(1, Math.min(prev.charWidth, p.charWidth));
        out += gap > unit * 1.6 ? '   ' : (gap > unit * 0.2 ? ' ' : '');
      }
      out += p.text;
      prev = p;
    }
    return out;
  });
}

// The same two patterns the journal reader uses (src/shifts/assd.js).
const HEAD = /^([A-Z][A-Za-z]+(?: [A-Za-z/]+){0,4})\s{2,}([A-Z][A-Z0-9]+)\b/;
const NUMBER = /^(\s*\d\d-\d{3}-\d{4,}\s+\S+\s+\d\d\.\d\d\.\d\d)\b/;

/**
 * Take the guests out before anything leaves the browser.
 *
 * Every transaction in the journal opens with a line naming the kind, the
 * ASSD user and the guest with their address, then a line with the number,
 * the date and the guest's town and country. The reconciliation needs the
 * first two and the number; it has no use for anybody's name or where they
 * live, so those lines are cut down to what it needs here, on the page, and
 * the rest of a guest's details never reach Insight at all.
 */
export function redactJournalLines(lines) {
  let afterHead = false;
  return lines.map((line) => {
    const head = HEAD.exec(line);
    if (head && !/^\d/.test(line)) {
      afterHead = true;
      return `${head[1]}   ${head[2]}`;
    }
    if (afterHead) {
      const number = NUMBER.exec(line);
      if (number) { afterHead = false; return number[1]; }
    }
    return line;
  });
}
