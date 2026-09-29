import { toMinor } from '../lib/money.js';

/**
 * Reading the bank statement — GTBank's Finacle "customer statement" export.
 *
 * The browser reads the spreadsheet and posts the rows as arrays under the
 * statement's own header; this turns them into the four kinds of row that
 * matter to a shift and ignores everything else. Salaries, suppliers and
 * transfers are not a shift's business and are not stored at all: the fewer
 * names this database holds, the better.
 *
 * - **card**: a settled card payment. The particular carries the masked card,
 *   the day it was tapped, the approval code and the terminal:
 *   `411111************1111_22-Sep-2026_A1B2C3_TERM0001`, the terminal often left
 *   off. It arrives one to
 *   six days later and carries no time.
 * - **card reversal**: the same particular as a debit. Money going back.
 * - **commission**: `comm_` and the same particular. The bank's fee, about 1%,
 *   debited separately. Never a shift's shortfall.
 * - **momo**: a mobile-money receipt, posted to the second:
 *   `GTB/<MERCHANT>//<ref><dd/mm/yyyy hh:mm:ss>`. A second, batched form
 *   (`<MERCHANT> GTB<MERCHANT><ref>/…`) carries only the posting time.
 *
 * Finacle exports every row it ever touched, including the ones it threw
 * away: a row whose PSTD FLG is not Y, or whose DEL FLG is Y, was never posted
 * and is a copy of one that was. In a month there can be hundreds of them,
 * worth as much as the month's real card takings. They are counted and
 * dropped, never matched and never summed.
 */

const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
const CARD = /^(?:comm_)?(\d{6})\*{4,}(\d{4})_(\d{1,2})-([A-Za-z]{3})-(\d{4})_([^_\s]+)(?:_([^_\s]+))?/;
const MOMO_STAMP = /^GTB\/[^/]+\/\/(\S+?)(\d\d)\/(\d\d)\/(\d{4}) (\d\d:\d\d:\d\d)\s*$/;
const MOMO_BATCH = /^[A-Z0-9]+ GTB[A-Z0-9]+\/[A-Z0-9]+\//;

/**
 * An Excel date, whichever way it arrived: a serial number (days since
 * 1899-12-30, which is how the browser sends it, so no timezone touches it),
 * or text.
 */
export function sheetTime(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = Math.round((value - 25569) * 86400000);
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  }
  const v = String(value).trim();
  let m = /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d)(?::(\d\d))?)?/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}`;
  m = /^(\d\d)[/-](\d\d)[/-](\d{4})(?:[ T](\d\d):(\d\d)(?::(\d\d))?)?/.exec(v);
  if (m) return `${m[3]}-${m[2]}-${m[1]} ${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}`;
  m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(v);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')} 00:00:00`;
  return null;
}

/** Find the header row and the columns this needs, by name. */
export function statementColumns(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i += 1) {
    const row = (rows[i] || []).map((c) => String(c ?? '').trim().toUpperCase());
    if (row.includes('TRAN ID') && row.includes('TRAN PARTICULAR')) {
      const at = (name) => row.indexOf(name);
      return {
        headerRow: i,
        tranId: at('TRAN ID'),
        srl: at('PART TRAN SRL NUM'),
        partType: at('PART TRAN TYPE'),
        posted: at('PSTD FLG'),
        tranDate: at('TRAN DATE'),
        postedAt: at('PSTD DATE'),
        amount: at('TRAN AMT'),
        particular: at('TRAN PARTICULAR'),
        ref: at('REF NUM'),
        deleted: at('DEL FLG'),
      };
    }
  }
  return null;
}

/** One particular → what kind of row it is, and what it says. */
export function classify(particular, partType) {
  const p = String(particular || '').trim();
  const card = CARD.exec(p);
  if (card) {
    const month = MONTHS[card[4].toLowerCase()];
    const info = {
      first6: card[1],
      last4: card[2],
      cardDay: month ? `${card[5]}-${month}-${card[3].padStart(2, '0')}` : null,
      approval: card[6],
      terminal: card[7],
    };
    if (/^comm_/i.test(p)) return { kind: 'commission', ...info };
    return { kind: partType === 'D' ? 'card-reversal' : 'card', ...info };
  }
  if (partType === 'C') {
    const stamp = MOMO_STAMP.exec(p);
    if (stamp) {
      return { kind: 'momo', reference: stamp[1], stampedAt: `${stamp[4]}-${stamp[3]}-${stamp[2]} ${stamp[5]}` };
    }
    if (MOMO_BATCH.test(p)) return { kind: 'momo', reference: p.split('/')[1] || null, stampedAt: null };
  }
  return { kind: 'other' };
}

/**
 * Rows (arrays, as the browser sends them) → the rows worth keeping.
 *
 * Returns the kept rows plus counts of what was dropped and why, so the
 * upload can say "471 rows the bank itself had deleted were ignored" rather
 * than leaving somebody to wonder why the totals moved.
 */
export function parseStatement(rows) {
  const cols = statementColumns(rows);
  if (!cols) return { rows: [], error: 'This does not look like the bank statement: there is no TRAN ID / TRAN PARTICULAR header.' };

  const kept = [];
  const counts = { flagged: 0, other: 0, unreadable: 0 };
  let flaggedAmount = 0;
  for (const raw of rows.slice(cols.headerRow + 1)) {
    if (!raw || raw.length <= cols.particular) continue;
    const tranId = String(raw[cols.tranId] ?? '').trim();
    if (!tranId) continue;
    const partType = String(raw[cols.partType] ?? '').trim().toUpperCase();
    const amount = toMinor(raw[cols.amount]);
    const tranAt = sheetTime(raw[cols.tranDate]);
    if (!tranAt || !Number.isFinite(amount)) { counts.unreadable += 1; continue; }

    const what = classify(raw[cols.particular], partType);
    if (what.kind === 'other') { counts.other += 1; continue; }

    const posted = String(raw[cols.posted] ?? '').trim().toUpperCase() === 'Y';
    const deleted = String(raw[cols.deleted] ?? '').trim().toUpperCase() === 'Y';
    if (!posted || deleted) { counts.flagged += 1; flaggedAmount += amount; continue; }

    const postedAt = sheetTime(raw[cols.postedAt]);
    const srl = String(raw[cols.srl] ?? '').trim();
    kept.push({
      id: `${tranAt.slice(0, 10)}|${tranId}|${srl}`,
      kind: what.kind,
      day: tranAt.slice(0, 10),
      // A MoMo row's own stamp is the moment the guest paid; the posting time
      // is when the bank got round to it. Cards have neither — only the day.
      at: what.kind === 'momo' ? (what.stampedAt || postedAt) : null,
      atExact: what.kind === 'momo' && Boolean(what.stampedAt),
      postedAt,
      amount,
      cardDay: what.cardDay || null,
      first6: what.first6 || null,
      last4: what.last4 || null,
      approval: what.approval || null,
      terminal: what.terminal || null,
      reference: what.reference || String(raw[cols.ref] ?? '').trim() || null,
    });
  }
  return { rows: kept, counts, flaggedAmount };
}
