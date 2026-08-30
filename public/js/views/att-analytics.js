import { deltaBadge, fmtNum, h, money } from '../util.js';
import { card } from './components.js';

/**
 * The workforce, measured.
 *
 * FOUR QUESTIONS, IN THE ORDER A HOTEL ASKS THEM. What does the labour cost
 * and which part of that could be different; where does the time go against
 * what was agreed; who is at risk and what liability sits behind them; what
 * shape is the cover across a day. Each is a block, each block opens with the
 * two or three figures somebody would repeat out loud, and the working is
 * under them.
 *
 * A RATE, NOT A TOTAL, WHEREVER A RATE EXISTS. A wage bill that went up tells
 * nobody anything: it goes up when trade goes up, which is the point of trade.
 * Cost per worked hour, absence as a share of the days actually rostered,
 * premium as a share of the bill — those move only when something has changed,
 * and they are the figures with a delta beside them.
 *
 * ONE MEASURE, ONE FILL. Every bar on this screen is the same measure repeated
 * down a column against the same track, so a long bar beside a short one *is*
 * the comparison. Colour is state — fine, watch, over — and never identity.
 * Nothing here is a pie, and nothing has two axes.
 *
 * A BLANK IS NOT A NOUGHT. Everything comes through as null where there was
 * no denominator, and a null is drawn as a dash. A department with nobody in
 * it has no absence rate, and printing 0% would be a claim nobody made.
 */

const pc = (n) => (n == null ? '—' : `${fmtNum(n, 1)}%`);
/** A share, or nothing known where there was no denominator. */
const share = (part, whole) => (Math.abs(Number(whole) || 0) < 1e-9
  ? null
  : Math.round((Number(part) || 0) / whole * 1000) / 10);
const num = (n, places = 0) => (n == null ? '—' : fmtNum(n, places));

/** A headline figure, with what it was last time under it. */
function tile(label, value, sub, versus, { higherIsBetter = false } = {}) {
  return h('div.stat',
    h('div.stat-label', label),
    h('div.stat-value', value),
    versus?.percent != null
      ? h('div.stat-sub',
        deltaBadge(versus.percent, { higherIsBetter }),
        h('span.muted', ` from ${sub ?? ''}`))
      : h('div.stat-sub', sub ?? ''));
}

/**
 * One measure down a column, on one track.
 *
 * The track is the largest value in the set rather than a round number, so the
 * longest bar always fills it and the rest are read against that. What the
 * figure *is* stays in text at the end of the row: the bar is for comparing,
 * the number is for quoting.
 */
function barRows(rows, { max, tone = () => '', label, figure, title } = {}) {
  const top = max ?? Math.max(1, ...rows.map((r) => Math.abs(Number(r.value) || 0)));
  return h('div.an-bars', rows.map((row) => h('div.an-bar', { title: title?.(row) ?? null },
    h('div.an-bar-label', label ? label(row) : row.name),
    h('div.an-bar-track',
      h(`div.an-bar-fill${tone(row) ? `.${tone(row)}` : ''}`, {
        style: { width: `${Math.round((Math.abs(Number(row.value) || 0) / top) * 100)}%` },
      })),
    h('div.an-bar-figure', figure ? figure(row) : num(row.value)))));
}

// --------------------------------------------------------------------------

export function analyticsSection(data, { currency = 'GHS' } = {}) {
  const cash = (n) => (n == null ? '—' : money(n, data.cost?.currency ?? currency));

  return h('div.an',
    data.cost ? costBlock(data.cost, cash) : null,
    timeBlock(data.time),
    riskBlock(data.risk, cash),
    shapeBlock(data.shape),
  );
}

// --------------------------------------------------------------------------
// What it costs
// --------------------------------------------------------------------------

function costBlock(cost, cash) {
  const v = cost.versus ?? {};
  const split = [
    { name: 'Salaries', value: cost.totals.fixed, note: 'the rota cannot move this' },
    { name: 'Daily and hourly', value: cost.totals.variable, note: 'what the rota itself adds' },
    { name: 'Overtime and holidays', value: cost.totals.premium, note: 'paid at a premium' },
  ].filter((part) => part.value > 0);

  return card('What the labour costs', {
    wide: true,
    note: v.from ? `against ${v.from} to ${v.to}` : null,
  },
  h('p.muted.an-lede',
    'Read as rates rather than as a total. A wage bill goes up when trade goes up, which is '
    + 'the point of trade; cost per worked hour only moves when something has actually changed.'),

  h('div.grid.grid-4.an-tiles',
    tile('Cost an hour', cash(cost.perHour), 'across every hour rostered', v.perHour),
    tile('Cost a day', cash(cost.perDay), 'per day somebody worked', v.perDay),
    // Higher is worse for both of these, which is the default.
    tile('Overtime and holidays', pc(cost.premiumShare),
      'of the bill, and the part a rota can change', v.premiumShare),
    tile('The whole bill', cash(cost.totals.total),
      `${num(cost.totals.hours)} hours, ${cost.people} people`, v.total)),

  cost.premiumShare != null && cost.premiumShare >= 10
    ? h('div.alert.warn',
      h('span.alert-icon', '⚠️'),
      h('div',
        h('div.alert-title', `${pc(cost.premiumShare)} of the bill is premium pay`),
        h('div', `${num(cost.totals.overtimeHours)} hours of overtime and `
          + `${num(cost.totals.holidayHours)} on public holidays. Over about a tenth usually `
          + 'means a vacancy being covered rather than a busy fortnight.')))
    : null,

  h('div.an-split',
    h('section',
      h('h3.an-head', 'What a rota could actually change'),
      h('p.muted.an-note',
        'A monthly salary does not go up because somebody worked a sixth day. Only the bottom '
        + 'two move with the rota, and burying them inside one total is how a hotel ends up '
        + 'cutting shifts that cost it nothing.'),
      barRows(split, {
        max: cost.totals.total || 1,
        tone: (r) => (r.name === 'Overtime and holidays' ? 'is-watch' : ''),
        label: (r) => h('div', h('div', r.name), h('small.muted', r.note)),
        figure: (r) => cash(r.value),
        title: (r) => `${pc(share(r.value, cost.totals.total))} of the bill`,
      })),

    h('section',
      h('h3.an-head', 'Where the figures came from'),
      h('p.muted.an-note',
        cost.fromPayroll
          ? (cost.fromPayroll === cost.people
            ? 'All of these come from what the payroll pays today, including the property\u2019s '
              + 'own pension contribution. Nobody has a dated rate on their record, so a window '
              + 'in the past is priced at today\u2019s salaries rather than at the ones in force '
              + 'at the time.'
            : `${cost.fromPayroll} of ${cost.people} come from what the payroll pays today `
              + 'rather than from a rate dated to the window.')
          : 'Every figure comes from a rate dated to the window, so a window in the past is '
            + 'priced at what people were actually on at the time.'),
      cost.missing?.length
        ? h('div.alert.warn',
          h('span.alert-icon', '\u26a0\ufe0f'),
          h('div',
            h('div.alert-title',
              `${cost.missing.length} not priced at all`),
            h('div', 'Everything above is an understatement until each of these has a salary '
              + `on their record: ${cost.missing.map((m) => m.name).join(', ')}.`)))
        : null)),

  cost.byDepartment.length
    ? h('div.an-split',
      h('section',
        h('h3.an-head', 'Cost an hour, by department'),
        h('p.muted.an-note',
          'The same measure on one track, so the longest bar is the most expensive hour of '
          + 'work in the building.'),
        barRows(
          cost.byDepartment.filter((d) => d.perHour != null)
            .map((d) => ({ ...d, name: d.department, value: d.perHour })),
          {
            figure: (r) => cash(r.perHour),
            title: (r) => `${r.people} people, ${num(r.hours)} hours, ${cash(r.total)}`,
          },
        )),

      h('section',
        h('h3.an-head', 'Where it goes'),
        h('p.muted.an-note',
          `${cost.concentration ? `${cost.concentration.people} of ${cost.concentration.of} people `
            + 'carry the first half of it.' : ''}`),
        h('div.table-wrap', h('table.an-table',
          h('thead', h('tr',
            h('th', 'Name'), h('th.num', 'Cost'), h('th.num', 'An hour'),
            h('th.num', 'Share'), h('th.num', 'Running'))),
          h('tbody', cost.drivers.map((d) => h('tr',
            h('td', d.staff.name,
              d.staff.department ? h('small.muted', ` · ${d.staff.department}`) : null),
            h('td.num', cash(d.total)),
            h('td.num', cash(d.perHour)),
            h('td.num', pc(d.shareOfBill)),
            h('td.num.muted', pc(d.runningShare)))))))))
    : null,

  h('div.table-wrap', h('table.an-table',
    h('thead', h('tr',
      h('th', 'Department'), h('th.num', 'People'), h('th.num', 'Hours'),
      h('th.num', 'Cost'), h('th.num', 'An hour'), h('th.num', 'Premium'),
      h('th.num', 'Share of bill'))),
    h('tbody', cost.byDepartment.map((d) => h('tr',
      h('td', d.department),
      h('td.num', d.people),
      h('td.num', num(d.hours)),
      h('td.num', cash(d.total)),
      h('td.num', cash(d.perHour)),
      h('td.num', pc(d.premiumShare)),
      h('td.num.muted', pc(d.shareOfBill))))))));
}

// --------------------------------------------------------------------------
// Where the time goes
// --------------------------------------------------------------------------

function timeBlock(time) {
  const t = time.totals;

  return card('Where the time goes', { wide: true, note: `${t.people} people` },
    h('p.muted.an-lede',
      'Two different questions, and mixing them sends somebody to talk to the wrong person. '
      + 'Did the rota ask of people what was agreed with them — and having been asked, did '
      + 'they turn up and stay.'),

    h('div.grid.grid-4.an-tiles',
      tile('Rostered against agreed', pc(time.scheduledAgainstAgreed),
        `${num(t.scheduledDays)} days asked of ${num(t.expectedDays)} agreed`),
      tile('Absence', pc(time.absenceRate),
        `${num(t.absentDays)} of ${num(t.dueDays)} rostered days missed`),
      tile('Lateness', pc(time.latenessRate),
        `${num(t.lateDays)} late arrivals, ${num(t.lateMinutes)} minutes in all`),
      tile('Turnout', pc(time.turnout),
        `${num(t.workedHours)} hours worked of ${num(t.scheduledHours)} rostered`)),

    h('div.an-split',
      h('section',
        h('h3.an-head', 'Absence by department'),
        h('p.muted.an-note',
          'Of the days each department was actually rostered for. A department nobody '
          + 'rostered has no rate rather than a perfect one.'),
        barRows(
          time.byDepartment.filter((d) => d.absenceRate != null)
            .map((d) => ({ ...d, name: d.department, value: d.absenceRate })),
          {
            max: Math.max(10, ...time.byDepartment.map((d) => d.absenceRate ?? 0)),
            tone: (r) => (r.value >= 8 ? 'is-over' : r.value >= 4 ? 'is-watch' : ''),
            figure: (r) => pc(r.value),
            title: (r) => `${r.absentDays} of ${r.dueDays} days`,
          },
        )),

      h('section',
        h('h3.an-head', 'The people to ask about'),
        h('p.muted.an-note', 'Most days missed first. Days nobody rostered are not counted.'),
        h('div.table-wrap', h('table.an-table',
          h('thead', h('tr',
            h('th', 'Name'), h('th.num', 'Rostered'), h('th.num', 'Missed'),
            h('th.num', 'Late'), h('th.num', 'Minutes'))),
          h('tbody', time.rows.filter((r) => r.absentDays || r.lateDays).slice(0, 10)
            .map((r) => h('tr',
              h('td', r.staff.name,
                r.staff.department ? h('small.muted', ` · ${r.staff.department}`) : null),
              h('td.num', r.dueDays),
              h('td.num', r.absentDays || h('span.muted', '—')),
              h('td.num', r.lateDays || h('span.muted', '—')),
              h('td.num.muted', r.lateMinutes || '—'))))))),
    ),

    h('div.table-wrap', h('table.an-table',
      h('thead', h('tr',
        h('th', 'Department'), h('th.num', 'People'), h('th.num', 'Agreed'),
        h('th.num', 'Rostered'), h('th.num', 'Of agreed'), h('th.num', 'Absence'),
        h('th.num', 'Lateness'), h('th.num', 'Turnout'))),
      h('tbody', time.byDepartment.map((d) => h('tr',
        h('td', d.department),
        h('td.num', d.people),
        h('td.num', num(d.expectedDays)),
        h('td.num', num(d.scheduledDays)),
        h('td.num', pc(d.scheduledAgainstAgreed)),
        h('td.num', pc(d.absenceRate)),
        h('td.num', pc(d.latenessRate)),
        h('td.num.muted', pc(d.turnout))))))));
}

// --------------------------------------------------------------------------
// Who is at risk
// --------------------------------------------------------------------------

function riskBlock(risk, cash) {
  return card('Who is at risk', {
    wide: true,
    note: `${risk.strained} strained · ${risk.watch} to watch`,
  },
  h('p.muted.an-lede',
    'The strain score behind the table above, ranked, with what put each person there. '
    + 'Untaken leave is priced beside it because it is a real bill that grows quietly and '
    + 'falls due in a lump the day somebody resigns.'),

  h('div.grid.grid-4.an-tiles',
    tile('Strained', num(risk.strained), 'scoring 60 or more'),
    tile('Worth watching', num(risk.watch), 'between 30 and 60'),
    tile('Leave owed', `${num(risk.leave.days, 1)} days`,
      risk.leave.unpriced
        ? `${risk.leave.unpriced} of them not priced`
        : 'across everybody on the rota'),
    tile('What that is worth', cash(risk.leave.liability),
      'at each person’s own daily rate')),

  h('div.an-split.an-split-lead',
    h('section',
      h('h3.an-head', 'The twelve to look at first'),
      risk.ranked.length
        ? barRows(risk.ranked.map((r) => ({ ...r, name: r.staff.name, value: r.score })), {
          max: 100,
          tone: (r) => (r.value >= 60 ? 'is-over' : r.value >= 30 ? 'is-watch' : ''),
          figure: (r) => num(r.value),
          label: (r) => h('div',
            h('div', r.staff.name),
            r.why.length ? h('small.muted', r.why[0]) : null),
          title: (r) => (r.why.length ? r.why.join(' · ') : `${r.daysOn} days, ${r.hours} hours`),
        })
        : h('p.muted', 'Nobody is carrying anything unusual this period.')),

    h('section',
      h('h3.an-head', 'What is being broken'),
      h('p.muted.an-note',
        'Counted by rule rather than by person: four people short of a turnaround is one '
        + 'rostering habit, not four separate problems.'),
      risk.breaches.length
        ? h('ul.an-list', risk.breaches.map((b) => h('li',
          h('span', b.title),
          h('strong', `${b.people} ${b.people === 1 ? 'person' : 'people'}`))))
        : h('p.muted', 'No hard limit is being passed in this window.'))));
}

// --------------------------------------------------------------------------
// What shape the cover is
// --------------------------------------------------------------------------

const HOUR = (n) => `${String(n).padStart(2, '0')}:00`;

function shapeBlock(shape) {
  const peak = Math.max(1, ...shape.byHour.map((x) => x.people));

  return card('What shape the cover is', {
    wide: true,
    note: `${shape.headcount.active} on the books`,
  },
  h('p.muted.an-lede',
    'A rota looks balanced as a grid of shifts and is often not balanced at all as a curve '
    + 'across the day. Three shifts that all start at eight leave the building empty at six, '
    + 'and no table of shift counts ever shows that.'),

  h('div.grid.grid-4.an-tiles',
    tile('Busiest hour', shape.busiest ? HOUR(shape.busiest.hour) : '—',
      shape.busiest ? `${num(shape.busiest.people, 1)} people on` : 'nobody rostered'),
    tile('Thinnest staffed hour', shape.thinnest ? HOUR(shape.thinnest.hour) : '—',
      shape.thinnest ? `${num(shape.thinnest.people, 1)} people on` : '—'),
    tile('Spread', num(shape.spread, 1), 'between the fullest and thinnest hour'),
    tile('Joined and left', `${shape.headcount.joiners} / ${shape.headcount.leavers}`,
      shape.headcount.turnover != null
        ? `${pc(shape.headcount.turnover)} turnover this window`
        : 'in this window')),

  h('h3.an-head', 'People on, hour by hour'),
  h('p.muted.an-note',
    'Averaged over the days in the window, so a fortnight and a month can be read against '
    + 'each other. A night shift counts on the hours it actually covers.'),
  h('div.an-hours',
    shape.byHour.map((slot) => h('div.an-hour', {
      title: `${HOUR(slot.hour)} — ${num(slot.people, 1)} people on`,
    },
    h('div.an-hour-track',
      h('div.an-hour-fill', {
        style: { height: `${Math.round((slot.people / peak) * 100)}%` },
      })),
    // Every third hour, or twenty-four labels sit on top of each other.
    h('div.an-hour-label', slot.hour % 3 === 0 ? String(slot.hour).padStart(2, '0') : '')))),

  h('h3.an-head', 'People on, by day of the week'),
  barRows(
    shape.byWeekday.filter((d) => d.people != null)
      .map((d) => ({ ...d, name: d.day, value: d.people })),
    {
      figure: (r) => `${num(r.value, 1)} on · ${num(r.hours, 0)} h`,
      title: (r) => `${r.dates} of them in this window`,
    },
  ));
}
