import { h, mount, money } from '../util.js';
import { api } from '../api.js';
import { state } from '../app.js';
import { npReviewBox, npMoveBox } from './np-review.js';

/**
 * Nice Place, the public washroom: what the desk sends each shift (the
 * takings, and a picture of the four door counters), and the people paid
 * for against the people counted. Today's two shifts and what needs somebody
 * first; then the figures, a chart, the staff on the desk, and each shift.
 * The desk link and the settings (names, walk-throughs, prices) are here too.
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

  let days = 7;
  let filter = 'all';

  async function load(message = null) {
    flash = message;
    const q = days ? `?days=${days}` : `?from=${range.from}&to=${range.to}`;
    data = await api(`/np${q}`);
    range = { from: data.from, to: data.to };
    if (open && !data.rows.some((r) => r.key === open)) open = null;
    paint();
  }

  const shiftOf = (key) => data.rows.find((r) => r.key === key);
  function openShift(key) { open = key; paint(); setTimeout(() => document.querySelector('.np-detail')?.scrollIntoView({ behavior: 'smooth' }), 30); }

  function paint() {
    if (part === 'settings') { mount(view, flash ? h(`div.banner.${flash[0]}`, flash[1]) : null, settingsBlock()); return; }
    const g = data.glance;
    mount(view,
      flash ? h(`div.banner.${flash[0]}`, flash[1]) : null,
      h('div.npg-head', h('p.npg-lede', 'Each shift the desk sends its takings and a picture of the four door counters. Insight sets the people paid for against the people counted.'), h('span.sp'),
        h('div.seg', [[1, 'Today'], [7, '7 days'], [30, '30 days']].map(([n, label]) => h('button', {
          type: 'button', 'aria-selected': String(days === n), onclick: () => { days = n; load(); },
        }, label))),
        isAdmin ? h('button.btn', { type: 'button', onclick: linkDialog }, '🔗 Desk link') : null),
      h('div.npg-now', g.today.map(shiftCard), needsCard(g)),
      tilesRow(g),
      h('div.npg-two', h('section.card.npg-chartbox', chartBlock(g)), h('section.card', staffBlock(g))),
      h('section.card', tableBlock(data.rows, g)),
      open ? detailBlock(shiftOf(open)) : null,
      isAdmin ? h('p.small.muted', 'Prices, staff walk-throughs and names on the desk link: Settings › Rules › Nice Place.') : null);
  }

  // ------------------------------------------------------------- today --
  const cedis = (minor) => money(minor || 0, { places: 0 });
  const pct = (a, b) => (b ? `${Math.max(0, Math.min(100, (a / b) * 100))}%` : '0%');
  function meter(paid, counted) {
    if (counted == null || paid == null || !counted) return null;
    const p = Math.min(paid, counted);
    return h('div.npg-meter', h('i.p', { style: `width:${pct(p, counted)}` }), counted > p ? h('i.u', { style: `width:${pct(counted - p, counted)}` }) : null);
  }
  function statusChip(st, notPaid) {
    if (st === 'good') return h('span.npg-chip.ok', '✓ Adds up');
    if (st === 'bad' || st === 'warn') return h('span.npg-chip.bad', notPaid ? `! ${notPaid} not paid for` : '! Less money than people');
    if (st === 'over') return h('span.npg-chip.warn', '! More money than people');
    if (st === 'review') return h('span.npg-chip.warn', '! Counter to read');
    if (st === 'no-revenue') return h('span.npg-chip.no', 'No takings sent');
    if (st === 'no-reading') return h('span.npg-chip.no', 'No picture');
    return h('span.npg-chip.no', 'Waiting');
  }
  function shiftCard(t) {
    const title = h('div.npg-top', h('b', `Today · ${SHIFT[t.shift]}`), h('small', t.hours), h('span.sp'),
      t.state === 'sent' ? statusChip(t.status, t.notPaid) : t.state === 'on' ? h('span.npg-chip.live', 'On now')
        : t.state === 'missing' ? h('span.npg-chip.bad', 'Not sent') : h('span.npg-chip.no', 'Later'));
    if (t.state === 'sent') {
      return h('div.npg-shift', title,
        h('div.npg-big', h('b', cedis(t.revenue)), h('span', `sent ${t.at || ''}${t.by ? ` by ${t.by}` : ''}${t.late ? ' · late' : ''}`)),
        h('div.npg-facts', h('div', h('small', 'Counted'), h('b', t.counted ?? '—')), h('div', h('small', 'Paid for'), h('b', t.paid ?? '—')), h('div', h('small', 'Not paid'), h('b', t.notPaid ?? '—'))),
        meter(t.paid, t.counted),
        h('button.sh-link', { type: 'button', onclick: () => openShift(`${t.day}|${t.shift}`) }, 'Open the shift'));
    }
    if (t.state === 'missing') {
      return h('div.npg-shift', title, h('div.npg-big', h('b.muted', '—'), h('span', `Nothing sent: it was due at ${t.due}.`)),
        h('p.npg-hint', 'You were told at ', t.chase, '. Ask the desk to send it from the desk link.'));
    }
    return h('div.npg-shift', title,
      h('div.npg-big', h('b.muted', '—'), h('span', t.state === 'on' ? `report due ${t.due}` : `starts ${t.hours.split('–')[0]}`)),
      h('div.npg-facts',
        h('div', h('small', 'Same shift last week'), h('b', t.lastWeek != null ? cedis(t.lastWeek) : '—')),
        h('div', h('small', 'Usual'), h('b', t.usual ? `${cedis(t.usual[0])}–${cedis(t.usual[1]).replace('GH₵', '')}` : '—')),
        h('div', h('small', 'Chased at'), h('b', t.chase))),
      h('p.npg-hint', `If it is not sent by ${t.chase}, you are told.`));
  }

  function needsCard(g) {
    const n = g.needs;
    const when = (x) => `${dayText(x.day)} ${SHIFT[x.shift].toLowerCase()}`;
    const items = [];
    if (n.toRead.length) items.push([n.toRead.length, `Picture${n.toRead.length === 1 ? '' : 's'} with a counter Insight could not read`, 'Read the number off the picture', 'Read them', () => openShift(`${n.toRead[0].day}|${n.toRead[0].shift}`)]);
    if (n.missing.length) items.push([n.missing.length, `Shift${n.missing.length === 1 ? '' : 's'} with nothing sent`, n.missing.slice(0, 3).map(when).join(', ') + (n.missing.length > 3 ? '…' : ''), 'See', () => { filter = 'look'; paint(); }]);
    for (const x of n.sensors) {
      items.push(x.kind === 'stuck'
        ? [1, `${COUNTER[x.counter].split(' · ')[1]} counter not moving`, `${x.counter.toUpperCase()} has not moved for ${x.shifts} shifts while the others have: the sensor may be off`, null, null]
        : [1, `${COUNTER[x.counter].split(' · ')[1]} counter jumped`, `${x.counter.toUpperCase()} moved ${whole(x.moved)} on ${when(x)}; usually about ${whole(x.usual)}. Look at the picture`, 'Look', () => openShift(`${x.day}|${x.shift}`)]);
    }
    if (n.notPaid.length) items.push([n.notPaid.length, `Shift${n.notPaid.length === 1 ? '' : 's'} with more people than paid`, n.notPaid.slice(0, 2).map((x) => `${when(x)}: ${x.notPaid ?? '?'} not paid for`).join(' · '), 'See', () => { filter = 'look'; paint(); }]);
    if (n.envelopes.shifts) items.push([n.envelopes.shifts, `Envelope${n.envelopes.shifts === 1 ? '' : 's'} not picked up`, `${cedis(n.envelopes.amount)} in the safe since ${dayText(n.envelopes.since)}`, 'Pickups', () => { location.hash = '#/np-pickups'; }]);
    const count = items.length;
    return h(`div.npg-needs${count ? '' : '.calm'}`,
      h('div.npg-top', h('b', 'Needs you'), h('span.sp'), count ? h('span.npg-chip.warn', String(count)) : h('span.npg-chip.ok', '✓')),
      count ? items.map(([num, title, sub, label, go]) => h('div.npg-need',
        h('span.npg-n', String(num)), h('span.npg-t', title, h('small', sub)),
        label ? h('button.sh-link', { type: 'button', onclick: go }, `${label} ›`) : null))
        : h('p.npg-hint', 'Nothing needs you: every shift is sent, read and adds up.'));
  }

  function tilesRow(g) {
    const t = g.tiles;
    const span = days === 1 ? 'today' : days ? `${days} days` : 'these days';
    const tile = (label, big, sub, tone = '') => h(`div.npg-tile${tone ? `.${tone}` : ''}`, h('small', label), h('b', big), h('em', sub));
    return h('div.npg-tiles',
      tile(`Takings · ${span}`, cedis(t.takings), [`toilet ${cedis(t.toilet).replace('GH₵', '')} · shower ${cedis(t.shower).replace('GH₵', '')}`,
        t.change != null ? h(`span.${t.change >= 0 ? 'up' : 'down'}`, ` · ${t.change >= 0 ? '▲' : '▼'} ${Math.abs(t.change)}%`) : null]),
      tile('People counted', whole(t.counted), 'after staff walk-throughs'),
      tile('Paid for', t.paidPct != null ? `${t.paidPct}%` : '—', `${whole(t.paid)} of ${whole(t.counted)}`),
      tile('Not paid for', whole(t.notPaid), `≈ ${cedis(t.notPaidMoney)} at the usual mix`, t.notPaid ? 'red' : ''),
      tile('Reports sent', `${t.sent} of ${t.expected}`, `${t.onTime} on time${t.missing ? ` · ${t.missing} missing` : ''}`, t.missing ? 'amber' : ''));
  }

  // --------------------------------------------------------------- chart --
  function chartBlock(g) {
    const most = Math.max(10, ...g.chart.flatMap((d) => d.shifts.map((x) => Math.max(x.counted || 0, x.paid || 0))));
    const step = [10, 20, 25, 50, 100, 200, 250, 500].find((v) => most / v <= 4) || 1000;
    const top = Math.ceil(most / step) * step;
    const y = (v) => `${(v / top) * 100}%`;
    const wide = g.chart.length > 10;
    return [
      h('div.npg-row', h('h2', 'People counted, and how many paid'), h('span.sp'),
        h('div.npg-legend', h('span', h('i.p'), 'Paid for'), h('span', h('i.u'), 'Not paid for'), h('span', h('i.miss'), 'Nothing sent'), h('span', h('i.read'), 'Counter to read'), h('span', h('i.dot'), 'More paid than counted'))),
      h('p.npg-hint', 'Each day: the day shift, then the night. The height is the people the counters saw, after staff walk-throughs; the red top is those not paid for.'),
      h('div.npg-chart',
        Array.from({ length: top / step }, (_, i) => h('div.npg-grid', { style: `bottom:${y((i + 1) * step)}` }, h('span', String((i + 1) * step)))),
        g.chart.map((d) => h('div.npg-day', d.shifts.map((x) => {
          const label = `${dayText(d.day)} ${SHIFT[x.shift].toLowerCase()}`;
          if (x.state === 'missing') return h('div.npg-bar.miss', { title: `${label}: nothing sent`, onclick: () => openShift(`${d.day}|${x.shift}`) });
          if (x.state === 'toread') return h('div.npg-bar.read', { title: `${label}: a counter to read`, onclick: () => openShift(`${d.day}|${x.shift}`) });
          if (x.state !== 'ok') return h('div.npg-bar.none', { title: `${label}: ${x.state === 'on' ? 'on now' : x.state === 'later' ? 'later' : 'no counters'}` });
          const p = Math.min(x.paid ?? x.counted, x.counted);
          return h('div.npg-bar', { title: `${label}: ${x.paid ?? '—'} paid for of ${x.counted} counted · ${cedis(x.revenue)}`, onclick: () => openShift(`${d.day}|${x.shift}`) },
            x.paid != null && x.counted > p ? h('i.u', { style: `height:${y(x.counted - p)}` }) : null,
            h('i.p', { style: `height:${y(p)}` }),
            x.paid != null && x.paid > x.counted ? h('span.dot', { style: `bottom:calc(${y(x.counted)} + 4px)` }) : null);
        })))),
      h('div.npg-x', g.chart.map((d) => h('span', wide ? String(Number(d.day.slice(8))) : [h('b', dayText(d.day, { weekday: 'short', day: 'numeric' })), 'D · N']))),
    ];
  }

  function staffBlock(g) {
    return [
      h('h2', 'On the desk'),
      g.staff.length ? h('table.npg-table',
        h('thead', h('tr', h('th', 'Name'), h('th.n', 'Shifts'), h('th.n', 'On time'), h('th.n', 'Paid for'))),
        h('tbody', g.staff.map((p) => h('tr', h('td', h('b', p.name)), h('td.n', String(p.shifts)), h('td.n', String(p.onTime)), h('td.n', p.paidPct != null ? `${p.paidPct}%` : '—')))))
        : h('p.npg-hint', 'Nothing sent in these days.'),
      h('h2', { style: 'margin-top:1rem' }, 'Envelopes'),
      g.needs.envelopes.shifts
        ? h('p', h('b', `${g.needs.envelopes.shifts} shift${g.needs.envelopes.shifts === 1 ? '' : 's'}`), ` not picked up: ${cedis(g.needs.envelopes.amount)} in the safe since ${dayText(g.needs.envelopes.since)}. `, h('a', { href: '#/np-pickups' }, 'Pickups ›'))
        : h('p.npg-hint', 'Every envelope is picked up.'),
    ];
  }

  // --------------------------------------------------------------- table --
  function tableBlock(rows, g) {
    const look = (r) => (['bad', 'warn', 'over', 'review'].includes(r.status) && !r.answer) || (!g.sent[r.key]?.at && g.sent[r.key]?.revenue == null);
    const shown = filter === 'look' ? rows.filter(look) : rows;
    const fac = (r, f) => {
      const x = r.facilities[f];
      const own = g.sent[r.key]?.[f];
      if (own == null) return h('td.n', '—');
      return h('td.n', cedis(own), x.paying != null && x.reportedPeople != null ? h('small', `${whole(x.reportedPeople)} paid · ${whole(x.paying)} counted`) : null);
    };
    return [
      h('div.npg-row', h('h2', 'Shift by shift'), h('span.sp'),
        h('div.seg', [['all', 'All'], ['look', 'Needs a look']].map(([k, label]) => h('button', { type: 'button', 'aria-selected': String(filter === k), onclick: () => { filter = k; paint(); } }, label))),
        h('span.np-range', h('input', { type: 'date', value: range.from, 'aria-label': 'From', onchange: (e) => { range.from = e.target.value; } }), ' to ',
          h('input', { type: 'date', value: range.to, 'aria-label': 'To', onchange: (e) => { range.to = e.target.value; } }),
          h('button.btn', { type: 'button', onclick: () => { days = null; load(); } }, 'Show'))),
      shown.length ? h('div.np-scroll', h('table.npg-table.npg-shifts',
        h('thead', h('tr', h('th', 'Shift'), h('th', 'Sent'), h('th.n', 'Toilet'), h('th.n', 'Shower'), h('th', 'Paid for / counted'), h('th', 'Envelope'), h('th', ''))),
        h('tbody', shown.map((r) => {
          const s = g.sent[r.key] || {};
          const nothing = !s.at && s.revenue == null && !r.pending;
          return h(`tr${open === r.key ? '.on' : ''}${nothing ? '.gap' : ''}`, { onclick: () => openShift(r.key) },
            h('td', h('b', dayText(r.day)), ` ${SHIFT[r.shift].toLowerCase()}`, r.span ? h('small', `covers ${r.span.length} shifts`) : null),
            nothing ? h('td.muted', { colspan: '5' }, 'Nothing sent.')
              : [
                h('td', s.by || '—', s.at ? h('small', `${String(s.at).slice(11, 16)} · ${s.late ? 'late' : 'on time'}`) : null),
                fac(r, 'toilet'), fac(r, 'shower'),
                h('td', r.pending ? h('small', `${r.pending.pending.map((c) => c.toUpperCase()).join(', ')} not read yet`) : [meter(s.paid, s.counted), s.counted != null ? h('small', `${s.paid ?? '—'} / ${s.counted}`) : h('small', '—')]),
                h('td', s.envelope === 'safe' ? h('span.npg-chip.no', 'In the safe') : s.envelope === 'picked' ? h('span.npg-chip.ok', 'Picked up') : h('small', '—')),
              ],
            h('td', r.answer ? h('span.npg-chip.ok', `✓ ${r.answer.answer}`) : nothing ? h('span.npg-chip.bad', 'Not sent') : statusChip(r.status, s.notPaid)));
        })))) : h('p.npg-hint', filter === 'look' ? 'Nothing needs a look in these days.' : 'Nothing in these days.'),
      h('p.small.muted', 'Open a shift for its picture, the four counters (GB, GT, LB, LT), adults and children, and to correct or move it.'),
    ];
  }

  // ---------------------------------------------------------- desk link --
  function linkDialog() {
    const close = () => shade.remove();
    const body = h('div');
    const card = h('div.fl-card', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Desk link' },
      h('div.npg-row', h('h2', 'Desk link'), h('span.sp'), h('button.sh-link', { type: 'button', onclick: close }, 'Close')), body);
    const shade = h('div.fl-dlg', { onclick: (e) => { if (e.target === shade) close(); } }, card);
    mount(body, linkBlock());
    document.body.append(shade);
  }

  // ---------------------------------------------------------------- link --
  function linkBlock() {
    if (!isAdmin) return h('span.small', data.link ? 'Staff send the counters from the Nice Place link.' : 'The Nice Place link is not made yet: an admin makes it.');
    const said = h('span.small');
    const make = async (again) => {
      if (again && !window.confirm('Make a new link? The old one stops working: send the new one to the staff.')) return;
      try { await api('/np/settings', { method: 'POST', body: { newLink: true } }); document.querySelector('.fl-dlg')?.remove(); await load(['good', 'A new link is ready. Copy it and send it to the staff.']); } catch (err) { said.textContent = err.message; }
    };
    if (!data.link?.token) return h('span', h('button.btn.primary', { type: 'button', onclick: () => make(false) }, 'Make the link'), said);
    // The short link (/niceplace) when an ending is set, the long one with its code otherwise.
    const url = data.link.slug ? `${location.origin}/${data.link.slug}` : `${location.origin}/np#${data.link.token}`;
    const ending = h('input.np-slug', { type: 'text', value: data.link.slug || '', placeholder: 'niceplace', 'aria-label': 'The link’s ending', maxlength: '30' });
    const setEnding = async () => {
      try {
        await api('/np/settings', { method: 'POST', body: { slug: ending.value } });
        document.querySelector('.fl-dlg')?.remove();
        await load(['good', ending.value.trim() ? `The link is now ${location.origin}/${ending.value.trim().toLowerCase()}. The old one stops working: send the new one to the staff.` : 'The short link is taken away; the long one works.']);
      } catch (err) { said.textContent = err.message; }
    };
    return h('div.np-link',
      h('code', url),
      h('div.np-inline', h('button.btn', { type: 'button', onclick: async (e) => { try { await navigator.clipboard.writeText(url); e.target.textContent = 'Copied'; } catch { window.prompt('Copy the link:', url); } } }, 'Copy'),
        h('button.sh-link', { type: 'button', onclick: () => make(true) }, 'New link')),
      h('span.np-ending', h('small', `${location.origin}/`), ending, h('button.btn', { type: 'button', onclick: setEnding }, 'Set the ending')),
      h('small.np-apphint', 'Open it once in Chrome on the desk phone and press “Put Nice Place on this phone”: it says how to add it to the home screen, where it opens with one tap. A new link, or a new ending, stops the old one. (With ?app at the end of the link it is put on as an app instead; an old phone may not start it.)'), said);
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
        ['Sent from the desk', x.revenue != null ? money(x.revenue) : 'not sent'],
        x.reportedPeople != null ? ['Paid for, by the takings', `${whole(x.reportedPeople)} (${whole(x.adults)} adults, ${whole(x.children)} children)`] : null,
      ].filter(Boolean);
      return h('div.np-fac-box',
        h('h3', name),
        h('div.np-sums', rows.map(([a, b]) => h('div', h('span', a), h('b', b)))),
        verdict(x, name),
        null);
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
      h('p.sh-sub', [r.reading ? `${r.reading.editedBy ? `Typed in Insight by ${r.reading.editedBy}` : `Sent by ${r.reading.name || 'somebody'} at ${String(r.reading.sentAt).slice(11, 16)}`}` : 'No reading for this shift', null].filter(Boolean).join(' · ')),
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
        ? `! ${n(x.gap)} more people counted than paid for. ${n(x.paying)} should have paid; the takings are for ${n(x.reportedPeople)}.`
        : `! Lower than usual: at the usual mix, ${n(x.paying)} people bring about ${money(x.usualRevenue)}; ${money(x.revenue)} was reported.`),
      over: () => `! More money than people counted: ${money(x.revenue)} is more than even ${n(x.people)} adults would pay (${money(x.maxRevenue)}). A counter may not be counting.`,
      good: () => `✓ Fits. ${n(x.paying)} should have paid${x.reportedPeople != null ? `; the takings are for ${n(x.reportedPeople)}` : ''}, and ${money(x.revenue)} is within ${money(x.minRevenue)} to ${money(x.maxRevenue)}.`,
      'no-revenue': () => 'No takings sent from the desk for this shift.',
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
