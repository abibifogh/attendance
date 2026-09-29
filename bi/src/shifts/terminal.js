import { toMinor } from '../lib/money.js';

/**
 * Reading the card terminal report — the CSV the bank's merchant portal
 * (TAMS) exports.
 *
 * This is the only source that knows *when* a card was tapped, to the second,
 * and the only one that knows about the attempts that failed. The bank
 * statement knows neither: it carries the settled credit, days later, dated to
 * the day. So the terminal is what card payments are matched on, and the bank
 * is what they are checked against afterwards.
 *
 * The portal wraps most values as `="…"` so a spreadsheet keeps the leading
 * zeros; amounts come as `1,524.00`. Times are Accra time, which is UTC, and
 * are kept as the text they arrived as.
 */

/** Codes the portal uses for an approved purchase. */
const APPROVED = new Set(['00']);

const REASONS = {
  '05': 'Do not honour',
  '06': 'Error',
  '09': 'Request in progress',
  12: 'Invalid transaction',
  13: 'Invalid amount',
  14: 'Invalid card number',
  51: 'Insufficient funds',
  54: 'Expired card',
  55: 'Wrong PIN',
  61: 'Over the withdrawal limit',
  91: 'Issuer unavailable',
  96: 'System malfunction',
};

/** One CSV line, with quoted fields and doubled quotes inside them. */
export function csvRow(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

/** `="524322******4698"` → `524322******4698`. */
export function unwrap(value) {
  const v = String(value ?? '').trim();
  const m = /^="(.*)"$/.exec(v);
  return (m ? m[1] : v).trim();
}

/** `2026-08-31 22:01:22`, or the day-first form some exports use. */
export function terminalTime(value) {
  const v = unwrap(value);
  let m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)(?::(\d\d))?/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] || '00'}`;
  m = /^(\d\d)[/-](\d\d)[/-](\d{4})[ T](\d\d):(\d\d)(?::(\d\d))?/.exec(v);
  if (m) return `${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}:${m[6] || '00'}`;
  return null;
}

/**
 * The whole file → rows.
 *
 * Columns are found by their header, not their position, so a portal that
 * adds a column next year does not quietly shift every amount into the
 * wrong field.
 */
export function parseTerminalCsv(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { rows: [], skipped: 0 };
  const header = csvRow(lines[0]).map((h) => unwrap(h).toLowerCase());
  const col = (name) => header.indexOf(name.toLowerCase());
  const need = ['Date', 'PAN', 'Amount', 'RRN', 'Responsecode'];
  const missing = need.filter((n) => col(n) < 0);
  if (missing.length) {
    return { rows: [], skipped: lines.length - 1, error: `This does not look like the terminal report: no ${missing.join(', ')} column.` };
  }

  const rows = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const f = csvRow(line);
    const get = (name) => (col(name) >= 0 ? unwrap(f[col(name)]) : '');
    const at = terminalTime(get('Date'));
    const rrn = get('RRN');
    const amount = toMinor(get('Amount').replace(/,/g, ''));
    if (!at || !rrn || !Number.isFinite(amount)) { skipped += 1; continue; }
    const pan = get('PAN');
    const masked = /^(\d{6})\*+(\d{4})$/.exec(pan);
    const code = get('Responsecode');
    const type = get('TransactionType') || 'Purchase';
    rows.push({
      rrn,
      at,
      day: at.slice(0, 10),
      terminal: get('Terminal'),
      type,
      kind: /mobile/i.test(type) ? 'momo' : 'card',
      amount,
      first6: masked ? masked[1] : null,
      last4: masked ? masked[2] : null,
      stan: get('STAN'),
      code,
      status: get('Status') || REASONS[code] || '',
      approval: get('ApprovalCode'),
      approved: APPROVED.has(code),
    });
  }
  return { rows, skipped };
}

/** A plain word for a decline code. */
export function declineReason(code, status) {
  return status || REASONS[code] || `Declined (code ${code})`;
}
