import { h, mount } from '../util.js';
import { api } from '../api.js';
import { banner } from './components.js';

/**
 * Reports › Team (admins): what is on each person's table across the apps,
 * what is holding them back, and how they are doing.
 *
 * Everybody: a row each with today in HIVE, Doing, Due, Overdue, Done,
 * Asked, their rating and the first thing holding them back; Day, Week or
 * Month. One person: the four lists (Overdue, Doing now, Coming up, Done),
 * what holds them back with where to clear it, what they asked for; a month
 * adds its days. Their Evaluation: the rating and its eight measures, the
 * patterns behind them, strengths and things to watch, what to talk about,
 * the admin's notes and own measures; printed for an appraisal.
 */

const APP_TAG = { hive: 'HIVE', insight: 'Insight', breakfast: 'Breakfast', maintenance: 'Maintenance', teamtasks: 'Team Tasks', pos: 'POS', odoo: 'Odoo' };
const COLOURS = ['#d6402f', '#0e9f6e', '#5b3df5', '#e8a10c', '#2f6bff', '#be185d', '#0f766e', '#7c3aed'];
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dayText = (d, o = { weekday: 'short', day: 'numeric', month: 'short' }) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { ...o, timeZone: 'UTC' }) : '');
const avatar = (name, id, big = false) => h(`span.tm-av${big ? '.big' : ''}`, { style: `background:${COLOURS[Number(id) % COLOURS.length]}` }, String(name || '?').trim().charAt(0).toUpperCase());
const tag = (app) => h(`span.tm-tag.a-${app}`, APP_TAG[app] || app);
const grade = (s) => (s >= 3.7 ? 'gr' : s >= 3 ? 'am' : 'red');
const first = (name) => String(name || '').split(' ')[0];
const num = (n, tone = '') => h(`span.tm-num${n ? (tone ? `.${tone}` : '') : '.z'}`, String(n));

let view = 'all'; // all | person
let who = null;
let period = 'week';
let anchor = today();
let dept = '';
let tab = 'lists'; // lists | eval

export async function renderTeam(root) {
  const box = h('div.tm');
  mount(root, box);
  // Opened from Team › Evaluations: straight to that person's evaluation.
  try {
    const go = JSON.parse(sessionStorage.getItem('insight-team-open') || 'null');
    sessionStorage.removeItem('insight-team-open');
    if (go?.id) { who = go.id; view = 'person'; tab = go.tab || 'lists'; }
  } catch { /* private mode */ }
  await paint();

  async function paint(message = null) {
    if (view === 'person' && who) { await personPage(message); return; }
    let d;
    try { d = await api(`/team?period=${period}&day=${anchor}`); } catch (err) { mount(box, banner('problem', err.message)); return; }
    const rows = d.rows.filter((r) => !dept || r.department === dept);
    const t = d.tiles;
    mount(box,
      h('div.tm-head', h('h1', 'Team'), h('span.sp'), periodBar(d), dept !== null ? h('select.tm-dept', { onchange: (e) => { dept = e.target.value; paint(); }, 'aria-label': 'Department' },
        h('option', { value: '' }, 'All departments'), d.departments.map((x) => h('option', { value: x, selected: x === dept }, x))) : null),
      h('p.small.muted.tm-lede', 'What is on each person’s table across HIVE, Maintenance, Team Tasks, the POS, the breakfast app and Insight, and what is holding them back.'),
      message, sourcesSaid(d.sources),
      h('div.tm-tiles',
        tile('Overdue', t.overdue, `across ${t.overduePeople} ${t.overduePeople === 1 ? 'person' : 'people'}`, 'red'),
        tile('Waiting on an admin', t.waitingAdmin, 'requests and answers only an admin can clear', 'am'),
        tile(period === 'day' ? 'Due today' : `Due this ${period}`, t.due, 'to-dos, jobs, counts, plans', 'bl'),
        tile(period === 'day' ? 'Done today' : `Done this ${period}`, t.done, t.onTimePct != null ? `${t.onTimePct}% on time` : '', 'gr'),
        tile('On leave', t.away.length, t.away.join(', ') || 'nobody', '')),
      rows.length ? h('div.tm-tablewrap', h('table.tm-table',
        h('thead', h('tr', ['Person', 'Today', 'Doing', 'Due', 'Overdue', 'Done', 'Asked', 'Rating', 'Holding them back'].map((x, i) => h(`th${i >= 2 && i <= 7 ? '.n' : ''}`, x)))),
        h('tbody', rows.map((r) => h('tr', { tabindex: '0', onclick: () => open(r.id), onkeydown: (e) => { if (e.key === 'Enter') open(r.id); } },
          h('td', h('div.tm-who', avatar(r.name, r.id), h('div', h('b', r.name), h('small', r.role)))),
          h('td', h(`span.tm-now.${r.today.state}`, r.today.words)),
          h('td.n', num(r.doing)), h('td.n', num(r.due, 'bl')), h('td.n', num(r.overdue, 'red')),
          h('td.n', num(r.done, 'gr'), r.done ? h('div.tm-bar', h('i', { style: `width:${(r.doneOnTime / r.done) * 100}%;background:var(--tm-gr)` }), h('i', { style: `width:${((r.done - r.doneOnTime) / r.done) * 100}%;background:var(--tm-red)` })) : null),
          h('td.n', num(r.asked, 'am')),
          h('td.n', r.rating?.score != null ? [h(`span.tm-grade.${grade(r.rating.score)}`, r.rating.score.toFixed(1)), h(`small.tm-trend.${r.rating.trend}`, { up: '▲', down: '▼', same: '=' }[r.rating.trend])] : h('span.muted', '—')),
          h('td.tm-held', r.held.length ? r.held.map((x, i) => [i ? ' · ' : '', h(i ? 'span' : 'b', `${x.why}${x.days != null ? ` (${x.days} day${x.days === 1 ? '' : 's'})` : ''}`)]) : h('span.muted', 'Nothing')),
        ))))) : h('p.muted', 'Nobody in HIVE yet, or HIVE is not linked.'),
      h('div.tm-foot', h('button.sh-link', { type: 'button', onclick: () => settingsDialog() }, '⚙ How the rating is worked out')));
  }

  function tile(label, n, sub, tone) { return h(`div.tm-tile${tone ? `.${tone}` : ''}`, h('small', label), h('b', String(n)), h('em', sub)); }
  function open(id) { who = id; view = 'person'; tab = 'lists'; paint(); }

  function sourcesSaid(sources) {
    const off = Object.entries(sources || {}).filter(([, v]) => v !== 'ok');
    return off.length ? h('p.small.tm-src', `Not read just now: ${off.map(([k, v]) => `${APP_TAG[k] || k} (${v})`).join('; ')}. The rest is shown.`) : null;
  }

  function periodBar(d) {
    const step = (n) => { anchor = period === 'day' ? addDays(anchor, n) : period === 'week' ? addDays(anchor, 7 * n) : (() => { const x = new Date(`${anchor.slice(0, 7)}-15T12:00:00Z`); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); })(); paint(); };
    const label = d.period === 'day' ? dayText(d.from, { weekday: 'long', day: 'numeric', month: 'short' }) : d.period === 'week' ? `Week of ${dayText(d.from, { day: 'numeric', month: 'short' })} – ${dayText(d.to, { day: 'numeric', month: 'short' })}` : dayText(d.from, { month: 'long', year: 'numeric' });
    return h('div.tm-period',
      h('div.seg', [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ...(view === 'person' ? [['eval', 'Evaluation']] : [])].map(([k, l]) => h('button', {
        type: 'button', 'aria-selected': String(k === 'eval' ? tab === 'eval' : tab !== 'eval' && period === k),
        onclick: () => { if (k === 'eval') tab = 'eval'; else { tab = 'lists'; period = k; } paint(); },
      }, l))),
      tab === 'eval' ? null : h('div.tm-nav', h('button', { type: 'button', 'aria-label': 'Before', onclick: () => step(-1) }, '‹'), h('b', label), h('button', { type: 'button', 'aria-label': 'After', onclick: () => step(1) }, '›')));
  }

  // ------------------------------------------------------------ one person --

  async function personPage(message) {
    if (tab === 'eval') { await evalPage(message); return; }
    let d;
    try { d = await api(`/team/${who}?period=${period}&day=${anchor}`); } catch (err) { mount(box, banner('problem', err.message)); return; }
    const p = d.person;
    const c = d.counts;
    const card = (x, tone = '') => h(`div.tm-card${tone ? `.${tone}` : ''}`,
      h('div.tm-ctop', tag(x.app), h('small', cardWhen(x))),
      h('b', x.title),
      x.waitingOn && x.status !== 'done' ? h('span.tm-stuck', `⛔ ${x.waitingOn}`) : null,
      x.link && /^https?:/.test(x.link) ? h('a.tm-open', { href: x.link, target: '_blank', rel: 'noopener' }, 'Open') : x.link ? h('a.tm-open', { href: x.link }, 'Open') : null);
    const col = (icon, label, xs, tone, empty) => h('div.tm-col', h('h3', icon, ' ', label, ' ', h('span', String(xs.length))),
      xs.length ? xs.slice(0, 12).map((x) => card(x, tone)) : h('p.small.muted', empty),
      xs.length > 12 ? h('p.small.muted', `and ${xs.length - 12} more`) : null);
    mount(box,
      h('div.tm-head', h('button.sh-link', { type: 'button', onclick: () => { view = 'all'; paint(); } }, '‹ Everybody'), h('span.sp'), periodBar(d)),
      message, sourcesSaid(d.sources),
      h('div.tm-phead', avatar(p.name, p.id, true),
        h('div', h('h2', p.name), h('small.muted', [p.role, p.today?.words, !p.email ? 'no email in HIVE: only HIVE is read' : null].filter(Boolean).join(' · '))),
        h('div.tm-stats', [['Doing', c.doing, ''], ['Due', c.due, 'bl'], ['Overdue', c.overdue, 'red'], ['Done', c.done, 'gr'], ['On time', c.onTime != null ? `${c.onTime}%` : '—', ''], ['Asked', c.asked, 'am']]
          .map(([l, v, tone]) => h('div', h('small', l), h(`span.tm-num${tone ? `.${tone}` : ''}`, String(v)))))),
      d.days ? monthGrid(d.days) : null,
      h('div.tm-cols',
        col('⏳', 'Overdue', d.lists.overdue, 'red', 'Nothing overdue.'),
        col('🔧', 'Doing now', d.lists.doing, '', 'Nothing started.'),
        col('📅', 'Coming up', d.lists.due, '', 'Nothing coming up.'),
        col('✅', 'Done', d.lists.done, 'done', 'Nothing done in these days.')),
      h('div.tm-side',
        h('section.card', h('h3', `⛔ Holding ${first(p.name)} back`),
          d.lists.held.length ? d.lists.held.map((x) => h('div.tm-block', h('span.tm-ic', '!'), h('div', h('b', x.title), h('small', `${x.waitingOn}${x.days != null ? ` · ${x.days} day${x.days === 1 ? '' : 's'}` : ''}`)),
            x.link ? h('a.btn', { href: x.link, ...(/^https?:/.test(x.link) ? { target: '_blank', rel: 'noopener' } : {}) }, 'Open') : tag(x.app)))
            : h('p.small.muted', 'Nothing of theirs is waiting on anybody else.')),
        h('section.card', h('h3', `🙋 What ${first(p.name)} asked for`),
          d.lists.asked.length ? d.lists.asked.map((x) => h('div.tm-li', tag(x.app), h('div', h('b', x.title), h('small', dayText(String(x.createdAt || '').slice(0, 10)))),
            h(`span.tm-chip.${x.decision === 'approved' ? 'ok' : x.decision === 'refused' ? 'no' : 'wait'}`, x.decision === 'approved' ? 'Approved' : x.decision === 'refused' ? 'Refused' : `Waiting${x.waited != null ? ` ${x.waited} d` : ''}`)))
            : h('p.small.muted', 'Nothing asked for in these days.'))),
      d.shifts ? h('p.small.muted', `HIVE: ${d.shifts.worked} shift${d.shifts.worked === 1 ? '' : 's'} worked in these days${d.shifts.late ? `, late ${d.shifts.late} time${d.shifts.late === 1 ? '' : 's'}` : ''}.`) : null);
  }

  function cardWhen(x) {
    if (x.status === 'done') return `${dayText(String(x.doneAt || '').slice(0, 10))}${x.onTime === false ? ' · late' : x.onTime ? ' · on time' : ''}`;
    if (x.status === 'doing') return x.startedAt ? `started ${String(x.startedAt).slice(11, 16)}` : 'started';
    if (x.missed) return `${dayText(x.due)} · missed`;
    if (x.due && x.due < today()) { const n = Math.round((Date.parse(`${today()}T12:00:00Z`) - Date.parse(`${x.due}T12:00:00Z`)) / 86_400_000); return `due ${dayText(x.due)} · ${n} day${n === 1 ? '' : 's'} late`; }
    return x.due ? (x.due === today() ? 'today' : dayText(x.due)) : 'no due day';
  }

  function monthGrid(days) {
    const lead = (new Date(`${days[0].day}T12:00:00Z`).getUTCDay() + 6) % 7;
    return h('section.card.tm-month',
      h('div.tm-grid', ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x) => h('div.tm-gh', x)),
        Array.from({ length: lead }, () => h('div')),
        days.map((x) => {
          const n = x.onTime + x.late + x.missed;
          return h(`div.tm-gd${x.off ? '.off' : ''}${x.future ? '.future' : ''}`, { title: `${dayText(x.day)}: ${x.onTime} on time, ${x.late} late, ${x.missed} missed` }, String(Number(x.day.slice(8))),
            n ? h('i', h('u', { style: `width:${(x.onTime / n) * 100}%;background:var(--tm-gr)` }), h('u', { style: `width:${(x.late / n) * 100}%;background:var(--tm-am)` }), h('u', { style: `width:${(x.missed / n) * 100}%;background:var(--tm-red)` })) : null);
        })),
      h('div.tm-legend', h('span', { style: '--c:var(--tm-gr)' }, 'Done on time'), h('span', { style: '--c:var(--tm-am)' }, 'Done late'), h('span', { style: '--c:var(--tm-red)' }, 'Missed, still open'), h('span', { style: '--c:#c3c7d4' }, 'Off or leave')));
  }

  // ------------------------------------------------------------ evaluation --

  async function evalPage(message) {
    let e;
    try { e = await api(`/team/${who}/evaluation`); } catch (err) { mount(box, banner('problem', err.message)); return; }
    mount(box,
      h('div.tm-head', h('button.sh-link', { type: 'button', onclick: () => { view = 'all'; paint(); } }, '‹ Everybody'), h('span.tm-ename', e.person.name), h('span.sp'),
        periodBar({ period, from: anchor, to: anchor }), h('span.tm-range.small.muted', `${dayText(e.from, { day: 'numeric', month: 'short' })} – ${dayText(e.to, { day: 'numeric', month: 'short', year: 'numeric' })}`)),
      message,
      evaluationBody(e, { admin: true, after: (m) => paint(m) }));
  }
}

/** One person's evaluation, as admins see it (notes, own measures, print) or as they see their own. */
export function evaluationBody(e, { admin = false, after = () => {} } = {}) {
  const pct = e.score != null ? ((e.score - 1) / 4) * 100 : 0;
  const tone = e.score == null ? 'none' : e.score >= 3.7 ? 'gr' : e.score >= 3 ? 'am' : 'red';
  const maxDone = Math.max(1, ...e.months.map((x) => x.done));
  const scoreBox = (m) => {
    if (!admin || !m.custom) return h('span.tm-v', m.score != null ? m.score.toFixed(1) : '—');
    const pick = h('select', { 'aria-label': `${m.label} score`, onchange: async () => {
      try { await api(`/team/${e.person.id}/score`, { method: 'POST', body: { measure: m.id, score: pick.value } }); after(banner('good', `${m.label}: saved.`)); } catch (err) { after(banner('problem', err.message)); }
    } }, h('option', { value: '' }, '—'), [1, 2, 3, 4, 5].map((n) => h('option', { value: String(n), selected: Number(m.score) === n }, String(n))));
    return pick;
  };
  return h('div.tm-ev',
    h('section.card.tm-score',
      h('div.tm-big', h(`div.tm-ring.${tone}`, { style: `--p:${pct}%` }, h('div', h('b', e.score != null ? e.score.toFixed(1) : '—'), h('small', 'OF 5'))),
        h('div', h('b.tm-verdict', e.verdict),
          e.rank ? h('div.small', `${ordinal(e.rank)} of ${e.peers} ${e.person.role.toLowerCase()}${e.peers === 1 ? '' : 's'}${e.was != null ? ` · was ${e.was.toFixed(1)} the three months before` : ''}`) : null,
          h('div.small.muted', `From ${e.things} things across the apps`))),
      h('div', e.measures.map((m) => h(`div.tm-dim${m.weight === 0 ? '.off' : ''}`,
        h('div', h('b', m.label, m.weight !== 1 ? h('small.tm-w', m.weight === 0 ? ' not counted' : ` ×${m.weight}`) : null), h('small', m.score != null ? m.facts : m.custom ? 'scored by an admin' : `${m.what}: too little to judge`)),
        h('div.tm-meter', h('i', { style: `width:${m.score != null ? ((m.score - 1) / 4) * 100 : 0}%;background:var(--tm-${m.score == null ? 'gy' : m.score >= 3.7 ? 'gr' : m.score >= 3 ? 'am' : 'red'})` })),
        scoreBox(m)))),
      h('p.tm-fair', e.heldDays ? `${e.heldDays} days held back by somebody else (an approval, parts, the store room) are not counted against them. ` : '', 'A dash is too little to judge, not a low mark.')),
    h('div.tm-evr',
      h('div.tm-two',
        h('section.card', h('h3', 'Patterns Insight found'),
          e.patterns.length ? e.patterns.map((x) => h('div.tm-pat', h(`span.tm-pic.${x.tone}`, x.icon), h('div', h('b', x.title), h('small', x.why))))
            : h('p.small.muted', 'Nothing that repeats three times or more.')),
        h('section.card', h('h3', 'The last six months'),
          h('div.tm-spark', { role: 'img', 'aria-label': e.months.map((x) => `${x.month}: ${x.done} done, ${x.onTime} on time`).join('; ') }, e.months.map((x) => h('div.tm-sc', { title: `${x.done} done, ${x.onTime} on time` },
            h('small', String(x.done)),
            h('div.tm-sb', { style: `height:${x.done ? Math.max(6, (x.done / maxDone) * 100) : 0}%` }, x.done - x.onTime ? h('i.lt', { style: `flex:${x.done - x.onTime}` }) : null, x.onTime ? h('i.ot', { style: `flex:${x.onTime}` }) : null),
            h('span', new Date(`${x.month}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }))))),
          h('p.tm-key.small.muted', h('i.ot'), 'Done on time ', h('i.lt'), 'Done late'),
          h('div.tm-sw', e.strengths.map((x) => h('div.tm-li', h('span.tm-chip.ok', 'Strength'), h('div', h('b', x.title), h('small', x.why)))),
            e.watch.map((x) => h('div.tm-li', h('span.tm-chip.no', 'Watch'), h('div', h('b', x.title), h('small', x.why)))),
            !e.strengths.length && !e.watch.length ? h('p.small.muted', 'Nothing stands out either way.') : null))),
      admin ? h('div.tm-two',
        h('section.card', h('h3', `To talk about with ${e.person.name.split(' ')[0]}`), e.talk.length ? h('ul.tm-talk', e.talk.map((t) => h('li', t))) : h('p.small.muted', 'Nothing in particular.')),
        notesCard(e, after)) : null));
}

function notesCard(e, after) {
  const text = h('textarea', { rows: 2, maxlength: 1000, placeholder: 'What you talked about, what was agreed' });
  return h('section.card', h('h3', 'Your notes'),
    e.notes.length ? e.notes.map((n) => h('div.tm-li', h('span.tm-tag.a-insight', 'Admin'), h('div', h('b', n.text), h('small', `${String(n.at).slice(0, 10)} · ${n.by || ''}`)))) : h('p.small.muted', 'No notes yet.'),
    h('div.tm-note', text, h('button.btn.primary', { type: 'button', onclick: async () => {
      try { await api(`/team/${e.person.id}/note`, { method: 'POST', body: { text: text.value } }); after(banner('good', 'Note kept.')); } catch (err) { after(banner('problem', err.message)); }
    } }, '＋ Add a note'), h('button.btn', { type: 'button', onclick: () => window.print() }, '⬇ Print for an appraisal')));
}

const ordinal = (n) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

/** How the rating is worked out: each measure's weight, an admin's own measures, and whether people see their own. */
/** How the rating is worked out: the weights, an admin's own measures, and people seeing their own. `done` runs after a save. */
function ratingForm(s, done) {
  const MEASURES = [['turns_up', 'Turns up'], ['on_time', 'On time'], ['gets_done', 'Gets it done'], ['throughput', 'Gets through work'], ['answers', 'Answers'], ['first_time', 'Done right first time'], ['routine', 'Follows the routine'], ['money', 'Money and stock']];
  const weight = (id, v) => h('select', { 'data-id': id }, [0, 0.5, 1, 1.5, 2, 3].map((n) => h('option', { value: String(n), selected: Number(v) === n }, n === 0 ? 'Not counted' : `×${n}`)));
  const rows = [...MEASURES.map(([id, label]) => [id, label, s.weights[id], false]), ...s.custom.map((c) => [c.id, c.label, c.weight, true])];
  const selects = rows.map(([id, , v]) => weight(id, v));
  const name = h('input', { placeholder: 'e.g. Guest complaints', maxlength: 60 });
  const what = h('input', { placeholder: 'What it is about (optional)', maxlength: 120 });
  const show = h('input', { type: 'checkbox', checked: s.showOwn });
  const err = h('p.small.form-error');
  const save = async (extra = {}) => {
    try {
      await api('/team/settings', { method: 'POST', body: { weights: Object.fromEntries(selects.map((x) => [x.dataset.id, Number(x.value)])), showOwn: show.checked, ...extra } });
      done();
    } catch (e) { err.textContent = e.message; }
  };
  return [
    h('p.small.muted', 'Each measure is 1 to 5 over the last three months, against others in the same role. The rating is their average, each counted as many times as its weight. Your own measures you score by hand on each person’s Evaluation.'),
    h('div.tm-wts', rows.map(([id, label, , custom], i) => h('div.tm-wrow', h('span', label, custom ? h('small.muted', ' (yours)') : null), selects[i],
      custom ? h('button.sh-link', { type: 'button', onclick: () => save({ remove: id }) }, 'Take off') : h('span')))),
    h('h3', 'Add a measure of your own'), h('div.fl-two', name, what), h('button.btn', { type: 'button', onclick: () => save({ add: { label: name.value, what: what.value } }) }, '＋ Add it'),
    h('label.tm-show', show, ' Let people see their own evaluation (in Insight, by their email in HIVE; never your notes)'),
    err, h('div.fl-dlg-acts', h('button.btn.primary', { type: 'button', onclick: () => save() }, 'Save')),
  ];
}

async function settingsDialog() {
  let s;
  try { s = await api('/team/settings'); } catch (err) { alert(err.message); return; }
  const close = () => shade.remove();
  const card = h('div.fl-card', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'How the rating is worked out' },
    h('div.fl-dlg-head', h('h2', 'How the rating is worked out'), h('button.btn', { type: 'button', onclick: close }, '✕')),
    ...ratingForm(s, () => { close(); location.reload(); }));
  const shade = h('div.fl-dlg', { onclick: (e) => { if (e.target === shade) close(); } }, card);
  document.body.append(shade);
}

/** Settings › Rules › Team rating: the same, as a page. */
export async function renderTeamRules(root) {
  let s;
  try { s = await api('/team/settings'); } catch (err) { mount(root, h('div.card', h('h2', 'That did not work'), h('p', err.message))); return; }
  mount(root, h('div.card', h('h2', 'How the Team rating is worked out'), ...ratingForm(s, () => renderTeamRules(root).then(() => root.prepend(banner('good', 'Saved.'))))));
}

/** Their own evaluation, when an admin allows it. */
export async function renderMyEvaluation(root) {
  let e;
  try { e = await api('/team/me'); } catch (err) { mount(root, h('div.tm', h('h1', 'My evaluation'), banner('none', err.message))); return; }
  mount(root, h('div.tm', h('div.tm-head', h('h1', 'My evaluation'), h('span.sp'), h('span.small.muted', `${e.from} – ${e.to}`)), evaluationBody(e)));
}

/** Team › Evaluations: everybody's rating at once, by role, to compare. A row opens that person's evaluation. */
export async function renderEvaluations(root) {
  let d;
  try { d = await api('/team/evaluations'); } catch (err) { mount(root, h('div.tm', banner('problem', err.message))); return; }
  const trend = { up: '▲', down: '▼', same: '=' };
  const open = (id) => { try { sessionStorage.setItem('insight-team-open', JSON.stringify({ id, tab: 'eval' })); } catch { /* private mode */ } location.hash = '#/team'; };
  mount(root, h('div.tm',
    h('div.tm-head', h('p.small.muted.tm-lede', `Everybody’s rating over the last three months (${d.from} – ${d.to}), by role. Press a person for their evaluation, their patterns and your notes.`), h('span.sp'),
      h('button.btn', { type: 'button', onclick: () => window.print() }, 'Print')),
    d.roles.length ? d.roles.map((g) => h('section.card.tm-evgroup',
      h('h2', g.role, h('small.muted', ` · ${g.people.length}`)),
      h('div.tm-tablewrap', h('table.tm-table',
        h('thead', h('tr', ['Person', 'Rating', 'Place', 'Verdict', 'Best at', 'Watch'].map((x, i) => h(`th${i === 1 || i === 2 ? '.n' : ''}`, x)))),
        h('tbody', g.people.map((p) => h('tr', { tabindex: '0', onclick: () => open(p.id), onkeydown: (e) => { if (e.key === 'Enter') open(p.id); } },
          h('td', h('div.tm-who', avatar(p.name, p.id), h('div', h('b', p.name), h('small', p.department || '')))),
          h('td.n', p.score != null ? [h(`span.tm-grade.${grade(p.score)}`, p.score.toFixed(1)), h(`small.tm-trend.${p.trend}`, trend[p.trend])] : h('span.muted', '—')),
          h('td.n', p.rank != null ? `${p.rank} of ${p.peers}` : '—'),
          h('td', p.verdict),
          h('td', p.best ? `${p.best.label} (${p.best.score.toFixed(1)})` : h('span.muted', '—')),
          h('td', p.watch ? h('span.tm-watch', `${p.watch.label} (${p.watch.score.toFixed(1)})`) : h('span.muted', '—'))))))))) : h('p.muted', 'Nobody in HIVE yet, or HIVE is not linked.')));
}

