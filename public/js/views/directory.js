import { api } from '../api.js';
import { h, mount } from '../util.js';
import { card, emptyState } from './components.js';

/**
 * The staff directory.
 *
 * Names, numbers and addresses, and nothing else on the page. Somebody opens
 * this holding a phone because they need to reach the person covering their
 * shift, so the number is a link that dials and the address is a link that
 * writes, and neither of them is a row somebody has to read out to themselves
 * while typing.
 *
 * Grouped by department, because "who is on reception" is how the question
 * arrives. Searchable, because twenty-four names is one scroll too many on a
 * phone and a property twice this size would be four.
 */
export async function renderDirectory() {
  const host = h('div');
  const data = await api.directory();

  if (!data.on) {
    mount(host,
      h('div.page-head', h('div', h('h1', 'Directory'))),
      emptyState('The directory is turned off',
        'An administrator can turn it on under Setup → Rules, in "What staff see". '
        + 'It shows every '
        + 'colleague’s phone number and email address to everybody signed in, '
        + 'which is a decision about personal numbers rather than a setting.'));
    return host;
  }

  const search = h('input.dir-search', {
    type: 'search',
    placeholder: 'Find somebody',
    'aria-label': 'Find somebody',
    autocomplete: 'off',
    oninput: () => paint(search.value),
  });

  const list = h('div');

  const paint = (needle) => {
    const want = String(needle ?? '').trim().toLowerCase();
    const people = data.people.filter((p) => !want
      || `${p.name} ${p.department ?? ''}`.toLowerCase().includes(want));

    if (!people.length) {
      mount(list, emptyState('Nobody by that name',
        'Try part of a first name, a surname or a department.'));
      return;
    }

    const departments = [...new Set(people.map((p) => p.department || 'No department'))].sort();
    mount(list, departments.map((department) => card(department, {
      note: `${people.filter((p) => (p.department || 'No department') === department).length}`,
      wide: true,
    },
    h('div.dir-list', people
      .filter((p) => (p.department || 'No department') === department)
      .map((person) => h('div.dir-row',
        h('div.dir-name', person.name),
        h('div.dir-ways',
          // A number that dials and an address that writes. On a desk they do
          // nothing surprising; on a phone they are the whole point.
          person.phone
            ? h('a.dir-way', { href: `tel:${person.phone.replace(/\s+/g, '')}` },
              h('span.dir-mark', '☎'), person.phone)
            : null,
          person.email
            ? h('a.dir-way', { href: `mailto:${person.email}` },
              h('span.dir-mark', '✉'), person.email)
            : null),
      ))))));
  };

  paint('');
  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Directory'),
        h('div.sub', `${data.people.length} people`)),
      search),
    // Said once, at the top, rather than beside every number. Anybody reading
    // this is holding a colleague's personal mobile.
    h('p.muted.dir-note',
      'Personal numbers, shared so the property can reach each other. '
      + 'Not for anything else.'),
    list);
  return host;
}
