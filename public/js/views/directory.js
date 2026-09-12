import { api } from '../api.js';
import { h, mount, toast } from '../util.js';
import { card, emptyState, face } from './components.js';
import {
  countByDepartment, departmentOf, departmentsIn, filterPeople,
} from '../directory-list.js';

/**
 * The staff directory.
 *
 * Names, numbers and addresses, and nothing else on the page. Somebody opens
 * this holding a phone because they need to reach the person covering their
 * shift, so the number is a link that dials and the address is a link that
 * writes, and neither of them is a row somebody has to read out to themselves
 * while typing.
 *
 * A card each rather than a line each. A list of names with the numbers pushed
 * to the far edge is a page you read with a ruler on a wide screen: the eye has
 * to carry a name across six inches of nothing to reach the thing it came for.
 * A card keeps the two together, and a face on it means the usual way of
 * finding somebody, knowing what they look like, works here too.
 *
 * Grouped by department, because "who is on reception" is how the question
 * arrives, with a row of departments to jump between them. Searchable, because
 * twenty-four names is one scroll too many on a phone and a property twice this
 * size would be four.
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

  const departments = departmentsIn(data.people);
  const howMany = countByDepartment(data.people);

  // What is being looked at, held here rather than read back off the screen.
  const showing = { department: null, needle: '' };

  const search = h('input.dir-search', {
    type: 'search',
    placeholder: 'Search a name or a department',
    'aria-label': 'Search a name or a department',
    autocomplete: 'off',
    oninput: () => {
      showing.needle = search.value;
      paint();
    },
  });

  const chips = h('div.dir-chips');
  const list = h('div.dir-groups');
  const note = h('p.muted.dir-note');

  /**
   * One way of reaching somebody.
   *
   * The copy button is for a desk, where tapping a telephone number does
   * nothing and the next thing anybody does is read it out to themselves while
   * typing it somewhere else. A phone never draws it: the link already dials,
   * and a second control beside it is a thumb-sized mistake waiting to happen.
   */
  const wayTo = (person, { kind, value, href, mark, label }) => h('div.dir-way-row',
    h(`a.dir-way.dir-way-${kind}`, { href },
      h('span.dir-way-mark', mark),
      h('span.dir-way-text', value)),
    h('button.dir-copy', {
      type: 'button',
      'aria-label': `Copy ${person.name}’s ${label}`,
      title: `Copy ${label}`,
      onclick: async (e) => {
        const button = e.currentTarget;
        try {
          await navigator.clipboard.writeText(value);
          button.classList.add('is-copied');
          button.textContent = 'Copied';
          setTimeout(() => {
            button.classList.remove('is-copied');
            button.textContent = 'Copy';
          }, 1400);
        } catch {
          toast('Select it and copy it.', 'bad');
        }
      },
    }, 'Copy'),
  );

  const personCard = (person) => h('div.dir-card',
    face(person.name, {
      src: person.hasPhoto ? `/api/directory/photo/${person.id}` : null,
    }),
    h('div.dir-who',
      h('div.dir-name', person.name),
      h('div.dir-ways',
        person.phone
          ? wayTo(person, {
            kind: 'phone',
            value: person.phone,
            href: `tel:${person.phone.replace(/\s+/g, '')}`,
            mark: '☎',
            label: 'number',
          })
          : null,
        person.email
          ? wayTo(person, {
            kind: 'mail',
            value: person.email,
            href: `mailto:${person.email}`,
            mark: '✉',
            label: 'address',
          })
          : null)),
  );

  const paintChips = () => {
    // One department is not a choice, so there is nothing to draw.
    if (departments.length < 2) return;
    const chip = (label, value, n) => h('button', {
      type: 'button',
      class: showing.department === value ? 'active' : null,
      'aria-pressed': showing.department === value ? 'true' : 'false',
      onclick: () => {
        showing.department = value;
        paint();
      },
    }, label, h('span.seg-count', String(n)));

    mount(chips, h('div.seg.seg-wrap',
      chip('Everybody', null, data.people.length),
      departments.map((department) => chip(
        department, department, howMany.get(department) ?? 0,
      ))));
  };

  const paint = () => {
    paintChips();

    const people = filterPeople(data.people, showing);
    const all = data.people.length;
    // How much of the list is left, and only once some of it is not. The whole
    // list needs no caption: the heading has already said how many there are.
    const narrowed = people.length !== all;
    note.textContent = narrowed ? `${people.length} of ${all} people.` : '';
    note.hidden = !narrowed;

    if (!people.length) {
      mount(list, emptyState('Nobody by that name',
        'Try part of a first name, a surname or a department.'));
      return;
    }

    const here = departmentsIn(people);
    mount(list, here.map((department) => {
      const theirs = people.filter((p) => departmentOf(p) === department);
      return card(department, { note: `${theirs.length}`, wide: true },
        h('div.dir-grid', theirs.map(personCard)));
    }));
  };

  paint();
  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Directory'),
        h('div.sub', departments.length > 1
          ? `${data.people.length} people · ${departments.length} departments`
          : `${data.people.length} people`)),
      search),
    chips,
    note,
    list);
  return host;
}
