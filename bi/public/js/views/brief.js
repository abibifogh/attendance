import { add, h, money, moneyShort, num, percent, dayRange, lineColour } from '../util.js';
import { api } from '../api.js';
import { tile, findingCard, banner, caveats } from './components.js';
import { state } from '../app.js';

/**
 * The morning screen.
 *
 * One hero number, six tiles, and the findings worth the most money. Anything
 * else belongs on one of the other screens: a brief that takes ten minutes to
 * read is a brief nobody reads twice.
 */
export async function renderBrief(root, { range }) {
  const data = await api(`/brief?from=${range.from}&to=${range.to}`);
  state.lastBrief = data;

  const totalWorth = data.findings.reduce((sum, f) => sum + f.impactMonthly, 0);
  const contribution = data.headline.find((m) => m.label === 'Contribution');
  const revenue = data.headline.find((m) => m.label === 'Revenue recorded');

  const problems = data.sources.filter((s) => s.status !== 'ok' && s.status !== 'demo');

  add(root, 
    data.demoMode ? banner('demo',
      h('strong', 'Demonstration data. '),
      'Nothing here comes from the business. Every figure is generated from a fixed seed so the screens can be judged before a single system is connected. Connect a source in Setup and the whole of it is replaced.') : null,

    problems.length ? banner('problem',
      h('strong', `${problems.length} source${problems.length > 1 ? 's are' : ' is'} not being read. `),
      `${problems.map((s) => s.label).join(', ')}. Every total below is missing whatever they would have contributed.`) : null,

    h('div.card',
      h('p.sub', `${data.range.days} days · ${dayRange(data.range.from, data.range.to)}`),
      h('div.hero', money(contribution?.value)),
      h('p.hero-note',
        'contribution — everything the four systems recorded as revenue, less what was bought and what the hours cost. ',
        h('span.muted', 'Not profit: no rent, power or depreciation is recorded in any of them, and no system in the group records what the rooms earn.')),
      totalWorth > 0 ? h('p',
        h('strong', `${moneyShort(totalWorth)} a month `),
        'is sitting in the findings below — the total of what every open finding is estimated to be worth.') : null),

    h('div.grid.three', data.headline.map((metric) => tile({
      label: metric.label,
      value: metric.value,
      unit: metric.unit,
      changePct: metric.changePct,
      goodWhen: metric.label === 'Wage bill' ? 'down' : 'up',
      note: metric.note,
    }))),

    h('div.card',
      h('h2', 'What to look at'),
      h('p.sub', data.findings.length
        ? 'Ranked by what each is worth a month, not by how alarming it sounds.'
        : 'Nothing is far enough out of line to raise. That is a real answer, not an empty screen.'),
      data.findings.map((finding) => findingCard(finding, { onDecide: decide }))),

    data.ruleErrors?.length ? h('div.card',
      h('h3', 'Some checks could not run'),
      h('ul.caveats', data.ruleErrors.map((e) => h('li', `${e.ruleId}: ${e.error}`)))) : null,

    h('div.card',
      h('h3', 'Where these numbers came from'),
      h('div.table-wrap', h('table',
        h('thead', h('tr', h('th', 'System'), h('th', 'Last run'), h('th', 'What it said'))),
        h('tbody', data.sources.map((source) => h('tr',
          h('td', source.label),
          h('td', source.status),
          h('td', h('span.muted.small', source.detail || '—')))))))),
  );

  async function decide(finding, next) {
    await api(`/findings/${finding.id}`, { method: 'POST', body: { state: next } });
    state.reload();
  }
}
