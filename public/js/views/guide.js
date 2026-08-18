import { h, mount } from '../util.js';
import { card } from './components.js';
import { can, state } from '../app.js';
import { printButton } from '../print.js';
import { GUIDE } from '../guide-content.js';

/**
 * The handbook, showing the reader their own job and naming the rest.
 *
 * Filtering is the point. A guide that opens with eleven chapters, nine of
 * which are for somebody else, is a guide people close — and the two that
 * mattered were on page six. So a section appears only if the reader holds the
 * permission it belongs to.
 *
 * What is left out is still listed by name at the bottom, with who holds it.
 * Hiding the existence of a feature is a different thing from hiding the
 * feature, and only the second one is useful: somebody who does not know the
 * sign-off screen exists cannot ask to be given it, and will go on doing by
 * hand the thing it was built to do.
 */
export async function renderGuide(params) {
  const host = h('div');
  const mine = GUIDE.filter((section) => holds(section.permission));
  const theirs = GUIDE.filter((section) => !holds(section.permission));

  const wanted = params.section && mine.some((s) => s.key === params.section)
    ? params.section
    : null;

  const contents = card('What is in here', { wide: true },
    h('ol.guide-toc', mine.map((section) => h('li',
      h('a', {
        href: `#guide-${section.key}`,
        onclick: (event) => {
          event.preventDefault();
          document.getElementById(`guide-${section.key}`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
      }, section.title),
      h('small.muted', section.lede),
    ))),
  );

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', 'Guide'),
        h('div.sub', whoYouAre()),
      ),
      printButton({
        title: 'Guide',
        subtitle: whoYouAre(),
        note: state.name ?? '',
        label: '📄 Save as PDF',
      }),
    ),

    contents,
    ...mine
      .filter((section) => !wanted || section.key === wanted)
      .map(renderSection),
    theirs.length ? notYours(theirs) : null,
  );

  return host;
}

/**
 * The reader, in one line.
 *
 * Their role rather than a list of thirteen permissions, because the role is
 * what they would call themselves — and the exact list is on the Users screen
 * for whoever needs it.
 */
function whoYouAre() {
  const role = state.roleLabels?.[state.role];
  const count = GUIDE.filter((section) => holds(section.permission)).length;
  return `${role ?? 'Your account'} — ${count} section${count === 1 ? '' : 's'} you can use`;
}

function holds(permission) {
  if (!permission) return true;
  const needed = Array.isArray(permission) ? permission : [permission];
  return needed.some((p) => can(p));
}

function renderSection(section) {
  return card(section.title, { wide: true, note: section.lede, id: `guide-${section.key}` },
    h('div.guide-body', section.blocks.map(block)));
}

/**
 * One block.
 *
 * Six kinds and no more. Anything that needed a seventh would be a sign the
 * content had started decorating itself rather than saying something.
 */
function block(item) {
  if (item.sub) return h('h4.guide-sub', item.sub);
  if (item.p) return h('p', item.p);
  if (item.list) return h('ul', item.list.map((line) => h('li', line)));
  if (item.steps) return h('ol.guide-steps', item.steps.map((line) => h('li', line)));
  if (item.note) {
    return h('div.alert.info', h('span.alert-icon', 'ℹ️'), h('div', h('div.alert-detail', item.note)));
  }
  if (item.warn) {
    return h('div.alert.warn', h('span.alert-icon', '⚠️'), h('div', h('div.alert-detail', item.warn)));
  }
  if (item.table) {
    return h('div.table-wrap', h('table',
      h('thead', h('tr', item.table.head.map((cell) => h('th', cell)))),
      h('tbody', item.table.rows.map((row) => h('tr', row.map((cell) => h('td', cell))))),
    ));
  }
  return null;
}

/**
 * The rest of the system, named but not explained.
 *
 * Enough to ask for: what it is called, one line on what it does, and the
 * permission somebody would have to be given. Not the instructions — those
 * would be instructions for a screen the reader cannot open, which is how a
 * guide teaches people to distrust it.
 */
function notYours(sections) {
  return card('The rest of the system', {
    wide: true,
    note: 'Not yours to use. Here so you know it exists and who to ask',
  }, h('div',
    h('div.table-wrap', h('table',
      h('thead', h('tr', h('th', 'Section'), h('th', 'What it is'), h('th', 'Needs'))),
      h('tbody', sections.map((section) => h('tr',
        h('td', section.title),
        h('td', h('small', section.lede)),
        h('td', h('small.muted', labelsFor(section.permission))),
      ))),
    )),
    h('p.muted', { style: { fontSize: '.82rem', marginTop: '.7rem', marginBottom: 0 } },
      'An administrator can grant any of these under Users & data.'),
  ));
}

function labelsFor(permission) {
  const needed = Array.isArray(permission) ? permission : [permission];
  return needed.map((key) => state.permissionLabels?.[key] ?? key).join(' or ');
}
