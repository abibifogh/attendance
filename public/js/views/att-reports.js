import { api } from '../api.js';
import { can, navigate, replaceParams } from '../app.js';
import {
  fmtDay, fmtNum, h, money, monthOf, mount, shiftDay, shiftMonth, toast, todayISO,
} from '../util.js';
import { card, emptyState, exportButton, face, moreActions, table } from './components.js';
import { printButton } from '../print.js';
import { analyticsSection } from './att-analytics.js';
import {
  asHours, correctTimesDialog, daysCell, field, formDialog, needsAttention, reasonSelect, statusPill,
} from './att-shared.js';

/**
 * Reports: the week and the month.
 *
 * Both lead with the answer and let colour carry the state. A day is one of a
 * handful of things (on time, late, absent, a punch missing, on leave, a rest
 * day, worked without a shift) and every cell, square and calendar day below
 * is painted from the same `toneOf`, so the week, the month and the side panel
 * can never disagree about what a day was.
 */

/** How far under their rostered hours somebody can be and still be "all there". */
const SHORT_SLACK = 60;

// ---------------------------------------------------------------------------
// What a day was
// ---------------------------------------------------------------------------

/**
 * One word for a day, from the record the server already decided.
 *
 * Works on the full record the week sends and the slim one the month sends:
 * both carry status, colour, open and the minutes.
 */
function toneOf(d) {
  if (!d) return 'none';
  switch (d.status) {
    case 'present': return 'ok';
    case 'late': case 'late_early': return 'late';
    case 'early_leave': return 'early';
    case 'working': return d.late_minutes > 0 ? 'late' : 'ok';
    case 'upcoming': return 'future';
    case 'unscheduled': return 'extra';
    case 'rest': return 'rest';
    case 'leave': case 'holiday': return 'leave';
    case 'missing_in': case 'missing_out':
      if (d.open) return 'miss';
      if (d.colour === 'red' || d.reason_code === 'absent') return 'absent';
      return 'ok';
    case 'absent': return d.colour === 'red' ? 'absent' : 'excused';
    default: return d.colour === 'red' ? 'absent' : 'rest';
  }
}

const isLate = (d) => d.status === 'late' || d.status === 'late_early'
  || (d.status === 'working' && d.late_minutes > 0);

/** +12m, +1h07: how late, as short as it will go. */
function lateShort(minutes) {
  const n = Math.max(0, Math.round(Number(minutes) || 0));
  if (n < 60) return `+${n}m`;
  return `+${Math.floor(n / 60)}h${String(n % 60).padStart(2, '0')}`;
}

/** Hours, to a decimal place only where there is one. */
const hrs = (minutes) => fmtNum((Number(minutes) || 0) / 60, (minutes % 60) ? 1 : 0);

/** What a week cell says: a big line and a small one. */
function cellText(d) {
  switch (toneOf(d)) {
    case 'ok':
      if (d.status === 'working') return [d.first_in || 'On', 'on now'];
      if (d.status === 'missing_out' || d.status === 'missing_in') return [d.first_in || d.last_out || 'Done', 'credited'];
      return [d.first_in || 'In', d.last_out ? `to ${d.last_out}` : ''];
    case 'late': return [lateShort(d.late_minutes), d.first_in ? `in ${d.first_in}` : ''];
    case 'early': return ['Left early', d.last_out ? `out ${d.last_out}` : ''];
    case 'absent': return ['Absent', d.shift?.starts_at ? `due ${d.shift.starts_at}` : ''];
    case 'excused': return ['Excused', ''];
    case 'miss':
      return d.status === 'missing_in'
        ? ['No in', d.last_out ? `out ${d.last_out}` : '']
        : ['No out', d.first_in ? `in ${d.first_in}` : ''];
    case 'leave': return [d.status === 'holiday' ? 'Holiday' : 'Leave', leaveWord(d.label)];
    case 'rest': return ['Rest', ''];
    case 'extra': return [d.first_in || 'Worked', 'no shift'];
    case 'future': return [d.shift?.starts_at || 'Due', 'to come'];
    default: return ['', ''];
  }
}

/** "Annual leave" becomes "annual"; anything else is left as it is. */
function leaveWord(label) {
  const word = String(label || '').replace(/\s*leave$/i, '').trim();
  return word && !/^leave$/i.test(word) ? word.toLowerCase() : '';
}

/** The small word under a day number on the person's calendar. */
function calendarWord(d) {
  switch (toneOf(d)) {
    case 'late': return lateShort(d.late_minutes);
    case 'early': return 'early';
    case 'absent': return 'absent';
    case 'excused': return 'excused';
    case 'miss': return d.status === 'missing_in' ? 'no in' : 'no out';
    case 'leave': return d.status === 'holiday' ? 'holiday' : 'leave';
    case 'extra': return 'extra';
    default: return '';
  }
}

/**
 * A run of days, added up the way the screen talks about them.
 *
 * Days still to come, and a shift still going, count for nothing yet: a week
 * looked at on a Wednesday is not short by Thursday's hours.
 */
function tally(days) {
  const t = {
    due: 0, came: 0, rostered: 0, worked: 0, late: 0, lateMinutes: 0,
    absent: 0, excused: 0, miss: 0, leave: 0,
  };
  for (const d of days ?? []) {
    const tone = toneOf(d);
    if (tone === 'future' || tone === 'none' || d.status === 'working') continue;
    t.worked += d.worked_minutes || 0;
    if (d.scheduled && tone !== 'leave') {
      t.rostered += d.expected_minutes || 0;
      if (['ok', 'late', 'early', 'miss', 'absent', 'excused'].includes(tone)) {
        t.due += 1;
        if (tone !== 'absent' && tone !== 'excused') t.came += 1;
      }
    }
    if (isLate(d)) { t.late += 1; t.lateMinutes += d.late_minutes || 0; }
    if (tone === 'absent') t.absent += 1;
    if (tone === 'excused') t.excused += 1;
    if (tone === 'miss') t.miss += 1;
    if (tone === 'leave') t.leave += 1;
  }
  t.rate = t.due ? Math.round((t.came / t.due) * 100) : null;
  t.short = t.rostered - t.worked > SHORT_SLACK;
  return t;
}

function addTallies(list) {
  const out = tally([]);
  for (const t of list) {
    for (const key of Object.keys(out)) if (typeof t[key] === 'number') out[key] += t[key];
  }
  out.rate = out.due ? Math.round((out.came / out.due) * 100) : null;
  return out;
}

// ---------------------------------------------------------------------------
// The week
// ---------------------------------------------------------------------------

const SHOWS = [
  ['all', 'Everybody', null],
  ['late', 'Late', 'late'],
  ['absent', 'Absent', 'absent'],
  ['miss', 'Punch missing', 'miss'],
  ['short', 'Short of their hours', 'short'],
];

const shows = {
  all: () => true,
  late: (t) => t.late > 0,
  absent: (t) => t.absent + t.excused > 0,
  miss: (t) => t.miss > 0,
  short: (t) => t.short,
};

/**
 * The week, one row a person.
 *
 * Seven coloured days and what they came to against the rota. A manager reads
 * this to find the pattern a daily list hides: the person late three Mondays
 * running, the section that is short every weekend.
 */
export async function renderAttWeek(params) {
  const host = h('div.rep-page');
  const from = params.from || mondayOf(todayISO());
  const data = await api.attWeek(from);
  const state = {
    department: departmentOf(data.rows, params.department),
    show: shows[params.show] ? params.show : 'all',
  };

  const paramsNow = (nextFrom = data.from) => ({
    from: nextFrom,
    ...(state.department ? { department: state.department } : {}),
    ...(state.show !== 'all' ? { show: state.show } : {}),
  });

  const reload = async (nextFrom) => {
    const next = paramsNow(nextFrom);
    replaceParams('att-week', next);
    mount(host, await renderAttWeek(next));
  };

  const nav = h('div.toolbar',
    // Arrows on a phone, words on a desk, either side of the date.
    h('button.btn-sm', {
      onclick: () => reload(shiftDay(data.from, -7)),
      'aria-label': 'The week before',
    }, '‹', h('span.only-desk', ' Previous week')),
    h('input', {
      type: 'date', value: data.from,
      onchange: (e) => e.target.value && reload(mondayOf(e.target.value)),
    }),
    h('button.btn-sm', {
      onclick: () => reload(shiftDay(data.from, 7)),
      'aria-label': 'The week after',
    }, h('span.only-desk', 'Next week '), '›'),
    // Only when it is not the week already on screen.
    data.from === mondayOf(todayISO())
      ? null
      : h('button.btn-sm', { onclick: () => reload(mondayOf(todayISO())) }, 'This week'),
    h('div', { style: { flex: 1 } }),
    moreActions(
      printButton({
        title: 'Attendance, week',
        subtitle: `${fmtDay(data.from, { withYear: true })} to ${fmtDay(data.to, { withYear: true })}`,
        footer: PRINT_FOOTER,
      }),
      exportButton(api.attExportUrl(data.from, data.to), 'Export week'),
    ),
  );

  if (!data.rows.length) {
    mount(host, head(data), nav, emptyState('Nobody on the rota this week', 'Set the rota to see this filled in.'));
    return host;
  }

  const tallies = new Map(data.rows.map((r) => [r.staff.id, tally(r.days)]));
  const opens = canOpenPerson();
  const body = h('div');

  const draw = () => {
    const rows = inDepartment(data.rows, state.department);
    const all = addTallies(rows.map((r) => tallies.get(r.staff.id)));
    const shown = rows.filter((r) => shows[state.show](tallies.get(r.staff.id)));
    const count = (k) => rows.filter((r) => shows[k](tallies.get(r.staff.id))).length;
    const choose = (patch) => {
      Object.assign(state, patch);
      replaceParams('att-week', paramsNow());
      draw();
    };

    mount(body,
      h('div.rep-tiles',
        repTile(all.rate == null ? '—' : `${all.rate}%`, 'turned up when rostered'),
        repTile(`${fmtNum(all.worked / 60, 0)}h`, `worked, of ${fmtNum(all.rostered / 60, 0)}h rostered`),
        repTile(fmtNum(all.late, 0), all.late ? `late arrivals · ${asHours(all.lateMinutes)} in all` : 'late arrivals', all.late ? 'late' : null),
        repTile(fmtNum(all.absent + all.excused, 0),
          `absences, ${all.excused ? `${all.excused} excused` : 'none excused'}`, all.absent ? 'absent' : null),
        repTile(fmtNum(all.miss, 0), all.miss === 1 ? 'punch missing' : 'punches missing', all.miss ? 'miss' : null),
      ),
      h('div.rep-filterbar',
        h('div.rep-chips', { role: 'group', 'aria-label': 'Show' },
          SHOWS.map(([key, label, dot]) => h(`button.rep-chip${state.show === key ? '.on' : ''}`, {
            type: 'button',
            'aria-pressed': String(state.show === key),
            onclick: () => choose({ show: key }),
          }, dot ? h('i.rep-dot', { 'data-tone': dot }) : null, label,
          h('span.rep-chip-n', String(key === 'all' ? rows.length : count(key)))))),
        departmentChips(data.rows, state.department, (d) => choose({ department: d })),
      ),
      h('section.rep-card.rep-week',
        h('div.rep-wrow.rep-whead', { 'aria-hidden': 'true' },
          h('span.rep-wperson', 'Person'),
          h('div.rep-days', data.days.map((day) => h('span',
            h('b', new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })),
            ` ${Number(day.slice(8))}`))),
          h('span.rep-wmeter', 'Worked · rostered'),
        ),
        shown.length
          ? shown.map((row) => weekRow(row, tallies.get(row.staff.id), data, opens, () => reload(data.from)))
          : h('p.rep-none', state.show === 'all' ? 'Nobody in this department this week.' : 'Nobody this week.'),
      ),
      weekKey(opens),
    );
  };
  draw();

  mount(host, head(data), nav, body);
  return host;
}

function weekRow(row, t, data, opens, changed) {
  const open = (day) => openPerson({
    staff: row.staff, day, period: 'week', week: data.from, changed,
  });
  const today = todayISO();
  const focus = today >= data.from && today <= data.to ? today : data.to;
  return h('div.rep-wrow',
    personCell(row.staff, opens ? () => open(focus) : null),
    h('div.rep-days', row.days.map((d, i) => {
      const [big, small] = cellText(d);
      const label = `${fmtDay(data.days[i])}: ${d?.label ?? 'nothing'}${d?.first_in ? `, ${d.first_in} to ${d.last_out || 'no clock-out'}` : ''}`;
      const props = { 'data-tone': toneOf(d), title: label, 'aria-label': label };
      const inner = [h('b', big), small ? h('small', small) : null];
      return opens
        ? h('button.rep-day', { ...props, type: 'button', onclick: () => open(data.days[i]) }, inner)
        : h('span.rep-day', props, inner);
    })),
    weekMeter(t),
  );
}

/** Worked against rostered, as a bar, and the one word that matters. */
function weekMeter(t) {
  if (!t.rostered && !t.worked) {
    return h('div.rep-wmeter.rep-meter', h('div.rep-meter-nums', h('span.muted', 'Nothing rostered')));
  }
  const gap = t.rostered - t.worked;
  const over = t.rostered && gap < -120;
  const kind = t.short ? 'under' : over ? 'over' : 'ok';
  const badge = t.short ? `${hrs(gap)}h short` : over ? `${hrs(-gap)}h over` : '✓ all there';
  const width = t.rostered ? Math.min(100, (t.worked / t.rostered) * 100) : 100;
  return h(`div.rep-wmeter.rep-meter.is-${kind}`,
    h('div.rep-meter-track', h('i.rep-meter-fill', { style: { width: `${width}%` } })),
    h('div.rep-meter-nums',
      h('span', h('b', `${hrs(t.worked)}h`), ` of ${hrs(t.rostered)}h`),
      h('b.rep-meter-badge', badge)));
}

function weekKey(opens) {
  const item = (tone, label) => h('span.rep-key-item', h('i.rep-key-swatch', { 'data-tone': tone }), label);
  return h('div.rep-key',
    item('ok', 'On time'),
    item('late', 'Late'),
    item('absent', 'Absent'),
    item('miss', 'Punch missing'),
    item('leave', 'Leave'),
    item('rest', 'Rest day'),
    item('extra', 'Worked, not rostered'),
    opens ? h('span.rep-key-hint', 'Click a day to see the punches and fix them; click a name for their month.') : null,
  );
}

// ---------------------------------------------------------------------------
// The month
// ---------------------------------------------------------------------------

/**
 * Everybody, a month at a time.
 *
 * A square a day a person, how often they turned up, how often late, and the
 * hours against what their hours a week make of the month. At the side, the
 * departments, the people worth a word, and what the labour cost; the full
 * sheet for the wages and the full breakdown are folded underneath.
 */
export async function renderAttOverview(params) {
  const host = h('div.rep-page');
  const month = params.month || monthOf(todayISO());
  const data = await api.attOverview(month);
  const department = departmentOf(data.rows, params.department);
  const rows = inDepartment(data.rows, department);

  const reload = async (nextMonth, nextDepartment = department) => {
    const next = { month: nextMonth, ...(nextDepartment ? { department: nextDepartment } : {}) };
    replaceParams('att-overview', next);
    mount(host, await renderAttOverview(next));
  };

  const label = new Date(`${data.month}-15T12:00:00Z`)
    .toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const monthName = new Date(`${data.month}-15T12:00:00Z`)
    .toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });

  const nav = h('div.toolbar',
    h('button.btn-sm', { onclick: () => reload(shiftMonth(data.month, -1)), 'aria-label': 'The month before' }, '‹'),
    h('input', {
      type: 'month', value: data.month,
      onchange: (e) => e.target.value && reload(e.target.value),
    }),
    h('button.btn-sm', {
      onclick: () => reload(shiftMonth(data.month, 1)),
      disabled: data.month >= monthOf(todayISO()),
      'aria-label': 'The month after',
    }, '›'),
    h('div', { style: { flex: 1 } }),
    moreActions(
      printButton({
        title: `Attendance, ${label}`,
        subtitle: `${department ? `${department} · ` : ''}${rows.length} people · ${fmtDay(data.from)} to ${fmtDay(data.to)}`,
        footer: PRINT_FOOTER,
      }),
      // The export carries the balances, so it stays behind the permission
      // that may see them rather than handing a planner a file with the column
      // the screen just took out.
      can('att_reports') ? exportButton(api.attExportUrl(data.from, data.to), 'Export month') : null,
    ),
  );

  if (!data.rows.length) {
    mount(host,
      h('div.page-head', h('div', h('h1', 'Reports'), h('div.sub', label))),
      nav,
      emptyState('Nothing recorded this month', 'No punches have landed for anybody in this period.'),
    );
    return host;
  }

  // What the month cost and where the time went. Heavier than the rest, so a
  // failure leaves the grid standing. Money in it is left out by the server
  // for anybody who may not see pay.
  const deeper = await api.attAnalytics({ from: data.from, to: data.to, ...(department ? { department } : {}) })
    .catch(() => null);

  const opens = canOpenPerson();
  const days = monthDays(data.month);
  const tallies = new Map(data.rows.map((r) => [r.staff.id, tally(r.days)]));
  const openCount = rows.reduce((n, r) => n + (r.totals.openCount || 0), 0);
  const changed = () => reload(data.month);

  const breakdown = h('details.rep-fold', { id: 'rep-breakdown' },
    h('summary', h('b', 'The full breakdown'),
      h('span', 'What the labour costs, where the time goes, who is at risk and how the cover is shaped')),
    deeper ? analyticsSection(deeper) : h('p.muted', 'The breakdown could not be worked out just now.'));

  mount(host,
    h('div.page-head',
      h('div', h('h1', 'Reports'), h('div.sub', label)),
      openCount
        ? h('span.pill.warn', `${openCount} day${openCount === 1 ? '' : 's'} still unconfirmed`)
        : h('span.pill.good', 'Every day settled'),
    ),
    nav,
    departmentChips(data.rows, department, (d) => reload(data.month, d)),
    h('div.rep-month-layout',
      h('section.rep-card.rep-month',
        h('div.rep-mrow.rep-mhead', { 'aria-hidden': 'true' },
          h('span', 'Person'),
          h('span', `Every day of ${monthName}`),
          h('span.rep-num', 'Turned up'),
          h('span.rep-num', 'Late'),
          h('span', 'Hours against their month')),
        rows.map((row) => monthRow(row, tallies.get(row.staff.id), days, data, opens, changed)),
        monthKey(),
      ),
      h('div.rep-side',
        departmentsCard(rows, tallies),
        talkToCard(rows, tallies, opens, data, changed),
        labourCard(deeper, () => {
          breakdown.open = true;
          breakdown.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }),
      ),
    ),
    wagesFold(rows, data),
    breakdown,
  );
  return host;
}

function monthRow(row, t, days, data, opens, changed) {
  const byDay = new Map((row.days ?? []).map((d) => [d.day, d]));
  const open = (day) => openPerson({ staff: row.staff, day, period: 'month', changed });
  const lastDay = data.to;
  const strip = h('div.rep-squares', {
    style: { '--days': days.length },
    onclick: opens
      ? (e) => { const day = e.target?.dataset?.day; if (day) open(day); }
      : null,
  }, days.map((day) => {
    const d = byDay.get(day);
    const later = day > lastDay;
    return h('span.rep-sq', {
      'data-tone': later ? 'future' : toneOf(d),
      'data-day': day,
      title: `${fmtDay(day)}: ${later ? 'to come' : d?.label ?? 'nothing'}`,
    });
  }));

  const pctTone = t.rate == null ? '' : t.rate >= 95 ? '.is-good' : t.rate >= 88 ? '' : '.is-bad';
  return h('div.rep-mrow',
    personCell(row.staff, opens ? () => open(lastDay < todayISO() ? lastDay : todayISO()) : null),
    strip,
    h(`b.rep-num.rep-pct${pctTone}`, { 'data-label': 'Turned up' }, t.rate == null ? '—' : `${t.rate}%`),
    h(`span.rep-num.rep-late${t.late >= 4 ? '.is-warn' : ''}`, { 'data-label': 'Late' }, t.late ? `${t.late}×` : '—'),
    monthMeter(row, data),
  );
}

/** Hours against their month, with a mark where the month's hours fall. */
function monthMeter(row, data) {
  const worked = row.totals.workedMinutes || 0;
  const target = Number.isFinite(row.targetMinutes) ? row.targetMinutes : (row.totals.expectedMinutes || 0);
  if (!target && !worked) {
    return h('div.rep-meter', h('div.rep-meter-nums', h('span.muted', 'No hours due')));
  }
  const diff = worked - target;
  const slack = Math.max(120, target * 0.05);
  const kind = Math.abs(diff) <= slack ? 'ok' : diff < 0 ? 'under' : diff <= slack * 3 ? 'over' : 'far';
  const word = kind === 'ok' ? 'on target' : diff < 0 ? `${hrs(-diff)}h under` : `${hrs(diff)}h over`;
  const scale = Math.max(target * 1.3, worked, 1);
  const soFar = data.to < monthDays(data.month).at(-1);
  return h(`div.rep-meter.is-${kind}`, {
    title: `Their hours a week${row.staff.weeklyHours ? ` (${fmtNum(row.staff.weeklyHours, 1)}h)` : ''}, `
      + `scaled to ${soFar ? 'the month so far' : 'the month'}, less leave and holidays`,
  },
  h('div.rep-meter-track',
    h('i.rep-meter-fill', { style: { width: `${Math.min(100, (worked / scale) * 100)}%` } }),
    target ? h('i.rep-meter-tick', { style: { left: `${Math.min(100, (target / scale) * 100)}%` } }) : null),
  h('div.rep-meter-nums',
    h('span', h('b', `${hrs(worked)}h`), ` of ${hrs(target)}h${soFar ? ' so far' : ''}`),
    h('b.rep-meter-badge', word)));
}

function monthKey() {
  const item = (tone, label) => h('span.rep-key-item', h('i.rep-key-sq', { 'data-tone': tone }), label);
  return h('div.rep-key.rep-key-month',
    item('ok', 'On time'), item('late', 'Late'), item('absent', 'Absent'),
    item('miss', 'Punch missing'), item('leave', 'Leave'), item('rest', 'Rest'),
    item('extra', 'Worked, not rostered'));
}

function departmentsCard(rows, tallies) {
  const by = new Map();
  for (const row of rows) {
    const name = row.staff.department || 'No department';
    if (!by.has(name)) by.set(name, []);
    by.get(name).push(tallies.get(row.staff.id));
  }
  const list = [...by.entries()]
    .map(([name, ts]) => ({ name, rate: addTallies(ts).rate }))
    .filter((d) => d.rate != null)
    .sort((a, b) => b.rate - a.rate);

  return h('section.rep-card.rep-sidecard',
    h('h2.rep-label', 'Turned up, by department'),
    list.length
      ? h('div.rep-bars', list.map((d) => {
        const tone = d.rate >= 95 ? 'good' : d.rate >= 85 ? 'warn' : 'bad';
        return h('div.rep-bar-row',
          h('div.rep-bar-head', h('span', d.name), h(`b.is-${tone}`, `${d.rate}%`)),
          h('div.rep-bar', h(`i.is-${tone}`, { style: { width: `${d.rate}%` } })));
      }))
      : h('p.muted.rep-small', 'Nobody was rostered this month.'));
}

/** The few people whose month is worth a conversation. */
function talkToCard(rows, tallies, opens, data, changed) {
  const items = [];
  for (const row of rows) {
    const t = tallies.get(row.staff.id);
    if (t.absent >= 2) items.push({ row, score: t.absent * 3, tone: 'absent', text: `${t.absent} absences` });
    if (t.late >= 3) items.push({ row, score: t.late * 1.5, tone: 'late', text: `${t.late} times late` });
    if (t.miss >= 2) items.push({ row, score: t.miss * 2, tone: 'miss', text: `${t.miss} punches missing` });
  }
  items.sort((a, b) => b.score - a.score);
  const day = data.to < todayISO() ? data.to : todayISO();

  return h('section.rep-card.rep-sidecard',
    h('h2.rep-label', 'People to talk to'),
    items.length
      ? h('div.rep-talk', items.slice(0, 6).map((item) => h('div.rep-talk-row',
        opens
          ? h('button.rep-link', {
            type: 'button',
            onclick: () => openPerson({ staff: item.row.staff, day, period: 'month', changed }),
          }, item.row.staff.name)
          : h('span', item.row.staff.name),
        h('b', { 'data-tone': item.tone }, item.text))))
      : h('p.muted.rep-small', 'Nobody stands out this month.'));
}

/** The labour figures in four, with the way through to all of them. */
function labourCard(deeper, more) {
  if (!deeper) return null;
  const { cost, time } = deeper;
  const pc = (n) => (n == null ? '—' : `${fmtNum(n, 1)}%`);
  const cash = (n) => (n == null ? '—' : money(n, cost?.currency ?? 'GHS'));
  const figure = (value, label, tone) => h('div.rep-fig', h(`b${tone ? `.is-${tone}` : ''}`, value), h('span', label));

  const figures = cost
    ? [
      figure(cash(cost.perHour), 'an hour rostered'),
      figure(cash(cost.perDay), 'a day worked'),
      figure(pc(cost.premiumShare), 'of the bill is overtime and holidays', cost.premiumShare >= 10 ? 'warn' : null),
      figure(fmtNum(cost.missing?.length ?? 0, 0), 'people with no pay on record', cost.missing?.length ? 'warn' : null),
    ]
    : time
      ? [
        figure(pc(time.turnout), 'turnout'),
        figure(pc(time.absenceRate), 'absence'),
        figure(pc(time.latenessRate), 'lateness'),
        figure(pc(time.scheduledAgainstAgreed), 'rostered against agreed'),
      ]
      : [];

  return h('section.rep-card.rep-sidecard',
    h('h2.rep-label', cost ? 'What the labour costs' : 'Where the time goes'),
    figures.length ? h('div.rep-figs', figures) : null,
    h('button.rep-link.rep-more', { type: 'button', onclick: more }, 'The full breakdown'));
}

/**
 * The sheet that goes to whoever does the wages: days worked and hours, what
 * was missed, leave taken and left. Folded, because the grid above answers the
 * everyday question and this answers the payroll one.
 */
function wagesFold(rows, data) {
  const totals = rows.reduce((acc, row) => ({
    daysWorked: acc.daysWorked + row.totals.daysWorked,
    workedMinutes: acc.workedMinutes + row.totals.workedMinutes,
    daysAbsent: acc.daysAbsent + row.totals.daysAbsent,
    lateCount: acc.lateCount + row.totals.lateCount,
  }), { daysWorked: 0, workedMinutes: 0, daysAbsent: 0, lateCount: 0 });

  return h('details.rep-fold',
    h('summary', h('b', 'The sheet for the wages'),
      h('span', 'Days worked, hours, overtime, absences and leave, person by person')),
    h('div.grid.grid-4', { style: { margin: '.25rem 0 1rem' } },
      tile('Days worked', fmtNum(totals.daysWorked, 1), `${rows.length} people`),
      tile('Hours', fmtNum(totals.workedMinutes / 60, 0), 'total for the month', 'var(--c3)'),
      tile('Absences', fmtNum(totals.daysAbsent, 0), 'unexcused', totals.daysAbsent ? 'var(--bad)' : null),
      tile('Late arrivals', fmtNum(totals.lateCount, 0), 'across the month', totals.lateCount ? 'var(--warn)' : null),
    ),
    card('Per person', { note: 'Click a name for the day-by-day report', wide: true },
      table([
        {
          key: 'staff',
          label: 'Name',
          format: (v) => h('div',
            h('div', h('a', {
              href: `#/att-staff?id=${v.id}`,
              onclick: (e) => { e.preventDefault(); navigate('att-staff', { id: v.id, period: 'month', day: `${data.month}-15` }); },
            }, v.name)),
            h('small.muted', v.department || `No. ${v.employee_no}`),
          ),
        },
        { key: 'totals', label: 'Rostered', align: 'right', format: (v) => fmtNum(v.scheduled, 0) },
        { key: 'worked', label: 'Worked', align: 'right', format: (v, r) => daysCell(r.totals.daysWorked) },
        { key: 'hours', label: 'Hours', align: 'right', format: (v, r) => fmtNum(r.totals.workedMinutes / 60, 1) },
        { key: 'overtime', label: 'Overtime', align: 'right', format: (v, r) => (r.totals.overtimeMinutes ? `${fmtNum(r.totals.overtimeMinutes / 60, 1)} h` : h('span.muted', '—')) },
        { key: 'late', label: 'Late', align: 'right', format: (v, r) => (r.totals.lateCount ? h('span', { style: { color: 'var(--warn)' } }, fmtNum(r.totals.lateCount, 0)) : h('span.muted', '—')) },
        { key: 'absent', label: 'Absent', align: 'right', format: (v, r) => (r.totals.daysAbsent ? h('span', { style: { color: 'var(--bad)' } }, fmtNum(r.totals.daysAbsent, 0)) : h('span.muted', '—')) },
        { key: 'leaveTaken', label: 'Leave taken', align: 'right', format: (v, r) => daysCell(r.totals.daysLeave) },
        // Leave *taken* is what happened this month and belongs to the rota.
        // Leave *left* is a balance, and whoever builds the rota is never shown
        // it: the server does not send it to them, so there is nothing to draw.
        data.showsLeave
          ? { key: 'leaveLeft', label: 'Leave left', align: 'right', format: (v, r) => h('span', { style: { color: r.leave.remaining <= 0 ? 'var(--bad)' : 'var(--good)' } }, fmtNum(r.leave.remaining, 1)) }
          : null,
        { key: 'rate', label: 'Attendance', align: 'right', format: (v, r) => (r.totals.attendanceRate == null ? h('span.muted', '—') : `${fmtNum(r.totals.attendanceRate, 0)}%`) },
      ].filter(Boolean), rows, {
        groupBy: (r) => r.staff.department,
        empty: 'Nothing recorded.',
      })),
    h('p.muted', { style: { fontSize: '.82rem' } },
      'Days worked counts a full day at or above the shift\'s full-day threshold and a half day above the '
      + 'half-day threshold, both set per shift in Settings › Rota & clocking.'
      + (data.showsLeave ? ' Leave left is against the current leave year.' : '')),
  );
}

// ---------------------------------------------------------------------------
// One person, at the side
// ---------------------------------------------------------------------------

/** The panel needs the per-person report, which not every reader of the month may open. */
const canOpenPerson = () => can(['att_reports', 'att_signoff']);

let closeOpenPanel = null;

/**
 * One person's month beside the report: a calendar coloured by day, what it
 * adds up to, and for the day picked, the shift against the punches with the
 * fixes this login may make. Everything it changes goes through the same
 * routes the day-by-day report uses.
 */
function openPerson({ staff, day, period = 'month', week = null, changed = null }) {
  closeOpenPanel?.();
  const opener = document.activeElement;
  const state = { month: monthOf(day), day, data: null, error: null, moved: false };

  const scrim = h('div.rep-scrim', { onclick: () => close() });
  const panel = h('aside.rep-drawer', {
    role: 'dialog', 'aria-modal': 'true', 'aria-label': `${staff.name}, attendance`, tabindex: '-1',
  });

  // A dialog opened from inside the panel takes Escape for itself.
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) close(); };
  const onHash = () => close();
  function close() {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', onHash);
    scrim.remove();
    panel.remove();
    if (closeOpenPanel === close) closeOpenPanel = null;
    if (opener && document.contains(opener)) opener.focus?.();
  }
  closeOpenPanel = close;
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', onHash);
  document.body.append(scrim, panel);

  const draw = () => {
    const closeBtn = h('button.rep-x', { type: 'button', 'aria-label': 'Close', onclick: close }, '✕');
    const headLine = [
      staff.department || (staff.employee_no ? `No. ${staff.employee_no}` : null),
      staff.weeklyHours ? `${fmtNum(staff.weeklyHours, 1)}h a week` : null,
    ].filter(Boolean).join(' · ');

    const report = state.moved || period === 'month'
      ? { period: 'month', day: `${state.month}-15` }
      : { period: 'week', day: week ?? state.day };

    mount(panel,
      h('div.rep-drawer-head',
        face(staff.name, { size: '3.1rem' }),
        h('div.rep-drawer-who', h('h2', staff.name), headLine ? h('div.rep-dim', headLine) : null),
        closeBtn),
      state.error
        ? h('div.rep-drawer-body', h('p.form-error', state.error))
        : !state.data
          ? h('div.rep-drawer-body', h('p.muted', 'Loading…'))
          : panelBody(state, staff, {
            pick: (d) => { state.day = d; draw(); },
            month: (n) => { state.month = shiftMonth(state.month, n); state.moved = true; load(); },
            changed: async () => { await load(); changed?.(); },
          }),
      h('div.rep-drawer-foot',
        h('button.btn-sm', {
          type: 'button',
          onclick: () => { close(); navigate('att-staff', { id: staff.id, ...report }); },
        }, report.period === 'week' ? 'This week, day by day' : 'Day-by-day report')),
    );
    if (!panel.contains(document.activeElement)) closeBtn.focus();
  };

  async function load() {
    const from = `${state.month}-01`;
    const to = monthDays(state.month).at(-1);
    state.data = null;
    state.error = null;
    draw();
    try {
      state.data = await api.attStaffReport(staff.id, from, to);
    } catch (err) {
      state.error = err.message || 'That did not load.';
    }
    if (state.data && monthOf(state.day) !== state.month) {
      // A new month: start on its first day that needs somebody, or the 1st.
      const first = state.data.days.find((d) => ['absent', 'miss', 'late'].includes(toneOf(d)));
      state.day = first?.day ?? from;
    }
    draw();
  }

  load();
}

function panelBody(state, staff, { pick, month, changed }) {
  const data = state.data;
  const t = tally(data.days);
  const nameOf = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  const byDay = new Map(data.days.map((d) => [d.day, d]));
  const days = monthDays(state.month);
  const lead = (new Date(`${days[0]}T12:00:00Z`).getUTCDay() + 6) % 7;
  const absences = t.absent + t.excused;
  const stat = (value, label, tone) => h('div.rep-pstat', h(`b${tone ? `.is-${tone}` : ''}`, value), h('span', label));

  return h('div.rep-drawer-body',
    h('div.rep-pstats',
      stat(t.rate == null ? '—' : `${t.rate}%`, `turned up in ${nameOf(state.month)}`,
        t.rate == null ? null : t.rate >= 95 ? 'good' : t.rate >= 88 ? null : 'bad'),
      stat(fmtNum(absences, 0), absences ? `absences, ${t.excused} excused` : 'absences', t.absent ? 'bad' : null),
      stat(t.late ? `${t.late}×` : '0', t.late ? `late, ${asHours(t.lateMinutes)} in all` : 'times late', t.late ? 'warn' : null),
      data.leave
        ? stat(fmtNum(data.leave.remaining, 1), 'leave days left', data.leave.remaining <= 0 ? 'bad' : 'good')
        : stat(`${hrs(data.totals?.workedMinutes ?? t.worked)}h`, 'worked'),
    ),
    h('div.rep-cal-head',
      h('span.rep-label', nameOf(state.month)),
      h('span.rep-cal-nav',
        h('button.rep-link', { type: 'button', onclick: () => month(-1) }, `‹ ${nameOf(shiftMonth(state.month, -1))}`),
        h('button.rep-link', {
          type: 'button',
          onclick: () => month(1),
          disabled: shiftMonth(state.month, 1) > monthOf(todayISO()),
        }, `${nameOf(shiftMonth(state.month, 1))} ›`))),
    h('div.rep-cal.rep-cal-days', { 'aria-hidden': 'true' },
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => h('em', d))),
    h('div.rep-cal',
      Array.from({ length: lead }, () => h('span.rep-cal-blank')),
      days.map((day) => {
        const d = byDay.get(day);
        const word = calendarWord(d);
        return h(`button.rep-cal-day${day === state.day ? '.is-picked' : ''}`, {
          type: 'button',
          'data-tone': toneOf(d),
          'aria-pressed': String(day === state.day),
          'aria-label': `${fmtDay(day)}: ${d?.label ?? 'nothing'}`,
          onclick: () => pick(day),
        }, String(Number(day.slice(8))), word ? h('small', word) : null);
      })),
    dayDetail(byDay.get(state.day), state.day, data, staff, changed),
  );
}

/** The day picked: the shift against what the clock saw, and what can be done. */
function dayDetail(record, day, data, staff, changed) {
  const title = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
  if (!record) {
    return h('div.rep-dayc', h('div.rep-dayc-head', h('b', title)), h('p.muted.rep-small', 'Nothing on record for this day.'));
  }

  const punches = punchesFor(record, day, data.punches ?? []);
  const pending = (data.pendingTimes ?? []).find((p) => p.day === day) ?? null;
  const signedSpan = (data.signedSpans ?? [])
    .find((s) => s.from <= day && s.to >= day && !(s.excluded ?? []).includes(day)) ?? null;
  const tone = toneOf(record);
  const manages = can('att_manage');

  const fixTimes = async () => {
    const done = await correctTimesDialog(record, staff, { approves: data.canApproveTimes, pending, signedSpan });
    if (done) { toast(data.canApproveTimes ? 'Times corrected.' : 'Sent for approval.', 'good'); await changed(); }
  };
  const settle = async () => {
    const done = await settleDialog(record, staff, signedSpan);
    if (done) { toast('Recorded.', 'good'); await changed(); }
  };
  const unsettle = async () => {
    if (!window.confirm(`Undo the ruling on ${fmtDay(day)} and let the punches speak for themselves?`)) return;
    await api.attUnresolve(day, { staffId: staff.id });
    toast('Back to what the terminal saw.');
    await changed();
  };

  const actions = [];
  if (data.canFixTimes && tone !== 'future' && tone !== 'leave' && tone !== 'rest') {
    actions.push(h(`button.btn-sm${tone === 'miss' ? '.btn-primary' : ''}`, { type: 'button', onclick: fixTimes },
      tone === 'miss' ? 'Add the missing time' : 'Correct the times'));
  }
  if (manages && needsAttention(record) && record.resolution !== 'resolved') {
    actions.push(h(`button.btn-sm${tone === 'absent' ? '.btn-primary' : ''}`, { type: 'button', onclick: settle },
      tone === 'absent' ? 'Excuse it or settle it' : 'Settle the day'));
  }
  if (manages && record.resolution === 'resolved') {
    actions.push(h('button.btn-sm', { type: 'button', onclick: unsettle }, 'Undo the ruling'));
  }

  return h('div.rep-dayc',
    h('div.rep-dayc-head', h('b', title), statusPill(record)),
    timeline(record, punches),
    h('div.rep-dayc-facts',
      record.shift
        ? h('span', `${record.shift.name}, ${record.shift.starts_at} to ${record.shift.ends_at}`)
        : h('span', 'No shift rostered'),
      h('span', punches.length
        ? `Clock: ${punches.map((p) => `${String(p.at).slice(11, 16)}${p.direction ? ` ${p.direction}` : ''}`).join(' · ')}`
        : 'No punches'),
      record.worked_minutes ? h('span', `${asHours(record.worked_minutes)} worked`) : null,
      record.corrected_in || record.corrected_out ? h('span', 'Times corrected by hand') : null,
    ),
    pending
      ? h('p.rep-small.rep-pending', `A change is waiting: ${pending.now_in || '—'} to ${pending.now_out || '—'}, asked by ${pending.actor}.`)
      : null,
    signedSpan ? h('p.rep-small.muted', `Signed off with ${fmtDay(signedSpan.from)} to ${fmtDay(signedSpan.to)}.`) : null,
    h('div.rep-dayc-actions',
      actions,
      h('button.rep-link', {
        type: 'button',
        onclick: () => { closeOpenPanel?.(); navigate('att-staff', { id: staff.id, period: 'day', day }); },
      }, 'The full day')),
  );
}

const clockMinutes = (t) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);

/**
 * The punches that belong to this day's shift, each with its minutes from the
 * day's midnight. A night shift's clock-out lands on the next date, and the
 * morning's clock-out from the night before is not this shift's at all.
 */
function punchesFor(record, day, punches) {
  const start = clockMinutes(record.shift?.starts_at);
  let end = clockMinutes(record.shift?.ends_at);
  if (start != null && end != null && end <= start) end += 1440;
  const inAt = clockMinutes(record.first_in);
  let outAt = clockMinutes(record.last_out);
  if (inAt != null && outAt != null && outAt < inAt) outAt += 1440;
  const [lo, hi] = start != null && end != null
    ? [Math.min(start, inAt ?? start) - 180, Math.max(end, outAt ?? end) + 180]
    : inAt != null ? [inAt - 60, (outAt ?? inAt + 960) + 60] : [0, 1440];
  return punches
    .map((p) => {
      const offset = p.day === day ? 0 : p.day === shiftDay(day, 1) ? 1440 : p.day === shiftDay(day, -1) ? -1440 : null;
      const m = clockMinutes(String(p.at).slice(11, 16));
      return offset == null || m == null ? null : { ...p, min: offset + m };
    })
    .filter((p) => p && p.min >= lo && p.min <= hi)
    .sort((a, b) => a.min - b.min);
}

/**
 * The shift as a dashed block on the day's clock, the time worked as a solid
 * bar under it, and a tick for every punch.
 */
function timeline(record, punches) {
  const min = clockMinutes;
  const start = min(record.shift?.starts_at);
  let end = min(record.shift?.ends_at);
  if (start != null && end != null && end <= start) end += 1440;
  const inAt = min(record.first_in);
  let outAt = min(record.last_out);
  if (inAt != null && outAt != null && outAt < inAt) outAt += 1440;
  const ticks = punches.map((p) => p.min);

  const known = [start, end, inAt, outAt, ...ticks].filter((n) => n != null);
  let lo = known.length ? Math.floor((Math.min(...known) - 60) / 60) * 60 : 360;
  let hi = known.length ? Math.ceil((Math.max(...known) + 60) / 60) * 60 : 1320;
  if (hi - lo < 480) { const pad = Math.ceil((480 - (hi - lo)) / 120) * 60; lo -= pad; hi += pad; }
  const at = (n) => `${((n - lo) / (hi - lo)) * 100}%`;
  const clock = (n) => {
    const m = ((n % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };

  return h('div.rep-tl', { 'aria-hidden': 'true' },
    start != null && end != null
      ? h('div.rep-tl-shift', { style: { left: at(start), width: `calc(${at(end)} - ${at(start)})` } },
        `${record.shift.starts_at} to ${record.shift.ends_at}${inAt == null && outAt == null ? ' · no punches' : ''}`)
      : null,
    inAt != null
      ? h('div.rep-tl-worked', {
        'data-tone': toneOf(record),
        style: { left: at(inAt), width: outAt != null ? `calc(${at(outAt)} - ${at(inAt)})` : '6px' },
      })
      : null,
    ticks.map((n) => h('i.rep-tl-tick', { style: { left: at(n) } })),
    h('span.rep-tl-lo', clock(lo)),
    h('span.rep-tl-hi', clock(hi)),
  );
}

/**
 * Say what a day should be charged to: the same decision the day-by-day
 * report records, through the same route.
 */
async function settleDialog(row, staff, signedSpan) {
  const { reasons } = await api.attReasons();
  const suggested = row.status === 'missing_out' || row.status === 'missing_in'
    ? (row.late_minutes > 5 ? 'late' : 'present')
    : '';
  return formDialog({
    title: `${staff.name}, ${fmtDay(row.day, { withYear: true })}`,
    submitLabel: 'Record it',
    body: h('div',
      h('p.muted', row.shift ? `${row.shift.name}, ${row.shift.starts_at} to ${row.shift.ends_at}` : 'No shift rostered for this day'),
      h('div.grid.grid-2',
        field('Clocked in', h('input', { type: 'time', name: 'in', value: row.first_in || '' }),
          row.first_in ? 'What the terminal saw' : 'The terminal saw nothing'),
        field('Clocked out', h('input', { type: 'time', name: 'out', value: row.last_out || '' }),
          row.last_out ? 'What the terminal saw' : 'The terminal saw nothing'),
      ),
      field('Record this day as',
        reasonSelect(reasons, row.reason_code || suggested, { name: 'reason', required: true })),
      field('Note', h('input', {
        type: 'text', name: 'note', maxlength: 500,
        placeholder: 'What they told you, or who confirmed it',
      })),
      h('p.muted', { style: { fontSize: '.82rem', marginBottom: 0 } },
        'Recorded against your name. The punches themselves are never altered, and it can be undone.'),
      signedSpan
        ? h('p.muted', { style: { color: 'var(--warn)', fontSize: '.85rem', marginBottom: 0 } },
          `${fmtDay(signedSpan.from)} to ${fmtDay(signedSpan.to)} has already been signed off. `
          + 'Changing this day will not change what was charged. Reopen that period and sign it again '
          + 'if the figure should move.')
        : null,
    ),
    onSubmit: async (form) => api.attResolve(row.day, {
      staffId: staff.id,
      reason: form.get('reason'),
      in: form.get('in') || null,
      out: form.get('out') || null,
      note: form.get('note') || null,
    }),
  });
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** The department asked for, if it is one on this sheet; everybody otherwise. */
function departmentOf(rows, asked) {
  if (!asked) return '';
  return rows.some((r) => (r.staff.department || '') === asked) ? asked : '';
}

const inDepartment = (rows, department) => (department
  ? rows.filter((r) => (r.staff.department || '') === department)
  : rows);

/**
 * Every department, or one. Drawn only when there is more than one to choose
 * between, and kept in the address so a live update stays on it.
 */
function departmentChips(rows, chosen, pick) {
  const names = [...new Set(rows.map((r) => r.staff.department).filter(Boolean))].sort();
  if (names.length < 2) return null;
  return h('div.rep-chips.rep-depts', { role: 'group', 'aria-label': 'Department' },
    [['', 'Every department'], ...names.map((n) => [n, n])].map(([key, label]) => h(`button.rep-chip${key === chosen ? '.on' : ''}`, {
      type: 'button',
      'aria-pressed': String(key === chosen),
      onclick: () => pick(key),
    }, label)));
}

/** A face and a name; a button when it opens the side panel. */
function personCell(staff, onOpen) {
  const inner = [
    face(staff.name, { size: '2rem' }),
    h('span.rep-who', h('b', staff.name), h('small', staff.department || `No. ${staff.employee_no}`)),
  ];
  return onOpen
    ? h('button.rep-person', { type: 'button', onclick: onOpen, title: `${staff.name}: their month` }, inner)
    : h('div.rep-person', inner);
}

function head(data) {
  return h('div.page-head',
    h('div',
      h('h1', 'Reports'),
      h('div.sub', `${fmtDay(data.from, { withYear: true })} to ${fmtDay(data.to, { withYear: true })}`),
    ),
  );
}

function repTile(value, label, tone) {
  return h('div.rep-tile', h('b', tone ? { 'data-tone': tone } : null, value), h('span', label));
}

function tile(label, value, sub, accent) {
  return h('div.stat',
    h('div.stat-label', label),
    h('div.stat-value', { style: accent ? { color: accent } : null }, value),
    sub ? h('div.stat-sub', h('span', sub)) : null,
  );
}

/** Every date of a month, as YYYY-MM-DD. */
function monthDays(month) {
  const last = Number(shiftDay(`${shiftMonth(month, 1)}-01`, -1).slice(8));
  return Array.from({ length: last }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

function mondayOf(day) {
  const d = new Date(`${day}T12:00:00Z`);
  return shiftDay(day, -((d.getUTCDay() + 6) % 7));
}

const PRINT_FOOTER = 'Clock times come from the attendance terminal. Where a punch was missing, '
  + 'the time shown was supplied by a supervisor and is noted as such.';
