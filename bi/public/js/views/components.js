import { h } from '../util.js';
import { money, num, percent, delta, moneyShort } from '../util.js';
import { sparkline } from '../charts.js';

/** A labelled number, how it has moved, and what it does not include. */
export function tile({ label, value, unit, changePct, goodWhen = 'up', note, spark }) {
  const d = delta(changePct, { goodWhen });
  const shown = value == null ? '—'
    : unit === 'money' ? money(value)
      : unit === 'percent' ? percent(value)
        : num(value);
  return h('div.tile',
    h('div.label', label),
    h('div.value', shown),
    h(`div.delta.${d.tone}`, d.arrow ? h('span', d.arrow) : null, d.text,
      changePct == null ? null : h('span.muted', { style: { fontWeight: '400' } }, ' vs the period before')),
    spark ? sparkline(spark) : null,
    note ? h('div.note', note) : null);
}

/** A severity chip. Always an icon and a word, never a colour on its own. */
export function severityPill(severity) {
  const marks = { critical: '!', warning: '!', info: 'i', good: '✓' };
  const words = { critical: 'Serious', warning: 'Worth acting on', info: 'Worth knowing', good: 'Going well' };
  return h(`span.pill.${severity}`, h('span.dot'), `${marks[severity] || 'i'} ${words[severity] || severity}`);
}

export function sourcePills(sources) {
  const names = {
    attendance: 'Attendance', breakfast: 'Breakfast & rooms', pos: 'POS', laundry: 'Laundry',
  };
  if (!sources?.length) return null;
  return h('span.pill', `From ${sources.map((id) => names[id] || id).join(' + ')}`);
}

export function confidencePill(confidence) {
  const words = { high: 'strong evidence', medium: 'reasonable evidence', low: 'thin evidence' };
  return h('span.pill', words[confidence] || confidence);
}

/** A finding, as it appears on the brief and in the full list. */
export function findingCard(finding, { onDecide } = {}) {
  return h(`div.finding.${finding.severity}`,
    h('div.meta',
      severityPill(finding.severity),
      finding.impactMonthly > 0
        ? h('span.pill', h('span.worth', `${moneyShort(finding.impactMonthly)} a month`))
        : null,
      confidencePill(finding.confidence),
      sourcePills(finding.sources),
      finding.state && finding.state !== 'open' ? h('span.pill', finding.state) : null),
    h('h3', finding.headline),
    h('p.body', finding.detail),
    finding.action ? h('p.action', h('strong', 'What to do: '), finding.action) : null,
    onDecide ? h('div.controls',
      h('button.btn', { onclick: () => onDecide(finding, 'acknowledged') }, 'Noted'),
      h('button.btn', { onclick: () => onDecide(finding, 'actioned') }, 'Dealt with'),
      h('button.btn', { onclick: () => onDecide(finding, 'dismissed') }, 'Not a problem')) : null);
}

/** Everything that qualifies a number on the screen it sits on. */
export function caveats(items) {
  if (!items?.length) return null;
  return h('ul.caveats', items.map((text) => h('li', text)));
}

export function banner(kind, ...children) {
  return h(`div.banner.${kind}`, ...children);
}

export function table(columns, rows, { footer } = {}) {
  return h('div.table-wrap',
    h('table',
      h('thead', h('tr', columns.map((c) => h(c.num ? 'th.num' : 'th', c.label)))),
      h('tbody', rows.length
        ? rows.map((row) => h('tr', columns.map((c) => h(c.num ? 'td.num' : 'td', c.get(row)))))
        : h('tr', h('td', { colspan: columns.length }, h('span.muted', 'Nothing in this window.')))),
      footer ? h('tfoot', h('tr', columns.map((c) => h(c.num ? 'td.num' : 'td', c.foot ? c.foot(footer) : '')))) : null));
}
