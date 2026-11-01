import { A4, PdfDoc, textWidth } from './pdf.js';

/**
 * A payslip as a PDF, for email.
 *
 * The same page as the payslip on screen (public/js/views/payslip.js): the
 * employer at the top, who and when, earnings on the left and deductions on
 * the right, the net pay in a dark band, then how the bonus came out and what
 * the month cost. One A4 page. Drawn with the small writer in pdf.js, so the
 * Worker needs nothing installed and the file stays a few kilobytes.
 *
 * Only ever from a closed month's slip as it was written down, so the PDF is
 * the record of what was paid and never a draft that later moves.
 *
 * Not locked: the property chose to send it as an ordinary PDF.
 */

const M = 50;
const RIGHT = A4.width - M;
const MID = A4.width / 2;
const INK = '#14181f';
const DIM = '#5b6472';
const FAINT = '#8a93a0';
const RULE = '#dde1e8';

function fit(text, width, size, bold = false) {
  let s = String(text ?? '');
  if (textWidth(s, size, bold) <= width) return s;
  while (s.length > 1 && textWidth(`${s}…`, size, bold) > width) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** "GHS 1,234.50", or without the pesewas when there are none, as on screen. */
export function cashOf(currency = 'GHS') {
  const code = currency === 'GH₵' || !currency ? 'GHS' : currency;
  return (n) => {
    const v = round2(n);
    const whole = Number.isInteger(v);
    return `${code} ${v.toLocaleString('en-GB', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
  };
}

/** "2, 6 and 8 Nov": the days late charges came off for. */
export function lateDays(charges = []) {
  const days = [...charges].map((c) => String(c.day ?? '')).filter(Boolean).sort();
  if (!days.length) return null;
  const mon = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  const parts = days.map((d, i) => {
    const n = String(Number(d.slice(8, 10)));
    const last = i === days.length - 1 || mon(days[i + 1]) !== mon(d);
    return last ? `${n} ${mon(d)}` : n;
  });
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The deductions column, the same lines the screen draws. */
export function deductionRows(line, cash, rates = {}) {
  const rows = [];
  if (line.ssnit?.qualifies) {
    rows.push([`SSNIT`, cash(line.ssnit.employee), `${round2((rates.ssnitEmployee ?? 0) * 100)}% of basic`]);
  }
  rows.push(['PAYE', cash(line.paye?.total ?? 0), null]);
  const loans = line.loans ?? [];
  const till = loans.filter((l) => l.what === 'till');
  const lent = loans.filter((l) => l.what !== 'till');
  const sum = (list) => list.reduce((n, l) => n + (l.amount || 0), 0);
  const lentTotal = till.length ? sum(lent) : (line.loanTotal ?? sum(lent));
  const short = round2(sum(till));
  const over = round2(Number(line.tillCredit) || 0);
  const both = short > 0 && over > 0 ? `${cash(short)} short, less ${cash(over)} over` : null;
  if (lent.length) rows.push([lent.length > 1 ? 'Salary advances' : 'Salary advance', cash(lentTotal), null]);
  if (short > over) rows.push([till.length > 1 ? 'Till shortages' : 'Till shortage', cash(short - over), both]);
  if (over > short) rows.push(['Till surplus paid', `-${cash(over - short)}`, both || 'Money over on your account, handed back untaxed']);
  if (over > 0 && over === short) rows.push(['Till', cash(0), both]);
  const late = line.lateCharges ?? [];
  if (late.length) rows.push([`Late arrivals (${late.length})`, cash(line.lateCharge ?? 0), lateDays(late)]);
  const took = (line.ssnit?.employee ?? 0) + (line.paye?.total ?? 0) + (line.loanTotal ?? 0) - over + (Number(line.lateCharge) || 0);
  return { rows, took: round2(took) };
}

/**
 * Build it.
 *
 * `line`     the payslip line as the closed month wrote it down
 * `company`  { legalName, address, phone, email, website, tin, ssnit }
 * `month`    'YYYY-MM'
 * `logo`     { bytes, mime } or null
 */
export async function payslipPdf({ line, company = {}, property = '', month, currency = 'GHS', logo = null, sentAt = null }) {
  const cash = cashOf(currency);
  const rates = line.rates ?? {};
  const nice = new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const name = company.legalName || property || 'The company';
  const doc = new PdfDoc({ title: `Payslip ${nice} · ${line.staff?.name ?? ''}`, author: name });
  const img = logo?.bytes ? await doc.addImage(logo.bytes, logo.mime) : null;
  const p = doc.addPage();

  // ---- the employer
  let x = M;
  if (img) { p.image(img, M, 46, 52, 52); x = M + 64; }
  p.text(x, 62, fit(name, RIGHT - x, 15, true), { size: 15, bold: true, color: INK });
  let y = 76;
  const lines = [
    String(company.address ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(', '),
    [company.phone, company.email, company.website].filter(Boolean).join(' · '),
    [company.tin ? `TIN ${company.tin}` : '', company.ssnit ? `SSNIT employer no. ${company.ssnit}` : ''].filter(Boolean).join(' · '),
  ].filter(Boolean);
  for (const l of lines) { p.text(x, y, fit(l, RIGHT - x, 8.5), { size: 8.5, color: DIM }); y += 11.5; }
  y = Math.max(y, 106) + 6;

  // ---- what and when
  p.line(M, y, RIGHT, y, { width: 1.6, color: INK });
  p.text(M, y + 17, 'PAYSLIP', { size: 11, bold: true, color: INK });
  p.text(RIGHT, y + 17, nice, { size: 10, color: DIM, align: 'right' });
  p.line(M, y + 26, RIGHT, y + 26, { color: RULE });
  y += 46;

  // ---- who
  const cells = [
    ['NAME', line.staff?.name || '—'],
    ['DEPARTMENT', line.staff?.department || '—'],
    ['EMPLOYEE NO.', line.staff?.employeeNo || '—'],
    ['SSNIT', line.ssnit?.qualifies ? 'Contributing' : 'Not a member'],
  ];
  const cw = (RIGHT - M) / 4;
  cells.forEach(([k, v], i) => {
    p.text(M + i * cw, y, k, { size: 7, bold: true, color: FAINT });
    p.text(M + i * cw, y + 13, fit(v, cw - 8, 9.5, true), { size: 9.5, bold: true, color: INK });
  });
  y += 36;

  // ---- earnings | deductions
  const colW = MID - M - 12;
  const L = M;
  const R0 = MID + 12;
  const head = (cx, label, at) => {
    p.text(cx, at, label, { size: 7.5, bold: true, color: DIM });
    p.line(cx, at + 5, cx + colW, at + 5, { color: RULE });
  };
  const row = (cx, at, label, value, note) => {
    p.text(cx, at, fit(label, colW - 90, 9.5), { size: 9.5, color: INK });
    p.text(cx + colW, at, value, { size: 9.5, color: INK, align: 'right' });
    if (note) { p.text(cx, at + 10.5, fit(note, colW - 10, 7.5), { size: 7.5, color: FAINT }); return at + 24; }
    return at + 16;
  };
  const total = (cx, at, label, value) => {
    p.line(cx, at - 10, cx + colW, at - 10, { width: 1, color: INK });
    p.text(cx, at + 2, label, { size: 9.5, bold: true, color: INK });
    p.text(cx + colW, at + 2, value, { size: 9.5, bold: true, color: INK, align: 'right' });
    return at + 18;
  };

  head(L, 'EARNINGS', y);
  head(R0, 'DEDUCTIONS', y);
  let ly = y + 22;
  const slip = line.slip ?? {};
  const b = line.bonus ?? { schemes: [] };
  ly = row(L, ly, 'Basic salary', cash(line.basic), line.partMonth ? `${line.partMonth.days} of ${line.partMonth.of} days` : null);
  for (const a of (slip.allowances ?? line.allowances ?? [])) ly = row(L, ly, a.name, cash(a.amount), a.taxable === false ? 'not taxed' : null);
  if (b.net) ly = row(L, ly, 'Bonus', cash(b.net));
  ly += 8;

  let ry = y + 22;
  const { rows, took } = deductionRows(line, cash, rates);
  for (const [label, value, note] of rows) ry = row(R0, ry, label, value, note);
  ry += 8;
  const at = Math.max(ly, ry);
  total(L, at, 'Gross pay', cash(line.gross));
  total(R0, at, 'Total deductions', cash(took));
  y = at + 24;

  // ---- net pay
  p.rect(M, y, RIGHT - M, 40, { fill: INK });
  p.text(M + 16, y + 24, 'NET PAY', { size: 8.5, bold: true, color: '#c9ced6' });
  p.text(RIGHT - 16, y + 27, cash(line.net), { size: 17, bold: true, color: '#ffffff', align: 'right' });
  y += 66;

  // ---- the working
  let wy = y;
  if (b.earned || b.docked) {
    head(L, 'HOW THE BONUS CAME OUT', wy);
    let by = wy + 22;
    for (const sc of (b.schemes ?? [])) by = row(L, by, sc.name, cash(sc.amount), `${cash(sc.award)} at ${round2(sc.score)}%`);
    if (b.docked) by = row(L, by, 'Less deductions for misconduct', `-${cash(b.docked)}`);
    if (b.notTaken) by = row(L, by, 'More was docked than the bonus could carry', cash(b.notTaken));
    by += 8;
    by = total(L, by, 'Bonus paid', cash(b.net));
    if (b.tax) {
      p.paragraph(L, by - 4, colW, `Agreed as what you receive. The ${cash(b.tax)} of tax on it is carried by the property, and is in the allowance above.`,
        { size: 7.5, color: DIM });
    }
  }
  head(R0, 'WHAT IT COST THE COMPANY', wy);
  let cy = wy + 22;
  cy = row(R0, cy, 'Gross pay', cash(line.gross));
  if (line.ssnit?.qualifies) cy = row(R0, cy, 'Employer SSNIT', cash(line.ssnit.employer), `${round2((rates.ssnitEmployer ?? 0) * 100)}% of basic`);
  cy += 8;
  total(R0, cy, 'Cost to the company', cash(line.employerCost));

  // ---- the foot
  p.line(M, 790, RIGHT, 790, { color: RULE });
  p.text(M, 803, fit(`${nice} is closed, so this payslip is a record and will not change. Keep it.`, RIGHT - M - 150, 7.5), { size: 7.5, color: FAINT });
  if (sentAt) p.text(RIGHT, 803, `Sent from HIVE on ${sentAt}`, { size: 7.5, color: FAINT, align: 'right' });
  void wy;

  return doc.build();
}

/** The file's name: Payslip-October-2026-Kwame-Asare.pdf. */
export function payslipFilename(month, name) {
  const nice = new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const clean = (s) => String(s ?? '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
  return `Payslip-${clean(nice)}-${clean(name) || 'staff'}.pdf`;
}
