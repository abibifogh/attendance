import { itemsToLines, redactJournalLines } from './pdf-lines.js';

/**
 * Reading the three shift files in the browser.
 *
 * The PDF and the spreadsheet are opened here, on the page, with two
 * libraries kept in this app's own folder (public/vendor) rather than fetched
 * from somebody else's server. What goes to Insight is only what the
 * reconciliation needs: the journal's lines with every guest's name and
 * address taken out, and the statement's card and MoMo rows without the
 * salaries and suppliers around them.
 */

const loaded = new Map();
function script(src) {
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => { loaded.delete(src); reject(new Error(`Could not load ${src}`)); };
      document.head.append(el);
    }));
  }
  return loaded.get(src);
}

/** The ASSD journal PDF → redacted lines. */
export async function readJournalPdf(file, progress = () => {}) {
  await script('/vendor/pdf.min.js');
  const pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const lines = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    lines.push(...itemsToLines(content.items));
    progress(`Reading page ${i} of ${doc.numPages}…`);
  }
  return { lines: redactJournalLines(lines), pages: doc.numPages };
}

const FINACLE_COLUMNS = ['TRAN ID', 'PART TRAN SRL NUM', 'PART TRAN TYPE', 'PSTD FLG', 'TRAN DATE', 'PSTD DATE',
  'TRAN AMT', 'TRAN PARTICULAR', 'REF NUM', 'DEL FLG'];
// Card credits, commission and MoMo, as the bank writes them. Everything
// else stays on this computer.
const WANTED = /^(comm_)?\d{6}\*{4,}\d{4}_|^GTB\/[^/]+\/\/|^[A-Z0-9]+ GTB[A-Z0-9]+\//;

/**
 * The bank statement → its header and the card and MoMo rows.
 *
 * Two kinds of file arrive. Internet banking's "Excel" download is really a
 * web page with an .xls name: it is read as a page, table by table. The
 * Finacle export is a real spreadsheet and goes through SheetJS. Either way
 * the header goes as the bank wrote it, and the server recognises both.
 */
export async function readStatement(file) {
  const head = new TextDecoder().decode(await file.slice(0, 2048).arrayBuffer()).replace(/^\uFEFF/, '').trimStart();
  const rows = /^</.test(head) ? await statementPageRows(file) : await statementSheetRows(file);
  const at = rows.findIndex((r) => (r || []).some((c) => /^(TRAN ID|TRANS DATE)$/i.test(String(c ?? '').trim())));
  if (at < 0) throw new Error('This does not look like the bank statement: there is no TRAN ID or Trans Date column.');
  const header = rows[at].map((c) => String(c ?? '').trim().toUpperCase());
  const particular = header.indexOf(header.includes('TRAN PARTICULAR') ? 'TRAN PARTICULAR' : 'REMARKS');
  if (particular < 0) throw new Error('The statement has no TRAN PARTICULAR or Remarks column.');

  // Only the columns the reconciliation reads: the Finacle export has sixty.
  const finacle = header.includes('TRAN ID');
  const index = finacle ? FINACLE_COLUMNS.map((name) => header.indexOf(name)) : header.map((_, i) => i);
  const kept = [finacle ? FINACLE_COLUMNS : rows[at]];
  let left = 0;
  for (const row of rows.slice(at + 1)) {
    if (!row || row.length <= particular) continue;
    if (!WANTED.test(String(row[particular] ?? '').trim())) { left += 1; continue; }
    kept.push(index.map((i) => (i < 0 ? null : row[i] ?? null)));
  }
  return { rows: kept, leftOut: left };
}

/** Internet banking's statement page → rows of cell text. */
async function statementPageRows(file) {
  const doc = new DOMParser().parseFromString(await file.text(), 'text/html');
  return [...doc.querySelectorAll('tr')]
    .map((tr) => [...tr.children].filter((c) => /^T[DH]$/.test(c.tagName)).map((c) => c.textContent.replace(/\s+/g, ' ').trim()));
}

/** The Finacle XLSX → rows of values. */
async function statementSheetRows(file) {
  await script('/vendor/xlsx.mini.min.js');
  const XLSX = window.XLSX;
  const book = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
  // Raw values: dates stay Excel serial numbers, which the server turns into
  // days without this computer's time zone getting a say.
  return XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, raw: true, defval: null });
}

/** The terminal report CSV → its text. */
export async function readTerminalCsv(file) {
  return { text: await file.text() };
}
