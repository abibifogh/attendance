import { h, mount, money } from '../util.js';
import { api } from '../api.js';
import { state } from '../app.js';

/**
 * Today: each person's one list. Everything that is theirs, from every page
 * (to-dos given to them, proof asked, shifts to check, staff answers,
 * envelopes, Nice Place, POs to chase and, for an admin, approvals and the
 * rest), placed by when it wants doing: Overdue, Due today, Later. Each line
 * has the button that does it, or opens the page where it is done. Chips
 * across the top show one kind at a time.
 *
 * On top, the Saturday report's clock for whoever sends it (and, once it is
 * close, for an admin). At the bottom, what this person sent up that waits
 * for an admin. Beside it: their week, the one morning email, what they did
 * today, and Ask Insight.
 */
const WHEN = [['overdue', 'Overdue'], ['today', 'Due today'], ['later', 'Later']];
const AREAS = [
  ['given', 'Given to you'], ['maintenance', 'Maintenance'], ['teamtasks', 'Team Tasks'], ['shifts', 'Shifts'], ['safe', 'Safe'], ['niceplace', 'Nice Place'],
  ['approvals', 'Approvals'], ['buying', 'Buying'], ['checks', 'Checks'], ['people', 'People'], ['report', 'Report'], ['other', 'Other'],
];
const SHOWN = 6;

export async function renderAssistant(root) {
  let area = 'all';
  try { area = sessionStorage.getItem('insight-today-area') || 'all'; } catch { /* private mode */ }
  const data = await api('/assistant');
  if (area !== 'all' && !data.areas[area]) area = 'all';
  const done = new Map();
  const more = new Set();

  const name = (state.me?.account?.name || '').split(' ')[0];
  const hour = new Date().getHours();
  const chips = h('div.today-chips', { role: 'tablist', 'aria-label': 'Show' });
  const list = h('div.today-list');
  const brief = h('p.today-brief');

  mount(root,
    h('div.today',
      h('div.today-main',
        h('div.today-hello',
          h('div',
            h('h1', `${hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'}${name ? `, ${name}` : ''}`),
            h('p.today-lede', lede(data))),
          chips),
        brief,
        data.duty ? dutyCard(data.duty) : null,
        list),
      h('aside.today-side', weekCard(), data.admin ? null : mailCard(), doneCard(), askCard(), readCard())));
  paintChips();
  paintList();

  // The summary in words, after the page: it takes a few seconds.
  api('/assistant/brief').then((b) => { if (b.by === 'ai' && b.text) brief.textContent = `✨ ${b.text}`; }).catch(() => {});

  function open() { return data.items.filter((x) => x.when && !done.has(x.key)); }

  function paintChips() {
    const items = data.items.filter((x) => x.when);
    const chip = (k, label, n) => h('button.today-chip', {
      type: 'button', role: 'tab', 'aria-selected': String(area === k),
      onclick: () => { area = k; try { sessionStorage.setItem('insight-today-area', k); } catch { /* private mode */ } paintChips(); paintList(); },
    }, label, h('span', String(n)));
    mount(chips, chip('all', 'All', items.length),
      AREAS.filter(([k]) => data.areas[k]).map(([k, label]) => chip(k, label, data.areas[k])));
  }

  function paintList() {
    const items = data.items.filter((x) => x.when && (area === 'all' || x.area === area));
    const groups = WHEN.map(([w, label]) => [w, label, items.filter((x) => x.when === w)]).filter(([, , xs]) => xs.length);
    const waiting = area === 'all' || area === 'shifts' ? data.waiting || [] : [];
    if (!groups.length && !waiting.length) {
      mount(list, h('div.today-empty', '✓ Nothing on your list. Everything Insight reads agrees, or has an answer.'));
      return;
    }
    mount(list,
      groups.map(([w, label, xs]) => {
        const all = more.has(w);
        const shown = all ? xs : xs.slice(0, SHOWN);
        return h(`section.today-group.w-${w}`,
          h('div.today-gh', h('span.today-dot'), label, h('span.today-gn', String(xs.length))),
          h('div.today-rows', shown.map(row),
            xs.length > shown.length ? h('button.today-more', { type: 'button', onclick: () => { more.add(w); paintList(); } }, `${xs.length - shown.length} more ${label.toLowerCase()} ▾`) : null));
      }),
      waiting.length ? h('section.today-group.w-waiting',
        h('div.today-gh', h('span.today-dot'), 'Sent up, waiting for a decision', h('span.today-gn', String(waiting.length))),
        h('div.today-rows', waiting.map((w) => h('div.today-row',
          h('span.today-bar'),
          h('div.today-t', h('b', w.title),
            h('div.today-m', h('span.today-tag.a-waiting', 'Waiting'), w.why ? h('span', w.why) : null, w.at ? h('span', `sent ${when(w.at)}`) : null, h('span', 'nothing for you to do'))))))) : null);
  }

  function row(x) {
    const said = done.get(x.key);
    const note = h('span.small.today-note');
    const due = x.when === 'overdue'
      ? (x.due ? `due ${shortDay(x.due)}${x.late ? ` · ${x.late} day${x.late === 1 ? '' : 's'} late` : ''}` : x.age ? `waiting ${x.age} days` : 'overdue')
      : x.when === 'today' ? 'today' : x.due ? `due ${shortDay(x.due)}` : null;
    return h('div.today-row', { class: said ? 'done' : '' },
      h('span.today-bar'),
      h('div.today-t',
        h('b', x.title),
        h('div.today-m',
          h(`span.today-tag.a-${x.area}`, x.tag || x.source),
          x.from ? h('span.today-from', h('span.today-av', initials(x.from)), `from ${x.from}`) : null,
          x.why ? h('span', x.why) : null,
          x.amount ? h('span.num', `${money(x.amount, { places: 0 })}${x.amountNote ? ` ${x.amountNote}` : ''}`) : null,
          due ? h(`span.today-due.w-${x.when}`, due) : null,
          said ? h('span.today-said', `✓ ${said}`) : null),
        x.advice && !said && (!x.due || x.blocked) ? h('div.today-adv', x.advice) : null,
        note),
      h('div.today-acts', said ? null : (x.actions || []).map((a) => action(x, a, note))));
  }

  function action(x, a, note) {
    const cls = `btn.sm${a.primary ? '.primary' : '.soft'}`;
    if (a.href) return h(`a.${cls}`, a.external ? { href: a.href, target: '_blank', rel: 'noopener' } : { href: a.href }, a.label);
    if (a.shift) {
      return h(`button.${cls}`, {
        type: 'button',
        onclick: () => {
          try { sessionStorage.setItem('insight-shifts-openshift', `${a.shift.day}|${a.shift.slot}`); } catch { /* private mode */ }
          location.hash = '#/shifts';
        },
      }, a.label);
    }
    const send = (path, body, said) => async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      note.textContent = 'Sending…';
      try {
        const out = await api(path, { method: 'POST', body });
        done.set(x.key, said(out));
        paintList();
        if (a.decide) window.dispatchEvent(new CustomEvent('approvals:count', { detail: Math.max(0, open().filter((i) => i.area === 'approvals').length) }));
      } catch (err) {
        note.textContent = err.message;
        note.className = 'small form-error today-note';
        b.disabled = false;
      }
    };
    if (a.task) return h(`button.${cls}`, { type: 'button', onclick: send(`/shifts/tasks/${a.task}/done`, {}, () => 'Done') }, a.label);
    if (a.app) return h(`button.${cls}`, { type: 'button', onclick: send('/assistant/app-done', a.app, (out) => out.said || 'Done') }, a.label);
    if (a.decide) return h(`button.${cls}`, { type: 'button', onclick: send('/approvals/decide', a.decide, (out) => `${out.said || a.label}${out.as ? ` as ${out.as}` : ''}`) }, a.label);
    return null;
  }

  function dutyCard(d) {
    const now = Date.now();
    const due = Date.parse(d.due);
    const dock = Date.parse(d.dock);
    const amount = money(d.amount, { places: 0 });
    const week = `${shortDay(d.from)} to ${shortDay(d.to)}`;
    const dueDay = new Date(d.due).toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? 'today' : 'Saturday';
    const whose = d.mine ? 'your' : `${d.who}’s`;
    let title;
    let sub;
    if (d.stage === 'sent') {
      title = 'Management report sent ✓';
      sub = `This week, ${week} · sent ${when(d.sent?.at)}${d.sent?.by ? ` by ${d.sent.by}` : ''}`;
    } else if (d.stage === 'docked') {
      title = d.mine ? `${amount} came off your bonus — the report still needs sending` : `${d.who}’s management report: ${amount} came off their bonus`;
      sub = `This week, ${week} · it was due at 10:00 and had not gone by 14:00`;
    } else if (d.stage === 'late') {
      title = d.mine ? 'Management report — late since 10:00' : `${d.who}’s management report is late`;
      sub = `This week, ${week} · ${left(dock - now)} before ${amount} comes off ${whose} bonus at 14:00`;
    } else {
      title = d.mine ? `Management report — due ${dueDay}, 10:00` : `${d.who} sends the management report ${dueDay === 'today' ? 'today' : 'Saturday'} by 10:00`;
      sub = `This week, ${week} · ${left(due - now)} left · late after 14:00 costs ${amount} of ${whose} bonus`;
    }
    const steps = [
      [Date.parse(d.reminders[0]), 'Fri 17:00 reminder'],
      [Date.parse(d.reminders[1]), 'Sat 09:00 reminder'],
      [due, 'Sat 10:00 due'],
      [dock, `Sat 14:00 −${amount}`],
    ];
    return h(`section.today-duty.s-${d.stage}`,
      h('div.today-clock', '10'),
      h('div.today-dt',
        h('b', title),
        h('div.today-ds', sub),
        d.stage === 'sent' ? null : h('div.today-steps', steps.map(([t, label], i) => h('span', { class: now >= t ? (i === 3 ? 'past late' : 'past') : i === 3 ? 'late' : '' }, `${label}${now >= t && i < 2 ? ' ✓' : ''}`)))),
      d.stage === 'sent' ? null : h('a.btn.primary', { href: '#/management?period=week' }, d.mine ? 'Open the report' : 'Open it'));
  }

  function weekCard() {
    const w = data.week || {};
    const r = w.report;
    return h('section.card.today-card',
      h('h2', 'Your week'),
      h('div.today-mini', h('span', 'Things you did this week'), h('b.num', String(w.did || 0))),
      h('div.today-mini', h('span', 'Overdue'), h('b.num', { class: w.overdue ? 'bad' : '' }, String(w.overdue || 0))),
      w.checks ? h('div.today-mini', h('span', 'Shifts checked, last 7 days'), h('b.num', `${w.checks.checked} of ${w.checks.of}`)) : null,
      r ? h('div.today-mini', h('span', 'Report sent last week'), h('b.num', { class: r.sent ? '' : 'bad' },
        r.sent ? `${new Date(r.sent.at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} ✓` : r.docked ? `late, −${money(r.docked.amount, { places: 0 })}` : 'not sent')) : null);
  }

  function mailCard() {
    return h('section.card.today-card.today-mail', h('span.today-at', '@'),
      h('p', h('b', 'One email a day. '), 'This list comes to you at 07:00, admins in copy. You also get one email the moment somebody gives you a to-do. No other reminders.'));
  }

  function doneCard() {
    const t = data.doneToday || { lines: [], other: 0, byInsight: [] };
    const lines = [
      ...t.lines.map((l) => `✓ ${l.what}${l.n > 1 ? ` ×${l.n}` : ''} · ${l.at}`),
      ...(t.other ? [`✓ ${t.other} other change${t.other === 1 ? '' : 's'}`] : []),
      ...(t.byInsight || []).map((x) => `✨ Insight: ${x.title}`),
    ];
    return h('section.card.today-card',
      h('h2', 'Done today'),
      lines.length ? h('div.today-done', lines.map((l) => h('div', l))) : h('p.small.muted', 'Nothing yet today.'));
  }

  function askCard() {
    const box = h('div.as-chat');
    const input = h('input', { type: 'text', placeholder: 'Ask about anything Insight reads…', 'aria-label': 'Ask Insight' });
    const ask = async (q) => {
      const question = (q || input.value).trim();
      if (!question) return;
      input.value = '';
      box.append(h('div.as-q', question));
      const answer = h('div.as-a', 'Thinking…');
      box.append(answer);
      try { answer.textContent = (await api('/assistant/ask', { method: 'POST', body: { question } })).answer; } catch (err) { answer.textContent = err.message; }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
    return h('section.card.today-card.as-ask',
      h('h2', '✨ Ask Insight'),
      box,
      h('div.as-askrow', input, h('button.btn.primary', { type: 'button', onclick: () => ask() }, 'Ask')),
      h('div.as-sugs', ['What needs me most today?', 'What is the oldest thing waiting?', 'Why is anything overdue?']
        .map((s) => h('button', { type: 'button', onclick: () => ask(s) }, s))));
  }

  function readCard() {
    const bad = data.read.filter((r) => !r.ok);
    const places = data.read.filter((r) => !r.off).length;
    const at = new Date(data.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return h('section.today-read',
      h('p.small.muted', `Read ${places - bad.length} of ${places} places at ${at}.`,
        bad.length ? h('span.bad', { title: bad.map((r) => `${r.label}: ${r.error}`).join('\n') }, ` ${bad.map((r) => r.label).join(', ')} could not be read.`) : null),
      data.admin ? billsSwitch() : null);
  }

  /** Bills owed in Odoo are left out of the list, unless turned on here. */
  function billsSwitch() {
    const said = h('span.small');
    const box = h('input', {
      type: 'checkbox', checked: Boolean(data.billsOn),
      onchange: async (e) => {
        e.target.disabled = true;
        said.textContent = 'Saving…';
        try {
          await api('/assistant/bills', { method: 'POST', body: { on: e.target.checked } });
          await renderAssistant(root);
        } catch (err) { said.textContent = err.message; e.target.checked = !e.target.checked; e.target.disabled = false; }
      },
    });
    return h('div.as-bills',
      h('label', box, h('span', 'Flag bills owed in Odoo')),
      h('p.small.muted', data.billsOn ? 'Suppliers owed for over 30 days are on the list.' : 'Off: bills owed are not on the list. Buying › Suppliers still shows them.'),
      said);
  }
}

function lede(data) {
  const c = data.counts || {};
  if (!c.all) return 'Nothing is waiting on you.';
  return [
    `${c.all} thing${c.all === 1 ? ' is' : 's are'} yours`,
    c.overdue ? h('b.bad', `${c.overdue} overdue`) : null,
    c.today ? `${c.today} due today` : null,
  ].filter(Boolean).flatMap((x, i) => (i ? [' · ', x] : [x]));
}

function initials(name) {
  return String(name).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

function shortDay(day) {
  return new Date(`${String(day).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** "Fri 16:10" from a stored time (Accra, which is UTC). */
function when(at) {
  const t = String(at || '').replace(' ', 'T');
  if (!t) return '';
  const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
}

/** How long is left, in words. */
function left(ms) {
  if (ms <= 0) return 'no time';
  const mins = Math.round(ms / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  if (days) return `${days} day${days === 1 ? '' : 's'}${hours ? ` ${hours} hour${hours === 1 ? '' : 's'}` : ''}`;
  if (hours) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}
