import { add, h, moneyShort } from '../util.js';
import { api } from '../api.js';
import { findingCard, banner } from './components.js';
import { state } from '../app.js';

/** Everything the rules have found, including what has been put down. */
export async function renderFindings(root) {
  let filter = 'live';

  const list = h('div');
  const controls = h('div.rangebar',
    ...['live', 'open', 'acknowledged', 'actioned', 'dismissed', 'resolved', 'all'].map((value) =>
      h('button.btn', {
        onclick: async () => { filter = value; paint(controls); await load(); },
      }, label(value))));

  add(root, 
    h('div.card',
      h('h2', 'Findings'),
      h('p.sub', 'Every conclusion the rules have reached, ranked by what it is worth a month. Putting one down keeps it down: a finding somebody has dismissed does not come back to the top of the brief the next morning.'),
      controls),
    list);

  paint(controls);
  await load();

  async function load() {
    const data = await api(`/findings?state=${filter}`);
    const worth = data.findings.reduce((sum, f) => sum + f.impactMonthly, 0);
    list.replaceChildren(
      worth > 0 ? banner('demo', h('strong', `${moneyShort(worth)} a month `), 'across the findings shown.') : null,
      ...(data.findings.length
        ? data.findings.map((finding) => h('div',
          findingCard(finding, { onDecide: decide }),
          h('p.small.muted', { style: { margin: '-.4rem 0 .8rem .2rem' } },
            `${finding.ruleId} · first seen ${finding.firstSeenAt?.slice(0, 10) || '—'} · window ${finding.from} to ${finding.to}`,
            finding.evidence && Object.keys(finding.evidence).length
              ? h('details.tableview', h('summary', 'Show the evidence'),
                h('pre.small', { style: { whiteSpace: 'pre-wrap', margin: 0 } },
                  JSON.stringify(finding.evidence, null, 2)))
              : null)))
        : [h('p.muted', 'Nothing here.')]));
  }

  async function decide(finding, next) {
    await api(`/findings/${finding.id}`, { method: 'POST', body: { state: next } });
    await load();
  }

  function paint(bar) {
    [...bar.children].forEach((button, i) => {
      const value = ['live', 'open', 'acknowledged', 'actioned', 'dismissed', 'resolved', 'all'][i];
      button.className = value === filter ? 'btn primary' : 'btn';
    });
  }

  function label(value) {
    return { live: 'Live', open: 'Open', acknowledged: 'Noted', actioned: 'Dealt with', dismissed: 'Not a problem', resolved: 'No longer true', all: 'Everything' }[value];
  }
}
