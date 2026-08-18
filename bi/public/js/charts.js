import { h, s, mount, moneyShort, num, shortDay } from './util.js';

/**
 * Charts, in SVG, by hand.
 *
 * A charting library is thirty times the size of this file and would be the
 * only dependency in the whole group's software. These are the four shapes the
 * dashboard actually needs, drawn to one set of rules:
 *
 *   marks are thin           bars capped at 24px, lines at 2px, dots at r4
 *   white does the dividing  a 2px surface gap between touching marks, a 2px
 *                            surface ring on any dot that can overlap
 *   labels are sparing       the end of a line, the top of a column, never
 *                            every point
 *   grid recedes             hairline, solid, one step off the surface
 *   never two y-axes         two measures of different size get two charts or
 *                            a common base, because a dual axis lets whoever
 *                            drew it decide which line is on top
 *
 * Every chart carries a hover layer and, underneath, the same numbers as a
 * table. The table is not a fallback nobody uses: three of the categorical
 * colours sit below 3:1 against the light surface, and shipping the values in
 * readable text is what makes that acceptable rather than merely pretty.
 */

const PAD = { top: 14, right: 14, bottom: 26, left: 52 };

/** Round a maximum up to something an axis can be labelled with. */
function niceMax(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

function frame({ width, height, max, min = 0, ticks = 4, format }) {
  const plot = {
    x: PAD.left, y: PAD.top,
    w: width - PAD.left - PAD.right,
    hgt: height - PAD.top - PAD.bottom,
  };
  const top = niceMax(max);
  const bottom = min < 0 ? -niceMax(Math.abs(min)) : 0;
  const span = top - bottom || 1;
  const yOf = (value) => plot.y + plot.hgt - ((value - bottom) / span) * plot.hgt;

  const gridlines = [];
  for (let i = 0; i <= ticks; i += 1) {
    const value = bottom + (span * i) / ticks;
    const y = yOf(value);
    gridlines.push(s('line', {
      x1: plot.x, x2: plot.x + plot.w, y1: y, y2: y,
      stroke: value === 0 && bottom < 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1,
    }));
    gridlines.push(s('text', {
      x: plot.x - 8, y: y + 4, 'text-anchor': 'end',
      fill: 'var(--muted)', 'font-size': 10.5, 'font-variant-numeric': 'tabular-nums',
    }, format ? format(value) : num(value)));
  }
  return { plot, top, bottom, span, yOf, gridlines };
}

/** The floating tooltip every chart shares. */
function hoverLayer(root) {
  const tip = h('div.tooltip');
  root.append(tip);
  return {
    show(x, y, nodes) {
      mount(tip, nodes);
      tip.style.opacity = '1';
      const box = root.getBoundingClientRect();
      const left = Math.min(Math.max(4, x - tip.offsetWidth / 2), box.width - tip.offsetWidth - 4);
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(4, y - tip.offsetHeight - 12)}px`;
    },
    hide() { tip.style.opacity = '0'; },
  };
}

const swatch = (colour) => h('i', { style: { background: colour } });

function tableView(columns, rows) {
  return h('details.tableview',
    h('summary', 'Show these numbers as a table'),
    h('div.table-wrap',
      h('table',
        h('thead', h('tr', columns.map((c) => h(c.num ? 'th.num' : 'th', c.label)))),
        h('tbody', rows.map((row) => h('tr', columns.map((c) => h(c.num ? 'td.num' : 'td', c.get(row)))))))));
}

/**
 * A time series, one or more lines, with a crosshair.
 *
 * `series` is `[{ key, label, colour, value(row) }]`. Every series is drawn
 * against the same axis; two measures that do not share a scale belong in two
 * charts, so this function has no way of expressing them.
 */
export function lineChart(rows, series, { height = 190, format = moneyShort, labelEnd = true } = {}) {
  const root = h('div.chart');
  if (!rows.length) return mount(root, h('p.muted.small', 'Nothing in this window.'));

  const width = 720;
  const values = rows.flatMap((row) => series.map((serie) => serie.value(row))).filter(Number.isFinite);
  const { plot, yOf, gridlines } = frame({
    width, height, max: Math.max(...values, 0), min: Math.min(...values, 0), format,
  });
  const xOf = (index) => plot.x + (rows.length === 1 ? plot.w / 2 : (index / (rows.length - 1)) * plot.w);

  const marks = [];
  for (const serie of series) {
    const points = rows.map((row, i) => [xOf(i), serie.value(row)])
      .filter(([, v]) => Number.isFinite(v))
      .map(([x, v]) => [x, yOf(v)]);
    if (!points.length) continue;
    marks.push(s('path', {
      d: points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' '),
      fill: 'none', stroke: serie.colour, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
    // The end dot carries a 2px ring in the surface colour so two series that
    // finish at the same value stay two series.
    const [ex, ey] = points[points.length - 1];
    marks.push(s('circle', { cx: ex, cy: ey, r: 4, fill: serie.colour, stroke: 'var(--surface)', 'stroke-width': 2 }));
  }

  // Only the last value is labelled. A number on every point is chaos and goes
  // unread; the axis and the tooltip carry the rest.
  const endLabels = [];
  if (labelEnd && series.length <= 2) {
    for (const serie of series) {
      const last = [...rows].reverse().find((row) => Number.isFinite(serie.value(row)));
      if (!last) continue;
      endLabels.push(s('text', {
        x: plot.x + plot.w, y: yOf(serie.value(last)) - 12, 'text-anchor': 'end',
        fill: 'var(--ink-2)', 'font-size': 11, 'font-weight': 600,
        // Painted over its own outline in the surface colour, so the label
        // stays readable where the line runs underneath it. Cheaper and more
        // reliable than trying to find a clear patch of chart to put it in.
        stroke: 'var(--surface)', 'stroke-width': 3, 'paint-order': 'stroke',
      }, format(serie.value(last))));
    }
  }

  const xTicks = [];
  const every = Math.max(1, Math.ceil(rows.length / 6));
  rows.forEach((row, i) => {
    if (i % every && i !== rows.length - 1) return;
    xTicks.push(s('text', {
      x: xOf(i), y: height - 8, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 10.5,
    }, shortDay(row.day)));
  });

  const crosshair = s('line', {
    y1: plot.y, y2: plot.y + plot.hgt, stroke: 'var(--axis)', 'stroke-width': 1, opacity: 0,
  });

  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' },
    gridlines, marks, endLabels, xTicks, crosshair,
    // One transparent capture rectangle: a hit target far bigger than a 2px
    // line, so the tooltip is reachable without aiming.
    s('rect', {
      x: plot.x, y: plot.y, width: plot.w, height: plot.hgt, fill: 'transparent',
    }));

  mount(root, svg);
  const tip = hoverLayer(root);

  svg.addEventListener('pointermove', (event) => {
    const box = svg.getBoundingClientRect();
    const localX = ((event.clientX - box.left) / box.width) * width;
    const index = Math.round(((localX - plot.x) / plot.w) * (rows.length - 1));
    if (!(index >= 0 && index < rows.length)) return;
    const row = rows[index];
    crosshair.setAttribute('x1', xOf(index));
    crosshair.setAttribute('x2', xOf(index));
    crosshair.setAttribute('opacity', 1);
    tip.show(((xOf(index) / width) * box.width), ((yOf(Math.max(...series.map((x) => x.value(row)).filter(Number.isFinite), 0)) / height) * box.height),
      [h('div.small', h('b', shortDay(row.day))),
        ...series.map((serie) => h('div.t-row',
          h('span', swatch(serie.colour), ` ${serie.label}`),
          h('b', Number.isFinite(serie.value(row)) ? format(serie.value(row)) : '—')))]);
  });
  svg.addEventListener('pointerleave', () => { crosshair.setAttribute('opacity', 0); tip.hide(); });

  if (series.length >= 2) {
    root.append(h('div.legend', series.map((serie) =>
      h('span.key', swatch(serie.colour), serie.label))));
  }
  root.append(tableView(
    [{ label: 'Day', get: (r) => shortDay(r.day) },
      ...series.map((serie) => ({ label: serie.label, num: true, get: (r) => format(serie.value(r)) }))],
    rows));
  return root;
}

/**
 * Horizontal bars, one measure, sorted. The form for "which is biggest".
 *
 * Negative values run left of a zero line, because a line that loses money is
 * the thing somebody opened this screen to find.
 */
export function barChart(rows, { label, value, colour, format = moneyShort, height } = {}) {
  const root = h('div.chart');
  if (!rows.length) return mount(root, h('p.muted.small', 'Nothing in this window.'));

  const width = 720;
  const rowHeight = 30;
  const chartHeight = height || rows.length * rowHeight + 18;
  const max = Math.max(...rows.map((r) => Math.abs(value(r))), 1);
  const labelWidth = 128;
  const plotX = labelWidth;
  const plotW = width - labelWidth - 74;
  const hasNegative = rows.some((r) => value(r) < 0);
  const zeroX = hasNegative ? plotX + plotW / 2 : plotX;
  const scale = hasNegative ? (plotW / 2) / max : plotW / max;

  const marks = rows.flatMap((row, i) => {
    const v = value(row);
    const w = Math.abs(v) * scale;
    // Bars are capped at 24px and the leftover in the band is left as air.
    const thickness = Math.min(24, rowHeight - 8);
    const y = 8 + i * rowHeight + (rowHeight - thickness) / 2;
    const x = v < 0 ? zeroX - w : zeroX;
    const fill = typeof colour === 'function' ? colour(row) : (colour || 'var(--series-1)');
    // 4px rounded at the data end, square at the baseline.
    const r = Math.min(4, w);
    const d = v < 0
      ? `M${x + r} ${y} h${w - r} v${thickness} h${-(w - r)} a${r} ${r} 0 0 1 ${-r} ${-r} v${-(thickness - 2 * r)} a${r} ${r} 0 0 1 ${r} ${-r} z`
      : `M${x} ${y} h${w - r} a${r} ${r} 0 0 1 ${r} ${r} v${thickness - 2 * r} a${r} ${r} 0 0 1 ${-r} ${r} h${-(w - r)} z`;
    return [
      s('text', { x: labelWidth - 10, y: y + thickness / 2 + 4, 'text-anchor': 'end', fill: 'var(--ink-2)', 'font-size': 11.5 }, label(row)),
      s('path', { d: w > 1 ? d : `M${x} ${y} h1 v${thickness} h-1 z`, fill, 'data-i': i }),
      // The value rides the tip of its own bar, always outside it, so it can
      // never be clipped by a short bar or lost inside a pale one.
      s('text', {
        x: v < 0 ? x - 6 : x + w + 6, y: y + thickness / 2 + 4,
        'text-anchor': v < 0 ? 'end' : 'start',
        fill: 'var(--ink-2)', 'font-size': 11, 'font-variant-numeric': 'tabular-nums',
      }, format(v)),
    ];
  });

  const svg = s('svg', { viewBox: `0 0 ${width} ${chartHeight}`, role: 'img' },
    hasNegative ? s('line', { x1: zeroX, x2: zeroX, y1: 4, y2: chartHeight - 4, stroke: 'var(--axis)', 'stroke-width': 1 }) : null,
    marks);

  mount(root, svg);
  root.append(tableView(
    [{ label: 'Line', get: label }, { label: 'Value', num: true, get: (r) => format(value(r)) }],
    rows));
  return root;
}

/**
 * Stacked columns. Used for a mix that adds to a whole — the tender split, a
 * cost breakdown — and never for two things that merely happen to be near each
 * other in size.
 */
export function stackedColumns(rows, series, { height = 190, format = moneyShort } = {}) {
  const root = h('div.chart');
  if (!rows.length) return mount(root, h('p.muted.small', 'Nothing in this window.'));

  const width = 720;
  const totals = rows.map((row) => series.reduce((sum, serie) => sum + (serie.value(row) || 0), 0));
  const { plot, yOf, gridlines } = frame({ width, height, max: Math.max(...totals, 0), format });
  const band = plot.w / rows.length;
  const thickness = Math.min(24, band - 3);

  const marks = rows.flatMap((row, i) => {
    const x = plot.x + i * band + (band - thickness) / 2;
    let cursor = 0;
    return series.map((serie) => {
      const v = serie.value(row) || 0;
      const y = yOf(cursor + v);
      const barHeight = yOf(cursor) - y;
      cursor += v;
      if (barHeight <= 0) return null;
      // A 2px gap in the surface colour separates the segments. Nothing is
      // outlined: the gap does the dividing.
      return s('rect', {
        x, y, width: thickness, height: Math.max(0, barHeight - 2),
        fill: serie.colour, rx: 1,
      });
    }).filter(Boolean);
  });

  const xTicks = [];
  const every = Math.max(1, Math.ceil(rows.length / 6));
  rows.forEach((row, i) => {
    if (i % every && i !== rows.length - 1) return;
    xTicks.push(s('text', {
      x: plot.x + i * band + band / 2, y: height - 8, 'text-anchor': 'middle',
      fill: 'var(--muted)', 'font-size': 10.5,
    }, shortDay(row.day)));
  });

  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img' },
    gridlines, marks, xTicks,
    s('rect', { x: plot.x, y: plot.y, width: plot.w, height: plot.hgt, fill: 'transparent' }));

  mount(root, svg);
  const tip = hoverLayer(root);
  svg.addEventListener('pointermove', (event) => {
    const box = svg.getBoundingClientRect();
    const localX = ((event.clientX - box.left) / box.width) * width;
    const index = Math.floor((localX - plot.x) / band);
    if (!(index >= 0 && index < rows.length)) return;
    const row = rows[index];
    tip.show(((plot.x + index * band + band / 2) / width) * box.width,
      ((yOf(totals[index]) / height) * box.height),
      [h('div.small', h('b', shortDay(row.day))),
        ...series.map((serie) => h('div.t-row',
          h('span', swatch(serie.colour), ` ${serie.label}`),
          h('b', format(serie.value(row) || 0))))]);
  });
  svg.addEventListener('pointerleave', () => tip.hide());

  root.append(h('div.legend', series.map((serie) => h('span.key', swatch(serie.colour), serie.label))));
  root.append(tableView(
    [{ label: 'Day', get: (r) => shortDay(r.day) },
      ...series.map((serie) => ({ label: serie.label, num: true, get: (r) => format(serie.value(r) || 0) }))],
    rows));
  return root;
}

/**
 * Two measures of different size, side by side as small multiples.
 *
 * This exists so that nobody is ever tempted to put hours and cedis on one
 * pair of axes. Two panels, each with its own scale, each honestly labelled,
 * sharing an x-axis.
 */
export function smallMultiples(rows, panels, options = {}) {
  return h('div.grid.two', panels.map((panel) => h('div',
    h('h3', panel.title),
    panel.note ? h('p.sub', panel.note) : null,
    lineChart(rows, [{ key: panel.key, label: panel.title, colour: panel.colour, value: panel.value }],
      { ...options, format: panel.format, height: 150 }))));
}

/** A twelve-point sparkline for a stat tile. No axis, no labels, no hover. */
export function sparkline(values, colour = 'var(--series-1)') {
  const clean = values.filter(Number.isFinite);
  if (clean.length < 2) return h('span');
  const max = Math.max(...clean);
  const min = Math.min(...clean);
  const span = max - min || 1;
  const width = 92;
  const height = 22;
  const points = clean.map((v, i) => [
    (i / (clean.length - 1)) * width,
    height - ((v - min) / span) * height,
  ]);
  return h('div.chart', s('svg', { viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true' },
    s('path', {
      d: points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' '),
      fill: 'none', stroke: colour, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    })));
}
