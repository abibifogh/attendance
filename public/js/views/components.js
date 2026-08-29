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
 */
export function table(columns, rows, {
  rowClass = null, empty = 'No data yet.', groupBy = null, groupSummary = null,
  groupNoun = ['person', 'people'],
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
        ? groupedBody(rows, groupBy, groupSummary, columns.length, rowEl, groupNoun)
        : rows.map(rowEl)),
    ),
  );
}

function groupedBody(rows, groupBy, groupSummary, span, rowEl, noun) {
  const groups = new Map();
  for (const row of rows) {
    const label = groupBy(row) || UNGROUPED;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(row);
  }

  const out = [];
  for (const label of sortGroups([...groups.keys()])) {
    const group = groups.get(label);
    out.push(h('tr.row-group', h('td', { colspan: span },
      h('span.row-group-name', label),
      h('span.row-group-meta', `${group.length} ${group.length === 1 ? noun[0] : noun[1]}`),
      groupSummary ? h('span.row-group-meta', groupSummary(group)) : null,
    )));
    out.push(...group.map(rowEl));
  }
  return out;
}

const UNGROUPED = 'No department';

/** Alphabetical, but whoever has no department sits at the bottom. */
function sortGroups(labels) {
  return labels.sort((a, b) => {
    if (a === UNGROUPED) return 1;
    if (b === UNGROUPED) return -1;
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
 * One way in for a file of data, with the template behind it.
 *
 * Uploading a sheet and downloading the one to fill in were two buttons side by
 * side on three different screens, which reads as two unrelated things and puts
 * the one nobody wants first. They are the same job in two directions: you take
 * the sheet, you change it, you send it back.
 *
 * So it is one button that opens a small menu. The upload is the first item
 * because it is what somebody came for, and the template sits under it for the
 * first time they do this.
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

  const menu = h('div.bulk-menu', { role: 'menu' },
    h('button.bulk-item', {
      type: 'button',
      role: 'menuitem',
      onclick: () => { close(); picker.click(); },
    }, 'Upload a file'),
    template
      ? h('a.bulk-item', {
        role: 'menuitem',
        href: template.href,
        download: template.download ?? 'template.csv',
        onclick: () => close(),
      }, template.label ?? 'Download template')
      : null);

  const button = h('button.btn-sm.bulk-btn', {
    type: 'button',
    'aria-expanded': 'false',
    'aria-haspopup': 'menu',
    title: title ?? 'Send a sheet of data in, or take the template to fill in',
    onclick: (e) => { e.stopPropagation(); toggle(); },
  }, label, h('span.bulk-caret', '▾'));

  const wrap = h('div.bulk-wrap', picker, button, menu);

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

export function emptyState(title, detail) {
  return h('div.card.empty', h('h3', title), h('p', detail));
}
