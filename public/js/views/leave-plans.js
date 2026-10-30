import { api } from '../api.js';
import { can } from '../app.js';
import { fmtDay, h, mount, toast } from '../util.js';
import { emptyState } from './components.js';
import { field, formDialog } from './att-shared.js';
import { inWeek, sayRange, stripKey, yearStrip } from './year-strip.js';

/**
 * Leave plans for the year: the managers' board.
 *
 * Everybody's plan on one timeline, each department's weeks against what it
 * can spare, the clashes to settle, and who has not sent theirs. Approving a
 * block makes it ordinary approved leave.
 */
export async function renderLeavePlans(params = {}) {
  const host = h('div.lp-board');
  const data = await api.leavePlans(params.year);
  const reload = async () => mount(host, ...(await renderLeavePlans({ year: data.year })).childNodes);
  const sets = can('att_setup');

  if (!data.round) {
    mount(host,
      h('div.page-head', h('div', h('h1', 'Leave'),
        h('div.sub', `Plans for ${data.year}. Ask everybody for their leave plan at once, remind them until it is in, and approve the year in one place.`))),
      sets
        ? setupForm(data, reload)
        : emptyState('Planning is not open yet', 'An administrator opens leave planning for the year.'));
    return host;
  }

  const { round, counts } = data;
  const chase = async () => {
    try {
      const out = await api.chaseLeavePlans(round.year);
      toast(`Reminded ${out.reminded} of ${out.waiting}.`, 'good');
      await reload();
    } catch (err) { toast(err.message, 'bad'); }
  };
  const approveClear = async () => {
    try {
      const out = await api.approveClearPlans(round.year);
      toast(`Approved ${out.approved}.${out.skipped.length ? ` ${out.skipped.length} could not be: ${out.skipped[0]}` : ''}`, out.skipped.length ? 'warn' : 'good');
      await reload();
    } catch (err) { toast(err.message, 'bad'); }
  };

  const statusLine = round.status === 'open'
    ? `Open ${sayRange(round.opensOn, round.dueOn)} · ${counts.sent} of ${counts.eligible} sent · plans you approve go straight onto the rota`
    : 'Saved, not opened yet. Nobody has been asked.';

  mount(host,
    h('div.page-head',
      h('div', h('h1', 'Leave'), h('div.sub', `Plans for ${round.year} · ${statusLine}`)),
      h('div.btn-row',
        data.years.length > 1
          ? h('select', { 'aria-label': 'Year', onchange: async (e) => mount(host, ...(await renderLeavePlans({ year: e.target.value })).childNodes) },
            data.years.map((y) => h('option', { value: y, selected: y === round.year }, String(y))))
          : null,
        sets ? h('button.btn-sm', { type: 'button', onclick: () => setupDialog(data, reload) }, 'Settings') : null,
        counts.notSent && round.status === 'open' ? h('button.btn', { type: 'button', onclick: chase }, `Chase the ${counts.notSent} not sent`) : null,
        counts.clear ? h('button.btn.btn-primary', { type: 'button', onclick: approveClear }, `Approve the ${counts.clear} with no clash`) : null)),

    h('div.home-tiles',
      tile(`${counts.sent}`, `/ ${counts.eligible}`, 'Plans sent'),
      tile(String(counts.reviewed), '', 'Approved'),
      tile(String(counts.clashes), '', 'Clashes to settle', counts.clashes ? 'warn' : ''),
      tile(String(counts.notSent), '', `Not sent · due ${fmtDay(round.dueOn)}`, counts.notSent ? 'bad' : '')),

    h('section.card.lp-time',
      h('div.card-head', h('h2', 'The year, person by person')),
      stripKey([['is-ok', 'Approved'], ['is-mine', 'Waiting'], ['is-move', 'Asked to move'], ['is-over', 'Over the limit'], ['is-busy', 'Busy season']]),
      h('div.lp-rows',
        data.departments.map((d) => h('div.lp-dept',
          h('div.lp-row.is-dept',
            h('div.lp-name', h('strong', d.name), h('small.muted', `${d.limit} away at once`)),
            yearStrip(round.year, (monday) => {
              const w = d.weeks.find((x) => x.monday === monday);
              if (round.busy.some((b) => inWeek(monday, b.from, b.to))) return { cls: 'is-busy', title: 'Busy season' };
              if (!w || !w.away) return null;
              return { cls: w.away > d.limit ? 'is-over' : w.away === d.limit ? 'is-at' : 'is-some', title: `${w.away} away` };
            }, { months: false, label: `${d.name}, who is away each week` })),
          data.people.filter((p) => p.department === d.name).map((p) => h('button.lp-row', {
            type: 'button',
            onclick: () => personDialog(p, round, reload),
            disabled: !p.blocks.length,
          },
          h('div.lp-name', h('span', p.name)),
          !p.plan || p.plan.status === 'draft'
            ? h('div.lp-none.muted', 'Plan not sent yet')
            : yearStrip(round.year, (monday) => {
              const b = p.blocks.find((x) => x.status !== 'declined' && inWeek(monday, x.from, x.to));
              if (!b) return null;
              const cls = b.status === 'approved' ? 'is-ok' : b.status === 'move' ? 'is-move' : b.clash ? 'is-over' : 'is-mine';
              return { cls, title: `${sayRange(b.from, b.to)} · ${b.days} days` };
            }, { months: false, label: `${p.name}'s plan` }))))),
        h('div.lp-row.is-months', h('div.lp-name'), yearStrip(round.year, () => null, { label: 'Months' })))),

    data.clashes.length
      ? h('section.card', h('div.card-head', h('h2', `Clashes to settle · ${data.clashes.length}`)),
        data.clashes.map((c) => clashRow(c, reload)))
      : null,

    data.notSent.length
      ? h('section.card', h('div.card-head', h('h2', `Not sent yet · ${data.notSent.length}`)),
        h('div.home-list', data.notSent.map((p) => h('div.home-row',
          h('span.home-row-main', h('strong', p.name), h('small.muted', p.department)),
          p.reachable
            ? h('small.muted', p.remindedOn ? `reminded ${fmtDay(p.remindedOn)}` : 'not reminded yet')
            : h('small.lp-unreached', 'No login or email: ask in person')))))
      : null,
  );
  return host;
}

function tile(n, of, label, tone = '') {
  return h(`div.card.home-tile${tone ? `.is-${tone}` : ''}`,
    h('span.home-tile-n', n, of ? h('small.muted', ` ${of}`) : null), h('span.home-tile-l', label));
}

function clashRow(c, reload) {
  const last = c.sentLast;
  const first = last.name.split(/\s+/)[0];
  const count = ['', 'it', 'both', 'all three', 'all four'][c.people.length] ?? `all ${c.people.length}`;
  const allow = async () => {
    try {
      for (const p of c.people) await api.decidePlanBlock(p.blockId, { decision: 'approve' });
      toast(c.people.length === 1 ? `${last.name}: allowed.` : `Allowed ${count}.`, 'good');
    } catch (err) { toast(err.message, 'bad'); }
    await reload();
  };
  const names = [...c.withNames, ...c.people.map((p) => (c.people.length > 1 && p === last ? `${p.name} (sent last)` : p.name))];
  return h('div.lp-clash',
    h('div',
      h('strong', `${c.department} · ${sayRange(c.from, c.to)}`),
      h('span.pill.warn', c.kind === 'busy' ? 'Busy season' : `${c.away} away, ${c.limit} allowed`),
      h('p.muted', c.kind === 'busy'
        ? `${last.name} asked for ${sayRange(last.from, last.to)}. No leave from ${sayRange(c.busyFrom, c.busyTo)}${c.label ? ` (${c.label})` : ''}.`
        : names.join(', '))),
    h('div.btn-row',
      h('button.btn', { type: 'button', onclick: () => moveDialog({ id: last.blockId, from: last.from, to: last.to }, last.name, reload) }, `Ask ${first} to move`),
      h('button.btn', { type: 'button', onclick: allow }, c.people.length === 1 ? 'Allow it' : `Allow ${count}`)));
}

async function decide(id, body, reload, done) {
  try {
    await api.decidePlanBlock(id, body);
    toast(done, 'good');
    await reload();
  } catch (err) { toast(err.message, 'bad'); }
}

async function moveDialog(block, name, reload) {
  const first = name.split(/\s+/)[0];
  const out = await formDialog({
    title: `Ask ${first} to move ${sayRange(block.from, block.to)}`,
    submitLabel: 'Ask to move',
    body: h('div.ask-sheet',
      field('Message', h('textarea', { name: 'note', rows: 3, maxlength: 400, placeholder: 'e.g. Front desk can only spare one that week. Could you take the week after?' })),
      h('div.grid.grid-2',
        field('Suggest instead, from', h('input', { type: 'date', name: 'suggestFrom' })),
        field('to', h('input', { type: 'date', name: 'suggestTo' }))),
      h('p.muted', `${first} can take the suggested dates in one tap, or choose others.`)),
    onSubmit: (form) => api.decidePlanBlock(block.id, {
      decision: 'move', note: form.get('note') || null,
      suggestFrom: form.get('suggestFrom') || null, suggestTo: form.get('suggestTo') || null,
    }),
  });
  if (out) { toast(`${first} has been asked to move it.`, 'good'); await reload(); }
}

async function personDialog(p, round, reload) {
  const close = () => document.querySelector('dialog.app-dialog')?.close();
  await formDialog({
    title: `${p.name} · ${round.year} plan`,
    submitLabel: 'Done',
    body: h('div.ask-sheet', p.blocks.map((b) => h('div.lp-decide',
      h('div', h('strong', sayRange(b.from, b.to)), h('small.muted', ` ${b.days} days`),
        b.clash ? h('span.pill.warn', b.clash === 'busy' ? 'Busy season' : 'Over the limit') : null,
        b.status !== 'planned' ? h('span.pill', { approved: 'Approved', move: 'Asked to move', declined: 'Not approved' }[b.status] ?? b.status) : null),
      b.status === 'planned'
        ? h('div.btn-row',
          h('button.btn-sm.btn-primary', { type: 'button', onclick: () => { close(); decide(b.id, { decision: 'approve' }, reload, 'Approved.'); } }, 'Approve'),
          h('button.btn-sm', { type: 'button', onclick: () => { close(); moveDialog(b, p.name, reload); } }, 'Ask to move'),
          h('button.btn-sm', { type: 'button', onclick: () => { close(); decide(b.id, { decision: 'decline' }, reload, 'Not approved.'); } }, 'Decline'))
        : null))),
    onSubmit: async () => true,
  });
}

function setupDialog(data, reload) {
  const form = setupForm(data, reload, { inDialog: true });
  const dialog = h('dialog.app-dialog.app-dialog-wide',
    h('div.dialog-head', h('h2', `Leave planning for ${data.year}`),
      h('div.dialog-head-tools', h('button.dialog-close', { type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, '✕'))),
    form);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

/** Open leave planning for a year, or change its settings. */
function setupForm(data, reload, { inDialog = false } = {}) {
  const r = data.round;
  const s = data.setup;
  const busy = [...(r?.busy ?? [])];
  const busyHost = h('div.lp-busy');
  const drawBusy = () => mount(busyHost, busy.map((b, i) => h('div.lp-busy-row',
    h('input', { type: 'date', value: b.from, 'aria-label': 'From', onchange: (e) => { b.from = e.target.value; } }),
    h('input', { type: 'date', value: b.to, 'aria-label': 'To', onchange: (e) => { b.to = e.target.value; } }),
    h('input', { type: 'text', value: b.label ?? '', placeholder: 'e.g. Christmas and New Year', 'aria-label': 'What it is', onchange: (e) => { b.label = e.target.value; } }),
    h('button.btn-sm', { type: 'button', onclick: () => { busy.splice(i, 1); drawBusy(); } }, 'Remove'))));
  drawBusy();

  const year = h('input', { type: 'number', name: 'year', value: s.year, min: 2000, max: 2100 });
  const opens = h('input', { type: 'date', name: 'opensOn', value: r?.opensOn ?? s.suggested.opensOn, required: true });
  const due = h('input', { type: 'date', name: 'dueOn', value: r?.dueOn ?? s.suggested.dueOn, required: true });
  const min = h('input', { type: 'number', name: 'minDays', value: r?.minDays ?? s.suggested.minDays, min: 0, max: 60, step: 0.5 });
  const limits = s.departments.map((d) => ({ name: d.name, input: h('input', { type: 'number', min: 0, max: 50, value: d.limit, 'aria-label': `${d.name}, away at once` }) }));
  const remind = h('input', { type: 'checkbox', checked: r ? r.remind : true });
  const tell = h('input', { type: 'checkbox', checked: r ? r.tellManagers : true });

  const save = async (open) => {
    try {
      const out = await api.saveLeavePlanRound({
        year: Number(year.value), opensOn: opens.value, dueOn: due.value, minDays: Number(min.value),
        busy: busy.filter((b) => b.from), limits: Object.fromEntries(limits.map((l) => [l.name, Number(l.input.value)])),
        remind: remind.checked, tellManagers: tell.checked, open,
      });
      document.querySelector('dialog.app-dialog')?.close();
      toast(out.invited ? `Planning is open. ${out.invited} people told.` : out.open ? 'Planning is open. Everybody is told on the opening day.' : 'Saved. Nobody has been asked yet.', 'good');
      await reload();
    } catch (err) { toast(err.message, 'bad'); }
  };

  return h(inDialog ? 'div.lp-setup' : 'section.card.lp-setup',
    inDialog ? null : h('div.card-head', h('h2', `Open leave planning for ${s.year}`)),
    h('h3', 'When'),
    h('div.grid.grid-3', field('Year being planned', year), field('Opens', opens), field('Plans due by', due)),
    h('h3', 'Who plans, and how much'),
    h('p.muted', 'Everybody who earns annual leave and has qualified for it. Casual staff are left out.'),
    field('Ask each person to plan at least this many of their days now', min, 'The rest can be asked for later in the year as usual.'),
    h('h3', 'Busy seasons: no leave'),
    busyHost,
    h('button.btn-sm', { type: 'button', onclick: () => { busy.push({ from: '', to: '', label: '' }); drawBusy(); } }, '+ Add a busy season'),
    h('p.muted', 'Staff see these hatched on their calendar. A plan that falls in one comes to you marked, to allow or to send back.'),
    h('h3', 'How many can be away at once'),
    h('div.lp-limits', limits.map((l) => h('label.lp-limit', l.input, h('span', l.name)))),
    h('p.muted', 'Weeks at the limit show as full on everybody\'s calendar while they plan.'),
    h('h3', 'Reminders and approval'),
    h('label.check', remind, ' Remind anybody who has not sent theirs every Monday, then every day in the last week'),
    h('label.check', tell, ' Tell the managers when all of a department\'s plans are in'),
    h('p.muted', 'Approved plans become ordinary approved leave: on the rota, off the balance, and changed later through Requests like any other leave.'),
    h('div.btn-row',
      r?.status === 'open' ? null : h('button.btn', { type: 'button', onclick: () => save(false) }, 'Save without opening'),
      h('button.btn.btn-primary', { type: 'button', onclick: () => save(true) }, r?.status === 'open' ? 'Save' : 'Open planning and tell everybody')));
}
