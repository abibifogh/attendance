import { api } from '../api.js';
import { can, state } from '../app.js';
import { fmtSince, h, mount, todayISO } from '../util.js';
import { face } from './components.js';
import { lateBy } from './att-shared.js';
import { byDepartment, sayHowItStands, standing, toDealWith } from '../today-groups.js';
import { questionCard, settledList } from './absence.js';

/**
 * Home, for everybody who runs the floor.
 *
 * Three questions, in the order a morning asks them: who is here, who is not,
 * and what is waiting on me. Everything else is a tap away in the menu. A home
 * page that tries to show the whole property is a dashboard nobody reads.
 */
export async function renderHome() {
  const host = h('div');
  const day = todayISO();
  const decides = ['att_manage', 'att_setup', 'att_rota', 'hr_pay', 'hr_manage', 'lunch'].some((p) => can(p));

  const [today, inbox, asks] = await Promise.all([
    api.attDay(day).catch(() => null),
    decides ? api.inbox().catch(() => null) : Promise.resolve(null),
    can('att_rota') ? api.absenceQuestions().catch(() => null) : Promise.resolve(null),
  ]);
  const reload = async () => mount(host, ...(await renderHome()).childNodes);

  const rows = today?.rows ?? [];
  const count = (s) => rows.filter((r) => standing(r) === s).length;
  const late = rows.filter((r) => standing(r) === 'amber');
  const issues = rows.filter(toDealWith);
  const departments = byDepartment(rows).filter((d) => d.rows.length);
  const waiting = inbox?.items ?? [];

  const first = String(state.name || '').split(/\s+/)[0];
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  mount(host,
    h('div.page-head',
      h('div',
        h('h1', first ? `${hello}, ${first}` : hello),
        h('div.sub', [
          new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }),
          state.settings?.property_name,
        ].filter(Boolean).join(' · '))),
      can('att_rota') || can('att_rota_view')
        ? h('div.btn-row', h('a.btn', { href: '#/att-rota' }, 'Open the rota'))
        : null),

    asks?.open?.length
      ? h('div.ask-cards', asks.open.map((q) => questionCard(q, reload)))
      : null,
    asks?.open?.length ? settledList((asks.settled ?? []).filter((q) => q.day === asks.today)) : null,

    h('div.home-tiles',
      tile(count('green') + late.length, 'In today'),
      tile(late.length, 'Late or left early', late.length ? 'warn' : ''),
      tile(count('red'), 'Absent', count('red') ? 'bad' : ''),
      tile(count('open'), 'To confirm', count('open') ? 'warn' : '')),

    h('div.home-grid',
      decides
        ? h('section.card', { 'aria-labelledby': 'home-needs' },
          h('div.card-head',
            h('h2', { id: 'home-needs' }, 'Waiting on you'),
            waiting.length ? h('a.btn-sm.btn-primary', { href: '#/inbox' }, `Open inbox · ${waiting.length}`) : null),
          waiting.length
            ? h('div.home-list',
              waiting.slice(0, 5).map((item) => h('a.home-row', { href: '#/inbox' },
                h('span.pill', item.kindLabel),
                h('span.home-row-main', `${item.who ? `${item.who}: ` : ''}${item.sub || item.title}`),
                item.askedAt ? h('small.muted', fmtSince(item.askedAt)) : null)),
              waiting.length > 5 ? h('div.muted.home-more', `and ${waiting.length - 5} more`) : null)
            : h('p.muted', 'Nothing waiting on you.'))
        : null,

      h('section.card', { 'aria-labelledby': 'home-late' },
        h('div.card-head',
          h('h2', { id: 'home-late' }, 'Late, absent or to confirm'),
          h('a', { href: '#/att-today' }, 'Everyone today')),
        issues.length
          ? h('div.home-list', issues.slice(0, 8).map((row) => h('a.home-row', {
            href: `#/att-staff?id=${row.staff?.id}&day=${day}`,
          },
          face(row.staff?.name, { size: '2rem' }),
          h('span.home-row-main',
            h('strong', row.staff?.name ?? ''),
            h('small.muted', [row.staff?.department, row.shift?.name].filter(Boolean).join(' · '))),
          h(`span.pill.${pillOf(row)}`, sayRow(row)))),
          issues.length > 8 ? h('a.home-more', { href: '#/att-today' }, `and ${issues.length - 8} more`) : null)
          : h('p.muted', rows.length ? 'Everybody is accounted for.' : 'Nobody is on the rota today.')),

      departments.length
        ? h('section.card', { 'aria-labelledby': 'home-depts' },
          h('div.card-head', h('h2', { id: 'home-depts' }, 'By department')),
          h('div.home-list', departments.map((d) => h('a.home-row', { href: '#/att-today' },
            h('span.home-row-main', h('strong', d.department)),
            h('small.muted', sayHowItStands(d))))))
        : null,
    ),
  );

  return host;
}

function tile(n, label, tone = '') {
  return h('div.card.home-tile', { class: tone ? `card home-tile is-${tone}` : 'card home-tile' },
    h('span.home-tile-n', String(n)), h('span.home-tile-l', label));
}

function pillOf(row) {
  const s = standing(row);
  return s === 'red' ? 'bad' : s === 'open' ? 'warn' : s === 'amber' ? 'warn' : '';
}

function sayRow(row) {
  const s = standing(row);
  if (s === 'open') return 'To confirm';
  if (s === 'red') return row.label || 'Absent';
  if (row.late_minutes > 0) return `${lateBy(row.late_minutes)} late`;
  if (row.early_minutes > 0) return 'Left early';
  return row.label || 'Late or early';
}
