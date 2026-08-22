import { api } from '../api.js';
import { fmtDayShort, fmtNum, h, money, mount, shiftDay, todayISO } from '../util.js';
import { card, emptyState } from './components.js';
import { can, navigate, replaceParams } from '../app.js';

/**
 * How the rota is treating people.
 *
 * ONE TABLE, NOT TWENTY-FOUR CARDS. The screen this replaced gave everybody a
 * card with four figures and a bullet list in it. Every fact was on the page
 * and none of them could be compared with any other: to answer "who is working
 * hardest" you read twenty-four cards and held the numbers in your head. That
 * is the one question the screen exists for.
 *
 * So: a row per person, on one scale, sortable by any of it. The load bar is
 * the whole design — hours against what the property allows over the window,
 * on an identical track for everybody, so a long bar beside a short one *is*
 * the comparison. Sorting reorders the bars and the answer is the shape of the
 * column rather than a number anybody has to hold in their head.
 *
 * WHY IT IS NOT A CHART. Twenty-four people all of whom matter is a table; a
 * bar chart of twenty-four names is a table with the numbers taken out. What
 * is drawn is the one ratio each row is about, drawn inside the row.
 *
 * COLOUR MEANS STATE HERE, NEVER IDENTITY. There is one measure, so there is
 * one fill. It turns amber and then red only where a limit has been passed,
 * and never without a word beside it saying which: a red bar nobody can name
 * is a red bar they learn to scroll past.
 */

const LEVEL_PILL = { high: 'bad', warn: 'warn' };

/** The columns, and how each sorts. Everything else follows from this list. */
const COLUMNS = [
  { key: 'name', label: 'Name', of: (r) => r.staff.name, text: true },
  { key: 'load', label: 'Load', of: (r) => r.figures.hours, wide: true },
  { key: 'days', label: 'Days', of: (r) => r.figures.daysOn, num: true },
  {
    key: 'run',
    label: 'Run',
    of: (r) => r.figures.longestRun,
    num: true,
    hint: 'The longest stretch of days with none off',
  },
  { key: 'nights', label: 'Nights', of: (r) => r.figures.nights, num: true },
  { key: 'weekends', label: 'Weekends', of: (r) => r.figures.weekends, num: true },
  {
    key: 'rest',
    label: 'Rest',
    of: (r) => r.figures.shortestTurnaround ?? 999,
    num: true,
    hint: 'The shortest gap between clocking off and clocking on again',
  },
  { key: 'flags', label: '', of: (r) => r.findings.length, num: true },
];

export async function renderAttWorkload(params) {
  const host = h('div');
  const from = params.from || mondayOf(todayISO());
  const to = params.to || shiftDay(from, 13);
  const sort = COLUMNS.some((c) => c.key === params.sort) ? params.sort : 'load';
  const dir = params.dir === 'asc' ? 'asc' : 'desc';
  const only = ['over', 'quiet', 'all'].includes(params.only) ? params.only : 'all';

  const [data, cost] = await Promise.all([
    api.attWorkload({ from, to, ...(params.department ? { department: params.department } : {}) }),
    // Only for somebody who may see pay at all, and never allowed to stop the
    // rest of the screen loading.
    can('hr_pay') ? api.attLabourCost({ from, to }).catch(() => null) : Promise.resolve(null),
  ]);

  const reload = async (next = {}) => {
    const merged = { ...params, from, to, sort, dir, only, ...next };
    replaceParams('att-workload', merged);
    mount(host, await renderAttWorkload(merged));
  };

  // What this property allows one person over a window this long, and the
  // scale every bar is drawn against.
  //
  // The scale is not the allowance. A property where most people are over it
  // — which is the property that needs this screen — would have every bar
  // pinned at the end of its track and no two of them comparable, which is
  // the one thing the bars are for. So the scale runs to the busiest person,
  // with a line drawn where the allowance falls: the bars stay comparable and
  // the limit is a place on them rather than the edge of the world.
  const weeks = Math.max(1, data.span) / 7;
  const allowance = Math.max(1, Math.round((data.limits?.weeklyHours?.value ?? 40) * weeks));
  const busiest = data.rows.reduce((n, r) => Math.max(n, r.figures.hours), 0);
  const scale = Math.max(allowance, Math.ceil(busiest / 10) * 10);

  const over = data.rows.filter((r) => r.findings.some((f) => f.level === 'high'));
  const quiet = data.rows.filter((r) => r.resting.length);

  const shown = only === 'over' ? over : only === 'quiet' ? quiet : data.rows;
  const column = COLUMNS.find((c) => c.key === sort);
  const ordered = [...shown].sort((a, b) => {
    const x = column.of(a);
    const y = column.of(b);
    const cmp = column.text ? String(x).localeCompare(String(y)) : Number(x) - Number(y);
    return dir === 'asc' ? cmp : -cmp;
  });

  const hours = data.rows.reduce((n, r) => n + r.figures.hours, 0);

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Workload'),
        h('div.sub', 'How the rota is treating people, before it is worked'),
      ),
      h('button.btn-sm', { onclick: () => navigate('att-rota', { from, to }) }, 'Open the rota'),
    ),

    h('div.toolbar',
      h('button.btn-sm', {
        onclick: () => reload({ from: shiftDay(from, -14), to: shiftDay(to, -14) }),
        'aria-label': 'The fortnight before',
      }, '‹'),
      h('input', {
        type: 'date', value: from, 'aria-label': 'Fortnight beginning',
        onchange: (e) => e.target.value && reload({ from: e.target.value, to: shiftDay(e.target.value, 13) }),
      }),
      h('button.btn-sm', {
        onclick: () => reload({ from: shiftDay(from, 14), to: shiftDay(to, 14) }),
        'aria-label': 'The fortnight after',
      }, '›'),
      h('button.btn-sm', {
        onclick: () => reload({ from: mondayOf(todayISO()), to: shiftDay(mondayOf(todayISO()), 13) }),
      }, 'This fortnight'),
      h('div', { style: { flex: 1 } }),
      data.departments?.length
        ? h('select', {
          'aria-label': 'Department',
          onchange: (e) => reload({ department: e.target.value || null }),
        },
        h('option', { value: '' }, 'Every department'),
        data.departments.map((d) => h('option', {
          value: d, selected: params.department === d,
        }, d)))
        : null,
    ),

    // The four numbers the fortnight comes down to, and three of them are also
    // the filter. A count somebody has to act on should be the way in to the
    // people behind it rather than a figure they then go hunting for.
    h('div.grid.grid-4.wl-tiles',
      pick('Everybody', String(data.rows.length),
        `${fmtNum(hours, 0)} hours rostered`, only === 'all', () => reload({ only: 'all' })),
      pick('Over a limit', String(over.length),
        over.length ? 'the law, or your own rules' : 'nothing over a limit',
        only === 'over', over.length ? () => reload({ only: 'over' }) : null,
        over.length ? 'bad' : 'good'),
      pick('Barely used', String(quiet.length),
        quiet.length ? 'carried by the rest of their department' : 'everybody is being used',
        only === 'quiet', quiet.length ? () => reload({ only: 'quiet' }) : null,
        quiet.length ? 'warn' : 'good'),
      pick('Each may work', `${allowance} h`,
        `${fmtDayShort(data.from)} – ${fmtDayShort(data.to)}`),
    ),

    data.rows.length
      ? card(
        only === 'over' ? 'Over a limit' : only === 'quiet' ? 'Barely used' : 'Everybody, compared',
        {
          note: `${ordered.length} of ${data.rows.length} · by `
            + `${(column.label || 'warnings').toLowerCase()}`,
          wide: true,
          actions: only === 'all'
            ? null
            : h('button.btn-sm', { onclick: () => reload({ only: 'all' }) }, 'Show everybody'),
        },
        ordered.length
          ? comparison(ordered, { data, allowance, scale, sort, dir, reload })
          : h('p.muted', 'Nobody in this group.'),
      )
      : emptyState('Nobody to look at',
        'No active staff in this window — or none in the department chosen.'),

    cost ? costCard(cost) : null,
    limitsCard(data.limits),
  );

  return host;
}

/**
 * One figure, which is also a filter.
 *
 * The tone lives on the number rather than the whole tile: a card washed in
 * red because six people are over a limit shouts at somebody who has already
 * read the six.
 */
function pick(label, value, sub, active, onclick, tone = '') {
  return h(`div.stat${onclick ? '.stat-open' : ''}${active ? '.stat-on' : ''}`, onclick
    ? {
      role: 'button',
      tabindex: 0,
      onclick,
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onclick(); }
      },
    }
    : null,
  h('div.stat-label', label),
  h(`div.stat-value${tone ? `.stat-${tone}` : ''}`, value),
  h('div.stat-sub', sub));
}

/**
 * Everybody on one scale.
 *
 * The table is the chart. Each row's bar runs against the same track, so
 * sorting reorders the bars and the answer is the shape of the column.
 */
function comparison(rows, { data, allowance, scale, sort, dir, reload }) {
  const head = (col) => {
    const on = sort === col.key;
    return h(`th${col.num ? '.num' : ''}${col.wide ? '.wl-load-head' : ''}`, {
      title: col.hint ?? (col.label ? `Sort by ${col.label.toLowerCase()}` : 'Sort by warnings'),
    }, h('button.th-sort', {
      onclick: () => reload({ sort: col.key, dir: on && dir === 'desc' ? 'asc' : 'desc' }),
    }, col.label || '⚠', on ? h('span.th-arrow', dir === 'desc' ? '▾' : '▴') : null));
  };

  const rowsFor = (row) => {
    const f = row.figures;
    const worst = row.findings.some((x) => x.level === 'high') ? 'high'
      : row.findings.length ? 'warn' : null;

    const open = h('tr.wl-findings', { style: { display: 'none' } },
      h('td', { colspan: COLUMNS.length },
        h('ul.finding-list', row.findings.length
          ? row.findings.map((found) => h('li',
            h(`span.pill.${LEVEL_PILL[found.level] ?? ''}`,
              found.level === 'high' ? 'over' : 'watch'),
            h('div',
              h('div.finding-title', found.title),
              h('div.finding-detail', found.detail,
                found.law ? h('span.finding-law', ` ${found.law}`) : null))))
          : [h('li', h('span.pill.good', 'fine'),
            h('div',
              h('div.finding-title', 'Nothing over a limit'),
              h('div.finding-detail',
                `${f.daysOn} days, ${fmtNum(f.hours, 0)} hours, longest run ${f.longestRun}.`)))]),

        h('div.btn-row', { style: { marginTop: '.5rem' } },
          h('button.btn-sm', {
            onclick: (e) => {
              e.stopPropagation();
              navigate('att-staff', { id: row.staff.id, from: data.from, to: data.to });
            },
          }, 'Their record'),
          h('button.btn-sm', {
            onclick: (e) => {
              e.stopPropagation();
              navigate('att-rota', { from: data.from, to: data.to });
            },
          }, 'The rota'))));

    const toggle = () => {
      const showing = open.style.display !== 'none';
      open.style.display = showing ? 'none' : '';
      main.classList.toggle('wl-open', !showing);
      main.setAttribute('aria-expanded', String(!showing));
    };

    const main = h(`tr.wl-row${worst ? `.wl-${worst}` : ''}`, {
      tabindex: 0,
      role: 'button',
      'aria-expanded': 'false',
      title: 'What is behind these figures',
      onclick: toggle,
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      },
    },
    h('td',
      h('div.wl-name', row.staff.name),
      h('small.muted', row.staff.department || `No. ${row.staff.employee_no}`),
      // On a handset the warning count rides with the name: the column it
      // lives in is one of the five that fold away, and a row with three
      // things wrong with it should still say so before it is opened.
      row.findings.length
        ? h('small.on-phone', h(`span.pill.${LEVEL_PILL[worst] ?? ''}`,
          `${row.findings.length} to look at`))
        : null),

    h('td.wl-load', loadBar(f.hours, allowance, scale, worst, f)),

    h('td.num', String(f.daysOn),
      f.expected ? h('small.muted', ` /${f.expected}`) : null),
    h('td.num', String(f.longestRun)),
    h('td.num', f.nights ? String(f.nights) : h('span.muted', '—')),
    h('td.num', f.weekends ? String(f.weekends) : h('span.muted', '—')),
    h('td.num', f.shortestTurnaround != null
      ? `${fmtNum(f.shortestTurnaround, 0)} h`
      : h('span.muted', '—')),
    h('td.num', row.findings.length
      ? h(`span.pill.${LEVEL_PILL[worst] ?? ''}`, String(row.findings.length))
      : h('span.muted', '·')));

    return [main, open];
  };

  return h('div',
    h('div.table-wrap',
      h('table.wl-table',
        h('thead', h('tr', COLUMNS.map(head))),
        h('tbody', rows.flatMap(rowsFor)))),
    h('p.wl-key',
      h('span.wl-key-item', h('span.wl-key-swatch'), 'Hours rostered'),
      h('span.wl-key-item', h('span.wl-key-line'), `The ${allowance} hours one person may work`),
      h('span.muted', 'Press a row for what is behind it.'),
    ),
  );
}

/**
 * Hours against what the property allows, on the same track for everybody.
 *
 * A meter rather than a bar chart: the question is one ratio against one
 * limit, repeated down the page. The track is the limit, so a bar that reaches
 * the end is somebody at it — and anything past the end is drawn as an
 * overflow rather than by rescaling, because rescaling would move everybody
 * else's bar to make room for one person's bad fortnight.
 */
function loadBar(hours, allowance, scale, worst, figures) {
  const spill = Math.max(0, Math.round(hours - allowance));

  return h('div.wl-meter', {
    title: `${fmtNum(hours, 0)} hours of ${allowance} allowed`
      + `${spill ? `, ${spill} over` : ''}`
      + `${figures.heaviestWeek ? `. Heaviest week ${fmtNum(figures.heaviestWeek, 0)} h` : ''}`,
  },
  h('div.wl-track',
    h('div.wl-fill', {
      class: spill ? 'wl-fill-over' : worst === 'high' ? 'wl-fill-high' : worst ? 'wl-fill-warn' : '',
      style: { width: `${Math.round((Math.min(hours, scale) / scale) * 100)}%` },
    }),
    // Where the allowance falls on the same scale. A line rather than the end
    // of the track, so being over it is a distance somebody can see rather
    // than a bar that has simply run out of room.
    h('div.wl-limit', { style: { left: `${Math.round((allowance / scale) * 100)}%` } })),
  h('div.wl-figure',
    h('strong', fmtNum(hours, 0)),
    // The unit stays in text ink. The bar beside it carries the state.
    h('small.muted', ' h'),
    spill ? h('span.pill.bad.wl-over-pill', `+${spill}`) : null));
}

/**
 * What the fortnight costs, and which part of it the rota can change.
 *
 * Split on purpose. A monthly salary does not move because somebody worked a
 * sixth day, so a single total reacts to the rota in ways the bank balance
 * never will — and a planner trying to save money ends up cutting the shifts
 * that cost nothing while the overtime carries on.
 */
function costCard(cost) {
  const m = (n) => money(n, cost.currency);

  return card('What this costs', {
    note: `${fmtDayShort(cost.from)} – ${fmtDayShort(cost.to)}`,
    wide: true,
  },
    h('div.grid.grid-4', { style: { marginBottom: '.8rem' } },
      h('div.stat',
        h('div.stat-label', 'Wage bill'),
        h('div.stat-value', m(cost.totals.total)),
        h('div.stat-sub', `${fmtNum(cost.totals.hours, 0)} h · ${m(cost.totals.perHour)} an hour`)),
      h('div.stat',
        h('div.stat-label', 'Fixed'),
        h('div.stat-value', m(cost.totals.fixed)),
        h('div.stat-sub', 'salaries — the rota cannot move this')),
      h('div.stat',
        h('div.stat-label', 'The rota’s doing'),
        h('div.stat-value', m(cost.totals.variable)),
        h('div.stat-sub', 'daily and hourly staff')),
      h('div.stat',
        h('div.stat-label', 'Overtime and holidays'),
        h('div.stat-value', m(cost.totals.premium)),
        h('div.stat-sub', `at ${cost.rates.overtimeMultiplier}× and ${cost.rates.holidayMultiplier}×`)),
    ),

    // Named, not counted. Until every one of these has a rate the total above
    // is an understatement rather than an answer, and a count sends somebody
    // hunting where a list sends them straight there.
    cost.missing.length
      ? h('div.alert.warn',
        h('span.alert-icon', '⚠️'),
        h('div',
          h('div.alert-title',
            `${cost.missing.length} ${cost.missing.length === 1 ? 'person has' : 'people have'} no rate recorded`),
          h('div.alert-detail',
            `${cost.missing.map((p) => p.name).join(', ')}. `
            + 'They are left out of every figure above rather than counted as free.')))
      : null,

    cost.departments.length
      ? h('div.table-wrap', h('table',
        h('thead', h('tr',
          h('th', 'Department'), h('th.num', 'People'), h('th.num', 'Hours'),
          h('th.num', 'Fixed'), h('th.num', 'Rota'), h('th.num', 'Premium'), h('th.num', 'Total'),
        )),
        h('tbody', cost.departments.map((d) => h('tr',
          h('td', d.department),
          h('td.num', String(d.people)),
          h('td.num', fmtNum(d.hours, 0)),
          h('td.num', m(d.fixed)),
          h('td.num', m(d.variable)),
          h('td.num', d.premium ? m(d.premium) : h('span.muted', '—')),
          h('td.num', h('strong', m(d.total))),
        )))))
      : null,
  );
}

/** What the app is measuring against, said plainly and in one place. */
function limitsCard(limits) {
  const rows = Object.entries(limits ?? {});
  if (!rows.length) return null;

  return h('details.limits-card',
    h('summary', 'What counts as too much here'),
    h('p.muted', { style: { fontSize: '.85rem' } },
      'The first four are the law. The rest are this property’s own. Every one of them is set '
      + 'under ',
      h('a', { href: '#/att-setup?tab=workload' }, 'Setup, Workload'),
      '. Nothing here ever stops a rota being saved: a hotel has nights when somebody has to '
      + 'cover, and an app that refuses to record what happened is one people work around on '
      + 'paper.'),
    h('ul.finding-list',
      rows.map(([key, spec]) => h('li',
        h(`span.pill${spec.law ? '' : '.warn'}`, spec.law ? 'law' : 'ours'),
        h('div',
          h('div.finding-title', `${spec.label}: ${spec.value}`),
          h('div.finding-detail',
            spec.law ? spec.law : 'Set by this property',
            spec.changed ? h('span.finding-law', ' · changed from the default') : null),
        )))));
}

/** The Monday on or before a day, which is where a rota fortnight starts. */
function mondayOf(day) {
  const date = new Date(`${day}T12:00:00Z`);
  const back = (date.getUTCDay() + 6) % 7;
  return shiftDay(day, -back);
}
