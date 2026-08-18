import { add, h, num, percent, dayRange } from '../util.js';
import { api } from '../api.js';
import { lineChart, smallMultiples } from '../charts.js';
import { table, banner, caveats } from './components.js';

/**
 * Work that was due, against the people who were there to do it.
 *
 * The two figures at the top of this screen — completion with a full team and
 * completion a person down — are the answer to a question housekeeping has
 * been asked for years and has never had the data to answer, because the
 * checks are in one application and the rota is in another.
 */
export async function renderService(root, { range }) {
  const data = await api(`/service?from=${range.from}&to=${range.to}`);
  const s = data.summary;

  add(root, 
    data.demoMode ? banner('demo', h('strong', 'Demonstration data.'), ' Not the business.') : null,

    h('div.card',
      h('h2', 'Housekeeping checks'),
      h('p.sub', `${dayRange(data.range.from, data.range.to)}. ${data.note}`),
      h('div.grid.three',
        h('div.tile', h('div.label', 'Checks completed'), h('div.value', percent(s.completionPct)),
          h('div.note', `${num(s.checksDone)} of ${num(s.checksDue)} due.`)),
        h('div.tile', h('div.label', 'With a full team'), h('div.value', percent(s.completionFullTeamPct)),
          h('div.note', `The median of ${num(s.fullTeamDays)} days when nobody was absent.`)),
        h('div.tile', h('div.label', 'A person down'), h('div.value', percent(s.completionShortTeamPct)),
          h('div.note', `The median of ${num(s.shortTeamDays)} days with an absence. Two applications, one comparison.`))),
      lineChart(data.daily.filter((d) => d.checksDue > 0), [
        { key: 'completion', label: 'Checks completed', colour: 'var(--series-1)', value: (r) => r.completionPct },
      ], { height: 190, format: (v) => `${Math.round(v)}%` })),

    h('div.card',
      h('h2', 'Completion against who was on'),
      h('p.sub', 'A percentage and a headcount are different measures, so they get a panel each.'),
      smallMultiples(data.daily.filter((d) => d.checksDue > 0), [
        { key: 'completion', title: 'Checks completed', colour: 'var(--series-1)', value: (r) => r.completionPct, format: (v) => `${Math.round(v)}%` },
        { key: 'absent', title: 'Housekeepers absent', colour: 'var(--series-2)', value: (r) => r.absent, format: (v) => num(v) },
      ])),

    h('div.card',
      h('h2', 'Beds found in a state nobody expected'),
      h('p.sub', `${num(s.mismatches)} across the window. Each one is a room being used and not billed, or a rooming list that is out of date.`),
      table([
        { label: 'Day', get: (r) => r.day },
        { label: '', get: (r) => r.dow },
        { label: 'Guests', num: true, get: (r) => num(r.guests) },
        { label: 'On duty', num: true, get: (r) => num(r.onDuty) },
        { label: 'Absent', num: true, get: (r) => num(r.absent) },
        { label: 'Checks due', num: true, get: (r) => num(r.checksDue) },
        { label: 'Done', num: true, get: (r) => num(r.checksDone) },
        { label: 'Completed', num: true, get: (r) => (r.completionPct == null ? '—' : `${r.completionPct}%`) },
        { label: 'Unexpected', num: true, get: (r) => num(r.mismatches) },
        { label: 'Maintenance jobs', num: true, get: (r) => num(r.maintenanceJobs) },
      ], data.daily)),
  );
}
