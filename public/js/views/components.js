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

export function card(title, { note, actions, wide } = {}, ...children) {
  return h('section.card', { style: wide ? { gridColumn: '1 / -1' } : null },
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
  return h('a.btn.btn-sm', { href, download: '' }, '⬇ ', label);
}

export function emptyState(title, detail) {
  return h('div.card.empty', h('h3', title), h('p', detail));
}
