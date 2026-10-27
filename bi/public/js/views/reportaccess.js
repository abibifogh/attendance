import { h, mount } from '../util.js';
import { api } from '../api.js';

/**
 * Who sees which reports: one row a person, one tick a report page. Admins
 * and owners see every report, so their rows are shown filled and cannot be
 * changed. Ticking a report for somebody with only the hub gives them
 * Insight as Reports only; taking their last one away takes it back.
 */

export async function renderReportAccess(root) {
  let data = await api('/report-access');
  let flash = null;
  const view = h('div.ra');
  mount(root, view);
  paint();

  function paint() {
    const others = data.people.filter((p) => p.level !== 'admin');
    const admins = data.people.filter((p) => p.level === 'admin');
    mount(view,
      h('div.ra-top',
        h('h1', 'Who sees which reports'),
        h('p.muted', 'Admins see every report. Tick the report pages each other person may open; they appear in their Reports menu, and nothing else is opened to them. Somebody with only the hub who is given a report gets Insight as "Reports only".')),
      flash,
      h('section.card.ra-card',
        others.length ? h('div.ra-table', h('table',
          h('thead', h('tr',
            h('th', 'Person'),
            ...data.reports.map((r) => h('th.ra-rep', { title: r.note }, h('span', r.label))))),
          h('tbody', others.map((p) => row(p))))) : h('p.muted', 'Everybody with an account is an admin: there is nobody to choose for.')),
      admins.length ? h('p.small.muted', `Every report already: ${admins.map((p) => `${p.name} (${p.levelWords})`).join(', ')}.`) : null);
  }

  function row(person) {
    const ticks = data.reports.map((r) => h('input', {
      type: 'checkbox',
      checked: person.reports.includes(r.key),
      'aria-label': `${person.name}: ${r.label}`,
      onchange: () => save(person, ticks),
    }));
    return h('tr',
      h('td.ra-who',
        h('b', person.name),
        h('span.ra-level', person.levelWords),
        h('div.ra-all',
          h('button', { type: 'button', onclick: () => { ticks.forEach((t) => { t.checked = true; }); save(person, ticks); } }, 'All'),
          ' · ',
          h('button', { type: 'button', onclick: () => { ticks.forEach((t) => { t.checked = false; }); save(person, ticks); } }, 'None'))),
      ...ticks.map((t, i) => h('td.ra-tick', { title: data.reports[i].label }, t)));
  }

  async function save(person, ticks) {
    const reports = data.reports.filter((r, i) => ticks[i].checked).map((r) => r.key);
    ticks.forEach((t) => { t.disabled = true; });
    try {
      data = await api('/report-access', { method: 'POST', body: { accountId: person.id, reports } });
      const now = data.people.find((p) => p.id === person.id);
      flash = h('div.ra-flash', reports.length
        ? `${person.name} now sees ${reports.length} report${reports.length === 1 ? '' : 's'}${now && person.level === 'none' && now.level === 'reports' ? ', and has Insight as "Reports only"' : ''}.`
        : `${person.name} sees no reports${person.level === 'reports' ? ': Insight was taken away, the hub stays' : ''}.`);
    } catch (err) {
      flash = h('div.ra-flash.form-error', err.message);
    }
    paint();
  }
}
