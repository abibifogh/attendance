import { deltaBadge, fmtNum, h } from '../util.js';

/**
 * The handful of shapes every screen is built from.
 *
 * Deliberately small. A component library grows a variant per screen if you let
 * it, and then the screens stop looking like each other — which is the only
 * thing a component library is for.
 */

export function statTile({ label, value, sub, delta, higherIsBetter = false, accent }) {
  return h('div.stat',
    h('div.stat-label', label),
    h('div.stat-value', { style: accent ? { color: accent } : null }, value),
    (sub || delta != null) && h('div.stat-sub',
      delta != null ? deltaBadge(delta, { higherIsBetter }) : null,
      sub ? h('span', sub) : null,
    ),
  );
}

const ALERT_ICON = { high: '⛔', warn: '⚠️', info: 'ℹ️' };

export function alertList(alerts, { empty = 'Nothing needs attention.' } = {}) {
  if (!alerts?.length) {
    return h('div.alert.info',
      h('span.alert-icon', '✓'),
      h('div', h('div.alert-title', 'All clear'), h('div.alert-detail', empty)),
    );
  }
  return h('div', alerts.map((a) => h(`div.alert.${a.level || 'info'}`,
    h('span.alert-icon', ALERT_ICON[a.level] || 'ℹ️'),
    h('div',
      h('div.alert-title', a.title),
      a.detail ? h('div.alert-detail', a.detail) : null,
    ),
  )));
}

export function card(title, { note, actions, wide, id, cls } = {}, ...children) {
  return h('section.card', {
    id: id ?? null,
    // `no-print` is the one anybody passes: a card that belongs on the screen
    // and not on the sheet somebody carries to the kitchen.
    class: cls ? `card ${cls}` : null,
    style: wide ? { gridColumn: '1 / -1' } : null,
  },
    (title || note || actions) && h('div.card-head',
      h('h2', title || ''),
      note ? h('span.card-note', note) : null,
      actions || null,
    ),
    ...children,
  );
}

/**
 * columns: [{ key, label, align, format, cls }]
 * Rows are plain objects; `format` receives (value, row).
 *
 * `groupBy` turns the flat list into banded sections — one heading row per
 * group, the rows under it in the order they arrived. It stays one table rather
 * than a table per group so the columns still line up down the page, which is
 * the whole point of reading a list of names.
 *
 * `groupNoun` is what the band counts. A list of shifts announcing "5 people"
 * is the sort of small wrongness that makes somebody stop trusting the rest of
 * the screen.
 *
 * `groupOrder` is the order the bands appear in, as a list of labels.
 * Alphabetical is right for a list of departments and wrong for anything that
 * has an order of its own: a recruitment pipeline reading "Not this time,
 * Shortlisted" is sorted correctly and reads as nonsense. Anything not named
 * falls to the end, alphabetically, so a new group cannot vanish.
 *
 * `fold` makes each band a lid. Opt-in, because folding is only worth the
 * click on a list long enough to lose your place in: on a screen with three
 * groups of four it is a control that costs more than it saves. Pass
 * `'closed'` to start with everything shut, which is right where somebody
 * comes to the screen looking for one department rather than reading all of
 * them.
 */
export function table(columns, rows, {
  rowClass = null, empty = 'No data yet.', groupBy = null, groupSummary = null,
  groupNoun = ['person', 'people'], fold = false, groupOrder = null,
} = {}) {
  if (!rows?.length) return h('div.empty', h('p', empty));

  const rowEl = (row) => h('tr', { class: rowClass ? rowClass(row) : '' },
    columns.map((c) => {
      const value = row[c.key];
      const content = c.format ? c.format(value, row) : (value ?? '—');
      return h(`td${c.align === 'right' ? '.num' : ''}${c.cls ? `.${c.cls}` : ''}`, content);
    }));

  return h('div.table-wrap',
    h('table',
      // The header carries the column's class too, so a column hidden on paper
      // takes its heading with it rather than leaving an empty strip.
      h('thead', h('tr', columns.map((c) =>
        h(`th${c.align === 'right' ? '.num' : ''}${c.cls ? `.${c.cls}` : ''}`, c.label)))),
      h('tbody', groupBy
        ? groupedBody(rows, groupBy, groupSummary, columns.length, rowEl, groupNoun, fold,
          groupOrder)
        : rows.map(rowEl)),
    ),
  );
}

function groupedBody(rows, groupBy, groupSummary, span, rowEl, noun, fold, groupOrder) {
  const groups = new Map();
  for (const row of rows) {
    const label = groupBy(row) || UNGROUPED;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(row);
  }

  const out = [];
  const shut = fold === 'closed';

  for (const label of sortGroups([...groups.keys()], groupOrder)) {
    const group = groups.get(label);
    const body = group.map(rowEl);

    const heading = h(`tr.row-group${fold ? '.is-foldable' : ''}`,
      h('td', { colspan: span },
        fold ? h('span.row-group-caret', shut ? '\u25b8' : '\u25be') : null,
        h('span.row-group-name', label),
        h('span.row-group-meta', `${group.length} ${group.length === 1 ? noun[0] : noun[1]}`),
        groupSummary ? h('span.row-group-meta', groupSummary(group)) : null,
      ));

    if (fold) {
      // The rows themselves carry the state rather than a wrapper element:
      // a tbody cannot hold a div, and wrapping each group in its own tbody
      // would break the striping and the border between the last row of one
      // group and the heading of the next.
      let open = !shut;
      const apply = () => {
        for (const row of body) row.hidden = !open;
        heading.querySelector('.row-group-caret').textContent = open ? '\u25be' : '\u25b8';
        heading.setAttribute('aria-expanded', String(open));
      };
      heading.setAttribute('role', 'button');
      heading.setAttribute('tabindex', '0');
      heading.addEventListener('click', () => { open = !open; apply(); });
      heading.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open = !open;
        apply();
      });
      apply();
    }

    out.push(heading, ...body);
  }
  return out;
}

const UNGROUPED = 'No department';

/**
 * Alphabetical, unless the caller has said otherwise, and whoever has no
 * department sits at the bottom either way.
 */
function sortGroups(labels, order = null) {
  const rank = order
    ? (label) => { const at = order.indexOf(label); return at === -1 ? order.length : at; }
    : null;

  return labels.sort((a, b) => {
    if (a === UNGROUPED) return 1;
    if (b === UNGROUPED) return -1;
    if (rank) {
      const by = rank(a) - rank(b);
      if (by) return by;
    }
    return a.localeCompare(b);
  });
}

export function pctCell(value) {
  if (value == null) return h('span.muted', '—');
  return deltaBadge(value);
}

export function numCell(value, places = 1) {
  if (value == null) return h('span.muted', '—');
  return h('span', fmtNum(value, places));
}

/** Date navigator shared by the day / week / month views. */
export function periodNav({ label, onPrev, onNext, onToday, nextDisabled, input }) {
  return h('div.toolbar',
    h('button.btn-sm', { onclick: onPrev }, '‹'),
    input || null,
    h('button.btn-sm', { onclick: onNext, disabled: nextDisabled }, '›'),
    onToday ? h('button.btn-sm', { onclick: onToday }, 'Latest') : null,
    label ? h('strong', { style: { marginLeft: '.4rem' } }, label) : null,
  );
}

export function exportButton(href, label = 'Export CSV') {
  // A plain arrow rather than the emoji one. On a phone the emoji is drawn in
  // full colour at the height of the words beside it, and a row of them turns
  // a toolbar into a sticker album.
  return h('a.btn.btn-sm', { href, download: '' }, '↓ ', label);
}

/**
 * The buttons on a toolbar that are not the main thing it does.
 *
 * A screen accumulates outputs — save it, download the ones to deal with, the
 * same across the week, the whole day as a file — and on a desk they sit along
 * the toolbar and cost nothing. On a phone the same four wrap onto three rows
 * and push the day's list below the fold, so what a supervisor sees when they
 * open the app in a corridor is a page of buttons.
 *
 * On a desk nothing changes: the wrapper carries no box of its own and the
 * buttons sit in the toolbar exactly where they were. On a phone they are
 * behind More, which is one button, and they come back in a block under the
 * toolbar when it is pressed.
 */
export function moreActions(...items) {
  const real = items.flat().filter(Boolean);
  if (!real.length) return null;

  const box = h('div.toolbar-more', ...real);
  const button = h('button.btn-sm.toolbar-more-btn', {
    type: 'button',
    'aria-expanded': 'false',
    onclick: () => {
      const open = box.classList.toggle('open');
      button.setAttribute('aria-expanded', String(open));
      button.textContent = open ? 'Fewer' : `More (${real.length})`;
    },
  }, `More (${real.length})`);

  return h('div.toolbar-more-wrap', button, box);
}

/**
 * A button that opens a small menu under itself.
 *
 * Two or three buttons doing variations of one job read as unrelated things
 * and put the one nobody wants first. One button that says the job, with the
 * variations under it, says what it is and takes one place on the bar.
 *
 * Each item is `{ label, onClick }` or `{ label, href, download }`. A link
 * item is a real anchor, so the browser saves the file itself rather than us
 * inventing a spinner and a filename twice.
 */
export function dropdownMenu({ label, title = null, items = [], extra = null } = {}) {
  const menu = h('div.menu-drop', { role: 'menu' },
    items.filter(Boolean).map((item) => (item.href
      ? h('a.menu-item', {
        role: 'menuitem',
        href: item.href,
        download: item.download ?? '',
        title: item.title ?? null,
        onclick: () => close(),
      }, item.label)
      : h('button.menu-item', {
        type: 'button',
        role: 'menuitem',
        title: item.title ?? null,
        onclick: () => { close(); item.onClick?.(); },
      }, item.label))));

  const button = h('button.btn-sm.menu-btn', {
    type: 'button',
    'aria-expanded': 'false',
    'aria-haspopup': 'menu',
    title,
    onclick: (e) => { e.stopPropagation(); toggle(); },
  }, label, h('span.menu-caret', '▾'));

  const wrap = h('div.menu-wrap', extra, button, menu);

  function close() {
    wrap.classList.remove('open');
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', away);
    document.removeEventListener('keydown', escape);
  }

  // Anywhere else on the page closes it, and so does Escape. Without both, a
  // menu left open sits over whatever somebody moved on to look at.
  const away = (e) => { if (!wrap.contains(e.target)) close(); };
  const escape = (e) => { if (e.key === 'Escape') close(); };

  function toggle() {
    if (wrap.classList.contains('open')) { close(); return; }
    wrap.classList.add('open');
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', away);
    document.addEventListener('keydown', escape);
  }

  return wrap;
}

/**
 * One way in for a file of data, with the template behind it.
 *
 * Uploading a sheet and downloading the one to fill in were two buttons side by
 * side on three different screens, which reads as two unrelated things and puts
 * the one nobody wants first. They are the same job in two directions: you take
 * the sheet, you change it, you send it back.
 */
export function bulkUpload({
  accept = '.csv,text/csv',
  onFile,
  template = null,
  label = 'Bulk upload',
  title = null,
} = {}) {
  const picker = h('input', {
    type: 'file',
    accept,
    style: { display: 'none' },
    onchange: async (e) => {
      const file = e.target.files?.[0];
      // Cleared at once, so choosing the same file again after fixing
      // something in it still fires a change.
      e.target.value = '';
      if (file) await onFile(file);
    },
  });

  return dropdownMenu({
    label,
    title: title ?? 'Send a sheet of data in, or take the template to fill in',
    extra: picker,
    items: [
      // The upload first, because it is what somebody came for. The template
      // sits under it for the first time they do this.
      { label: 'Upload a filled-in sheet', onClick: () => picker.click() },
      template
        ? {
          label: template.label ?? 'Download template',
          href: template.href,
          download: template.download ?? 'template.csv',
        }
        : null,
    ],
  });
}

export function emptyState(title, detail) {
  return h('div.card.empty', h('h3', title), h('p', detail));
}
