import { api } from '../api.js';
import { fmtDay, fmtDayShort, fmtNum, h, money, mount, shiftDay, todayISO } from '../util.js';
import { card, emptyState } from './components.js';
import { can, navigate, replaceParams } from '../app.js';

/**
 * How the rota is treating people.
 *
 * Two lists, because they are two different problems and averaging them hides
 * both. On the left, whoever is being worked hardest — a run of days with
 * nothing off, a turnaround too short to sleep in, a week over forty hours. On
 * the right, whoever is being left out: fewer days than the month expected of
 * them, none of the weekends their colleagues are covering, leave nobody has
 * released them to take.
 *
 * Every line names its rule and, where the rule is the law, its section. A
 * warning somebody can look up is one they act on; a bare red dot is one they
 * learn to scroll past.
 */

const LEVEL_PILL = { high: 'bad', warn: 'warn' };

export async function renderAttWorkload(params) {
  const host = h('div');
  const from = params.from || mondayOf(todayISO());
  const to = params.to || shiftDay(from, 13);

  const [data, cost] = await Promise.all([
    api.attWorkload({ from, to, ...(params.department ? { department: params.department } : {}) }),
    // Only for somebody who may see pay at all, and never allowed to stop the
    // rest of the screen loading.
    can('hr_pay') ? api.attLabourCost({ from, to }).catch(() => null) : Promise.resolve(null),
  ]);

  const reload = async (next = {}) => {
    const merged = { ...params, from, to, ...next };
    replaceParams('att-workload', merged);
    mount(host, await renderAttWorkload(merged));
  };

  const strained = data.rows.filter((r) => r.findings.some((f) => f.level === 'high') || r.score >= 40);
  const quiet = data.rows.filter((r) => r.resting.length);
  const settled = data.rows.filter((r) => !r.findings.length && !r.resting.length);

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Workload'),
        h('div.sub', 'How the rota is treating people, before it is worked'),
      ),
    ),

    h('div.toolbar',
      h('button.btn-sm', { onclick: () => reload({ from: shiftDay(from, -14), to: shiftDay(to, -14) }) }, '‹ Earlier'),
      h('input', {
        type: 'date', value: from, 'aria-label': 'From',
        onchange: (e) => e.target.value && reload({ from: e.target.value, to: shiftDay(e.target.value, 13) }),
      }),
      h('button.btn-sm', { onclick: () => reload({ from: shiftDay(from, 14), to: shiftDay(to, 14) }) }, 'Later ›'),
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

    h('p.muted', { style: { marginTop: '-.3rem' } },
      `${fmtDay(data.from)} to ${fmtDay(data.to)} · ${data.summary.people} people · `,
      data.summary.breaches
        ? h('strong', `${data.summary.breaches} over a limit`)
        : h('span', 'nothing over a limit'),
    ),

    cost ? costCard(cost) : null,

    strained.length
      ? h('div',
        h('h2.group-head', h('span.pill.bad', 'Working hardest'),
          ` ${strained.length} to look at`),
        strained.map((row) => personCard(row, data)))
      : null,

    quiet.length
      ? h('div',
        h('h2.group-head', h('span.pill.warn', 'Rested most'),
          ' under-used, or carried by the rest of their department'),
        quiet.map((row) => personCard(row, data)))
      : null,

    settled.length
      ? h('details',
        h('summary', { style: { cursor: 'pointer', margin: '1rem 0 .5rem', fontWeight: 650 } },
          `${settled.length} nothing to say about`),
        h('div.grid.grid-3', settled.map((row) => h('div.stat',
          h('div.stat-label', row.staff.name),
          h('div.stat-value', String(row.figures.daysOn)),
          h('div.stat-sub', `days · ${fmtNum(row.figures.hours, 0)} h`)))))
      : null,

    !data.rows.length
      ? emptyState('Nobody to look at',
        'No active staff in this window — or none in the department chosen.')
      : null,

    limitsCard(data.limits),
  );

  return host;
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

/** One person: the figures, then what is wrong and why. */
function personCard(row, data) {
  const f = row.figures;

  const figure = (label, value, sub) => h('div.stat',
    h('div.stat-label', label),
    h('div.stat-value', value),
    sub ? h('div.stat-sub', sub) : null);

  return card(row.staff.name, {
    note: [row.staff.department, row.score ? `strain ${row.score}` : null]
      .filter(Boolean).join(' · '),
    wide: true,
    actions: h('div.btn-row',
      h('button.btn-sm', {
        onclick: () => navigate('att-staff', { id: row.staff.id, from: data.from, to: data.to }),
      }, 'Record'),
      h('button.btn-sm', {
        onclick: () => navigate('att-rota', { from: data.from, to: data.to }),
      }, 'Rota'),
    ),
  },
    h('div.grid.grid-4', { style: { marginBottom: '.7rem' } },
      figure('Days on', String(f.daysOn),
        f.expected ? `of ${f.expected} expected` : null),
      figure('Hours', fmtNum(f.hours, 0),
        f.heaviestWeek ? `heaviest week ${fmtNum(f.heaviestWeek, 0)} h` : null),
      figure('Longest run', String(f.longestRun),
        f.longestRun ? 'days without one off' : null),
      figure('Nights', String(f.nights),
        f.flips ? `${f.flips} swaps to days` : null),
    ),

    h('ul.finding-list',
      row.findings.map((found) => h('li',
        h(`span.pill.${LEVEL_PILL[found.level] ?? ''}`, found.level === 'high' ? 'over' : 'watch'),
        h('div',
          h('div.finding-title', found.title),
          h('div.finding-detail', found.detail,
            found.law ? h('span.finding-law', ` ${found.law}`) : null),
        )))),
  );
}

/** What the app is measuring against, said plainly and in one place. */
function limitsCard(limits) {
  const rows = Object.entries(limits ?? {});
  if (!rows.length) return null;

  return h('details.limits-card',
    h('summary', 'What counts as too much here'),
    h('p.muted', { style: { fontSize: '.85rem' } },
      'The first four are the law. The rest are this property’s own, and can be changed under '
      + 'Setup. Nothing here ever stops a rota being saved — a hotel has nights when somebody has '
      + 'to cover, and an app that refuses to record what happened is one people work around on '
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
