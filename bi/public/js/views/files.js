import { h, mount, num, shortDay } from '../util.js';
import { api } from '../api.js';
import { readJournalPdf, readStatement, readTerminalCsv } from '../shift-files.js';

/**
 * The three shift files: a box for each, and which days each covers.
 *
 * Shared by Shifts → Files and by the Upload page an uploader sees, so the two
 * load files the same way. The files are opened on this computer; only the
 * amounts, times and ASSD user names are sent.
 */

const dayText = (day, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => new Date(`${day}T12:00:00Z`)
  .toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });

export function filesPanel(v, { coverage = {}, uploads = [], canUpload = false, end, onLoaded }) {
  const c = coverage || {};
  const last = (kind) => uploads.find((u) => u.kind === kind);
  const FILES = [
    { kind: 'journal', title: 'ASSD detail journal', ext: 'PDF', colour: 'var(--series-8)', accept: '.pdf,application/pdf', cover: c.journal,
      what: '“Detail Journal of every Transaction”, printed to PDF. Run it one day past the last shift you want. Guest names and addresses are removed on this computer before anything is sent.' },
    { kind: 'terminal', title: 'Card terminal report', ext: 'CSV', colour: 'var(--series-1)', accept: '.csv,text/csv', cover: c.terminal,
      what: 'The CSV from the bank’s card portal: every tap, approved or declined, to the second.' },
    { kind: 'bank', title: 'GTBank statement', ext: 'XLS', colour: 'var(--series-6)', accept: '.xls,.xlsx,.htm,.html', cover: c.bank,
      what: 'The .xls from internet banking (the Finacle XLSX works too). Card settlements, MoMo and commission are read; salaries and suppliers stay on this computer.' },
  ];

  const drop = (f) => {
    const said = h('p.small');
    const input = h('input', { type: 'file', accept: f.accept });
    const card = h('div.sh-drop', { style: `--fc:${f.colour}` },
      h('span.fi', f.ext), h('h3', f.title), h('p', f.what),
      h('p', { style: 'color:var(--muted)' }, f.cover ? `Loaded: ${shortDay(f.cover.from)} to ${shortDay(f.cover.to)}` : 'Nothing loaded yet.'),
      last(f.kind) ? h('p', { style: 'color:var(--muted)' }, `Last: ${last(f.kind).name || 'a file'}, ${String(last(f.kind).at).slice(0, 16)} by ${last(f.kind).by}. ${last(f.kind).note || ''}`) : null,
      canUpload ? h('label.go', input, 'Choose the file') : h('p', { style: 'color:var(--muted)' }, 'An owner loads this file.'),
      said);
    const run = async (file) => {
      if (!file || !canUpload) return;
      input.disabled = true;
      said.className = 'small';
      said.textContent = 'Reading the file on this computer…';
      try {
        let result;
        if (f.kind === 'journal') {
          const { lines, pages } = await readJournalPdf(file, (t) => { said.textContent = t; });
          said.textContent = `Read ${pages} pages. Sending the amounts to Insight…`;
          result = await api('/shifts/journal', { method: 'POST', body: { lines, name: file.name } });
        } else if (f.kind === 'bank') {
          const { rows, leftOut } = await readStatement(file);
          said.textContent = `Sending ${num(rows.length - 1)} card and MoMo rows to Insight…`;
          result = await api('/shifts/bank', { method: 'POST', body: { rows, leftOut, name: file.name } });
        } else {
          const { text } = await readTerminalCsv(file);
          result = await api('/shifts/terminal', { method: 'POST', body: { text, name: file.name } });
        }
        await onLoaded(file, result);
      } catch (err) {
        said.className = 'small form-error';
        said.textContent = err.message;
        input.disabled = false;
      }
    };
    input.addEventListener('change', () => run(input.files?.[0]));
    if (canUpload) {
      card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('over'); });
      card.addEventListener('dragleave', () => card.classList.remove('over'));
      card.addEventListener('drop', (e) => { e.preventDefault(); card.classList.remove('over'); run(e.dataTransfer?.files?.[0]); });
    }
    return card;
  };

  // Coverage over the month `end` falls in.
  const y = Number(end.slice(0, 4));
  const m = Number(end.slice(5, 7));
  const length = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthDays = Array.from({ length }, (_, k) => `${end.slice(0, 7)}-${String(k + 1).padStart(2, '0')}`);
  const inCover = (cover, d) => cover && d >= cover.from && d <= cover.to;
  const cover = h('div.sh-cover', { style: `grid-template-columns: 8rem repeat(${length}, minmax(0, 1fr))` },
    h('span'), monthDays.map((d) => h('span.h', String(Number(d.slice(8))))),
    FILES.map((f) => [h('span', f.title.replace('ASSD detail ', 'ASSD ').replace('Card terminal report', 'Terminal')),
      monthDays.map((d) => h('span.d', { title: shortDay(d), style: inCover(f.cover, d) ? `background:${f.colour}` : '' }))]));

  mount(v,
    h('p.sh-sub', 'Files are opened on this computer. Only amounts, times and ASSD user names are sent. Loading the same file twice changes nothing; a newer one updates the days it covers. You can also drop a file on its box.'),
    h('div.sh-files', FILES.map(drop)),
    h('section.card',
      h('div.sh-cardhead', h('div', h('h2', `What ${dayText(end, { month: 'long', year: 'numeric' })} has so far`),
        h('p.sh-sub', 'Which days each file covers. A shift is fully checked only where all three overlap.'))),
      h('div', { style: 'overflow-x:auto' }, cover)));
}

/**
 * The whole screen for somebody whose account only uploads: the three boxes,
 * and nothing about what is in them.
 */
export async function renderUpload(root) {
  const view = h('div.sh');
  mount(root, view);
  const paint = async (notice = null) => {
    const d = await api('/shifts/files');
    const v = h('div');
    mount(view,
      h('div.sh-head', h('h1', 'Upload files')),
      notice,
      v);
    filesPanel(v, {
      ...d, end: new Date().toISOString().slice(0, 10),
      onLoaded: (file, result) => paint(h('div.banner.good', h('strong', `${file.name} loaded. `), result.note || '')),
    });
  };
  await paint();
}
