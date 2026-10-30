import { h, mount } from '../util.js';
import { api } from '../api.js';
import { banner } from './components.js';

/**
 * Settings › Connections & files › Speed: how long each page's request took
 * over the last day, split into waiting on the database and the rest (other
 * systems, the AI, the work itself), and where the Worker ran. Slow requests
 * and a sample of the rest are kept (lib/speed.js).
 */
const PLACES = {
  ACC: 'Accra', LOS: 'Lagos', ABJ: 'Abidjan', DKR: 'Dakar', JNB: 'Johannesburg', NBO: 'Nairobi',
  LHR: 'London', MAN: 'Manchester', AMS: 'Amsterdam', FRA: 'Frankfurt', CDG: 'Paris', MAD: 'Madrid', LIS: 'Lisbon',
  DUB: 'Dublin', BRU: 'Brussels', ZRH: 'Zurich', MXP: 'Milan', ARN: 'Stockholm', WAW: 'Warsaw', VIE: 'Vienna',
  IAD: 'Washington', EWR: 'New York', ORD: 'Chicago', SJC: 'San Jose', LAX: 'Los Angeles', SIN: 'Singapore',
};
const AFRICA = new Set(['ACC', 'LOS', 'ABJ', 'DKR', 'JNB', 'NBO']);
const secs = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export async function renderSpeed(root) {
  const d = await api('/admin/speed');
  const near = d.colos.length && d.colos.every((c) => AFRICA.has(c.colo));
  mount(root,
    h('section.card',
      h('h2', 'Where Insight runs'),
      d.colos.length ? h('p', d.colos.map((c, i) => [i ? ', ' : '', h('b', `${PLACES[c.colo] || c.colo} (${c.colo})`), ` ${c.n} request${c.n === 1 ? '' : 's'}, ${secs(c.avgMs)} on average`])) : h('p.muted', 'Nothing measured yet: open a few pages, then come back.'),
      near ? banner('warning', 'Insight is running near you, not near its database: every read crosses the distance. Smart Placement moves it beside the database once it has seen enough traffic; if this stays, the database is too far away.') : null,
      h('p.small.muted', 'Each page asks the database many times, one after another. Beside the database each read is a millisecond or two; far from it, each is a long round trip and they add up to seconds.')),
    h('section.card',
      h('h2', 'Each page, the last day'),
      h('p.sub', 'Slow requests, and one in twenty of the rest. Database: waiting on the database. Other: other systems (HIVE, Odoo, the AI) and the work itself.'),
      d.pages.length ? h('div.table-wrap', h('table',
        h('thead', h('tr', ['Page', 'Requests', 'Average', 'Slowest', 'Database', 'Reads', 'Other'].map((x, i) => h(i ? 'th.num' : 'th', x)))),
        h('tbody', d.pages.map((p) => h('tr',
          h('td', h('code', p.path)), h('td.num', String(p.n)), h('td.num', h('b', secs(p.avgMs))), h('td.num', secs(p.maxMs)),
          h('td.num', secs(p.dbMs)), h('td.num', String(p.reads)), h('td.num', secs(p.otherMs))))))) : h('p.muted', 'Nothing yet.')));
}
