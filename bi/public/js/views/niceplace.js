import { h, mount, money } from '../util.js';
import { api } from '../api.js';
import { state } from '../app.js';
import { npReviewBox, npMoveBox } from './np-review.js';

/**
 * Nice Place, the public washroom: the counters each shift against the money
 * the income workbook reports for it, the toilets and the showers apart.
 * The link staff send the counters from, the workbook upload, and the
 * settings (names, walk-throughs by staff, prices) are here too.
 */

const SHIFT = { day: 'Day', night: 'Night' };
const FAC = { toilet: ['Toilet', ['gt', 'lt']], shower: ['Shower', ['gb', 'lb']] };
const COUNTER = { gb: 'GB · Gents bath', gt: 'GT · Gents toilet', lb: 'LB · Ladies bath', lt: 'LT · Ladies toilet' };
const STATUS = {
  bad: ['bad', '✕ Not adding up'], warn: ['warn', '! More people than paid'], over: ['warn', '! More money than people'],
  review: ['warn', '! Counter to read'], good: ['good', '✓ Fits'], 'no-revenue': ['none', 'Workbook not uploaded'], 'no-reading': ['none', 'No picture'], waiting: ['none', 'Waiting'],
};
const ANSWERS = ['Counter fault', 'Free use (staff, cleaning)', 'Staff to account for it', 'Explained'];
const dayText = (d, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
const whole = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-GB'));

/** `part: 'settings'` is Settings › Rules › Nice Place: names, prices, walk-throughs and the reader. */
export async function renderNicePlace(root, { part = null } = {}) {
  const isAdmin = (state.me?.account?.till?.role || (state.me?.account?.isOwner ? 'admin' : null)) === 'admin';
  const view = h('div.np');
  mount(root, view);
  let range = { from: null, to: null };
  let data = null;
  let open = null;
  let flash = null;

  async function load(message = null) {
    flash = message;
    const q = range.from ? `?from=${range.from}&to=${range.to}` : '';
    data = await api(`/np${q}`);
    range = { from: data.from, to: data.to };
    if (open && !data.rows.some((r) => r.key === open)) open = null;
    paint();
  }

  function paint() {
    if (part === 'settings') { mount(view, flash ? h(`div.banner.${flash[0]}`, flash[1]) : null, settingsBlock()); return; }
    const rows = data.rows;
    const count = (st) => rows.filter((r) => r.status === st && !r.answer).length;
    const waiting = rows.filter((r) => ['no-revenue', 'no-reading'].includes(r.status)).length;
    const toRead = rows.filter((r) => r.pending).length;
    mount(view,
      flash ? h(`div.banner.${flash[0]}`, flash[1]) : null,
      toRead ? h('div.banner.warning', `${toRead} picture${toRead === 1 ? '' : 's'} sent with a counter that could not be read. Open ${toRead === 1 ? 'it' : 'them'} below (“! Counter to read”) and read the number off the picture. Supervisors given Nice Place see ${toRead === 1 ? 'it' : 'them'} in their Inbox too.`) : null,
      h('section.card',
        h('div.np-bar',
          linkBlock(),
          h('span.np-grow'),
          uploadBlock())),
      h('div.np-tiles',
        tile('Shifts shown', rows.length, ''),
        tile('✕ Not adding up', count('bad'), 'bad'),
        tile('! More people than paid', count('warn') + count('over'), 'warn'),
        tile('Waiting: picture or workbook', waiting, '')),
      h('section.card', chartBlock(rows)),
      h('section.card', tableBlock(rows)),
      open ? detailBlock(rows.find((r) => r.key === open)) : null,
      isAdmin ? h('p.small.muted', 'Names on the link, prices and walk-throughs: Settings › Rules › Nice Place.') : null);
  }

  const tile = (label, n, tone) => h(`div.np-tile${tone ? `.${tone}` : ''}`, h('small', label), h('b.num', String(n)));

  // ---------------------------------------------------------------- link --
  function linkBlock() {
    if (!isAdmin) return h('span.small', data.link ? 'Staff send the counters from the Nice Place link.' : 'The Nice Place link is not made yet: an admin makes it.');
    const said = h('span.small');
    const make = async (again) => {
      if (again && !window.confirm('Make a new link? The old one stops working: send the new one to the staff.')) return;
      try { await api('/np/settings', { method: 'POST', body: { newLink: true } }); await load(['good', 'A new link is ready. Copy it and send it to the staff.']); } catch (err) { said.textContent = err.message; }
    };
    if (!data.link?.token) return h('span', h('b', 'Staff link '), h('button.btn.primary', { type: 'button', onclick: () => make(false) }, 'Make the link'), said);
    const url = `${location.origin}/np.html#${data.link.token}`;
    return h('span.np-link',
      h('b', 'Staff link'), h('code', url),
      h('button.btn', { type: 'button', onclick: async (e) => { try { await navigator.clipboard.writeText(url); e.target.textContent = 'Copied'; } catch { window.prompt('Copy the link:', url); } } }, 'Copy'),
      h('button.sh-link', { type: 'button', onclick: () => make(true) }, 'New link'), said);
  }

  // -------------------------------------------------------------- upload --
  function uploadBlock() {
    const said = h('span.small');
    const file = h('input', { type: 'file', accept: '.xlsx,.xls', hidden: true });
    file.onchange = async () => {
      const f = file.files[0];
      if (!f) return;
      said.textContent = 'Reading the workbook…';
      try {
        await script('/vendor/xlsx.mini.min.js');
        const book = window.XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' });
        const sheetName = book.SheetNames[0];
        const rows = window.XLSX.utils.sheet_to_json(book.Sheets[sheetName], { header: 1, raw: true, defval: null });
        const out = await api('/np/income', { method: 'POST', body: { rows, sheetName, fileName: f.name } });
        await load(['good', `Workbook read: ${out.saved} shifts, ${dayText(out.from)} to ${dayText(out.to)}.${out.problems.length ? ` Left out: ${out.problems.join(' ')}` : ''}`]);
      } catch (err) { said.textContent = err.message; }
      file.value = '';
    };
    return h('span.np-upload',
      data.revenueThrough ? h('span.small', `Workbook up to ${dayText(data.revenueThrough)}`) : h('span.small', 'No workbook uploaded yet'),
      isAdmin ? [h('button.btn', { type: 'button', onclick: template }, '⬇ Template'),
        h('button.btn.primary', { type: 'button', onclick: () => file.click() }, '⬆ Upload income workbook'), file] : null,
      said);
  }

  /** The workbook's layout, empty, for a month. */
  async function template() {
    await script('/vendor/xlsx.mini.min.js');
    const month = (data.to || new Date().toISOString()).slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const name = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }).toUpperCase();
    const rows = [
      [null, 'Toilet', null, null, null, null, null, 'Shower', null, null, null, null, null, null, null],
      ['Date', 'Day', null, null, 'Night', null, null, 'Day', null, null, 'Night', null, null, 'Shifts', null],
      [null, 'Adult', 'Child', 'Revenue', 'Adult', 'Child', 'Revenue', 'Adult', 'Child', 'Revenue', 'Adult', 'Child', 'Revenue', 'Day', 'Night'],
      ...Array.from({ length: days }, (_, i) => [i + 1]),
      ['Total'],
    ];
    const book = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(book, window.XLSX.utils.aoa_to_sheet(rows), `${name} ${String(y).slice(2)}`);
    window.XLSX.writeFile(book, `Nice_Place_Income_${name.charAt(0)}${name.slice(1).toLowerCase()}_${String(y).slice(2)}.xlsx`);
  }

  // --------------------------------------------------------------- chart --
  function chartBlock(rows) {
    const shown = rows.filter((r) => r.reading);
    // A round scale: steps of 50, 100, 200, 250, 500… cedis, four or five of them.
    const most = Math.max(100, ...shown.flatMap((r) => Object.values(r.facilities).flatMap((x) => [x.maxRevenue || 0, x.revenue || 0])));
    const step = [5000, 10000, 20000, 25000, 50000, 100000, 200000, 250000, 500000].find((s) => most / s <= 5) || 1000000;
    const top = Math.ceil(most / step) * step;
    const pct = (v) => `${Math.max(0, Math.min(100, (v / top) * 100))}%`;
    const ticks = Array.from({ length: top / step + 1 }, (_, i) => money(i * step, { places: 0 }));
    const strip = (r, f) => {
      const x = r.facilities[f];
      const [tone] = STATUS[x.status] || STATUS.waiting;
      const tip = x.revenue == null ? `${FAC[f][0]}: ${x.people ?? '—'} people, no revenue yet`
        : `${FAC[f][0]}: ${x.paying} paying people allow ${money(x.minRevenue)} to ${money(x.maxRevenue)}; reported ${money(x.revenue)}`;
      return h('div.np-strip', { title: tip },
        h('span.np-fac', FAC[f][0]),
        h('div.np-track',
          h('div.np-axis'),
          x.maxRevenue != null ? h('div.np-band', { style: `left:${pct(x.minRevenue)};width:calc(${pct(x.maxRevenue)} - ${pct(x.minRevenue)})` }) : null,
          x.usualRevenue != null ? h('div.np-usual', { style: `left:${pct(x.usualRevenue)}` }) : null,
          x.revenue != null ? h(`div.np-dot.${tone}`, { style: `left:${pct(x.revenue)}` }) : null));
    };
    return [
      h('h2', 'Money against the people counted'),
      h('p.sh-sub', 'For each shift, the toilets and the showers apart. The grey band is what the people counted allow: every one a child (left end) to every one an adult (right end), after the staff walk-throughs. The line is the usual mix of adults and children. The dot is what the workbook reports.'),
      shown.length ? h('div.np-chart',
        h('div.np-scale', h('span'), h('div', ticks.map((t) => h('span', t))), h('span')),
        shown.map((r) => h(`div.np-row${open === r.key ? '.on' : ''}`, { onclick: () => { open = r.key; paint(); document.querySelector('.np-detail')?.scrollIntoView({ behavior: 'smooth' }); } },
          h('span.np-when', h('b', dayText(r.day)), ` · ${SHIFT[r.shift].toLowerCase()}`),
          h('div.np-pair', strip(r, 'toilet'), strip(r, 'shower')),
          chip(r)))) : h('p', 'No counters sent for these days yet.'),
      h('div.np-legend',
        h('span', h('i.np-k-band'), 'What the people counted allow'), h('span', h('i.np-k-usual'), 'Usual mix'),
        h('span', h('i.np-k-dot.good'), '✓ Fits'), h('span', h('i.np-k-dot.warn'), '! More people than paid'), h('span', h('i.np-k-dot.bad'), '✕ Not adding up')),
    ];
  }

  const chip = (r) => {
    if (r.answer) return h('span.sh-chip.ok', `✓ ${r.answer.answer}`);
    const [tone, words] = STATUS[r.status] || STATUS.waiting;
    return h(`span.sh-chip.np-${tone}`, words);
  };

  // --------------------------------------------------------------- table --
  function tableBlock(rows) {
    const people = (r, c) => (r.moved ? Math.floor(r.moved[c] / 2) : '—');
    return [
      h('div.np-head', h('h2', 'Shift by shift'),
        h('span.np-range', h('input', { type: 'date', value: range.from, onchange: (e) => { range.from = e.target.value; } }), ' to ',
          h('input', { type: 'date', value: range.to, onchange: (e) => { range.to = e.target.value; } }),
          h('button.btn', { type: 'button', onclick: () => load() }, 'Show'))),
      h('div.np-scroll', h('table.np-table',
        h('thead', h('tr', h('th', 'Shift'), h('th', 'Picture'), ...['GB', 'GT', 'LB', 'LT'].map((c) => h('th.n', c)),
          h('th.n', 'Toilet people'), h('th.n', 'Paid for'), h('th.n', 'Toilet GH₵'), h('th.n', 'Shower people'), h('th.n', 'Paid for'), h('th.n', 'Shower GH₵'), h('th', ''))),
        h('tbody', rows.map((r) => h(`tr${open === r.key ? '.on' : ''}${r.status === 'bad' && !r.answer ? '.bad' : ''}`, { onclick: () => { open = r.key; paint(); } },
          h('td', h('b', dayText(r.day)), ` ${SHIFT[r.shift].toLowerCase()}`, h('small', r.reading?.name || r.pending?.name || r.staff || ''),
            r.pending ? h('small.np-typed', `${r.pending.pending.map((c) => c.toUpperCase()).join(', ')} not read yet`) : null,
            r.span ? h('small', `covers ${r.span.length} shifts`) : null, r.resets.length ? h('small', `${r.resets.map((c) => c.toUpperCase()).join(', ')} reset`) : null,
            r.reading?.differs?.length || r.reading?.unread?.length ? h('small.np-typed', `${[...(r.reading.differs || []), ...(r.reading.unread || [])].map((c) => c.toUpperCase()).join(', ')} typed, not as read`) : null,
            r.reading?.typed ? h('small.np-typed', 'typed: picture not read') : null),
          h('td', (r.reading || r.pending)?.photoId ? h('img.np-thumb', { src: `/api/np/photo/${(r.reading || r.pending).photoId}`, alt: '', loading: 'lazy' }) : h('span.muted', r.reading ? 'typed' : '—')),
          ...['gb', 'gt', 'lb', 'lt'].map((c) => h('td.n.num', String(people(r, c)))),
          ...['toilet', 'shower'].flatMap((f) => {
            const x = r.facilities[f];
            return [h('td.n.num', x.paying != null ? whole(x.paying) : '—'), h('td.n.num', x.reportedPeople != null ? whole(x.reportedPeople) : '—'), h('td.n.num', x.revenue != null ? money(x.revenue, { places: 0 }) : '—')];
          }),
          h('td', chip(r))))))),
      h('p.small.muted', 'People per counter is the movements since the shift before, halved. "Toilet people" and "Shower people" are after the staff walk-throughs; "Paid for" is the adults’ money ÷ the adult price plus the children’s ÷ the child price. Click a shift to open it.'),
    ];
  }

  // -------------------------------------------------------------- detail --
  function detailBlock(r) {
    if (!r) return null;
    const said = h('span.small');
    const set = async (path, body, words) => {
      said.textContent = 'Saving…';
      try { await api(path, { method: 'POST', body: { day: r.day, shift: r.shift, ...body } }); await load(['good', words]); } catch (err) { said.textContent = err.message; }
    };
    const notes = [];
    if (r.first) notes.push('The first reading: counted from zero, as the counters were set to zero at the start.');
    for (const c of r.resets) notes.push(`${c.toUpperCase()} is lower than at the shift before (${whole(r.before?.[c])} → ${whole(r.reading[c])}): it was reset, so it is counted from zero.`);
    if (r.reading?.differs?.length) notes.push(`Typed differently from what the picture was read as: ${r.reading.differs.map((c) => `${c.toUpperCase()} typed ${whole(r.reading[c])}, picture ${whole(r.reading.read[c])}`).join('; ')}. Look at the picture.`);
    if (r.reading?.typed) notes.push('The picture could not be read automatically when it was sent, so these numbers were typed. Look at the picture.');
    if (r.reading?.unread?.length) notes.push(`${r.reading.unread.map((c) => c.toUpperCase()).join(', ')} could not be read from the picture, so ${r.reading.unread.length === 1 ? 'it was' : 'they were'} typed. Look at the picture.`);
    if (r.span) notes.push(`No picture for ${r.span.slice(0, -1).map((x) => `${dayText(x.day)} ${SHIFT[x.shift].toLowerCase()}`).join(', ')}: these counts cover ${r.span.length} shifts, held against the money of all of them.`);
    const facility = (f) => {
      const x = r.facilities[f];
      const [name] = FAC[f];
      const rows = [
        ['People through the doors', x.people != null ? `${whole(x.people)} (${whole(x.movements)} movements ÷ 2)` : '—'],
        ['Less staff and cleaners', x.allowance != null ? `−${whole(x.allowance)}` : '—'],
        ['Should have paid', x.paying != null ? whole(x.paying) : '—'],
        ['If every one was a child', x.minRevenue != null ? money(x.minRevenue) : '—'],
        ['If every one was an adult', x.maxRevenue != null ? money(x.maxRevenue) : '—'],
        x.usualRevenue != null ? ['At the usual mix', money(x.usualRevenue)] : null,
        ['Reported in the workbook', x.revenue != null ? money(x.revenue) : 'not uploaded yet'],
        x.reportedPeople != null ? ['Paid for, by the workbook', `${whole(x.reportedPeople)} (${whole(x.adults)} adults, ${whole(x.children)} children)`] : null,
      ].filter(Boolean);
      return h('div.np-fac-box',
        h('h3', name),
        h('div.np-sums', rows.map(([a, b]) => h('div', h('span', a), h('b', b)))),
        verdict(x, name),
        x.sheetGap ? h('p.small', `The workbook’s adults and children come to ${money(x.adultMoney + x.childMoney)}, but its revenue says ${money(x.revenue)}.`) : null);
    };
    if (r.pending) {
      return h('section.card.np-detail',
        h('div.np-head', h('h2', `${dayText(r.day, { weekday: 'long', day: 'numeric', month: 'long' })} · ${SHIFT[r.shift]}`), h('button.sh-link', { type: 'button', onclick: () => { open = null; paint(); } }, 'Close')),
        h('p.sh-sub', 'Not counted yet: worked out once all four numbers are in.'),
        npReviewBox({ day: r.day, shift: r.shift, ...r.pending, before: r.before }, { after: (words) => load(['good', words]), canAct: isAdmin }));
    }
    const fix = isAdmin ? fixBlock(r, set) : null;
    return h('section.card.np-detail',
      h('div.np-head', h('h2', `${dayText(r.day, { weekday: 'long', day: 'numeric', month: 'long' })} · ${SHIFT[r.shift]}`), h('button.sh-link', { type: 'button', onclick: () => { open = null; paint(); } }, 'Close')),
      h('p.sh-sub', [r.reading ? `${r.reading.editedBy ? `Typed in Insight by ${r.reading.editedBy}` : `Sent by ${r.reading.name || 'somebody'} at ${String(r.reading.sentAt).slice(11, 16)}`}` : 'No reading for this shift', r.staff ? `On the workbook: ${r.staff}` : null].filter(Boolean).join(' · ')),
      h('div.np-cols',
        h('div',
          r.reading?.photoId ? h('a', { href: `/api/np/photo/${r.reading.photoId}`, target: '_blank', rel: 'noopener' }, h('img.np-photo', { src: `/api/np/photo/${r.reading.photoId}`, alt: 'The counters as sent' })) : h('div.np-nophoto', r.reading ? 'Typed in Insight: no picture' : 'No picture sent', isAdmin ? addPicture(r) : null),
          r.reading?.photoId ? h('div.np-check',
            r.reading.checkedBy ? [h('span', `✓ Numbers match the picture (${r.reading.checkedBy})`), h('button.sh-link', { type: 'button', onclick: () => set('/np/check', { ok: false }, 'Taken back.') }, 'Undo')]
              : [h('span', 'Do the numbers typed match the picture?'), h('button.btn', { type: 'button', onclick: () => set('/np/check', { ok: true }, 'Marked as matching the picture.') }, 'Yes'),
                isAdmin ? h('button.btn', { type: 'button', onclick: () => { const box = document.querySelector('.np-fix'); if (box) box.hidden = false; } }, 'Fix a number') : null]) : null,
          r.reading ? h('table.np-table.np-counters',
            h('thead', h('tr', h('th', ''), h('th.n', r.before ? `End of ${dayText(r.before.day)} ${SHIFT[r.before.shift].toLowerCase()}` : 'Start'), h('th.n', 'End of this shift'), h('th.n', 'Movements'), h('th.n', 'People'))),
            h('tbody', Object.entries(COUNTER).map(([c, label]) => h('tr',
              h('td', label), h('td.n.num', whole(r.before ? r.before[c] : 0)), h('td.n.num', whole(r.reading[c])), h('td.n.num', whole(r.moved[c])), h('td.n.num', whole(Math.floor(r.moved[c] / 2))))))) : null,
          notes.length ? h('ul.np-notes', notes.map((n) => h('li', n))) : null,
          r.reading && isAdmin ? npMoveBox({ day: r.day, shift: r.shift, photoId: r.reading.photoId, movedFrom: r.reading.movedFrom, movedBy: r.reading.movedBy }, { after: (words) => { open = null; return load(['good', words]); } }) : null,
          !isAdmin && r.reading?.movedFrom ? h('p.small.muted', `Moved here from ${dayText(r.reading.movedFrom.split('|')[0])} ${SHIFT[r.reading.movedFrom.split('|')[1]].toLowerCase()}${r.reading.movedBy ? ` by ${r.reading.movedBy}` : ''}.`) : null,
          fix),
        h('div', facility('toilet'), facility('shower'),
          ['bad', 'warn', 'over'].includes(r.status) || r.answer ? h('div.np-answer',
            r.answer ? [h('span', `✓ ${r.answer.answer}${r.answer.note ? `: ${r.answer.note}` : ''} (${r.answer.by})`), h('button.sh-link', { type: 'button', onclick: () => set('/np/answer', { answer: '' }, 'Answer taken back.') }, 'Undo')]
              : (() => {
                const note = h('input', { type: 'text', maxlength: '600', placeholder: 'What happened (optional)' });
                return [note, h('div.sh-answers', ANSWERS.map((a) => h('button', { type: 'button', onclick: () => set('/np/answer', { answer: a, note: note.value }, 'Answered.') }, a)))];
              })()) : null,
          said)));
  }

  function verdict(x, name) {
    const n = (v) => whole(v);
    const t = {
      bad: () => `✕ Not adding up. ${n(x.paying)} people should have paid for the ${name.toLowerCase()}s. Even if every one was a child, that is ${money(x.minRevenue)}. ${money(x.revenue)} was reported: at least ${money(x.minRevenue - x.revenue)} short.`,
      warn: () => (x.gap != null && x.gap > 0
        ? `! ${n(x.gap)} more people counted than paid for. ${n(x.paying)} should have paid; the workbook has ${n(x.reportedPeople)}.`
        : `! Lower than usual: at the usual mix, ${n(x.paying)} people bring about ${money(x.usualRevenue)}; ${money(x.revenue)} was reported.`),
      over: () => `! More money than people counted: ${money(x.revenue)} is more than even ${n(x.people)} adults would pay (${money(x.maxRevenue)}). A counter may not be counting.`,
      good: () => `✓ Fits. ${n(x.paying)} should have paid${x.reportedPeople != null ? `; the workbook has ${n(x.reportedPeople)}` : ''}, and ${money(x.revenue)} is within ${money(x.minRevenue)} to ${money(x.maxRevenue)}.`,
      'no-revenue': () => 'The workbook for this shift is not uploaded yet.',
      'no-reading': () => 'No picture of the counters for this shift.',
      waiting: () => 'Nothing to compare yet.',
    }[x.status] || (() => '');
    const tone = { bad: 'bad', warn: 'warn', over: 'warn', good: 'good' }[x.status] || 'none';
    return h(`p.np-verdict.${tone}`, t());
  }

  /**
   * A picture of the counters for a shift that has none. Read like one from
   * the link: with no reading, what is read becomes it (and a counter not read
   * waits to be typed); with numbers typed, they stay and the picture is held
   * against them.
   */
  function addPicture(r) {
    const said = h('span.small');
    const pick = h('input', { type: 'file', accept: 'image/*', hidden: true });
    pick.addEventListener('change', async () => {
      if (!pick.files[0]) return;
      said.textContent = 'Reading the picture…';
      try {
        const photo = await shrinkPicture(pick.files[0]);
        const out = await api('/np/upload', { method: 'POST', body: { day: r.day, shift: r.shift, photo } });
        const names = (cs) => cs.map((c) => c.toUpperCase()).join(', ');
        const read = ['gb', 'gt', 'lb', 'lt'].filter((c) => out.values[c] != null);
        let words;
        if (out.kept) {
          words = out.differs.length
            ? `Picture added. It reads differently from what was typed: ${out.differs.map((d) => `${d.counter.toUpperCase()} typed ${whole(d.typed)}, picture ${whole(d.read)}`).join('; ')}. Fix a number if the picture is right.`
            : `Picture added${read.length ? `, and it agrees with the numbers typed (${names(read)} read)` : ''}.`;
        } else {
          words = out.pending.length
            ? `Picture added. ${names(out.pending)} could not be read: type ${out.pending.length === 1 ? 'it' : 'them'} from the picture below.`
            : 'Picture added, and all four counters read off it. The shift is worked out.';
        }
        await load([out.differs?.length || out.pending?.length ? 'warning' : 'good', words]);
      } catch (err) { said.textContent = err.message; }
      pick.value = '';
    });
    return h('div.np-inline', { style: 'justify-content:center;margin-top:.6rem' },
      h('button.btn.primary', { type: 'button', onclick: (e) => { e.stopPropagation(); pick.click(); } }, '📷 Add the picture'), pick, said);
  }

  function fixBlock(r, set) {
    const inputs = Object.fromEntries(Object.keys(COUNTER).map((c) => [c, h('input', { inputmode: 'numeric', value: r.reading ? String(r.reading[c]) : '', 'aria-label': c.toUpperCase() })]));
    const box = h('div.np-fix', { hidden: Boolean(r.reading) },
      h('b', r.reading ? 'Fix the numbers' : 'Type the counters for this shift'),
      h('div.np-fixgrid', Object.entries(COUNTER).map(([c, label]) => h('label', h('small', label), inputs[c]))),
      h('button.btn.primary', { type: 'button', onclick: () => set('/np/reading', Object.fromEntries(Object.keys(COUNTER).map((c) => [c, inputs[c].value])), 'Saved. The shift is worked out again.') }, 'Save'));
    return box;
  }

  // ------------------------------------------------------------ settings --
  function settingsBlock() {
    const said = h('span.small');
    const save = async (body, words) => {
      said.textContent = 'Saving…';
      try { await api('/np/settings', { method: 'POST', body }); await load(['good', words]); } catch (err) { said.textContent = err.message; }
    };
    const name = h('input', { type: 'text', maxlength: '80', placeholder: 'Name' });
    const allowance = h('input', { type: 'number', min: '0', max: '500', value: String(data.settings.allowance) });
    const adult = h('input', { type: 'number', step: '0.5', min: '0', value: String(data.settings.adult / 100) });
    const child = h('input', { type: 'number', step: '0.5', min: '0', value: String(data.settings.child / 100) });
    const layout = h('input', { type: 'text', maxlength: '300', value: data.settings.layout || '', placeholder: 'Each counter is labelled GB, GT, LB or LT' });
    const active = data.staff.filter((p) => p.active);
    /** How the last picture went with the reader, and a way to try one: what it read, or exactly why not. */
    const readerBox = () => {
      const last = data.readLast;
      const out = h('div.np-readtest');
      const pick = h('input', { type: 'file', accept: 'image/*', hidden: true });
      pick.addEventListener('change', async () => {
        if (!pick.files[0]) return;
        mount(out, h('p.small', 'Reading the picture…'));
        try {
          const photo = await shrinkPicture(pick.files[0]);
          const res = await api('/np/read-test', { method: 'POST', body: { photo } });
          mount(out,
            h('img.np-photo', { src: photo, alt: 'The picture tried' }),
            res.ok
              ? h('p', h('b', '✓ Read: '), ['gb', 'gt', 'lb', 'lt'].map((c) => `${c.toUpperCase()} ${res.read[c] ?? 'not read'}`).join(' · '), res.read.problem ? ` (${res.read.problem})` : '')
              : h('p', h('b', 'Not read. '), (res.errors || []).join(' | ') || 'No reason given.'),
            res.raw ? h('pre.np-raw', res.raw) : null);
        } catch (err) { mount(out, h('p.small', err.message)); }
        pick.value = '';
      });
      return h('div',
        h('b', 'Reading the counters off the picture'),
        last ? h('p.small', `Last picture${last.test ? ' (a try from here)' : ''}, ${String(last.at).slice(0, 16)}: `,
          last.ok ? h('span', { style: 'color:var(--good)' }, 'read.') : h('span', { style: 'color:var(--critical, #b3261e)' }, `not read: ${(last.errors || []).join(' | ') || 'no reason given'}`))
          : h('p.small', 'No picture read yet.'),
        h('div.np-inline', h('button.btn', { type: 'button', onclick: () => pick.click() }, 'Try reading a picture'), pick),
        out);
    };
    return h('section.card.np-settings',
      h('h2', 'Nice Place'),
      h('div.np-setgrid',
        h('div',
          h('b', 'Names on the link'),
          h('div.np-names', active.length ? active.map((p) => h('span.sh-chip.none', p.name, h('button.sh-link', { type: 'button', 'aria-label': `Remove ${p.name}`, onclick: () => save({ removeId: p.id }, `${p.name} taken off the list.`) }, '×'))) : h('span.small', 'Nobody yet: add the staff who send the counters.')),
          h('div.np-inline', name, h('button.btn', { type: 'button', onclick: () => save({ addName: name.value }, `${name.value} added.`) }, 'Add'))),
        h('div',
          h('b', 'Walk-throughs by staff and cleaners'),
          h('p.small', 'Per counter, per shift. Each is a person who did not pay.'),
          h('div.np-inline', allowance, h('button.btn', { type: 'button', onclick: () => save({ allowance: allowance.value }, 'Saved.') }, 'Save'))),
        h('div',
          h('b', 'Prices, GH₵, for the toilet and the shower each'),
          h('div.np-inline', h('label', 'Adult ', adult), h('label', 'Child ', child), h('button.btn', { type: 'button', onclick: () => save({ adult: adult.value, child: child.value }, 'Prices saved.') }, 'Save'))),
        readerBox(),
        h('div',
          h('b', 'How the counters are laid out'),
          h('p.small', 'For reading the numbers off the picture. Leave empty if each counter has its label on it; otherwise say where each is, e.g. "left to right: GB, GT, LB, LT".'),
          h('div.np-inline', layout, h('button.btn', { type: 'button', onclick: () => save({ layout: layout.value }, 'Saved.') }, 'Save')))),
      said);
  }

  await load();
}

/** A picture made at most 1280 pixels across, as a JPEG data address: as the staff page sends it. */
async function shrinkPicture(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
    const scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.8);
  } finally { URL.revokeObjectURL(url); }
}

function script(src) {
  if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load the spreadsheet reader.'));
    document.head.append(s);
  });
}
