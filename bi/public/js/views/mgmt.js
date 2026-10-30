import { h, mount } from '../util.js';
import { api } from '../api.js';
import { state } from '../app.js';

/**
 * The management report: a week or a month of the other systems on one page.
 * The figures at the top, what needs a decision, then a section a system:
 * breakfast, maintenance, and more to come. Each system works its own figures
 * out (see src/routes/mgmt.js); this page only draws them. PDF is the
 * browser's own print, with the buttons left off.
 */

const cedis = (x, dp = 0) => (x == null || !Number.isFinite(Number(x)) ? '—'
  : `${Number(x) < 0 ? '−' : ''}GH₵ ${Math.abs(Number(x)).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`);
const n = (x) => (x == null ? '—' : Number(x).toLocaleString('en-GB'));
const tone = (s) => (s == null ? 'none' : s >= 80 ? 'good' : s >= 65 ? 'warn' : 'bad');
const day = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const STATUS = { negative: ['Below nothing', 'bad'], below_par: ['Below reorder', 'warn'], low_cover: ['Running out', 'warn'] };

const asked = () => {
  const i = location.hash.indexOf('?');
  const q = new URLSearchParams(i < 0 ? '' : location.hash.slice(i + 1));
  let period = q.get('period');
  if (period !== 'week' && period !== 'month') {
    try { period = sessionStorage.getItem('insight-mgmt-period') || 'week'; } catch { period = 'week'; }
  }
  // The sections left out, as chosen with "Include" (kept for the visit).
  let skip = q.get('skip');
  if (skip == null) { try { skip = sessionStorage.getItem('insight-mgmt-skip') || ''; } catch { skip = ''; } }
  return { period: period === 'month' ? 'month' : 'week', at: q.get('at') || '', skip };
};

/**
 * `part: 'settings'` is Settings › Notifications › Management report: who
 * gets it and whether it goes by itself, without reading the report.
 */
export async function renderMgmt(root, { part = null } = {}) {
  const me = state.me?.account;
  const isAdmin = (me?.till?.role || (me?.isOwner || me?.bootstrap ? 'admin' : null)) === 'admin';
  const view = h('div.mg');
  if (part === 'settings') {
    let mail = await api('/reports/management/mail');
    const r = { sections: mail.sections, skip: [] };
    return mount(root, view, settingsCard());

    /** Who gets it, and sending by itself. */
    function settingsCard() {
      const box = h('section.card.mg-mail');
      const draw = () => {
        const emails = [...mail.emails];
        const typed = h('input', { type: 'email', placeholder: 'Add an email address', 'aria-label': 'Email address' });
        const said = h('span.small');
        const save = async (body) => {
          said.textContent = 'Saving…'; said.className = 'small';
          try { mail = { ...mail, ...(await api('/reports/management/mail', { method: 'POST', body: { emails, admins: mail.admins, weekly: mail.weekly, monthly: mail.monthly, ...body } })) }; draw(); } catch (err) { said.textContent = err.message; said.className = 'small form-error'; }
        };
        const add = () => {
          const v = typed.value.trim().toLowerCase();
          if (!v) return;
          if (emails.includes(v)) { said.textContent = 'Already on the list.'; return; }
          save({ emails: [...emails, v] });
        };
        const tick = (key, label, opts = {}) => h('label.mg-tick', h('input', { type: 'checkbox', checked: mail[key], disabled: opts.disabled, onchange: (e) => save({ [key]: e.target.checked }) }), label);
        const last = mail.lastSent || {};
        const auto = h('input', { type: 'checkbox', role: 'switch', checked: mail.auto, 'aria-label': 'Send by itself', onchange: (e) => save({ auto: e.target.checked }) });
        mount(box,
          h('h2', 'Management report'),
          h('p.sub', 'The weekly or monthly report from breakfast and maintenance. Nothing goes until somebody presses Send on Reports › Management report, unless sending by itself is switched on.'),
          h('div.mg-auto',
            h('label.mg-switch', auto, h('span.track', h('span.knob')), h('b', mail.auto ? 'Sending by itself: on' : 'Sending by itself: off')),
            h('p.small.muted', mail.auto ? 'Sent by itself at 06:45 for the ticked ones below. Each week or month goes once.' : 'Off: it goes only when somebody presses Send.'),
            h('div.mg-row', tick('weekly', 'Every Monday: last week', { disabled: !mail.auto }), tick('monthly', 'On the 1st: last month', { disabled: !mail.auto })),
            h('div.mg-row', h('span.small', 'With:'), r.sections.map((x) => h('label.mg-tick',
              h('input', {
                type: 'checkbox', checked: !(mail.skip || []).includes(x.key), disabled: !mail.auto,
                onchange: (e) => {
                  const left = e.target.checked ? (mail.skip || []).filter((k) => k !== x.key) : [...(mail.skip || []), x.key];
                  if (left.length === r.sections.length) { e.target.checked = true; said.textContent = 'At least one section has to go.'; return; }
                  save({ skip: left });
                },
              }), x.label)))),
          h('h3', 'Who gets it'),
          h('div.mg-row', tick('admins', `Insight’s admins${mail.adminEmails?.length ? ` (${mail.adminEmails.join(', ')})` : ''}`)),
          h('div.mg-emails', emails.length ? emails.map((e) => h('span.mg-email', e,
            h('button', { type: 'button', 'aria-label': `Remove ${e}`, title: 'Remove', onclick: () => save({ emails: emails.filter((x) => x !== e) }) }, '×')))
            : h('span.muted', 'Nobody else yet. Any address works, not only people with an account.')),
          h('div.mg-row', typed, h('button.btn', { type: 'button', onclick: add }, 'Add')),
          h('p.small.muted', `Last sent: ${last.week ? `week of ${day(last.week)}` : 'no week yet'} · ${last.month ? new Date(`${last.month}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'no month yet'}.`),
          said);
      };
      draw();
      return box;
    }
  }
  const { period, at, skip } = asked();
  mount(root, view, h('p.muted', 'Asking each system…'));
  const r = await api(`/reports/management?period=${period}${at ? `&at=${encodeURIComponent(at)}` : ''}${skip ? `&skip=${encodeURIComponent(skip)}` : ''}`);
  const go = (p, key, left = r.skip) => {
    try { sessionStorage.setItem('insight-mgmt-period', p); sessionStorage.setItem('insight-mgmt-skip', left.join(',')); } catch { /* private mode */ }
    location.hash = `#/management?period=${p}${key ? `&at=${key}` : ''}${left.length ? `&skip=${left.join(',')}` : ''}`;
  };
  // Include or leave out a section: the page, its PDF and Send all follow.
  const toggle = (key) => {
    const left = r.skip.includes(key) ? r.skip.filter((k) => k !== key) : [...r.skip, key];
    if (left.length === r.sections.length) return;
    go(r.period, r.key, left);
  };
  let mailBox = null;
  let mail = null;

  paint();

  function paint() {
    mount(root, view);
    mount(view,
      h('div.mg-top',
        h('div', h('h1', 'Management report'), h('p', `${r.label} · ${r.vs}`)),
        h('div.mg-tools',
          h('div.mg-seg', { role: 'group', 'aria-label': 'Week or month' },
            h('button', { type: 'button', class: r.period === 'week' ? 'on' : '', 'aria-pressed': String(r.period === 'week'), onclick: () => go('week') }, 'Week'),
            h('button', { type: 'button', class: r.period === 'month' ? 'on' : '', 'aria-pressed': String(r.period === 'month'), onclick: () => go('month') }, 'Month')),
          h('div.mg-period',
            h('button.btn', { type: 'button', 'aria-label': r.period === 'week' ? 'Week before' : 'Month before', onclick: () => go(r.period, r.before) }, '‹'),
            h('b', r.title),
            h('button.btn', { type: 'button', 'aria-label': r.period === 'week' ? 'Week after' : 'Month after', disabled: r.latest, onclick: () => go(r.period, r.after) }, '›')),
          h('div.mg-include', { role: 'group', 'aria-label': 'Sections to include' },
            h('span', 'Include'),
            r.sections.map((x) => {
              const on = !r.skip.includes(x.key);
              return h('button', {
                type: 'button', class: on ? 'on' : '', 'aria-pressed': String(on),
                title: on ? `Leave ${x.label} out of the page, its PDF and the email` : `Put ${x.label} back`,
                disabled: on && r.skip.length === r.sections.length - 1,
                onclick: () => toggle(x.key),
              }, on ? `✓ ${x.label}` : x.label);
            })),
          h('button.btn', { type: 'button', onclick: () => window.print() }, '⤓ PDF'),
          // An admin goes to Sending the report; anybody else may send it to themselves.
          isAdmin
            ? h('button.btn', { type: 'button', onclick: () => document.getElementById('mg-mail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, '✉ Send')
            : h('button.btn', { type: 'button', 'aria-expanded': String(Boolean(mailBox)), onclick: () => { mailBox = mailBox ? null : true; paint(); } }, '✉ Email it'))),
      mailBox ? sendBox() : null,

      h('div.mg-tiles', r.tiles.map((t) => h('div.mg-tile',
        h('small', t.label), h('b.num', t.value), h(`span.d.${t.tone}`, t.sub), h('span.from', t.source)))),

      h('section.card.mg-attn',
        h('h2', 'Needs your attention'),
        h('p.sub', `The few things worth a decision this ${r.period}, from every system, most serious first.`),
        r.attention.length
          ? h('ul', r.attention.map((a) => h('li',
            h(`span.mg-ic.${a.level}`, { 'aria-label': a.level === 'good' ? 'Good' : a.level === 'bad' ? 'Serious' : 'Worth a look' }, a.level === 'good' ? '✓' : '!'),
            h('span', a.text), h('span.src', a.source))))
          : h('p.muted', 'Nothing stands out.')),

      r.breakfast?.skipped ? null : breakfast(r.breakfast),
      r.maintenance?.skipped ? null : maintenance(r.maintenance),
      r.skip.length ? h('p.small.muted.mg-left', `Left out of this report: ${r.sections.filter((x) => r.skip.includes(x.key)).map((x) => x.label).join(', ')}. Press it under Include to put it back.`) : null,

      isAdmin ? mailCard() : null,
      h('p.mg-foot', `Made by Insight, ${new Date(r.made).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })}. Each system's figures are its own, as its own screens show them.`));
  }


  // ------------------------------------------------------------ breakfast --
  function breakfast(b) {
    const head = h('div.mg-srchead', h('h2', '☕ Breakfast'), h('span', 'from the breakfast app · usage, deliveries, counts and the bakery'));
    if (!b?.ok) return h('section.mg-src.mg-bf', head, h('div.card.mg-off', b?.error || 'Not linked.'));
    const prevWord = r.prevName[0].toUpperCase() + r.prevName.slice(1);
    return h('section.mg-src.mg-bf', head,
      b.note ? h('p.mg-note', b.note) : null,
      h('div.mg-g2',
        h('div.card',
          h('h3', `Food cost per guest, ${r.period === 'week' ? 'day by day' : 'week by week'}`),
          columns(b.series, b.reference),
          h('p.small.muted', `What was used each morning at what it cost, over in-house and outside guests.${b.reference != null ? ` Dashed: ${r.prevName}’s average, ${cedis(b.reference, 2)}.` : ''}`)),
        h('div.card',
          h('h3', `The ${r.period} in figures`),
          h('div.mg-table', h('table',
            h('thead', h('tr', h('th', ''), h('th.n', `This ${r.period}`), h('th.n', prevWord))),
            h('tbody', b.figures.map((f) => h('tr', h('td', f.label), h('td.n.num', f.now), h('td.n.num.muted', f.before)))))))),
      h('div.mg-g3',
        h('div.card',
          h('h3', 'What moved the cost per guest'),
          b.movers.length ? [
            h('div.mg-table', h('table', h('tbody', b.movers.map((m) => h('tr',
              h('td', m.name),
              h(`td.n.num.${m.change > 0 ? 'bad' : 'good'}`, `${m.change > 0 ? '+' : '−'}${Math.abs(m.change).toFixed(2)}`)))))),
            h('p.small.muted', `GH₵ a guest, against ${r.prevName}.`),
          ] : h('p.muted', 'Nothing moved it much.')),
        h('div.card', h('h3', 'Deliveries by supplier'),
          b.suppliers.length ? bars(b.suppliers.map((s) => [s.name, s.value]), (v) => cedis(v)) : h('p.muted', 'Nothing delivered.')),
        h('div.card',
          h('h3', 'Below the reorder level'),
          b.reorder.length ? h('div.mg-table', h('table',
            h('thead', h('tr', h('th', 'Item'), h('th.n', 'In stock'), h('th.n', 'Lasts'))),
            h('tbody', b.reorder.slice(0, 8).map((x) => h('tr',
              h('td', x.name),
              h('td.n.num', `${n(x.stock)} ${x.unit}`),
              h('td.n', h(`span.mg-chip.${(STATUS[x.status] || [])[1] || 'none'}`, x.daysCover != null ? `${x.daysCover} day${x.daysCover === 1 ? '' : 's'}` : (STATUS[x.status] || ['—'])[0]))))))) : h('p.muted', 'Everything is above its reorder level.'),
          b.reorder.length > 8 ? h('p.small.muted', `And ${b.reorder.length - 8} more in the breakfast app.`) : null,
          b.short.value < 0 ? h('p.small', 'Last counts against the books: ', h('b.bad', `${cedis(-b.short.value)} short`), ` (${b.short.names.join(', ')}).`) : null)));
  }

  // ---------------------------------------------------------- maintenance --
  function maintenance(m) {
    const head = h('div.mg-srchead', h('h2', '🔧 Maintenance'), h('span', 'from the maintenance app · rounds, jobs, plans and the store'));
    if (!m?.ok) return h('section.mg-src.mg-mx', head, h('div.card.mg-off', m?.error || 'Not linked.'));
    const ro = m.rounds;
    const j = m.jobs;
    const st = m.store;
    return h('section.mg-src.mg-mx', head,
      h('div.mg-g3',
        h('div.card', h('h3', 'Room rounds'),
          meter('Rooms visited', ro.rooms.done, ro.rooms.total),
          meter('Areas visited', ro.areas.done, ro.areas.total),
          meter('Preventive checks done', ro.preventive.done, ro.preventive.due),
          h('p.small', h('b.num', n(ro.faults)), ' faults found: ', h('b', n(ro.fixed)), ' fixed on the spot, ', h('b', n(ro.toJobs)), ' became jobs.'),
          ro.missed.length ? h('p.small.muted', `Missed: ${[...new Set(ro.missed)].join(', ')}.`) : null),
        h('div.card', h('h3', 'Jobs'),
          h('div.mg-table', h('table', h('tbody',
            h('tr', h('td', 'Reported'), h('td.n.num', n(j.reported))),
            h('tr', h('td', 'Done'), h('td.n.num', n(j.done))),
            h('tr', h('td', 'Still open'), h('td.n.num', n(j.open), j.oldestOpenDays != null ? h('span.small.muted', ` (oldest ${j.oldestOpenDays} days)`) : null)),
            h('tr', h('td', 'Median time to fix'), h('td.n.num', j.medianFixDays != null ? `${j.medianFixDays} days` : '—')),
            h('tr', h('td', 'Time-sensitive, late'), h('td.n', h(`span.mg-chip.${j.late.length ? 'bad' : 'good'}`, String(j.late.length)))))))),
        h('div.card', h('h3', 'Jobs by trade'),
          j.byCategory.length ? bars(j.byCategory.map((c) => [c.category, c.reported || c.done]), (v) => String(v), 'Reported') : h('p.muted', 'No jobs.'))),
      h('div.card',
        h('h3', 'Artisans'),
        h('p.sub', `Each week’s score out of 100, as the maintenance app works it out: completed 50, on time 20, kept to the plan 20, plan in on time 10.${r.period === 'month' ? ' The month is the average of its weeks.' : ''}`),
        m.artisans.length ? h('div.mg-table', h('table',
          h('thead', h('tr', h('th', 'Artisan'), h('th', 'Trade'), h('th.n', 'Score'), h('th', 'Made of'), h('th.n', 'Jobs done'), h('th.n', 'Carried over'))),
          h('tbody', m.artisans.map((a) => h('tr',
            h('td', a.name),
            h('td.muted', a.trades.join(', ')),
            h('td.n', h(`span.mg-score.${tone(a.score)}.num`, a.score == null ? '—' : String(a.score))),
            h('td', parts(a.parts)),
            h('td.n.num', n(a.done)),
            h('td.n.num', n(a.carried))))))) : h('p.muted', 'No artisans.')),
      h('div.mg-g3',
        h('div.card', h('h3', 'Store: parts used, by trade'),
          st.byCategory.length ? bars(st.byCategory.map((c) => [c.name, c.value]), (v) => cedis(v)) : h('p.muted', 'No parts used.')),
        h('div.card', h('h3', 'Most used parts'),
          st.topParts.length ? h('div.mg-table', h('table',
            h('thead', h('tr', h('th', 'Part'), h('th.n', 'Issued'), h('th.n', 'Value'))),
            h('tbody', st.topParts.map((x) => h('tr', h('td', x.name), h('td.n.num', `${n(x.qty)} ${x.unit}`), h('td.n.num', cedis(x.value))))))) : h('p.muted', 'No parts used.')),
        h('div.card', h('h3', 'Store stock'),
          st.belowPar.length ? h('div.mg-table', h('table',
            h('thead', h('tr', h('th', 'Part'), h('th.n', 'Left'), h('th.n', ''))),
            h('tbody', st.belowPar.slice(0, 8).map((x) => h('tr', h('td', x.name), h('td.n.num', `${n(x.onHand)} ${x.unit}`),
              h('td.n', h(`span.mg-chip.${x.onHand <= 0 ? 'bad' : 'warn'}`, `reorder at ${n(x.par)}`))))))) : h('p.muted', 'Every part is above its reorder level.'),
          h('p.small',
            `On the shelf: ${cedis(st.shelfValue)}. Bought: ${cedis(st.purchased)}.`, h('br'),
            `${st.counts.made} count${st.counts.made === 1 ? '' : 's'}${st.counts.waiting ? ` (${st.counts.waiting} waiting for approval)` : ''} · ${st.stocktakes} stocktake${st.stocktakes === 1 ? '' : 's'} sent.`, h('br'),
            `${st.tools.out} tool${st.tools.out === 1 ? '' : 's'} out${st.tools.overdue.length ? ` · ${st.tools.overdue.length} overdue (${st.tools.overdue.map((t) => `${t.tool}, ${t.daysOver} day${t.daysOver === 1 ? '' : 's'}`).join('; ')})` : ''}.`))));
  }

  // ------------------------------------------------------------- pictures --
  /** One column per day or week, a dashed line at the period before. Hover for the figure. */
  function columns(series, ref) {
    const values = series.map((x) => x.value).filter((v) => v != null);
    if (!values.length) return h('p.muted', 'No breakfast recorded.');
    const top = Math.max(...values, ref || 0) * 1.15 || 1;
    return h('div',
      h('div.mg-cols', { role: 'img', 'aria-label': `Food cost per guest: ${series.map((x) => `${x.label} ${x.value == null ? 'not recorded' : x.value.toFixed(2)}`).join(', ')}` },
        series.map((x) => h('div.c', { title: x.value == null ? `${x.label}: not recorded` : `${x.label}: ${cedis(x.value, 2)} a guest` },
          x.value == null ? h('em', '—') : [h('i', { style: `height:${(x.value / top) * 100}%` }), h('span.num', x.value.toFixed(2))])),
        ref != null ? h('div.ref', { style: `bottom:${(ref / top) * 100}%`, title: `${r.prevName}: ${cedis(ref, 2)} a guest` }) : null),
      h('div.mg-xl', series.map((x) => h('span', x.label))));
  }

  function bars(rows, fmt, what = '') {
    const max = Math.max(1, ...rows.map((x) => x[1]));
    return h('div.mg-bars', rows.map(([k, v]) => h('div.bar', { title: `${k}: ${what ? `${what} ` : ''}${fmt(v)}` },
      h('span.k', k), h('span.t', h('i', { style: `width:${(v / max) * 100}%` })), h('span.v.num', fmt(v)))));
  }

  function meter(label, done, total) {
    return [
      h('div.small', `${label} `, h('b.num', total ? `${n(done)} of ${n(total)}` : '—')),
      h('div.mg-meter', h('i', { style: `width:${total ? (done / total) * 100 : 0}%` })),
    ];
  }

  function parts(p) {
    if (!p) return h('span.muted', '—');
    return h('div.mg-parts', { title: `Completed ${p.completion}/50 · on time ${p.onTime}/20 · kept to the plan ${p.kept}/20 · plan in on time ${p.plan}/10` },
      h('i', { style: `width:${p.completion}%` }), h('i', { style: `width:${p.onTime}%` }), h('i', { style: `width:${p.kept}%` }), h('i', { style: `width:${p.plan}%` }));
  }

  // ---------------------------------------------------------------- email --
  function sendBox() {
    const said = h('span.small');
    const send = async (button, everyone) => {
      button.disabled = true; said.textContent = 'Sending…'; said.className = 'small';
      try {
        const out = await api('/reports/management/send', { method: 'POST', body: { period: r.period, at: r.key, skip: r.skip, everyone } });
        said.textContent = out.sent ? `Sent to ${everyone ? `${out.sent} address${out.sent === 1 ? '' : 'es'}` : me?.email}.${out.failed?.length ? ` Not sent to: ${out.failed.join('; ')}` : ''}` : (out.failed?.[0] || out.reason || 'Not sent.');
        said.className = out.sent ? 'small' : 'small form-error';
      } catch (err) { said.textContent = err.message; said.className = 'small form-error'; }
      button.disabled = false;
    };
    const toMe = h('button.btn', { type: 'button', onclick: () => send(toMe, false) }, 'Send it to me');
    return h('div.card.mg-send', h('p.small', `${r.label}: the figures, what needs attention and both sections in short, with a link back here.`), h('div.mg-row', toMe, said));
  }

  /** Sending it now, to everybody it goes to or to yourself; who that is and sending by itself are in Settings › Notifications. */
  function mailCard() {
    const box = h('section.card.mg-mail', { id: 'mg-mail' }, h('h2', 'Sending the report'), h('p.muted', 'Loading…'));
    const draw = () => {
      const said = h('span.small');
      const who = [mail.admins ? 'Insight’s admins' : null, mail.emails.length ? `${mail.emails.length} address${mail.emails.length === 1 ? '' : 'es'}` : null].filter(Boolean);
      const sendNow = h('button.btn.primary', {
        type: 'button',
        disabled: !mail.emails.length && !mail.admins,
        onclick: async () => {
          if (!window.confirm(`Send ${r.title} now to everybody on the list?`)) return;
          sendNow.disabled = true; said.textContent = 'Sending…'; said.className = 'small';
          try {
            const out = await api('/reports/management/send', { method: 'POST', body: { period: r.period, at: r.key, skip: r.skip, everyone: true } });
            said.textContent = out.sent ? `Sent ${r.title} to ${out.sent} address${out.sent === 1 ? '' : 'es'}.${out.failed?.length ? ` Not sent to: ${out.failed.join('; ')}` : ''}` : (out.failed?.[0] || out.reason || 'Not sent.');
            said.className = out.sent ? 'small' : 'small form-error';
          } catch (err) { said.textContent = err.message; said.className = 'small form-error'; }
          sendNow.disabled = false;
        },
      }, `✉ Send ${r.title} now`);
      const toMe = h('button.btn', {
        type: 'button',
        onclick: async () => {
          toMe.disabled = true; said.textContent = 'Sending…'; said.className = 'small';
          try {
            const out = await api('/reports/management/send', { method: 'POST', body: { period: r.period, at: r.key, skip: r.skip } });
            said.textContent = out.sent ? `Sent ${r.title} to ${me?.email}.` : (out.failed?.[0] || out.reason || 'Not sent.');
            said.className = out.sent ? 'small' : 'small form-error';
          } catch (err) { said.textContent = err.message; said.className = 'small form-error'; }
          toMe.disabled = false;
        },
      }, 'Send a test to me');
      mount(box,
        h('h2', 'Sending the report'),
        h('p.sub', `Send sends the sections included above${r.skip.length ? ` (without ${r.sections.filter((x) => r.skip.includes(x.key)).map((x) => x.label).join(', ')})` : ''}.`),
        h('div.mg-row', sendNow, toMe),
        h('p.small.muted', `It goes to ${who.length ? who.join(' and ') : 'nobody yet'}. Sending by itself is ${mail.auto ? 'on' : 'off'}. `,
          h('a', { href: '#/notify-mgmt' }, 'Change who gets it, and when')),
        said);
    };
    if (mail) { draw(); return box; }
    api('/reports/management/mail').then((m) => { mail = m; draw(); }).catch((err) => mount(box, h('h2', 'Sending the report'), h('p.form-error', err.message)));
    return box;
  }
}
